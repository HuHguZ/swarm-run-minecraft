// Сводка A/B моста: node absum.js [префикс=ab-]
const fs = require('fs')
const path = require('path')
const LOGS = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const pre = process.argv[2] || 'ab-'
const by = {}
for (const f of fs.readdirSync(LOGS).filter(f => f.startsWith(pre) && f.endsWith('.jsonl'))) {
  const v = /-(rise|norise)\.jsonl$/.exec(f)
  const key = v ? v[1] : 'other'
  for (const line of fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(line) } catch { continue }
    const k = by[key] || (by[key] = { n: 0, win: 0, died: 0, other: 0, times: [], causes: {}, rows: [] })
    k.n++
    const c = r.cause || {}; const lh = c.lastHurt || {}
    if (r.killed && !r.died) { k.win++; if (r.killSecs != null) k.times.push(r.killSecs) } else if (r.died) { k.died++; const key2 = `${lh.type || '?'}/${String(lh.doing || '?').split(':')[0]}`; k.causes[key2] = (k.causes[key2] || 0) + 1 } else k.other++
    k.rows.push(`${f.replace('.jsonl', '')}: ${r.killed && !r.died ? 'ПОБЕДА' : r.died ? 'СМЕРТЬ' : 'нет'} ${r.secs}с убит@${r.killSecs ?? '-'} крист@${r.crystalSecs ?? '-'}${r.died ? ` ${lh.type}/${lh.doing}` : ''}`)
  }
}
for (const [k, v] of Object.entries(by)) {
  v.times.sort((a, b) => a - b)
  console.log(`== ${k}: боёв ${v.n}, побед без смерти ${v.win}, смертей ${v.died}, прочее ${v.other}; убийство, с: ${v.times.join(', ')}${v.times.length ? ` (медиана ${v.times[Math.floor(v.times.length / 2)]})` : ''}; смерти: ${JSON.stringify(v.causes)}`)
  for (const r of v.rows) console.log('   ' + r)
}
