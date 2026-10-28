// Калибровка цен графа по журналам ферм (поток graph, sr27): реальное время, доля успеха и смертность стратегий против цен графа.
//   node dist-sr-graph/farm/analysis/graph-calibrate.js [папки с *.skills.jsonl…] [--out файл.json]
// Без папок — farm/results/{sr27-*,ow27-*}. Цена «сейчас» — приор speedrun.ts, смешанный с daemon/strategy-costs.json (06.10);
// «по новым» — та же формула applyCosts, но на новых данных вместо старых.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import '../../daemon/src/speedrun-defaults'
import { collectCosts } from './strategy-costs'
import { applyCosts, successEstimate, mortalitySamples, type CostModel } from '../../daemon/src/core/cost-model'
import { speedrunRegistry } from '../../daemon/src/core/speedrun'
import { loadCosts } from '../../daemon/src/environments/cost-data'
import { scenarioState, ENTRY_KIT } from './graph-scenarios'
import { REPO_ROOT } from '../../daemon/src/paths'

const NETHER = new Set(['FindBastions', 'FindFortress', 'BastionBarter', 'PiglinBarter', 'HuntEndermen', 'GetBlazeRods', 'AcquireNetherTools',
  'AcquireFireResistance', 'CraftEyes', 'LeaveNether'])

function main(args: string[]): void {
  let out: string | null = null
  const dirs: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = resolve(args[++i]!)
    else dirs.push(resolve(args[i]!))
  }
  if (!dirs.length) {
    const results = resolve(REPO_ROOT, 'farm/results')
    dirs.push(...readdirSync(results, { withFileTypes: true }).filter(e => e.isDirectory() && /^(sr27-|ow27-)/.test(e.name)).map(e => resolve(results, e.name)))
  }
  const fresh = collectCosts(dirs)
  const models = fresh.models.filter(m => !m.key.includes('@'))
  const prior = speedrunRegistry({ eyes: 12, beds: 5 })
  const now = speedrunRegistry({ eyes: 12, beds: 5 }); applyCosts(now, loadCosts())
  const refit = speedrunRegistry({ eyes: 12, beds: 5 }); applyCosts(refit, fresh.models)
  const perDoneWas = process.env.ND_GRAPH_RISK_PER_DONE
  process.env.ND_GRAPH_RISK_PER_DONE = '1'
  const done = speedrunRegistry({ eyes: 12, beds: 5 }); applyCosts(done, fresh.models)
  if (perDoneWas === undefined) delete process.env.ND_GRAPH_RISK_PER_DONE; else process.env.ND_GRAPH_RISK_PER_DONE = perDoneWas
  const ref = (id: string) => scenarioState(NETHER.has(id)
    ? { name: 'ref', speedrunner: [], why: '', dimension: 'the_nether', inventory: ENTRY_KIT, known: { fortress: { x: 0, y: 70, z: 0 }, bastion: { x: 0, y: 70, z: 0 } } }
    : { name: 'ref', speedrunner: [], why: '', dimension: 'overworld', inventory: ENTRY_KIT })
  const rows = models.filter(m => prior.get(m.key)).sort((a, b) => b.samples - a.samples).map((m: CostModel) => {
    const s = ref(m.key)
    const price = (r: typeof prior) => ({ sec: Math.round(r.get(m.key)!.estimateCost(s) / 20), risk: Math.round(r.get(m.key)!.estimateRisk(s) * 1000) / 1000 })
    return { id: m.key, n: m.samples, ok: m.successes, partial: m.partials ?? 0, interrupted: m.interrupts ?? 0, deaths: m.deaths, deathN: mortalitySamples(m),
      medianSec: Math.round(m.medianTicks / 20), p90Sec: Math.round(m.p90Ticks / 20), success: Math.round(successEstimate(m) * 100) / 100,
      prior: price(prior), now: price(now), refit: price(refit), perDone: price(done).risk }
  })
  console.log(`источники: ${fresh.sourceDirectories.length} папок, записей ${fresh.records}, образцов ${fresh.acceptedSamples}`)
  console.log('стратегия              n  ok part int смерт  мед/p90 с  успех | приор с/риск | сейчас с/риск | по новым с/риск | риск на завершение')
  for (const r of rows) console.log(`${r.id.padEnd(22)}${String(r.n).padStart(3)}${String(r.ok).padStart(4)}${String(r.partial).padStart(5)}${String(r.interrupted).padStart(4)}${String(r.deaths).padStart(4)}/${String(r.deathN).padEnd(3)}${String(r.medianSec).padStart(5)}/${String(r.p90Sec).padEnd(5)}${String(r.success).padStart(6)} | ${String(r.prior.sec).padStart(5)} ${r.prior.risk.toFixed(3)} | ${String(r.now.sec).padStart(5)} ${r.now.risk.toFixed(3)} | ${String(r.refit.sec).padStart(5)} ${r.refit.risk.toFixed(3)} | ${r.perDone.toFixed(3)}`)
  const stages = models.filter(m => !prior.get(m.key)).sort((a, b) => b.samples - a.samples)
  console.log('\nэтапы/шаги (legacy): ' + stages.slice(0, 30).map(m => `${m.key} ${m.samples}/${m.successes}✓/${m.deaths}✝ ${Math.round(m.medianTicks / 20)}с`).join('; '))
  const deaths = attributeDeaths(dirs)
  console.log(`
смерти по последней стратегии графа (≤ ${ATTRIB_S} с до смерти; в записях strategy их почти нет — гибнут в тактике после прерывания):`)
  for (const [id, d] of [...deaths.entries()].sort((a, b) => b[1].deaths - a[1].deaths)) console.log(`  ${id.padEnd(22)} смертей ${d.deaths} из ${d.attempts} попыток (${Math.round(100 * d.deaths / Math.max(1, d.attempts))} %); риск графа сейчас ${now.get(id) ? now.get(id)!.estimateRisk(ref(id)).toFixed(3) : '—'}`)
  if (out) writeFileSync(out, JSON.stringify({ generatedAt: fresh.generatedAt, sources: fresh.sourceDirectories, rows, models: fresh.models }, null, 1) + '\n')
}

const ATTRIB_S = 180
/** Death → the graph strategy last run in that file within ATTRIB_S game seconds (tactics finish what the interrupted skill started). */
export function attributeDeaths(dirs: string[]): Map<string, { deaths: number; attempts: number }> {
  const stats = new Map<string, { deaths: number; attempts: number }>()
  const get = (id: string) => { let s = stats.get(id); if (!s) stats.set(id, s = { deaths: 0, attempts: 0 }); return s }
  for (const dir of dirs) for (const file of readdirSync(dir).filter(f => f.endsWith('.skills.jsonl'))) {
    let last: { id: string; at: number } | null = null
    for (const line of readFileSync(resolve(dir, file), 'utf8').split(String.fromCharCode(10))) {
      if (!line.trim()) continue
      let r: any
      try { r = JSON.parse(line) } catch { continue }
      const at = Date.parse(r.at)
      const rate = Number(r.tickRate) || 20
      if (r.level === 'strategy' && r.strategy) { get(r.strategy).attempts++; last = { id: r.strategy, at }; if (r.after?.alive === false) { get(r.strategy).deaths++; last = null } continue }
      if (r.death === true && r.level === 'act') {
        // wall ms × tickRate/20 ≈ game ms on accelerated worlds
        const gameSec = last ? (at - last.at) / 1000 * rate / 20 : Infinity
        get(last && gameSec <= ATTRIB_S ? last.id : '(вне стратегии)').deaths++
        last = null
      }
    }
  }
  return stats
}

if (require.main === module) main(process.argv.slice(2))
