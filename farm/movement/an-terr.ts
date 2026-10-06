// Сводка серий try-lab-mv-terrain.js по ногам: node farm/movement/an-terr.js <tag>
const fs = require('fs'); const path = require('path')
const rows = []
for (const t of process.argv.slice(2)) {
  const dir = path.join('C:/Users/user/Desktop/work/minecraft-claude/farm/results', t)
  for (const f of fs.readdirSync(dir).filter(f => /^slot-\d+\.jsonl$/.test(f))) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) rows.push({ tag: t, ...JSON.parse(l) })
}
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const modes = [...new Set(rows.map(r => r.mode))]
for (const m of modes) {
  const rs = rows.filter(r => r.mode === m); const ok = rs.filter(r => r.ok)
  console.log(`${m.padEnd(8)} n=${rs.length} ok=${ok.length} med=${(med(ok.map(r => r.ms)) / 1000).toFixed(1)}s fell=${rs.filter(r => r.fell).length} hpLoss=${rs.filter(r => (r.minHp ?? 20) < 20).length} minHp=${Math.min(...rs.map(r => r.minHp ?? 20))} blocks=${rs.reduce((n, r) => n + (r.blocks || 0), 0)} pearls=${rs.reduce((n, r) => n + (r.pearls || 0), 0)} err=${rs.filter(r => r.error).length}`)
}
// Пары по ноге: все режимы дошли — сумма времени.
const legs: Record<string, any> = {} as Record<string, any>
for (const r of rows) (legs[`${r.tag}:${r.slot}:${r.leg}`] ??= {} as Record<string, any>)[r.mode] = r
const full = Object.values<any>(legs).filter(l => modes.every(m => l[m] && l[m].ok))
const sum: Record<string, any> = {} as Record<string, any>
for (const m of modes) sum[m] = full.reduce((n, l) => n + l[m].ms, 0) / 1000
console.log(`ноги, где дошли все режимы: ${full.length}; сумма времени: ` + modes.map(m => `${m} ${sum[m].toFixed(1)}s`).join(', '))
for (const [k, l] of Object.entries<any>(legs)) console.log('  ' + k + ' ' + modes.map(m => l[m] ? `${m}:${l[m].ok ? 'ok' : 'NO'}/${(l[m].ms / 1000).toFixed(1)}${l[m].blocks ? '/b' + l[m].blocks : ''}${l[m].fell ? '/FELL' : ''}${(l[m].minHp ?? 20) < 20 ? '/hp' + l[m].minHp : ''}` : `${m}:-`).join(' '))
