'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// S8d (07.10): сводка серий «новый мир → Ад» по префиксам тегов + вехи на ОДИНАКОВОЙ работе (замечание проверки S8c «в»):
// время (игровые с от начала маршрута, по концу шага маршрута, где веха появилась в рюкзаке) до деревянной кирки, каменной
// кирки, ведра (любого), ведра + огня (огниво/заряд), ведра воды + огня (готовность к литью), входа в Ад; отрезки между вехами;
// дерево — секунд на бревно (шаг wood / брёвен в рюкзаке после него). Темп — игровые тики / реальные секунды (batch.json → итог).
//   node dist/farm/route-scan/s8d-sum.js <префикс[,префикс]> [...] [--cap 20] [--ready 12] [--rows] [--pairs A B]
import * as fs from 'fs'
import path = require('path')
const RES = path.join(REPO_ROOT, 'farm/results')
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args.splice(i, 2)[1]) : d }
const CAP = opt('--cap', 20)
const READY = opt('--ready', 12)
const showRows = args.includes('--rows')
const pi = args.indexOf('--pairs')
const pairs = pi >= 0 ? args.splice(pi, 3).slice(1) : null
const med = a => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const r1 = x => x == null ? '—' : Math.round(x * 10) / 10
const MS = ['деревянная кирка', 'каменная кирка', 'ведро', 'ведро+огонь', 'вода+огонь', 'Ад']

function milestones (res) {
  const pick = res.pick || ''
  const buckets = (res.bucket || 0) + (res.waterBucket || 0) + (res.lavaBucket || 0)
  const fire = (res.flintSteel || 0) + (res.fireCharge || 0) > 0
  return [!!pick, /^(stone|iron|diamond|netherite)$/.test(pick), buckets > 0, buckets > 0 && fire, (res.waterBucket || 0) > 0 && fire]
}

function load (prefix) {
  const dirs = prefix.split(',').flatMap(pre => fs.readdirSync(RES).filter(d => d.startsWith(pre + '-') && /^-[0-9]+$/.test(d.slice(pre.length)) && fs.statSync(path.join(RES, d)).isDirectory()))
  const runs = []
  for (const d of dirs) {
    const f = fs.readdirSync(path.join(RES, d)).find(x => /^slot-\d+\.jsonl$/.test(x))
    if (!f) continue
    let r; try { r = JSON.parse(fs.readFileSync(path.join(RES, d, f), 'utf8').trim().split('\n').pop()) } catch { continue }
    let wall = null; try { wall = (Date.parse(r.at) - Date.parse(JSON.parse(fs.readFileSync(path.join(RES, d, 'batch.json'), 'utf8')).at)) / 1000 } catch {}
    const at = MS.map(() => null)
    let woodSec = null; let woodLogs = null
    for (const s of fs.readdirSync(path.join(RES, d)).filter(x => x.endsWith('.skills.jsonl'))) {
      for (const l of fs.readFileSync(path.join(RES, d, s), 'utf8').split('\n')) {
        if (!l) continue
        let j; try { j = JSON.parse(l) } catch { continue }
        if (j.level !== 'step') continue
        const res = (j.after && j.after.res) || {}
        const m = milestones(res)
        m.forEach((v, i) => { if (v && at[i] === null) at[i] = j.sinceStart ?? null })
        if (j.kind === 'wood' && j.ok && woodSec === null) { woodSec = j.sec || 0; woodLogs = (res.logs || 0) + (res.planks || 0) / 4 + (res.pick ? 3 + 2 / 4 : 0) + 1 }
      }
    }
    const inAt = r.ok ? (r.reachedAt ?? r.minutes) : null
    if (inAt != null) at[5] = inAt * 60
    const deathAt = !r.ok && /смерт/.test(String(r.stoppedBy)) ? r.minutes : null
    runs.push({ tag: d, seed: String(r.seed), map: r.map || r.knowledge || '?', ok: inAt != null && inAt <= CAP, inAt, death: deathAt != null && deathAt <= CAP, deathAt,
      why: r.stoppedBy, deaths: r.deaths || [], at, perLog: woodSec != null && woodLogs ? woodSec / woodLogs : null, ticks: (r.minutes || 0) * 1200, wall })
  }
  return runs.sort((a, b) => Number(a.tag.split('-').pop()) - Number(b.tag.split('-').pop()))
}

function summary (prefix, runs) {
  const n = runs.length
  const ok = runs.filter(r => r.ok)
  const deaths = runs.filter(r => r.death)
  const maps = [...new Set(runs.map(r => r.map))].join('/')
  const paced = runs.filter(r => r.wall > 0)
  const pace = paced.reduce((t, r) => t + r.ticks, 0) / Math.max(1, paced.reduce((t, r) => t + r.wall, 0))
  console.log(`${prefix} [${maps}]: прогонов ${n}, в Аду ≤${CAP} мин ${ok.length}/${n} (${Math.round(100 * ok.length / Math.max(1, n))} %), медиана входа ${r1(med(ok.map(r => r.inAt)))} мин` +
    ` (${ok.map(r => r1(r.inAt)).sort((a: any, b: any) => a - b).join(' / ')}), смертей ≤${CAP} ${deaths.length}/${n} (${Math.round(100 * deaths.length / Math.max(1, n))} %), темп ${Math.round(pace)} тиков/с (тики / реальные с)`)
  const rd = i => runs.filter(r => r.at[i] != null && r.at[i] <= READY * 60).length
  console.log(`  к ${READY} мин: ведро+огонь ${rd(3)}/${n}, вода+огонь (готов к литью) ${rd(4)}/${n}; медианы вех (мин, у дошедших): ` +
    MS.map((m, i) => `${m} ${r1(med(runs.map(r => r.at[i] != null ? r.at[i] / 60 : NaN)))} (${runs.filter(r => r.at[i] != null).length})`).join(', '))
  const seg = (i) => med(runs.filter(r => r.at[i] != null && r.at[i + 1] != null).map(r => r.at[i + 1] - r.at[i]))
  console.log(`  отрезки между вехами (мед., с): старт→дер.кирка ${r1(med(runs.map(r => r.at[0])))}, дер.→кам. ${r1(seg(0))}, кам.→ведро ${r1(seg(1))}, ведро→огонь ${r1(seg(2))}, огонь→вода ${r1(seg(3))}, вода→Ад ${r1(seg(4))}; дерево ${r1(med(runs.map(r => r.perLog)))} с/бревно`)
  if (showRows) for (const r of runs) console.log(`  ${r.tag} ${r.seed} ${r.ok ? `в Аду ${r1(r.inAt)}` : r.death ? `смерть ${r1(r.deathAt)} (${String(r.deaths[0] || '').replace(/^NeuroFarm\d+ /, '')})` : `нет (${r.why})`} | ` + MS.map((m, i) => `${m} ${r.at[i] != null ? r1(r.at[i] / 60) : '—'}`).join(', '))
}

for (const prefix of args.filter(a => !a.startsWith('--') && !/^\d+$/.test(a))) summary(prefix, load(prefix))

// Пары A ↔ B по сидам (знак-тест): исход «в Аду», «вода+огонь к READY» — сид лучше/хуже/равно.
if (pairs) {
  const [A, B] = pairs.map(load)
  const bySeed = rs => { const m = new Map(); for (const r of rs) { const a = m.get(r.seed) || []; a.push(r); m.set(r.seed, a) } return m }
  const a = bySeed(A); const b = bySeed(B)
  for (const [name, f] of [['в Аду', r => r.ok ? 1 : 0], ['вода+огонь', r => r.at[4] != null && r.at[4] <= READY * 60 ? 1 : 0], ['смерть', r => r.death ? -1 : 0]] as [string, any][]) {
    let better = 0; let worse = 0; let same = 0
    for (const [seed, ra] of a) {
      const rb = b.get(seed); if (!rb) continue
      const sa = ra.reduce((t, r) => t + f(r), 0) / ra.length; const sb = rb.reduce((t, r) => t + f(r), 0) / rb.length
      if (sb > sa) better++; else if (sb < sa) worse++; else same++
    }
    const k = Math.min(better, worse); const nn = better + worse
    let p = 0; for (let i = 0; i <= k; i++) { let c = 1; for (let j = 0; j < i; j++) c = c * (nn - j) / (j + 1); p += c } p = Math.min(1, 2 * p / Math.pow(2, nn || 1))
    console.log(`пары ${pairs[0]} → ${pairs[1]} по «${name}»: лучше ${better}, хуже ${worse}, равно ${same} (знак-тест p≈${r1(p)})`)
  }
}
