'use strict'
// Живая арена (часть arena-live.ts): наборы раундов (что получают A и B, режим kits/craft/all) и куда класть
// броню и щит сразу на тело.

const ARMOR = {
  iron: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
  diamond: ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
}

// Наборы. Каждый — что получает A и что получает B. Зелья через компонент
// potion_contents (синтаксис /give 1.21).
// Режим арены: kits — готовые наборы (как было), craft — сырьё и крафт перед
// боем, all — всё подряд.
const MODE = process.env.ARENA_MODE || 'kits'
// Сырьё на полный комплект: алмазный меч, железная броня (24 слитка), щит,
// топор и кирка (6), лук (нитки), брёвна на доски, палки и верстак.
const RAW = ['oak_log 6', 'iron_ingot 31', 'diamond 2', 'string 3', 'arrow 16', 'cobblestone 64', 'golden_apple 2', 'cooked_beef 8']
const pot = (kind, name, n = 1) => `${kind}[potion_contents={potion:"minecraft:${name}"}] ${n}`
// Булава (PVP-RESEARCH г.3, без чар): меч и булава, заряды ветра, топор под
// щит, вода, яблоки, тотемы; против — меч, топор, щит, лук.
const MACE_KIT = ['diamond_sword', 'mace', 'wind_charge 32', 'diamond_axe', 'golden_apple 4', 'water_bucket', 'cobblestone 64', 'ender_pearl 4', 'totem_of_undying', 'totem_of_undying', pot('splash_potion', 'strong_healing', 2)]
const SHIELD_KIT = ['diamond_sword', 'diamond_axe', 'golden_apple 4', 'water_bucket', 'cobblestone 64', 'bow', 'arrow 32', 'totem_of_undying', 'totem_of_undying', pot('splash_potion', 'strong_healing', 2)]
// Дальний бой (2026-09-26): компоненты 1.21.5+ без обёртки levels.
const tipped = (name, n) => `tipped_arrow[potion_contents={potion:"minecraft:${name}"}] ${n}`
const ROCKET3 = 'firework_rocket[fireworks={flight_duration:1,explosions:[{shape:"small_ball"},{shape:"small_ball"},{shape:"small_ball"}]}]'
const XBOW_MULTI = 'crossbow[enchantments={quick_charge:3,multishot:1}]'
const XBOW_PIERCE = 'crossbow[enchantments={quick_charge:3,piercing:4}]'
const KITS = [
  { name: 'крафт: рывок против полного', craft: { a: 'rush', b: 'full' }, a: RAW, b: RAW },
  { name: 'крафт: умный против умного', craft: { a: 'smart', b: 'smart' }, a: RAW, b: RAW },
  { name: 'крафт: полный против рывка', craft: { a: 'full', b: 'rush' }, a: RAW, b: RAW },
  { name: 'кулаки', a: [], b: [] },
  { name: 'железо: меч+броня', a: ['iron_sword', ...ARMOR.iron], b: ['iron_sword', ...ARMOR.iron] },
  { name: 'топор против щита', a: ['diamond_axe', ...ARMOR.iron], b: ['diamond_sword', 'shield', ...ARMOR.iron] },
  { name: 'паутина и яблоки против лавы и огня', a: ['iron_sword', 'cobweb 8', 'golden_apple 3', ...ARMOR.iron], b: ['iron_sword', 'lava_bucket', 'flint_and_steel', 'water_bucket', ...ARMOR.iron] },
  { name: 'лук против щита', a: ['bow', 'arrow 32', 'iron_sword', 'cobblestone 32', ...ARMOR.iron], b: ['iron_sword', 'shield', 'cobblestone 32', ...ARMOR.iron] },
  { name: 'перестрелка: лук и щит', a: ['bow', 'arrow 64', 'shield', ...ARMOR.iron], b: ['bow', 'arrow 64', 'shield', ...ARMOR.iron] },
  { name: 'дуэль лучников', a: ['bow', 'arrow 64', 'iron_sword', 'cobblestone 32', 'golden_apple 2', ...ARMOR.iron], b: ['bow', 'arrow 64', 'iron_sword', 'cobblestone 32', 'golden_apple 2', ...ARMOR.iron] },
  {
    name: 'зелья',
    a: ['iron_sword', pot('splash_potion', 'strong_healing', 3), pot('potion', 'strength'), pot('splash_potion', 'harming', 2), ...ARMOR.iron],
    b: ['iron_sword', pot('splash_potion', 'healing', 3), pot('potion', 'swiftness'), pot('splash_potion', 'poison', 2), ...ARMOR.iron]
  },
  // Кошки-мышки: закрыться в коробке и лечиться, ломать чужую киркой.
  { name: 'крепость', a: ['iron_sword', 'iron_pickaxe', 'cobblestone 64', 'golden_apple 3', ...ARMOR.iron], b: ['iron_sword', 'iron_pickaxe', 'cobblestone 64', 'golden_apple 3', ...ARMOR.iron] },
  // Булава и заряды ветра (mace.js, 2026-09-26): A/B — одной стороне булава,
  // другой щит (PVP-RESEARCH г.3). Броня и щит — сразу на тело (onBody).
  { name: 'булава против щита', onBody: true, a: [...ARMOR.diamond, ...MACE_KIT], b: [...ARMOR.diamond, 'shield', ...SHIELD_KIT] },
  { name: 'булава на булаву', onBody: true, a: [...ARMOR.diamond, 'shield', ...MACE_KIT], b: null },
  // Подручное (utility.js, 2026-09-26; PVP-RESEARCH г.3 «удочка и лава», «ловушка»,
  // «хорус и жемчуг»): удочка — со столба, в яму, едока к мечу; паутина, лава и
  // наковальни — ловушки застрявшему; хорус — уход, когда жемчуг хуже. Броня на
  // тело, в рюкзаке 11 слотов. Пустое ведро после лавы — тот же слот.
  { name: 'ловушки и удочка', onBody: true, a: [...ARMOR.iron, 'iron_sword', 'fishing_rod', 'cobweb 12', 'anvil 4', 'lava_bucket', 'water_bucket', 'cobblestone 64', 'chorus_fruit 8', 'ender_pearl 2', 'golden_apple 3', 'iron_pickaxe'], b: null },
  // Трезубцы под дождём (weather: «Тягун» работает только в воде или под дождём,
  // TridentItem.use; в мире пользователя погоду не трогаем — ARENA_GENTLE):
  // «Верность» — бросок и возврат, «Тягун» — рывок, «Громовержец» — в грозу.
  { name: 'трезубцы', onBody: true, weather: 'rain', a: [...ARMOR.iron, 'trident[enchantments={loyalty:3}]', 'trident[enchantments={riptide:3}]', 'trident[enchantments={channeling:1,loyalty:1}]', 'iron_sword', 'water_bucket', 'golden_apple 3', 'cobblestone 64', 'chorus_fruit 4'], b: null },
  // Дальний бой (ranged.js, read.js, 2026-09-26; PVP-RESEARCH г.3 «арбалеты»):
  // A — два арбалета с «Быстрой перезарядкой III»: «Тройной выстрел» под
  // фейерверки с тремя звёздами (5 + 2·3 = 11 взрывом), «Пронзание IV» под
  // стрелы (щит не держит); стрелы с медлительностью и слабостью; B — лук, меч,
  // щит. Броня и щит — на тело. Рюкзак: A 12, B 8.
  { name: 'арбалет', onBody: true, a: [...ARMOR.iron, 'shield', XBOW_MULTI, XBOW_PIERCE, `${ROCKET3} 32`, 'arrow 64', tipped('slowness', 16), tipped('weakness', 16), 'diamond_sword', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', pot('splash_potion', 'strong_healing', 2)], b: [...ARMOR.iron, 'shield', 'bow', 'arrow 64', 'diamond_sword', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', pot('splash_potion', 'strong_healing', 2)] },
  // Стрелы с эффектом (ranged.pickArrow; г.3 «стрелы и зелья»): вред II — добить и
  // коротким натяжением мимо брони, слабость — сильно бьющему, медлительность —
  // убегающему. Обеим сторонам одно. Рюкзак 9.
  { name: 'стрелы с эффектом', onBody: true, a: [...ARMOR.iron, 'shield', 'bow[enchantments={power:3}]', tipped('strong_harming', 16), tipped('weakness', 16), tipped('strong_slowness', 16), 'arrow 32', 'iron_sword', 'golden_apple 3', 'cobblestone 64', pot('splash_potion', 'strong_healing', 2)], b: null },
  // Копья (spear.js; г.3 «копья»): A — копья (укол STAB с 2.0–4.5, разгон),
  // меч на случай «обнял»; B — меч, топор, щит: против копья он должен
  // прилипнуть ближе 1.9. Броня — на тело. Рюкзак: A 10, B 8.
  { name: 'копья', onBody: true, a: [...ARMOR.diamond, 'diamond_spear[enchantments={lunge:3}]', 'netherite_spear', 'diamond_sword', 'diamond_axe', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', 'ender_pearl 4', pot('splash_potion', 'strong_healing', 2)], b: [...ARMOR.diamond, 'shield', 'diamond_sword', 'diamond_axe', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', 'ender_pearl 4', pot('splash_potion', 'strong_healing', 2)] },
  {
    name: 'арсенал',
    // Броня и щит — на тело (/item replace, onBody): рюкзак 36 слотов весь под
    // вещи — 23 вещи + 12 зелий (зелья не стакаются — каждое слот) = 35.
    // Булава и заряды ветра — в начале: /give кладёт первые девять в хотбар.
    // Удочка, хорус и трезубец с «Верностью» (utility.js, 2026-09-26) — в конце.
    onBody: true,
    // Арбалет с «Быстрой перезарядкой III» (ranged.js, 2026-09-26) — 36-й слот:
    // заряженный — мгновенный выстрел в окно; стрелы те же.
    a: [...ARMOR.diamond, 'shield', 'diamond_sword', 'mace', 'wind_charge 32', 'diamond_axe', 'golden_apple 4', 'water_bucket', 'ender_pearl 6', 'cobblestone 64', 'bow',
      'arrow 64', 'crossbow[enchantments={quick_charge:3}]', 'diamond_pickaxe', 'cobweb 8', 'enchanted_golden_apple 1',
      'lava_bucket', 'lava_bucket', 'totem_of_undying', 'flint_and_steel',
      'oak_planks 64', 'obsidian 16', 'cooked_beef 16',
      pot('splash_potion', 'strong_healing', 3), pot('potion', 'strong_regeneration'), pot('potion', 'strong_strength'), pot('potion', 'strong_swiftness'),
      pot('potion', 'turtle_master'), pot('splash_potion', 'strong_harming', 2), pot('splash_potion', 'strong_poison'), pot('splash_potion', 'slowness'), pot('splash_potion', 'weakness'),
      'fishing_rod', 'chorus_fruit 8', 'trident[enchantments={loyalty:3}]'],
    b: null // люди получают ровно то же, что бот (просьба 2026-09-25: «дай нам такие же зелья»)
  },
  // Небо и порох (elytra.js, boom.js, 2026-09-26): элитры и фейерверки (уход
  // лечиться в воздух, пике с булавой, когда его щит выбит — топор), лук с
  // «Огнём» и вагонетки с TNT на рельсах (стрела в вагонетку — взрыв сразу),
  // кристаллы Края (пол — обсидиан), обсидиан под них. Броня и щит — на тело.
  // Взрыв выбивает светокамень пола и стекло: дыр больше с каждым взрывом.
  // ench: 'blast' — розыгрыш чар знает, что взрывов тут много
  // (arena-ench.W_BLAST: «Взрывоустойчивость» в цене). Стены держат взрывы:
  // Колизей — барьером, классика — барьерной оболочкой за стеклом (blastShell).
  // Рюкзак 25 из 36.
  {
    name: 'небо и порох',
    onBody: true,
    ench: 'blast',
    a: [...ARMOR.diamond, 'shield', 'diamond_sword', 'diamond_axe', 'mace', 'elytra', 'firework_rocket 48', 'bow[enchantments={flame:1}]', 'arrow 48',
      'rail 16', 'tnt_minecart', 'tnt_minecart', 'tnt_minecart', 'tnt_minecart', 'end_crystal 16', 'obsidian 16',
      'golden_apple 4', 'enchanted_golden_apple 1', 'totem_of_undying', 'totem_of_undying', 'water_bucket', 'ender_pearl 4', 'cobblestone 64',
      pot('splash_potion', 'strong_healing', 2), pot('potion', 'strong_regeneration'), pot('potion', 'strong_strength')],
    b: null
  },
  {
    name: 'полный кит',
    a: ['diamond_sword', 'diamond_axe', 'shield', 'bow', 'arrow 16', 'cobweb 4', 'golden_apple 2', 'lava_bucket', 'water_bucket', 'ender_pearl 2', 'totem_of_undying', 'cobblestone 64', 'diamond_pickaxe', pot('splash_potion', 'strong_healing', 2), pot('potion', 'strength'), ...ARMOR.diamond],
    b: ['diamond_sword', 'diamond_axe', 'shield', 'bow', 'arrow 16', 'cobweb 4', 'golden_apple 2', 'flint_and_steel', 'water_bucket', 'ender_pearl 2', 'totem_of_undying', 'cobblestone 64', 'diamond_pickaxe', pot('splash_potion', 'strong_healing', 2), pot('potion', 'swiftness'), ...ARMOR.diamond]
  }
]

// Куда на тело (onBody): броня — armor.*, щит — левая рука (PVP-RESEARCH г.1:
// /item replace entity <кто> armor.head with …) — мимо рюкзака, и боту не
// тратить время на equipBestArmor.
const BODY = { helmet: 'armor.head', chestplate: 'armor.chest', leggings: 'armor.legs', boots: 'armor.feet' }
function bodySlot (name) {
  const base = name.replace(/\[.*$/, '').replace(/^minecraft:/, '')
  const m = base.match(/_(helmet|chestplate|leggings|boots)$/)
  if (m) return BODY[m[1]]
  return base === 'shield' ? 'weapon.offhand' : null
}

export { MODE, KITS, bodySlot }
