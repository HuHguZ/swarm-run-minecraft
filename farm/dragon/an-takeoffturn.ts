// Взлёт: на сколько и куда поворачивается голова за 0.25/0.5/0.75 с в зависимости от
// разницы между азимутом головы сидя и азимутом, куда потом полетело тело (узел пути).
import * as fs from 'fs'; import path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const wrap = a => { while (a > 180) a -= 360; while (a < -180) a += 360; return a }
const pre = process.argv[2] || ''
const rows = []
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-' + pre))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    const S = lines.filter(l => l.k === 's' && l.d && l.d.p)
    for (let i = 1; i < S.length; i++) {
      if (!(S[i].d.ph === 4 && [5, 6, 7].includes(S[i - 1].d.ph))) continue
      const s0 = S[i - 1]
      const az = y => Math.atan2(Math.cos(y), Math.sin(y)) * 180 / Math.PI
      const s2 = S.find(s => s.t - s0.t >= 1800 && s.t - s0.t < 2600)
      if (!s2) continue
      const fly = Math.atan2(s2.d.p[2] - s0.d.p[2], s2.d.p[0] - s0.d.p[0]) * 180 / Math.PI
      const need = wrap(fly - az(s0.d.yaw))
      const r = { need }
      for (const dt of [250, 500, 750]) { const s = S.find(q => q.t - s0.t >= dt - 120 && q.t - s0.t <= dt + 120); if (s) r[dt] = wrap(az(s.d.yaw) - az(s0.d.yaw)) }
      rows.push(r)
    }
  }
}
const bins: Record<string, any> = {} as Record<string, any>
for (const r of rows) { const b = Math.round(r.need / 45) * 45; (bins[b] = bins[b] || []).push(r) }
const med = a => { a = a.filter(x => x != null).sort((x, y) => x - y); return a.length ? Math.round(a[a.length >> 1]) : '-' }
for (const b of Object.keys(bins).map(Number).sort((a, c) => a - c)) {
  const a = bins[b]
  console.log(`нужно повернуть ~${b}° (n ${a.length}): повернул за 0.25 с ${med(a.map(x => x[250]))}°, 0.5 с ${med(a.map(x => x[500]))}°, 0.75 с ${med(a.map(x => x[750]))}°`)
}
