import test from 'node:test'
import assert from 'node:assert/strict'
import { testBot, block } from '../daemon/test/tick-plugins-fixture'
import { native } from '../daemon/test/parkour-fixture'
import { cacheMethods } from '../daemon/src/rpc/caches'
import * as hop from '../daemon/src/pearl-hop'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmClimb } from './swarm/swarm-driver/climb'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmLoot } from './swarm/swarm-driver/loot'

for (const grounded of [true, false]) test(grounded
  ? 'a looter on a safe intermediate gallery keeps the roof claim while its status poll lags'
  : 'an airborne first pearl receipt cannot reserve the roof or establish a firing position', async t => {
  const { Vec3 } = require('../daemon/node_modules/vec3')
  const start = new Vec3(.5, 120, .5), roof = { x: 44.5, y: 153, z: 4.5, tier: 5, climbFrom: 120 }
  const arena = { x: 20, y: 120, z: 0, r: 89, killY: 113 }, board = { enemies: () => [] }
  let roofOpen = true
  const blocks = new Map()
  const blockAt = p => {
    const cell = p.floored(), { x, y, z } = cell
    const gallery = y === 135 && Math.abs(x - 20) <= 3 && Math.abs(z) <= 3
    const top = y === 152 && Math.abs(x - 44) <= 3 && Math.abs(z - 4) <= 3 && roofOpen
    const name = gallery || top ? 'glass' : y === 119 && Math.abs(x) < 7 && Math.abs(z) < 7 ? 'stone' : 'air'
    const key = cell.toString() + name
    if (!blocks.has(key)) blocks.set(key, block(name, cell))
    return blocks.get(key)
  }
  const pos: any = {}, bodies: any = {}, receipts: any[] = [], launches: Array<[string, number, number]> = []
  const actor = name => {
    const bot = bodies[name] = testBot()
    bot.username = name; bot.health = 20; bot.entity.position = start.clone()
    bot.blockAt = blockAt; bot.world = { getBlock: blockAt, raycast: require('../daemon/node_modules/prismarine-world/src/worldsync').prototype.raycast }
    bot.physics = native.Physics(bot.registry, bot.world)
    const stack = { name: 'ender_pearl', count: 3 }
    bot.inventory.items = () => [stack]
    pos[name] = { p: start.clone(), hp: 20, inv: { ender_pearl: stack.count }, armor: {} }
    const session: any = { require: () => bot, immediate: f => f(), runIntent: (_m, f) => f({ aborted: false }) }
    const rpc = cacheMethods({ session } as any)
    return { name, team: 'blue', c: { async call(method, params) {
      assert.equal(method, 'pearl_up')
      const detail = await rpc.pearl_up(params)
      receipts.push(detail)
      return { status: 'done', detail, state: { pos: bot.entity.position.clone(), health: bot.health, inventory: { ender_pearl: stack.count } } }
    } } }
  }
  const a = actor('A'), b = actor('B')
  t.mock.method(require('../daemon/src/throw'), 'throwAt', async (bot, _, opts) => {
    const eye = bot.entity.position.offset(0, hop.EYE, 0)
    const aim = opts.pick({ from: eye, moved: bot.entity.velocity, airborne: false })
    assert.ok(aim && opts.onAim())
    const world = hop.worldOf(bot, arena.killY)
    const trail = hop.simulate(world, eye, hop.velOf(aim.yaw, aim.pitch))
    assert.ok(trail.tp)
    const landing = hop.settle(world, trail.tp)
    assert.ok(landing.ok)
    launches.push([bot.username, bot.entity.position.y, landing.feet.y])
    bot.entity.position = landing.feet; bot.inventory.items()[0].count--; bot.health -= 5
    if (launches.length === 1) { roofOpen = false; bot.entity.onGround = grounded }
    return { thrown: true }
  })
  const sw: any = createDriverState({ bots: [a, b], pos, alive: () => true, now: () => 1000,
    arena, home: () => start, log() {}, hideouts: [roof] })
  Object.assign(sw, { boardOf: () => board, teamOf: () => 'blue' }, swarmRetry(sw))
  Object.assign(sw, swarmMoves(sw)); Object.assign(sw, swarmClimb(sw)); Object.assign(sw, swarmLoot(sw))
  assert.equal(await sw.tour(a, board), true)
  assert.equal(receipts[0].hops, 1); assert.equal(receipts[0].ok, false); assert.equal(receipts[0].stop, 'нет броска')
  assert.equal(pos.A.p.y, 120); assert.equal(bodies.A.entity.position.y, 136)
  assert.equal(!!receipts[0].partialLanding, grounded)
  assert.equal(receipts[0].landing, undefined, 'an intermediate hop never advertises the roof as reached')
  roofOpen = true
  const teammateTookSameRoof = await sw.tour(b, board)
  const first = bodies.A
  pos.A.p = first.entity.position.clone(); pos.A.inv.ender_pearl = first.inventory.items()[0].count
  await sw.tour(a, board)
  assert.deepEqual(launches, grounded ? [['A', 120, 136], ['A', 136, 153]] : [['A', 120, 136], ['B', 120, 136], ['B', 136, 153]])
  assert.equal(teammateTookSameRoof, !grounded)
  assert.equal(sw.toured.get('blue').get(0)?.by, grounded ? 'A' : 'B')
  assert.equal(sw.toured.get('blue').get(0)?.done, true)
})
