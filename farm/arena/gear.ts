'use strict'
// Снаряжение: что видно глазами (оружие в руке, броня, блеск чар) — оценки «кто сильнее» и ценность вещей; наборы
// дезматча и их выдача.
import { rcon } from './server'

// Снаряжение: оружие, еда, слоты брони; ступень материала — кому отдавать худшее.
export const WEAPON = /(_sword|_axe|_spear|^mace|^trident|^bow|^crossbow)$/
export const FOOD = /^(golden_apple|enchanted_golden_apple|bread|cooked_\w+|baked_potato|apple|carrot|golden_carrot|pumpkin_pie)$/
export const ARMOR_SLOT: Record<string, RegExp> = { head: /_helmet$/, torso: /_chestplate$/, legs: /_leggings$/, feet: /_boots$/ }
export const ALCHEMY = /^(nether_wart|glistering_melon_slice|glowstone_dust|gunpowder|blaze_powder|glass_bottle|fermented_spider_eye|spider_eye|redstone)$/
// Ценность вещи в гонке (подарок игрока, 10.10: «кидаю предметы — пусть думают, брать ли; ценное — союз»).
export const worthOf = (n: string) => {
  const t = /^(netherite|diamond)_/.test(n) ? 5 : /^iron_/.test(n) ? 3 : /^(chainmail|golden|copper)_/.test(n) ? 2 : /^(stone|wooden|leather)_/.test(n) ? 1 : 0
  if (/_(helmet|chestplate|leggings|boots|sword|axe|spear)$/.test(n)) return t
  if (/^(enchanted_golden_apple|totem_of_undying|mace|trident)$/.test(n)) return 8
  if (/^(golden_apple|diamond|netherite_ingot)$/.test(n)) return 4
  if (/^(bow|crossbow|shield|splash_potion|potion|lingering_potion|iron_ingot)$/.test(n)) return 3
  if (/^(ender_pearl|arrow|wind_charge|firework_rocket|golden_carrot|cooked_\w+|bread|baked_potato|milk_bucket|honey_bottle)$/.test(n)) return 1
  return 0.2
}
// Снаряжён ли боец: оружие и не больше одной пустой части брони (видно глазами — что в руке и на теле).
export const geared = (m: any) => !!m && Object.keys(m.inv || {}).some(n => WEAPON.test(n)) && Object.keys(ARMOR_SLOT).filter(sl => !(m.armor || {})[sl]).length < 2
// Сила бойца — по тому, что видно (пользователь 10.10: «не хардкодь блоки — адаптивно»): хп × оружие × броня (ступень
// материала). Только для сравнения «кто сильнее здесь», не модель урона. Спринт игрока — 5.6 бл./с (физика 1.21).
export const SPRINT = 5.6
export const power = (hp: number, inv: any, armor: any) => {
  const w = Object.keys(inv || {}).filter(n => WEAPON.test(n)).reduce((a, n) => Math.max(a, tierOf(n) + 2), 0)
  const a = Object.values(armor || {}).reduce((s: number, n: any) => s + (n ? tierOf(String(n)) + 2 : 0), 0) as number
  return Math.max(1, hp) * (1 + w / 4) * (1 + a / 18)
}
// Кто кого (10.10: «руками бьют меня в жёсткой броне — бесполезно, даже толпой; надо за лутом, потом драться»): урон
// по броне по формуле 1.21 (очки брони, твёрдость, защита EPF), темп удара оружия; бой «мы против него» — он валит
// нас по одному (слабейшего первым), наш общий урон падает с каждым. Видно глазами: оружие в руке, броня, блеск чар.
export const WDMG = (n?: string) => !n ? 1 : /netherite_sword/.test(n) ? 8 : /diamond_sword/.test(n) ? 7 : /iron_sword/.test(n) ? 6 : /stone_sword/.test(n) ? 5 : /_sword/.test(n) ? 4
  : /^(netherite|diamond|iron|stone)_axe/.test(n) ? 9 : /_axe/.test(n) ? 7 : /^mace$/.test(n) ? 6 : /trident/.test(n) ? 9 : /_spear/.test(n) ? 5 : 1
export const WSPD = (n?: string) => !n ? 4 : /_axe/.test(n) ? 0.9 : /^mace$/.test(n) ? 0.6 : /trident|_spear/.test(n) ? 1.1 : /_sword/.test(n) ? 1.6 : 4
const APTS: Record<string, number[]> = { leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], copper: [2, 4, 3, 1], iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3], turtle: [2, 0, 0, 0] }
export const armorStat = (armor: any, epf = 0) => {
  let pts = 0; let tough = 0
  for (const [k, sl] of [[0, 'head'], [1, 'torso'], [2, 'legs'], [3, 'feet']] as [number, string][]) {
    const n = String((armor || {})[sl] || ''); const mat = n.split('_')[0]
    if (APTS[mat]) { pts += APTS[mat][k]; tough += mat === 'netherite' ? 3 : mat === 'diamond' ? 2 : 0 }
  }
  return { pts, tough, epf }
}
export const hitDmg = (d: number, A: any) => d * (1 - Math.min(20, Math.max(A.pts / 5, A.pts - 4 * d / (A.tough + 8))) / 25) * (1 - Math.min(20, A.epf) / 25)
export const bestWeapon = (inv: any) => Object.keys(inv || {}).filter(n => WEAPON.test(n) && !/bow|crossbow/.test(n)).sort((a, b) => WDMG(b) * WSPD(b) - WDMG(a) * WSPD(a))[0]
export const dpsOn = (att: any, def: any) => hitDmg(WDMG(att.weapon) + att.bonus, def.A) * (att.mob ? 1 : WSPD(att.weapon))
// edge — наш запас на удачу (криты, первый удар, его промахи): бежать, только когда проигрываешь и с ним, иначе равные
// бегут друг от друга (гонка 10.10: 31u бежал от 31t, а 31t — от 31u).
export const winsAgainst = (us: any[], foe: any, edge = 1.5) => {
  let H = foe.hp; let D = us.reduce((s, f) => s + dpsOn(f, foe), 0) * edge
  for (const o of us.map(f => ({ f, t: f.hp / Math.max(0.05, dpsOn(foe, f)) })).sort((a, b) => a.t - b.t)) {
    if (D * o.t >= H) return true
    H -= D * o.t; D -= dpsOn(o.f, foe) * edge
  }
  return false
}
// Мобы (те же правила «кто кого»): хп, базовый урон (атрибут attack_damage 1.21 + оружие в руке), скорость погони бл/с.
export const MOB_HP: Record<string, number> = { piglin_brute: 50, vindicator: 24, ravager: 100, iron_golem: 100, bogged: 16 }
export const MOB_HIT: Record<string, number> = { zombie: 3, husk: 3, drowned: 3, zombie_villager: 3, wither_skeleton: 4, vindicator: 5, piglin_brute: 7, piglin: 5, skeleton: 2, stray: 2, bogged: 2, spider: 2, cave_spider: 2, ravager: 12, enderman: 7 }
export const MOB_SPD: Record<string, number> = { zombie: 2.3, husk: 2.3, drowned: 2.3, wither_skeleton: 2.75, skeleton: 2.5, stray: 2.5, bogged: 2.5, vindicator: 3.5, piglin_brute: 3.5, spider: 4, cave_spider: 4, enderman: 6 }
export const tierOf =(n: string) => ['wooden', 'golden', 'stone', 'copper', 'chainmail', 'iron', 'diamond', 'netherite'].findIndex(t => n.startsWith(t)) + (/^(mace|trident)$/.test(n) ? 6 : 0)

const ARMOR = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
export const ANTIDOTES = ['milk_bucket 1', 'honey_bottle 2']
export const KITS = {
  elytra: ['elytra', 'firework_rocket 48', 'iron_spear', 'diamond_sword', 'golden_apple 4', 'water_bucket', 'cobblestone 32', 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}] 2', ...ANTIDOTES],
  sword: ['diamond_sword', 'diamond_axe', 'shield', 'golden_apple 4', 'cobblestone 32', ...ANTIDOTES],
  // Кристаллы — как набор арены «кристаллы» (arena.ts): тотем в левой руке, обсидиан под кристаллы, «Взрывоустойчивость» на поножах.
  arms: [],
  // Командный: зелья лечения — бросать союзникам, булыжник — стенки прикрытия.
  team: ['diamond_sword', 'diamond_axe', 'golden_apple 2', 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}] 6', 'cobblestone 64', ...ANTIDOTES],
  // Командный в воздухе: элитры и копьё + зелья своим (бросок и с полёта) и блоки.
  teamair: ['elytra', 'firework_rocket 48', 'iron_spear', 'diamond_sword', 'golden_apple 2', 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}] 4', 'water_bucket', 'cobblestone 32', ...ANTIDOTES],
  teamcrystal: ['diamond_sword[enchantments={sharpness:5}]', 'end_crystal 64', 'obsidian 64', 'bow[enchantments={power:1}]', 'golden_apple 8', 'totem_of_undying 3', 'arrow 64', 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}] 4', 'cobblestone 32'],
  crystal: ['diamond_sword[enchantments={sharpness:5}]', 'end_crystal 64', 'obsidian 64', 'bow[enchantments={power:1}]', 'golden_apple 12', 'totem_of_undying 4', 'arrow 64', 'enchanted_golden_apple 1']
}
const ARMOR_OF = {
  teamcrystal: ['diamond_helmet[enchantments={protection:4,unbreaking:3}]', 'diamond_chestplate[enchantments={protection:4,unbreaking:3}]', 'diamond_leggings[enchantments={blast_protection:4,unbreaking:3}]', 'diamond_boots[enchantments={protection:4,unbreaking:3}]'],
  crystal: ['diamond_helmet[enchantments={protection:4,unbreaking:3}]', 'diamond_chestplate[enchantments={protection:4,unbreaking:3}]', 'diamond_leggings[enchantments={blast_protection:4,unbreaking:3}]', 'diamond_boots[enchantments={protection:4,unbreaking:3}]']
}
const OFFHAND = { crystal: 'totem_of_undying', teamcrystal: 'totem_of_undying' }
// Бой взрывами: цель — куча врагов, свои — врозь.
export const BLAST = /crystal/
export async function dress (i, who, kit) {
  await rcon(i, `clear ${who}`)
  await rcon(i, `effect clear ${who}`)
  for (const [a, slot] of (ARMOR_OF[kit] || ARMOR).map((a, k) => [a, ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet'][k]])) await rcon(i, `item replace entity ${who} ${slot} with minecraft:${a}`)
  if (OFFHAND[kit]) await rcon(i, `item replace entity ${who} weapon.offhand with minecraft:${OFFHAND[kit]}`)
  for (const it of KITS[kit]) { const [n, c] = it.split(/ (?=\d+$)/); await rcon(i, `give ${who} minecraft:${n} ${c || 1}`) }
  await rcon(i, `effect give ${who} minecraft:instant_health 1 10 true`)
  await rcon(i, `effect give ${who} minecraft:saturation 1 20 true`)
}
