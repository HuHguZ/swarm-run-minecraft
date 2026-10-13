import { amount, type WorldState, type Position } from '../core/world-state'

export interface NetherCompletion {
  reachedEnd: boolean
  health: number
  deaths: number
}

export function deathFreeEnd(result: NetherCompletion): boolean {
  return result.reachedEnd && result.health > 0 && result.deaths === 0
}

// Nether PASS (раунд 06.10): жемчуг и стержни на очи в рюкзаке, тело живо и без смертей вернулось в верхний мир.
// Готовые очи считаются и жемчугом, и половиной стержня (око = жемчуг + порошок, стержень = 2 порошка).
export function netherGoalMet(inventory: Record<string, number>, eyesNeed: number): boolean {
  const n = (name: string) => Number(inventory[name]) || 0
  return n('ender_pearl') + n('ender_eye') >= eyesNeed && 2 * n('blaze_rod') + n('blaze_powder') + n('ender_eye') >= eyesNeed
}

export function netherPass(result: { dimension: string | null; health: number; deaths: number; inventory: Record<string, number>; eyesNeed: number }): boolean {
  return result.dimension === 'overworld' && result.health > 0 && result.deaths === 0 && netherGoalMet(result.inventory, result.eyesNeed)
}

export interface BastionMetric { key: string; blocks: number; ingots: number }

export function bastionMetrics(text: string): BastionMetric[] {
  return [...text.matchAll(/(бастион[^:\n]*\(ад\)): золотых блоков (\d+), слитков пиглинам (\d+)/g)]
    .map(match => ({ key: match[1], blocks: Number(match[2]), ingots: Number(match[3]) }))
}

export function explicitBarterMetrics(samples: Iterable<unknown>): BastionMetric[] {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  const seen = new Set<string>()
  const result: BastionMetric[] = []
  for (const sample of samples) {
    const row = record(sample)
    if (row.level !== 'act' || row.skill !== 'bastion' || row.status !== 'done' || row.death !== false || typeof row.run !== 'string' || !Number.isInteger(row.seq)) continue
    const id = `${row.run}:${row.seq}`
    if (seen.has(id)) continue
    seen.add(id)
    let params: Record<string, unknown> = {}
    try { params = record(typeof row.params === 'string' ? JSON.parse(row.params) : row.params) } catch {}
    if ((row.barterMode ?? params.mode) !== 'barter') continue
    const before = record(row.before); const after = record(row.after)
    if (before.dim !== 'the_nether' || after.dim !== 'the_nether' || number(after.hp) <= 0) continue
    const gold = (state: Record<string, unknown>) => {
      const resources = record(state.res)
      return number(resources.gold) + 9 * number(resources.goldBlocks)
    }
    const spent = gold(before) - gold(after)
    if (spent <= 0) continue
    const site = record(row.barterSite)
    result.push({ key: `PiglinBarter@${site.x ?? params.x ?? '?'},${site.z ?? params.z ?? '?'}`, blocks: 0, ingots: spent })
  }
  return result
}

export function deliveredBarterReceipts(samples: Iterable<unknown>): number {
  const seen = new Set<string>()
  let total = 0
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') continue
    const row = sample as Record<string, unknown>
    if (row.level !== 'act' || row.skill !== 'bastion' || row.status !== 'done' || row.death !== false ||
      typeof row.run !== 'string' || !Number.isInteger(row.seq) || typeof row.barterDelivered !== 'number' ||
      !Number.isSafeInteger(row.barterDelivered) || row.barterDelivered <= 0) continue
    const id = `${row.run}:${row.seq}`
    if (seen.has(id)) continue
    seen.add(id)
    total += row.barterDelivered
  }
  return total
}

function quantity(state: WorldState, name: string): number {
  const value = state.facts[name]?.value
  return typeof value === 'number' ? value : 0
}

function targetPosition(state: WorldState, name: string): Position | null {
  const value = state.facts[name]?.value
  return value && typeof value === 'object' && 'x' in value && 'y' in value && 'z' in value ? value : null
}

function approachProgress(before: Position, after: Position, target: Position): boolean {
  const distance = (position: Position) => Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z)
  return distance(before) - distance(after) >= 8
}

export function bastionApproachProgress(before: Position | null, after: Position | null,
  site: { x: number; y?: number; z: number; gold?: readonly unknown[]; chests?: readonly unknown[] }): boolean {
  if (!before || !after) return false
  const points: Position[] = []
  for (const value of [...(site.gold ?? []), ...(site.chests ?? [])]) {
    const coordinates: unknown[] = Array.isArray(value) ? value : value && typeof value === 'object'
      ? [(value as Record<string, unknown>).x, (value as Record<string, unknown>).y, (value as Record<string, unknown>).z] : []
    const [x, y, z] = coordinates
    if ([x, y, z].every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))) {
      points.push({ x: x as number, y: y as number, z: z as number })
    }
  }
  if (!points.length) points.push({ x: site.x, y: site.y ?? 64, z: site.z })
  return points.some(target => approachProgress(before, after, target))
}

export function netherStageProgress(stage: 'bastion' | 'nether', before: WorldState, after: WorldState): boolean {
  const resources = stage === 'bastion' ? ['gold', 'pearls', 'eyes', 'obsidian'] : ['rods', 'powder', 'eyes']
  if (resources.some(name => amount(after, name) > amount(before, name))) return true
  if (stage === 'nether' && before.dimension === 'the_nether' && after.dimension === 'the_nether' && quantity(after, 'fortress_explored') > quantity(before, 'fortress_explored')) return true
  if (stage === 'bastion' && ['fire_resistance_count', 'bastion_gold_dug', 'bastion_traded'].some(name => quantity(after, name) > quantity(before, name))) return true
  const name = stage === 'bastion' ? 'bastion_position' : 'fortress_position'
  const target = targetPosition(before, name)
  if (!target || !before.position || !after.position || before.dimension !== after.dimension) return false
  return approachProgress(before.position, after.position, target)
}

export function netherSupplyProgress(before: WorldState, after: WorldState): boolean {
  const count = (state: WorldState, pattern: RegExp) => Object.entries(state.inventory)
    .reduce((total, [item, count]) => total + (pattern.test(item) ? count : 0), 0)
  const wood = (state: WorldState) => count(state, /_planks$/) + count(state, /_(log|stem)$/) * 4
  if (Math.min(16, wood(after)) > Math.min(16, wood(before))) return true
  if (Math.min(260, quantity(after, 'nether_pick_swings')) > Math.min(260, quantity(before, 'nether_pick_swings'))) return true
  if (amount(after, 'stone_tool') > amount(before, 'stone_tool')) return true
  for (const [pattern, maximum] of [[/^crafting_table$/, 1], [/^stick$/, 2]] as const) {
    if (Math.min(maximum, count(after, pattern)) > Math.min(maximum, count(before, pattern))) return true
  }
  const material = /^(cobblestone|cobbled_deepslate|blackstone)$/
  if (quantity(before, 'nether_pick_swings') < 260 && Math.min(3, count(after, material)) > Math.min(3, count(before, material))) return true
  return after.facts.nether_tools_ready?.value === true && before.facts.nether_tools_ready?.value !== true
}
