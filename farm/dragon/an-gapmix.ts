// Из чего состоит перерыв между посадками: время в фазах (0 кружит, 1 заход с фаерболом, 2 заход на посадку, 3 садится, 8 таран).
import * as fs from 'fs'; import path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
for (const pre of process.argv.slice(2)) {
  const tot: Record<string, any> = {} as Record<string, any>; let n = 0; const dur1 = []
  for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-' + pre))) {
    for (const f of fs.readdirSync(path.join(L, d))) {
      let lines
      try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
      const P = lines.filter(l => l.k === 'phase')
      let inGap = false; let acc: Record<string, any> = {} as Record<string, any>
      for (let i = 0; i + 1 < P.length; i++) {
        const sit = [5, 6, 7].includes(P[i].ph)
        if (sit) { if (inGap) { for (const [k, v] of Object.entries<any>(acc)) tot[k] = (tot[k] || 0) + v; n++ } inGap = false; acc = {} as Record<string, any>; continue }
        if (i > 0 && [5, 6, 7].includes(P[i - 1].ph)) inGap = true
        if (!inGap) continue
        const dt = (P[i + 1].t - P[i].t) / 1000
        acc[P[i].ph] = (acc[P[i].ph] || 0) + dt
        if (P[i].ph === 1) dur1.push(dt)
      }
    }
  }
  dur1.sort((a, b) => a - b)
  console.log(`${pre}: перерывов ${n}; в среднем на перерыв, с: ` + Object.entries<any>(tot).sort((a, b) => b[1] - a[1]).map(([k, v]: any) => `ф${k}=${(v / (n || 1)).toFixed(0)}`).join(' ') + `; заход с фаерболом длится мед ${dur1.length ? dur1[dur1.length >> 1].toFixed(1) : '-'} с`)
}
