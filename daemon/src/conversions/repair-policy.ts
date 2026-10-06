export interface RepairItem {
  slot: number
  name: string
  maxDamage: number
  damage: number
  count: number
  enchanted: boolean
  modified?: boolean
}
export interface RepairPair { first: RepairItem; second: RepairItem; mechanism: 'craft' | 'anvil'; expectedDamage: number }

export function repairDamage(first: RepairItem, second: RepairItem): number {
  const maximum = Math.max(first.maxDamage, second.maxDamage)
  const remaining = first.maxDamage - first.damage + second.maxDamage - second.damage
  return Math.max(0, maximum - remaining - Math.floor(maximum * 5 / 100))
}

export function chooseRepairPair(items: RepairItem[], name?: string): RepairPair | null {
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const first = items[i], second = items[j]
    if (name && first.name !== name || first.name !== second.name || first.count !== 1 || second.count !== 1
      || first.maxDamage <= 0 || first.maxDamage !== second.maxDamage || first.damage <= 0 || second.damage <= 0) continue
    const enchanted = first.enchanted || second.enchanted
    if (!enchanted && (first.modified || second.modified)) continue
    if (!enchanted && first.maxDamage - first.damage + second.maxDamage - second.damage > first.maxDamage) continue
    const expectedDamage = repairDamage(first, second)
    if (expectedDamage >= Math.min(first.damage, second.damage)) continue
    return { first, second, mechanism: enchanted ? 'anvil' : 'craft', expectedDamage }
  }
  return null
}
