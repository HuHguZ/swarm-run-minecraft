export interface ConsumeHands {
  main: string | null
  off: string | null
  safe: boolean
  grounded: boolean
  flightStable?: boolean
  diveActive?: boolean
  usingMain?: boolean
  clutchActive: boolean
  shieldNeeded: boolean
  totemNeeded: boolean
}

export function consumeHand(state: ConsumeHands): 'hand' | 'off-hand' | null {
  if (state.clutchActive || state.diveActive || state.usingMain || (!state.grounded && !state.flightStable)) return null
  if (!state.safe || state.shieldNeeded || state.totemNeeded) return 'hand'
  const passiveMain = state.main !== null && /_(sword|axe)$|^mace$|_spear$/.test(state.main)
  return passiveMain ? 'off-hand' : 'hand'
}
