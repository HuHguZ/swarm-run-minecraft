'use strict'
const gameClock = require('./game-clock')
// Opt-in until the independent farm series: ND_BARTER_FLOW=1; =0 restores the old policy.
const enabled = () => process.env.ND_BARTER_FLOW === '1'
const ADMIRE_MS = 119 * 50
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
function stillNeeds (bag, { pearls = 10, fireRes = 0, obsidian = 0 } = {}) {
  return (bag.ender_pearl || 0) < pearls || (bag.fire_res || 0) < fireRes || (bag.obsidian || 0) < obsidian
}
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
module.exports = { enabled, ADMIRE_MS, pearlChance, pearlBudget, stock, stillNeeds, ready, retry }
