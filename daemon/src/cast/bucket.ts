'use strict'
// Литьё портала (cast.ts): ведро — где стоять у лавы, прицел на грань, вылить, зачерпнуть.
import { Vec3 } from 'vec3'
import { itemNamed } from '../items'
import { sleep } from '../movement'
import * as gameClock from '../game-clock'
import { blockOnRay } from '../pick'
import { FACE_VEC, FALLING, SIDES4, UP, countOf, eyes, isAir, isSolid, levelOf } from './base'
import { lavaSources } from './plan'


// Клетки, где можно стоять, в r от k (твёрдый сухой пол, ноги и голова — воздух), ближние к телу первыми.
export function standNear (bot, k, r = 3) {
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
export function standSpots (bot, src, { r = 3 }: any = {}) {
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

export async function hold (bot, name) {
  const it = itemNamed(bot, name)
  if (!it) return false
  if (bot.heldItem && bot.heldItem.name === name) return true
  try { await bot.equip(it, 'hand'); return true } catch { return false }
}

// Куда ляжет жидкость из полного ведра, если смотреть в point: тот же луч,
// что у сервера (от глаз, жидкости насквозь — Fluid.NONE), первый непустой
// блок и грань входа; жидкость — в клетку за этой гранью. Воздух насквозь;
// трава и цветы — препятствие (у сервера луч по OUTLINE, травинка его ловит),
// поэтому место под раму от них расчищено, а здесь они считаются стеной.
export function landing (bot, point, range = 4.5) {
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
export function aimFor (bot, ref, face, expect) {
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
export async function pour (bot, full, ref, face = UP) {
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
export function scoopAim (bot, cell, eye = null) {
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
export function scoopableSources (bot, known: any = []) {
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

export async function scoop (bot, cell, fluid = 'water') {
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
