// Точность щелчков станции у столба по записи сервера: тик взрыва = тик падения хп дракона в LANDING;
// расстояние головы до центра подушки в этот тик и минимум в ±4 тиках (насколько промахнулись по времени).
// Подушка — из трассы бота (pillarPlan H). node dist/farm/dragon/an-pilltiming.js trace-dir...
import * as fs from 'fs'
import path = require('path')
import * as S from './dsim'
const rows = []
for (const dir of process.argv.slice(2)) {
  const trace = fs.readdirSync(dir).filter(f => /^dragon-.*\.jsonl$/.test(f)).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
  const m = trace.match(/"k":"pillarPlan","ms":\d+,"H":\[(-?\d+),(-?\d+),(-?\d+)\]/)
  if (!m) continue
  const H = { x: +m[1] + 0.5, y: +m[2] + 0.5, z: +m[3] + 0.5 }
  const recf = fs.readdirSync(dir).filter(f => /^rec-.*\.jsonl$/.test(f))[0]
  if (!recf) continue
  const L = fs.readFileSync(path.join(dir, recf), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(x => x && x.ph != null && x.p)
  const byGt = new Map(L.map(x => [x.gt, x]))
  const head = gt => {
    const a: any = byGt.get(gt); const b: any = byGt.get(gt - 1); if (!a || !b) return null
    const hist = []; for (let k = 0; k <= 10; k++) { const h: any = byGt.get(gt - k); hist.push(h ? h.p[1] : a.p[1]) }
    return S.headOf({ x: a.p[0], y: a.p[1], z: a.p[2], yRot: a.r[0], yRotA: S.wrap(a.r[0] - b.r[0]) * 10, hist }, false)
  }
  for (let i = 1; i < L.length; i++) {
    const a = L[i]; const b = L[i - 1]
    if (a.ph !== 3 || a.gt !== b.gt + 1 || !(b.hp - a.hp > 3)) continue
    const dAt = g => { const h = head(g); return h ? Math.hypot(h.x - H.x, h.y - H.y, h.z - H.z) : null }
    const d0 = dAt(a.gt - 1)
    let best = null
    for (let k = -4; k <= 4; k++) { const d = dAt(a.gt - 1 + k); if (d != null && (!best || d < best.d)) best = { k, d } }
    const h0 = head(a.gt - 1); rows.push({ dir: path.basename(dir), dmg: +(b.hp - a.hp).toFixed(1), d: d0 && +d0.toFixed(2), best: best && +best.d.toFixed(2), off: best && best.k, rel: h0 && [+(h0.x - H.x).toFixed(1), +(h0.y - H.y).toFixed(1), +(h0.z - H.z).toFixed(1)], Hc: [H.x - 0.5, H.y - 0.5, H.z - 0.5] })
  }
}
console.log(`взрывов ${rows.length}`)
const offs: Record<string, any> = {} as Record<string, any>; for (const r of rows) offs[r.off] = (offs[r.off] || 0) + 1
console.log('сдвиг лучшего тика (тиков; + — надо было позже):', JSON.stringify(offs))
const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
console.log(`расстояние в тик взрыва p50 ${med(rows.map(r => r.d))}, лучшее в ±4 тиках p50 ${med(rows.map(r => r.best))}, урон p50 ${med(rows.map(r => r.dmg))}`)
for (const r of rows.slice(0, +(process.env.N || 20))) console.log(JSON.stringify(r))
const ys = rows.filter(r => r.rel).map(r => r.rel[1]); const hs = rows.filter(r => r.rel).map(r => Math.hypot(r.rel[0], r.rel[2])); console.log(`голова над подушкой dy p50 ${med(ys)}, по горизонтали p50 ${med(hs)}`)
