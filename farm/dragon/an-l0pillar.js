// Офлайн: L0 — кровать на проход головы у центра за 11–20 тиков до «сел» (подушка у столба, станция в
// окопе за краем чаши), и уживается ли она с L (за 2 тика до «сел»): L0 не сносит кровать L, окоп общий
// или свой. Плоский мир с точной чашей фонтана (EndPodiumFeature) и стойкостью блоков 1.21.11.
// node farm/dragon/an-l0pillar.js farm/logs/trace-fin3-*/rec-*.jsonl
const fs = require('fs')
const REG = require('../../daemon/node_modules/minecraft-data')('1.21.11')
const Vec3 = require('../../daemon/node_modules/vec3')
const dragon = require('../../daemon/src/dragon')

function world (P) {
  const o = Math.floor(P) - 4 // origin.y: слой портала; пол чаши — o − 1; обод — на o
  const top = o // верх земли вокруг: блок на o (ноги на o + 1 = P − 3)
  return p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const r = Math.hypot(x, z)
    let name = 'air'
    if (y <= top && y >= top - 20) name = 'end_stone'
    if (r <= 3.5) {
      if (y < o && y >= o - 3) name = 'bedrock'
      else if (y === o) name = r >= 2.5 ? 'bedrock' : 'air'
      else if (y > o) name = 'air'
    }
    if (x === 0 && z === 0 && y >= o && y <= o + 3) name = 'bedrock'
    if (y === o + 2 && Math.abs(x) + Math.abs(z) === 1) name = 'wall_torch'
    const solid = name !== 'air' && name !== 'wall_torch'
    return { name, boundingBox: solid ? 'block' : 'empty', position: new Vec3(x, y, z), shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
}
const q8 = r => Math.round(r * 256 / 360) * 360 / 256
let N = 0; let n0 = 0; let both = 0; const out = []; const why = {}
for (const file of process.argv.slice(2)) {
  const L = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(x => x && x.ph != null && x.p)
  const byGt = new Map(L.map(x => [x.gt, x]))
  for (let i = 1; i < L.length; i++) {
    if (!([5, 6, 7].includes(L[i].ph) && L[i - 1].ph === 3 && L[i].gt - L[i - 1].gt === 1)) continue
    const gs = L[i].gt; const P = L[i].p[1]; const kb = gs - 120
    const a = byGt.get(kb - 3); const b = byGt.get(kb)
    if (!a || !b || a.ph !== 3 || b.ph !== 3) continue
    const pk = (x, t) => ({ t, id: 1, x: x.p[0], y: x.p[1], z: x.p[2], vx: x.v[0], vy: x.v[1], vz: x.v[2], yRot: dragon.yRotOf(Math.PI - q8(x.r[0]) * Math.PI / 180), ph: dragon.PHASE.LANDING })
    const fc = dragon.landingForecast({ list: [pk(a, 0), pk(b, 150)] }, Math.floor(P))
    if (!fc || fc.n < 40) continue
    N++
    const bot = { entity: { position: new Vec3(12.5, Math.floor(P) - 3, 0.5), yaw: 0, pitch: 0, height: 1.8, onGround: true }, blockAt: world(P), entities: {}, inventory: { items: () => [] }, game: { dimension: 'the_end' }, registry: REG }
    // проход головы у центра: тик i0 в [n−20, n−12] с головой ближе всего к центру
    let i0 = null; let best = 99
    for (let k = fc.n - 20; k <= fc.n - 12; k++) { const st = fc.path[k]; if (!st) continue; const d = Math.hypot(st.head.x - 0.5, st.head.z - 0.5); if (d < best) { best = d; i0 = k } }
    if (i0 == null) continue
    const tgt = fc.path[i0].head
    const fc0 = { ...fc, n: i0 + 2 } // кровать L0 не на пути головы до её тика
    let p0 = null
    for (const lift of [2, 3, 1]) { const p = dragon.tsPlan(bot, tgt, { lift, fc: fc0, dpos: new Vec3(fc.sit.x, fc.sit.y, fc.sit.z), portalOk: true, radius: 3.2 }); if (p && (!p0 || p.cost < p0.cost)) p0 = p; if (!p) for (const [k, v] of Object.entries(dragon.tsPlan.why || {})) why[k] = (why[k] || 0) + v }
    if (p0) n0++
    // L после толчка L0 — у того же окопа или свой; кровать L переживает взрыв L0
    let L2 = null
    if (p0) {
      const fc2 = dragon.pushedForecast(fc, i0, p0.centre, p0.seen || 1, Math.floor(P))
      if (fc2 && (fc2.n - 2) - (i0 + 1) >= 10) {
        const t2 = (fc2.path[fc2.n - 3] || fc2.path[fc2.path.length - 1]).head
        const ex0 = dragon.stationWorld(p0, p0.world)
        for (const fixed of [p0.B, null]) {
          for (const lift of [2, 1]) {
            const avoid = new Set([p0.F, p0.W, p0.V, p0.PS, p0.H].map(q => `${q.x},${q.z}`))
            if (!fixed) avoid.add(`${p0.B.x},${p0.B.z}`)
            const q = dragon.tsPlan(bot, t2, { lift, fc: fc2, dpos: new Vec3(fc2.sit.x, fc2.sit.y, fc2.sit.z), fixedB: fixed, avoid, extra: ex0, radius: fixed ? 3.8 : 2.6 })
            if (!q) continue
            const ex = dragon.stationWorld(q, ex0)
            const vb = { ...bot, blockAt: p => { const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; if (ex.has(k)) { const v = ex.get(k); const pos = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return v === 'air' ? { name: 'air', boundingBox: 'empty', shapes: [], position: pos } : v === 'bed' ? { name: 'red_bed', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5625, 1]], position: pos } : { name: 'cobblestone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: pos } } return bot.blockAt(p) } }
            if (dragon.blastReaches(vb, bot, p0.centre, dragon.stationCells(q))) continue
            if (!L2 || q.expect > L2.expect) L2 = { ...q, shared: !!fixed }
          }
          if (L2) break
        }
      }
    }
    if (L2) both++
    out.push(`проход ${best.toFixed(1)} от центра за ${fc.n - i0} т.: L0 ${p0 ? p0.expect + '@' + p0.dist + ' L' + p0.lift + ' окоп r' + Math.hypot(p0.B.x + 0.5, p0.B.z + 0.5).toFixed(1) : '—'}  L ${L2 ? L2.expect + (L2.shared ? ' (общий окоп)' : ' (свой окоп)') : '—'}`)
    if (N >= 20) break
  }
  if (N >= 20) break
}
console.log(`посадок ${N}: L0 у центра — ${n0}, L0 + L вместе — ${both}`)
console.log(out.join('\n'))
console.log(why)
