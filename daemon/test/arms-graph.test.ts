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

test('крафт: из слитков и палки — железный меч; без палки и досок — нет; граф берёт крафт, когда он есть', () => {
  const { bestCraft } = require('../src/pvp/arms-graph')
  assert.equal(bestCraft([{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }])?.item, 'iron_sword')
  assert.equal(bestCraft([{ name: 'iron_ingot', count: 3 }]), null)
  assert.equal(bestCraft([{ name: 'diamond_sword' }, { name: 'iron_ingot', count: 2 }, { name: 'oak_planks', count: 4 }]), null, 'меч хуже имеющегося — не нужен')
  assert.equal(bestCraft([{ name: 'iron_sword' }, { name: 'iron_ingot', count: 8 }, { name: 'stick' }])?.item, 'iron_chestplate', 'меч уже есть — нагрудник')
  assert.equal(first(state({ power: 3, unscouted: 4, craft_gain: 5 }, { enemy_power: 3 }))[0], 'CraftUpgrade')
})

test('засада: после срока лута, врага не видно и я не слабее — сперва засада, затем атака; после засады — сразу атака', () => {
  assert.deepEqual(first(state({ power: 10 }, { deadline: true, enemy_power: 10 })), ['Ambush', 'Engage'])
  assert.deepEqual(first(state({ power: 10 }, { deadline: true, enemy_power: 10, ambushed: true })), ['Engage'], 'одна засада за раунд')
  assert.deepEqual(first(state({ power: 4 }, { deadline: true, enemy_power: 10 })), ['Engage'], 'слабее — засада не по мне')
})

test('лаборатория: книга + ≥6 бутылок или лазурит + ≥20; цель — меч/броня не хуже камня', () => {
  const { labReady } = require('../src/pvp/arms-graph')
  assert.equal(labReady([{ name: 'lapis_lazuli', count: 3 }, { name: 'experience_bottle', count: 20 }, { name: 'iron_sword' }]), true)
  assert.equal(labReady([{ name: 'lapis_lazuli', count: 3 }, { name: 'experience_bottle', count: 16 }, { name: 'iron_sword' }]), false, '16 бутылок = 7 ур. — столу мало')
  assert.equal(labReady([{ name: 'enchanted_book' }, { name: 'experience_bottle', count: 8 }, { name: 'iron_sword' }]), true, 'книга на наковальне дешевле')
  assert.equal(labReady([{ name: 'lapis_lazuli', count: 3 }, { name: 'experience_bottle', count: 30 }, { name: 'wooden_sword' }]), false)
  assert.deepEqual(first(state({ power: 6, lab_gain: 2 }, { enemy_power: 6, enemy_known: true })), ['EnchantAtLab', 'Engage'])
})
