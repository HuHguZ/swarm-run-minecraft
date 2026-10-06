'use strict'
// Сводка пар natural/baseline: node farm/portal-scan/pairs-report.js <tag> [<tag> ...] [--steps]
const fs = require('fs'); const path = require('path')
const tags = process.argv.slice(2).filter(a => !a.startsWith('--'))
const steps = process.argv.includes('--steps')
const rows = []
for (const t of tags) {
  const dir = path.join(__dirname, '..', 'results', t)
  for (const f of fs.readdirSync(dir).filter(f => /^slot-\d+\.jsonl$/.test(f))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) if (line.trim()) rows.push({ tag: t, ...JSON.parse(line) })
  }
}
rows.sort((a, b) => a.at.localeCompare(b.at))
const bySeed: Record<string, any> = {} as Record<string, any>
for (const r of rows) (bySeed[`${r.tag} ${r.seed}`] = bySeed[`${r.tag} ${r.seed}`] || {} as Record<string, any>)[r.mode] = r
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
const MODES = ['natural', 'hint', 'baseline']
const sum = { natural: [], hint: [], baseline: [] }
for (const [k, p] of Object.entries<any>(bySeed)) {
  const line = [k]
  for (const m of MODES) {
    const r = p[m]
    if (!r) { if (m !== 'hint') line.push(`${m}: —`); continue }
    sum[m].push(r)
    line.push(`${m}: ${r.ok ? 'ГОРИТ' : 'нет'} ${r.seconds} с, hp≥${r.minHp}, смертей ${r.deaths}${r.site ? `, ${r.site.kind} ${r.site.dist} м` : ''}${r.foundAt !== undefined ? `, нашёл на ${r.foundAt} с` : ''}${!r.ok && r.stopped ? ` (${r.stopped.slice(0, 40)})` : ''}`)
  }
  console.log(line.join(' | '))
  if (steps) for (const m of MODES) if (p[m]) for (const s of p[m].steps) console.log(`   ${m} ${JSON.stringify(s).slice(0, 200)}`)
}
for (const m of MODES) {
  const rs = sum[m]; const ok = rs.filter(r => r.ok)
  if (!rs.length) continue
  console.log(`${m}: n ${rs.length}, горит ${ok.length}, медиана до поджига (успешные) ${med(ok.map(r => r.seconds))} с, медиана всех ${med(rs.map(r => r.ok ? r.seconds : 600))} с (провал = 600), мин hp ${Math.min(...rs.map(r => r.minHp))}, смертей ${rs.reduce((a, r) => a + r.deaths, 0)}`)
}
