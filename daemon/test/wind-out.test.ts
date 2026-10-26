import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()

// Platform x −8..4 over the void; the arena square ends at x = 5 (r 6.5 around −1.5).
function fixture() {
  const cells = new Map<string, string>()
  for (let x = -8; x <= 4; x++) for (let z = -5; z <= 5; z++) cells.set(`${x},0,${z}`, 'stone')
  const world = { getBlock(p: Vec3) {
    const q = p.floored(), name = cells.get(`${q.x},${q.y},${q.z}`) || 'air'
    const block = Block.fromStateId(registry.blocksByName[name].defaultState); block.position = q; return block
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384 }, health: 20, food: 20, username: 'A',
    inventory: { slots: [], items: () => [] }, entities: {},
    entity: { id: 1, username: 'A', position: new Vec3(-2, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    blockAt: p => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    ndClock: { age: 500n, serverTicks: 20, ticks: 20 }, physics: native.Physics(registry, world)
  })
  const foe: any = { id: 2, username: 'Enemy', name: 'player', type: 'player', isValid: true,
    position: new Vec3(4.2, 2.5, .5), velocity: new Vec3(.1, .2, 0), onGround: false, height: 1.8, width: .6,
    equipment: [], metadata: [] }
  bot.entities[2] = foe
  bot.players = { Enemy: { entity: foe, gamemode: 0 }, A: { entity: bot.entity, gamemode: 0 } }
  const own = { id: 'A', position: { x: -2, y: 1, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }
  return { bot, foe, own, arena: { x: -1.5, z: .5, r: 6.5, killY: -10 } }
}

test('wind out: an airborne foe at the edge is worth one own charge; the far centre, an ally and a spectator are not', () => {
  const { windOutDecide, windOutCandidates } = require('../src/combat/wind-out')
  const { bot, foe, own, arena } = fixture()
  const pick = windOutDecide(bot, own, arena)
  assert.ok(pick, 'one own shot throws the airborne foe past the edge')
  assert.match(pick.kind, /^out/)
  assert.equal(pick.plan.shots.length, 1)
  assert.equal(pick.plan.shots[0].thrower, 'A')
  assert.equal(pick.plan.baseline.out, false, 'without the charge he would not leave by himself')
  // Far from the edge: not even a candidate (the cheap gate before the full native rollout).
  const centre = fixture(); centre.foe.position = new Vec3(-3, 2.5, .5); centre.arena.r = 30
  assert.equal(windOutCandidates(centre.bot, centre.arena).length, 0)
  // A teammate in the same spot is never a target.
  const ally = fixture(); ally.bot._ndSwarmAllies = ['Enemy']
  assert.equal(windOutDecide(ally.bot, ally.own, ally.arena), null)
  // Already leaving by himself: keep the charge.
  const leaving = fixture(); leaving.foe.position.x = 4.6; leaving.foe.velocity = new Vec3(.3, .3, 0)
  assert.equal(windOutDecide(leaving.bot, leaving.own, leaving.arena), null)
  const spectator = fixture(); spectator.bot.players.Enemy.gamemode = 3
  assert.equal(windOutDecide(spectator.bot, spectator.own, spectator.arena), null)
})

test('wind out: falling below the death line counts as out even inside the square', () => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, own } = fixture()
  // Wide square (no side exit), but the platform ends at x = 4: past it is the void below killY.
  const plan = planEnemyWind(bot, foe, [own], { arena: { x: -1.5, z: .5, r: 40, killY: -10 }, startTick: 501, maxShots: 1 })
  assert.ok(plan, JSON.stringify(plan))
  assert.ok(plan.nominal.ticks > 15, 'the exit is the fall below killY, not the square side')
  assert.equal(plan.nominal.out, true, 'pushed off the platform edge into the void')
})

test('wind out: a standing foe is aimed where he stands — he cannot react before the burst, only after it', () => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, own, arena } = fixture()
  foe.position = new Vec3(4.4, 1, .5); foe.velocity = new Vec3(0, 0, 0); foe.onGround = true
  const options = { arena, startTick: 500, maxShots: 1, delays: [0] }
  assert.equal(planEnemyWind(bot, foe, [own], options), null, 'old model: he sprints home before the charge arrives, so it never hits')
  const plan = planEnemyWind(bot, foe, [own], { ...options, reactAfterHit: true })
  assert.ok(plan && Math.abs(plan.shots[0].feet.x - 4.4) < .05, 'aimed at the standing body')
  // One charge at a standing player who steers back after it: a small shove, not a kill — the reflex keeps the charge.
  assert.equal(plan.nominal.out, false)
  assert.ok(plan.nominal.progress > 0 && plan.nominal.progress < 1)
})

test('wind out: high in the air far from any edge — juggle him (longer airborne, not inward), not wait for the rim', () => {
  const { windOutDecide, windOutCandidates, heightAbove } = require('../src/combat/wind-out')
  const { bot, foe, own } = fixture()
  const arena = { x: -1.5, z: .5, r: 40, killY: -10 }
  foe.position = new Vec3(0, 6, .5); foe.velocity = new Vec3(.05, .3, 0); foe.onGround = false
  assert.ok(Math.abs(heightAbove(bot, foe.position) - 5) < 1e-6)
  assert.equal(windOutCandidates(bot, arena).length, 1, 'a high flyer is a candidate anywhere')
  const pick = windOutDecide(bot, own, arena)
  assert.ok(pick, 'juggling shot found')
  assert.ok(pick.plan.nominal.air > pick.plan.baseline.air, JSON.stringify({ n: pick.plan.nominal, b: pick.plan.baseline }))
  // Standing on the floor in the middle: no juggling, no edge — keep the charge.
  foe.position = new Vec3(0, 1, .5); foe.velocity = new Vec3(0, 0, 0); foe.onGround = true
  assert.equal(windOutCandidates(bot, arena).length, 0)
})

test('trampoline: an ally with a mace just jumped toward a foe — charge at the floor under his landing feet lifts him; no mace — no throw', () => {
  const { trampolineDecide } = require('../src/combat/wind-out')
  const { bot, foe, own } = fixture()
  foe.position = new Vec3(3.5, 1, .5); foe.velocity = new Vec3(0, 0, 0); foe.onGround = true
  const ally: any = { id: 3, username: 'Mace', type: 'player', position: new Vec3(0, 1.4, 2.5), velocity: new Vec3(.2, .33, -.05), onGround: false,
    heldItem: { name: 'mace' }, equipment: [{ name: 'mace' }], width: .6, height: 1.8, isValid: true }
  bot.entities[3] = ally; bot.players.Mace = { entity: ally, gamemode: 0 }; bot._ndSwarmAllies = ['Mace']
  const pick = trampolineDecide(bot, own)
  assert.ok(pick, 'trampoline found')
  assert.equal(pick.kind, 'trampoline'); assert.equal(pick.ally, 'Mace')
  assert.ok(pick.kick >= .5, String(pick.kick))
  foe.onGround = false; foe.position.y = 4
  assert.equal(trampolineDecide(bot, own)?.kind, 'volley', 'a launched foe: send the mace up to meet him')
  ally.heldItem = { name: 'iron_sword' }; ally.equipment = [{ name: 'iron_sword' }]
  assert.equal(trampolineDecide(bot, own), null)
})

test('trampoline: only the teammate closest to the jumper throws', () => {
  const { trampolineDecide } = require('../src/combat/wind-out')
  const { bot, foe, own } = fixture()
  foe.position = new Vec3(3.5, 1, .5); foe.velocity = new Vec3(0, 0, 0); foe.onGround = true
  const ally: any = { id: 3, username: 'Mace', type: 'player', position: new Vec3(0, 1.4, 2.5), velocity: new Vec3(.2, .33, -.05), onGround: false,
    heldItem: { name: 'mace' }, equipment: [{ name: 'mace' }], width: .6, height: 1.8, isValid: true }
  const closer: any = { id: 4, username: 'Near', type: 'player', position: new Vec3(.5, 1, 3.5), velocity: new Vec3(0, 0, 0), onGround: true, width: .6, height: 1.8, isValid: true }
  bot.entities[3] = ally; bot.entities[4] = closer
  bot.players.Mace = { entity: ally, gamemode: 0 }; bot.players.Near = { entity: closer, gamemode: 0 }; bot._ndSwarmAllies = ['Mace', 'Near']
  assert.equal(trampolineDecide(bot, own), null, 'Near is closer to him — Near throws')
})

test('mace descent target: a visible foe below within 6 blocks; an ally or a foe at my height is not', () => {
  const { maceTarget } = require('../src/combat/wind-out')
  const { bot, foe } = fixture()
  foe.position = new Vec3(1, 1, .5)
  assert.equal(maceTarget(bot, { x: 0, y: 7, z: .5 })?.username, 'Enemy')
  assert.equal(maceTarget(bot, { x: 0, y: 2, z: .5 }), null, 'not below me')
  bot._ndSwarmAllies = ['Enemy']
  assert.equal(maceTarget(bot, { x: 0, y: 7, z: .5 }), null)
})

test('wind out: release freshness follows observed game time and rechecks the queued release', async t => {
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const hands = require('../src/mace/hands') as typeof import('../src/mace/hands')
  const enemy = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const execute = require('../src/combat/enemy-wind-execute') as typeof import('../src/combat/enemy-wind-execute')
  const out = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
  const worldTick = require('../src/combat/team-wind').worldTick
  const nativePlan = enemy.planEnemyWind, afterPacket = hands.afterPacket
  for (const c of [
    { name: '20 TPS fresh', rate: 20, elapsed: 60, fired: 1, lag: 1 },
    { name: '20 TPS last accepted instant', rate: 20, elapsed: 125, fired: 1, lag: 1 },
    { name: '20 TPS past the deadline', rate: 20, elapsed: 125.001, fired: 0, lag: 1 },
    { name: '40 TPS passes the forecast window before 125 wall ms', rate: 40, elapsed: 100, fired: 0, lag: 2 },
    { name: '5 TPS still fresh after 200 wall ms', rate: 5, elapsed: 200, fired: 1, lag: 0 },
    { name: 'rate changes while queued', rate: 20, afterRate: 40, elapsed: 80, fired: 0, lag: 1 },
    { name: 'next tick within the forecast lead', rate: 20, elapsed: 50, ticks: 1, fired: 1, lag: 1 },
    { name: 'clock catches up after scheduling', rate: 20, elapsed: 40, ticks: 4, fired: 0, lag: 1 },
    { name: 'clock rewinds after scheduling', rate: 20, elapsed: 40, ticks: -1, fired: 0, lag: 1 },
    { name: 'clock unavailable after scheduling', rate: 20, elapsed: 40, missing: true, fired: 0, lag: 1 },
    { name: 'clock replaced after scheduling', rate: 20, elapsed: 40, replaced: true, fired: 0, lag: 1 },
    { name: 'same clock reanchors on respawn at the same world age', rate: 20, elapsed: 600, reanchor: true, fired: 0, lag: 1 }
  ]) await t.test(c.name, async st => {
    const { bot, own, arena } = fixture()
    let wallMs = 0, fired = 0, lag: number | undefined, complete!: () => void
    st.mock.method(clock.wall, 'monotonic', () => wallMs)
    const producer = new clock.GameClock({ epoch: 0 })
    producer.setState({ tick_rate: c.rate }); producer.syncAge(500n); bot.ndClock = producer
    st.after(() => { producer.dispose(); bot.removeAllListeners() })
    bot._client = new EventEmitter(); producer.attach(bot)
    bot.getControlState = () => false; bot.activateItem = () => { fired++ }
    st.mock.method(hands, 'windReady', () => true); st.mock.method(hands, 'offWind', () => true)
    st.mock.method(hands, 'hotbarIndex', () => 0)
    st.mock.method(execute, 'enemyWindReport', () => ({ ok: true, ready: true, report: { ...own, gameTick: worldTick(bot) } }))
    st.mock.method(enemy, 'planEnemyWind', (...args: Parameters<typeof nativePlan>) => {
      lag = args[3].delays![0]
      const plan = nativePlan(...args); wallMs = 20; return plan
    })
    const released = new Promise<void>(resolve => { complete = resolve })
    let queued = false
    st.mock.method(hands, 'afterPacket', (b, fn) => { queued = true; afterPacket(b, () => { fn(); complete() }) })
    const session: any = { bot, _rescue: { arena }, current: null }
    out.installWindOut(session)
    bot.emit('physicsTick'); bot.emit('physicsTick')
    assert.ok(queued, 'the real native plan reached the actual afterPacket queue')
    if (c.afterRate) producer.setState({ tick_rate: c.afterRate })
    wallMs = c.elapsed
    producer.ticks += c.ticks || 0
    if (c.reanchor) { bot.emit('respawn'); producer.syncAge(500n) }
    if (c.missing) producer.age = null
    if (c.replaced) bot.ndClock = { age: 500n, serverTicks: 0, ticks: 0 }
    await released
    assert.equal(fired, c.fired, JSON.stringify(c))
    assert.equal(lag, c.lag, 'wall planning cost is converted at the observed tick rate')
    assert.equal(session._windOut.log[0]?.why, c.fired ? undefined : 'stale_release')
  })
})

test('wind out: one native forecast blocked for 220 ms never releases its stale first trajectory', async t => {
  const { bot, own, arena } = fixture()
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const hands = require('../src/mace/hands') as typeof import('../src/mace/hands')
  const enemy = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const execute = require('../src/combat/enemy-wind-execute') as typeof import('../src/combat/enemy-wind-execute')
  const out = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
  const worldTick = require('../src/combat/team-wind').worldTick
  const nativePlan = enemy.planEnemyWind, afterPacket = hands.afterPacket
  const producer = new clock.GameClock(); producer.syncAge(500n); bot.ndClock = producer
  t.after(() => { producer.dispose(); bot.removeAllListeners() })
  let plans = 0, fired = 0, before: number | null = null, after: number | null = null, lag: number | undefined, complete!: () => void
  bot._client = new EventEmitter(); bot.getControlState = () => false; bot.activateItem = () => { fired++ }
  t.mock.method(hands, 'windReady', () => plans === 0); t.mock.method(hands, 'offWind', () => true)
  t.mock.method(hands, 'hotbarIndex', () => 0)
  t.mock.method(execute, 'enemyWindReport', () => ({ ok: true, ready: true, report: { ...own, gameTick: worldTick(bot) } }))
  t.mock.method(enemy, 'planEnemyWind', (...args: Parameters<typeof nativePlan>) => {
    plans++; lag = args[3].delays![0]; before = worldTick(bot)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 220)
    after = worldTick(bot); return nativePlan(...args)
  })
  const released = new Promise<void>(resolve => { complete = resolve })
  t.mock.method(hands, 'afterPacket', (b, fn) => afterPacket(b, () => { fn(); complete() }))
  const session: any = { bot, _rescue: { arena }, current: null }
  out.installWindOut(session)
  producer.on('tick', () => { bot.emit('physicsTick'); bot.emit('physicTick') }); producer.start()
  await released
  assert.equal(plans, 1, 'only the first forecast can affect this release receipt')
  assert.equal(lag, 1)
  assert.equal(after, before, 'the actual clock cannot process timer/time packets during the forecast')
  assert.equal(fired, 0)
  assert.equal(session._windOut.log[0]?.why, 'stale_release')
})
