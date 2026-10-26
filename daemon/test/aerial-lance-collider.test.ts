import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as L from '../src/combat/aerial-lance'
import * as sky from '../src/elytra/physics'
import { observedCollision } from '../src/pvp/search'
import { EventEmitter } from 'node:events'

const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)

function fixture(cells: Array<[number, number, number, string]> = []) {
  const map = new Map(cells.map(([x, y, z, name]) => [`${x},${y},${z}`, name]))
  const blockAt = p => {
    const q = p.floored(), name = map.get(`${q.x},${q.y},${q.z}`) || (q.y < 99 ? 'stone' : 'air')
    const block = Block.fromStateId(registry.blocksByName[name].defaultState)
    block.position = q; return block
  }
  const native = new (require('prismarine-world')('1.21.11'))().sync
  native.getBlock = blockAt
  return { blockAt, native, W: sky.worldOf({ blockAt, on() {} }) }
}

const state = { p: new Vec3(.5, 101.1, .5), v: new Vec3(.25, .4, 0), boost: 0, fd: 0 }
const foot = new Vec3(4.5, 100, .5)
const eye = new Vec3(.75, 101.875, .5), direction = new Vec3(1, 0, 0)
const clipOf = world => (L as any).lanceCollider(world)

test('kinetic planner checks a viable contact before accepting its collider-obstructed damage', () => {
  const { W } = fixture()
  assert.ok(L.chooseLance(W, state, () => foot)?.dmg > 0)
  let calls = 0
  const blocked = L.chooseLance(W, state, () => foot, { clip: () => { calls++; return 0 } })
  assert.equal(blocked, null, 'a clear body rollout does not certify the spear eye ray')
  assert.ok(calls > 0)
})

test('observed native COLLIDER shapes preserve slab and pane gaps and empty cobweb collision', () => {
  for (const [name, at, expected] of [
    ['air', eye, 4], ['stone', eye, 1.25], ['stone_slab', eye, 4],
    ['stone_slab', new Vec3(.75, 101.25, .5), 1.25],
    ['glass_pane', new Vec3(.75, 101.875, .1), 4],
    ['glass_pane', eye, 1.6875], ['cobweb', eye, 4]
  ] as Array<[string, Vec3, number]>) {
    const { blockAt } = fixture([[2, 101, 0, name]])
    assert.equal(clipOf({ blockAt })(at, direction, 4), expected, name)
  }
})

test('collider clip handles start inside shape, a partial shape behind the start, unknowns and read failure', () => {
  const slab = fixture([[0, 101, 0, 'stone_slab']])
  assert.equal(clipOf(slab)(new Vec3(.75, 101.25, .5), direction, 4), 0)
  assert.equal(clipOf(slab)(new Vec3(.75, 101.75, .5), new Vec3(0, 1, 0), 4), 4)
  assert.equal(clipOf({ blockAt: () => null })(eye, direction, 4), 0)
  assert.equal(clipOf({ blockAt: () => { throw Error('unknown') } })(eye, direction, 4), 0)
})

test('actual observed adapter refuses raw packet-only cells without calling the bound raw world raycast', () => {
  const { blockAt } = fixture([[2, 101, 0, 'stone'], [3, 101, 0, 'air']])
  const bot: any = { entity: { position: new Vec3(.5, 100.25, .5), elytraFlying: false }, blockAt,
    world: { raycast: () => { throw Error('raw packet raycast must not be used') } } }
  const observed = observedCollision(bot)
  assert.equal(observed.blockAt(new Vec3(3, 101, 0)), null, 'air behind stone has not been seen')
  const from = new Vec3(3.5, 101.5, .5)
  assert.equal(clipOf(observed)(from, direction, 4), 0, 'future eyes cannot certify hidden air')
})

test('native stone before minimum range cannot promise the previous ready planner hit', () => {
  const world = fixture([[2, 101, 0, 'stone']])
  const clip = clipOf(world)
  const plan = L.chooseLance(world.W, state, () => foot, { clip })
  assert.ok(plan, 'a different, later approach remains available')
  assert.notEqual(plan.hitT, 0, 'the old pre-min-range promise is rejected')
  const path = sky.rollout(world.W, state.p, state.v, plan.yaw, plan.pitch, 0, plan.hitT + 1, { fd: 0, keepPath: true }).path
  const q = path[plan.hitT], look = sky.lookVec(plan.yaw, plan.pitch)
  const from = new Vec3(q.x, q.y + .4, q.z), dir = new Vec3(look.x, look.y, look.z)
  const range = 4.5 + Math.max(0, q.vx * dir.x + q.vy * dir.y + q.vz * dir.z)
  const wall = world.native.raycast(from, dir, range), end = wall ? from.distanceTo(wall.intersect) : range
  assert.ok(end >= 2, 'independent native world COLLIDER ray reaches the minimum segment')
  const start = from.plus(dir.scaled(2))
  const { RaycastIterator } = require('prismarine-world').iterators
  const bare = [[-.3, 0, -.3, .3, 1.8, .3]]
  const inside = Math.abs(start.x - foot.x) < .3 && Math.abs(start.z - foot.z) < .3 && start.y >= foot.y && start.y < foot.y + 1.8
  const contact = new RaycastIterator(start, dir, end - 2).intersect(bare, foot)
  assert.ok(inside || contact && start.distanceTo(contact.pos) < end - 2, 'native AABB intersects before native block clipping')
})

test('actual lance executor installs the observed clip when choosing its approach', async t => {
  const flight = require('../src/elytra/flight'), search = require('../src/pvp/search')
  t.mock.method(flight, 'fly', async () => ({ why: 'разбег' }))
  t.mock.method(flight, 'chestDown', async () => ({ ok: true }))
  let reads = 0
  t.mock.method(search, 'observedCollision', () => ({ blockAt: () => { reads++; return null } }))
  const world = fixture(), item = { name: 'iron_spear', count: 1 }, rocket = { name: 'firework_rocket', count: 8 }
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: state.p.clone(), velocity: state.v.clone(), elytraFlying: true, onGround: false, yaw: -Math.PI / 2, pitch: 0 },
    health: 20, heldItem: item, inventory: { items: () => [item, rocket], slots: [] },
    _client: new EventEmitter(), _ndElytra: { driving: 0, fd: 0, startedAt: 0 }, fireworkRocketDuration: 0,
    blockAt: world.blockAt, look: async () => {}, activateItem() {}, deactivateItem() {}
  })
  bot.inventory.slots[6] = { name: 'elytra' }; bot.inventory.slots[45] = rocket
  const foe = { id: 2, type: 'player', username: 'foe', position: foot, onGround: true, isValid: true }
  const ctl = { aborted: false }, stats: any = {}
  const done = L.lance(bot, ctl, foe, { passes: 1, telemetryHp: () => null, stats })
  try {
    for (let n = 0; n < 30 && !stats.lancePasses; n++) await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(stats.lancePasses, 1)
    bot.emit('physicsTick')
    assert.ok(reads > 0, 'real executor candidate checks must reach observed collision reads')
  } finally {
    ctl.aborted = true; bot.entity.onGround = true; bot.entity.elytraFlying = false; bot.emit('physicsTick')
    await done
  }
})

test('kinetic clip precedes bare start-inside; a wall behind the bare entry preserves the hit', () => {
  const start = new Vec3(0, 101.62, 0), look = new Vec3(1, 0, 0), still = new Vec3(0, 0, 0)
  const hit = (at, clip) => L.lanceHits(start, look, still, at, 1.8, .6, clip)
  assert.equal(hit(new Vec3(2, 100.5, 0), () => 1), false, 'wall before 2 rejects even a bare contains(start)')
  assert.equal(hit(new Vec3(3, 100.5, 0), () => 3.1), true, 'block behind entry must not veto the target')
  assert.equal(hit(new Vec3(3, 100.5, 0), () => 2.5), false)
})

test('grown-only contact follows jar secondary COLLIDER ray to bare AABB, not unconditional margin acceptance', () => {
  const start = new Vec3(0, 101.85, 0), look = new Vec3(1, 0, 0), still = new Vec3(0, 0, 0)
  const at = new Vec3(3, 100, 0)
  assert.equal(L.lanceHits(start, look, still, at), true, 'geometry reaches inflated box just above bare top')
  assert.equal(L.lanceHits(start, look, still, at, 1.8, .6, (_o, _d, range) => range), true)
  let rays = 0
  assert.equal(L.lanceHits(start, look, still, at, 1.8, .6, (_o, _d, range) => ++rays === 1 ? range : 0), false)
  assert.equal(rays, 2, 'jar tests the grown entry toward target center before adding the hit')
})
