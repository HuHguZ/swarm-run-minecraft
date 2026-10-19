// Куда уходит голова на взлёте: смещение головы (и тела) через 0.25–1 с от начала TAKEOFF
// в осях «вдоль взгляда сидящего / поперёк».
import * as fs from 'fs'; import path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const by: Record<string, any> = {} as Record<string, any>
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-'))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    const S = lines.filter(l => l.k === 's' && l.d && l.d.p)
    for (let i = 1; i < S.length; i++) {
      if (!(S[i].d.ph === 4 && [5, 6, 7].includes(S[i - 1].d.ph))) continue
      const s0 = S[i - 1]
      const ux = Math.sin(s0.d.yaw); const uz = Math.cos(s0.d.yaw)
      const h0 = [s0.d.p[0] + ux * 6.5, s0.d.p[2] + uz * 6.5]
      for (let j = i; j < S.length && S[j].t - s0.t < 1300; j++) {
        const s = S[j]
        const hx = s.d.p[0] + Math.sin(s.d.yaw) * 6.5; const hz = s.d.p[2] + Math.cos(s.d.yaw) * 6.5
        const dx = hx - h0[0]; const dz = hz - h0[1]
        const along = dx * ux + dz * uz; const side = -dx * uz + dz * ux
        const bx = s.d.p[0] - s0.d.p[0]; const bz = s.d.p[2] - s0.d.p[2]
        const b = Math.round((s.t - s0.t) / 250) * 0.25
        ;(by[b] = by[b] || []).push({ along, side, balong: bx * ux + bz * uz, dy: s.d.p[1] - s0.d.p[1] })
      }
    }
  }
}
const q = (a, p) => { a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length * p)] }
for (const b of Object.keys(by).map(Number).sort((a, c) => a - c)) {
  const a = by[b]
  console.log(`+${b}s n ${a.length}: голова вдоль взгляда мед ${q(a.map(x => x.along), 0.5).toFixed(1)} (p25 ${q(a.map(x => x.along), 0.25).toFixed(1)}, p75 ${q(a.map(x => x.along), 0.75).toFixed(1)}), поперёк |мед| ${q(a.map(x => Math.abs(x.side)), 0.5).toFixed(1)}; тело вдоль ${q(a.map(x => x.balong), 0.5).toFixed(1)}; выше ${q(a.map(x => x.dy), 0.5).toFixed(1)}`)
}
