import { planConversion } from '../conversions/planner'
import { conversionRecipes } from '../conversions/registry'

const bread = conversionRecipes.find(recipe => recipe.id === 'bread')!
const wheat = conversionRecipes.find(recipe => recipe.id === 'wheat')!

export function carriedBread(inventory: Record<string, number>) {
  const grain = (inventory.wheat ?? 0) + (inventory.hay_block ?? 0) * wheat.result.count
  const count = Math.min(1024, Math.floor(grain / bread.ingredients.length) * bread.result.count)
  if (!count) return null
  const plan = planConversion(inventory, 'bread', count)
  return plan.ok ? { count, plan } : null
}
