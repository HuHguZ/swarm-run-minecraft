// Взлёт: подбор (узел, y цели, yRotA на посадке) по записи сервера; ошибка головы на 5/10/15/20 тиках.
const fs = require('fs')
const S = require('./dsim')
const file = process.argv[2]
const L = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.ph != null && x.p && x.p.length === 3)
const byGt = new Map(L.map(x => [x.gt, x]))
const nodes = S.nodesOf(() => 60)
const starts = []
for (let i = 1; i < L.length; i++) if (L[i].ph === 4 && L[i - 1].ph !== 4 && L[i].gt - L[i - 1].gt === 1) starts.push(L[i].gt)
for (const g0 of starts) {
  const sit: any = byGt.get(g0 - 1)
  if (!sit) continue
  const obs = []; for (let k = 0; k <= 25; k++) { const x = byGt.get(g0 + k); if (x) obs.push({ k, x }) }
  const run = (T, yRotA, n, cb) => {
    const s = { x: sit.p[0], y: sit.p[1], z: sit.p[2], vx: sit.v[0], vy: sit.v[1], vz: sit.v[2], yRot: sit.r[0], yRotA, hist: new Array(11).fill(sit.p[1]), inWall: false }
    for (let k = 0; k <= n; k++) { S.step(s, T, 0.6, S.turnDefault); if (cb) cb(k, s) }
    return s
  }
  let best = null
  for (const nd of nodes) {
    for (let ty = nd.y; ty <= nd.y + 40; ty += 4) {
      for (let q = -200; q <= 200; q += 10) {
        let err = 0
        run({ x: nd.x, y: ty, z: nd.z }, q, 12, (k, s) => { const o = obs.find(o => o.k === k); if (o) err += (s.x - o.x.p[0]) ** 2 + (s.z - o.x.p[2]) ** 2 + (S.wrap(s.yRot - o.x.r[0]) / 10) ** 2 })
        if (!best || err < best.err) best = { nd, ty, q, err }
      }
    }
  }
  // уточнить q, ty
  for (let ty = best.ty - 4; ty <= best.ty + 4; ty += 0.5) for (let q = best.q - 10; q <= best.q + 10; q += 0.5) {
    let err = 0
    run({ x: best.nd.x, y: ty, z: best.nd.z }, q, 12, (k, s) => { const o = obs.find(o => o.k === k); if (o) err += (s.x - o.x.p[0]) ** 2 + (s.y - o.x.p[1]) ** 2 + (s.z - o.x.p[2]) ** 2 + (S.wrap(s.yRot - o.x.r[0]) / 10) ** 2 })
    if (err < best.err) best = { ...best, ty, q, err }
  }
  const e = []
  run({ x: best.nd.x, y: best.ty, z: best.nd.z }, best.q, 25, (k, s) => { const o = obs.find(o => o.k === k); if (o && k % 5 === 0) e.push(`${k}:${Math.hypot(s.x - o.x.p[0], s.y - o.x.p[1], s.z - o.x.p[2]).toFixed(2)}`) })
  console.log(`взлёт gt ${g0}: узел ${best.nd.i} (${best.nd.x},${best.nd.z}) y ${best.ty} yRotA ${best.q} err ${best.err.toFixed(3)} | ошибка позиции ${e.join(' ')}`)
}
