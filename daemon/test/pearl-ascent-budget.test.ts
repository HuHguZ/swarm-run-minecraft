import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { cacheMethods } from '../src/rpc/caches'
import * as hop from '../src/pearl-hop'
import * as throwing from '../src/throw'
import { block } from './tick-plugins-fixture'

function gallery(pearls = 1) {
  const feet = new Vec3(.5, 120, .5), to = new Vec3(16.5, 124, .5)
  const air = block('air', feet), stone = block('stone', feet), glass = block('glass', feet)
  const bot: any = { entity: { position: feet, velocity: new Vec3(0, 0, 0), onGround: true }, health: 20,
    entities: {}, registry: {}, inventory: { slots: [], items: () => [{ name: 'ender_pearl', count: pearls }] }, setControlState() {},
    blockAt({ x, y, z }) {
      if (x === 11 && z >= -4 && z <= 1 && y >= 115 && y <= 200) return glass
      if (x >= 9 && x <= 23 && Math.abs(z) <= 7 && y === 123) return glass
      return y === 119 ? stone : air
    } }
  const session: any = { require: () => bot, immediate: f => f(), runIntent: (_, f) => f({ aborted: false }) }
  const rpc = cacheMethods({ session } as any), arena = { x: 20, y: 120, z: 0, r: 80, killY: 113 }
  return { bot, feet, to, rpc, arena }
}

test('the last pearl can execute the visible high arc found after the first 24 gallery candidates', async t => {
  const f = gallery(), releases = []
  t.mock.method(throwing, 'throwAt', async (bot, _, opts) => {
    const actual = opts.pick({ from: bot.entity.position.offset(0, hop.EYE, 0), moved: bot.entity.velocity, airborne: false })
    if (actual && opts.onAim()) releases.push(actual)
    return { thrown: false, why: 'release recorded' }
  })
  const query = { to: f.to, arena: f.arena, maxHops: 2 }
  assert.equal((await f.rpc.pearl_plan({ ...query, maxTries: 24 })).ok, false)
  await f.rpc.pearl_up({ ...query, maxTries: 24 })
  assert.equal(releases.length, 0)
  const preview = await f.rpc.pearl_plan(query)
  assert.equal(preview.ok, true)
  assert.deepEqual(preview.feet, new Vec3(16.5, 124, 4.5))
  assert.equal(preview.arc, 'high')
  await f.rpc.pearl_up(query)
  assert.equal(releases.length, 1, 'the same direct-search budget reaches the actual release check')
  for (const reserve of [2, 3]) {
    const stocked = gallery(reserve), before = releases.length
    await stocked.rpc.pearl_up(query)
    assert.equal(releases.length, before + 1, 'carrying spare pearls preserves the same direct throw')
  }
  f.bot.entity.position = preview.feet
  const arrived = await f.rpc.pearl_up(query)
  assert.equal(arrived.ok, true); assert.equal(arrived.stop, 'у цели')
  assert.equal(releases.length, 3)
})

test('a real intermediate landing remains available when the high platform needs two pearls', () => {
  const terrain = (x, y, z) => {
    const stone = [[0, 100], [24, 108], [48, 116]].some(([center, top]) =>
      Math.abs(x - center) <= 5 && Math.abs(z) <= 5 && y >= top - 3 && y <= top)
    return { name: stone ? 'stone' : 'air', boundingBox: stone ? 'block' : 'empty' }
  }
  const feet = new Vec3(.5, 101, .5), goal = new Vec3(48.5, 117, .5)
  const opts = { observed: true, mustArrive: true, pearls: 2, maxHops: 2, reserve: 0, hp: 20, hpMin: 3,
    arriveR: 3, dmg: 5, maxR: 30, lateral: [0] }
  assert.equal(hop.planRoute(terrain, feet, goal, { ...opts, pearls: 1 }).plans.length, 0)
  const route = hop.planRoute(terrain, feet, goal, opts)
  assert.deepEqual(route.plans.map(plan => plan.feet.y), [109, 117])
  assert.ok(route.plans[1].feet.distanceTo(goal) <= 4)
})

test('an unsuccessful single-pearl ascent reports the real search without running another pass for the log', async () => {
  const f = gallery(), reject = () => { checks++; return false }
  let checks = 0
  const opts = { observed: true, mustArrive: true, arriveR: 3, reserve: 0, hpMin: 3, maxHops: 2,
    jump: 'stand', edgeOk: true, yTop: 45, yBot: 8, minBlockY: 113, maxTries: 40, lookOk: reject }
  const direct = hop.planHop(hop.worldOf(f.bot, 113, true), f.feet, f.to, opts)
  const onePass = checks
  assert.equal(direct.plan, null); assert.equal(direct.tries, 40); assert.ok(onePass > 0)
  checks = 0
  const result = await hop.hopTo(f.bot, f.to, { ...opts, log() {} })
  assert.equal(result.hops, 0); assert.equal(result.stop, 'нет броска')
  assert.deepEqual(result.why, direct.why)
  assert.equal(checks, onePass)
})
