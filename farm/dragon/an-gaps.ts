// Перерывы между посадками (конец сидения → следующее «высматривает») по префиксу трасс: node an-gaps.js b2- b4-
const fs = require('fs'); const path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
for (const pre of process.argv.slice(2)) {
  const gaps = []; let strafes = 0; let firstPerch = []
  for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-' + pre))) {
    for (const f of fs.readdirSync(path.join(L, d))) {
      let lines
      try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
      const P = lines.filter(l => l.k === 'phase')
      let sitEnd = null; let first = true
      for (let i = 1; i < P.length; i++) {
        const sit = [5, 6, 7].includes(P[i].ph); const was = [5, 6, 7].includes(P[i - 1].ph)
        if (!sit && was) sitEnd = P[i].t
        if (P[i].ph === 1 && sitEnd != null) strafes++
        if (P[i].ph === 6 && P[i - 1].ph === 3) { if (first) { firstPerch.push(P[i].t / 1000); first = false } if (sitEnd != null) { gaps.push((P[i].t - sitEnd) / 1000); sitEnd = null } }
      }
    }
  }
  gaps.sort((a, b) => a - b); firstPerch.sort((a, b) => a - b)
  const q = p => gaps.length ? Math.round(gaps[Math.floor(gaps.length * p)]) : '-'
  console.log(`${pre}: перерывов ${gaps.length}, p10 ${q(0.1)} мед ${q(0.5)} p90 ${q(0.9)} с; заходов с фаерболом в перерывах ${strafes} (${(strafes / (gaps.length || 1)).toFixed(1)} на перерыв); первая посадка (от вызова), мед ${firstPerch.length ? Math.round(firstPerch[firstPerch.length >> 1]) : '-'} с`)
}
