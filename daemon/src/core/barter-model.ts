// Barter economics for Java 1.21.11 piglin bartering. Pure functions, no Minecraft.
// Table: data/minecraft/loot_table/gameplay/piglin_bartering.json from the 1.21.11 server jar (farm/server-*/cache/
// mojang_1.21.11.jar → META-INF/versions/1.21.11/server-1.21.11.jar), one roll per ingot, total weight 469,
// set_count uniform = integer uniform inclusive. Barter outcomes are never predicted from the world RNG sequence.

export interface BarterEntry { item: string; weight: number; min: number; max: number }
export const BARTER_TABLE: readonly BarterEntry[] = [
  { item: 'enchanted_book', weight: 5, min: 1, max: 1 }, { item: 'iron_boots', weight: 8, min: 1, max: 1 },
  { item: 'fire_resistance_potion', weight: 8, min: 1, max: 1 }, { item: 'fire_resistance_splash_potion', weight: 8, min: 1, max: 1 },
  { item: 'water_potion', weight: 10, min: 1, max: 1 }, { item: 'iron_nugget', weight: 10, min: 10, max: 36 },
  { item: 'ender_pearl', weight: 10, min: 2, max: 4 }, { item: 'dried_ghast', weight: 10, min: 1, max: 1 },
  { item: 'string', weight: 20, min: 3, max: 9 }, { item: 'quartz', weight: 20, min: 5, max: 12 },
  { item: 'obsidian', weight: 40, min: 1, max: 1 }, { item: 'crying_obsidian', weight: 40, min: 1, max: 3 },
  { item: 'fire_charge', weight: 40, min: 1, max: 1 }, { item: 'leather', weight: 40, min: 2, max: 4 },
  { item: 'soul_sand', weight: 40, min: 2, max: 8 }, { item: 'nether_brick', weight: 40, min: 2, max: 8 },
  { item: 'spectral_arrow', weight: 40, min: 6, max: 12 }, { item: 'gravel', weight: 40, min: 8, max: 16 },
  { item: 'blackstone', weight: 40, min: 8, max: 16 }
]
export const BARTER_WEIGHT = BARTER_TABLE.reduce((sum, entry) => sum + entry.weight, 0)
/** Goods the speedrun counts; fire_resistance joins the drinkable and splash potions. */
export type Good = 'ender_pearl' | 'fire_resistance' | 'obsidian' | 'string' | 'crying_obsidian' | 'fire_charge'
const entriesOf = (good: Good) => BARTER_TABLE.filter(entry => good === 'fire_resistance' ? /^fire_resistance_/.test(entry.item) : entry.item === good)

/** P(one ingot yields exactly c of the good and the stack reaches the bag), c = 1..max; index 0 unused. */
export function perIngot(good: Good, delivery = 1): number[] {
  const q = Math.max(0, Math.min(1, delivery))
  const out: number[] = []
  for (const entry of entriesOf(good)) for (let c = entry.min; c <= entry.max; c++) out[c] = (out[c] ?? 0) + entry.weight / BARTER_WEIGHT / (entry.max - entry.min + 1) * q
  return Array.from(out, value => value ?? 0)
}
/** Mean count of the good per ingot after delivery losses (pearl: 10/469·3·q ≈ 0.064·q). */
export const meanPerIngot = (good: Good, delivery = 1): number => perIngot(good, delivery).reduce((sum, p, c) => sum + p * c, 0)

/** Joint progress over capped counts of several goods, stepped one ingot at a time (goods are exclusive per roll). */
export class BarterProgress {
  readonly goods: Good[]
  readonly caps: number[]
  private readonly rows: Array<Array<[number, number]>>
  private dist: Float64Array
  ingots = 0
  constructor(needs: Partial<Record<Good, number>>, delivery = 1) {
    const entries = (Object.entries(needs) as Array<[Good, number]>).filter(([, need]) => need > 0)
    this.goods = entries.map(([good]) => good)
    this.caps = entries.map(([, need]) => Math.ceil(need))
    this.rows = this.goods.map(good => perIngot(good, delivery).map((p, c) => [c, p] as [number, number]).filter(([, p]) => p > 0))
    this.dist = new Float64Array(this.caps.reduce((size, cap) => size * (cap + 1), 1))
    this.dist[0] = 1
  }
  private index(counts: number[]): number { return counts.reduce((index, count, i) => index * (this.caps[i]! + 1) + count, 0) }
  private counts(index: number): number[] {
    const out = new Array<number>(this.caps.length)
    for (let i = this.caps.length - 1; i >= 0; i--) { out[i] = index % (this.caps[i]! + 1); index = Math.floor(index / (this.caps[i]! + 1)) }
    return out
  }
  step(): void {
    const next = new Float64Array(this.dist.length)
    const stay = 1 - this.rows.reduce((sum, row) => sum + row.reduce((s, [, p]) => s + p, 0), 0)
    for (let index = 0; index < this.dist.length; index++) {
      const mass = this.dist[index]!
      if (!mass) continue
      next[index] += mass * stay
      const counts = this.counts(index)
      this.rows.forEach((row, i) => {
        for (const [c, p] of row) {
          const moved = counts.slice(); moved[i] = Math.min(this.caps[i]!, moved[i]! + c)
          next[this.index(moved)] += mass * p
        }
      })
    }
    this.dist = next
    this.ingots++
  }
  /** P(every need met). */
  done(): number { return this.dist[this.dist.length - 1]! }
  /** Distribution of one good's capped count: [P(0), …, P(≥cap)]. */
  marginal(good: Good): number[] {
    const g = this.goods.indexOf(good)
    const out = new Array<number>((this.caps[g] ?? 0) + 1).fill(0)
    if (g < 0) { out[0] = 1; return out }
    for (let index = 0; index < this.dist.length; index++) if (this.dist[index]) out[this.counts(index)[g]!]! += this.dist[index]!
    return out
  }
}
/** P(all needs met | n ingots, delivery q). Matches barter-flow pearlChance for pearls alone. */
export function chanceAll(ingots: number, needs: Partial<Record<Good, number>>, delivery = 1): number {
  const progress = new BarterProgress(needs, delivery)
  for (let n = 0; n < Math.max(0, Math.floor(ingots)); n++) progress.step()
  return progress.goods.length ? progress.done() : 1
}
/** E[ingots until every need is met] = Σ_n P(not yet met after n). */
export function expectedIngots(needs: Partial<Record<Good, number>>, delivery = 1, limit = 6000): number {
  const progress = new BarterProgress(needs, delivery)
  if (!progress.goods.length) return 0
  let expected = 0
  while (progress.ingots < limit) {
    const left = 1 - progress.done()
    if (left < 1e-9) break
    expected += left
    progress.step()
  }
  return expected
}
/** Smallest n with P(all met | n) ≥ confidence (limit if unreachable). */
export function ingotsFor(needs: Partial<Record<Good, number>>, confidence: number, delivery = 1, limit = 6000): number {
  const progress = new BarterProgress(needs, delivery)
  if (!progress.goods.length) return 0
  while (progress.ingots < limit && progress.done() < confidence) progress.step()
  return progress.ingots
}
/** Delivery q̂ = posterior mean of Beta(8.5, 1.5) (prior ≈ 0.85) after this run's throws. */
export function deliveryEstimate(delivered: number, thrown: number): number {
  const d = Math.max(0, delivered), t = Math.max(d, thrown)
  return (8.5 + d) / (10 + t)
}

export interface BarterTiming {
  /** Game seconds per mined gold ingot (blocks × 9), sealed tunnel included. */
  mineSecondsPerIngot: number
  /** Game seconds per traded ingot (limited by piglins at the mouth). */
  tradeSecondsPerIngot: number
  /** One mine → trade switch: piglin anger 33 s + pit build/exit. */
  switchSeconds: number
}
/** Measured defaults (barter-piglins.md 4.4): trade 144 ingots / 334 s; sealed mining 1.8–3.9 s/ingot; switch ≈ 60 s. */
export const DEFAULT_TIMING: BarterTiming = { mineSecondsPerIngot: 2.5, tradeSecondsPerIngot: 2.4, switchSeconds: 60 }
/** Shrink observed rates toward the prior with 27 ingots (3 blocks) and 2 switches of prior weight. */
export function learnTiming(prior: BarterTiming, seen: { minedIngots?: number; mineSeconds?: number; tradedIngots?: number; tradeSeconds?: number; switches?: number; switchSeconds?: number }): BarterTiming {
  const blend = (rate: number, weight: number, units = 0, seconds = 0) => units > 0 && seconds >= 0 ? (rate * weight + seconds) / (weight + units) : rate
  return { mineSecondsPerIngot: blend(prior.mineSecondsPerIngot, 27, seen.minedIngots, seen.mineSeconds),
    tradeSecondsPerIngot: blend(prior.tradeSecondsPerIngot, 27, seen.tradedIngots, seen.tradeSeconds),
    switchSeconds: blend(prior.switchSeconds, 2, seen.switches, seen.switchSeconds) }
}

export interface BarterSite { /** Minable ingots left (gold blocks × 9). */ gold: number; /** Game seconds to get there and dig in. */ travelSeconds: number }
export interface BarterState {
  /** Pearls plus eyes already held. */
  pearls: number
  /** Hard need: empty frames from the world copy when known, else the campaign default. */
  required: number
  /** Optional spare pearls (throws, triangulation) and the game seconds each one is worth. */
  spare?: { count: number; valueSeconds: number }
  /** Ingots carried (blocks × 9): already paid for. */
  gold: number
  /** The current bastion; null when not at one. */
  here: BarterSite | null
  /** Other known bastions with travel from here. */
  next?: BarterSite[]
  /** q̂: share of loot stacks that reach the bag. */
  delivery: number
  timing: BarterTiming
  /** Enderman hunting rate (game s per pearl); undefined when not allowed yet. */
  endermenSecondsPerPearl?: number
  /** Compare hunting now with trading carried gold first; opt-in campaign experiment. */
  directHunt?: boolean
  /** Secondary goods with marginal value in game seconds (trade or mine for them only when it pays). */
  wants?: Partial<Record<Exclude<Good, 'ender_pearl'>, { have: number; want: number; valueSeconds: number }>>
  /** Cost of ending without enough pearls (run lost). */
  failSeconds?: number
}
export type BarterAction = 'trade' | 'mine' | 'move' | 'endermen' | 'stop'
export interface BarterOption { action: BarterAction; eSeconds: number; pReach: number; batch: number; site?: number }
export interface BarterDecision extends BarterOption { why: string; deficit: number; options: BarterOption[] }

interface Outcome { seconds: number; p: number; mined: number }
/** Expected seconds to reach `deficit` pearls with carried gold g, then minable gold G here, then `fallback(r)`. */
function siteOutcome(deficit: number, carried: number, site: BarterSite, s: BarterState, fallback: (left: number) => { seconds: number; p: number }): Outcome & { batch: number } {
  const t = s.timing
  if (deficit <= 0) return { seconds: 0, p: 1, mined: 0, batch: 0 }
  const progress = new BarterProgress({ ender_pearl: deficit }, s.delivery)
  let seconds = 0, mined = 0
  const supply = carried + Math.max(0, site.gold)
  for (let n = 0; n < supply; n++) {
    const left = 1 - progress.done()
    if (left < 1e-9) break
    seconds += left * (t.tradeSecondsPerIngot + (n >= carried ? t.mineSecondsPerIngot : 0))
    if (n >= carried) mined += left
    progress.step()
  }
  const reached = progress.done()
  const marginal = progress.marginal('ender_pearl')
  let pFallback = 0
  for (let k = 0; k < deficit; k++) {
    if (!marginal[k]) continue
    const f = fallback(deficit - k)
    seconds += marginal[k]! * f.seconds
    pFallback += marginal[k]! * f.p
  }
  // Mine in batches: B* = √(2·S·E_mined / c_g) balances switches against overshoot, rounded up to whole blocks.
  const raw = Math.sqrt(2 * t.switchSeconds * mined / Math.max(0.1, t.mineSecondsPerIngot))
  const batch = mined > 0 ? Math.min(Math.max(9, Math.ceil(raw / 9) * 9), Math.max(9, Math.ceil(site.gold / 9) * 9)) : 0
  seconds += site.travelSeconds + (mined > 0 ? Math.ceil(mined / batch) * t.switchSeconds : 0)
  return { seconds, p: reached + pFallback, mined, batch }
}
/** One economic step of bartering: trade, mine (batch), move to another bastion, hunt endermen, or stop. */
export function barterPlan(s: BarterState): BarterDecision {
  const t = s.timing
  const deficit = Math.max(0, Math.ceil(s.required - s.pearls))
  const failSeconds = s.failSeconds ?? 3600
  const spareLeft = s.spare ? Math.max(0, s.spare.count - Math.max(0, s.pearls - s.required)) : 0
  // Marginal value of one more ingot of loot once the required pearls are held, in game seconds.
  const pearlValue = spareLeft > 0 ? s.spare!.valueSeconds : 0
  const secondary = Object.entries(s.wants ?? {}).reduce((sum, [good, want]) => want && want.have < want.want ? sum + meanPerIngot(good as Good, s.delivery) * want.valueSeconds : sum, 0)
  const ingotValue = meanPerIngot('ender_pearl', s.delivery) * pearlValue + secondary
  const endermen = (left: number) => s.endermenSecondsPerPearl !== undefined ? { seconds: left * s.endermenSecondsPerPearl, p: 1 } : { seconds: failSeconds, p: 0 }
  if (deficit === 0) {
    if (s.gold > 0 && ingotValue >= t.tradeSecondsPerIngot) return { action: 'trade', batch: s.gold, eSeconds: s.gold * t.tradeSecondsPerIngot, pReach: 1, deficit,
      options: [], why: `loot value ${ingotValue.toFixed(1)} s per ingot ≥ trade ${t.tradeSecondsPerIngot.toFixed(1)} s` }
    const mineValue = ingotValue - t.tradeSecondsPerIngot - t.mineSecondsPerIngot
    if (s.gold <= 0 && s.here && s.here.gold > 0 && mineValue > 0) {
      const batch = Math.min(Math.ceil(s.here.gold / 9) * 9, 27)
      if (mineValue * batch > t.switchSeconds) return { action: 'mine', batch, eSeconds: batch * (t.mineSecondsPerIngot + t.tradeSecondsPerIngot) + t.switchSeconds,
        pReach: 1, deficit, options: [], why: `secondary loot ${ingotValue.toFixed(1)} s per ingot pays for mining` }
    }
    return { action: 'stop', batch: 0, eSeconds: 0, pReach: 1, deficit, options: [], why: 'required pearls held; more loot is worth less than the time' }
  }
  // Every option trades the carried gold first (it is already paid for), then continues from its own source.
  const sites = s.next ?? []
  const afterHere = (left: number) => [endermen(left), ...sites.map(site => {
    const there = siteOutcome(left, 0, site, s, endermen)
    return { seconds: there.seconds + t.switchSeconds, p: there.p }
  })].sort((a, b) => a.seconds - b.seconds)[0]!
  const options: BarterOption[] = []
  if (s.gold > 0) {
    const trade = siteOutcome(deficit, s.gold, { gold: 0, travelSeconds: 0 }, s, afterHere)
    options.push({ action: 'trade', eSeconds: trade.seconds, pReach: trade.p, batch: s.gold })
  }
  if (s.here && s.here.gold > 0) {
    const here = siteOutcome(deficit, s.gold, s.here, s, afterHere)
    options.push({ action: 'mine', eSeconds: here.seconds, pReach: here.p, batch: here.batch })
  }
  sites.forEach((site, index) => {
    const there = siteOutcome(deficit, s.gold, site, s, endermen)
    options.push({ action: 'move', eSeconds: there.seconds + t.switchSeconds, pReach: there.p, batch: there.batch, site: index })
  })
  if (s.endermenSecondsPerPearl !== undefined) {
    const hunt = s.directHunt ? { seconds: deficit * s.endermenSecondsPerPearl, p: 1 }
      : siteOutcome(deficit, s.gold, { gold: 0, travelSeconds: 0 }, s, endermen)
    options.push({ action: 'endermen', eSeconds: hunt.seconds, pReach: hunt.p, batch: 0 })
  }
  options.sort((a, b) => a.eSeconds - b.eSeconds)
  if (s.gold > 0 && !(s.directHunt && options[0]?.action === 'endermen')) {
    const best = options[0]!
    return { action: 'trade', batch: s.gold, eSeconds: best.eSeconds, pReach: best.pReach, deficit, options,
      why: `pearls short by ${deficit}: carried gold is already paid for; then ${options.find(o => o.action !== 'trade')?.action ?? 'nothing'}` }
  }
  const best = options[0]
  if (!best) return { action: 'stop', batch: 0, eSeconds: failSeconds, pReach: 0, deficit, options, why: `pearls short by ${deficit} and no gold, bastion or endermen left` }
  return { ...best, deficit, options, why: `${best.action}: ${Math.round(best.eSeconds)} s expected, P(reach) ${best.pReach.toFixed(2)}` }
}
