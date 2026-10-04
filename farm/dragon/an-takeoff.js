// Взлёт: сколько длится фаза 4, как далеко голова уходит от места посадки по времени, перерыв между посадками.
const fs = require('fs'); const path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const durs = []; const gaps = []; const byT = {}
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-'))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    const P = lines.filter(l => l.k === 'phase')
    for (let i = 0; i + 1 < P.length; i++) if (P[i].ph === 4) durs.push(P[i + 1].t - P[i].t)
    // перерыв: от конца сидения (первая фаза не 5/6/7 после сидения) до следующего SCANNING
    let sitEnd = null
    for (let i = 1; i < P.length; i++) {
      const sit = [5, 6, 7].includes(P[i].ph); const was = [5, 6, 7].includes(P[i - 1].ph)
      if (!sit && was) sitEnd = P[i].t
      if (P[i].ph === 6 && P[i - 1].ph === 3 && sitEnd != null) { gaps.push(P[i].t - sitEnd); sitEnd = null }
    }
    const S = lines.filter(l => l.k === 's' && l.d && l.d.p)
    for (let i = 1; i < S.length; i++) {
      if (S[i].d.ph === 4 && [5, 6, 7].includes(S[i - 1].d.ph)) {
        const s0 = S[i - 1]
        const h0 = [s0.d.p[0] + Math.sin(s0.d.yaw) * 6.5, s0.d.p[1] - 1, s0.d.p[2] + Math.cos(s0.d.yaw) * 6.5]
        for (let j = i; j < S.length && S[j].t - s0.t < 3000; j++) {
          const s = S[j]
          const h = [s.d.p[0] + Math.sin(s.d.yaw) * 6.5, s.d.p[1], s.d.p[2] + Math.cos(s.d.yaw) * 6.5]
          const b = Math.round((s.t - s0.t) / 250) * 0.25
          ;(byT[b] = byT[b] || []).push({ dh: Math.hypot(h[0] - h0[0], h[2] - h0[2]), dy: h[1] - h0[1], ph: s.d.ph })
        }
      }
    }
  }
}
const q = (a, p) => { a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length * p)] }
console.log('TAKEOFF ms n', durs.length, 'p10', q(durs, 0.1), 'med', q(durs, 0.5), 'p90', q(durs, 0.9))
console.log('перерыв между посадками, с: n', gaps.length, 'p10', Math.round(q(gaps, 0.1) / 1000), 'med', Math.round(q(gaps, 0.5) / 1000), 'p90', Math.round(q(gaps, 0.9) / 1000))
for (const b of Object.keys(byT).map(Number).sort((a, c) => a - c).slice(0, 10)) {
  const a = byT[b]
  console.log(`после взлёта ${b}s: n ${a.length} голова ушла по гориз мед ${q(a.map(x => x.dh), 0.5).toFixed(1)} p25 ${q(a.map(x => x.dh), 0.25).toFixed(1)} выше ${q(a.map(x => x.dy), 0.5).toFixed(1)} ещё взлёт ${(a.filter(x => x.ph === 4).length / a.length).toFixed(2)}`)
}
