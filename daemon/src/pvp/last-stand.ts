export interface FailedEscape {
  alive: boolean
  interrupted: boolean
  clear: boolean
  hazardous: boolean
  targetVisible: boolean
  targetReach: number
  moved: number
}
export function counterattackAfterFailedEscape(state: FailedEscape): boolean {
  return state.alive && !state.interrupted && !state.clear && !state.hazardous &&
    state.targetVisible && state.targetReach <= 6 && state.moved < 2
}
