'use strict'
const fs = require('fs')
const path = require('path')
process.env.SURFACE_REGION = path.resolve(__dirname, '../server-2/world/region')
const { height, block } = require('./surface-map')
const S = { x: -20, z: -24 }
const G = { x: -236, z: 736 }
const STEP = 4
const key = p => `${p.x},${p.z}`
const H = p => Math.hypot(p.x - G.x, p.z - G.z)
const cache = new Map()
function cell (p) {
  const k = key(p)
  if (cache.has(k)) return cache.get(k)
  const y = height(p.x, p.z)
  const name = y === null ? null : block(p.x, y - 1, p.z)
  const ok = name && !/water|lava|leaves|log|bamboo|cactus|magma/.test(name)
  const c = ok ? { ...p, y } : null
  cache.set(k, c)
  return c
}
const heap = []
function push (n) { heap.push(n); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].f <= n.f) break; heap[i] = heap[p]; i = p } heap[i] = n }
function pop () { const first = heap[0]; const last = heap.pop(); if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let c = i * 2 + 1; if (c + 1 < heap.length && heap[c + 1].f < heap[c].f) c++; if (heap[c].f >= last.f) break; heap[i] = heap[c]; i = c } heap[i] = last } return first }
const costs = new Map([[key(S), 0]])
const prev = new Map()
push({ ...S, g: 0, f: H(S) })
let done = null
let nodes = 0
while (heap.length && nodes++ < 50000) {
  const p = pop()
  if (costs.get(key(p)) !== p.g) continue
  if (H(p) <= STEP) { done = p; break }
  const pc = cell(p)
  if (!pc) continue
  for (const [dx, dz] of [[STEP, 0], [-STEP, 0], [0, STEP], [0, -STEP], [STEP, STEP], [STEP, -STEP], [-STEP, STEP], [-STEP, -STEP]]) {
    const q = { x: p.x + dx, z: p.z + dz }
    if (q.x < -512 || q.x > 128 || q.z < -80 || q.z > 800) continue
    const qc = cell(q)
    if (!qc || Math.abs(qc.y - pc.y) > 8) continue
    const g = p.g + Math.hypot(dx, dz) + Math.abs(qc.y - pc.y) * 2 + Math.max(0, qc.y - 85) * 0.12
    if (g >= (costs.get(key(q)) ?? Infinity)) continue
    costs.set(key(q), g); prev.set(key(q), { x: p.x, z: p.z })
    push({ ...q, g, f: g + H(q) })
  }
}
if (!done) { console.log(JSON.stringify({ found: false, nodes, knownCells: cache.size })); process.exit(0) }
const route = []
for (let p = done; p; p = prev.get(key(p))) route.unshift(cell(p))
function dryLine (a, b) {
  const dist = Math.hypot(b.x - a.x, b.z - a.z)
  for (let t = 0; t <= dist; t++) {
    const x = Math.round(a.x + (b.x - a.x) * t / dist)
    const z = Math.round(a.z + (b.z - a.z) * t / dist)
    const y = height(x, z)
    if (y === null || /water|lava/.test(block(x, y - 1, z))) return false
  }
  return true
}
const waypoints = []
for (let i = 0; i < route.length - 1;) {
  let j = i + 1
  while (j + 1 < route.length && Math.hypot(route[j + 1].x - route[i].x, route[j + 1].z - route[i].z) <= 48 && dryLine(route[i], route[j + 1])) j++
  waypoints.push(route[j]); i = j
}
const rec = { found: true, nodes, estimatedCost: Math.round(done.g), distance: Math.round(route.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - route[i].x, p.z - route[i].z), 0)), waypoints, route }
fs.writeFileSync(path.join(__dirname, 'land-plan.json'), JSON.stringify(rec))
console.log(JSON.stringify({ ...rec, route: undefined }))
