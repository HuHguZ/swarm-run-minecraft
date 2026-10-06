// «Гонка вооружений» (TODO «PvP Гонка вооружений» п.5–6, s7 2026-10-06): граф стратегий для цели
// opponent_defeated поверх общего планировщика (core/strategy.ts). Бой ведёт pvp.duel (навык fight);
// здесь — что делать до него: разведать место, взять известный сундук, вскрыть тайник, уйти или атаковать.
// Знание — только своё: сундук попадает в WorldState, когда его увидели глазами (arms-run, blocks_around seen).
import { StrategyRegistry, type Strategy } from '../core/strategy'
import { amount, knows, type WorldState } from '../core/world-state'
const { gearOf, WEAPON } = require('../assess')

// ---------------------------------------------------------------- сила снаряжения
// Грубая шкала «насколько опасен в бою»: ближнее оружие ≈ урон за секунду (меч ×1.6 удара/с,
// топор ×0.9 — по скорости атаки 1.21.11), броня — очки брони + прочность, плюс щит, стрельба,
// лечение, тотем. Единица — порядка «один удар железного меча».
const SPEAR = { wooden_spear: 4, stone_spear: 5, copper_spear: 5, golden_spear: 4, iron_spear: 6, diamond_spear: 7, netherite_spear: 8 } as Record<string, number>
export interface Item { name: string; count?: number; enchants?: number }
export function weaponScore(name: string, enchanted = false): number {
  const bonus = enchanted ? 1.5 : 0
  if (/_sword$/.test(name)) return (WEAPON[name] ?? 4) * 1.6 + bonus
  if (/_axe$/.test(name)) return (WEAPON[name] ?? 7) * 0.9 + bonus
  if (name === 'mace') return 9 + bonus
  if (name === 'trident') return 9 * 1.1 + bonus
  if (SPEAR[name]) return SPEAR[name] * 1.4 + bonus
  return 0
}
export interface Power { total: number; weapon: number; armor: number }
export function powerOf(items: Item[]): Power {
  const names = items.map(i => i.name)
  const count = (re: RegExp) => items.filter(i => re.test(i.name)).reduce((n, i) => n + (i.count ?? 1), 0)
  const weapon = Math.max(1, ...items.map(i => weaponScore(i.name, !!i.enchants)))
  // Лучшее на каждый слот (в рюкзаке может быть два шлема).
  const best: Record<string, Item> = {}
  for (const it of items) {
    const slot = /_(helmet|chestplate|leggings|boots)$/.exec(it.name)?.[1]
    if (!slot) continue
    const g = gearOf([it])
    if (!best[slot] || g.armor + g.tough > gearOf([best[slot]]).armor + gearOf([best[slot]]).tough) best[slot] = it
  }
  const g = gearOf(Object.values(best))
  const armor = g.armor + g.tough + Object.values(best).filter(i => i.enchants).length
  const ranged = names.some(n => /^(bow|crossbow)$/.test(n)) && count(/^(arrow|spectral_arrow|tipped_arrow)$/) + count(/^firework_rocket$/) > 0 ? 4 : 0
  const extra = (names.includes('shield') ? 3 : 0) + ranged + Math.min(3, count(/^golden_apple$/)) * 2 + count(/^enchanted_golden_apple$/) * 5 +
    Math.min(3, count(/^(splash_potion|potion)$/)) * 1.5 + Math.min(1, count(/^totem_of_undying$/)) * 8 + Math.min(2, count(/^ender_pearl$/)) * 0.5
  return { total: Math.round((weapon + armor * 0.8 + extra) * 10) / 10, weapon, armor }
}
// Видимое у врага: руки и броня (пакеты equipment). Рюкзак не видно — то же, что у меня в рюкзаке.
export function visiblePower(gear: string[]): number {
  return powerOf(gear.map(name => ({ name }))).total
}

// ---------------------------------------------------------------- крафт
// Лучшее улучшение из рюкзака: меч/броня из слитков и алмазов, каменный меч из булыжника; палки — из досок/брёвен.
const RECIPES: Array<[string, Record<string, number>]> = [
  ['diamond_sword', { diamond: 2 }], ['iron_sword', { iron_ingot: 2 }], ['stone_sword', { cobblestone: 2 }],
  ['diamond_chestplate', { diamond: 8 }], ['diamond_leggings', { diamond: 7 }], ['diamond_helmet', { diamond: 5 }], ['diamond_boots', { diamond: 4 }],
  ['iron_chestplate', { iron_ingot: 8 }], ['iron_leggings', { iron_ingot: 7 }], ['iron_helmet', { iron_ingot: 5 }], ['iron_boots', { iron_ingot: 4 }]
]
// Лаборатория окупится, если есть что улучшать (меч/топор/броня не хуже каменного) и: книга чар + ≥6 бутылок опыта
// (наковальня, 1–5 ур.) или лазурит + ≥20 бутылок (стол с 15 полками: верхняя строка 2–10 ур.; натив s7 06.10:
// 16 бутылок = 7 ур., строка 8 ур. — не хватило).
export function labReady(items: Item[]): boolean {
  const have = (n: string) => items.filter(i => i.name === n).reduce((k, i) => k + (i.count ?? 1), 0)
  const target = items.some(i => !i.enchants && /^(stone|copper|iron|golden|diamond|netherite)_(sword|axe)$|^(chainmail|copper|iron|golden|diamond|netherite)_(helmet|chestplate|leggings|boots)$/.test(i.name))
  return target && ((have('enchanted_book') >= 1 && have('experience_bottle') >= 6) || (have('lapis_lazuli') >= 1 && have('experience_bottle') >= 20))
}
export function bestCraft(items: Item[]): { item: string; gain: number } | null {
  const have = (n: string) => items.filter(i => i.name === n).reduce((k, i) => k + (i.count ?? 1), 0)
  const stick = have('stick') >= 1 || items.some(i => /_planks$|_log$/.test(i.name))
  const base = powerOf(items).total
  let best: { item: string; gain: number } | null = null
  for (const [item, need] of RECIPES) {
    if (/_sword$/.test(item) && !stick) continue
    if (!Object.entries(need).every(([n, k]) => have(n) >= k)) continue
    const gain = powerOf([...items, { name: item }]).total - base
    if (gain >= 1 && (!best || gain > best.gain)) best = { item, gain: Math.round(gain * 10) / 10 }
  }
  return best
}

// ---------------------------------------------------------------- граф
// P(проиграть сшибку) по разнице сил: логистика с масштабом 4 (одна броня-тир ≈ 4 очка).
export const loseChance = (mine: number, his: number): number => Math.min(0.98, Math.max(0.02, 1 / (1 + Math.exp((mine - his) / 4))))
export interface ArmsOptions { chestValue?: number; fightSeconds?: number }
export function armsRegistry(options: ArmsOptions = {}): StrategyRegistry {
  const chestValue = options.chestValue ?? 4
  const fightSeconds = options.fightSeconds ?? 40
  const registry = new StrategyRegistry()
  const free = (s: WorldState) => !knows(s, 'enemy_near') && !knows(s, 'deadline')
  const enemy = (s: WorldState) => Number(s.facts.enemy_power?.value ?? amount(s, 'power'))
  const add = (id: string, skill: string, pre: Strategy['preconditions'], eff: Strategy['expectedEffects'], seconds: (s: WorldState) => number,
    risk: (s: WorldState) => number, success: Strategy['successCondition'], extra: Partial<Strategy> = {}) => registry.register({
    id, skill, version: 1, preconditions: pre, expectedEffects: eff, estimateCost: s => seconds(s) * 20, estimateRisk: risk,
    timeoutMs: 90000, successCondition: success, command: () => ({ skill, strategy: id }), ...extra
  })
  add('ScoutArea', 'arms.scout', s => free(s) && amount(s, 'unscouted') > 0 && !amount(s, 'chests') && !amount(s, 'caches'),
    { resources: { unscouted: -1, chests: 1 } }, () => 15, () => 0.01,
    (b, a) => amount(a, 'unscouted') < amount(b, 'unscouted') || amount(a, 'chests') > amount(b, 'chests'))
  add('LootChest', 'arms.loot', s => free(s) && amount(s, 'chests') > 0,
    { resources: { chests: -1, power: chestValue } }, () => 10, () => 0.01,
    (b, a) => amount(a, 'chests') < amount(b, 'chests') || amount(a, 'power') > amount(b, 'power'))
  add('OpenCache', 'arms.cache', s => free(s) && amount(s, 'caches') > 0,
    { resources: { caches: -1, chests: 1 } }, () => 12, () => 0.02,
    (b, a) => amount(a, 'caches') < amount(b, 'caches') || amount(a, 'chests') > amount(b, 'chests'))
  add('CraftUpgrade', 'arms.craft', s => free(s) && amount(s, 'craft_gain') > 0,
    s => ({ resources: { craft_gain: -amount(s, 'craft_gain'), power: amount(s, 'craft_gain') } }), () => 8, () => 0.01,
    (b, a) => amount(a, 'power') > amount(b, 'power') || amount(a, 'craft_gain') < amount(b, 'craft_gain'))
  // Лаборатория (TODO гонки п.8): бутылки опыта под ноги и стол зачарований с 15 полками — чары на лучшее
  // незачарованное оружие/броню (enchant.chooseTargets). Раз за раунд.
  add('EnchantAtLab', 'arms.lab', s => free(s) && amount(s, 'lab_gain') > 0,
    s => ({ resources: { lab_gain: -amount(s, 'lab_gain'), power: amount(s, 'lab_gain') } }), () => 20, () => 0.02,
    (b, a) => amount(a, 'power') > amount(b, 'power'), { progressCondition: (b, a) => amount(a, 'lab_gain') < amount(b, 'lab_gain') })
  // Уйти от сильного или равного, пока есть что брать: лут дешевле сшибки наугад (равные с пустыми руками — не драться).
  add('Retreat', 'arms.retreat', s => knows(s, 'enemy_near') && !knows(s, 'enemy_contact') && !knows(s, 'deadline') &&
    amount(s, 'chests') + amount(s, 'caches') + amount(s, 'unscouted') > 0 && enemy(s) >= amount(s, 'power') - 1,
    { facts: { enemy_near: false } }, () => 10, () => 0.05, (_b, a) => !knows(a, 'enemy_near'))
  // Засада (TODO п.9): срок лута вышел, врага не видно, я не слабее — ждать у середины поля со своей стороны
  // (через неё идёт его обход), а не искать вслепую; первый удар — мой (+3 к силе в оценке сшибки). Один раз.
  add('Ambush', 'arms.ambush', s => knows(s, 'deadline') && !knows(s, 'enemy_known') && !knows(s, 'enemy_near') &&
    !knows(s, 'ambushed') && amount(s, 'power') >= enemy(s), { facts: { enemy_known: true, ambushed: true } }, () => 25, () => 0.02,
    (_b, a) => knows(a, 'enemy_known'), { progressCondition: (_b, a) => knows(a, 'ambushed') })
  // Атака: найти (последнее наблюдение) и драться до конца — pvp.duel.
  const first = (s: WorldState) => knows(s, 'ambushed') && knows(s, 'enemy_known') ? 3 : 0
  add('Engage', 'arms.engage', () => true, { facts: { opponent_defeated: true } },
    s => fightSeconds + (knows(s, 'enemy_near') ? 0 : knows(s, 'enemy_known') ? 10 : 30),
    s => loseChance(amount(s, 'power') + first(s), enemy(s)), (_b, a) => knows(a, 'opponent_defeated'),
    // Обход и неоконченная сшибка — тоже ход к цели: после срока лута другого пути нет, и «исчерпать» атаку нельзя.
    { progressCondition: () => true, timeoutMs: 180000 })
  return registry
}
export const opponentDefeated = (s: WorldState): boolean => knows(s, 'opponent_defeated')
// Штраф за риск в тиках: проигранная сшибка = проигранный раунд ≈ 5 игровых минут лута.
export const ARMS_RISK_PENALTY = 6000
