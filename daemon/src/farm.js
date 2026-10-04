'use strict'
const Vec3 = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const { withTimeout } = require('./build')
const { countItems, diffItems, equipBestTool, itemNamed, usesLeft } = require('./items')
const obsidianMod = require('./obsidian')
const { biomeName } = require('./perception')

// Грядки: вспахать, полить, посадить, удобрить, собрать и посадить заново;
// тростник, бамбук и кактус — срезать верх, корень оставить; арбузы и тыквы —
// ломать плод, стебель не трогать.
//
// Всё сверено с paper-1.21.11.jar (javap), а не с памятью:
//  · HoeItem.TILLABLES: grass_block, dirt_path, dirt → farmland (только если
//    нажата НЕ нижняя грань и над блоком воздух — onlyIfAirAbove), coarse_dirt и
//    rooted_dirt → dirt (второй удар мотыгой уже даёт грядку). Трава сверху
//    (short_grass) мешает: её сперва срезать.
//  · FarmBlock.isNearWater: вода в квадрате dx,dz ∈ [-4..4] на уровне грядки
//    или на один выше (dy ∈ [0..1]); годится любая вода — источник, течение,
//    водоросли, залитые блоки (FluidTags.WATER). Сухая грядка без посева
//    высыхает в землю.
//  · FarmBlock.fallOn: игрок топчет грядку, падая на неё с высоты > 0.5 (шанс
//    растёт с высотой) — поэтому по полю тело ходит без прыжков и паркура.
//  · CropBlock: растёт только на farmland при свете >= 8 (hasSufficientLight)
//    или под открытым небом; костная мука даёт +2..5 стадий (Mth.nextInt(2,5)).
//    Спелость — максимум свойства age, у каждой культуры свой: берём его из
//    данных блоков (wheat/carrots/potatoes 0..7, beetroots 0..3).
//  · SugarCaneBlock.canSurvive: под ним тростник, либо земля (BlockTags.DIRT)
//    или песок (BlockTags.SAND), и вплотную к этому блоку по горизонтали вода
//    или подмёрзший лёд. CactusBlock: по бокам ничего твёрдого, снизу кактус или
//    песок, сверху не жидкость.
//  · Семечко и тростник — предмет-блок: клик по ВЕРХНЕЙ грани опоры, растение
//    встаёт над ней (BlockItem → clicked.relative(face)).
//
// Честное зрение: цель берётся, только если её видно (bot.canSeeBlock) — хотя
// бы раз за это намерение; то, что знает клиентская память мира за стенкой, в
// работу не идёт.

const AIR = new Set(['air', 'cave_air', 'void_air'])
// FluidTags.WATER у блока: сама вода и то, что стоит в воде всегда.
const WATERY = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])
const TILL = { grass_block: 'farmland', dirt: 'farmland', dirt_path: 'farmland', coarse_dirt: 'dirt', rooted_dirt: 'dirt' }
// BlockTags.DIRT и BlockTags.SAND 1.21.11 — на чём стоит тростник.
const CANE_SOIL = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'mycelium', 'rooted_dirt', 'moss_block', 'pale_moss_block', 'mud', 'muddy_mangrove_roots', 'sand', 'red_sand', 'suspicious_sand', 'suspicious_red_sand'])

// Семена → что вырастет и на чём сажать.
const SEEDS = {
  wheat_seeds: { crop: 'wheat', on: 'farmland' },
  carrot: { crop: 'carrots', on: 'farmland' },
  potato: { crop: 'potatoes', on: 'farmland' },
  beetroot_seeds: { crop: 'beetroots', on: 'farmland' },
  melon_seeds: { crop: 'melon_stem', on: 'farmland' },
  pumpkin_seeds: { crop: 'pumpkin_stem', on: 'farmland' },
  torchflower_seeds: { crop: 'torchflower_crop', on: 'farmland' },
  sugar_cane: { crop: 'sugar_cane', on: 'cane' },
  cactus: { crop: 'cactus', on: 'sand' },
  bamboo: { crop: 'bamboo_sapling', on: 'cane' },
  nether_wart: { crop: 'nether_wart', on: 'soul_sand' }
}
// Культура на грядке → чем пересадить после сбора.
const CROPS = {
  wheat: { seed: 'wheat_seeds', produce: 'wheat' },
  carrots: { seed: 'carrot', produce: 'carrot' },
  potatoes: { seed: 'potato', produce: 'potato' },
  beetroots: { seed: 'beetroot_seeds', produce: 'beetroot' },
  nether_wart: { seed: 'nether_wart', produce: 'nether_wart' }
}
// Что мозг может сказать словами → предмет.
const ALIAS = {
  wheat: 'wheat_seeds', seeds: 'wheat_seeds', пшеница: 'wheat_seeds',
  carrots: 'carrot', морковь: 'carrot', potatoes: 'potato', картошка: 'potato',
  beetroot: 'beetroot_seeds', beetroots: 'beetroot_seeds', свёкла: 'beetroot_seeds',
  melon: 'melon_seeds', арбуз: 'melon_seeds', pumpkin: 'pumpkin_seeds', тыква: 'pumpkin_seeds',
  cane: 'sugar_cane', тростник: 'sugar_cane', wart: 'nether_wart'
}
const TALL = ['sugar_cane', 'bamboo', 'cactus']
const FRUIT = { attached_melon_stem: 'melon', attached_pumpkin_stem: 'pumpkin' }
const BONEMEALABLE = new Set(['wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem', 'torchflower_crop', 'bamboo', 'bamboo_sapling'])

const EYE = 1.62
// block_interaction_range 4.5 (сервер пускает ещё +1 до кликнутой точки).
const REACH = 4.3
const HORIZ = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function sleep (ms, ctl) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { clearTimeout(t); resolve() })
  })
}

const k3 = p => `${p.x},${p.y},${p.z}`
const xyz = p => ({ x: p.x, y: p.y, z: p.z })
const props = b => { try { return b.getProperties() || {} } catch { return {} } }
const eye = bot => bot.entity.position.offset(0, EYE, 0)
const reachOf = (bot, p) => eye(bot).distanceTo(p.offset(0.5, 0.9, 0.5))

function seedName (s) {
  if (!s) return null
  const n = String(s).trim().toLowerCase()
  return SEEDS[n] ? n : (ALIAS[n] || null)
}

// Спелость — из данных блока, а не таблицей в коде.
function maxAge (bot, name) {
  const b = bot.registry.blocksByName[name]
  const st = b && (b.states || []).find(s => s.name === 'age')
  if (!st) return null
  return (st.num_values || (st.values || []).length) - 1
}

function ageOf (block) {
  const a = props(block).age
  return a === undefined ? null : Number(a)
}

function isWater (b) {
  if (!b) return false
  if (WATERY.has(b.name)) return true
  return props(b).waterlogged === true
}

// FarmBlock.isNearWater — тот же квадрат, что у сервера.
function nearWater (bot, pos) {
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        if (isWater(bot.blockAt(pos.offset(dx, dy, dz)))) return true
      }
    }
  }
  return false
}

// Вода вплотную к блоку по горизонтали — условие тростника.
function waterBeside (bot, pos) {
  return HORIZ.some(([dx, dz]) => {
    const b = bot.blockAt(pos.offset(dx, 0, dz))
    return isWater(b) || (b && b.name === 'frosted_ice')
  })
}

// Мелочь над землёй, которая не даёт вспахать: трава, цветы, снег слоем.
function isWeed (b) {
  return !!b && !AIR.has(b.name) && !WATERY.has(b.name) && b.boundingBox === 'empty' &&
    (b.hardness === 0 || b.name === 'snow') && !/crop|wheat|carrots|potatoes|beetroots|stem|sugar_cane|bamboo|sapling|torch|rail|redstone|button|lever|pressure_plate|sign|banner|carpet/.test(b.name)
}

function farmMovements (bot) {
  const m = new Movements(bot)
  m.canDig = false
  m.allow1by1towers = false
  m.allowParkour = false
  m.allowSprinting = false
  m.scafoldingBlocks = []
  m.maxDropDown = 2
  // По полю — только пешком: прыжок на грядку топчет её (FarmBlock.fallOn), а
  // в лунку с водой тело провалится и выпрыгнет прямо на пашню.
  m.infiniteLiquidDropdownDistance = false
  const water = bot.registry.blocksByName.water
  if (water) m.blocksToAvoid.add(water.id)
  return m
}

async function walkNear (bot, ctl, pos, range = 2, ms = 12000) {
  if (reachOf(bot, pos) <= REACH - 0.3) return true
  const goal = new goals.GoalNear(pos.x, pos.y + 1, pos.z, range)
  const stop = () => { try { bot.pathfinder.setGoal(null) } catch {} }
  ctl.onAbort.push(stop)
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, 'не дошёл')
  } catch {
    stop()
    try { bot.clearControlStates() } catch {}
  }
  return reachOf(bot, pos) <= REACH
}

async function hold (bot, name) {
  if (bot.heldItem && bot.heldItem.name === name) return true
  const it = itemNamed(bot, name)
  if (!it) return false
  try { await bot.equip(it, 'hand'); return true } catch { return false }
}

const HOES = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'golden_hoe', 'stone_hoe', 'wooden_hoe']
// Слабую — первой: удар мотыгой по земле стоит одну прочность любой мотыге
// (деревянная — 59 клеток, каменная — 131), а хорошую жалко.
function hoeIn (bot) {
  for (const n of [...HOES].reverse()) if (itemNamed(bot, n)) return n
  return null
}

function hoeUses (bot) {
  return bot.inventory.items().filter(i => HOES.includes(i.name)).reduce((n, i) => n + usesLeft(i), 0)
}

async function waitBlock (bot, pos, test, ms = 1200) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const b = bot.blockAt(pos)
    if (b && test(b)) return b
    await sleep(50)
  }
  return null
}

// Клик предметом в руке по грани блока. Взгляд — заранее и силой: внутренний
// lookAt у activateBlock не форсирован и догоняет по 0.15 рад за тик (см.
// build.js againstFaces) — на поле это секунда на каждую клетку.
async function useOn (bot, block, face = new Vec3(0, 1, 0)) {
  const aim = block.position.offset(0.5, 0.5, 0.5)
  try { await bot.lookAt(aim, true) } catch {}
  const cursor = new Vec3(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
  await bot.activateBlock(block, face, cursor)
}

async function dig (bot, block) {
  try {
    await equipBestTool(bot, block)
    await withTimeout(bot.dig(block, true), 8000, `${block.name} не ломается`)
    return true
  } catch {
    const now = bot.blockAt(block.position)
    return !!now && now.name !== block.name
  }
}

// Подобрать дроп вокруг точки: общий слой подбора (drops.js). Прежний цикл спрашивал
// мир один раз — дроп сломанного блока приходит на тик-два позже, и подбор кончался,
// не начавшись (замер фермы: 1 из 20), — и шёл к позиции, которую mineflayer не
// двигает, пока предмет летит.
async function collect (bot, ctl, around, radius = 6, ms = 12000) {
  return require('./drops').collect(bot, ctl, { radius, timeoutMs: ms, from: around })
}

// ------------------------------------------------------------------ зрение

function sight (session) {
  const bot = session.bot
  const fair = session.cfg.fairPlay !== false
  const seen = new Set()
  return {
    fair,
    // Видел хоть раз за намерение — годится; иначе только если видно сейчас.
    sees (b) {
      if (!fair) return true
      const k = k3(b.position)
      if (seen.has(k)) return true
      let ok = false
      try { ok = bot.canSeeBlock(b) } catch {}
      if (!ok) {
        // Клетку над блоком (там, где растение) тоже считаем взглядом на неё.
        const up = bot.blockAt(b.position.offset(0, 1, 0))
        try { ok = !!up && up.boundingBox === 'empty' && bot.canSeeBlock(up) } catch {}
      }
      if (ok) seen.add(k)
      return ok
    }
  }
}

// Из того, что помнит мир клиента, в работу идёт только видимое. Если видимого
// не осталось, а ближняя клетка своего поля заслонена (тело стоит в лунке,
// угол обзора по земле), — сходить и посмотреть, по разу на клетку: так игрок
// обходит своё поле. Замер: 2 клетки из 80 у лунки не вспахались ни разу.
async function pickSeen (bot, ctl, eyeSees, all, peeked, blockOf = x => x) {
  const vis = all.filter(x => eyeSees.sees(blockOf(x)))
  if (vis.length || !eyeSees.fair) return vis
  const me = bot.entity.position
  const hid = all.filter(x => !peeked.has(k3(blockOf(x).position)))
    .sort((a, b) => blockOf(a).position.distanceTo(me) - blockOf(b).position.distanceTo(me))
  // Не обходить полмира: дюжина взглядов на работу.
  if (!hid.length || ctl.aborted || peeked.size >= 12) return []
  const h = blockOf(hid[0]).position
  peeked.add(k3(h))
  try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(h.x, h.y + 1, h.z, 1)), 8000, 'не дошёл') } catch { try { bot.pathfinder.setGoal(null) } catch {} }
  const again = all.filter(x => eyeSees.sees(blockOf(x)))
  // Всё ещё не видно — пусть следующий круг попробует другую клетку.
  return again.length ? again : pickSeen(bot, ctl, eyeSees, all, peeked, blockOf)
}

function findAll (bot, names, center, radius, count = 400) {
  const ids = names.map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
  if (!ids.length) return []
  return bot.findBlocks({ matching: ids, point: center, maxDistance: radius, count }).map(p => bot.blockAt(p)).filter(Boolean)
}

// ------------------------------------------------------------------ разведка

// Что на поле видно: грядки (мокрые/сухие), что растёт и сколько спелого,
// тростник/бамбук/кактус выше корня, плоды у стеблей, вода.
function survey (session, { radius = 12, center = null } = {}) {
  const bot = session.bot
  const eyeSees = sight(session)
  const c = center ? new Vec3(center.x, center.y, center.z) : bot.entity.position.floored()
  const farmland = findAll(bot, ['farmland'], c, radius).filter(b => eyeSees.sees(b))
  const wet = farmland.filter(b => Number(props(b).moisture) > 0).length
  let empty = 0
  const crops = {}
  for (const f of farmland) {
    const up = bot.blockAt(f.position.offset(0, 1, 0))
    if (!up || AIR.has(up.name)) { empty++; continue }
    const max = maxAge(bot, up.name)
    const row = crops[up.name] || (crops[up.name] = { planted: 0, ripe: 0, ages: {} })
    row.planted++
    const a = ageOf(up)
    if (a !== null) row.ages[a] = (row.ages[a] || 0) + 1
    if (max !== null && a === max && up.name !== 'melon_stem' && up.name !== 'pumpkin_stem') row.ripe++
    if (max !== null) row.max = max
  }
  const tall = {}
  for (const col of columns(bot, eyeSees, c, radius)) {
    const row = tall[col.name] || (tall[col.name] = { columns: 0, cut: 0, blocks: 0 })
    row.columns++
    row.blocks += col.height - 1
    if (col.height >= 2) row.cut++
  }
  const fruit = fruits(bot, eyeSees, c, radius)
  const water = findAll(bot, ['water'], c, radius, 64).filter(b => eyeSees.sees(b)).length
  // Холодный биом: открытая вода у поля замерзает под случайными тиками
  // (Biome.shouldFreeze: вода с краю, свет блоков < 10), тростник у льда
  // осыпается, грядки сохнут. Замер на снежной равнине: 7 корней из 7 за 3 с
  // при ускоренных тиках.
  const ice = findAll(bot, ['ice'], c, radius, 64).filter(b => eyeSees.sees(b)).length
  let biome = null
  try { biome = biomeName(bot, c) } catch {}
  const cold = /snowy|frozen|ice_spikes|grove|jagged_peaks|frozen_peaks/.test(biome || '')
  return {
    farmland: farmland.length,
    wet,
    dry: farmland.length - wet,
    empty,
    crops,
    tall: Object.keys(tall).length ? tall : undefined,
    fruit: fruit.length ? fruit.reduce((o, f) => { o[f.block.name] = (o[f.block.name] || 0) + 1; return o }, {}) : undefined,
    water,
    ice: ice || undefined,
    biome: biome || undefined,
    warn: (cold || ice) ? `холодно (${biome || 'лёд рядом'}): открытая вода у поля замёрзнет — факел не дальше 4 блоков от воды (свет от 10) или крыша над ней` : undefined,
    fair: eyeSees.fair
  }
}

// Столбы тростника/бамбука/кактуса: корень, высота, что резать.
function columns (bot, eyeSees, center, radius) {
  const out = new Map()
  for (const b of findAll(bot, TALL, center, radius)) {
    let base = b.position
    for (let i = 0; i < 24; i++) {
      const under = bot.blockAt(base.offset(0, -1, 0))
      if (!under || under.name !== b.name) break
      base = base.offset(0, -1, 0)
    }
    const key = k3(base)
    if (out.has(key)) continue
    let height = 0
    let seen = false
    for (let i = 0; i < 24; i++) {
      const x = bot.blockAt(base.offset(0, i, 0))
      if (!x || x.name !== b.name) break
      height++
      if (!seen && eyeSees.sees(x)) seen = true
    }
    if (!seen) continue
    out.set(key, { name: b.name, base, height })
  }
  return [...out.values()]
}

// Плоды у присоединённых стеблей: attached_*_stem смотрит на свой арбуз/тыкву.
function fruits (bot, eyeSees, center, radius) {
  const out = []
  for (const s of findAll(bot, Object.keys(FRUIT), center, radius, 128)) {
    const f = props(s).facing
    const d = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[f]
    if (!d) continue
    const fb = bot.blockAt(s.position.offset(d[0], 0, d[1]))
    if (!fb || fb.name !== FRUIT[s.name]) continue
    if (!eyeSees.sees(fb)) continue
    out.push({ block: fb, stem: s.position })
  }
  return out
}

// ------------------------------------------------------------------ вода

// Вода в центр будущего поля: копнуть клетку и вылить туда ведро. Ведро
// целится лучом из глаз с Fluid.NONE (BucketItem.use → getPlayerPOVHitResult),
// поэтому смотреть надо в верх блока ПОД лункой, и ничего не должно стоять на
// пути луча.
async function waterAt (session, ctl, cell) {
  const bot = session.bot
  const here = bot.blockAt(cell)
  if (isWater(here)) return { ok: true, already: true }
  if (!itemNamed(bot, 'water_bucket')) {
    if (!itemNamed(bot, 'bucket')) return { ok: false, need: { what: 'water_bucket', count: 1, have: 0 }, why: 'нет ни ведра воды, ни пустого ведра' }
    const r = await obsidianMod.fillBucket(session, ctl, { fluid: 'water', radius: 24 })
    if (!itemNamed(bot, 'water_bucket')) return { ok: false, need: { what: 'water_bucket', count: 1, have: 0 }, why: r.stopped || 'воду набрать не вышло' }
  }
  // Встать ВПЛОТНУЮ сбоку, на соседнюю клетку. Не на саму лунку — копнув под
  // собой, тело падает в неё (замер: так и было). И не дальше одной клетки:
  // луч ведра из глаз в дно лунки с двух блоков проходит у края на 120.65 при
  // верхе земли 121 и упирается в край — вода встаёт на соседа сверху. С одной
  // клетки тот же луч идёт над краем на 121.31.
  const spot = HORIZ.map(([dx, dz]) => cell.offset(dx, 1, dz)).find(p => {
    const f = bot.blockAt(p); const h = bot.blockAt(p.offset(0, 1, 0)); const g = bot.blockAt(p.offset(0, -1, 0))
    return f && h && g && f.boundingBox === 'empty' && h.boundingBox === 'empty' && g.boundingBox === 'block' && !isWater(f)
  })
  if (!spot) return { ok: false, why: 'встать рядом с лункой негде' }
  const feet = bot.entity.position.floored()
  if (!feet.equals(spot)) {
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(spot.x, spot.y, spot.z)), 12000, 'не дошёл') } catch { try { bot.pathfinder.setGoal(null) } catch {} }
  }
  const now0 = bot.entity.position.floored()
  if (now0.x === cell.x && now0.z === cell.z) return { ok: false, why: 'стою на месте лунки, сойти не вышло' }
  if (here && !AIR.has(here.name)) {
    if (!(await dig(bot, here))) return { ok: false, why: `лунку не выкопал: ${here.name}` }
  }
  const poured = await obsidianMod.pourOnto(bot, cell.offset(0, -1, 0))
  const now = await waitBlock(bot, cell, b => isWater(b), 1500)
  return now ? { ok: true, poured } : { ok: false, why: 'ведро вылилось не туда (луч упёрся в другое)' }
}

// ------------------------------------------------------------------ работы

// Вспахать: всё тиллабельное рядом с водой в квадрате (или в радиусе), что видно.
async function till (session, ctl, { center = null, radius = 4, square = false, max = 81, needWater = true, report }) {
  const bot = session.bot
  let hoe = hoeIn(bot)
  if (!hoe) { report.need = { what: 'wooden_hoe', count: 1, have: 0 }; report.stopped = 'мотыги нет (2 доски + 2 палки)'; return }
  report.hoeUsesBefore = hoeUses(bot)
  const eyeSees = sight(session)
  const c = center || bot.entity.position.floored().offset(0, -1, 0)
  const cand = () => {
    const out = []
    const list = square
      ? (() => { const a = []; for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) { const b = bot.blockAt(c.offset(dx, 0, dz)); if (b) a.push(b) } return a })()
      : findAll(bot, Object.keys(TILL), c, radius + 1)
    for (const b of list) {
      if (!TILL[b.name]) continue
      if (square && (Math.abs(b.position.x - c.x) > radius || Math.abs(b.position.z - c.z) > radius)) continue
      const up = bot.blockAt(b.position.offset(0, 1, 0))
      if (!up || !(AIR.has(up.name) || isWeed(up))) continue
      if (needWater && !nearWater(bot, b.position)) { report.dryNear = (report.dryNear || 0) + 1; continue }
      out.push(b)
    }
    return out
  }
  report.dryNear = 0
  const failed = new Set()
  const peeked = new Set()
  let guard = 0
  while (!ctl.aborted && (report.tilled || 0) < max && guard++ < 400) {
    report.dryNear = 0
    const list = await pickSeen(bot, ctl, eyeSees, cand().filter(b => !failed.has(k3(b.position))), peeked)
    if (!list.length) break
    const me = bot.entity.position
    list.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    const t = list[0]
    if (!(await walkNear(bot, ctl, t.position, 2))) { failed.add(k3(t.position)); continue }
    // Всё, что достаётся отсюда, — одним заходом.
    const batch = list.filter(b => reachOf(bot, b.position) <= REACH).slice(0, 24)
    for (const b of batch) {
      if (ctl.aborted) break
      const up = bot.blockAt(b.position.offset(0, 1, 0))
      if (up && isWeed(up)) { await dig(bot, up); report.weeded = (report.weeded || 0) + 1 }
      hoe = hoeIn(bot)
      if (!hoe || !(await hold(bot, hoe))) break
      const before = bot.blockAt(b.position)
      const want = TILL[before.name]
      try { await useOn(bot, before) } catch {}
      const got = await waitBlock(bot, b.position, x => x.name !== before.name, 900)
      if (got && got.name === 'farmland') report.tilled = (report.tilled || 0) + 1
      else if (got && got.name === 'dirt' && want === 'dirt') report.loosened = (report.loosened || 0) + 1
      else failed.add(k3(b.position))
    }
    if (!hoeIn(bot)) {
      const left = cand().filter(b => !failed.has(k3(b.position))).length
      report.stopped = `мотыга сломалась${left ? `, не вспахано ещё ${left}` : ''} (деревянная — 59 клеток, каменная — 131)`
      if (left) report.need = { what: 'stone_hoe', count: 1, have: 0 }
      break
    }
  }
  report.hoeUsesLeft = hoeUses(bot)
  if (failed.size) report.tillFailed = failed.size
  if (!report.dryNear) delete report.dryNear
}

// Посадить: на пустые грядки (или на землю у воды — тростник), что видно.
async function plant (session, ctl, { seed = null, center = null, radius = 8, max = 200, only = null, report }) {
  const bot = session.bot
  const eyeSees = sight(session)
  const c = center || bot.entity.position.floored()
  const pick = () => {
    if (seed) return itemNamed(bot, seed) ? seed : null
    return Object.keys(SEEDS).filter(n => SEEDS[n].on === 'farmland').find(n => itemNamed(bot, n)) || null
  }
  let s = pick()
  if (!s) {
    report.need = { what: seed || 'wheat_seeds', count: 1, have: 0 }
    report.stopped = seed ? `нечего сажать: ${seed} нет` : 'нечего сажать: ни семян, ни моркови, ни картошки, ни свёклы'
    return
  }
  const spec = SEEDS[s]
  const soilOk = b => {
    if (spec.on === 'farmland') return b.name === 'farmland'
    if (spec.on === 'soul_sand') return b.name === 'soul_sand'
    if (spec.on === 'sand') return /sand$/.test(b.name) && HORIZ.every(([dx, dz]) => { const n = bot.blockAt(b.position.offset(dx, 1, dz)); return !n || n.boundingBox === 'empty' })
    return CANE_SOIL.has(b.name) && waterBeside(bot, b.position)
  }
  const soilNames = spec.on === 'farmland' ? ['farmland'] : spec.on === 'soul_sand' ? ['soul_sand'] : spec.on === 'sand' ? ['sand', 'red_sand'] : [...CANE_SOIL]
  const failed = new Set()
  const cand = () => findAll(bot, soilNames, c, radius).filter(b => {
    if (only && !only.has(k3(b.position))) return false
    if (failed.has(k3(b.position))) return false
    const up = bot.blockAt(b.position.offset(0, 1, 0))
    return up && AIR.has(up.name) && soilOk(b)
  })
  const peeked = new Set()
  let guard = 0
  while (!ctl.aborted && (report.planted || 0) < max && guard++ < 400) {
    const list = await pickSeen(bot, ctl, eyeSees, cand(), peeked)
    if (!list.length) break
    const me = bot.entity.position
    list.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    if (!(await walkNear(bot, ctl, list[0].position, 2))) { failed.add(k3(list[0].position)); continue }
    const batch = list.filter(b => reachOf(bot, b.position) <= REACH).slice(0, 30)
    for (const b of batch) {
      if (ctl.aborted) break
      if (!itemNamed(bot, s)) {
        s = seed ? null : pick()
        if (!s || SEEDS[s].on !== spec.on) { report.ranOut = true; return }
      }
      if (!(await hold(bot, s))) return
      try { await useOn(bot, b) } catch {}
      const got = await waitBlock(bot, b.position.offset(0, 1, 0), x => !AIR.has(x.name), 900)
      if (got) {
        report.planted = (report.planted || 0) + 1
        report.plantedAs = report.plantedAs || {}
        report.plantedAs[got.name] = (report.plantedAs[got.name] || 0) + 1
      } else failed.add(k3(b.position))
    }
  }
  if (failed.size) report.plantFailed = failed.size
}

// Костная мука на то, что ещё не выросло.
async function bonemeal (session, ctl, { center = null, radius = 8, max = 16, report }) {
  const bot = session.bot
  if (!itemNamed(bot, 'bone_meal')) { report.need = { what: 'bone_meal', count: 1, have: 0 }; report.stopped = 'костной муки нет (кость → 3 муки)'; return }
  const eyeSees = sight(session)
  const c = center || bot.entity.position.floored()
  const done = new Set()
  const peeked = new Set()
  let guard = 0
  while (!ctl.aborted && (report.bonemealed || 0) < max && guard++ < 200) {
    const list = await pickSeen(bot, ctl, eyeSees, findAll(bot, [...BONEMEALABLE], c, radius).filter(b => {
      const m = maxAge(bot, b.name)
      const a = ageOf(b)
      return m !== null && a !== null && a < m && !done.has(k3(b.position))
    }), peeked)
    if (!list.length) break
    const me = bot.entity.position
    list.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    const t = list[0]
    if (!(await walkNear(bot, ctl, t.position, 2))) { done.add(k3(t.position)); continue }
    if (!(await hold(bot, 'bone_meal'))) { report.ranOut = true; break }
    const before = ageOf(t)
    try { await useOn(bot, t) } catch {}
    const got = await waitBlock(bot, t.position, x => x.name !== t.name || ageOf(x) !== before, 900)
    report.bonemealed = (report.bonemealed || 0) + 1
    if (got && ageOf(got) !== null && ageOf(got) >= maxAge(bot, got.name)) done.add(k3(t.position))
    if (!got) done.add(k3(t.position))
    if (!itemNamed(bot, 'bone_meal')) { report.ranOut = true; break }
  }
}

// Собрать спелое и сразу посадить обратно; срезать тростник/бамбук/кактус над
// корнем; сломать арбузы и тыквы у стеблей.
async function harvest (session, ctl, { center = null, radius = 10, max = 400, replant = true, what = null, report }) {
  const bot = session.bot
  const eyeSees = sight(session)
  const c = center || bot.entity.position.floored()
  const want = what ? new Set(String(what).split(',').map(s => s.trim())) : null
  const wants = n => !want || want.has(n) || [...want].some(w => n.startsWith(w) || (ALIAS[w] && SEEDS[ALIAS[w]] && SEEDS[ALIAS[w]].crop === n))
  const skip = new Set()
  const replantAt = new Map()
  const targets = () => {
    const out = []
    for (const b of findAll(bot, Object.keys(CROPS), c, radius)) {
      if (!wants(b.name) || skip.has(k3(b.position))) continue
      if (ageOf(b) !== maxAge(bot, b.name)) continue
      out.push({ kind: 'crop', block: b, pos: b.position })
    }
    for (const col of columns(bot, eyeSees, c, radius)) {
      if (col.height < 2 || !wants(col.name)) continue
      const cut = col.base.offset(0, 1, 0)
      if (skip.has(k3(cut))) continue
      out.push({ kind: 'tall', block: bot.blockAt(cut), pos: cut, height: col.height })
    }
    for (const f of fruits(bot, eyeSees, c, radius)) {
      if (!wants(f.block.name) || skip.has(k3(f.block.position))) continue
      out.push({ kind: 'fruit', block: f.block, pos: f.block.position })
    }
    return out
  }
  let guard = 0
  let harvested = 0
  const peeked = new Set()
  while (!ctl.aborted && harvested < max && guard++ < 400) {
    const list = await pickSeen(bot, ctl, eyeSees, targets(), peeked, t => t.block)
    if (!list.length) break
    const me = bot.entity.position
    list.sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me))
    if (!(await walkNear(bot, ctl, list[0].pos, 2))) { skip.add(k3(list[0].pos)); continue }
    const batch = list.filter(t => reachOf(bot, t.pos) <= REACH).slice(0, 24)
    for (const t of batch) {
      if (ctl.aborted) break
      const b = bot.blockAt(t.pos)
      if (!b || b.name !== t.block.name) continue
      const ok = await dig(bot, b)
      if (!ok) { skip.add(k3(t.pos)); continue }
      harvested++
      const row = report.harvested || (report.harvested = {})
      const label = t.kind === 'tall' ? t.block.name : t.block.name
      row[label] = (row[label] || 0) + (t.kind === 'tall' ? t.height - 1 : 1)
      if (t.kind === 'crop' && replant && CROPS[b.name]) replantAt.set(k3(t.pos.offset(0, -1, 0)), CROPS[b.name].seed)
    }
    await collect(bot, ctl, bot.entity.position, 6, 6000)
    // Посадить обратно то, что сняли в этом заходе.
    if (replant && replantAt.size) {
      for (const [key, s] of [...replantAt]) {
        if (ctl.aborted) break
        const [x, y, z] = key.split(',').map(Number)
        const soil = bot.blockAt(new Vec3(x, y, z))
        const up = bot.blockAt(new Vec3(x, y + 1, z))
        if (!soil || soil.name !== 'farmland' || !up || !AIR.has(up.name)) { replantAt.delete(key); continue }
        if (reachOf(bot, soil.position) > REACH) continue
        if (!itemNamed(bot, s)) { report.replantShort = report.replantShort || {}; report.replantShort[s] = (report.replantShort[s] || 0) + 1; replantAt.delete(key); continue }
        if (!(await hold(bot, s))) continue
        try { await useOn(bot, soil) } catch {}
        if (await waitBlock(bot, up.position, q => !AIR.has(q.name), 900)) report.replanted = (report.replanted || 0) + 1
        replantAt.delete(key)
      }
    }
  }
  // Что осталось не пересаженным (далеко ушёл) — последним проходом.
  if (replant && replantAt.size && !ctl.aborted) {
    const only = new Set(replantAt.keys())
    const byS = {}
    for (const s of replantAt.values()) byS[s] = (byS[s] || 0) + 1
    for (const s of Object.keys(byS)) {
      const r = {}
      await plant(session, ctl, { seed: s, center: c, radius, only, report: r })
      report.replanted = (report.replanted || 0) + (r.planted || 0)
    }
  }
  await collect(bot, ctl, c, radius, 8000)
  if (skip.size) report.harvestSkipped = skip.size
}

// Поле с нуля: вода в центр, вспахать квадрат вокруг, посадить.
async function plot (session, ctl, p, report) {
  const bot = session.bot
  const R = Math.max(1, Math.min(4, Math.round(p.radius ?? 4)))
  let c
  if (p.at) c = new Vec3(Math.floor(p.at.x), Math.floor(p.at.y), Math.floor(p.at.z))
  else {
    // Перед собой, чтобы поле не легло под ноги: центр в R+2 по взгляду, на
    // уровне земли, на которой стоит тело.
    const yaw = bot.entity.yaw
    const fx = Math.round(-Math.sin(yaw)); const fz = Math.round(-Math.cos(yaw))
    const feet = bot.entity.position.floored()
    c = feet.offset(fx * (R + 2), -1, fz * (R + 2))
  }
  report.center = xyz(c)
  report.size = `${2 * R + 1}×${2 * R + 1}`
  const ground = bot.blockAt(c)
  if (!ground) { report.stopped = 'место не прогружено — подойди ближе'; return }
  // Ровность: сколько клеток квадрата на том же уровне и годятся под грядку.
  let level = 0; let total = 0
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      if (!dx && !dz) continue
      total++
      const b = bot.blockAt(c.offset(dx, 0, dz))
      if (b && (TILL[b.name] || b.name === 'farmland')) level++
    }
  }
  report.fit = `${level}/${total}`
  if (level < total / 2) { report.stopped = `место не годится под поле: земли на уровне ${c.y} только ${level} из ${total} клеток — выбери ровнее (at) или подойди`; return }
  const w = await waterAt(session, ctl, c)
  report.water = w.ok ? (w.already ? 'уже была' : 'налил') : `нет: ${w.why}`
  if (!w.ok) { if (w.need) report.need = w.need; report.stopped = `без воды грядки высохнут: ${w.why}`; return }
  await till(session, ctl, { center: c, radius: R, square: true, report })
  // Мотыга кончилась на полпути — вспаханное всё равно засеять: иначе сухая
  // пустая грядка без посева со временем снова станет землёй.
  if (report.stopped && !report.tilled) return
  if (p.seed !== false && !ctl.aborted) {
    const tillStop = report.stopped
    const tillNeed = report.need
    delete report.stopped
    delete report.need
    const s = seedName(p.seed)
    // Радиус поиска — шар, а поле — квадрат: углы 9×9 лежат в 5.7 от центра.
    await plant(session, ctl, { seed: s, center: c, radius: Math.ceil(R * Math.SQRT2) + 1, report })
    if (report.need && !report.planted) {
      // Поле готово, сажать нечем — это не провал поля.
      report.note = 'поле вспахано и полито, семян нет — посажу, когда принесёшь (mc_farm mode=plant)'
      delete report.stopped
    }
    // Недопаханное — главнее: мотыгу мозгу нести первой.
    if (tillStop) { report.stopped = tillStop; if (tillNeed) report.need = tillNeed }
  }
}

// ------------------------------------------------------------------ вход

async function run (session, ctl, p = {}) {
  const bot = session.bot
  const mode = String(p.mode || 'status').toLowerCase()
  const before = countItems(bot)
  const t0 = Date.now()
  const report = { mode }
  const center = p.at ? new Vec3(Math.floor(p.at.x), Math.floor(p.at.y), Math.floor(p.at.z)) : null
  const radius = Math.max(2, Math.min(24, Math.round(p.radius ?? (mode === 'plot' ? 4 : 10))))
  // Свой срок внутри намерения: по нему работа встаёт сама и отдаёт отчёт
  // обычным путём, а не через обрыв таймаутом.
  const outer = ctl
  ctl = { aborted: false, onAbort: [] }
  ctl.abort = () => { if (ctl.aborted) return; ctl.aborted = true; for (const fn of ctl.onAbort) { try { fn() } catch {} } }
  outer.onAbort.push(() => ctl.abort())
  const budget = Math.min(600, p.timeoutSeconds ?? 180) * 1000
  const timer = setTimeout(() => { report.timedOut = true; ctl.abort() }, budget)
  const old = bot.pathfinder.movements
  bot.pathfinder.setMovements(farmMovements(bot))
  try {
    if (mode === 'plot') await plot(session, ctl, p, report)
    else if (mode === 'till') await till(session, ctl, { center: center && center.offset(0, 0, 0), radius, report, max: p.count ?? 81 })
    else if (mode === 'plant') await plant(session, ctl, { seed: seedName(p.seed), center, radius, max: p.count ?? 200, report })
    else if (mode === 'bonemeal') await bonemeal(session, ctl, { center, radius, max: p.count ?? 16, report })
    else if (mode === 'harvest') await harvest(session, ctl, { center, radius, max: p.count ?? 400, replant: p.replant !== false, what: p.what || null, report })
    else throw new Error(`не знаю режим ${mode}: status / plot / till / plant / bonemeal / harvest`)
  } finally {
    clearTimeout(timer)
    try { bot.pathfinder.setGoal(null) } catch {}
    if (old) { try { bot.pathfinder.setMovements(old) } catch {} }
    session.updateMovements(true)
  }
  if (report.timedOut && !report.stopped) report.stopped = `время вышло (${budget / 1000}с) — позови тот же вызов, продолжит с того, что осталось`
  report.gained = diffItems(before, countItems(bot))
  const spent = diffItems(countItems(bot), before)
  if (Object.keys(spent).length) report.spent = spent
  report.seconds = Math.round((Date.now() - t0) / 100) / 10
  try { report.field = survey(session, { radius: Math.max(radius, 6), center: center || null }) } catch {}
  if (!report.stopped) {
    const done = report.tilled || report.planted || report.harvested || report.bonemealed || report.replanted
    if (!done && mode !== 'plot') report.stopped = nothingWhy(mode, report)
  }
  return report
}

function nothingWhy (mode, r) {
  const f = r.field || {}
  if (mode === 'till') return r.dryNear ? `земля есть, но воды ближе 4 блоков нет (${r.dryNear} клеток) — сухая грядка высохнет; mode=plot нальёт воду сам` : 'нечего пахать: не вижу земли/травы с воздухом над ней'
  if (mode === 'plant') return f.empty === 0 ? 'пустых грядок не вижу — сперва mode=till или mode=plot' : 'не посадил ни одной: грядки не видно или не дотянулся'
  if (mode === 'bonemeal') return 'удобрять нечего: всё видимое уже спелое или не растёт'
  if (mode === 'harvest') {
    const growing = Object.entries(f.crops || {}).map(([n, v]) => `${n} ${v.planted} (спелых ${v.ripe}, max age ${v.max})`).join(', ')
    return growing ? `спелого нет: ${growing} — подожди или mode=bonemeal` : 'собирать нечего: не вижу ни спелого, ни тростника выше корня, ни плодов'
  }
  return 'ничего не сделал'
}

module.exports = { run, survey, SEEDS, CROPS, maxAge, nearWater, waterBeside, isWater, seedName, farmMovements, collect, TILL, CANE_SOIL }
