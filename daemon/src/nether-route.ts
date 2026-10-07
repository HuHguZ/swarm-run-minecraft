'use strict'
const gameClock = require('./game-clock')
// Ход по Аду по сетке «из копии этого же мира» (nether-grid.js; поток nether, 03.10).
//
// Пешком по Аду тело гибло на обрывах, в лаве и под гастами, а закрытый штрек (tunnel.js / sealed.plan) кусками по
// ~18 бл. по живым чанкам упирался в «пути нет», «со старта не войти», крышу крепости над залом спавнера (сводка
// 02.10: смерть в 15 из 26 сквозных). Здесь план — весь путь сразу по сетке копии мира: A* по клеткам ног тела
// (тело — 2 клетки), ходы ровно / ступень вверх / вниз / копка вниз / столб; цена — секунды (ходьба, копка по
// классу блока) плюс штрафы: открытое место (грань тела касается чужого воздуха), большая пещера (гасты), край
// обрыва; запрещено: лава в 1 клетке от тела, огонь, гравий над вскрытой клеткой, пол из магмы, коренная порода,
// обсидиан, спавнер, золото и сундуки (злят пиглинов). Исполнение — по живым блокам: копает только клетки хода
// (лицо впереди — его видно, pick.js), живое расхождение с сеткой (лава, твёрдое) — пометка и новый план.
//
// Вкл. по умолчанию (ND_NE_ROUTE=0 — выкл.) в своих местах: fortress.toSpawner, bastion подход/золото, кампания goToward по
// Аду (у кампании — ND_NE_ROUTE=1 в её окружении); RPC ne_route.
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const NG = require('./nether-grid')
const { C, DIG } = NG
const { performance } = require('node:perf_hooks')
const { ReceiptCostWindow } = require('./environments/receipt-cost')
const receiptCosts = new WeakMap<object, import('./environments/receipt-cost').ReceiptCostWindow>()
interface RouteSupplyNeed {
  pickSwings: number
  requiredSwings: number
  woodEquivalent: number
  requiredWood: 8
  table: boolean
}
interface NetherRouteResult {
  ok: boolean
  why?: string
  steps: number
  dug: number
  plans: number
  goal: { x: number; y: number; z: number; r: number; dy: number }
  own?: Set<string>
  at?: { x: number; y: number; z: number }
  seconds?: number
  placed?: number
  supplyNeeded?: RouteSupplyNeed
}
function receiptCostFor (session) {
  const bot = session.bot
  let costs = receiptCosts.get(bot)
  if (!costs) { costs = new ReceiptCostWindow(); receiptCosts.set(bot, costs) }
  const tickRate = bot.ndClock?.snapshot?.().tickRate ?? gameClock.snapshot?.().tickRate ?? 20
  return { costs, context: `${bot.game?.dimension || 'unknown'}|${bot.version || 'unknown'}|${tickRate}` }
}
const budgetOn = () => process.env.ND_NE_PLAN !== '0'

const sleep = ms => new Promise<any>(resolve => gameClock.setTimeout(resolve, ms))
const log = (what, o) => console.log('[route]', new Date().toTimeString().slice(0, 8), what, JSON.stringify(o))
const xyz = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

let cached = null
function gridOf (session) {
  const dir = session && session.cfg && session.cfg.memoryDir
  if (!dir) return null
  let st
  try { st = fs.statSync(path.join(dir, 'nether-grid.json')) } catch { return null }
  if (cached && cached.dir === dir && cached.mtime === st.mtimeMs) return cached.grid
  const g = NG.load(dir)
  cached = { dir, mtime: st.mtimeMs, grid: g }
  return g
}
// По умолчанию вкл. с 03.10 08:10 (замер D5: 1/8 в Энде, смертей 3/8 против 0/17 и 15/17 без хода по сетке; ход
// работает только при сетке копии мира в памяти — без неё ничего не меняется). Откат — ND_NE_ROUTE=0.
const enabled = () => process.env.ND_NE_ROUTE !== '0'

// --- план ------------------------------------------------------------------------------------------------------
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
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
function legGoal (g, from, goal, opts: any = {}) {
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
async function plan (g, from, goal, opts: any = {}) {
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
  const danger = (x, y, z, ex) => { for (let i = 0; i < DG.length; i++) { const d = DG[i]; if (Math.abs(d[1] - y) <= 6 && (d[0] - x) * (d[0] - x) + (d[2] - z) * (d[2] - z) < 144) return ex ? (d[3] ?? 10) : 1.5 } return 0 }
  if (bounded) {
    // Reverse Dijkstra on a RELAXED column graph. Entering a column costs the
    // cheapest legal body height in it, including unavoidable exposure/zone/
    // mob penalties. Vertical motion is free in this graph. Therefore its
    // potential is consistent with EVERY real horizontal edge, including drops.
    const minCost = new Float64Array(sx * sz).fill(-1)
    potential = new Float64Array(sx * sz).fill(Infinity)
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
        if (opts.alarm?.()) return { ok: false, path: [], nodes: 0, why2: 'тревога' }
        if (lastYield >= Math.min(deadline, (opts._t0 ?? lastYield) + 225)) { potential = null; break } // Reserve time for partial A* progress.
      }
    }
    if (potential && !Number.isFinite(potential[(from.z - z0) * sx + from.x - x0])) return { ok: false, path: [], nodes: 0, why2: 'цель отсечена непроходимыми столбцами' }
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
  return out
}

// --- исполнение -----------------------------------------------------------------------------------------------
function feetCell (bot) { const p = bot.entity.position; const f = p.floored(); return (bot.entity.onGround && p.y - f.y >= 0.8) ? f.offset(0, 1, 0) : f }
const HOSTILE = new Set(['wither_skeleton', 'piglin_brute', 'hoglin', 'magma_cube', 'blaze', 'skeleton', 'zoglin'])

function liveClass (bot, c) {
  const b = bot.blockAt(new Vec3(c[0], c[1], c[2]))
  if (!b) return C.UNKNOWN
  if (/lava/.test(b.name)) return C.LAVA
  return NG.classOfName(b.name)
}

// Иссушитель/брут виден в 9 бл. (на тронном зале их бывает по 2–3 — сид 6: на спуске на помост смерть за 2 с ×4) —
// сверху (тело выше на 2.6+ — его рамка удара не достаёт) луком, пока не убит/не ушёл; на одном уровне и не вплотную —
// столб в 3 блока и луком сверху. Нет лука или стрел — как было (бой вплотную в threatCheck).
async function rangedClear (session, ctl, st, { radius = 9, maxMs = 25000, tower = true }: any = {}) {
  const bot = session.bot
  const { itemNamed } = require('./items')
  const arrows = () => bot.inventory.items().filter(i => /arrow$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  if (!itemNamed(bot, 'bow') || arrows() === 0) return false
  const P = require('./perception')
  const seen = e => { try { return P.raySees(bot, P.eyePos(bot), e.position.offset(0, 1.6, 0)) } catch { return false } }
  const pick = () => (Object.values(bot.entities || {}) as any[]).filter((e : any) => e && e.position && e.isValid !== false && /^(wither_skeleton|piglin_brute)$/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < radius && seen(e))
    .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  let foe: any = pick()
  if (!foe) return false
  const t0 = gameClock.now()
  let towered = false
  st.ranged = (st.ranged || 0) + 1
  while (foe && !ctl.aborted && gameClock.now() - t0 < maxMs && (bot.health ?? 20) > 7) {
    const above = bot.entity.position.y - foe.position.y >= 2.6
    const d = foe.position.distanceTo(bot.entity.position)
    if (!above && tower && !towered && d > 3.2 && bot.entity.onGround) {
      const r = await require('./build').towerUp(bot, ctl, 3, { sneak: true }).catch(() => ({ ok: false }))
      towered = true
      log('столб от иссушителя', { foe: foe.name, ok: !!(r && r.ok), y: Math.round(bot.entity.position.y * 10) / 10 })
      continue
    }
    if (!above) return false
    bot.setControlState('sneak', true)
    const e: any = foe
    const r = await require('./bow').shoot(bot, e, { follow: false, mode: 'settle', point: () => e.position.offset(0, (e.height || 2.4) * 0.6, 0), shouldStop: () => !e.isValid }).catch(err => ({ shot: false, why: err.message }))
    if (!(r && r.shot)) await sleep(300)
    foe = pick()
  }
  bot.setControlState('sneak', false)
  log('сверху луком', { s: Math.round((gameClock.now() - t0) / 1000), left: !!foe, hp: Math.round(bot.health ?? 0) })
  return true
}

// Иссушитель вплотную — бой из ямы глубиной 2: рамка удара моба раздута только вширь (Mob.getAttackBoundingBox, 1.20.5+),
// иссушитель 2.4 в высоту с пола — тело с ногами на −2 он не достаёт, а меч снизу достаёт его ноги (s1c-A-5 06.10: столб не
// встал, «бой на ходу» 20 → 0 за 3 с: 18 ударами и 14 иссушением). Пол на −3 твёрдый, лавы рядом нет; потом столб 2 наверх.
async function pitFight (session, ctl, st, foe) {
  const bot = session.bot
  const SL = require('./sealed')
  const pick = require('./pick')
  for (let i = 0; i < 20 && !bot.entity.onGround && !ctl.aborted; i++) await sleep(50)
  const f = bot.entity.position.offset(0, 0.2, 0).floored()
  const firm = c => { const b = bot.blockAt(c); return !!b && b.boundingBox === 'block' && !/lava|water|fire|magma|spawner|bedrock|chest/.test(b.name) }
  const cells = [f.offset(0, -1, 0), f.offset(0, -2, 0)]
  if (![...cells, f.offset(0, -3, 0)].every(firm)) return false
  // Стенки твёрдые со всех сторон: яма с воздухом сбоку открыта удару (s1c-M-2 06.10 — то же у ямы ифритов).
  if (cells.some(c => DIRS.some(([x, z]) => { const b = bot.blockAt(c.offset(x, 0, z)); return !b || /lava/.test(b.name) || b.boundingBox !== 'block' }))) return false
  for (const c of cells) {
    let r = 'err'
    for (let k = 0; k < 3 && r !== 'ok' && r !== 'air' && !ctl.aborted; k++) r = await SL.digCell(bot, c).catch(e => 'err ' + e.message)
    if (r !== 'ok' && r !== 'air') { log('яма от иссушителя', { ok: false, why: r }); return false }
    for (let i = 0; i < 20 && !bot.entity.onGround; i++) await sleep(50)
  }
  for (let i = 0; i < 10 && bot.entity.position.y > f.y - 1.5; i++) await sleep(100)
  const t0 = gameClock.now()
  let swings = 0
  while (!ctl.aborted && gameClock.now() - t0 < 30000 && (bot.health ?? 0) > 3) {
    const e = bot.entities[foe.id]
    if (!e || e.isValid === false || e.position.distanceTo(bot.entity.position) > 8) break
    const sw = bot.inventory.items().find(i => /_sword$/.test(i.name))
    if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} }
    if (pick.canHit(bot, e) && gameClock.now() - (st.lastSwing || 0) > require('./pvp').cooldownMs(bot.heldItem)) {
      try { await bot.lookAt(e.position.offset(0, 0.4, 0), true) } catch {}
      try { bot.attack(e); st.lastSwing = gameClock.now(); swings++ } catch {}
    }
    await sleep(100)
  }
  const left = !!(bot.entities[foe.id] && bot.entities[foe.id].isValid !== false)
  const up = await require('./build').towerUp(bot, ctl, 2, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
  st.pits = (st.pits || 0) + 1
  log('яма от иссушителя', { ok: true, swings, left, s: Math.round((gameClock.now() - t0) / 1000), hp: Math.round(bot.health ?? 0), up: !!(up && up.ok) })
  return true
}

async function threatCheck (session, ctl, st) {
  const bot = session.bot
  if (await rangedClear(session, ctl, st)) return true
  const me = bot.entity.position
  let foe = null
  for (const e of ((Object.values(bot.entities || {}) as any[]) as any)) {
    if (!e || !e.position || e === bot.entity || e.isValid === false) continue
    const n = e.name
    if (!HOSTILE.has(n) && !(n === 'piglin' && st.piglinsAngry)) continue
    const d = e.position.distanceTo(me)
    if (d > 3.6) continue
    if (!foe || d < foe.d) foe = { e, d }
  }
  if (!foe) return false
  // Блейз: не гоняться (combat.fight бегал за летающим, удары вплотную сняли 13 хп: neF-B5f23-1 03.10) — один взмах,
  // если в досягаемости и виден, и дальше по пути.
  if (foe.e.name === 'blaze') {
    const pick = require('./pick')
    if (foe.d <= 3.2 && pick.canHit(bot, foe.e) && gameClock.now() - (st.lastSwing || 0) > 640) {
      const sw = bot.inventory.items().find(i => /_sword$/.test(i.name))
      if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} }
      try { await bot.lookAt(foe.e.position.offset(0, (foe.e.height || 1.8) * 0.6, 0), true) } catch {}
      try { bot.attack(foe.e); st.lastSwing = gameClock.now(); st.swings = (st.swings || 0) + 1 } catch {}
    }
    return false
  }
  // ND_BRUTE_HUNKER=1: брут/хоглин вплотную — не бой на земле (брут: 50 хп, 13 урона, D7c-24 03.10: «бой на ходу» ×3, смерть
  // за 2 с), а столб на 2: рамка удара раздута только вширь — ноги на +2 им не достать; сверху — мечом, пока не уйдёт/умрёт.
  // По умолчанию (s1c 06.10): «бой на ходу» с брутом — смерть за 2–3 удара (s1c-D-3/A-8: у входа в сокровищницу 4120…, 20 → 0 за
  // 2 с); столб 2 — по той же механике рамки удара (раздута только вширь). ND_BRUTE_HUNKER=0 — выкл.
  if (process.env.ND_BRUTE_HUNKER !== '0' && /^(piglin_brute|hoglin)$/.test(foe.e.name)) {
    const pick = require('./pick')
    const y0 = bot.entity.position.y
    const tw = await require('./build').towerUp(bot, ctl, 2, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
    const up = bot.entity.position.y >= y0 + 1.9
    const t0 = gameClock.now()
    let swings = 0
    while (up && !ctl.aborted && gameClock.now() - t0 < 30000 && (bot.health ?? 0) > 4) {
      const e = bot.entities[foe.e.id]
      if (!e || e.isValid === false || e.position.distanceTo(bot.entity.position) > 10) break
      if (pick.canHit(bot, e) && gameClock.now() - (st.lastSwing || 0) > 640) {
        const sw = bot.inventory.items().find(i => /_sword$/.test(i.name))
        if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} }
        try { await bot.lookAt(e.position.offset(0, (e.height || 1.9) * 0.7, 0), true) } catch {}
        try { bot.attack(e); st.lastSwing = gameClock.now(); swings++ } catch {}
      }
      await sleep(100)
    }
    bot.setControlState('sneak', false)
    st.towers = (st.towers || 0) + 1
    log('столб от ' + foe.e.name, { up, placed: tw && tw.placed, swings, s: Math.round((gameClock.now() - t0) / 1000), left: !!(bot.entities[foe.e.id] && bot.entities[foe.e.id].isValid !== false), hp: Math.round(bot.health ?? 0) })
    if (up) return true
  }
  if (foe.e.name === 'wither_skeleton' && process.env.ND_WITHER_PIT !== '0' && await pitFight(session, ctl, st, foe.e).catch(() => false)) return true
  st.fights++
  const r = await require('./combat').fight(session, ctl, { target: '#' + foe.e.id, timeoutSeconds: 20, retreatAtHealth: 7, shield: 'always', clearArea: 0 }).catch(err => ({ error: err.message }))
  log('бой на ходу', { foe: foe.e.name, d: Math.round(foe.d * 10) / 10, hp: Math.round(bot.health ?? 0), killed: !!(r && (r.killed || (r.kills && r.kills.length))), error: r && r.error })
  return true
}

async function eatIfLow (session, ctl) {
  const bot = session.bot
  if ((bot.food ?? 20) >= 14 && (bot.health ?? 20) >= 14) return
  if ((bot.food ?? 20) >= 20) return
  try { await require('./actions').eat(session, {}) } catch {}
}

// Клетки, которые ход вскрывает (копка по живым блокам), — сверху вниз.
function moveCells (mv) {
  const t = mv.to; const f = mv.from
  switch (mv.kind) {
    case 'flat': case 'bridge': return [[t.x, t.y + 1, t.z], [t.x, t.y, t.z]]
    case 'up': return [[f.x, f.y + 2, f.z], [t.x, t.y + 1, t.z], [t.x, t.y, t.z]]
    case 'down': return [[t.x, t.y + 2, t.z], [t.x, t.y + 1, t.z], [t.x, t.y, t.z]]
    case 'vdown': return [[t.x, t.y, t.z]]
    case 'vup': return [[f.x, f.y + 2, f.z]]
    default: return []
  }
}

function routeFrame (bot, ctl, deadline) {
  return new Promise<boolean>(resolve => {
    const wall = gameClock.wall
    let timer
    const finish = (observed: boolean) => {
      bot.removeListener('physicsTick', observedFrame)
      bot.removeListener('end', stopped)
      bot.removeListener('death', stopped)
      if (timer) wall.clearTimeout(timer)
      if (ctl.onAbort) { const index = ctl.onAbort.indexOf(stopped); if (index >= 0) ctl.onAbort.splice(index, 1) }
      resolve(observed)
    }
    const observedFrame = () => finish(!ctl.aborted && (bot.health ?? 20) > 0)
    const stopped = () => finish(false)
    if (ctl.aborted || (bot.health ?? 20) <= 0 || wall.now() >= deadline) return resolve(false)
    bot.on('physicsTick', observedFrame)
    bot.on('end', stopped)
    bot.on('death', stopped)
    ctl.onAbort?.push(stopped)
    timer = wall.setTimeout(stopped, Math.max(1, deadline - wall.now()))
  })
}

async function exposeBridgeFace (bot, ctl, support, destination) {
  const face = destination.minus(support)
  if (Math.abs(face.x) + Math.abs(face.z) !== 1 || face.y !== 0) return false
  const pick = require('./pick')
  const deadline = gameClock.wall.now() + 3000
  try {
    for (let frames = 0; frames < 24 && !ctl.aborted; frames++) {
      if (ctl.waitReflex) await ctl.waitReflex()
      const p = bot.entity.position
      const half = (bot.entity.width || 0.6) / 2
      if (ctl.aborted || !bot.entity.onGround || Math.abs(p.y - support.y - 1) > 0.02 ||
        bot.blockAt(support)?.boundingBox !== 'block' ||
        p.x + half <= support.x || p.x - half >= support.x + 1 ||
        p.z + half <= support.z || p.z - half >= support.z + 1) return false
      if (pick.faceAim(bot, support, face)) return true
      // Sneak keeps the native body supported while its eyes cross the outward face.
      await bot.lookAt(destination.offset(0.5, 2.6, 0.5), true)
      bot.setControlState('forward', true)
      if (!await routeFrame(bot, ctl, deadline)) return false
    }
    return false
  } finally { bot.setControlState('forward', false) }
}

async function dropInto (bot, ctl, to) {
  if (ctl.waitReflex) await ctl.waitReflex()
  if (ctl.aborted || !bot.physics || !bot.entity.onGround) return false
  const result = await require('./navigation/parkour').executeJump(bot, ctl, to.offset(0.5, 0, 0.5),
    { allowWalk: true, planningMs: 180 })
  return result.ok && !ctl.aborted && bot.entity.onGround && feetCell(bot).equals(to)
}

// Один ход: проверить живые блоки, вскрыть клетки, шагнуть. Итог: 'ok' | 'replan' | 'stop:<почему>'.
async function stepOne (session, ctl, g, mv, st) {
  const bot = session.bot
  const SL = require('./sealed')
  if (ctl.aborted) return 'stop:прервано'
  const describe = () => ({ at: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
    velocity: bot.entity.velocity ? { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z } : null,
    grounded: bot.entity.onGround, jumpTicks: bot.jumpTicks, pose: bot.entity.pose,
    keys: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(key => [key, bot.getControlState?.(key) ?? bot.controlState?.[key] ?? null])) })
  const beforeStep = describe()
  // A route owns the next movement; movement inherited from a previous escape cancels its forward vector.
  for (const key of ['forward', 'back', 'left', 'right', 'jump']) bot.setControlState(key, false)
  const cells = moveCells(mv)
  const timing = st.timing || (st.timing = { digMs: 0, moveMs: 0, receiptMs: 0, receiptWallMs: 0, receiptServerWallMs: 0, receiptNotificationWallMs: 0, receiptSingle: 0, receiptSection: 0 })
  const digOptions = { interrupted: () => ctl.aborted, onReceipt: receipt => {
    timing.receiptMs += receipt.gameMs; timing.receiptWallMs += receipt.wallMs
    timing.receiptServerWallMs += receipt.serverWaitWallMs; timing.receiptNotificationWallMs += receipt.notificationDelayWallMs
    if (receipt.packet === 'single') timing.receiptSingle++
    if (receipt.packet === 'section') timing.receiptSection++
    if (ctl.aborted || session.bot !== bot) return
    const history = receiptCostFor(session)
    history.costs.observe(history.context, receipt)
    if (receipt.result !== 'confirmed') {
      st.digIssues ||= []
      if (st.digIssues.length < 8) st.digIssues.push({ result: receipt.result, wallMs: receipt.wallMs, ...receipt.dig })
    }
  } }
  const isDrop = mv.kind === 'drop2' || mv.kind === 'drop3'
  // Живое расхождение с сеткой: лава, огонь, коренное и т. п. — пометить и перепланировать.
  for (const c of cells) {
    const lc = liveClass(bot, c)
    if (lc === C.UNKNOWN) return 'stop:не прогружено'
    if (lc === C.LAVA || lc === C.HOT || DIG[lc] === Infinity) { g.mark(c[0], c[1], c[2], lc); st.mismatch++; return 'replan' }
    if (NG.passable(lc)) continue
    // Вскрываемая клетка у лавы по живым блокам (сбоку/сверху; сетка не знала: натекла) — пометить.
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (liveClass(bot, [c[0] + dx, c[1] + dy, c[2] + dz]) === C.LAVA) { g.mark(c[0] + dx, c[1] + dy, c[2] + dz, C.LAVA); st.mismatch++; return 'replan' }
    }
  }
  if (isDrop) {
    // Колонна прыжка — проходима по живым блокам, под ней — пол.
    for (let y = mv.from.y + 1; y >= mv.to.y; y--) {
      const lc = liveClass(bot, [mv.to.x, y, mv.to.z])
      if (!NG.passable(lc)) { g.mark(mv.to.x, y, mv.to.z, lc); st.mismatch++; return 'replan' }
    }
  }
  if (mv.kind !== 'vup' && mv.kind !== 'bridge') {
    const fl = liveClass(bot, [mv.to.x, mv.to.y - 1, mv.to.z])
    if (fl === C.LAVA || fl === C.HOT || (fl === C.MAGMA && !st.fireproof) || (NG.passable(fl) && mv.kind !== 'vdown')) {
      g.mark(mv.to.x, mv.to.y - 1, mv.to.z, fl); st.mismatch++; return 'replan'
    }
  }
  for (const c of cells) {
    const lc = liveClass(bot, c)
    if (NG.passable(lc)) continue
    const digStarted = gameClock.now()
    let r = await SL.digCell(bot, new Vec3(c[0], c[1], c[2]), digOptions)
    if (ctl.aborted || session.bot !== bot) return 'stop:прервано'
    // Не докопал (рукой — долго, кирок нет): сделать каменные и ещё раз; не вышло — обойти (пометка «твёрдое»).
    if (/^failed|^left/.test(r) && !ctl.aborted) {
      if (!bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) { const made = await require('./tunnel').restockPicks(session, ctl, 3).catch(() => 0); st.crafted = (st.crafted || 0) + (made || 0) }
      if (ctl.aborted || session.bot !== bot) return 'stop:прервано'
      if (!bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) st.crafted = (st.crafted || 0) + await goldPicks(session, ctl, 2)
      if (ctl.aborted || session.bot !== bot) return 'stop:прервано'
      r = await SL.digCell(bot, new Vec3(c[0], c[1], c[2]), digOptions)
      if (ctl.aborted || session.bot !== bot) return 'stop:прервано'
    }
    timing.digMs += Math.max(0, gameClock.now() - digStarted)
    if (r === 'ok' || r === 'air') { st.dug++; g.mark(c[0], c[1], c[2], C.AIR); continue }
    st.digFails++
    if (st.digFails > 12) return 'stop:копка ' + r
    g.mark(c[0], c[1], c[2], C.HARD)
    return 'replan'
  }
  const to = new Vec3(mv.to.x, mv.to.y, mv.to.z)
  const moveStarted = gameClock.now()
  if (mv.kind !== 'bridge') bot.setControlState('sneak', false)
  if (mv.kind === 'bridge') {
    const fc = to.offset(0, -1, 0)
    const fb = bot.blockAt(fc)
    if (fb && fb.boundingBox !== 'block') {
      if (!bot.entity.onGround || /lava|water|fire/.test(fb.name)) return 'replan'
      const { placeBlockAt } = require('./build')
      bot.setControlState('sprint', false)
      bot.setControlState('sneak', true)
      try {
        const support = feetCell(bot).offset(0, -1, 0)
        const below = bot.blockAt(support)
        const prop = below?.boundingBox === 'empty' && /^(air|cave_air|void_air)$/.test(below.name) &&
          Math.abs(bot.entity.position.y - support.y - 1) < 0.02 &&
          Math.abs(support.x - fc.x) + Math.abs(support.z - fc.z) === 1 && support.y === fc.y ? support : null
        let r = await placeBlockAt(bot, fc, { timeoutMs: 2000, steady: true, honest: true, prop })
        if (prop && r?.prop?.placed && bot.blockAt(prop)?.boundingBox === 'block') {
          st.placed = (st.placed || 0) + 1
          g.mark(prop.x, prop.y, prop.z, C.SOFT)
        }
        if (!r?.ok && !ctl.aborted && (r?.noFooting || r?.prop?.placed) &&
          await exposeBridgeFace(bot, ctl, support, fc)) {
          r = await placeBlockAt(bot, fc, { timeoutMs: 2000, steady: true, honest: true })
        }
        if (ctl.aborted) return 'stop:прервано'
        if (!r || !r.ok) {
          st.placeFails = (st.placeFails || 0) + 1
          // Сущность в клетке (блейз пролетал) — подождать и заново; прочее — несколько раз и стоп.
          if (/стоит/.test(String(r && r.reason)) && st.placeFails < 8) { await sleep(600); return 'replan' }
          if (st.placeFails < 4) return 'replan'
          return 'stop:мост: ' + String((r && r.reason) || 'не поставил').slice(0, 80)
        }
        if (!r.already) st.placed = (st.placed || 0) + 1
        g.mark(fc.x, fc.y, fc.z, C.SOFT)
        await require('./bridge').stepOnto(bot, ctl, fc)
      } finally { bot.setControlState('sneak', false) }
    } else await SL.stepMove(bot, ctl, { kind: 'flat', to })
  } else if (isDrop) {
    await dropInto(bot, ctl, to)
  } else {
    const kind = mv.kind === 'down' ? 'flat' : mv.kind
    let ok = await SL.stepMove(bot, ctl, { kind, to })
    if (!ok && !feetCell(bot).equals(to)) { await sleep(250); ok = await SL.stepMove(bot, ctl, { kind, to }) }
  }
  timing.moveMs += Math.max(0, gameClock.now() - moveStarted)
  if (mv.kind === 'vup') g.mark(mv.from.x, mv.from.y, mv.from.z, C.SOFT)
  if (!feetCell(bot).equals(to)) {
    st.stepFails++
    if (st.stepFails <= 8) log('шаг не подтверждён', { kind: mv.kind, from: mv.from, to: mv.to,
      before: beforeStep, after: describe(), aborted: ctl.aborted, reflex: !!session.reflex,
      floor: bot.blockAt(to.offset(0, -1, 0))?.name, feet: bot.blockAt(to)?.name, head: bot.blockAt(to.offset(0, 1, 0))?.name,
      shapes: [-1, 0, 1].map(dy => { const b = bot.blockAt(to.offset(0, dy, 0)); return { dy, name: b?.name, box: b?.boundingBox, shapes: b?.shapes } }) })
    // Не шагнул туда дважды — клетка «непроходима» для плана (живая геометрия: забор, ступени, сущность).
    const k = `${to.x},${to.y},${to.z}`
    st.badStep = st.badStep || new Map()
    const n = (st.badStep.get(k) || 0) + 1
    st.badStep.set(k, n)
    if (n >= 2) { g.mark(to.x, to.y, to.z, C.BLOCK); st.blocked = st.blocked || new Set(); st.blocked.add(k); log('не шагнул — клетку в обход', { kind: mv.kind, to: mv.to, from: mv.from, at: xyz(bot.entity.position) }) }
    return 'replan'
  }
  return 'ok'
}

// Живые блоки вокруг тела — в сетку (портал прибытия, своя рама, натёкшая лава — в копии мира их не было:
// neF-B2f25-1 03.10 — у портала прибытия 3 плана подряд «расхождение» на первом шаге и «на месте»).
function syncAround (bot, g, r = 6) {
  const f = bot.entity.position.floored()
  let n = 0
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
    const x = f.x + dx; const y = f.y + dy; const z = f.z + dz
    if (!g.inside(x, y, z)) continue
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) continue
    const c = /lava/.test(b.name) ? C.LAVA : NG.classOfName(b.name)
    if (g.get(x, y, z) !== c) { g.mark(x, y, z, c); n++ }
  }
  return n
}

// Место в рюкзаке: копка по Аду набивает его незераком (сотни), и стержни/золото потом не подбираются — рюкзак полон
// (neF-B16f21 03.10: стержень в 0.95 бл. от ног лежит, 79 взмахов и 0 стержней). Лишнее (сверх запаса bastion
// JUNK_KEEP) — бросить назад, за спину (вперёд — тело само подберёт снова).
async function makeRoom (bot, want = 5) {
  if (bot.inventory.emptySlotCount() >= want) return 0
  const yaw0 = bot.entity.yaw; const pitch0 = bot.entity.pitch
  let tossed = []
  try {
    await bot.look(yaw0 + Math.PI, 0.3, true).catch(() => {})
    // Свой запас: незерак (мосты, заделка) — 64, гравий/песок душ/кирпич/кварц — прочь; чернокамень и булыжник — НЕ
    // трогать: из них каменные кирки (D5-31 03.10: у спавнера ни одной кирки — булыжник ушёл на кирки и мосты, чернокамень
    // выброшен как лишний, «бой у спавнера: не хватает кирки»).
    // Незерак — 128 (B2-3 03.10: заделка штрека съела 64, коробке стража блоков не осталось — «нечем», смерть).
    const KEEP = { netherrack: 128, gravel: 0, soul_sand: 0, soul_soil: 0, nether_brick: 0, quartz: 0, dried_ghast: 0, basalt: 16, polished_blackstone_bricks: 0, cracked_polished_blackstone_bricks: 0, magma_block: 0, crimson_nylium: 0, warped_nylium: 0, glowstone_dust: 0, crying_obsidian: 4, leather: 0, magma_cream: 0, iron_nugget: 64, glass_bottle: 0, bone: 0 }
    for (const [name, keep] of (Object.entries(KEEP) as [string, any][])) {
      let have = bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
      if (have <= keep) continue
      for (const it of bot.inventory.items().filter(i => i.name === name).sort((a, c) => a.count - c.count)) {
        if (have - it.count < keep) break
        try { await bot.tossStack(it); have -= it.count; tossed.push(`${name}×${it.count}`) } catch {}
      }
    }
    if (bot.inventory.emptySlotCount() < Math.min(3, want)) { try { await require('./pack').makeRoom(bot, { slots: Math.min(3, want) }) } catch {} }
  } finally { await bot.look(yaw0, pitch0, true).catch(() => {}) }
  if (tossed.length) log('рюкзак: выбросил', { tossed, free: bot.inventory.emptySlotCount() })
  return tossed.length
}

// Тело в лаве (сорвалось с моста над лавовым морем — B12f22 03.10; под огнестойкостью живо): плыть к ближнему берегу —
// клетка в 10 бл., где пол твёрдый, а ноги и голова свободны; прыжок+вперёд, пока не на твёрдом.
function inLava (bot) {
  if (bot.entity && bot.entity.isInLava) return true
  const p = bot.entity.position
  for (const x of new Set([Math.floor(p.x - 0.3), Math.floor(p.x + 0.3)])) {
    for (const z of new Set([Math.floor(p.z - 0.3), Math.floor(p.z + 0.3)])) {
      for (const y of new Set([Math.floor(p.y), Math.floor(p.y + 1)])) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && /lava/.test(b.name)) return true }
    }
  }
  return false
}
async function lavaSwim (bot, ctl, st) {
  if (!inLava(bot)) return false
  const f = bot.entity.position.floored()
  let best = null
  for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) for (let dy = -2; dy <= 3; dy++) {
    const c = f.offset(dx, dy, dz)
    const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0))
    if (!a || !b || !u) continue
    if (a.boundingBox !== 'empty' || b.boundingBox !== 'empty' || /lava|fire|nether_portal/.test(a.name + b.name)) continue
    if (u.boundingBox !== 'block' || /magma/.test(u.name)) continue
    // Без лавы рядом по горизонтали — рамка тела (±0.3) иначе в ней (D6-32 03.10: «выбрался» в портал рядом с лавой).
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => [0, 1].some(y => { const q = bot.blockAt(c.offset(x, y, z)); return q && q.name === 'lava' }))) continue
    const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5
    if (!best || d < best.d) best = { c, d }
  }
  if (!best) return false
  st.swims = (st.swims || 0) + 1
  const t0 = gameClock.now()
  try {
    // Из лавы — всегда до конца, и при оборванном ходе: обёртка lavaWatched (bastion) рвёт ход именно на лаве, и выход
    // обрывался за 0.1 с, а потом 5 с считался план — тело горело (VR22-1 03.10: смерть на 14-й с после входа в Ад).
    while (gameClock.now() - t0 < 9000) {
      const p = bot.entity.position
      await bot.lookAt(new Vec3(best.c.x + 0.5, p.y + 1.2, best.c.z + 0.5), true).catch(() => {})
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(80)
      if (!inLava(bot) && bot.entity.onGround) break
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
  log('из лавы', { to: xyz(best.c), ok: !inLava(bot), s: Math.round((gameClock.now() - t0) / 100) / 10, hp: Math.round(bot.health ?? 0) })
  return !inLava(bot)
}

// Коробки известного золота бастионов (память тела: «бастион (ад)» … gold) ± 12 — зоны, где открытое втридорога: путь
// из бастиона к крепости шёл по двору — брут (neF-C124-1 03.10: «slain by Piglin Brute» на 6-м шаге хода).
function bruteSpots (session) {
  try {
    const places = (session.journal && session.journal.state && session.journal.state.places) || {}
    const out = []
    for (const [k, v] of ((Object.entries(places) as [string, any][]) as any)) if (/бастион/.test(k) && v && Array.isArray(v.brutes)) for (const b of v.brutes) if (Array.isArray(b) && b.length === 3) out.push(b)
    return out
  } catch { return [] }
}
// ND_SPAWNER_HOT=1: спавнер блейзов из памяти — уходя от него (цель дальше 30) без огнестойкости, открытое в ±14 (−4..+10)
// +6 за шаг: штреком в толще, а не коридором под шарами (D7-32 03.10: 11 очей на 20-й мин, на 36-м шаге хода от
// спавнера «fireballed by Blaze»).
// Кирок никаких, камня на каменные нет — золотые из слитков (3 слитка + 2 палки; копает незерак и кирпич, 32 копки,
// быстрее железной): D6-23 03.10 — 13 слитков в рюкзаке, «для ифритов не хватает кирки — домой», 20 мин ходу назад.
async function goldPicks (session, ctl, want = 2) {
  const bot = session.bot
  const A = require('./actions')
  const has = n => bot.inventory.items().filter(i => i.name === n).reduce((k, i) => k + i.count, 0)
  let made = 0
  try {
    for (let k = 0; k < want && has('gold_ingot') >= 3 && !ctl.aborted; k++) {
      if (has('stick') < 2 && bot.inventory.items().some(i => /_planks$/.test(i.name))) await A.craft(session, ctl, { item: 'stick', count: 4 })
      if (has('stick') < 2) break
      const n0 = has('golden_pickaxe')
      await A.craft(session, ctl, { item: 'golden_pickaxe', count: 1 })
      if (has('golden_pickaxe') <= n0) break
      made++
    }
  } catch (e) { log('кирки: золотые не вышло', { error: e.message }) }
  return made
}
function spawnerHot (session, goal, fireproof) {
  if (process.env.ND_SPAWNER_HOT !== '1' || fireproof) return []
  try {
    const places = (session.journal && session.journal.state && session.journal.state.places) || {}
    const out = []
    for (const [k, v] of ((Object.entries(places) as [string, any][]) as any)) {
      if (!/спавнер блейзов/.test(k) || !v || typeof v.x !== 'number') continue
      if (v.dimension && v.dimension !== 'the_nether') continue
      if (Math.hypot(goal.x - v.x, goal.z - v.z) < 30) continue
      out.push([v.x - 14, v.y - 4, v.z - 14, v.x + 14, v.y + 10, v.z + 14, 6])
    }
    return out
  } catch { return [] }
}
// Места брутов из копии мира + (ND_GUARD=1) живые бруты/хоглины рядом: открытое в 12 бл. от живого +40 за шаг (ревью Codex
// ne-deaths.md №1: штраф +10 A* брал, если обход дороже; 12 смертей от брутов на открытом ходе).
function liveDangers (session) {
  const out = bruteSpots(session)
  if (process.env.ND_GUARD === '0') return out
  const bot = session.bot
  try {
    for (const e of ((Object.values(bot.entities || {}) as any[]) as any)) {
      if (!e || !e.position || e.isValid === false || !/^(piglin_brute|hoglin|zoglin)$/.test(e.name || '')) continue
      if (e.position.distanceTo(bot.entity.position) > 64) continue
      out.push([Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z), 40])
    }
  } catch {}
  return out
}
function bastionZones (session) {
  try {
    const places = (session.journal && session.journal.state && session.journal.state.places) || {}
    const out = []
    for (const [k, v] of ((Object.entries(places) as [string, any][]) as any)) {
      if (!/бастион/.test(k) || !v) continue
      if (v.dimension && v.dimension !== 'the_nether') continue
      // Коробка бастиона по кускам (карта) ± 16 — двор, мосты, хоглины и бруты вокруг (D1-26 03.10: брут в 20 бл. от
      // золота, на багровом нилии у бастиона).
      if (Array.isArray(v.bb) && v.bb.length === 6) { out.push([v.bb[0] - 16, v.bb[1] - 4, v.bb[2] - 16, v.bb[3] + 16, v.bb[4] + 8, v.bb[5] + 16]); continue }
      if (!Array.isArray(v.gold) || !v.gold.length) continue
      const xs = v.gold.map(q => q[0]); const ys = v.gold.map(q => q[1]); const zs = v.gold.map(q => q[2])
      out.push([Math.min(...xs) - 12, Math.min(...ys) - 6, Math.min(...zs) - 12, Math.max(...xs) + 12, Math.max(...ys) + 8, Math.max(...zs) + 12])
    }
    return out
  } catch { return [] }
}

// К цели по сетке: план, исполнение, перепланирование (живые поправки — g.mark). Итог { ok, why, steps, dug, … }.
async function routeTo (session, ctl, p: any = {}): Promise<NetherRouteResult> {
  const bot = session.bot
  try { require('./ne-guard').swatInstall(bot) } catch {}
  try { require('./ne-guard').attach(session) } catch {}
  const g = gridOf(session)
  const goal = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), r: p.r ?? 0, dy: p.dy ?? 0 }
  const st: any = { ok: false, steps: 0, dug: 0, plans: 0, mismatch: 0, digFails: 0, stepFails: 0, fights: 0, goal, fireproof: false, piglinsAngry: !!p.piglinsAngry }
  if (!g) return { ...st, why: 'сетки Ада нет (знание карты не снято)' }
  const deadline = gameClock.now() + (p.timeoutSeconds ?? 600) * 1000
  const t0 = gameClock.now()
  // Кирки: железная — золоту бастиона; обёртка bot.dig берёт «лучший» инструмент, и без фильтра железная стиралась о
  // незерак за 250 копок (neF-B3f25-1 03.10). ironOk (после бастиона) — любая.
  const filter0 = bot._ndToolFilter
  // Железную беречь всегда (нужна золоту, спуску к крепости Края — SH1 03.10: 825 копок по Аду стёрли все кирки, наверху
  // «до кирпича не докопался: голыми руками»); каменные — из запаса и по дороге (restockPicks).
  bot._ndToolFilter = require('./tunnel').makeToolFilter(bot, false)
  // ND_NE_STAY=1: других кирок нет (каменные стёрлись, сделать не из чего) — железная лучше рук (B2-26 03.10: 608 копок руками,
  // 13 мин хода домой).
  const ironOnly = () => !bot.inventory.items().some(i => /^(stone|wooden|golden|diamond|netherite)_pickaxe$/.test(i.name)) && bot.inventory.items().some(i => i.name === 'iron_pickaxe')
  // Ход сам себя бережёт (бой на ходу, стоп на хп < 6), как nether_tunnel (autopilot SELF_GUARDED): аварийный отход
  // автопилота посреди хода у тронного зала бегал на месте 60 с под блейзами — смерть (neF-B4f22-1 03.10).
  const emOff0 = session.emergencyOff
  session.emergencyOff = true
  const own = new Set<string>()
  const solidUnder = () => { if (!p.solidFloor) return true; const b = bot.blockAt(feetCell(bot).offset(0, -1, 0)); return !!b && b.boundingBox === 'block' && !/fence|wall|slab|stairs|chain|bars|pane/.test(b.name) }
  const reached = () => { const f = feetCell(bot); return Math.abs(f.y - goal.y) <= goal.dy && (goal.r ? Math.hypot(f.x - goal.x, f.z - goal.z) <= goal.r : (f.x === goal.x && f.z === goal.z)) && solidUnder() }
  // Запас взмахов — под оставшиеся копки плана, а не жёсткие 260 (s1c-F-7 06.10: «ресурсный запас 259/260 — пополнение» по кругу
  // bastion ↔ AcquireNetherTools 10+ мин, и отказ уже ПОСЛЕ прихода к цели).
  const keepSupply = async (craft = true, need = 260): Promise<boolean> => {
    if (!p.supplyReserve) return true
    const tools = require('./items')
    let swings = tools.toolBudget(bot, 'pickaxe')
    if (swings >= need) return true
    const calm = (bot.health ?? 0) >= 12 && !require('./ne-guard').meleeFoes(bot, 12).length
    if (craft && calm && !ctl.aborted && session.bot === bot && gameClock.now() < deadline) {
      const made = await require('./tunnel').restockPicks(session, ctl, 2, { reservePlanks: 8 }).catch(() => 0)
      st.crafted = (st.crafted || 0) + made
      if (made) log('кирки: запас подхода', { made, low: require('./tunnel').lowPicks(bot) })
    }
    if (ctl.aborted || session.bot !== bot) return false
    swings = tools.toolBudget(bot, 'pickaxe')
    if (swings >= need) return true
    const inventory = tools.countItems(bot)
    st.supplyNeeded = { pickSwings: swings, requiredSwings: need,
      woodEquivalent: Object.entries(inventory).reduce((total, [name, count]) => total +
        (/_planks$/.test(name) ? Number(count) : /_(log|stem|wood|hyphae)$/.test(name) ? Number(count) * 4 : 0), 0),
      requiredWood: 8, table: (inventory.crafting_table || 0) > 0 } satisfies RouteSupplyNeed
    st.why = 'нужно пополнить инструменты до продолжения подхода'
    return false
  }
  let prefetch = null
  try {
  let lastFrom = null; let sameFrom = 0
  const planCap = p.maxPlans ?? (12 + Math.ceil(Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z) / 48))
  // Гаст в 96 бл. с лучом к нам (раз в план): дальнобойный, выше пола — опасен на любом открытом шаге, не по расстоянию.
  const ghastSeen = () => {
    try {
      const P = require('./perception')
      // …и ифриты с лучом в 24 бл.: выход от спавнера открытым ходом убивал (s1-LI-7 06.10: 6 стержней, 10 очей, ne_route из норы у
      // спавнера — смерть на первом шаге).
      return (Object.values(bot.entities || {}) as any[]).some((e: any) => e && e.position && e.isValid !== false && (
        e.name === 'ghast' && e.position.distanceTo(bot.entity.position) < 96 && P.raySees(bot, P.eyePos(bot), e.position.offset(0, 2, 0)) ||
        e.name === 'blaze' && e.position.distanceTo(bot.entity.position) < 24 && P.raySees(bot, P.eyePos(bot), e.position.offset(0, 1.2, 0))))
    } catch { return false }
  }
  // У спавнера ифритов (≤ 28 бл. по памяти) — открытое дороже всегда: из норы у спавнера ифриты лучом не видны, план выводил
  // в открытый зал (s1-LI-7).
  const nearSpawner = () => {
    try {
      const sp = ((session.journal && session.journal.state && session.journal.state.places) || {})['спавнер блейзов']
      return !!sp && Math.hypot(sp.x - bot.entity.position.x, sp.z - bot.entity.position.z) < 28 && Math.abs(sp.y - bot.entity.position.y) < 20
    } catch { return false }
  }
  const planOptions = blocks => ({ solidFloor: !!p.solidFloor, maxNodes: p.maxNodes, maxMs: p.maxPlanMs, blocks: Math.min(24, blocks), fireproof: st.fireproof, partial: true, zone: p.zone, zones: bastionZones(session), zoneExpo: p.zoneExpo,
    digWaitSeconds: receiptCostFor(session).costs.seconds(receiptCostFor(session).context),
    alarm: () => ctl.aborted || !!session.reflex || (process.env.ND_GUARD_REFLEX === '0' && process.env.ND_GUARD !== '0' && !!require('./ne-guard').hot(bot)),
    dangers: liveDangers(session), hot: [...(p.hot || []), ...spawnerHot(session, goal, st.fireproof)], expoMul: ghastSeen() || nearSpawner() ? 3 : 1 })
  const planLog = (pl, from, speculative) => log('план', { from: xyz(from), goal, leg: pl.leg, more: pl.more, prefetched: speculative, ok: pl.ok, steps: pl.steps, digs: pl.digs, expo: pl.expo, risk: pl.risk || 0, cost: pl.cost, digWaitSeconds: pl.digWaitSeconds, nodes: pl.nodes, ms: pl.ms, why2: pl.why2, why: pl.ok ? undefined : pl.why,
    head: (pl.path || []).slice(0, pl.steps <= 12 ? 12 : 4).map(m => `${m.kind}@${m.to.x},${m.to.y},${m.to.z}`).join(' ') })
  { const f0 = feetCell(bot); own.add(`${f0.x},${f0.y},${f0.z}`); own.add(`${f0.x},${f0.y + 1},${f0.z}`) }
  while (!ctl.aborted && gameClock.now() < deadline && st.plans < planCap) {
    if (ctl.waitReflex) await ctl.waitReflex()
    if (!(await keepSupply(true, 120))) break
    if (reached()) { st.ok = true; break }
    st.fireproof = require('./blaze').hasEffect(bot, 'fire_resistance')
    if (inLava(bot)) {
      // Огнестойкость, если есть, — и к берегу.
      if (!st.fireproof) { try { const B = require('./blaze'); await B.drinkFireResistance(bot); st.fireproof = B.hasEffect(bot, 'fire_resistance') } catch {} }
      await lavaSwim(bot, ctl, st)
    }
    if (ctl.aborted) break
    // Перед планом (он бывает 2–15 с): брут/злой вплотную — сперва ответ (VR23-1 03.10: брут бил 8 с, пока считался план).
    if (process.env.ND_GUARD !== '0') {
      const G = require('./ne-guard')
      const h = G.hot(bot, { near: 4 })
      if (h) {
        const rr = await G.react(session, ctl, { force: h, onOwn: cells => { for (const k of cells) own.add(k) } })
        if (rr.cancelled || ctl.aborted || session.bot !== bot) break
        if (rr.acted !== false) {
          st.guards = (st.guards || 0) + 1
          log('страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0), before: 'план' })
        }
      }
    }
    const from = feetCell(bot)
    st.synced = (st.synced || 0) + syncAround(bot, g, st.plans ? 5 : 8)
    // Клетки, куда тело не шагнуло дважды, — снова «непроходимы» (сверка с живыми блоками их стирала: B7f31).
    for (const k of (st.blocked || [])) { const [bx, by, bz] = k.split(',').map(Number); g.mark(bx, by, bz, C.BLOCK) }
    const blocks = bot.inventory.items().filter(i => require('./sealed').FILL_NAMES.includes(i.name)).reduce((n, i) => n + i.count, 0)
    let pl
    if (prefetch && from.x === prefetch.from.x && from.y === prefetch.from.y && from.z === prefetch.from.z && prefetch.fireproof === st.fireproof) {
      pl = await prefetch.promise
      st.prefetched = (st.prefetched || 0) + 1
    } else {
      // Failed/moved defence invalidates the speculative start, not the intent.
      if (prefetch) { prefetch.cancelled = true; await prefetch.promise }
      pl = await plan(g, { x: from.x, y: from.y, z: from.z }, goal, planOptions(blocks))
      st.plans++
      if (pl.why2 !== 'тревога' || (st.pausedPlans || 0) < 8) planLog(pl, from, false)
    }
    prefetch = null
    if (pl.why2 === 'тревога') {
      st.plans--
      st.pausedPlans = (st.pausedPlans || 0) + 1
      if (ctl.waitReflex) await ctl.waitReflex()
      await new Promise<void>(resolve => setImmediate(resolve))
      continue
    }
    if (lastFrom && lastFrom.equals(from)) sameFrom++; else sameFrom = 0
    lastFrom = from
    if (sameFrom >= 5) { st.why = 'на месте после пяти планов'; break }
    if (!pl.path || !pl.path.length) { st.why = pl.why2 || 'пути нет'; st.planWhy = pl.why; break }
    // Неполный план (цель недостижима по сетке) — идём до ближней точки, дальше — решает вызывающий.
    let res = 'ok'
    for (let i = 0; i < pl.path.length && !ctl.aborted && gameClock.now() < deadline; i++) {
      if (ctl.waitReflex) await ctl.waitReflex()
      // Start the next leg while the last 12 physical moves of this one run.
      // Snapshot/arrays belong to that plan; projected digs/blocks describe only
      // the remaining moves. Source mismatch discards it above.
      if (budgetOn() && pl.more && !prefetch && i >= pl.path.length - 12 && st.plans < planCap) {
        const tail = pl.path.slice(i)
        const next: any = { from: pl.path.at(-1).to, fireproof: st.fireproof, cancelled: false }
        const options = planOptions(Math.max(0, blocks - pl.path.filter(m => m.kind === 'bridge' || m.kind === 'vup').length))
        const alarm = options.alarm
        prefetch = next; st.plans++
        next.promise = plan(g, next.from, goal, { ...options, projected: tail, alarm: () => next.cancelled || alarm() })
          .then(r => { planLog(r, next.from, true); return r }, e => ({ ok: false, path: [], why2: e.message }))
      }
      // Страж ближнего боя (ND_GUARD=1, ne-guard): удар/брут вплотную — ответ до шага (проверка угроз раз в 4 шага
      // запаздывала на секунды: VR22-3/VR31-2 03.10 — брут, 3 удара за 2 с посреди хода к золоту).
      if (process.env.ND_GUARD !== '0') {
        const G = require('./ne-guard')
        const h = G.hot(bot)
        if (h) {
          const rr = await G.react(session, ctl, { force: h, onOwn: cells => { for (const k of cells) own.add(k) } })
          if (rr.cancelled || ctl.aborted || session.bot !== bot) { res = 'stop:прервано'; break }
          if (rr.acted !== false) {
            st.guards = (st.guards || 0) + 1
            log('страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) })
            res = 'replan'; break
          }
        }
      }
      if (!(await keepSupply(true, Math.min(260, 30 + Math.ceil(1.3 * pl.path.slice(i).reduce((n, m) => n + (m.dig ? m.dig.length : 0), 0)))))) { res = 'stop:' + (st.supplyNeeded ? st.why : 'прервано'); break }
      // Иссушитель/брут вплотную — ответ на каждом шаге, а не раз в 4 (s1c-D-2 06.10: 5 ударов по 4.8 за один длинный шаг спуска).
      if (i % 4 !== 0 && process.env.ND_WITHER_PIT !== '0' && (Object.values(bot.entities || {}) as any[]).some((e: any) => e && /^(wither_skeleton|piglin_brute)$/.test(e.name || '') &&
          e.isValid !== false && e.position && e.position.distanceTo(bot.entity.position) < 3.6)) {
        if (await threatCheck(session, ctl, st)) { res = 'replan'; break }
      }
      // abortNear: враг из списка виден ближе r — ход бросить (золото у двора: брут — D2-31 03.10, три удара за 2 с). На каждом шаге,
      // а не раз в 4 (s1c-F-3 06.10: ход к помосту среди ифритов — 26 урона ударами до обрыва хода).
      if (p.abortNear) {
        const P = require('./perception')
        const re = p.abortNear.re instanceof RegExp ? p.abortNear.re : new RegExp(p.abortNear.re || '^(piglin_brute|hoglin)$')
        const near: any = (Object.values(bot.entities || {}) as any[]).find((e : any) => e && e.position && e.isValid !== false && re.test(e.name || '') && e.position.distanceTo(bot.entity.position) < (p.abortNear.r || 10) && (() => { try { return P.raySees(bot, P.eyePos(bot), e.position.offset(0, 1.2, 0)) } catch { return true } })())
        if (near) { res = 'stop:рядом ' + near.name; break }
      }
      if (i % 4 === 0) {
        if (i % 40 === 0) await makeRoom(bot, 5)
        // Кирки: каменных не осталось — сделать из булыжника/чернокамня (железная — золоту бастиона).
        // Не у самой цели (у спавнера — блейзы: крафт 80 с под ударами, neF-B5f31-1): там — любая кирка, и железная.
        const nearGoal = Math.hypot(bot.entity.position.x - goal.x, bot.entity.position.z - goal.z) < 28
        if (nearGoal && bot._ndToolFilter && p.ironOk) bot._ndToolFilter = filter0
        if (process.env.ND_NE_STAY === '1' && bot._ndToolFilter && ironOnly()) bot._ndToolFilter = filter0
        // ND_GUARD=1: ближний враг в 12 бл. — не крафт (верстак — секунды без ответа: B1-31 03.10, брут убил за крафтом кирок).
        const calm = process.env.ND_GUARD === '0' || !require('./ne-guard').meleeFoes(bot, 12).length
        if (calm && !nearGoal && i % 12 === 0 && pl.path.slice(i, i + 12).some(m => m.dig.length) && require('./tunnel').lowPicks(bot) < 2) {
          const made = await require('./tunnel').restockPicks(session, ctl, 2, p.supplyReserve ? { reservePlanks: 8 } : {}).catch(() => 0)
          st.crafted = (st.crafted || 0) + (made || 0)
          if (made) log('кирки', { made, low: require('./tunnel').lowPicks(bot) })
          // Камня на каменные нет, а кирок никаких — железная из слитков/самородков/блоков сундуков (D5-23/31 03.10: «бой у
          // спавнера: не хватает кирки» при 2 слитках и самородках).
          if (!made && !bot.inventory.items().some(it => /_pickaxe$/.test(it.name))) {
            const ok = await require('./bastion').makeIronPick(session, ctl).catch(() => false)
            log('кирки: железная', { ok })
            if (!ok) { const g = await goldPicks(session, ctl, 2); if (g) log('кирки: золотые', { made: g }) }
          }
        }
        if (await threatCheck(session, ctl, st)) { res = 'replan'; break }
        await eatIfLow(session, ctl)
        if ((bot.health ?? 20) < 6) { res = 'stop:хп ' + Math.round(bot.health ?? 0); break }
      }
      // Впереди (5 ходов) опасные шаги, огнестойкости нет, а зелий больше, чем просили оставить, — выпить; у точки frNear
      // (спавнер: блейзы) — любое зелье.
      const nearFr = p.frNear && Math.hypot(bot.entity.position.x - p.frNear.x, bot.entity.position.z - p.frNear.z) <= (p.frNear.r ?? 20) && Math.abs(bot.entity.position.y - (p.frNear.y ?? bot.entity.position.y)) <= 24
      if ((p.frKeep != null || nearFr) && !st.fireproof && (nearFr || pl.path.slice(i, i + 5).some(m => m.risk))) {
        const B = require('./blaze')
        const { potionOf } = require('./pvp')
        const frN = bot.inventory.items().filter(it => /potion$/.test(it.name) && /fire_resistance$/.test(potionOf(it) || '')).reduce((n, it) => n + it.count, 0)
        if ((nearFr ? frN > 0 : frN > p.frKeep) && !B.hasEffect(bot, 'fire_resistance')) {
          const d = await B.drinkFireResistance(bot).catch(e => e.message)
          for (let q = 0; q < 20 && !B.hasEffect(bot, 'fire_resistance'); q++) await sleep(100)
          st.fireproof = B.hasEffect(bot, 'fire_resistance')
          st.drinks = (st.drinks || 0) + 1
          log('огнестойкость перед опасным', { d, left: frN - 1, at: xyz(bot.entity.position) })
        }
      }
      const r = await stepOne(session, ctl, g, pl.path[i], st)
      if (r !== 'ok') { res = r; break }
      if (i % 20 === 0) st.fireproof = require('./blaze').hasEffect(bot, 'fire_resistance')
      st.steps++
      if (st.steps % 50 === 0) log('ход', { steps: st.steps, of: pl.steps, dug: st.dug, s: Math.round((gameClock.now() - t0) / 1000), at: xyz(bot.entity.position), hp: Math.round(bot.health ?? 0) })
      // Свои клетки (тело прошло, копал) — для штрека бастиона (sealedGold: «свои» не чужой воздух).
      const t = pl.path[i].to
      own.add(`${t.x},${t.y},${t.z}`); own.add(`${t.x},${t.y + 1},${t.z}`)
      for (const c of pl.path[i].dig) own.add(`${c[0]},${c[1]},${c[2]}`)
    }
    if (res.startsWith('stop:')) { st.why = res.slice(5); break }
    // Неполный план по пределу узлов — дошли до ближней к цели точки, план снова оттуда; поиск исчерпан — путей нет.
    if (res === 'ok' && !pl.ok && !pl.limit && !pl.more && !reached()) { st.why = 'по сетке дальше пути нет'; st.planWhy = pl.why; break }
  }
  } finally { if (prefetch) { prefetch.cancelled = true; await prefetch.promise }; bot._ndToolFilter = filter0; session.emergencyOff = emOff0 }
  if (!ctl.aborted && session.bot === bot && !reached()) await keepSupply(false, 120)
  st.ok = !st.supplyNeeded && (st.ok || reached())
  if (!st.ok && !st.why) st.why = ctl.aborted ? 'прервано' : gameClock.now() >= deadline ? 'время вышло' : 'планов много'
  st.seconds = Math.round((gameClock.now() - t0) / 1000)
  st.at = xyz(bot.entity.position)
  st.speed = st.seconds ? Math.round(st.steps / st.seconds * 100) / 100 : null
  log('итог', st)
  st.own = own
  return st
}

module.exports = { gridOf, plan, legGoal, routeTo, enabled, feetCell, makeRoom, rangedClear, pitFight, bruteSpots, goldPicks }
