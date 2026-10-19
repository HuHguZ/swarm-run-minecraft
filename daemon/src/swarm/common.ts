// Рой (swarm.ts): мелкие общие функции и списки допустимых значений.
import type { SwarmPosition, SwarmMember, Doctrine, SwarmKind, ThreatKind, SwarmRole } from './types'

export const distance = (a: SwarmPosition, b: SwarmPosition) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
export const validPosition = (p: SwarmPosition) => p && [p.x, p.y, p.z].every(Number.isFinite)
export const position = (p: SwarmPosition): SwarmPosition => ({ x: p.x, y: p.y, z: p.z })
export const cellKey = (p: SwarmPosition) => `${p.x},${p.y},${p.z}`
export const ratio = (m: SwarmMember) => Math.min(1, Math.max(0, m.health / (m.maxHealth ?? 20)))
export const copy = <T>(value: T): T => structuredClone(value)
export const count = (items: Record<string, number> | undefined, item: string) => Math.max(0, Math.floor(items?.[item] || 0))
export function ownedCount(member: Pick<SwarmMember, 'inventory' | 'armor'>, item: string): number {
  return count(member.inventory, item) + (Array.isArray(member.armor) ? member.armor : Object.values(member.armor || {})).filter(name => name === item).length
}
export const doctrines: Doctrine[] = ['ring', 'line', 'buffalo', 'fountain', 'weak-center', 'cocoon', 'wave', 'hunt', 'false-weakness', 'false-retreat']
export const kinds: SwarmKind[] = ['fight', 'goto', 'heal', 'build', 'mine', 'scout', 'recover', 'transfer', 'flee', 'loot']
export const threats: ThreatKind[] = ['melee', 'bow', 'aerial', 'blast']
export const roles: SwarmRole[] = ['fighter', 'healer', 'ranged', 'flank', 'miner-builder']
export const sharpWeapon = (name?: string) => !!name && /_(sword|axe|spear)$/.test(name)
export const hasShield = (m: SwarmMember) => count(m.inventory, 'shield') > 0 || m.offHand === 'shield'
export const buildBlock = (m: SwarmMember) => Object.entries(m.inventory || {}).find(([n, c]) => /^(cobblestone|stone|dirt|sandstone|smooth_sandstone|netherrack|.*_planks)$/.test(n) && c > 0)?.[0]
