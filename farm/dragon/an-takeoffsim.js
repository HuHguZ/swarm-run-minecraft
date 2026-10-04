// Взлёт по записи сервера: голова по тикам от начала TAKEOFF и прогноз dsim с узлами (узел y — перебор).
const fs = require('fs')
const S = require('./dsim')
const [file, gtStart] = [process.argv[2], Number(process.argv[3])]
const L = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.ph != null && x.p && x.p.length === 3)
const byGt = new Map(L.map(x => [x.gt, x]))
const sit = byGt.get(gtStart - 1) || byGt.get(gtStart - 2)
console.log('sit', sit && sit.gt, sit && sit.p.map(v => v.toFixed(2)), 'yRot', sit && sit.r[0], 'v', sit && sit.v.map(v => v.toFixed(3)))
// yRotA при посадке: из последних тиков LANDING (подбор, как an-simcheck)
let land = null; for (let g = gtStart - 1; g > gtStart - 400; g--) { const x = byGt.get(g); if (x && x.ph === 3) { land = x; break } }
const nodesXZ = S.nodesOf(() => 60)
const out = []
for (let k = 0; k <= 30; k++) {
  const x = byGt.get(gtStart + k)
  if (!x) continue
  const s = { x: x.p[0], y: x.p[1], z: x.p[2], yRot: x.r[0], yRotA: 0, hist: [] }
  out.push(`${k}: ph ${x.ph} pos ${x.p.map(v => v.toFixed(2)).join(',')} yRot ${x.r[0].toFixed(1)} v ${x.v.map(v => v.toFixed(3)).join(',')}`)
}
console.log(out.join('\n'))
console.log('last landing', land && land.gt, land && land.p.map(v => v.toFixed(2)), land && land.r)
console.log('inner nodes', nodesXZ.slice(20).map(n => [n.x, n.z]), 'middle', nodesXZ.slice(12, 20).map(n => [n.x, n.z]))
