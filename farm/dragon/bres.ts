// Итоги серии «только кровати»: node bres.js <префикс тега> [с какого времени ISO/HH:MM МСК]
// Победа — сервер: дракона нет и портал горит (try-dragon e2e killed) и тело не умирало.
const fs = require('fs')
const path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const pre = process.argv[2] || 'b3-'
let since = process.argv[3] || null
if (since && /^\d\d:\d\d$/.test(since)) since = `2026-09-30T${since}:00+03:00`
const t0 = since ? Date.parse(since) : 0
const rows = []
for (const f of fs.readdirSync(L).filter(f => f.startsWith(pre) && f.endsWith('.jsonl'))) {
  for (const line of fs.readFileSync(path.join(L, f), 'utf8').split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(line) } catch { continue }
    const start = Date.parse(r.at) - (r.secs || 0) * 1000
    if (start < t0) continue
    rows.push({ f: f.replace('.jsonl', ''), start, r })
  }
}
rows.sort((a, b) => a.start - b.start)
let win = 0; let died = 0; let beds = 0; let perches = 0; const times = []; const perD = []
for (const { f, start, r } of rows) {
  const res = r.killed && !r.died ? 'ПОБЕДА' : r.died ? 'СМЕРТЬ' : 'нет'
  if (res === 'ПОБЕДА') { win++; if (r.killSecs != null) times.push(r.killSecs) }
  if (r.died) died++
  beds += r.bedsTotal || 0
  perches += r.perchCount || 0
  for (const p of r.bedPerches || []) if (p.beds && p.beds.length) perD.push(Math.round(p.beds.reduce((s, x) => s + (x || 0), 0)))
  const st = new Date(start + 3 * 3600e3).toISOString().slice(11, 16)
  const pp = (r.bedPerches || []).map(p => `[${(p.beds || []).map(x => Math.round(x || 0)).join(',')}]`).join('')
  console.log(`${f.padEnd(7)} ${st} ${res.padEnd(6)} ${String(r.secs).padStart(4)}с убит@${r.killSecs ?? '-'} дракон=${r.dragonHp ?? '-'} кроватей ${r.bedsTotal ?? '-'} посадок ${r.perchCount ?? '-'} кристаллы ${r.crystalsServer || '-'} ${pp}${r.died && r.cause ? ` ${(r.cause.lastHurt || {} as Record<string, any>).type}/${(r.cause.lastHurt || {} as Record<string, any>).doing}` : ''}`)
}
times.sort((a, b) => a - b)
perD.sort((a, b) => a - b)
console.log(`ИТОГ ${pre}: боёв ${rows.length}, побед без смерти ${win}, смертей ${died}, кроватей ${beds} (на бой ${(beds / (rows.length || 1)).toFixed(1)}), посадок ${perches}; убийство, с: ${times.join(', ')}${times.length ? ` (медиана ${times[times.length >> 1]})` : ''}; урон за посадку с кроватями: медиана ${perD[perD.length >> 1] ?? '-'}, макс ${perD[perD.length - 1] ?? '-'}`)
