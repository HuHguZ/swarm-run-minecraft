'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// S8c (07.10): сводка серий «новый мир → Ад» по префиксам тегов (как s8b-sum) + уровень знания (map из итога сцены), темп
// (игровые тики / реальные секунды, от batch.json до итоговой строки) и фазы: шаги маршрута (level step) и верхние этапы
// кампании (level stage, кроме route) — вслепую старым путём шагов маршрута нет.
//   node dist/farm/route-scan/s8c-sum.js <префикс[,префикс]> [...] [--cap 20] [--rows]
import * as fs from 'fs'
import path = require('path')
const RES = path.join(REPO_ROOT, 'farm/results')
const args = process.argv.slice(2)
const capI = args.indexOf('--cap'); const CAP = capI >= 0 ? Number(args.splice(capI, 2)[1]) : 20
const showRows = args.includes('--rows')
const PH = ['дерево', 'камень', 'железо/еда', 'лава/литьё', 'портал']
const STEP = { wood: 0, stone: 1, ruin: 2, village: 2, ship: 2, treasure: 2, ore: 2, mine: 2, ironStage: 2, lookout: 2, scoutIron: 2, smelt: 2, food: 2, flint: 2,
  water: 3, castSky: 3, castCave: 3, castDeep: 3, scoutLava: 3, light: 3, enter: 4 }
const STAGE = { wood: 0, AcquireWood: 0, stone: 1, AcquireStoneTools: 1, iron: 2, MineIron: 2, ScoutStructures: 2, VillageIron: 2, ShipwreckIron: 2,
  TreasureIron: 2, CraftPortalKit: 2, food: 2, FindFood: 2, Heal: 2, water: 3, GetWater: 3, cast: 3, ScoutLava: 3, LavaPoolPortal: 3, RuinedPortal: 3,
  AcquireDiamondPick: 3, MineObsidian: 3, ObsidianPortal: 3, portal: 4, routeEnter: 4, PrepareNether: 4, EnterNether: 4 }
const med = a => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const r1 = x => x == null ? '—' : Math.round(x * 10) / 10

function load (prefix) {
  const dirs = prefix.split(',').flatMap(pre => fs.readdirSync(RES).filter(d => d.startsWith(pre + '-') && /^-[0-9]+$/.test(d.slice(pre.length)) && fs.statSync(path.join(RES, d)).isDirectory()))
  const runs = []
  for (const d of dirs) {
    const f = fs.readdirSync(path.join(RES, d)).find(x => /^slot-\d+\.jsonl$/.test(x))
    if (!f) continue
    let r; try { r = JSON.parse(fs.readFileSync(path.join(RES, d, f), 'utf8').trim().split('\n').pop()) } catch { continue }
    let wall = null; try { wall = (Date.parse(r.at) - Date.parse(JSON.parse(fs.readFileSync(path.join(RES, d, 'batch.json'), 'utf8')).at)) / 1000 } catch {}
    const sec = PH.map(() => 0); const done = PH.map(() => null)
    let ready = null // ведро и огниво в рюкзаке — первый шаг маршрута с ними (с от начала маршрута)
    for (const s of fs.readdirSync(path.join(RES, d)).filter(x => x.endsWith('.skills.jsonl'))) {
      for (const l of fs.readFileSync(path.join(RES, d, s), 'utf8').split('\n')) {
        if (!l) continue
        let j; try { j = JSON.parse(l) } catch { continue }
        const k = j.level === 'step' ? STEP[j.kind] : j.level === 'stage' && j.stage !== 'route' ? STAGE[j.stage] : undefined
        if (k === undefined) continue
        sec[k] += j.sec || 0
        if (j.level === 'step' && j.ok) done[k] = Math.max(done[k] || 0, j.sinceStart || 0)
        const res = j.level === 'step' && j.after && j.after.res
        if (res && ready === null && (res.bucket || 0) >= 1 && (res.flintSteel || 0) >= 1) ready = j.sinceStart || null
      }
    }
    const inAt = r.ok ? (r.reachedAt ?? r.minutes) : null
    const deathAt = !r.ok && /смерт/.test(String(r.stoppedBy)) ? r.minutes : null
    runs.push({ tag: d, seed: r.seed, map: r.map || r.knowledge || '?', ok: inAt != null && inAt <= CAP, inAt, death: deathAt != null && deathAt <= CAP, deathAt,
      why: r.stoppedBy, deaths: r.deaths || [], sec, done, ready, ticks: (r.minutes || 0) * 1200, wall })
  }
  return runs.sort((a, b) => Number(a.tag.split('-').pop()) - Number(b.tag.split('-').pop()))
}

for (const prefix of args.filter(a => !a.startsWith('--') && !/^\d+$/.test(a))) {
  const runs = load(prefix)
  const n = runs.length
  const ok = runs.filter(r => r.ok)
  const deaths = runs.filter(r => r.death)
  const maps = [...new Set(runs.map(r => r.map))].join('/')
  const paced = runs.filter(r => r.wall > 0)
  const pace = paced.reduce((t, r) => t + r.ticks, 0) / Math.max(1, paced.reduce((t, r) => t + r.wall, 0))
  console.log(`${prefix} [${maps}]: прогонов ${n}, в Аду ≤${CAP} мин ${ok.length}/${n} (${Math.round(100 * ok.length / Math.max(1, n))} %), медиана входа ${r1(med(ok.map(r => r.inAt)))} мин` +
    ` (${ok.map(r => r1(r.inAt)).sort((a: any, b: any) => a - b).join(' / ')}), смертей ≤${CAP} ${deaths.length}/${n} (${Math.round(100 * deaths.length / Math.max(1, n))} %), темп ${Math.round(pace)} тиков/с`)
  const readies = runs.map(r => r.ready).filter(x => x != null)
  console.log(`  ведро+огниво к ≤20 мин: ${readies.filter(x => x <= CAP * 60).length}/${n}, медиана ${r1(med(readies) != null ? med(readies) / 60 : null)} мин`)
  console.log('  фазы (мед., с): ' + PH.map((p, i) => `${p} ${r1(med(runs.map(r => r.sec[i])))} / конец у вошедших ${r1(med(ok.map(r => r.done[i])))}`).join('; '))
  if (showRows) for (const r of runs) console.log(`  ${r.tag} ${r.seed} ${r.ok ? `в Аду ${r1(r.inAt)}` : r.death ? `смерть ${r1(r.deathAt)} (${String(r.deaths[0] || '').replace(/^NeuroFarm\d+ /, '')})` : `нет (${r.why})`} | ` + PH.map((p, i) => `${p} ${Math.round(r.sec[i])}`).join(', '))
}
