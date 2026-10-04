'use strict'
// Разбор противника перед боем и между целями. Не «ближайший — бей», а то,
// что делает игрок, глядя на толпу: кто из них в броне и с чем в руке, кого
// я убью быстро, кто бьёт больнее всего, и в каком порядке их снимать, чтобы
// самому получить меньше всего. И честный итог: драться, драться осторожно
// или уходить.
//
// Числа — Java, сложность normal (minecraft.wiki по каждому мобу, «Armor»,
// «Damage»). Урон моба с оружием = его базовый + (урон оружия − 1): оружие
// даёт модификатор атрибута attack_damage поверх базы моба.

const { raySees } = require('./perception')

const MOBS = {
  // hp, dmg — удар в ближнем бою (или выстрел), every — секунд между атаками,
  // ranged — стреляет, armor — природная броня.
  zombie: { hp: 20, dmg: 3, every: 1, armor: 2 },
  husk: { hp: 20, dmg: 3, every: 1, armor: 2 },
  zombie_villager: { hp: 20, dmg: 3, every: 1, armor: 2 },
  drowned: { hp: 20, dmg: 3, every: 1, armor: 2 },
  zombified_piglin: { hp: 20, dmg: 5, every: 1, armor: 2 },
  skeleton: { hp: 20, dmg: 3.5, every: 2, ranged: true },
  // 1.21.11: пустынный скелет. Байткод Parched: MAX_HEALTH 16, getAttackInterval 70 / getHardAttackInterval 50 тиков; стрелы слабости
  parched: { hp: 16, dmg: 3.5, every: 3.5, ranged: true },
  stray: { hp: 20, dmg: 3.5, every: 2, ranged: true },
  bogged: { hp: 16, dmg: 3.5, every: 3.5, ranged: true },
  wither_skeleton: { hp: 20, dmg: 8, every: 1 },
  creeper: { hp: 20, dmg: 22, every: 99, blast: true },
  spider: { hp: 16, dmg: 2, every: 1 },
  cave_spider: { hp: 12, dmg: 3, every: 1 },
  witch: { hp: 26, dmg: 6, every: 3, ranged: true },
  enderman: { hp: 40, dmg: 7, every: 1 },
  vindicator: { hp: 24, dmg: 13, every: 1 },
  pillager: { hp: 24, dmg: 4, every: 2, ranged: true },
  evoker: { hp: 24, dmg: 6, every: 2, ranged: true },
  vex: { hp: 14, dmg: 9, every: 1 },
  ravager: { hp: 100, dmg: 12, every: 2 },
  piglin: { hp: 16, dmg: 5, every: 1 },
  piglin_brute: { hp: 50, dmg: 13, every: 1 },
  hoglin: { hp: 40, dmg: 6, every: 1, armor: 0 },
  zoglin: { hp: 40, dmg: 6, every: 1 },
  blaze: { hp: 20, dmg: 5, every: 3, ranged: true, armor: 0 },
  ghast: { hp: 10, dmg: 6, every: 3, ranged: true },
  slime: { hp: 16, dmg: 4, every: 1 },
  magma_cube: { hp: 16, dmg: 6, every: 1, armor: 12 },
  silverfish: { hp: 8, dmg: 1, every: 1 },
  endermite: { hp: 8, dmg: 2, every: 1 },
  phantom: { hp: 20, dmg: 2, every: 3 },
  breeze: { hp: 30, dmg: 3, every: 2, ranged: true },
  guardian: { hp: 30, dmg: 6, every: 3, ranged: true },
  elder_guardian: { hp: 80, dmg: 8, every: 3, ranged: true },
  warden: { hp: 500, dmg: 30, every: 1.5 },
  creaking: { hp: 1, dmg: 3, every: 1 }
}

// Урон оружия в руке (как у игрока) и очки брони по предмету.
const WEAPON = {
  wooden_sword: 4, golden_sword: 4, stone_sword: 5, copper_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8,
  wooden_axe: 7, golden_axe: 7, stone_axe: 9, copper_axe: 9, iron_axe: 9, diamond_axe: 9, netherite_axe: 10,
  trident: 9, mace: 6
}
const ARMOR = {
  leather_helmet: 1, leather_chestplate: 3, leather_leggings: 2, leather_boots: 1,
  golden_helmet: 2, golden_chestplate: 5, golden_leggings: 3, golden_boots: 1,
  chainmail_helmet: 2, chainmail_chestplate: 5, chainmail_leggings: 4, chainmail_boots: 1,
  copper_helmet: 2, copper_chestplate: 4, copper_leggings: 3, copper_boots: 1,
  iron_helmet: 2, iron_chestplate: 6, iron_leggings: 5, iron_boots: 2,
  diamond_helmet: 3, diamond_chestplate: 8, diamond_leggings: 6, diamond_boots: 3,
  netherite_helmet: 3, netherite_chestplate: 8, netherite_leggings: 6, netherite_boots: 3,
  turtle_helmet: 2
}
const TOUGH = { diamond: 2, netherite: 3 }

function gearOf (items) {
  let armor = 0; let tough = 0; const worn = []
  for (const it of items) {
    if (!it || !ARMOR[it.name]) continue
    armor += ARMOR[it.name]
    const m = it.name.match(/^(\w+?)_/)
    tough += (m && TOUGH[m[1]]) || 0
    worn.push(it.name)
  }
  return { armor, tough, worn }
}

// Урон после брони (minecraft.wiki «Armor»).
function afterArmor (dmg, armor, tough) {
  const eff = Math.min(20, Math.max(armor / 5, armor - (4 * dmg) / (tough + 8)))
  return dmg * (1 - eff / 25)
}

// Чем мы можем бить: оружие из рюкзака или кулак. dps с учётом того, что
// ~60% ударов бот наносит критом (прогоны арены: 4-7 критов на 8-10 ударов).
function ourWeapons (bot) {
  const out = [{ item: null, name: 'кулак', dmg: 1, every: 0.5 }]
  for (const it of bot.inventory.items()) {
    if (!WEAPON[it.name] || /trident|mace/.test(it.name)) continue
    const every = /_sword$/.test(it.name) ? 0.625 : /^(wooden|stone)_axe$/.test(it.name) ? 1.25 : it.name === 'iron_axe' ? 1.11 : 1.0
    out.push({ item: it, name: it.name, dmg: WEAPON[it.name], every })
  }
  return out
}

function strengthBonus (bot) {
  try {
    const s = bot.registry.effectsByName.strength
    const e = s && bot.entity.effects && bot.entity.effects[s.id]
    return e ? 3 * (e.amplifier + 1) : 0
  } catch { return 0 }
}

// Лучшее оружие против этой брони: у топора удар крупнее, и броня его режет
// меньше — против алмазного моба это может перевесить скорость меча.
function bestAgainst (bot, armor, tough) {
  const plus = strengthBonus(bot)
  let best = null
  for (const w of ourWeapons(bot)) {
    const hit = afterArmor((w.dmg + plus) * 1.3, armor, tough)
    const dps = hit / w.every
    if (!best || dps > best.dps) best = { ...w, hit, dps }
  }
  return best
}

function ourGear (bot) {
  const slots = [5, 6, 7, 8].map(i => bot.inventory.slots[i])
  return gearOf(slots)
}

// Эффективное здоровье: хп + поглощение + то, чем можно вылечиться.
function effectiveHp (bot) {
  let hp = bot.health ?? 20
  try {
    const abs = bot.entity.metadata && bot.entity.metadata[15]
    if (typeof abs === 'number' && abs > 0 && abs < 40) hp += abs
  } catch {}
  let heal = 0
  for (const it of bot.inventory.items()) {
    if (it.name === 'enchanted_golden_apple') heal += 20 * it.count
    else if (it.name === 'golden_apple') heal += 8 * it.count
    else if (/potion$/.test(it.name) && /heal/.test(JSON.stringify(it.componentMap ? [...it.componentMap.values()] : ''))) heal += 6 * it.count
    else if (it.name === 'totem_of_undying') heal += 12
  }
  return { hp: Math.round(hp), heal: Math.min(40, heal), total: Math.round(hp + Math.min(40, heal)) }
}

// Видно ли его глазами. Стекло прозрачно для глаз (человек сквозь стену
// арены видит мобов), хотя стрелы и шаги оно держит — поэтому свой луч, а не
// perception.raySees, который про укрытие от стрел.
const SEE_THROUGH = /glass|pane|^ice$|barrier|leaves|iron_bars|chain|fence$/
function looks (bot, from, to) {
  try {
    const delta = to.minus(from)
    const dist = delta.norm()
    if (dist < 0.1) return true
    const hit = bot.world.raycast(from, delta.normalize(), Math.min(dist, 96),
      b => b && b.boundingBox !== 'empty' && !SEE_THROUGH.test(b.name))
    return !hit || hit.position.distanceTo(from) >= dist - 1.2
  } catch { return true }
}

function inSight (bot, e) {
  const me = bot.entity.position
  if (e.position.distanceTo(me) < 4) return true
  const eye = me.offset(0, 1.62, 0)
  const h = e.height || 1.8
  return looks(bot, eye, e.position.offset(0, h * 0.5, 0)) || looks(bot, eye, e.position.offset(0, h * 0.9, 0))
}

// Умирает: здоровье в метаданных 0 (анимация смерти длится около секунды).
function dying (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' && h <= 0
  } catch { return false }
}

function creeperSwelling (bot, e) {
  try {
    const keys = bot.registry.entitiesByName.creeper.metadataKeys
    const i = keys.indexOf('swell_dir')
    return e.metadata[i >= 0 ? i : 16] === 1
  } catch { return false }
}

// Разбор одного моба.
function sizeUp (bot, e, mine) {
  const base = MOBS[e.name]
  if (!base) return null
  const eq = e.equipment || []
  const hand = eq[0] ? eq[0].name : null
  const g = gearOf(eq.slice(2))
  const armor = (base.armor || 0) + g.armor
  let dmg = base.dmg
  let ranged = !!base.ranged
  let every = base.every
  // Скелет с мечом — уже не лучник: подходит и бьёт.
  if (hand && WEAPON[hand]) {
    dmg = base.dmg + (WEAPON[hand] - 1)
    if (/skeleton|stray|bogged|parched/.test(e.name)) { ranged = false; every = 1 }
  }
  const d = e.position.distanceTo(bot.entity.position)
  const weapon = bestAgainst(bot, armor, g.tough)
  const toKill = base.hp / Math.max(0.1, weapon.dps)
  // Подход: 4.3 бл/с шагом, минус дальность удара.
  const approach = Math.max(0, d - 3) / 4.3
  const theirHit = afterArmor(dmg, mine.armor, mine.tough)
  // Какая доля его атак реально доходит при нашей тактике. Ближник, который
  // достаёт короче нас (зомби ~1.4 против наших 2.9), почти не успевает
  // ударить: мы бьём с края и отходим в перезарядке — арена 2026-09-24: три
  // зомби, 0 урона. Быстрые (паук, векс) и длиннорукие достают чаще;
  // стрелок промахивается по стрейфящему боту примерно в половине случаев.
  const FAST = /spider|vex|phantom|enderman|ravager|hoglin|zoglin/
  const share = ranged ? 0.5 : FAST.test(e.name) ? 0.6 : 0.3
  let dps = base.blast ? 0 : (theirHit / every) * share
  // Когда он до нас дойдёт: ~3 бл/с шагом моба, стрелку идти не надо.
  const arrive = ranged ? 0 : Math.max(0, d - 2.5) / 3
  const swelling = e.name === 'creeper' && creeperSwelling(bot, e)
  // Крипер, который не шипит, опасен только если стоять рядом, а бот отходит
  // после каждого удара и убегает от шипения (арена: 2 крипера, 0 урона).
  if (base.blast) dps = swelling && d < 6 ? afterArmor(22 * Math.max(0, 1 - d / 7), mine.armor, mine.tough) / 1.5 : 0.3
  return {
    e,
    name: e.name,
    dist: Math.round(d * 10) / 10,
    hp: base.hp,
    hand: hand || undefined,
    armor,
    worn: g.worn.length ? g.worn : undefined,
    ranged,
    hit: Math.round(theirHit * 10) / 10,
    dps: Math.round(dps * 100) / 100,
    toKill: Math.round((toKill + approach) * 10) / 10,
    arrive: Math.round(arrive * 10) / 10,
    weapon: weapon.name,
    weaponItem: weapon.item,
    swelling
  }
}

// Порядок убийства, при котором суммарно получаешь меньше всего (правило
// Смита: по убыванию dps / время на убийство). Шипящий крипер рядом — вне
// очереди: он не про урон в секунду, а про «через секунду взорвётся».
function plan (bot, { radius = 20, entities = null, exclude = null } = {}) {
  if (!bot || !bot.entity) return null
  const mine = ourGear(bot)
  const me = bot.entity.position
  const foes = []
  const list = entities || Object.values(bot.entities)
  for (const e of list) {
    if (!e || e === bot.entity || !e.position || !MOBS[e.name]) continue
    if (e.isValid === false || (exclude && exclude.has(e.id)) || dying(bot, e)) continue
    // Только те, кого видно (или кто вплотную): эндермен в пещере под ареной
    // — не враг этого боя, а бот шёл «к нему» по полу на 35 блоков выше.
    if (!inSight(bot, e)) continue
    if (e.position.distanceTo(me) > radius) continue
    const s = sizeUp(bot, e, mine)
    if (s) foes.push(s)
  }
  if (!foes.length) return { foes: [], order: [], verdict: 'чисто', text: 'врагов рядом нет' }
  const order = foes.slice().sort((a, b) => {
    if (a.swelling !== b.swelling) return a.swelling ? -1 : 1
    return (b.dps / b.toKill) - (a.dps / a.toKill)
  })
  // Сколько получим, снимая их по порядку: каждый бьёт с того момента, как
  // дошёл, и до того, как умер.
  let t = 0
  let expected = 0
  for (const f of order) {
    t += f.toKill
    expected += f.dps * Math.max(0, t - (f.arrive || 0))
  }
  const eff = effectiveHp(bot)
  const ratio = expected / Math.max(1, eff.total)
  const verdict = ratio > 0.9 ? 'уходить' : ratio > 0.55 ? 'осторожно' : 'драться'
  const who = order.slice(0, 5).map(f => {
    const gear = [f.hand, f.worn ? `броня ${f.armor}` : null].filter(Boolean).join(', ')
    return `${f.name}${gear ? ` (${gear})` : ''} ~${f.toKill}с ${f.weapon}`
  })
  return {
    foes: order.length,
    order: order.map(f => ({ name: f.name, dist: f.dist, hand: f.hand, armor: f.armor, worn: f.worn, ranged: f.ranged || undefined, hit: f.hit, dps: f.dps, toKill: f.toKill, weapon: f.weapon, swelling: f.swelling || undefined })),
    first: order[0],
    expectedDamage: Math.round(expected),
    effectiveHp: eff,
    ourArmor: mine.armor,
    verdict,
    text: `${verdict}: ${order.length} врагов, ожидаю ~${Math.round(expected)} урона при запасе ${eff.total}. Порядок: ${who.join(' → ')}`
  }
}

// Чем бить именно этого: по его броне. null — если он не моб из таблицы.
function weaponFor (bot, e) {
  if (!e) return null
  const eq = e.equipment || []
  const g = gearOf(eq.slice(2))
  const base = MOBS[e.name]
  const armor = (base ? base.armor || 0 : 0) + g.armor
  return bestAgainst(bot, armor, g.tough)
}

module.exports = { plan, sizeUp, bestAgainst, weaponFor, afterArmor, gearOf, inSight, MOBS }
