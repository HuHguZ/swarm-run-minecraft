export type Dimension = 'overworld' | 'the_nether' | 'the_end' | 'unknown'
export type FactSource = 'observed' | 'map' | 'inferred' | 'simulated'
export interface Position { x: number; y: number; z: number }
export type FactValue = boolean | string | number | Position
export interface Fact<T extends FactValue = FactValue> {
  status: 'known' | 'unknown'
  value: T | null
  source: FactSource
  at: number
  confidence: number
}
export interface WorldState {
  dimension: Dimension
  position: Position | null
  health: number
  hunger: number
  inventory: Record<string, number>
  resources: Record<string, number>
  facts: Record<string, Fact>
  elapsedMs: number
  structureSearchMs: number
  threatLevel: number
  revision: number
  /** Physical retry metadata, deliberately excluded from stateKey/usefulProgress. */
  retryContext?: string
  alive: boolean
}
export function fact<T extends FactValue>(value: T | null, source: FactSource, at: number, confidence = 1): Fact<T> {
  return { status: value === null ? 'unknown' : 'known', value, source, at, confidence: Math.max(0, Math.min(1, confidence)) }
}
export const knows = (state: WorldState, name: string): boolean => state.facts[name]?.status === 'known' && state.facts[name]?.value === true
export const unknown = (state: WorldState, name: string): boolean => !state.facts[name] || state.facts[name].status === 'unknown'
export const amount = (state: WorldState, resource: string): number => state.resources[resource] ?? 0
export function emptyWorld(): WorldState {
  return { dimension: 'overworld', position: null, health: 20, hunger: 20, inventory: {}, resources: {}, facts: {}, elapsedMs: 0,
    structureSearchMs: 0, threatLevel: 0, revision: 0, alive: true }
}
export function cloneWorld(state: WorldState): WorldState {
  return { ...state, position: state.position && { ...state.position }, inventory: { ...state.inventory }, resources: { ...state.resources },
    facts: Object.fromEntries(Object.entries(state.facts).map(([name, value]) => [name, { ...value }])) }
}
export interface Effect {
  inventory?: Record<string, number>
  resources?: Record<string, number>
  atLeast?: Record<string, number>
  facts?: Record<string, FactValue>
  dimension?: Dimension
  structureSearchMs?: number
  health?: number
  hunger?: number
}
export function applyEffect(state: WorldState, effect: Effect, source: FactSource = 'inferred'): WorldState {
  const next = cloneWorld(state)
  for (const [key, delta] of Object.entries(effect.inventory ?? {})) next.inventory[key] = Math.max(0, (next.inventory[key] ?? 0) + delta)
  for (const [key, delta] of Object.entries(effect.resources ?? {})) next.resources[key] = Math.max(0, amount(next, key) + delta)
  for (const [key, minimum] of Object.entries(effect.atLeast ?? {})) next.resources[key] = Math.max(amount(next, key), minimum)
  for (const [key, value] of Object.entries(effect.facts ?? {})) next.facts[key] = fact(value, source, next.elapsedMs)
  if (effect.dimension) next.dimension = effect.dimension
  if (effect.health !== undefined) next.health = effect.health
  if (effect.hunger !== undefined) next.hunger = effect.hunger
  if (effect.structureSearchMs) next.structureSearchMs += effect.structureSearchMs
  return next
}
export function stateKey(state: WorldState): string {
  const resources = Object.entries(state.resources).filter(([, value]) => value > 0).sort(([a], [b]) => a.localeCompare(b))
  const facts = Object.entries(state.facts).filter(([, value]) => value.status === 'known').sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, value.value])
  return JSON.stringify([state.dimension, resources, facts, Math.min(180000, state.structureSearchMs), state.alive, Math.min(20, state.health), Math.min(18, state.hunger)])
}
export function usefulProgress(before: WorldState, after: WorldState): boolean {
  return stateKey(before) !== stateKey(after) && (Object.entries(after.resources).some(([key, value]) => value > amount(before, key)) ||
    Object.entries(after.facts).some(([key, value]) => value.status === 'known' && JSON.stringify(value.value) !== JSON.stringify(before.facts[key]?.value)) ||
    before.dimension !== after.dimension || after.health > before.health || after.hunger > before.hunger)
}
