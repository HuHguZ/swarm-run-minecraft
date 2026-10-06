// Сколько места над землёй у столба на снижении: по записи сервера (rec*.jsonl) — низ коробок головы/шеи/тела/крыльев
// над кольцом r ∈ [R0, R1] от центра, относительно P (верх столба). node an-clear.js <rec>...
const fs = require('fs')
const S = require('./dsim')
const R0 = +(process.env.R0 || 3.5); const R1 = +(process.env.R1 || 5.5)
const mins = []
for (const f of process.argv.slice(2)) {
  const L = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(x => x && x.p && x.ph != null)
  const byGt = new Map(L.map(x => [x.gt, x]))
  // P — по посадке: y тела в первый тик «сидит»
  for (let i = 1; i < L.length; i++) {
    if (![5, 6, 7].includes(L[i].ph) || L[i - 1].ph !== 3) continue
    const P = Math.round(L[i].p[1])
    let m = Infinity
    for (let g = L[i].gt - 200; g < L[i].gt; g++) {
      const x: any = byGt.get(g); const b: any = byGt.get(g - 1); if (!x || !b || x.ph !== 3) continue
      const hist = []; for (let k = 0; k <= 10; k++) { const h: any = byGt.get(g - k); hist.push(h ? h.p[1] : x.p[1]) }
      const s = { x: x.p[0], y: x.p[1], z: x.p[2], yRot: x.r[0], yRotA: S.wrap(x.r[0] - b.r[0]) * 10, hist }
      const hd = S.headOf(s, false); const nk = S.neckOf(s, false)
      const g0 = s.yRot * 0.017453292
      const body = { x: s.x + S.msin(g0) * 0.5, y: s.y, z: s.z - S.mcos(g0) * 0.5 }
      const w1 = { x: s.x + S.mcos(g0) * 4.5, y: s.y + 2, z: s.z + S.msin(g0) * 4.5 }; const w2 = { x: s.x - S.mcos(g0) * 4.5, y: s.y + 2, z: s.z - S.msin(g0) * 4.5 }
      for (const [c, hw] of [[hd, 0.5], [nk, 1.5], [body, 2.5], [w1, 2], [w2, 2]]) {
        // ближняя к центру и дальняя точки коробки по горизонтали; попадает ли коробка в кольцо
        const r = Math.hypot(c.x - 0.5, c.z - 0.5)
        if (r + hw * 1.42 < R0 || r - hw * 1.42 > R1) continue
        m = Math.min(m, c.y - P)
      }
    }
    if (isFinite(m)) mins.push(+m.toFixed(2))
  }
}
mins.sort((a, b) => a - b)
console.log(`ниже −1.1: ${mins.filter(m => m < -1.1).length}, ниже −1.6: ${mins.filter(m => m < -1.6).length}, ниже −2.1: ${mins.filter(m => m < -2.1).length}; `)
console.log(`посадок ${mins.length}; низ коробок над кольцом r ${R0}–${R1}, относительно P: min ${mins[0]}, p10 ${mins[Math.floor(mins.length * 0.1)]}, p50 ${mins[Math.floor(mins.length / 2)]}`)
