export type ThreatLevel = 0 | 1 | 2 | 3 | 4
export type ActionId = 'Fight' | 'LastStand' | 'Flee' | 'Heal' | 'Eat' | 'Shield' | 'Dodge' | 'CreateDistance' | 'BlockOff' | 'PillarUp' | 'DigDown' | 'EnterPortal' | 'UseWater' | 'Hide' | 'FreeEmbedded' | 'FlightEscape' | 'PearlEscape' | 'UseFireResistance' | 'ClimbOut' | 'WebBoatEscape' | 'BoatLavaHop'
export type ControlOwner = 'Skill' | 'Tactical' | 'Emergency'

export interface TacticalEnemy {
  id: number
  kind: string
  distance: number
  player: boolean
  threatening: boolean
}

export interface TacticalState {
  at: number
  health: number
  food: number
  armor: number
  weapon: boolean
  shield: boolean
  enemies: TacticalEnemy[]
  incomingProjectiles: number
  burning: boolean
  lava: boolean
  lavaAhead?: boolean
  fireResistance: boolean
  explosion: boolean
  dangerousFall: boolean
  emergencyController: boolean
  inWater: boolean
  cover: boolean
  portal: boolean
  escapeRoute: boolean
  blocks: number
  water: boolean
  edible: boolean
  canFight: boolean
  contact: boolean
  shelter: 'BlockOff' | 'PillarUp' | 'DigDown' | 'Hide' | null
  protectedEncounter: boolean
  embedded?: boolean
  airborne?: boolean
  aerialCombat?: boolean
  flightEscape?: boolean
  pearlEscape?: boolean
  fireResistancePotion?: boolean
  lavaClimb?: boolean
  lavaEscapePending?: boolean
  webBoatEscape?: boolean
  boatLavaHop?: boolean
  escapeExhausted?: boolean
  failedEscapes?: ActionId[]
}

export interface Candidate {
  id: ActionId
  score: number
  reason: string
}

export const hasObservedTarget = (state: TacticalState): boolean => state.enemies.some(enemy => enemy.threatening)
export const canRepelLavaAttacker = (state: TacticalState): boolean => state.health > 0 && state.fireResistance &&
  (state.lava || !!state.lavaEscapePending) && state.weapon && state.canFight && state.contact &&
  !state.embedded && !state.explosion && !state.dangerousFall && !state.emergencyController &&
  state.enemies.some(enemy => enemy.threatening && enemy.distance <= 3)

export function threatLevel(state: TacticalState): ThreatLevel {
  if (state.health <= 0) return 0
  if (state.embedded || state.emergencyController || state.dangerousFall || state.lavaAhead || state.lava && !state.fireResistance || state.explosion) return 4
  const foes = state.enemies.filter(enemy => enemy.threatening && enemy.distance <= 12)
  if (state.contact && (state.health <= 6 || foes.length >= 3 && state.health < 12)) return 3
  if (state.burning && !state.fireResistance && state.health <= 8) return 3
  if (state.lava || state.lavaEscapePending) return 2
  if (state.contact || state.incomingProjectiles > 0 || state.burning && !state.fireResistance) return 2
  if (foes.length) return 1
  return 0
}

export function candidates(state: TacticalState, level = threatLevel(state)): Candidate[] {
  if (level === 0) return []
  const result: Candidate[] = []
  const add = (id: ActionId, score: number, reason: string, available: boolean) => {
    if (available && !state.failedEscapes?.includes(id) && Number.isFinite(score)) result.push({ id, score, reason })
  }
  const critical = level >= 3
  const contact = state.contact
  const observedTarget = hasObservedTarget(state)
  const escapeExhausted = observedTarget && !!state.escapeExhausted
  add('FreeEmbedded', 180, 'solid block after teleport or suffocation', !!state.embedded)
  add('FlightEscape', 172, 'loaded safe landing with elytra and rockets', (state.lava || !!state.lavaAhead) && !!state.flightEscape)
  add('PearlEscape', 166, 'safe pearl landing and enough health', (state.lava || !!state.lavaAhead) && !!state.pearlEscape)
  add('WebBoatEscape', 160, 'cobweb, two wall supports and a boat', state.lava && !!state.webBoatEscape)
  add('UseFireResistance', 156, 'available fire resistance before climbing', (state.lava || state.burning) && !state.fireResistance && !!state.fireResistancePotion)
  add('BoatLavaHop', 154, 'existing expendable boats and a visible collision-free lava route', state.lava && !!state.boatLavaHop)
  add('ClimbOut', 140, 'fire resistant swimming or visible wall steps', (state.lava || !!state.lavaEscapePending) && state.fireResistance && !!state.lavaClimb)
  add('UseWater', 145, 'fire', state.water && state.burning && !state.fireResistance && !state.lava)
  add('Dodge', 150, 'explosion', state.explosion)
  add('EnterPortal', 115, 'nearby escape', critical && state.portal && !state.dangerousFall)
  add('LastStand', 155, 'observed escape attempts exhausted; defend until a new exit opens', level >= 2 && observedTarget && contact && escapeExhausted && !state.lava && !state.lavaEscapePending && !state.dangerousFall && !state.embedded && !state.aerialCombat)
  const repel = canRepelLavaAttacker(state)
  add('Fight', repel ? 157 : critical ? -100 : 90, repel ? 'repel a close attacker before resuming the fire resistant escape' : 'favorable fight', repel || level >= 2 && observedTarget && state.canFight && state.weapon && contact && !state.protectedEncounter && !state.lava && !state.lavaEscapePending && !escapeExhausted)
  add('Flee', critical ? 100 : 65, 'create safe distance', level >= 2 && state.escapeRoute && !state.dangerousFall && !state.aerialCombat && !state.lavaEscapePending && !escapeExhausted)
  add('CreateDistance', 85, 'unfavorable or unidentified attacker', level >= 2 && (!state.canFight || !observedTarget) && state.escapeRoute && !state.dangerousFall && !state.aerialCombat && !state.lavaEscapePending && !escapeExhausted)
  if (state.shelter) add(state.shelter, critical ? 120 : state.canFight ? 45 : 95, 'available refuge', level >= 2 && state.blocks > 0 && !state.dangerousFall && !state.aerialCombat && !state.lava && !state.lavaEscapePending && !escapeExhausted)
  add('Hide', 110, 'existing cover', critical && state.cover && !state.dangerousFall && !state.lava && !escapeExhausted)
  add('Shield', 80, 'incoming threat', state.shield && !state.dangerousFall && !state.aerialCombat && (level === 1 || state.incomingProjectiles > 0))
  add('Heal', 105, 'recover behind cover', state.cover && state.health < 16 && state.edible && !state.dangerousFall && !state.aerialCombat && !state.lava && !state.lavaEscapePending)
  add('Eat', 45, 'restore food', level <= 1 && state.food < 16 && state.edible && !state.dangerousFall)
  return result.sort((a, b) => b.score - a.score)
}
