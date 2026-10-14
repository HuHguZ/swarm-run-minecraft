import test from 'node:test'
import assert from 'node:assert/strict'
const { candidates } = require('../src/tactics/state')
const { TacticalArbiter } = require('../src/tactics/arbiter')

// Ходячие Ада без золота (агент Ада 14.10, сцена try-lab-ne-piglin): брут, хоглин или двое — нора на 2 вниз (PillarUp/netherHide)
// выше дуэли, бега и последнего боя; гаст над обрывом — коробка выше щита.
const make = (changes: Record<string, any> = {}) => ({ at: 0, health: 20, food: 20, armor: 0, weapon: true, shield: true,
  enemies: [{ id: 1, kind: 'piglin_brute', distance: 6, threatening: true, player: false, hit: 13 }],
  incomingProjectiles: 0, burning: false, lava: false, fireResistance: false, explosion: false, dangerousFall: false,
  emergencyController: false, inWater: false, cover: false, portal: false, escapeRoute: true, blocks: 128, water: false,
  edible: true, canFight: false, contact: false, shelter: 'BlockOff', protectedEncounter: false, ...changes })

test('брут в 6 бл. — нора (PillarUp) первой, ещё до контакта', () => {
  assert.equal(candidates(make({ netherHide: true }))[0].id, 'PillarUp')
})
test('загнан в угол вплотную — нора выше последнего боя', () => {
  assert.equal(candidates(make({ netherHide: true, contact: true, escapeExhausted: true, health: 6 }))[0].id, 'PillarUp')
})
test('без норы (netherHide нет) — прежний выбор, не PillarUp норы', () => {
  assert.ok(!candidates(make({ contact: true })).some(c => c.id === 'PillarUp' && /Nether walkers/.test(c.reason)))
})
test('лава или взрыв — нора не предлагается', () => {
  for (const changes of [{ lava: true }, { explosion: true }, { dangerousFall: true }]) {
    assert.ok(!candidates(make({ netherHide: true, contact: true, ...changes })).some(c => c.id === 'PillarUp' && /Nether walkers/.test(c.reason)), JSON.stringify(changes))
  }
})
test('арбитр уходит из дуэли в нору, и рост угрозы до 3 её не перезапускает', () => {
  const arbiter = new TacticalArbiter()
  const piglins = [{ id: 1, kind: 'piglin', distance: 3, threatening: true, player: false, hit: 2 }, { id: 2, kind: 'piglin', distance: 5, threatening: true, player: false, hit: 2 }]
  const duel = arbiter.decide(make({ enemies: [piglins[0]], contact: true, canFight: true, shelter: null }))
  assert.equal(duel.selected?.id, 'Fight')
  const hide = arbiter.decide(make({ at: 400, enemies: piglins, contact: true, canFight: true, netherHide: true, shelter: null }))
  assert.equal(hide.selected?.id, 'PillarUp')
  assert.equal(hide.change, true)
  const hit = arbiter.decide(make({ at: 800, enemies: piglins, contact: true, canFight: true, netherHide: true, shelter: null, health: 5 }))
  assert.equal(hit.selected?.id, 'PillarUp')
  assert.equal(hit.change, false, 'тот же PillarUp — без перезапуска копки')
})
test('гаст над обрывом и шар в полёте — коробка выше щита', () => {
  const ghast = { id: 3, kind: 'ghast', distance: 20, threatening: true, player: false, hit: 6 }
  const state = make({ enemies: [ghast], incomingProjectiles: 1, canFight: true, ghastEdge: true })
  assert.equal(candidates(state)[0].id, 'BlockOff')
  assert.notEqual(candidates({ ...state, ghastEdge: false })[0].id, 'BlockOff')
})
