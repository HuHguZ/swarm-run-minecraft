import { REPO_ROOT } from '../../daemon/src/paths'
// Лаборатория: доля снижений, где первые N взрывов (сервер) дают ≥ T урона (02.10): node dist/farm/dragon/an-sum4.js <тег> [N=4]
// MAXCYC=24 — только первые циклы слота (в labS1/labS2 кончался булыжник — опора P + 1). Порог 209 — 200 хп + ~9 лечения кристаллами за цепочку в бою. По плечам: снижений, взрывов/снижение, Σ p25/p50, ≥200, ≥209.
import * as fs from 'fs'; import path = require('path')
const tag = process.argv[2]; const N = Number(process.argv[3] || 4)
const dir = path.join(REPO_ROOT, 'farm/results', tag)
const cyc = new Map(); const cycRec = []
for (const f of fs.readdirSync(dir).filter(f => /^slot-\d+\.jsonl$/.test(f))) {
  for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!l) continue; let e; try { e = JSON.parse(l) } catch { continue }
    if (e.t === 'blast' && e.ph === 'LAND_ON_PORTAL') { const k = `${e.arm}|${f}|${e.cyc}`; (cyc.get(k) || cyc.set(k, []).get(k)).push(e) }
    if (e.t === 'cyc' && e.cyc < Number(process.env.MAXCYC || 1e9)) cycRec.push({ ...e, f })
  }
}
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor((s.length - 1) * p)] * 10) / 10 : '-' }
const arms = [...new Set(cycRec.map(c => c.arm))].sort()
for (const arm of arms) {
  const cs = cycRec.filter(c => c.arm === arm && c.landed)
  const sums = cs.map(c => (cyc.get(`${arm}|${c.f}|${c.cyc}`) || []).sort((a, b) => a.k - b.k).slice(0, N).reduce((s, b) => s + b.dmg, 0))
  const n4 = cs.filter(c => (cyc.get(`${arm}|${c.f}|${c.cyc}`) || []).length >= N).length
  const all = [].concat(...cs.map(c => cyc.get(`${arm}|${c.f}|${c.cyc}`) || []))
  const arr = cs.map(c => (c.arrows || []).reduce((s, a) => s + (a.dmg || 0), 0))
  const sumsA = sums.map((s, i) => s + arr[i])
  const nArr = cs.reduce((s, c) => s + (c.arrows || []).length, 0)
  console.log(`${arm}: снижений ${cs.length}, с ≥${N} взрывами ${n4}, взрыв p25/p50 ${q(all.map(b => b.dmg), 0.25)}/${q(all.map(b => b.dmg), 0.5)} seen p25 ${q(all.map(b => b.seen ?? 1), 0.25)} голова p50 ${q(all.map(b => b.dHead), 0.5)}; Σ${N} p25/p50 ${q(sums, 0.25)}/${q(sums, 0.5)}; ≥200 ${sums.filter(s => s >= 200).length} (${Math.round(100 * sums.filter(s => s >= 200).length / Math.max(1, cs.length))}%), ≥209 ${sums.filter(s => s >= 209).length} (${Math.round(100 * sums.filter(s => s >= 209).length / Math.max(1, cs.length))}%)${nArr ? `; стрел попало ${nArr} (урон p50 ${q([].concat(...cs.map(c => (c.arrows || []).map(a => a.dmg))), 0.5)}), Σ${N}+стрелы ≥209 ${sumsA.filter(s => s >= 209).length} (${Math.round(100 * sumsA.filter(s => s >= 209).length / Math.max(1, cs.length))}%)` : ''}`)
}
