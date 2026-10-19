'use strict'
// Поиск крепости (stronghold.ts): решатель по лучам бросков (кандидаты-чанки, правдоподобие), память бросков, итог в журнал.
import * as gameClock from '../game-clock'
import { countOf } from '../items'
import { Vec3 } from 'vec3'
import {
  DEG, EYE_REACH, PLACE, POS_ERR, SIGMA_MIN, bearingOf, farTable, flat, nearestFactor, r1, ringDensity, ringOf, wrap
} from './rings'


// ------------------------------------------------------------------ решатель

// Бросок в виде, который ест решатель (и который лежит в памяти eyeThrows).
export function asRay (t) {
  if (!t) return null
  const from = t.start || t.from
  if (!from) return null
  if (t.near && t.corner) return { from, near: true, corner: t.corner }
  if (!Number.isFinite(t.bearing)) return null
  return { from, bearing: t.bearing, sigma: t.sigma || Math.max(SIGMA_MIN, POS_ERR * Math.SQRT2 / Math.max(1, t.flew || EYE_REACH)) }
}

// Углы чанков у лучей: вдоль каждого луча шагом 4 блока, по 4 угла сетки
// вокруг точки. Настоящий угол лежит на луче с точностью σ·дальность (доли
// блока), так что он всегда среди них.
export function candidates (rays, { maxDist = 9000, step = 4 }: any = {}) {
  const seen = new Map()
  for (const t of rays) {
    if (t.near) continue
    const dx = Math.sin(t.bearing)
    const dz = Math.cos(t.bearing)
    for (let s = EYE_REACH - 1; s <= maxDist; s += step) {
      const qx = t.from.x + dx * s
      const qz = t.from.z + dz * s
      const x0 = Math.floor(qx / 16) * 16
      const z0 = Math.floor(qz / 16) * 16
      for (const cx of [x0, x0 + 16]) {
        for (const cz of [z0, z0 + 16]) {
          const k = `${cx},${cz}`
          if (!seen.has(k)) seen.set(k, { x: cx, z: cz })
        }
      }
    }
  }
  return [...seen.values()]
}

// Точка наименьших квадратов по лучам (веса — 1/(σ·дальность)²): сырое
// пересечение, без сетки. Сверка: угол чанка рядом с ней — всё сошлось.
export function lsPoint (rays, guess) {
  const far = rays.filter(t => !t.near)
  if (far.length < 2) return null
  let c = guess
  for (let it = 0; it < 4; it++) {
    let a11 = 0; let a12 = 0; let a22 = 0; let b1 = 0; let b2 = 0
    for (const t of far) {
      const nx = Math.cos(t.bearing)
      const nz = -Math.sin(t.bearing)
      const dist = c ? Math.max(32, flat(c, t.from)) : 1000
      const w = 1 / Math.pow(t.sigma * dist, 2)
      const k = nx * t.from.x + nz * t.from.z
      a11 += w * nx * nx; a12 += w * nx * nz; a22 += w * nz * nz; b1 += w * nx * k; b2 += w * nz * k
    }
    const det = a11 * a22 - a12 * a12
    if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return null
    c = { x: (b1 * a22 - b2 * a12) / det, z: (a11 * b2 - a12 * b1) / det }
  }
  return c
}

// Решение по броскам. Ответ: best {x, z, p, dist, ring, fromOrigin, stairs},
// другие кандидаты (top), сырое пересечение ls, невязки лучшего в градусах.
export function solve (throws, { maxDist = 9000, top = 5, nearest = true }: any = {}) {
  const rays = throws.map(asRay).filter(Boolean)
  if (!rays.length) return null
  const last = rays[rays.length - 1]
  const near = rays.find(t => t.near)
  const dress = (c, p) => ({
    x: c.x,
    z: c.z,
    p: +p.toFixed(4),
    dist: Math.round(flat(c, last.from)),
    fromOrigin: Math.round(Math.hypot(c.x + 8, c.z + 8)),
    ring: ringOf(Math.hypot(c.x + 8, c.z + 8)),
    stairs: { x: c.x + 4, z: c.z + 4 }
  })
  if (near) {
    return { throws: rays.length, best: dress(near.corner, 1), top: [], near: true, note: 'око ушло вниз: угол чанка старта ближе 12 блоков, он и есть ответ' }
  }
  const cands = candidates(rays, { maxDist })
  const far = nearest ? farTable(rays[0].from, maxDist + 200) : null
  let max = -Infinity
  for (const c of cands) {
    let ll = 0
    for (const t of rays) {
      const d = flat(c, t.from)
      // Око ушло вверх — угол дальше 12 блоков от точки броска.
      if (d < EYE_REACH - 0.5) { ll = -Infinity; break }
      const e = wrap(bearingOf(t.from, c) - t.bearing) / t.sigma
      ll -= 0.5 * e * e
    }
    c.lp = ll + Math.log(ringDensity(Math.hypot(c.x + 8, c.z + 8))) + (nearest ? Math.log(nearestFactor(c, rays[0].from, far)) : 0)
    if (c.lp > max) max = c.lp
  }
  if (!Number.isFinite(max)) return { throws: rays.length, best: null, top: [], note: 'ни один угол чанка не согласуется с бросками' }
  let sum = 0
  for (const c of cands) { c.w = Math.exp(c.lp - max); sum += c.w }
  for (const c of cands) c.p = c.w / sum
  cands.sort((a, b) => b.p - a.p)
  const best = cands[0]
  const out: any = {
    throws: rays.length,
    best: dress(best, best.p),
    top: cands.slice(1, top).filter(c => c.p > 0.001).map(c => dress(c, c.p)),
    residualDeg: rays.map(t => +(wrap(bearingOf(t.from, best) - t.bearing) * DEG).toFixed(4)),
    sigmaDeg: rays.map(t => +(t.sigma * DEG).toFixed(4)),
    candidates: cands.length
  }
  // Один бросок: вдоль луча — распределение дальности (для решения «идти или
  // бросать ещё», и для слепого решения — где кольцо).
  if (rays.length === 1) {
    const ds = cands.filter(c => c.p > 1e-4).map(c => ({ d: flat(c, last.from), p: c.p })).sort((a, b) => a.d - b.d)
    let acc = 0
    const q = f => { acc = 0; for (const x of ds) { acc += x.p; if (acc >= f) return Math.round(x.d) } return ds.length ? Math.round(ds[ds.length - 1].d) : null }
    out.range = { p10: q(0.1), p50: q(0.5), p90: q(0.9) }
  }
  const ls = lsPoint(rays, best)
  if (ls) {
    out.ls = { x: r1(ls.x), z: r1(ls.z), offCorner: r1(flat(ls, best)) }
  }
  return out
}

// Старое пересечение двух лучей (для совместимости и сцен).
export function intersect (p1, b1, p2, b2) {
  const d1 = { x: Math.sin(b1), z: Math.cos(b1) }
  const d2 = { x: Math.sin(b2), z: Math.cos(b2) }
  const den = d1.x * d2.z - d1.z * d2.x
  if (Math.abs(den) < 1e-9) return null
  const t = ((p2.x - p1.x) * d2.z - (p2.z - p1.z) * d2.x) / den
  if (t < 0) return null
  return { x: Math.round(p1.x + d1.x * t), z: Math.round(p1.z + d1.z * t), dist: Math.round(t) }
}

// ------------------------------------------------------------------ память

export function rememberThrow (session, t) {
  const ray = asRay(t)
  if (!ray) return
  session.journal.patch(s => {
    const list = Array.isArray(s.eyeThrows) ? s.eyeThrows : []
    list.push({ ms: gameClock.now(), ...ray, flew: t.flew })
    s.eyeThrows = list.slice(-8)
  })
}

// Броски из памяти моложе maxAgeMin (для mode=solve: мозг бросал сам по одному).
export function storedThrows (session, { maxAgeMin = 60 }: any = {}) {
  const list = (session.journal.state && session.journal.state.eyeThrows) || []
  const since = gameClock.now() - maxAgeMin * 60000
  return list.filter(t => t && t.ms >= since)
}

function save (session, sol) {
  const c = sol.best
  const refined = c.p >= 0.95
  const rec = {
    x: c.x,
    y: 30,
    z: c.z,
    dimension: 'overworld',
    refined,
    p: c.p,
    stairs: c.stairs,
    note: refined
      ? `угол стартового чанка по оку (p=${c.p}): лестница старта x+2..x+6, z+2..z+6 — копать у ${c.stairs.x},${c.stairs.z}`
      : `по оку, неточно (p=${c.p}): у места бросить ещё одно око`
  }
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[PLACE] = { ...rec }
  })
  session.journal.append(PLACE, `по оку эндера: угол чанка ${c.x}, ${c.z} (p=${c.p}, ${c.dist} бл.)`, session.bot.entity.position)
  return rec
}

export function report (session, sol, throws, extra: any = {}) {
  const c = sol.best
  const rec = save(session, sol)
  return {
    stronghold: { x: c.x, z: c.z },
    // То же под именем, которое читает директор и кампания (memo.stronghold ← detail.at).
    at: { x: c.x, y: rec.y, z: c.z },
    stairs: c.stairs,
    p: c.p,
    refined: rec.refined,
    dist: c.dist,
    distFromFirst: throws[0] && throws[0].from ? Math.round(flat(c, throws[0].from)) : undefined,
    ring: c.ring,
    fromOrigin: c.fromOrigin,
    others: sol.top && sol.top.length ? sol.top.map(o => ({ x: o.x, z: o.z, p: o.p })) : undefined,
    ls: sol.ls,
    residualDeg: sol.residualDeg,
    throws: throws.map(t => ({ from: t.from, bearingDeg: t.bearingDeg, sigmaDeg: t.sigmaDeg, flew: t.flew, near: t.near || undefined, broke: t.broke || undefined, lost: t.lost || undefined })),
    eyesLeft: throws.length ? throws[throws.length - 1].eyesLeft : countOf(session.bot, 'ender_eye'),
    note: rec.refined
      ? `Крепость: угол чанка ${c.x},${c.z} (p=${c.p}), лестница старта у ${c.stairs.x},${c.stairs.z}, ${c.dist} бл. отсюда. ` +
        `Дальше mc_stronghold mode=go (копать у лестницы) или mode=travel (через Ад, если далеко).`
      : `Крепость примерно у ${c.x},${c.z} (p=${c.p}) — не уверен: брось ещё око из другой точки (mode=throw, потом mode=solve).`,
    ...extra
  }
}

// ------------------------------------------------------------------ find

// Суша ли в колонке (x, z) около высоты y: первый непустой блок сверху вниз —
// не вода и не лава. Непрогруженная колонка — «не знаю», то есть нет.
export function dryAt (bot, x, z, y) {
  for (let yy = y + 8; yy >= y - 12; yy--) {
    const b = bot.blockAt(new Vec3(x, yy, z))
    if (!b) return false
    if (b.boundingBox === 'empty' && !/water|lava|bubble/.test(b.name)) continue
    return !/water|lava|bubble|kelp|seagrass/.test(b.name)
  }
  return false
}
