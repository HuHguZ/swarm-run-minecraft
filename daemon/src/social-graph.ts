export type SocialSignal = 'crouch' | 'wave' | 'look' | 'jump' | 'victory'
export type SocialNode = 'Quiet' | 'Greeting' | 'Acknowledge' | 'Cautious' | 'Celebrate'
export interface SocialState {
  signal: SocialSignal
  mood: number
  affinity: number
  health: number
  threatLevel: number
  bodyBusy: boolean
  airborne: boolean
  interrupted: boolean
  distance: number
}
export interface SocialDecision { node: SocialNode; gesture: SocialSignal | null; reason: string; priority: 1 }

export const socialTransitions: Readonly<Record<SocialNode, readonly SocialNode[]>> = {
  Quiet: ['Greeting', 'Acknowledge', 'Cautious', 'Celebrate'],
  Greeting: ['Quiet', 'Cautious'], Acknowledge: ['Quiet', 'Cautious'],
  Cautious: ['Quiet', 'Greeting', 'Acknowledge'], Celebrate: ['Quiet', 'Cautious']
}

export function evaluateSocial(state: SocialState): SocialDecision {
  if (state.interrupted || state.bodyBusy || state.airborne || state.threatLevel > 0 || state.health <= 8) {
    return { node: 'Quiet', gesture: null, reason: 'body or safety takes priority', priority: 1 }
  }
  if (state.affinity < 35 || state.mood < 25) return { node: 'Cautious', gesture: 'look', reason: 'low trust or poor mood', priority: 1 }
  if (state.signal === 'victory') return { node: 'Celebrate', gesture: 'crouch', reason: 'fight ended safely', priority: 1 }
  if (state.signal === 'crouch' && state.distance <= 8) return { node: 'Greeting', gesture: 'crouch', reason: 'friendly greeting', priority: 1 }
  return { node: 'Acknowledge', gesture: state.signal, reason: 'acknowledge visible player', priority: 1 }
}
