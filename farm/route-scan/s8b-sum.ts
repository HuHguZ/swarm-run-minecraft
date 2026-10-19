'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// S8b (07.10): сводка серий «новый мир → Ад» по тегу-префиксу: farm/results/<префикс>-<k>/. Вход в Ад и смерти — в пределах
// CAP игровых минут (по умолчанию 20: у серий с MINUTES=30 считается то же окно), фазы — по шагам маршрута (level step).
//   node dist/farm/route-scan/s8b-sum.js <префикс> [<префикс> ...] [--cap 20] [--rows]
import * as fs from 'fs'
import path = require('path')
const RES = path.join(REPO_ROOT, 'farm/results')
const args = process.argv.slice(2)
const capI = args.indexOf('--cap'); const CAP = capI >= 0 ? Number(args.splice(capI, 2)[1]) : 20
const showRows = args.includes('--rows')
const PHASE = { wood: 'дерево', stone: 'камень', ruin: 'железо/еда', village: 'железо/еда', ship: 'железо/еда', treasure: 'железо/еда', ore: 'железо/еда',
  smelt: 'железо/еда', food: 'железо/еда', flint: 'железо/еда', water: 'лава/литьё', castSky: 'лава/литьё', castCave: 'лава/литьё', castDeep: 'лава/литьё', enter: 'портал' }
const PH = ['дерево', 'камень', 'железо/еда', 'лава/литьё', 'портал']
const med = a => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const r1 = x => x == null ? '—' : Math.round(x * 10) / 10

// Префиксы через запятую — одной сводкой (плечо из нескольких серий: s8b-a1,s8b-a2).
for (const prefix of args.filter(a => !a.startsWith('--') && !/^\d+$/.test(a))) {
  const dirs = prefix.split(',').flatMap(pre => fs.readdirSync(RES).filter(d => d.startsWith(pre + '-') && /-[0-9]+$/.test(d.slice(pre.length)) && fs.statSync(path.join(RES, d)).isDirectory())
    .sort((a, b) => Number(a.split('-').pop()) - Number(b.split('-').pop())))
  const runs = []
  for (const d of dirs) {
    const f = fs.readdirSync(path.join(RES, d)).find(x => /^slot-\d+\.jsonl$/.test(x))
    if (!f) continue
    const line = fs.readFileSync(path.join(RES, d, f), 'utf8').trim().split('\n').pop()
    let r; try { r = JSON.parse(line) } catch { continue }
    const steps = []
    for (const s of fs.readdirSync(path.join(RES, d)).filter(x => x.endsWith('.skills.jsonl'))) {
      for (const l of fs.readFileSync(path.join(RES, d, s), 'utf8').split('\n')) { if (!l) continue; try { const j = JSON.parse(l); if (j.level === 'step') steps.push(j) } catch {} }
    }
    const inAt = r.ok ? (r.reachedAt ?? r.minutes) : null
    const deathAt = !r.ok && /смерт/.test(String(r.stoppedBy)) ? r.minutes : null
    const phaseSec = {}; const phaseDone = {}
    for (const s of steps) {
      const p = PHASE[s.kind]; if (!p) continue
      phaseSec[p] = (phaseSec[p] || 0) + (s.sec || 0)
      if (s.ok) phaseDone[p] = Math.max(phaseDone[p] || 0, s.sinceStart || 0)
    }
    runs.push({ tag: d, seed: r.seed, ok: inAt != null && inAt <= CAP, inAt, death: deathAt != null && deathAt <= CAP, deathAt, why: r.stoppedBy, phaseSec, phaseDone })
  }
  const n = runs.length
  const ok = runs.filter(r => r.ok)
  const deaths = runs.filter(r => r.death)
  console.log(`${prefix}: прогонов ${n}, в Аду ≤${CAP} мин ${ok.length}/${n} (${Math.round(100 * ok.length / Math.max(1, n))} %), медиана входа ${r1(med(ok.map(r => r.inAt)))} мин` +
    ` (${ok.map(r => r1(r.inAt)).sort((a: any, b: any) => a - b).join(' / ')}), смертей ≤${CAP} ${deaths.length}/${n} (${Math.round(100 * deaths.length / Math.max(1, n))} %)`)
  console.log('  фазы (с): ' + PH.map(p => `${p} — время в фазе мед. ${r1(med(runs.map(r => r.phaseSec[p] || 0)))}, у вошедших конец фазы мед. ${r1(med(ok.map(r => r.phaseDone[p])))}`).join('; '))
  if (showRows) for (const r of runs) console.log(`  ${r.tag} ${r.seed} ${r.ok ? `в Аду ${r1(r.inAt)}` : r.death ? `смерть ${r1(r.deathAt)}` : `нет (${r.why})`} | ` + PH.map(p => `${p} ${Math.round(r.phaseSec[p] || 0)}`).join(', '))
}
