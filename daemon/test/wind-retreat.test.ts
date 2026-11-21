import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { worldOf, drive, native, Block, registry } from './parkour-fixture'
import { aerialMethods } from '../src/rpc/aerial'
import { eyeOf } from '../src/pick'
import { WIND, windBlockImpact, windImpulse, windInside } from '../src/combat/team-wind'
import { safeRetreatBurst } from '../src/combat/wind-retreat'
import * as clock from '../src/game-clock'
import { swarmMoves } from '../../farm/swarm/swarm-driver/moves'
import { swarmTurnTasks } from '../../farm/swarm/swarm-driver/turn-tasks'

const arena = { x: 0, y: 120, z: 0, r: 20, killY: 113 }
type Terrain = 'field' | 'island' | 'removeNext' | 'beforePacket'

async function retreat(terrain: Terrain, noise = new Vec3(0, 0, 0)) {
  const { bot, world } = worldOf([])
  drive(bot, world)
  let t = 0, spent = 0, airborne = false, outside = false, returned = -1, moved = new Vec3(0, 0, 0)
  const impulses: Array<{ tick: number, at: Vec3 }> = [], calls: string[] = [], replies: any[] = []
  world.getBlock = p => {
    const q = p.floored()
    const floor = q.y === 119 && q.x >= -20 && q.x < 20 && q.z >= -20 && q.z < 20 &&
      (terrain !== 'island' || q.x === 15 && q.z === 0) &&
      (terrain !== 'removeNext' || t < 25 || q.z < 9) &&
      (terrain !== 'beforePacket' || t < 4 || Math.abs(q.z) < 4)
    const b = Block.fromStateId(registry.blocksByName[floor ? 'stone' : 'air'].defaultState)
    b.position = q; return b
  }
  bot.entity.position = new Vec3(15.5, 120, .5)
  Object.assign(bot.entity, { height: 1.8, width: .6, metadata: [] })
  const charge = { name: 'wind_charge', count: 8, slot: 36 }
  bot.entities = {}; bot._client = new EventEmitter()
  bot.inventory = { items: () => [charge], slots: Array(46).fill(null) }
  bot.inventory.slots[36] = charge; bot.heldItem = charge; bot.quickBarSlot = 0
  bot.equip = async () => {}; bot.setQuickBarSlot = n => { bot.quickBarSlot = n }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.waitForTicks = async n => { while (n-- > 0) await new Promise(resolve => bot.once('physicsTick', resolve)) }
  bot.activateItem = () => {
    spent++
    const e = bot.entity, c = Math.cos(e.pitch)
    const v = new Vec3(-Math.sin(e.yaw) * c, Math.sin(e.pitch), -Math.cos(e.yaw) * c)
      .plus(noise.scaled(WIND.dispersion)).scaled(WIND.speed).plus(moved)
    const speed = v.norm(), hit = windBlockImpact(bot, eyeOf(bot), v.scaled(1 / speed), speed * 8, speed)
    assert.ok(hit)
    impulses.push({ tick: t + Math.ceil(hit.distance / speed), at: hit.burst })
  }
  const game = clock.activate(new clock.GameClock({ manual: true }))
  const ctl = { aborted: false, onAbort: [] }, session = { bot, require: () => bot, runIntent: (_, cb) => cb(ctl) }
  const rpc = aerialMethods({ session } as any)
  const b = { name: 'Weak', c: { async call(method, p) {
    calls.push(method)
    if (method === 'flee') return {}
    assert.equal(method, 'wind_jump')
    const r = await rpc.wind_jump(p); replies.push(r); return r
  } } }
  const sw: any = { arena, now: () => 0, alive: () => true, log() {}, generation: 1,
    blocked: () => false, failed() {}, detail: x => x, rangedAdvantage: () => false }
  sw.bounded = swarmMoves(sw).bounded
  const run = swarmTurnTasks(sw).turnFlee({ b, m: { p: bot.entity.position.clone(), inv: { wind_charge: 8 } },
    task: { data: {} }, context: { members: [] }, round: 1, enemies: [{ id: 'Champion', position: new Vec3(12.5, 120, .5), seenAt: 0 }]
  } as any).then(() => { returned = t })
  try {
    // Continue physics beyond the RPC result so an early success cannot hide a fatal fall.
    for (; t < 110;) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const before = bot.entity.position.clone(), st = new native.PlayerState(bot, bot.controlState)
      bot.physics.simulatePlayer(st, world); st.apply(bot); moved = bot.entity.position.minus(before); t++
      for (const hit of impulses) if (hit.tick === t) bot.entity.velocity.add(windImpulse(bot, bot.entity.position, hit.at))
      airborne ||= Math.abs(bot.entity.position.y - 120) > .01; outside ||= !windInside(bot.entity.position, arena)
      game.advanceTicks(1); bot.emit('physicsTick')
    }
    assert.ok(returned >= 0, 'the turn completes')
    return { spent, outside, airborne, at: bot.entity.position.clone(), grounded: bot.entity.onGround, calls, replies, returned }
  } finally {
    ctl.aborted = true; for (const stop of ctl.onAbort) stop()
    game.advanceTicks(200); await run; game.dispose(); clock.activate(null)
  }
}

test('ordinary swarm retreat rejects a bounded outward aim, then actually lands along the rim under shot dispersion', async () => {
  const samples = [new Vec3(0, 0, 0)]
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) samples.push(new Vec3(x, y, z))
  for (const noise of samples) {
    const r = await retreat('field', noise)
    assert.deepEqual(r.calls, ['wind_jump', 'wind_jump'])
    assert.equal(r.replies[0].used, 0); assert.equal(r.spent, 2)
    assert.ok(r.airborne && r.grounded && !r.outside && r.at.z > 8 && r.at.y === 120)
  }
})

test('no supported escape uses the ordinary foot retreat without spending a charge', async () => {
  const r = await retreat('island')
  assert.equal(r.spent, 0); assert.equal(r.airborne, false); assert.equal(r.calls.at(-1), 'flee')
})

test('a lost second landing spends only the first charge and remains on the first safe platform', async () => {
  const r = await retreat('removeNext')
  assert.equal(r.spent, 1); assert.ok(r.grounded && !r.outside && r.at.y === 120 && r.at.z < 9)
})

test('removing the landing during the run-up invalidates the release before use_item', async () => {
  const r = await retreat('beforePacket')
  assert.equal(r.spent, 0); assert.ok(r.grounded && !r.outside); assert.equal(r.calls.at(-1), 'flee')
})

test('the kill plane independently excludes an otherwise safe visible one-block descent', () => {
  const cells: Parameters<typeof worldOf>[0] = []
  for (let x = -3; x < 20; x++) for (let z = -3; z <= 3; z++) cells.push([x, x < 4 ? 119 : 118, z, 'stone'])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.5, 120, .5)
  bot.entity.height = 1.8
  assert.equal(safeRetreatBurst(bot, -Math.PI / 2, { ...arena, killY: 113 }), true)
  assert.equal(safeRetreatBurst(bot, -Math.PI / 2, { ...arena, killY: 119 }), false)
})
