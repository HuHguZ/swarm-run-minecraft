'use strict'
// Движение дракона по байткоду Paper 1.21.11 (EnderDragon.aiStep, ветка полёта; части — tickPart;
// узлы и путь — findClosestNode/findPath; взлёт — DragonTakeoffPhase). Всё в градусах/блоках сервера:
// yRot — как в NBT Rotation[0], голова по (sin yRot, −cos yRot).
const SIN = new Float32Array(65536)
for (let i = 0; i < 65536; i++) SIN[i] = Math.fround(Math.sin(i * Math.PI * 2 / 65536))
const idx = v => { let n = Math.trunc(v); n %= 65536; if (n < 0) n += 65536; return n }
const msin = d => SIN[idx(d * 10430.378350470453)]
const mcos = d => SIN[idx(d * 10430.378350470453 + 16384)]
const RAD = 0.017453292
const wrap = f => { f %= 360; if (f >= 180) f -= 360; if (f < -180) f += 360; return f }
const clamp = (v, a, b) => v < a ? a : v > b ? b : v
const norm = (x, y, z) => { const l = Math.sqrt(x * x + y * y + z * z); return l < 1e-4 ? [0, 0, 0] : [x / l, y / l, z / l] }

// Состояние: { x, y, z, vx, vy, vz, yRot, yRotA, hist: [y0 (этот тик), y1, …] , inWall }
function clone (s) { return { ...s, hist: s.hist.slice() } }
// Один тик полёта к цели T (flySpeed, turn(s) — getTurnSpeed фазы).
function step (s, T, flySpeed, turn) {
  s.hist.unshift(s.y); if (s.hist.length > 12) s.hist.length = 12
  const dx = T.x - s.x; let e = T.y - s.y; const dz = T.z - s.z
  const g = dx * dx + e * e + dz * dz
  const j = Math.sqrt(dx * dx + dz * dz)
  const dyRaw = e
  if (j > 0) e = clamp(e / j, -flySpeed, flySpeed)
  s.vy += e * 0.01
  s.yRot = wrap(s.yRot)
  const v32 = norm(dx, dyRaw, dz)
  const v33 = norm(msin(s.yRot * RAD), s.vy, -mcos(s.yRot * RAD))
  const k = Math.max((v33[0] * v32[0] + v33[1] * v32[1] + v33[2] * v32[2] + 0.5) / 1.5, 0)
  if (Math.abs(dx) > 1e-5 || Math.abs(dz) > 1e-5) {
    const l = clamp(wrap(180 - Math.atan2(dx, dz) * 57.295776 - s.yRot), -50, 50)
    s.yRotA *= 0.8
    s.yRotA += l * turn(s)
    s.yRot += s.yRotA * 0.1
  }
  const l2 = 2 / (g + 1)
  const sp = 0.06 * (k * l2 + (1 - l2))
  s.vx += sp * msin(s.yRot * RAD); s.vz += -sp * mcos(s.yRot * RAD)
  const m = s.inWall ? 0.8 : 1
  s.x += s.vx * m; s.y += s.vy * m; s.z += s.vz * m
  const v34 = norm(s.vx, s.vy, s.vz)
  const n = 0.8 + 0.15 * (v34[0] * v33[0] + v34[1] * v33[1] + v34[2] * v33[2] + 1) / 2
  s.vx *= n; s.vy *= 0.91; s.vz *= n
  return s
}
const turnLanding = s => { const f = Math.hypot(s.vx, s.vz) + 1; return Math.min(f, 40) / f }
const turnDefault = s => { const f = Math.hypot(s.vx, s.vz) + 1; return 0.7 / Math.min(f, 40) / f }
// Низ-центр коробки головы (1×1×1) после тика; sitting — сидячие фазы.
function headOf (s, sitting = false) {
  const h = s.hist
  const y5 = h[5] ?? s.y; const y10 = h[10] ?? s.y; const y0 = h[0] ?? s.y
  const f16 = (y5 - y10) * 10 * RAD
  const f17 = mcos(f16); const f18 = msin(f16)
  const a = s.yRot * RAD - s.yRotA * 0.01
  const off = sitting ? -1 : (y5 - y0)
  return { x: s.x + msin(a) * 6.5 * f17, y: s.y + off + f18 * 6.5, z: s.z - mcos(a) * 6.5 * f17 }
}
function neckOf (s, sitting = false) {
  const h = s.hist
  const y5 = h[5] ?? s.y; const y10 = h[10] ?? s.y; const y0 = h[0] ?? s.y
  const f16 = (y5 - y10) * 10 * RAD
  const f17 = mcos(f16); const f18 = msin(f16)
  const a = s.yRot * RAD - s.yRotA * 0.01
  const off = sitting ? -1 : (y5 - y0)
  return { x: s.x + msin(a) * 5.5 * f17, y: s.y + off + f18 * 5.5, z: s.z - mcos(a) * 5.5 * f17 }
}

// Узлы пути (findClosestNode, первая инициализация): h(x, z) — MOTION_BLOCKING_NO_LEAVES (y первого
// воздуха над верхним непрозрачным для движения блоком) в клетке (x, z).
function nodesOf (h) {
  const out = []
  for (let i = 0; i < 24; i++) {
    let k; let l; let j = 5
    if (i < 12) { const a = 2 * (-3.1415927 + 0.2617994 * i); k = Math.floor(60 * mcos(a)); l = Math.floor(60 * msin(a)) } else if (i < 20) { const m = i - 12; const a = 2 * (-3.1415927 + 0.3926991 * m); k = Math.floor(40 * mcos(a)); l = Math.floor(40 * msin(a)); j += 10 } else { const m = i - 20; const a = 2 * (-3.1415927 + 0.7853982 * m); k = Math.floor(20 * mcos(a)); l = Math.floor(20 * msin(a)) }
    out.push({ i, x: k, y: Math.max(73, h(k, l) + j), z: l })
  }
  return out
}
const ADJ = [6146, 8197, 8202, 16404, 32808, 32848, 65696, 131392, 131712, 263424, 526848, 525313, 1581057, 3166214, 2138120, 6373424, 4358208, 12910976, 9044480, 9706496, 15216640, 13688832, 11763712, 8257536]
const nd2 = (a, b) => { const x = a.x - b.x; const y = a.y - b.y; const z = a.z - b.z; return Math.fround(x * x + y * y + z * z) }
const ndist = (a, b) => Math.fround(Math.sqrt(nd2(a, b)))
function closestNode (nodes, x, y, z, crystals = 10) {
  const p = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
  let f = 10000; let best = 0
  for (let k = crystals === 0 ? 12 : 0; k < 24; k++) { const g = nd2(nodes[k], p); if (g < f) { f = g; best = k } }
  return best
}
// A* как в EnderDragon.findPath (двоичная куча Minecraft по f).
function findPath (nodes, start, end, crystals = 10) {
  const N = nodes.map(n => ({ ...n, closed: false, f: 0, g: 0, h: 0, from: null, heap: -1 }))
  const heap = []
  const up = i => { const n = heap[i]; const f = n.f; while (i > 0) { const p = (i - 1) >> 1; const q = heap[p]; if (!(f < q.f)) break; heap[i] = q; q.heap = i; i = p } heap[i] = n; n.heap = i }
  const down = i => {
    const n = heap[i]; const f = n.f
    for (;;) {
      const a = 1 + (i << 1); const b = a + 1
      if (a >= heap.length) break
      const na = heap[a]; const fa = na.f
      let nb = null; let fb = Infinity
      if (b < heap.length) { nb = heap[b]; fb = nb.f }
      if (fa < fb) { if (!(fa < f)) break; heap[i] = na; na.heap = i; i = a } else { if (!(fb < f)) break; heap[i] = nb; nb.heap = i; i = b }
    }
    heap[i] = n; n.heap = i
  }
  const insert = n => { heap.push(n); n.heap = heap.length - 1; up(n.heap) }
  const pop = () => { const n = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; last.heap = 0; down(0) } n.heap = -1; return n }
  const change = (n, f) => { const o = n.f; n.f = f; if (f < o) up(n.heap); else down(n.heap) }
  const s = N[start]; const t = N[end]
  s.g = 0; s.h = ndist(s, t); s.f = s.h
  insert(s)
  let best = s
  const from = crystals === 0 ? 12 : 0
  while (heap.length) {
    const n = pop()
    if (n.i === t.i) return recon(t)
    if (ndist(n, t) < ndist(best, t)) best = n
    n.closed = true
    for (let k = from; k < 24; k++) {
      if (!((ADJ[n.i] & (1 << k)) > 0)) continue
      const m = N[k]
      if (m.closed) continue
      const g = Math.fround(n.g + ndist(n, m))
      if (m.heap >= 0 && !(g < m.g)) continue
      m.from = n; m.g = g; m.h = ndist(m, t)
      if (m.heap >= 0) change(m, Math.fround(m.g + m.h))
      else { m.f = Math.fround(m.g + m.h); insert(m) }
    }
  }
  return best === s ? null : recon(best)
  function recon (e) { const out = [e]; while (e.from) { e = e.from; out.unshift(e) } return out.map(q => q.i) }
}
// Куда полетит на взлёте (DragonTakeoffPhase.findNewTarget → navigateToNextPathNode): узел пути №1.
function takeoffTarget (nodes, s, crystals = 10) {
  const i = closestNode(nodes, s.x, s.y, s.z, crystals)
  // getHeadLookVector на взлёте: взгляд по yRot (без yRotA), −look·40 — по голове.
  const hx = msin(s.yRot * RAD); const hz = -mcos(s.yRot * RAD)
  let j = closestNode(nodes, hx * 40, 105, hz * 40, crystals)
  if (crystals > 0) { j %= 12; if (j < 0) j += 12 } else { j -= 12; j &= 7; j += 12 }
  const path = findPath(nodes, i, j, crystals)
  if (!path || path.length < 2) return { i, j, path, node: null }
  return { i, j, path, node: nodes[path[1]] }
}
module.exports = { msin, mcos, wrap, step, clone, headOf, neckOf, turnLanding, turnDefault, nodesOf, closestNode, findPath, takeoffTarget, ADJ }
