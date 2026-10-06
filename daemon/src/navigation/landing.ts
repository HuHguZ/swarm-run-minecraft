import type { CollisionBlock } from './geometry'
interface FallRules { version: string; safeFallDistance: number; epsilon: number; rules: Array<{ block: string; properties: Record<string, string>; distanceOffset: number; damageMultiplier: number }> }
const rules = require('../../data/landing-damage-1.21.11.json') as FallRules
if (rules.version !== '1.21.11') throw new Error('landing damage mechanics require reviewed 1.21.11 data')
const ruleFor = (block: CollisionBlock) => rules.rules.find(rule => rule.block === block.name && Object.entries(rule.properties).every(([key, value]) => String(block.getProperties?.()[key]) === value))
export function hasFallMitigation(block: CollisionBlock): boolean { return (ruleFor(block)?.damageMultiplier ?? 1) < 1 }

// Native collision does not include the server's fallOn damage. State-specific
// server rules supplement it; geometry always remains the registry's shapes.
export function landingDamage(block: CollisionBlock, distance: number, attributes: Record<string, { value: number }> = {}): number {
  const rule = ruleFor(block)
  const safe = attributes['minecraft:safe_fall_distance']?.value ?? rules.safeFallDistance
  const multiplier = attributes['minecraft:fall_damage_multiplier']?.value ?? 1
  return Math.max(0, Math.floor((distance + (rule?.distanceOffset ?? 0) + rules.epsilon - safe) * Math.fround(rule?.damageMultiplier ?? 1) * multiplier))
}
