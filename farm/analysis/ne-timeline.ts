'use strict'
// Куда ушло время сквозной попытки (dev-F): node dist/farm/analysis/ne-timeline.js <campaign.log>…
// По строкам «[чч:мм:сс +Nм] этап  …» — минуты на каждый этап (от первой его строки до первой строки следующего),
// плюс вехи и смерти.
import * as fs from 'fs'
for (const file of process.argv.slice(2)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const rows = []
  for (const l of lines) {
    const m = /^\[(\d\d):(\d\d):(\d\d) \+\s*\d+м\] (\S+)\s+(.*)$/.exec(l)
    if (!m) continue
    rows.push({ t: (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]), stage: m[4], text: m[5] })
  }
  if (!rows.length) { console.log(file, ': пусто'); continue }
  const per: Record<string, any> = {} as Record<string, any>
  for (let i = 0; i < rows.length - 1; i++) {
    let dt = rows[i + 1].t - rows[i].t
    if (dt < 0) dt += 86400
    per[rows[i].stage] = (per[rows[i].stage] || 0) + dt
  }
  const total = (rows[rows.length - 1].t - rows[0].t + 86400) % 86400
  const miles = rows.filter(r => /ВЕХА/.test(r.text)).map(r => r.text.replace(/: готово.*?(\d+) мин.*$/, ' @$1м'))
  const deaths = rows.filter(r => /умер|DIED/.test(r.text)).length
  console.log(`${file.split(/[\\/]/).pop()}: всего ${(total / 60).toFixed(1)} мин; ` +
    Object.entries<any>(per).sort((a, b) => b[1] - a[1]).map(([k, v]: any) => `${k} ${(v / 60).toFixed(1)}`).join(', ') +
    `; вехи: ${miles.join(', ') || '—'}; строк о смерти: ${deaths}`)
}
