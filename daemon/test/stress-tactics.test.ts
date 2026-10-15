// Stress stand of the tactical layer without Minecraft (src/tactics/sim-*.ts): named distractions from the user's list
// and a seeded fuzz over the REAL TacticalSystem, plus the observation fixes the stand found, checked on observeTactics.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { check, runSystem, type SimResult } from '../src/tactics/sim-run'
import { SCENARIOS, randomScenario } from '../src/tactics/sim-scenarios'
import { candidates, sustainableFight, threatLevel, type TacticalState } from '../src/tactics/state'
import { TacticalArbiter } from '../src/tactics/arbiter'
import type { Scenario } from '../src/tactics/sim-world'
const { observeTactics } = require('../src/tactics/minecraft')
const { Autopilot } = require('../src/autopilot')
const safety = require('../src/combat-safety')
const { Vec3 } = require('vec3')

process.env.ND_TELEMETRY = '0'
const named = (name: string): Scenario => SCENARIOS.find(scenario => scenario.name === name)!
const kinds = (result: SimResult) => result.violations.map(violation => violation.kind)
const tactical = (changes: Partial<TacticalState> = {}): TacticalState => ({ at: 0, health: 20, food: 20, armor: 15, weapon: true, shield: false,
  enemies: [], incomingProjectiles: 0, burning: false, lava: false, fireResistance: false, explosion: false, dangerousFall: false,
  emergencyController: false, inWater: false, cover: false, portal: false, escapeRoute: true, blocks: 16, water: false, edible: true,
  canFight: true, contact: false, shelter: null, protectedEncounter: false, ...changes })
const zombie = { id: 2, kind: 'zombie', distance: 2, player: false, threatening: true, hit: 1.8 }

function observing() {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'
  bot.health = 20; bot.food = 20
  bot.inventory = { slots: [], items: () => [{ name: 'bread', count: 8 }, { name: 'iron_sword', count: 1 }] }
  bot.pathfinder = { setGoal: () => {}, setMovements: () => {}, stop: () => {} }
  bot.registry = { foodsByName: { bread: { foodPoints: 5, saturation: 6 } }, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [], yaw: 0, pitch: 0 }
  bot.entities = {}
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.blockAt = (p: any) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty',
    position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  const session: any = { bot, current: null, reflex: null, bus: { emit: () => {} } }
  return { session, bot }
}

test('an attacking player becomes a threat with its weapon hit, a bystander player does not', () => {
  const { session, bot } = observing()
  bot._client = new EventEmitter()
  session.autopilot = new Autopilot(session, {})
  session.autopilot.hookDamage(bot)
  bot.entities[5] = { id: 5, name: 'player', username: 'Tank', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6,
    equipment: [{ name: 'diamond_sword' }], metadata: [] }
  bot.entities[6] = { id: 6, name: 'player', username: 'Walker', position: new Vec3(.5, 64, 6.5), height: 1.8, width: .6, equipment: [], metadata: [] }
  const before = observeTactics(session)
  assert.equal(before.enemies.find((enemy: any) => enemy.id === 5)?.threatening, false, 'a nearby player is not a threat by itself')
  assert.equal(threatLevel(before), 0)
  bot._client.emit('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 6 })
  assert.equal(session.autopilot.lastHurt.sourceId, 5)
  const state = observeTactics(session)
  const tank = state.enemies.find((enemy: any) => enemy.id === 5)
  assert.equal(tank?.threatening, true)
  assert.ok(tank.hit >= 7, `diamond sword hit after no armor: ${tank.hit}`)
  assert.equal(state.enemies.find((enemy: any) => enemy.id === 6)?.threatening, false)
  assert.ok(threatLevel(state) >= 2)
})

test('primed TNT and a falling block overhead are level-4 blasts answered by Dodge', () => {
  const { session, bot } = observing()
  bot.entities[7] = { id: 7, name: 'tnt', position: new Vec3(3.5, 64, .5), metadata: [0, 300, null, false, false, false, 0, 0, 40] }
  const tnt = observeTactics(session)
  assert.equal(tnt.explosion, true)
  assert.equal(tnt.blast, 'tnt')
  assert.equal(threatLevel(tnt), 4)
  assert.equal(candidates(tnt)[0]?.id, 'Dodge')
  bot.entities[7].position = new Vec3(12.5, 64, .5)
  assert.equal(observeTactics(session).explosion, false, 'beyond 2 * power + 1 blocks')
  bot.entities[8] = { id: 8, name: 'falling_block', position: new Vec3(.6, 69, .4), metadata: [] }
  const anvil = observeTactics(session)
  assert.equal(anvil.blast, 'falling_block')
  assert.equal(threatLevel(anvil), 4)
  bot.entities[8].position = new Vec3(.5, 66, 1.5)
  const beside = observeTactics(session)
  assert.equal(beside.explosion, false, 'gravel of the next staircase column lands beside the body')
  assert.notEqual(candidates(beside)[0]?.id, 'Dodge')
})

test('a fight the verdict abandons after one exchange is not favourable (brute), a zombie fight still is', () => {
  const brute = safety.evaluate({ health: 20, food: 20, foodPoints: 30, weapon: true, threats: [{ name: 'piglin_brute', distance: 3, hit: 8.6 }] })
  assert.equal(brute.action, 'fight', 'the shared verdict itself is unchanged')
  assert.equal(sustainableFight(brute, 20), false)
  const zombie = safety.evaluate({ health: 20, food: 20, foodPoints: 30, weapon: true, threats: [{ name: 'zombie', distance: 3, hit: 1.8 }] })
  assert.equal(sustainableFight(zombie, 20), true)
})

test('stand: TNT is dodged, a lava pool without a dry exit is swum out, a charged creeper is outrun once', async () => {
  const tnt = await check(named('tnt-falling'))
  assert.equal(tnt.died, null)
  assert.deepEqual(tnt.selections.map(selection => `${selection.action}/${selection.level}`), ['Dodge/4'])
  const pool = await check({ name: 'lava-pool', world: { exits: false }, events: [{ at: 20, type: 'lava' }] })
  assert.equal(pool.selections[0]?.action, 'Flee')
  assert.ok(!kinds(pool).includes('level4-unhandled'))
  const creeper = await check(named('charged-creeper'))
  assert.equal(creeper.died, null)
  assert.deepEqual(creeper.selections.map(selection => selection.action), ['CreateDistance'], 'flight past FOLLOW_RANGE, not a return into contact')
})

test('drowning is a critical incident answered by Surface', async () => {
  const { session, bot } = observing()
  bot.oxygenLevel = 6
  bot.blockAt = (p: any) => ({ name: p.y < 64 ? 'stone' : 'water', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored(), shapes: [] })
  const state = observeTactics(session)
  assert.equal(state.drowning, true)
  assert.equal(threatLevel(state), 3)
  assert.equal(candidates(state)[0]?.id, 'Surface')
  bot.oxygenLevel = 20
  assert.equal(observeTactics(session).drowning, false)
  const stand = await check(named('drowning'))
  assert.equal(stand.died, null)
  assert.deepEqual(stand.selections.map(selection => `${selection.action}/${selection.level}`), ['Surface/3'])
})

test('stand: a brute in contact is outrun, not fought or boxed in its reach, and regeneration does not flap a refuge into a fight', async () => {
  const brute = await check(named('brute-in-nether'))
  assert.equal(brute.died, null)
  assert.ok(brute.selections.every(selection => selection.action === 'CreateDistance'), JSON.stringify(brute.selections))
  const box = await check(named('blocks-lost-in-box'))
  assert.ok(!kinds(box).includes('flapping'), JSON.stringify(box.selections.slice(0, 6)))
})

test('stand: named distractions survive wherever a simple policy survives', async () => {
  for (const scenario of SCENARIOS) {
    const result = await check(scenario)
    assert.deepEqual(result.violations, [], scenario.name)
  }
})

test('stand: 300 seeded distraction tapes keep the invariants of the real TacticalSystem', async () => {
  const structural = new Set(['two-owners', 'skill-during-lease', 'no-replan', 'fight-low-hp', 'level4-unhandled', 'flapping', 'cycle'])
  const found: string[] = []
  for (let seed = 1; seed <= 300; seed++) {
    const result = await runSystem(randomScenario(seed))
    for (const violation of result.violations) if (structural.has(violation.kind)) found.push(`${seed}:${violation.kind}:${violation.detail}`)
  }
  assert.deepEqual(found, [])
})

test('a brute in sight of adult piglins is walled off, never struck (S1: LastStand at the barter pit angered them)', () => {
  const base = { at: 0, health: 12, food: 20, armor: 15, weapon: true, shield: false, incomingProjectiles: 0, burning: false, lava: false,
    fireResistance: false, explosion: false, dangerousFall: false, emergencyController: false, inWater: false, cover: false, portal: false,
    escapeRoute: true, blocks: 16, water: false, edible: true, canFight: true, contact: true, shelter: 'BlockOff' as const, protectedEncounter: false,
    enemies: [{ id: 3, kind: 'piglin_brute', distance: 2, player: false, threatening: true, hit: 3 }] }
  assert.ok(candidates(base).some(candidate => candidate.id === 'Fight'))
  const watched = candidates({ ...base, piglinWitnesses: true })
  assert.ok(!watched.some(candidate => candidate.id === 'Fight'))
  const cornered = candidates({ ...base, piglinWitnesses: true, escapeExhausted: true })
  assert.ok(!cornered.some(candidate => candidate.id === 'LastStand' || candidate.id === 'Fight'))
  assert.ok(cornered.some(candidate => candidate.id === 'BlockOff'))
  const { session, bot } = observing()
  bot.entities[9] = { id: 9, name: 'piglin', position: new Vec3(4.5, 64, 2.5), height: 1.95, width: .6, metadata: [], equipment: [] }
  assert.equal(observeTactics(session).piglinWitnesses, false, 'no brute, no witness scan')
  bot.entities[10] = { id: 10, name: 'piglin_brute', position: new Vec3(2.5, 64, .5), height: 1.95, width: .6, metadata: [], equipment: [] }
  assert.equal(observeTactics(session).piglinWitnesses, true)
  bot.registry.entitiesByName.piglin = { metadataKeys: ['a', 'b', 'is_baby'] }
  bot.entities[9].metadata = [0, 0, true]
  assert.equal(observeTactics(session).piglinWitnesses, false, 'a baby piglin does not join the fight')
})

test('the fall controller is a live graph node: a fall offers only freeing, landing reopens the graph', () => {
  const arbiter = new TacticalArbiter()
  assert.equal(arbiter.decide(tactical({ contact: true, enemies: [zombie] })).selected?.id, 'Fight')
  const fall = arbiter.decide(tactical({ at: 150, dangerousFall: true, contact: true, enemies: [zombie], shelter: 'PillarUp' }))
  assert.equal(fall.selected, null)
  const mid = arbiter.decide(tactical({ at: 200, dangerousFall: true, contact: true, enemies: [zombie], shelter: 'PillarUp' }))
  assert.deepEqual(mid.candidates.map(candidate => candidate.id), [], 'EmergencyController edges open only after the fall')
  assert.equal(arbiter.graph.canTransition('EmergencyController', 'FreeEmbedded', tactical({ embedded: true })), true)
  assert.equal(arbiter.decide(tactical({ at: 400, contact: true, enemies: [zombie] })).selected?.id, 'Fight')
})

test('stage B: the real observeTactics over the mineflayer facade keeps the named outcomes and the invariants', async () => {
  for (const scenario of SCENARIOS) {
    const mirror = await runSystem(scenario)
    const real = await runSystem(scenario, { observe: 'minecraft' })
    // The facade builds no cover pocket (sim-mineflayer.ts): a tape that lives by hiding is compared by invariants only.
    if (!scenario.world?.cover) assert.equal(real.died === null, mirror.died === null, `${scenario.name}: ${real.died} vs mirror ${mirror.died}`)
    assert.deepEqual(kinds(real).filter(kind => kind !== 'death'), [], scenario.name)
  }
  const structural = new Set(['two-owners', 'skill-during-lease', 'no-replan', 'fight-low-hp', 'level4-unhandled', 'flapping', 'cycle'])
  const found: string[] = []
  for (let seed = 1; seed <= 60; seed++) {
    for (const violation of (await runSystem(randomScenario(seed), { observe: 'minecraft' })).violations) {
      if (structural.has(violation.kind)) found.push(`${seed}:${violation.kind}:${violation.detail}`)
    }
  }
  assert.deepEqual(found, [])
})

test('stand: digging, walking and crafting skills paused by a shield lease never touch the body and craft exactly', async () => {
  for (const skill of ['mine', 'walk', 'craft'] as const) {
    const result = await runSystem({ name: `paused-${skill}`, skill, body: { shield: true, food: 12 },
      events: [{ at: 20, type: 'enemy', kind: 'zombie', distance: 11.5 }, { at: 260, type: 'tnt', distance: 2, fuse: 40 }] })
    assert.ok(result.selections.some(selection => selection.action === 'Shield' && selection.level === 1), `${skill}: paused, not interrupted`)
    assert.deepEqual(result.violations, [], skill)
    assert.ok(result.skillProgress > 10, `${skill}: the skill resumed (${result.skillProgress})`)
  }
})

test('no melee against a hovering blaze or a ghast: a cornered body walls off instead (farm slot 21: LastStand x100, death)', () => {
  const blaze = (distance: number) => ({ id: 4, kind: 'blaze', distance, player: false, threatening: true, hit: 2.7 })
  const cornered = tactical({ contact: true, escapeExhausted: true, shelter: 'BlockOff', fireResistance: true, enemies: [blaze(4.6), blaze(3.9)] })
  const ids = candidates(cornered).map(candidate => candidate.id)
  assert.ok(!ids.includes('LastStand') && !ids.includes('Fight'), ids.join(','))
  assert.ok(ids.includes('BlockOff'), ids.join(','))
  assert.ok(candidates({ ...cornered, enemies: [blaze(2.6)] }).some(candidate => candidate.id === 'LastStand'), 'a blaze at the body is in reach')
  assert.ok(!candidates({ ...cornered, escapeExhausted: false, enemies: [{ ...blaze(2), kind: 'ghast' }] }).some(candidate => candidate.id === 'Fight'))
})

test('a strike that ends in its first tick sits out 2 s instead of being re-selected on every sample', async () => {
  const { TacticalSystem } = require('../src/tactics/minecraft')
  const gameClock = require('../src/game-clock')
  const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
  const { session, bot } = observing()
  const picks: string[] = []
  session.bus = { emit: (name: string, payload: any) => { if (name === 'tactical_selected') picks.push(payload.action) } }
  const system = new TacticalSystem(session, { observe: () => tactical({ at: gameClock.now(), contact: true, enemies: [zombie] }), record: () => {},
    execute: async () => ({ acted: true, duel: { swings: 0, stopped: 'out of melee' } }) })
  try {
    system.attach(bot)
    for (let i = 0; i < 20; i++) {
      timer.advanceTicks(3)
      system.update(true)
      await new Promise(resolve => setImmediate(resolve))
    }
    // 3 s of samples: the strike comes back once its 2 s are over (S4c: the no-op run sits out too, it no longer fills them).
    assert.ok(picks.filter(pick => pick === 'Fight').length <= 2, picks.join(','))
    assert.ok(picks.length < 6, `no churn: ${picks.join(',')}`)
  } finally { system.detach(); timer.dispose(); gameClock.activate(null) }
})

test('a phantom is not outrun: a run is priced below the strike at its swoop, a walker beside it restores the price (farm slot 17: Flee x3 at hp 6.9, death)', () => {
  const phantom = (distance: number) => ({ id: 6, kind: 'phantom', distance, player: false, threatening: true, hit: 2 })
  const swoop = tactical({ health: 6.9, contact: true, canFight: false, enemies: [phantom(2.3)] })
  const offered = candidates(swoop)
  assert.equal(offered[0].id, 'LastStand')
  assert.ok(!offered.some(candidate => candidate.id === 'Flee'), `at level 2 a run priced .3 is worth less than the work it stops: ${JSON.stringify(offered)}`)
  const critical = candidates({ ...swoop, health: 5 })
  assert.ok(critical.some(candidate => candidate.id === 'Flee' && candidate.score === 100 * .3), `at level 3 it is there, priced: ${JSON.stringify(critical)}`)
  const arbiter = new TacticalArbiter()
  arbiter.decide(tactical({ health: 6.9, contact: true, enemies: [zombie] }))
  assert.equal(arbiter.decide({ ...swoop, at: 400 }).selected?.id, 'LastStand', 'reachable through the graph from a running flight')
  assert.ok(candidates({ ...swoop, enemies: [phantom(2.3), zombie] }).some(candidate => candidate.id === 'Flee' && candidate.score === 65), 'a walker still makes running worthwhile')
})

test('an arena duel to the death keeps its fight at level 3; lava under the duel is still the tactics\' (S7 20:08)', async () => {
  const { TacticalSystem } = require('../src/tactics/minecraft')
  const gameClock = require('../src/game-clock')
  const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
  const { session, bot } = observing()
  const picks: string[] = []
  session.bus = { emit: (name: string, payload: any) => { if (name === 'tactical_selected') picks.push(payload.action) } }
  session.tempo = {}
  session.current = { name: 'fight', params: { arena: true }, ctl: { aborted: false, onAbort: [], abort() { this.aborted = true } } }
  const duel = { id: 9, kind: 'NeuroFarm27b', distance: 2, player: true, threatening: true, hit: 6 }
  let lava = false
  const system = new TacticalSystem(session, { record: () => {}, execute: () => new Promise(() => {}),
    observe: () => tactical({ at: gameClock.now(), health: 4, contact: true, protectedEncounter: true, enemies: [duel], lava, fireResistance: false }) })
  try {
    system.attach(bot)
    for (let i = 0; i < 4; i++) { timer.advanceTicks(3); system.update(true); await new Promise(resolve => setImmediate(resolve)) }
    assert.deepEqual(picks, [], 'no retreat out of the arena duel')
    assert.equal(session.current.ctl.aborted, false)
    lava = true
    timer.advanceTicks(3); system.update(true); await new Promise(resolve => setImmediate(resolve))
    assert.equal(picks.length, 1, 'lava under the duel is a level-4 rescue')
    session.current.params = {}
    lava = false
  } finally { system.detach(); timer.dispose(); gameClock.activate(null) }
})

test('no pillar, hole, box or cover rest against an attacking player (arena slot 27: DigDown, death; 14.10: "закапываются и стоят афк")', () => {
  const tank = { id: 5, kind: 'Tank', distance: 3, player: true, threatening: true, hit: 6 }
  const hole = candidates(tactical({ health: 12, contact: true, canFight: false, shelter: 'DigDown', enemies: [tank] })).map(candidate => candidate.id)
  assert.ok(!hole.includes('DigDown'), hole.join(','))
  const walled = candidates(tactical({ health: 12, contact: true, canFight: false, shelter: 'BlockOff', escapeRoute: false, cover: true, edible: true, enemies: [tank] })).map(candidate => candidate.id)
  assert.ok(!walled.some(id => ['BlockOff', 'Hide', 'Heal'].includes(id)), walled.join(','))
  assert.ok(candidates(tactical({ health: 12, contact: true, canFight: false, shelter: 'DigDown', enemies: [zombie] })).some(candidate => candidate.id === 'DigDown'))
})

test('no shield stance against people without a shot in flight, nor with a second of them near (14.10: "я со спины подхожу и такого фармлю")', () => {
  const striker = { id: 5, kind: 'player', distance: 9, player: true, threatening: true }
  const second = { id: 6, kind: 'HuHguZ', distance: 7, player: true, threatening: false, foe: true }
  const ids = (s: Partial<TacticalState>) => candidates(tactical({ shield: true, ...s })).map(candidate => candidate.id)
  assert.ok(!ids({ enemies: [striker] }).includes('Shield'), 'one player walking up, nothing in flight: the skill goes on')
  assert.ok(ids({ enemies: [striker], incomingProjectiles: 1 }).includes('Shield'), 'his arrow in flight: the shield')
  assert.ok(!ids({ enemies: [striker, second], incomingProjectiles: 1 }).includes('Shield'), 'a second one near walks round the shield')
  assert.ok(ids({ enemies: [striker, { ...second, foe: false }], incomingProjectiles: 1 }).includes('Shield'), 'an ally bot near is no flanker')
})

test('a charged creeper is a 12-block blast: alarm when it swells, dodged by dodgeBlast (farm s4-stress-1: death at 4-5 blocks)', () => {
  const { session, bot } = observing()
  bot.registry.entitiesByName.creeper = require('minecraft-data')('1.21.11').entitiesByName.creeper
  const keys = bot.registry.entitiesByName.creeper.metadataKeys
  const metadata: unknown[] = []
  metadata[keys.indexOf('is_powered')] = true; metadata[keys.indexOf('swell_dir')] = -1
  bot.entities[11] = { id: 11, name: 'creeper', position: new Vec3(8.5, 64, .5), height: 1.7, width: .6, metadata, equipment: [] }
  const calm = observeTactics(session)
  assert.equal(calm.blast, 'charged_creeper')
  assert.equal(calm.explosion, false, 'a calm charged creeper 8 blocks off is no alarm')
  metadata[keys.indexOf('swell_dir')] = 1
  const swelling = observeTactics(session)
  assert.equal(swelling.explosion, true, 'swelling 8 blocks off: still inside its 12-block reach')
  assert.equal(candidates(swelling)[0]?.id, 'Dodge')
})

test('no last stand inside a blast alarm: Dodge wins at a swelling creeper even in a dead end (farm s4-stress-3)', () => {
  const creeper = { id: 12, kind: 'creeper', distance: 2.5, player: false, threatening: true, hit: 20 }
  const ids = candidates(tactical({ contact: true, explosion: true, escapeExhausted: true, enemies: [creeper] })).map(candidate => candidate.id)
  assert.equal(ids[0], 'Dodge', ids.join(','))
  assert.ok(!ids.includes('LastStand'))
})

test('no last stand under water out of air: Surface wins among drowned (cl-l 14.10)', () => {
  const drowned = { id: 13, kind: 'drowned', distance: 1.5, player: false, threatening: true, hit: 9 }
  const ids = candidates(tactical({ contact: true, drowning: true, water: true, escapeExhausted: true, enemies: [drowned] })).map(candidate => candidate.id)
  assert.equal(ids[0], 'Surface', ids.join(','))
  assert.ok(!ids.includes('LastStand'))
  const afloat = candidates(tactical({ contact: true, inWater: true, escapeExhausted: true, enemies: [drowned] })).map(candidate => candidate.id)
  assert.ok(!afloat.includes('LastStand'), 'head above water: still no stand in it (cl-s 14.10)')
})

test('a crit jump keeps the ground route: feet a block up still see the run they jumped from (farm slot 30: Fight<->LastStand)', () => {
  const { session, bot } = observing()
  const ground = observeTactics(session)
  const geometry = session._tacticalExitGeometry
  for (const height of [1.0, 1.17, 1.25]) {
    bot.entity.position = new Vec3(.5, 64 + height, .5); bot.entity.onGround = false
    const air = observeTactics(session)
    assert.equal(air.escapeRoute, ground.escapeRoute, `route at +${height}`)
    assert.equal(session._tacticalExitGeometry, geometry, `exit signature at +${height}`)
  }
  assert.equal(ground.escapeRoute, true)
})

function flicker(observe: (sample: number, now: number) => TacticalState, ends: Record<string, number> = {}, skill?: string) {
  const { TacticalSystem } = require('../src/tactics/minecraft')
  const gameClock = require('../src/game-clock')
  const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
  const { session, bot } = observing()
  const picks: string[] = []
  session.bus = { emit: (name: string, payload: any) => { if (name === 'tactical_selected') picks.push(payload.action) } }
  if (skill) session.current = { name: skill, ctl: { aborted: false, onAbort: [], abort() { this.aborted = true } } }
  let sample = 0
  const system = new TacticalSystem(session, { observe: () => observe(sample++, gameClock.now()), record: () => {},
    // An action runs until aborted, or ends by itself after ends[id] samples.
    execute: (action: { id: string }, ctl: { onAbort: Array<() => void> }) => new Promise(resolve => {
      ctl.onAbort.push(() => resolve({ cancelled: true }))
      const until = sample + (ends[action.id] ?? Infinity)
      const poll = () => sample >= until ? resolve({ ended: true }) : setImmediate(poll)
      if (Number.isFinite(until)) poll()
    }) })
  return { picks, async run(samples: number) {
    try {
      system.attach(bot)
      for (let i = 0; i < samples; i++) { timer.advanceTicks(3); system.update(true); await new Promise(resolve => setImmediate(resolve)) }
    } finally { system.detach(); timer.dispose(); gameClock.activate(null) }
  } }
}
const flaps = (picks: string[]) => picks.filter((pick, i) => i >= 2 && pick === picks[i - 2] && pick !== picks[i - 1]).length

test('an exit that flickers sample by sample does not swap Fight and LastStand (exhaustion holds 400 ms)', async () => {
  // Walking a corridor edge: a 3-block run in one cell, none in the next - each sample flips the dead-end fact.
  const stand = flicker((sample, now) => tactical({ at: now, contact: true, enemies: [zombie], escapeRoute: sample % 2 === 0 }))
  await stand.run(20)
  assert.equal(flaps(stand.picks), 0, stand.picks.join(','))
  assert.ok(stand.picks.length <= 2, stand.picks.join(','))
})

test('a fight dropped as unsustainable waits for two hits of recovery: one arrow and one regen point do not swap it with a retreat', async () => {
  // Skeleton 2.8 per arrow, fight floor 8: canFight crosses with each arrow and each regenerated point.
  const skeleton = { id: 3, kind: 'skeleton', distance: 4, player: false, threatening: true, hit: 2.8 }
  const health = [11.2, 8.4, 9.4, 10.4, 11.4, 12.4, 13.4, 13.4, 13.4, 13.4]
  const stand = flicker((sample, now) => {
    const hp = health[Math.min(health.length - 1, Math.floor(sample / 2))]
    return tactical({ at: now, contact: true, health: hp, enemies: [skeleton], canFight: hp - 2.8 > 8 })
  }, { CreateDistance: 12 })
  await stand.run(20)
  assert.ok(!stand.picks.slice(1).includes('Fight'), `recovery to 13.4 (< 8.4 + 2 x 2.8) is no reason to walk back: ${stand.picks.join(',')}`)
})

test('a started refuge holds against a shield at each volley and through its own heal threshold; a retreat is not traded for a fight', () => {
  const blaze = { id: 4, kind: 'blaze', distance: 6, player: false, threatening: true, hit: 2.5 }
  const hide = new TacticalArbiter()
  assert.equal(hide.decide(tactical({ at: 0, contact: true, enemies: [blaze], shelter: 'Hide', escapeRoute: false })).selected?.id, 'Hide')
  const volley = hide.decide(tactical({ at: 600, contact: true, enemies: [blaze], shelter: 'Hide', escapeRoute: false, incomingProjectiles: 1, shield: true }))
  assert.equal(volley.selected?.id, 'Hide', 'Hide>Shield>Hide on every blaze volley (stress stand)')
  const heal = new TacticalArbiter()
  assert.equal(heal.decide(tactical({ at: 0, contact: true, enemies: [zombie], health: 15.7, cover: true })).selected?.id, 'Heal')
  assert.equal(heal.decide(tactical({ at: 600, contact: true, enemies: [zombie], health: 16.2, cover: true })).selected?.id, 'Heal', 'one regenerated point is no reason to swap the run for a fight')
  const run = new TacticalArbiter()
  // A creeper: the run is the answer and it is kept. An archer at 6 is rushed instead once the body can fight (Codex q5 14.10:
  // a run in the open from a skeleton is shot in the back — s4d «an archer within 8 blocks is rushed»).
  const creeper = { id: 3, kind: 'creeper', distance: 6, player: false, threatening: true, hit: 2.8 }
  assert.equal(run.decide(tactical({ at: 0, contact: true, enemies: [creeper], canFight: false })).selected?.id, 'CreateDistance')
  assert.equal(run.decide(tactical({ at: 2000, contact: true, enemies: [creeper] })).selected?.id, 'CreateDistance', 'the retreat ends at its safe distance')
  const archer = new TacticalArbiter()
  const skeleton = { id: 7, kind: 'skeleton', distance: 6, player: false, threatening: true, hit: 2.8 }
  assert.equal(archer.decide(tactical({ at: 0, contact: true, enemies: [skeleton], canFight: false })).selected?.id, 'CreateDistance')
  assert.equal(archer.decide(tactical({ at: 2000, contact: true, enemies: [skeleton] })).selected?.id, 'Fight', 'the archer that shoots a runner in the back is rushed')
})

test('a kill ends the contact of the dead attacker, and a refuge run that ends at once sits out 2 s', async () => {
  const { TacticalSystem } = require('../src/tactics/minecraft')
  const gameClock = require('../src/game-clock')
  const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
  const { session, bot } = observing()
  const system = new TacticalSystem(session, { observe: () => tactical({ at: gameClock.now(), contact: true, enemies: [zombie] }), record: () => {},
    execute: async () => ({ killed: true }) })
  try {
    system.attach(bot); timer.advanceTicks(3); system.update(true)
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(session._tacticalRetreatSafeAt, gameClock.now(), 'Fight killed: the hit memory no longer makes contact')
  } finally { system.detach(); timer.dispose(); gameClock.activate(null) }
  const rest = flicker((_sample, now) => tactical({ at: now, contact: true, enemies: [zombie], health: 12, canFight: false, cover: true, shelter: 'Hide' }), { Heal: 0, Hide: 0 })
  await rest.run(12)
  assert.ok(rest.picks.length <= 3, `instant refuge ends are not re-selected on each sample: ${rest.picks.join(',')}`)
})

test('the blaze skill keeps level 3 at the spawner with or without fire resistance; in lava the tactics take over (S1 21:01, S1c 06.10)', async () => {
  const blazes = [0, 1, 2].map(i => ({ id: 10 + i, kind: 'blaze', distance: 3 + i, player: false, threatening: true, hit: 2.7 }))
  for (const [changes, owned] of [[{ fireResistance: true }, true], [{ fireResistance: false }, true], [{ fireResistance: true, lava: true }, false]] as const) {
    const stand = flicker((_sample, now) => tactical({ at: now, contact: true, health: 10, enemies: blazes, canFight: false,
      shelter: 'BlockOff', protectedEncounter: true, ...changes }), {}, 'blaze')
    await stand.run(6)
    if (owned) assert.deepEqual(stand.picks, [], JSON.stringify(changes))
    else assert.ok(stand.picks.length > 0, JSON.stringify(changes))
  }
})

test('a neutral mob that struck the body stays a threat for 10 s, past the 1.5 s hit memory of ne-guard; one that did not stays out (S1: 5 deaths by zombified piglins)', () => {
  const gameClock = require('../src/game-clock')
  const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
  try {
  const { session, bot } = observing()
  bot._client = new EventEmitter()
  bot.registry.entitiesByName = { zombified_piglin: { metadataKeys: [] } }
  session.autopilot = new Autopilot(session, {})
  session.autopilot.hookDamage(bot)
  const pigman = (id: number, x: number) => ({ id, name: 'zombified_piglin', position: new Vec3(x, 64, .5), height: 1.95, width: .6,
    equipment: [{ name: 'golden_sword' }], metadata: [] })
  bot.entities[7] = pigman(7, 2.5)
  bot.entities[8] = pigman(8, -3.5)
  assert.equal(observeTactics(session).enemies.length, 0, 'calm pigmen are no threat')
  bot._client.emit('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 8 })
  timer.advanceTicks(60)
  const state = observeTactics(session)
  assert.deepEqual(state.enemies.filter((enemy: any) => enemy.threatening).map((enemy: any) => enemy.id), [7], 'the striker only, 3 s later')
  assert.ok(threatLevel(state) >= 2)
  timer.advanceTicks(160)
  assert.equal(observeTactics(session).enemies.length, 0, 'forgotten after 10 s')
  } finally { timer.dispose(); gameClock.activate(null) }
})

test('a ghast is not fled first (64-block shots, FOLLOW_RANGE 100): the shield outranks a run priced at .3; a level-3 flicker within 2 s re-picks nothing', () => {
  const ghast = { id: 9, kind: 'ghast', distance: 9, player: false, threatening: true, hit: 4 }
  const shot = tactical({ contact: true, enemies: [ghast], shield: true, incomingProjectiles: 1, shelter: 'BlockOff' })
  const offered = candidates(shot)
  assert.equal(offered[0].id, 'Shield', JSON.stringify(offered))
  assert.ok(offered.filter(candidate => /^(Flee|CreateDistance)$/.test(candidate.id)).every(candidate => candidate.score < 30), JSON.stringify(offered))
  // Burning at 8 hp: level 3 with each fire tick, level 2 with each regenerated point.
  const husk = { id: 2, kind: 'husk', distance: 4.6, player: false, threatening: true, hit: 3 }
  const arbiter = new TacticalArbiter()
  const at = (t: number, health: number) => arbiter.decide(tactical({ at: t, health, burning: true, contact: true, enemies: [husk], canFight: false, shelter: 'BlockOff', blocks: 16 }))
  assert.equal(at(0, 8).level, 3)
  const first = at(0, 8).selected?.id
  at(150, 9); at(300, 9)
  const again = at(450, 8)
  assert.equal(again.level, 3)
  assert.equal(again.selected?.id, first, 'the same level 3 a moment later is no escalation')
  assert.equal(again.change, false)
})

test('no pillar or hole against a flyer: a phantom swoops onto it, a blaze shoots down (farm s1-LK-8: PillarUp x3 under blazes, death)', () => {
  for (const kind of ['phantom', 'blaze']) {
    const foe = { id: 4, kind, distance: 3, player: false, threatening: true, hit: 2.5 }
    for (const shelter of ['PillarUp', 'DigDown'] as const) {
      assert.ok(!candidates(tactical({ health: 5, contact: true, enemies: [foe], canFight: false, shelter })).some(c => c.id === shelter), `${shelter} vs ${kind}`)
    }
  }
  assert.ok(candidates(tactical({ health: 5, contact: true, enemies: [zombie], canFight: false, shelter: 'PillarUp' })).some(c => c.id === 'PillarUp'), 'a walker cannot reach a pillar')
})

test('an attacking player alone is run from at .4 of the price (he sprints as fast), never walled off (slot 27, 18 swaps; arena 14.10)', () => {
  const tank = { id: 5, kind: 'Tank', distance: 2.5, player: true, threatening: true, hit: 7 }
  const offered = candidates(tactical({ health: 9, contact: true, enemies: [tank], canFight: false, shelter: 'BlockOff' }))
  assert.equal(offered[0].id, 'CreateDistance', JSON.stringify(offered))
  assert.ok(offered.some(candidate => candidate.id === 'CreateDistance' && candidate.score === 85 * .4), JSON.stringify(offered))
  const bare = candidates(tactical({ health: 9, contact: true, enemies: [tank], canFight: false, blocks: 0 }))
  assert.equal(bare[0].id, 'CreateDistance', `no wall, shield or strike: run for cover rather than stand (${JSON.stringify(bare)})`)
  const mixed = candidates(tactical({ health: 9, contact: true, enemies: [tank, zombie], canFight: false })).map(c => c.id + ':' + c.score)
  assert.ok(mixed.includes('CreateDistance:85'), `a mob beside him is run from at full price: ${mixed.join(',')}`)
})

test('shots from beyond sight and blazes price a run down, not out: the shield and the wall go first (farm s4b-flap-1..3)', () => {
  const unseen = candidates(tactical({ incomingProjectiles: 1, contact: false, enemies: [], shield: true }))
  assert.equal(unseen[0].id, 'Shield', JSON.stringify(unseen))
  assert.ok(unseen.some(c => c.id === 'CreateDistance' && c.score === 85 * .5), `a run to the nearest cover is still there: ${JSON.stringify(unseen)}`)
  const hit = candidates(tactical({ contact: true, enemies: [], health: 9 })).map(c => c.id + ':' + c.score)
  assert.ok(hit.includes('CreateDistance:85'), `a hit from an unseen attacker runs at full price: ${hit.join(',')}`)
  const blaze = { id: 6, kind: 'blaze', distance: 8, player: false, threatening: true, hit: 4 }
  const blazes = candidates(tactical({ contact: true, enemies: [blaze], health: 9, canFight: false, shield: true, incomingProjectiles: 1 }))
  assert.equal(blazes[0].id, 'Shield', JSON.stringify(blazes))
  assert.ok(!blazes.some(c => c.id === 'Flee'), `a run from a blaze (48-block shots) at level 2 is not worth the work: ${JSON.stringify(blazes)}`)
  const bare = candidates(tactical({ contact: true, enemies: [blaze], health: 5, canFight: false, blocks: 0 }))
  assert.ok(/^(Flee|CreateDistance)$/.test(bare[0].id), `level 3, no shield, wall or strike: run for cover (${JSON.stringify(bare)})`)
})
