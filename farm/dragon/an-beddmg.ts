import * as fs from 'fs'; import path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const out = []
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-'))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    for (let i = 0; i < lines.length; i++) {
      const e = lines[i]
      if (e.k !== 'bed' || e.dragonHp == null) continue
      // phase at time
      let ph = null
      for (let j = i; j >= 0; j--) if (lines[j].d && lines[j].d.ph != null) { ph = lines[j].d.ph; break }
      let after = null
      for (let j = i + 1; j < lines.length && lines[j].t - e.t < 2500; j++) {
        if (lines[j].k === 'bedDone' && lines[j].dmg != null) { after = e.dragonHp - lines[j].dmg; break }
        if (lines[j].d && lines[j].d.hp != null && lines[j].t - e.t > 400) { after = lines[j].d.hp; break }
      }
      const dmg = after == null ? null : Math.round((e.dragonHp - after) * 10) / 10
      out.push({ d, dist: e.dist, ph: e.ph ?? ph, why: e.why, dmg, self: e.me })
    }
  }
}
const ok = out.filter(o => o.dmg != null && o.dmg > 0.5)
console.log('beds', out.length, 'with dmg', ok.length)
const byDist: Record<string, any> = {} as Record<string, any>
for (const o of ok) { const k = Math.round(o.dist); (byDist[k] = byDist[k] || []).push(o.dmg) }
for (const [k, v] of Object.entries<any>(byDist).sort((a: any, b: any) => a[0] - b[0])) { v.sort((a, b) => a - b); console.log('dist', k, 'n', v.length, 'med', v[Math.floor(v.length / 2)], 'min', v[0], 'max', v[v.length - 1]) }
const byPh: Record<string, any> = {} as Record<string, any>
for (const o of ok) { const k = o.ph; (byPh[k] = byPh[k] || []).push(o.dmg) }
for (const [k, v] of Object.entries<any>(byPh)) { v.sort((a, b) => a - b); console.log('ph', k, 'n', v.length, 'med', v[Math.floor(v.length / 2)], 'max', v[v.length - 1]) }
const zero = out.filter(o => o.dmg != null && o.dmg <= 0.5).length
console.log('zero-dmg beds', zero)
