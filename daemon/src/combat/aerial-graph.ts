export interface AerialVector { x: number; y: number; z: number }
export interface AerialActor {
  id: number
  position: AerialVector
  velocity: AerialVector
  flying: boolean
  grounded: boolean
  alive: boolean
}
export interface AerialState {
  self: AerialActor
  target: AerialActor | null
  health: number
  interrupted: boolean
  safeLanding: AerialVector | null
  corridorClear: boolean
  equipment: { elytra: boolean; chestplate: boolean; rockets: number; pearls: number; mace: boolean; spear: boolean; ranged?: boolean }
  rangedReady?: boolean
  maceReady: boolean
  spearReady: boolean
  fallDistance: number
  pearlDamage: number
}
export type AerialNode = 'Ground' | 'Interrupted' | 'AerialIntercept' | 'RangedVolley' | 'DiveStrike' | 'SpearStrike' | 'PearlReposition' | 'SafeLanding'
export interface AerialCandidate { id: AerialNode; cost: number; reason: string; target: AerialVector }
export interface AerialDecision { node: AerialNode; candidates: AerialCandidate[]; selected?: AerialCandidate }

export const aerialTransitions: Readonly<Record<AerialNode, readonly AerialNode[]>> = {
  Ground: ['AerialIntercept'],
  AerialIntercept: ['RangedVolley', 'DiveStrike', 'SpearStrike', 'PearlReposition', 'SafeLanding', 'Interrupted'],
  RangedVolley: ['AerialIntercept', 'SafeLanding', 'Interrupted'],
  DiveStrike: ['AerialIntercept', 'SafeLanding', 'Interrupted'],
  SpearStrike: ['AerialIntercept', 'SafeLanding', 'Interrupted'],
  PearlReposition: ['Ground', 'AerialIntercept', 'Interrupted'],
  SafeLanding: ['Ground', 'Interrupted'],
  Interrupted: ['Ground', 'AerialIntercept']
}

export function interceptPoint(self: AerialActor, target: AerialActor, maxLeadTicks = 12): AerialVector {
  const distance = Math.hypot(target.position.x - self.position.x, target.position.y - self.position.y, target.position.z - self.position.z)
  const relative = Math.hypot(self.velocity.x - target.velocity.x, self.velocity.y - target.velocity.y, self.velocity.z - target.velocity.z)
  const ticks = Math.min(maxLeadTicks, distance / Math.max(0.25, relative))
  return { x: target.position.x + target.velocity.x * ticks, y: target.position.y + target.velocity.y * ticks, z: target.position.z + target.velocity.z * ticks }
}

export function evaluateAerial(state: AerialState): AerialDecision {
  if (state.interrupted || !state.self.alive) return { node: 'Interrupted', candidates: [] }
  const { self, target, equipment, safeLanding } = state
  if (!target?.alive) return safeLanding && self.flying ? { node: 'SafeLanding', candidates: [{ id: 'SafeLanding', cost: 1, reason: 'target lost', target: safeLanding }], selected: { id: 'SafeLanding', cost: 1, reason: 'target lost', target: safeLanding } } : { node: 'Ground', candidates: [] }
  if (!self.flying && !target.flying) return { node: 'Ground', candidates: [] }
  const candidates: AerialCandidate[] = []
  if (self.flying && safeLanding) candidates.push({ id: 'SafeLanding', cost: state.health <= 8 ? 1 : 10, reason: 'confirmed landing', target: safeLanding })
  if (safeLanding && state.corridorClear && state.health > 8) {
    const at = interceptPoint(self, target)
    const distance = Math.hypot(target.position.x - self.position.x, target.position.y - self.position.y, target.position.z - self.position.z)
    const height = self.position.y - target.position.y
    if (self.flying && equipment.ranged && state.rangedReady && distance >= 8 && distance <= 48) candidates.push({ id: 'RangedVolley', cost: 3 + distance / 50, reason: 'clear airborne firing corridor', target: at })
    if (equipment.elytra && equipment.rockets > 0) candidates.push({ id: 'AerialIntercept', cost: 5 + distance / 20, reason: 'moving airborne target', target: at })
    if (self.flying && equipment.spear && state.spearReady && distance <= 6) candidates.push({ id: 'SpearStrike', cost: 2, reason: 'airborne spear window', target: at })
    if (self.flying && equipment.mace && equipment.chestplate && state.maceReady && height > 2 && self.velocity.y < -0.45 && state.fallDistance > 1.5 && distance < 6) candidates.push({ id: 'DiveStrike', cost: 1, reason: 'charged descent above target', target: at })
    if (self.flying && equipment.pearls > 0 && state.health > state.pearlDamage + 8 && distance > 24) candidates.push({ id: 'PearlReposition', cost: 2 + state.pearlDamage / 2, reason: 'safe midflight reposition', target: safeLanding })
  }
  candidates.sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id))
  return { node: candidates[0]?.id ?? (self.flying ? 'AerialIntercept' : 'Ground'), candidates, selected: candidates[0] }
}
