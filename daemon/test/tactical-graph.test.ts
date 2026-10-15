import test from 'node:test'
import assert from 'node:assert/strict'
import { TacticalArbiter } from '../src/tactics/arbiter'
import { TacticalGraph } from '../src/tactics/graph'
import { candidates, threatLevel, type TacticalState } from '../src/tactics/state'
import { EscapeProgress } from '../src/tactics/escape-progress'

const state = (changes: Partial<TacticalState> = {}): TacticalState => ({
  at: 0, health: 20, food: 20, armor: 0, weapon: true, shield: false, enemies: [], incomingProjectiles: 0,
  burning: false, lava: false, fireResistance: false, explosion: false, dangerousFall: false,
  emergencyController: false, inWater: false, cover: false, portal: false, escapeRoute: true, blocks: 16,
  water: false, edible: true, canFight: true, contact: false, shelter: null, protectedEncounter: false, ...changes
})
const enemy = { id: 1, kind: 'zombie', distance: 2, player: false, threatening: true }

test('fresh unknown damage preserves contact but cannot select a phantom fight or last stand', () => {
  const unknown = state({ contact: true, escapeExhausted: true })
  const graph = new TacticalGraph()
  assert.equal(threatLevel(unknown), 2)
  assert.ok(!graph.candidates(unknown).some(candidate => candidate.id === 'Fight' || candidate.id === 'LastStand'))
  assert.equal(graph.candidates(unknown)[0]?.id, 'CreateDistance')
  assert.equal(graph.canTransition('Flee', 'LastStand', unknown), false)
  assert.equal(graph.canTransition('Shield', 'Fight', unknown), false)
})

test('threat levels distinguish nearby, contact, critical, and immediate danger', () => {
  assert.equal(threatLevel(state()), 0)
  assert.equal(threatLevel(state({ enemies: [{ ...enemy, distance: 10 }] })), 1)
  assert.equal(threatLevel(state({ enemies: [enemy], contact: true })), 2)
  assert.equal(threatLevel(state({ enemies: [enemy], contact: true, health: 3 })), 3)
  assert.equal(threatLevel(state({ explosion: true })), 4)
  assert.equal(threatLevel(state({ dangerousFall: true })), 4)
})

test('fight graph is interrupted by a critical refuge, then healing and strategic release', () => {
  const arbiter = new TacticalArbiter()
  assert.equal(arbiter.decide(state({ enemies: [enemy], contact: true })).selected?.id, 'Fight')
  const critical = arbiter.decide(state({ at: 150, enemies: [enemy], contact: true, health: 3, canFight: false, shelter: 'BlockOff' }))
  assert.equal(critical.selected?.id, 'BlockOff')
  assert.equal(critical.change, true)
  const healing = arbiter.decide(state({ at: 650, enemies: [{ ...enemy, distance: 10 }], health: 5, cover: true }))
  assert.equal(healing.selected?.id, 'Heal')
  assert.equal(arbiter.decide(state({ at: 650, health: 16 })).release, true, 'confirmed calm releases without a timer tail')
})

test('utility hysteresis retains a valid action but an emergency bypasses commitment', () => {
  const arbiter = new TacticalArbiter()
  assert.equal(arbiter.decide(state({ contact: true, enemies: [enemy] })).selected?.id, 'Fight')
  const modest = arbiter.decide(state({ at: 150, contact: true, enemies: [enemy], shelter: 'BlockOff' }))
  assert.equal(modest.selected?.id, 'Fight')
  const explosion = arbiter.decide(state({ at: 200, contact: true, enemies: [enemy], explosion: true }))
  assert.equal(explosion.selected?.id, 'Dodge')
  assert.equal(explosion.change, true)
})

test('a materially better available action starts immediately, independent of the clock', () => {
  for (const at of [0, 500, 3000, 15000, 60000]) {
    const arbiter = new TacticalArbiter()
    const threatened = state({ contact: true, enemies: [enemy], health: 12 })
    assert.equal(arbiter.decide(threatened).selected?.id, 'Fight')
    const shelter = arbiter.decide({ ...threatened, at, cover: true })
    assert.equal(shelter.selected?.id, 'Heal', `real cover is useful immediately at ${at}`)
  }
})

test('the same critical threat does not restart a running action after an arbitrary clock jump', () => {
  const arbiter = new TacticalArbiter()
  const hot = state({ health: 8, burning: true, contact: true, canFight: false, shelter: 'BlockOff',
    enemies: [{ ...enemy, distance: 4.6 }] })
  const first = arbiter.decide(hot).selected?.id
  arbiter.decide({ ...hot, health: 9, at: 500 })
  const again = arbiter.decide({ ...hot, at: 60000 })
  assert.equal(again.selected?.id, first); assert.equal(again.change, false)
  const newcomer = arbiter.decide({ ...hot, at: 60000, enemies: [{ ...enemy, id: 3 }] })
  assert.equal(newcomer.change, true, 'a newly observed critical attacker is new information')
})

test('returning by preference keeps its score margin until the run ends or the alternative really improves', () => {
  const arbiter = new TacticalArbiter(), threatened = state({ contact: true, enemies: [enemy] })
  let fight = 100, heal = 90
  arbiter.graph.candidates = () => [{ id: 'Fight', score: fight, reason: 'contact' }, { id: 'Heal', score: heal, reason: 'cover' }]
    .sort((a, b) => b.score - a.score) as any
  assert.equal(arbiter.decide(threatened).selected?.id, 'Fight')
  heal = 180
  assert.equal(arbiter.decide({ ...threatened, at: 3000 }).selected?.id, 'Heal')
  fight = 210
  for (const at of [3500, 6000, 60000]) assert.equal(arbiter.decide({ ...threatened, at }).selected?.id, 'Heal')
  fight = 260
  assert.equal(arbiter.decide({ ...threatened, at: 60000 }).selected?.id, 'Fight', 'the margin is a price, not a permanent ban')
})

test('airborne emergency releases movement actions to the tick controller', () => {
  const arbiter = new TacticalArbiter()
  arbiter.decide(state({ contact: true, enemies: [enemy] }))
  const decision = arbiter.decide(state({ at: 150, dangerousFall: true, contact: true, enemies: [enemy], shelter: 'PillarUp' }))
  assert.equal(decision.selected, null)
  assert.equal(decision.level, 4)
  assert.equal(decision.release, true)
})

test('a forecast lava fall uses the pearl before contact while an active clutch keeps ownership', () => {
  const arbiter = new TacticalArbiter()
  arbiter.decide(state({ contact: true, enemies: [enemy] }))
  const falling = state({ at: 150, lavaAhead: true, pearlEscape: true, airborne: true })
  assert.equal(arbiter.decide(falling).selected?.id, 'PearlEscape')
  assert.equal(arbiter.decide({ ...falling, at: 200, dangerousFall: true }).selected, null)
})

test('graph exposes guarded edges from combat to retreat and blocks premature recovery', () => {
  const graph = new TacticalGraph()
  assert.equal(graph.canTransition('Fight', 'BlockOff', state({ contact: true, health: 3 })), true)
  assert.equal(graph.canTransition('Flee', 'Heal', state({ health: 3, cover: false })), false)
  assert.equal(graph.canTransition('Flee', 'Heal', state({ health: 3, cover: true })), true)
  assert.equal(graph.canTransition('Fight', 'EmergencyController', state({ dangerousFall: true })), true)
})

test('lava graph chooses real air escape, then potion and climb without releasing while still in lava', () => {
  const graph = new TacticalGraph()
  const lava = state({ lava: true, flightEscape: true, pearlEscape: true, fireResistancePotion: true, lavaClimb: true, shelter: 'BlockOff' })
  assert.equal(threatLevel(lava), 4)
  assert.equal(graph.canTransition('Fight', 'FlightEscape', lava), true)
  assert.equal(graph.candidates(lava, 'Fight')[0].id, 'FlightEscape')
  assert.equal(graph.candidates({ ...lava, failedEscapes: ['FlightEscape'] }, 'FlightEscape')[0].id, 'PearlEscape')
  assert.equal(graph.candidates({ ...lava, failedEscapes: ['FlightEscape', 'PearlEscape'] }, 'PearlEscape')[0].id, 'UseFireResistance')
  const protectedLava = { ...lava, fireResistance: true, flightEscape: false, pearlEscape: false }
  assert.equal(threatLevel(protectedLava), 2)
  assert.equal(graph.candidates(protectedLava, 'UseFireResistance')[0].id, 'ClimbOut')
  assert.ok(!candidates(protectedLava).some(candidate => candidate.id === 'BlockOff' || candidate.id === 'Heal'))
  assert.equal(graph.canTransition('ClimbOut', 'Strategic', state()), true)
  const intermediate = { ...protectedLava, lava: false, lavaEscapePending: true, contact: true, canFight: false, enemies: [enemy], escapeExhausted: true }
  assert.equal(threatLevel(intermediate), 2)
  assert.equal(graph.candidates(intermediate, 'ClimbOut')[0].id, 'ClimbOut', 'a first dry building block is not the completed shore goal')
  assert.equal(graph.canTransition('ClimbOut', 'LastStand', intermediate), false)
})

test('confirmed fire resistance permits repelling a visible close attacker during an unfinished rescue', () => {
  const graph = new TacticalGraph()
  const rescuing = state({ lava: true, lavaEscapePending: true, lavaClimb: true, fireResistance: true, contact: true, enemies: [enemy], health: 4 })
  assert.equal(graph.candidates(rescuing, 'ClimbOut')[0]?.id, 'Fight')
  assert.equal(graph.candidates({ ...rescuing, enemies: [{ ...enemy, distance: 8 }] }, 'ClimbOut')[0]?.id, 'ClimbOut')
  assert.equal(graph.candidates({ ...rescuing, canFight: false }, 'ClimbOut')[0]?.id, 'ClimbOut')
  assert.ok(!graph.candidates({ ...rescuing, fireResistance: false }, 'ClimbOut').some(candidate => candidate.id === 'Fight'))
  assert.equal(graph.candidates({ ...rescuing, flightEscape: true }, 'ClimbOut')[0]?.id, 'FlightEscape')
})

test('failed escape in an unchanged corner selects LastStand and a new exit clears that mode', () => {
  const progress = new EscapeProgress()
  const graph = new TacticalGraph()
  const observation = { at: 0, position: { x: 0, y: 64, z: 0 }, threatDistance: 2, exits: 'same stone corner', available: true,
    actions: ['Flee', 'BlockOff'] as const }
  const before = { ...observation, actions: [...observation.actions] }
  progress.observe(before)
  progress.begin('Flee', before)
  progress.finish('Flee', { ...before, at: 4000 }, 'completed')
  progress.begin('BlockOff', { ...before, at: 4000 })
  progress.finish('BlockOff', { ...before, at: 8000 }, 'failed')
  const failed = progress.observe({ ...before, at: 8000 })
  assert.equal(failed.exhausted, true)
  const corner = state({ health: 4, contact: true, enemies: [enemy], canFight: false, shelter: 'BlockOff', failedEscapes: failed.failed, escapeExhausted: failed.exhausted })
  assert.equal(graph.candidates(corner, 'Flee')[0].id, 'LastStand')
  const opened = progress.observe({ ...before, exits: 'opened door', at: 8200 })
  assert.equal(opened.exhausted, false)
  assert.deepEqual(opened.failed, [])
  assert.equal(graph.candidates({ ...corner, failedEscapes: opened.failed, escapeExhausted: opened.exhausted }, 'LastStand')[0].id, 'BlockOff')
  assert.ok(!candidates(state({ lava: true, escapeRoute: false, escapeExhausted: true })).some(candidate => candidate.id === 'LastStand'))
})

test('failed lava escape retains environmental rescue priority even while an enemy attacks', () => {
  const graph = new TacticalGraph()
  const trapped = state({ lava: true, health: 4, contact: true, enemies: [enemy], escapeExhausted: true,
    failedEscapes: ['FlightEscape', 'PearlEscape'], fireResistancePotion: true })
  assert.equal(graph.canTransition('PearlEscape', 'LastStand', trapped), false)
  assert.equal(graph.candidates(trapped, 'PearlEscape')[0].id, 'UseFireResistance')
  assert.deepEqual(graph.candidates({ ...trapped, fireResistancePotion: false, escapeRoute: false }, 'PearlEscape'), [])
  const arbiter = new TacticalArbiter()
  assert.equal(arbiter.decide({ ...trapped, lava: false }).selected?.id, 'LastStand')
  const fellIn = arbiter.decide({ ...trapped, at: 150, fireResistancePotion: false, escapeRoute: false })
  assert.equal(fellIn.selected, null, 'an action whose environmental guard became invalid cannot remain active')
  assert.equal(fellIn.release, true)
})
