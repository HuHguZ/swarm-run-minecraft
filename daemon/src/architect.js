'use strict'
const gameClock = require('./game-clock')
const Vec3 = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const { xyz, unstick } = require('./movement')
const { withTimeout, towerUp, FILLER } = require('./build')
const { itemNamed, countItems, equipBestTool } = require('./items')
const bp = require('./blueprint')

// Архитектор: план → место → смета → стройка. Чертёж и генераторы — в
// blueprint.js (без мира), раскладка сундуков и таблички — в sorting.js.
//
// Главные решения, и откуда они:
//  · Состояние блока (куда смотрит ступень, дверь, кровать, сундук) сервер
//    берёт из НАПРАВЛЕНИЯ ИГРОКА в момент постановки
//    (BlockPlaceContext.getHorizontalDirection → Player.getDirection, байткод
//    paper-1.21.11.jar), а верх/низ ступени и плиты — из нажатой грани и
//    высоты точки клика. mineflayer.placeBlock сам смотрит в центр грани и тем
//    самым выбирает направление за нас, поэтому здесь постановка своя: взгляд
//    с нужным yaw отдельным пакетом (bot.look с force шлёт его следующим тиком
//    физики, physics.js updatePosition), потом _genericPlace с forceLook
//    'ignore' и точной точкой клика (delta). Пакеты одного соединения сервер
//    разбирает по порядку — поворот приходит раньше клика.
//  · Мир проверяется, а не ответ: после клика читаем блок в клетке.
//  · Повтор после обрыва ничего не ломает: готовая клетка (имя и состояние
//    совпали) пропускается, и второй вызов доделывает недостающее. Место,
//    поворот и сам план лежат в памяти (state.build), поэтому «где строил» не
//    теряется даже с автовыбором места.
//  · Высоко — леса: столб из дешёвого блока под собой (build.towerUp), потом
//    разобрать его сверху вниз. Pathfinder на время стройки не копает и не
//    строит сам (canDig=false, без столбов и мостков) — иначе он прорубает
//    путь сквозь только что поставленную стену.
//  · Дверь ставится последней, пока её нет — проём остаётся выходом; и перед
//    каждой клеткой, пока бот внутри постройки, проверяется, что выйти он
//    ещё может (поиск пешего пути наружу с прыжком на блок и падением).

const EYE = 1.62
// От глаз до центра клетки. Сервер пускает клик до block_interaction_range
// (4.5) + 1 до ближайшей точки КЛИКНУТОГО блока (handleUseItemOn), клик идёт в
// соседа клетки, так что 4.5 до центра самой клетки — с запасом.
const REACH = 4.5
const AIR = new Set(['air', 'cave_air', 'void_air'])
const FLUID = /^(water|lava|bubble_column)$/
// Блоки, клик по которым что-то открывает или переключает: ставить на них можно
// только присев (ServerPlayerGameMode.useItemOn пропускает use блока, если
// isSecondaryUseActive и в руке предмет).
const INTERACTIVE = /chest|barrel|furnace|smoker|crafting_table|_door$|trapdoor|fence_gate|_bed$|_sign$|button|lever|anvil|enchanting_table|shulker_box|hopper|dispenser|dropper|beacon|brewing_stand|jukebox|note_block|loom|grindstone|stonecutter|cartography_table|smithing_table|lectern|bell|repeater|comparator|daylight_detector|cake|composter|respawn_anchor|decorated_pot|crafter|chiseled_bookshelf|flower_pot|campfire/
// За это не держится ни факел, ни табличка: грань не «крепкая».
const FLIMSY = /pane|fence|_wall$|iron_bars|chain|_slab$|_stairs$|glass_pane|ladder|_sign|torch|lantern|_door$|trapdoor|_bed$|chest/
// Мир, который трогать нельзя: сделанное руками. Автовыбор места обходит его.
const MADE = /_planks$|_stairs$|_slab$|_door$|_bed$|chest|barrel|furnace|crafting_table|torch|lantern|glass|_bricks$|^bricks$|_fence|_wall$|_sign$|ladder|_wool$|_carpet$|bookshelf|_log$/
// mineflayer: yaw 0 — север, растёт против часовой (conversions.js toNotchianYaw = 180° − yaw).
const YAW = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }
const V = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0),
  up: new Vec3(0, 1, 0),
  down: new Vec3(0, -1, 0)
}
const HORIZ = ['north', 'east', 'south', 'west']
const JOB = 'build'

const sleep = ms => new Promise(resolve => gameClock.setTimeout(resolve, ms))
const k3 = p => `${p.x},${p.y},${p.z}`

// ---------------------------------------------------------------- world bits

const isSolid = b => !!b && b.boundingBox === 'block' && !FLUID.test(b.name)
const isPassable = b => !!b && b.boundingBox === 'empty' && !FLUID.test(b.name)
const sturdy = b => isSolid(b) && !FLIMSY.test(b.name)
// Табличку держит то, что isSolid() в игре (WallSignBlock и StandingSignBlock
// canSurvive): сундук годится, хотя факел на нём не висит.
const holds = (c, b) => /_sign$/.test(c.name || '')
  ? isSolid(b) && !/pane|fence|iron_bars|chain|_wall$/.test(b.name)
  : sturdy(b)

function propsOf (block) {
  try { return block.getProperties() || {} } catch { return {} }
}

function propsMatch (block, want) {
  if (!want) return true
  const got = propsOf(block)
  for (const [k, v] of Object.entries(want)) {
    if (got[k] === undefined) continue
    if (String(got[k]) !== String(v)) return false
  }
  return true
}

function isDone (bot, c) {
  const w = bot.blockAt(c.pos)
  if (!w) return false
  if (c.kind === 'air') return AIR.has(w.name) || (!!c.allow && w.name === c.allow)
  if (c.kind === 'seal') return isSolid(w) || w.name === c.name
  return w.name === c.name && propsMatch(w, c.props)
}

function eyeOf (bot) { return bot.entity.position.offset(0, EYE, 0) }
const centre = p => p.offset(0.5, 0.5, 0.5)
const inReach = (bot, c) => eyeOf(bot).distanceTo(centre(c.pos)) <= REACH

// Тело — не точка: бот на x=10.9 занимает и клетку 11. Сервер не ставит блок,
// пересекающий игрока, и каждый такой отказ стоит полного ожидания.
function bodyInCell (bot, p) {
  const e = bot.entity.position
  return e.x + 0.3 > p.x && e.x - 0.3 < p.x + 1 && e.z + 0.3 > p.z && e.z - 0.3 < p.z + 1 &&
    e.y + 1.8 > p.y && e.y < p.y + 1
}

function squatter (bot, p) {
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || /^(item|experience_orb|arrow|spectral_arrow|item_frame|painting|glow_item_frame)$/.test(e.name || '')) continue
    const half = (e.width || 0.6) / 2
    const q = e.position
    if (q.x + half <= p.x || q.x - half >= p.x + 1 || q.z + half <= p.z || q.z - half >= p.z + 1) continue
    if (q.y + (e.height || 1.8) <= p.y || q.y >= p.y + 1) continue
    return e.name || 'кто-то'
  }
  return null
}

// ---------------------------------------------------------------- palette

const hasName = mcData => n => !!(mcData.blocksByName[n] || mcData.itemsByName[n])

// Материал «auto»: то, чего в запасе больше всего. Дерево считается досками —
// бревно стоит четырёх.
function autoMaterial (stock, kind) {
  const woods = bp.WOODS.map(w => ({ m: w, n: (stock[`${w}_planks`] || 0) + 4 * ((stock[`${w}_log`] || 0) + (stock[`${w}_stem`] || 0)) }))
  const stones = bp.STONES.map(s => ({ m: s, n: stock[s] || 0 }))
  const loose = kind === 'hut' ? ['dirt', 'coarse_dirt', 'netherrack', 'sand'].map(s => ({ m: s, n: stock[s] || 0 })) : []
  let pool = [...woods, ...stones, ...loose]
  if (kind === 'castle' && stones.some(s => s.n > 0)) pool = stones
  const best = pool.sort((a, b) => b.n - a.n)[0]
  if (best && best.n > 0) return best.m
  return kind === 'castle' ? 'cobblestone' : kind === 'hut' ? 'dirt' : 'oak'
}

// Роли палитры, которые решает запас, а не материал: дверь, стекло, свет,
// заделка, табличка, лестница. Подмена — только когда предмета нет СОВСЕМ:
// если его есть хоть сколько-то, значит его и хотели, и нехватка — это отказ
// сметы с числом, а не тихая замена.
function resolvePalette (mcData, p, kind, stock) {
  const has = hasName(mcData)
  const asked = p.material && String(p.material).toLowerCase() !== 'auto' ? String(p.material).toLowerCase() : null
  const material = asked || autoMaterial(stock, kind)
  const pal = bp.palette(material, has)
  const subs = []
  const got = n => (n ? stock[n] || 0 : 0)
  const fallback = p.fallback !== false
  const anyOf = re => Object.keys(stock).filter(n => re.test(n) && stock[n] > 0).sort((a, b) => stock[b] - stock[a])[0] || null

  if (pal.stairs && !got(pal.stairs) && fallback) {
    subs.push({ key: 'stairs', role: 'крыша', wanted: pal.stairs, used: pal.roofFill, why: 'ступеней нет совсем — крыша уступами из полного блока' })
    pal.stairs = null
  }
  if (pal.slab && !got(pal.slab) && fallback) {
    subs.push({ key: 'slab', role: 'конёк', wanted: pal.slab, used: pal.roofFill, why: 'плит нет — конёк полным блоком' })
    pal.slab = null
  }
  if (pal.frame !== pal.main && !got(pal.frame)) {
    subs.push({ key: 'frame', role: 'каркас', wanted: pal.frame, used: pal.main, why: 'брёвен нет — углы тем же, что стены' })
    pal.frame = pal.main
  }
  // Дверь: своей породы, любая из рюкзака, иначе проём.
  const door = got(pal.door) ? pal.door : anyOf(/_door$/)
  if (p.door === false) pal.door = null
  else if (door) pal.door = door
  else {
    subs.push({ key: 'door', role: 'дверь', wanted: pal.door, used: null, why: 'двери нет — оставлю проём (oak_door: 6 досок на 3 двери)' })
    pal.door = null
  }
  // Окна: панель, стекло, иначе глухая стена (дыра 1×1 пропускает детёныша зомби).
  if (p.windows === false) pal.window = null
  else if (got('glass_pane')) pal.window = 'glass_pane'
  else if (got('glass')) pal.window = 'glass'
  else {
    pal.window = null
    subs.push({ key: 'window', role: 'окна', wanted: 'glass_pane', used: pal.main, why: 'стекла нет — окна заложены стеной' })
  }
  // Свет.
  pal.light = ['torch', 'lantern', 'soul_torch', 'soul_lantern'].find(n => got(n)) || null
  if (!pal.light && p.light !== false) subs.push({ key: 'light', role: 'свет', wanted: 'torch', used: null, why: 'факелов нет — внутри будет темно, мобы могут появиться' })
  // Заделка дыр и фундамент — дешёвым, если он есть, а не материалом стен.
  const fillers = FILLER.filter(n => !/^(sand|gravel)$/.test(n)).map(n => ({ n, c: got(n) })).sort((a, b) => b.c - a.c)
  pal.fill = p.fill || (fillers[0] && fillers[0].c > 0 ? fillers[0].n : pal.main)
  // Табличка, лестница, кровать.
  pal.sign = got(pal.sign) ? pal.sign : (anyOf(/_sign$/) || pal.sign)
  pal.ladder = got('ladder') ? 'ladder' : null
  pal.bed = anyOf(/_bed$/) || 'red_bed'
  return { pal, subs, material }
}

// ---------------------------------------------------------------- plan

function cleanParams (p) {
  const out = {}
  for (const [k, v] of Object.entries(p || {})) if (v !== undefined && v !== null) out[k] = v
  return out
}

// Во что просили: готовый kind или свой план частями.
function makeParts (session, p, stock) {
  const kind = p.plan ? 'plan' : String(p.kind || 'house').toLowerCase()
  if (kind === 'plan') {
    const parts = Array.isArray(p.plan) ? p.plan : p.plan.parts
    return { kind, parts, pal: null, subs: [], material: null, labels: null }
  }
  const spec = bp.KINDS[kind]
  if (!spec) throw new Error(`не знаю постройку «${p.kind}»: ${Object.keys(bp.KINDS).join(', ')} или свой plan`)
  const { pal, subs, material } = resolvePalette(session.mcData, p, kind, stock)
  if (kind === 'storage') {
    const sorting = require('./sorting')
    const labels = sorting.labelsFor(session, p.categories, stock)
    return { kind, parts: bp.storage(p, pal, labels), pal, subs: subs.filter(x => spec.roles.includes(x.key)), material, labels }
  }
  return { kind, parts: spec.make(p, pal), pal, subs: subs.filter(x => !spec.roles || spec.roles.includes(x.key)), material, labels: null }
}

// Мировые клетки: layout (поворот + прижатие к углу) плюс origin.
function place (layout, origin) {
  const cells = layout.rel.map(c => {
    const pos = new Vec3(origin.x + c.x, origin.y + c.y, origin.z + c.z)
    return { ...c, pos, key: k3(pos), pair: c.pair ? (() => { const [x, y, z] = c.pair.split(',').map(Number); return `${origin.x + x},${origin.y + y},${origin.z + z}` })() : undefined }
  })
  // Проём двери вынимается в самом начале, вместе с прочей землёй: дверь
  // ставится последней, а до того проём — единственный вход. В землянке он
  // был полон земли, и тело копало комнату снаружи сквозь стену, а заднюю
  // стенку так и не достало. Готово — когда там воздух или уже сама дверь.
  for (const c of cells.filter(c => c.kind === 'door' || (c.kind === 'part' && /_door$/.test(c.name)))) {
    cells.push({ x: c.x, y: c.y, z: c.z, pos: c.pos, key: `${c.key}:проём`, name: 'air', kind: 'air', allow: c.name, phase: bp.PHASE.clear, role: 'doorway', part: c.part })
  }
  return cells
}

function boxOf (cells) {
  const b = { x1: Infinity, y1: Infinity, z1: Infinity, x2: -Infinity, y2: -Infinity, z2: -Infinity }
  for (const c of cells) {
    if (c.kind === 'seal' && c.role === 'foundation') continue
    b.x1 = Math.min(b.x1, c.pos.x); b.y1 = Math.min(b.y1, c.pos.y); b.z1 = Math.min(b.z1, c.pos.z)
    b.x2 = Math.max(b.x2, c.pos.x); b.y2 = Math.max(b.y2, c.pos.y); b.z2 = Math.max(b.z2, c.pos.z)
  }
  return b
}

// Относительная клетка канонического (фасад на юг) плана после того же
// поворота и сдвига, что сделал layout: нужна, чтобы привязать вход к месту.
function relOf (layout, parts, has, cx, cz) {
  const steps = layout.steps
  let x = cx; let z = cz
  for (let i = 0; i < steps; i++) [x, z] = [-z, x]
  // bounds до сдвига — пересчитываем по той же компиляции
  const raw = bp.rotateCells(bp.compileParts(parts, has), steps)
  const b = bp.bounds(raw)
  return { x: x - b.x1, z: z - b.z1 }
}

// ---------------------------------------------------------------- sites

function cardinalTo (from, to) {
  const dx = to.x - from.x; const dz = to.z - from.z
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west'
  return dz > 0 ? 'south' : 'north'
}

function facingOf (bot) {
  // Куда смотрит тело — сторона света по yaw.
  const y = ((bot.entity.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const i = Math.round(y / (Math.PI / 2)) % 4
  return ['north', 'west', 'south', 'east'][i]
}

// Ровное место рядом: пятно L×L, где земля ровная, нет воды и лавы, нет
// чужих построек. Цена — сколько копать и сколько подсыпать плюс дорога.
function pickSurfaceSite (bot, { w, d, h, radius = 16 }) {
  const me = bot.entity.position.floored()
  const cols = new Map()
  const column = (x, z) => {
    const k = `${x},${z}`
    if (cols.has(k)) return cols.get(k)
    let top = null; let bad = null; let tree = 0; let made = null
    for (let y = me.y + 14; y >= me.y - 16; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) { bad = 'не прогружено'; break }
      if (AIR.has(b.name)) continue
      if (FLUID.test(b.name)) { bad = b.name; top = y; break }
      if (MADE.test(b.name) && !/_log$/.test(b.name)) { made = b.name; top = y; break }
      if (/_leaves$|_log$|_wood$|_stem$|mushroom_block|bamboo|vine|cactus/.test(b.name)) { tree++; continue }
      if (b.boundingBox !== 'block') continue
      top = y; break
    }
    const r = { top, bad, tree, made }
    cols.set(k, r)
    return r
  }
  let best = null
  const L = Math.max(w, d)
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dz = -radius; dz <= radius; dz += 2) {
      const x0 = me.x + dx - Math.floor(L / 2); const z0 = me.z + dz - Math.floor(L / 2)
      const hs = []
      let bad = null; let trees = 0
      for (let x = x0 - 1; x <= x0 + L && !bad; x++) {
        for (let z = z0 - 1; z <= z0 + L && !bad; z++) {
          const c = column(x, z)
          const inside = x >= x0 && x < x0 + L && z >= z0 && z < z0 + L
          if (c.bad && (inside || /water|lava/.test(c.bad))) bad = c.bad
          else if (inside && c.made) bad = `тут уже стоит ${c.made}`
          else if (inside) {
            if (c.top === null) bad = 'пропасть'
            hs.push(c.top); trees += c.tree
          }
        }
      }
      if (bad || !hs.length) continue
      const sorted = [...hs].sort((a, b) => a - b)
      const y0 = sorted[Math.floor(sorted.length / 2)]
      if (sorted[sorted.length - 1] - sorted[0] > 4) continue
      let fill = 0; let cut = 0
      for (const t of hs) { if (t < y0) fill += y0 - t; else cut += t - y0 }
      const dist = Math.hypot(x0 + L / 2 - me.x, z0 + L / 2 - me.z)
      const score = cut * 2 + fill + trees * 3 + dist * 0.4
      if (!best || score < best.score) best = { x0, z0, y0, L, fill, cut, trees, dist: Math.round(dist), score }
    }
  }
  return best
}

// Склон под землянку: вход E (где встать), а в сторону d — холм, в котором
// комната целиком в земле и над потолком ещё слой.
function pickHillside (bot, { W, D, H, radius = 12 }) {
  const me = bot.entity.position.floored()
  let best = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -4; dy <= 4; dy++) {
        const E = me.offset(dx, dy, dz)
        const f = bot.blockAt(E); const hd = bot.blockAt(E.offset(0, 1, 0)); const fl = bot.blockAt(E.offset(0, -1, 0))
        if (!isPassable(f) || !isPassable(hd) || !isSolid(fl)) continue
        for (const dir of HORIZ) {
          const d = V[dir]
          const side = V[bp.CW[dir]]
          const half = Math.floor(W / 2)
          let total = 0; let rock = 0; let fluid = false; let roof = 0; let roofN = 0
          for (let j = 1; j <= D + 2 && !fluid; j++) {
            for (let l = -half - 1; l <= W - half && !fluid; l++) {
              for (let y = 0; y <= H + 2; y++) {
                const p = E.offset(d.x * j + side.x * l, y, d.z * j + side.z * l)
                const b = bot.blockAt(p)
                if (!b) { fluid = true; break }
                if (FLUID.test(b.name)) { fluid = true; break }
                if (MADE.test(b.name)) { fluid = true; break }
                if (j === 1 && Math.abs(l) === 0 && y <= 1) continue // проём
                total++
                if (isSolid(b)) rock++
                if (y >= H + 1 && j >= 2 && j <= D + 1) { roofN++; if (isSolid(b)) roof++ }
              }
            }
          }
          if (fluid || !total) continue
          const ratio = rock / total
          const roofRatio = roofN ? roof / roofN : 0
          if (ratio < 0.7 || roofRatio < 0.8) continue
          const dist = E.distanceTo(me)
          const score = (1 - ratio) * 40 + (1 - roofRatio) * 30 + dist
          if (!best || score < best.score) best = { E, dir, ratio: +ratio.toFixed(2), roof: +roofRatio.toFixed(2), dist: Math.round(dist), score }
        }
      }
    }
  }
  return best
}

// ---------------------------------------------------------------- job memory

function jobOf (session) {
  return session.journal.state[JOB] || null
}

function saveJob (session, job) {
  session.journal.patch(s => { s[JOB] = job })
}

// Подпись заказа: по ЗАПРОШЕННОМУ материалу, не по выбранному. «auto» после
// половины дома выбрал бы другое дерево (доски-то ушли в стены), и повтор
// перестал бы узнавать свой же дом.
function sigOf (kind, p) {
  const pick = ['width', 'depth', 'height', 'roof', 'furnish', 'double', 'categories', 'door', 'windows', 'front']
  const o = { kind, material: p.material ? String(p.material).toLowerCase() : 'auto' }
  for (const k of pick) if (p[k] !== undefined) o[k] = p[k]
  if (kind === 'plan') o.plan = p.plan
  return JSON.stringify(o)
}

// ---------------------------------------------------------------- estimate

function pickaxeIn (bot) {
  return bot.inventory.items().some(i => /_pickaxe$/.test(i.name))
}

// Что нужно ещё поставить и выкопать — только по клеткам, которых в мире нет:
// повтор после обрыва считает остаток, а не всю постройку заново.
function tally (bot, cells) {
  const need = {}; const optional = {}
  let digs = 0; let hard = 0; let standing = 0; let work = 0; let unknown = 0
  const hazards = []
  for (const c of cells) {
    if (c.kind === 'part') continue
    const w = bot.blockAt(c.pos)
    if (!w) { unknown++; continue }
    if (FLUID.test(w.name) && c.kind !== 'air') { hazards.push(`${w.name} на ${c.pos.x},${c.pos.y},${c.pos.z}`) }
    if (c.kind === 'air' && !AIR.has(w.name)) {
      if (FLUID.test(w.name)) hazards.push(`${w.name} на ${c.pos.x},${c.pos.y},${c.pos.z}`)
      for (const dir of ['up', ...HORIZ, 'down']) {
        const n = bot.blockAt(c.pos.plus(V[dir]))
        if (n && /lava/.test(n.name)) { hazards.push(`лава за стенкой ${n.position.x},${n.position.y},${n.position.z}`); break }
      }
    }
    if (isDone(bot, c)) { standing++; continue }
    work++
    if (c.kind === 'air' || (!AIR.has(w.name) && !FLUID.test(w.name) && w.boundingBox === 'block')) {
      digs++
      if (w.material && /pickaxe/.test(w.material)) hard++
      if (c.kind === 'air') continue
    }
    const bag = c.optional ? optional : need
    bag[c.item] = (bag[c.item] || 0) + 1
  }
  // Одна строка на вид опасности: «water ×40 (первая 1,2,3)», а не сорок строк.
  const kinds = new Map()
  for (const h of new Set(hazards)) {
    const [what, where] = h.split(' на ')
    const k = kinds.get(what) || { n: 0, first: where }
    k.n++
    kinds.set(what, k)
  }
  const summary = [...kinds].map(([what, k]) => k.n > 1 ? `${what} ×${k.n} (первая ${k.first})` : `${what} на ${k.first}`)
  return { need, optional, digs, hard, standing, work, unknown, hazards: summary }
}

// Рецепт словами: чтобы отказ сметы сразу говорил, из чего сделать.
function craftHint (bot, mcData, name, count) {
  const item = mcData.itemsByName[name]
  if (!item) return null
  let recipes = []
  try { recipes = bot.recipesAll(item.id, null, true) } catch {}
  if (!recipes.length) return null
  const stock = countItems(bot)
  const score = r => (r.delta || []).filter(d => d.count < 0).every(d => (stock[mcData.items[d.id]?.name] || 0) > 0) ? 1 : 0
  const r = recipes.sort((a, b) => score(b) - score(a))[0]
  const per = r.result ? r.result.count : 1
  const times = Math.ceil(count / per)
  const ins = (r.delta || []).filter(d => d.count < 0).map(d => {
    const n = mcData.items[d.id] ? mcData.items[d.id].name : String(d.id)
    return `${n}×${-d.count * times} (есть ${stock[n] || 0})`
  })
  return `${name}×${count}: ${ins.join(' + ')} → mc_craft item=${name} count=${times * per}`
}

// Скаффолдинг: насколько высоко ставить из-за земли. Пол по колено — REACH
// ~4.5 от глаз, глаза на 1.62 над ногами, ноги на y0+1: выше y0+5 — леса.
function scaffoldNeed (cells, groundY) {
  let top = -Infinity
  for (const c of cells) if (c.kind !== 'air' && c.kind !== 'part') top = Math.max(top, c.pos.y)
  return Math.max(0, top - (groundY + 5))
}

function scaffoldItem (bot, planNeeds) {
  const stock = countItems(bot)
  const order = ['dirt', 'netherrack', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'coarse_dirt']
  const spare = n => (stock[n] || 0) - (planNeeds[n] || 0)
  const free = order.find(n => spare(n) >= 3)
  if (free) return free
  return order.find(n => (stock[n] || 0) >= 3) || Object.keys(stock).find(n => /_planks$/.test(n) && stock[n] >= 3) || null
}

// Что в сундуках рядом. Открывает, считает, закрывает. Нужен только если
// рюкзака не хватает — иначе это пустая прогулка.
async function peekChests (session, ctl, radius = 12, max = 6) {
  const bot = session.bot
  const c = require('./containers')
  const ids = ['chest', 'trapped_chest', 'barrel'].map(n => session.mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: max * 2 })
  const seen = []
  const done = new Set()
  for (const pos of found) {
    if (ctl.aborted || seen.length >= max) break
    if (done.has(k3(pos))) continue
    try {
      const { block, win } = await c.findAndOpen(session, ctl, pos, gameClock.now() + 20000)
      const shut = c.guardWindow(ctl, win)
      try {
        const contents = {}
        for (const it of win.containerItems()) contents[it.name] = (contents[it.name] || 0) + it.count
        seen.push({ at: xyz(block.position), contents })
        done.add(k3(block.position))
        // Двойной сундук открывается с любой половины — вторую не открываем.
        for (const dir of HORIZ) {
          const n = block.position.plus(V[dir])
          const nb = bot.blockAt(n)
          if (nb && nb.name === block.name && propsOf(block).type && propsOf(block).type !== 'single') done.add(k3(n))
        }
      } finally { shut(); await sleep(150) }
    } catch {}
  }
  return seen
}

async function takeFromChests (session, ctl, chests, want) {
  const c = require('./containers')
  const took = {}
  for (const ch of chests) {
    const names = Object.keys(want).filter(n => want[n] > 0 && ch.contents[n])
    if (!names.length) continue
    try {
      const { win } = await c.findAndOpen(session, ctl, ch.at, gameClock.now() + 20000)
      const shut = c.guardWindow(ctl, win)
      try {
        const caps = {}
        for (const n of names) caps[n] = want[n]
        const r = await c.withdrawPass(session.bot, session.mcData, win, names, { caps, ctl })
        for (const [n, v] of Object.entries(r.took)) { took[n] = (took[n] || 0) + v; want[n] -= v }
      } finally { shut(); await sleep(150) }
    } catch {}
  }
  return took
}

// ---------------------------------------------------------------- movement

function buildMovements (bot) {
  const m = new Movements(bot)
  m.canDig = false
  m.allow1by1towers = false
  m.scafoldingBlocks = []
  m.allowSprinting = false
  m.maxDropDown = 3
  return m
}

async function walk (bot, goal, ms) {
  const from = bot.entity.position.clone()
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, 'не дошёл')
    return true
  } catch {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    // Не сдвинулся вовсе — тело зажато (впритык к стене после смены хитбокса,
    // см. session.connect playerHalfWidth): встряхнуть, как это делает goto.
    if (bot.entity.position.distanceTo(from) < 0.2) await unstick(bot)
    return false
  }
}

function canStand (bot, p) {
  return isPassable(bot.blockAt(p)) && isPassable(bot.blockAt(p.offset(0, 1, 0))) && isSolid(bot.blockAt(p.offset(0, -1, 0)))
}

// Где встать, чтобы дотянуться до клетки: ближе к телу, не в будущей стене,
// не на земле, которую сейчас выкопаем, не в самой клетке и её паре.
// band — соседние по очереди клетки: место, откуда достаётся больше их,
// лучше ближнего — иначе тело ходит за каждым блоком отдельно.
function standSpots (bot, c, ctx, { outside = null, band = null } = {}) {
  const T = centre(c.pos)
  const me = bot.entity.position
  const pairPos = c.pair ? ctx.byKey.get(c.pair)?.pos : null
  const out = []
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dy = -5; dy <= 1; dy++) {
        const S = c.pos.offset(dx, dy, dz)
        if (S.offset(0.5, EYE, 0.5).distanceTo(T) > REACH - 0.3) continue
        // Не в клетке, не под ней головой и не НА ней: блок под ногами тело
        // не трогает (reachable ниже), и место «на цели» — вечная ходьба туда же.
        if (S.equals(c.pos) || S.offset(0, 1, 0).equals(c.pos) || S.offset(0, -1, 0).equals(c.pos)) continue
        if (pairPos && (S.equals(pairPos) || S.offset(0, 1, 0).equals(pairPos))) continue
        if (outside && S.x >= outside.x1 && S.x <= outside.x2 && S.z >= outside.z1 && S.z <= outside.z2) continue
        if (!canStand(bot, S)) continue
        if (ctx.reach && !ctx.reach.has(k3(S))) continue
        let score = S.distanceTo(me)
        if (band) {
          const eye = S.offset(0.5, EYE, 0.5)
          let cover = 0
          for (const b of band) if (eye.distanceTo(centre(b.pos)) <= REACH - 0.2) cover++
          score -= Math.min(cover, 24) * 0.6
        }
        if (ctx.pendingSolid.has(k3(S)) || ctx.pendingSolid.has(k3(S.offset(0, 1, 0)))) score += 6
        if (ctx.pendingAir.has(k3(S.offset(0, -1, 0)))) score += 12
        out.push({ p: S, score })
      }
    }
  }
  return out.sort((a, b) => a.score - b.score)
}

// Куда тело дойдёт пешком отсюда — тем же набором ходов, что pathfinder без
// копания и без столбов: шаг, шаг на блок вверх, падение до трёх. Место
// встать, до которого не дойти (на верху стены, в замкнутом углу), раньше
// выбиралось по близости — и pathfinder искал к нему дорогу до таймаута:
// 5104 частичных поиска и 15 таймаутов за один дом, 243 с из 315 на ходьбу.
function reachMap (bot, box, { margin = 6, limit = 15000 } = {}) {
  const s = bot.entity.position.floored()
  const X1 = Math.min(box.x1, s.x) - margin; const X2 = Math.max(box.x2, s.x) + margin
  const Z1 = Math.min(box.z1, s.z) - margin; const Z2 = Math.max(box.z2, s.z) + margin
  const Y1 = Math.min(box.y1, s.y) - 4; const Y2 = Math.max(box.y2, s.y) + 3
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const open = (x, y, z) => isPassable(at(x, y, z))
  const solid = (x, y, z) => isSolid(at(x, y, z))
  const seen = new Set()
  const q = [[s.x, s.y, s.z]]
  seen.add(k3(s))
  const push = (x, y, z) => {
    if (x < X1 || x > X2 || z < Z1 || z > Z2 || y < Y1 || y > Y2) return
    const k = `${x},${y},${z}`
    if (seen.has(k)) return
    seen.add(k); q.push([x, y, z])
  }
  while (q.length && seen.size < limit) {
    const [x, y, z] = q.shift()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const nz = z + dz
      if (open(nx, y, nz) && open(nx, y + 1, nz)) {
        let ny = y
        while (ny > y - 4 && !solid(nx, ny - 1, nz) && open(nx, ny - 1, nz)) ny--
        if (solid(nx, ny - 1, nz)) push(nx, ny, nz)
      } else if (solid(nx, y, nz) && open(x, y + 2, z) && open(nx, y + 1, nz) && open(nx, y + 2, nz)) {
        push(nx, y + 1, nz)
      }
    }
  }
  return seen
}

// Выйти наружу пешком: соседняя клетка на том же уровне, шаг на блок вверх
// (прыжок) и падение. Сверх этого тело из коробки не выберется — летать не
// умеет, а столб наружу это уже порча чужой стены.
function canWalkOut (bot, box, extra) {
  // Дверь здесь — стена: pathfinder 2.4.5 открывать умеет только калитки
  // (movements.js: openable — только имена с «gate»), и из дома с закрытой
  // дверью тело пешком не выйдет. Поэтому дверь ставится снаружи.
  const solidAt = (x, y, z) => extra.has(`${x},${y},${z}`) || isSolid(bot.blockAt(new Vec3(x, y, z)))
  const passable = (x, y, z) => !solidAt(x, y, z) && !solidAt(x, y + 1, z)
  const outside = (x, y, z) => x < box.x1 || x > box.x2 || z < box.z1 || z > box.z2 || y > box.y2 + 1
  const s = bot.entity.position.floored()
  const q = [[s.x, s.y, s.z]]
  const seen = new Set([k3(s)])
  const push = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (seen.has(k)) return
    seen.add(k); q.push([x, y, z])
  }
  while (q.length && seen.size < 8000) {
    const [x, y, z] = q.shift()
    if (outside(x, y, z)) return true
    let fy = y
    while (fy > box.y1 - 4 && !solidAt(x, fy - 1, z)) fy--
    if (fy !== y) { push(x, fy, z); continue }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const nz = z + dz
      if (passable(nx, y, nz)) push(nx, y, nz)
      else if (!solidAt(x, y + 2, z) && passable(nx, y + 1, nz)) push(nx, y + 1, nz)
    }
  }
  return false
}

const insideBox = (p, box) => p.x >= box.x1 && p.x <= box.x2 && p.z >= box.z1 && p.z <= box.z2 && p.y >= box.y1 && p.y <= box.y2

// ---------------------------------------------------------------- placing

function waitLook (bot) {
  return new Promise(resolve => {
    const t = gameClock.setTimeout(done, 160)
    function done () { gameClock.clearTimeout(t); bot.removeListener('move', done); resolve() }
    bot.once('move', done)
  })
}

async function waitChange (bot, pos, before, ms) {
  const deadline = gameClock.now() + ms
  while (gameClock.now() < deadline) {
    const b = bot.blockAt(pos)
    if (b && b.name !== before) return b
    await sleep(50)
  }
  return null
}

// Куда кликать, по видам блоков (см. kindOf в blueprint.js). Вектор face — от
// опоры к клетке, cursor — точка клика внутри опоры.
function placeOptions (bot, c) {
  const opts = []
  const add = (dir, cursorY = null) => {
    const d = V[dir]
    const ref = bot.blockAt(c.pos.plus(d))
    if (!isSolid(ref)) return
    if ((c.kind === 'wall' || c.kind === 'floor' || c.kind === 'lantern') && !holds(c, ref)) return
    const face = d.scaled(-1)
    const cursor = new Vec3(0.5 + face.x * 0.5, cursorY ?? 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
    opts.push({ ref, face, cursor, dir, sneak: INTERACTIVE.test(ref.name) })
  }
  const props = c.props || {}
  switch (c.kind) {
    case 'wall': add(c.support); break
    case 'floor': case 'door': case 'bed': add('down'); break
    case 'lantern': add(c.support || 'down'); break
    case 'facer': add('down'); for (const h of HORIZ) add(h); add('up'); break
    case 'stairs': case 'slab': {
      const top = props.half === 'top' || props.type === 'top'
      if (top) { add('up'); for (const h of HORIZ) add(h, 0.75) } else { add('down'); for (const h of HORIZ) add(h, 0.25) }
      break
    }
    case 'pillar': {
      const axis = props.axis || 'y'
      const along = axis === 'y' ? ['down', 'up'] : axis === 'x' ? ['east', 'west'] : ['north', 'south']
      for (const d of along) add(d)
      for (const d of ['down', ...HORIZ, 'up']) if (!along.includes(d)) add(d)
      break
    }
    default:
      for (const d of ['down', ...HORIZ, 'up']) add(d)
  }
  const eye = eyeOf(bot)
  // Порядок вида важен (ступени: сначала грань, которая точно даёт нужную
  // половину), поэтому сортируем устойчиво и только по приседу и досягаемости.
  return opts
    .map((o, i) => ({ ...o, i, far: eye.distanceTo(o.ref.position.plus(o.cursor)) > REACH + 0.9 }))
    .filter(o => !o.far)
    .sort((a, b) => (a.sneak - b.sneak) || (a.i - b.i))
}

function yawFor (c) {
  const f = c.props && c.props.facing
  switch (c.kind) {
    case 'stairs': case 'door': case 'bed': return f ? YAW[f] : null
    case 'facer': return f ? YAW[bp.OPP[f]] : null
    case 'floor': return c.faces ? YAW[bp.OPP[c.faces]] : null
    default: return null
  }
}

// Одна постановка. Возвращает приговор миру, а не пакету.
async function putCell (bot, c, { onSign = null } = {}) {
  const opts = placeOptions(bot, c)
  if (!opts.length) return { ok: false, why: 'не к чему прислонить (или опора далеко)' }
  const stack = itemNamed(bot, c.item)
  if (!stack) return { ok: false, noItem: true, why: `нет ${c.item}` }
  if (!bot.heldItem || bot.heldItem.name !== c.item) {
    try { await bot.equip(stack, 'hand') } catch (e) { return { ok: false, why: e.message } }
  }
  const want = yawFor(c)
  let last = null
  for (const o of opts.slice(0, 3)) {
    const aim = o.ref.position.plus(o.cursor)
    const eye = eyeOf(bot)
    const dx = aim.x - eye.x; const dy = aim.y - eye.y; const dz = aim.z - eye.z
    const yaw = want ?? Math.atan2(-dx, -dz)
    const pitch = Math.atan2(dy, Math.hypot(dx, dz))
    await bot.look(yaw, pitch, true)
    await waitLook(bot)
    const before = (bot.blockAt(c.pos) || {}).name
    if (o.sneak) { bot.setControlState('sneak', true); await sleep(100) }
    const signOpen = onSign ? onSign() : null
    try {
      await bot._genericPlace(o.ref, o.face, { forceLook: 'ignore', delta: o.cursor, swingArm: 'right' })
    } catch (e) { last = e.message }
    const got = await waitChange(bot, c.pos, before, 1200)
    if (o.sneak) { await sleep(60); bot.setControlState('sneak', false) }
    if (got && !AIR.has(got.name)) return { ok: true, name: got.name, match: isDone(bot, c), signOpen }
    if (signOpen && signOpen.cancel) signOpen.cancel()
    last = last || `сервер не поставил (клик в ${o.ref.name} ${o.dir})`
    const e = bot.entity.position
    console.log(`[build] мимо ${c.key} ${c.name}: в руке ${bot.heldItem && bot.heldItem.name}, клик ${o.ref.name}@${k3(o.ref.position)} грань ${o.dir}` +
      ` курсор ${o.cursor.x},${o.cursor.y},${o.cursor.z} yaw ${yaw.toFixed(2)} я ${e.x.toFixed(2)},${e.y.toFixed(2)},${e.z.toFixed(2)}` +
      ` клетка ${(bot.blockAt(c.pos) || {}).name} над ней ${(bot.blockAt(c.pos.offset(0, 1, 0)) || {}).name}`)
  }
  return { ok: false, why: last }
}

async function digAt (bot, pos, { timeoutMs = 15000 } = {}) {
  const b = bot.blockAt(pos)
  if (!b || AIR.has(b.name)) return { ok: true, already: true }
  if (FLUID.test(b.name)) return { ok: false, hard: true, why: `в клетке ${b.name}` }
  if (b.name === 'bedrock' || b.hardness === null || b.hardness < 0) return { ok: false, hard: true, why: `${b.name} не ломается` }
  for (const dir of ['up', ...HORIZ, 'down']) {
    const n = bot.blockAt(pos.plus(V[dir]))
    if (n && /lava/.test(n.name)) return { ok: false, hard: true, why: `за ${b.name} лава (${n.position.x},${n.position.y},${n.position.z}) — не вскрываю` }
  }
  try {
    await equipBestTool(bot, b)
    await withTimeout(bot.dig(b, true), timeoutMs, `${b.name} не ломается`)
    return { ok: true, name: b.name }
  } catch (e) {
    const now = bot.blockAt(pos)
    if (now && AIR.has(now.name)) return { ok: true, name: b.name }
    return { ok: false, why: e.message }
  }
}

// ---------------------------------------------------------------- scaffold

function onTower (bot, t) {
  const f = bot.entity.position.floored()
  return f.x === t.x && f.z === t.z && f.y > t.base
}

async function towerFor (bot, ctl, c, ctx) {
  const item = scaffoldItem(bot, ctx.planNeeds)
  if (!item) return { ok: false, why: 'лесам нечем: ни земли, ни булыжника, ни досок' }
  const T = centre(c.pos)
  const me = bot.entity.position
  const cands = []
  let unreachable = 0
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      const x = c.pos.x + dx; const z = c.pos.z + dz
      let g = null
      for (let y = c.pos.y - 1; y >= c.pos.y - 14; y--) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (!b || FLUID.test(b.name)) break
        if (isSolid(b)) { g = y; break }
      }
      if (g === null) continue
      const base = g + 1
      let top = null
      for (let y = base + 1; y <= c.pos.y + 1; y++) {
        if (new Vec3(x + 0.5, y + EYE, z + 0.5).distanceTo(T) <= REACH - 0.4) { top = y; break }
      }
      if (top === null) continue
      let ok = true
      for (let y = base; y <= top + 1 && ok; y++) {
        const p = new Vec3(x, y, z)
        if (!isPassable(bot.blockAt(p)) || ctx.pendingSolid.has(k3(p)) || p.equals(c.pos)) ok = false
      }
      if (!ok || !canStand(bot, new Vec3(x, base, z))) continue
      if (ctx.reach && !ctx.reach.has(`${x},${base},${z}`) && !(me.floored().x === x && me.floored().z === z)) { unreachable++; continue }
      const h = top - base
      if (h > 12 || (countItems(bot)[item] || 0) < h) continue
      const inside = x > ctx.box.x1 && x < ctx.box.x2 && z > ctx.box.z1 && z < ctx.box.z2
      cands.push({ x, z, base, top, h, score: h * 2 + Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) - (inside ? 2 : 0) })
    }
  }
  cands.sort((a, b) => a.score - b.score)
  if (!cands.length) console.log(`[build] лесов под ${c.key} нет: столбов не дойти ${unreachable}, досягаемо всего ${ctx.reach ? ctx.reach.size : '-'}`)
  for (const s of cands.slice(0, 3)) {
    if (ctl.aborted) break
    const here = bot.entity.position.floored()
    if (!(here.x === s.x && here.z === s.z && here.y === s.base)) {
      await walk(bot, new goals.GoalBlock(s.x, s.base, s.z), 12000)
      const now = bot.entity.position.floored()
      if (!(now.x === s.x && now.z === s.z && now.y === s.base)) continue
    }
    const tower = { x: s.x, z: s.z, base: s.base, top: s.base, item }
    ctx.towers.push(tower)
    ctx.saveTowers()
    const r = await towerUp(bot, ctl, s.h, { sneak: true, item })
    tower.top = s.base + r.placed
    ctx.saveTowers()
    ctx.stats.scaffold += r.placed
    const e = bot.entity.position
    console.log(`[build] леса ${s.x},${s.base},${s.z} +${s.h} под ${c.key}: встало ${r.placed}${r.why ? ` (${r.why.join('; ')})` : ''}, я ${e.x.toFixed(1)},${e.y.toFixed(1)},${e.z.toFixed(1)}, достаю ${inReach(bot, c)}`)
    if (r.placed && inReach(bot, c)) return { ok: true, tower }
    await descend(bot, tower, ctx)
  }
  return { ok: false, why: 'не нашёл, где поставить леса' }
}

// Разобрать свой столб, стоя на нём: копать блок под ногами, падать на следующий.
async function descend (bot, tower, ctx) {
  for (let i = 0; i < 40; i++) {
    const feet = bot.entity.position.floored()
    if (feet.y <= tower.base) break
    const below = bot.blockAt(feet.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') { await sleep(200); continue }
    if (below.position.x !== tower.x || below.position.z !== tower.z || below.position.y < tower.base) break
    try {
      await equipBestTool(bot, below)
      await withTimeout(bot.dig(below, true), 8000, 'леса не ломаются')
    } catch { break }
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && bot.entity.position.y > below.position.y + 0.05) await sleep(50)
  }
  await sweepTower(bot, tower, ctx)
}

// Что от столба осталось (тело слетело с него, или обрыв) — снять в досягаемости.
async function sweepTower (bot, tower, ctx) {
  let left = 0
  for (let y = tower.base; y <= tower.top; y++) {
    const p = new Vec3(tower.x, y, tower.z)
    const b = bot.blockAt(p)
    if (!b || b.name !== tower.item) continue
    if (ctx.byKey.has(k3(p))) continue // клетка плана — не наши леса
    if (eyeOf(bot).distanceTo(centre(p)) > REACH) { left++; continue }
    const r = await digAt(bot, p, { timeoutMs: 8000 })
    if (!r.ok) left++
  }
  if (!left) {
    const i = ctx.towers.indexOf(tower)
    if (i >= 0) ctx.towers.splice(i, 1)
    ctx.saveTowers()
  }
  return left
}

// ---------------------------------------------------------------- execute

async function execute (session, ctl, job, cells, { deadline }) {
  const bot = session.bot
  const t0 = gameClock.now()
  const byKey = new Map(cells.map(c => [c.key, c]))
  const box = boxOf(cells)
  const stats = { placed: 0, dug: 0, scaffold: 0, redo: 0 }
  // Куда ушло время: без этого «медленно» не разобрать на ходьбу и на руки.
  const clock = { walk: 0, walks: 0, place: 0, dig: 0 }
  const timed = async (k, fn) => { const t = gameClock.now(); try { return await fn() } finally { clock[k] += gameClock.now() - t } }
  const skipped = new Map()
  const tries = new Map()
  const missing = new Set()
  const crooked = new Set()
  let unloaded = 0
  const hardSkip = new Set()
  const towerTries = new Map()
  const walkedTo = new Map()
  let focus = null
  const ctx = {
    byKey,
    box,
    stats,
    pendingSolid: new Set(),
    pendingAir: new Set(),
    planNeeds: {},
    towers: job.towers || (job.towers = []),
    saveTowers: () => saveJob(session, job)
  }
  let stopped = null

  bot.pathfinder.setMovements(buildMovements(bot))
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {}; try { bot.setControlState('sneak', false) } catch {} })

  const fail = (c, why, hard = false) => {
    const n = (tries.get(c.key) || 0) + 1
    tries.set(c.key, n)
    c.lastWhy = why
    if (hard || n >= 3) skipped.set(c.key, why)
    if (hard) hardSkip.add(c.key)
    const at = bot.entity.position
    console.log(`[build] ${c.key} ${c.name} #${n}: ${why} (я ${at.x.toFixed(1)},${at.y.toFixed(1)},${at.z.toFixed(1)})`)
  }

  // Прошлый вызов оборвался на лесах — сначала слезть и прибрать.
  for (const t of [...ctx.towers]) {
    if (onTower(bot, t)) await descend(bot, t, ctx)
    else await sweepTower(bot, t, ctx)
  }
  let tower = null

  // Своя дверь уже стоит (прошлый вызов дошёл до неё), а работы ещё есть —
  // снять её: pathfinder дверей не открывает. В конце она встанет снова.
  let reopened = 0
  const leftWork = cells.some(c => c.kind !== 'door' && c.kind !== 'part' && !isDone(bot, c))
  for (const d of cells.filter(c => c.kind === 'door' && isDone(bot, c))) {
    if (!leftWork || ctl.aborted) break
    if (!inReach(bot, d)) await walk(bot, new goals.GoalNear(d.pos.x, d.pos.y, d.pos.z, 2), 12000)
    if (inReach(bot, d)) {
      const r = await digAt(bot, d.pos)
      if (r.ok) reopened++
      // Верхнюю половину сервер снимает отдельным обновлением, чуть позже нижней:
      // карта «куда дойду», снятая раньше, видит проём закрытым.
      const up = d.pos.offset(0, 1, 0)
      for (let i = 0; i < 30 && !AIR.has((bot.blockAt(up) || {}).name); i++) await sleep(50)
    }
  }

  const refresh = () => {
    ctx.pendingSolid.clear(); ctx.pendingAir.clear()
    const need = {}
    const pending = []
    // Клетки под своими лесами — не работа: столб снимется сам, спускаясь.
    const scaffolded = p => ctx.towers.some(t => p.x === t.x && p.z === t.z && p.y >= t.base && p.y <= t.top)
    for (const c of cells) {
      if (c.kind === 'part') continue
      if (isDone(bot, c)) continue
      if (scaffolded(c.pos)) continue
      if (skipped.has(c.key)) continue
      pending.push(c)
      if (c.kind === 'air') ctx.pendingAir.add(c.key)
      else {
        ctx.pendingSolid.add(c.key)
        need[c.item] = (need[c.item] || 0) + 1
      }
    }
    // Вторая половина двери и кровати — тоже будущий блок.
    for (const c of pending) if (c.pair && c.kind !== 'air') ctx.pendingSolid.add(c.pair)
    ctx.planNeeds = need
    return pending
  }

  const ready = c => {
    const b = bot.blockAt(c.pos)
    if (!b) return false
    if (c.kind === 'air') return true
    const opts = c.kind === 'wall' || c.kind === 'lantern'
      ? [c.support || 'down']
      : c.kind === 'floor' || c.kind === 'door' || c.kind === 'bed' ? ['down'] : ['down', ...HORIZ, 'up']
    return opts.some(d => {
      const n = bot.blockAt(c.pos.plus(V[d]))
      return (c.kind === 'wall' || c.kind === 'floor' || c.kind === 'lantern') ? holds(c, n) : isSolid(n)
    })
  }

  while (!ctl.aborted) {
    if (gameClock.now() > deadline - (tower ? 9000 : 2500)) { stopped = 'время вышло'; break }
    const pending = refresh()
    if (!pending.length) break
    const phase = Math.min(...pending.map(c => c.phase))
    const layer = pending.filter(c => c.phase === phase)
    const workable = layer.filter(c => ready(c) && !missing.has(c.item))
    for (const c of layer) {
      if (c.kind !== 'air' && missing.has(c.item)) { skipped.set(c.key, `нет ${c.item}`); hardSkip.add(c.key) }
    }
    // Дверь — последней и только когда внутри доделано: pathfinder дверей не
    // открывает, и с дверью на месте следующий вызов внутрь уже не войдёт.
    if (phase === bp.PHASE.door) {
      const unfinished = [...skipped.keys()].filter(k => !hardSkip.has(k) && byKey.get(k) && byKey.get(k).phase < bp.PHASE.door)
      if (unfinished.length) {
        for (const c of layer) skipped.set(c.key, `дверь не ставлю: не достроено ${unfinished.length} клеток, проём оставил, чтобы войти`)
        continue
      }
    }
    if (!workable.length) {
      // Чанк выгрузился (ушли далеко на леса или за угол) — подождать, а не списывать.
      if (layer.some(c => !bot.blockAt(c.pos)) && (unloaded++ < 20)) { await sleep(500); continue }
      for (const c of layer) {
        if (skipped.has(c.key)) continue
        skipped.set(c.key, c.kind === 'wall' ? 'опоры для неё нет' : 'висит в воздухе: прислонить не к чему')
        hardSkip.add(c.key)
      }
      continue
    }

    // Порядок: копать сверху вниз (осыпь падает в уже пустое), ставить снизу
    // вверх полосой в три ряда — чтобы с одного места ложилась вся колонка.
    let band
    if (phase === bp.PHASE.clear) {
      const top = Math.max(...workable.map(c => c.pos.y))
      band = workable.filter(c => c.pos.y >= top - 2)
    } else {
      const low = Math.min(...workable.map(c => c.pos.y))
      band = workable.filter(c => c.pos.y <= low + 2)
    }
    const me = bot.entity.position
    const byDist = (a, b) => (phase === bp.PHASE.clear ? b.pos.y - a.pos.y : a.pos.y - b.pos.y) || centre(a.pos).distanceTo(me) - centre(b.pos).distanceTo(me)
    const reachable = c => inReach(bot, c) && !bodyInCell(bot, c.pos) &&
      !(c.pair && byKey.get(c.pair) && bodyInCell(bot, byKey.get(c.pair).pos)) &&
      !(bot.entity.position.floored().offset(0, -1, 0).equals(c.pos))
    // Сначала то, что уже в руке: смена предмета — это клик по окну и круг до сервера.
    const held = bot.heldItem ? bot.heldItem.name : null
    const inHand = (a, b) => (b.item === held) - (a.item === held)
    let target = null
    // Леса ставились под конкретную клетку — её и первой, не перебирая заново.
    if (focus) {
      const f = pending.find(c => c.key === focus)
      if (f && reachable(f)) target = f
      else if (f) console.log(`[build] под ${f.key} встал на леса, а не достаю: до глаз ${eyeOf(bot).distanceTo(centre(f.pos)).toFixed(2)}, тело ${bodyInCell(bot, f.pos)}`)
      focus = null
    }
    if (!target) target = band.filter(reachable).sort((a, b) => (phase === bp.PHASE.clear ? 0 : inHand(a, b)) || byDist(a, b))[0]
    if (!target && tower) target = workable.filter(reachable).sort(byDist)[0]

    if (!target) {
      if (tower) {
        const b0 = band[0]
        const e = bot.entity.position
        console.log(`[build] с лесов ${tower.x},${tower.top},${tower.z} больше не достать: в полосе ${band.length} (${b0.key} до глаз ${eyeOf(bot).distanceTo(centre(b0.pos)).toFixed(2)}, тело в клетке ${bodyInCell(bot, b0.pos)}), готовых ${workable.length}, я ${e.x.toFixed(2)},${e.y.toFixed(2)},${e.z.toFixed(2)}`)
        await descend(bot, tower, ctx); tower = null; continue
      }
      const near = (a, b) => centre(a.pos).distanceTo(me) - centre(b.pos).distanceTo(me)
      const goal = band.slice().sort((a, b) => (tries.get(a.key) || 0) - (tries.get(b.key) || 0) || near(a, b))[0]
      ctx.reach = reachMap(bot, box)
      const spots = standSpots(bot, goal, ctx, { band })
      let there = false
      for (const s of spots.slice(0, 3)) {
        if (ctl.aborted) break
        clock.walks++
        await timed('walk', () => walk(bot, new goals.GoalBlock(s.p.x, s.p.y, s.p.z), 12000))
        if (reachable(goal)) { there = true; break }
      }
      if (ctl.aborted) continue
      if (there) { walkedTo.set(goal.key, (walkedTo.get(goal.key) || 0) + 1); if (walkedTo.get(goal.key) > 3) fail(goal, 'дохожу, а взять не выходит', true); continue }
      // Леса — только когда клетка правда высоко. Низкая, до которой не
      // дошли, — это дорога, а не рост, и столб её не решит.
      if (spots.length && goal.pos.y - bot.entity.position.floored().y < 4) {
        fail(goal, 'не дошёл до места, откуда достать')
        continue
      }
      const up = await towerFor(bot, ctl, goal, ctx)
      if (up.ok) {
        tower = up.tower
        focus = goal.key
        const n = (towerTries.get(goal.key) || 0) + 1
        towerTries.set(goal.key, n)
        // Леса под одну и ту же клетку в третий раз — дело не в высоте.
        if (n > 2) fail(goal, 'и с лесов не выходит поставить', true)
        continue
      }
      fail(goal, spots.length ? `не дошёл, куда встать (${up.why})` : `встать некуда: ${up.why}`)
      continue
    }

    // --- работа над клеткой
    const c = target
    if (c.kind === 'air') {
      const r = await timed('dig', () => digAt(bot, c.pos))
      if (r.ok) { if (!r.already) stats.dug++ } else fail(c, r.why, r.hard)
      continue
    }
    const who = squatter(bot, c.pos)
    if (who) { fail(c, `в клетке стоит ${who}`); await sleep(400); continue }

    // Чужой блок на месте — убрать. Заделку (seal) твёрдое устраивает всегда.
    const w = bot.blockAt(c.pos)
    if (w && !AIR.has(w.name)) {
      if (FLUID.test(w.name)) { fail(c, `в клетке ${w.name}`, true); continue }
      const r = await timed('dig', () => digAt(bot, c.pos))
      if (!r.ok) { fail(c, `мешает ${w.name}: ${r.why}`, r.hard); continue }
      if (w.name === c.name) stats.redo++
    }
    if (c.pair) {
      const pc = byKey.get(c.pair)
      const pw = pc && bot.blockAt(pc.pos)
      if (pw && !AIR.has(pw.name)) {
        const r = await digAt(bot, pc.pos)
        if (!r.ok) { fail(c, `вторая клетка занята ${pw.name}`, r.hard); continue }
      }
    }
    // Не замуровать себя: пока тело внутри, после этого блока выход должен остаться.
    const feet = bot.entity.position.floored()
    // Выход закрывают только клетки на уровне ног и головы (и та, что над ней,
    // — для прыжка): поиск пути наружу — десятки мс, и на крышу его не тратим.
    // Факел, табличка, фонарь, лестница проход не закрывают — их не проверяем.
    const blocks = !(c.kind === 'wall' || c.kind === 'floor' || c.kind === 'lantern')
    if (blocks && insideBox(feet, box) && c.pos.y >= feet.y - 1 && c.pos.y <= feet.y + 2) {
      const extra = new Set([c.key])
      if (c.pair) extra.add(c.pair)
      if (!canWalkOut(bot, box, extra)) {
        // Стою на своих лесах — сперва слезть: столб в клетке за проёмом сам
        // закрывает выход (так и было: леса под конёк встали прямо за дверью).
        if (tower) { await descend(bot, tower, ctx); tower = null; continue }
        ctx.reach = reachMap(bot, box)
        const out = standSpots(bot, c, ctx, { outside: box })
        let moved = false
        for (const s of out.slice(0, 3)) {
          await walk(bot, new goals.GoalBlock(s.p.x, s.p.y, s.p.z), 15000)
          if (!insideBox(bot.entity.position.floored(), box) && inReach(bot, c)) { moved = true; break }
        }
        if (!moved) { fail(c, 'замуровал бы себя изнутри: снаружи до клетки не дотянуться'); continue }
      }
    }

    const sign = c.text && c.text.length ? onceSignEditor(bot, 2500) : null
    const r = await timed('place', () => putCell(bot, c, { onSign: sign ? () => sign : null }))
    if (!r.ok) {
      if (sign) sign.cancel()
      if (r.noItem) { missing.add(c.item); fail(c, r.why, true) } else fail(c, r.why)
      continue
    }
    stats.placed++
    if (!r.match) {
      // Встал, но не тем боком. Один повтор (следующий круг выкопает и
      // поставит снова), потом — как есть, с причиной: иначе круг вечный.
      const got = JSON.stringify(propsOf(bot.blockAt(c.pos)))
      if (crooked.has(c.key)) skipped.set(c.key, `встал не тем боком: ${got}`)
      else { crooked.add(c.key); c.lastWhy = `встал не тем боком: ${got}` }
      continue
    }
    if (sign) {
      const s = await writeSign(bot, c.pos, c.text, { opened: sign })
      if (!s.ok) c.signWhy = s.why
      else stats.signs = (stats.signs || 0) + 1
    }
  }

  if (tower && !ctl.aborted) await descend(bot, tower, ctx)
  try { session.updateMovements(true) } catch {}

  const unfinished = cells.filter(c => c.kind !== 'part' && !isDone(bot, c))
  // Необязательное (мебель, свет, окна), чего нет в рюкзаке, — не недострой,
  // а пропуск с причиной: дом без кровати всё равно дом.
  const lacking = unfinished.filter(c => c.optional && missing.has(c.item))
  const left = unfinished.filter(c => !lacking.includes(c))
  const optionalMissing = {}
  for (const c of lacking) optionalMissing[c.item] = (optionalMissing[c.item] || 0) + 1
  const why = {}
  for (const c of left) {
    const w = skipped.get(c.key) || c.lastWhy || 'не дошли руки'
    why[w] = (why[w] || 0) + 1
  }
  const skippedAt = left.filter(c => skipped.has(c.key)).slice(0, 6)
    .map(c => ({ at: xyz(c.pos), block: c.name, why: skipped.get(c.key) }))
  const signFails = cells.filter(c => c.signWhy).map(c => ({ at: xyz(c.pos), why: c.signWhy }))
  const walledIn = insideBox(bot.entity.position.floored(), box) && !canWalkOut(bot, box, new Set())
  return {
    placed: stats.placed,
    dug: stats.dug,
    optionalMissing: Object.keys(optionalMissing).length ? optionalMissing : undefined,
    redo: stats.redo || undefined,
    reopened: reopened || undefined,
    scaffold: stats.scaffold || undefined,
    towersLeft: ctx.towers.length ? ctx.towers.map(t => ({ x: t.x, z: t.z, from: t.base, to: t.top })) : undefined,
    left: left.length,
    skipped: skipped.size,
    why: Object.keys(why).length ? why : undefined,
    skippedAt: skippedAt.length ? skippedAt : undefined,
    signs: stats.signs || undefined,
    signFails: signFails.length ? signFails : undefined,
    missing: missing.size ? [...missing] : undefined,
    walledIn: walledIn || undefined,
    stopped,
    seconds: Math.round((gameClock.now() - t0) / 1000),
    timing: { walk: Math.round(clock.walk / 1000), walks: clock.walks, place: Math.round(clock.place / 1000), dig: Math.round(clock.dig / 1000) }
  }
}

// ---------------------------------------------------------------- signs

// Редактор таблички сервер открывает сам сразу после постановки (Paper:
// SignItem запоминает openSign, потом SignBlock.openTextEdit ставит
// playerWhoMayEdit = мы и шлёт open_sign_editor). Пакет прилетает сразу за
// блоком, поэтому ухо ставится ДО клика. updateSignText на сервере пустит
// текст только от того, кто в playerWhoMayEdit (байткод SignBlockEntity).
function onceSignEditor (bot, ms) {
  let settle
  let timer = null
  const p = new Promise(resolve => { settle = resolve })
  const on = packet => { cleanup(); settle(packet) }
  const cleanup = () => { gameClock.clearTimeout(timer); bot._client.removeListener('open_sign_entity', on) }
  bot._client.on('open_sign_entity', on)
  timer = gameClock.setTimeout(() => { cleanup(); settle(null) }, ms)
  p.cancel = () => { cleanup(); settle(null) }
  return p
}

function signText (bot, pos) {
  const b = bot.blockAt(pos)
  if (!b || !/_sign$/.test(b.name)) return null
  const e = b.entity
  if (!e) return { front: [], back: [] }
  let nbt = null
  try { nbt = require('prismarine-nbt').simplify(e) } catch { nbt = null }
  const side = s => {
    const msgs = (nbt && nbt[s] && nbt[s].messages) || []
    return msgs.map(m => {
      if (typeof m === 'string') {
        if (/^[{["]/.test(m)) {
          try { return flat(JSON.parse(m)) } catch { return m }
        }
        return m
      }
      return flat(m)
    })
  }
  return { front: side('front_text'), back: side('back_text') }
}

function flat (c) {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(flat).join('')
  return (c.text || '') + (Array.isArray(c.extra) ? c.extra.map(flat).join('') : '')
}

async function writeSign (bot, pos, lines, { opened = null } = {}) {
  const want = bp.signLines(lines)
  let pk = opened ? await opened : null
  if (!pk) {
    // Редактор не открылся сам (табличка старая) — клик по ней открывает его,
    // если в руке нет красителя, чернил или сот: они красят, а не открывают.
    const b = bot.blockAt(pos)
    if (!b || !/_sign$/.test(b.name)) return { ok: false, why: 'таблички нет' }
    if (bot.heldItem && /dye$|ink_sac|honeycomb/.test(bot.heldItem.name)) {
      try { await bot.unequip('hand') } catch {}
    }
    const again = onceSignEditor(bot, 2500)
    try { await bot.activateBlock(b) } catch {}
    pk = await again
  }
  if (!pk) return { ok: false, why: 'сервер не открыл табличку для записи (воском покрыта или её правит другой)' }
  const block = bot.blockAt(pos)
  bot.updateSign(block, want.join('\n'), pk.isFrontText === false)
  const deadline = gameClock.now() + 2000
  while (gameClock.now() < deadline) {
    const t = signText(bot, pos)
    const side = t && (pk.isFrontText === false ? t.back : t.front)
    if (side && want.every((s, i) => (side[i] || '') === s)) return { ok: true, side: pk.isFrontText === false ? 'back' : 'front' }
    await sleep(150)
  }
  const t = signText(bot, pos)
  return { ok: false, why: `текст не подтвердился: ${JSON.stringify(t)}` }
}

// ---------------------------------------------------------------- entry

// Разобрать запрос до мировых клеток, место и смету — общее для preview и build.
async function prepare (session, ctl, p) {
  const bot = session.bot
  const mcData = session.mcData
  const has = hasName(mcData)
  const stock = countItems(bot)
  const job = jobOf(session)
  let kind = p.plan ? 'plan' : String(p.kind || '').toLowerCase()
  const resume = p.mode === 'resume' || (!p.kind && !p.plan && job && job.status !== 'done' && p.mode !== 'preview')

  let plan
  let front
  let origin = p.origin ? { x: Math.floor(p.origin.x), y: Math.floor(p.origin.y), z: Math.floor(p.origin.z) } : null
  let site = null
  let reused = false

  if (resume) {
    if (!job) throw new Error('продолжать нечего: в памяти нет начатой стройки')
    kind = job.kind
    plan = { kind, parts: job.parts, subs: job.subs || [], material: job.material, labels: job.labels || null }
    front = job.front
    origin = job.origin
    reused = true
  } else {
    if (!kind) kind = 'house'
    plan = makeParts(session, { ...p, kind }, stock)
    const sig = sigOf(kind, p)
    // Тот же заказ, что в памяти, и рядом — это продолжение того же дома.
    if (!origin && !p.fresh && job && job.sig === sig && job.origin &&
        new Vec3(job.origin.x, job.origin.y, job.origin.z).distanceTo(bot.entity.position) < 64) {
      plan = { kind, parts: job.parts, subs: job.subs || plan.subs, material: job.material, labels: job.labels || plan.labels }
      front = job.front
      origin = job.origin
      reused = true
    }
    front = front || p.front || null
  }

  const spec = bp.KINDS[kind] || { site: 'surface', ru: 'постройка' }
  if (!origin) {
    if (spec.site === 'hill') {
      const probe = bp.layout(plan.parts, { front: 'south', has })
      const W = probe.size.w - 2; const D = probe.size.d - 3; const H = probe.size.y2 - 1
      const hill = pickHillside(bot, { W, D, H, radius: Math.max(4, Math.min(24, p.radius ?? 12)) })
      if (!hill) return { refused: { stopped: `Склона под землянку рядом нет: нужен холм, где комната ${W}×${D}×${H} целиком в земле и над ней ещё слой. Подойди к склону или скажи место (origin), или строй дом (kind=house).` } }
      front = bp.OPP[hill.dir]
      const L = bp.layout(plan.parts, { front, has })
      const mid = Math.floor(W / 2)
      const porch = relOf(L, plan.parts, has, mid, D + 1)
      origin = { x: hill.E.x - porch.x, y: hill.E.y - 1, z: hill.E.z - porch.z }
      site = { how: 'склон нашёл сам', entrance: xyz(hill.E), into: hill.dir, rock: hill.ratio, roof: hill.roof, dist: hill.dist }
    } else if (spec.site === 'ahead') {
      const dir = p.direction || facingOf(bot)
      front = bp.OPP[dir]
      const L = bp.layout(plan.parts, { front, has })
      const probe = bp.layout(plan.parts, { front: 'south', has })
      const W = probe.size.w - 2; const D = probe.size.d - 3
      const porch = relOf(L, plan.parts, has, Math.floor(W / 2), D + 1)
      const feet = bot.entity.position.floored()
      origin = { x: feet.x - porch.x, y: feet.y - 1, z: feet.z - porch.z }
      site = { how: 'прямо передо мной', into: dir }
    } else {
      const L0 = bp.layout(plan.parts, { front: 'south', has })
      const s = pickSurfaceSite(bot, { w: L0.size.w, d: L0.size.d, h: L0.size.y2, radius: Math.max(4, Math.min(32, p.radius ?? 16)) })
      if (!s) return { refused: { stopped: `Ровного места под ${spec.ru} ${L0.size.w}×${L0.size.d} в ${p.radius ?? 16} блоках нет: везде вода, обрыв или чужие постройки. Назови место (origin) или отойди на открытое.` } }
      const centreXZ = { x: s.x0 + s.L / 2, z: s.z0 + s.L / 2 }
      front = front || cardinalTo(centreXZ, bot.entity.position)
      const L = bp.layout(plan.parts, { front, has })
      origin = { x: Math.floor(centreXZ.x - L.size.w / 2), y: s.y0, z: Math.floor(centreXZ.z - L.size.d / 2) }
      site = { how: 'выбрал сам', levelling: { dig: s.cut, fill: s.fill, trees: s.trees || undefined }, dist: s.dist }
    }
  } else if (!site) {
    site = { how: reused ? 'продолжаю начатое' : 'назвал ты' }
  }

  front = front || 'south'
  const L = bp.layout(plan.parts, { front, has })
  const cells = place(L, origin)
  // Мир вокруг места должен быть прогружен: blockAt в непрогруженном чанке —
  // null, и такая клетка читается как «висит в воздухе». Сразу после входа на
  // сервер или телепорта это вся постройка.
  let t = tally(bot, cells)
  for (let i = 0; i < 20 && t.unknown && !ctl.aborted; i++) {
    if (i === 0) { try { await withTimeout(bot.waitForChunksToLoad(), 8000, 'чанки') } catch {} }
    await sleep(400)
    t = tally(bot, cells)
  }
  if (t.unknown) return { refused: { stopped: `Место не прогружено: ${t.unknown} клеток постройки в чанках, которых тело не видит. Подойди ближе и позови снова.` } }
  const groundY = origin.y
  const lift = scaffoldNeed(cells.filter(c => !isDone(bot, c)), groundY)
  return { plan, kind, spec, front, origin, site, reused, L, cells, tally: t, lift, stock }
}

// Смета: что нужно, что есть в рюкзаке, что в сундуках рядом, чего нет.
function shortfall (bot, mcData, need, stock, chests) {
  const inChests = {}
  for (const ch of chests || []) for (const [n, v] of Object.entries(ch.contents)) inChests[n] = (inChests[n] || 0) + v
  const short = []
  for (const [what, count] of Object.entries(need)) {
    const have = stock[what] || 0
    const box = inChests[what] || 0
    if (have + box >= count) continue
    short.push({ what, count: count - have - box, have, inChests: box || undefined, craft: craftHint(bot, mcData, what, count - have - box) || undefined })
  }
  return { short, inChests }
}

function say (kindRu, L, material, need, short) {
  const total = Object.values(need).reduce((a, b) => a + b, 0)
  const top = Object.entries(need).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, v]) => `${n} ${v}`).join(', ')
  const miss = short.length ? ` Не хватает: ${short.slice(0, 3).map(s => `${s.what} ${s.count}`).join(', ')}.` : ' Всё есть.'
  return `${kindRu} ${L.size.w}×${L.size.d}${material ? ` из ${material}` : ''}: ${total} блоков (${top}).${miss}`.slice(0, 240)
}

async function preview (session, ctl, p) {
  const bot = session.bot
  p = cleanParams(p)
  const pr = await prepare(session, ctl, { ...p, mode: 'preview' })
  if (pr.refused) return { mode: 'preview', ok: false, ...pr.refused }
  const { plan, kind, spec, front, origin, site, L, tally: t, lift, stock } = pr
  const needAll = { ...t.need }
  let chests = []
  let { short } = shortfall(bot, session.mcData, needAll, stock, [])
  if (short.length && p.chests !== false) {
    chests = await peekChests(session, ctl)
    short = shortfall(bot, session.mcData, needAll, stock, chests).short
  }
  const optShort = shortfall(bot, session.mcData, t.optional, stock, chests).short
  const scaff = lift ? scaffoldItem(bot, needAll) : null
  const eta = Math.round(t.digs * 0.8 + t.hard * 1.2 + Object.values(needAll).reduce((a, b) => a + b, 0) * 0.7 + Object.values(t.optional).reduce((a, b) => a + b, 0) * 0.9 + lift * 3 + 5)
  const job = {
    kind,
    sig: sigOf(kind, p),
    status: 'preview',
    name: p.name || spec.ru,
    material: plan.material,
    parts: plan.parts,
    subs: plan.subs,
    labels: plan.labels,
    front,
    origin,
    size: L.size,
    towers: [],
    at: new Date().toISOString()
  }
  if (!pr.reused || (jobOf(session) && jobOf(session).status === 'preview')) saveJob(session, job)
  else saveJob(session, { ...jobOf(session), origin, front })
  const verdict = t.hazards.length ? 'нельзя' : short.length ? 'не хватает' : 'хватает'
  return {
    mode: 'preview',
    kind,
    name: job.name,
    material: plan.material || undefined,
    front,
    at: origin,
    size: { w: L.size.w, d: L.size.d, h: L.size.y2 },
    entrance: entranceOf(pr.cells),
    site,
    blocks: t.work + t.standing,
    standing: t.standing || undefined,
    materials: needAll,
    optional: Object.keys(t.optional).length ? t.optional : undefined,
    have: Object.fromEntries(Object.keys({ ...needAll, ...t.optional }).map(n => [n, stock[n] || 0])),
    chests: chests.length ? chests.map(c => ({ at: c.at, items: Object.keys(c.contents).length })) : undefined,
    short: short.length ? short : undefined,
    shortOptional: optShort.length ? optShort.map(s => `${s.what} ${s.count}`) : undefined,
    need: short[0] ? { what: short[0].what, count: short[0].count, have: short[0].have } : undefined,
    substitutions: plan.subs.length ? plan.subs : undefined,
    dig: t.digs || undefined,
    digNeedsPickaxe: t.hard && !pickaxeIn(bot) ? t.hard : undefined,
    scaffold: lift ? { height: lift, item: scaff || 'нечем', returns: true } : undefined,
    hazards: t.hazards.length ? t.hazards : undefined,
    etaSeconds: eta,
    verdict,
    say: say(spec.ru || 'постройка', L, plan.material, needAll, short),
    note: verdict === 'нельзя'
      ? `Строить тут нельзя: ${t.hazards.join('; ')}. Другое место — origin или radius.`
      : `Место и план запомнил: mc_build mode=build с теми же параметрами строит ровно это (или mode=resume). ${short.length ? 'Сначала принеси недостающее — стройка без него откажет, не тронув мир.' : ''}`.trim()
  }
}

async function build (session, ctl, p) {
  const bot = session.bot
  p = cleanParams(p)
  const deadline = gameClock.now() + Math.min(600, p.timeoutSeconds ?? 240) * 1000
  const pr = await prepare(session, ctl, p)
  if (pr.refused) return { mode: 'build', built: false, ...pr.refused }
  const { plan, kind, spec, front, origin, site, L, cells, tally: t, lift, stock } = pr

  // --- 1. отказ до того, как тронуть мир.
  if (t.hazards.length) {
    return { mode: 'build', built: false, kind, at: origin, site, hazards: t.hazards, stopped: `НЕ СТРОЮ: в пятне стройки ${t.hazards.join('; ')} — в воде и у лавы не строю. Другое место: origin или radius.` }
  }
  if (t.hard > 4 && !pickaxeIn(bot)) {
    return { mode: 'build', built: false, kind, at: origin, site, need: { what: 'wooden_pickaxe', count: 1, have: 0 }, stopped: `НЕ СТРОЮ: копать ${t.hard} блоков камня, а кирки нет — руками это по 7с на блок.` }
  }
  let chests = []
  let { short } = shortfall(bot, session.mcData, t.need, stock, [])
  if (short.length && p.chests !== false) {
    chests = await peekChests(session, ctl)
    short = shortfall(bot, session.mcData, t.need, stock, chests).short
  }
  const scaff = lift ? scaffoldItem(bot, t.need) : null
  if (lift && !scaff && !short.length) {
    short = [{ what: 'dirt', count: lift, have: 0, why: 'на леса (вернутся)' }]
  }
  if (short.length) {
    const job = jobOf(session)
    if (!job || job.sig !== sigOf(kind, p) || pr.reused === false) {
      saveJob(session, { kind, sig: sigOf(kind, p), status: 'preview', name: p.name || spec.ru, material: plan.material, parts: plan.parts, subs: plan.subs, labels: plan.labels, front, origin, size: L.size, towers: [], at: new Date().toISOString() })
    }
    return {
      mode: 'build',
      built: false,
      kind,
      at: origin,
      front,
      site,
      need: { what: short[0].what, count: short[0].count, have: short[0].have },
      short,
      materials: t.need,
      stopped: `НЕ СТРОЮ: не хватает ${short.map(s => `${s.what} ×${s.count} (есть ${s.have}${s.inChests ? `, в сундуках ${s.inChests}` : ''})`).join(', ')}. Мир не тронут.`,
      note: [short.map(s => s.craft).filter(Boolean).join('; '), 'Место запомнил: принесёшь — позови тот же mc_build, встанет сюда же.'].filter(Boolean).join(' ')
    }
  }

  // --- 2. взять недостающее из сундуков рядом.
  let fromChests
  if (chests.length) {
    const want = {}
    for (const [n, c] of Object.entries(t.need)) {
      const lack = c - (countItems(bot)[n] || 0)
      if (lack > 0) want[n] = lack
    }
    for (const [n, c] of Object.entries(t.optional)) {
      const lack = c - (countItems(bot)[n] || 0) - (want[n] || 0)
      if (lack > 0) want[n] = (want[n] || 0) + lack
    }
    if (Object.keys(want).length) fromChests = await takeFromChests(session, ctl, chests, want)
  }

  // --- 3. строить.
  const prev = jobOf(session)
  const same = prev && prev.origin && prev.origin.x === origin.x && prev.origin.y === origin.y && prev.origin.z === origin.z &&
    (pr.reused || prev.sig === sigOf(kind, p))
  const job = same
    ? prev
    : { kind, sig: sigOf(kind, p), name: p.name || spec.ru, material: plan.material, parts: plan.parts, subs: plan.subs, labels: plan.labels, front, origin, size: L.size, towers: [], at: new Date().toISOString() }
  if (!job.towers) job.towers = []
  job.status = 'building'
  job.calls = (job.calls || 0) + 1
  saveJob(session, job)

  const r = await execute(session, ctl, job, cells, { deadline })
  const finished = r.left === 0
  job.status = finished ? 'done' : 'partial'
  job.placed = (job.placed || 0) + r.placed
  job.updated = new Date().toISOString()
  saveJob(session, job)
  if (finished || r.placed > 0) remember(session, job, cells)

  const detail = {
    mode: 'build',
    built: finished,
    kind,
    name: job.name,
    material: plan.material || undefined,
    at: origin,
    front,
    size: { w: L.size.w, d: L.size.d, h: L.size.y2 },
    entrance: entranceOf(cells),
    site,
    total: t.work + t.standing,
    standing: t.standing || undefined,
    ...r,
    fromChests,
    substitutions: plan.subs.length ? plan.subs : undefined,
    calls: job.calls
  }
  const essential = (r.missing || []).filter(n => cells.some(c => c.item === n && !c.optional && !isDone(bot, c)))
  if (essential.length) {
    const lack = essential[0]
    detail.need = { what: lack, count: cells.filter(c => c.item === lack && !isDone(bot, c)).length, have: countItems(bot)[lack] || 0 }
  }
  if (finished) {
    detail.note = `Готово: ${job.name} ${L.size.w}×${L.size.d} на ${origin.x},${origin.y},${origin.z}` +
      `${r.placed ? `, поставил ${r.placed}` : ', всё уже стояло'}${r.dug ? `, выкопал ${r.dug}` : ''} за ${r.seconds}с. Записал в память как «${job.name}».` +
      (r.optionalMissing ? ` Без: ${Object.entries(r.optionalMissing).map(([n, k]) => `${n} ×${k}`).join(', ')} — нет в рюкзаке, принесёшь — позови снова, доставлю.` : '')
  } else {
    const reasons = r.why ? Object.entries(r.why).map(([w, n]) => `${w} ×${n}`).slice(0, 3).join('; ') : ''
    detail.stopped = r.stopped === 'время вышло'
      ? `время вышло: осталось ${r.left} клеток из ${t.work + t.standing}`
      : r.walledIn ? 'ЗАМУРОВАН: выхода нет — план без двери/проёма' : `не всё встало: осталось ${r.left} (${reasons})`
    detail.note = r.skipped
      ? `Пропустил ${r.skipped} клеток с причинами (why). Позови mc_build mode=resume — доделает остальное; поставленное не ломает.`
      : 'Позови mc_build mode=resume (или тот же вызов) — продолжит отсюда, поставленное не трогает.'
  }
  return detail
}

// Где вход: клетка двери, а без неё — нижняя клетка проёма или ворот.
function entranceOf (cells) {
  const door = cells.find(c => c.kind === 'door')
  if (door) return xyz(door.pos)
  const way = cells.filter(c => c.role === 'doorway' || c.role === 'gate').sort((a, b) => a.pos.y - b.pos.y)[0]
  return way ? xyz(way.pos) : undefined
}

// Постройка в память: место по имени, склад — со списком сундуков.
function remember (session, job, cells) {
  const o = job.origin
  session.journal.patch(s => {
    s.places = s.places || {}
    s.places[job.name] = { x: o.x, y: o.y + 1, z: o.z, note: `${job.kind} ${job.size ? `${job.size.w}×${job.size.d}` : ''} (${job.status})` }
    if (job.kind === 'storage') {
      const chests = cells.filter(c => c.role === 'chest').map(c => ({ ...xyz(c.pos), category: c.label }))
      s.storage = { name: job.name, at: o, chests, updated: new Date().toISOString() }
    }
  })
}

// Справка без мира: какие постройки есть и как выглядит план частями.
function kinds (session, p = {}) {
  const has = session.mcData ? hasName(session.mcData) : () => true
  const stock = session.bot ? countItems(session.bot) : {}
  if (p.kind || p.plan) {
    const kind = p.plan ? 'plan' : String(p.kind).toLowerCase()
    const plan = makeParts(session, { ...p, kind }, stock)
    const L = bp.layout(plan.parts, { front: p.front || 'south', has })
    const need = {}
    for (const c of L.rel) if (c.kind !== 'air' && c.kind !== 'part' && c.kind !== 'seal') need[c.item] = (need[c.item] || 0) + 1
    return {
      mode: 'plan',
      kind,
      material: plan.material || undefined,
      size: { w: L.size.w, d: L.size.d, h: L.size.y2 },
      parts: plan.parts,
      materials: need,
      substitutions: plan.subs.length ? plan.subs : undefined,
      note: 'Это чертёж без места и без мира: seal (фундамент, заделка) считается в смете только там, где дыра. ' +
        'Правь части и отдавай обратно как plan — или mc_build mode=preview kind=… посчитает смету на месте.'
    }
  }
  return {
    mode: 'kinds',
    kinds: Object.fromEntries(Object.entries(bp.KINDS).map(([k, v]) => [k, { ru: v.ru, defaults: v.defaults, what: v.note }])),
    materials: { wood: bp.WOODS, stone: bp.STONES },
    parts: ['box', 'walls', 'floor', 'line', 'clear', 'seal', 'block', 'stairs', 'slab', 'door', 'window', 'torch', 'lantern', 'bed', 'chest', 'sign', 'ladder', 'crenel', 'roof'],
    last: jobOf(session) ? { kind: jobOf(session).kind, status: jobOf(session).status, at: jobOf(session).origin } : undefined
  }
}

function status (session) {
  const job = jobOf(session)
  if (!job) return { mode: 'status', job: null, note: 'начатой стройки в памяти нет' }
  const { parts, ...rest } = job
  const bot = session.bot
  let left = null
  if (bot && bot.entity && job.origin && parts) {
    try {
      const L = bp.layout(parts, { front: job.front || 'south', has: hasName(session.mcData) })
      const cells = place(L, job.origin)
      left = cells.filter(c => c.kind !== 'part' && bot.blockAt(c.pos) && !isDone(bot, c)).length
    } catch {}
  }
  return { mode: 'status', job: { ...rest, parts: parts ? parts.length : 0 }, left: left ?? undefined }
}

function forget (session) {
  const had = !!jobOf(session)
  session.journal.patch(s => { delete s[JOB] })
  return { mode: 'forget', forgot: had }
}

module.exports = {
  build,
  preview,
  kinds,
  status,
  forget,
  prepare,
  execute,
  putCell,
  placeOptions,
  writeSign,
  signText,
  onceSignEditor,
  digAt,
  isDone,
  pickSurfaceSite,
  pickHillside,
  canWalkOut,
  reachMap,
  resolvePalette,
  autoMaterial,
  walk,
  buildMovements,
  standSpots,
  REACH,
  YAW,
  JOB
}
