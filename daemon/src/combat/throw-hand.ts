export interface ThrowHandState {
  item: string
  mainItem: string | null
  usingItem: boolean
  preferOffhand: boolean
}
export function throwHand(state: ThrowHandState): 'hand' | 'off-hand' {
  const weapon = !!state.mainItem && /(?:_sword|_axe|_spear)$|^mace$/.test(state.mainItem)
  return state.preferOffhand && weapon && !state.usingItem
    && /^(ender_pearl|snowball|egg|splash_potion|lingering_potion)$/.test(state.item) ? 'off-hand' : 'hand'
}
