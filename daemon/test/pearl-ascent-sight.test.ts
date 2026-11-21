import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { cacheMethods } from '../src/rpc/caches'
import * as hop from '../src/pearl-hop'
import * as throwing from '../src/throw'
import { block, testBot } from './tick-plugins-fixture'

function scene() {
  const from = new Vec3(.5, 120, .5), to = new Vec3(17.5, 126, .5)
  const arena = { x: 10, z: 0, y: 120, r: 80, killY: 113 }
  let wall = true, pad = true, reads = 0
  const air = block('air', from), stone = block('stone', from)
  const bot = { entity: { position: from, velocity: new Vec3(0, 0, 0), onGround: true }, registry: {}, health: 20,
    entities: {}, inventory: { slots: [], items: () => [{ name: 'ender_pearl', count: 3 }] }, setControlState() {},
    blockAt(p) {
      reads++
      const { x, y, z } = p
      const launch = y === 119 && Math.abs(x) <= 2 && Math.abs(z) <= 2
      const roof = pad && y === 125 && x >= 15 && x <= 20 && Math.abs(z) <= 3
      const screen = wall && x === 8 && y >= 115 && y <= 125 && Math.abs(z) <= 10
      return launch || roof || screen ? stone : air
    } }
  const rpc = cacheMethods({ session: { require: () => bot, immediate: f => f(), runIntent: (_, f) => f({ aborted: false }) } } as any)
  const query = { to, arena, maxHops: 1 }
  return { bot, query, rpc, wall: value => { wall = value }, pad: value => { pad = value }, get reads() { return reads } }
}

test('the two ascent RPCs cannot discover a landing behind an opaque wall', async t => {
  const f = scene(), shots = []
  let closeAtRelease = false
  t.mock.method(throwing, 'throwAt', async (_, __, opts) => {
    if (closeAtRelease) f.wall(true)
    shots.push(!!opts.pick({ from: f.bot.entity.position.offset(0, hop.EYE, 0), moved: f.bot.entity.velocity, airborne: false }))
    return { thrown: false, why: 'test release' }
  })
  const hidden = await f.rpc.pearl_plan(f.query)
  await f.rpc.pearl_up(f.query)
  f.pad(false)
  const absent = await f.rpc.pearl_plan(f.query)
  assert.deepEqual(hidden, absent, 'adding hidden support cannot change any planning observation')
  assert.equal(hidden.ok, false)
  assert.deepEqual(shots, [])
  f.pad(true); f.wall(false)
  assert.equal((await f.rpc.pearl_plan(f.query)).ok, true, 'the near edge can be seen from the side')
  await f.rpc.pearl_up(f.query)
  assert.deepEqual(shots, [true])
  f.bot.entity.position.y = 130
  assert.equal((await f.rpc.pearl_plan(f.query)).ok, true, 'top of the wide platform is in sight')
  f.bot.entity.position.y = 120
  closeAtRelease = true
  await f.rpc.pearl_up(f.query)
  assert.deepEqual(shots, [true, false], 'a newly opaque wall hides the landing before release')
})

const crystal = () => ({ name: 'end_crystal', width: 2, height: 2, position: new Vec3(1.5, 124, 2.75) })
test('preview and ascent use the same visible pearl obstacles behind and beside a wall', async t => {
  const f = scene(), bot = f.bot, original = bot.blockAt, stone = block('stone', bot.entity.position)
  let screen = true, releases = 0
  f.wall(false)
  bot.blockAt = p => screen && p.z === 1 && p.y >= 119 && p.y <= 145 && p.x >= -2 && p.x <= 8 ? stone : original(p)
  t.mock.method(throwing, 'throwAt', async (_, __, opts) => {
    if (opts.pick({ from: bot.entity.position.offset(0, hop.EYE, 0), moved: bot.entity.velocity, airborne: false })) releases++
    return { thrown: false, why: 'test ends before packet' }
  })
  const empty = await f.rpc.pearl_plan(f.query)
  assert.equal(empty.ok, true)
  bot.entities[8] = crystal()
  assert.deepEqual(await f.rpc.pearl_plan(f.query), empty)
  await f.rpc.pearl_up(f.query)
  assert.equal(releases, 1, 'an unseen crystal does not suppress a good release')
  screen = false
  assert.equal((await f.rpc.pearl_plan(f.query)).ok, false, 'the exposed crystal intersects the ascent')
  await f.rpc.pearl_up(f.query)
  assert.equal(releases, 1)
  delete bot.entities[8]
  assert.equal((await f.rpc.pearl_plan(f.query)).ok, true)
})

for (const spreadOnly of [false, true]) test(`a new crystal on the ${spreadOnly ? 'scattered' : 'nominal'} arc preserves the pearl at the actual use_item boundary`, async () => {
  const f = scene(), bot = testBot()
  f.wall(false)
  bot.entity.position = f.bot.entity.position; bot.entity.velocity = new Vec3(0, 0, 0); bot.entity.onGround = true
  bot.blockAt = f.bot.blockAt
  bot.world = { getBlock: bot.blockAt, raycast: require('prismarine-world/src/worldsync').prototype.raycast }
  const held = { name: 'ender_pearl', type: bot.registry.itemsByName.ender_pearl.id, slot: 36, count: 1 }
  bot.inventory.items = () => [held]; bot.heldItem = held; bot.health = 20
  const rpc = cacheMethods({ session: { require: () => bot, runIntent: (_, run) => run({ aborted: false }) } } as any)
  let uses = 0, aims = 0
  bot.look = async () => {
    aims++
    // The nominal throw stays on Z=.5. The second crystal is 3.4 blocks away
    // at its apex, outside the 3-block exclusion radius until lateral scatter.
    bot.entities[8] = spreadOnly ? { ...crystal(), position: new Vec3(10.5, 147.2, 3.9) } : crystal()
  }
  bot.activateItem = () => { uses++; bot.entity.position = f.query.to }
  const ticks = setInterval(() => bot.emit('physicsTick'), 3)
  try {
    const r = await rpc.pearl_up(f.query)
    assert.ok(aims > 0, 'the initial trajectory was certified before the crystal appeared')
    assert.equal(uses, 0)
    assert.equal(r.hops, 0)
    assert.equal(r.launchAt, undefined)
  } finally { clearInterval(ticks) }
})

test('forty ordinary players require zero obstacle sight rays on an ascent preview', async t => {
  const f = scene()
  f.wall(false)
  for (let i = 0; i < 40; i++) f.bot.entities[i] = { name: 'player', position: new Vec3(i, 120, 0) }
  const sight = t.mock.method(require('../src/pvp/last-seen'), 'seesPlayer')
  assert.equal((await f.rpc.pearl_plan(f.query)).ok, true)
  assert.equal(sight.mock.callCount(), 0)
  f.bot.entities[40] = crystal()
  await f.rpc.pearl_plan(f.query)
  assert.equal(sight.mock.callCount(), 1, 'one visible obstacle is sampled once across every candidate')
})
