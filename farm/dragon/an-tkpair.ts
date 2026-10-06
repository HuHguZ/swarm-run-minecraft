// Офлайн по записанным взлётам (rec-*.jsonl): две кровати из ОДНОГО окопа (две станции L-типа у общего окопа).
//   MODE=nat (взлёт сам, сидел ≥ 95 тиков): 1 — голова на k=KA, 2 — на k=KB (через ≥ 10 тиков).
//   MODE=dmg (взлёт от урона): 1 — голова сидя (X, взрыв поднимает на взлёт), 2 — голова на k=10.
// node farm/dragon/an-tkpair.js farm/logs/trace-fin3-*/rec-*.jsonl
const fs = require('fs')
const REG = require('C:/Users/user/Desktop/work/minecraft-claude/daemon/node_modules/minecraft-data')('1.21.11')
const Vec3 = require('../../daemon/node_modules/vec3')
const dragon = require('../../daemon/src/dragon')
const S = require('./dsim')

function world (P) {
  const top = P - 4
  return p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    let s = y <= top && y >= top - 20
    let name = 'end_stone'
    const r = Math.hypot(x + 0.5, z + 0.5)
    if (r <= 3.5 && y >= top - 3 && y <= top) { s = true; name = 'bedrock' }
    if (x === 0 && z === 0 && y >= top && y <= P - 1) { s = true; name = 'bedrock' }
    return { name: s ? name : 'air', boundingBox: s ? 'block' : 'empty', position: new Vec3(x, y, z), shapes: s ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
}
function vbotOf (bot, map) {
  return {
    ...bot,
    blockAt (p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = `${x},${y},${z}`
      if (map.has(k)) {
        const v = map.get(k); const pos = new Vec3(x, y, z)
        if (v === 'air') return { name: 'air', boundingBox: 'empty', shapes: [], position: pos }
        if (v === 'bed') return { name: 'red_bed', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5625, 1]], position: pos }
        return { name: 'cobblestone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: pos }
      }
      return bot.blockAt(p)
    }
  }
}
const ovl = (A, B) => A.min.x < B.max.x && A.max.x > B.min.x && A.min.y < B.max.y && A.max.y > B.min.y && A.min.z < B.max.z && A.max.z > B.min.z

const mode = process.env.MODE || 'nat'
const KA = +(process.env.KA || 2); const KB = +(process.env.KB || 12)
const MAXN = +(process.env.MAXN || 30)
let N = 0; let ok = 0; const why: Record<string, any> = {} as Record<string, any>; const sums = []
const note = k => { why[k] = (why[k] || 0) + 1 }
outer:
for (const file of process.argv.slice(2)) {
  const L = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(x => x && x.ph != null && x.p)
  const byGt = new Map(L.map(x => [x.gt, x]))
  const st = (gt, yRotA) => {
    const x: any = byGt.get(gt); if (!x) return null
    const hist = []; for (let k = 0; k <= 10; k++) { const h: any = byGt.get(gt - k); hist.push(h ? h.p[1] : x.p[1]) }
    return { x: x.p[0], y: x.p[1], z: x.p[2], yRot: x.r[0], yRotA, hist, vx: 0, vy: 0, vz: 0 }
  }
  for (let i = 1; i < L.length; i++) {
    if (!(L[i].ph === 4 && L[i - 1].ph !== 4 && L[i - 1].gt === L[i].gt - 1)) continue
    const g0 = L[i].gt
    let gs = g0 - 1; while (byGt.get(gs - 1) && [5, 6, 7].includes((byGt.get(gs - 1) as any).ph)) gs--
    const dur = g0 - gs
    if ((mode === 'nat') !== (dur >= 95)) continue
    const last: any = byGt.get(gs - 1); const prev: any = byGt.get(gs - 2)
    if (!last || !prev) continue
    const sit = st(g0 - 1, S.wrap(last.r[0] - prev.r[0]) * 10); if (!sit) continue
    const P = sit.y
    const hs = S.headOf(sit, true); const ns = S.neckOf(sit, true)
    const path = []
    let bad = false
    for (let k = 0; k <= 25; k++) {
      const a: any = byGt.get(g0 + k); const b: any = byGt.get(g0 + k - 1)
      if (!a || !b) { bad = true; break }
      const s = st(g0 + k, S.wrap(a.r[0] - b.r[0]) * 10)
      const h = S.headOf(s, false); const n = S.neckOf(s, false)
      path.push({ k, head: new Vec3(h.x, h.y, h.z), neck: new Vec3(n.x, n.y, n.z), pos: new Vec3(s.x, s.y, s.z), yRot: s.yRot })
    }
    if (bad) continue
    N++
    const bot = { entity: { position: new Vec3(12.5, P - 3, 0.5), yaw: 0, pitch: 0, height: 1.8, onGround: true }, blockAt: world(P), entities: {} as Record<string, any>, inventory: { items: () => [] }, game: { dimension: 'the_end' }, registry: REG }
    const fcOf = kT => ({ n: kT + 3, path: path.slice(0, kT + 1), sit, head: new Vec3(hs.x, hs.y, hs.z), neck: new Vec3(ns.x, ns.y, ns.z) })
    const t1 = mode === 'nat' ? path[KA].head : new Vec3(hs.x, hs.y, hs.z)
    const k2 = mode === 'nat' ? KB : 10
    const t2 = path[k2].head
    const dpos = new Vec3(sit.x, sit.y, sit.z)
    const fc1 = mode === 'nat' ? fcOf(KA) : { ...fcOf(0), path: [], n: 0 }
    const fc2 = fcOf(k2)
    const sitP = dragon.predParts(fcOf(0))
    const c1 = []
    for (const lift of [0, 1, 2, 3]) { dragon.tsPlan(bot, t1, { lift, fc: fc1, dpos }); c1.push(...(dragon.tsPlan.all || [])) }
    if (!c1.length) { note('нет станции 1'); continue }
    let best = null
    const seenB = new Set()
    for (const c of c1.filter(q => !q.psLift).sort((p, q) => q.expect - p.expect)) {
      const kb = `${c.B.x},${c.B.z}`; if (seenB.has(kb)) continue; seenB.add(kb); if (seenB.size > 12) break
      const bb1 = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
      if (mode === 'nat' && (ovl(bb1, sitP.head) || ovl(bb1, sitP.neck) || ovl(bb1, sitP.body))) { note('1 в сидячих коробках'); continue }
      const ex1 = dragon.stationWorld(c, c.world)
      const avoid = new Set([c.F, c.W, c.V, c.PS, c.H].map(q => `${q.x},${q.z}`))
      const c2 = []
      for (const lift of [0, 1, 2, 3]) { dragon.tsPlan(bot, t2, { lift, fc: fc2, dpos, fixedB: c.B, avoid, extra: ex1, radius: 3.8 }); c2.push(...(dragon.tsPlan.all || [])) }
      if (!c2.length) { note('нет станции 2 у окопа'); continue }
      const destroyed = dragon.blastDestroyed(vbotOf(bot, ex1), bot, c.centre)
      for (const d of c2.filter(q => !q.psLift).sort((p, q) => q.expect - p.expect).slice(0, 6)) {
        const cells = [{ x: d.F.x, y: d.yb, z: d.F.z }, { x: d.H.x, y: d.yb, z: d.H.z }, ...d.sCells.map(y => ({ x: d.F.x, y, z: d.F.z })), ...d.wCells.map(y => ({ x: d.W.x, y, z: d.W.z }))]
        const both = dragon.stationWorld(d, ex1)
        const bb = { min: new Vec3(Math.min(d.F.x, d.H.x), d.yb, Math.min(d.F.z, d.H.z)), max: new Vec3(Math.max(d.F.x, d.H.x) + 1, d.yb + 1, Math.max(d.F.z, d.H.z) + 1) }
        if (ovl(bb, sitP.head) || ovl(bb, sitP.neck) || ovl(bb, sitP.body)) { note('2 в сидячих коробках'); continue }
        if (dragon.blastReaches(vbotOf(bot, both), bot, c.centre, cells)) { note('взрыв 1 снесёт 2'); continue }
        const post = new Map(both)
        for (const k of destroyed) post.set(k, 'air')
        post.set(`${c.F.x},${c.yb},${c.F.z}`, 'air'); post.set(`${c.H.x},${c.yb},${c.H.z}`, 'air')
        for (const q of cells) post.set(`${q.x},${q.y},${q.z}`, q.y === d.yb && ((q.x === d.F.x && q.z === d.F.z) || (q.x === d.H.x && q.z === d.H.z)) ? 'bed' : 'block')
        const vPost = vbotOf(bot, post)
        if (dragon.exposure(vPost, c.trench, d.centre) > 0.02) { note('после 1 окоп открыт 2'); continue }
        if (!dragon.tsClickPoint(vPost, c.trench.offset(0, 1.62, 0), d)) { note('после 1 бок 2 не видно'); continue }
        if (!dragon.tsClickPoint(vbotOf(bot, both), c.trench.offset(0, 1.62, 0), c)) { note('2 закрыла бок 1'); continue }
        const e2 = dragon.bedDamage(d.centre.distanceTo(t2), d.seen || 1)
        const sum = c.expect + e2
        if (!best || sum > best.sum) best = { sum, e1: c.expect, e2, d1: c.centre.distanceTo(t1).toFixed(1), d2: d.centre.distanceTo(t2).toFixed(1) }
      }
    }
    if (best) { ok++; sums.push(best) } else note('пары нет')
    if (N >= MAXN) break outer
  }
}
sums.sort((a, b) => b.sum - a.sum)
console.log(`${mode}: взлётов ${N}, пара есть ${ok}`)
console.log(sums.map(s => `${s.e1}@${s.d1}+${s.e2}@${s.d2}=${s.sum}`).join('  '))
console.log(why)
