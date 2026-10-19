'use strict'

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

function kindsFor (dim) {
  return (Object.entries(KINDS) as [string, any][]).filter(([, K]) => K.dim.includes(dim))
}

// ------------------------------------------------------------------ шаблоны

// Виды с шаблонами (data/structure-templates.json) → как узнавать. ND_STRUCT_TEMPLATES=0 — без шаблонов (только видимые
// сундуки, как до 14.10 — для замера «с шаблонами и без»).
const TEMPLATE_KINDS = { shipwreck: 32, desert_pyramid: 30, jungle_pyramid: 24, ruined_portal: 22, igloo: 16, village: 56, ocean_ruin: 22, outpost: 24 }

// Места, которые пишут модули-разведчики (не наша база). Отметка увиденной
// лавы рядом с руинами тоже не превращает их сундук в наш склад.
const STRUCTURE_PLACES = new Set(['крепость', 'крепость (ад)', 'бастион (ад)', 'спавнер блейзов', 'портал', 'портал (ад)', 'лава'])

export {
  WOODS, BEDS, CONTAINER_NAMES, DOOR_NAMES, SETS, KINDS, TRAP_BLOCKS, kindsFor, TEMPLATE_KINDS, STRUCTURE_PLACES
}
