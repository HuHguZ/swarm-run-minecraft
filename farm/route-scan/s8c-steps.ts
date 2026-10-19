'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// S8c (07.10): шаги маршрута серии — по виду шага: сколько раз, доля удачных, медиана и сумма секунд на прогон.
//   node dist/farm/route-scan/s8c-steps.js <префикс[,префикс]>
import * as fs from 'fs'
import path = require('path')
const RES = path.join(REPO_ROOT, 'farm/results')
for (const prefix of process.argv.slice(2)) {
  const dirs = prefix.split(',').flatMap(pre => fs.readdirSync(RES).filter(d => d.startsWith(pre + '-') && /^-[0-9]+$/.test(d.slice(pre.length))))
  const by = {}
  let runs = 0
  for (const d of dirs) {
    if (!fs.existsSync(path.join(RES, d, 'slot-8.jsonl'))) continue
    runs++
    for (const f of fs.readdirSync(path.join(RES, d)).filter(x => x.endsWith('.skills.jsonl'))) {
      for (const l of fs.readFileSync(path.join(RES, d, f), 'utf8').split('\n')) {
        if (!l) continue
        let j; try { j = JSON.parse(l) } catch { continue }
        if (j.level !== 'step') continue
        const b = by[j.kind] || (by[j.kind] = { n: 0, ok: 0, sec: [] })
        b.n++; if (j.ok) b.ok++; b.sec.push(j.sec || 0)
      }
    }
  }
  const med = a => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[v.length >> 1] : 0 }
  console.log(`${prefix}: прогонов ${runs}`)
  for (const [k, b] of Object.entries<any>(by).sort((a: any, c: any) => c[1].sec.reduce((x, y) => x + y, 0) - a[1].sec.reduce((x, y) => x + y, 0))) {
    console.log(`  ${k.padEnd(10)} n ${String(b.n).padStart(3)}  удачных ${String(b.ok).padStart(3)}  мед. ${String(Math.round(med(b.sec))).padStart(4)} с  сумма/прогон ${Math.round(b.sec.reduce((x, y) => x + y, 0) / Math.max(1, runs))} с`)
  }
}
