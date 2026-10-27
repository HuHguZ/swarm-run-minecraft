import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { fly } from '../src/elytra/flight'
import { choose, cost } from '../src/elytra/control'
import { worldOf } from '../src/elytra/physics'
import { install } from '../src/elytra/install'
import { observedCollision } from '../src/pvp/search'
import * as clock from '../src/game-clock'

test('landing cost includes same-tick motion and surface-dependent runout', () => {
  const goal: any = { kind: 'land', at: new Vec3(.5, 100, .5) }
  const result = (vx: number): any => ({ kind: 'floor', t: 1, p: goal.at, v: { x: vx, y: -.2, z: 0 }, fd: 1, remainingMove: { x: .5, z: 0 } })
  const world = (wall: number, drag = .6 * .91): any => ({
    airborneInertia: .91, groundInertia: () => drag,
    floorBelow: () => ({ top: 100 }), boxHit: x => x + .3 >= wall
  })
  const price = (W, r, g = goal) => cost(W, {}, g, () => g.at, r, 0, 0)
  assert(price(world(3), result(1.5)) > 400)
  assert(price(world(3), result(.1)) < 1)
  assert(price(world(Infinity), result(1.5)) < 1)
  assert(price(world(5), result(.8)) < 1)
  assert(price(world(5, .98 * .91), result(.8)) > 400)
  assert(price(world(Infinity), result(1.5), { ...goal, arena: { x: 0, z: 0, r: 3 } }) >= 5000)
})

test('landing under an active rocket avoids a same-tick floor-plus-wall collision in native physics', () => {
  const data = require('minecraft-data')('1.21.11')
  const Block = require('prismarine-block')(data)
  const { Physics, PlayerState } = require('prismarine-physics')
  const world = { getBlock(p) {
    const q = p.floored()
    const b = Block.fromStateId((q.y < 100 || q.x >= 3 ? data.blocksByName.stone : data.blocksByName.air).minStateId, 0)
    b.position = q
    return b
  } }
  const bot: any = { on() {}, version: '1.21.11', inventory: { slots: [] }, blockAt: world.getBlock,
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 30,
    entity: { position: new Vec3(.5, 100.5, .5), velocity: new Vec3(1.5, -.4, 0),
      effects: {}, attributes: {}, onGround: false, elytraFlying: true, yaw: 0, pitch: 0 } }
  bot.inventory.slots[6] = { name: 'elytra' }
  bot.physics = Physics(data, world)
  const simulate = plan => {
    bot.entity.yaw = plan.yaw; bot.entity.pitch = plan.pitch
    let s = new PlayerState(bot, { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
    let walls = 0
    for (let i = 0; i < 12; i++) { s = bot.physics.simulatePlayer(s, world); if (s.isCollidedHorizontally) walls++ }
    return walls
  }
  assert(simulate({ yaw: -Math.PI / 2, pitch: -.38 }) > 0, 'the fixture contains a real touchdown collision')
  const plan = choose(worldOf(bot), { p: bot.entity.position, v: bot.entity.velocity, boost: 30, fd: 1 },
    { kind: 'land', at: new Vec3(2.5, 100, .5) })
  assert(plan)
  assert.equal(simulate(plan), 0)
})

test('fly records actual touchdown before a later onGround change', async () => {
  const bot: any = new EventEmitter()
  bot.health = 20; bot._ndElytra = { driving: 0, fd: 0, startedAt: 0 }
  bot.entity = { position: new Vec3(2, 100, 3), velocity: new Vec3(0, 0, 0), onGround: true }
  bot.blockAt = () => null
  const done = fly(bot, { aborted: false }, { goal: { kind: 'point', at: bot.entity.position } })
  bot.emit('physicsTick')
  bot.entity.onGround = false; bot.entity.position.x = 4
  const r = await done
  assert.equal(r.why, 'сел')
  assert.deepEqual(r.ground, { x: 2, y: 100, z: 3 })
})

test('player movement fall estimate survives shallow descent and resets after an actual rise', () => {
  const bot: any = new EventEmitter()
  bot.health = 20; bot._client = new EventEmitter(); bot.inventory = { slots: [] }
  bot.inventory.slots[6] = { name: 'elytra' }
  bot.entity = { id: 1, position: new Vec3(.5, 140, .5), velocity: new Vec3(0, -.3, 0),
    onGround: false, elytraFlying: true, yaw: 0, pitch: 0 }
  bot.blockAt = p => ({ name: p.y < 100 ? 'stone' : 'air', boundingBox: p.y < 100 ? 'block' : 'empty' })
  const S = install(bot); S.driving = 1
  bot.emit('physicsTick')
  for (let i = 1; i <= 20; i++) { bot.entity.position.y = 140 - i * .3; bot.emit('physicsTick') }
  assert(Math.abs(S.moveFd - 6) < 1e-8)
  assert(S.fd < 3, 'the old client-velocity estimate understates this descent')
  bot.entity.position.y += .01; bot.emit('physicsTick')
  assert.equal(S.moveFd, 0)
  bot.entity.position.y -= 2; bot.emit('physicsTick')
  bot.entity.onGround = true; bot.emit('physicsTick')
  assert.equal(S.moveFd, 0)
})

function occludedFloor(surface = 'air') {
  return Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(603.5067110125685, 120, 605.5091611740959) },
    blockAt(p: Vec3) {
      const at = p.floored(), ridge = (at.x === 607 || at.x === 608) && at.z === 660
      const name = at.x === 608 && at.y === 156 && at.z === 666 ? surface
        : ridge && at.y === 152 ? 'smooth_sandstone' : ridge && at.y === 153 ? 'smooth_sandstone_slab' : 'air'
      return { position: at, name, boundingBox: name === 'air' ? 'empty' : 'block',
        shapes: name === 'air' ? [] : [[0, 0, 0, 1, name.endsWith('_slab') ? .5 : 1, 1]] }
    }
  })
}

test('hidden air blocks flight avoidance but cannot become a landing floor, then is reobserved after moving', t => {
  let now = 1000
  t.mock.method(clock, 'now', () => now)
  // Four actual ridge blocks shadow the false AH pad's support while its body space stays visible.
  const bot = occludedFloor(), at = new Vec3(608, 156, 666), W = worldOf(bot, { observed: true })
  assert.equal(bot.blockAt(at).name, 'air', 'the loaded packet contains air behind a real occluder')
  assert.equal(observedCollision(bot).blockAt(at), null, 'actual sight cannot certify the hidden cell')
  assert.equal(observedCollision(bot).blockAt(at.offset(0, 1, 0))?.name, 'air', 'planned standing space really is visible')
  assert.equal(W.solid(608, 156, 666), true)
  assert.equal(W.boxHit(608.5, 156, 666.5), true)
  assert.equal(W.floorBelow(608.5, 170, 666.5, 14), null, 'unknown collision must not manufacture support')
  bot.entity.position = new Vec3(608.5, 157, 666.5); now += 50
  assert.equal(observedCollision(bot).blockAt(at)?.name, 'air')
  assert.equal(W.solid(608, 156, 666), false, 'hidden cells are not cached as observed walls')
  assert.equal(W.boxHit(608.5, 156, 666.5), false)
  assert.equal(W.floorBelow(608.5, 170, 666.5, 14), null)
})

test('an observed landing floor remains remembered behind an occluder until its block update', t => {
  let now = 1000
  t.mock.method(clock, 'now', () => now)
  const bot = occludedFloor('smooth_sandstone'), at = new Vec3(608, 156, 666), W = worldOf(bot, { observed: true })
  const start = bot.entity.position.clone()
  bot.entity.position = new Vec3(608.5, 157, 666.5)
  assert.deepEqual(W.floorBelow(608.5, 170, 666.5, 14), { top: 157 }, 'a real visible floor is still eligible')
  bot.entity.position = start; now += 50
  assert.equal(observedCollision(bot).blockAt(at), null)
  assert.deepEqual(W.floorBelow(608.5, 170, 666.5, 14), { top: 157 }, 'retain the floor the player actually observed')
  const old = bot.blockAt(at), read = bot.blockAt
  const air = { ...old, name: 'air', boundingBox: 'empty', shapes: [] }
  bot.blockAt = p => p.floored().equals(at) ? air : read(p)
  bot.emit('blockUpdate', old, air); now += 50
  assert.equal(W.solid(608, 156, 666), true, 'updated hidden space stays blocked for avoidance')
  assert.equal(W.floorBelow(608.5, 170, 666.5, 14), null, 'the invalidated floor cannot reappear from unknown space')
})

test('unloaded default flight space is blocked but supplies no landing floor', () => {
  const bot = Object.assign(new EventEmitter(), { blockAt: () => null }), W = worldOf(bot)
  assert.equal(W.solid(2, 0, 0), true)
  assert.equal(W.boxHit(2.5, 0, .5), true)
  assert.equal(W.floorBelow(2.5, 0, .5, 0), null)
})
