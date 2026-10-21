import { candidates, piglinNiche, frWorth, burnRecovery, threatLevel, hasObservedTarget, canRepelLavaAttacker, deadEnd, type ActionId, type Candidate, type TacticalState } from './state'

export type TacticalNodeId = ActionId | 'Strategic' | 'EmergencyController'
export interface TacticalTransition {
  from: TacticalNodeId
  to: TacticalNodeId
  when(state: TacticalState): boolean
}

const actions: ActionId[] = ['Fight', 'LastStand', 'Flee', 'Heal', 'Eat', 'Shield', 'Dodge', 'CreateDistance', 'BlockOff', 'PillarUp', 'DigDown', 'EnterPortal', 'UseWater', 'Hide', 'FreeEmbedded', 'FlightEscape', 'PearlEscape', 'UseFireResistance', 'ClimbOut', 'WebBoatEscape', 'BoatLavaHop', 'Surface']
const refuge: ActionId[] = ['Flee', 'CreateDistance', 'BlockOff', 'PillarUp', 'DigDown', 'Hide', 'EnterPortal']
const edges: TacticalTransition[] = []
const edge = (from: TacticalNodeId, to: TacticalNodeId, when: TacticalTransition['when']) => edges.push({ from, to, when })
for (const action of actions) {
  for (const response of ['Fight', 'Flee', 'Surface', 'PillarUp'] as const) edge(action, response, state => state.polarBear?.action === response)
  edge('Strategic', action, state => candidates(state).some(candidate => candidate.id === action))
  edge(action, 'Strategic', state => threatLevel(state) === 0)
  edge(action, 'EmergencyController', state => state.dangerousFall || state.emergencyController)
  edge('EmergencyController', action, state => !state.dangerousFall && !state.emergencyController)
  edge(action, 'FreeEmbedded', state => !!state.embedded)
  edge(action, 'FlightEscape', state => (state.lava || !!state.lavaAhead) && !!state.flightEscape)
  edge(action, 'PearlEscape', state => (state.lava || !!state.lavaAhead) && !!state.pearlEscape)
  edge(action, 'WebBoatEscape', state => state.lava && !!state.webBoatEscape)
  edge(action, 'BoatLavaHop', state => state.lava && !!state.boatLavaHop)
  edge(action, 'UseFireResistance', state => frWorth(state) && !state.fireResistance && !!state.fireResistancePotion)
  edge(action, 'ClimbOut', state => (state.lava || !!state.lavaEscapePending) && state.fireResistance && !!state.lavaClimb)
  edge(action, 'LastStand', state => state.contact && deadEnd(state) && !state.lava && !state.lavaEscapePending && !state.dangerousFall && !state.embedded && !state.aerialCombat)
  for (const immediate of ['Dodge', 'UseWater'] as const) edge(action, immediate, state => immediate === 'Dodge' ? state.explosion : state.burning && state.water)
  edge(action, 'Surface', state => !!(state.drowning || state.waterEmergency))
  edge(action, 'Flee', state => !!state.hotFloor && !state.dangerousFall && !state.emergencyController)
  for (const shelter of refuge) edge(action, shelter, state => threatLevel(state) >= 2 && (!state.canFight || state.health < 12 || action === 'Fight' || shelter === 'BlockOff' && piglinNiche(state) || shelter === 'PillarUp' && !!state.netherHide || shelter === 'BlockOff' && !!state.ghastEdge))
  edge(action, 'Heal', state => state.cover && state.health < 16 && state.edible)
  edge(action, 'Eat', state => state.edible && (burnRecovery(state) || state.food < 16 && threatLevel(state) <= 1))
  edge(action, 'Shield', state => state.shield && (!!state.owGuard || state.incomingProjectiles > 0 || threatLevel(state) === 1))
  edge(action, 'Fight', state => canRepelLavaAttacker(state) || hasObservedTarget(state) && state.contact && state.canFight && state.health > 6 && !state.explosion)
}
edge('EmergencyController', 'Strategic', state => !state.dangerousFall && !state.emergencyController && threatLevel(state) === 0)
edge('EmergencyController', 'FreeEmbedded', state => !!state.embedded)
edge('EmergencyController', 'Surface', state => !!state.waterEmergency && !state.dangerousFall)

export class TacticalGraph {
  readonly transitions = edges

  candidates(state: TacticalState, current: TacticalNodeId = 'Strategic'): Candidate[] {
    return candidates(state).filter(candidate => candidate.id === current || this.canTransition(current, candidate.id, state))
  }

  canTransition(from: TacticalNodeId, to: TacticalNodeId, state: TacticalState): boolean {
    return from === to || this.transitions.some(edge => edge.from === from && edge.to === to && edge.when(state))
  }
}
