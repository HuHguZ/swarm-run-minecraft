import type { Strategy, StrategyRegistry } from './strategy'
import type { WorldState } from './world-state'

export interface CostSample {
  strategy?: string; skill?: string; stage?: string; kind?: string; level?: string
  ticks?: number; sec?: number; seconds?: number; clock?: string; tickRate?: number
  ok?: boolean; outcome?: string; death?: boolean
  /** Legacy stage snapshots carry dim/hp; graph strategy records carry a WorldState with dimension/health. */
  before?: { dim?: string; hp?: number; dimension?: string; health?: number }
  /** Graph strategy records: WorldState resources after − before. */
  gained?: Record<string, number>
}
export interface CostModel { key: string; samples: number; successes: number; deaths: number; deathSamples?: number; medianTicks: number; p90Ticks: number; partials?: number; interrupts?: number
  /** Mean resource change of a PARTIAL attempt (graph records only): what partial progress really buys. */
  partialGain?: Record<string, number> }
export const mortalitySamples = (model: CostModel): number => model.deathSamples ?? (model.deaths > 0 ? model.samples : 0)
/** Laplace estimate of finishing in one attempt; a PARTIAL attempt counts as half a completion. */
export const successEstimate = (model: CostModel): number => (model.successes + 0.5 * (model.partials ?? 0) + 1) / (model.samples + 2)
export function durationTicks(sample: CostSample, legacyRate?: number): number | null {
  if (Number.isFinite(sample.ticks) && sample.ticks! > 0) return Math.round(sample.ticks!)
  const seconds = sample.sec ?? sample.seconds
  if (!Number.isFinite(seconds) || seconds! <= 0) return null
  const rate = sample.clock === 'game' ? 20 : sample.clock === 'wall' ? sample.tickRate : legacyRate
  return Number.isFinite(rate) && rate! > 0 ? Math.max(1, Math.round(seconds! * rate!)) : null
}
export function sampleKey(sample: CostSample): string | null {
  // A stage record named after a graph strategy (PascalCase) repeats that attempt's own strategy record: count it once.
  if (!sample.strategy && sample.level === 'stage' && /^[A-Z]/.test(sample.stage ?? '')) return null
  return sample.strategy ?? (sample.level === 'step' ? sample.kind : sample.level === 'stage' ? sample.stage : undefined) ?? null
}
function contextKey(key: string, state: NonNullable<CostSample['before']>): string {
  return `${key}@${state.dim ?? state.dimension ?? 'unknown'}@${(state.hp ?? state.health ?? 20) < 10 ? 'wounded' : 'healthy'}`
}
export function learnCosts(samples: Iterable<CostSample>, legacyRate?: number): CostModel[] {
  const groups = new Map<string, Array<{ ticks: number; success: boolean; partial: boolean; interrupted: boolean; death: boolean | undefined; gained?: Record<string, number> }>>()
  for (const sample of samples) {
    const key = sampleKey(sample)
    const ticks = durationTicks(sample, legacyRate)
    if (!key || ticks === null) continue
    for (const group of [key, ...(sample.before ? [contextKey(key, sample.before)] : [])]) {
      const rows = groups.get(group) ?? []
      rows.push({ ticks, success: !sample.death && (sample.ok === true || sample.outcome === 'SUCCESS'),
        partial: !sample.death && sample.outcome === 'PARTIAL', interrupted: !sample.death && sample.outcome === 'INTERRUPTED', death: sample.death, gained: sample.gained })
      groups.set(group, rows)
    }
  }
  return [...groups].map(([key, rows]) => {
    const successful = rows.filter(row => row.success)
    const partial = rows.filter(row => row.partial)
    const times = (successful.length ? successful : partial.length ? partial : rows).map(row => row.ticks).sort((a, b) => a - b)
    const measured = partial.filter(row => row.gained)
    const totals: Record<string, number> = {}
    for (const row of measured) for (const [name, delta] of Object.entries(row.gained!)) totals[name] = (totals[name] ?? 0) + delta
    const partialGain = Object.fromEntries(Object.entries(totals).map(([name, total]) => [name, Math.round(100 * total / measured.length) / 100]).filter(([, mean]) => mean !== 0))
    return { ...(measured.length ? { partialGain } : {}), key, samples: rows.length, successes: successful.length, partials: partial.length, interrupts: rows.filter(row => row.interrupted).length, deaths: rows.filter(row => row.death).length,
      deathSamples: rows.filter(row => typeof row.death === 'boolean').length,
      medianTicks: times[Math.floor((times.length - 1) / 2)]!, p90Ticks: times[Math.floor((times.length - 1) * 0.9)]! }
  })
}
const aliases: Record<string, string[]> = {
  AcquireWood: ['wood'], AcquireStoneTools: ['stone'], FindFood: ['food'], GetWater: ['water'],
  MineIron: ['iron'], VillageIron: ['village'], ShipwreckIron: ['ship'], TreasureIron: ['treasure'],
  LavaPoolPortal: ['castSky'], RuinedPortal: ['ruin'], EnterNether: ['enter', 'routeEnter'], PrepareNether: ['prep'],
  // No GetBlazeRods → 'nether': that legacy stage mixed empty Nether visits with rod farming (0 of 6 successes).
  BastionBarter: ['bastion'], HuntEndermen: ['pearls'], CraftEyes: ['eyes'],
  PrepareEnd: ['endkit'], FindStronghold: ['stronghold'], KillDragon: ['dragon'],
  MappedOverworldRoute: ['route'], MappedRouteEnter: ['routeEnter', 'enter']
}
export function modelFor(strategy: Strategy, state: WorldState, models: ReadonlyMap<string, CostModel>): CostModel | undefined {
  for (const key of [strategy.id, ...(aliases[strategy.id] ?? [])]) {
    for (const name of [contextKey(key, { dimension: state.dimension, health: state.health }), key]) {
      const model = models.get(name)
      if (model && model.samples >= 5 && model.medianTicks > 0) return model
    }
  }
  return undefined
}
export function applyCosts(registry: StrategyRegistry, entries: CostModel[]): void {
  const models = new Map(entries.map(model => [model.key, model]))
  for (const strategy of registry.all()) {
    const estimate = strategy.estimateCost
    const risk = strategy.estimateRisk
    if (!strategy.modelCost) strategy.estimateCost = state => {
      const model = modelFor(strategy, state, models)
      if (!model) return estimate(state)
      // Travel to a known target is state-specific and stays outside the blend with the measured median.
      const travel = strategy.travelTicks?.(state) ?? 0
      const weight = model.samples / (model.samples + 5)
      return weight * model.medianTicks / Math.max(0.1, successEstimate(model)) + (1 - weight) * (estimate(state) - travel) + travel
    }
    strategy.estimateRisk = state => {
      const model = modelFor(strategy, state, models)
      return model ? (model.deaths + 5 * risk(state)) / (mortalitySamples(model) + 5) : risk(state)
    }
  }
}
