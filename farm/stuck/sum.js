'use strict'
// Сводка сцены try-lab-stuck.js: сцена × режим — дошёл/всего, медиана времени удачных, среднее с провалом = срок,
// мин. хп, блоков, ступени лестницы.
//   node farm/stuck/sum.js <tag...>
const fs = require('fs')
const path = require('path')
const RES = path.join(__dirname, '..', 'results')
const rows = []
for (const tag of process.argv.slice(2)) {
  const dir = path.join(RES, tag)
  for (const f of fs.readdirSync(dir).filter(f => /^slot-\d+\.jsonl$/.test(f))) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l.trim()) { try { rows.push({ ...JSON.parse(l), tag }) } catch {} }
  }
}
const med = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const groups = {}
for (const r of rows) {
  if (r.error && !r.goto) continue // сбой стенда (телепорт, clone) — не проба
  const k = `${r.scene}|${r.mode}`
  ;(groups[k] = groups[k] || []).push(r)
}
const lim = Number(process.env.GOTO_SEC || 60) * 1000
console.log('сцена        режим    дошёл   медиана,с  среднее*,с  минХП  блоков  ступени (класс:ступень, «-» — не применилась)')
for (const k of Object.keys(groups).sort()) {
  const g = groups[k]
  const [scene, mode] = k.split('|')
  const ok = g.filter(r => r.ok)
  const mean = g.reduce((s, r) => s + (r.ok ? r.ms : Math.max(r.ms || 0, lim)), 0) / g.length
  const rungs = {}
  for (const r of g) for (const x of (r.ladder && r.ladder.rungs) || []) rungs[x] = (rungs[x] || 0) + 1
  const top = Object.entries(rungs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([x, n]) => `${x}×${n}`).join(' ')
  console.log(`${scene.padEnd(12)} ${mode.padEnd(8)} ${String(ok.length + '/' + g.length).padEnd(7)} ${(med(ok.map(r => r.ms)) / 1000).toFixed(1).padStart(9)}  ${(mean / 1000).toFixed(1).padStart(10)}  ${String(Math.min(...g.map(r => r.minHp ?? 20))).padStart(5)}  ${String(Math.round(g.reduce((s, r) => s + (r.blocks || 0), 0) / g.length)).padStart(6)}  ${top}`)
}
const fails = rows.filter(r => !r.ok)
if (process.env.FAILS) for (const r of fails) console.log(`  ✗ ${r.tag} s${r.slot} ${r.scene}/${r.mode}: ${r.error || (r.goto && (r.goto.error || r.goto.stopped)) || 'не дошёл'} → ${r.end ? JSON.stringify(r.end.pos) : ''}`)
