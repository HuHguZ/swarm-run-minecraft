// Последние секунды LANDING: где голова относительно конечной (при SCANNING), высота дракона.
const fs = require('fs'); const path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const buckets: Record<string, any> = {} as Record<string, any> // по времени до посадки (0.25 с): [dist head->final]
const ybk: Record<string, any> = {} as Record<string, any>
let n = 0
const spins = []
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-'))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    const S = lines.filter(l => l.k === 's' && l.d && l.d.p)
    for (let i = 1; i < S.length; i++) {
      if (S[i].d.ph === 6 && S[i - 1].d.ph === 3) {
        const sit = S[i]
        const hf = [sit.d.p[0] + Math.sin(sit.d.yaw) * 6.5, sit.d.p[2] + Math.cos(sit.d.yaw) * 6.5]
        n++
        const traj = []
        for (let j = i - 1; j >= 0 && sit.t - S[j].t <= 4000 && S[j].d.ph === 3; j--) {
          const s = S[j]
          const h = [s.d.p[0] + Math.sin(s.d.yaw) * 6.5, s.d.p[2] + Math.cos(s.d.yaw) * 6.5]
          const dist = Math.hypot(h[0] - hf[0], h[1] - hf[1])
          const b = Math.round((sit.t - s.t) / 250) * 0.25
          ;(buckets[b] = buckets[b] || []).push(dist)
          ;(ybk[b] = ybk[b] || []).push(s.d.p[1] - sit.d.p[1])
          traj.push({ dt: sit.t - s.t, dist: +dist.toFixed(1), dy: +(s.d.p[1] - sit.d.p[1]).toFixed(1), r: +Math.hypot(s.d.p[0] - 0.5, s.d.p[2] - 0.5).toFixed(1) })
        }
        if (spins.length < 6) spins.push({ d, t: sit.t, traj: traj.slice(0, 12) })
      }
    }
  }
}
console.log('perches', n)
const med = a => { a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] }
const p = (a, q) => { a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length * q)] }
for (const b of Object.keys(buckets).map(Number).sort((a, c) => a - c)) {
  console.log(`до посадки ${b}s: n ${buckets[b].length} голова от конечной: мед ${med(buckets[b]).toFixed(1)} p25 ${p(buckets[b], 0.25).toFixed(1)} p75 ${p(buckets[b], 0.75).toFixed(1)}; выше посадки на ${med(ybk[b]).toFixed(1)}; доля ≤2: ${(buckets[b].filter(x => x <= 2).length / buckets[b].length).toFixed(2)}`)
}
for (const s of spins) console.log(s.d, s.t, JSON.stringify(s.traj))
