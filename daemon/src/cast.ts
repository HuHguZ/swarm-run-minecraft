'use strict'
const gameClock = require('./game-clock')
// Портал в Ад без алмазной кирки: литьё рамы вёдрами (спидран-приём).
//
// Механика — по исходникам 1.21.11 (extracted_minecraft_data, client1.21.11):
// * LiquidBlock.shouldSpreadLiquid: лава смотрит на соседей по
//   POSSIBLE_FLOW_DIRECTIONS = [DOWN, SOUTH, NORTH, EAST, WEST] через
//   pos.relative(direction.getOpposite()) — СВЕРХУ и с четырёх сторон, но не
//   снизу. Там вода — источник лавы становится obsidian, текущая лава —
//   cobblestone. Зовётся из onPlace (лаву поставили к воде) и из
//   neighborChanged (воду поставили к лаве) — порядок любой, застывает сразу.
// * Сама лава растекается только по своему тику: onPlace → scheduleTick(...,
//   fluid.getTickDelay), у лавы в верхнем мире 30 тиков. Полторы секунды на
//   воду — с запасом, дальше вода успевает раньше, чем лава течёт.
// * BucketItem.use: полное ведро бросает луч от глаз с ClipContext.Fluid.NONE
//   (жидкости луч проходит насквозь) и кладёт жидкость в клетку по грани, в
//   которую упёрся (getBlockPos().relative(getDirection())): воздух или
//   заменимое — ИСТОЧНИК; текущая вода заменима (LiquidBlock своего
//   canBeReplaced не имеет). Поэтому жидкость ставится «на грань опоры», как
//   блок, и целиться надо в грань, а не в клетку: луч в клетку с лавой пройдёт
//   её насквозь и заменит лаву водой на полу. Пустое ведро — SOURCE_ONLY:
//   берёт только источник.
// * Рама — PortalShape: углы не проверяются, 10 обсидиана (nether.js).
//
// Раскладка (origin — левая нижняя клетка проёма, как в nether.js; i вдоль
// рамы, j вверх; F(i,j) — ряд перед рамой, где стоит тело):
//   низ (0,-1),(1,-1) — с земли: лава на пол под клеткой, вода себе под ноги
//                       (клетка ног — соседка рамы спереди);
//   стойки j=0        — с земли: лава на нижний угол (булыжник), вода в проём
//                       на низ рамы (клетка проёма — соседка стойки);
//   стойки j=1,2      — со столба перед стойкой: лава на верх клетки ниже,
//                       вода себе под ноги (на вершину столба);
//   верх (0,3),(1,3)  — со столба до j=3: лава на верх временной подпорки в
//                       проёме (0,2)/(1,2), вода в верхний угол рамы
//                       (-1,3)/(2,3) — на верх стойки.
// Потом подпорки долой, проём чистый; поджиг — nether.portal: готовую раму он
// находит сам и зажигает.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, xyz } = require('./movement')
const { itemNamed, equipBestTool, missingHarvestTool } = require('./items')
const { placeBlockAt, towerUp, pickFiller, withTimeout } = require('./build')
const { visibleOf } = require('./sight')
const { faceAim, eyeOf, blockOnRay } = require('./pick')

const UP = new Vec3(0, 1, 0)
const AX = { x: new Vec3(1, 0, 0), z: new Vec3(0, 0, 1) }
const PLACE = 'литьё портала'
// Сколько держать от лавы рабочее место: вода, пока не вычерпана, течёт по
// блоку за 5 тиков (WaterFluid.getTickDelay) и за секунду дойдёт до четырёх;
// дотекла до озера — поверхность озера застынет, и черпать станет неоткуда.
const LAVA_KEEP = 5
// Дальше этого от места до лавы — каждый черпак это прогулка.
const LAVA_FAR = 18
const MAX_DIG = 48
const REACH = 4.3
const PROTECTED = /chest|barrel|shulker|furnace|smoker|anvil|_bed$|crafting_table|enchanting_table|brewing_stand|beacon|spawner|bedrock|_door$|ladder|rail|_sign$|end_portal|nether_portal/
const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$/
const FILLER_STEADY = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'basalt']

function countOf (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}
const isAir = b => !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')
const hasFluid = b => {
  if (!b) return false
  if (/^(water|lava|bubble_column)$/.test(b.name)) return true
  try { return b.getProperties().waterlogged === true } catch { return false }
}
const isSolid = b => !!b && b.boundingBox === 'block' && !hasFluid(b)
const isEmptyish = b => !!b && b.boundingBox === 'empty' && !/lava/.test(b.name)
const eyes = eyeOf
const centre = p => p.offset(0.5, 0.5, 0.5)

// Геометрия раскладки: at(i,j) — клетки рамы и проёма, F(i,j) — ряд перед ней.
function geom (origin, axis, side) {
  const u = AX[axis]
  const perp = axis === 'x' ? AX.z : AX.x
  const at = (i, j) => origin.offset(u.x * i, j, u.z * i)
  const F = (i, j) => at(i, j).offset(perp.x * side, 0, perp.z * side)
  return { origin, axis, side, u, perp, at, F }
}

function frameKeys (g) {
  const out = []
  for (const [i, j] of [[0, -1], [1, -1], [-1, 0], [-1, 1], [-1, 2], [2, 0], [2, 1], [2, 2], [0, 3], [1, 3]]) out.push(g.at(i, j))
  return out
}

// Refusal only: hidden fluids may reject a cut, never count as found resources.
function digRisk (read, p) {
  const b = read(p)
  if (!b) return 'чанк не прогружен'
  if (hasFluid(b)) return 'жидкость в клетке копания'
  if (PROTECTED.test(b.name) || b.name === 'obsidian') return `не копать ${b.name}`
  const up = read(p.plus(UP))
  if (!up || hasFluid(up) || FALLING.test(up.name)) return 'жидкость или сыпучее сверху'
  for (const v of SIDES4) {
    const n = read(p.plus(v))
    if (!n || hasFluid(n)) return 'жидкость сбоку или неизвестный сосед'
  }
  return null
}

// Трава, цветы, слой снега: коллизии нет, а контур есть (OUTLINE: трава 2..14 × 0..13/16, цветок 5..11 × 0..10/16,
// снег — высота слоя), и прицел клиента (GameRenderer.pick, ClipContext.Block.OUTLINE) в него упирается. pick.js
// (shapesOf) их не видит — для честного удара по сущностям так и надо, а копать их здесь нужно: в проёме рамы они
// не дают зажечь портал (PortalShape.isEmpty — только воздух и огонь), а digVisible бросал «блок не виден прицелом»
// (07 §9.5: «не выкопано 2: … short_grass/snow» на 4 из 6 сидов с подсказкой). Цель — середина контура; луч до неё не
// должен упереться в чужую коллизию раньше (blockOnRay).
const SOFT_PLANT = /^(short_grass|tall_grass|fern|large_fern|snow|dead_bush|bush|short_dry_grass|tall_dry_grass|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|.*_petals|leaf_litter|sweet_berry_bush|firefly_bush|sunflower|lilac|rose_bush|peony|.*_sapling|brown_mushroom|red_mushroom|seagrass|vine|glow_lichen)$/
function outlineAim (bot, b, { eye = null, range = REACH }: any = {}) {
  if (!b || !SOFT_PLANT.test(b.name)) return null
  let h = 13 / 16
  if (b.name === 'snow') { try { h = Number(b.getProperties().layers || 1) * 2 / 16 } catch { h = 2 / 16 } }
  const o = eye || eyeOf(bot)
  for (const [ax, ay, az] of [[0.5, Math.max(0.05, h / 2), 0.5], [0.5, Math.max(0.03, h * 0.85), 0.5], [0.3, Math.max(0.05, h / 2), 0.3], [0.7, Math.max(0.05, h / 2), 0.7]]) {
    const P = b.position.offset(ax, ay, az)
    const delta = P.minus(o)
    const len = delta.norm()
    if (len > range || len < 1e-4) continue
    const hit = blockOnRay(bot, o, delta.scaled(1 / len), len)
    if (hit && !hit.pos.equals(b.position)) continue
    return P
  }
  return null
}

async function digVisible (bot, b, ms) {
  let point = null
  if (b && b.boundingBox === 'empty') point = outlineAim(bot, b)
  for (const face of [...SIDES4, UP, new Vec3(0, -1, 0)]) {
    if (point) break
    point = faceAim(bot, b.position, face, { range: REACH })
  }
  if (!point) throw new Error('блок не виден прицелом')
  await bot.lookAt(point, true)
  await withTimeout(bot.dig(b, 'ignore'), ms, 'не копается')
}

// Пол под рамой и перед ней: твёрдый; песок и гравий — тоже, если держатся (под ними не пусто и не жидкость:
// FallingBlock падает только в «свободную» клетку). Пустыня и саванна — самые частые озёра, а «под низом рамы нет
// твёрдого пола» отказывал там со всех сторон (07 §9.5, сид 5647002953211837822).
function steadyFloor (read, p) {
  const b = read(p)
  if (!isSolid(b)) return false
  if (!FALLING.test(b.name)) return true
  const below = read(p.offset(0, -1, 0))
  return !!below && !hasFluid(below) && below.boundingBox === 'block'
}

// ---------------------------------------------------------------- план места

// Одна площадка целиком. Возвращает { plan } или { why }.
// maxDig — сколько клеток можно выкопать под место (поверху 48; глубоко в штреке место копается почти целиком —
// рама 18 + ряд перед ней 20, там больше); keep — ближе этого к лаве рабочее место не ставить (глубоко — дальше:
// вода по полу штрека дотекает до окна к лаве и стелет его обсидианом).
function judge (read, g, lava, me, { maxDig = MAX_DIG, keep = LAVA_KEEP, canDig = null }: any = {}) {
  const dig = []
  const corners = []
  const need = (p, why) => { const b = read(p); if (!b) return { why: 'чанк не прогружен' }; return { b, why } }
  // Проём, рама, углы: всё, что не угол, должно стать воздухом.
  for (let i = -1; i <= 2; i++) {
    for (let j = -1; j <= 3; j++) {
      const p = g.at(i, j)
      const b = read(p)
      if (!b) return { why: 'чанк не прогружен' }
      if (/water|lava/.test(b.name)) return { why: 'жидкость в раме' }
      if (PROTECTED.test(b.name) || b.name === 'obsidian') return { why: `в раме ${b.name}` }
      const bottomCorner = (i === -1 || i === 2) && j === -1
      if (bottomCorner) {
        // Нижний угол — опора стойки: годится свой твёрдый не-сыпучий камень.
        if (isSolid(b) && !FALLING.test(b.name)) continue
        if (!isEmptyish(b)) dig.push(p)
        corners.push(p)
        continue
      }
      // Только воздух: трава, цветы, снег ловят луч ведра (у сервера он по
      // OUTLINE), и лава легла бы клеткой выше.
      if (!isAir(b)) dig.push(p)
    }
  }
  // Пол под низом рамы и под нижними углами — твёрдый: на него льётся лава
  // низа и опирается булыжник углов.
  for (const i of [-1, 0, 1, 2]) {
    const b = read(g.at(i, -2))
    if (!b) return { why: 'чанк не прогружен' }
    if (!steadyFloor(read, g.at(i, -2))) return { why: 'под низом рамы нет твёрдого пола' }
  }
  // Ряд перед рамой: пол твёрдый, над ним до j=4 — воздух (столб до j=2,
  // тело на нём до j=3, голова j=4). j=5 — без жидкости, воздухом быть не обязан: прыжок со столба h=2 упирается
  // в него на высоте ног +1.2 (потолок y+6, рост 1.8), а блок под ноги встаёт уже с +1.0 (build.towerUp смотрит
  // только клетку над головой). Раньше j=5 копался тоже — глубоко до него не достать с пола (4.9 бл. от глаз), и
  // pathfinder строил к нему столбы булыжника прямо в ряду перед рамой: «столб не вырос (потолок cobblestone)».
  for (let i = -1; i <= 2; i++) {
    const fl = read(g.F(i, -2))
    if (!fl) return { why: 'чанк не прогружен' }
    if (!steadyFloor(read, g.F(i, -2))) return { why: 'перед рамой нет твёрдого пола' }
    for (let j = -1; j <= 5; j++) {
      const b = read(g.F(i, j))
      if (!b) return { why: 'чанк не прогружен' }
      if (/water|lava/.test(b.name)) return { why: 'жидкость перед рамой' }
      if (j === 5) { if (FALLING.test(b.name)) return { why: 'над рядом перед рамой гравий или песок' }; continue }
      if (PROTECTED.test(b.name)) return { why: `перед рамой ${b.name}` }
      if (!isAir(b)) dig.push(g.F(i, j))
    }
  }
  if (dig.length > maxDig) return { why: `копать ${dig.length} клеток` }
  for (const p of dig) {
    const risk = digRisk(read, p)
    if (risk) return { why: risk }
    // Руда не по нашей кирке (золото, редстоун, алмаз у дна — каменной не ломаются): место не годится (ow-L3 02.10,
    // слот 12: «расчистить место: для deepslate_gold_ore нужна кирка получше»).
    if (canDig) { const b = read(p); if (b && b.boundingBox === 'block' && !canDig(b)) return { why: `копать нечем: ${b.name}` } }
  }
  // Лава не ближе LAVA_KEEP к рабочему месту, но и не дальше LAVA_FAR.
  const work = []
  for (let i = -1; i <= 2; i++) for (let j = -1; j <= 4; j++) { work.push(g.at(i, j)); work.push(g.F(i, j)) }
  let nearest = Infinity
  for (const l of lava) {
    for (const w of work) {
      const d = Math.max(Math.abs(l.x - w.x), Math.abs(l.y - w.y), Math.abs(l.z - w.z))
      if (d < keep) return { why: `лава в ${d} бл. от места` }
    }
    nearest = Math.min(nearest, l.distanceTo(g.at(0, 0)))
  }
  if (nearest > LAVA_FAR) return { why: 'лава далеко' }
  // Сверху не должно сыпаться: гравий над проёмом упадёт в раму, над рядом
  // перед ней — на голову, когда столб дорастёт.
  for (let i = -1; i <= 2; i++) {
    const b = read(g.at(i, 4))
    if (b && FALLING.test(b.name)) return { why: 'над рамой гравий или песок' }
    const f = read(g.F(i, 6))
    if (f && FALLING.test(f.name)) return { why: 'над рядом перед рамой гравий или песок' }
  }
  return {
    plan: {
      axis: g.axis,
      side: g.side,
      origin: xyz(g.origin),
      dig: dig.sort((a, b) => b.y - a.y).map(xyz),
      corners: corners.map(xyz),
      lavaDist: Math.round(nearest),
      score: dig.length * 2 + corners.length + Math.round(nearest) + 3 * Math.round(g.origin.distanceTo(me))
    }
  }
}

function planCast (bot, lava, { radius = 7, maxDig = MAX_DIG, keep = LAVA_KEEP, groundY = null, mcData = null }: any = {}) {
  const canDig = mcData ? (b => !missingHarvestTool(bot, b, mcData)) : null
  const read = p => bot.blockAt(p)
  const me = bot.entity.position.floored()
  let best = null
  const why = new Map()
  for (let dy = 2; dy >= -3; dy--) {
    if (groundY !== null && me.y + dy - 1 !== groundY) continue
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (const axis of ['x', 'z']) {
          for (const side of [1, -1]) {
            const g = geom(me.offset(dx, dy, dz), axis, side)
            const r = judge(read, g, lava, me, { maxDig, keep, canDig })
            if (r.why) { why.set(r.why, (why.get(r.why) || 0) + 1); continue }
            if (!best || r.plan.score < best.score) best = r.plan
          }
        }
      }
    }
  }
  if (best) return { ok: true, plan: best }
  const ranked = [...why.entries()].sort((a, b) => b[1] - a[1])
  return { ok: false, reasons: ranked.slice(0, 3).map(([w, n]) => `${w} (${n})`) }
}

function clearanceKeys (g) {
  const out = []
  for (let i = -1; i <= 2; i++) {
    for (let j = -1; j <= 3; j++) {
      if (j === -1 && (i === -1 || i === 2)) continue
      out.push(g.at(i, j))
    }
    for (let j = -1; j <= 4; j++) out.push(g.F(i, j))
  }
  return out
}

function geomOf (plan) {
  return geom(new Vec3(plan.origin.x, plan.origin.y, plan.origin.z), plan.axis, plan.side)
}

// Keep the observed partial frame when changing the bucket layout.
function resumeOnePlan (session, { maxDig = MAX_DIG, windows = false }: any = {}) {
  const bot = session.bot
  if (bot.game?.dimension !== 'overworld') return null
  const rec = session.journal.state?.places?.[require('./cast1').PLACE1]
  const one = session.castPlan1 || (rec && (rec.dimension || 'overworld') === 'overworld'
    ? { origin: { x: rec.x, y: rec.y, z: rec.z }, axis: rec.axis, side: rec.side } : null)
  if (!one || !['x', 'z'].includes(one.axis) || ![-1, 1].includes(one.side) ||
      !['x', 'y', 'z'].every(k => Number.isInteger(one.origin?.[k]))) return null
  const g = geomOf(one), read = p => bot.blockAt(p)
  if (g.at(0, 0).distanceTo(bot.entity.position) > 24) return null
  const frame = new Set(frameKeys(g).map(p => p.toString()))
  if (!frameKeys(g).some(p => read(p)?.name === 'obsidian')) return null
  for (let i = -1; i <= 2; i++) {
    if (!steadyFloor(read, g.at(i, -2)) || !steadyFloor(read, g.F(i, -2))) return null
    for (const p of [g.at(i, 4), g.F(i, 6)]) {
      const b = read(p)
      if (!b || hasFluid(b) || FALLING.test(b.name)) return null
    }
  }
  const dig = []
  for (const p of clearanceKeys(g)) {
    const b = read(p)
    if (!b || hasFluid(b)) return null
    if (b.name === 'obsidian' && frame.has(p.toString())) continue
    if (isAir(b)) continue
    if (digRisk(read, p)) return null
    dig.push(xyz(p))
  }
  if (dig.length > maxDig) return null
  return { origin: xyz(g.origin), axis: g.axis, side: g.side, dig,
    corners: [xyz(g.at(-1, -1)), xyz(g.at(2, -1))], lavaAt: [], windows: !!windows }
}

function refillState (bot, plan) {
  const frame = frameKeys(geomOf(plan)).map(p => (bot.blockAt(p) || {}).name || '?')
  const visible = lavaSources(bot, 28).map(b => b.position.toString()).sort()
  const carried = countOf(bot, 'lava_bucket')
  return { frame: `${frame.filter(n => n === 'obsidian').length}/10 обсидиан`, empty: !visible.length && !carried,
    key: JSON.stringify([plan.origin, plan.axis, plan.side, bot.entity.position.floored().toString(), frame, visible, carried, countOf(bot, 'water_bucket')]) }
}

// ---------------------------------------------------------------- вёдра

// Видимые источники лавы. Через sight.visibleOf: ближние клетки могут быть за стеной.
function lavaSources (bot, radius = 24) {
  const id = bot.registry.blocksByName.lava.id
  const me = bot.entity.position
  // Только источник, открытый сверху (воздух над ним): луч зрения проходит сквозь лаву (у неё пустая коробка), и
  // «видимым» оказывался источник под потолком за первым — черпать его неоткуда (ow-M1 02.10: «видно 1» — источник
  // в 3 клетках за окном под камнем, «не дошёл»).
  return visibleOf(bot, [id], radius, { max: 80, rays: 1500 })
    .filter(b => b && levelOf(b) === 0 && isAir(bot.blockAt(b.position.plus(UP))))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

// Слух. Клиент игры сам, без пакетов сервера, раз в тик перебирает случайные клетки в 16 и 32 бл. вокруг игрока
// (ClientLevel.animateTick) и у лавы, над которой воздух, с вероятностью 1/100 пускает «бульк» (LAVA_POP) и 1/200 —
// гул (LAVA_AMBIENT), громкость 0.2–0.4 — слышно до 16 бл. (LavaFluid.animateTick, клиентский код 1.21; на сервере
// его нет — сверено по памяти о клиенте, не по jar сервера). Человек под землёй так и находит лаву: «слышу
// бульканье справа». Здесь — то же: лава с воздухом над ней в radius от головы; наружу отдаётся только
// направление (сторона света по главной оси, выше/ниже) и дальность, округлённая до 2 бл., — не клетка.
function hearLava (bot, { radius = 16 }: any = {}) {
  const head = bot.entity.position.offset(0, 1.62, 0)
  const c = head.floored()
  const r = Math.ceil(radius)
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue
      for (let dy = -r; dy <= r; dy++) {
        const p = c.offset(dx, dy, dz)
        const b = bot.blockAt(p)
        if (!b || b.name !== 'lava') continue
        const up = bot.blockAt(p.plus(UP))
        if (!isAir(up)) continue
        const d = p.offset(0.5, 0.5, 0.5).distanceTo(head)
        if (d > radius) continue
        if (!best || d < best.d) best = { p, d }
      }
    }
  }
  if (!best) return []
  const v = best.p.offset(0.5, 0.5, 0.5).minus(head)
  const dir = Math.abs(v.x) >= Math.abs(v.z) ? (v.x >= 0 ? 'east' : 'west') : (v.z >= 0 ? 'south' : 'north')
  // height — высота звука над глазами, округлённая до 2 (как дальность): оценка «выше/ниже» без sqrt двух округлённых
  // чисел (Codex ow-review1: ошибка той оценки до 7 бл.).
  return [{ dir, dist: Math.round(best.d / 2) * 2, flat: Math.round(Math.hypot(v.x, v.z) / 2) * 2, height: Math.round(v.y / 2) * 2, below: v.y < -1, above: v.y > 2 }]
}

// Слух воды. WaterFluid.animateTick (клиент 1.21): текущая вода, не падающая, раз в 64 тика шумит (WATER_AMBIENT,
// громкость 0.75–1.0 — до 16 бл.); источник и водопад молчат. Под землёй это ручьи от родников в стенах пещер — у них
// рядом источник. Наружу — сторона света, дальность до 2 бл., выше/ниже.
function hearWater (bot, { radius = 16 }: any = {}) {
  const head = bot.entity.position.offset(0, 1.62, 0)
  const c = head.floored()
  const r = Math.ceil(radius)
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue
      for (let dy = -r; dy <= r; dy++) {
        const p = c.offset(dx, dy, dz)
        const b = bot.blockAt(p)
        if (!b || b.name !== 'water') continue
        const lv = levelOf(b)
        if (!(lv > 0 && lv < 8)) continue // источник (0) и падающая (8+) — молчат
        const d = p.offset(0.5, 0.5, 0.5).distanceTo(head)
        if (d > radius) continue
        if (!best || d < best.d) best = { p, d }
      }
    }
  }
  if (!best) return []
  const v = best.p.offset(0.5, 0.5, 0.5).minus(head)
  const dir = Math.abs(v.x) >= Math.abs(v.z) ? (v.x >= 0 ? 'east' : 'west') : (v.z >= 0 ? 'south' : 'north')
  return [{ dir, dist: Math.round(best.d / 2) * 2, flat: Math.round(Math.hypot(v.x, v.z) / 2) * 2, below: v.y < -1, above: v.y > 2 }]
}

// Клетки, где можно стоять, в r от k (твёрдый сухой пол, ноги и голова — воздух), ближние к телу первыми.
function standNear (bot, k, r = 3) {
  const out = []
  const me = bot.entity.position
  const c = new Vec3(Math.floor(k.x), Math.floor(k.y), Math.floor(k.z))
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -1; dy <= 3; dy++) {
        const S = c.offset(dx, dy, dz)
        const floor = bot.blockAt(S.offset(0, -1, 0))
        if (!isAir(bot.blockAt(S)) || !isAir(bot.blockAt(S.plus(UP))) || !isSolid(floor) || FALLING.test(floor.name)) continue
        out.push(S)
      }
    }
  }
  return out.sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(me) - b.offset(0.5, 0, 0.5).distanceTo(me))
}

// Где встать, чтобы зачерпнуть источник src: клетка с твёрдым сухим полом, ноги и голова — воздух, не над окном, и
// с её глаз луч черпака доходит до src (scoopAim с этих глаз). Ближние к телу — первыми. Раньше шли к GoalNear(над
// источником, 2) — в пещере над озером это клетки над лавой, стоять негде: «не дошёл» (ow-M1, пещера).
function standSpots (bot, src, { r = 3 }: any = {}) {
  const out = []
  const me = bot.entity.position
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -1; dy <= 3; dy++) {
        const S = src.offset(dx, dy, dz)
        const feet = bot.blockAt(S)
        const head = bot.blockAt(S.plus(UP))
        const floor = bot.blockAt(S.offset(0, -1, 0))
        if (!isAir(feet) || !isAir(head) || !isSolid(floor) || FALLING.test(floor.name)) continue
        const eye = S.offset(0.5, 1.62, 0.5)
        if (!scoopAim(bot, src, eye)) continue
        out.push({ S, d: S.offset(0.5, 0, 0.5).distanceTo(me) })
      }
    }
  }
  return out.sort((a, b) => a.d - b.d)
}
function levelOf (b) {
  try { const p = b.getProperties(); if (p && p.level !== undefined) return Number(p.level) } catch {}
  return typeof b.metadata === 'number' ? b.metadata : null
}

async function hold (bot, name) {
  const it = itemNamed(bot, name)
  if (!it) return false
  if (bot.heldItem && bot.heldItem.name === name) return true
  try { await bot.equip(it, 'hand'); return true } catch { return false }
}

// prismarine-world BlockFace: 0 низ, 1 верх, 2 север, 3 юг, 4 запад, 5 восток.
const FACE_VEC = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]

// Куда ляжет жидкость из полного ведра, если смотреть в point: тот же луч,
// что у сервера (от глаз, жидкости насквозь — Fluid.NONE), первый непустой
// блок и грань входа; жидкость — в клетку за этой гранью. Воздух насквозь;
// трава и цветы — препятствие (у сервера луч по OUTLINE, травинка его ловит),
// поэтому место под раму от них расчищено, а здесь они считаются стеной.
function landing (bot, point, range = 4.5) {
  const eye = eyes(bot)
  const dir = point.minus(eye).normalize()
  const hit = bot.world.raycast(eye, dir, range, (b, iter) => {
    if (!b || isAir(b) || /water|lava|bubble_column/.test(b.name)) return false
    const shapes = b.shapes && b.shapes.length ? b.shapes : [[0, 0, 0, 1, 1, 1]]
    const r = iter.intersect(shapes, b.position)
    if (r) { b.face = r.face; return true }
    return false
  })
  if (!hit || hit.face === undefined || hit.face < 0) return null
  return { cell: hit.position.plus(FACE_VEC[hit.face]), hit: hit.position, face: hit.face }
}

// Точка на грани face блока ref, взгляд в которую кладёт жидкость ровно в
// expect: центр грани и восемь точек вокруг (±0.3). Нет такой — null: лить
// нельзя, жидкость легла бы не туда.
function aimFor (bot, ref, face, expect) {
  const c = ref.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
  const axes = face.y !== 0 ? [new Vec3(1, 0, 0), new Vec3(0, 0, 1)] : face.x !== 0 ? [new Vec3(0, 1, 0), new Vec3(0, 0, 1)] : [new Vec3(1, 0, 0), new Vec3(0, 1, 0)]
  const offs = [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]
  for (const [a, b] of offs) {
    const p = c.plus(axes[0].scaled(a)).plus(axes[1].scaled(b))
    if (eyes(bot).distanceTo(p) > 4.4) continue
    const l = landing(bot, p)
    if (l && l.cell.equals(expect)) return p
  }
  return null
}

// Вылить из ведра на грань face блока ref: жидкость ляжет в ref+face. Прицел
// проверен лучом заранее — не туда не льём вовсе.
async function pour (bot, full, ref, face = UP) {
  if (!(await hold(bot, full))) return { ok: false, why: `нет ${full}` }
  const expect = ref.plus(face)
  const aim = aimFor(bot, ref, face, expect)
  if (!aim) {
    const c = ref.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
    const l = landing(bot, c)
    const d = Math.round(eyes(bot).distanceTo(c) * 10) / 10
    return { ok: false, why: d > 4.4 ? `до грани ${d} бл. — не достать` : `луч к грани ${ref.x},${ref.y},${ref.z} упирается в ${l ? `${l.hit.x},${l.hit.y},${l.hit.z}` : 'пустоту'}` }
  }
  try { await bot.lookAt(aim, true) } catch {}
  await sleep(60)
  const before = countOf(bot, full)
  try { bot.activateItem() } catch {}
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 1200) {
    if (countOf(bot, full) < before) return { ok: true }
    await sleep(40)
  }
  return { ok: false, why: 'ведро не опустело — луч упёрся не туда' }
}

// Зачерпнуть источник в клетке cell пустым ведром.
// Куда смотреть, чтобы пустое ведро (луч SOURCE_ONLY: сквозь текущую жидкость и воздух, до первого твёрдого контура)
// взяло источник в cell: верх клетки, середина, бока на половине высоты, углы верха — первая точка, до которой луч от
// глаз не упирается в твёрдое. Под землёй верх соседней клетки — порода над ней: ow-L1 02.10, слот 10 — вода в углу
// рамы на уровне ног, луч к верху клетки входил в неё через камень над ней, «свою воду не забрал».
function scoopAim (bot, cell, eye = null) {
  const o = eye || eyes(bot)
  const pts = [[0.5, 0.8, 0.5], [0.5, 0.5, 0.5]]
  for (const v of SIDES4) pts.push([0.5 + v.x * 0.45, 0.45, 0.5 + v.z * 0.45])
  for (const [a, c] of [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) pts.push([a, 0.8, c])
  for (const [dx, dy, dz] of pts) {
    const P = cell.offset(dx, dy, dz)
    const delta = P.minus(o)
    const len = delta.norm()
    if (len > 4.4 || len < 1e-3) continue
    const hit = blockOnRay(bot, o, delta.scaled(1 / len), len)
    if (!(!hit || hit.t >= len - 0.02 || hit.pos.equals(cell))) continue
    // Чужой источник на пути: луч пустого ведра (SOURCE_ONLY) встанет на нём (pick.blockOnRay жидкость пропускает: у неё
    // пустая коробка).
    if (fluidOnRay(bot, o, P, cell)) continue
    return P
  }
  return null
}

// Есть ли на отрезке o→P (до клетки target) источник жидкости, кроме самой target. Шаг 0.05 блока.
function fluidOnRay (bot, o, P, target) {
  const d = P.minus(o)
  const len = d.norm()
  const n = Math.ceil(len / 0.05)
  let last = null
  for (let i = 1; i < n; i++) {
    const q = o.plus(d.scaled(i / n)).floored()
    if (last && q.equals(last)) continue
    last = q
    if (q.equals(target)) return false
    const b = bot.blockAt(q)
    // Источник жидкости — стоп (луч пустого ведра SOURCE_ONLY встал бы на нём); текущую луч проходит насквозь.
    if (b && /^(lava|water)$/.test(b.name) && levelOf(b) === 0) return true
  }
  return false
}

// Источники, которые можно зачерпнуть отсюда: видимые (lavaSources) и — рядом с известной лавой (вычерпанные клетки,
// окна) — те, до которых есть луч черпака (scoopAim, несколько точек клетки). Центр клетки у окна часто закрыт
// краем пола штрека, а угол верха виден (ow-M3, отладка 02.10: окно открыто, «видно 0», scoopAim — есть).
function scoopableSources (bot, known: any = []) {
  const out = new Map()
  const consider = p => {
    const key = `${p.x},${p.y},${p.z}`
    if (out.has(key)) return
    const b = bot.blockAt(p)
    if (!b || b.name !== 'lava' || levelOf(b) !== 0 || !isAir(bot.blockAt(p.plus(UP)))) return
    if (!scoopAim(bot, p)) return
    out.set(key, b)
  }
  for (const b of lavaSources(bot, 28)) consider(b.position)
  for (const k of known) {
    const c = new Vec3(Math.floor(k.x), Math.floor(k.y), Math.floor(k.z))
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [-1, 0]) consider(c.offset(dx, dy, dz))
  }
  const me = bot.entity.position
  return [...out.values()].sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

async function scoop (bot, cell, fluid = 'water') {
  const b = bot.blockAt(cell)
  if (!b || b.name !== fluid || levelOf(b) !== 0) return false
  if (!(await hold(bot, 'bucket'))) return false
  const aim = scoopAim(bot, cell) || cell.offset(0.5, 0.8, 0.5)
  try { await bot.lookAt(aim, true) } catch {}
  await sleep(60)
  const before = countOf(bot, `${fluid}_bucket`)
  try { bot.activateItem() } catch {}
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 1200) {
    if (countOf(bot, `${fluid}_bucket`) > before) return true
    await sleep(40)
  }
  return false
}

let lastWalkError = null
async function walk (bot, ctl, goal, ms = 20000, { clearance = false }: any = {}) {
  const mv = bot.pathfinder.movements
  const saved = mv && { canDig: mv.canDig, towers: mv.allow1by1towers, scaffold: mv.scafoldingBlocks, breaks: mv.exclusionAreasBreak, steps: mv.exclusionAreasStep }
  if (mv) {
    mv.canDig = clearance && saved.canDig
    mv.allow1by1towers = false
    mv.scafoldingBlocks = []
    mv.exclusionAreasBreak = [...(saved.breaks || []), b =>
      b.position.y < feetCell(bot).y || digRisk(p => bot.blockAt(p), b.position) ? 100 : 0]
    mv.exclusionAreasStep = [...(saved.steps || []), b =>
      bot._ndCastHoles && bot._ndCastHoles.has(`${b.position.x},${b.position.y},${b.position.z}`) ? 100 : 0]
  }
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, 'не дошёл')
    lastWalkError = null
    return true
  } catch (e) {
    lastWalkError = String((e && e.message) || e).slice(0, 80)
    try { bot.pathfinder.setGoal(null) } catch {}
    return false
  } finally {
    if (mv && saved) {
      mv.canDig = saved.canDig
      mv.allow1by1towers = saved.towers
      mv.scafoldingBlocks = saved.scaffold
      mv.exclusionAreasBreak = saved.breaks
      mv.exclusionAreasStep = saved.steps
    }
  }
}

// Встать ровно в центр клетки: край тела у самой рамы коснётся лавы.
async function centreOn (bot, ctl, cell) {
  const c = cell.offset(0.5, 0, 0.5)
  const flat = () => Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z)
  if (flat() < 0.18) return true
  try {
    await bot.lookAt(c.offset(0, bot.entity.height || 1.62, 0), true)
    bot.setControlState('sneak', true)
    bot.setControlState('forward', true)
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && !ctl.aborted && flat() > 0.15) await sleep(30)
  } catch {} finally {
    try { bot.setControlState('forward', false) } catch {}
    try { bot.setControlState('sneak', false) } catch {}
  }
  await sleep(120)
  return flat() < 0.3
}

// ---------------------------------------------------------------- окно к лаве

// Штрек и лесенка встают у лавы, которой не видно («лава на X (в 1 впереди)» — чутьё безопасности
// mining.danger: лава за блоком). Человек на этом месте сломал бы блок и увидел её. Здесь так же, но безопасно:
// ломается только блок НАД источником (лава вверх не течёт — LiquidBlock: растекание вниз и по сторонам), и только
// если у этого блока по бокам и сверху нет жидкости (иначе она польётся в окно и к телу), сверху не сыпучее
// (гравий упал бы в лаву на место источника), блок виден глазами и в досягаемости. Пол под собой не ломается.
// Чутьё здесь только выбирает, какой из ВИДИМЫХ блоков сломать; лава засчитывается, когда её видно (lavaSources).
const SIDES4 = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
function windowCandidates (bot, hint, { span = 3, reach = REACH, fluid = 'lava' }: any = {}) {
  const h = new Vec3(Math.floor(hint.x), Math.floor(hint.y), Math.floor(hint.z))
  const feet = feetCell(bot)
  const out = []
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -2; dy <= 1; dy++) {
      for (let dz = -span; dz <= span; dz++) {
        const s = h.offset(dx, dy, dz)
        const lb = bot.blockAt(s)
        if (!lb || lb.name !== fluid || levelOf(lb) !== 0) continue
        const w = s.plus(UP)
        const wb = bot.blockAt(w)
        if (!wb || !isSolid(wb) || PROTECTED.test(wb.name) || wb.name === 'obsidian' || wb.name === 'bedrock') continue
        // Свой пол и клетки тела не трогать.
        if (w.x === feet.x && w.z === feet.z && w.y >= feet.y - 1 && w.y <= feet.y + 1) continue
        const up = bot.blockAt(w.plus(UP))
        if (!up || hasFluid(up) || FALLING.test(up.name)) continue
        if (SIDES4.some(v => { const n = bot.blockAt(w.plus(v)); return !n || hasFluid(n) })) continue
        const d = eyes(bot).distanceTo(centre(w))
        if (d > reach + 0.5) continue
        // Видна ли хоть одна грань блока, открытая в пустоту (pick.faceAim: луч из глаз до точки грани, как прицел
        // клиента): в центр соседнего снизу-впереди блока луч упирается в клетку над ним, а грань со стороны штрека
        // видна.
        let aim = null
        let face = null
        for (const v of [...SIDES4, UP, new Vec3(0, -1, 0)]) {
          const nb = bot.blockAt(w.plus(v))
          if (!nb || nb.boundingBox !== 'empty' || /lava|water/.test(nb.name)) continue
          try { aim = faceAim(bot, w, v, { range: reach }) } catch {}
          if (aim) { face = v; break }
        }
        if (!aim) continue
        out.push({ w, s, d, aim, face })
      }
    }
  }
  return out.sort((a, b) => a.d - b.d)
}

async function openWindow (session, ctl, hint, report, { max = 1, fluid = 'lava' }: any = {}) {
  const bot = session.bot
  if (!hint) return 0
  let opened = 0
  for (let k = 0; k < max && !ctl.aborted; k++) {
    const c = windowCandidates(bot, hint, { fluid })[0]
    if (!c) break
    const b = bot.blockAt(c.w)
    const problem = missingHarvestTool(bot, b, session.mcData)
    if (problem) break
    try {
      await equipBestTool(bot, b)
      // Keep the sampled visible point: dig(true, face) would aim at its centre.
      await bot.lookAt(c.aim, true)
      await withTimeout(bot.dig(b, 'ignore'), 8000, 'не копается')
      if (isSolid(bot.blockAt(c.w))) break
      if (!bot._ndCastHoles) bot._ndCastHoles = new Set()
      for (const p of [c.w, c.s]) bot._ndCastHoles.add(`${p.x},${p.y},${p.z}`)
      report.dug++
      report.windows = (report.windows || 0) + 1
      report.lastWindow = c.s
      opened++
    } catch { break }
    await sleep(250)
  }
  return opened
}

// Шаг над озером: источники в досягаемости от края вычерпаны, дальше — под потолком. Клетку под окном (вычерпанная —
// там текущая лава или пусто) — заложить блоком; окно над ней становится полом, на него — шаг, и окна открываются
// дальше (ow-M3, отладка 02.10: 9/10 отлито, десятому источнику не хватило досягаемости от края штрека).
async function advanceOver (session, ctl, report) {
  const bot = session.bot
  const holes = [...(bot._ndCastHoles || [])].map(k => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z) })
  const me = feetCell(bot)
  // Окна (воздух), под которыми не источник, рядом с клеткой, где можно стоять; ближние к телу первыми.
  const cands = holes.filter(w => {
    const head = bot.blockAt(w.plus(UP))
    if (!isAir(bot.blockAt(w)) || !(isAir(head) || (isSolid(head) && !PROTECTED.test(head.name) && !digRisk(q => bot.blockAt(q), w.plus(UP))))) return false
    const below = bot.blockAt(w.offset(0, -1, 0))
    if (!below || (below.name === 'lava' && levelOf(below) === 0) || isSolid(below)) return false
    return SIDES4.some(v => { const n = w.plus(v); const f = bot.blockAt(n.offset(0, -1, 0)); return isAir(bot.blockAt(n)) && isAir(bot.blockAt(n.plus(UP))) && isSolid(f) })
  }).sort((a, b) => {
    // Коридором над озером: окно прямо по ходу от клетки тела (продолжение штрека к лаве) — первым; потом ближнее.
    const dir = session.castPlan && session.castPlan.lavaAt && session.castPlan.lavaAt.length ? (() => {
      const l = session.castPlan.lavaAt[session.castPlan.lavaAt.length - 1]
      const dx = l.x - me.x; const dz = l.z - me.z
      return Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
    })() : null
    const ahead = w => dir && (w.x - me.x) * dir.x + (w.z - me.z) * dir.z > 0 && ((dir.x && w.z === me.z) || (dir.z && w.x === me.x)) ? 0 : 1
    return ahead(a) - ahead(b) || a.distanceTo(me) - b.distanceTo(me)
  })
  const note = m => { report.trace = report.trace || []; report.trace.push(m); if (report.trace.length > 40) report.trace.shift() }
  if (!cands.length) note(`шаг: окон-кандидатов нет (дыр ${holes.length})`)
  for (const w of cands.slice(0, 3)) {
    const floor = w.offset(0, -1, 0)
    const sp = standNear(bot, w, 1).filter(S => !S.equals(w))
    let near = false
    for (const S of sp.slice(0, 2)) { if (await walk(bot, ctl, new goals.GoalBlock(S.x, S.y, S.z), 15000)) { near = true; break } }
    if (!near) { note(`шаг: к ${w.x},${w.y},${w.z} не подошёл (${lastWalkError || 'нет клетки'})`); continue }
    const r = await placeBlockAt(bot, floor, { steady: true })
    if (!r.ok || !isSolid(bot.blockAt(floor))) { note(`шаг: закладка ${floor.x},${floor.y},${floor.z} — ${r.reason || (bot.blockAt(floor) || {}).name}`); continue }
    report.placed++
    // Окно в одну клетку высотой (над ним порода) — голове нужен воздух: копать (видимая грань, без жидкости рядом).
    const hb = bot.blockAt(w.plus(UP))
    if (isSolid(hb)) { try { await equipBestTool(bot, hb); await digVisible(bot, hb, 8000); report.dug++ } catch (e) { note(`шаг: над окном не копается (${e.message})`); continue } }
    bot._ndCastHoles.delete(`${w.x},${w.y},${w.z}`)
    bot._ndCastHoles.delete(`${floor.x},${floor.y},${floor.z}`)
    if (await walk(bot, ctl, new goals.GoalBlock(w.x, w.y, w.z), 10000)) { report.advanced = (report.advanced || 0) + 1; return w }
  }
  return null
}

// Наполнить лавой пустые вёдра (кроме одного, если воды в руках нет — он под
// воду). Тело должно стоять на земле.
async function refillLava (session, ctl, report) {
  const bot = session.bot
  if (!bot._ndCastHoles) bot._ndCastHoles = new Set()
  for (const p of ((session.castPlan && session.castPlan.lavaAt) || [])) {
    // Заложенное (шаг над озером) — уже пол, не дыра: иначе путь назад к окнам «No path to the goal» (ow-M4 02.10).
    if (isSolid(bot.blockAt(new Vec3(p.x, p.y, p.z)))) continue
    for (const dy of [0, 1]) bot._ndCastHoles.add(`${p.x},${p.y + dy},${p.z}`)
  }
  let want = countOf(bot, 'bucket') - (countOf(bot, 'water_bucket') ? 0 : 1)
  if (want <= 0) return countOf(bot, 'lava_bucket') > 0
  const tr = m => { report.trace = report.trace || []; report.trace.push(m); if (report.trace.length > 40) report.trace.shift() }
  let refreshed = false
  for (let tries = 0; want > 0 && tries < 7 && !ctl.aborted; tries++) {
    let src = scoopableSources(bot, ((session.castPlan && session.castPlan.lavaAt) || []).slice(0, 6))
    tr(`видно ${src.length}`)
    // Со стойки у рамы лаву заслоняет край ямы (2026-09-26, первый живой
    // прогон у спавна: место выбрано с -19,64,-25, а со стойки -21,64,-25
    // лавы не видно — «лава кончилась» за 0 с, двенадцать раз подряд). Идти к
    // лаве, которую видели при выборе места, и смотреть оттуда.
    if (!src.length) {
      const known = ((session.castPlan && session.castPlan.lavaAt) || []).map(p => new Vec3(p.x, p.y, p.z))
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      for (const k of known.slice(0, 3)) {
        if (ctl.aborted) break
        // Подойти к месту вычерпанной лавы — на клетку, где можно стоять (не над окном и не над озером).
        // Сперва клетки, откуда эта лава видна черпаку (у края окна), — иначе ближняя к телу клетка в 3 бл. от окна
        // смотрит на лаву под острым углом сквозь пол штрека: «дошёл, видно 0» и окна множатся (ow-M2, все «under»).
        let wk = false
        const sp0 = standSpots(bot, k).map(x => x.S)
        for (const sp of (sp0.length ? sp0 : standNear(bot, k)).slice(0, 3)) { if (await walk(bot, ctl, new goals.GoalBlock(sp.x, sp.y, sp.z), 15000)) { wk = true; break } }
        src = scoopableSources(bot, [k, ...known.slice(0, 6)])
        tr(`к ${k.x},${k.y},${k.z}: ${wk ? 'дошёл' : `НЕ дошёл (${lastWalkError || '?'})`}, видно ${src.length}`)
        // Глубоко: озеро под потолком — видимые через окно источники вычерпаны, рядом под тем же потолком есть
        // ещё. Новое окно над соседним источником (той же проверкой безопасности).
        if (!src.length && session.castPlan && session.castPlan.windows && await openWindow(session, ctl, k, report)) {
          src = scoopableSources(bot, [k, ...known.slice(0, 6)])
          // Новое окно не видно с этой клетки — встать туда, откуда черпак достаёт его лаву.
          const lw = report.lastWindow
          if (!src.length && lw) {
            for (const sp of standSpots(bot, lw).slice(0, 2)) { if (await walk(bot, ctl, new goals.GoalBlock(sp.S.x, sp.S.y, sp.S.z), 15000)) break }
            src = scoopableSources(bot, [lw, k, ...known.slice(0, 6)])
          }
          tr(`окно у ${k.x},${k.y},${k.z}: видно ${src.length}`)
        }
        if (src.length) break
      }
      // У края всё вычерпано — шаг над озером по заложенному окну и окна дальше.
      if (!src.length && session.castPlan && session.castPlan.windows) {
        const w = await advanceOver(session, ctl, report)
        if (w) {
          src = scoopableSources(bot, [w.offset(0, -1, 0), ...known.slice(0, 6)])
          if (!src.length && await openWindow(session, ctl, w.offset(0, -1, 0), report)) src = scoopableSources(bot, [w.offset(0, -1, 0), report.lastWindow || w, ...known.slice(0, 6)])
          tr(`шаг над озером на ${w.x},${w.y},${w.z}: видно ${src.length}`)
        } else tr('шаг над озером не вышел')
      }
    }
    // Всё видимое у плана вычерпано, а озеро живое: план знал только 12 источников, увиденных при выборе места
    // (07 §9.5: «лава кончилась» при 50+ открытых источниках того же тела). Обойти тело лавы от известных клеток по
    // связности и взять ближние к раме открытые источники, у которых есть где встать.
    if (!src.length && !refreshed && session.castPlan) {
      refreshed = true
      const seeds = ((session.castPlan.lavaAt) || []).map(p => new Vec3(p.x, p.y, p.z))
      const live = liveLava(bot, seeds, geomOf(session.castPlan).at(0, 0))
      tr(`живая лава тела: ${live.length}`)
      if (live.length) {
        session.castPlan.lavaAt = live.map(p => xyz(p))
        try { session.journal.patch(st => { const pl = st.places && st.places[PLACE]; if (pl) pl.lavaAt = session.castPlan.lavaAt }) } catch {}
        continue
      }
    }
    if (!src.length) break
    let got = false
    for (const s of src.slice(0, 5)) {
      const p = s.position
      if (!scoopAim(bot, p)) {
        const spots = standSpots(bot, p)
        if (!spots.length) { tr(`${p.x},${p.y},${p.z}: встать негде`); continue }
        let reached = false
        for (const sp of spots.slice(0, 3)) {
          if (await walk(bot, ctl, new goals.GoalBlock(sp.S.x, sp.S.y, sp.S.z), 15000)) { reached = true; break }
        }
        if (!reached) { tr(`${p.x},${p.y},${p.z}: не дошёл (${lastWalkError || '?'})`); continue }
      }
      const sc = await scoop(bot, p, 'lava')
      tr(`${p.x},${p.y},${p.z}: черпак ${sc ? 'да' : 'нет'}${sc ? '' : ` (прицел ${scoopAim(bot, p) ? 'есть' : 'нет'}, ${(bot.blockAt(p) || {}).name})`}`)
      if (sc) {
        got = true; report.refills++; want--
        // Вычерпанная клетка — ориентир следующего окна: соседние источники того же озера рядом с ней.
        if (session.castPlan && Array.isArray(session.castPlan.lavaAt)) session.castPlan.lavaAt.unshift(xyz(p))
        break
      }
    }
    if (!got) break
  }
  return countOf(bot, 'lava_bucket') > 0
}

// Открытые источники того же тела лавы (6-связность от известных клеток ±2), ближние к ref, у которых есть где встать
// с черпаком (standSpots). Только чтение мира — что видно, решает scoopableSources у самого черпака.
function liveLava (bot, seeds, ref, { limit = 12, cap = 1500 }: any = {}) {
  const key = p => `${p.x},${p.y},${p.z}`
  const seen = new Set()
  const q = []
  for (const s of seeds) {
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) {
      const p = s.offset(dx, dy, dz)
      const b = bot.blockAt(p)
      if (b && b.name === 'lava' && !seen.has(key(p))) { seen.add(key(p)); q.push(p) }
    }
  }
  const open = []
  const DOWN = new Vec3(0, -1, 0)
  for (let i = 0; i < q.length && seen.size < cap; i++) {
    const p = q[i]
    const b = bot.blockAt(p)
    if (b && levelOf(b) === 0 && isAir(bot.blockAt(p.plus(UP))) &&
        (process.env.ND_OW_KIT_FRAME === '0' || require('./sight').seesBlock(bot, b))) open.push(p)
    for (const v of [...SIDES4, UP, DOWN]) {
      const n = p.plus(v)
      if (seen.has(key(n))) continue
      const nb = bot.blockAt(n)
      if (nb && nb.name === 'lava') { seen.add(key(n)); q.push(n) }
    }
  }
  open.sort((a, b) => a.distanceTo(ref) - b.distanceTo(ref))
  const out = []
  for (const p of open.slice(0, 48)) {
    if (standSpots(bot, p).length) out.push(p)
    if (out.length >= limit) break
  }
  return out
}

async function ensureWater (session, ctl) {
  const bot = session.bot
  if (countOf(bot, 'water_bucket')) return true
  if (!countOf(bot, 'bucket')) return false
  const r = await require('./obsidian').fillBucket(session, ctl, { fluid: 'water', radius: 32 })
  return !!(r && (r.filled || r.already))
}

// ---------------------------------------------------------------- тело и столбы

function feetCell (bot) { return bot.entity.position.floored() }

// Слезть со своего столба: копать блок под ногами, пока ноги не на земле.
async function descend (bot, ctl, groundY, report) {
  for (let k = 0; k < 8 && !ctl.aborted; k++) {
    const feet = feetCell(bot)
    if (feet.y <= groundY) return true
    const under = bot.blockAt(feet.offset(0, -1, 0))
    if (!under || under.boundingBox !== 'block') { await sleep(300); continue }
    try {
      await equipBestTool(bot, under)
      await digVisible(bot, under, 6000)
      report.dug++
    } catch { return false }
    await sleep(450)
  }
  return feetCell(bot).y <= groundY
}

// Ноги и голова не в воде (остатки вычерпанной), до 3 с.
async function dryFeet (bot, ctl, ms = 3000) {
  const wet = () => {
    const f = feetCell(bot)
    return [f, f.offset(0, 1, 0)].some(p => { const b = bot.blockAt(p); return !!b && /water|bubble_column/.test(b.name) }) || !!bot.entity.isInWater
  }
  const t0 = gameClock.now()
  while (wet() && gameClock.now() - t0 < ms && !ctl.aborted) await sleep(100)
  return !wet()
}

// Встать: h = -1 — на землю в клетку F(col,-1); h >= 0 — на столб в колонке
// col, ноги в F(col,h).
async function stand (session, ctl, g, col, h, report) {
  const bot = session.bot
  const groundY = g.F(0, -1).y
  const base = g.F(col, -1)
  let feet = feetCell(bot)
  const onColumn = feet.x === base.x && feet.z === base.z
  // Копать вниз — только со СВОЕГО столба (ряд перед рамой): стоя на холме
  // рядом, тело прокопало бы себе яму.
  const onOwnPillar = [-1, 0, 1, 2].some(i => { const c = g.F(i, -1); return feet.x === c.x && feet.z === c.z }) && feet.y > groundY
  if (!onColumn && onOwnPillar) {
    if (!(await descend(bot, ctl, groundY, report))) return { ok: false, why: 'не слез со столба' }
    feet = feetCell(bot)
  }
  if (onColumn && feet.y > g.F(col, h).y) {
    // Столб выше, чем надо: копать вниз до нужной высоты.
    if (!(await descend(bot, ctl, g.F(col, h).y, report))) return { ok: false, why: 'не спустился по столбу' }
    feet = feetCell(bot)
  }
  if (!(feet.x === base.x && feet.z === base.z)) {
    const ok = (await walk(bot, ctl, new goals.GoalBlock(base.x, base.y, base.z), 20000)) ||
      (await walk(bot, ctl, new goals.GoalBlock(base.x, base.y, base.z), 20000, { clearance: true }))
    feet = feetCell(bot)
    if (!ok || !feet.equals(base)) return { ok: false, why: `не встал на ${base.x},${base.y},${base.z}` }
  }
  if (!(await centreOn(bot, ctl, feetCell(bot)))) return { ok: false, why: 'не центрировался перед литьём' }
  const need = g.F(col, h).y - feetCell(bot).y
  if (need > 0) {
    // По ступени: над головой должно быть пусто (towerUp иначе «потолок»), а клетку над головой с пола не всегда
    // достать — копается здесь, со столба, перед каждым прыжком.
    const whyAll = []
    for (let k = 0; k < need && !ctl.aborted; k++) {
      // В текущей воде прыжок — всплытие на 0.1–0.4 блока, столб не растёт (ow-L2 02.10, слот 8: 7/10 отлито,
      // «не подпрыгнул (+0.18)»): вычерпанная вода стекает остатками ещё до 35 тиков (Codex, WaterFluid). Ждать сухости.
      await dryFeet(bot, ctl)
      const head = bot.blockAt(feetCell(bot).offset(0, 2, 0))
      if (head && head.boundingBox === 'block' && !/lava|water/.test(head.name) && !PROTECTED.test(head.name)) {
        const risk = digRisk(p => bot.blockAt(p), head.position)
        if (risk) return { ok: false, why: `потолок: ${risk}` }
        try { await equipBestTool(bot, head); await digVisible(bot, head, 8000); report.dug++ } catch {}
      }
      let t = await towerUp(bot, ctl, 1, { sneak: true })
      if (!t.placed && !ctl.aborted) { if (t.why) whyAll.push(...t.why); t = await towerUp(bot, ctl, 1, { sneak: true }) }
      report.placed += t.placed || 0
      if (t.why && t.why.length) whyAll.push(...t.why)
      if (!t.placed) break
    }
    if (feetCell(bot).y !== g.F(col, h).y) return { ok: false, why: `столб не вырос (${whyAll.join('; ') || '?'})` }
    if (!(await centreOn(bot, ctl, feetCell(bot)))) return { ok: false, why: 'не центрировался на столбе' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------- одна клетка

// Отлить клетку cell: лава на грань lavaRef, вода на грань waterRef (вверх),
// стоя в (col, h). Возвращает { ok } или { why }.
async function castCell (session, ctl, g, t, report) {
  const bot = session.bot
  const cell = t.cell
  let b = bot.blockAt(cell)
  if (b && b.name === 'obsidian') return { ok: true, already: true }
  // Застыло камнем (текла лава) или мусор — выкопать и лить заново.
  if (b && !isEmptyish(b) && !/lava/.test(b.name)) {
    try { await equipBestTool(bot, b); await digVisible(bot, b, 6000); report.dug++ } catch {}
    b = bot.blockAt(cell)
  }
  const lavaHere = b && b.name === 'lava' && levelOf(b) === 0
  if (!lavaHere && !countOf(bot, 'lava_bucket')) {
    const s0 = await stand(session, ctl, g, t.col, -1, report)
    if (!s0.ok) return { ok: false, why: s0.why }
    if (!(await refillLava(session, ctl, report))) return { ok: false, fatal: process.env.ND_OW_KIT_FRAME !== '0', why: 'лава кончилась: зачерпнуть не вышло' }
  }
  if (!(await ensureWater(session, ctl))) return { ok: false, why: 'нет воды в ведре' }
  const s = await stand(session, ctl, g, t.col, t.h, report)
  if (!s.ok) return { ok: false, why: s.why }
  // Опора под лаву пропала (pathfinder копает по пути; угол и подпорка —
  // булыжник) — поставить заново, а не мазать лучом мимо.
  if (!lavaHere && !isSolid(bot.blockAt(t.lavaRef))) {
    const r = await placeBlockAt(bot, t.lavaRef, { steady: true })
    if (r.ok) report.placed++
    else return { ok: false, why: `опоры под лаву нет на ${t.lavaRef.x},${t.lavaRef.y},${t.lavaRef.z}: ${r.reason}` }
  }
  if (!lavaHere) {
    const l = await pour(bot, 'lava_bucket', t.lavaRef)
    if (!l.ok) return { ok: false, why: `лава: ${l.why}` }
  }
  // Вода рядом уже была (текущая с прошлого шага) — застыло сразу.
  await sleep(150)
  if ((bot.blockAt(cell) || {}).name !== 'obsidian') {
    const w = await pour(bot, 'water_bucket', t.waterRef)
    if (!w.ok) {
      // Вода не легла — лава рядом с телом растечётся через полторы секунды:
      // черпнуть её обратно тем же (теперь пустым) ведром.
      await scoop(bot, cell, 'lava')
      return { ok: false, why: `вода: ${w.why}` }
    }
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && (bot.blockAt(cell) || {}).name !== 'obsidian') await sleep(50)
    const b2 = bot.blockAt(cell)
    if (b2 && b2.name === 'lava') {
      // Легла не туда (луч задел другую грань) — воду назад, лаву назад.
      await scoop(bot, t.waterRef.plus(UP), 'water')
      await scoop(bot, cell, 'lava')
      return { ok: false, why: 'вода легла не рядом с лавой — забрал обе' }
    }
  }
  // Вычерпать свою воду (она в клетке над waterRef) — иначе растечётся.
  const wc = t.waterRef.plus(UP)
  if (!(await scoop(bot, wc, 'water'))) {
    await sleep(200)
    if (!(await scoop(bot, wc, 'water'))) {
      const wb = bot.blockAt(wc)
      const me = bot.entity.position
      return { ok: false, fatal: true, why: `свою воду не забрал (${wc.x},${wc.y},${wc.z}: ${wb ? wb.name : '?'} ур. ${levelOf(wb)}; тело ${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)}; прицел ${scoopAim(bot, wc) ? 'есть' : 'нет'}) — литьё остановлено` }
    }
  }
  await sleep(500)
  const now = bot.blockAt(cell)
  if (now && now.name === 'obsidian') { report.cast.push(xyz(cell)); return { ok: true } }
  return { ok: false, why: `на ${cell.x},${cell.y},${cell.z} вышло ${now ? now.name : '?'}` }
}

// ---------------------------------------------------------------- целиком

// hint — где чутьё штрека нашло лаву за блоком ({x,y,z}); maxDig/keep — см. judge; windows — разрешить окна к
// лаве и при доборе (глубокое литьё в штреке, кампания: ND_OW_DEEP).
async function castPortal (session, ctl, { timeoutSeconds = 540, radius = 9, maxDig = MAX_DIG, keep = LAVA_KEEP, hint = null, windows = false, waterHint = null }: any = {}) {
  const bot = session.bot
  // Одно ведро, с берега озера (cast1.js, поток route): portal cast {one: true}.
  if (arguments[2] && arguments[2].one) return require('./cast1').castOne(session, ctl, arguments[2])
  // Слух (ND_OW_HEAR): лава с воздухом над ней в 16 бл. — направление и примерная дальность, без движения тела.
  if (arguments[2] && arguments[2].listen) {
    const rad = Number(arguments[2].listen) > 1 ? Number(arguments[2].listen) : 16
    return { built: false, heard: arguments[2].fluid === 'water' ? hearWater(bot, { radius: rad }) : hearLava(bot, { radius: rad }) }
  }
  // Отладка (сцены): что видит литьё у подсказки — без движения тела.
  if (arguments[2] && arguments[2].probe) {
    const pr = arguments[2].probe
    const h = new Vec3(Math.floor(pr.x), Math.floor(pr.y), Math.floor(pr.z))
    const near = []
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 0; dy++) {
      const q = h.offset(dx, dy, dz); const b = bot.blockAt(q)
      if (b && b.name === 'lava') near.push({ at: xyz(q), level: levelOf(b), up: (bot.blockAt(q.plus(UP)) || {}).name, sees: (() => { try { return require('./sight').seesBlock(bot, b) } catch (e) { return 'err ' + e.message } })(), aim: !!scoopAim(bot, q) })
    }
    return { built: false, probe: true, pos: xyz(bot.entity.position), eye: (p => [p.x, p.y, p.z].map(v => Math.round(v * 100) / 100))(eyes(bot)), sources: lavaSources(bot, 28).map(b => xyz(b.position)).slice(0, 10), near: near.filter(n => n.level === 0).slice(0, 20), spots: standSpots(bot, h).slice(0, 5).map(x => xyz(x.S)), windows: windowCandidates(bot, h).slice(0, 5).map(c => xyz(c.w)) }
  }
  // Только вода глубоко (ведро ещё пустое, штрек встал у воды за блоком): окно над источником и черпак — тем же
  // ходом литья, без отдельного RPC (session.bucket окон не открывает).
  if (waterHint) {
    const rep0 = { cast: [], refills: 0, placed: 0, dug: 0 }
    if (countOf(bot, 'water_bucket')) return { ...rep0, water: true, built: false }
    if (!countOf(bot, 'bucket')) return { ...rep0, water: false, built: false, stopped: 'нет пустого ведра' }
    await openWindow(session, ctl, waterHint, rep0, { fluid: 'water' })
    const r = await require('./obsidian').fillBucket(session, ctl, { fluid: 'water', radius: 8 })
    return { ...rep0, water: !!(r && (r.filled || r.already)), built: false, stopped: r && r.stopped }
  }
  const deadline = gameClock.now() + Math.max(60, Math.min(600, timeoutSeconds)) * 1000 - 5000
  const report: any = { cast: [], refills: 0, placed: 0, dug: 0 }
  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  })
  const buckets = countOf(bot, 'bucket') + countOf(bot, 'water_bucket') + countOf(bot, 'lava_bucket')
  if (buckets < 2) {
    return { ...report, built: false, stopped: 'нужно два ведра: одно под воду, одно под лаву (6 железа)', need: { what: 'bucket', count: 2, have: buckets } }
  }
  // Все годные наполнители, а не первый по списку: 8 булыжника и 30 земли — это 38 блоков, а не 8 («нужно блоков 10»).
  const filler = () => FILLER_STEADY.reduce((n, name) => n + countOf(bot, name), 0)
  if (filler() < 10) return { ...report, built: false, stopped: 'на углы, столбы и подпорки нужно блоков 10', need: { what: 'cobblestone', count: 10, have: filler() } }

  // План: прошлый, если его рама ещё не испорчена, иначе новый у видимой лавы.
  // Прошлый переживает и перезапуск демона — он в памяти мира (place), иначе
  // вторая попытка начала бы вторую раму рядом с наполовину отлитой первой.
  let plan = session.castPlan
  if (!plan) {
    const rec = ((session.journal.state && session.journal.state.places) || {})[PLACE]
    const here = bot.game ? bot.game.dimension : null
    if (rec && rec.axis && rec.side && (rec.dimension || 'overworld') === (here || 'overworld')) {
      const g0 = geom(new Vec3(rec.x, rec.y, rec.z), rec.axis, rec.side)
      plan = { axis: rec.axis, side: rec.side, origin: { x: rec.x, y: rec.y, z: rec.z }, dig: rec.dig || clearanceKeys(g0).map(xyz), corners: [xyz(g0.at(-1, -1)), xyz(g0.at(2, -1))], lavaDist: rec.lavaDist, lavaAt: rec.lavaAt || [], windows: !!(rec.windows || windows) }
    }
  }
  if (plan) {
    session.castPlan = plan // Refill must see the plan restored from the journal.
    const g0 = geomOf(plan)
    const far = g0.at(0, 0).distanceTo(bot.entity.position) > 24
    if (far) { plan = null; session.castPlan = null }
  }
  if (!plan && process.env.ND_OW_KIT_FRAME !== '0') {
    plan = resumeOnePlan(session, { maxDig, windows })
    if (plan) {
      session.castPlan = plan
      session.journal.patch(st => {
        st.places ||= {}; st.places[PLACE] = { ...plan.origin, dimension: bot.game?.dimension, axis: plan.axis, side: plan.side,
          lavaAt: plan.lavaAt, windows: plan.windows, dig: plan.dig, note: 'литьё рамы' }
      })
    }
  }
  if (!plan) {
    const hintList = hint ? [hint] : []
    let lava = scoopableSources(bot, hintList).map(b => b.position)
    if (!lava.length) lava = lavaSources(bot, 24).map(b => b.position)
    // Лава известна, но отсюда не видна (тело отошло — прошлое место рамы, край штрека заслоняет): к клетке, откуда
    // черпак её достаёт, и смотреть оттуда; не видна и там — окно над источником.
    if (!lava.length && hint && windows) {
      const h = new Vec3(Math.floor(hint.x), Math.floor(hint.y), Math.floor(hint.z))
      const sp = standSpots(bot, h).map(x => x.S)
      for (const S of sp.slice(0, 2)) { if (await walk(bot, ctl, new goals.GoalBlock(S.x, S.y, S.z), 20000)) break }
      lava = scoopableSources(bot, hintList).map(b => b.position)
      if (!lava.length) lava = lavaSources(bot, 24).map(b => b.position)
    }
    if (!lava.length && hint && windows) {
      await openWindow(session, ctl, hint, report)
      lava = scoopableSources(bot, [...hintList, ...(report.lastWindow ? [report.lastWindow] : [])]).map(b => b.position)
    }
    if (!lava.length) return { ...report, built: false, stopped: 'не вижу лавы-источника в 24 блоках — подойди к лаве (озеро, пещера)' }
    const found = planCast(bot, lava, { radius, maxDig, keep, groundY: windows ? feetCell(bot).y : null, mcData: session.mcData })
    if (!found.ok) return { ...report, built: false, stopped: `места под раму у лавы нет: ${found.reasons.join(', ')}` }
    plan = found.plan
    // Где лава, которую видели при выборе места: со стойки у рамы её может
    // заслонять край ямы, и черпать тогда идут сюда (refillLava).
    plan.lavaAt = lava.slice(0, 12).map(p => xyz(p))
    plan.windows = !!windows
    session.castPlan = plan
    session.journal.patch(s => {
      if (!s.places) s.places = {}
      s.places[PLACE] = { ...plan.origin, dimension: bot.game ? bot.game.dimension : null, axis: plan.axis, side: plan.side, lavaDist: plan.lavaDist, lavaAt: plan.lavaAt, windows: plan.windows, dig: plan.dig, note: `литьё рамы: ось ${plan.axis}, сторона ${plan.side}` }
    })
  }
  const g = geomOf(plan)
  report.site = { origin: plan.origin, axis: plan.axis, side: plan.side, lavaDist: plan.lavaDist }
  if (process.env.ND_OW_KIT_FRAME !== '0' && session.castLavaFailure) {
    const current = refillState(bot, plan)
    if (current.empty && current.key === session.castLavaFailure.key) return { ...report, built: false, frame: current.frame,
      stopped: session.castLavaFailure.stopped, retryBlocked: true }
    session.castLavaFailure = null
  }
  const late = () => gameClock.now() > deadline || ctl.aborted
  const groundY = g.F(0, -1).y

  // 1. Расчистка. Сначала проход на уровне ног и головы (ряд перед рамой, j=-1..0) — от ближней клетки: так тело
  // само прокапывает себе дорогу (в штреке глубоко место копается почти целиком). Потом остальное сверху вниз —
  // стоя на полу перед своей колонкой рамы, только то, до чего достать с пола: к недосягаемой клетке pathfinder
  // строил столб булыжника прямо в ряду перед рамой (потом «потолок cobblestone» у литья).
  const digCell = async p => {
    const b = bot.blockAt(p)
    if (!b || isAir(b) || /lava|water/.test(b.name)) return null
    const risk = digRisk(p => bot.blockAt(p), p)
    if (risk) return risk
    const problem = b.boundingBox === 'empty' ? null : missingHarvestTool(bot, b, session.mcData)
    if (problem) return problem
    try { await equipBestTool(bot, b); await digVisible(bot, b, 8000); report.dug++ } catch {}
    const after = bot.blockAt(p)
    return after && isAir(after) ? null : 'клетка не выкопана'
  }
  const floorFor = p => {
    let best = null
    for (let i = -1; i <= 2; i++) {
      const f = g.F(i, -1)
      const d = f.offset(0.5, 1.62, 0.5).distanceTo(centre(p))
      if (!best || d < best.d) best = { f, d }
    }
    return best
  }
  const groundY0 = g.F(0, -1).y
  const frameSet = new Set(frameKeys(g).map(p => `${p.x},${p.y},${p.z}`))
  const cellsToDig = plan.dig.map(c => new Vec3(c.x, c.y, c.z))
    .filter(p => !(frameSet.has(`${p.x},${p.y},${p.z}`) && (bot.blockAt(p) || {}).name === 'obsidian'))
  const low = cellsToDig.filter(p => p.y <= groundY0 + 1)
  const inFront = p => g.axis === 'x' ? p.z === g.F(0, 0).z : p.x === g.F(0, 0).x
  const high = cellsToDig.filter(p => p.y > groundY0 + 1)
    .sort((a, b) => a.y - b.y || Number(inFront(b)) - Number(inFront(a)))
  // Невидимая сейчас клетка (за ещё не выкопанной соседкой) — не повод бросать литьё: в следующий проход, когда
  // соседку снимут, её грань откроется. Останов — только по риску (жидкость/сыпучее рядом) и по инструменту.
  const notDug = why => why === 'клетка не выкопана'
  // Место оказалось негодным при копке (жидкость за стенкой, сыпучее сверху, нечем копать) — план забыть, иначе
  // каждый следующий вызов поднимает его из журнала и встаёт на той же клетке (ow-L1 02.10, слот 15: три вызова за
  // секунду «жидкость сбоку»). Следующий вызов выберет место заново.
  const dropPlan = r => {
    session.castPlan = null
    try { session.journal.patch(st => { if (st.places) delete st.places[PLACE] }) } catch {}
    return r
  }
  for (let pass = 0; pass < 3 && !late(); pass++) {
    let left = 0
    const lowLeft = low.filter(p => { const b = bot.blockAt(p); return b && !isAir(b) && !/lava|water/.test(b.name) })
    while (lowLeft.length && !late()) {
      lowLeft.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      const p = lowLeft.shift()
      if (eyes(bot).distanceTo(centre(p)) > REACH) await walk(bot, ctl, new goals.GoalNear(p.x, p.y, p.z, 1), 15000, { clearance: true })
      const why = await digCell(p)
      if (why && !notDug(why)) return dropPlan({ ...report, built: false, stopped: `расчистить место: ${why}` })
      if (why) left++
    }
    for (const p of high) {
      if (late()) break
      const b = bot.blockAt(p)
      if (!b || isAir(b) || /lava|water/.test(b.name)) continue
      const st = floorFor(p)
      if (!st || st.d > REACH + 0.2) { report.skipped = (report.skipped || 0) + 1; continue }
      if (eyes(bot).distanceTo(centre(p)) > REACH) {
        const f = feetCell(bot)
        if (!f.equals(st.f)) await walk(bot, ctl, new goals.GoalBlock(st.f.x, st.f.y, st.f.z), 15000)
      }
      if (eyes(bot).distanceTo(centre(p)) > REACH + 0.2) { report.skipped = (report.skipped || 0) + 1; continue }
      const why = await digCell(p)
      if (why && !notDug(why)) return dropPlan({ ...report, built: false, stopped: `расчистить место: ${why}` })
      if (why) left++
    }
    // Следующий проход — то, что осыпалось (гравий над выкопанным) или было закрыто соседкой.
    if (!left) break
  }
  {
    // Что осталось невыкопанным из нужного воздуха (разбор: «не встал на …» после расчистки).
    const frameSet2 = new Set(frameKeys(g).map(p => `${p.x},${p.y},${p.z}`))
    const left = clearanceKeys(g).filter(p => { const b = bot.blockAt(p); return b && !isAir(b) && !/lava|water/.test(b.name) && !(frameSet2.has(`${p.x},${p.y},${p.z}`) && b.name === 'obsidian') })
    if (left.length) {
      report.trace = report.trace || []
      report.trace.push(`не выкопано ${left.length}: ${left.slice(0, 4).map(p => `${p.x},${p.y},${p.z} ${(bot.blockAt(p) || {}).name}`).join('; ')}`)
    }
  }
  // 2. Нижние углы — опора стоек.
  for (const c of plan.corners) {
    if (late()) break
    const p = new Vec3(c.x, c.y, c.z)
    if (isSolid(bot.blockAt(p))) continue
    if (eyes(bot).distanceTo(centre(p)) > REACH) await stand(session, ctl, g, 0, -1, report)
    const r = await placeBlockAt(bot, p, { steady: true })
    if (r.ok) report.placed++
  }

  // 3. Клетки рамы в порядке раскладки.
  const T = [
    { cell: g.at(0, -1), lavaRef: g.at(0, -2), waterRef: g.F(0, -2), col: 0, h: -1 },
    { cell: g.at(1, -1), lavaRef: g.at(1, -2), waterRef: g.F(1, -2), col: 1, h: -1 },
    { cell: g.at(-1, 0), lavaRef: g.at(-1, -1), waterRef: g.at(0, -1), col: 0, h: -1 },
    { cell: g.at(2, 0), lavaRef: g.at(2, -1), waterRef: g.at(1, -1), col: 1, h: -1 },
    { cell: g.at(-1, 1), lavaRef: g.at(-1, 0), waterRef: g.F(-1, 0), col: -1, h: 1 },
    { cell: g.at(-1, 2), lavaRef: g.at(-1, 1), waterRef: g.F(-1, 1), col: -1, h: 2 },
    { props: true },
    { cell: g.at(2, 1), lavaRef: g.at(2, 0), waterRef: g.F(2, 0), col: 2, h: 1 },
    { cell: g.at(2, 2), lavaRef: g.at(2, 1), waterRef: g.F(2, 1), col: 2, h: 2 },
    { cell: g.at(1, 3), lavaRef: g.at(1, 2), waterRef: g.at(2, 2), col: 2, h: 3 },
    { cell: g.at(0, 3), lavaRef: g.at(0, 2), waterRef: g.at(-1, 2), col: -1, h: 3 }
  ]
  let stopped = null
  for (const t of T) {
    if (late()) { stopped = 'время вышло — позови ещё раз, продолжу с этой рамы'; break }
    if (t.props) {
      // Временные подпорки в верхний ряд проёма — с земли, у стоек.
      const s = await stand(session, ctl, g, 0, -1, report)
      if (!s.ok) { stopped = s.why; break }
      for (const p of [g.at(0, 2), g.at(1, 2)]) {
        if (isSolid(bot.blockAt(p))) continue
        const r = await placeBlockAt(bot, p, { steady: true })
        if (r.ok) report.placed++
        else { stopped = `подпорка ${p.x},${p.y},${p.z}: ${r.reason}`; break }
      }
      if (stopped) break
      continue
    }
    const r = await castCell(session, ctl, g, t, report)
    if (!r.ok) {
      if (r.fatal) { stopped = r.why; break }
      // Одна повторная попытка — лава кончилась посреди, вода утекла и т. п.
      const again = await castCell(session, ctl, g, t, report)
      if (!again.ok) { stopped = `клетка ${t.cell.x},${t.cell.y},${t.cell.z}: ${again.why}`; break }
    }
  }
  // 4. Вниз, подпорки долой, проём чистый.
  await descend(bot, ctl, groundY, report)
  if (!stopped) {
    await stand(session, ctl, g, 0, -1, report)
    for (let j = 2; j >= 0; j--) {
      for (const i of [0, 1]) {
        const p = g.at(i, j)
        const b = bot.blockAt(p)
        // Трава и слой снега в проёме тоже долой: зажечь можно только пустой проём (PortalShape.isEmpty).
        if (!b || isAir(b) || (b.boundingBox === 'empty' && !SOFT_PLANT.test(b.name))) continue
        if (/water|lava/.test(b.name)) continue
        try { await equipBestTool(bot, b); await digVisible(bot, b, 6000); report.dug++ } catch {}
      }
    }
  }
  const frame = frameKeys(g).map(p => bot.blockAt(p)).map(b => (b ? b.name : '?'))
  const done = frame.filter(n => n === 'obsidian').length
  const built = done === 10
  if (process.env.ND_OW_KIT_FRAME !== '0' && !built && !ctl.aborted && /лава кончилась/.test(stopped || '')) {
    const current = refillState(bot, plan)
    if (current.empty) session.castLavaFailure = { key: current.key, stopped }
  }
  return {
    ...report,
    built,
    frame: `${done}/10 обсидиан`,
    stopped: built ? undefined : (stopped || `рама не собралась: ${done}/10`)
  }
}

module.exports = { castPortal, planCast, judge, geom, lavaSources, landing, aimFor, windowCandidates, openWindow, scoopAim, standSpots, hearLava, hearWater, liveLava, outlineAim, steadyFloor, SOFT_PLANT, PLACE }
// Внутренности для cast1.js (одно ведро): те же прицел, черпак, копка и ходьба.
module.exports._in = { resumeOnePlan, refillState, digVisible, digRisk, scoopAim, pour, scoop, aimFor, landing, levelOf, isAir, isSolid, hasFluid, walk, centreOn, feetCell, descend, dryFeet, hold, countOf, standSpots, lavaSources, liveLava, eyes }
