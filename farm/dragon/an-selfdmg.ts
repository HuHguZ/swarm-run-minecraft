import * as fs from 'fs'; import path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const v = []; const byDoing: Record<string, any> = {} as Record<string, any>
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-'))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i]
      if (h.k !== 'hurt' || h.type !== 'bad_respawn_point') continue
      const nx = lines.slice(i + 1).find(l => (l.k === 's' || l.k === 'hp') && l.t - h.t < 1500 && (l.hp != null))
      if (!nx) continue
      const dmg = h.hpBefore - nx.hp
      v.push(dmg); (byDoing[h.doing] = byDoing[h.doing] || []).push(dmg)
    }
  }
}
v.sort((a, b) => a - b)
console.log('n', v.length, 'p25', v[Math.floor(v.length * 0.25)], 'med', v[v.length >> 1], 'p90', v[Math.floor(v.length * 0.9)], 'max', v[v.length - 1])
for (const [k, a] of Object.entries<any>(byDoing)) { a.sort((x, y) => x - y); console.log(k, a.length, 'med', a[a.length >> 1]) }
