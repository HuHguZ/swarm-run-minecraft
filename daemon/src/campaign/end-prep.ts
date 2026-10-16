import { planConversion, type ConversionPlan } from '../conversions/planner'
import { conversionRecipes } from '../conversions/registry'
import { SECONDS } from './structure-value'

// sh15: 11 successful craft RPCs, median 2.9 s, maximum 7.2 s; round the observed maximum up.
export const END_CRAFT_SECONDS = 8
export interface EndPrepOffer { item: string; count: number; cost: number; value: number; plan: ConversionPlan }
const bedItems = [...new Set(conversionRecipes.map(r => r.result.item).filter(item => /_bed$/.test(item)))]

export function endPrepOffers(inventory: Record<string, number>, beds = 5): EndPrepOffer[] {
  const offers: EndPrepOffer[] = []
  const carriedBeds = Object.entries(inventory).reduce((n, [item, count]) => n + (/_bed$/.test(item) ? count : 0), 0)
  const add = (item: string, missing: number, seconds: number) => {
    for (let count = missing; count > 0; count--) {
      const plan = planConversion(inventory, item, (inventory[item] ?? 0) + count)
      if (!plan.ok || plan.steps.some(step => step.mechanism !== 'craft')) continue
      const cost = plan.steps.reduce((n, step) => n + step.times * END_CRAFT_SECONDS, 0)
      const value = count * seconds
      if (cost < value) { offers.push({ item, count, cost, value, plan }); break }
    }
  }
  // shortcut: acquisition with no priced, observed source stays on the route; extend after native receipts.
  for (const item of bedItems) add(item, Math.max(0, beds - carriedBeds), SECONDS.bed)
  add('golden_apple', Math.max(0, 2 - (inventory.golden_apple ?? 0) - (inventory.enchanted_golden_apple ?? 0)), SECONDS.goldenApple)
  return offers.sort((a, b) => (b.value - b.cost) - (a.value - a.cost))
}
