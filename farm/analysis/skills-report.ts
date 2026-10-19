'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// Сводка телеметрии навыков (daemon/src/telemetry.js): по сериям фермы — цены стратегий для будущего графа (V2).
//   node dist/farm/analysis/skills-report.js <метка|папка> [...] [--level step|stage|act] [--json]
// Метка — префикс папок farm/results/<метка>*; читаются все *.skills.jsonl в них. По умолчанию — step и stage.
// Ключ: step — вид шага маршрута (kind), stage — этап кампании, act — навык демона (RPC) с этапом.
import * as fs from 'fs'
import path = require('path')

const RESULTS = path.join(REPO_ROOT, 'farm/results')
const args = process.argv.slice(2)
const json = args.includes('--json')
const li = args.indexOf('--level')
const levels = li >= 0 ? [args[li + 1]] : ['step', 'stage']
const specs = args.filter((a, i) => !a.startsWith('--') && !(li >= 0 && i === li + 1))
if (!specs.length) { console.error('node dist/farm/analysis/skills-report.js <метка|папка> [...] [--level step|stage|act] [--json]'); process.exit(2) }

function files (spec) {
  const dirs = fs.existsSync(spec) && fs.statSync(spec).isDirectory() ? [spec]
    : fs.readdirSync(RESULTS).filter(d => d.startsWith(spec)).map(d => path.join(RESULTS, d)).filter(d => fs.statSync(d).isDirectory())
  const out = []
  for (const d of dirs) for (const f of fs.readdirSync(d)) if (f.endsWith('.skills.jsonl')) out.push(path.join(d, f))
  return out
}

const rows = []
for (const spec of specs) {
  for (const f of files(spec)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch {}
    }
  }
}

const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] }
const keyOf = r => r.level === 'step' ? r.kind || r.step : r.level === 'stage' ? r.stage : `${r.stage || '-'}:${r.skill}`
const report: Record<string, any> = {} as Record<string, any>
for (const level of levels) {
  const g = new Map()
  for (const r of rows.filter(r => r.level === level)) {
    const k = keyOf(r)
    if (!g.has(k)) g.set(k, [])
    g.get(k).push(r)
  }
  report[level] = [...g.entries()].map(([key, rs]: any) => {
    const ok = rs.filter(r => r.ok)
    const why = new Map()
    for (const r of rs.filter(r => !r.ok)) {
      const w = String(r.error || r.code || r.why || r.result || r.status || '?').replace(/-?\d+/g, '#').slice(0, 80)
      why.set(w, (why.get(w) || 0) + 1)
    }
    return {
      key, n: rs.length, ok: ok.length, okPct: Math.round(100 * ok.length / rs.length),
      medSec: q(ok.map(r => r.sec), 0.5), p90Sec: q(ok.map(r => r.sec), 0.9), medSecAll: q(rs.map(r => r.sec), 0.5),
      deaths: rs.filter(r => r.death).length, runs: new Set(rs.map(r => r.run)).size,
      topFail: [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]: any) => `${n}× ${w}`)
    }
  }).sort((a, b) => b.n - a.n)
}

if (json) { console.log(JSON.stringify({ specs, rows: rows.length, report }, null, 2)); process.exit(0) }
console.log(`строк телеметрии: ${rows.length} (${specs.join(', ')})`)
for (const [level, list] of Object.entries<any>(report)) {
  console.log(`\n## ${level}`)
  console.log('| ключ | n | успех | медиана, с | p90, с | смерти | частые провалы |')
  console.log('|---|---:|---:|---:|---:|---:|---|')
  for (const r of list) console.log(`| ${r.key} | ${r.n} | ${r.ok} (${r.okPct}%) | ${r.medSec ?? '—'} | ${r.p90Sec ?? '—'} | ${r.deaths} | ${r.topFail.join('; ')} |`)
}
