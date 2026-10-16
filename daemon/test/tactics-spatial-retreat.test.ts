import test from 'node:test'
import assert from 'node:assert/strict'
import { TacticalArbiter } from '../src/tactics/arbiter'
import { candidates, type TacticalState } from '../src/tactics/state'
import { runSystem } from '../src/tactics/sim-run'
import { SCENARIOS, randomScenario } from '../src/tactics/sim-scenarios'
import { createWorld, observeWorld } from '../src/tactics/sim-world'
import { mineflayerFacade } from '../src/tactics/sim-mineflayer'
import { observeTactics } from '../src/tactics/minecraft'

const state = (extra: Partial<TacticalState> = {}): TacticalState => ({ at: 0, health: 9.5, food: 10, armor: 15,
  weapon: true, shield: true, enemies: [], incomingProjectiles: 0, burning: false, lava: false,
  fireResistance: false, explosion: false, dangerousFall: false, emergencyController: false, inWater: false,
  cover: false, portal: false, escapeRoute: true, blocks: 0, water: false, edible: true,
  canFight: false, contact: true, shelter: null, protectedEncounter: false, ...extra })
const seen = () => state({ at: 150, canFight: true,
  enemies: [{ id: 2, kind: 'skeleton', distance: 4.6, threatening: true, player: false, hit: 1.6 }] })

test('a running retreat keeps its spatial endpoint when the other executor name remains available', () => {
  const arbiter = new TacticalArbiter()
  assert.equal(arbiter.decide(state()).selected?.id, 'CreateDistance')
  const visible = seen(), ids = candidates(visible).map(c => c.id)
  assert.ok(ids.includes('Flee') && !ids.includes('CreateDistance'), 'the scoring floor hides only one name')
  const decision = arbiter.decide(visible)
  assert.equal(decision.selected?.id, 'CreateDistance')
  assert.equal(decision.change, false)
})

test('a physically lost route and a blast still interrupt that shared retreat', () => {
  for (const change of [{ escapeRoute: false }, { explosion: true }]) {
    const arbiter = new TacticalArbiter()
    arbiter.decide(state())
    const decision = arbiter.decide({ ...seen(), ...change })
    assert.notEqual(decision.selected?.id, 'CreateDistance')
    assert.equal(decision.change, true)
  }
})

test('stage B/55: transient occlusion and restored sight do not restart the fight before freeing the body', async () => {
  const result = await runSystem(randomScenario(55), { observe: 'minecraft' })
  assert.equal(result.died, null)
  assert.ok(result.selections.some(s => s.action === 'FreeEmbedded'))
  assert.deepEqual(result.violations, [])
})

test('construction exposure is a price: a fragile body steps away, an unexposed or trapped body can still build', () => {
  const boxed = state({ health: 4, armor: 7, blocks: 16, shield: false, shelter: 'BlockOff',
    enemies: [{ id: 2, kind: 'skeleton', distance: 3.6, threatening: true, player: false, hit: 2.765 }],
    buildCostHp: 2.765 })
  const choices = candidates(boxed)
  assert.equal(choices[0].id, 'Flee')
  assert.ok(choices.some(c => c.id === 'BlockOff' && c.score > 0))
  assert.equal(candidates({ ...boxed, buildCostHp: 0 })[0].id, 'BlockOff')
  assert.ok(candidates({ ...boxed, escapeRoute: false }).some(c => c.id === 'BlockOff' && c.score > 0))
})

test('one affordable build hit does not turn a healthy box into a retreat; an unshakeable shooter still gets cover', () => {
  const healthy = state({ health: 9, armor: 0, shield: false, blocks: 64, shelter: 'BlockOff', buildCostHp: 3.5,
    enemies: [{ id: 2, kind: 'skeleton', distance: 2.4, threatening: true, player: false, hit: 3.5 }] })
  assert.equal(candidates(healthy)[0].id, 'BlockOff', 'gen1/1184: the box survives its construction hit')
  const trapped = state({ health: 6, blocks: 64, escapeRoute: false, shelter: 'BlockOff', buildCostHp: 3,
    enemies: [{ id: 2, kind: 'skeleton', distance: 10, threatening: true, player: false, hit: 3 }] })
  assert.equal(candidates(trapped)[0].id, 'BlockOff', 'no retreat route to buy instead')
  const blaze = state({ health: 5, blocks: 64, shelter: 'BlockOff', buildCostHp: 2.7,
    enemies: [{ id: 2, kind: 'blaze', distance: 5.8, threatening: true, player: false, hit: 2.7 }] })
  assert.equal(candidates(blaze)[0].id, 'BlockOff', 'a run does not break the blaze weapon range')
})

test('a paid construction hit is not charged as a second complete build when the same box is half finished', t => {
  const previous = process.env.ND_OW_NIGHT_BLOCKOFF
  process.env.ND_OW_NIGHT_BLOCKOFF = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.ND_OW_NIGHT_BLOCKOFF; else process.env.ND_OW_NIGHT_BLOCKOFF = previous
  })
  const arbiter = new TacticalArbiter()
  const initial = state({ health: 7, armor: 7, shield: false, edible: false, blocks: 64,
    shelter: 'BlockOff', buildCostHp: 2.765,
    enemies: [{ id: 2, kind: 'skeleton', distance: 5.3, threatening: true, player: false, hit: 2.765 }] })
  assert.equal(arbiter.decide(initial).selected?.id, 'BlockOff')
  const hit = arbiter.decide({ ...initial, at: 1100, health: 3.8 })
  assert.equal(hit.selected?.id, 'BlockOff')
  assert.equal(hit.change, false)
  assert.equal(arbiter.decide({ ...initial, at: 1150, health: 3.8, explosion: true }).selected?.id, 'Dodge')
})

test('the stand prices the same physical build interval without reading the unknown bow phase', () => {
  const w = createWorld({ name: 'priced-box', body: { hp: 4, armor: 7 }, events: [
    { at: 1, type: 'enemy', kind: 'skeleton', distance: 3.6 }] })
  const { stepWorld } = require('../src/tactics/sim-world')
  stepWorld(w)
  const before = observeWorld(w).buildCostHp
  assert.ok(before > 0)
  w.enemies[0].cooldown = 100
  assert.equal(observeWorld(w).buildCostHp, before)
})

test('the box estimate stays within its overworld walker and bow domain', () => {
  const { stepWorld } = require('../src/tactics/sim-world')
  for (const [nether, kind] of [[true, 'skeleton'], [false, 'blaze'], [false, 'piglin_brute']] as const) {
    const w = createWorld({ name: 'outside-box-estimate', world: { nether }, events: [
      { at: 1, type: 'enemy', kind, distance: 6 }] })
    stepWorld(w)
    assert.equal(observeWorld(w).buildCostHp, undefined, `${nether}:${kind}`)
  }
})

test('real observation publishes the physical box plan cost against a visible skeleton', () => {
  const w = createWorld({ name: 'native-box-estimate', body: { hp: 4, armor: 7 }, events: [
    { at: 1, type: 'enemy', kind: 'skeleton', distance: 3.6 }] })
  require('../src/tactics/sim-world').stepWorld(w)
  const session: any = {}, facade = mineflayerFacade(w, session)
  Object.assign(session, { bot: facade.bot })
  facade.sync()
  const s = observeTactics(session)!
  assert.equal(s.shelter, 'BlockOff')
  assert.ok(s.buildCostHp! > 0)
})

test('gen1/3008 and gen2/3309: an exposed build must not cut short the payable retreat', async () => {
  for (const name of ['regress-box-flight-arrow', 'regress-retreat-box-eta']) {
    const scenario = SCENARIOS.find(s => s.name === name)!
    assert.ok(scenario)
    const result = await runSystem(scenario)
    assert.equal(result.died, null, scenario.name)
    assert.deepEqual(result.violations, [], scenario.name)
  }
})
