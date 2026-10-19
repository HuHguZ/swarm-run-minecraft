'use strict'
// Колизей (часть colosseum.ts): каркас модели — параметры, дуги пролётов, сетка, колонки (геометрия на центр клетки),
// выборки по кольцам и общие помощники этапов. Возвращает контекст, из которого этапы (stages.ts) берут нужное по имени.
import { params, foot, arcTable } from './geometry'
import { Grid } from './grid'

function frame (opts: any) {
  const p = params(opts)
  const { R, A1, B1, K } = p
  const tab = arcTable(A1, B1)
  const Fd = p.F // длина дуги пролётов меряется по внешней грани стены
  const PF = tab.P(Fd)
  const L = PF / p.bays
  const u0 = tab.u(Math.PI / 2, Fd) // арка 0 — юг (малая ось, пульвинар)
  const uF = t => tab.u(t, Fd) - u0
  const tBay = b => tab.tAt(u0 + b * L, Fd) // центр пролёта b
  const tEdge = b => tab.tAt(u0 + (b + 0.5) * L, Fd) // граница b | b+1 (колонна)
  const bayT = []; const edgeT = []
  for (let b = 0; b < p.bays; b++) { bayT.push(tBay(b)); edgeT.push(tEdge(b)) }
  // Знаковая дуга от t1 к t2 по кривой на расстоянии d (кратчайшая).
  const arc = (t1, t2, d) => {
    const P = tab.P(d)
    let v = tab.u(t2, d) - tab.u(t1, d)
    v -= Math.round(v / P) * P
    return v
  }

  const X0 = -(p.outA + 3); const Z0 = -(p.outB + 3)
  const DY0 = -3; const DY1 = Math.max(42, p.ceilH + 2)
  const g: any = new Grid(X0, -X0, DY0, DY1, Z0, -Z0)

  // Колонки: геометрия на центр клетки.
  const cols = new Map() // key → { x, z, t, n, N, T, k, b, v }
  const key = (x, z) => x * 4096 + z
  for (let x = g.x0; x <= g.x1; x++) {
    for (let z = g.z0; z <= g.z1; z++) {
      const f = foot(A1, B1, x, z)
      if (f.n > p.F + 4) continue
      const k = Math.floor(f.n)
      const ub = uF(f.t)
      let b = Math.round(ub / L) % p.bays; if (b < 0) b += p.bays
      const d = Math.max(0, f.n)
      const v = arc(bayT[b], f.t, d)
      cols.set(key(x, z), { x, z, t: f.t, n: f.n, N: f.N, T: f.T, k, b, v })
    }
  }
  const ring = k => [...cols.values()].filter(c => c.k === k)
  // Клетки вдоль нормали эллипса в точке t от n0 до n1 (4-связная цепочка).
  const radial = (t, n0, n1) => {
    const ex = A1 * Math.cos(t); const ez = B1 * Math.sin(t)
    const nx0 = B1 * Math.cos(t); const nz0 = A1 * Math.sin(t); const nl = Math.hypot(nx0, nz0)
    const out = new Set(); let px = null; let pz = null
    for (let d = n0; d <= n1; d += 0.05) {
      const x = Math.round(ex + d * nx0 / nl); const z = Math.round(ez + d * nz0 / nl)
      if (px !== null && x !== px && z !== pz) out.add(key(x, pz))
      out.add(key(x, z)); px = x; pz = z
    }
    return out
  }
  // Ближайшая к радиальной линии t клетка кольца k (одна на цель — колонна,
  // фонарь, окно не пропадают на диагоналях).
  const nearestIn = (list, t, d) => {
    let best = null; let bd = Infinity
    for (const c of list) { const v = Math.abs(arc(t, c.t, d)); if (v < bd) { bd = v; best = c } }
    return best
  }
  const pick = (k, ts) => { const list = ring(k); return ts.map(t => nearestIn(list, t, k + 0.5)) }

  const S = (x, y, z, s) => g.set(x, y, z, s)
  const inField = (x, z) => Math.abs(x) <= R && Math.abs(z) <= R
  const cheb = (x, z) => Math.max(Math.abs(x), Math.abs(z))
  const onLine = v => ((Math.abs(v) % 8) + 8) % 8 === 4

  // Особые места: ворота (большая ось, пролёты bays/4 и 3·bays/4), ложи
  // (малая ось: юг — пульвинар, север — ложа напротив).
  const Q = p.bays / 4
  const gateBays = new Set([Q, 3 * Q])
  const isGate = c => Math.abs(c.z) <= 1 && Math.abs(c.x) > R + 2 && c.k <= K.m3[1]
  const boxHalf = 6 // ложи: |dx| ≤ 6
  const inBox = c => Math.abs(c.x) <= boxHalf && c.k >= -2 && c.k <= K.m1[1]

  const stats: Record<string, any> = { bays: p.bays, L: +L.toFixed(3) }

  // Общее для этапов: колонка блоков, колонны на границах пролётов, навесное (ставится в конце).
  const colFill = (x, z, y0, y1, s) => { for (let y = y0; y <= y1; y++) S(x, y, z, s) }
  const colT = edgeT // колонны на границах пролётов
  const attached = [] // висячие/стоящие на чём-то — в конце
  return {
    p, R, A1, B1, K, tab, Fd, PF, L, u0, uF, tBay, tEdge, bayT, edgeT, arc, X0, Z0, DY0, DY1, g, cols, key, ring, radial,
    nearestIn, pick, S, inField, cheb, onLine, Q, gateBays, isGate, boxHalf, inBox, stats, colFill, colT, attached
  }
}
type ModelCtx = ReturnType<typeof frame>

export { frame }
export type { ModelCtx }
