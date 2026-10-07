'use strict'
// S8b: средний темп серии — игровые тики / реальные секунды (от batch.json до итоговой строки сцены).
const fs = require('fs'), path = require('path')
const RES = path.join(__dirname, '..', 'results')
for (const prefix of process.argv.slice(2)) {
  let ticks = 0, wall = 0, n = 0
  for (const d of fs.readdirSync(RES).filter(x => x.startsWith(prefix + '-') && /-\d+$/.test(x))) {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(RES, d, 'batch.json'), 'utf8'))
      const r = JSON.parse(fs.readFileSync(path.join(RES, d, 'slot-8.jsonl'), 'utf8').trim().split('\n').pop())
      const w = (Date.parse(r.at) - Date.parse(b.at)) / 1000
      if (!(w > 0)) continue
      ticks += r.minutes * 60 * 20; wall += w; n++
    } catch {}
  }
  console.log(`${prefix}: ${n} прогонов, ${Math.round(ticks / 1200)} игр. мин за ${Math.round(wall / 60)} мин реального — средний темп ${Math.round(ticks / wall)} тиков/с`)
}
