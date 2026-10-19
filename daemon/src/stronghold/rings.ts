'use strict'
// Поиск крепости (stronghold.ts): константы ока, известная комната, кольца крепостей и их плотность.
import * as gameClock from '../game-clock'


const TAU = Math.PI * 2
export const DEG = 180 / Math.PI
export const EYE_REACH = 12 // EyeOfEnder.TOO_FAR_DISTANCE
// Ошибка позиции ока у клиента. Дельты движения — в 1/4096 блока от последней
// отправленной базы, база сервера точная, у клиента — округлённая: ошибка
// копится блужданием, ~22 пакета за полёт. Замер в игре (try-speedrun.js (у),
// 2026-09-26, 8 бросков с 500–1055 блоков против /locate): невязка угла RMS
// 0.00034° (5.9e-6 рад), худшая 0.0006° — это ~5e-5 блока на 12 блоках
// пролёта. Берём в 10 раз хуже: σ = 0.0005·√2/12 ≈ 5.9e-5 рад (0.0034°).
// Синтетика с этими σ (solvetest, 300 раскладок): один бросок — точный чанк в
// 93–97%, два из точек в 12–40 блоках — 100%, p ≥ 0.95 в 97–100%.
export const POS_ERR = 0.0005
export const SIGMA_MIN = 1e-5
export const PLACE = 'крепость'

// Карта копии мира — подсказка маршрута, не запись «портал найден».
// Старый скан сохранял BB комнаты только в note; поддерживаем его без перескана.
export function mappedRoom (rec) {
  if (!rec || (rec.dimension && rec.dimension !== 'overworld')) return null
  let room = rec.room || rec.portalRoom
  let bb = room && room.bb
  const m = /комната портала (-?\d+),(-?\d+),(-?\d+)\.\.(-?\d+),(-?\d+),(-?\d+)/.exec(rec.note || '')
  if (!bb && m && /карта/.test(rec.note)) bb = m.slice(1).map(Number)
  if (bb) {
    if (!Array.isArray(bb) || bb.length !== 6 || !bb.every(Number.isFinite)) return null
    const [x1, y1, z1, x2, y2, z2] = bb
    if (!((x2 - x1 === 10 && z2 - z1 === 15) || (x2 - x1 === 15 && z2 - z1 === 10)) || y2 - y1 !== 7) return null
    room = { x: Math.round((x1 + x2) / 2), y: y1 + 3, z: Math.round((z1 + z2) / 2) }
  } else room = room && (room.centre || room.center || room)
  if (!room || ![room.x, room.y, room.z].every(Number.isFinite) || room.y < -60 || room.y > 315 || Math.abs(room.x) > 29999984 || Math.abs(room.z) > 29999984) return null
  return { centre: { x: Math.floor(room.x), y: Math.floor(room.y), z: Math.floor(room.z) }, bb: bb ? bb.slice() : null }
}

export function roomApproach (room, from) {
  const c = room.centre
  const y = c.y + 1 // выше рамок: под центром лава; идём к боковому проходу
  if (room.bb) {
    const [x1, , z1, x2, , z2] = room.bb
    if (x2 - x1 < z2 - z1) {
      const east = Math.abs(from.x - x2) < Math.abs(from.x - x1)
      return { shaft: { x: east ? x2 + 2 : x1 - 2, z: c.z }, target: { x: east ? x2 - 1 : x1 + 1, y, z: c.z } }
    }
    const south = Math.abs(from.z - z2) < Math.abs(from.z - z1)
    return { shaft: { x: c.x, z: south ? z2 + 2 : z1 - 2 }, target: { x: c.x, y, z: south ? z2 - 1 : z1 + 1 } }
  }
  // Только центр: первая стенка в 5 бл. от него, без спуска на центр лавы.
  const dx = from.x <= c.x ? -1 : 1
  return { shaft: { x: c.x + dx * 7, z: c.z }, target: { x: c.x + dx * 4, y, z: c.z } }
}

export const wrap = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
// Компасный угол, как во всём демоне: 0 — юг (+z), 90° — восток (+x).
export const bearingOf = (from, to) => Math.atan2(to.x - from.x, to.z - from.z)
export const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
export const snap16 = v => Math.round(v / 16) * 16
export const r1 = v => Math.round(v * 10) / 10
export function withTimeout (promise, ms) {
  let timer = null
  return Promise.race([promise, new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), ms) })])
    .finally(() => gameClock.clearTimeout(timer))
}

// Кольца — тот же цикл, что в generateRingPositions (целочисленное деление Java).
export const RINGS = (() => {
  const out = []
  let spread = 3
  let inRing = 0
  let ring = 0
  for (let i = 0; i < 128; i++) {
    if (!out[ring]) out[ring] = { ring, n: 0, lo: (4 * 32 + 32 * ring * 6 - 40) * 16, hi: (4 * 32 + 32 * ring * 6 + 40) * 16 }
    out[ring].n++
    if (++inRing === spread) {
      ring++
      inRing = 0
      spread += Math.floor(2 * spread / (ring + 1))
      spread = Math.min(spread, 128 - i)
    }
  }
  return out
})()
// Сдвиг к биому (до 112) и угол чанка вместо середины (до 11) размывают края.
const RING_BLUR = 128

// Плотность крепостей на квадратный блок на расстоянии R от 0,0.
export function ringDensity (R) {
  let d = 0
  for (const g of RINGS) {
    const lo = g.lo - RING_BLUR
    const hi = g.hi + RING_BLUR
    const area = Math.PI * (hi * hi - Math.max(0, lo) * Math.max(0, lo))
    const w = 1 / (1 + Math.exp((lo - R) / 24)) / (1 + Math.exp((R - hi) / 24))
    d += g.n / area * w
  }
  return d + 1e-14
}

// Око летит к БЛИЖАЙШЕЙ крепости (getNearestGeneratedStructure). Для кандидата
// первого кольца две другие крепости кольца стоят через ±120° (generateRingPositions:
// угол += 2π/3 на кольце из трёх), радиус у каждой свой (1408..2688, ±112 к биому).
// Вес кандидата × P(обе дальше него от точки броска) — как «closest stronghold»
// у Ninjabrain Bot (Posterior). Нужен одному броску: длинный луч из-за края
// кольца пересекает кольцо дважды, и дальний кандидат иначе не отличить
// (прогон 2026-09-26: с 2990 от 0,0 лучшим вышел угол в 3983 блоках).
// Кандидат дальних колец — ближайший, только если все три крепости первого
// кольца (угол θ0 любой) дальше него: g(t) по сетке θ0 и радиусов, один раз
// на решение (от точки броска зависит, от кандидата — только через t).
export function farTable (from, maxDist) {
  const lo = RINGS[0].lo - 112
  const hi = RINGS[0].hi + 112
  const A = 48
  const K = 8
  const step = 50
  const g = []
  for (let t = 0; t <= maxDist + step; t += step) {
    let sum = 0
    for (let a = 0; a < A; a++) {
      let all = 1
      for (let j = 0; j < 3; j++) {
        const th = (a + 0.5) / A * TAU + j * TAU / 3
        let far = 0
        for (let i = 0; i < K; i++) {
          const r = lo + (i + 0.5) / K * (hi - lo)
          if (Math.hypot(Math.cos(th) * r - from.x, Math.sin(th) * r - from.z) > t) far++
        }
        all *= far / K
      }
      sum += all
    }
    g.push(sum / A)
  }
  return t => g[Math.min(g.length - 1, Math.round(t / step))]
}

export function nearestFactor (c, from, far) {
  const R = Math.hypot(c.x + 8, c.z + 8)
  const t = flat(c, from)
  if (ringOf(R) !== 0) return Math.max(far ? far(t) : 1, 1e-6)
  const phi = Math.atan2(c.z + 8, c.x + 8)
  const lo = RINGS[0].lo - 112
  const hi = RINGS[0].hi + 112
  const K = 12
  let f = 1
  for (const dphi of [TAU / 3, -TAU / 3]) {
    let closer = 0
    for (let i = 0; i < K; i++) {
      const r = lo + (i + 0.5) / K * (hi - lo)
      if (Math.hypot(Math.cos(phi + dphi) * r - from.x, Math.sin(phi + dphi) * r - from.z) < t) closer++
    }
    f *= 1 - closer / K
  }
  return Math.max(f, 1e-3)
}

export function ringOf (R) {
  for (const g of RINGS) if (R >= g.lo - RING_BLUR && R <= g.hi + RING_BLUR) return g.ring
  return null
}
