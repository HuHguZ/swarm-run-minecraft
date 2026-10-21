import type { Environment, EnvironmentEvent, ExecutionResult, SkillCommand } from '../core/environment'
import { emptyWorld, fact, type Dimension, type Fact, type Position, type WorldState } from '../core/world-state'
import { foodUnits, foodPoints } from '../play-policy'
import { overworldPauseCause } from '../campaign/overworld-pause'

export interface Observation {
  state: Record<string, unknown>
  situation?: Record<string, unknown>
  known?: Record<string, unknown>
  map?: Record<string, unknown> | null
  facts?: Record<string, Fact>
  structureSearchMs?: number
  elapsedMs?: number
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const numeric = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
function position(value: unknown): Position | null {
  const p = record(value)
  return typeof p.x === 'number' && typeof p.z === 'number' ? { x: p.x, y: numeric(p.y, 64), z: p.z } : null
}
export function worldFromObservation(observation: Observation, now: number): WorldState {
  const result = emptyWorld()
  const raw = observation.state
  const situation = observation.situation ?? {}
  const known = observation.known ?? {}
  const inventory = record(raw.inventory)
  result.inventory = Object.fromEntries(Object.entries(inventory).filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) as Record<string, number>
  const count = (pattern: RegExp): number => Object.entries(result.inventory).reduce((n, [name, quantity]) => n + (pattern.test(name) ? quantity : 0), 0)
  result.dimension = ['overworld', 'the_nether', 'the_end'].includes(String(raw.dimension)) ? raw.dimension as Dimension : 'unknown'
  result.position = position(raw.pos)
  result.health = numeric(raw.health, 20)
  result.hunger = numeric(raw.food, 20)
  result.elapsedMs = observation.elapsedMs ?? now
  result.structureSearchMs = observation.structureSearchMs ?? 0
  const tactics = record(raw.tactics)
  result.threatLevel = numeric(tactics.threatLevel)
  result.revision = numeric(raw.replanRevision, numeric(tactics.replanRevision))
  if (process.env.ND_OW_PAUSE_CAUSE === '1' && result.dimension === 'overworld') result.retryContext = overworldPauseCause(observation)
  result.alive = result.health > 0 && raw.alive !== false
  result.resources = {
    wood: count(/_(log|stem|planks)$/), stone_tool: count(/^(stone|iron|diamond|netherite)_pickaxe$/),
    iron: count(/^iron_ingot$/) + count(/^iron_block$/) * 9 + Math.floor(count(/^iron_nugget$/) / 9),
    raw_iron: count(/^raw_iron$/),
    iron_pick: count(/^(iron|diamond|netherite)_pickaxe$/), diamond_pick: count(/^(diamond|netherite)_pickaxe$/),
    food: foodUnits(result.inventory), food_points: foodPoints(result.inventory),
    bucket: count(/^(bucket|water_bucket|lava_bucket)$/), water: count(/^water_bucket$/), lighter: count(/^(flint_and_steel|fire_charge)$/),
    obsidian: count(/^obsidian$/), beds: count(/_bed$/), pearls: count(/^ender_pearl$/), rods: count(/^blaze_rod$/),
    // Очи, уже вставленные в рамки найденной комнаты, — тоже очи (S5e 07.10: после частичной вставки граф по «у тела 7 из 12» уводил
    // в Ад за очами из крепости, s5e-G-1).
    powder: count(/^blaze_powder$/), eyes: count(/^ender_eye$/) + (known.endPortal && Number.isFinite(Number(known.portalEyes)) ? Number(known.portalEyes) : 0), gold: count(/^gold_ingot$/) + count(/^gold_block$/) * 9,
    blocks: count(/^(cobblestone|cobbled_deepslate|stone|deepslate|netherrack|blackstone|dirt|end_stone|[a-z_]+_planks)$/),
    shield: count(/^shield$/) + (/shield/.test(JSON.stringify(raw.offHand)) ? 1 : 0)
  }
  result.facts = { ...observation.facts }
  for (const [name, key] of [['portal', 'portal'], ['lava', 'lava'], ['fortress', 'fortress'], ['stronghold', 'stronghold'], ['end_portal', 'endPortal'], ['dragon_dead', 'dragonWon']] as const) {
    if (known[key] !== null && known[key] !== undefined) result.facts[name] = fact(Boolean(known[key]), 'observed', now)
    else if (!result.facts[name]) result.facts[name] = fact(null, 'observed', now, 0)
    const at = position(known[key])
    if (at) result.facts[`${name}_position`] = fact(at, 'observed', now)
  }
  if (result.dimension === 'the_nether' || result.dimension === 'the_end') result.facts.entered_nether = fact(true, 'observed', now)
  const map = observation.map ?? {}
  for (const [name, key] of [['village', 'village'], ['shipwreck', 'ship'], ['treasure', 'treasure'], ['ruined_portal', 'rp'], ['lava', 'lava']] as const) {
    const at = position(map[key])
    if (at) {
      result.facts[name] = fact(true, 'map', now)
      result.facts[`${name}_position`] = fact(at, 'map', now)
    } else if (Object.prototype.hasOwnProperty.call(map, key)) result.facts[name] = fact(false, 'map', now)
  }
  const bastion = known.bastion || (Array.isArray(known.bastions) ? known.bastions[0] : null)
  if (bastion) result.facts.bastion = fact(true, 'observed', now)
  if (known.bastionsExhausted !== undefined) result.facts.bastions_exhausted = fact(Boolean(known.bastionsExhausted), 'observed', now)
  if (situation.night !== undefined) result.facts.night = fact(Boolean(situation.night), 'observed', now)
  return result
}
export interface RpcResult {
  status?: string; code?: string; error?: string; partial?: boolean
  detail?: Record<string, unknown>; state?: Record<string, unknown>; events?: EnvironmentEvent[]; by?: EnvironmentEvent
}
export function executionFromRpc(input: unknown): ExecutionResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Malformed environment result')
  const result = input as RpcResult
  if (result.status && !['done', 'failed', 'interrupted', 'timeout', 'partial', 'stopped', 'running'].includes(result.status)) throw new Error(`Unknown RPC status: ${result.status}`)
  const events = [...(result.by ? [result.by] : []), ...(Array.isArray(result.events) ? result.events : [])]
  return { outcome: events.some(e => e.type === 'death') ? 'FAILURE' : result.status === 'interrupted' ? 'INTERRUPTED' :
    result.status === 'timeout' ? 'TIMEOUT' : result.partial || result.status === 'partial' ? 'PARTIAL' : result.status === 'done' ? 'SUCCESS' : 'FAILURE',
    reason: result.error ?? result.code, detail: result.detail, events }
}
export interface MineflayerEnvironmentOptions {
  read(): Promise<Observation>
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  executeSkill?(command: SkillCommand, signal: AbortSignal): Promise<ExecutionResult>
  now(): number
  sleep(milliseconds: number): Promise<void>
}
export class MineflayerEnvironment implements Environment {
  constructor(private readonly options: MineflayerEnvironmentOptions) {}
  async observe(): Promise<WorldState> { return worldFromObservation(await this.options.read(), this.now()) }
  async execute(command: SkillCommand, signal: AbortSignal): Promise<ExecutionResult> {
    if (signal.aborted) return { outcome: 'INTERRUPTED', reason: String(signal.reason), events: [] }
    const cancel = () => { void this.cancel(String(signal.reason)).catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    try { return this.options.executeSkill ? await this.options.executeSkill(command, signal) : executionFromRpc(await this.options.call(command.skill, command.params ?? {})) }
    finally { signal.removeEventListener('abort', cancel) }
  }
  async cancel(reason: string): Promise<void> { await this.options.call('stop', { reason }) }
  now(): number { return this.options.now() }
  sleep(milliseconds: number): Promise<void> { return this.options.sleep(milliseconds) }
}
