'use strict'
// Поиск крепости (stronghold.ts): findStronghold — броски и решение; решение по сохранённым броскам; план вслепую.
import * as gameClock from '../game-clock'
import { itemNamed } from '../items'
import { travelXZ } from '../movement'
import { DEG, bearingOf, flat } from './rings'
import { dryAt, rememberThrow, report, solve, storedThrows } from './solve'
import { throwEye } from './throw'


// Броски до уверенности: первый — отсюда; дальше шаг вбок на sideways (и
// немного вперёд) и новый бросок, пока лучший угол не наберёт want (0.95), но
// не больше maxThrows. Каждый следующий отход — к лучшему кандидату и вбок в
// другую сторону: дорога не пропадает.
export async function findStronghold (session, ctl, { sideways = 24, maxThrows = 4, want = 0.95, timeoutSeconds = 240 }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + timeoutSeconds * 1000 - 3000
  const throws = []
  const walks = []
  let sol = null
  let side = 1
  let misses = 0
  while (!ctl.aborted && gameClock.now() < deadline && throws.length < maxThrows) {
    if (!itemNamed(bot, 'ender_eye')) break
    if (throws.length) {
      // Отход: вбок от направления на лучшего кандидата и вперёд к нему.
      const me = bot.entity.position
      const toward = sol && sol.best ? bearingOf(me, sol.best) : throws[throws.length - 1].bearing
      const dist = sol && sol.best ? flat(me, sol.best) : 2000
      const fwd = throws.length === 1 ? sideways / 2 : Math.min(240, Math.max(sideways, dist * 0.12))
      // Сторона и отход — туда, где суша: в воду pathfinder заходит, а
      // выплывает плохо (прогон 2026-09-26 у моря: тело встало в воде до конца
      // срока). Сначала своя сторона, потом другая, потом ближе.
      let tx = null
      let tz = null
      for (const [sd, k] of [[side, 1], [-side, 1], [side, 0.5], [-side, 0.5], [side, 0.25]]) {
        const lat = sideways * k * sd
        const x = Math.round(me.x + Math.sin(toward) * fwd * k + Math.sin(toward + Math.PI / 2) * lat)
        const z = Math.round(me.z + Math.cos(toward) * fwd * k + Math.cos(toward + Math.PI / 2) * lat)
        if (tx === null) { tx = x; tz = z }
        if (dryAt(bot, x, z, Math.floor(me.y))) { tx = x; tz = z; side = sd; break }
      }
      const w = await travelXZ(bot, ctl, tx, tz, { range: 3, retries: 1, deadline: Math.min(deadline, gameClock.now() + 60000) })
      walks.push({ to: { x: tx, z: tz }, ok: w.ok, error: w.ok ? undefined : w.error })
      if (ctl.aborted) break
      side = -side
      // Не дошёл: бросить можно и отсюда — точности хватает и 3 блоков поперёк
      // прежнего луча (замер (у): невязка 0.0006° и хуже не бывала). Меньше —
      // другая сторона; два промаха подряд — стоп, сказать словами.
      const prev = throws[throws.length - 1]
      const off = Math.abs(Math.sin(bearingOf(prev.start, bot.entity.position) - prev.bearing)) * flat(prev.start, bot.entity.position)
      if (!w.ok && off < 3) {
        if (++misses >= 2) break
        continue
      }
      misses = 0
    }
    const t = await throwEye(session, ctl)
    if (!t.thrown) {
      if (!throws.length) return { stopped: t.why, throws: [] }
      break
    }
    throws.push(t)
    rememberThrow(session, t)
    sol = solve(throws)
    console.log('[stronghold] бросок', JSON.stringify({ n: throws.length, from: t.from, deg: t.bearingDeg, flew: t.flew, near: t.near, best: sol && sol.best, ls: sol && sol.ls }))
    if (t.near || (sol && sol.best && sol.best.p >= want && throws.length >= 2)) break
  }
  const seconds = Math.round((gameClock.now() - t0) / 1000)
  if (!sol || !sol.best) {
    return { stopped: ctl.aborted ? 'прервано' : (throws.length ? 'броски не сошлись ни в одном углу чанка' : 'ни одного броска: нет ока?'), throws, walks, seconds }
  }
  if (throws.length === 1 && !sol.near) {
    const r = report(session, sol, throws, { walks, seconds, range: sol.range })
    r.stopped = 'один бросок: направление есть, дальность — только по кольцу' + (itemNamed(bot, 'ender_eye') ? '' : ' (ока больше нет)')
    r.note = `Один бросок: ${throws[0].bearingDeg}°, крепость вероятнее всего в ${sol.range.p10}..${sol.range.p90} бл. (медиана ${sol.range.p50}). ` + r.note
    return r
  }
  return report(session, sol, throws, { walks: walks.length ? walks : undefined, seconds })
}

// mode=solve: решить по броскам из памяти (мозг бросал по одному mode=throw).
export function solveStored (session, { maxAgeMin = 60 }: any = {}) {
  const list = storedThrows(session, { maxAgeMin })
  if (!list.length) return { stopped: `бросков в памяти за ${maxAgeMin} мин нет — mode=throw из двух точек в 30+ блоках друг от друга` }
  const sol = solve(list)
  if (!sol || !sol.best) return { stopped: 'броски из памяти не сходятся (разные крепости? броски из разных миров?)', throws: list.length }
  return report(session, sol, list.map(t => ({ from: t.from, bearingDeg: Number.isFinite(t.bearing) ? +(t.bearing * DEG).toFixed(3) : null, sigmaDeg: t.sigma ? +(t.sigma * DEG).toFixed(4) : null, flew: t.flew, near: t.near })), { fromMemory: list.length })
}

// ------------------------------------------------------------------ слепой переход

// Без ока (оно в Аду не летит: findNearestMapStructure в Аду — null) выйти из
// Ада там, где до ближайшей крепости первого кольца ближе всего. Монте-Карло по
// генератору колец (2026-09-26, 200 000 раскладок, сдвиг к биому — равномерно в
// круге 112): ожидаемое расстояние до ближайшей крепости от точки выхода на
// радиусе d от 0,0 —
const BLIND_TABLE = [
  // [d, E, медиана, 90%, P(<500)]
  [0, 1725, 1725, 2560, 0], [1200, 1213, 1249, 1732, 0.053], [1400, 1140, 1169, 1718, 0.096],
  [1600, 1097, 1104, 1735, 0.131], [1700, 1088, 1085, 1755, 0.144], [1800, 1089, 1078, 1782, 0.154],
  [1900, 1099, 1086, 1814, 0.154], [2000, 1117, 1102, 1855, 0.149], [2200, 1179, 1165, 1948, 0.133],
  [2400, 1272, 1261, 2059, 0.105], [2600, 1392, 1382, 2185, 0.072], [2800, 1532, 1523, 2321, 0.040]
]
const BLIND_R = 1750

export function blindExpect (d) {
  const T = BLIND_TABLE
  if (d <= T[1][0]) {
    const a = T[0]; const b = T[1]; const f = d / b[0]
    return Math.round(a[1] + (b[1] - a[1]) * f)
  }
  for (let i = 1; i < T.length - 1; i++) {
    if (d <= T[i + 1][0]) {
      const a = T[i]; const b = T[i + 1]; const f = (d - a[0]) / (b[0] - a[0])
      return Math.round(a[1] + (b[1] - a[1]) * f)
    }
  }
  const z = T[T.length - 1]
  return Math.round(z[1] + (d - z[0]) * 0.7)
}

// Куда идти в Аду для слепого выхода: по своему лучу от 0,0 на радиус 1750
// верхнего мира (218 в Аду). pos — где тело, world — его мир.
export function blindPlan (pos, world = 'the_nether') {
  const k = world === 'the_nether' ? 8 : 1
  const ox = pos.x * k
  const oz = pos.z * k
  const r = Math.hypot(ox, oz)
  const a = r > 16 ? Math.atan2(ox, oz) : Math.PI / 2
  const over = { x: Math.round(Math.sin(a) * BLIND_R), z: Math.round(Math.cos(a) * BLIND_R) }
  const nether = { x: Math.floor(over.x / 8), z: Math.floor(over.z / 8) }
  const walkNether = Math.round(Math.hypot(pos.x * k / 8 - nether.x, pos.z * k / 8 - nether.z))
  const now = blindExpect(r)
  const then = blindExpect(BLIND_R)
  return {
    overworld: over,
    nether,
    fromOriginNow: Math.round(r),
    expectNow: now,
    expectThere: then,
    gain: now - then,
    walkNether,
    note: `Слепой выход: Ад ${nether.x},${nether.z} = верх ${over.x},${over.z} (радиус ${BLIND_R}). До ближайшей крепости ` +
      `первого кольца оттуда в среднем ~${then} бл. (15% — ближе 500), отсюда ~${now}. Идти по Аду ${walkNether} бл. ` +
      'Там построить портал (mc_portal mode=link x,z), выйти и бросать око.'
  }
}
