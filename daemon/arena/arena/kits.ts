'use strict'
// Арена (часть arena.ts): наборы раундов (что получают A и B; режим kits/craft/all) и куда класть броню и щит сразу
// на тело.

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
// Кристаллы (crystal.js, 2026-09-30): «Защита IV» и поножи «Взрывоустойчивость
// IV» — против взрыва чары 4+4+8+4 = 20, потолок (−80%); против меча — 12.
// «Прочность III» и «Починка»: кристалл у ног снимает броне ~18 прочности за
// взрыв (урон/4 на вещь), к 20-му взрыву алмаз ломался — дальше каждый
// кристалл 25+ и конец боя. Бутылки опыта себе под ноги чинят (crystal.js «mend»).
const CRYSTAL_ARMOR = ['diamond_helmet[enchantments={protection:4,unbreaking:3,mending:1}]', 'diamond_chestplate[enchantments={protection:4,unbreaking:3,mending:1}]', 'diamond_leggings[enchantments={blast_protection:4,unbreaking:3,mending:1}]', 'diamond_boots[enchantments={protection:4,unbreaking:3,mending:1}]']
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
  // S7d (пункт I): «Громовержец» в грозу — молния по попаданию броском, если над целью небо (channeling.json). У обоих
  // по два трезубца с «Верностью III» (вернётся сам, TridentItem/ThrownTrident: ускорение возврата 0.05·уровень),
  // щит (трезубец — снаряд, щит держит спереди; молния — lightning_bolt мимо щита), вода — потушить поджог.
  { name: 'громовержец: трезубцы в грозу', onBody: true, weather: 'thunder', a: [...ARMOR.iron, 'trident[enchantments={channeling:1,loyalty:3}]', 'trident[enchantments={channeling:1,loyalty:3}]', 'iron_sword', 'shield', 'water_bucket', 'golden_apple 3', 'cobblestone 32'], b: null },
  { name: 'трезубцы', onBody: true, weather: 'rain', a: [...ARMOR.iron, 'trident[enchantments={loyalty:3}]', 'trident[enchantments={riptide:3}]', 'trident[enchantments={channeling:1,loyalty:1}]', 'iron_sword', 'water_bucket', 'golden_apple 3', 'cobblestone 64', 'chorus_fruit 4'], b: null },
  // Дальний бой (ranged.js, read.js, 2026-09-26; PVP-RESEARCH г.3 «арбалеты»):
  // A — два арбалета с «Быстрой перезарядкой III»: «Тройной выстрел» под
  // фейерверки с тремя звёздами (5 + 2·3 = 11 взрывом), «Пронзание IV» под
  // стрелы (щит не держит); стрелы с медлительностью и слабостью; B — лук, меч,
  // щит. Броня и щит — на тело. Рюкзак: A 12, B 8.
  // Пустые ракеты (для элитр, 0 звёзд) — первыми: арбалет должен брать ракеты
  // со звёздами (D3, s7 06.10).
  { name: 'арбалет', onBody: true, a: [...ARMOR.iron, 'shield', XBOW_MULTI, XBOW_PIERCE, 'firework_rocket 16', `${ROCKET3} 32`, 'arrow 64', tipped('slowness', 16), tipped('weakness', 16), 'diamond_sword', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', pot('splash_potion', 'strong_healing', 2)], b: [...ARMOR.iron, 'shield', 'bow', 'arrow 64', 'diamond_sword', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', pot('splash_potion', 'strong_healing', 2)] },
  // Стрелы с эффектом (ranged.pickArrow; г.3 «стрелы и зелья»): вред II — добить и
  // коротким натяжением мимо брони, слабость — сильно бьющему, медлительность —
  // убегающему. Обеим сторонам одно. Рюкзак 9.
  { name: 'стрелы с эффектом', onBody: true, a: [...ARMOR.iron, 'shield', 'bow[enchantments={power:3}]', tipped('strong_harming', 16), tipped('weakness', 16), tipped('strong_slowness', 16), 'arrow 32', 'iron_sword', 'golden_apple 3', 'cobblestone 64', pot('splash_potion', 'strong_healing', 2)], b: null },
  // Копья (spear.js; г.3 «копья»): A — копья (укол STAB с 2.0–4.5, разгон),
  // меч на случай «обнял»; B — меч, топор, щит: против копья он должен
  // прилипнуть ближе 1.9. Броня — на тело. Рюкзак: A 10, B 8.
  { name: 'копья', onBody: true, a: [...ARMOR.diamond, 'diamond_spear[enchantments={lunge:3}]', 'netherite_spear', 'diamond_sword', 'diamond_axe', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', 'ender_pearl 4', pot('splash_potion', 'strong_healing', 2)], b: [...ARMOR.diamond, 'shield', 'diamond_sword', 'diamond_axe', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', 'ender_pearl 4', pot('splash_potion', 'strong_healing', 2)] },
  // Удочка в комбо (s7b, просьба пользователя 06.10): подтяг убегающего/стрелка/«под удар» → рывок со спринт-ударом,
  // контрмеры — обратный подтяг своей удочкой, удар на подлёте; жемчуг и лук — чтобы было от чего подтягивать.
  { name: 'удочка в комбо', onBody: true, a: [...ARMOR.iron, 'iron_sword', 'fishing_rod', 'bow', 'arrow 24', 'ender_pearl 3', 'golden_apple 3', 'cobblestone 32'], b: null },
  // Элитры и копьё (s7b 06.10, план пользователя п.2): таран копьём на скорости (combat/aerial-lance — разгон
  // KineticWeapon: 1 + floor(отн. скорость·множитель), на 1.5 б/т железное ≈29 до брони), выход вверх, повтор,
  // посадка. Щитов нет: щит держит урон копья спереди (BlocksAttacks 90°) — таран против щита не планируется.
  // Простые ракеты (без звёзд) — для полёта. Потолок — по элитрам (CEIL), выше — ARENA_CEIL_H.
  { name: 'элитры и копьё', onBody: true, a: [...ARMOR.diamond, 'elytra', 'firework_rocket 48', 'iron_spear', 'diamond_sword', 'golden_apple 4', 'water_bucket', 'cobblestone 32', pot('splash_potion', 'strong_healing', 2)], b: null },
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
  // Кристаллы Края (crystal.js, 2026-09-30; просьба «научи ботов ими биться
  // зрелищно»): пол и слой под ним — обсидиан (кристалл ставится везде, взрыв
  // пол не пробивает), свет в полу — плачущий обсидиан (светокамень выбило бы).
  // Броня — CRYSTAL_ARMOR: кристалл у ног снимает ~12.6 из 20, не убивает;
  // толчок взрыва — 40% (устойчивость 0.6 от поножей), бойцов разносит.
  // Тотем — сразу в левой руке (offhand), ещё четыре в хотбаре: totem.js ставит
  // новый в тот же тик, как сработал прежний. Яблоки; лук со стрелами — подрыв
  // издалека. Чары только эти (fixedEnch — без розыгрыша arena-ench): модель
  // урона бота считает по ним. Кирки нет: против кристаллов — обсидиан вокруг
  // ног, не коробка. Порядок — хотбар: меч, кристаллы, обсидиан, лук, яблоки,
  // тотемы.
  {
    name: 'кристаллы',
    onBody: true,
    fixedEnch: true,
    offhand: 'totem_of_undying',
    floor: 'obsidian',
    light: 'crying_obsidian',
    a: [...CRYSTAL_ARMOR, 'diamond_sword[enchantments={sharpness:5}]', 'end_crystal 64', 'obsidian 64', 'bow[enchantments={power:1}]', 'golden_apple 12', 'totem_of_undying', 'totem_of_undying', 'totem_of_undying', 'totem_of_undying', 'arrow 64', 'enchanted_golden_apple 1', 'end_crystal 32', 'experience_bottle 64', 'experience_bottle 64'],
    b: null
  },
  // Кристаллы и щит (S7c, 07.10): тот же набор плюс щит — защита «щит лицом к его кристаллу» (взрыв
  // кристалла щит гасит целиком в передних 90°, толчок — нет), атака — кристалл за его спину, когда щит поднят.
  // Тотем — в левой руке, щит берётся в правую. Имя без «кристаллы»: фильтр KIT='кристаллы' его не берёт.
  // Топор (s7c1 р.3: щит против щита — 192 с ничья): удар топором выключает его щит на 5 с (javap Item$Properties.axe:
  // tool(…, disableBlockingForSeconds 5.0)).
  {
    name: 'кристалл со щитом',
    onBody: true,
    fixedEnch: true,
    offhand: 'totem_of_undying',
    floor: 'obsidian',
    light: 'crying_obsidian',
    a: [...CRYSTAL_ARMOR, 'diamond_sword[enchantments={sharpness:5}]', 'end_crystal 64', 'obsidian 64', 'shield', 'diamond_axe', 'bow[enchantments={power:1}]', 'golden_apple 12', 'totem_of_undying', 'totem_of_undying', 'totem_of_undying', 'totem_of_undying', 'arrow 64', 'enchanted_golden_apple 1', 'end_crystal 32', 'experience_bottle 64', 'experience_bottle 64'],
    b: null
  },
  // Якоря (бонус, 2026-09-30): тот же набор кристаллов плюс якоря возрождения и
  // светокамень — в верхнем мире заряженный якорь от «использовать» не
  // светокамнем взрывается силой 5 с огнём (crystal.js «anchor»). Имя без слова
  // «кристаллы»: фильтр «кристаллы» берёт только основной набор.
  // Якоря без кристаллов (TODO п.8, s7 06.10): crystal.engaged/plan берут якорь
  // и без своих кристаллов (D2). Пол и свет — как у кристаллов (сила 5 бьёт камень).
  { name: 'только якоря', onBody: true, fixedEnch: true, offhand: 'totem_of_undying', floor: 'obsidian', light: 'crying_obsidian', a: [...CRYSTAL_ARMOR, 'diamond_sword[enchantments={sharpness:5}]', 'respawn_anchor 32', 'glowstone 64', 'golden_apple 12', 'totem_of_undying', 'totem_of_undying', 'totem_of_undying', 'bow[enchantments={power:1}]', 'arrow 64', 'cobblestone 64', 'experience_bottle 64'], b: null },
  { name: 'якоря: кристалл и якорь возрождения', onBody: true, fixedEnch: true, offhand: 'totem_of_undying', floor: 'obsidian', light: 'crying_obsidian', a: [...CRYSTAL_ARMOR, 'diamond_sword[enchantments={sharpness:5}]', 'end_crystal 64', 'obsidian 64', 'bow[enchantments={power:1}]', 'golden_apple 12', 'respawn_anchor 16', 'glowstone 32', 'totem_of_undying', 'totem_of_undying', 'arrow 64', 'totem_of_undying', 'totem_of_undying', 'enchanted_golden_apple 1', 'end_crystal 32', 'experience_bottle 64', 'experience_bottle 64'], b: null },
  // Крафт-режим (ARENA_MODE=craft): кристалл — 7 стекла, око Края, слеза гаста
  // (верстак; prep.js крафтит все, на что хватит), обсидиан под них; броня —
  // своя из железа (без чар — кристалл у ног берёт тотем за раз).
  { name: 'крафт: кристаллы', craft: { a: 'smart', b: 'smart' }, floor: 'obsidian', light: 'crying_obsidian', a: [...RAW, 'glass 28', 'ender_eye 4', 'ghast_tear 4', 'obsidian 24', 'totem_of_undying 3', 'golden_apple 4'], b: null },
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
