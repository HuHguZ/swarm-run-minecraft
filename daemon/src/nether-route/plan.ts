'use strict'
// Ход по сетке Ада (nether-route.ts): план — A* по клеткам ног тела по сетке копии мира, цели и ноги пути.
import { performance } from 'node:perf_hooks'
import * as NG from '../nether-grid'
import * as gameClock from '../game-clock'
import { C, DIG, budgetOn } from './base'


// --- план ------------------------------------------------------------------------------------------------------
export const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const K = { FLAT: 0, UP: 1, DOWN: 2, VDOWN: 3, VUP: 4, BRIDGE: 5, DROP2: 6, DROP3: 7 }
const KIND = ['flat', 'up', 'down', 'vdown', 'vup', 'bridge', 'drop2', 'drop3']
const W = { walk: 0.25, up: 0.35, down: 0.1, vdown: 0.45, vup: 1.3, bridge: 1.4, drop: 0.3, expo: 0.8, open: 1.5, edge: 1.2, lava2: 0.8, lava1: 3.0, dig: 0.05 }

// Рабочие массивы поиска — по ёмкости (переиспользуются между планами; «поколение» вместо очистки). Поиск идёт в
// под-коробке сетки вокруг старта и цели (запас M по сторонам): сетка всех коридоров бывает 30–90 млн клеток.
function scratch (N) {
  const SCR = { cap: N, gen: 0, stamp: new Uint16Array(N), gc: new Float32Array(N), par: new Int32Array(N), kind: new Uint8Array(N), pil: new Uint8Array(N), closed: new Uint8Array(N) }
  SCR.gen = 1
  return SCR
}

class Heap {
  declare k: any
  declare v: any
  declare n: any

  constructor (cap = 1 << 16) { this.k = new Int32Array(cap); this.v = new Float32Array(cap); this.n = 0 }
  get size () { return this.n }
  push (key, val) {
    if (this.n >= this.k.length) {
      const k2 = new Int32Array(this.k.length * 2); k2.set(this.k); this.k = k2
      const v2 = new Float32Array(this.v.length * 2); v2.set(this.v); this.v = v2
    }
    const k = this.k; const v = this.v
    let i = this.n++
    while (i > 0) { const p = (i - 1) >> 1; if (v[p] <= val) break; k[i] = k[p]; v[i] = v[p]; i = p }
    k[i] = key; v[i] = val
  }
  pop () {
    const k = this.k; const v = this.v
    const top = k[0]
    const n = --this.n
    if (n > 0) {
      const lk = k[n]; const lv = v[n]
      let i = 0
      for (;;) {
        const l = 2 * i + 1; if (l >= n) break
        const r = l + 1
        const m = (r < n && v[r] < v[l]) ? r : l
        if (v[m] >= lv) break
        k[i] = k[m]; v[i] = v[m]; i = m
      }
      k[i] = lk; v[i] = lv
    }
    return top
  }
}

// Reject an impossible goal before allocating A* arrays. Radius/height tolerance
// is tested as a set: an unknown centre may still have a known reachable neighbour.
function targetStatus (g, goal, opts) {
  let known = false
  const r = Math.min(64, Math.max(0, Math.ceil(goal.r || 0)))
  const dy = Math.min(127, Math.max(0, Math.ceil(goal.dy || 0)))
  for (let x = goal.x - r; x <= goal.x + r; x++) for (let z = goal.z - r; z <= goal.z + r; z++) {
    if ((x - goal.x) ** 2 + (z - goal.z) ** 2 > r * r) continue
    for (let y = goal.y - dy; y <= goal.y + dy; y++) {
      const f = g.get(x, y, z); const h = g.get(x, y + 1, z)
      if (f === C.UNKNOWN || h === C.UNKNOWN) continue
      known = true
      if (f !== C.HOT && h !== C.HOT && Number.isFinite(DIG[f]) && Number.isFinite(DIG[h])) return null
    }
  }
  return known ? 'цель непроходима' : 'цель неизвестна/вне сетки'
}
export function legGoal (g, from, goal, opts: any = {}) {
  const dx = goal.x - from.x; const dz = goal.z - from.z; const dy = goal.y - from.y
  const d = Math.hypot(dx, dz)
  if (d <= 64 && Math.abs(dy) <= 48) return goal
  const t = Math.min(1, 56 / Math.max(1, d), 48 / Math.max(1, Math.abs(dy)))
  const mid = { x: Math.round(from.x + dx * t), y: Math.round(from.y + dy * t), z: Math.round(from.z + dz * t), r: 3, dy: 3 }
  if (!targetStatus(g, mid, opts)) return mid
  // A known frontier/corridor can replace an unknown point on the straight line.
  // This is a cheap local waypoint, not a claim that a global route exists.
  for (let back = 4; back <= 16; back += 4) {
    const t2 = t * (56 - back) / 56
    const q = { x: Math.round(from.x + dx * t2), y: Math.round(from.y + dy * t2), z: Math.round(from.z + dz * t2), r: 4, dy: 4 }
    if (!targetStatus(g, q, opts)) return q
  }
  return mid
}
export async function plan (g, from, goal, opts: any = {}) {
  if (!budgetOn()) return planFull(g, from, goal, opts)
  const t0 = performance.now()
  const maxMs = Math.max(1, Math.min(900, Number(opts.maxMs) || 900))
  const deadline = t0 + maxMs
  const fail = why2 => ({ ok: false, path: [], nodes: 0, ms: performance.now() - t0, why2 })
  if (![from.x, from.y, from.z, goal.x, goal.y, goal.z].every(Number.isFinite)) return fail('неверная цель')
  if (opts.alarm?.()) return fail('тревога')
  const invalid = targetStatus(g, goal, opts)
  if (invalid) return fail(invalid)
  const leg = legGoal(g, from, goal, opts)
  const margin = Math.min(32, opts.margin ?? 16)
  // A private local snapshot: concurrent prefetch/live grid.mark cannot mutate
  // an A* graph or overwrite shared scratch arrays. Copying is inside the budget.
  const x0 = Math.max(g.x0, Math.min(from.x, leg.x) - margin)
  const x1 = Math.min(g.x0 + g.sx - 1, Math.max(from.x, leg.x) + margin)
  const z0 = Math.max(g.z0, Math.min(from.z, leg.z) - margin)
  const z1 = Math.min(g.z0 + g.sz - 1, Math.max(from.z, leg.z) + margin)
  const snap = new NG.Grid(NG.headerOf([x0, g.y0, z0, x1, g.y0 + g.sy - 1, z1]))
  let lastYield = performance.now()
  for (let y = g.y0; y < g.y0 + g.sy; y++) for (let z = z0; z <= z1; z++) {
    snap.data.set(g.data.subarray(g.idx(x0, y, z), g.idx(x1, y, z) + 1), snap.idx(x0, y, z))
    if (performance.now() - lastYield >= 8) {
      await new Promise<any>(resolve => setImmediate(resolve)); lastYield = performance.now()
      if (opts.alarm?.()) return fail('тревога')
      if (lastYield >= deadline) return fail('бюджет снимка сетки')
    }
  }
  for (const m of opts.projected || []) {
    for (const [x, y, z] of m.dig) snap.setRaw(x, y, z, C.AIR)
    if (m.kind === 'bridge' || m.kind === 'vup') snap.setRaw(m.to.x, m.to.y - 1, m.to.z, C.STONE)
  }
  const result: any = await planFull(snap, from, leg, { ...opts, _deadline: deadline, _t0: t0, maxNodes: Math.min(250000, Math.max(1, opts.maxNodes ?? 250000)), margin, weight: 1, partial: opts.partial !== false })
  result.ms = performance.now() - t0
  result.leg = leg
  result.more = !!result.path.length && (leg !== goal || result.limit)
  if (leg !== goal) result.ok = false
  if (result.path.length > 64) {
    result.path = result.path.slice(0, 64)
    result.end = result.path.at(-1).to
    result.steps = result.path.length
    result.digs = result.path.reduce((n, m) => n + m.dig.length, 0)
    result.expo = result.path.filter(m => m.expo).length
    result.placed = result.path.filter(m => m.kind === 'bridge' || m.kind === 'vup').length
    result.cost = Math.round(result.path.reduce((n, m) => n + m.cost, 0) * 10) / 10
    result.ok = false; result.more = true
  }
  return result
}

// from — клетка ног {x,y,z}; goal — {x, y, z, r (по горизонтали, по умолчанию 0), dy (допуск по высоте, 0)}.
// opts: maxNodes, weight (эвристика), blocks (сколько можно поставить: мост, столб), fireproof (пол из магмы), partial.
async function planFull (g, from, goal, opts: any = {}) {
  // Гаст в виду (opts.expoMul, routeTo) — открытые шаги дороже: штрек в толще вместо прогулки под шарами (s1-LB-3/LB-4 06.10:
  // «fireballed by Ghast» на 3–4-й мин подхода к крепости; post27/post32 — лава после отбрасывания гастом).
  const EXPO = W.expo * (opts.expoMul || 1); const OPEN_W = W.open * (opts.expoMul || 1)
  const t0 = gameClock.wall.now()
  const bounded = opts._deadline != null
  const deadline = opts._deadline ?? Infinity
  let lastYield = performance.now()
  const maxNodes = opts.maxNodes || 2500000
  const Wh = opts.weight || 3.5
  const blocks = Math.min(250, opts.blocks ?? 16)
  const digWaitSeconds = Number.isFinite(opts.digWaitSeconds) ? Math.max(0, opts.digWaitSeconds) : 0
  const gr = goal.r ?? 0; const gdy = goal.dy ?? 0
  const GX = goal.x; const GY = goal.y; const GZ = goal.z
  const isGoal = (x, y, z) => Math.abs(y - GY) <= gdy && (gr ? ((x - GX) * (x - GX) + (z - GZ) * (z - GZ) <= gr * gr) : (x === GX && z === GZ))
  let potential = null
  // max(horizontal lower bound, vertical lower bound): descending 3 blocks in
  // one drop costs walk+drop=0.55; adding the bounds would overestimate it.
  const h = (x, y, z) => bounded
    ? Math.max(potential ? potential[(z - z0) * sx + x - x0] : Math.max(0, Math.abs(x - GX) + Math.abs(z - GZ) - gr * Math.SQRT2) * W.walk, Math.max(0, Math.abs(y - GY) - gdy) * .1)
    : Wh * ((Math.abs(x - GX) + Math.abs(z - GZ)) * 0.3 + Math.abs(y - GY) * 0.35)
  if (!g.inside(from.x, from.y, from.z)) return { ok: false, why: 'старт вне сетки', nodes: 0, path: [] }
  const data = g.data
  const gin = (x, y, z) => x >= g.x0 && y >= g.y0 && z >= g.z0 && x < g.x0 + g.sx && y < g.y0 + g.sy && z < g.z0 + g.sz
  const gidx = (x, y, z) => ((y - g.y0) * g.sz + (z - g.z0)) * g.sx + (x - g.x0)
  const get = (x, y, z) => gin(x, y, z) ? data[gidx(x, y, z)] : (y < 0 || y > 127 ? C.HARD : C.UNKNOWN)
  const pass = (x, y, z) => { const c = get(x, y, z); return c === C.AIR || c === C.PASS }
  // Под-коробка поиска: старт и цель плюс запас M (обходы шире прямой — до M в сторону).
  const M = opts.margin ?? 56
  const x0 = Math.max(g.x0, Math.min(from.x, GX) - M); const x1 = Math.min(g.x0 + g.sx - 1, Math.max(from.x, GX) + M)
  const z0 = Math.max(g.z0, Math.min(from.z, GZ) - M); const z1 = Math.min(g.z0 + g.sz - 1, Math.max(from.z, GZ) + M)
  const y0 = g.y0; const sy = g.sy
  const sx = x1 - x0 + 1; const sz = z1 - z0 + 1
  const inside = (x, y, z) => x >= x0 && y >= y0 && z >= z0 && x <= x1 && y < y0 + sy && z <= z1
  const idx = (x, y, z) => ((y - y0) * sz + (z - z0)) * sx + (x - x0)
  const S = scratch(sx * sy * sz)
  const { stamp, gc, par, kind: kindA, pil, closed } = S
  const lava = g.lavaMemo || (g.lavaMemo = new Uint8Array(g.sx * g.sy * g.sz))
  const gen = S.gen
  const lava1 = (x, y, z) => {
    if (!gin(x, y, z)) return true
    const i = gidx(x, y, z)
    const m = lava[i]
    if (m) return m === 2
    let v = false
    for (let dx = -1; dx <= 1 && !v; dx++) for (let dy = -1; dy <= 1 && !v; dy++) for (let dz = -1; dz <= 1 && !v; dz++) if (get(x + dx, y + dy, z + dz) === C.LAVA) v = true
    lava[i] = v ? 2 : 1
    return v
  }
  const L2 = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [2, -2], [-2, 2], [-2, -2]]
  const lava2 = (x, y, z) => {
    for (const [dx, dz] of L2) for (let dy = -2; dy <= 1; dy++) if (get(x + dx, y + dy, z + dz) === C.LAVA) return true
    return get(x, y - 2, z) === C.LAVA
  }
  const OPEN = [[3, 1, 0], [-3, 1, 0], [0, 1, 3], [0, 1, -3], [2, 1, 2], [-2, 1, -2], [2, 1, -2], [-2, 1, 2], [0, 4, 0], [0, -2, 3]]
  const open = (x, y, z) => { let n = 0; for (const [dx, dy, dz] of OPEN) if (pass(x + dx, y + dy, z + dz)) n++; return n >= 6 }
  const edge = (x, y, z) => {
    for (const [dx, dz] of DIRS) {
      if (!pass(x + dx, y, z + dz) || !pass(x + dx, y - 1, z + dz)) continue
      let d = 1
      while (d < 8 && pass(x + dx, y - d, z + dz)) d++
      if (d >= 3) return true
    }
    return false
  }
  const why = { lava: 0, hard: 0, floor: 0, fall: 0, unknown: 0 }
  const digCost = (x, y, z) => {
    const c = get(x, y, z)
    if (c === C.AIR) return 0
    if (c === C.PASS) return DIG[C.PASS]
    if (c === C.UNKNOWN) { why.unknown++; return Infinity }
    if (c === C.LAVA || c === C.HOT) { why.lava++; return Infinity }
    const d = DIG[c]
    if (d === Infinity) { why.hard++; return Infinity }
    // Над вскрытой клеткой гравий — посыплется в ход.
    const up = get(x, y + 1, z)
    if (up === C.FALL) { why.fall++; return Infinity }
    // Вскрыть клетку у лавы (сбоку или сверху) — лава потечёт в ход.
    if (up === C.LAVA || get(x + 1, y, z) === C.LAVA || get(x - 1, y, z) === C.LAVA || get(x, y, z + 1) === C.LAVA || get(x, y, z - 1) === C.LAVA) { why.lava++; return Infinity }
    return d + W.dig + digWaitSeconds
  }
  const floorGood = (x, y, z) => { const c = get(x, y, z); return c === C.MAGMA ? !!opts.fireproof : NG.floorOk(c) }
  const SOLIDF = new Set([C.SOFT, C.STONE, C.SLOW, C.SOULSAND, C.HARD, C.GUARD])
  const ZS = [...(Array.isArray(opts.zone) && opts.zone.length === 6 ? [opts.zone] : []), ...(Array.isArray(opts.zones) ? opts.zones.filter(z => Array.isArray(z) && z.length === 6) : [])]
  const ZX = opts.zoneExpo ?? 4
  // Места брутов (копия мира): в 12 бл. по горизонтали и 6 по высоте — открытое +10, в толще +1.5.
  const DG = Array.isArray(opts.dangers) ? opts.dangers.filter(d => Math.hypot(d[0] - (from.x + GX) / 2, d[2] - (from.z + GZ) / 2) < Math.hypot(from.x - GX, from.z - GZ) / 2 + 60) : []
  // Горячие коробки [x0,y0,z0,x1,y1,z1,цена] — открытое в них дороже (помост открытого тронного зала: иссушители, D6-26).
  const HOT = Array.isArray(opts.hot) ? opts.hot.filter(b => Array.isArray(b) && b.length === 7) : []
  const rememberedBrutes = process.env.ND_BRUTE_MEMORY === '1'
  const danger = (x, y, z, ex) => {
    let cost = 0
    for (const d of DG) {
      if (Math.abs(d[1] - y) > (rememberedBrutes ? 8 : 6)) continue
      const distance = Math.hypot(d[0] - x, d[2] - z)
      if (distance >= (rememberedBrutes ? 16 : 12)) continue
      if (!rememberedBrutes) return ex ? (d[3] ?? 10) : 1.5
      const weight = distance <= 13 ? 1 : (16 - distance) / 3
      cost = Math.max(cost, weight * (ex ? (d[3] ?? 16) : 1.5))
    }
    return cost
  }
  if (bounded) {
    const col = await columnPotential({ x0, x1, z0, z1, sx, sz, y0, sy, GX, GZ, gr, get, pass, floorGood, open, edge, danger,
      blocks, EXPO, OPEN_W, ZS, ZX, HOT, DG, digWaitSeconds, from }, opts, deadline, lastYield)
    lastYield = col.lastYield
    if (col.stop) return col.stop
    potential = col.potential
  }
  const heap = new Heap()
  const k0 = idx(from.x, from.y, from.z)
  stamp[k0] = gen; gc[k0] = 0; par[k0] = -1; kindA[k0] = 255; pil[k0] = 0; closed[k0] = 0
  heap.push(k0, h(from.x, from.y, from.z))
  let found = -1; let visited = 1
  let best = k0; let bestH = h(from.x, from.y, from.z)
  const sxz = sx * sz
  let cx = 0; let cy = 0; let cz = 0; let cg = 0; let cur = 0
  const tryMove = (nx, ny, nz, kind, cells, extra, usesBlock) => {
    if (!inside(nx, ny, nz)) return
    let cost = extra
    for (let i = 0; i < cells.length; i += 3) { const d = digCost(cells[i], cells[i + 1], cells[i + 2]); if (d === Infinity) return; cost += d }
    if (kind === K.BRIDGE) {
      // Мост: пол — воздух, ставим блок; под ним 2 клетки — не лава.
      if (get(nx, ny - 2, nz) === C.LAVA || get(nx, ny - 3, nz) === C.LAVA) { why.lava++; return }
    } else if (kind !== K.VUP && !floorGood(nx, ny - 1, nz)) { why.floor++; return }
    // Лава в кубе 3×3×3 у ног или головы — дорого (оступиться, отбросит), но не запрет: у портала прибытия бывает лава
    // рядом, и отойти от неё надо (neF-B1f25-1 03.10: ни одного хода — «пути нет» в 1 узел).
    const near1 = lava1(nx, ny, nz) || lava1(nx, ny + 1, nz)
    if (near1) cost += W.lava1
    const nk = idx(nx, ny, nz)
    const np = pil[cur] + (usesBlock ? 1 : 0)
    if (np > blocks) return
    if (stamp[nk] === gen && (closed[nk] || gc[nk] <= cg + cost)) return
    if (lava2(nx, ny, nz)) cost += W.lava2
    // Открыто: грань ног/головы касается воздуха, который не наш ход (не прежняя клетка тела).
    let expo = false
    for (let q = 0; q < 4 && !expo; q++) {
      const ax = nx + DIRS[q][0]; const az = nz + DIRS[q][1]
      if (ax === cx && az === cz) continue
      if (pass(ax, ny, az) || pass(ax, ny + 1, az)) expo = true
    }
    if (!expo && !(nx === cx && nz === cz) && pass(nx, ny + 2, nz)) expo = true
    if (expo) {
      cost += EXPO
      if (open(nx, ny, nz)) cost += OPEN_W
      if (edge(nx, ny, nz)) cost += W.edge
      // Зоны (бастион: двор с брутами и злыми пиглинами) — открытое там втридорога, идём сквозь стены.
      for (let zi = 0; zi < ZS.length; zi++) { const Z = ZS[zi]; if (nx >= Z[0] && nx <= Z[3] && ny >= Z[1] && ny <= Z[4] && nz >= Z[2] && nz <= Z[5]) { cost += ZX; break } }
      for (let hi = 0; hi < HOT.length; hi++) { const Z = HOT[hi]; if (nx >= Z[0] && nx <= Z[3] && ny >= Z[1] && ny <= Z[4] && nz >= Z[2] && nz <= Z[5]) { cost += Z[6]; break } }
    }
    if (DG.length) cost += danger(nx, ny, nz, expo)
    const ng = cg + cost
    if (stamp[nk] === gen && gc[nk] <= ng) return
    if (stamp[nk] !== gen) {
      if (bounded && visited >= maxNodes) return
      visited++
    }
    stamp[nk] = gen; gc[nk] = ng; par[nk] = cur; kindA[nk] = kind; pil[nk] = np; closed[nk] = 0
    heap.push(nk, ng + h(nx, ny, nz))
  }
  let pops = 0; let budgetLimit = false
  while (heap.size) {
    cur = heap.pop()
    if (closed[cur]) continue
    closed[cur] = 1
    // Не держать цикл событий дольше ~0.1 с: физика, пакеты, keep-alive (план бывает 2–8 с).
    if (bounded ? (++pops % 64 === 0 && performance.now() - lastYield >= (opts.yieldMs ?? 8)) : (++pops & 0xffff) === 0) {
      const cc = cur; const g0 = gen
      await new Promise<any>(resolve => setImmediate(resolve))
      lastYield = performance.now()
      if (S.gen !== g0) return { ok: false, why2: 'план перебит другим', nodes: visited, path: [] }
      // Тревога стража (удар/брут вплотную) посреди долгого плана — бросить план, ответить (VR23-1: брут бил 8 с, пока считался план).
      if (opts.alarm && opts.alarm()) return { ok: false, why2: 'тревога', nodes: visited, path: [] }
      cur = cc
    }
    cx = x0 + (cur % sx); cz = z0 + (Math.floor(cur / sx) % sz); cy = y0 + Math.floor(cur / sxz)
    cg = gc[cur]
    const x = cx; const y = cy; const z = cz
    // solidFloor: стоять на полном блоке (не на заборе/ступени — B7f22 03.10: с верха забора у зала тело сорвалось к
    // иссушителям); свой блок (столб, мост) — полный.
    if (isGoal(x, y, z) && (!opts.solidFloor || kindA[cur] === K.VUP || kindA[cur] === K.BRIDGE || SOLIDF.has(get(x, y - 1, z)))) { found = cur; break }
    const hh = h(x, y, z)
    if (hh < bestH) { bestH = hh; best = cur }
    if (bounded && (visited >= maxNodes || performance.now() >= deadline)) { budgetLimit = true; break }
    if (visited > maxNodes) break
    for (let q = 0; q < 4; q++) {
      const fx = x + DIRS[q][0]; const fz = z + DIRS[q][1]
      const fl = get(fx, y - 1, fz)
      const airFloor = fl === C.AIR || fl === C.PASS
      if (!airFloor) tryMove(fx, y, fz, K.FLAT, [fx, y + 1, fz, fx, y, fz], W.walk, false)
      else {
        // Пол впереди — воздух: спрыгнуть на 2–3 (урон от падения — с 4: LivingEntity.calculateFallDamage), иначе мост.
        if (pass(fx, y, fz) && pass(fx, y + 1, fz) && pass(fx, y - 1, fz) && pass(fx, y - 2, fz)) {
          if (floorGood(fx, y - 3, fz)) tryMove(fx, y - 2, fz, K.DROP2, [], W.walk + W.drop, false)
          else if (pass(fx, y - 3, fz) && floorGood(fx, y - 4, fz)) tryMove(fx, y - 3, fz, K.DROP3, [], W.walk + W.drop, false)
        }
        if (blocks > 0) tryMove(fx, y, fz, K.BRIDGE, [fx, y + 1, fz, fx, y, fz], W.walk + W.bridge, true)
      }
      if (floorGood(fx, y, fz)) tryMove(fx, y + 1, fz, K.UP, [x, y + 2, z, fx, y + 2, fz, fx, y + 1, fz], W.walk + W.up, false)
      tryMove(fx, y - 1, fz, K.DOWN, [fx, y + 1, fz, fx, y, fz, fx, y - 1, fz], W.walk + W.down, false)
    }
    tryMove(x, y - 1, z, K.VDOWN, [x, y - 1, z], W.vdown, false)
    if (blocks > 0) tryMove(x, y + 1, z, K.VUP, [x, y + 2, z], W.vup, true)
  }
  const end = found >= 0 ? found : (opts.partial ? best : -1)
  const out: any = { ok: found >= 0, nodes: visited, ms: gameClock.wall.now() - t0, why, digWaitSeconds, limit: found < 0 && (budgetLimit || visited > maxNodes) }
  if (end < 0 || end === k0) { if (!out.ok) out.why2 = budgetLimit ? 'бюджет без прогресса' : 'пути нет'; out.path = []; return out }
  pathOf({ end, k0, par, kindA, gc, sx, sz, sxz, x0, y0, z0, from, get, pass, edge, lava1, lava2 }, out)
  return out
}

// Reverse Dijkstra on a RELAXED column graph (бюджетный план): нижняя граница цены до цели по столбцам — потенциал для h.
// Итог — { potential, lastYield } или { stop, lastYield } (тревога, цель отсечена непроходимыми столбцами).
async function columnPotential (sp, opts, deadline, lastYield) {
  const { x0, x1, z0, z1, sx, sz, y0, sy, GX, GZ, gr, get, pass, floorGood, open, edge, danger, blocks, EXPO, OPEN_W, ZS, ZX, HOT, DG,
    digWaitSeconds, from } = sp
  // Reverse Dijkstra on a RELAXED column graph. Entering a column costs the
  // cheapest legal body height in it, including unavoidable exposure/zone/
  // mob penalties. Vertical motion is free in this graph. Therefore its
  // potential is consistent with EVERY real horizontal edge, including drops.
  const minCost = new Float64Array(sx * sz).fill(-1)
  let potential = new Float64Array(sx * sz).fill(Infinity)
  const q = new Heap()
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if ((x - GX) ** 2 + (z - GZ) ** 2 <= gr * gr) { const k = (z - z0) * sx + x - x0; potential[k] = 0; q.push(k, 0) }
  }
  const minimum = (x, z, k) => {
    if (minCost[k] >= 0) return minCost[k]
    let min = Infinity
    for (let y = y0; y < y0 + sy - 1; y++) {
      const a = get(x, y, z); const b = get(x, y + 1, z)
      if (!Number.isFinite(DIG[a]) || !Number.isFinite(DIG[b]) || a === C.HOT || b === C.HOT) continue
      const fl = get(x, y - 1, z)
      if (!floorGood(x, y - 1, z) && !(blocks > 0 && (fl === C.AIR || fl === C.PASS))) continue
      let tax = W.walk + DIG[a] + DIG[b] + (a > C.PASS ? W.dig + digWaitSeconds : 0) + (b > C.PASS ? W.dig + digWaitSeconds : 0)
      let sides = 0
      for (const [dx, dz] of DIRS) if (pass(x + dx, y, z + dz) || pass(x + dx, y + 1, z + dz)) sides++
      const ex = sides >= 2 || pass(x, y + 2, z)
      if (ex) {
        tax += EXPO
        if (open(x, y, z)) tax += OPEN_W
        if (edge(x, y, z)) tax += W.edge
        for (const Z of ZS) if (x >= Z[0] && x <= Z[3] && y >= Z[1] && y <= Z[4] && z >= Z[2] && z <= Z[5]) { tax += ZX; break }
        for (const Z of HOT) if (x >= Z[0] && x <= Z[3] && y >= Z[1] && y <= Z[4] && z >= Z[2] && z <= Z[5]) { tax += Z[6]; break }
      }
      if (DG.length) tax += danger(x, y, z, ex)
      min = Math.min(min, tax)
      if (min === W.walk) break
    }
    minCost[k] = min
    return min
  }
  let n = 0
  while (q.size) {
    const k = q.pop(); const x = x0 + k % sx; const z = z0 + Math.floor(k / sx)
    const v = potential[k] + minimum(x, z, k)
    for (const [dx, dz] of DIRS) {
      const nx = x + dx; const nz = z + dz
      if (nx < x0 || nx > x1 || nz < z0 || nz > z1) continue
      const nk = (nz - z0) * sx + nx - x0
      if (v < potential[nk]) { potential[nk] = v; q.push(nk, v) }
    }
    if ((++n % 32) === 0 && performance.now() - lastYield >= (opts.yieldMs ?? 8)) {
      await new Promise<any>(resolve => setImmediate(resolve)); lastYield = performance.now()
      if (opts.alarm?.()) return { stop: { ok: false, path: [], nodes: 0, why2: 'тревога' }, lastYield }
      if (lastYield >= Math.min(deadline, (opts._t0 ?? lastYield) + 225)) { potential = null; break } // Reserve time for partial A* progress.
    }
  }
  if (potential && !Number.isFinite(potential[(from.z - z0) * sx + from.x - x0])) return { stop: { ok: false, path: [], nodes: 0, why2: 'цель отсечена непроходимыми столбцами' }, lastYield }
  return { potential, lastYield }
}

// Путь из найденного конца: шаги с клетками копки, открытость и риск (открыто у края или у лавы), итоги плана в out.
function pathOf (sp, out) {
  const { end, k0, par, kindA, gc, sx, sz, sxz, x0, y0, z0, from, get, pass, edge, lava1, lava2 } = sp
  const pathK = []
  for (let k = end; k !== k0 && k >= 0; k = par[k]) pathK.push(k)
  pathK.reverse()
  const pathOut = []
  let px = from.x; let py = from.y; let pz = from.z
  let digs = 0; let expoSteps = 0; let placed = 0
  for (const k of pathK) {
    const nx = x0 + (k % sx); const nz = z0 + (Math.floor(k / sx) % sz); const ny = y0 + Math.floor(k / sxz)
    const kind = kindA[k]
    let cells
    if (kind === K.FLAT || kind === K.BRIDGE) cells = [[nx, ny + 1, nz], [nx, ny, nz]]
    else if (kind === K.UP) cells = [[px, py + 2, pz], [nx, ny + 1, nz], [nx, ny, nz]]
    else if (kind === K.DOWN) cells = [[nx, ny + 2, nz], [nx, ny + 1, nz], [nx, ny, nz]]
    else if (kind === K.VDOWN) cells = [[nx, ny, nz]]
    else if (kind === K.DROP2 || kind === K.DROP3) cells = []
    else cells = [[px, py + 2, pz]]
    const dig = cells.filter(([qx, qy, qz]) => DIG[get(qx, qy, qz)] > 0)
    digs += dig.length
    if (kind === K.BRIDGE || kind === K.VUP) placed++
    let e = false
    for (const [dx, dz] of DIRS) if (pass(nx + dx, ny, nz + dz) || pass(nx + dx, ny + 1, nz + dz)) e = true
    if (e) expoSteps++
    // Опасный шаг: открыто и у края обрыва или в 2 клетках от лавы — тут зелье огнестойкости (если есть лишнее).
    const risk = e && (edge(nx, ny, nz) || lava2(nx, ny, nz) || lava1(nx, ny, nz))
    if (risk) out.risk = (out.risk || 0) + 1
    pathOut.push({ kind: KIND[kind], to: { x: nx, y: ny, z: nz }, from: { x: px, y: py, z: pz }, dig, expo: e, risk, cost: gc[k] - gc[par[k]] })
    px = nx; py = ny; pz = nz
  }
  out.path = pathOut
  out.cost = Math.round(gc[end] * 10) / 10
  out.steps = pathOut.length
  out.digs = digs
  out.expo = expoSteps
  out.placed = placed
  out.end = pathOut.length ? pathOut[pathOut.length - 1].to : from
}
