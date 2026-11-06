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
  return { bot, foe, own, cells, arena: { x: -1.5, z: .5, r: 6.5, killY: -10 } }
}

function centreFixture() {
  const f = fixture()
  f.cells.clear()
  for (let x = 516; x <= 684; x++) for (let z = 516; z <= 684; z++) f.cells.set(`${x},119,${z}`, 'sand')
  Object.assign(f.bot.entity, { position: new Vec3(608.5, 120, 598.5), velocity: new Vec3(0, 0, 0) })
  Object.assign(f.own, { position: { ...f.bot.entity.position } })
  // Native pure-up descent near the apex, centre-2026-11-03T20-44-23-127Z/reactive-up-idle.packets.json.
  Object.assign(f.foe, { position: new Vec3(600.5648863263623, 131.14380700070453, 600.4419828413247),
    velocity: new Vec3(0, -.27824629393750167, 0), onGround: false })
  return { ...f, arena: { x: 600, z: 600, r: 80, killY: 113, ellipse: { a: 77, b: 65 } } }
}

test('the arena reflex sees native wind cooldown before the first duel and at release', t => {
  const { bot, arena } = fixture()
  const { installWindOut, release } = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
  const { windReady } = require('../src/mace/hands') as typeof import('../src/mace/hands')
  bot._client = new EventEmitter()
  bot.inventory.slots[45] = { name: 'wind_charge', count: 1 }
  let uses = 0
  bot.activateItem = () => { uses++ }
  t.after(() => bot.emit('end'))
  installWindOut({ bot, _rescue: { arena } })
  const cooldown = cooldownTicks => bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks })
  cooldown(10)
  assert.equal(windReady(bot), false)
  assert.equal(release(bot, { yaw: 0, pitch: 0 }), false)
  assert.equal(uses, 0)
  cooldown(0)
  assert.equal(release(bot, { yaw: 0, pitch: 0 }), true)
  assert.equal(uses, 1)
})

function upwindShooter(bot, foe, own, arena) {
  const axis = new Vec3(foe.position.x - arena.x, 0, foe.position.z - arena.z)
  if (Math.abs(axis.x) <= foe.width / 2 && Math.abs(axis.z) <= foe.width / 2) axis.set(0, 0, 1)
  axis.normalize()
  bot.entity.position = new Vec3(foe.position.x - 8 * axis.x, 120, foe.position.z - 8 * axis.z)
  own.position = { ...bot.entity.position }
  return axis
}

test('wind out: visible low central and distant targets reach the native planner in either own pose', t => {
  const { windOutCandidates } = require('../src/combat/wind-out')
  for (const flying of [false, true]) for (const grounded of [false, true]) for (const dx of [2, 40, 60]) {
    const { bot, foe, arena } = centreFixture()
    bot.entity.elytraFlying = flying
    foe.onGround = grounded; foe.position = bot.entity.position.offset(dx, grounded ? 0 : .5, 0)
    assert.deepEqual(windOutCandidates(bot, arena), [foe], `${flying}/${grounded}/${dx}`)
  }
  const f = fixture(); f.bot.blockAt = () => null
  assert.deepEqual(windOutCandidates(f.bot, f.arena), [], 'unknown LOS is still rejected')
})

test('wind out: recorded Z2 horizontal gains remain useful with unchanged or shorter air and the last charge', async t => {
  const enemy = require('../src/combat/enemy-wind')
  const { windOutDecide } = require('../src/combat/wind-out')
  for (const s of [
    { actor: 'd+2691', baseline: .09653511455256858, nominal: 1.5022273893325178, air: 13, at: [599.84521484375, 139.68293944001198, 604.54736328125] },
    { actor: 'BASE+3209', baseline: .9125865345065716, nominal: 1.6796582495271153, air: 2, at: [598.639404296875, 124.51692381501198, 609.4169921875] }
  ]) await t.test(s.actor, st => {
    const { bot, foe, own, arena } = centreFixture()
    foe.position = new Vec3(...s.at as [number, number, number])
    bot.inventory.items = () => [{ name: 'wind_charge', count: 1 }]
    const ram = { ...foe, id: 3, username: 'Ram', position: bot.entity.position.offset(1, 5, 0), elytraFlying: true }
    bot.entities[3] = ram; bot.players.Ram = { entity: ram, gamemode: 0 }
    const plan: any = { baseline: { out: false, exited: false, progress: s.baseline, air: s.air },
      nominal: { out: false, exited: false, progress: s.nominal, air: s.air },
      worst: { out: false, exited: false, progress: 0 }, shots: [{ thrower: own.id, fireDelay: 0 }] }
    st.mock.method(enemy, 'planEnemyWind', (_bot, target) => target === foe ? plan : null)
    assert.equal(windOutDecide(bot, own, arena)?.kind, 'chain')
    plan.nominal.air--
    assert.equal(windOutDecide(bot, own, arena)?.kind, 'chain', 'a native outward landing gain is independent of extra airtime')
    plan.nominal.progress = s.baseline
    assert.equal(windOutDecide(bot, own, arena), null, 'no landing or air gain is refused')
    plan.nominal.progress -= .001; plan.nominal.air = s.air + 5
    assert.equal(windOutDecide(bot, own, arena), null, 'extra airtime cannot buy an inward landing')
  })
})

test('wind out: later visible targets and every potential visible ally are considered within the deadline', t => {
  const enemy = require('../src/combat/enemy-wind'), clock = require('../src/game-clock')
  const { windOutDecide } = require('../src/combat/wind-out')
  const { bot, foe, own, arena } = centreFixture()
  for (let k = 3; k <= 4; k++) {
    const e = { ...foe, id: k, username: `Foe${k}`, position: foe.position.offset(k, 0, k) }
    bot.entities[k] = e; bot.players[e.username] = { entity: e, gamemode: 0 }
  }
  bot._ndSwarmAllies = []
  for (let k = 10; k < 16; k++) {
    const e = { ...foe, id: k, username: `Ally${k}`, position: foe.position.offset((k - 12) * .7, 0, 2) }
    bot.entities[k] = e; bot.players[e.username] = { entity: e, gamemode: 0 }; bot._ndSwarmAllies.push(e.username)
  }
  const visited: string[] = []
  t.mock.method(enemy, 'planEnemyWind', (_bot, target, _own, opts) => {
    visited.push(target.username)
    assert.equal(opts.allies.length, 6, 'the fifth or sixth visible ally cannot disappear from blast safety')
    return visited.length < 3 ? null : { baseline: { out: false, progress: 0, air: 1 }, nominal: { exited: false, progress: .01, air: 1 },
      worst: { exited: false, progress: 0 }, shots: [{ thrower: own.id, fireDelay: 0 }] }
  })
  t.mock.method(clock.wall, 'monotonic', () => 10)
  assert.ok(windOutDecide(bot, own, arena, 0, 11)); assert.equal(visited.length, 3)
  visited.length = 0
  assert.equal(windOutDecide(bot, own, arena, 0, 9), null); assert.equal(visited.length, 0, 'expired budget never starts another forecast')
})

// Supply three real native air poses ending at this fixture's original position and velocity.
// Solve the short affine kernel response rather than assuming a packet duration or reversing drag constants.
function observeNativeMotion(bot: any, foe: any, velocity = foe.velocity) {
  const core = require('../src/combat/enemy-wind'), edges = require('../src/edges'), clock = require('../src/game-clock')
  const position = foe.position.clone(), world = edges.worldOf(bot), simulate = edges.simOf(bot)
  const state = v => edges.stateOf({ ...bot, entity: { ...foe, position: position.clone(), velocity: v, effects: {}, attributes: {}, yaw: 0, pitch: 0 } }, edges.IDLE)
  const run = v => { const s = state(v); simulate(s, world); simulate(s, world); return s }
  const zero = run(new Vec3(0, 0, 0)), start = new Vec3(0, 0, 0)
  for (const axis of ['x', 'y', 'z']) { const unit = new Vec3(0, 0, 0); unit[axis] = 1; start[axis] = (velocity[axis] - zero.vel[axis]) / (run(unit).vel[axis] - zero.vel[axis]) }
  const s = state(start), end = run(start), at = clock.observationNow()
  s.pos = position.minus(end.pos.minus(position))
  core.installWindTracking(bot)
  let observed = at - 100
  foe._ndObservationNow = () => observed
  for (let step = 0; step <= 2; step++) {
    observed = at - 100 + step * 50; foe.position = s.pos.clone()
    foe._ndPositionReceipts = [foe._ndPositionReceipts?.[1] || null, { ...s.pos, t: observed, kind: 'rel_entity_move', grounded: false }]
    core.observeEnemyWindMotion(bot, foe)
    if (step < 2) simulate(s, world)
  }
  assert.ok(foe.position.distanceTo(position) < 1e-8); assert.ok(s.vel.distanceTo(velocity) < 1e-8)
  foe._ndObservationNow = () => clock.observationNow()
}

test('wind out: a visible ally initially beyond seven blocks is forecast before the native burst', t => {
  const enemy = require('../src/combat/enemy-wind'), out = require('../src/combat/wind-out')
  for (const moving of [false, true]) {
    const { bot, foe, own, arena } = centreFixture()
    upwindShooter(bot, foe, own, arena)
    bot._client = new EventEmitter()
    observeNativeMotion(bot, foe)
    const ally: any = { ...foe, id: 3, username: 'Ally', position: foe.position.offset(8, -2, 0),
      velocity: new Vec3(moving ? -1.5 : 0, 0, 0), onGround: false }
    observeNativeMotion(bot, ally)
    bot.entities[3] = ally; bot.players.Ally = { entity: ally, gamemode: 0 }; bot._ndSwarmAllies = ['Ally']
    assert.ok(ally.position.distanceTo(foe.position) > 7)
    const pick = out.windOutDecide(bot, own, arena)
    if (moving) assert.equal(pick, null, 'the visible future ally enters the native splash despite starting outside the old shortlist')
    else assert.ok(pick, 'a distant stationary ally outside the corridor and burst does not veto a useful shot')
  }
})

test('wind out: a visible distant glider keeps its public flight pose in the native ally forecast', t => {
  const enemy = require('../src/combat/enemy-wind'), out = require('../src/combat/wind-out')
  const { bot, foe, own, arena } = centreFixture()
  const ally: any = { ...foe, id: 3, username: 'Ally', position: foe.position.offset(18, -2, 5),
    velocity: new Vec3(-1.2, -.02, 0), onGround: false, elytraFlying: true, height: .6,
    yaw: -Math.PI / 2, pitch: .2, metadata: [128] }
  bot.entities[3] = ally; bot.players.Ally = { entity: ally, gamemode: 0 }; bot._ndSwarmAllies = ['Ally']
  let report: any
  const nativePlan = enemy.planEnemyWind
  t.mock.method(enemy, 'planEnemyWind', (...args) => { report = args[3].allies[0]; return nativePlan(...args) })
  out.windOutDecide(bot, own, arena)
  assert.ok(report, 'an ally outside the former radius still reaches the native forecast')
  assert.equal(report.gliding, true); assert.equal(report.eyeHeight, .4)
  assert.equal(report.yaw, ally.yaw); assert.equal(report.pitch, ally.pitch)
  const flight = enemy.windReportAt(bot, report, own.gameTick + 5)
  const falling = enemy.windReportAt(bot, { ...report, gliding: false }, own.gameTick + 5)
  assert.ok(flight && falling && new Vec3(flight.position.x, flight.position.y, flight.position.z)
    .distanceTo(new Vec3(falling.position.x, falling.position.y, falling.position.z)) > .1,
  'native elytra motion is not replaced by a standing body in free fall')
})

test('wind out: a centre apex uses the caster behind the common initial outward direction', () => {
  const { windOutDecide } = require('../src/combat/wind-out')
  for (const centre of [600, 600.5]) for (const lag of [0]) {
    const { bot, foe, own, arena } = centreFixture(), before = foe.position.clone()
    arena.x = arena.z = centre
    const original = windOutDecide(bot, own, arena, lag)
    if (centre === 600) assert.equal(original, null, 'outside the central footprint a westward radius gain opposes the initial radial direction')
    else assert.ok(original && original.plan.nominal.position.z > foe.position.z, 'inside the footprint the same diagonal cast has genuine progress towards the common south exit')
    const axis = upwindShooter(bot, foe, own, arena)
    const pick = windOutDecide(bot, own, arena, lag)
    assert.ok(pick, `a caster behind the shared direction offers a useful native landing: centre ${centre}, lag ${lag}`)
    assert.equal(pick.kind, 'juggle')
    assert.ok(pick.plan.nominal.position.minus(foe.position).dot(axis) > 0, 'the predicted first landing follows the initial shared axis')
    assert.equal(pick.plan.nominal.position.y, 120, 'progress is measured at the native landing, not at the later ground return')
    assert.ok(pick.plan.nominal.progress - Math.max(0, pick.plan.baseline.progress) >= .3)
    assert.ok(pick.plan.nominal.air >= pick.plan.baseline.air + 6)
    assert.equal(pick.plan.nominal.out, false, 'this is a measured step towards an exit, not a claimed complete throw-out')
    assert.deepEqual(foe.position, before, 'planning does not move the observed body')
  }
})

test('wind out: a later aligned centre ray still offers native extra air and outward progress', () => {
  const { windOutDecide } = require('../src/combat/wind-out'), { planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, own, arena } = centreFixture()
  upwindShooter(bot, foe, own, arena)
  const plan = planEnemyWind(bot, foe, [own], { arena, startTick: 500, maxShots: 1, delays: [1], reactAfterHit: true, juggle: true })
  assert.ok(plan && plan.nominal.progress - Math.max(0, plan.baseline.progress) >= .3)
  assert.ok(plan.nominal.air > plan.baseline.air, 'the stationary native launch adds useful flight time without inventing owner motion')
  assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'juggle')
})

test('wind out: the measured N opposing stationary shot cannot borrow gain from a reactive centre crossing', () => {
  const { bot, foe, own, arena } = centreFixture()
  arena.x = arena.z = 600.5
  bot.entity.position = new Vec3(612.5, 120, 602.5); own.position = { ...bot.entity.position }
  foe.position = new Vec3(600.6808724634146, 131.20302061645475, 600.6717022012984)
  foe.velocity = new Vec3(.0046263836019051425, -.08515774431568611, .004387087898358325)
  const out = require('../src/combat/wind-out')
  assert.equal(out.windOutDecide(bot, own, arena, 0), null)
})

test('wind out: early native pure-up air gain does not justify a landing closer to the centre', () => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  const { windOutDecide } = require('../src/combat/wind-out')
  const { bot, foe, own, arena } = centreFixture()
  Object.assign(foe, { position: new Vec3(600.5300956688446, 125.49032981428786, 600.4717611060332),
    velocity: new Vec3(.00591066374033554, 1.0108231648474948, -.005546000904568203) })
  const plan = planEnemyWind(bot, foe, [own], { arena, startTick: 500, maxShots: 1, delays: [0], reactAfterHit: true, juggle: true })
  assert.equal(plan, null, 'the planner already rejects opposing air gain under the same observed input')
  assert.equal(windOutDecide(bot, own, arena), null)
})

test('wind out: recorded Q rising plans buy useful air before the apex without moving the landing inward', async t => {
  const enemy = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const { windOutDecide } = require('../src/combat/wind-out')
  // Q1 BASE planEnemyWind results, wind-centre-2026-11-04T14-32-48-675Z / wind-q-capture.
  // Replay the measured native outcomes here; the policy must not discard +16/+10/+14 air ticks for a sub-.3m gain.
  for (const sample of [
    { y: 124.58113279938698, baseline: .021482769971549277, nominal: .14530876819729233, air: 22, addedAir: 16 },
    { y: 129.54036131501198, baseline: .04825885661991859, nominal: .2446723982990771, air: 24, addedAir: 10 },
    { y: 130.77668944001198, baseline: .015740310837230265, nominal: .15122434091858208, air: 21, addedAir: 14 }
  ]) await t.test(`rise y=${sample.y}`, st => {
    const { bot, foe, own, arena } = centreFixture()
    arena.x = arena.z = 600.5
    foe.position.y = sample.y
    const plan: any = { baseline: { out: false, exited: false, progress: sample.baseline, air: sample.air },
      nominal: { out: false, exited: false, progress: sample.nominal, air: sample.air + sample.addedAir },
      worst: { out: false, exited: false, progress: 0 }, shots: [{ thrower: own.id, fireDelay: 1 }] }
    st.mock.method(enemy, 'planEnemyWind', () => plan)
    assert.ok(sample.nominal > sample.baseline && sample.nominal - sample.baseline < .3)
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'juggle')
    // Zero landing gain still buys a complete native air tick from either side.
    plan.nominal.progress = sample.baseline
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'juggle')
    bot.entity.position = new Vec3(arena.x, 120, arena.z); own.position = { ...bot.entity.position }
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'juggle')
    // The no-charge drift is still subtracted: even a small negative net gain is inward.
    plan.nominal.progress = sample.baseline - .001
    assert.equal(windOutDecide(bot, own, arena, 1), null)
    plan.nominal.progress = sample.nominal; plan.nominal.air = sample.air
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'chain', 'the native outward landing gain is useful without extra air')
  })
})

test('wind out: baseline drift cannot turn an opposing native centre gust into useful directed gain', () => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  const { windOutDecide } = require('../src/combat/wind-out')
  const { bot, foe, own, arena } = centreFixture()
  arena.x = arena.z = 600.5
  // Same native rising body, with a small horizontal drift; no sprint or hidden opponent attributes.
  Object.assign(foe, { position: new Vec3(600.5648863263623, 130.5628138876425, 600.4419828413247),
    velocity: new Vec3(.03, .3605735694492054, 0) })
  bot.entity.position.z = 602.5; own.position = { ...bot.entity.position } // South-side throw opposes the common +Z exit inside the central footprint.
  const plan = planEnemyWind(bot, foe, [own], { arena, startTick: 500, maxShots: 1, delays: [0], reactAfterHit: true, juggle: true })
  assert.equal(plan, null)
  assert.equal(windOutDecide(bot, own, arena), null)
})

test('wind out: recorded AG negative baselines retain the actual positive added progress', async t => {
  const enemy = require('../src/combat/enemy-wind'), { windOutDecide } = require('../src/combat/wind-out')
  // Actual AG c +814/+937 kernel returns. These policy fixtures preserve the recorded outcomes, not a reconstructed collision world.
  for (const sample of [
    { at: 814, baseline: -13.14853105984183, nominal: -11.15668454672196 },
    { at: 937, baseline: -14.002160464733695, nominal: -13.104446359070279 }
  ]) await t.test(`c+${sample.at}`, st => {
    const { bot, foe, own, arena } = centreFixture()
    const plan: any = { baseline: { out: false, exited: false, progress: sample.baseline, air: 65 },
      nominal: { out: false, exited: false, progress: sample.nominal, air: 65 },
      worst: { out: false, exited: false, progress: sample.nominal, air: 65 }, shots: [{ thrower: own.id, fireDelay: 1 }] }
    st.mock.method(enemy, 'planEnemyWind', () => plan)
    assert.ok(plan.nominal.progress + .05 * plan.nominal.air > plan.baseline.progress + .05 * plan.baseline.air, 'the recorded native planner already prices this above no throw')
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'chain', 'the caller must preserve the same positive added progress')
    for (const baseline of [0, 2, -2]) {
      plan.baseline.progress = baseline; plan.nominal.progress = baseline
      assert.equal(windOutDecide(bot, own, arena, 1), null, 'unchanged progress and air buy nothing for any baseline sign')
      plan.nominal.progress = baseline + .005
      assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'chain', 'a small genuine gain needs no new minimum')
      plan.nominal.progress = baseline - .005
      assert.equal(windOutDecide(bot, own, arena, 1), null, 'a worse outcome is still rejected')
    }
    plan.nominal.exited = plan.worst.exited = true
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'out', 'actual opposite-side exit keeps priority over negative added progress')
    assert.equal(foe.onGround, false)
  })
})

test('wind out: recorded R followups keep useful air and outward progress after the first native hit', async t => {
  const enemy = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const { windOutDecide } = require('../src/combat/wind-out')
  // Replay actual R1 plan outcomes after projectile1717 hit; these are not new native launch measurements.
  for (const sample of [
    { actor: 'BASE+1403ms', at: [597.796142578125, 126.35896483063698, 601.53173828125], own: [606.6497979008948, 123.70864170315886, 598.6866585359203],
      baseline: .6963906423056629, nominal: 2.089016473858064, air: 10, added: 5 },
    { actor: 'c+1169ms', at: [599.558349609375, 126.58577147126198, 600.85595703125], own: [612.5, 120, 602.5],
      baseline: 2.186914580744327, nominal: 2.8921327847710687, air: 11, added: 2 },
    { actor: 'd+1135ms', at: [599.558349609375, 126.58577147126198, 600.85595703125], own: [614.5, 120, 600.5],
      baseline: 3.934761571655267, nominal: 4.871066942157965, air: 14, added: 2 }
  ]) await t.test(sample.actor, st => {
    const { bot, foe, own, arena } = centreFixture()
    arena.x = arena.z = 600.5
    foe.position = new Vec3(sample.at[0], sample.at[1], sample.at[2])
    bot.entity.position = new Vec3(sample.own[0], sample.own[1], sample.own[2]); own.position = { ...bot.entity.position }
    const plan: any = { baseline: { out: false, exited: false, progress: sample.baseline, air: sample.air },
      nominal: { out: false, exited: false, progress: sample.nominal, air: sample.air + sample.added },
      worst: { out: false, exited: false, progress: 0 }, shots: [{ thrower: own.id, fireDelay: 1 }] }
    st.mock.method(enemy, 'planEnemyWind', () => plan)
    assert.ok(Number.isInteger(plan.baseline.air) && Number.isInteger(plan.nominal.air), 'native air is a count of completed ticks')
    assert.ok(plan.nominal.progress + .05 * plan.nominal.air > plan.baseline.progress + .05 * plan.baseline.air + .01, 'the recorded native planner already prices this above no throw')
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'juggle')
    assert.equal(plan.nominal.out, false, 'continuing the escort is not a completed outer exit')
    plan.nominal.air = sample.air
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'chain', 'outward progress remains a useful chain outcome')
    plan.nominal.air = sample.air - 1
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'chain', 'shorter air still permits an improved outward landing')
    plan.nominal.air = sample.air + 1; plan.nominal.progress = sample.baseline - .001
    assert.equal(windOutDecide(bot, own, arena, 1), null, 'positive air cannot compensate an inward net landing')
    bot.entity.position = new Vec3(arena.x, 120, arena.z); own.position = { ...bot.entity.position }
    plan.nominal.progress = sample.baseline
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'juggle', 'one complete added tick with no inward gain is a physical benefit')
    foe.onGround = true
    assert.equal(windOutDecide(bot, own, arena, 1), null, 'ground contact is not prolonged air')
    foe.onGround = false; foe.elytraFlying = true; foe.metadata[0] = 128
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'juggle', 'the native outcome also decides the glider shot')
    foe.elytraFlying = false; foe.metadata[0] = 0
    const ram: any = { id: 99, username: 'Ram', type: 'player', position: bot.entity.position.offset(0, 6, 2),
      velocity: new Vec3(0, 0, 0), elytraFlying: true, onGround: false, height: .6, width: .6, metadata: [128], equipment: [] }
    bot.players.Ram = { entity: ram, gamemode: 0 }; bot.entities[99] = ram
    bot.inventory.items = () => [{ name: 'wind_charge', count: 2 }]
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'juggle', 'available wind is not reserved behind a fixed inventory threshold')
    bot.inventory.items = () => [{ name: 'wind_charge', count: 3 }]
    assert.equal(windOutDecide(bot, own, arena, 1)?.kind, 'juggle')
  })
})

test('wind out: an outside shooter near the eastern edge cannot buy air time by moving the landing inward', () => {
  const { windOutDecide } = require('../src/combat/wind-out')
  const { bot, foe, own, arena } = centreFixture()
  bot.entity.position = new Vec3(675, 120, 598.5); own.position = { ...bot.entity.position }
  foe.position.x = 670.5
  assert.equal(windOutDecide(bot, own, arena), null)
})

test('wind out: an airborne foe at the edge is worth one own charge; central targets reach the planner while allies and spectators do not', () => {
  const { windOutDecide, windOutCandidates } = require('../src/combat/wind-out')
  const { bot, foe, own, arena } = fixture()
  const pick = windOutDecide(bot, own, arena)
  assert.ok(pick, 'one own shot throws the airborne foe past the edge')
  assert.match(pick.kind, /^out/)
  assert.equal(pick.plan.shots.length, 1)
  assert.equal(pick.plan.shots[0].thrower, 'A')
  assert.equal(pick.plan.baseline.out, false, 'without the charge he would not leave by himself')
  // The centre reaches the same native planner as an edge target.
  const centre = fixture(); centre.foe.position = new Vec3(-3, 2.5, .5); centre.arena.r = 30
  assert.equal(windOutCandidates(centre.bot, centre.arena).length, 1)
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
  const arena = { x: -1.5, z: .5, r: 40, killY: -10 }
  const plan = planEnemyWind(bot, foe, [own], { arena, startTick: 500, maxShots: 1 })
  assert.ok(plan, JSON.stringify(plan))
  assert.ok(plan.nominal.ticks > 15, 'the exit is the fall below killY, not the square side')
  assert.equal(plan.nominal.out, true, 'pushed off the platform edge into the void')
  assert.equal(plan.nominal.exited, false, 'an interior kill hole is not proof of crossing the outer boundary')
  const late = planEnemyWind(bot, foe, [own], { arena, startTick: 501, maxShots: 1 })
  assert.ok(late?.nominal.out, 'continued observed input still lets a later native gust carry the body beyond support')
  assert.equal(late.nominal.exited, false, 'a kill hole remains distinct from the outer boundary')
})

test('wind out: nominal standing aim holds observed input while worst-case certification retains reaction', () => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, own, arena } = fixture()
  foe.position = new Vec3(4.2, 1, .5); foe.velocity = new Vec3(0, 0, 0); foe.onGround = true
  const options = { arena, startTick: 500, maxShots: 1, delays: [0] }
  const unannounced = planEnemyWind(bot, foe, [own], options)
  assert.ok(unannounced && Math.abs(unannounced.shots[0].feet.x - 4.2) < .05, 'nominal aim does not invent an early sprint')
  const plan = planEnemyWind(bot, foe, [own], { ...options, reactAfterHit: true })
  assert.ok(plan && Math.abs(plan.shots[0].feet.x - 4.2) < .05, 'aimed at the standing body')
  assert.ok(plan.nominal.progress > 0)
  assert.equal(plan.worst.out, false, 'reacting back towards the arena is still covered by worst-case certification')
  foe.position.x = 4.4
  const shifted = planEnemyWind(bot, foe, [own], { ...options, reactAfterHit: true })
  assert.ok(shifted)
  assert.ok(shifted.shots[0].burst.x < foe.position.x, 'the continued standing body has a real near-face entry, not an invented airborne detonation')
})

test('wind out: a high central candidate can gain an outward landing under continued observed input', () => {
  const { windOutDecide, windOutCandidates, heightAbove } = require('../src/combat/wind-out')
  const { bot, foe, own } = fixture()
  const arena = { x: -1.5, z: .5, r: 40, killY: -10 }
  foe.position = new Vec3(0, 6, .5); foe.velocity = new Vec3(.05, .3, 0); foe.onGround = false
  assert.ok(Math.abs(heightAbove(bot, foe.position) - 5) < 1e-6)
  assert.equal(windOutCandidates(bot, arena).length, 1, 'a high flyer is a candidate anywhere')
  const pick = windOutDecide(bot, own, arena)
  assert.ok(pick)
  assert.ok(pick.plan.nominal.progress > Math.max(0, pick.plan.baseline.progress), 'the native first landing improves, not just its transient peak')
  assert.equal(pick.plan.nominal.position.y, 1)
  // A standing central body is still a candidate; its actual trajectory decides the shot.
  foe.position = new Vec3(0, 1, .5); foe.velocity = new Vec3(0, 0, 0); foe.onGround = true
  assert.equal(windOutCandidates(bot, arena).length, 1)
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

test('wind out: a moving owner releases from his actual body, not the future planning origin', async t => {
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const hands = require('../src/mace/hands') as typeof import('../src/mace/hands')
  const enemy = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const out = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
  const { bot, foe, arena } = fixture()
  bot.entity.velocity = new Vec3(0, 0, .28); bot.entity.yaw = Math.PI
  bot.getControlState = k => k === 'forward' || k === 'sprint'
  bot._client = new EventEmitter()
  let fired: { yaw: number; pitch: number } | undefined, plans = 0
  bot.activateItem = () => { fired = { yaw: bot.entity.yaw, pitch: bot.entity.pitch } }
  t.after(() => { bot.removeAllListeners(); bot._client.removeAllListeners() })
  t.mock.method(clock.wall, 'monotonic', () => 0)
  t.mock.method(hands, 'windReady', () => true); t.mock.method(hands, 'offWind', () => true)
  t.mock.method(hands, 'hotbarIndex', () => 0)
  const nativePlan = enemy.planEnemyWind
  t.mock.method(enemy, 'planEnemyWind', (...args: Parameters<typeof nativePlan>) => { plans++; return nativePlan(...args) })
  out.installWindOut({ bot, _rescue: { arena }, current: null })
  observeNativeMotion(bot, foe)
  bot.emit('physicsTick'); bot.emit('physicsTick')
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve)) // afterPacket may queue another callback without a new physical tick.
  assert.equal(require('../src/combat/team-wind').worldTick(bot), 500)
  assert.ok(fired, 'the useful charge still releases in the current tick')
  const vz = -Math.cos(fired.yaw) * Math.cos(fired.pitch) * 1.5 + .28
  assert.ok(Math.abs(vz) < 1e-6, `the target stays at z=.5, so the actual projectile must not drift sideways: ${vz}`)
  assert.equal(plans, 1, 'release revalidation must not repeat the full chain search')
})

test('wind out: a visible charge already in flight cannot leave the next local shot aimed at the old trajectory', async t => {
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const hands = require('../src/mace/hands') as typeof import('../src/mace/hands')
  const out = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
  const enemy = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const { bot, foe, own, arena } = centreFixture()
  arena.x = 601 // This safety fixture chooses the west exit; the recorded charge/body geometry below stays intact.
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  timer.syncAge(500n); bot.ndClock = timer
  bot.entity.position = new Vec3(612.5, 120, 602.5); own.position = { ...bot.entity.position }
  // The C capture's d73 was released two ticks after c72, before c72 changed the target's trajectory.
  foe.position = new Vec3(600.5029296875, 128.134765625, 600.453857421875)
  foe.velocity = new Vec3(0, 1.19, -.01)
  t.mock.method(require('../src/bow/track'), 'observedVelocity', () => ({ x: 0, y: .36, z: 0, ageTicks: 2 }))
  bot._client = new EventEmitter(); bot.getControlState = () => false
  let fired: { yaw: number; pitch: number } | undefined
  bot.activateItem = () => { fired = { yaw: bot.entity.yaw, pitch: bot.entity.pitch } }
  t.after(() => { bot.emit('end'); bot.removeAllListeners(); bot._client.removeAllListeners(); timer.dispose(); clock.activate(null) })
  t.mock.method(clock.wall, 'monotonic', () => 0)
  t.mock.method(hands, 'windReady', () => true); t.mock.method(hands, 'offWind', () => true)
  t.mock.method(hands, 'hotbarIndex', () => 0)
  const session: any = { bot, _rescue: { arena }, current: null }
  out.installWindOut(session)
  observeNativeMotion(bot, foe, new Vec3(0, .36, 0))
  assert.ok(out.windOutDecide(bot, own, arena, 1), 'without c72 this real local decision considers the follow-up useful')
  bot.entities[66] = { id: 66, username: 'C', type: 'player', position: new Vec3(608.5, 120, 598.5), width: .6, height: 1.8 }
  const from = new Vec3(608.5, 121.62000000476837, 598.5)
  const velocity = new Vec3(-1.0025896401257395, 1.1043327260929077, .22775365915737916)
  bot.entities[72] = { id: 72, name: 'wind_charge', type: 'other', position: from.clone(), velocity: new Vec3(0, 0, 0), width: .25, height: .25 }
  bot._client.emit('packet', { entityId: 72, type: registry.entitiesByName.wind_charge.id, x: from.x, y: from.y, z: from.z, objectData: 66 },
    { name: 'spawn_entity' }, Buffer.from('014845787a737971407ab707bcc9bc9b6fd18f014083040000000000405e67ae148000004082b4000000000052ff8e938d5421c90042', 'hex'))
  assert.ok(Math.abs(bot._ndThrown.get(72).v.x - velocity.x) < .0001, 'the real C72 LPVec3 payload contains native motion even when raw entity.velocity is corrupt')
  bot.emit('entitySpawn', bot.entities[72])
  timer.advanceTicks(1)
  // C72's first native sync repeats its starting position with nonzero native motion; it is not a stop.
  bot.entities[72]._ndPositionReceipts = [null, { ...from, t: 1050, kind: 'sync_entity_position' }]
  bot._client.emit('sync_entity_position', { entityId: 72, ...from, dx: velocity.x, dy: velocity.y, dz: velocity.z })
  timer.advanceTicks(1)
  bot.emit('physicsTick'); bot.emit('physicsTick')
  await new Promise<void>(resolve => setImmediate(resolve))
  const first: any = { thrower: 'C', from, velocity, fireDelay: -2 }
  const before = enemy.enemyWindFrames(bot, foe, arena, [], 0, true)
  const after = enemy.enemyWindFrames(bot, foe, arena, [first], 0, true)
  assert.ok(after.some((f, i) => f.vel.distanceTo(before[i].vel) > .001), 'c72 is a real pending native body impulse, not just a nearby projectile')
  assert.equal(fired, undefined, 'wait for the pending unscheduled impulse rather than aim d73 at the old trajectory')
  assert.equal(out.windOutDecide(bot, own, arena, 1), null, 'a hit already in flight skips the local candidate search')
  const hit = enemy.pendingWindHit(bot, foe, before)
  assert.equal(hit?.id, 72); assert.equal(hit?.ticks, 6, 'the initial same-birth sync cannot rewind one already-observed flight tick')
  t.mock.method(clock, 'now', () => 1000)
  assert.equal(enemy.pendingWindHit(bot, foe, before)?.ticks, 6, 'a delayed body callback cannot freeze the native flight age')
  assert.equal(enemy.pendingWindHit(bot, foe, before, [{ ...first, fireTick: 500 }]), null, 'a known scheduled first shot is already in the coordinated forecast')
  assert.ok(enemy.pendingWindHit(bot, foe, before, [{ ...first, fireTick: 500, velocity: velocity.scaled(-1) }]), 'another trajectory is not deduplicated merely by owner and tick')
  const flight = bot.entities[72]
  Object.defineProperty(flight, 'velocity', { get() { throw new Error('raw projectile velocity is outside the fair view') } })
  assert.doesNotThrow(() => assert.equal(enemy.pendingWindHit(bot, foe, before)?.id, 72))
  const clear = bot.blockAt
  bot.blockAt = p => {
    if (Math.floor(p.x) !== 610 || p.y < 120 || p.y > 140) return clear(p)
    const block = Block.fromStateId(registry.blocksByName.stone.defaultState); block.position = p.floored(); return block
  }
  assert.equal(enemy.pendingWindHit(bot, foe, before), null, 'a remembered spawn is not extrapolated through current occlusion')
  flight.position = from.plus(velocity.scaled(2))
  flight._ndPositionReceipts = [{ ...from, t: 1000 }, { ...flight.position, t: 1100 }]
  bot.blockAt = clear
  assert.equal(enemy.pendingWindHit(bot, foe, before), null, 'reacquiring LOS cannot reuse the spawn velocity or motion receipts from before the gap')
  timer.advanceTicks(1)
  flight.position = from.plus(velocity.scaled(3))
  flight._ndPositionReceipts = [flight._ndPositionReceipts[1], { ...flight.position, t: 1150 }]
  assert.ok(enemy.pendingWindHit(bot, foe, before), 'two fresh visible positions restore the measured flight')
  timer.advanceTicks(1)
  flight.position = flight.position.minus(velocity)
  flight._ndPositionReceipts = [flight._ndPositionReceipts[1], { ...flight.position, t: 1200 }]
  assert.equal(enemy.pendingWindHit(bot, foe, before), null, 'a newly observed deflection away is not a pending impulse')
  delete bot.entities[72]
  assert.equal(enemy.pendingWindHit(bot, foe, before), null, 'an ended flight cannot retain a dependency')
})

test('wind out: the recorded visible d74 hit is protected when c75 would arrive two ticks earlier', t => {
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const core = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const { bot, foe } = centreFixture()
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  timer.syncAge(500n); bot.ndClock = timer; bot._client = new EventEmitter()
  t.after(() => { bot.emit('end'); timer.dispose(); clock.activate(null) })
  // Native30 c75 release11:05:33.572Z: d74 was already visible; its tick14 impact followed our tick12 arrival.
  foe.position = new Vec3(597.53857421875, 133.61083984375, 601.513916015625)
  bot.entities[68] = { id: 68, username: 'D', type: 'player', position: new Vec3(612.5, 120, 602.5), width: .6, height: 1.8 }
  const from = new Vec3(612.5, 121.62000000476837, 602.5)
  bot.entities[74] = { id: 74, name: 'wind_charge', type: 'other', position: from.clone(), velocity: new Vec3(0, 0, 0), width: .25, height: .25 }
  require('../src/threats').thrownTracker(bot)
  bot._client.emit('packet', { entityId: 74, type: 143, ...from, objectData: 68 }, { name: 'spawn_entity' },
    Buffer.from('014a76263da4fa77496fb27e269b9c8789738f014083240000000000405e67ae148000004082d400000000007aa082fd4bd410c10044', 'hex'))
  bot.emit('entitySpawn', bot.entities[74])
  timer.epoch += 52.467529296875
  bot.entities[74]._ndPositionReceipts = [null, { ...from, t: timer.epoch, kind: 'sync_entity_position' }]
  bot._client.emit('sync_entity_position', { entityId: 74, ...from, dx: -1.3731527771378287, dy: .5925101285984018, dz: .04673394520738569 })
  timer.epoch = 1058.928955078125
  const positions = [
    [596.9603271484375,133.84498953375004,601.695068359375],[596.4341223144531,133.99605623289025,601.8599169921876],
    [595.9552759155274,134.06570159940316,602.0099292480469],[595.519525692505,134.05555405838828,602.1464404008789],
    [595.1229929895545,133.9672094664743,602.270665549956],[594.7621482298696,133.80223176318765,602.3837104356162],
    [594.4337794985563,133.56215360929417,602.4865812815669],[594.1349639530613,133.24847701237354,602.5801937513821],
    [593.8630418066608,132.86267393988254,602.6653810989139],[593.6155926534364,132.4061869199569,602.7429015851679],
    [593.3904139240021,131.88042963019709,602.813445227659],[593.185501280217,131.28678747467856,602.8776399423259],
    [592.9990307743724,130.6266181494217,602.9360571326728],[592.8293426140539,129.90125219655235,602.9892167758884],
    [592.6749263881641,129.11199354737926,603.0375920512147],[592.5344076226044,128.26012005460984,603.0816135517616]
  ]
  const frames = positions.map(p => ({ pos: new Vec3(p[0], p[1], p[2]), vel: new Vec3(0, 0, 0), onGround: false }))
  const pending = core.pendingWindHit(bot, foe, frames)
  assert.equal(pending?.id, 74, 'a new impulse must not spoil the already-visible hit merely by arriving first')
  assert.equal(pending?.ticks, 13, 'preserving the birth phase includes the tick before the repeated initial sync')
})

test('wind out: queued release respects fresh defence, hands, visibility and friendly interception', async t => {
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const hands = require('../src/mace/hands') as typeof import('../src/mace/hands')
  const out = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
  for (const mode of ['dead', 'using-item', 'defence', 'target-gone', 'wall', 'ally']) await t.test(mode, st => {
    const { bot, arena } = fixture()
    const session: any = { bot, _rescue: { arena }, current: null }
    let queued: (() => void) | undefined, fired = 0
    bot._client = new EventEmitter(); bot.getControlState = () => false
    bot.activateItem = () => { fired++ }
    st.after(() => { bot.removeAllListeners(); bot._client.removeAllListeners() })
    st.mock.method(clock.wall, 'monotonic', () => 0)
    st.mock.method(hands, 'windReady', () => true); st.mock.method(hands, 'offWind', () => true)
    st.mock.method(hands, 'hotbarIndex', () => 0); st.mock.method(hands, 'afterPacket', (_b, fn) => { queued = fn })
    out.installWindOut(session)
    bot.emit('physicsTick'); bot.emit('physicsTick')
    assert.ok(queued, 'the candidate reaches the decision queue')
    if (mode === 'dead') bot.health = 0
    if (mode === 'using-item') bot.usingHeldItem = true
    if (mode === 'defence') session.current = { name: 'evade', ctl: { aborted: false } }
    if (mode === 'target-gone') delete bot.players.Enemy
    if (mode === 'wall') {
      const read = bot.blockAt
      bot.blockAt = p => { const b = read(p); if (p.x === 0 && p.y > 0 && p.y < 5 && p.z === 0) { const wall = Block.fromStateId(registry.blocksByName.stone.defaultState); wall.position = p.floored(); return wall } return b }
    }
    if (mode === 'ally') {
      const ally = { id: 3, username: 'Friend', type: 'player', position: new Vec3(0, 1.7, .5), velocity: new Vec3(0, 0, 0), onGround: false, height: 1.8, width: .6 }
      bot.entities[3] = ally; bot.players.Friend = { entity: ally, gamemode: 0 }; bot._ndSwarmAllies = ['Friend']
    }
    queued()
    assert.equal(fired, 0, 'a queued candidate cannot override the current release conditions')
    assert.equal(session._windOut.tries, 0, 'the invalid candidate is rejected before a useful plan is accepted')
  })
})

test('wind out: a visible burst before a queued decision waits for fresh post-impulse fair motion', async t => {
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const hands = require('../src/mace/hands') as typeof import('../src/mace/hands')
  const out = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
  const { bot, foe, arena } = fixture()
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  timer.syncAge(500n); bot.ndClock = timer
  bot._client = new EventEmitter(); bot.getControlState = () => false
  let queued: (() => void) | undefined, fired = 0
  bot.activateItem = () => { fired++ }
  t.mock.method(clock.wall, 'monotonic', () => 0)
  t.mock.method(hands, 'windReady', () => true); t.mock.method(hands, 'offWind', () => true)
  t.mock.method(hands, 'hotbarIndex', () => 0); t.mock.method(hands, 'afterPacket', (_b, fn) => { queued = fn })
  t.mock.method(require('../src/bow/track'), 'observedVelocity', () => ({ x: .1, y: .2, z: 0, ageTicks: 0 }))
  const session: any = { bot, _rescue: { arena }, current: null }
  t.after(() => { bot.emit('end'); bot.removeAllListeners(); bot._client.removeAllListeners(); timer.dispose(); clock.activate(null) })
  out.installWindOut(session)
  bot.emit('physicsTick'); bot.emit('physicsTick')
  assert.ok(queued, 'the local decision is queued before the first charge hits')
  bot._client.emit('explosion', { center: foe.position.offset(0, .8, 0), radius: 1.2, explosionParticle: { type: 'gust_emitter_small' } })
  queued!()
  assert.equal(fired, 0, 'the ended projectile must not make its pre-impulse target observation safe again')
  assert.equal(session._windOut.tries, 0, 'the burst blocks planning from the old fair trajectory')
  const edges = require('../src/edges'), state = edges.stateOf({ ...bot, entity: { ...foe, effects: {}, attributes: {}, yaw: 0, pitch: 0 } }, edges.IDLE)
  for (let step = 1; step <= 3; step++) {
    timer.advanceTicks(1)
    edges.simOf(bot)(state, edges.worldOf(bot)); foe.position = state.pos.clone()
    foe._ndPositionReceipts = [foe._ndPositionReceipts?.[1], { ...foe.position, t: 1000 + step * 50, grounded: false, kind: 'rel_entity_move' }]
    queued = undefined
    bot.emit('physicsTick'); bot.emit('physicsTick')
    queued?.()
    assert.equal(fired, step === 3 ? 1 : 0, 'two compatible post-impulse displacements identify a new physical trajectory')
  }
})

test('wind burst motion freshness is local to the visible affected body and resets across a LOS gap', t => {
  const core = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const { bot, foe, cells } = fixture()
  bot._client = new EventEmitter()
  let now = 1000
  t.mock.method(clock, 'observationNow', () => now)
  foe._ndObservationNow = () => now
  const hooks = bot.listenerCount('physicsTick'), explosions = bot._client.listenerCount('explosion')
  core.installWindTracking(bot)
  const gust = { center: foe.position.offset(0, .8, 0), radius: 1.2, explosionParticle: { type: 'gust_emitter_small' } }
  const move = () => { now += 50; foe.position = foe.position.offset(.05, 0, 0); foe._ndPositionReceipts = [foe._ndPositionReceipts?.[1], { ...foe.position, t: now, kind: 'rel_entity_move', grounded: false }] }
  bot._client.emit('explosion', { ...gust, center: gust.center.offset(0, 0, 8) })
  assert.equal(core.windMotionFresh(bot, foe), true, 'a harmless distant gust does not block the target')
  bot._client.emit('explosion', gust)
  assert.equal(core.windMotionFresh(bot, foe), false)
  move(); assert.equal(core.windMotionFresh(bot, foe), false)
  for (let y = 1; y <= 6; y++) for (let z = -3; z <= 3; z++) cells.set(`1,${y},${z}`, 'stone')
  assert.equal(core.windMotionFresh(bot, foe), false)
  move(); move()
  assert.equal(core.windMotionFresh(bot, foe), false, 'hidden raw receipts do not complete the observation')
  for (let y = 1; y <= 6; y++) for (let z = -3; z <= 3; z++) cells.delete(`1,${y},${z}`)
  assert.equal(core.windMotionFresh(bot, foe), false, 'the reacquired pose is only one fair baseline')
  move(); assert.equal(core.windMotionFresh(bot, foe), true)
  bot.emit('end')
  assert.equal(bot.listenerCount('physicsTick'), hooks)
  assert.equal(bot._client.listenerCount('explosion'), explosions)
})

test('a visible wind displacement can nominate a supported inside landing after fresh motion', t => {
  const core = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const { bot, foe, arena } = fixture()
  bot._client = new EventEmitter()
  t.after(() => bot.emit('end'))
  foe.position = new Vec3(2.5, 4, .5)
  let now = 1000
  t.mock.method(clock, 'observationNow', () => now)
  foe._ndObservationNow = () => now
  core.installWindTracking(bot)
  const finish = (zone = arena) => core.windFinishOpportunity(bot, foe, zone, bot)
  const gust = () => bot._client.emit('explosion', { center: foe.position.offset(0, .2, 0), radius: 1.2, explosionParticle: { type: 'gust_emitter_small' } })
  assert.equal(finish(), null, 'an ordinary airborne enemy is not a wind finish')
  gust(); assert.equal(finish(), null, 'before compatible receipts the impact is pending')
  let vy = -.16
  for (let i = 0; i < 3; i++) {
    now += 50; bot.ndClock.ticks++
    foe.position = foe.position.offset(.05 * .91 ** i, vy, 0)
    vy = (vy - .08) * .98
    foe._ndPositionReceipts = [foe._ndPositionReceipts?.[1], { ...foe.position, t: now, kind: 'rel_entity_move', grounded: false }]
    if (i < 2) assert.equal(finish(), null, 'one usable displacement is not enough to fit the arc')
  }
  assert.equal(core.windMotionFresh(bot, foe), true)
  const result = finish()
  assert.equal(result?.target, 'Enemy')
  assert.equal(result?.gameTick, 503)
  assert.equal(result?.at.y, 1)
  assert.equal(result?.frames.length, result!.ticks + 1)
  assert.equal(result?.frames.at(-1)?.onGround, true)
  assert.equal(finish({ ...arena, x: 0, r: 1 }), null, 'the same fall outside still belongs to the wind tactic')
  gust(); assert.equal(finish(), null, 'a new observed gust invalidates the forecast')
})

test('a witnessed wind trajectory may cross the ellipse aloft and still nominate its known inside landing', t => {
  const core: typeof import('../src/combat/enemy-wind') = require('../src/combat/enemy-wind')
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const { windOutside } = require('../src/combat/team-wind')
  const edges = require('../src/edges')
  const { bot, foe } = fixture()
  const arena = { x: 0, z: 0, r: 80, ellipse: { a: 77, b: 65 }, killY: -10 }
  const blockAt = (p: Vec3) => {
    const b = Block.fromStateId(registry.blocksByName[p.y < 0 ? 'stone' : 'air'].defaultState)
    b.position = p.floored(); return b
  }
  bot.blockAt = blockAt
  bot.physics = native.Physics(registry, { getBlock: blockAt })
  bot.entity.position = new Vec3(2, 30, 60)
  bot._client = new EventEmitter()
  let now = 1000
  t.mock.method(clock, 'observationNow', () => now)
  Object.assign(foe, { position: new Vec3(0, 30, 60), yaw: 0, pitch: 0, metadata: [8], _ndGlideRevision: 1, _ndObservationNow: () => now })
  const receipt = () => ({ ...foe.position, t: now, kind: 'rel_entity_move', grounded: false, flying: false, revision: 1, yaw: 0, pitch: 0 })
  foe._ndPositionReceipts = [null, receipt()]
  core.installWindTracking(bot)
  t.after(() => bot.emit('end'))
  bot._client.emit('explosion', { center: foe.position.offset(0, .2, 0), radius: 1.2, explosionParticle: { type: 'gust_emitter_small' } })
  const state = edges.stateOf({ ...bot, entity: { position: foe.position.clone(), velocity: new Vec3(0, .22, .95),
    yaw: 0, pitch: 0, onGround: false, effects: {}, attributes: {} } }, { ...edges.IDLE, forward: true, sprint: true })
  const receive = (position?: Vec3) => {
    now += 50; bot.ndClock.ticks++
    if (!position) bot.physics.simulatePlayer(state, { getBlock: blockAt })
    foe.position = (position ?? state.pos).clone()
    foe._ndPositionReceipts = [foe._ndPositionReceipts[1], receipt()]
    core.observeEnemyWindMotion(bot, foe, bot)
  }
  for (let i = 0; i < 3; i++) receive()
  assert.equal(core.windMotionFresh(bot, foe), true)
  const window = core.windFinishOpportunity(bot, foe, arena, bot, Infinity, 'preflight')
  assert.ok(window, 'an airborne crossing is reversible before the supported inside landing')
  assert.ok(window.frames.some(f => !f.onGround && windOutside(arena, f.pos)))
  assert.equal(window.frames.at(-1)?.onGround, true)
  assert.equal(windOutside(arena, window.at), false)
  const landing = edges.cloneState(state, state.control)
  for (let i = 0; i < window.ticks; i++) bot.physics.simulatePlayer(landing, { getBlock: blockAt })
  assert.ok(landing.onGround && window.at.distanceTo(landing.pos) < .001)
  const outsideArena = { ...arena, ellipse: { a: 77, b: 62.8 } }
  assert.equal(windOutside(outsideArena, landing.pos), true)
  assert.equal(core.windFinishOpportunity(bot, foe, outsideArena, bot), null, 'a durable outside landing retains wind priority')
  const missingFloor = { ...bot, blockAt: (p: Vec3) => p.y < 0 ? null : blockAt(p) }
  assert.equal(core.windFinishOpportunity(bot, foe, arena, missingFloor), null, 'there is no certified support')
  assert.equal(core.windFinishOpportunity(bot, foe, arena, missingFloor, Infinity, window), null, 'a prefix cannot certify recovery after crossing')
  const lastOutside = window.frames.reduce((last, f, i) => windOutside(arena, f.pos) ? i : last, -1)
  for (let i = 1; i <= lastOutside; i++) receive(window.frames[i].pos)
  assert.equal(windOutside(arena, foe.position), true)
  const reentry = core.windFinishOpportunity(bot, foe, arena, bot)
  assert.ok(reentry && !windOutside(arena, reentry.frames[1].pos), 'the next native step is inside')
  assert.equal(core.windFinishOpportunity(bot, foe, arena, missingFloor, Infinity, window), null, 'a prefix starting outside cannot certify recovery')
  foe.elytraFlying = true; foe.metadata[0] |= 128
  assert.equal(core.windFinishOpportunity(bot, foe, arena, bot), null, 'a gliding target is not a ballistic landing')
})

test('wind out: release freshness still bounds calculation and final safety in observed game time', async t => {
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
    { name: 'rate changes during calculation', rate: 20, afterRate: 40, elapsed: 80, fired: 0, lag: 1 },
    { name: 'final safety passes the same deadline', rate: 20, elapsed: 126, safety: true, fired: 0, lag: 1 },
    { name: 'clock catches up during final safety', rate: 20, elapsed: 40, safety: true, ticks: 4, fired: 0, lag: 1 },
    { name: 'clock rewinds during final safety', rate: 20, elapsed: 40, safety: true, ticks: -1, fired: 0, lag: 1 }
  ]) await t.test(c.name, async st => {
    const { bot, foe, own, arena } = fixture()
    st.mock.method(require('../src/bow/track'), 'observedVelocity', () => ({ ...foe.velocity, ageTicks: 0 })) // Fixed observed motion; this case varies only the release clock.
    let wallMs = 0, fired = 0, reports = 0, lag: number | undefined, complete!: () => void
    st.mock.method(clock.wall, 'monotonic', () => wallMs)
    const producer = new clock.GameClock({ epoch: 0 })
    producer.setState({ tick_rate: c.rate }); producer.syncAge(500n); bot.ndClock = producer
    st.after(() => { producer.dispose(); bot.removeAllListeners() })
    bot._client = new EventEmitter(); producer.attach(bot)
    bot.getControlState = () => false; bot.activateItem = () => { fired++ }
    st.mock.method(hands, 'windReady', () => true); st.mock.method(hands, 'offWind', () => true)
    st.mock.method(hands, 'hotbarIndex', () => 0)
    const elapse = () => { if (c.afterRate) producer.setState({ tick_rate: c.afterRate }); wallMs = c.elapsed; producer.ticks += c.ticks || 0 }
    st.mock.method(execute, 'enemyWindReport', () => {
      if (++reports === 2 && c.safety) elapse()
      return { ok: true, ready: true, report: { ...own, gameTick: worldTick(bot) } }
    })
    st.mock.method(enemy, 'planEnemyWind', (...args: Parameters<typeof nativePlan>) => {
      lag = args[3].delays![0]
      const plan = nativePlan(...args)
      if (c.safety) wallMs = 20; else elapse()
      return plan
    })
    const released = new Promise<void>(resolve => { complete = resolve })
    let queued = false
    st.mock.method(hands, 'afterPacket', (b, fn) => { queued = true; afterPacket(b, () => { fn(); complete() }) })
    const session: any = { bot, _rescue: { arena }, current: null }
    out.installWindOut(session)
    observeNativeMotion(bot, foe)
    bot.emit('physicsTick'); bot.emit('physicsTick')
    assert.ok(queued, 'the native decision uses the actual afterPacket queue')
    await released
    assert.equal(fired, c.fired, JSON.stringify(c))
    assert.equal(lag, c.lag, 'wall planning cost is converted at the observed tick rate')
    assert.equal(session._windOut.log[0]?.why, c.fired ? undefined : 'stale_release')
  })
})

test('wind out: the forecast lead follows calculation cost without counting the completed movement queue', async t => {
  const { bot, foe, own, arena } = fixture()
  t.mock.method(require('../src/bow/track'), 'observedVelocity', () => ({ ...foe.velocity, ageTicks: 0 })) // The latency fixture keeps its measured trajectory fixed.
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const hands = require('../src/mace/hands') as typeof import('../src/mace/hands')
  const enemy = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const execute = require('../src/combat/enemy-wind-execute') as typeof import('../src/combat/enemy-wind-execute')
  const out = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
  const worldTick = require('../src/combat/team-wind').worldTick
  const nativePlan = enemy.planEnemyWind
  let wallMs = 0, fired = 0
  const lags: number[] = []
  t.mock.method(clock.wall, 'monotonic', () => wallMs)
  const producer = new clock.GameClock({ epoch: 0 })
  producer.setState({ tick_rate: 20 }); producer.syncAge(500n); bot.ndClock = producer
  t.after(() => { producer.dispose(); bot.removeAllListeners() })
  bot._client = new EventEmitter(); producer.attach(bot)
  bot.getControlState = () => false; bot.activateItem = () => { fired++ }
  t.mock.method(hands, 'windReady', () => true); t.mock.method(hands, 'offWind', () => true)
  t.mock.method(hands, 'hotbarIndex', () => 0)
  t.mock.method(execute, 'enemyWindReport', () => ({ ok: true, ready: true, report: { ...own, gameTick: worldTick(bot) } }))
  t.mock.method(enemy, 'planEnemyWind', (...args: Parameters<typeof nativePlan>) => {
    lags.push(args[3].delays![0]); const plan = nativePlan(...args); wallMs += 280; return plan
  })
  let release: (() => void) | null = null
  t.mock.method(hands, 'afterPacket', (_b, fn) => { release = fn })
  out.installWindOut({ bot, _rescue: { arena }, current: null } as any)
  observeNativeMotion(bot, foe)
  const persistent = bot.listeners('physicsTick')
  for (let i = 0; i < 12 && !fired; i++) {
    release = null
    bot.emit('physicsTick'); bot.emit('physicsTick')
    assert.ok(release, `plan ${i} reached the release queue`)
    wallMs += 96 // other physics handlers finish before the decision starts
    release!()
    producer.ticks += 1 // новый кадр — прежний опоздавший не пересчитывается
    for (const l of bot.listeners('physicsTick')) if (!persistent.includes(l)) bot.removeListener('physicsTick', l as any) // ожидание взрыва прошлого броска
  }
  assert.equal(lags[0], 1, 'the first plan has no delay sample yet')
  assert.equal(fired, 1, `the lead grew to the measured delay and a release fit its window: lags ${lags}`)
  assert.ok(lags.at(-1)! >= 5 && lags.at(-1)! <= 6, `lead ≈ 280 ms at 20 TPS, capped: ${lags}`)
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
  let plans = 0, fired = 0, before: number | null = null, after: number | null = null, lag: number | undefined, queued = 0, complete!: () => void
  bot._client = new EventEmitter(); bot.getControlState = () => false; bot.activateItem = () => { fired++ }
  t.mock.method(hands, 'windReady', () => plans === 0); t.mock.method(hands, 'offWind', () => true)
  t.mock.method(hands, 'hotbarIndex', () => 0)
  t.mock.method(execute, 'enemyWindReport', () => ({ ok: true, ready: true, report: { ...own, gameTick: worldTick(bot) } }))
  t.mock.method(enemy, 'planEnemyWind', (...args: Parameters<typeof nativePlan>) => {
    plans++; lag = args[3].delays![0]; before = worldTick(bot)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 220)
    after = worldTick(bot); const plan = nativePlan(...args); setImmediate(complete); return plan
  })
  const released = new Promise<void>(resolve => { complete = resolve })
  t.mock.method(hands, 'afterPacket', (b, fn) => { queued++; afterPacket(b, fn) })
  const session: any = { bot, _rescue: { arena }, current: null }
  out.installWindOut(session)
  producer.on('tick', () => { bot.emit('physicsTick'); bot.emit('physicTick') }); producer.start()
  await released
  assert.equal(plans, 1, 'only the first forecast can affect this release receipt')
  assert.equal(lag, 1)
  assert.equal(after, before, 'the actual clock cannot process timer/time packets during the forecast')
  assert.equal(fired, 0)
  // Расчёт дольше окна свежести бросается ещё в планировании (Kimi AUDIT 2): до очереди выпуска он не доходит.
  assert.equal(queued, 1, 'the over-budget forecast is dropped inside its sole decision callback')
})

test('wind out: a forecast past the release window is dropped in planning and the same frame is not recomputed (Kimi AUDIT 2)', t => {
  const { bot, own, arena } = fixture()
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const hands = require('../src/mace/hands') as typeof import('../src/mace/hands')
  const enemy = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const execute = require('../src/combat/enemy-wind-execute') as typeof import('../src/combat/enemy-wind-execute')
  const out = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
  const worldTick = require('../src/combat/team-wind').worldTick
  const nativePlan = enemy.planEnemyWind
  let wallMs = 0, plans = 0, fired = 0, queued = 0
  t.mock.method(clock.wall, 'monotonic', () => wallMs)
  const producer = new clock.GameClock({ epoch: 0 })
  producer.setState({ tick_rate: 20 }); producer.syncAge(500n); bot.ndClock = producer
  t.after(() => { producer.dispose(); bot.removeAllListeners() })
  bot._client = new EventEmitter(); producer.attach(bot)
  bot.getControlState = () => false; bot.activateItem = () => { fired++ }
  t.mock.method(hands, 'windReady', () => true); t.mock.method(hands, 'offWind', () => true)
  t.mock.method(hands, 'hotbarIndex', () => 0)
  t.mock.method(execute, 'enemyWindReport', () => ({ ok: true, ready: true, report: { ...own, gameTick: worldTick(bot) } }))
  // Медленный кадр: к первой проверке бюджета прошло 300 мс — больше окна свежести (lag 1 → 125 мс).
  t.mock.method(enemy, 'planEnemyWind', (...args: Parameters<typeof nativePlan>) => { plans++; wallMs += 300; return nativePlan(...args) })
  t.mock.method(hands, 'afterPacket', (_b, fn) => { queued++; fn() })
  const session: any = { bot, _rescue: { arena }, current: null }
  out.installWindOut(session)
  for (let k = 0; k < 6; k++) bot.emit('physicsTick')
  assert.equal(queued, 3, 'each cheap queue rechecks the stale frame without recomputing it')
  assert.equal(fired, 0)
  assert.equal(plans, 1, 'the same stale frame is not planned again')
  producer.ticks += 1
  for (let k = 0; k < 2; k++) bot.emit('physicsTick')
  assert.equal(plans, 2, 'a new game tick is a new frame worth planning')
  assert.equal(fired, 0)
})

test('wind out: a fresh useful plan can retry the same positions while burst confirmation still requires own projectile removal', async t => {
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const hands = require('../src/mace/hands') as typeof import('../src/mace/hands')
  const execute = require('../src/combat/enemy-wind-execute') as typeof import('../src/combat/enemy-wind-execute')
  const out = require('../src/combat/wind-out') as typeof import('../src/combat/wind-out')
  const worldTick = require('../src/combat/team-wind').worldTick
  const own = (radius: number, type: string) => (c: any) => ({ center: { ...c }, radius, blockCount: 0, explosionParticle: { type } })
  for (const c of [
    { name: 'own charge burst, foe did not move', boom: own(1.2, 'gust_emitter_small'), shift: 0, confirmed: true },
    { name: 'foreign explosion near the aim point', boom: own(4, 'explosion'), shift: 0, confirmed: false },
    { name: 'foreign wind gust while the own charge keeps flying', boom: own(1.2, 'gust_emitter_small'), shift: 0, confirmed: false },
    { name: 'foe was moved a block by the burst', boom: own(1.2, 'gust_emitter_small'), shift: 1, confirmed: true }
  ]) await t.test(c.name, st => {
    const { bot, foe, own: report } = fixture(), arena = fixture().arena
    // This fixture repositions the body absolutely; its launch forecast retains the stubbed motion.
    st.mock.method(require('../src/bow/track'), 'observedVelocity', () => ({ x: .1, y: .2, z: 0, ageTicks: 0 }))
    st.mock.method(clock.wall, 'monotonic', () => 0)
    let observedAt = 1000
    st.mock.method(clock, 'observationNow', () => observedAt)
    const producer = new clock.GameClock({ epoch: 0 })
    producer.setState({ tick_rate: 20 }); producer.syncAge(500n); bot.ndClock = producer
    st.after(() => { producer.dispose(); bot.removeAllListeners() })
    bot._client = new EventEmitter(); producer.attach(bot)
    let ready = true, burst: any = null
    bot.getControlState = () => false; bot.activateItem = () => { ready = false }
    st.mock.method(hands, 'windReady', () => ready); st.mock.method(hands, 'offWind', () => true)
    st.mock.method(hands, 'hotbarIndex', () => 0)
    st.mock.method(execute, 'enemyWindReport', () => ({ ok: true, ready: true, report: { ...report, gameTick: worldTick(bot) } }))
    st.mock.method(hands, 'afterPacket', (_b, fn) => fn())
    const session: any = { bot, _rescue: { arena }, current: null }
    out.installWindOut(session)
    observeNativeMotion(bot, foe)
    const at = foe.position.clone()
    bot.emit('physicsTick'); bot.emit('physicsTick')
    assert.equal(session._windOut.fired, 1, 'the first throw is released')
    bot._client.emit('spawn_entity', { entityId: 90, type: registry.entitiesByName.wind_charge.id, objectData: bot.entity.id })
    burst = foe.position.offset(0, 1, 0)
    bot._client.emit('explosion', c.boom(burst))
    bot._client.emit('entity_destroy', { entityIds: [c.confirmed ? 90 : 91] })
    foe.position = at.offset(c.shift, 0, 0)
    const seenAt = clock.observationNow()
    for (let step = 1; step <= 2; step++) {
      producer.ticks++
      observedAt = seenAt + step * 50
      foe._ndPositionReceipts = [foe._ndPositionReceipts?.[1], { ...foe.position, t: seenAt + step * 50, grounded: false, kind: 'entity_teleport' }]
      bot.emit('physicsTick')
    }
    for (let k = 0; k < 50; k++) bot.emit('physicsTick')
    assert.equal(!!session._windOut.log[0]?.burst, c.confirmed, 'a nearby gust belongs to this cast only with its native projectile removal')
    foe.position = at.clone(); ready = true
    foe._ndPositionReceipts = [foe._ndPositionReceipts[1], { ...foe.position, t: seenAt + 150, grounded: false, kind: 'entity_teleport' }]
    observedAt = seenAt + 300
    observeNativeMotion(bot, foe) // A retry still requires fresh motion receipts, rather than the absolute synchronization itself.
    for (let k = 0; k < 2; k++) bot.emit('physicsTick')
    assert.equal(session._windOut.tries, 2, JSON.stringify(c.name))
  })
})

test('a local wind follow-up uses its granted live charge and cancels after the packet if the proof changes', async t => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const hands: typeof import('../src/mace/hands') = require('../src/mace/hands')
  const execute: typeof import('../src/combat/enemy-wind-execute') = require('../src/combat/enemy-wind-execute')
  const threats: typeof import('../src/threats') = require('../src/threats')
  const { installWindOut, windOutDecide }: typeof import('../src/combat/wind-out') = require('../src/combat/wind-out')
  const arena = { x: 0, z: .5, r: 9, ellipse: { a: 8, b: 10 }, killY: -10 }, at = 1000
  for (const state of ['present', 'enchanted', 'hidden', 'replacement', 'glass', 'second ray', 'expired', 'denied']) await t.test(state, async st => {
    const { bot, foe, own, cells } = fixture()
    for (let x = -8; x <= 12; x++) for (let z = -7; z <= 8; z++) cells.set(`${x},${z < -5 ? -1 : 0},${z}`, 'stone')
    own.position = bot.entity.position = new Vec3(-2, 1, 1.1)
    foe.position = new Vec3(4.5, 1, .5); foe.onGround = true; foe.velocity = new Vec3(0, 0, 0); foe._ndVisible = true
    foe._ndPositionReceipts = [at - 50, at].map(t => ({ ...foe.position, t, kind: 'rel_entity_move', grounded: true, flying: false, yaw: 0, revision: 1 }))
    foe._ndObservationNow = () => at
    if (state === 'enchanted') foe.equipment = [null, null, ...['helmet', 'chestplate', 'leggings', 'boots']
      .map(kind => ({ name: `netherite_${kind}`, componentMap: new Map([['enchantments', {}]]) }))]
    const relay = { ...foe, id: 3, username: 'Relay', position: new Vec3(4.2, .7, -7), onGround: false, elytraFlying: true, height: .6 }
    bot.players.Relay = { entity: relay, gamemode: 0 }; bot.entities[3] = relay; bot._ndSwarmAllies = ['Relay']
    bot.ndClock.observationRate = () => 10
    const ray = new Vec3(1.5, 0, 0), origin = new Vec3(-2.8, 2.7, .5), charge = { id: 4, name: 'wind_charge', position: origin.plus(ray.scaled(2)) }
    bot._ndThrown = new Map([[4, { name: charge.name, owner: 3, p: origin, observedAt: at - 100 }]])
    bot.entities[4] = charge
    let hidden = false, wall = 0, casts = 0
    const bids = [], releases = [], packets: Array<() => void> = []
    st.mock.method(clock, 'observationNow', () => at); st.mock.method(clock.wall, 'monotonic', () => wall)
    st.mock.method(threats, 'projectileView', (_bot, e) => hidden ? null : { position: e.position,
      _ndPositionReceipts: [null, { t: at }], _ndWindMotion: { position: e.position, velocity: ray, t: at }, _ndObservationNow: () => at } as any)
    st.mock.method(hands, 'windReady', () => true); st.mock.method(hands, 'offWind', () => true)
    st.mock.method(hands, 'hotbarIndex', () => 0); st.mock.method(hands, 'afterPacket', (_bot, send) => { packets.push(send) })
    st.mock.method(execute, 'enemyWindReport', () => ({ ok: true, ready: true, report: own }))
    bot._client = new EventEmitter(); bot.getControlState = () => false; bot.activateItem = () => { casts++ }
    st.after(() => bot.emit('end'))
    assert.equal(windOutDecide(bot, own, arena), null, 'ordinary shots still wait for the pending impulse')
    const session: any = { bot, _rescue: { arena, killY: arena.killY }, _windRadio: async bid => {
      bids.push(bid); return state === 'denied' ? undefined : flight => releases.push(flight)
    } }
    installWindOut(session)
    bot.emit('physicsTick'); bot.emit('physicsTick')
    assert.equal(packets.length, 1)
    packets.shift()!(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(casts, 0, 'the certified shot needs a grant')
    assert.deepEqual(bids, [{ target: foe.username, entity: foe.id, tick: 500, ticks: 5, prefix: 4 }])
    if (state === 'hidden') hidden = true
    if (state === 'glass') cells.set('1,2,0', 'glass')
    if (state === 'expired') wall = 200
    if (state === 'replacement' || state === 'second ray') {
      const second = state === 'second ray'
      bot.entities[5] = { ...charge, id: 5, position: second ? charge.position.minus(ray) : charge.position }
      bot._ndThrown.set(5, { ...bot._ndThrown.get(4), ...(second && { owner: 2, p: origin.minus(ray) }) })
      if (!second) { delete bot.entities[4]; bot._ndThrown.delete(4) }
    }
    assert.equal(packets.length, state === 'denied' ? 0 : 1)
    packets.shift()?.()
    const sent = state === 'present' || state === 'enchanted'
    assert.equal(casts, Number(sent), JSON.stringify(session._windOut))
    assert.deepEqual(releases, sent ? [{ tick: 500, ticks: 5 }] : state === 'denied' ? [] : [undefined])
  })
})

test('a visible birth ray remains usable between native updates while its swept path and deflection grace hold', t => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const threats: typeof import('../src/threats') = require('../src/threats')
  const { planEnemyWind }: typeof import('../src/combat/enemy-wind') = require('../src/combat/enemy-wind')
  const { bot, foe, own, cells } = fixture()
  for (let x = -12; x <= 16; x++) for (let z = -11; z <= 11; z++) cells.set(`${x},${z < -5 ? -1 : 0},${z}`, 'stone')
  const born = 1000, motionAt = born + 29.8772, observed = born + 130, id = 200
  let now = observed, visible = true, changed = false
  own.position = bot.entity.position = new Vec3(-5, 1, 1.5)
  foe.position = new Vec3(4.5, 1, .5); foe.onGround = true; foe.velocity = new Vec3(0, 0, 0); foe._ndVisible = true
  const pose = { ...foe.position, grounded: true, flying: false, yaw: Math.PI }
  const history = [{ ...pose, t: born - 64.156, kind: 'reacquired' }, { ...pose, t: born + 29.171, kind: 'sync_entity_position' }]
  foe._ndPositionReceipts = history; foe._ndObservationNow = () => now
  const origin = new Vec3(-7.3, 2.62000000476837, .5), velocity = new Vec3(1.50093432933005, .0303356582139, .021595281699635)
  const relay = { ...foe, id: 3, username: 'Relay', position: origin.offset(0, -1.62, 0), onGround: true }
  bot.players.Relay = { entity: relay }; bot.entities[relay.id] = relay; bot._ndSwarmAllies = [relay.username]
  const record = { name: 'wind_charge', owner: relay.id, p: origin, observedAt: born }
  const charge = { id, name: record.name, position: origin }
  bot.entities[id] = charge; bot._ndThrown = new Map([[id, record]])
  const blockAt = bot.blockAt
  const options = { arena: { x: 0, z: .5, r: 9, ellipse: { a: 8, b: 10 }, killY: -10 }, startTick: 500,
    delays: [1], maxShots: 1, waitForHit: true, visiblePrefix: true, reactAfterHit: true, collision: bot }
  t.mock.method(clock, 'observationNow', () => now)
  t.mock.method(threats, 'projectileView', (_bot, e) => !visible ? null : { position: e.position,
    _ndPositionReceipts: [null, { ...origin, t: motionAt }], _ndWindMotion: { position: origin.plus(velocity.scaled((motionAt - born) / 50)),
      velocity, t: motionAt, birth: changed ? undefined : { velocity, record } }, _ndObservationNow: () => now } as any)
  const plan = (lag = 1, expectedPrefix?: number) => planEnemyWind(bot, foe, [own], { ...options, delays: [lag], expectedPrefix })
  assert.equal(plan()?.relayPrefix, id, 'the recorded native ray still has a useful flight')
  now += 10; assert.equal(plan(0, id)?.relayPrefix, id, 'same birth still has a release ray'); now = observed
  now += 25; assert.equal(plan(0, id), null, 'one adjacent native age reaches the deflection boundary'); now = observed
  changed = true; assert.equal(plan(1, id), null, 'changed motion needs a recent actual update'); changed = false
  visible = false; assert.equal(plan(1, id), null, 'the release requires current visibility'); visible = true
  delete bot.entities[id]; assert.equal(plan(1, id), null, 'the destroyed charge cannot renew its grant'); bot.entities[id] = charge
  cells.set('-7,2,0', 'glass'); assert.equal(plan(1, id), null, 'transparent cover on the already swept segment stops it'); cells.delete('-7,2,0')
  bot.blockAt = p => p.floored().equals(new Vec3(-7, 2, 0)) ? null : blockAt(p)
  assert.equal(plan(1, id), null, 'the swept segment must be known'); bot.blockAt = blockAt
  foe._ndPositionReceipts = [{ ...history[0], x: -3.5 }, history[1]]
  assert.equal(plan(1, id), null, 'the previous fair target body was already in the ray'); foe._ndPositionReceipts = history
  bot.entities[4] = { ...relay, id: 4, username: 'OtherBlue', position: new Vec3(-4.2, 1, .5) }
  bot._ndSwarmAllies.push('OtherBlue')
  assert.equal(plan(1, id), null, 'a visible ally already crossed by the ray invalidates the grant')
  const other = bot.entities[4]
  other.position = new Vec3(-4.2, 1, 2)
  other._ndPositionReceipts = [{ x: -4.2, y: 1, z: .5, t: born + 5 }, { ...other.position, t: born + 100 }]
  assert.equal(plan(1, id), null, 'a prior fair ally pose can also consume the ray')
  other._ndVisible = undefined
  assert.equal(plan(1, id)?.relayPrefix, id, 'unfiltered history does not change the public forecast')
  delete bot.entities[4]
  bot._ndLaunchMovement = () => new Vec3(0, 0, 1)
  assert.equal(plan(1, id), null, 'the native preceding local position can also consume the ray')
  delete bot._ndLaunchMovement
  own.position = bot.entity.position = new Vec3(-4.2, 1, .5)
  assert.equal(plan(1, id), null, 'the same sweep includes the local body')
})

test('a granted dependent wind shot keeps its calculated movement tick and cleans up cancelled waits', async t => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const hands: typeof import('../src/mace/hands') = require('../src/mace/hands')
  const enemy: typeof import('../src/combat/enemy-wind') = require('../src/combat/enemy-wind')
  const execute: typeof import('../src/combat/enemy-wind-execute') = require('../src/combat/enemy-wind-execute')
  const { installWindOut }: typeof import('../src/combat/wind-out') = require('../src/combat/wind-out')
  for (const state of ['sent', 'owner', 'mode', 'abort', 'disconnect', 'socket', 'arena', 'expiry', 'rewind', 'witness']) await t.test(state, async st => {
    const { bot, foe, own, arena } = fixture(), packets: Array<() => void> = [], releases = [], plans = []
    let tick = 500, wall = 0, casts = 0, expiry: (() => void) | undefined
    bot.ndClock = { get age() { return BigInt(tick) }, ticks: 20, serverTicks: 20, observationRate: () => 20 }
    bot._client = new EventEmitter(); bot.getControlState = () => false; bot.activateItem = () => { casts++ }
    st.after(() => bot.emit('end'))
    st.mock.method(clock.wall, 'monotonic', () => wall)
    st.mock.method(clock.wall, 'setTimeout', fn => { expiry = fn; return { unref() {} } as any })
    st.mock.method(clock.wall, 'clearTimeout', () => { expiry = undefined })
    st.mock.method(hands, 'windReady', () => true); st.mock.method(hands, 'windCooling', () => false)
    st.mock.method(hands, 'offWind', () => true); st.mock.method(hands, 'hotbarIndex', () => 0)
    st.mock.method(hands, 'afterPacket', (_bot, send) => { packets.push(send) })
    st.mock.method(enemy, 'windMotionFresh', () => true); st.mock.method(enemy, 'windTeamSafe', () => true)
    st.mock.method(execute, 'enemyWindReport', () => ({ ok: true, ready: true, report: { ...own, gameTick: tick } }))
    st.mock.method(enemy, 'planEnemyWind', (_bot, _foe, _own, opts) => {
      const { expectedPrefix, delays: [delay] } = opts
      plans.push({ tick, delay, expectedPrefix })
      if (expectedPrefix !== undefined && (tick < 501 || state === 'witness')) return null
      const base = { out: false, exited: false, progress: 0, outwardEffect: 0, air: 0, ticks: null, position: foe.position, clear: Infinity, reach: Infinity, fallDamage: 0 }
      return { target: foe.username, targetAt: foe.position, gameTick: tick, resistance: { lo: 0, hi: 0 }, tried: 1, fallThreat: false,
        repriceRim: true, earlyLift: false, lateLift: false, relayPrefix: 4, baseline: base, nominal: { ...base, progress: 1 }, worst: base,
        shots: [{ thrower: own.id, fireDelay: delay, fireTick: tick + delay, ticks: 7, yaw: 0, pitch: 0,
          from: bot.entity.position, aim: foe.position, velocity: new Vec3(1.5, 0, 0), burst: foe.position, feet: foe.position }] }
    })
    const ctl = { aborted: false, onAbort: [] as Array<() => void> }, owner = { name: 'fight', ctl }
    const session: any = { bot, current: owner, _rescue: { arena }, _windRadio: async bid => {
      assert.deepEqual(bid, { target: foe.username, entity: foe.id, tick: 500, ticks: 7, prefix: 4 })
      return flight => releases.push(flight)
    } }
    installWindOut(session)
    bot.emit('physicsTick'); bot.emit('physicsTick')
    packets.shift()!(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(packets.length, 0, 'the grant waits for the calculated game tick')
    assert.deepEqual(plans, [{ tick: 500, delay: 1, expectedPrefix: undefined }])
    assert.ok(expiry); assert.equal(ctl.onAbort.length, 1)
    if (state === 'owner') session.current = { name: 'other' }
    if (state === 'mode') bot.players[foe.username].gamemode = 3
    if (state === 'socket') session._windRadio = async () => undefined
    if (state === 'arena') session._rescue = null
    if (state === 'disconnect') bot.emit('end')
    if (state === 'expiry') { wall = 200; expiry!() }
    if (state === 'abort') {
      let tail = 0
      ctl.onAbort.push(() => { tail++ }); ctl.aborted = true
      for (const abort of ctl.onAbort) abort()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(tail, 1, 'removing the relay hook must not skip later session abort hooks')
    }
    if (!['abort', 'disconnect', 'expiry'].includes(state)) { tick++; wall = 50; bot.emit('physicsTick') }
    assert.equal(expiry, undefined)
    assert.equal(ctl.onAbort.length, state === 'abort' ? 1 : 0)
    const queuesRelease = ['sent', 'rewind', 'witness'].includes(state)
    assert.equal(packets.length, Number(queuesRelease))
    if (state === 'rewind') tick--
    packets.shift()?.()
    assert.equal(casts, Number(state === 'sent'))
    assert.deepEqual(releases, state === 'sent' ? [{ tick: 501, ticks: 7 }] : [undefined])
    if (state === 'sent') assert.deepEqual(plans[1], { tick: 501, delay: 0, expectedPrefix: 4 })
  })
})

test('velocity receipts on either side of a visible post-gust position defer a wind reprice', t => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const wind: typeof import('../src/combat/enemy-wind') = require('../src/combat/enemy-wind')
  const { bot, foe, arena } = fixture()
  let now = 997.356
  t.mock.method(clock, 'observationNow', () => now)
  bot._client = new EventEmitter()
  bot.entity.position = new Vec3(648.4028666764366, 150.75861664025695, 642.5385498205083)
  foe.position = new Vec3(642.3075886463336, 160.34170752168964, 654.9365518314189)
  const receipt = (position: Vec3) => ({ ...position, t: now, kind: 'rel_entity_move', grounded: false, flying: false })
  foe._ndObservationNow = () => now; foe._ndPositionReceipts = [null, receipt(foe.position)]
  const move = (time: number, p: Vec3) => { now = time; foe.position = p; foe._ndPositionReceipts = [foe._ndPositionReceipts[1], receipt(p)] }
  const velocity = (time: number) => {
    now = time
    bot._client.emit('entity_velocity', { entityId: foe.id, get velocity() { throw Error('velocity vectors are not an aim input') } })
  }
  wind.installWindTracking(bot); t.after(() => bot.emit('end'))
  now = 1000
  bot._client.emit('explosion', { center: new Vec3(642.4814841920105, 160.76226313273705, 654.3366000725842),
    radius: 1.2000000476837158, explosionParticle: { type: 'gust_emitter_small' } })
  assert.equal(wind.windMotionFresh(bot, foe), false)
  // DB #1371: the same native velocity packet was broadcast again after the first position.
  velocity(1036.731); move(1036.767, new Vec3(642.1374226307086, 160.36709814668964, 655.1794717532939))
  assert.equal(wind.windMotionFresh(bot, foe), false)
  velocity(1037.034)
  move(1084.003, new Vec3(641.9672566150836, 160.31363134981464, 655.3801553470439))
  assert.equal(wind.windMotionFresh(bot, foe), false, 'only one body receipt followed the last visible motion receipt')
  assert.deepEqual(wind.enemyWindFrames(bot, foe, arena), [])
  move(1134.003, new Vec3(641.8646191394829, 160.1975810505522, 655.9391878263823))
  assert.equal(wind.windMotionFresh(bot, foe), true)
  velocity(1154.003); assert.equal(wind.windMotionFresh(bot, foe), true, 'the settled impact does not fence later unrelated velocity')
  now = 1000 + wind.WIND_FORECAST_TICKS * 50
  assert.equal(wind.recentlyWindAffected(bot, foe), true)
  now++; assert.equal(wind.recentlyWindAffected(bot, foe), false, 'role recency still expires from the original visible gust')
  bot.emit('end'); assert.equal(bot._client.listenerCount('entity_velocity'), 0)
})
