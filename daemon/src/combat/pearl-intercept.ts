export interface PearlVector { x: number; y: number; z: number }
export interface ObservedPearl {
  id: number
  ownerId: number
  position: PearlVector
  velocity: PearlVector
  observedAt: number
  visible: boolean
  alive: boolean
}
export interface PearlCollision { point: PearlVector }
export interface PearlPrediction {
  id: number
  ownerId: number
  teleport: PearlVector
  impact: PearlVector
  ticks: number
  observedAt: number
}
export interface PearlWorld {
  trace(from: PearlVector, to: PearlVector): PearlCollision | 'unloaded' | null
}
export function predictPearl(observed: ObservedPearl, world: PearlWorld, now: number, maxTicks = 100): PearlPrediction | null {
  if (!observed.visible || !observed.alive || now - observed.observedAt > 1500 || now < observed.observedAt) return null
  const coordinates = [...Object.values(observed.position), ...Object.values(observed.velocity)]
  if (coordinates.some(value => !Number.isFinite(value))) return null
  let position = { ...observed.position }
  let velocity = { ...observed.velocity }
  for (let tick = 1; tick <= maxTicks; tick++) {
    velocity = { x: velocity.x * 0.99, y: (velocity.y - 0.03) * 0.99, z: velocity.z * 0.99 }
    const next = { x: position.x + velocity.x, y: position.y + velocity.y, z: position.z + velocity.z }
    if (next.y < -64) return null
    const collision = world.trace(position, next)
    if (collision === 'unloaded') return null
    if (collision) return { id: observed.id, ownerId: observed.ownerId, teleport: position,
      impact: collision.point, ticks: tick, observedAt: observed.observedAt }
    position = next
  }
  return null
}

export type PearlResponseNode = 'PearlIntercept' | 'CounterPearl' | 'TrapArrival' | 'Wait'
export interface PearlResponseState {
  position: PearlVector
  health: number
  pearlDamage: number
  pearls: number
  cobwebs: number
  interrupted: boolean
  safeArrival: boolean
  occupied: boolean
  routeClear: boolean
  walkingBlocksPerTick: number
}
export interface PearlResponsePlan { kind: PearlResponseNode; prediction: PearlPrediction; at: PearlVector; reason: string }
export function planPearlResponse(prediction: PearlPrediction | null, state: PearlResponseState): PearlResponsePlan | null {
  if (!prediction || state.interrupted || state.health <= 8 || !state.safeArrival || state.occupied) return null
  const at = prediction.teleport
  const distance = Math.hypot(at.x - state.position.x, at.y - state.position.y, at.z - state.position.z)
  if (state.cobwebs > 0 && distance <= 4 && prediction.ticks >= 4) {
    return { kind: 'TrapArrival', prediction, at, reason: 'visible arrival within placement reach' }
  }
  if (state.routeClear && distance / Math.max(0.01, state.walkingBlocksPerTick) < prediction.ticks - 2) {
    return { kind: 'PearlIntercept', prediction, at, reason: 'can reach visible arrival before teleport' }
  }
  if (state.pearls > 0 && state.health > state.pearlDamage + 8 && distance > 5 && prediction.ticks > 8) {
    return { kind: 'CounterPearl', prediction, at, reason: 'safe counter pearl towards observed arrival' }
  }
  return null
}

export interface PearlHeightOption {
  impact: PearlVector
  teleport: PearlVector
  enemy: PearlVector
  visible: boolean
  loaded: boolean
  bodyClear: boolean
  exitClear: boolean
  safeRecovery: boolean
  health: number
  pearlDamage: number
  hasPearl: boolean
  hasWeapon: boolean
  interrupted: boolean
}
export type PearlHeightPhase = 'PearlGainHeight' | 'ConfirmTeleport' | 'DiveStrike' | 'Recover'
export const pearlHeightTransitions: Readonly<Record<PearlHeightPhase, readonly PearlHeightPhase[]>> = {
  PearlGainHeight: ['ConfirmTeleport', 'Recover'], ConfirmTeleport: ['DiveStrike', 'Recover'],
  DiveStrike: ['Recover'], Recover: []
}
export function pearlHeightWorth(option: PearlHeightOption): boolean {
  const height = option.teleport.y - option.enemy.y
  const horizontal = Math.hypot(option.teleport.x - option.enemy.x, option.teleport.z - option.enemy.z)
  return !option.interrupted && option.hasPearl && option.hasWeapon && option.visible && option.loaded
    && option.bodyClear && option.exitClear && option.safeRecovery && option.health > option.pearlDamage + 8
    && height >= 4 && height <= 12 && horizontal <= 4
}
