import type { CollisionBlock } from './geometry'
import { repoJson } from '../paths'
interface Rule { block: string; properties: Record<string, string>; distanceOffset: number; damageMultiplier: number; distanceMultiplier?: number; bounce?: number }
interface FallRules { version: string; safeFallDistance: number; epsilon: number; rules: Rule[]; bedRule: { suffix: string; distanceMultiplier: number; damageMultiplier: number; bounce: number } }
const rules = repoJson<FallRules>('daemon/data/landing-damage-1.21.11.json')
if (rules.version !== '1.21.11') throw new Error('landing damage mechanics require reviewed 1.21.11 data')
const bed: Rule = { block: '*_bed', properties: {}, distanceOffset: 0, ...rules.bedRule }
const ruleFor = (block: CollisionBlock): Rule | undefined => block.name.endsWith(rules.bedRule.suffix) ? bed
  : rules.rules.find(rule => rule.block === block.name && Object.entries(rule.properties).every(([key, value]) => String(block.getProperties?.()[key]) === value))
/** A floor that lowers fall damage and that native physics lands on like the server (no unmodelled bounce). */
export function hasFallMitigation(block: CollisionBlock): boolean {
  const rule = ruleFor(block)
  return !!rule && !rule.bounce && rule.damageMultiplier * (rule.distanceMultiplier ?? 1) < 1
}

// Native collision does not include the server's fallOn damage. State-specific
// server rules supplement it; geometry always remains the registry's shapes.
export function landingDamage(block: CollisionBlock, distance: number, attributes: Record<string, { value: number }> = {}): number {
  const rule = ruleFor(block)
  const safe = attributes['minecraft:safe_fall_distance']?.value ?? rules.safeFallDistance
  const multiplier = attributes['minecraft:fall_damage_multiplier']?.value ?? 1
  return Math.max(0, Math.floor((distance * (rule?.distanceMultiplier ?? 1) + (rule?.distanceOffset ?? 0) + rules.epsilon - safe) * Math.fround(rule?.damageMultiplier ?? 1) * multiplier))
}
