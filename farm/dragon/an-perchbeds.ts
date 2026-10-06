// По посадкам: сколько кроватей, время от SCANNING до 1-й и 2-й, урон за посадку (по хп дракона до/после), чем кончилась.
const fs = require('fs'); const path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const rows = []
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-'))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    const P = lines.filter(l => l.k === 'phase')
    for (let i = 1; i < P.length; i++) {
      if (!(P[i].ph === 6 && P[i - 1].ph === 3)) continue
      const t0 = P[i].t; const hp0 = P[i].hp
      let j = i; while (j + 1 < P.length && [5, 6, 7].includes(P[j + 1].ph)) j++
      const endPh = P[j + 1] ? P[j + 1].ph : null
      const t1 = P[j + 1] ? P[j + 1].t : t0
      const hp1 = P[j + 1] ? P[j + 1].hp : null
      const beds = lines.filter(l => l.k === 'bed' && l.t >= t0 - 3000 && l.t <= t1 + 2000)
      const deaths = lines.filter(l => l.k === 'death' && l.t >= t0 && l.t <= t1 + 3000).length
      rows.push({ d, n: beds.length, first: beds[0] ? (beds[0].t - t0) / 1000 : null, second: beds[1] ? (beds[1].t - beds[0].t) / 1000 : null, dmg: hp1 != null ? hp0 - hp1 : null, secs: (t1 - t0) / 1000, endPh, deaths })
    }
  }
}
const withBeds = rows.filter(r => r.n > 0)
console.log('посадок', rows.length, 'с кроватями', withBeds.length)
const q = (a, p) => { a = a.filter(x => x != null).sort((x, y) => x - y); return a[Math.floor(a.length * p)] }
console.log('кроватей за посадку:', [1, 2, 3, 4].map(k => `${k}:${withBeds.filter(r => r.n === k).length}`).join(' '))
console.log('до первой кровати, с: p25', q(withBeds.map(r => r.first), 0.25), 'мед', q(withBeds.map(r => r.first), 0.5), 'p75', q(withBeds.map(r => r.first), 0.75))
console.log('между 1 и 2, с: p25', q(withBeds.map(r => r.second), 0.25), 'мед', q(withBeds.map(r => r.second), 0.5))
console.log('урон за посадку с кроватями: мед', q(withBeds.map(r => r.dmg), 0.5), 'p75', q(withBeds.map(r => r.dmg), 0.75), 'max', q(withBeds.map(r => r.dmg), 0.999))
console.log('длина посадки, с: мед', q(rows.map(r => r.secs), 0.5), 'p90', q(rows.map(r => r.secs), 0.9))
console.log('смертей в посадках с кроватями', withBeds.reduce((s, r) => s + r.deaths, 0))
