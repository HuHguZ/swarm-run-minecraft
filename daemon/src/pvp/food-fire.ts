export const foodAnimals = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'])
export interface FoodIgnitionWindow {
  purpose: string | undefined
  animal: string
  remainingUses: number
  grounded: boolean
  visible: boolean
  burning: boolean
  selfSafe: boolean
  terrainSafe: boolean
}
export function foodIgnitionAllowed(window: FoodIgnitionWindow): boolean {
  return window.purpose === 'food' && foodAnimals.has(window.animal) && window.remainingUses > 4 &&
    window.grounded && window.visible && !window.burning && window.selfSafe && window.terrainSafe
}
