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
export function landingDamage(block: CollisionBlock, distance: number, attributes: Record<string, { value: number }> = {}, distanceCap = Infinity): number {
  const rule = ruleFor(block)
  const safe = attributes['minecraft:safe_fall_distance']?.value ?? rules.safeFallDistance
  const multiplier = attributes['minecraft:fall_damage_multiplier']?.value ?? 1
  const fallOn = distance * (rule?.distanceMultiplier ?? 1) + (rule?.distanceOffset ?? 0)
  return Math.max(0, Math.floor((Math.min(fallOn, distanceCap) + rules.epsilon - safe) * Math.fround(rule?.damageMultiplier ?? 1) * multiplier))
}

interface WindFallView {
  /** Fair view order: main hand, off hand, boots, leggings, chest, helmet. */
  equipment: ReadonlyArray<{ name: string; enchanted?: boolean } | null>
  unknownArmorSlots: number
  gliding?: boolean
  ordinaryFall?: boolean
}

/** Public damage bounds at a known support, with a distance cap for a predicted wind impact. */
export function windFallDamage(block: CollisionBlock | null, fallDistance: number, landingY: number, impactFeetY: number | undefined, view: WindFallView) {
  if (!block || fallDistance < 0 || ![fallDistance, landingY].every(Number.isFinite) ||
      impactFeetY !== undefined && !Number.isFinite(impactFeetY)) return null
  // Player.causeFallDamage caps the surface's supplied distance at the victim's impulse height.
  const upper = landingDamage(block, fallDistance, {}, impactFeetY === undefined ? Infinity : impactFeetY - landingY)
  const { equipment, unknownArmorSlots, gliding, ordinaryFall } = view
  const unknown = Number.isSafeInteger(unknownArmorSlots) ? Math.min(4, Math.max(0, unknownArmorSlots)) : 4
  const boots = equipment[2], chest = equipment[4]
  const mayGlide = gliding || chest?.name === 'elytra' || !chest && unknown > 0
  const protection = 4 * (unknown + equipment.slice(2, 6).filter(item => item && item.enchanted !== false).length)
  const featherFalling = (boots ? boots.enchanted !== false : unknown > 0) ? 12 : 0
  const epf = Math.min(20, protection + featherFalling)
  const lower = ordinaryFall && !mayGlide ? Math.fround(upper * Math.fround(1 - Math.fround(epf / 25))) : 0
  const visibleTotem = equipment.slice(0, 2).some(item => item?.name === 'totem_of_undying')
  return { lower, upper, visibleTotem }
}
