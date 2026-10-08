import test from 'node:test'
import assert from 'node:assert/strict'
const { plan } = require('../src/core/strategy')
const { emptyWorld, fact } = require('../src/core/world-state')
const { armsRegistry, opponentDefeated, powerOf, visiblePower, loseChance, ARMS_RISK_PENALTY } = require('../src/pvp/arms-graph')

function state(resources: Record<string, number>, facts: Record<string, any> = {}) {
  const s = emptyWorld()
  s.resources = resources
  for (const [k, v] of Object.entries(facts)) s.facts[k] = fact(v, 'observed', 0)
  return s
}
const first = (s: any) => plan(armsRegistry(), s, opponentDefeated, { riskPenalty: ARMS_RISK_PENALTY }).steps.map((x: any) => x.id)

test('гонка: пустой старт — разведка, затем известный сундук; без лута и после срока — атака', () => {
  assert.equal(first(state({ power: 1, unscouted: 6 }, { enemy_power: 1 }))[0], 'ScoutArea', 'враг не виден — паритет на момент наблюдения')
  assert.equal(first(state({ power: 1, unscouted: 6, chests: 1 }, { enemy_power: 1 }))[0], 'LootChest')
  assert.equal(first(state({ power: 1, caches: 1 }, { enemy_power: 1 }))[0], 'OpenCache')
  assert.deepEqual(first(state({ power: 12 })), ['Engage'], 'брать нечего — в бой')
  assert.deepEqual(first(state({ power: 3, unscouted: 6, chests: 2 }, { deadline: true, enemy_known: true })), ['Engage'], 'срок лута вышел, враг на виду')
})

test('гонка: враг рядом — сильнее меня и лут есть: уйти; слабее — атаковать', () => {
  assert.equal(first(state({ power: 6, chests: 2, unscouted: 4 }, { enemy_near: true, enemy_known: true, enemy_power: 14 }))[0], 'Retreat')
  assert.equal(first(state({ power: 18, chests: 2 }, { enemy_near: true, enemy_known: true, enemy_power: 6 }))[0], 'Engage')
  assert.deepEqual(first(state({ power: 6, chests: 2, unscouted: 4 }, { enemy_near: true, enemy_contact: true, enemy_known: true, enemy_power: 14 })), ['Engage'], 'бьёт вплотную — уходить поздно')
  assert.equal(first(state({ power: 1, unscouted: 20 }, { enemy_near: true, enemy_known: true, enemy_power: 1 }))[0], 'Retreat', 'равные с пустыми руками — не драться, а лутать')
})

test('сила снаряжения: алмаз > железо > ничего, броня и тотем считаются; видимое — только руки и броня', () => {
  const bare = powerOf([]).total
  const iron = powerOf([{ name: 'iron_sword' }]).total
  const dia = powerOf([{ name: 'diamond_sword' }]).total
  assert.ok(bare < iron && iron < dia)
  const kit = powerOf([{ name: 'iron_sword' }, { name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }, { name: 'iron_boots' }, { name: 'totem_of_undying' }])
  assert.ok(kit.total > iron + 15, `полный железный комплект с тотемом ${kit.total}`)
  assert.equal(kit.armor, 15)
  assert.equal(powerOf([{ name: 'iron_helmet' }, { name: 'iron_helmet' }]).armor, 2, 'два шлема — один слот')
  assert.ok(visiblePower(['diamond_sword', 'diamond_chestplate']) > visiblePower(['iron_sword']))
  assert.ok(loseChance(10, 2) < 0.2 && loseChance(2, 10) > 0.8 && loseChance(5, 5) === 0.5)
})

test('P7 ranged: бонус только за оружие с совместимым боевым снарядом', () => {
  const item = (name: string, extra: any = {}) => ({ name, count: 1, ...extra })
  const cases: Array<[string, any[], number]> = [
    ['нет оружия', [item('arrow'), item('firework_rocket', { stars: 3 })], 1],
    ['пустой лук', [item('bow')], 1],
    ['лук и пустая ракета', [item('bow'), item('firework_rocket')], 1],
    ['лук и боевая ракета', [item('bow'), item('firework_rocket', { stars: 3 })], 1],
    ['пустой арбалет', [item('crossbow')], 1],
    ['арбалет и неизвестная ракета', [item('crossbow'), item('firework_rocket')], 1],
    ['арбалет и пустая ракета', [item('crossbow'), item('firework_rocket', { stars: 0 })], 1],
    ['арбалет и боевая ракета', [item('crossbow'), item('firework_rocket', { stars: 3 })], 5],
    ['заряженная стрела', [item('crossbow', { crossbow: { loaded: true, ammo: 'arrow' } })], 5],
    ['заряженная боевая ракета', [item('crossbow', { crossbow: { loaded: true, ammo: 'firework', stars: 2 } })], 5],
    ['заряженная пустая ракета', [item('crossbow', { crossbow: { loaded: true, ammo: 'firework', stars: 0 } })], 1],
    ['заряд неизвестен', [item('crossbow', { crossbow: { loaded: true, ammo: null } })], 1],
    ['заряд снят', [item('crossbow', { crossbow: { loaded: false, ammo: 'arrow' } })], 1],
    ['боеприпасы кончились', [item('bow'), item('crossbow'), item('arrow', { count: 0 }), item('firework_rocket', { count: 0, stars: 2 })], 1]
  ]
  for (const weapon of ['bow', 'crossbow']) for (const ammo of ['arrow', 'spectral_arrow', 'tipped_arrow']) {
    cases.push([`${weapon}+${ammo}`, [item(weapon), item(ammo)], 5])
  }
  for (const ammo of ['spectral_arrow', 'tipped_arrow']) cases.push([`заряженный ${ammo}`, [item('crossbow', { crossbow: { loaded: true, ammo } })], 5])
  cases.push(['два оружия не удваивают бонус', [item('bow'), item('crossbow'), item('arrow'), item('firework_rocket', { stars: 2 })], 5])
  for (const [label, items, want] of cases) assert.equal(powerOf(items).total, want, label)
})

test('крафт: из слитков и палки — железный меч; без палки и досок — нет; граф берёт крафт, когда он есть', () => {
  const { bestCraft } = require('../src/pvp/arms-graph')
  assert.equal(bestCraft([{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }])?.item, 'iron_sword')
  assert.equal(bestCraft([{ name: 'iron_ingot', count: 3 }]), null)
  assert.equal(bestCraft([{ name: 'diamond_sword' }, { name: 'iron_ingot', count: 2 }, { name: 'oak_planks', count: 4 }]), null, 'меч хуже имеющегося — не нужен')
  assert.equal(bestCraft([{ name: 'iron_sword' }, { name: 'iron_ingot', count: 8 }, { name: 'stick' }])?.item, 'iron_chestplate', 'меч уже есть — нагрудник')
  assert.ok(first(state({ power: 3, unscouted: 4, craft_gain: 5 }, { enemy_power: 3 })).includes('CraftUpgrade'), 'крафт в плане')
})

test('засада без позиции не даёт бонуса: неудачное ожидание не меняет риск боя (S7d, ревью Codex)', () => {
  const { armsRegistry } = require('../src/pvp/arms-graph')
  const eng = armsRegistry().all().find((x: any) => x.id === 'Engage')
  const a = state({ power: 10 }, { deadline: true, enemy_power: 10, enemy_known: true })
  const b = state({ power: 10 }, { deadline: true, enemy_power: 10, enemy_known: true, ambushed: true })
  assert.equal(eng.estimateRisk(a), eng.estimateRisk(b))
  assert.deepEqual(first(state({ power: 10 }, { deadline: true, enemy_power: 10, ambushed: true })), ['Engage'])
})

test('гонка, S7d (ревью Codex): польза сундука тает к полному набору; при 3 хп от сильного — сперва восстановиться', () => {
  const { chestMargin, powerOf } = require('../src/pvp/arms-graph')
  const full = powerOf(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'diamond_sword', 'shield'].map(name => ({ name }))).total
  assert.ok(chestMargin(1) > 0.9 && chestMargin(full) < 0.3)
  const fullPlan = first(state({ power: Math.round(full), chests: 3 }, { enemy_power: Math.round(full), enemy_known: true }))
  assert.ok(fullPlan.filter((x: string) => x === 'LootChest').length <= 1, fullPlan.join('>'))
  const low = state({ power: 35, chests: 2, heal_items: 2 }, { enemy_known: true, enemy_power: 20 })
  low.health = 3; low.hunger = 15; low.inventory = { bread: 2 }
  const lp = first(low)
  assert.ok(['Retreat', 'Recover'].includes(lp[0]) && lp.indexOf('Recover') >= 0 && lp.indexOf('Recover') < lp.indexOf('Engage'), 'на 3 хп — отойти и вылечиться до боя: ' + lp.join('>'))
  const ok = state({ power: 35, chests: 2, heal_items: 2 }, { enemy_known: true, enemy_power: 20 })
  assert.equal(first(ok)[0], 'Engage', 'на 20 хп и сильнее — бить')
})

test('Recover: голод без еды и одни зелья не обещают регенерацию', () => {
  for (const inventory of [{}, { potion: 3, splash_potion: 2 }]) {
    const s = state({ power: 14, heal_items: 5 }, { enemy_power: 10, enemy_known: true })
    s.health = 3; s.hunger = 10; s.inventory = inventory
    assert.equal(armsRegistry().get('Recover').preconditions(s), false, JSON.stringify(inventory))
    assert.deepEqual(first(s), ['Engage'])
  }
})

test('Recover: ожидание расходует сытость и не создаёт полное здоровье из пустого инвентаря', () => {
  const { applyEffect } = require('../src/core/world-state')
  const recover = armsRegistry().get('Recover')
  let s = state({ power: 14 }, { enemy_power: 10, enemy_known: true, enemy_near: true })
  s.health = 3; s.hunger = 20
  const effect = typeof recover.expectedEffects === 'function' ? recover.expectedEffects(s) : recover.expectedEffects
  let after = applyEffect(s, effect)
  assert.ok(after.health > 3 && after.health <= 6, `за 15 с без известного насыщения не более трёх slow-regen HP: ${after.health}`)
  assert.ok(after.hunger < 20, 'регенерация тратит еду')
  assert.equal(after.facts.enemy_near.value, true, 'восстановление не доказывает успешный отход')
  for (let i = 0; i < 5 && recover.preconditions(after); i++) {
    after = applyEffect(after, typeof recover.expectedEffects === 'function' ? recover.expectedEffects(after) : recover.expectedEffects)
  }
  assert.ok(after.health < 14, 'пустой инвентарь не превращает ожидание в бесконечное лечение')
})

test('Recover: еда в прогнозе конечна, неподтверждённые зелья и рыба в ведре не еда', () => {
  const { applyEffect } = require('../src/core/world-state')
  const { recoveryFood } = require('../src/pvp/arms-graph')
  const recover = armsRegistry().get('Recover')
  const s = state({ power: 35, heal_items: 2 }, { enemy_power: 20 })
  s.health = 3; s.hunger = 10; s.inventory = { bread: 2, potion: 4, salmon_bucket: 1 }
  assert.equal(recoveryFood(s.inventory).count, 2)
  const fed = applyEffect(s, recover.expectedEffects(s))
  assert.equal(fed.health, 3, 'один хлеб на hunger10 не включает natural regen')
  assert.equal(fed.hunger, 15)
  assert.equal(fed.resources.heal_items, 1)
  const healed = applyEffect(fed, recover.expectedEffects(fed))
  assert.equal(healed.resources.heal_items, 0)
  assert.ok(healed.health > 3 && healed.health <= 6)
  assert.equal(recover.preconditions(healed), false, 'израсходованную еду повторно не планирует')
})

test('Recover: яблоки дают конечную регенерацию даже ниже 18 еды; план сравнивает её с боем', () => {
  const { applyEffect } = require('../src/core/world-state')
  const recover = armsRegistry().get('Recover')
  for (const [name, gain] of [['golden_apple', 4], ['enchanted_golden_apple', 12]] as const) {
    const s = state({ power: 35, heal_items: 1 }, { enemy_power: 20, enemy_known: true })
    s.health = 3; s.hunger = 10; s.inventory = { [name]: 1 }
    const after = applyEffect(s, recover.expectedEffects(s))
    assert.equal(after.health, 3 + gain, name)
    assert.equal(after.hunger, 14, 'регенерация от эффекта не расходует сытость')
    assert.equal(after.resources.heal_items, 0)
    assert.equal(recover.preconditions(after), false, 'одно яблоко не лечит повторно')
    assert.equal(first(s)[0], 'Recover', 'лечение выигрывает по цене и риску при низком голоде')
  }
})

test('Recover: прогноз совпадает с выбором eat и не тратит одно яблоко вместо другой еды', () => {
  const { applyEffect } = require('../src/core/world-state')
  const recover = armsRegistry().get('Recover')
  const s = state({ power: 35, heal_items: 2 }, { enemy_power: 20 })
  s.health = 3; s.hunger = 10; s.inventory = { golden_apple: 1, cod: 1 }
  const apple = applyEffect(s, recover.expectedEffects(s))
  assert.equal(apple.health, 7)
  assert.equal(apple.hunger, 14)
  const fish = applyEffect(apple, recover.expectedEffects(apple))
  assert.equal(fish.health, 7, 'яблоко уже израсходовано; cod не даёт регенерацию')
  assert.equal(fish.hunger, 16)
  assert.equal(fish.resources.heal_items, 0)
})

test('Recover: один настоящий HP — результат; новое наблюдение врага без лечения — провал без таймерного повтора', () => {
  const { StrategicDirector } = require('../src/core/strategy')
  const { cloneWorld } = require('../src/core/world-state')
  const registry = armsRegistry()
  const recover = registry.get('Recover')
  const before = state({ power: 30 }, { enemy_power: 18, enemy_known: true })
  before.health = 3
  const healed = cloneWorld(before); healed.health = 4
  assert.equal(recover.successCondition(before, healed), true)
  const after = cloneWorld(before); after.facts.enemy_near = fact(false, 'observed', 1)
  let now = 0
  const director = new StrategicDirector(registry, { now: () => now }, { goal: opponentDefeated, maxFailures: 1, retryAfterMs: 30000, riskPenalty: ARMS_RISK_PENALTY })
  assert.equal(director.verify(recover, before, after, { outcome: 'PARTIAL', events: [] }), 'FAILURE')
  now = 31000
  director.decide(after)
  assert.equal(director.canRun(recover, after), false, 'прошедшее время не создаёт новый источник лечения')
  const fed = cloneWorld(after); fed.inventory.bread = 1; fed.resources.heal_items = 1
  director.decide(fed)
  assert.equal(director.canRun(recover, fed), true, 'найденная еда даёт основание попробовать снова')
})

test('лаборатория: книга + ≥6 бутылок или лазурит + ≥20; цель — меч/броня не хуже камня', () => {
  const { labReady } = require('../src/pvp/arms-graph')
  assert.equal(labReady([{ name: 'lapis_lazuli', count: 3 }, { name: 'experience_bottle', count: 20 }, { name: 'iron_sword' }]), true)
  assert.equal(labReady([{ name: 'lapis_lazuli', count: 3 }, { name: 'experience_bottle', count: 16 }, { name: 'iron_sword' }]), false, '16 бутылок = 7 ур. — столу мало')
  assert.equal(labReady([{ name: 'enchanted_book' }, { name: 'experience_bottle', count: 8 }, { name: 'iron_sword' }]), true, 'книга на наковальне дешевле')
  assert.equal(labReady([{ name: 'lapis_lazuli', count: 3 }, { name: 'experience_bottle', count: 30 }, { name: 'wooden_sword' }]), false)
  assert.deepEqual(first(state({ power: 6, lab_gain: 2 }, { enemy_power: 6, enemy_known: true })), ['EnchantAtLab', 'Engage'])
})

test('сторож боя (S7d): выстрел (отпустил «использовать») и урон по другому — прогресс; без них и под ударами — бросить', async () => {
  const { watchFight } = require('../src/combat')
  const gameClock = require('../src/game-clock')
  const { EventEmitter } = require('node:events')
  const mk = () => { const b: any = new EventEmitter(); b.health = 20; b.entity = { position: { distanceTo: () => 5 } }; b.attack = () => {}; b.deactivateItem = () => {}; return b }
  const a = mk(); const wa = watchFight(a, { aborted: false, onAbort: [] })
  const b = mk(); const wb = watchFight(b, { aborted: false, onAbort: [] })
  b.deactivateItem() // выстрел из лука
  a.health = 14; b.health = 14
  await new Promise(r => gameClock.setTimeout(r, 4300))
  assert.equal(wa.ctl.aborted, true, 'ни удара, ни выстрела, −6 хп — бросил')
  assert.equal(wb.ctl.aborted, false, 'стрелял — бой идёт')
  wa.close(); wb.close()
})
