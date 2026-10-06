// Проверка dsim по записи сервера (rec-*.jsonl): посадка (LANDING → цель (0.5, P, 0.5)).
// Для пары выборок a→b подбираем yRotA(a) по yRot(b), потом предсказываем c (дальше) и сравниваем.
const fs = require('fs'); const path = require('path')
const S = require('./dsim')
const files = process.argv.slice(2)
const errs = []; const herrs = []
for (const f of files) {
  const L = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.ph != null && x.p && x.p.length === 3)
  // P по первой сидячей выборке после посадки
  for (let i = 0; i + 2 < L.length; i++) {
    const a = L[i]; const b = L[i + 1]; const c = L[i + 2]
    if (a.ph !== 3 || b.ph !== 3 || c.ph !== 3) continue
    const da = b.gt - a.gt; const db = c.gt - b.gt
    if (da < 1 || da > 8 || db < 1 || db > 12) continue
    let sit = null; for (let k = i; k < L.length && k < i + 400; k++) if (L[k].ph === 6) { sit = L[k]; break }
    if (!sit) continue
    const P = Math.round(sit.p[1])
    const T = { x: 0.5, y: P, z: 0.5 }
    const mk = yRotA => ({ x: a.p[0], y: a.p[1], z: a.p[2], vx: a.v[0], vy: a.v[1], vz: a.v[2], yRot: a.r[0], yRotA, hist: new Array(11).fill(a.p[1]), inWall: false })
    const run = (s, n) => { for (let k = 0; k < n; k++) S.step(s, T, 1.5, S.turnLanding); return s }
    let best = null
    for (let q = -300; q <= 300; q += 2) {
      const s = run(mk(q), da)
      const e = Math.abs(S.wrap(s.yRot - b.r[0]))
      if (!best || e < best.e) best = { q, e }
    }
    for (let q = best.q - 2; q <= best.q + 2; q += 0.05) {
      const s = run(mk(q), da)
      const e = Math.abs(S.wrap(s.yRot - b.r[0]))
      if (e < best.e) best = { q, e }
    }
    // проверка на b: позиция
    const sb = run(mk(best.q), da)
    const eb = Math.hypot(sb.x - b.p[0], sb.y - b.p[1], sb.z - b.p[2])
    const sc = run(sb, db)
    const ec = Math.hypot(sc.x - c.p[0], sc.y - c.p[1], sc.z - c.p[2])
    const eyaw = Math.abs(S.wrap(sc.yRot - c.r[0]))
    errs.push({ da, db, eb, ec, eyaw, fit: best.e })
  }
}
const q = (a, p) => { a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length * p)] }
console.log('n', errs.length)
for (const k of ['fit', 'eb', 'ec', 'eyaw']) console.log(k, 'p50', q(errs.map(e => e[k]), 0.5)?.toFixed(4), 'p90', q(errs.map(e => e[k]), 0.9)?.toFixed(4), 'max', Math.max(...errs.map(e => e[k])).toFixed(3))
