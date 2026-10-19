// Хронология боя «только кровати» по трассам: node bsum.js <префикс тега> [последних строк]
// Посадки (фазы 2–7), кровати (план/щелчок/итог/отказ), удары по телу, смерть.
import * as fs from 'fs'
import path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const pre = process.argv[2] || 'b1-'
const tailN = Number(process.argv[3] || 30)
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-' + pre)).sort()) {
  for (const f of fs.readdirSync(path.join(L, d)).sort()) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    const out = []
    for (const l of lines) {
      if (!['phase', 'bed', 'bedDone', 'bedFail', 'bedsPerch', 'death', 'hurt', 'end'].includes(l.k)) continue
      if (l.k === 'phase' && ![2, 3, 4, 5, 6, 7].includes(l.ph)) continue
      const { t, k, ...r } = l
      out.push(`${(t / 1000).toFixed(1).padStart(6)} ${k.padEnd(9)} ${JSON.stringify(r).slice(0, 200)}`)
    }
    console.log(`== ${d}/${f} (${out.length})`)
    console.log(out.slice(-tailN).join('\n'))
  }
}
