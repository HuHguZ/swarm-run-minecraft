'use strict'
const gameClock = require('./game-clock')
// Постройки игры: узнать по тому, что видно, запомнить, рассудить, где искать
// следующую, зайти, обезвредить ловушку и забрать ценное — объяснив, зачем.
//
// Узнавание честное: блок засчитан, только если луч от глаз упирается в него
// (sight.seesBlock), сущность — если до неё есть луч. Сигнатура постройки —
// группы блоков (и сущностей "e:имя"), которые вместе больше нигде не растут:
// спавнер + замшелый булыжник — данж, рельсы + паутина + доски — шахта,
// обсидиан + незерак/плакучий обсидиан без портала внутри — руины портала...
//
// Когда постройка уже опознана, человек знает её планировку: сундуки
// пустынного храма — в камере под центральной синей терракотой, у храма в
// джунглях — за стенами. Поэтому сундуки в пределах опознанной постройки
// ищутся по данным мира (findBlocks), а не только глазами: это знание
// игры, а не подсказка сервера. Узнавание — только глазами.
//
// Факты — из paper-1.21.11.jar (SPEEDRUN.md, «Постройки»):
//   structure_set/*.json — spacing/separation регионов,
//   tags/worldgen/biome/has_structure/*.json — где что растёт,
//   loot_table/chests/*.json — что внутри,
//   DesertPyramidPiece — плита (10,-11,10) над 9 TNT (9..11,-13,9..11),
//     сундуки в 2 блоках от плиты по сторонам света;
//   TripWireBlock.playerWillDestroy — ножницы в руке ставят DISARMED,
//     без ножниц сломанная нить срабатывает;
//   PiglinAi.angerNearbyPiglins — открыл сундук/бочку или сломал золотой блок
//     (тег guarded_by_piglins): злятся все пиглины в кубе ±16, кто тебя видит.
//     Золотая броня от этого НЕ спасает — она только от нападения при встрече.
//
// ЭТИКА (правило человека): сундук, который поставил ИГРОК, без решения
// человека не трогаем. playerMarks() — признаки чужой руки: табличка, рамка,
// эндер-сундук, шалкер, наковальня, воронка у сундука, кровать не в деревне.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep: movementSleep, xyz } = require('./movement')
// Пауза, которую рвёт ctl (ревью Codex q2: под водой и на остановленных часах ожидания держали тело после abort).
function sleep (ms, ctl = null) {
  if (!ctl || !Array.isArray(ctl.onAbort)) return movementSleep(ms)
  if (ctl.aborted) return Promise.resolve()
  let stop
  return new Promise<void>(resolve => {
    const timer = gameClock.setTimeout(resolve, ms)
    stop = () => { gameClock.clearTimeout(timer); resolve() }
    ctl.onAbort.push(stop)
  }).finally(() => { const i = ctl.onAbort.indexOf(stop); if (i >= 0) ctl.onAbort.splice(i, 1) })
}
const { seesBlock } = require('./sight')
const { raySees, eyePos, biomeName } = require('./perception')
const pack = require('./pack')

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']
const PLANKS = WOODS.map(w => `${w}_planks`)
const TRAPDOORS = WOODS.map(w => `${w}_trapdoor`)
const FENCES = WOODS.map(w => `${w}_fence`)
const STRIPPED = WOODS.flatMap(w => [`stripped_${w}_log`, `stripped_${w}_wood`])
const WOOD_STEPS = WOODS.flatMap(w => [`${w}_stairs`, `${w}_slab`])
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const BEDS = COLORS.map(c => `${c}_bed`)
const JOBS = ['composter', 'lectern', 'smithing_table', 'fletching_table', 'cartography_table', 'grindstone', 'stonecutter', 'loom', 'blast_furnace', 'smoker', 'brewing_stand']
const COPPER_BULBS = ['', 'exposed_', 'weathered_', 'oxidized_'].flatMap(s => [`${s}copper_bulb`, `waxed_${s}copper_bulb`])
const CONTAINER_NAMES = ['chest', 'trapped_chest', 'barrel']
const DOOR_NAMES = ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door', 'bamboo_door']

// structure_set/*.json (paper-1.21.11): регион spacing×spacing чанков, в нём
// одна попытка; старт — в первых (spacing - separation) чанках региона от
// северо-западного угла. triangular — ближе к середине этого окна.
const SETS = {
  villages: { spacing: 34, separation: 8, members: ['village'] },
  desert_pyramids: { spacing: 32, separation: 8, members: ['desert_pyramid'] },
  jungle_temples: { spacing: 32, separation: 8, members: ['jungle_pyramid'] },
  igloos: { spacing: 32, separation: 8, members: ['igloo'] },
  swamp_huts: { spacing: 32, separation: 8, members: ['swamp_hut'] },
  pillager_outposts: { spacing: 32, separation: 8, frequency: 0.2, members: ['outpost'] },
  ruined_portals: { spacing: 40, separation: 15, members: ['ruined_portal', 'ruined_portal_nether'] },
  shipwrecks: { spacing: 24, separation: 4, members: ['shipwreck'] },
  ocean_ruins: { spacing: 20, separation: 8, members: ['ocean_ruin'] },
  ocean_monuments: { spacing: 32, separation: 5, triangular: true, members: ['monument'] },
  woodland_mansions: { spacing: 80, separation: 20, triangular: true, members: ['mansion'] },
  trial_chambers: { spacing: 34, separation: 12, members: ['trial_chambers'] },
  trail_ruins: { spacing: 34, separation: 8, members: ['trail_ruins'] },
  ancient_cities: { spacing: 24, separation: 8, members: ['ancient_city'] },
  nether_complexes: { spacing: 27, separation: 4, members: ['fortress', 'bastion'], share: 'крепость 2/5, бастион 3/5 — в регионе одна из двух' },
  end_cities: { spacing: 20, separation: 11, triangular: true, members: ['end_city'] },
  mineshafts: { perChunk: 0.004, members: ['mineshaft'] },
  buried_treasures: { perChunk: 0.01, members: ['buried_treasure'], at: 'блок 9,9 внутри чанка (locate_offset [9,0,9])' },
  strongholds: { rings: true, members: ['stronghold'] }
}

// Виды построек. groups — группы имён (любое из группы); "e:имя" — сущность.
// min — сколько групп нужно; must — хотя бы одна из этих групп обязательна.
// {names, min} — группа, которой нужно min видимых блоков.
const KINDS = {
  dungeon: {
    ru: 'данж', dim: ['overworld'], set: null, r: 7, lootR: 9,
    groups: [['spawner'], ['mossy_cobblestone']], min: 2, must: [0],
    table: 'simple_dungeon', handler: 'spawner', prio: 2,
    danger: 'спавнер зомби/скелетов/пауков — мобы идут волнами, пока он цел',
    value: 'золотые яблоки (15/144), книги с чарами, сёдла, бирки, железо, ведро'
  },
  mineshaft: {
    ru: 'заброшенная шахта', dim: ['overworld'], set: 'mineshafts', r: 10, lootR: 24,
    groups: [['rail'], ['cobweb'], ['oak_fence', 'dark_oak_fence'], ['oak_planks', 'dark_oak_planks'], ['e:chest_minecart'], ['spawner']], min: 3, must: [0, 1, 4],
    table: 'abandoned_mineshaft', handler: 'spawner', prio: 1,
    danger: 'пещерные пауки (яд) из спавнера в паутине; паутина держит; провалы',
    value: 'вагонетки с сундуком: золотые яблоки, книги, бирки, железо, иногда алмазы; рельсы'
  },
  desert_pyramid: {
    ru: 'пустынный храм', dim: ['overworld'], set: 'desert_pyramids', r: 14, lootR: 16,
    // DesertPyramidPiece: cut_sandstone 50, sandstone 38, orange_terracotta 35,
    // chiseled_sandstone 14, sandstone_stairs 5, blue_terracotta 2. Снаружи с
    // боков терракоты не видно — узнаётся по резному песчанику и ступеням.
    // Оранжевая терракота бывает и своя — полосы бесплодных земель по
    // соседству с пустыней (2026-09-25, храм у -5254,1690), поэтому одной её
    // мало; колокол или житель рядом — это пустынная деревня, не храм.
    groups: [['blue_terracotta'], ['orange_terracotta'], ['chiseled_sandstone'], ['cut_sandstone'], ['sandstone_stairs'], ['stone_pressure_plate', 'tnt']], min: 2, must: [0, 2, 3, 5],
    not: ['bell', 'e:villager'], notR: 48,
    biomes: /desert/, table: 'desert_pyramid', handler: 'desert', prio: 2,
    danger: 'нажимная плита в центре камеры над 9 TNT — наступил, и всё взлетело',
    value: '4 сундука: золотые яблоки, алмазы, изумруды, золото, железо, книги; 9 TNT под плитой'
  },
  jungle_pyramid: {
    ru: 'храм в джунглях', dim: ['overworld'], set: 'jungle_temples', r: 12, lootR: 14,
    // Снаружи — замшелый и простой булыжник со ступенями (шаблон: 701 / 456 / 24); растяжки, рычаги и резной кирпич —
    // внутри (ферма 14.10: без булыжника в группах храм не узнавался и с 2 бл.). Деревня тайги из того же булыжника —
    // не в джунглях.
    // Сквозь листву видно мало: двух групп хватает (замшелый булыжник обязателен), лишнее отсеют биом джунглей и шаблон.
    groups: [['tripwire_hook', 'tripwire'], ['mossy_cobblestone'], ['chiseled_stone_bricks'], ['dispenser', 'sticky_piston', 'lever'], ['cobblestone_stairs'], ['cobblestone']], min: 2, must: [1],
    biomes: /jungle/, table: 'jungle_temple', handler: 'jungle', prio: 1,
    danger: 'растяжки из нити у раздатчиков со стрелами; сломаешь нить без ножниц — выстрелит',
    value: '2 сундука: золото, железо, алмазы изредка; стрелы в раздатчиках'
  },
  ruined_portal: {
    ru: 'руины портала', dim: ['overworld'], set: 'ruined_portals', r: 10, lootR: 12,
    groups: [['obsidian'], ['crying_obsidian'], ['netherrack', 'magma_block'], ['gold_block']], min: 2, must: [0, 1], not: ['nether_portal'],
    table: 'ruined_portal', handler: 'portal', prio: 3,
    danger: 'почти нет: лава рядом, магма жжёт ноги',
    value: 'обсидиан (40/398 на заход), огниво и огненные заряды, золото и золотая броня с чарами — портал в Ад без алмазной кирки'
  },
  ruined_portal_nether: {
    ru: 'руины портала (Ад)', dim: ['the_nether'], set: 'ruined_portals', r: 10, lootR: 12,
    groups: [['obsidian'], ['crying_obsidian'], ['gold_block'], ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks']], min: 2, must: [0, 1], not: ['nether_portal'],
    table: 'ruined_portal', handler: 'portal', prio: 2,
    danger: 'лава, пиглины рядом',
    value: 'огниво, обсидиан, золото'
  },
  shipwreck: {
    ru: 'затонувший корабль', dim: ['overworld'], set: 'shipwrecks', r: 16, lootR: 18,
    groups: [PLANKS, TRAPDOORS, STRIPPED, FENCES, WOOD_STEPS], min: 3, must: [0],
    biomes: /ocean|beach|river/, table: 'shipwreck_supply / _treasure / _map', handler: 'generic', prio: 2,
    danger: 'утопленники, воздух под водой, течение',
    value: 'сундук сокровищ: железо (90/150), изумруды, алмазы; снабжение: еда, порох, TNT; карта — к кладу'
  },
  // Клад глазами не узнаётся (он под песком) — только по карте сокровищ (treasure-map: крестик и своя метка на карте).
  buried_treasure: {
    ru: 'клад', dim: ['overworld'], set: 'buried_treasures', r: 3, lootR: 3,
    groups: [], min: 99, must: [],
    table: 'buried_treasure', handler: 'generic', prio: 3,
    danger: 'почти нет; на мели — вода в столбце',
    value: 'железо ~9.3, золото ~4.6, алмаз ~1, TNT, рыба, сердце моря (loot_table/chests/buried_treasure)'
  },
  ocean_ruin: {
    ru: 'подводные руины', dim: ['overworld'], set: 'ocean_ruins', r: 10, lootR: 12,
    groups: [['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks', 'cut_sandstone', 'chiseled_sandstone'], ['suspicious_gravel', 'suspicious_sand'], ['magma_block'], ['e:drowned']], min: 2, must: [0], wet: 5,
    biomes: /ocean/, table: 'underwater_ruin_big / _small', handler: 'generic', prio: 1,
    danger: 'утопленники с трезубцами, воздух',
    value: 'карта сокровищ (10/23 в большом), золотое яблоко изредка, книги с чарами'
  },
  village: {
    ru: 'деревня', dim: ['overworld'], set: 'villages', r: 40, lootR: 56,
    groups: [['bell', 'hay_block', 'dirt_path', 'e:villager', 'e:iron_golem'], BEDS, JOBS, ['e:villager'], ['bell'], ['hay_block']], min: 3, must: [0],
    table: 'village/*', handler: 'village', prio: 3,
    danger: 'железный голем: ударишь жителя — убьёт; ночью зомби-осада',
    value: 'кровати (ночь и дракон), еда (сено = 9 пшеницы, грядки), железо и обсидиан у оружейника, торговля'
  },
  igloo: {
    ru: 'иглу', dim: ['overworld'], set: 'igloos', r: 8, lootR: 14,
    // Снаружи видно купол из снега и два окна-льдинки (igloo/top: 94 snow_block, 2 ice); ковёр, факел и печь — только в
    // дверь (ферма 14.10: с «обязательным ковром» иглу не узнавался ни с 18, ни с 2 бл.). Ложное — снег со льдом на
    // склонах — отсеет шаблон.
    groups: [['snow_block'], ['ice'], ['white_carpet', 'light_gray_carpet'], ['redstone_torch'], ['furnace', 'crafting_table']], min: 2, must: [0, 2],
    biomes: /snow/, table: 'igloo_chest', handler: 'igloo', prio: 1,
    danger: 'почти нет; в подвале — житель-зомби',
    value: 'подвал (в половине иглу): сундук с ВСЕГДА одним золотым яблоком'
  },
  outpost: {
    ru: 'аванпост разбойников', dim: ['overworld'], set: 'pillager_outposts', r: 16, lootR: 18,
    groups: [['e:pillager'], ['dark_oak_log'], ['birch_planks'], ['white_wall_banner', 'white_banner'], ['dark_oak_fence', 'dark_oak_stairs']], min: 3, must: [0, 3],
    table: 'pillager_outpost', handler: 'avoid', prio: 0,
    danger: 'разбойники с арбалетами волнами, дурное знамение (рейд на деревню)',
    value: 'арбалет, пузырьки опыта; для победы не нужен'
  },
  swamp_hut: {
    ru: 'хижина ведьмы', dim: ['overworld'], set: 'swamp_huts', r: 6, lootR: 8,
    groups: [['potted_red_mushroom'], ['cauldron'], ['e:witch'], ['spruce_planks'], ['oak_fence']], min: 3, must: [0, 2],
    biomes: /swamp/, table: null, handler: 'avoid', prio: 0,
    danger: 'ведьма: зелья отравления и слабости',
    value: 'сундуков нет'
  },
  trial_chambers: {
    ru: 'испытательная камера', dim: ['overworld'], set: 'trial_chambers', r: 24, lootR: 40,
    groups: [['trial_spawner'], ['vault'], ['tuff_bricks', 'chiseled_tuff', 'polished_tuff', 'chiseled_tuff_bricks'], COPPER_BULBS, ['e:breeze']], min: 2, must: [0, 1, 3, 4],
    table: 'trial_chambers/*', handler: 'generic', prio: 1,
    danger: 'испытательные спавнеры: волна мобов на каждого игрока рядом; вихрь (breeze) отбивает снаряды',
    value: 'хранилища — только за ключ испытаний; простые сундуки/бочки — еда, стрелы'
  },
  ancient_city: {
    ru: 'древний город', dim: ['overworld'], set: 'ancient_cities', r: 32, lootR: 48,
    groups: [['reinforced_deepslate'], { names: ['deepslate_tiles', 'deepslate_bricks', 'cracked_deepslate_tiles', 'cracked_deepslate_bricks'], min: 6 }, ['soul_lantern', 'soul_fire', 'candle'], ['sculk_shrieker'], ['sculk', 'sculk_vein', 'sculk_sensor'], ['e:warden']], min: 2, must: [0, 1],
    table: 'ancient_city', handler: 'avoid', prio: 0,
    danger: 'ВАРДЕН: вопль шрикера трижды — выходит и убивает за два удара; ходить только крадучись',
    value: 'зачарованные золотые яблоки (1/86), книги (Быстрые ноги), алмазная броня; для победы не нужен'
  },
  deep_dark: {
    ru: 'глубокая тьма (скалк)', dim: ['overworld'], set: null, r: 16, lootR: 0,
    groups: [['sculk_shrieker'], ['sculk_sensor', 'calibrated_sculk_sensor'], ['sculk_catalyst']], min: 1, must: [0],
    table: null, handler: 'avoid', prio: 0,
    danger: 'шрикер будит вардена; сенсоры слышат шаги, стук кирки, падение — только крадучись',
    value: 'ничего нужного'
  },
  monument: {
    ru: 'подводная крепость', dim: ['overworld'], set: 'ocean_monuments', r: 30, lootR: 0,
    groups: [['prismarine_bricks', 'dark_prismarine'], ['sea_lantern'], ['prismarine'], ['e:guardian', 'e:elder_guardian']], min: 2, must: [0, 3], wet: 6,
    table: null, handler: 'avoid', prio: 0,
    danger: 'стражи (лазер), древний страж — усталость рудокопа III: кирка почти не копает',
    value: 'золотые блоки под губкой; для победы не нужен'
  },
  mansion: {
    ru: 'лесной особняк', dim: ['overworld'], set: 'woodland_mansions', r: 40, lootR: 60,
    groups: [['e:vindicator', 'e:evoker'], ['dark_oak_planks', 'dark_oak_log'], ['birch_planks'], ['cobblestone']], min: 3, must: [0],
    table: 'woodland_mansion', handler: 'avoid', prio: 0,
    danger: 'поборники с топорами, вызыватели (досаждатели, клыки)',
    value: 'тотем бессмертия с вызывателя; сундуки как в данже'
  },
  stronghold: {
    ru: 'крепость Края', dim: ['overworld'], set: 'strongholds', r: 24, lootR: 32,
    // Решётки и кирпич бывают и в руинах портала (2026-09-25: «крепость» у
    // руин): якорь — только рамка портала, железная дверь или книжные полки.
    groups: [['end_portal_frame'], ['stone_bricks'], ['mossy_stone_bricks', 'cracked_stone_bricks'], ['iron_bars'], ['iron_door'], ['bookshelf']], min: 3, must: [0, 4, 5],
    not: ['obsidian', 'crying_obsidian', 'netherrack'],
    table: 'stronghold_corridor / _library', handler: 'generic', prio: 3,
    danger: 'чешуйницы в «камнях» (их не отличить глазом), пауки в библиотеке',
    value: 'портал в Край (mc_stronghold); в сундуках коридоров — жемчуг (10/101), железо'
  },
  trail_ruins: {
    ru: 'руины тропы', dim: ['overworld'], set: 'trail_ruins', r: 12, lootR: 0,
    groups: [['suspicious_gravel'], ['mud_bricks'], ['packed_mud']], min: 2, must: [0],
    table: null, handler: 'avoid', prio: 0,
    danger: 'нет', value: 'только археология кисточкой; сундуков нет'
  },
  fortress: {
    ru: 'крепость Ада', dim: ['the_nether'], set: 'nether_complexes', r: 24, lootR: 32,
    groups: [{ names: ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs'], min: 3 }, ['nether_brick_fence'], ['e:blaze'], ['nether_wart'], ['spawner']], min: 1, must: [0],
    table: 'nether_bridge', handler: 'generic', prio: 2,
    danger: 'ифриты, скелеты-иссушители (иссушение), лава; спавнеры ифритов НЕ ломать — это палки',
    value: 'сундуки: алмазы, золото, железо, сёдла, огниво, обсидиан, нарост; палки ифритов (mc_blaze)'
  },
  bastion: {
    ru: 'бастион', dim: ['the_nether'], set: 'nether_complexes', r: 32, lootR: 44,
    groups: [['gilded_blackstone'], { names: ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks'], min: 20 }, ['e:piglin_brute'], ['gold_block'], ['e:hoglin'], ['e:piglin']], min: 2, must: [0, 1, 2],
    table: 'bastion_treasure / _other / _bridge / _hoglin_stable', handler: 'bastion', prio: 1,
    danger: 'брутья бьют всегда; открыл сундук или сломал золото на глазах у пиглина — злятся все в ±16; без золотой брони нападают сразу',
    value: 'сундук сокровищ: незерит, алмазная броня с чарами, зач. яблоко; прочие — золото, жемчуг бартером (mc_pearls)'
  },
  end_city: {
    ru: 'город Края', dim: ['the_end'], set: 'end_cities', r: 40, lootR: 56,
    groups: [['purpur_block', 'purpur_pillar', 'purpur_stairs', 'purpur_slab'], ['end_stone_bricks'], ['end_rod'], ['e:shulker'], ['magenta_stained_glass']], min: 2, must: [0],
    table: 'end_city_treasure', handler: 'endcity', prio: 2,
    danger: 'шалкеры: левитация — вверх и падение в пустоту; только после дракона',
    value: 'элитры в рамке на корабле; алмазная броня и инструменты с чарами'
  }
}

// Ловушки, на которые ногами не наступать ни при каком пути.
const TRAP_BLOCKS = ['stone_pressure_plate', 'tripwire', 'sculk_sensor', 'calibrated_sculk_sensor', 'sculk_shrieker']

// ------------------------------------------------------------------ helpers

function dimOf (bot) { return (bot.game && bot.game.dimension ? String(bot.game.dimension) : 'overworld').replace(/^minecraft:/, '') }
function flat (a, b) { return Math.hypot(a.x - b.x, a.z - b.z) }
function v3 (p) { return new Vec3(p.x, p.y, p.z) }
function keyOf (p) { return `${p.x},${p.y},${p.z}` }
function groupNames (g) { return Array.isArray(g) ? g : g.names }
function groupMin (g) { return Array.isArray(g) ? 1 : (g.min || 1) }
function withTimeout (p, ms, what = 'время вышло') {
  let t
  return Promise.race([p, new Promise<any>((resolve, reject) => { t = gameClock.setTimeout(() => reject(new Error(what)), ms) })]).finally(() => gameClock.clearTimeout(t))
}

function kindsFor (dim) {
  return (Object.entries(KINDS) as [string, any][]).filter(([, K]) => K.dim.includes(dim))
}

function count (bot, re) {
  let n = 0
  for (const it of bot.inventory.items()) if (typeof re === 'string' ? it.name === re : re.test(it.name)) n += it.count
  return n
}

// ------------------------------------------------------------------ зрение

// Где лежат блоки этих имён в радиусе — ОДИН проход по секциям чанков.
// bot.findBlocks на каждое имя стоил ~60 мс даже впустую (Block.fromStateId
// на каждую запись палитры каждой секции): 160 имён — 8 с стоящего цикла
// событий, и сервер выкидывал бота по тайм-ауту (2026-09-25). Здесь палитра
// секции сверяется с набором stateId, и только совпавшие секции читаются.
function gather (bot, names, radius, perName = 64) {
  const R = bot.registry.blocksByName
  const byState = new Map()
  for (const n of names) {
    const b = R[n]
    if (!b || n.startsWith('e:')) continue
    for (let st = b.minStateId; st <= b.maxStateId; st++) byState.set(st, n)
  }
  const out = new Map()
  if (!byState.size) return out
  const me = bot.entity.position
  const minY = bot.game.minY || 0
  const cr = Math.ceil(radius / 16)
  const cx0 = Math.floor(me.x / 16)
  const cz0 = Math.floor(me.z / 16)
  const syLo = Math.max(0, Math.floor((me.y - radius - minY) / 16))
  const syHi = Math.floor((me.y + radius - minY) / 16)
  const r2 = radius * radius
  for (let dx = -cr; dx <= cr; dx++) {
    for (let dz = -cr; dz <= cr; dz++) {
      const col = bot.world.getColumn(cx0 + dx, cz0 + dz)
      if (!col || !col.sections) continue
      for (let sy = syLo; sy <= syHi && sy < col.sections.length; sy++) {
        const sec = col.sections[sy]
        const data = sec && sec.data
        if (!data) continue
        if (data.palette) {
          if (!data.palette.some(st => byState.has(st))) continue
        } else if (data.value !== undefined) {
          if (!byState.has(data.value)) continue
        }
        const bx = (cx0 + dx) * 16
        const bz = (cz0 + dz) * 16
        const by = sy * 16 + minY
        for (let i = 0; i < 4096; i++) {
          const n = byState.get(data.get(i))
          if (!n) continue
          const x = bx + (i & 15)
          const y = by + (i >> 8)
          const z = bz + ((i >> 4) & 15)
          const ddx = x + 0.5 - me.x
          const ddy = y + 0.5 - me.y
          const ddz = z + 0.5 - me.z
          if (ddx * ddx + ddy * ddy + ddz * ddz > r2) continue
          let list = out.get(n)
          if (!list) out.set(n, list = [])
          if (list.length < perName * 4) list.push(new Vec3(x, y, z))
        }
      }
    }
  }
  for (const [n, list] of out) {
    list.sort((a, b) => a.distanceSquared(me) - b.distanceSquared(me))
    if (list.length > perName) out.set(n, list.slice(0, perName))
  }
  return out
}

// Виден ли блок: луч к центру (sight.seesBlock), а нет — к центрам граней,
// обращённых к глазам. Блок в стене видно краем, хотя центр закрыт соседом:
// башня храма, торчащая из дюны, человеку видна, а лучу в центр — нет.
function sees (bot, block) {
  if (seesBlock(bot, block)) return true
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
  const p = block.position
  const c = p.offset(0.5, 0.5, 0.5)
  const faces = []
  if (eye.x < p.x) faces.push(c.offset(-0.45, 0, 0)); else if (eye.x > p.x + 1) faces.push(c.offset(0.45, 0, 0))
  if (eye.y < p.y) faces.push(c.offset(0, -0.45, 0)); else if (eye.y > p.y + 1) faces.push(c.offset(0, 0.45, 0))
  if (eye.z < p.z) faces.push(c.offset(0, 0, -0.45)); else if (eye.z > p.z + 1) faces.push(c.offset(0, 0, 0.45))
  const match = (b, iter) => b.position.equals(p) || !!iter.intersect(b.shapes, b.position)
  for (const f of faces) {
    const d = f.minus(eye)
    const dist = d.norm()
    try {
      const hit = bot.world.raycast(eye, d.normalize(), dist + 0.3, match)
      if (hit && hit.position.equals(p)) return true
    } catch {}
  }
  return false
}

// Один взгляд: кандидаты — из gather, у каждого имени свой бюджет лучей
// (как fortress.look), чтобы обычный камень не съедал бюджет редких блоков.
function look (bot, names, { radius = 40, rays = 24, enough = 8 }: any = {}) {
  const seen = new Map()
  const me = bot.entity.position
  const all = gather(bot, names, radius)
  for (const [name, found] of all) {
    const hits = []
    let tried = 0
    const want = name === 'polished_blackstone_bricks' || name === 'cracked_polished_blackstone_bricks' ? 30 : enough
    const step = Math.max(1, Math.floor(found.length / (rays * 2)))
    for (let i = 0; i < found.length && tried < rays * 2 && hits.length < want; i += step) {
      tried++
      const p = found[i]
      const block = bot.blockAt(p)
      if (!block) continue
      // Вплотную (руку протянуть) — видно и за углом.
      if (p.offset(0.5, 0.5, 0.5).distanceTo(me.offset(0, 1.62, 0)) <= 2.2 || sees(bot, block)) hits.push(p)
    }
    if (hits.length) seen.set(name, hits)
  }
  // Сущности — по лучу к середине тела.
  const ents = new Map()
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e === bot.entity || !e.name || !e.position) continue
    if (e.position.distanceTo(me) > radius) continue
    const k = `e:${e.name}`
    if (!names.has(k)) continue
    const mid = e.position.offset(0, (e.height || 1) / 2, 0)
    if (!raySees(bot, eyePos(bot), mid)) continue
    if (!ents.has(k)) ents.set(k, [])
    ents.get(k).push(e.position.floored())
  }
  for (const [k, v] of ents) seen.set(k, v)
  return seen
}

// Узнать постройки в увиденном. Якорь — видимый блок обязательной группы;
// остальные группы засчитываются в радиусе r от него.
function evaluate (bot, kind, K, seen) {
  const hitsOf = K.groups.map(g => groupNames(g).flatMap(n => (seen.get(n) || []).map(p => ({ n, p }))))
  const anchorGroups = K.must || K.groups.map((_, i) => i)
  const anchors = anchorGroups.flatMap(i => hitsOf[i]).slice(0, 24)
  let best = null
  for (const a of anchors) {
    const got = []
    hitsOf.forEach((hits, i) => {
      const near = hits.filter(h => h.p.distanceTo(a.p) <= K.r * 1.5)
      if (near.length >= groupMin(K.groups[i])) got.push({ i, n: near[0].n, list: near })
    })
    if (!got.some(g => anchorGroups.includes(g.i))) continue
    if (!best || got.length > best.got.length) best = { anchor: a.p, got }
  }
  if (!best || best.got.length < K.min) return null
  // Исключения: светится портал внутри рамки — это чей-то портал, не руины.
  if (K.not && K.not.some(n => (seen.get(n) || []).some(p => p.distanceTo(best.anchor) <= (K.notR || K.r)))) return null
  if (K.wet) {
    const w = bot.registry.blocksByName.water
    if (!w || !bot.findBlock({ matching: w.id, maxDistance: K.wet, point: best.anchor })) return null
  }
  if (K.biomes) {
    // Биом проверяется у старта постройки, а её блоки лежат и на соседнем:
    // храм у -5254,1690 стоит краем на wooded_badlands. Поэтому — любой из
    // пяти точек вокруг якоря; неизвестный (#id) — не спорим.
    const pts = [best.anchor, ...[[16, 0], [-16, 0], [0, 16], [0, -16]].map(([dx, dz]) => best.anchor.offset(dx, 0, dz))]
    const names = pts.map(q => biomeName(bot, q)).filter(Boolean)
    if (names.length && !names.some(b => /^biome#/.test(b) || K.biomes.test(b))) return null
  }
  const pts = best.got.flatMap(g => g.list.map(h => h.p))
  const c = pts.reduce((s, p) => s.plus(p), new Vec3(0, 0, 0)).scaled(1 / pts.length)
  // Колокол деревни — на площади в центре (пулы town_centers): увиден — он и есть центр.
  const bell = kind === 'village' ? best.got.flatMap(g => g.list).find(h => h.n === 'bell') : null
  return {
    kind,
    name: K.ru,
    at: { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) },
    evidence: [...new Set(best.got.map(g => g.n.replace(/^e:/, '')))],
    groups: best.got.length,
    ...(bell ? { bell: { x: bell.p.x, y: bell.p.y, z: bell.p.z } } : {})
  }
}

// Честный осмотр: что из построек видно отсюда. record — записать в память.
function scan (session, { radius = 40, record = true }: any = {}) {
  const bot = session.bot
  const dim = dimOf(bot)
  const kinds = kindsFor(dim)
  const names = new Set(kinds.flatMap(([, K]) => K.groups.flatMap(groupNames)))
  for (const [, K] of (kinds as any)) for (const n of (K.not || [])) names.add(n)
  const seen = look(bot, names, { radius })
  const found = []
  for (const [kind, K] of kinds) {
    const d = evaluate(bot, kind, K, seen)
    if (d) found.push(d)
  }
  // Руины портала — часть сигнатуры бастиона (блэкстоун-кирпич): бастион главнее.
  const me = bot.entity.position
  for (const d of found) d.dist = Math.round(flat(me, d.at))
  const fresh = []
  if (record) {
    for (const d of found) {
      const r = remember(session, d, dim)
      if (r.fresh) fresh.push(d)
      d.known = !r.fresh
      d.done = !!r.rec.done
    }
  }
  const blocks = {}
  for (const [n, list] of seen) blocks[n.replace(/^e:/, '')] = list.length
  return { dim, found: found.sort((a, b) => a.dist - b.dist), fresh, blocks }
}

// ------------------------------------------------------------------ память

function listOf (session) {
  const s = session.journal.state
  return Array.isArray(s.structures) ? s.structures : []
}

function remember (session, d, dim) {
  const K = KINDS[d.kind]
  const list = listOf(session)
  const same = list.find(s => s.kind === d.kind && s.dim === dim && flat(s, d.at) < Math.max(24, K.r * 2))
  if (same) {
    // Центр деревни: первая запись — по краю, который увидел первым (ферма 14.10: с края explore сундуков не находил).
    // Колокол на виду — центр по нему; иначе — среднее увиденного с разных мест (вес старого — до 4 взглядов).
    const move = d.kind === 'village' && !same.bell && d.bell ? d.bell : null
    const drift = d.kind === 'village' && !same.bell && !move && flat(same, d.at) > 6
    // Раз в минуту — обновить «видел» и улики, не чаще: patch пишет файл.
    if (move || drift || gameClock.now() - (same.t || 0) > 60000 || d.evidence.some(e => !(same.ev || []).includes(e))) {
      session.journal.patch(s => {
        const r = (s.structures || []).find(x => x === same || (x.kind === same.kind && x.dim === same.dim && x.x === same.x && x.z === same.z))
        if (!r) return
        r.t = gameClock.now()
        r.ev = [...new Set([...(r.ev || []), ...d.evidence])].slice(0, 8)
        if (move) { r.x = move.x; r.y = move.y; r.z = move.z; r.bell = true }
        else if (drift) {
          const n = Math.min(4, r.n || 1)
          r.x = Math.round((r.x * n + d.at.x) / (n + 1)); r.z = Math.round((r.z * n + d.at.z) / (n + 1)); r.y = Math.round(((r.y ?? d.at.y) * n + d.at.y) / (n + 1))
          r.n = (r.n || 1) + 1
        }
      })
    }
    return { fresh: false, rec: same }
  }
  const at0 = d.bell || d.at
  const rec: any = { kind: d.kind, dim, x: at0.x, y: at0.y, z: at0.z, t: gameClock.now(), ev: d.evidence.slice(0, 8), done: false, ...(d.bell ? { bell: true } : {}) }
  session.journal.patch(s => {
    if (!Array.isArray(s.structures)) s.structures = []
    s.structures.push(rec)
    if (s.structures.length > 80) s.structures.splice(0, s.structures.length - 80)
  })
  try { session.journal.append('постройка', `${K.ru} на ${d.at.x},${d.at.y},${d.at.z} (${dim}): видел ${d.evidence.join(', ')}`, v3(d.at)) } catch {}
  try {
    const map = session.director && session.director.map
    if (map) { map.hint(dim, d.at, 'structure'); map.hint(dim, d.at, `s:${d.kind}`) }
  } catch {}
  return { fresh: true, rec }
}

function patchRec (session, rec, fn) {
  session.journal.patch(s => {
    const r = (s.structures || []).find(x => x.kind === rec.kind && x.dim === rec.dim && x.x === rec.x && x.z === rec.z)
    if (r) fn(r)
  })
}

// Запись постройки, внутри которой точка (для loot.js: «что за место»).
function recordedAt (session, pos, dim = null) {
  const d = dim || dimOf(session.bot)
  let best = null
  for (const r of listOf(session)) {
    if (r.dim !== d) continue
    const K = KINDS[r.kind]
    if (!K) continue
    const dist = flat(r, pos)
    if (dist <= Math.max(K.lootR || 0, K.r) && Math.abs((r.y ?? pos.y) - pos.y) <= 24 && (!best || dist < best.dist)) best = { rec: r, dist }
  }
  return best ? best.rec : null
}

function describe (rec, me, looted = null) {
  const K = KINDS[rec.kind] || {}
  // Узнанный шаблон: невзятые сундуки с таблицами (для цены: campaign/structure-value).
  const ex = rec.fit && rec.fit.extra
  const fit = rec.fit ? { name: rec.fit.name, chests: (rec.fit.chests || []).filter(([x, y, z]) => !looted || (!looted.has(`${x},${y},${z}`) && !looted.has(`miss:${x},${y},${z}`))).map(([x, y, z, table, p, wet]) => ({ x, y, z, table, p, wet: !!wet })), ...(ex && Number.isFinite(ex.houses) ? { houses: ex.houses, beds: ex.beds || 0, hay: ex.hay || 0 } : {}) } : undefined
  return {
    kind: rec.kind,
    name: K.ru,
    at: { x: rec.x, y: rec.y, z: rec.z },
    dim: rec.dim,
    dist: me ? Math.round(flat(me, rec)) : undefined,
    done: !!rec.done,
    evidence: rec.ev,
    prio: K.prio,
    value: K.value,
    danger: K.danger,
    note: rec.note || undefined,
    fit,
    rough: rec.rough || undefined
  }
}

function known (session, { all = false }: any = {}) {
  const bot = session.bot
  const dim = dimOf(bot)
  const me = bot.entity.position
  const looted = lootedSet(session)
  return listOf(session).filter(r => all || r.dim === dim).map(r => describe(r, r.dim === dim ? me : null, looted))
    .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9))
}

// Узнать шаблон постройки из памяти, которую видно отсюда (для цены до захода): ближайшая запись вида kind у x,z.
function fitKnown (session, { kind = null, x, z, maxDistance = 64, debug = false }: any = {}) {
  const bot = session.bot
  const rec = pickTarget(session, { kind, x, z, again: true })
  if (!rec || !TEMPLATE_KINDS[rec.kind] || flat(bot.entity.position, rec) > maxDistance) return { fit: null, why: rec ? 'далеко или без шаблона' : 'нет записи' }
  session._fitDebug = debug ? [] : null
  const tf = templateFit(session, debug ? { ...rec, fit: null } : rec)
  const dbg = session._fitDebug
  session._fitDebug = null
  const ex = tf && tf.extra
  return { fit: tf ? { name: tf.name, chests: tf.chests.filter(c => Number.isFinite(c.y) || c.basement).map(c => ({ x: c.x, y: c.y, z: c.z, table: c.table, p: c.p, wet: !!c.wet })), ...(ex && Number.isFinite(ex.houses) ? { houses: ex.houses, beds: ex.beds || 0, hay: ex.hay || 0 } : {}) } : null, debug: dbg || undefined }
}

// Для session.compactState: не весь список, а счёт и ближайшие.
function compact (list) {
  if (!Array.isArray(list) || !list.length) return undefined
  const kinds = {}
  for (const r of list) kinds[r.kind] = (kinds[r.kind] || 0) + 1
  return {
    всего: list.length,
    виды: kinds,
    последние: list.slice(-4).map(r => `${(KINDS[r.kind] || {}).ru || r.kind} ${r.x},${r.y},${r.z} ${r.dim}${r.done ? ' (взято)' : ''}`),
    как: 'mc_structure mode=list — все с расстояниями; explore — зайти и взять'
  }
}

// ------------------------------------------------------------------ где искать

// Где может быть следующая постройка этого вида — по сетке регионов
// structure_set. Семя мира бот не знает (честно), поэтому точку не
// вычислить; известно другое: в каждом регионе ровно одна попытка, старт
// в окне у северо-западного угла, а регион, где такая уже найдена,
// второй не даст (у nether_complexes — ни крепости, ни бастиона).
function whereNext (session, kind, { from = null }: any = {}) {
  const K = KINDS[kind]
  if (!K) throw new Error(`не знаю постройку ${kind}; бывают: ${Object.keys(KINDS).join(', ')}`)
  const bot = session.bot
  const dim = dimOf(bot)
  const me = from || bot.entity.position
  const S = K.set ? SETS[K.set] : null
  const out: any = { kind, name: K.ru, dims: K.dim, biomes: biomesText(kind) }
  if (!K.dim.includes(dim)) out.warn = `${K.ru} бывает только в ${K.dim.join('/')}, а мы в ${dim}`
  if (!S) { out.text = `${K.ru}: регионов нет — растёт где придётся (${K.ru === 'данж' ? 'в пещерах, в любом биоме, y до 256' : 'смотри биомы'})`; return out }
  if (S.rings) { out.text = 'крепость Края — кольца (128 штук, первое кольцо 1280-2816 от центра): mc_stronghold по глазам Края'; return out }
  if (S.perChunk) {
    out.text = `${K.ru}: не регионы, а шанс ${S.perChunk * 100}% на чанк${S.at ? `; ${S.at}` : ''} — в среднем одна на ${Math.round(1 / S.perChunk)} чанков`
    if (kind === 'mineshaft') out.text += '; честно — идти пещерами/штреком на y 0..40, шахту выдают рельсы и паутина'
    return out
  }
  const span = S.spacing * 16
  const win = (S.spacing - S.separation) * 16
  const rxOf = x => Math.floor(Math.floor(x / 16) / S.spacing)
  const used = new Set()
  for (const r of listOf(session)) if (S.members.includes(r.kind) && r.dim === dim) used.add(`${rxOf(r.x)},${rxOf(r.z)}`)
  const seenChunks = (session.director && session.director.map && session.director.map.seen[dim]) || {}
  const rx0 = rxOf(me.x)
  const rz0 = rxOf(me.z)
  const cand = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const rx = rx0 + dx
      const rz = rz0 + dz
      const k = `${rx},${rz}`
      const x0 = rx * span
      const z0 = rz * span
      const cx = x0 + Math.round(win / 2)
      const cz = z0 + Math.round(win / 2)
      // Сколько чанков окна уже видели (карта директора).
      let total = 0
      let visited = 0
      for (let ix = 0; ix < S.spacing - S.separation; ix += 2) {
        for (let iz = 0; iz < S.spacing - S.separation; iz += 2) {
          total++
          if (seenChunks[`${rx * S.spacing + ix},${rz * S.spacing + iz}`]) visited++
        }
      }
      const cover = total ? visited / total : 0
      cand.push({
        region: k,
        used: used.has(k),
        window: { x0, z0, x1: x0 + win - 1, z1: z0 + win - 1 },
        x: cx,
        z: cz,
        dist: Math.round(Math.hypot(cx - me.x, cz - me.z)),
        covered: Math.round(cover * 100)
      })
    }
  }
  const open = cand.filter(c => !c.used).sort((a, b) => (a.dist * (1 + a.covered / 50)) - (b.dist * (1 + b.covered / 50)))
  out.region = `${span}×${span} блоков, старт в окне ${win}×${win} у северо-западного угла${S.triangular ? ' (ближе к середине окна)' : ''}`
  out.here = cand.find(c => c.region === `${rx0},${rz0}`)
  out.next = open.slice(0, 4)
  if (S.share) out.share = S.share
  if (S.frequency) out.chance = `попытка удаётся в ${S.frequency * 100}% регионов`
  const b = biomeName(bot, me.floored ? me.floored() : me)
  if (K.biomes && b && !/^biome#/.test(b) && !K.biomes.test(b)) out.biomeNow = `здесь ${b} — ${K.ru} тут не растёт`
  out.text = `${K.ru}: регион ${out.region}. ${out.here && out.here.used ? 'В нашем регионе уже найдена — ищи в соседних. ' : ''}` +
    (out.next.length ? `Ближайшее окно без находки: ${out.next[0].x},${out.next[0].z} (${out.next[0].dist} бл., разведано ${out.next[0].covered}%).` : '')
  return out
}

function biomesText (kind) {
  const B = {
    desert_pyramid: 'desert', jungle_pyramid: 'jungle, bamboo_jungle', igloo: 'snowy_plains, snowy_slopes, snowy_taiga',
    swamp_hut: 'swamp', village: 'plains, meadow, desert, savanna, snowy_plains, taiga',
    ruined_portal: 'почти любой (7 вариантов: обычный, пустыня, джунгли, болото, горы, океан, Ад)',
    shipwreck: 'океаны (затонувший) и пляжи (на мели)', ocean_ruin: 'океаны: холодные — камень, тёплые — песчаник',
    monument: 'глубокие океаны', mansion: 'dark_forest, pale_garden', outpost: 'plains, desert, savanna, taiga, snowy, горы, cherry_grove',
    trial_chambers: 'почти все сухопутные и океаны, под землёй y -40..-20', ancient_city: 'deep_dark (под горами, y ≈ -52)',
    mineshaft: 'почти везде под землёй; в бесплодных землях — открытые, на поверхности', buried_treasure: 'beach, snowy_beach',
    fortress: 'все биомы Ада', bastion: 'все биомы Ада, кроме базальтовых дельт', end_city: 'end_highlands, end_midlands (внешние острова)',
    trail_ruins: 'тайга, старые леса, джунгли', dungeon: 'любой, под землёй', stronghold: 'любой, кольца от 0,0'
  }
  return B[kind]
}

// Что рядом стоит крюка (для директора): известные невзятые постройки этого
// измерения по пользе сейчас и расстоянию.
function opportunities (session, { radius = 192 }: any = {}) {
  const bot = session.bot
  const me = bot.entity.position
  const dim = dimOf(bot)
  const obsidian = count(bot, 'obsidian')
  const hasDiamondPick = count(bot, /^(diamond|netherite)_pickaxe$/) > 0
  const beds = count(bot, /_bed$/)
  const out = []
  for (const r of listOf(session)) {
    if (r.dim !== dim || r.done) continue
    const K = KINDS[r.kind]
    if (!K || K.handler === 'avoid') continue
    const dist = Math.round(flat(me, r))
    if (dist > radius) continue
    let prio = K.prio
    let why = K.value
    if (r.kind === 'ruined_portal' && !hasDiamondPick && obsidian < 10) { prio = 4; why = `обсидиан без алмазной кирки: в сундуке и рамке (есть ${obsidian} из 10) + огниво` }
    if (r.kind === 'village' && beds < 3) { prio = 4; why = `кровати (есть ${beds}, на дракона нужно 3+), еда, железо` }
    if (r.kind === 'end_city' && count(bot, 'elytra') === 0) { prio = 3; why = 'элитры на корабле' }
    const limit = prio >= 4 ? 192 : prio === 3 ? 160 : prio === 2 ? 96 : 40
    if (dist > limit) continue
    out.push({ ...describe(r, me), prio, why })
  }
  return out.sort((a, b) => b.prio - a.prio || a.dist - b.dist)
}

// ------------------------------------------------------------------ ценность

// Что брать из сундука и зачем — для победы в игре, а не «всё подряд».
const WANT = [
  [/^enchanted_golden_apple$/, 10, 'зачарованное золотое яблоко: сопротивление и поглощение — переживёт дракона'],
  [/^golden_apple$/, 9, 'золотое яблоко: реген и поглощение — спасает в бою и в лаве'],
  [/^totem_of_undying$/, 10, 'тотем: одна смерть отменяется'],
  [/^(diamond|diamond_block)$/, 9, 'алмазы: кирка на обсидиан, меч, броня'],
  [/^obsidian$/, 9, 'обсидиан: рамка портала в Ад (10 штук)'],
  [/^(flint_and_steel|fire_charge)$/, 9, 'зажечь портал в Ад'],
  [/^(ender_pearl|ender_eye)$/, 9, 'жемчуг: глаза Края — найти крепость и портал'],
  [/^(blaze_rod|blaze_powder)$/, 9, 'огненный порошок: глаза Края'],
  [/^elytra$/, 9, 'элитры'],
  [/^(bucket|water_bucket|lava_bucket)$/, 8, 'ведро: вода от падения и лавы, обсидиан из лавы'],
  [/^enchanted_book$/, 8, 'книга с чарами: на наковальне — защита, острота, эффективность'],
  [/^(iron_ingot|iron_block|raw_iron|iron_nugget)$/, 8, 'железо: ведро, щит, броня, кирка'],
  [/^(gold_ingot|gold_block|raw_gold|gold_nugget)$/, 7, 'золото: бартер с пиглинами (жемчуг), золотой шлем от пиглинов'],
  [/^(netherite_ingot|netherite_scrap|ancient_debris|netherite_upgrade_smithing_template)$/, 7, 'незерит — лучшая броня'],
  [/^(arrow|spectral_arrow|tipped_arrow)$/, 7, 'стрелы: кристаллы Края и дракон'],
  [/^(tnt|gunpowder)$/, 6, 'взрывчатка; порох — фейерверки для элитр'],
  [/^saddle$/, 6, 'седло: лошадь — втрое быстрее по миру'],
  [/^(emerald|emerald_block)$/, 6, 'изумруды: торговля с жителями (стрелы, броня, книги)'],
  [/^experience_bottle$/, 6, 'опыт на зачарование'],
  [/^magma_cream$/, 6, 'огнестойкость: Ад и лава'],
  [/^(golden_carrot|glistering_melon_slice)$/, 6, 'лучшая еда / зелье лечения'],
  [/^lapis_lazuli$/, 5, 'лазурит: стол зачарований'],
  [/^nether_wart$/, 5, 'нарост: основа зелий'],
  [/^(bread|cooked_[a-z_]+|baked_potato|apple|carrot|potato|beetroot|melon_slice|glow_berries|sweet_berries|pumpkin_pie|cookie|dried_kelp|mushroom_stew|beetroot_soup|rabbit_stew|wheat|hay_block|suspicious_stew)$/, 5, 'еда'],
  [/^(coal|charcoal|coal_block)$/, 4, 'уголь: факелы и печь'],
  [/^(crying_obsidian)$/, 3, 'якорь возрождения в Аду (для рамки портала не годится)'],
  [/^(filled_map)$/, 5, 'карта: крестик — клад (железо, TNT, изумруды)'],
  [/^(compass)$/, 3, 'компас'],
  [/^(string)$/, 3, 'нитки: лук, шерсть на кровать'],
  [/^(name_tag)$/, 2, 'бирка — слот дешёвый'],
  [/^(flint|feather)$/, 2, 'стрелы'],
  [/^(redstone|quartz|glowstone_dust|amethyst_shard)$/, 2, 'материал']
]
const LEAVE = /^(rotten_flesh|bone|bone_block|spider_eye|poisonous_potato|[a-z_]*_seeds|sand|red_sand|gravel|paper|book|moss_block|bamboo|pumpkin|music_disc_[a-z0-9_]+|disc_fragment_5|[a-z_]*horse_armor|[a-z_]*nautilus_armor|[a-z_]*_armor_trim_smithing_template|[a-z_]*banner_pattern|lodestone|bell|light_weighted_pressure_plate|clock|candle|sculk[a-z_]*|leather|lead|goat_horn|dark_oak_log|tripwire_hook|iron_chain|chain|echo_shard|soul_torch|resin_clump|bundle|[a-z_]*_sapling|stick|gilded_blackstone|rail|powered_rail|detector_rail|activator_rail|torch|prismarine_crystals|heart_of_the_sea|piglin_banner_pattern|potion)$/

const TIER = { wooden: 1, golden: 1, stone: 2, copper: 2, iron: 3, diamond: 4, netherite: 5 }
const ARMOR_TIER = { leather: 1, golden: 2, copper: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 }

function bestTier (bot, kind) {
  let t = 0
  const all = [...bot.inventory.items(), ...[5, 6, 7, 8, 45].map(s => bot.inventory.slots[s]).filter(Boolean)]
  for (const it of all) {
    const m = it.name.match(/^([a-z]+)_([a-z]+)$/)
    if (!m || m[2] !== kind) continue
    t = Math.max(t, (kind === 'helmet' || kind === 'chestplate' || kind === 'leggings' || kind === 'boots' ? ARMOR_TIER : TIER)[m[1]] || 0)
  }
  return t
}

function enchantsOf (it) {
  try { return (it.enchants || []).map(e => `${e.name}${e.lvl > 1 ? ' ' + e.lvl : ''}`) } catch { return [] }
}

// Решение по одному предмету: { take, prio, why }.
function decide (bot, it, ctx: any = {}) {
  const name = it.name
  const ench = enchantsOf(it)
  // Инструменты, оружие, броня — только если лучше своего (или золото от пиглинов).
  const gear = name.match(/^([a-z]+)_(pickaxe|axe|shovel|sword|spear|helmet|chestplate|leggings|boots|hoe)$/)
  if (gear) {
    const [, mat, kind] = gear
    if (kind === 'hoe') return { take: false, prio: 0, why: 'мотыга не нужна' }
    const armor = ['helmet', 'chestplate', 'leggings', 'boots'].includes(kind)
    const tier = (armor ? ARMOR_TIER : TIER)[mat] || 0
    const have = bestTier(bot, kind === 'spear' ? 'sword' : kind)
    if (armor && mat === 'golden' && !ctx.gold && count(bot, /^golden_(helmet|chestplate|leggings|boots)$/) === 0) {
      ctx.gold = true
      return { take: true, prio: 7, why: `золотая броня${ench.length ? ' с чарами' : ''}: хоть одна часть — и пиглины не нападают (бартер за жемчуг)` }
    }
    if (tier > have) return { take: true, prio: armor ? 8 : 7, why: `${armor ? 'броня' : 'инструмент'} лучше моего (${mat} против ${have ? 'уровня ' + have : 'ничего'})${ench.length ? ', чары: ' + ench.join(', ') : ''}` }
    if (ench.length && tier >= 3) return { take: true, prio: 5, why: `с чарами: ${ench.join(', ')}` }
    return { take: false, prio: 0, why: `не лучше своего (${mat})` }
  }
  if (/^(bow|crossbow|trident|fishing_rod|shield)$/.test(name)) {
    const have = count(bot, name)
    if (!have || ench.length) return { take: true, prio: 7, why: name === 'bow' || name === 'crossbow' ? 'стрельба по кристаллам Края' : name === 'shield' ? 'щит' : 'пригодится' }
    return { take: false, prio: 0, why: 'такой уже есть' }
  }
  for (const [re, prio, why] of (WANT as any)) {
    if (re.test(name)) {
      if (name === 'enchanted_book' && ench.length) return { take: true, prio, why: `${why} (${ench.join(', ')})` }
      return { take: true, prio, why }
    }
  }
  if (LEAVE.test(name)) return { take: false, prio: 0, why: 'хлам для победы' }
  const w = pack.worth(name)
  if (w >= 2) return { take: true, prio: 3, why: 'материал' }
  if (w === 0) return { take: false, prio: 0, why: 'хлам' }
  return { take: bot.inventory.emptySlotCount() > 8, prio: 1, why: 'мелочь — если есть место' }
}

// ------------------------------------------------------------------ чужой сундук

// Признаки руки игрока у сундука. kind — в какой постройке он стоит:
// кровати в деревне и рамка на корабле Края — свои у игры.
function playerMarks (bot, pos, kind = null) {
  const out = []
  const p = v3(pos)
  const near = (re, r) => {
    try { return bot.findBlock({ matching: b => !!b && re.test(b.name), maxDistance: r, point: p }) } catch { return null }
  }
  if (near(/_sign$|_hanging_sign$/, 4)) out.push('табличка рядом')
  if (near(/^(ender_chest|[a-z_]*shulker_box|anvil|chipped_anvil|damaged_anvil|enchanting_table|beacon|jukebox|respawn_anchor)$/, 4)) out.push('эндер-сундук/шалкер/наковальня/стол чар рядом')
  const below = bot.blockAt(p.offset(0, -1, 0))
  const above = bot.blockAt(p.offset(0, 1, 0))
  if ((below && below.name === 'hopper') || (above && above.name === 'hopper')) out.push('воронка у сундука (сортировка)')
  if (kind !== 'village' && kind !== 'igloo' && near(/_bed$/, 5)) out.push('кровать рядом — не деревня')
  if (kind !== 'end_city') {
    for (const e of ((Object.values(bot.entities) as any[]) as any)) {
      if (e && /item_frame$|^armor_stand$/.test(e.name || '') && e.position && e.position.distanceTo(p) < 4) { out.push('рамка/стойка рядом'); break }
    }
  }
  return out
}

// ------------------------------------------------------------------ тело

function armTraps (session) {
  const bot = session.bot
  try { session.updateMovements() } catch {}
  const m = bot.pathfinder && bot.pathfinder.movements
  if (!m || !m.blocksToAvoid) return
  for (const n of TRAP_BLOCKS) {
    const b = bot.registry.blocksByName[n]
    if (b) m.blocksToAvoid.add(b.id)
  }
}

async function walk (session, ctl, goal, ms) {
  const bot = session.bot
  if (ctl.aborted) throw new Error('прервано')
  armTraps(session)
  const stop = () => { try { bot.pathfinder.setGoal(null) } catch {} }
  ctl.onAbort.push(stop)
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, `не дошёл за ${Math.round(ms / 1000)} с`)
  } finally {
    stop()
  }
}

function canReach (bot, pos, reach = 4.3) {
  return v3(pos).offset(0.5, 0.5, 0.5).distanceTo(require('./pick').eyeOf(bot)) <= reach
}

// Сломать блок: подойти, взять лучший инструмент (или названный), копать.
// Копать — только то, что в прицеле (AGENTS.md: не сквозь стены; ревью Codex q2: копка доски за камнем уходила): точка
// контура блока, до которой луч из глаз не упирается ни в блок (стекло тоже, для действия), ни в живое; на неё взгляд, копка
// без своего доворота mineflayer. Без контура (посевы, трава) — луч в клетку (eyes.seesNow). walkMs ≤ 1 — не ходить.
async function digAt (session, ctl, pos, { tool = null, maxMs = 15000, walkMs = 25000 }: any = {}) {
  const bot = session.bot
  const pick = require('./pick')
  const p = v3(pos).floored()
  if (ctl.aborted) return { ok: false, why: 'прервано' }
  const aimAt = () => pick.blockAim(bot, p, { range: 4.5, seeThrough: null }) || (require('./perception/eyes').seesNow(bot, p) ? p.offset(0.5, 0.5, 0.5) : null)
  const ready = () => canReach(bot, p) && !!aimAt()
  if (!ready() && walkMs > 1) {
    for (const g of [() => new goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), () => new goals.GoalNear(p.x, p.y, p.z, 2)]) {
      if (ctl.aborted) break
      try { await walk(session, ctl, g(), walkMs) } catch {}
      if (ready()) break
    }
  }
  if (!canReach(bot, p)) return { ok: false, why: 'не дотянуться' }
  if (!aimAt()) return { ok: false, why: 'не в прицеле' }
  const b = bot.blockAt(p)
  if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'water') return { ok: true, name: b && b.name }
  const name = b.name
  try {
    const it = tool ? bot.inventory.items().find(i => i.name === tool) : require('./tools').bestFor(bot, b).item
    if (it && (!bot.heldItem || bot.heldItem.name !== it.name)) await bot.equip(it, 'hand')
  } catch {}
  // Прервали (сторож воздуха, бой) — копку бросить сразу, а не докапывать секундами под водой.
  let digging = false
  const stop = () => { if (digging) { try { bot.stopDigging() } catch {} } }
  if (Array.isArray(ctl.onAbort)) ctl.onAbort.push(stop)
  try {
    if (ctl.aborted) return { ok: false, name, why: 'прервано' }
    const aim = aimAt() // после экипировки — заново: тело могло сдвинуться
    if (!aim) return { ok: false, name, why: 'не в прицеле' }
    await bot.lookAt(aim, true)
    if (ctl.aborted) return { ok: false, name, why: 'прервано' }
    digging = true
    await withTimeout(bot.dig(b, 'ignore', undefined, ctl), maxMs, 'копал слишком долго')
  } catch (e) { return { ok: false, name, why: e.message } } finally {
    stop()
    const i = Array.isArray(ctl.onAbort) ? ctl.onAbort.indexOf(stop) : -1
    if (i >= 0) ctl.onAbort.splice(i, 1)
  }
  const now = bot.blockAt(p)
  return { ok: !now || now.name !== name, name }
}

async function pickUp (bot, ctl, radius = 6, ms = 6000) {
  try { return await require('./actions').collectNearbyDrops(bot, ctl, { radius, timeoutMs: ms }) } catch { return null }
}

function hostileNear (bot, r = 10) {
  try { return require('./combat').nearestHostile(bot, r) } catch { return null }
}

// Зачистить мобов вокруг (спавнер данжа): бить, пока есть кого, но не
// ниже 8 хп. combat.fight сам выбирает оружие и щит.
async function clearMobs (session, ctl, out, { radius = 12, rounds = 4 }: any = {}) {
  const bot = session.bot
  const combat = require('./combat')
  for (let i = 0; i < rounds && !ctl.aborted; i++) {
    const e = hostileNear(bot, radius)
    if (!e) break
    if ((bot.health ?? 20) < 8) { out.lines.push(`⚠ ${Math.round(bot.health)} хп — с мобами у спавнера не дерусь`); return false }
    // Пиглины в бастионе — не цель: драка поднимет весь бастион.
    if (/^(piglin|piglin_brute|zombified_piglin|enderman)$/.test(e.name)) break
    try {
      const r = await combat.fight(session, ctl, { target: e.name, timeoutSeconds: 30, clearArea: radius, retreatAtHealth: 7 })
      out.fought.push(`${e.name}${r && (r.killed || (r.kills && r.kills.length)) ? ' убит' : ''}`)
    } catch (err) { out.fought.push(`${e.name}: ${err.message}`); break }
  }
  return true
}

// ------------------------------------------------------------------ лут

function lootedSet (session) {
  const s = session.journal.state
  return new Set(Array.isArray(s.looted) ? s.looted : [])
}

function markLooted (session, key) {
  session.journal.patch(s => {
    if (!s.looted) s.looted = []
    if (!s.looted.includes(key)) s.looted.push(key)
    if (s.looted.length > 500) s.looted.splice(0, s.looted.length - 500)
  })
}

// Пиглины, которые увидят, как открываем сундук (куб ±16 и луч).
function piglinsWatching (bot) {
  const me = bot.entity.position
  const eye = eyePos(bot)
  return (Object.values(bot.entities) as any[]).filter((e : any) => e && /^piglin(_brute)?$/.test(e.name || '') && e.position &&
    Math.abs(e.position.x - me.x) <= 16.3 && Math.abs(e.position.y - me.y) <= 16.9 && Math.abs(e.position.z - me.z) <= 16.3 &&
    raySees(bot, e.position.offset(0, 1.6, 0), eye))
}

// Пиглины, которых разозлит сломанный золотой блок: ВСЕ в ±16, без луча
// (Block.playerWillDestroy → PiglinAi.angerNearbyPiglins(level, player, false);
// исходники 1.21.11, 2026-09-26). Для сундука взгляд нужен, для блока — нет.
function piglinsNear (bot) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'piglin' && e.position &&
    Math.abs(e.position.x - me.x) <= 16.3 && Math.abs(e.position.y - me.y) <= 16.9 && Math.abs(e.position.z - me.z) <= 16.3)
}

// Под водой: голова в воде и воздуха мало — всплыть и отдышаться.
// Воздух 0..20. mineflayer 4.37 кладёт в oxygenLevel то сырые тики
// метаданных (0..300), то уже делённые на 15 — приводим к 0..20.
function air (bot) {
  const v = bot.oxygenLevel ?? 20
  return v > 20 ? v / 15 : v
}

function headWet (bot) {
  const b = bot.blockAt(require('./pick').eyeOf(bot))
  return !!b && (b.name === 'water' || b.name === 'bubble_column' || b.name === 'kelp' || b.name === 'kelp_plant' || b.name === 'seagrass' || b.name === 'tall_seagrass' || b.getProperties?.().waterlogged === true)
}

// Где голова последний раз была над водой — путь наверх из трюма (прыжок упирается в палубу: ферма 14.10, корабль
// 115,-89 — утонул под палубой у сундука карты).
// Под водой — след пути (точка раз в 5 тиков, через 0.8 бл.): наверх тем же путём, каким пришёл (он проходим).
function trackAir (bot) {
  if (!bot || bot._ndAirTrack || typeof bot.on !== 'function') return
  bot._ndAirTrack = true
  let n = 0
  bot.on('physicsTick', () => {
    try {
      if (!bot.entity) return
      const p = bot.entity.position
      if (!headWet(bot)) {
        bot._ndLastAir = p.clone()
        bot._ndTrail = []
        // Над водой по-настоящему (голова в воздухе, не в двери кармана) — поверхность.
        const head = bot.blockAt(p.offset(0, bot.entity.eyeHeight || 1.62, 0))
        if (head && /air$/.test(head.name)) bot._ndSurface = p.clone()
        return
      }
      if (++n % 5) return
      const t = bot._ndTrail || (bot._ndTrail = [])
      if (!t.length || t[t.length - 1].distanceTo(p) > 0.8) t.push(p.clone())
      if (t.length > 240) t.shift()
    } catch {}
  })
}
// Над глазами до последней сухой точки — только вода (видно: столб прямо над головой) — всплыть можно отвесно.
function openAbove (bot) {
  const top = bot._ndLastAir ? bot._ndLastAir.y + 1.62 : null
  if (top === null) return false
  const e = require('./pick').eyeOf(bot)
  for (let y = Math.floor(e.y) + 1; y <= Math.floor(top); y++) {
    const b = bot.blockAt(new Vec3(Math.floor(e.x), y, Math.floor(e.z)))
    if (!b || !(WET.test(b.name) || /air$/.test(b.name))) return false
  }
  return true
}
// Длина обратного пути по следу до воздуха (бл.).
function trailLength (bot) {
  const t = bot._ndTrail || []
  let s = t.length && bot._ndLastAir ? t[0].distanceTo(bot._ndLastAir) : 0 // первый отрезок — от последней сухой точки
  for (let i = 1; i < t.length; i++) s += t[i].distanceTo(t[i - 1])
  return s + (t.length ? t[t.length - 1].distanceTo(bot.entity.position) : 0)
}
// По следу назад: к каждой точке — взглядом и шагом (вверх — прыжок, вниз — присед), пока голова под водой.
async function retrace (bot, ctl, ms) {
  // С последней сухой точкой: след начинается уже под водой, до воздуха — ещё отрезок (ревью Codex q2).
  const t = [...(bot._ndLastAir ? [bot._ndLastAir.clone()] : []), ...(bot._ndTrail || [])]
  const t0 = gameClock.now()
  try {
    for (let i = t.length - 1; i >= 0 && !ctl.aborted && headWet(bot) && gameClock.now() - t0 < ms; i--) {
      const q = t[i]
      const ts = gameClock.now()
      while (!ctl.aborted && headWet(bot) && bot.entity.position.distanceTo(q) > 0.3 && gameClock.now() - ts < 1500 && gameClock.now() - t0 < ms) {
        const p = bot.entity.position
        try { await bot.lookAt(q.offset(0, 1.6, 0), true) } catch {}
        bot.setControlState('forward', Math.hypot(q.x - p.x, q.z - p.z) > 0.3)
        bot.setControlState('jump', q.y > p.y - 0.2)
        bot.setControlState('sneak', q.y < p.y - 0.8)
        await sleep(100, ctl)
      }
    }
  } finally { for (const k of ['forward', 'jump', 'sneak']) bot.setControlState(k, false) }
}
async function breathe (bot, ctl, ms = 15000, session = null) {
  if (ctl.aborted) return false
  try { bot.pathfinder.setGoal(null) } catch {}
  trackAir(bot)
  const t0 = gameClock.now()
  // Свой карман (дверь) рядом и след ведёт к нему — туда, а не наверх через всю толщу.
  const pk = bot._ndPocket
  if (pk && headWet(bot) && bot.entity.position.distanceTo(pk) < 10 && /_door$/.test((bot.blockAt(pk) || {}).name || '') && (bot._ndTrail || []).length) {
    await retrace(bot, ctl, Math.min(ms, 6000))
    if (!headWet(bot)) {
      const t1 = gameClock.now()
      while (!ctl.aborted && gameClock.now() - t1 < 5000 && air(bot) < 19 && !headWet(bot)) await sleep(150, ctl)
      return !ctl.aborted && air(bot) >= 17
    }
  }
  if (ctl.aborted) return false
  bot.setControlState('jump', true)
  try {
    let lastY = bot.entity.position.y
    let still = gameClock.now()
    let retraced = false
    while (!ctl.aborted && gameClock.now() - t0 < ms && headWet(bot)) {
      await sleep(100, ctl)
      if (ctl.aborted) break
      if (bot.entity.position.y > lastY + 0.1) { lastY = bot.entity.position.y; still = gameClock.now() }
      // Вверх не идёт — над головой палуба: назад по следу (им пришёл), не вышло — плыть к месту, где голова была над
      // водой (swimTo копает, что на пути).
      if (gameClock.now() - still > 600) {
        bot.setControlState('jump', false)
        if (!retraced && (bot._ndTrail || []).length) { retraced = true; await retrace(bot, ctl, Math.max(0, ms - (gameClock.now() - t0))) }
        else if (session && bot._ndLastAir) await swimTo(session, ctl, bot._ndLastAir.offset(0, 1, 0), { reach: 1.2, ms: Math.max(0, ms - (gameClock.now() - t0)) })
        if (ctl.aborted) break
        bot.setControlState('jump', true)
        still = gameClock.now()
        lastY = bot.entity.position.y
      }
    }
    const t1 = gameClock.now()
    // Ждать воздух у поверхности. На плаву голова качается — то над водой, то под ней (ферма 14.10, корабль −220,−952:
    // «прервано» на каждом нырке); под водой дольше 1 с — снова тонем, ждать нечего (ревью Codex q2: удушье в ожидании).
    let wetSince = null
    while (!ctl.aborted && gameClock.now() - t1 < 5000 && air(bot) < 19) {
      if (!headWet(bot)) wetSince = null
      else if (wetSince === null) wetSince = gameClock.now()
      else if (gameClock.now() - wetSince > 1000) break
      await sleep(200, ctl)
    }
    if (process.env.ND_DEBUG_AIR) console.log('[breathe]', JSON.stringify({ air: air(bot), aborted: !!ctl.aborted, wet: headWet(bot), waited: gameClock.now() - t1, total: gameClock.now() - t0 }))
  } finally { bot.setControlState('jump', false) }
  return !ctl.aborted && air(bot) >= 17
}

const WET = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/
function wetAt (bot, p) { const b = bot.blockAt(p); return !!b && WET.test(b.name) }
// Цель под водой: вода рядом с ней или в столбе над ней (сундук в трюме —
// над ним палуба, а выше вода). Мы в воде: по щиколотку, по пояс, по голову.
function underwater (bot, pos) {
  const p = v3(pos).floored()
  // Только видимое (ревью Codex q2: соседи цели и столб над ней читались сквозь палубу).
  const eyes = require('./perception/eyes')
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = p.offset(dx, 0, dz); if (eyes.seesNow(bot, q) && wetAt(bot, q)) return true }
  for (let dy = 1; dy <= 16; dy++) {
    const q = p.offset(0, dy, 0)
    if (!eyes.seesNow(bot, q)) continue
    if (wetAt(bot, q)) return true
    const b = bot.blockAt(q)
    if (!b || b.name === 'air' || b.name === 'cave_air') return false
  }
  return false
}
function swimming (bot) { const f = bot.entity.position.floored(); return wetAt(bot, f) || wetAt(bot, f.offset(0, 1, 0)) || headWet(bot) || !!bot.entity.isInWater }

// Плыть к точке без pathfinder'а: под водой он не находит путь («Took to
// long to decide path», корабль 2026-09-25). Смотреть на цель, вперёд;
// ниже — присесть (тонуть), выше — прыжок (всплывать). Упёрся — сломать,
// что между нами (обшивка корабля).
async function swimTo (session, ctl, pos, { reach = 4, ms = 25000 }: any = {}) {
  const bot = session.bot
  trackAir(bot)
  const aim = v3(pos).floored()
  const target = aim.offset(0.5, 0.5, 0.5)
  const t0 = gameClock.now()
  let best = Infinity
  let bestAt = gameClock.now()
  const off = () => { for (const c of ['forward', 'sneak', 'jump']) bot.setControlState(c, false) }
  // Присесть в воде — тонуть быстрее (ванильный LivingEntity.goDownInWater:
  // -0.04 к скорости за тик); prismarine-physics этого не умеет, добавляем.
  const dive = () => { if (bot.controlState.sneak && bot.entity.isInWater) bot.entity.velocity.y -= 0.04 }
  bot.on('physicsTick', dive)
  let orig = null
  if (process.env.ND_DEBUG_STRUCT) {
    orig = bot.setControlState
    bot.setControlState = function (c, v) { if (c === 'jump' && v) console.log('[swim] jump by', new Error().stack.split(String.fromCharCode(10)).slice(2, 5).join(' | ')); return orig.call(this, c, v) }
  }
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      const eye = bot.entity.position.offset(0, 1.62, 0)
      if (eye.distanceTo(target) <= reach) return true
      try { await bot.lookAt(target, true) } catch {}
      const dy = target.y - eye.y
      const flatD = Math.hypot(target.x - eye.x, target.z - eye.z)
      // Как человек: поверху — до точки над целью (воздух не тратится),
      // потом отвесно вниз. Под водой плывём ~0.6 бл/с, воздуха на 15 с. Уже на глубине — прямо к цели, не
      // всплывая (ферма 14.10: между сундуками корабля в 20 бл. вверх-вниз — воздух кончился на полпути).
      const surf = bot._ndSurface || bot._ndLastAir
      const deep = !!surf && surf.y - bot.entity.position.y > 3 && dy < 3
      const above = flatD <= 2.5 || deep
      bot.setControlState('forward', flatD > 0.7)
      bot.setControlState('sneak', above && dy < -0.8)
      bot.setControlState('jump', (!above && headWet(bot)) || dy > 0.3)
      await sleep(250, ctl)
      const now = bot.entity.position
      const d = now.offset(0, 1.62, 0).distanceTo(target)
      if (process.env.ND_DEBUG_STRUCT) console.log('[swim]', now.x.toFixed(1), now.y.toFixed(1), now.z.toFixed(1), 'dy', dy.toFixed(1), 'flat', flatD.toFixed(1), 'air', air(bot).toFixed(1))
      if (d < best - 0.4) { best = d; bestAt = gameClock.now() }
      // Полторы секунды без продвижения — упёрся: сломать, что между нами
      // (луч к цели), а нет — что перед ногами/головой по курсу.
      if (gameClock.now() - bestAt > 1500) {
        off()
        bestAt = gameClock.now()
        const dir = target.minus(eye).normalize()
        let hit = null
        try { const h = require('./pick').blockOnRay(bot, require('./pick').eyeOf(bot), dir, 4.5); hit = h && !h.pos.equals(aim) ? h.block : null } catch {}
        if (!hit || !canReach(bot, hit.position, 4.5)) {
          const yaw = Math.atan2(target.x - now.x, target.z - now.z)
          const ahead = now.offset(Math.sin(yaw) * 0.9, 0, Math.cos(yaw) * 0.9).floored()
          for (const q of [ahead.offset(0, 1, 0), ahead, dy < -0.8 ? now.floored().offset(0, -1, 0) : null]) {
            const b = q && require('./pick').blockSeen(bot, q, { range: 4.5 }) ? bot.blockAt(q) : null
            if (b && b.boundingBox === 'block' && !b.position.equals(aim)) { hit = b; break }
          }
        }
        if (hit && NO_DIG.test(hit.name)) return false
        if (hit && canReach(bot, hit.position, 4.5)) {
          // Под водой копается впятеро дольше (без «Подводника»), а на плаву — ещё впятеро (Player.getDestroySpeed:
          // в воде ×0.2, не на земле ×0.2): сперва осесть на дно или палубу (присесть — тонуть), потом копать.
          // Присед держать и всю копку: отпущенный — тело всплывает с опоры (ферма 14.10, палуба на 51: y 52 → 52.4).
          const wetDig = bot.entity.isInWater
          if (wetDig) {
            bot.setControlState('sneak', true)
            const ts = gameClock.now()
            while (!ctl.aborted && !bot.entity.onGround && gameClock.now() - ts < 1500) await sleep(100, ctl)
          }
          // Копка — в остаток времени и воздуха (1 из 20 ≈ 0.75 с; ревью Codex q2: спасательный заплыв копал 20 с без сторожа).
          const budget = Math.min(20000, ms - (gameClock.now() - t0), headWet(bot) ? Math.max(0, (air(bot) - 2) * 750) : Infinity)
          if (ctl.aborted || budget <= 0) { bot.setControlState('sneak', false); return false }
          const r = await digAt(session, ctl, hit.position, { maxMs: budget, walkMs: 0 })
          if (wetDig) bot.setControlState('sneak', false)
          if (process.env.ND_DEBUG_STRUCT) console.log('[swim] dig', hit.name, hit.position.toString(), JSON.stringify(r))
        } else { bot.setControlState('jump', true); await sleep(400, ctl) }
      }
    }
  } finally {
    off()
    bot.removeListener('physicsTick', dive)
    if (orig) bot.setControlState = orig
  }
  return bot.entity.position.offset(0, 1.62, 0).distanceTo(target) <= reach
}

// Дочернее «прервать»: снаружи рвёт родитель, изнутри — сторож воздуха.
function childCtl (ctl) {
  const sub: any = { aborted: false, onAbort: [] }
  sub.abort = () => {
    if (sub.aborted) return
    sub.aborted = true
    for (const fn of sub.onAbort) { try { fn() } catch {} }
  }
  ctl.onAbort.push(() => sub.abort())
  if (ctl.aborted) sub.abort()
  return sub
}

// Работа под водой нырками: воздуха (300 тиков = 15 с, LivingEntity.decreaseAirSupply) осталось на подъём с запасом —
// сторож рвёт работу, всплыть, отдышаться, снова (до dives раз). Тактика Surface на это время — последний рубеж (≤ 4 из
// 20, флаг session._airManaged; без него ≤ 8 рвала навык целиком: ферма 14.10, корабли 115,-89 и −224,−960). fn(sub) —
// сама работа; итог — последней попытки.
async function withAir (session, ctl, fn, dives = 3) {
  const was = session._airManaged
  try { return await withAirBody(session, ctl, fn, dives) } finally { session._airManaged = was || false }
}
async function withAirBody (session, ctl, fn, dives) {
  const bot = session.bot
  trackAir(bot)
  let lastErr = null
  for (let dive = 0; dive < dives && !ctl.aborted; dive++) {
    // Нырок — только с полным воздухом (всплыл на 12 из 20 и сразу вниз — ферма 14.10: тактика Surface на полпути).
    // Не набрал воздух — работу не начинать (ревью Codex q2: после неудачного breathe нырок шёл с пустыми лёгкими).
    if (air(bot) < 17 && (headWet(bot) || swimming(bot)) && !await breathe(bot, ctl, 15000, session)) return null
    if (ctl.aborted) return null
    const sub: any = childCtl(ctl)
    let drowning = false
    // Порог — по глубине: подъём прыжком ~3.2 бл/с (ферма 14.10: 52 → 62 за 3.1 с; 1 из 20 воздуха = 0.75 с), на реакцию
    // 0.5 с, наверх — с запасом над последним рубежом тактики. Пока нырок под этим сторожем, тактика Surface ждёт до ≤ 4
    // (session._airManaged, tactics/minecraft.ts; без флага — ≤ 8 и обрыв навыка: на 9–13 бл. оставалось ~1.5 с работы).
    session._airManaged = true
    const guard = gameClock.setInterval(() => {
      if (process.env.ND_DEBUG_AIR) console.log('[air]', JSON.stringify({ air: air(bot), raw: bot.oxygenLevel, wet: headWet(bot), y: Math.round(bot.entity.position.y * 10) / 10, last: bot._ndLastAir && Math.round(bot._ndLastAir.y) }))
      if (!headWet(bot)) return
      const depth = bot._ndLastAir ? Math.max(0, bot._ndLastAir.y - bot.entity.position.y) : 8
      // С дверью — раньше на 2.5 (≈2 с): поставить карман, пока до порога тактики далеко.
      const door = depth >= 5 && process.env.ND_AIR_POCKET === '1' && bot.inventory.items().some(i => /_door$/.test(i.name) && i.name !== 'iron_door')
      // Обратный путь по следу (под палубой он длиннее глубины): ~2.5 бл/с.
      // Над головой до поверхности открытая вода — наверх отвесно (порог по глубине); нет — назад по следу. По следу
      // для отвесного нырка — та же глубина, но по 0.53 за блок: у сундука на 12 бл. сторож рвал копку палубы сразу
      // по прибытии (ферма 14.10, корабль −220,49,−952: 4 нырка — «прервано»).
      const back = openAbove(bot) ? 0 : Math.min(17, 6 + 0.53 * trailLength(bot))
      if (air(bot) < Math.max(7, 6 + 0.42 * depth, back) + (door ? 2.5 : 0)) {
        drowning = true
        sub.abort()
        try { bot.stopDigging() } catch {} // копка под водой — секунды; бросить сразу
      }
    }, 200)
    let res
    try {
      res = await fn(sub)
    } catch (e) {
      lastErr = e
      if (!drowning) throw e
    } finally { gameClock.clearInterval(guard) }
    if (ctl.aborted) return null
    // Дело сделано под водой — наверх сразу, пока воздуха больше порога тактики.
    if (!drowning) { if (air(bot) < 16 && (headWet(bot) || swimming(bot))) await breathe(bot, ctl, 15000, session); return res }
    // Глубоко и есть дверь — карман воздуха на месте (дверь в воде не заливается: голова в её клетке дышит), не подъём.
    if (!await airPocket(session, ctl) && !await breathe(bot, ctl, 15000, session)) return null
    if (dive === dives - 1 && res !== undefined) return res
  }
  if (lastErr) throw lastErr
  return null
}

// Карман воздуха под водой: дверь в соседнюю клетку на дне (DoorBlock не заливается водой: в его клетках воды нет, и
// голова в них дышит — LivingEntity.isEyeInFluid), открыть (закрытая — стенка между нами), шагнуть в неё и отдышаться.
// Только стоя на твёрдом и глубже 5 бл.: мельче — быстрее всплыть. Клетки соседей: вода в обеих (видны — рядом с телом),
// твёрдое под ними. true — воздух набран.
async function airPocket (session, ctl) {
  const bot = session.bot
  // ND_AIR_POCKET=1 — включить (ферма 14.10: карман дверью вышел 1 раз из 3, два раза — смерть под водой; без него глубже 16 не ныряю).
  if (ctl.aborted || process.env.ND_AIR_POCKET !== '1') return false
  const door = bot.inventory.items().find(i => /_door$/.test(i.name) && i.name !== 'iron_door')
  const surf = bot._ndSurface || bot._ndLastAir
  const depth = surf ? surf.y - bot.entity.position.y : 0
  if (!door || !bot.entity.onGround || !headWet(bot) || depth < 5) return false
  // Свой карман рядом — к нему (breathe идёт по следу), новую дверь не тратить.
  const pk = bot._ndPocket
  if (pk && bot.entity.position.distanceTo(pk) < 10 && (!require('./perception/eyes').seesNow(bot, pk) || /_door$/.test((bot.blockAt(pk) || {}).name || ''))) return false
  const feet = bot.entity.position.floored()
  const isWater = p => { const b = bot.blockAt(p); return !!b && b.name === 'water' }
  const cells = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const q = feet.offset(dx, 0, dz)
    // Соседние клетки и опора под ними — только видимые (ревью Codex q2).
    if (!require('./perception/eyes').seesNow(bot, q) || !require('./perception/eyes').seesNow(bot, q.offset(0, 1, 0))) continue
    if (!require('./pick').faceAim(bot, q.offset(0, -1, 0), new Vec3(0, 1, 0))) continue
    const under = bot.blockAt(q.offset(0, -1, 0))
    if (isWater(q) && isWater(q.offset(0, 1, 0)) && under && under.boundingBox === 'block' && !NO_DIG.test(under.name)) cells.push({ q, under })
  }
  if (!cells.length) return false
  let placed = false
  let cell = null
  try {
    await bot.equip(door, 'hand')
    // Стенка закрытой двери встаёт у ближнего края её клетки (DoorBlock.getShape по взгляду ставящего): тело — в середину
    // своей клетки, иначе рамка задевает стенку и сервер дверь не ставит.
    const mid = feet.offset(0.5, 0, 0.5)
    for (let i = 0; i < 10 && Math.hypot(bot.entity.position.x - mid.x, bot.entity.position.z - mid.z) > 0.12; i++) {
      await bot.lookAt(mid.offset(0, 1.5, 0), true)
      bot.setControlState('forward', true); await sleep(60); bot.setControlState('forward', false); await sleep(60)
    }
    for (const c of cells) {
      await bot.lookAt(c.under.position.offset(0.5, 1, 0.5), true)
      const ok = await Promise.race([bot.placeBlock(c.under, new Vec3(0, 1, 0)).then(() => true, () => false), sleep(1200).then(() => false)])
      const d = bot.blockAt(c.q)
      if (ok || (d && /_door$/.test(d.name))) { placed = true; cell = c; break }
    }
    if (!placed) return false
    const d = bot.blockAt(cell.q)
    if (d && /_door$/.test(d.name) && String(d.getProperties().open) === 'false') { await bot.activateBlock(d); await sleep(250) }
    // В клетку двери: шаг к её середине, пока голова не в ней.
    const c = cell.q.offset(0.5, 0, 0.5)
    const t1 = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t1 < 2500 && headWet(bot)) {
      await bot.lookAt(c.offset(0, 1.6, 0), true)
      bot.setControlState('forward', Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z) > 0.15)
      await sleep(100)
    }
  } catch {} finally { bot.setControlState('forward', false) }
  const t0 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t0 < 6000 && air(bot) < 19) await sleep(150)
  const ok = air(bot) >= 19
  if (ok) bot._ndPocket = cell.q.clone()
  try { session.journal.append('под водой', `карман воздуха дверью на ${cell.q.x},${cell.q.y},${cell.q.z} (глубина ${Math.round(depth)}): ${placed ? '' : 'дверь не встала, '}${ok ? 'воздух набран' : 'не помогло'}`, bot.entity.position) } catch {}
  return ok
}

// Двери на карманы воздуха — до глубокого нырка (6 досок → 3 двери на верстаке; actions.craft сам ставит и забирает стол).
async function ensureDoors (session, ctl) {
  const bot = session.bot
  if (bot.inventory.items().some(i => /_door$/.test(i.name) && i.name !== 'iron_door')) return true
  for (const w of WOODS) {
    if (count(bot, `${w}_planks`) < 6 && count(bot, new RegExp(`^(stripped_)?${w}_(log|wood)$`)) < 2) continue
    try { await require('./actions').craft(session, ctl, { item: `${w}_door`, count: 3 }); if (count(bot, `${w}_door`) > 0) return true } catch {}
  }
  return false
}

// Открыть сундук, взять ценное по decide(), хлам оставить. Отчёт с «зачем».
// Под водой — до трёх нырков: воздуха меньше 7 из 20 — всплыть, отдышаться.
async function takeWorth (session, ctl, pos, opts: any = {}) {
  const r = await withAir(session, ctl, sub => takeOnce(session, sub, pos, opts))
  if (!r) throw new Error('прервано')
  return r
}

// Довести клетку шаблона до вида: подойти (по воде — вплавь) и копать то, что прицел видит на луче к ней, пока сама
// клетка не окажется в прицеле на досягаемости (pick.blockSeen — как клиент). Скрытое не читается: копается только
// первый блок на луче (виден), ловушки (TNT, нажимная плита, растяжка), лава и спавнер — не копаются.
const NO_DIG = /^(tnt|stone_pressure_plate|tripwire|tripwire_hook|lava|bedrock|spawner|trial_spawner|chest|trapped_chest|barrel)$/
async function digToSee (session, ctl, pos, { ms = 60000, wet = false }: any = {}) {
  const bot = session.bot
  const pick = require('./pick')
  const p = v3(pos).floored()
  const t0 = gameClock.now()
  const left = () => ms - (gameClock.now() - t0)
  const seen = () => !!pick.blockAim(bot, p, { range: 4.5, seeThrough: null })
  let stuck = 0
  for (let i = 0; i < 40 && !ctl.aborted && left() > 0; i++) {
    if (seen()) return true
    if (wet || swimming(bot)) {
      await swimTo(session, ctl, p, { reach: 3.6, ms: Math.min(30000, left()) })
      if (seen()) return true
      if (++stuck > 3) break
      continue
    }
    const eye = pick.eyeOf(bot)
    const c = p.offset(0.5, 0.5, 0.5)
    const d = c.minus(eye)
    const len = d.norm()
    if (len > 4.4) {
      const before = bot.entity.position.clone()
      try { await walk(session, ctl, new goals.GoalNear(p.x, p.y, p.z, stuck ? 1 : 2), Math.min(30000, left())) } catch {}
      if (bot.entity.position.distanceTo(before) < 0.5 && ++stuck > 2) break
      continue
    }
    const hit = pick.blockOnRay(bot, eye, d.scaled(1 / len), len + 0.5)
    if (!hit || hit.pos.equals(p)) return seen()
    if (NO_DIG.test(hit.block.name)) {
      try { await walk(session, ctl, new goals.GoalNear(p.x, p.y, p.z, 1), Math.min(15000, left())) } catch {}
      if (++stuck > 2) break
      continue
    }
    const r = await digAt(session, ctl, hit.pos, { maxMs: 12000, walkMs: 1 })
    if (!r.ok && ++stuck > 3) break
  }
  return seen()
}

// Копать под собой, пока под ногами не сундук: копается только блок под ногами (виден), ловушки и жидкость — стоп.
// { chest: Vec3 } или { stopped }, dug — сколько выкопал.
async function digDown (session, ctl, { maxDepth = 16 }: any = {}) {
  const bot = session.bot
  let dug = 0
  for (let k = 0; k < maxDepth + 4 && !ctl.aborted; k++) {
    const f = bot.entity.position.floored()
    // Под ногами — первый контур вертикального луча из глаз (ревью Codex q2: стоя на сундуке, верх 0.875, «floored − 1»
    // читал скрытый блок под ним); так же ковёр и плита у ног.
    const under = require('./pick').blockOnRay(bot, require('./pick').eyeOf(bot), new Vec3(0, -1, 0), 4.5)?.block || null
    if (!under) return { stopped: 'чанк не прогружен', dug }
    if (/^(chest|trapped_chest|barrel)$/.test(under.name)) {
      // Луч видит сундук ещё в падении (до него 2–4 бл.): дождаться опоры — плита камеры храма видна только стоя на нём
      // (ферма 14.10, храм 24,53,170: «плита цела», сундук «отсюда не дотянуться» — тело ещё летело в колодце).
      const t1 = gameClock.now()
      while (!ctl.aborted && !bot.entity.onGround && gameClock.now() - t1 < 2500) await sleep(80, ctl)
      return { chest: under.position, dug }
    }
    if (/water|lava/.test(under.name)) return { stopped: `под ногами ${under.name} — не копаю`, dug }
    if (NO_DIG.test(under.name)) return { stopped: `под ногами ${under.name} — не копаю`, dug }
    if (dug >= maxDepth) return { stopped: `глубже ${maxDepth} не копаю`, dug }
    if (under.boundingBox !== 'empty') {
      const r = await digAt(session, ctl, under.position, { maxMs: 8000, walkMs: 1 })
      if (!r.ok) return { stopped: `не копается ${under.name}: ${r.why || '?'}`, dug }
      dug++
    }
    // Дождаться падения на клетку ниже.
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && bot.entity.position.floored().y >= f.y && !ctl.aborted) await sleep(80)
    if (headWet(bot)) return { stopped: 'в столбце вода', dug }
  }
  return { stopped: 'прервано', dug }
}

// Вниз по лестнице ствола (иглу): встать в столб люка и не держать ни прыжка, ни шага — по лестнице сползает
// (LivingEntity.handleOnClimbable: скорость вниз ≥ −0.15). Итог — y ног внизу или null.
// Середина свободной части клетки люка: створка открытого люка — тонкая коробка у одной стены (3/16), тело (0.6) проходит
// в оставшиеся 0.8125, только если целиться в их середину (допуск ±0.1).
function holeCenter (bot, hatch) {
  const b = bot.blockAt(v3(hatch))
  let cx = 0.5
  let cz = 0.5
  const s = b && /_trapdoor$/.test(b.name) && Array.isArray(b.shapes) ? b.shapes[0] : null
  if (s) {
    if (s[3] - s[0] < 0.5) cx = s[0] > 0.01 ? s[0] / 2 : (s[3] + 1) / 2
    if (s[5] - s[2] < 0.5) cz = s[2] > 0.01 ? s[2] / 2 : (s[5] + 1) / 2
  }
  return v3(hatch).offset(cx, 0, cz)
}
async function ladderDown (session, ctl, hatch, ms = 15000) {
  const bot = session.bot
  const c = holeCenter(bot, hatch)
  const t0 = gameClock.now()
  const y0 = bot.entity.position.y
  try { await walk(session, ctl, new goals.GoalNear(hatch.x, hatch.y + 1, hatch.z, 1), 8000) } catch {}
  let lastY = bot.entity.position.y
  let still = 0
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      const pos = bot.entity.position
      const flatD = Math.hypot(c.x - pos.x, c.z - pos.z)
      try { await bot.lookAt(new Vec3(c.x, pos.y + 1.2, c.z), true) } catch {}
      bot.setControlState('jump', false)
      bot.setControlState('sneak', false)
      // В дыру тело (0.6) проваливается, только когда до середины свободной части ≤ 0.1: шажками, без разгона мимо.
      if (flatD > 0.07) { bot.setControlState('forward', true); await sleep(flatD > 0.6 ? 150 : 50); bot.setControlState('forward', false) }
      await sleep(150)
      const y = bot.entity.position.y
      if (process.env.ND_DEBUG_STRUCT) console.log('[ladder]', pos.x.toFixed(2), y.toFixed(2), pos.z.toFixed(2), 'flat', flatD.toFixed(2), (bot.blockAt(bot.entity.position.floored()) || {}).name)
      if (Math.abs(y - lastY) < 0.05) { if (++still > (flatD <= 0.07 ? 6 : 24)) break } else still = 0
      lastY = y
    }
  } finally { for (const k of ['forward', 'jump', 'sneak']) bot.setControlState(k, false) }
  // Дно — только стоя на опоре (по таймауту посреди лестницы это не дно и не высота сундука — ревью Codex q2).
  return !ctl.aborted && bot.entity.onGround && bot.entity.position.y < y0 - 2 ? Math.floor(bot.entity.position.y) : null
}

// Вверх по лестнице ствола: в столбе люка держать прыжок (LivingEntity.handleOnClimbable: прыжок на лестнице — +0.2).
// Открытый люк над лестницей той же стороны — тоже лестница (LivingEntity.onClimbable → trapdoorUsableAsLadder);
// prismarine-physics для 1.21 этого не знает (features.json: climbableTrapdoor — до 1.20) и наверху бот прыгал на краю
// люка 25 с (ферма 14.10, иглу 163,-218) — подъём 0.2 за тик в клетке люка добавляем, как сервер. Над полом — шаг на
// соседнюю клетку пола, где проходимо.
async function ladderUp (session, ctl, hatch, ms = 25000) {
  const bot = session.bot
  const c = holeCenter(bot, hatch)
  const H = v3(hatch)
  const t0 = gameClock.now()
  const low = b => !!b && (!Array.isArray(b.shapes) || !b.shapes.length || Math.max(...b.shapes.map(q => q[4])) <= 0.2)
  const exit = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => H.offset(dx, 1, dz))
    .find(q => { const a = bot.blockAt(q); const b = bot.blockAt(q.offset(0, 1, 0)); const f = bot.blockAt(q.offset(0, -1, 0)); return low(a) && b && (!b.shapes || !b.shapes.length) && f && f.boundingBox === 'block' })
  const climb = () => {
    try {
      const f = bot.blockAt(bot.entity.position.floored())
      if (!bot.controlState.jump || !f || !/_trapdoor$/.test(f.name)) return
      const p = f.getProperties()
      const below = bot.blockAt(f.position.offset(0, -1, 0))
      if (String(p.open) === 'true' && below && below.name === 'ladder' && below.getProperties().facing === p.facing) bot.entity.velocity.y = 0.2
    } catch {}
  }
  bot.on('physicsTick', climb)
  try { await walk(session, ctl, new goals.GoalNear(hatch.x, bot.entity.position.y, hatch.z, 0), 6000) } catch {}
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      const pos = bot.entity.position
      if (pos.y >= H.y + 0.95 && bot.entity.onGround && Math.hypot(pos.x - c.x, pos.z - c.z) > 0.55) break
      const top = pos.y > H.y + 0.6 && exit
      const aim = top ? exit.offset(0.5, 0, 0.5) : c
      try { await bot.lookAt(new Vec3(aim.x, pos.y + 1.2, aim.z), true) } catch {}
      bot.setControlState('forward', top ? true : Math.hypot(c.x - pos.x, c.z - pos.z) > 0.3)
      bot.setControlState('jump', true)
      await sleep(100)
      if (process.env.ND_DEBUG_STRUCT) console.log('[ladderUp]', pos.x.toFixed(2), pos.y.toFixed(2), pos.z.toFixed(2), (bot.blockAt(pos.floored()) || {}).name, top ? 'выход' : '')
    }
  } finally {
    for (const k of ['forward', 'jump']) bot.setControlState(k, false)
    bot.removeListener('physicsTick', climb)
  }
  return bot.entity.position.y >= H.y + 0.95
}

// Сундук под водой — отвесно, как спидраннер: поверху к точке над сундуком, вниз по его столбцу (присед — тонуть), на что
// встал — копать под собой (виден: под ногами), пока под ногами не сундук. Столбец над сундуком после этого — открытая
// вода: наверх — прямо (breathe), следующий нырок — тем же ходом. Стоя на твёрдом, копка в воде ×0.2, а не ×0.04
// (Player.getDestroySpeed: глаза в воде ×0.2, не на земле ÷5). true — сундук под ногами или в прицеле.
async function diveToChest (session, ctl, c, { ms = 40000 }: any = {}) {
  const bot = session.bot
  const pick = require('./pick')
  const p = v3(c).floored()
  const t0 = gameClock.now()
  const left = () => ms - (gameClock.now() - t0)
  const seen = () => !!pick.blockAim(bot, p, { range: 4.5, seeThrough: null })
  // Готов — сундук в прицеле и на досягаемости открытия (containers: 3.6 до середины): виден в дыру палубы с 4 бл. — ещё
  // вниз, в трюм (ферма 14.10, корабль −220,−952: «не дотянуться» с края дыры).
  const ready = () => seen() && pick.eyeOf(bot).distanceTo(p.offset(0.5, 0.5, 0.5)) <= 3.5
  const col = p.offset(0.5, 0, 0.5)
  const flatD = () => Math.hypot(bot.entity.position.x - col.x, bot.entity.position.z - col.z)
  if (ready()) return true
  // Поверху — к точке над столбцом (воздух не тратится).
  if (flatD() > 1.2) {
    const surfY = bot._ndSurface ? Math.floor(bot._ndSurface.y) : Math.floor(bot.entity.position.y)
    await swimTo(session, ctl, { x: p.x, y: Math.max(surfY, p.y + 2), z: p.z }, { reach: 1.4, ms: Math.min(30000, left()) })
  }
  let dug = 0
  // Присед в воде — тонуть быстрее (LivingEntity.goDownInWater: −0.04 за тик; prismarine-physics этого не умеет).
  const sink = () => { if (bot.controlState.sneak && bot.entity.isInWater) bot.entity.velocity.y -= 0.04 }
  bot.on('physicsTick', sink)
  try {
    while (!ctl.aborted && left() > 0) {
      if (ready()) return true
      const f = bot.entity.position.floored()
      const under = require('./pick').blockOnRay(bot, require('./pick').eyeOf(bot), new Vec3(0, -1, 0), 4.5)?.block || null
      if (process.env.ND_DEBUG_STRUCT) console.log('[dive]', bot.entity.position.toString(), 'under', under && under.name, under && under.position.toString(), 'flat', flatD().toFixed(2), 'ground', bot.entity.onGround)
      // Под ногами сам сундук: готов — открывать; нет (стою на краю дыры палубы, до него 3.8) — встать точно и опуститься.
      const onTarget = !!under && under.position.equals(p)
      if (onTarget && ready()) return true
      if (f.y <= p.y && !onTarget) break // ниже сундука — промахнулся столбцом
      // Держаться столбца: взгляд вниз на середину столбца, короткий шаг.
      // Стоя — точнее: в дыру 1×1 (выкопанная палуба) тело 0.6 проходит, только если до середины ≤ 0.2 (ферма 14.10,
      // корабль −220,−952: 0.27 от середины — стоял на краю дыры, пока не кончился воздух).
      // Шаг — без приседа: присед на земле не пускает с края (prismarine-physics, как ванильный «крадущийся» шаг) — в дыру
      // тело не шагнёт (там же: 0.20 от середины, 30 шагов на месте).
      if (flatD() > (bot.entity.onGround ? 0.12 : 0.35)) {
        try { await bot.lookAt(new Vec3(col.x, bot.entity.position.y, col.z), true) } catch {}
        bot.setControlState('sneak', false)
        bot.setControlState('forward', true); await sleep(bot.entity.onGround ? 50 : 80); bot.setControlState('forward', false)
      }
      if (bot.entity.onGround && under && under.boundingBox === 'block' && !onTarget) {
        if (NO_DIG.test(under.name)) return seen()
        // Присед не отпускать: в воде без него тело всплывает с палубы, и копка «не на земле» — ещё ×5 (Player.getDestroySpeed).
        bot.setControlState('sneak', true)
        const t1 = gameClock.now()
        const r = await digAt(session, ctl, under.position, { maxMs: 20000, walkMs: 1 })
        if (process.env.ND_DEBUG_STRUCT) console.log('[dive] dig', under.name, under.position.toString(), JSON.stringify(r), 'ms', gameClock.now() - t1, 'ground', bot.entity.onGround, 'air', air(bot))
        if (!r.ok) return seen()
        dug++
      } else {
        bot.setControlState('sneak', true)
        await sleep(150)
      }
    }
  } finally { bot.setControlState('sneak', false); bot.setControlState('forward', false); bot.removeListener('physicsTick', sink) }
  void dug
  return seen()
}

// ------------------------------------------------------------------ шаблоны

// Виды с шаблонами (data/structure-templates.json) → как узнавать. ND_STRUCT_TEMPLATES=0 — без шаблонов (только видимые
// сундуки, как до 14.10 — для замера «с шаблонами и без»).
const TEMPLATE_KINDS = { shipwreck: 32, desert_pyramid: 30, jungle_pyramid: 24, ruined_portal: 22, igloo: 16, village: 56, ocean_ruin: 22, outpost: 24 }
function templatesOn () { return process.env.ND_STRUCT_TEMPLATES !== '0' }

// Узнать шаблон записи по видимому: { chests: [{x,y,z,table,p,wet}], name, extra } (и записать в память — для цены).
function templateFit (session, rec, out = null) {
  const bot = session.bot
  const R = TEMPLATE_KINDS[rec.kind]
  if (!R || !templatesOn()) return null
  const F = require('./structure-fit')
  const center = { x: rec.x, y: rec.y, z: rec.z }
  let chests = []
  let name = null
  let extra: any = {}
  const t0 = Date.now()
  if (rec.kind === 'village') {
    const houses = F.fitHouses(bot, center, { radius: R, biome: F.villageBiome(bot, center) })
    for (const h of houses) chests.push(...h.chests.map(c => ({ ...c, from: h.name })))
    name = houses.map(h => h.name.split('/').pop()).join(', ') || null
    // Кровати и сено узнанных домов — по их шаблонам (цена деревни — не по среднему; ферма 14.10, cs-7: «+2 с — иду», 146 с, ничего).
    let beds = 0
    let hay = 0
    for (const h of houses) { beds += templateCells(h, /_bed$/).length / 2; hay += templateCells(h, /^hay_block$/).length }
    extra = { houses: houses.length, beds: Math.floor(beds), hay }
  } else {
    // Под водой или на пляже — по биому места (океан — затонувший, пляж — на мели: has_structure/shipwreck(_beached)).
    const biome = (() => { try { return biomeName(bot, bot.entity.position.floored()) || '' } catch { return '' } })()
    const wetShip = rec.kind === 'ocean_ruin' || (rec.kind === 'shipwreck' && (/ocean|river/.test(biome) || (!biome && swimming(bot))))
    const r = F.fit(bot, rec.kind, center, { radius: R, env: rec.kind === 'shipwreck' ? (wetShip ? 'ocean' : 'beached') : null, debug: session._fitDebug || null })
    if (session._fitDebug && r) session._fitDebug.push({ seen: r.seen, voters: r.voters, best: r.best && r.best.name })
    if (r && r.best) {
      name = r.best.name
      if (rec.kind === 'igloo') {
        const b = F.iglooBasement(r.best)
        extra = { igloo: b }
        if (b) chests = [{ x: b.chest.x, y: null, z: b.chest.z, table: b.chest.table, p: 0.5, basement: true }]
      } else chests = F.chestsOf(r)
      extra.score = r.best.score
      extra.match = r.best.match
      extra.miss = r.best.miss
      if (rec.kind === 'desert_pyramid') extra.plate = templateCells(r.best, /^stone_pressure_plate$/)[0] || null
      if (rec.kind === 'jungle_pyramid') extra.traps = templateCells(r.best, /^(tripwire_hook|tripwire)$/)
    }
    // Руины портала и прочее в океане (биом под ногами, F3) ниже уровня моря — тоже под водой: нырок, сторож воздуха.
    for (const c of chests) c.wet = wetShip || (Number.isFinite(c.y) && c.y < 61 && /ocean|river/.test(biome))
  }
  const ms = Date.now() - t0
  // Узнан раньше (с лучшего места подхода: под водой видно на ~20 бл.) — то узнавание и берём.
  if (!name && rec.fit && rec.fit.name) {
    if (out) out.lines.push(`▸ шаблон: ${rec.fit.name} — узнан раньше (отсюда не видно, ${ms} мс)`)
    return { name: rec.fit.name, chests: (rec.fit.chests || []).map(([x, y, z, table, p, wet]) => ({ x, y, z, table, p, wet: !!wet, basement: y === null })), extra: rec.fit.extra || {}, old: true }
  }
  if (out) out.lines.push(name ? `▸ шаблон: ${name} (сундуков по шаблону ${chests.length}, ${ms} мс)` : `▸ шаблон не узнан (${ms} мс)`)
  if (name) patchRec(session, rec, r => { r.fit = { name, chests: chests.map(c => [c.x, c.y, c.z, c.table, c.p, c.wet ? 1 : 0]), extra, t: gameClock.now() } })
  return name ? { chests, name, extra } : null
}
// Клетки шаблона гипотезы с именем блока по re → мир.
function templateCells (h, re) {
  const F = require('./structure-fit')
  const T = F.lib()[h.name]
  const CHR = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-/:;<=>?@[]^_`{|}~'
  const ids = new Set(T.pal.map((n, i) => re.test(n) ? CHR[i] : null).filter(Boolean))
  const [X, Y, Z] = T.size
  const out = []
  for (let i = 0; i < T.grid.length; i++) {
    if (!ids.has(T.grid[i])) continue
    const x = i % X; const z = Math.floor(i / X) % Z; const y = Math.floor(i / (X * Z))
    out.push(F.toWorld(h, x, y, z))
  }
  return out
}

async function takeOnce (session, ctl, pos, { kind = null, visibleOnly = false, stay = false, deadline: callerDeadline = Infinity }: any = {}) {
  const bot = session.bot
  const containers = require('./containers')
  const at = xyz(v3(pos))
  if (kind === 'bastion') {
    const eyes = piglinsWatching(bot)
    if (eyes.length) return { at, stopped: `${eyes.length} пиглин(ов) видят — откроешь, озлобятся все в ±16 блоках (золотая броня не спасёт)`, took: {} }
  }
  // Место заранее: при открытом окне выкинуть нельзя.
  if (bot.inventory.emptySlotCount() < 3) {
    try { await pack.makeRoom(bot, { slots: 3, forItem: 'iron_ingot' }) } catch {}
  }
  const deadline = Math.min(gameClock.now() + 25000, callerDeadline)
  if (ctl.aborted || gameClock.now() >= deadline) return { at, took: {}, stopped: 'время добычи вышло или прервано' }
  armTraps(session)
  // В воде — подплыть, если сундук не в прицеле на досягаемости (ферма 14.10, корабль −220,−952: видно в дыру палубы с 3.7 бл.,
  // а заплыв «до 3.4» упирался в край дыры, пока не кончился воздух).
  const aimable = () => !!require('./pick').blockAim(bot, v3(at), { range: 4.4, seeThrough: null })
  if (!stay && (underwater(bot, at) || swimming(bot)) && !aimable()) await swimTo(session, ctl, at, { reach: 3.4, ms: Math.max(0, deadline - gameClock.now()) })
  // Сундук не открывается под блоком-проводником (ChestBlock.isChestBlockedAt → isRedstoneConductor: полный куб, не
  // стекло и не листва; плита, ступень, люк, забор и вода над сундуком не мешают): в трюме корабля над ним палуба —
  // сломать её, как сделал бы человек; не видна — сперва до вида.
  // Крышка — какой её видно (ревью Codex q2: тип скрытого блока над сундуком читался до вида): не видна — сперва до вида.
  const lidPos = v3(at).offset(0, 1, 0)
  const eyes = require('./perception/eyes')
  if (visibleOnly && !stay && !eyes.seesNow(bot, lidPos)) await digToSee(session, ctl, lidPos, { ms: 15000 })
  const lid = eyes.seesNow(bot, lidPos) ? bot.blockAt(lidPos) : null
  const cube = b => !!b && b.boundingBox === 'block' && Array.isArray(b.shapes) && b.shapes.length === 1 && b.shapes[0].join(',') === '0,0,0,1,1,1' &&
    !/chest|barrel|glass|leaves|^ice$|_ice$|barrier|slime|honey|soul_sand|tnt|glowstone|sea_lantern|beacon|observer|piston|redstone_block/.test(b.name)
  if (cube(lid) && !(eyes.seesNow(bot, v3(at)) && (bot.blockAt(v3(at)) || {}).name === 'barrel')) {
    const pick = require('./pick')
    if (visibleOnly && !pick.blockSeen(bot, lid.position, { range: 4.6 })) {
      if (stay) return { at, took: {}, stopped: 'крышку отсюда не вижу' }
      await digToSee(session, ctl, lid.position, { ms: 15000 })
    }
    if (visibleOnly && !pick.blockSeen(bot, lid.position, { range: 4.6 })) return { at, took: {}, stopped: 'крышка сундука закрыта невидимым блоком' }
    await digAt(session, ctl, lid.position, { maxMs: 20000, walkMs: stay ? 0 : 20000 })
  }
  if (process.env.ND_DEBUG_STRUCT) console.log('[take]', JSON.stringify(at), 'me', bot.entity.position.toString(), 'eye→', require('./pick').eyeOf(bot).distanceTo(v3(at).offset(0.5, 0.5, 0.5)).toFixed(2), 'lid', lid && lid.name, 'aim', aimable())
  // Открывать — без приседа: присед с предметом в руке — «второе действие», сундук не открывается
  // (ServerPlayerGameMode.useItemOn: isSecondaryUseActive && предмет в руке → мимо блока; ферма 14.10, трюм −220,−952).
  bot.setControlState('sneak', false)
  const { block, win } = await containers.findAndOpen(session, ctl, { ...at, visibleOnly, stay }, deadline)
  const shut = containers.guardWindow(ctl, win)
  let pass = null
  const plan = []
  try {
    const byName = new Map()
    const ctx = {}
    for (const it of win.containerItems()) {
      const d = decide(bot, it, ctx)
      const cur = byName.get(it.name)
      if (cur) { cur.count += it.count; if (d.take && !cur.take) Object.assign(cur, d) } else byName.set(it.name, { name: it.name, count: it.count, ...d })
    }
    plan.push(...byName.values())
    const names = plan.filter(p => p.take).sort((a, b) => b.prio - a.prio).map(p => p.name)
    pass = await containers.withdrawPass(bot, session.mcData, win, names, { deadline, ctl })
  } finally {
    shut()
    await sleep(150)
  }
  // Взято не всё (прервали, не влезло) — сундук не «взят»: вернуться можно (ревью Codex q2).
  if (!ctl.aborted && !(pass && pass.stopped) && !Object.keys((pass && pass.left) || {}).length) markLooted(session, keyOf(block.position))
  const took = (pass && pass.took) || {}
  const why = {}
  for (const p of plan) if (took[p.name]) why[p.name] = p.why
  const left = {}
  for (const p of plan) if (!p.take) left[p.name] = p.count
  const text = (Object.entries(took) as [string, any][]).map(([k, v]) => `${k}×${v}`).join(', ') || 'ничего ценного'
  try { session.journal.append('лут', `${(KINDS[kind] || {}).ru || 'сундук'} ${at.x},${at.y},${at.z}: ${text}`, bot.entity.position) } catch {}
  return { at, kind: block.name, took, why, left, notTaken: pass && Object.keys(pass.left || {}).length ? pass.left : undefined, stopped: (pass && pass.stopped) || undefined }
}

// Вагонетка с сундуком: shift-клик только ценного.
async function takeCart (session, ctl, cart) {
  const bot = session.bot
  const t0 = gameClock.now()
  bot.pathfinder.setGoal(new goals.GoalFollow(cart, 2))
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  while (!ctl.aborted && gameClock.now() - t0 < 30000 && cart.isValid !== false && cart.position.distanceTo(bot.entity.position) > 3) await sleep(200)
  bot.pathfinder.setGoal(null)
  if (cart.position.distanceTo(bot.entity.position) > 3.5) return { stopped: 'не дошёл до вагонетки', took: {} }
  const win = await withTimeout(bot.openContainer(cart), 6000, 'вагонетка не открылась')
  const took = {}
  const why = {}
  const left = {}
  try {
    const ctx = {}
    const items = win.containerItems().map(it => ({ it, d: decide(bot, it, ctx) })).sort((a, b) => b.d.prio - a.d.prio)
    for (const { it, d } of items) {
      if (!d.take) { left[it.name] = (left[it.name] || 0) + it.count; continue }
      try { await bot.clickWindow(it.slot, 0, 1); took[it.name] = (took[it.name] || 0) + it.count; why[it.name] = d.why } catch {}
      await sleep(120)
    }
  } finally { try { win.close() } catch {} }
  markLooted(session, `cart:${cart.id}`)
  return { at: xyz(cart.position), kind: 'chest_minecart', took, why, left }
}

// S8d (аудит S10 №11/№12): блоки постройки — как нашёл бы игрок: память глаз + оглядеться (eyes.locate), а не findBlocks
// сквозь стены. На уровне знания scan eyes.locate сам берёт findBlocks (знание карты). ND_STRUCT_EYES=0 — прежнее (findBlocks).
function seenNear (bot, names, center, R, max = 32) {
  const c = v3(center)
  if (process.env.ND_STRUCT_EYES === '0') {
    const ids = names.map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
    try { return bot.findBlocks({ matching: ids, point: c, maxDistance: R, count: max }) } catch { return [] }
  }
  const radius = Math.min(160, bot.entity.position.distanceTo(c) + R)
  try { return require('./perception/eyes').locate(bot, names, { radius, max: max * 2, rays: 600, filter: q => q.distanceTo(c) <= R }).slice(0, max) } catch { return [] }
}
function containersNear (session, center, R, yR = 16) {
  return seenNear(session.bot, CONTAINER_NAMES, center, R, 32).filter(p => Math.abs(p.y - center.y) <= yR)
}

function merge (out, r) {
  for (const [k, v] of (Object.entries(r.took || {}) as [string, any][])) out.took[k] = (out.took[k] || 0) + v
  Object.assign(out.why, r.why || {})
  for (const [k, v] of (Object.entries(r.left || {}) as [string, any][])) out.left[k] = (out.left[k] || 0) + v
}

// Взятое за весь заход к сундуку — по рюкзаку: под водой первый нырок открывает и берёт, сторож воздуха рвёт его, и в итог
// последнего (сундук уже без ценного) это не попадало (ферма 14.10, корабль −1,53,13: железо 6 + 10 самородков и карта в
// рюкзаке, «взял: —»). Только то, что decide берёт (доски с копки — нет).
function bagCounts (bot) {
  const m = {}
  for (const it of bot.inventory.items()) m[it.name] = (m[it.name] || 0) + it.count
  return m
}
function bagGain (bot, before) {
  const gain = {}
  for (const [k, n] of (Object.entries(bagCounts(bot)) as [string, number][])) {
    const d = n - (before[k] || 0)
    if (d > 0 && decide(bot, { name: k, count: d }, {}).take) gain[k] = d
  }
  return gain
}
function withGain (bot, before, r) {
  const gain = bagGain(bot, before)
  return Object.keys(gain).length > Object.keys((r && r.took) || {}).length ? { ...r, took: gain } : r
}

async function lootAll (session, ctl, rec, out, p) {
  const bot = session.bot
  const K = KINDS[rec.kind]
  const R = rec.lootR || K.lootR || K.r
  if (!R) return
  const done = lootedSet(session)
  const center = { x: rec.x, y: rec.y, z: rec.z }
  let list0 = containersNear(session, center, R, rec.yR || K.yR || 16).filter(q => !done.has(keyOf(q)))
  const planned = ((rec.tf && rec.tf.chests) || []).filter(c => Number.isFinite(c.y) && c.p > 0)
  // Стоять на месте (плита храма цела — по камере не ходить; ревью Codex q2): только сундуки в досягаемости и в прицеле.
  const hereOnly = q => canReach(bot, q) && !!require('./pick').blockAim(bot, v3(q), { range: 4.3, seeThrough: null })
  if (rec.stay) list0 = list0.filter(hereOnly)
  // Сундуков не видно, а «пирог» F3 считает их в прорисовке (сундук без клетки) — обход: 4 точки вокруг центра постройки,
  // глаза смотрят по ходу (S8d, аудит S10 №11). Бочку «пирог» не видит. ND_STRUCT_EYES=0 — без обхода. Шаблон узнан —
  // обход не нужен: где сундуки, известно.
  if (!rec.stay && !list0.length && !planned.length && process.env.ND_STRUCT_EYES !== '0') {
    let pieN = 0
    try { const pp = require('./perception/senses').pie(bot, { range: Math.min(96, bot.entity.position.distanceTo(v3(center)) + R) }); pieN = (pp && pp.byType && (pp.byType.chest || 0)) || 0 } catch {}
    const ring = Math.max(6, Math.min(R, 14))
    for (const [dx, dz] of pieN ? [[1, 0], [0, 1], [-1, 0], [0, -1]] : []) {
      if (ctl.aborted || list0.length) break
      try { await walk(session, ctl, new goals.GoalNear(center.x + dx * ring, Number.isFinite(center.y) ? center.y : bot.entity.position.y, center.z + dz * ring, 3), 9000) } catch {}
      try { require('./perception/eyes').nearest(bot, CONTAINER_NAMES, { fresh: true, max: 1 }) } catch {}
      list0 = containersNear(session, center, R, rec.yR || K.yR || 16).filter(q => !done.has(keyOf(q)))
    }
  }
  const list = list0
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  const places = (session.journal.state && session.journal.state.places) || {}
  const here = dimOf(bot)
  for (const q of list) {
    if (ctl.aborted) break
    if ((bot.health ?? 20) < 8) { out.lines.push(`⚠ ${Math.round(bot.health)} хп — остальные сундуки потом`); break }
    const marks = p.force ? [] : playerMarks(bot, q, rec.kind)
    // Наша база рядом — не лут (как loot.js).
    const base = (Object.entries(places) as [string, any][]).some(([n, pl]: any) => pl && typeof pl.x === 'number' && !STRUCTURE_PLACES.has(n) &&
      (pl.dimension || 'overworld') === here && Math.hypot(pl.x - q.x, pl.z - q.z) < 24 && Math.abs((pl.y ?? q.y) - q.y) < 16)
    if (base) marks.push('рядом наша база')
    if (marks.length) { out.skipped.push({ at: xyz(q), why: `поставил игрок? ${marks.join(', ')} — без решения человека не трогаю` }); continue }
    try {
      // Открыть — только в прицеле (не сквозь стену): visibleOnly.
      const bag0 = bagCounts(bot)
      const r = withGain(bot, bag0, await takeWorth(session, ctl, q, { kind: rec.kind, visibleOnly: true, stay: !!rec.stay }))
      out.chests.push({ at: r.at, took: r.took, stopped: r.stopped })
      merge(out, r)
      if (r.stopped) out.lines.push(`⚠ сундук ${r.at.x},${r.at.y},${r.at.z}: ${r.stopped}`)
    } catch (e) {
      out.chests.push({ at: xyz(q), error: e.message })
    }
  }
  // Сундуки шаблона, которых не видно (в трюме, под песком, в доме, в камере): ближний первым — довести до вида
  // (digToSee: копать то, что на луче к клетке), увидел сундук — открыть; на клетке не сундук — вариант не тот, мимо.
  let todo = planned.filter(c => (!rec.stay || hereOnly(c)) && !lootedSet(session).has(keyOf(c)) && !lootedSet(session).has(`miss:${keyOf(c)}`))
  while (todo.length && !ctl.aborted) {
    if ((bot.health ?? 20) < 8) { out.lines.push(`⚠ ${Math.round(bot.health)} хп — сундуки шаблона потом`); break }
    const me = bot.entity.position
    todo.sort((a, b) => me.distanceTo(v3(a)) - me.distanceTo(v3(b)))
    const c = todo.shift()
    // Глубже 16 бл. под водой без дверей на карман — не ныряю (15 с воздуха: вниз и наверх не успеть; ферма 14.10, корабль
    // на 20 бл. — утонул трижды); с дверями — до 26.
    const surfY = bot._ndSurface ? bot._ndSurface.y : (swimming(bot) ? bot.entity.position.y : 62)
    const doors = process.env.ND_AIR_POCKET === '1' && bot.inventory.items().some(i => /_door$/.test(i.name) && i.name !== 'iron_door')
    if (c.wet && surfY - c.y > (doors ? 26 : 16)) { out.lines.push(`⚠ сундук ${c.table} на ${Math.round(surfY - c.y)} бл. под водой${doors ? '' : ' без дверей на карман воздуха'} — не ныряю`); continue }
    const t0 = gameClock.now()
    const bag0 = bagCounts(bot)
    try {
      const r0 = await withAir(session, ctl, async sub => {
        const got = rec.stay ? hereOnly(c) : c.wet && (swimming(bot) || headWet(bot)) ? await diveToChest(session, sub, c, { ms: 40000 }) : await digToSee(session, sub, c, { ms: c.wet ? 40000 : 60000, wet: c.wet })
        if (!got) return { miss: 'не вскрыл' }
        const b = bot.blockAt(v3(c))
        if (!b || !/^(chest|trapped_chest|barrel)$/.test(b.name)) return { miss: `на клетке ${b ? b.name : '—'}` }
        try {
          return await takeOnce(session, sub, c, { kind: rec.kind, visibleOnly: true, stay: !!rec.stay })
        } catch (e) {
          // Видна краем, а луч к середине упёрся в соседа (ферма 14.10, храм 16,160: ниша сбоку) — шаг ближе и снова.
          if (rec.stay || !/не в прицеле/.test(String(e.message)) || sub.aborted) throw e
          try { await walk(session, sub, new goals.GoalNear(c.x, c.y, c.z, 1), 10000) } catch {}
          await digToSee(session, sub, c, { ms: 15000, wet: c.wet })
          return takeOnce(session, sub, c, { kind: rec.kind, visibleOnly: true, stay: !!rec.stay })
        }
      }, c.wet ? 4 : 1)
      const g = bagGain(bot, bag0)
      const r = r0 && !r0.miss ? withGain(bot, bag0, r0) : (!r0 && Object.keys(g).length ? { at: xyz(c), took: g, stopped: 'нырок оборван — взято, что успел' } : r0)
      const sec = Math.round((gameClock.now() - t0) / 1000)
      if (!r || r.miss) {
        if (r && /на клетке/.test(r.miss)) {
          markLooted(session, `miss:${keyOf(c)}`)
          // На клетке не сундук — её гипотезы неверны: их клетки, которых нет у других гипотез, не копать.
          if (Array.isArray(c.hyps)) todo = todo.filter(q => !Array.isArray(q.hyps) || q.hyps.some(h => !c.hyps.includes(h)))
        }
        out.chests.push({ at: xyz(c), planned: true, error: (r && r.miss) || 'прервано', sec })
        out.lines.push(`⚠ сундук шаблона ${c.x},${c.y},${c.z} (${c.table}): ${(r && r.miss) || 'прервано'} за ${sec} с`)
        continue
      }
      out.chests.push({ at: r.at, planned: true, table: c.table, took: r.took, stopped: r.stopped, sec })
      merge(out, r)
      // Сундук на клетке — верны гипотезы этой клетки: клетки только других гипотез (зеркало, сдвиг) — мимо (ферма 14.10,
      // храм джунглей 18,-168: две гипотезы, лишние 13 с на пустые клетки).
      if (Array.isArray(c.hyps)) todo = todo.filter(q => !Array.isArray(q.hyps) || q.hyps.some(h => c.hyps.includes(h)))
      if (r.stopped) out.lines.push(`⚠ сундук ${r.at.x},${r.at.y},${r.at.z}: ${r.stopped}`)
    } catch (e) {
      out.chests.push({ at: xyz(c), planned: true, error: e.message })
    }
    // Взял под водой — сразу наверх, пока воздуха больше, чем у тактики (Surface при ≤ 8 рвёт навык): следующий нырок — с полным.
    if (headWet(bot) && air(bot) < 16) await breathe(bot, ctl, 15000, session)
    todo = todo.filter(q => !lootedSet(session).has(keyOf(q)))
  }
  if (rec.stay) return
  // Вагонетки с сундуком (шахта).
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (ctl.aborted) break
    if (!e || e.name !== 'chest_minecart' || !e.position) continue
    if (flat(e.position, center) > R || done.has(`cart:${e.id}`)) continue
    // Вагонетка шахты под постройкой (деревня над шахтой: 4 × «не дошёл до вагонетки» по 30 с, ферма 14.10) — только на её уровне и на виду.
    if (Math.abs(e.position.y - (Number.isFinite(center.y) ? center.y : bot.entity.position.y)) > (rec.yR || K.yR || 16) || !require('./perception/eyes').seesNow(bot, e.position.offset(0, 0.5, 0))) continue
    try {
      const r = await takeCart(session, ctl, e)
      out.chests.push({ at: r.at, cart: true, took: r.took, stopped: r.stopped })
      merge(out, r)
    } catch (err) { out.chests.push({ at: xyz(e.position), cart: true, error: err.message }) }
  }
}

// Места, которые пишут модули-разведчики (не наша база). Отметка увиденной
// лавы рядом с руинами тоже не превращает их сундук в наш склад.
const STRUCTURE_PLACES = new Set(['крепость', 'крепость (ад)', 'бастион (ад)', 'спавнер блейзов', 'портал', 'портал (ад)', 'лава'])

// ------------------------------------------------------------------ обработчики

const HANDLERS = {
  // Данж и шахта: мобов — перебить, спавнер — сломать (ифритов не трогаем).
  async spawner (session, ctl, rec, out) {
    const bot = session.bot
    await clearMobs(session, ctl, out)
    const sp = bot.findBlocks({ matching: [bot.registry.blocksByName.spawner.id], point: v3(rec), maxDistance: KINDS[rec.kind].lootR, count: 4 })
    for (const s of sp) {
      if (ctl.aborted) break
      const hasPick = count(bot, /_pickaxe$/) > 0
      if (!hasPick) { out.lines.push('⚠ спавнер цел: без кирки ломать 25 с — лутаю быстро'); break }
      const r = await digAt(session, ctl, s, { maxMs: 12000 })
      out.disarmed.push(r.ok ? `спавнер ${s.x},${s.y},${s.z} сломан — мобы больше не появятся` : `спавнер не сломал: ${r.why}`)
      await clearMobs(session, ctl, out, { rounds: 2 })
    }
  },

  // Пустынный храм (DesertPyramidPiece 1.21.11): под центром пола (синяя терракота) шахта 3×3 в 11 блоков, на её дне
  // нажимная плита над 9 TNT, сундуки — в нишах в 2 блоках от плиты по сторонам света. Как спидраннер: встать на пол над
  // нишей сундука и копать под собой — колодец кончается на крышке сундука, плита в стороне; оттуда видно и плиту
  // (снять рукой: сломать можно, наступить — нет), и остальные три ниши. Без шаблона — только видимое (X-ray плиты убран).
  async desert (session, ctl, rec, out, p) {
    const bot = session.bot
    const tf = rec.tf
    const chests = ((tf && tf.chests) || []).filter(c => !lootedSet(session).has(keyOf(c)))
    if (!chests.length) { out.lines.push(tf ? '▸ сундуки храма уже взяты' : '▸ храм не узнан по шаблону — только видимое'); return }
    const me = bot.entity.position
    const c = chests.sort((a, b) => me.distanceTo(v3(a)) - me.distanceTo(v3(b)))[0]
    // Пол над нишей — на 11 выше сундука (локальные y кода: сундук −11, пол 0); встать на него, в столб сундука.
    try { await walk(session, ctl, new goals.GoalBlock(c.x, c.y + 12, c.z), 60000) } catch (e) { out.lines.push(`⚠ к полу над сундуком храма: ${e.message}`) }
    const f = bot.entity.position.floored()
    if (f.x !== c.x || f.z !== c.z) { out.lines.push('⚠ не встал над нишей сундука — без колодца'); return }
    const d = await digDown(session, ctl, { maxDepth: 14 })
    out.lines.push(d.chest ? `▸ храм: колодец над нишей до сундука ${d.chest.x},${d.chest.y},${d.chest.z} (${d.dug} бл.)` : `⚠ колодец храма: ${d.stopped || 'сундука под собой нет'}`)
    // Плита — без коллизии (луч прицела по коробке её не берёт): видна, если луч входит в её клетку (eyes.seesNow; клиент
    // целится по контуру — тонкая плитка). Стоять рядом с ней тоже нельзя: её TOUCH_AABB — почти вся клетка, рамка тела
    // у края соседней клетки в неё заходит (ферма 14.10, храм 352,794: шаг к дальнему сундуку — взрыв 9 TNT).
    const plate = tf.extra && tf.extra.plate
    let gone = false
    if (plate && require('./perception/eyes').seesNow(bot, plate)) {
      const b = bot.blockAt(v3(plate))
      if (b && b.name === 'stone_pressure_plate') {
        const r = await digAt(session, ctl, plate, { maxMs: 4000, walkMs: 0 })
        if (r.ok) { gone = true; out.disarmed.push('нажимная плита над 9 TNT снята руками (ломать можно, наступать — нет)'); rec.plate = plate }
      } else if (b) gone = true // плиты уже нет
    }
    if (!gone) {
      rec.stay = true
      // Плита цела — по камере не ходить: только сундуки в досягаемости отсюда.
      const eye = bot.entity.position.offset(0, 1.62, 0)
      const near = c => eye.distanceTo(v3(c).offset(0.5, 0.5, 0.5)) <= 4.3
      const far = tf.chests.filter(c => !near(c))
      if (far.length) out.lines.push(`⚠ плита над TNT цела — дальние сундуки храма (${far.length}) не беру`)
      rec.tf = { ...tf, chests: tf.chests.filter(near) }
    }
  },

  // Храм в джунглях (JungleTemplePiece): два сундука в подвале — за рычагами и в конце коридора с растяжками у раздатчиков.
  // Сундуки — по шаблону, к ним — копать по лучу; нить и крючки не копаются и пути их обходят (TRAP_BLOCKS). Видимые
  // растяжки шаблона: ножницы — срезать (TripWireBlock: ножницы ставят DISARMED), без них — сломать крюк (не стреляет).
  async jungle (session, ctl, rec, out) {
    const bot = session.bot
    const pick = require('./pick')
    const traps = ((rec.tf && rec.tf.extra && rec.tf.extra.traps) || []).filter(q => pick.blockSeen(bot, v3(q), { range: 24 }))
    const shears = bot.inventory.items().find(i => i.name === 'shears')
    let n = 0
    for (const q of traps) {
      if (ctl.aborted) break
      const b = bot.blockAt(v3(q))
      if (!b || (shears ? b.name !== 'tripwire' : b.name !== 'tripwire_hook')) continue
      const r = await digAt(session, ctl, q, { tool: shears ? 'shears' : null, maxMs: 4000 })
      if (r.ok) n++
    }
    if (n) out.disarmed.push(shears ? `нить растяжек срезана ножницами: ${n}` : `крюки растяжек сломаны: ${n} (нить без ножниц стреляет)`)
  },

  // Иглу (IglooPieces): подвал в половине; люк — под ковром в полу (3,0,5 верха); подвала нет — там снег (postProcess).
  // Войти, снять ковёр над люком, посмотреть: люк — открыть, вниз по лестнице, сундук лаборатории — по шаблону.
  async igloo (session, ctl, rec, out) {
    const bot = session.bot
    const b = rec.tf && rec.tf.extra && rec.tf.extra.igloo
    if (!b) return
    rec.tf.chests = []
    if (!await digToSee(session, ctl, b.carpet, { ms: 30000 })) { out.lines.push('⚠ иглу: до ковра над люком не добрался'); return }
    const carpet = bot.blockAt(v3(b.carpet))
    if (carpet && /_carpet$/.test(carpet.name)) await digAt(session, ctl, b.carpet, { maxMs: 2000, walkMs: 1 })
    if (!require('./pick').blockSeen(bot, v3(b.hatch), { range: 4.6 })) { out.lines.push('⚠ иглу: люка не вижу'); return }
    const hatch = bot.blockAt(v3(b.hatch))
    if (!hatch || !/_trapdoor$/.test(hatch.name)) { out.lines.push(`▸ иглу без подвала: под ковром ${hatch ? hatch.name : '—'}`); return }
    // Люк — открыть: открытый люк над лестницей той же стороны (igloo/top: oak_trapdoor facing=north, лестницы north) —
    // тоже лестница, наверх через него (сломанный — наверху нет опоры: ферма 14.10, иглу 163,-218 — 25 с на краю).
    // Створка занимает 3/16 клетки: вниз — в середину свободной части (ladderDown); не провалился — сломать люк.
    try { if (String(hatch.getProperties().open) === 'false') { await bot.activateBlock(hatch); await sleep(300) } } catch {}
    const y0 = Math.floor(bot.entity.position.y)
    rec.ladderUp = { x: b.hatch.x, y: b.hatch.y, z: b.hatch.z } // наверх — и после неудачного спуска
    let bottom = await ladderDown(session, ctl, b.hatch, 30000)
    if (bottom === null && !ctl.aborted && (await digAt(session, ctl, b.hatch, { maxMs: 6000, walkMs: 1 })).ok) bottom = await ladderDown(session, ctl, b.hatch, 30000)
    if (bottom === null || bottom > y0 - 8) { out.lines.push('⚠ иглу: по лестнице вниз не спустился'); return }
    out.lines.push(`▸ иглу: подвал, спустился на ${y0 - bottom} бл.`)
    rec.tf.chests = [{ x: b.chest.x, y: bottom, z: b.chest.z, table: b.chest.table, p: 1 }]
  },

  // Руины портала: сундук, потом золотые блоки (бартер) и счёт обсидиана.
  async portal () {},
  // Сундуки деревни — в домах, снаружи их не видно (ферма 14.10, сид 6520139407132075259: три сундука в 20–38 бл. от центра, глаза —
  // ни одного, «пирог» видит). Как игрок: к видимым дверям домов, открыть, заглянуть — сундук внутри попадает в глаза, дальше
  // общий лут. До 6 дверей, ближние первыми; хватит, как только виден неоткрытый сундук.
  async village (session, ctl, rec, out, p) {
    const bot = session.bot
    const R = rec.lootR || KINDS.village.lootR
    const fresh = () => containersNear(session, rec, R, rec.yR || 16).filter(q => !lootedSet(session).has(keyOf(q)))
    // Дома узнаны по шаблонам — где сундуки, известно (общий лут копает к ним); заглядывать в двери не нужно. Узнано 3+ дома и
    // ни в одном сундука нет — тоже (обход дверей — 25–129 с, cs-7 14.10: 146 с впустую).
    if (fresh().length || (rec.tf && (rec.tf.chests.length || (rec.tf.extra && rec.tf.extra.houses >= 3)))) return
    const doors = seenNear(bot, DOOR_NAMES, rec, R, 24).filter(d => (bot.blockAt(d)?.getProperties?.().half ?? 'lower') === 'lower')
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, 6)
    let peeked = 0
    for (const d of doors) {
      if (ctl.aborted || fresh().length) break
      try { await walk(session, ctl, new goals.GoalNear(d.x, d.y, d.z, 1), 20000) } catch { continue }
      const door = bot.blockAt(d)
      try { if (door && String(door.getProperties?.().open) === 'false') { await bot.activateBlock(door); await sleep(300) } } catch {}
      try { require('./perception/eyes').nearest(bot, CONTAINER_NAMES, { fresh: true, max: 1 }) } catch {}
      peeked++
    }
    if (peeked) out.lines.push(`▸ деревня: заглянул в ${peeked} двер. — сундуков на виду ${fresh().length}`)
  },

  // Бастион: брутья — отказ без force; открытие сундуков проверяет глаза пиглинов.
  async bastion (session, ctl, rec, out, p) {
    const bot = session.bot
    const brutes = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'piglin_brute' && e.position && e.position.distanceTo(bot.entity.position) < 24)
    const gold = count(bot, /^golden_(helmet|chestplate|leggings|boots)$/) > 0
    const worn = [5, 6, 7, 8].some(s => bot.inventory.slots[s] && /^golden_/.test(bot.inventory.slots[s].name))
    if ((brutes.length || !worn) && !p.force) {
      out.lines.push(`⚠ бастион: ${brutes.length ? `брутьев рядом ${brutes.length} — бьют всегда` : ''}${!worn ? `${brutes.length ? '; ' : ''}золотой брони на мне нет${gold ? ' (в рюкзаке есть — надень)' : ''} — пиглины нападут` : ''}. Не лезу; force:true — на свой страх`)
      out.abort = true
    }
  },

  // Город Края: элитры в рамке на корабле — ударить рамку, подобрать.
  async endcity (session, ctl, rec, out) {
    const bot = session.bot
    for (const e of ((Object.values(bot.entities) as any[]) as any)) {
      if (ctl.aborted) break
      if (!e || !/item_frame$/.test(e.name || '') || !e.position) continue
      if (flat(e.position, rec) > 60 || frameItem(bot, e) !== 'elytra') continue
      try {
        await walk(session, ctl, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), 60000)
        await bot.lookAt(e.position, true)
        bot.attack(e)
        await sleep(400)
        await pickUp(bot, ctl, 5, 5000)
        out.disarmed.push(count(bot, 'elytra') ? 'элитры сняты с рамки' : 'рамку ударил, элитр в рюкзаке нет')
      } catch (err) { out.lines.push(`⚠ элитры: ${err.message}`) }
    }
  },

  async generic () {},
  async avoid () {}
}

// Что в рамке: предмет в метаданных сущности.
function frameItem (bot, e) {
  for (const v of ((Object.values(e.metadata || {}) as any[]) as any)) {
    if (!v || typeof v !== 'object') continue
    const id = v.itemId ?? v.blockId ?? (v.present && v.itemId)
    if (typeof id === 'number' && bot.registry.items[id]) return bot.registry.items[id].name
  }
  return null
}

// После сундуков: добыча вне сундуков по виду постройки.
async function extras (session, ctl, rec, out, p) {
  const bot = session.bot
  const R = bot.registry.blocksByName
  // Пустынный храм: 9 TNT под плитой. Плита снята — копать безопасно
  // (TNT от кирки не взрывается).
  if (rec.kind === 'desert_pyramid' && rec.plate && p.tnt === true) { // TNT спидрану не нужен (дракон — кроватями): только по просьбе
    const pp = v3(rec.plate)
    const feet = bot.entity.position.floored()
    let tnt = 0
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (ctl.aborted) break
        const col = pp.offset(dx, 0, dz)
        if (col.x === feet.x && col.z === feet.z) continue
        const t = pp.offset(dx, -2, dz)
        const tb = bot.blockAt(t)
        if (!tb || tb.name !== 'tnt') continue
        const fl = pp.offset(dx, -1, dz)
        const fb = bot.blockAt(fl)
        if (fb && fb.boundingBox === 'block' && canReach(bot, fl)) await digAt(session, ctl, fl, { maxMs: 4000, walkMs: 1 })
        if (canReach(bot, t)) { const r = await digAt(session, ctl, t, { maxMs: 2000, walkMs: 1 }); if (r.ok) tnt++ }
      }
    }
    if (tnt) {
      // Шашки упали в яму на 2 ниже — спуститься и собрать.
      try { await walk(session, ctl, new goals.GoalNear(pp.x, pp.y - 2, pp.z, 1), 8000) } catch {}
      await pickUp(bot, ctl, 4, 5000)
      out.disarmed.push(`TNT из-под плиты: ${tnt} шашек выкопано (${count(bot, 'tnt')} в рюкзаке)`)
    }
  }
  // Руины портала: золотые блоки (1 блок = 9 слитков на бартер) и счёт обсидиана.
  if (rec.kind === 'ruined_portal' || rec.kind === 'ruined_portal_nether') {
    const gold = seenNear(bot, ['gold_block'], rec, 12, 6)
    if (gold.length && count(bot, /^(iron|diamond|netherite)_pickaxe$/) > 0 && p.gold !== false && !(rec.kind === 'ruined_portal_nether' && piglinsNear(bot).length)) {
      let n = 0
      for (const g of gold) { if (ctl.aborted) break; const r = await digAt(session, ctl, g, { maxMs: 8000 }); if (r.ok) n++ }
      await pickUp(bot, ctl, 6, 5000)
      if (n) out.disarmed.push(`золотых блоков: ${n} (×9 слитков — бартер с пиглинами за жемчуг)`)
    }
    const obs = seenNear(bot, ['obsidian'], rec, 12, 64).length
    const cry = seenNear(bot, ['crying_obsidian'], rec, 12, 64).length
    const have = count(bot, 'obsidian')
    const dpick = count(bot, /^(diamond|netherite)_pickaxe$/) > 0
    const lighter = count(bot, /^(flint_and_steel|fire_charge)$/) > 0
    rec.note = `обсидиан: в рамке ${obs}, плачущий ${cry} (для рамки не годится), в рюкзаке ${have}`
    out.portal = { frameObsidian: obs, crying: cry, bagObsidian: have, need: 10, diamondPick: dpick, lighter }
    out.lines.push(have >= 10
      ? `▸ обсидиана ${have} — хватит на рамку 4×5 без углов (10); ${lighter ? 'огниво есть' : 'огниво: железо + кремень'} → mc_portal`
      : dpick
        ? `▸ обсидиан: ${have} в рюкзаке + ${obs} в рамке руин (алмазная кирка есть — выкопать) → на рамку нужно 10`
        : `▸ обсидиан: ${have} из 10; рамку руин без алмазной кирки не выкопать — достроить отливкой из лавы ведром воды (mc_obsidian), ${cry} плачущих не годятся`)
  }
  // Деревня: кровати (ночь, дракон), сено на хлеб, спелые грядки.
  if (rec.kind === 'village') {
    const beds = count(bot, /_bed$/)
    const want = Math.max(0, (p.beds ?? 3) - beds)
    if (want > 0) {
      const found = seenNear(bot, BEDS.filter(n => R[n]), rec, KINDS.village.lootR, 16)
      const heads = []
      for (const q of found) {
        const b = bot.blockAt(q)
        let part = null
        try { part = b.getProperties().part } catch {}
        if (part === 'head' || part === null) heads.push(q)
      }
      let got = 0
      for (const h of heads) {
        if (ctl.aborted || got >= want) break
        if ((Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'villager' && e.position && e.position.distanceTo(h) < 1.5)) continue
        const before = count(bot, /_bed$/)
        const r = await digAt(session, ctl, h, { maxMs: 3000 })
        if (r.ok) { await pickUp(bot, ctl, 4, 4000); if (count(bot, /_bed$/) > before) got++ }
      }
      if (got) out.disarmed.push(`кроватей из домов: ${got} (стало ${count(bot, /_bed$/)}) — ночь и взрывы у дракона`)
    }
    const edible = count(bot, /^(bread|cooked_[a-z_]+|baked_potato|golden_carrot|apple|carrot)$/)
    if (edible < 16 && p.food !== false) {
      const hay = seenNear(bot, ['hay_block'], rec, KINDS.village.lootR, 3)
      let n = 0
      for (const h of hay.slice(0, 2)) { if (ctl.aborted) break; const r = await digAt(session, ctl, h, { maxMs: 3000 }); if (r.ok) n++ }
      const crops = []
      for (const [name, ripe] of [['wheat', 7], ['carrots', 7], ['potatoes', 7], ['beetroots', 3]]) {
        if (!R[name]) continue
        for (const q of seenNear(bot, [name], rec, 48, 24)) {
          const b = bot.blockAt(q)
          let age: any = -1
          try { age = b.getProperties().age } catch {}
          if (age >= ripe) crops.push(q)
        }
      }
      let c = 0
      for (const q of crops.slice(0, 12)) { if (ctl.aborted) break; const r = await digAt(session, ctl, q, { maxMs: 1500 }); if (r.ok) c++ }
      await pickUp(bot, ctl, 8, 6000)
      if (n || c) out.disarmed.push(`еда: сена ${n} (×9 пшеницы = 3 хлеба), спелых грядок ${c}`)
    }
  }
}

// ------------------------------------------------------------------ намерение

function pickTarget (session, p) {
  const bot = session.bot
  const dim = dimOf(bot)
  const me = bot.entity.position
  const list = listOf(session).filter(r => r.dim === dim && (!p.kind || r.kind === p.kind))
  if (typeof p.x === 'number' && typeof p.z === 'number') {
    const pos = { x: p.x, y: p.y ?? me.y, z: p.z }
    return list.filter(r => flat(r, pos) <= Math.max(24, (KINDS[r.kind] || {}).lootR || 0)).sort((a, b) => flat(a, pos) - flat(b, pos))[0] || null
  }
  return list.filter(r => !r.done || p.again).sort((a, b) => flat(a, me) - flat(b, me))[0] || null
}

// Карты сокровищ в рюкзаке → клад в память построек (крестик и своя метка — treasure-map). Вне карты — место примерное
// (rough): уточнится, когда тело войдёт в карту. [{ x, z, rough, id }]
function readTreasureMaps (session) {
  const bot = session.bot
  if (!bot || !bot.inventory || dimOf(bot) !== 'overworld') return []
  const tm = require('./treasure-map')
  const out = []
  for (const m of tm.read(bot)) {
    const at = Number.isFinite(m.x) ? { x: m.x, z: m.z } : m.toward
    if (!at) continue
    const rough = !Number.isFinite(m.x)
    const same = listOf(session).find(r => r.kind === 'buried_treasure' && r.map === m.id)
    if (same) {
      if (same.rough && (same.x !== at.x || same.z !== at.z || !rough)) patchRec(session, same, r => { r.x = at.x; r.z = at.z; r.rough = rough })
    } else {
      const r = remember(session, { kind: 'buried_treasure', at: { x: at.x, y: 62, z: at.z }, evidence: [rough ? 'карта сокровищ (я вне карты — место примерно)' : 'карта сокровищ'] }, 'overworld')
      patchRec(session, r.rec, x => { x.map = m.id; x.rough = rough })
    }
    out.push({ ...at, rough, id: m.id })
  }
  return out
}

// Клад: место — по карте сокровищ в рюкзаке (крестик и своя метка, treasure-map; главная метрика — только так). Точка
// снаружи (поток route в строке «известный сид»: seedtool, клад на (чанк·16 + 9, чанк·16 + 9)) — без карты, не в главной.
// BuriedTreasurePieces 1.21.11: от OCEAN_FLOOR_WG вниз до первой клетки, под которой песчаник/камень/андезит/гранит/
// диорит, — там сундук (песок над ним). Копаю свой столбец сверху, только видимые блоки (bot.dig по верхней грани
// стоя на столбце), пока под ногами не сундук; под водой глубже 2 — не лезу.
async function treasureDig (session, ctl, p) {
  const bot = session.bot
  // По карте сокровищ: вне карты место примерное — дойти к нему и прочитать карту снова (метка игрока станет на карту).
  let byMap = false
  let exact = false
  let mapId = null
  for (let k = 0; k < 4 && !ctl.aborted; k++) {
    // Карта одна на поход (их бывает две — ревью Codex q2).
    const m = readTreasureMaps(session).find(q => mapId !== null ? q.id === mapId : Math.hypot(q.x - p.x, q.z - p.z) < 600)
    if (!m) break
    byMap = true
    mapId = m.id
    exact = !m.rough
    p = { ...p, x: m.x, z: m.z }
    const d = Math.hypot(m.x - bot.entity.position.x, m.z - bot.entity.position.z)
    if (!m.rough && d < 24) break
    try { await walk(session, ctl, new goals.GoalNearXZ(m.x, m.z, m.rough ? 8 : 3), Math.min(240000, 30000 + d * 900)) } catch {}
    if (!m.rough) break
  }
  const out: any = { lines: [], took: {}, chests: [], structure: { kind: 'buried_treasure', name: 'клад', at: { x: p.x, z: p.z } } }
  // Примерное место (я вне карты) — не клетка клада: не копать, пока карта не прочитана точно.
  if (ctl.aborted || (byMap && !exact)) { out.stopped = ctl.aborted ? 'прервано' : 'карта ещё не уточнена — не копаю примерную клетку'; return out }
  const x = Math.floor(p.x); const z = Math.floor(p.z)
  const me0 = bot.entity.position
  if (!byMap && Math.hypot(me0.x - (x + 0.5), me0.z - (z + 0.5)) > (p.maxDistance ?? 96)) { out.stopped = `до клада ${Math.round(Math.hypot(me0.x - x, me0.z - z))} бл. — сначала дойти`; return out }
  try { await walk(session, ctl, new goals.GoalXZ(x, z), 40000) } catch (e) { out.lines.push(`⚠ дорога: ${e.message}`) }
  const feet0 = bot.entity.position.floored()
  if (feet0.x !== x || feet0.z !== z) { out.stopped = `не встал на столбец клада ${x},${z}`; return out }
  if (headWet(bot)) { out.stopped = 'клад под водой — не копаю'; return out }
  // Клад — ровно в клетке (9, 9) чанка (locate_offset buried_treasures), сундук под песком над песчаником/камнем:
  // копать свой столбец сверху, только блок под ногами (виден).
  const dd = await digDown(session, ctl, { maxDepth: 16 })
  const chest = dd.chest
  if (!chest) { out.stopped = dd.stopped || 'сундука клада не нашёл в столбце'; return out }
  out.lines.push(`▸ клад: сундук на ${chest.x},${chest.y},${chest.z}`)
  try {
    const r = await takeOnce(session, ctl, chest, { kind: 'buried_treasure' })
    out.chests.push(r)
    for (const [k, v] of (Object.entries(r.took || {}) as [string, any][])) out.took[k] = (out.took[k] || 0) + v
    if (r.stopped) out.lines.push(`⚠ ${r.stopped}`)
  } catch (e) { out.stopped = `сундук клада: ${e.message}` }
  const tookText = (Object.entries(out.took) as [string, any][]).map(([k, v]) => `${k}×${v}`)
  if (tookText.length) out.lines.push(`▸ взял: ${tookText.join(', ')}`)
  // Взят — только открытый сундук; запись клада в памяти — взята (ревью Codex q2: done ставился и при ошибке открытия).
  out.done = !out.stopped && out.chests.length > 0
  if (out.done) {
    const r0 = listOf(session).find(r => r.kind === 'buried_treasure' && (mapId !== null ? r.map === mapId : Math.hypot(r.x - x, r.z - z) < 3))
    if (r0) patchRec(session, r0, r => { r.done = true })
  }
  return out
}

// Зайти в постройку: дойти, обезвредить, забрать ценное. p: kind, x/y/z,
// loot (true), force, tnt, beds, gold, food, maxDistance, chestsOnly.
async function explore (session, ctl, p: any = {}) {
  const bot = session.bot
  if (p.kind === 'buried_treasure' && Number.isFinite(p.x) && Number.isFinite(p.z)) return treasureDig(session, ctl, p)
  const out: any = { lines: [], disarmed: [], fought: [], chests: [], took: {}, why: {}, left: {}, skipped: [] }
  // Сначала оглядеться: может, видно что-то новое.
  const look0 = scan(session, { radius: 48 })
  let rec = pickTarget(session, p)
  // Место из карты копии этого же мира (поток route: seedtool знает деревню, руины, корабль; AGENTS.md — разрешено):
  // глазами с подхода постройку не узнал (дома заслоняют колокол и грядки — rt-S1 03.10, слот 27: «деревня не знаю
  // рядом» в 24 бл. от её места) — запись по карте, дальше как с увиденной: обработчик, сундуки в её радиусе.
  if (!rec && p.fromMap && p.kind && KINDS[p.kind] && Number.isFinite(p.x) && Number.isFinite(p.z)) {
    const me0 = bot.entity.position
    rec = remember(session, { kind: p.kind, at: { x: Math.round(p.x), y: Math.round(Number.isFinite(p.y) ? p.y : me0.y), z: Math.round(p.z) }, evidence: ['карта копии мира'] }, dimOf(bot)).rec
  }
  if (!rec) {
    const hint: any = p.kind ? whereNext(session, p.kind) : null
    return {
      stopped: p.kind ? `${(KINDS[p.kind] || {}).ru || p.kind} не знаю рядом` : 'ни одной невзятой постройки в памяти этого мира',
      seen: look0.found.map(d => `${d.name} ${d.dist} бл.`),
      where: hint ? hint.text : undefined,
      lines: [`▸ ${hint ? hint.text : 'осмотрись (mc_structure mode=scan) или иди разведкой (mc_explore)'}`]
    }
  }
  const K = KINDS[rec.kind]
  const me = bot.entity.position
  const dist = Math.round(flat(me, rec))
  out.structure = { kind: rec.kind, name: K.ru, at: { x: rec.x, y: rec.y, z: rec.z }, dist }
  out.lines.push(`▸ ${K.ru} на ${rec.x},${rec.y},${rec.z} (${dist} бл.): ${K.value}`)
  if (K.handler === 'avoid' && !p.force) {
    out.stopped = `${K.ru}: ${K.danger} — не лезу без force`
    return out
  }
  if (dist > (p.maxDistance ?? 128)) {
    out.stopped = `до ${K.ru} ${dist} блоков — сначала mc_goto ${rec.x} ${rec.z} (или maxDistance)`
    return out
  }
  out.lines.push(`▸ опасность: ${K.danger}`)
  // Дойти до постройки (близко к центру; дальше обработчик).
  if (dist > 10 && !(swimming(bot) || underwater(bot, rec))) {
    try { await walk(session, ctl, new goals.GoalNear(rec.x, rec.y, rec.z, Math.min(8, K.r)), Math.min(120000, 20000 + dist * 700)) } catch (e) {
      out.lines.push(`⚠ дорога: ${e.message}`)
    }
  } else if (Math.hypot(bot.entity.position.x - rec.x, bot.entity.position.z - rec.z) > 8 && (swimming(bot) || underwater(bot, rec))) {
    // Под водой видно на ~20 бл.: подплыть поверху к точке над постройкой — глазам в ~10 бл. от неё, узнать шаблон.
    // Под сторожем воздуха: swimTo у цели ныряет отвесно.
    await withAir(session, ctl, sub => swimTo(session, sub, { x: rec.x, y: Math.max((rec.y ?? 50) + 8, 60), z: rec.z }, { reach: 4, ms: Math.min(60000, 15000 + dist * 600) }), 1)
  }
  if (ctl.aborted) return out
  // Глазами ещё раз — уточнить центр и улики.
  scan(session, { radius: 48 })
  rec = pickTarget(session, { ...p, kind: rec.kind, x: rec.x, y: rec.y, z: rec.z, again: true }) || rec
  // Рабочая копия: обработчики пишут в неё (плита, центр камеры, заметка),
  // а не в память; запись в памяти ищется по исходной.
  const orig = rec
  // Шаблон — до обработчика: где сундуки, плита храма, люк иглу, дома деревни. Под водой глубоко (корабль на 20 бл. ниже
  // поверхности — ферма 14.10, 642,42,-597: с поверхности «не узнан») — нырнуть к постройке и узнавать там.
  let tf = null
  const wetKind = rec.kind === 'shipwreck' || rec.kind === 'ocean_ruin'
  if (wetKind && templatesOn() && (swimming(bot) || underwater(bot, rec)) && bot.entity.position.offset(0, 1.62, 0).distanceTo(v3(rec).offset(0.5, 0.5, 0.5)) > 14) {
    await withAir(session, ctl, async sub => {
      await swimTo(session, sub, { x: rec.x, y: (rec.y ?? 50) + 6, z: rec.z }, { reach: 3, ms: 20000 })
      tf = templateFit(session, orig, out)
    }, 1)
  }
  rec = { ...rec, tf: K.handler === 'avoid' && !p.force ? null : (tf || templateFit(session, orig, out)) }
  // Не узнан с места подхода (вплотную к стене иглу видно 9 блоков — ферма 14.10, иглу 164,-215) — обойти: до 4 точек
  // вокруг на расстоянии обзора, взглянуть на постройку и узнать снова (увиденное копится в памяти глаз).
  if (!rec.tf && !wetKind && templatesOn() && TEMPLATE_KINDS[rec.kind] && rec.kind !== 'village' && (K.handler !== 'avoid' || p.force)) {
    const ring = Math.max(9, Math.round(TEMPLATE_KINDS[rec.kind] / 2))
    const me0 = bot.entity.position
    const a0 = Math.atan2(me0.x - rec.x, me0.z - rec.z)
    for (let i = 0; i < 4 && !rec.tf && !ctl.aborted; i++) {
      const a = a0 + (i + 1) * Math.PI / 2
      try { await walk(session, ctl, new goals.GoalNear(Math.round(rec.x + Math.sin(a) * ring), Number.isFinite(rec.y) ? rec.y : Math.floor(me0.y), Math.round(rec.z + Math.cos(a) * ring), 2), 15000) } catch {}
      try { await bot.lookAt(v3(rec).offset(0.5, 1, 0.5), true) } catch {}
      await sleep(300)
      const t = templateFit(session, orig, null)
      if (t) { rec = { ...rec, tf: t }; out.lines.push(`▸ шаблон: ${t.name} (сундуков по шаблону ${t.chests.length}) — узнан с обхода, точка ${i + 1}`) }
    }
  }
  const hp = bot.health ?? 20
  if (hp < 10 && !p.force) { out.stopped = `${Math.round(hp)} хп — сначала поесть/отлечиться`; return out }
  await HANDLERS[K.handler](session, ctl, rec, out, p)
  if (!out.abort && !ctl.aborted && p.loot !== false) await lootAll(session, ctl, rec, out, p)
  if (!out.abort && !ctl.aborted && !rec.stay && !p.chestsOnly) await extras(session, ctl, rec, out, p)
  // Подвал иглу — наверх по лестнице.
  if (rec.ladderUp && !ctl.aborted && bot.entity.position.y < rec.ladderUp.y) out.lines.push(await ladderUp(session, ctl, rec.ladderUp) ? '▸ из подвала иглу поднялся' : '⚠ из подвала иглу по лестнице не поднялся')
  // Под водой работу не бросаем: сначала всплыть (автопилот в открытом море
  // берег ищет pathfinder'ом и не находит — бот тонул на месте).
  if (headWet(bot)) await breathe(bot, ctl, 20000, session)
  // Карта сокровищ из сундука корабля или руин — прочитать (крестик и своя метка) и запомнить клад.
  if (out.took.filled_map || out.took.map) {
    await sleep(600)
    for (const m of readTreasureMaps(session)) out.lines.push(`▸ карта сокровищ: клад ${m.rough ? 'примерно ' : ''}на ${m.x},${m.z} (${Math.round(Math.hypot(m.x - bot.entity.position.x, m.z - bot.entity.position.z))} бл.)`)
  }
  // Итог: что взято и зачем.
  const tookText = (Object.entries(out.took) as [string, any][]).map(([k, v]) => `${k}×${v}`)
  if (tookText.length) out.lines.push(`▸ взял: ${tookText.join(', ')}`)
  const reasons = [...new Set((Object.values(out.why) as any[]))].slice(0, 5)
  if (reasons.length) out.lines.push(`▸ зачем: ${reasons.join('; ')}`)
  const left = (Object.entries(out.left) as [string, any][]).map(([k, v]) => `${k}×${v}`)
  if (left.length) out.lines.push(`▸ оставил: ${left.slice(0, 8).join(', ')} — не нужно для победы`)
  for (const d of out.disarmed) out.lines.push(`▸ ${d}`)
  for (const s of out.skipped) out.lines.push(`⚠ не тронул ${s.at.x},${s.at.y},${s.at.z}: ${s.why}`)
  const lootedNow = lootedSet(session)
  const leftPlanned = ((rec.tf && rec.tf.chests) || []).filter(c => Number.isFinite(c.y) && !lootedNow.has(keyOf(c)) && !lootedNow.has(`miss:${keyOf(c)}`)).length
  const leftChests = containersNear(session, rec, rec.lootR || K.lootR || K.r, rec.yR || K.yR || 16).filter(q => !lootedNow.has(keyOf(q))).length + leftPlanned
  // Постройка с шаблоном, а шаблон не узнан и сундуков не видно — не «взята»: узнается с другого места.
  const unknownTemplate = !!TEMPLATE_KINDS[rec.kind] && templatesOn() && !rec.tf && !out.chests.length
  const allDone = !out.abort && !ctl.aborted && !rec.stay && leftChests <= out.skipped.length && !unknownTemplate
  if (allDone) patchRec(session, orig, r => { r.done = true; if (rec.note) r.note = rec.note })
  else if (rec.note) patchRec(session, orig, r => { r.note = rec.note })
  out.done = allDone
  if (!tookText.length && !out.disarmed.length && !out.stopped) out.stopped = out.chests.length ? 'в сундуках ничего ценного' : 'сундуков не нашёл'
  const { abort, ...rest } = out
  return rest
}

// ------------------------------------------------------------------ фоном

// Раз в 8 с — честный осмотр; новая постройка — событие structure_seen.
function install (session) {
  if (session._structuresTimer && !session._structuresTimer.clock?.disposed) return
  session._structuresTimer = gameClock.setInterval(() => {
    try {
      const bot = session.bot
      if (!bot || !bot.entity) return
      require('./treasure-map').install(bot) // пакеты карт — до того, как карта попадёт в рюкзак
      if (session.structuresAuto === false) return
      const r = scan(session, { radius: 32 })
      for (const d of r.fresh) {
        const K = KINDS[d.kind]
        session.bus.emit('structure_seen', { kind: d.kind, name: K.ru, at: d.at, dist: d.dist, evidence: d.evidence, value: K.value, danger: K.danger, avoid: K.handler === 'avoid' })
      }
      readTreasureMaps(session)
    } catch {}
  }, 8000)
  if (session._structuresTimer.unref) session._structuresTimer.unref()
}

// Забыть постройки (вид и/или место); looted — заодно и «взятые» сундуки в
// них (сцена перестроила постройку на том же месте).
function forget (session, { kind, x, z, looted = false }: any = {}) {
  let n = 0
  let chests = 0
  session.journal.patch(s => {
    const before = (s.structures || []).length
    const gone = (s.structures || []).filter(r => (!kind || r.kind === kind) && (typeof x !== 'number' || flat(r, { x, z }) < 24))
    s.structures = (s.structures || []).filter(r => !gone.includes(r))
    n = before - s.structures.length
    if (looted && Array.isArray(s.looted)) {
      const was = s.looted.length
      s.looted = s.looted.filter(k => {
        const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(k)
        if (!m) return true
        const q = { x: +m[1], z: +m[3] }
        return !gone.some(r => flat(r, q) <= Math.max(24, (KINDS[r.kind] || {}).lootR || 0))
      })
      chests = was - s.looted.length
    }
  })
  return { forgot: n, chests }
}

module.exports = {
  KINDS, SETS, TRAP_BLOCKS, STRUCTURE_PLACES,
  scan, look, sees, gather, evaluate, whereNext, opportunities, known, compact, recordedAt, forget,
  decide, playerMarks, piglinsWatching, piglinsNear, takeWorth, takeCart, armTraps,
  explore, install, seenNear, templateFit, fitKnown, digAt, digToSee, digDown, withAir, readTreasureMaps, TEMPLATE_KINDS, remember
}
