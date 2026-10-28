import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { durationTicks, learnCosts, sampleKey, type CostSample, type CostModel } from '../../daemon/src/core/cost-model'
import { REPO_ROOT } from '../../daemon/src/paths'

interface SourceDirectory { directory: string; files: number; modifiedAt: string; sha256: string; legacyTps: number | null }
export interface CostDataset {
  schemaVersion: 1
  unit: 'gameTicks'
  generatedAt: string
  sourceDirectories: SourceDirectory[]
  records: number
  acceptedSamples: number
  skipped: number
  malformed: number
  models: CostModel[]
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

export function normalizeSkillSample(value: unknown, legacyTps?: number): CostSample | null {
  const row = record(value)
  const before = record(row.before)
  const after = record(row.after)
  // Graph strategy records carry the observed WorldState after the attempt: alive=false is a death, alive=true survival.
  const death = typeof row.death === 'boolean' ? row.death : row.level === 'strategy' && typeof after.alive === 'boolean' ? !after.alive : undefined
  const sample: CostSample = { strategy: string(row.strategy), skill: string(row.skill), stage: string(row.stage), kind: string(row.kind),
    level: string(row.level), ticks: number(row.ticks), sec: number(row.sec), seconds: number(row.seconds),
    clock: string(row.clock), tickRate: number(row.tickRate), outcome: string(row.outcome),
    ok: row.ok === true, death }
  const dim = string(before.dim) ?? string(before.dimension), hp = number(before.hp) ?? number(before.health)
  if (dim !== undefined || hp !== undefined) sample.before = { dim, hp }
  if (!sampleKey(sample)) return null
  const ticks = durationTicks(sample, legacyTps)
  if (ticks === null) return null
  // Graph strategy records: what the attempt changed in WorldState resources (calibrates PARTIAL progress in the simulator).
  const had = record(before.resources), has = record(after.resources)
  const gained = row.level === 'strategy' && Object.keys(has).length ? Object.fromEntries([...new Set([...Object.keys(had), ...Object.keys(has)])]
    .map(name => [name, (number(has[name]) ?? 0) - (number(had[name]) ?? 0)]).filter(([, delta]) => delta !== 0)) : undefined
  return { strategy: sample.strategy, skill: sample.skill, stage: sample.stage, kind: sample.kind, level: sample.level,
    ticks, ok: sample.ok, outcome: sample.outcome, death: sample.death, before: sample.before, ...(gained ? { gained } : {}) }
}

/** Graph strategy rows whose body died within `seconds` of game time after the attempt ended (sr27 graph: tactics interrupt the
 *  skill and the body dies in refuge/flee after it — the strategy row itself says alive, so mortality was undercounted). */
export function tacticalDeaths(rows: readonly unknown[], seconds = 180): Set<number> {
  const marked = new Set<number>()
  let last: { index: number; at: number; rate: number } | null = null
  rows.forEach((value, index) => {
    const row = record(value)
    const at = Date.parse(String(row.at))
    if (row.level === 'strategy') { last = Number.isFinite(at) && record(row.after).alive !== false ? { index, at, rate: number(row.tickRate) ?? 20 } : null; return }
    if (row.death !== true || !last) return
    // Wall time × target rate / 20 bounds game time from above on a lockstep world: only nearer deaths are attributed.
    if ((at - last.at) / 1000 * last.rate / 20 <= seconds) marked.add(last.index)
    last = null
  })
  return marked
}

function knownLegacyRate(directory: string): number | undefined {
  const filename = resolve(directory, 'batch.json')
  if (!existsSync(filename)) return undefined
  const batch = record(JSON.parse(readFileSync(filename, 'utf8')))
  const env = record(batch.env)
  const rate = env.TICK_RATE ?? env.ND_TICK_RATE ?? env.ND_TPS
  // These retained day05r batches ran before accelerated game clocks, at normal 20 TPS.
  return /^day05r-rt[1-9][ab]$/.test(basename(directory)) && rate === undefined ? 20 : undefined
}

export function collectCosts(directories: readonly string[], root = REPO_ROOT): CostDataset {
  const samples: CostSample[] = []
  const sourceDirectories: SourceDirectory[] = []
  let records = 0; let skipped = 0; let malformed = 0
  for (const directory of [...new Set(directories.map(path => resolve(path)))].sort()) {
    const legacyTps = knownLegacyRate(directory)
    const files = readdirSync(directory).filter(name => name.endsWith('.skills.jsonl')).sort()
    const hash = createHash('sha256')
    let modified = 0
    for (const file of files) {
      const filename = resolve(directory, file)
      const source = readFileSync(filename, 'utf8')
      hash.update(file).update('\0').update(source)
      modified = Math.max(modified, statSync(filename).mtimeMs)
      const rows: unknown[] = []
      for (const line of source.split(/\r?\n/)) {
        if (!line.trim()) continue
        records++
        try { rows.push(JSON.parse(line)) } catch { malformed++ }
      }
      const died = tacticalDeaths(rows)
      rows.forEach((value, index) => {
        const sample = normalizeSkillSample(value, legacyTps)
        if (sample && died.has(index)) sample.death = true
        if (sample) samples.push(sample)
        else skipped++
      })
    }
    sourceDirectories.push({ directory: relative(root, directory).replaceAll('\\', '/'), files: files.length,
      modifiedAt: new Date(modified).toISOString(), sha256: hash.digest('hex'), legacyTps: legacyTps ?? null })
  }
  return { schemaVersion: 1, unit: 'gameTicks', generatedAt: new Date().toISOString(), sourceDirectories,
    records, acceptedSamples: samples.length, skipped, malformed, models: learnCosts(samples).sort((a, b) => a.key.localeCompare(b.key)) }
}

function main(args: string[]): void {
  if (args.includes('--help')) {
    console.log('node dist/farm/analysis/strategy-costs.js [папки с *.skills.jsonl] [--out daemon/strategy-costs.json]\nБез папок: сохранённые day05r, граф-прогоны graph-ne-* и полные прогоны Ада s1-full* (раунд 06.10). Неизвестные wall-clock секунды и нулевые действия исключаются.')
    return
  }
  const root = REPO_ROOT
  let output = resolve(root, 'daemon/strategy-costs.json')
  const directories: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--out') { if (!args[i + 1]) throw new Error('--out needs a filename'); output = resolve(args[++i]!) }
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`)
    else directories.push(resolve(arg))
  }
  if (!directories.length) {
    const results = resolve(root, 'farm/results')
    // Legacy stage telemetry (day05r, 20 TPS) plus graph runs at 750 TPS: graph-ne-* and the natural Nether runs s1-full* (not
    // s1-post*: their kit is given by commands).
    directories.push(...readdirSync(results, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^(?:day05r-rt[1-9][ab]|graph-ne-.+|s1-full\d+)$/.test(entry.name)).map(entry => resolve(results, entry.name)))
  }
  if (!directories.length) throw new Error('No retained telemetry directories found')
  const dataset = collectCosts(directories, root)
  if (!dataset.acceptedSamples) throw new Error('No samples with a proven game duration')
  writeFileSync(output, JSON.stringify(dataset) + '\n')
  console.log(JSON.stringify({ output: relative(root, output), sources: dataset.sourceDirectories.length, records: dataset.records,
    acceptedSamples: dataset.acceptedSamples, models: dataset.models.length, malformed: dataset.malformed, unit: dataset.unit }))
}

if (require.main === module) main(process.argv.slice(2))
