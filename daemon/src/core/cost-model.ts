import type { Strategy, StrategyRegistry } from './strategy'
import type { WorldState } from './world-state'

export interface CostSample {
  strategy?: string; skill?: string; stage?: string; kind?: string; level?: string
  ticks?: number; sec?: number; seconds?: number; clock?: string; tickRate?: number
  ok?: boolean; outcome?: string; death?: boolean
  before?: { dim?: string; hp?: number }
}
export interface CostModel { key: string; samples: number; successes: number; deaths: number; deathSamples?: number; medianTicks: number; p90Ticks: number }
export const mortalitySamples = (model: CostModel): number => model.deathSamples ?? (model.deaths > 0 ? model.samples : 0)
export function durationTicks(sample: CostSample, legacyRate?: number): number | null {
  if (Number.isFinite(sample.ticks) && sample.ticks! > 0) return Math.round(sample.ticks!)
  const seconds = sample.sec ?? sample.seconds
  if (!Number.isFinite(seconds) || seconds! <= 0) return null
  const rate = sample.clock === 'game' ? 20 : sample.clock === 'wall' ? sample.tickRate : legacyRate
  return Number.isFinite(rate) && rate! > 0 ? Math.max(1, Math.round(seconds! * rate!)) : null
}
export function sampleKey(sample: CostSample): string | null {
  return sample.strategy ?? (sample.level === 'step' ? sample.kind : sample.level === 'stage' ? sample.stage : undefined) ?? null
}
function contextKey(key: string, state: { dim?: string; hp?: number }): string {
  return `${key}@${state.dim ?? 'unknown'}@${(state.hp ?? 20) < 10 ? 'wounded' : 'healthy'}`
}
export function learnCosts(samples: Iterable<CostSample>, legacyRate?: number): CostModel[] {
  const groups = new Map<string, Array<{ ticks: number; success: boolean; death: boolean | undefined }>>()
  for (const sample of samples) {
    const key = sampleKey(sample)
    const ticks = durationTicks(sample, legacyRate)
    if (!key || ticks === null) continue
    for (const group of [key, ...(sample.before ? [contextKey(key, sample.before)] : [])]) {
      const rows = groups.get(group) ?? []
      rows.push({ ticks, success: !sample.death && (sample.ok === true || sample.outcome === 'SUCCESS'), death: sample.death })
      groups.set(group, rows)
    }
  }
  return [...groups].map(([key, rows]) => {
    const successful = rows.filter(row => row.success)
    const times = (successful.length ? successful : rows).map(row => row.ticks).sort((a, b) => a - b)
    return { key, samples: rows.length, successes: successful.length, deaths: rows.filter(row => row.death).length,
      deathSamples: rows.filter(row => typeof row.death === 'boolean').length,
      medianTicks: times[Math.floor((times.length - 1) / 2)]!, p90Ticks: times[Math.floor((times.length - 1) * 0.9)]! }
  })
}
const aliases: Record<string, string[]> = {
  AcquireWood: ['wood'], AcquireStoneTools: ['stone'], FindFood: ['food'], GetWater: ['water'],
  MineIron: ['iron'], VillageIron: ['village'], ShipwreckIron: ['ship'], TreasureIron: ['treasure'],
  LavaPoolPortal: ['castSky'], RuinedPortal: ['ruin'], EnterNether: ['enter', 'routeEnter'], PrepareNether: ['prep'],
  BastionBarter: ['bastion'], HuntEndermen: ['pearls'], GetBlazeRods: ['nether'], CraftEyes: ['eyes'],
  PrepareEnd: ['endkit'], FindStronghold: ['stronghold'], KillDragon: ['dragon'],
  MappedOverworldRoute: ['route'], MappedRouteEnter: ['routeEnter', 'enter']
}
export function modelFor(strategy: Strategy, state: WorldState, models: ReadonlyMap<string, CostModel>): CostModel | undefined {
  for (const key of [strategy.id, ...(aliases[strategy.id] ?? [])]) {
    for (const name of [contextKey(key, { dim: state.dimension, hp: state.health }), key]) {
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
    strategy.estimateCost = state => {
      const model = modelFor(strategy, state, models)
      if (!model) return estimate(state)
      const success = (model.successes + 1) / (model.samples + 2)
      const weight = model.samples / (model.samples + 5)
      return weight * model.medianTicks / Math.max(0.1, success) + (1 - weight) * estimate(state)
    }
    strategy.estimateRisk = state => {
      const model = modelFor(strategy, state, models)
      return model ? (model.deaths + 5 * risk(state)) / (mortalitySamples(model) + 5) : risk(state)
    }
  }
}
