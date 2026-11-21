import type { Item } from './arms-graph'
import { cloneWorld, type Position, type WorldState } from '../core/world-state'
import { powerOf, lootRiskIncrement, ARMS_RISK_PENALTY } from './arms-graph'
const { itemsByName } = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
import { pathSeconds, WALK, RUN } from '../hopgoto'

export type StorageItem = Item & { plain?: boolean }
export function sampleItems(samples: string[][], rocket3: string): Item[][] {
  const { parseItem }: typeof import('../../arena/arena-ench') = require('../../arena/arena-ench')
  return samples.map(sample => sample.map(raw => {
    const item = parseItem(raw)
    return { name: item.id, count: Number(item.count) || 1, ench: item.pinned,
      ...(item.id === 'firework_rocket' ? { stars: raw.split(' ')[0] === rocket3 ? 3 : 0 } : {}) }
  }))
}
const simpleStack = (i: StorageItem): boolean => i.plain !== false && !Object.keys(i.ench || {}).length &&
  i.stars == null && !i.crossbow && !/potion|tipped_arrow|firework_rocket|enchanted_book/.test(i.name)

export const DROP_TICKS_PER_SLOT = 4
const EVICT_MIN_GAIN = 0.2
const CORE_UTILITY = /^(water_bucket|ender_pearl|wind_charge|cobweb|cooked_|bread|baked_potato|golden_carrot)|_pickaxe$/

function removeOneFromOwned (owned: Item[], target: StorageItem): Item[] {
  const out: Item[] = []
  let removed = false
  for (const it of owned) {
    if (!removed && it.name === target.name && (it.count ?? 1) === (target.count ?? 1) &&
        JSON.stringify(it.ench || {}) === JSON.stringify(target.ench || {}) &&
        it.stars === target.stars) {
      removed = true
      continue
    }
    out.push(it)
  }
  if (!removed) {
    for (let i = 0; i < out.length; i++) {
      if (out[i].name === target.name) {
        const left = (out[i].count ?? 1) - (target.count ?? 1)
        if (left > 0) out[i] = { ...out[i], count: left }
        else out.splice(i, 1)
        break
      }
    }
  }
  return out
}

export function planLootEviction (owned: Item[], reward: Item[], storage: Array<StorageItem | null> | null): {
  accepted: Item[]; evicted: StorageItem[]; dropTicks: number; netGain: number
} {
  if (!storage) return { accepted: [], evicted: [], dropTicks: 0, netGain: 0 }
  const slots = storage.map(i => i && { ...i })
  const evictable = slots.map(i => !!i)
  const accepted: Item[] = []
  const overflow: Item[] = []
  const ordered = [...new Set(reward.map(i => i.name))].flatMap(name => reward.filter(i => i.name === name))
  for (const item of ordered) {
    const limit = itemsByName[item.name]?.stackSize || 1
    let left = Math.max(0, Math.floor(item.count ?? 1)), got = 0
    if (limit > 1 && simpleStack(item)) for (const slot of slots) {
      if (!slot || slot.name !== item.name || !simpleStack(slot)) continue
      const n = Math.min(left, Math.max(0, limit - (slot.count ?? 1)))
      slot.count = (slot.count ?? 1) + n; left -= n; got += n
    }
    for (let index = 0; index < slots.length && left > 0; index++) if (!slots[index]) {
      const count = Math.min(left, limit)
      slots[index] = { ...item, count }; evictable[index] = false; left -= count; got += count
    }
    if (got > 0) accepted.push({ ...item, count: got })
    while (left > 0) {
      const count = Math.min(left, limit)
      overflow.push({ ...item, count })
      left -= count
    }
  }
  const baseOwnedPower = powerOf(owned).total
  let currentOwned = [...owned, ...accepted]
  const evicted: StorageItem[] = []
  if (overflow.length) {
    const ranked = overflow
      .map(item => ({ item, rawGain: powerOf([...currentOwned, item]).total - powerOf(currentOwned).total }))
      .sort((a, b) => b.rawGain - a.rawGain)
    for (const { item } of ranked) {
      const curPower = powerOf(currentOwned).total
      if (powerOf([...currentOwned, item]).total <= curPower + EVICT_MIN_GAIN) continue
      let bestIdx = -1, bestCost = Infinity, bestWithout: Item[] | null = null
      for (let idx = 0; idx < slots.length; idx++) {
        const s = slots[idx]
        if (!evictable[idx] || !s) continue
        const without = removeOneFromOwned(currentOwned, s)
        const loss = Math.max(0, curPower - powerOf(without).total)
        const sameNameCount = slots.filter(x => x && x.name === s.name).length
        const utilityTie = sameNameCount === 1 && CORE_UTILITY.test(s.name) ? 0.05 : 0
        const cost = loss + utilityTie
        if (cost < bestCost) { bestCost = cost; bestIdx = idx; bestWithout = without }
      }
      if (bestIdx < 0 || !bestWithout) break
      const afterPower = powerOf([...bestWithout, item]).total
      if (afterPower - curPower > EVICT_MIN_GAIN) {
        evicted.push(slots[bestIdx]!)
        slots[bestIdx] = { ...item }
        evictable[bestIdx] = false
        currentOwned = [...bestWithout, item]
        accepted.push(item)
      }
    }
  }
  return {
    accepted,
    evicted,
    dropTicks: evicted.length * DROP_TICKS_PER_SLOT,
    netGain: Math.max(0, powerOf(currentOwned).total - baseOwnedPower)
  }
}

export function fittingLoot(reward: Item[], storage: Array<StorageItem | null> | null, opts?: { evict?: boolean; owned?: Item[] }): Item[] {
  if (!storage) return []
  if (opts?.evict) {
    const owned = opts.owned ?? storage.filter((i): i is StorageItem => !!i)
    return planLootEviction(owned, reward, storage).accepted
  }
  const slots = storage.map(i => i && { ...i })
  const accepted: Item[] = []
  // chest_take(all) withdraws each first-seen name completely before moving to the next name.
  const ordered = [...new Set(reward.map(i => i.name))].flatMap(name => reward.filter(i => i.name === name))
  for (const item of ordered) {
    const limit = itemsByName[item.name]?.stackSize || 1
    let left = Math.max(0, Math.floor(item.count ?? 1)), got = 0
    if (limit > 1 && simpleStack(item)) for (const slot of slots) {
      if (!slot || slot.name !== item.name || !simpleStack(slot)) continue
      const n = Math.min(left, Math.max(0, limit - (slot.count ?? 1)))
      slot.count = (slot.count ?? 1) + n; left -= n; got += n
    }
    for (let index = 0; index < slots.length && left > 0; index++) if (!slots[index]) {
      const count = Math.min(left, limit)
      slots[index] = { ...item, count }; left -= count; got += count
    }
    if (got > 0) accepted.push({ ...item, count: got })
  }
  return accepted
}
export function marginalGain(owned: Item[], reward: Item[], storage: Array<StorageItem | null> | null, opts?: { evict?: boolean }): number {
  if (opts?.evict) return planLootEviction(owned, reward, storage).netGain
  return Math.max(0, powerOf([...owned, ...fittingLoot(reward, storage)]).total - powerOf(owned).total)
}
export function gainRange(owned: Item[], outcomes: Item[][], storage: Array<StorageItem | null> | null, opts?: { evict?: boolean }) {
  if (opts?.evict) {
    const plans = outcomes.map(reward => planLootEviction(owned, reward, storage))
    const gains = plans.map(p => p.netGain)
    const dropTicks = plans.length ? plans.reduce((a, p) => a + p.dropTicks, 0) / plans.length : 0
    return { gain: gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : 0,
      lo: gains.length ? Math.min(...gains) : 0, hi: gains.length ? Math.max(...gains) : 0, dropTicks }
  }
  const gains = outcomes.map(reward => marginalGain(owned, reward, storage))
  return { gain: gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : 0,
    lo: gains.length ? Math.min(...gains) : 0, hi: gains.length ? Math.max(...gains) : 0, dropTicks: 0 }
}
export const expectedGain = (owned: Item[], outcomes: Item[][], storage: Array<StorageItem | null> | null, opts?: { evict?: boolean }): number => gainRange(owned, outcomes, storage, opts).gain

export interface LootInteraction { ticks: number; movedNames: number; interrupted: boolean }
export function interactionCost(receipts: LootInteraction[], outcomes: Item[][], storage: Array<StorageItem | null> | null): number {
  if (!receipts.length) return 200 // Existing uninformed interaction prior.
  // containers.withdrawPass pays 250 game ms for each attempted, nonempty name.
  // Subtract only confirmed transfers: failed waits and opening/closing remain paid
  // residual, including interrupted receipts. This is a conservative estimate, not
  // a calibrated separation of latency from work.
  const perName = 250 / 50
  const residual = receipts.map(r => Math.max(0, r.ticks - perName * r.movedNames)).sort((a, b) => a - b)
  const groups = outcomes.map(items => new Set(fittingLoot(items, storage).map(i => i.name)).size)
  return residual[Math.floor(residual.length / 2)] + perName * (groups.length ? groups.reduce((a, b) => a + b, 0) / groups.length : 0)
}

export interface OwnTraversal {
  from: Position; to: Position; points: Position[]; ticks: number; completed: boolean; at: number
}
export interface LootQuote {
  chestId: string; roundScope: string; quoteAt: number; at: Position; approach: Position
  gain: number; gainLo: number; gainHi: number; travelTicks: number; travelSource: 'traversed' | 'estimate'
  costTicks: number; risk: number; riskLo: number; riskHi: number; totalWithFight: number
  exposure: number; exposureLo: number; exposureHi: number; riskPrior: 'interval-midpoint'
}
const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
export function routeEstimate(from: Position, chest: ChestMemory, traversals: OwnTraversal[]) {
  const approach = chest.seenFrom || chest
  if (distance(from, chest) <= 3.5) return { ticks: 0, source: 'traversed' as const, points: [{ ...from }], known: true }
  for (const route of [...traversals].reverse()) {
    if (!route.completed || cellKey(route.to) !== cellKey(approach)) continue
    const index = route.points.map(cellKey).lastIndexOf(cellKey(from))
    if (index < 0) continue
    const points = route.points.slice(index)
    const whole = pathSeconds(route.points.slice(1), route.from, { speed: WALK })
    const suffix = pathSeconds(points.slice(1), from, { speed: WALK })
    const ticks = index === 0 ? route.ticks : whole > 0 ? route.ticks * suffix / whole : 0
    const last = Math.max(0, distance(approach, chest) - 3.5) / WALK * 3 * 20
    return { ticks: ticks + last, source: 'traversed' as const, points, known: last === 0 }
  }
  // hopgoto's unknown-path prior: straight distance x3, never a claim that a route is open.
  const ticks = (distance(from, approach) + Math.max(0, distance(approach, chest) - 3.5)) / WALK * 3 * 20
  return { ticks, source: 'estimate' as const, points: [{ ...from }], known: false }
}
export function quoteLoot(input: {
  state: WorldState; owned: Item[]; storage: Array<StorageItem | null> | null; chest: ChestMemory
  prior: Item[][]; priorGain?: { gain: number; lo: number; hi: number; dropTicks?: number }; traversals: OwnTraversal[]
  foe: null | { at: number; pos: Position; previous?: { at: number; pos: Position } }
  roundScope: string; now: number; interactionTicks?: number; allowEvict?: boolean
  engage: { estimateCost(s: WorldState): number; estimateRisk(s: WorldState): number }
}): LootQuote {
  const { state, chest, foe, engage } = input
  const fullBag = Array.isArray(input.storage) && input.storage.length > 0 && !input.storage.some(s => !s)
  const useEvict = input.allowEvict !== false && fullBag
  const gain = Array.isArray(chest.contents)
    ? gainRange(input.owned, [chest.contents], input.storage, { evict: useEvict })
    : (useEvict && (!input.priorGain || input.priorGain.gain === 0)
        ? gainRange(input.owned, input.prior, input.storage, { evict: true })
        : (input.priorGain || gainRange(input.owned, input.prior, input.storage)))
  const route = routeEstimate(state.position || chest.seenFrom || chest, chest, input.traversals)
  const dropTicks = Math.round(gain.dropTicks || 0)
  const costTicks = route.ticks + (input.interactionTicks ?? 200) + (chest.attempt?.spentTicks || 0) + dropTicks
  let exposureLo = 0, exposureHi = 1
  if (foe?.pos && route.known) {
    const elapsed = foe.previous && foe.at > foe.previous.at ? (foe.at - foe.previous.at) / 1000 : 0
    const pace = Math.max(RUN, elapsed > 0 ? distance(foe.pos, foe.previous!.pos) / elapsed : 0)
    const radius = pace * Math.max(0, input.now - foe.at) / 1000
    const d = Math.min(...route.points.map(p => distance(p, foe.pos)))
    const seconds = Math.max(0.05, costTicks / 20)
    const exposure = (dist: number) => Math.max(0, Math.min(1, (seconds - dist / pace) / seconds))
    exposureLo = exposure(d + radius); exposureHi = exposure(Math.max(0, d - radius))
  }
  const after = cloneWorld(state)
  after.resources.power = (after.resources.power || 0) + gain.gain
  const beforeRisk = engage.estimateRisk(state), afterRisk = engage.estimateRisk(after)
  const riskLo = lootRiskIncrement(beforeRisk, afterRisk, exposureLo)
  const riskHi = lootRiskIncrement(beforeRisk, afterRisk, exposureHi)
  // Полный интервал сохраняется; midpoint — явный prior, а не измеренная вероятность перехвата.
  const exposure = (exposureLo + exposureHi) / 2
  const risk = lootRiskIncrement(beforeRisk, afterRisk, exposure)
  const approach = chest.seenFrom || chest
  return { chestId: chest.id, roundScope: input.roundScope, quoteAt: input.now,
    at: { x: chest.x, y: chest.y, z: chest.z }, approach: { x: approach.x, y: approach.y, z: approach.z },
    gain: gain.gain, gainLo: gain.lo, gainHi: gain.hi, travelTicks: route.ticks, travelSource: route.source,
    costTicks, risk, riskLo, riskHi, exposure, exposureLo, exposureHi, riskPrior: 'interval-midpoint',
    totalWithFight: costTicks + risk * ARMS_RISK_PENALTY + engage.estimateCost(after) + afterRisk * ARMS_RISK_PENALTY }
}
export function chooseLoot(quotes: LootQuote[]): LootQuote | null {
  return [...quotes].sort((a, b) => a.totalWithFight - b.totalWithFight || a.chestId.localeCompare(b.chestId))[0] || null
}

export interface ChestMemory extends Position {
  id: string; seenAt: number; seenFrom: Position | null
  opened: boolean; looted: boolean; taken: number; contents: Item[] | null
  evidenceRevision?: number
  attempt: null | { from: string; reason: string; failures: number; spentTicks: number; abandoned: boolean; evidenceRevision: number }
}
export interface LootReceipt {
  opened: boolean; emptied: boolean; moved: Record<string, number>; contents: Item[] | null
  interrupted: boolean; reason: string | null
}
export const cellKey = (p: Position): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

// chest_take.took уже измерен по приросту своих слотов открытого окна, а не по обещанию withdraw.
export function lootReceipt(chest: Position, reply: any): LootReceipt {
  const d = reply?.detail
  const interrupted = reply?.status === 'interrupted'
  const valid = d?.at && ['x', 'y', 'z'].every(k => d.at[k] === chest[k])
  const base: LootReceipt = { opened: false, emptied: false, moved: {}, contents: null, interrupted, reason: reply?.error || null }
  if (!valid) return { ...base, reason: base.reason || 'receipt does not match selected chest' }
  const contents = d.contents
  const opened = contents && !Array.isArray(contents) && typeof contents === 'object' &&
    Object.values(contents).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  if (!opened) return { ...base, reason: d.stopped || base.reason || 'no container observation' }
  const items = Object.entries(contents).filter(([, n]) => Number(n) > 0).map(([name, count]) => ({ name, count: Number(count) }))
  const moved: Record<string, number> = {}
  for (const [name, count] of Object.entries(d.took || {})) if (typeof count === 'number' && Number.isFinite(count) && count > 0) moved[name] = count
  return { opened: true, emptied: items.length === 0 && !d.stopped && !Object.keys(d.left || {}).length,
    moved, contents: items, interrupted, reason: d.stopped || base.reason }
}
