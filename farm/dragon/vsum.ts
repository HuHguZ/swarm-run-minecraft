// Сводка боёв, начатых после момента (заморозка кода): node vsum.js <ISO или HH:MM МСК> [префиксы через запятую]
import * as fs from 'fs'
import path = require('path')
const LOGS = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
let since = process.argv[2]
if (/^\d\d:\d\d$/.test(since)) since = `2026-09-30T${since}:00+03:00`
const t0 = Date.parse(since)
const pres = (process.argv[3] || 'c').split(',')
const rows = []
for (const f of fs.readdirSync(LOGS).filter(f => f.endsWith('.jsonl') && pres.some(p => f.startsWith(p)))) {
  for (const line of fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(line) } catch { continue }
    const start = Date.parse(r.at) - (r.secs || 0) * 1000
    if (start < t0) continue
    rows.push({ f: f.replace('.jsonl', ''), start, r })
  }
}
rows.sort((a, b) => a.start - b.start)
let win = 0; let died = 0; let other = 0; const times = []
for (const { f, start, r } of rows) {
  const c = r.cause || {} as Record<string, any>; const lh = c.lastHurt || {} as Record<string, any>
  const res = r.killed && !r.died ? 'ПОБЕДА' : r.died ? 'СМЕРТЬ' : 'нет'
  if (res === 'ПОБЕДА') { win++; if (r.killSecs != null) times.push(r.killSecs) } else if (res === 'СМЕРТЬ') died++; else other++
  const st = new Date(start + 3 * 3600e3).toISOString().slice(11, 16)
  console.log(`${f.padEnd(8)} старт ${st} ${res.padEnd(6)} ${String(r.secs).padStart(5)}с убит@${r.killSecs ?? '-'} дракон=${r.dragonHp ?? '-'}${r.died ? ` ${lh.type}/${lh.doing}` : ''}${res === 'нет' ? ` (${(r.stopped || '').slice(0, 50)})` : ''}`)
}
times.sort((a, b) => a - b)
console.log(`ИТОГ с ${since}: боёв ${rows.length}, побед без смерти ${win}, смертей ${died}, прочее ${other}; убийство, с: ${times.join(', ')}${times.length ? ` (медиана ${times[Math.floor(times.length / 2)]})` : ''}`)
