'use strict'
// ND_END2_PIE=1 (поток end2 sr27): «пирог» F3 при нескольких спавнерах у крепости. Прежде пеленг брался по одной дуге
// (arcs[0] — любая из равных), и пересечение смешивало разные спавнеры; а у лестницы старта часто есть данж или шахта
// (e2-rA/rB 27.10: 5955 — данж на y ~76 у поверхности, «ниже уровня комнаты (59 < 81)» по кругу и 8 зомби; −9170 — «пирог»
// сошёлся на данже 336,1356 в 60 бл. от комнаты). Как игрок с F3: каждую дугу спавнера веду отдельно (связь по пеленгу), и
// отбрасываю то, что комнатой быть не может:
//   - выше крепости: наклон «пирога» на этом пеленге даёт y > 60 (крепость ниже моря −10: верх < 53, StrongholdStructure
//     moveBelowSeaLevel; запас 8 на ошибку наклона);
//   - данж: в той же стороне дуга сундука (у данжа 1–2 сундука вплотную к спавнеру; в комнате портала сундуков нет) в
//     большинстве отсчётов; или мшистый булыжник (стены данжа) на виду у оценки.
// Знание — то же, что у человека: дуги «пирога» и наклон камеры, глаза; клетки спавнеров наружу не выходят.
import { log, visibleOf } from './common'

const norm = (a: number) => ((a % 360) + 540) % 360 - 180
const TOP = 60

export interface PieSample { x: number, z: number, yaw: number, chest: boolean }
export interface PieTrack { id: number, samples: PieSample[], est?: any, y?: number | null, notRoom?: string, dungeon?: string }
export interface PieStore { key: string, tracks: PieTrack[], last?: { x: number, z: number }, n: number }

export function pieStore (session, key: string): PieStore {
  if (!session._pieTrack || session._pieTrack.key !== key) session._pieTrack = { key, tracks: [], n: 0 }
  return session._pieTrack
}

function bearings (bot, skip) {
  const S: typeof import('../perception/senses') = require('../perception/senses')
  const sp = S.pieArcs(bot, 'spawner', { fov: 20, step: 2, skip }).filter(a => !a.all && a.center !== null)
  const ch = S.pieArcs(bot, 'chest', { fov: 20, step: 2 }).filter(a => !a.all && a.center !== null)
  return sp.map(a => ({ yaw: a.center, chest: ch.some(c => Math.abs(norm(c.center - a.center)) <= 4) }))
}

function estimate (t: PieTrack) {
  const s = t.samples.slice(-8)
  if (s.length < 2) return null
  let base = 0
  for (const a of s) for (const b of s) base = Math.max(base, Math.hypot(a.x - b.x, a.z - b.z))
  if (base < 4) return null
  return (require('../perception/senses') as typeof import('../perception/senses')).triangulate(s)
}

// Ошибка места ≤ 9 бл. — комната 16×11, штрек к ней всё равно в неё попадает (5730 e2-rC2: оценка 305,−1565 при truth 304,−1567,
// u 6.6–8.6 — «неточная», и тело 25 мин ходило по пеленгу на 24 бл. туда-обратно).
export const precise = (t: PieTrack) => !!t.est && t.est.spread <= 6 && t.est.uncertainty <= 9

// Отсчёт с этого места (не ближе minStep к прошлому): дуги → треки, оценки, отбраковка. true — отсчёт сделан.
export function pieObserve (bot, store: PieStore, { skip = null, minStep = 4 }: any = {}) {
  const me = bot.entity.position
  if (store.last && Math.hypot(store.last.x - me.x, store.last.z - me.z) < minStep) return false
  store.last = { x: me.x, z: me.z }
  const S: typeof import('../perception/senses') = require('../perception/senses')
  // Связь дуга ↔ трек — жадно по наименьшей разнице пеленга: у трека с оценкой — до 12° от пеленга на оценку, у трека из одного
  // отсчёта (место неизвестно; шаг вбок 10 бл. при спавнере в 30 бл. поворачивает пеленг на ~18°) — до 30°.
  const bs = bearings(bot, skip)
  const pairs = []
  for (const [i, b] of bs.entries()) {
    for (const t of store.tracks) {
      const pred = t.est ? S.yawOf(t.est.x - me.x, t.est.z - me.z) : t.samples[t.samples.length - 1].yaw
      const d = Math.abs(norm(b.yaw - pred))
      if (d <= (t.est ? 12 : 30)) pairs.push({ i, t, d })
    }
  }
  const usedB = new Set<number>()
  const usedT = new Set<PieTrack>()
  const pick = new Map<number, PieTrack>()
  for (const q of pairs.sort((a, b) => a.d - b.d)) if (!usedB.has(q.i) && !usedT.has(q.t)) { usedB.add(q.i); usedT.add(q.t); pick.set(q.i, q.t) }
  for (const [i, b] of bs.entries()) {
    let best = pick.get(i)
    if (!best) { best = { id: ++store.n, samples: [] }; store.tracks.push(best) }
    best.samples.push({ x: me.x, z: me.z, yaw: b.yaw, chest: b.chest })
    if (best.samples.length > 12) best.samples.splice(0, best.samples.length - 12)
    best.est = estimate(best) || best.est
  }
  const mossy = bot.registry.blocksByName.mossy_cobblestone
  for (const t of store.tracks) {
    if (t.notRoom) continue
    // Данж по сундуку — не навсегда: пересчёт по всем отсчётам (−9170 e2-rC: дуга чужого сундука 2 раза из 4 легла на пеленг комнаты).
    // Два отсчёта (с поверхности) — оба; больше — три четверти.
    const ch = t.samples.filter(s => s.chest).length
    const n = t.samples.length
    const dg = ch >= 2 && (n <= 2 ? ch === n : ch * 4 >= n * 3) ? `данж: сундук на пеленге спавнера (${ch} из ${n})` : undefined
    if (dg && !t.dungeon) log('«пирог»: спавнер не комната', { track: t.id, est: t.est && { x: t.est.x, z: t.est.z }, why: dg })
    t.dungeon = dg
    let why = null
    if (!why && t.est) {
      const flat = Math.hypot(t.est.x - me.x, t.est.z - me.z)
      if (flat <= 64) {
        const el = (require('../endportal-descent') as typeof import('../endportal-descent')).pieElevation(bot, flat, { skip, yaw: S.yawOf(t.est.x - me.x, t.est.z - me.z) })
        if (el) t.y = el.y
        if (el && el.y > TOP) why = `выше крепости: наклон «пирога» даёт y ${el.y}`
      }
      if (!why && mossy && precise(t) && visibleOf(bot, [mossy.id], 24, 32).some(q => Math.hypot(q.position.x - t.est.x, q.position.z - t.est.z) <= 6)) why = 'данж: мшистый булыжник у оценки'
    }
    if (why) { t.notRoom = why; log('«пирог»: спавнер не комната', { track: t.id, est: t.est && { x: t.est.x, z: t.est.z }, y: t.y, why }) }
  }
  return true
}

// Лучшая оценка комнаты: точная (пересечение) и не отбракованная, ближе к лестнице старта; нет точной — сторона живой дуги
// (последний пеленг). null — живых дуг нет.
export function pieBest (bot, store: PieStore, stairs: { x: number, z: number } | null = null) {
  const me = bot.entity.position
  const live = store.tracks.filter(t => !t.notRoom && !t.dungeon && t.samples.length)
  const ref = stairs || me
  // Под землёй (y < 50, у коридоров крепости) — штраф за высоту дальше 6 бл. от своей: спавнер шахты на y −45 под крепостью ближе к
  // лестнице, чем комната на y −18 (−9170 e2-rC), но коридоры вокруг — на −10…−20.
  const yRef = me.y < 50 ? me.y : null
  // Одна шкала для всех оценок (u ≤ 16): даль от лестницы + штраф высоты + ошибка места (−9170 e2-rC3: шахта y −45 с u 8.6 — «точная»,
  // комната y −16 с u 12.5 — нет, и тело ушло к шахте).
  const score = t => Math.hypot(t.est.x - ref.x, t.est.z - ref.z) + (yRef !== null && Number.isFinite(t.y) ? 1.5 * Math.max(0, Math.abs(t.y - yRef) - 6) : 0) + t.est.uncertainty
  const top = live.filter(t => t.est && t.est.uncertainty <= 16).sort((a, b) => score(a) - score(b))[0]
  if (top) return { at: { x: top.est.x, z: top.est.z }, y: Number.isFinite(top.y) ? Math.min(top.y, 52) : null, precise: precise(top), track: top.id, est: top.est }
  const dir = live.sort((a, b) => b.samples.length - a.samples.length)[0]
  if (!dir) return null
  const s = dir.samples[dir.samples.length - 1]
  const v = (require('../perception/senses') as typeof import('../perception/senses')).vecOf(s.yaw)
  return { at: { x: me.x + v.x * 24, z: me.z + v.z * 24 }, y: null, precise: false, track: dir.id, est: dir.est || null }
}

export function pieSummary (store: PieStore) {
  return store.tracks.map(t => ({ id: t.id, n: t.samples.length, est: t.est ? { x: t.est.x, z: t.est.z, u: t.est.uncertainty } : null, y: t.y, not: t.notRoom || t.dungeon || undefined }))
}
