// Разбор журнала демона по goto: от строки [goto] до следующей. node an-goto-log.js <daemon.out.log> [fromLine]
const fs = require('fs')
const [file, from = '0'] = process.argv.slice(2)
const lines = fs.readFileSync(file, 'utf8').split('\n').slice(Number(from))
const segs = []
let cur = null
for (const l of lines) {
  if (l.startsWith('[goto] ')) { try { cur = { info: JSON.parse(l.slice(7)), paths: 0, searches: 0, searchMs: 0, statuses: {}, resets: {}, bridges: 0, cells: 0, stuck: 0 }; segs.push(cur) } catch {} continue }
  if (!cur) continue
  if (l.startsWith('[path] {')) {
    try {
      const p = JSON.parse(l.slice(7)); cur.paths++
      cur.statuses[p.status] = (cur.statuses[p.status] || 0) + 1
      if (p.status !== 'partial') { cur.searches++; cur.searchMs += p.ms }
    } catch {}
  } else if (l.startsWith('[path] reset: ')) { const r = l.slice(14).trim(); cur.resets[r] = (cur.resets[r] || 0) + 1 } else if (l.startsWith('[bridge] мост')) { cur.bridges++; try { cur.cells += JSON.parse(l.slice(14)).placed } catch {} } else if (l.startsWith('[stuck]')) cur.stuck++
}
for (const s of segs) {
  const m = s.info.bridge ? 'bridge' : s.info.sprint ? 'sprint' : s.info.wait ? 'wait' : 'base'
  console.log(`${m.padEnd(7)} to=${JSON.stringify(s.info.to)} поисков=${s.searches} мс=${s.searchMs} путей=${s.paths} ${JSON.stringify(s.statuses)} сбросы=${JSON.stringify(s.resets)} мостов=${s.bridges}/${s.cells} stuck=${s.stuck}`)
}
