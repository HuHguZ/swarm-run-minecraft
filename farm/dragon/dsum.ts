// Сводка серии боёв: node dsum.js <префикс тега> [...]  (farm/logs/<тег>.jsonl)
const fs = require('fs')
const path = require('path')
const LOGS = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const pre = process.argv.slice(2)
const files = fs.readdirSync(LOGS).filter(f => f.endsWith('.jsonl') && pre.some(p => f.startsWith(p)))
let n = 0; let wins = 0; let deaths = 0
const times = []
for (const f of files.sort()) {
  for (const line of fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(line) } catch { continue }
    n++
    const win = r.killed && !r.died
    if (win) { wins++; if (r.killSecs != null) times.push(r.killSecs) }
    if (r.died) deaths++
    const c = r.cause || {} as Record<string, any>
    const lh = c.lastHurt || {} as Record<string, any>
    console.log(`${f.replace('.jsonl', '').padEnd(8)} ${win ? 'ПОБЕДА' : r.died ? 'СМЕРТЬ' : 'нет   '} ${String(r.secs).padStart(4)}с убит@${r.killSecs ?? '-'} крист@${r.crystalSecs ?? '-'} ${r.crystals || ''} дракон=${r.dragonHp ?? '-'} ` +
      (r.died ? `причина: ${JSON.stringify(c.types)} last=${lh.type}/${lh.doing} @${c.t}с` : `stop=${(r.stopped || '').slice(0, 60)}`))
  }
}
times.sort((a, b) => a - b)
console.log(`\nИТОГ: ${n} боёв, побед без смерти ${wins}, смертей ${deaths}; убийство, с: ${times.join(', ')}${times.length ? ` (медиана ${times[Math.floor(times.length / 2)]})` : ''}`)
