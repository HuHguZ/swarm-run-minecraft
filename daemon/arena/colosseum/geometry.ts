'use strict'
// Колизей (часть colosseum.ts): параметры постройки и геометрия эллипса арены.

// ---------------------------------------------------------------- параметры

const DEFAULTS = {
  R: 24, // полуширина поля (ARENA_R)
  bays: 80, // арок по кругу (кратно 4: оси — центры арок)
  bExtra: 11, // малая полуось арены = R + bExtra
  cornerGap: 4, // угол бордюра поля (R+2) отстоит от подиума внутрь эллипса
  ceilH: 16, // потолок-барьер над полем (dy), ARENA_CEIL_H
  masts: 2, // мачта веллария на каждой 2-й пилястре
  banner: 'red', // флаги на мачтах
  version: 1
}

function params (opts: any = {} as Record<string, any>) {
  const p: Record<string, any> = { ...DEFAULTS, ...opts }
  p.R = Math.round(p.R)
  p.B1 = p.R + p.bExtra
  const c = p.R + p.cornerGap
  p.A1 = Math.ceil(Math.sqrt(c * c / (1 - (c * c) / (p.B1 * p.B1))))
  // Кольца (floor(n) от внутренней грани подиума).
  p.K = {
    parapet: 0, terrace: [1, 3], m1: [4, 7], p1: [8, 9], m2: [10, 14], p2: [15, 16], m3: [17, 21],
    gallery: [22, 24], wall: [25, 26], relief: 27, step1: 28, step2: 29
  }
  p.F = 27 // внешняя грань стены (n)
  p.outA = p.A1 + 30
  p.outB = p.B1 + 30
  return p
}

// ------------------------------------------------------- геометрия эллипса

// Ближайшая точка эллипса (a·cos t, b·sin t) к (x, z): t, знаковое расстояние
// n (+ снаружи), нормаль и касательная. Первая четверть — Ньютон со страховкой
// бисекцией (g(0) ≤ 0 ≤ g(π/2) для любой точки четверти).
function foot (a, b, x, z) {
  const px = Math.abs(x); const pz = Math.abs(z)
  const g = t => px * a * Math.sin(t) - pz * b * Math.cos(t) + (b * b - a * a) * Math.sin(t) * Math.cos(t)
  let lo = 0; let hi = Math.PI / 2
  let t = Math.atan2(a * pz, b * px)
  for (let i = 0; i < 60; i++) {
    const s = Math.sin(t); const c = Math.cos(t)
    const gv = px * a * s - pz * b * c + (b * b - a * a) * s * c
    if (gv > 0) hi = t; else lo = t
    const dg = px * a * c + pz * b * s + (b * b - a * a) * (c * c - s * s)
    let nt = dg > 1e-12 ? t - gv / dg : (lo + hi) / 2
    if (!(nt > lo && nt < hi)) nt = (lo + hi) / 2
    if (Math.abs(nt - t) < 1e-13) { t = nt; break }
    t = nt
  }
  if (g(0) === 0 && pz === 0) t = 0
  const ex = a * Math.cos(t); const ez = b * Math.sin(t)
  let n = Math.hypot(px - ex, pz - ez)
  if ((px * px) / (a * a) + (pz * pz) / (b * b) < 1) n = -n
  // В полный круг.
  let T = t
  if (x < 0 && z >= 0) T = Math.PI - t
  else if (x < 0 && z < 0) T = Math.PI + t
  else if (x >= 0 && z < 0) T = 2 * Math.PI - t
  if (T >= 2 * Math.PI) T -= 2 * Math.PI
  const nx0 = b * Math.cos(T); const nz0 = a * Math.sin(T); const nl = Math.hypot(nx0, nz0)
  const tx0 = -a * Math.sin(T); const tz0 = b * Math.cos(T); const tl = Math.hypot(tx0, tz0)
  return { t: T, n, N: [nx0 / nl, nz0 / nl], T: [tx0 / tl, tz0 / tl] }
}

// Длина дуги кривой, параллельной эллипсу на расстоянии d: s_d(t) = s(t) + d·φ(t),
// φ — угол нормали (∫κ ds = поворот нормали). Таблица по t.
function arcTable (a, b, M = 20000) {
  const s = new Float64Array(M + 1); const phi = new Float64Array(M + 1)
  const sp = t => Math.hypot(a * Math.sin(t), b * Math.cos(t))
  const h = 2 * Math.PI / M
  let prev = 0
  for (let i = 0; i <= M; i++) {
    const t = i * h
    if (i > 0) s[i] = s[i - 1] + h * (sp(t - h) + 4 * sp(t - h / 2) + sp(t)) / 6
    let f = Math.atan2(a * Math.sin(t), b * Math.cos(t))
    while (f < prev - Math.PI) f += 2 * Math.PI
    phi[i] = f; prev = f
  }
  const at = (arr, t) => {
    let tt = t % (2 * Math.PI); if (tt < 0) tt += 2 * Math.PI
    const x = tt / h; const i = Math.min(M - 1, Math.floor(x)); const f = x - i
    return arr[i] * (1 - f) + arr[i + 1] * f
  }
  const P0 = s[M]
  return {
    P: d => P0 + 2 * Math.PI * d,
    // s_d(t) от t = 0 (восток)
    u: (t, d) => at(s, t) + d * at(phi, t),
    // t по длине дуги на расстоянии d (бинпоиск)
    tAt: (u, d) => {
      const P = P0 + 2 * Math.PI * d
      let uu = u % P; if (uu < 0) uu += P
      let lo = 0; let hi = 2 * Math.PI
      for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (at(s, m) + d * at(phi, m) < uu) lo = m; else hi = m }
      return (lo + hi) / 2
    }
  }
}

export { DEFAULTS, params, foot, arcTable }
