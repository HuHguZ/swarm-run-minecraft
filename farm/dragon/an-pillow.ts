// Где голова проходит над фонтаном на снижении (rec-*.jsonl): минимум расстояния от низа-центра
// головы до «подушек» у центрального столба (кровать на P−1 вплотную к столбу и на P−2/P−3), сколько
// тиков голова в ≤ 2.5 от каждой, по последним 80 тикам LANDING. node farm/dragon/an-pillow.js rec...
const fs = require('fs')
const S = require('./dsim')
const rows = []
for (const file of process.argv.slice(2)) {
  const L = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(x => x && x.ph != null && x.p)
  const byGt = new Map(L.map(x => [x.gt, x]))
  for (let i = 1; i < L.length; i++) {
    if (!([5, 6, 7].includes(L[i].ph) && L[i - 1].ph === 3 && L[i].gt - L[i - 1].gt === 1)) continue
    const gs = L[i].gt; const P = L[i].p[1]
    // подушки: кровать-изголовье в клетке рядом со столбом (0,0): (±1,0),(0,±1) на y = P−1, P−2, P−3
    const pillows = []
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) for (const dy of [1, 2, 3]) pillows.push({ x: x + 0.5, y: Math.floor(P) - dy + 0.5, z: z + 0.5, tag: `${x},${z},P-${dy}` })
    const best = new Map()
    let ok = true
    for (let k = gs - 80; k < gs; k++) {
      const a: any = byGt.get(k); const b: any = byGt.get(k - 1)
      if (!a || !b || a.ph !== 3) continue
      const hist = []; for (let j = 0; j <= 10; j++) { const h: any = byGt.get(k - j); hist.push(h ? h.p[1] : a.p[1]) }
      const s = { x: a.p[0], y: a.p[1], z: a.p[2], yRot: a.r[0], yRotA: S.wrap(a.r[0] - b.r[0]) * 10, hist }
      const h = S.headOf(s, false)
      for (const pw of pillows) {
        const d = Math.hypot(h.x - pw.x, h.y - pw.y, h.z - pw.z)
        const r = best.get(pw.tag) || { min: 99, n25: 0, at: null }
        if (d < r.min) { r.min = d; r.at = gs - k }
        if (d <= 2.5) r.n25++
        best.set(pw.tag, r)
      }
    }
    if (!ok) continue
    let top = null
    for (const [tag, r] of best) if (!top || r.min < top.r.min) top = { tag, r }
    rows.push({ file: file.replace(/.*trace-/, ''), gs, P, top: top && { tag: top.tag, min: +top.r.min.toFixed(2), ticksBefore: top.r.at, n25: top.r.n25 } })
  }
}
const mins = rows.map(r => r.top ? r.top.min : 99).sort((a, b) => a - b)
const q = p => mins[Math.min(mins.length - 1, Math.floor(mins.length * p))]
console.log(`посадок ${rows.length}: лучшая подушка у столба — мин. расстояние до головы p25 ${q(0.25).toFixed(2)} p50 ${q(0.5).toFixed(2)} p75 ${q(0.75).toFixed(2)}`)
console.log(`≤ 2.0: ${mins.filter(x => x <= 2).length}, ≤ 2.5: ${mins.filter(x => x <= 2.5).length}, ≤ 3: ${mins.filter(x => x <= 3).length}`)
for (const r of rows.slice(0, 15)) console.log(JSON.stringify(r))
