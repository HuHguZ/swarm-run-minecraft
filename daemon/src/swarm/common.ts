// Рой (swarm.ts): мелкие общие функции и списки допустимых значений.
import type { SwarmPosition, SwarmMember, Doctrine, SwarmKind, ThreatKind, SwarmRole } from './types'

export const distance = (a: SwarmPosition, b: SwarmPosition) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
// The guard must be close to the ward, with its hitbox on the archer's line before the ward.
export function screensBow(guard: SwarmPosition, ward: SwarmPosition, archer: SwarmPosition): boolean {
  if (distance(guard, ward) > 3) return false
  const dx = ward.x - archer.x, dz = ward.z - archer.z
  const fraction = ((guard.x - archer.x) * dx + (guard.z - archer.z) * dz) / (dx * dx + dz * dz)
  if (!(fraction > 0 && fraction < 1)) return false
  const chestY = archer.y + 1.62 + (ward.y + 1.3 - archer.y - 1.62) * fraction
  return Math.hypot(guard.x - archer.x - dx * fraction, guard.z - archer.z - dz * fraction) <= .3 &&
    chestY >= guard.y && chestY <= guard.y + 1.8
}
/** One lateral shield step on the near side of the ward. The body checks the floor and the actual draw. */
export function bowScreenStep(guard: SwarmPosition, ward: SwarmPosition, archer: SwarmPosition): SwarmPosition | null {
  if (screensBow(guard, ward, archer)) return guard
  const dx = archer.x - ward.x, dz = archer.z - ward.z, length = Math.hypot(dx, dz)
  if (!length || distance(guard, ward) > 3) return null
  const ahead = ((guard.x - ward.x) * dx + (guard.z - ward.z) * dz) / length
  if (ahead < .6 || ahead >= length) return null
  const at = { x: ward.x + dx / length * ahead, y: guard.y, z: ward.z + dz / length * ahead }
  return distance(guard, at) <= 1.25 && screensBow(at, ward, archer) ? at : null
}
export const validPosition = (p: SwarmPosition) => p && [p.x, p.y, p.z].every(Number.isFinite)
export const assistTimeoutMs = (mode?: string) => mode === 'pickup' || mode === 'deny' ? 9000 : 5000
export const swarmHoldTimeoutMs = (p: { camp?: boolean; whileSmash?: string; whileDraw?: string }) =>
  p.camp === true ? 12000 : p.whileSmash || p.whileDraw ? 21000 : 5000
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
