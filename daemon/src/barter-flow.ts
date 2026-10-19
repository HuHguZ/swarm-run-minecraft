'use strict'
import * as gameClock from './game-clock'
const enabled = () => process.env.ND_BARTER_FLOW !== '0'
const ADMIRE_MS = 119 * 50
function awaitingLure (lastConfirmedToss: number | undefined, now: number): boolean {
  return lastConfirmedToss !== undefined && now >= lastConfirmedToss && now - lastConfirmedToss < ADMIRE_MS + 2500
}
const cache = new Map()
// Exact compound Bernoulli distribution from gameplay/piglin_bartering, Java 1.21.11.
// A missed pearl stack counts as a failed trade; no deterministic RNG manipulation.
function pearlChance (ingots, need, delivery = 1) {
  need = Math.max(0, Math.ceil(need)); if (!need) return 1
  const p = 10 / 469 * Math.max(0, Math.min(1, delivery))
  let a = Array(need).fill(0); a[0] = 1
  for (let n = 0; n < Math.max(0, Math.floor(ingots)); n++) {
    const b = a.map(v => v * (1 - p))
    for (let k = 0; k < need; k++) for (const count of [2, 3, 4]) if (k + count < need) b[k + count] += a[k] * p / 3
    a = b
  }
  return 1 - a.reduce((s, v) => s + v, 0)
}
function pearlBudget (need, confidence = 0.85, delivery = 0.95) {
  need = Math.max(0, Math.ceil(need)); if (!need) return 0
  const key = `${need}/${confidence}/${delivery}`; if (cache.has(key)) return cache.get(key)
  for (let n = 1; n <= 480; n++) if (pearlChance(n, need, delivery) >= confidence) { cache.set(key, n); return n }
  return 480
}
function stock (bag) { return (Number(bag.gold_ingot) || 0) + 9 * (Number(bag.gold_block) || 0) }
// Successful clicks are reserved locally before delayed equipment packets arrive.
function ready (bot, pg, busy, now = gameClock.now()) {
  if (!pg || pg.isValid === false || !pg.position || (busy.get(pg.id) || 0) > now) return false
  const keys = bot.registry.entitiesByName.piglin.metadataKeys
  if (pg.metadata && (pg.metadata[keys.indexOf('baby')] || ((Number(pg.metadata[keys.indexOf('mob_flags')]) || 0) & 4))) return false
  const offhand = pg.equipment && pg.equipment[1]
  return !offhand || !/^(gold_ingot|gold_block|golden_.*)$/.test(offhand.name || '')
}
function retry (detail, bag) {
  // The ordinary trader-search branch can stop before it creates a booth;
  // it has no barterRetry field even though the gold is still in the bag.
  const searchGap = process.env.ND_BARTER_RETRY_GAP !== '0' &&
    /^бартер встал: (?:пиглинов рядом нет|пиглины рядом есть, но ни до одного не дойти)/.test(detail.stopped || '')
  return stock(bag) >= 18 && !(detail.ingotsTraded > 0) && (!!detail.barterRetry || searchGap)
}
// Campaign adapter for core/barter-model (S3, 06.10): bastion.ts numbers in, one decision and its log line out.
// action: trade (carried gold) | mine (next batch, ingots) | move (to next[site]) | endermen | stop; why/eSeconds/pReach go to the log.
function plan (s: { pearls: number; required: number; gold: number; siteIngots: number | null; next?: Array<{ ingots: number; blocks: number }>;
  delivered?: number; thrown?: number; mined?: { ingots: number; seconds: number }; traded?: { ingots: number; seconds: number };
  endermen?: boolean; fireRes?: { have: number; want: number; valueSeconds?: number } }) {
  const BM: typeof import('./core/barter-model') = require('./core/barter-model')
  const timing = BM.learnTiming(BM.DEFAULT_TIMING, { minedIngots: s.mined?.ingots, mineSeconds: s.mined?.seconds, tradedIngots: s.traded?.ingots, tradeSeconds: s.traded?.seconds })
  const delivery = BM.deliveryEstimate(s.delivered ?? 0, s.thrown ?? 0)
  const fire = s.fireRes && s.fireRes.have < s.fireRes.want ? { fire_resistance: { have: s.fireRes.have, want: s.fireRes.want, valueSeconds: s.fireRes.valueSeconds ?? 300 } } : undefined
  const d = BM.barterPlan({ pearls: s.pearls, required: s.required, gold: s.gold, here: s.siteIngots === null ? null : { gold: s.siteIngots, travelSeconds: 0 },
    next: (s.next || []).map(b => ({ gold: b.ingots, travelSeconds: b.blocks / 2.5 })), delivery, timing,
    endermenSecondsPerPearl: s.endermen ? 240 : undefined, wants: fire })
  return { ...d, delivery, timing, line: `бартер-модель: ${d.action}${d.batch ? ` ${d.batch} сл.` : ''}, E ${Math.round(d.eSeconds)} с, P(цель) ${d.pReach.toFixed(2)}, q̂ ${delivery.toFixed(2)} — ${d.why}` }
}
export { enabled, ADMIRE_MS, awaitingLure, pearlChance, pearlBudget, stock, ready, retry, plan }
