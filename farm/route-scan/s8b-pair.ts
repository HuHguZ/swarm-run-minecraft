'use strict'
// S8b (07.10): парное сравнение двух плеч серий «новый мир → Ад» по сидам (одни и те же сиды, по нескольку прогонов на сид).
// Окно — CAP игровых минут (по умолчанию 20). Знак-тест по сидам: где плечо B лучше/хуже по доле входов.
//   node farm/route-scan/s8b-pair.js --a s8b-a1,s8b-a2 --b s8b-b [--cap 20]
const fs = require('fs')
const path = require('path')
const RES = path.join(__dirname, '..', 'results')
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const CAP = Number(opt('--cap', 20))
function load (prefixes) {
  const by = new Map()
  for (const prefix of prefixes.split(',')) {
    for (const d of fs.readdirSync(RES).filter(x => x.startsWith(prefix + '-') && /-\d+$/.test(x))) {
      const f = path.join(RES, d, 'slot-8.jsonl')
      if (!fs.existsSync(f)) continue
      let r; try { r = JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop()) } catch { continue }
      const inAt = r.ok ? (r.reachedAt ?? r.minutes) : null
      const row = { ok: inAt != null && inAt <= CAP, inAt, death: !r.ok && /смерт/.test(String(r.stoppedBy)) && r.minutes <= CAP }
      if (!by.has(r.seed)) by.set(r.seed, [])
      by.get(r.seed).push(row)
    }
  }
  return by
}
const A = load(opt('--a', '')), B = load(opt('--b', ''))
const med = a => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
let better = 0, worse = 0, same = 0
const both = []
const tot = { a: { n: 0, ok: 0, d: 0 }, b: { n: 0, ok: 0, d: 0 } }
for (const seed of [...A.keys()].filter(s => B.has(s))) {
  const a = A.get(seed), b = B.get(seed)
  const pa = a.filter(r => r.ok).length / a.length, pb = b.filter(r => r.ok).length / b.length
  if (pb > pa) better++; else if (pb < pa) worse++; else same++
  for (const [k, rows] of [['a', a], ['b', b]] as const) { tot[k].n += rows.length; tot[k].ok += rows.filter(r => r.ok).length; tot[k].d += rows.filter(r => r.death).length }
  const ta = med(a.filter(r => r.ok).map(r => r.inAt)), tb = med(b.filter(r => r.ok).map(r => r.inAt))
  if (ta != null && tb != null) both.push(tb - ta)
  console.log(`${seed.padStart(21)}  A ${a.map(r => r.ok ? r.inAt.toFixed(1) : r.death ? '†' : '—').join(' ').padEnd(16)} B ${b.map(r => r.ok ? r.inAt.toFixed(1) : r.death ? '†' : '—').join(' ')}`)
}
// Знак-тест (двусторонний, без ничьих): P(≥ max из n при p = 0.5).
const n = better + worse, k = Math.max(better, worse)
let p = 0; for (let i = k; i <= n; i++) { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); p += c / 2 ** n }
console.log(`A: ${tot.a.ok}/${tot.a.n} в Аду, смертей ${tot.a.d}; B: ${tot.b.ok}/${tot.b.n}, смертей ${tot.b.d}; сидов: B лучше ${better}, хуже ${worse}, равно ${same} (знак-тест p≈${Math.min(1, 2 * p).toFixed(3)}); ` +
  `сдвиг времени входа B−A на сидах, где вошли оба: медиана ${med(both) == null ? '—' : med(both).toFixed(1)} мин (${both.length} сидов)`)
