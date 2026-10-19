'use strict'
// Литьё портала (cast.ts): константы, проверки клеток, геометрия рамы, копка по видимому.
import { Vec3 } from 'vec3'
import { eyeOf, blockOnRay, faceAim } from '../pick'
import { withTimeout } from '../build'


export const UP = new Vec3(0, 1, 0)
const AX = { x: new Vec3(1, 0, 0), z: new Vec3(0, 0, 1) }
export const PLACE = 'литьё портала'
// Сколько держать от лавы рабочее место: вода, пока не вычерпана, течёт по
// блоку за 5 тиков (WaterFluid.getTickDelay) и за секунду дойдёт до четырёх;
// дотекла до озера — поверхность озера застынет, и черпать станет неоткуда.
export const LAVA_KEEP = 5
// Дальше этого от места до лавы — каждый черпак это прогулка.
export const LAVA_FAR = 18
export const MAX_DIG = 48
export const REACH = 4.3
export const PROTECTED = /chest|barrel|shulker|furnace|smoker|anvil|_bed$|crafting_table|enchanting_table|brewing_stand|beacon|spawner|bedrock|_door$|ladder|rail|_sign$|end_portal|nether_portal/
export const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$/
export const FILLER_STEADY = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'basalt']

export function countOf (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}
export const isAir = b => !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')
export const hasFluid = b => {
  if (!b) return false
  if (/^(water|lava|bubble_column)$/.test(b.name)) return true
  try { return b.getProperties().waterlogged === true } catch { return false }
}
export const isSolid = b => !!b && b.boundingBox === 'block' && !hasFluid(b)
export const isEmptyish = b => !!b && b.boundingBox === 'empty' && !/lava/.test(b.name)
export const eyes = eyeOf
export const centre = p => p.offset(0.5, 0.5, 0.5)

// Геометрия раскладки: at(i,j) — клетки рамы и проёма, F(i,j) — ряд перед ней.
export function geom (origin, axis, side) {
  const u = AX[axis]
  const perp = axis === 'x' ? AX.z : AX.x
  const at = (i, j) => origin.offset(u.x * i, j, u.z * i)
  const F = (i, j) => at(i, j).offset(perp.x * side, 0, perp.z * side)
  return { origin, axis, side, u, perp, at, F }
}

export function frameKeys (g) {
  const out = []
  for (const [i, j] of [[0, -1], [1, -1], [-1, 0], [-1, 1], [-1, 2], [2, 0], [2, 1], [2, 2], [0, 3], [1, 3]]) out.push(g.at(i, j))
  return out
}

// Refusal only: hidden fluids may reject a cut, never count as found resources.
export function digRisk (read, p) {
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
export const SOFT_PLANT = /^(short_grass|tall_grass|fern|large_fern|snow|dead_bush|bush|short_dry_grass|tall_dry_grass|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|.*_petals|leaf_litter|sweet_berry_bush|firefly_bush|sunflower|lilac|rose_bush|peony|.*_sapling|brown_mushroom|red_mushroom|seagrass|vine|glow_lichen)$/
export function outlineAim (bot, b, { eye = null, range = REACH }: any = {}) {
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

export async function digVisible (bot, b, ms) {
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
export function steadyFloor (read, p) {
  const b = read(p)
  if (!isSolid(b)) return false
  if (!FALLING.test(b.name)) return true
  const below = read(p.offset(0, -1, 0))
  return !!below && !hasFluid(below) && below.boundingBox === 'block'
}

export function clearanceKeys (g) {
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

export function geomOf (plan) {
  return geom(new Vec3(plan.origin.x, plan.origin.y, plan.origin.z), plan.axis, plan.side)
}
export function levelOf (b) {
  try { const p = b.getProperties(); if (p && p.level !== undefined) return Number(p.level) } catch {}
  return typeof b.metadata === 'number' ? b.metadata : null
}

// prismarine-world BlockFace: 0 низ, 1 верх, 2 север, 3 юг, 4 запад, 5 восток.
export const FACE_VEC = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]

// ---------------------------------------------------------------- окно к лаве

// Штрек и лесенка встают у лавы, которой не видно («лава на X (в 1 впереди)» — чутьё безопасности
// mining.danger: лава за блоком). Человек на этом месте сломал бы блок и увидел её. Здесь так же, но безопасно:
// ломается только блок НАД источником (лава вверх не течёт — LiquidBlock: растекание вниз и по сторонам), и только
// если у этого блока по бокам и сверху нет жидкости (иначе она польётся в окно и к телу), сверху не сыпучее
// (гравий упал бы в лаву на место источника), блок виден глазами и в досягаемости. Пол под собой не ломается.
// Чутьё здесь только выбирает, какой из ВИДИМЫХ блоков сломать; лава засчитывается, когда её видно (lavaSources).
export const SIDES4 = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

// ---------------------------------------------------------------- тело и столбы

export function feetCell (bot) { return bot.entity.position.floored() }
