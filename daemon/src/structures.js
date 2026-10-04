'use strict'
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
const { sleep, xyz } = require('./movement')
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
    groups: [['tripwire_hook', 'tripwire'], ['mossy_cobblestone'], ['chiseled_stone_bricks'], ['dispenser', 'sticky_piston', 'lever'], ['cobblestone_stairs']], min: 3, must: [1],
    table: 'jungle_temple', handler: 'jungle', prio: 1,
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
    groups: [['snow_block'], ['white_carpet'], ['ice'], ['redstone_torch'], ['furnace', 'crafting_table']], min: 3, must: [1],
    biomes: /snow/, table: 'igloo_chest', handler: 'generic', prio: 1,
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
  return Promise.race([p, new Promise((resolve, reject) => { t = setTimeout(() => reject(new Error(what)), ms) })]).finally(() => clearTimeout(t))
}

function kindsFor (dim) {
  return Object.entries(KINDS).filter(([, K]) => K.dim.includes(dim))
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
function look (bot, names, { radius = 40, rays = 24, enough = 8 } = {}) {
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
  for (const e of Object.values(bot.entities)) {
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
  return {
    kind,
    name: K.ru,
    at: { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) },
    evidence: [...new Set(best.got.map(g => g.n.replace(/^e:/, '')))],
    groups: best.got.length
  }
}

// Честный осмотр: что из построек видно отсюда. record — записать в память.
function scan (session, { radius = 40, record = true } = {}) {
  const bot = session.bot
  const dim = dimOf(bot)
  const kinds = kindsFor(dim)
  const names = new Set(kinds.flatMap(([, K]) => K.groups.flatMap(groupNames)))
  for (const [, K] of kinds) for (const n of (K.not || [])) names.add(n)
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
    // Раз в минуту — обновить «видел» и улики, не чаще: patch пишет файл.
    if (Date.now() - (same.t || 0) > 60000 || d.evidence.some(e => !(same.ev || []).includes(e))) {
      session.journal.patch(s => {
        const r = (s.structures || []).find(x => x === same || (x.kind === same.kind && x.dim === same.dim && x.x === same.x && x.z === same.z))
        if (r) { r.t = Date.now(); r.ev = [...new Set([...(r.ev || []), ...d.evidence])].slice(0, 8) }
      })
    }
    return { fresh: false, rec: same }
  }
  const rec = { kind: d.kind, dim, x: d.at.x, y: d.at.y, z: d.at.z, t: Date.now(), ev: d.evidence.slice(0, 8), done: false }
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

function describe (rec, me) {
  const K = KINDS[rec.kind] || {}
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
    note: rec.note || undefined
  }
}

function known (session, { all = false } = {}) {
  const bot = session.bot
  const dim = dimOf(bot)
  const me = bot.entity.position
  return listOf(session).filter(r => all || r.dim === dim).map(r => describe(r, r.dim === dim ? me : null))
    .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9))
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
function whereNext (session, kind, { from = null } = {}) {
  const K = KINDS[kind]
  if (!K) throw new Error(`не знаю постройку ${kind}; бывают: ${Object.keys(KINDS).join(', ')}`)
  const bot = session.bot
  const dim = dimOf(bot)
  const me = from || bot.entity.position
  const S = K.set ? SETS[K.set] : null
  const out = { kind, name: K.ru, dims: K.dim, biomes: biomesText(kind) }
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
function opportunities (session, { radius = 192 } = {}) {
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
function decide (bot, it, ctx = {}) {
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
  for (const [re, prio, why] of WANT) {
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
    for (const e of Object.values(bot.entities)) {
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
  return v3(pos).offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) <= reach
}

// Сломать блок: подойти, взять лучший инструмент (или названный), копать.
async function digAt (session, ctl, pos, { tool = null, maxMs = 15000, walkMs = 25000 } = {}) {
  const bot = session.bot
  const p = v3(pos)
  let b = bot.blockAt(p)
  if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'water') return { ok: true, name: b && b.name }
  const name = b.name
  if (!canReach(bot, p)) {
    for (const g of [() => new goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), () => new goals.GoalNear(p.x, p.y, p.z, 2)]) {
      if (ctl.aborted) break
      try { await walk(session, ctl, g(), walkMs) } catch {}
      if (canReach(bot, p)) break
    }
  }
  if (!canReach(bot, p)) return { ok: false, name, why: 'не дотянуться' }
  b = bot.blockAt(p)
  if (!b || b.name !== name) return { ok: true, name }
  try {
    const it = tool ? bot.inventory.items().find(i => i.name === tool) : require('./tools').bestFor(bot, b).item
    if (it && (!bot.heldItem || bot.heldItem.name !== it.name)) await bot.equip(it, 'hand')
  } catch {}
  try { await withTimeout(bot.dig(b, true), maxMs, 'копал слишком долго') } catch (e) { return { ok: false, name, why: e.message } }
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
async function clearMobs (session, ctl, out, { radius = 12, rounds = 4 } = {}) {
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
  return Object.values(bot.entities).filter(e => e && /^piglin(_brute)?$/.test(e.name || '') && e.position &&
    Math.abs(e.position.x - me.x) <= 16.3 && Math.abs(e.position.y - me.y) <= 16.9 && Math.abs(e.position.z - me.z) <= 16.3 &&
    raySees(bot, e.position.offset(0, 1.6, 0), eye))
}

// Пиглины, которых разозлит сломанный золотой блок: ВСЕ в ±16, без луча
// (Block.playerWillDestroy → PiglinAi.angerNearbyPiglins(level, player, false);
// исходники 1.21.11, 2026-09-26). Для сундука взгляд нужен, для блока — нет.
function piglinsNear (bot) {
  const me = bot.entity.position
  return Object.values(bot.entities).filter(e => e && e.name === 'piglin' && e.position &&
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
  const b = bot.blockAt(bot.entity.position.offset(0, 1.62, 0))
  return !!b && (b.name === 'water' || b.name === 'bubble_column' || b.name === 'kelp' || b.name === 'kelp_plant' || b.name === 'seagrass' || b.name === 'tall_seagrass')
}

async function breathe (bot, ctl, ms = 15000) {
  try { bot.pathfinder.setGoal(null) } catch {}
  const t0 = Date.now()
  bot.setControlState('jump', true)
  try {
    while (!ctl.aborted && Date.now() - t0 < ms && headWet(bot)) await sleep(100)
    const t1 = Date.now()
    while (!ctl.aborted && Date.now() - t1 < 5000 && air(bot) < 19) await sleep(200)
  } finally { bot.setControlState('jump', false) }
  return !headWet(bot)
}

const WET = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/
function wetAt (bot, p) { const b = bot.blockAt(p); return !!b && WET.test(b.name) }
// Цель под водой: вода рядом с ней или в столбе над ней (сундук в трюме —
// над ним палуба, а выше вода). Мы в воде: по щиколотку, по пояс, по голову.
function underwater (bot, pos) {
  const p = v3(pos).floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (wetAt(bot, p.offset(dx, 0, dz))) return true
  for (let dy = 1; dy <= 16; dy++) {
    const q = p.offset(0, dy, 0)
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
async function swimTo (session, ctl, pos, { reach = 4, ms = 25000 } = {}) {
  const bot = session.bot
  const aim = v3(pos).floored()
  const target = aim.offset(0.5, 0.5, 0.5)
  const t0 = Date.now()
  let best = Infinity
  let bestAt = Date.now()
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
    while (!ctl.aborted && Date.now() - t0 < ms) {
      const eye = bot.entity.position.offset(0, 1.62, 0)
      if (eye.distanceTo(target) <= reach) return true
      try { await bot.lookAt(target, true) } catch {}
      const dy = target.y - eye.y
      const flatD = Math.hypot(target.x - eye.x, target.z - eye.z)
      // Как человек: поверху — до точки над целью (воздух не тратится),
      // потом отвесно вниз. Под водой плывём ~0.6 бл/с, воздуха на 15 с.
      const above = flatD <= 2.5
      bot.setControlState('forward', flatD > 0.7)
      bot.setControlState('sneak', above && dy < -0.8)
      bot.setControlState('jump', (!above && headWet(bot)) || dy > 0.3)
      await sleep(250)
      const now = bot.entity.position
      const d = now.offset(0, 1.62, 0).distanceTo(target)
      if (process.env.ND_DEBUG_STRUCT) console.log('[swim]', now.x.toFixed(1), now.y.toFixed(1), now.z.toFixed(1), 'dy', dy.toFixed(1), 'flat', flatD.toFixed(1), 'air', air(bot).toFixed(1))
      if (d < best - 0.4) { best = d; bestAt = Date.now() }
      // Полторы секунды без продвижения — упёрся: сломать, что между нами
      // (луч к цели), а нет — что перед ногами/головой по курсу.
      if (Date.now() - bestAt > 1500) {
        off()
        bestAt = Date.now()
        const dir = target.minus(eye).normalize()
        let hit = null
        try { hit = bot.world.raycast(eye, dir, 4.5, b => b.boundingBox === 'block' && !b.position.equals(aim)) } catch {}
        if (!hit || !canReach(bot, hit.position, 4.5)) {
          const yaw = Math.atan2(target.x - now.x, target.z - now.z)
          const ahead = now.offset(Math.sin(yaw) * 0.9, 0, Math.cos(yaw) * 0.9).floored()
          for (const q of [ahead.offset(0, 1, 0), ahead, dy < -0.8 ? now.floored().offset(0, -1, 0) : null]) {
            const b = q && bot.blockAt(q)
            if (b && b.boundingBox === 'block' && !b.position.equals(aim)) { hit = b; break }
          }
        }
        if (hit && canReach(bot, hit.position, 4.5)) {
          // Под водой копается впятеро дольше (без «Подводника»).
          const r = await digAt(session, ctl, hit.position, { maxMs: 12000, walkMs: 1 })
          if (process.env.ND_DEBUG_STRUCT) console.log('[swim] dig', hit.name, hit.position.toString(), JSON.stringify(r))
        } else { bot.setControlState('jump', true); await sleep(400) }
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
  const sub = { aborted: false, onAbort: [] }
  sub.abort = () => {
    if (sub.aborted) return
    sub.aborted = true
    for (const fn of sub.onAbort) { try { fn() } catch {} }
  }
  ctl.onAbort.push(() => sub.abort())
  if (ctl.aborted) sub.abort()
  return sub
}

// Открыть сундук, взять ценное по decide(), хлам оставить. Отчёт с «зачем».
// Под водой — до трёх нырков: воздуха меньше 6 из 20 — всплыть, отдышаться.
async function takeWorth (session, ctl, pos, opts = {}) {
  const bot = session.bot
  let lastErr = null
  for (let dive = 0; dive < 3 && !ctl.aborted; dive++) {
    const sub = childCtl(ctl)
    let drowning = false
    const guard = setInterval(() => {
      if (air(bot) < 7 && headWet(bot)) { drowning = true; sub.abort() }
    }, 250)
    try {
      return await takeOnce(session, sub, pos, opts)
    } catch (e) {
      lastErr = e
      if (!drowning) throw e
    } finally { clearInterval(guard) }
    await breathe(bot, ctl)
  }
  throw lastErr || new Error('прервано')
}

async function takeOnce (session, ctl, pos, { kind = null } = {}) {
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
  const deadline = Date.now() + 25000
  armTraps(session)
  if (underwater(bot, at) || swimming(bot)) await swimTo(session, ctl, at, { reach: 3.4 })
  // Сундук под твёрдым блоком не открывается (ChestBlock.isChestBlockedAt):
  // в трюме корабля над ним палуба — сломать её, как сделал бы человек.
  const lid = bot.blockAt(v3(at).offset(0, 1, 0))
  if (lid && lid.boundingBox === 'block' && !/chest|barrel/.test(lid.name) && (bot.blockAt(v3(at)) || {}).name !== 'barrel') {
    await digAt(session, ctl, lid.position, { maxMs: 6000, walkMs: 20000 })
  }
  const { block, win } = await containers.findAndOpen(session, ctl, at, deadline)
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
  markLooted(session, keyOf(block.position))
  const took = (pass && pass.took) || {}
  const why = {}
  for (const p of plan) if (took[p.name]) why[p.name] = p.why
  const left = {}
  for (const p of plan) if (!p.take) left[p.name] = p.count
  const text = Object.entries(took).map(([k, v]) => `${k}×${v}`).join(', ') || 'ничего ценного'
  try { session.journal.append('лут', `${(KINDS[kind] || {}).ru || 'сундук'} ${at.x},${at.y},${at.z}: ${text}`, bot.entity.position) } catch {}
  return { at, kind: block.name, took, why, left, notTaken: pass && Object.keys(pass.left || {}).length ? pass.left : undefined, stopped: (pass && pass.stopped) || undefined }
}

// Вагонетка с сундуком: shift-клик только ценного.
async function takeCart (session, ctl, cart) {
  const bot = session.bot
  const t0 = Date.now()
  bot.pathfinder.setGoal(new goals.GoalFollow(cart, 2))
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  while (!ctl.aborted && Date.now() - t0 < 30000 && cart.isValid !== false && cart.position.distanceTo(bot.entity.position) > 3) await sleep(200)
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

function containersNear (session, center, R, yR = 16) {
  const bot = session.bot
  const ids = CONTAINER_NAMES.map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
  let found = []
  try { found = bot.findBlocks({ matching: ids, point: v3(center), maxDistance: R, count: 32 }) } catch {}
  return found.filter(p => Math.abs(p.y - center.y) <= yR)
}

function merge (out, r) {
  for (const [k, v] of Object.entries(r.took || {})) out.took[k] = (out.took[k] || 0) + v
  Object.assign(out.why, r.why || {})
  for (const [k, v] of Object.entries(r.left || {})) out.left[k] = (out.left[k] || 0) + v
}

async function lootAll (session, ctl, rec, out, p) {
  const bot = session.bot
  const K = KINDS[rec.kind]
  const R = rec.lootR || K.lootR || K.r
  if (!R) return
  const done = lootedSet(session)
  const center = { x: rec.x, y: rec.y, z: rec.z }
  const list = containersNear(session, center, R, rec.yR || K.yR || 16)
    .filter(q => !done.has(keyOf(q)))
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  const places = (session.journal.state && session.journal.state.places) || {}
  const here = dimOf(bot)
  for (const q of list) {
    if (ctl.aborted) break
    if ((bot.health ?? 20) < 8) { out.lines.push(`⚠ ${Math.round(bot.health)} хп — остальные сундуки потом`); break }
    const marks = p.force ? [] : playerMarks(bot, q, rec.kind)
    // Наша база рядом — не лут (как loot.js).
    const base = Object.entries(places).some(([n, pl]) => pl && typeof pl.x === 'number' && !STRUCTURE_PLACES.has(n) &&
      (pl.dimension || 'overworld') === here && Math.hypot(pl.x - q.x, pl.z - q.z) < 24 && Math.abs((pl.y ?? q.y) - q.y) < 16)
    if (base) marks.push('рядом наша база')
    if (marks.length) { out.skipped.push({ at: xyz(q), why: `поставил игрок? ${marks.join(', ')} — без решения человека не трогаю` }); continue }
    try {
      const r = await takeWorth(session, ctl, q, { kind: rec.kind })
      out.chests.push({ at: r.at, took: r.took, stopped: r.stopped })
      merge(out, r)
      if (r.stopped) out.lines.push(`⚠ сундук ${r.at.x},${r.at.y},${r.at.z}: ${r.stopped}`)
    } catch (e) {
      out.chests.push({ at: xyz(q), error: e.message })
    }
  }
  // Вагонетки с сундуком (шахта).
  for (const e of Object.values(bot.entities)) {
    if (ctl.aborted) break
    if (!e || e.name !== 'chest_minecart' || !e.position) continue
    if (flat(e.position, center) > R || done.has(`cart:${e.id}`)) continue
    try {
      const r = await takeCart(session, ctl, e)
      out.chests.push({ at: r.at, cart: true, took: r.took, stopped: r.stopped })
      merge(out, r)
    } catch (err) { out.chests.push({ at: xyz(e.position), cart: true, error: err.message }) }
  }
}

// Места, которые пишут модули-разведчики (не наша база).
const STRUCTURE_PLACES = new Set(['крепость', 'крепость (ад)', 'бастион (ад)', 'спавнер блейзов', 'портал', 'портал (ад)'])

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

  // Пустынный храм: плита над 9 TNT. Спуститься шахтой рядом с плитой, снять
  // плиту рукой (ломать — не наступать), дальше сундуки и по желанию TNT.
  async desert (session, ctl, rec, out, p) {
    const bot = session.bot
    const plateB = bot.registry.blocksByName.stone_pressure_plate
    // Центр записи — середина видимого (верх башен), камера на 12-20 ниже.
    const plate = bot.findBlock({ matching: plateB.id, point: v3(rec), maxDistance: 40 })
    if (!plate) {
      out.lines.push('▸ плиты в камере нет — снята раньше; просто сундуки')
      // Камера под центральной синей терракотой: сундуки ищем от неё.
      const blue = bot.findBlock({ matching: bot.registry.blocksByName.blue_terracotta.id, point: v3(rec), maxDistance: 40 })
      if (blue) Object.assign(rec, { x: blue.position.x, y: blue.position.y - 6, z: blue.position.z, yR: 12 })
      return
    }
    const pp = plate.position
    // Сундуки — в нишах в 2 блоках от плиты: искать от неё.
    Object.assign(rec, { x: pp.x, y: pp.y, z: pp.z, lootR: 4, yR: 2 })
    // Встать рядом с плитой, не на неё: одна из четырёх соседних клеток пола.
    let stood = false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (ctl.aborted) break
      try {
        await walk(session, ctl, new goals.GoalBlock(pp.x + dx, pp.y, pp.z + dz), 60000)
        stood = true
        break
      } catch {}
    }
    if (!stood && !canReach(bot, pp)) { out.lines.push('⚠ до камеры храма не дошёл — сундуки не трогаю (плита цела)'); out.abort = true; return }
    const r = await digAt(session, ctl, pp, { maxMs: 4000 })
    if (!r.ok) { out.lines.push(`⚠ плиту не снял (${r.why}) — дальше не иду`); out.abort = true; return }
    out.disarmed.push('нажимная плита над 9 TNT снята руками (ломать можно, наступать — нет)')
    rec.plate = xyz(pp)
  },

  // Храм в джунглях: растяжки. Ножницы — режем нить (DISARMED), без них —
  // ломаем крюки (так не стреляет); раздатчики потом — это стрелы.
  async jungle (session, ctl, rec, out) {
    const bot = session.bot
    const R = bot.registry.blocksByName
    const wires = bot.findBlocks({ matching: [R.tripwire.id], point: v3(rec), maxDistance: 16, count: 32 })
    const hooks = bot.findBlocks({ matching: [R.tripwire_hook.id], point: v3(rec), maxDistance: 16, count: 16 })
    const shears = bot.inventory.items().find(i => i.name === 'shears')
    if (shears && wires.length) {
      let cut = 0
      for (const w of wires) {
        if (ctl.aborted) break
        const r = await digAt(session, ctl, w, { tool: 'shears', maxMs: 3000 })
        if (r.ok) cut++
      }
      out.disarmed.push(`нить растяжек срезана ножницами: ${cut} из ${wires.length} (ножницы ставят «обезврежено», выстрела нет)`)
    } else if (hooks.length) {
      let broke = 0
      for (const h of hooks) {
        if (ctl.aborted) break
        const r = await digAt(session, ctl, h, { maxMs: 4000 })
        if (r.ok) broke++
      }
      out.disarmed.push(`крюки растяжек сломаны: ${broke} из ${hooks.length}${shears ? '' : ' (ножниц нет; нить без ножниц стреляет)'}`)
    }
    // Раздатчики со стрелами — если есть лук (стрелы на кристаллы).
    if (count(bot, /^(bow|crossbow)$/) > 0 && count(bot, /_pickaxe$/) > 0) {
      const disp = bot.findBlocks({ matching: [R.dispenser.id], point: v3(rec), maxDistance: 16, count: 4 })
      for (const d of disp) {
        if (ctl.aborted) break
        const r = await digAt(session, ctl, d, { maxMs: 6000 })
        if (r.ok) out.disarmed.push(`раздатчик ${d.x},${d.y},${d.z} сломан — стрелы из него на земле`)
      }
      await pickUp(bot, ctl, 6, 5000)
    }
  },

  // Руины портала: сундук, потом золотые блоки (бартер) и счёт обсидиана.
  async portal () {},
  async village () {},

  // Бастион: брутья — отказ без force; открытие сундуков проверяет глаза пиглинов.
  async bastion (session, ctl, rec, out, p) {
    const bot = session.bot
    const brutes = Object.values(bot.entities).filter(e => e && e.name === 'piglin_brute' && e.position && e.position.distanceTo(bot.entity.position) < 24)
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
    for (const e of Object.values(bot.entities)) {
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
  for (const v of Object.values(e.metadata || {})) {
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
  if (rec.kind === 'desert_pyramid' && rec.plate && p.tnt !== false) {
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
    const gold = bot.findBlocks({ matching: [R.gold_block.id], point: v3(rec), maxDistance: 12, count: 6 })
    if (gold.length && count(bot, /^(iron|diamond|netherite)_pickaxe$/) > 0 && p.gold !== false && !(rec.kind === 'ruined_portal_nether' && piglinsNear(bot).length)) {
      let n = 0
      for (const g of gold) { if (ctl.aborted) break; const r = await digAt(session, ctl, g, { maxMs: 8000 }); if (r.ok) n++ }
      await pickUp(bot, ctl, 6, 5000)
      if (n) out.disarmed.push(`золотых блоков: ${n} (×9 слитков — бартер с пиглинами за жемчуг)`)
    }
    const obs = bot.findBlocks({ matching: [R.obsidian.id], point: v3(rec), maxDistance: 12, count: 64 }).length
    const cry = bot.findBlocks({ matching: [R.crying_obsidian.id], point: v3(rec), maxDistance: 12, count: 64 }).length
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
      const ids = BEDS.map(n => R[n]).filter(Boolean).map(b => b.id)
      const found = bot.findBlocks({ matching: ids, point: v3(rec), maxDistance: KINDS.village.lootR, count: 16 })
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
        if (Object.values(bot.entities).some(e => e && e.name === 'villager' && e.position && e.position.distanceTo(h) < 1.5)) continue
        const before = count(bot, /_bed$/)
        const r = await digAt(session, ctl, h, { maxMs: 3000 })
        if (r.ok) { await pickUp(bot, ctl, 4, 4000); if (count(bot, /_bed$/) > before) got++ }
      }
      if (got) out.disarmed.push(`кроватей из домов: ${got} (стало ${count(bot, /_bed$/)}) — ночь и взрывы у дракона`)
    }
    const edible = count(bot, /^(bread|cooked_[a-z_]+|baked_potato|golden_carrot|apple|carrot)$/)
    if (edible < 16 && p.food !== false) {
      const hay = bot.findBlocks({ matching: [R.hay_block.id], point: v3(rec), maxDistance: KINDS.village.lootR, count: 3 })
      let n = 0
      for (const h of hay.slice(0, 2)) { if (ctl.aborted) break; const r = await digAt(session, ctl, h, { maxMs: 3000 }); if (r.ok) n++ }
      const crops = []
      for (const [name, ripe] of [['wheat', 7], ['carrots', 7], ['potatoes', 7], ['beetroots', 3]]) {
        if (!R[name]) continue
        for (const q of bot.findBlocks({ matching: [R[name].id], point: v3(rec), maxDistance: 48, count: 24 })) {
          const b = bot.blockAt(q)
          let age = -1
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

// Клад (поток route, 03.10.2026): место — из карты копии мира (seedtool: клад на (чанк·16 + 9, чанк·16 + 9)).
// BuriedTreasurePieces 1.21.11: от OCEAN_FLOOR_WG вниз до первой клетки, под которой песчаник/камень/андезит/гранит/
// диорит, — там сундук (песок над ним). Копаю свой столбец сверху, только видимые блоки (bot.dig по верхней грани
// стоя на столбце), пока под ногами не сундук; под водой глубже 2 — не лезу.
async function treasureDig (session, ctl, p) {
  const bot = session.bot
  const out = { lines: [], took: {}, chests: [], structure: { kind: 'buried_treasure', name: 'клад', at: { x: p.x, z: p.z } } }
  const x = Math.floor(p.x); const z = Math.floor(p.z)
  const me0 = bot.entity.position
  if (Math.hypot(me0.x - (x + 0.5), me0.z - (z + 0.5)) > (p.maxDistance ?? 96)) { out.stopped = `до клада ${Math.round(Math.hypot(me0.x - x, me0.z - z))} бл. — сначала дойти`; return out }
  try { await walk(session, ctl, new goals.GoalXZ(x, z), 40000) } catch (e) { out.lines.push(`⚠ дорога: ${e.message}`) }
  const feet0 = bot.entity.position.floored()
  if (feet0.x !== x || feet0.z !== z) { out.stopped = `не встал на столбец клада ${x},${z}`; return out }
  // Вода над кладом: столбец под ногами и над ними.
  let wet = 0
  for (let dy = -3; dy <= 1; dy++) { const b = bot.blockAt(feet0.offset(0, dy, 0)); if (b && /water/.test(b.name)) wet++ }
  if (wet >= 3 || headWet(bot)) { out.stopped = 'клад под водой — не копаю'; return out }
  let chest = null
  for (let k = 0; k < 16 && !ctl.aborted; k++) {
    const f = bot.entity.position.floored()
    const under = bot.blockAt(f.offset(0, -1, 0))
    if (!under) break
    if (/chest/.test(under.name)) { chest = under.position; break }
    // Рядом в столбце сбоку (сдвиг на клетку при обвале песка) — тоже он.
    const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => bot.blockAt(f.offset(dx, -1, dz))).find(b => b && /chest/.test(b.name))
    if (side) { chest = side.position; break }
    if (/water|lava/.test(under.name)) { out.stopped = `под ногами ${under.name} — не копаю`; break }
    if (under.name === 'bedrock') break
    const r = await digAt(session, ctl, under.position, { maxMs: 8000, walkMs: 1 })
    if (!r.ok) { out.stopped = `не копается ${under.name}: ${r.why || '?'}`; break }
    // Дождаться падения на клетку ниже (сыпучее сверху — успеть увернуться не нужно: столбец 1×1 копаем под собой).
    const t0 = Date.now()
    while (Date.now() - t0 < 1500 && bot.entity.position.floored().y >= f.y && !ctl.aborted) await sleep(80)
    if (headWet(bot)) { out.stopped = 'в столбце вода — клад бросаю'; break }
  }
  if (!chest) { if (!out.stopped) out.stopped = 'сундука клада не нашёл в столбце'; return out }
  out.lines.push(`▸ клад: сундук на ${chest.x},${chest.y},${chest.z}`)
  try {
    const r = await takeOnce(session, ctl, chest, { kind: 'buried_treasure' })
    out.chests.push(r)
    for (const [k, v] of Object.entries(r.took || {})) out.took[k] = (out.took[k] || 0) + v
    if (r.stopped) out.lines.push(`⚠ ${r.stopped}`)
  } catch (e) { out.stopped = `сундук клада: ${e.message}` }
  const tookText = Object.entries(out.took).map(([k, v]) => `${k}×${v}`)
  if (tookText.length) out.lines.push(`▸ взял: ${tookText.join(', ')}`)
  out.done = true
  return out
}

// Зайти в постройку: дойти, обезвредить, забрать ценное. p: kind, x/y/z,
// loot (true), force, tnt, beds, gold, food, maxDistance, chestsOnly.
async function explore (session, ctl, p = {}) {
  const bot = session.bot
  if (p.kind === 'buried_treasure' && Number.isFinite(p.x) && Number.isFinite(p.z)) return treasureDig(session, ctl, p)
  const out = { lines: [], disarmed: [], fought: [], chests: [], took: {}, why: {}, left: {}, skipped: [] }
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
    const hint = p.kind ? whereNext(session, p.kind) : null
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
  }
  if (ctl.aborted) return out
  // Глазами ещё раз — уточнить центр и улики.
  scan(session, { radius: 48 })
  rec = pickTarget(session, { ...p, kind: rec.kind, x: rec.x, y: rec.y, z: rec.z, again: true }) || rec
  // Рабочая копия: обработчики пишут в неё (плита, центр камеры, заметка),
  // а не в память; запись в памяти ищется по исходной.
  const orig = rec
  rec = { ...rec }
  const hp = bot.health ?? 20
  if (hp < 10 && !p.force) { out.stopped = `${Math.round(hp)} хп — сначала поесть/отлечиться`; return out }
  await HANDLERS[K.handler](session, ctl, rec, out, p)
  if (!out.abort && !ctl.aborted && p.loot !== false) await lootAll(session, ctl, rec, out, p)
  if (!out.abort && !ctl.aborted && !p.chestsOnly) await extras(session, ctl, rec, out, p)
  // Под водой работу не бросаем: сначала всплыть (автопилот в открытом море
  // берег ищет pathfinder'ом и не находит — бот тонул на месте).
  if (headWet(bot)) await breathe(bot, { aborted: false, onAbort: [] }, 20000)
  // Итог: что взято и зачем.
  const tookText = Object.entries(out.took).map(([k, v]) => `${k}×${v}`)
  if (tookText.length) out.lines.push(`▸ взял: ${tookText.join(', ')}`)
  const reasons = [...new Set(Object.values(out.why))].slice(0, 5)
  if (reasons.length) out.lines.push(`▸ зачем: ${reasons.join('; ')}`)
  const left = Object.entries(out.left).map(([k, v]) => `${k}×${v}`)
  if (left.length) out.lines.push(`▸ оставил: ${left.slice(0, 8).join(', ')} — не нужно для победы`)
  for (const d of out.disarmed) out.lines.push(`▸ ${d}`)
  for (const s of out.skipped) out.lines.push(`⚠ не тронул ${s.at.x},${s.at.y},${s.at.z}: ${s.why}`)
  const leftChests = containersNear(session, rec, rec.lootR || K.lootR || K.r, rec.yR || K.yR || 16).filter(q => !lootedSet(session).has(keyOf(q))).length
  const allDone = !out.abort && !ctl.aborted && leftChests <= out.skipped.length
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
  if (session._structuresTimer) return
  session._structuresTimer = setInterval(() => {
    try {
      const bot = session.bot
      if (!bot || !bot.entity || session.structuresAuto === false) return
      const r = scan(session, { radius: 32 })
      for (const d of r.fresh) {
        const K = KINDS[d.kind]
        session.bus.emit('structure_seen', { kind: d.kind, name: K.ru, at: d.at, dist: d.dist, evidence: d.evidence, value: K.value, danger: K.danger, avoid: K.handler === 'avoid' })
      }
    } catch {}
  }, 8000)
  if (session._structuresTimer.unref) session._structuresTimer.unref()
}

// Забыть постройки (вид и/или место); looted — заодно и «взятые» сундуки в
// них (сцена перестроила постройку на том же месте).
function forget (session, { kind, x, z, looted = false } = {}) {
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
  explore, install
}
