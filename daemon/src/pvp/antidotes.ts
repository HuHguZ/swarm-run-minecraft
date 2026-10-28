import * as clock from '../game-clock'

export type AntidoteItem = 'honey_bottle' | 'milk_bucket'
export interface AntidoteEffect { name: string; amplifier: number; remainingTicks: number | null }
export interface AntidoteContext {
  now?: number; deliveryTicks?: number; horizonTicks?: number; damagePerTick?: number;
  incomingPerTick?: number; exposurePerTick?: number; resourceCost?: Partial<Record<AntidoteItem, number>>
}
export interface AntidoteState extends AntidoteContext {
  health: number; maxHealth?: number; absorption?: number; burning?: boolean; airborne?: boolean; alive?: boolean;
  effects: AntidoteEffect[]; inventory: Record<AntidoteItem, number>
}
export interface AntidoteChoice {
  item: AntidoteItem; drinkTicks: number; utility: number; benefit: number;
  savedHp: number; tempoGain: number; buffLoss: number; cost: number
}
const nameOf = (name: string) => String(name).replace(/^minecraft:/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
const nonnegative = (n: number, fallback: number) => Number.isFinite(n) ? Math.max(0, n) : fallback
const interval = (base: number, amp: number) => Math.max(1, Math.floor(base / 2 ** Math.max(0, amp)))

/** Prices are HP-equivalent estimates; the DOT periods and drink durations are jar mechanics. */
export function chooseAntidote(state: AntidoteState): AntidoteChoice | null {
  if (!(state.health > 0) || state.alive === false) return null
  // shortcut: five-second horizon and .04/.05 HP-per-tick opportunity/risk priors are prices, not physical coefficients.
  const horizon = nonnegative(state.horizonTicks, 100), damage = nonnegative(state.damagePerTick, .04)
  const incoming = nonnegative(state.incomingPerTick, .05), exposure = nonnegative(state.exposurePerTick, 0)
  let best: AntidoteChoice | null = null
  for (const item of ['honey_bottle', 'milk_bucket'] as AntidoteItem[]) {
    if (!(state.inventory[item] > 0)) continue
    const drinkTicks = item === 'honey_bottle' ? 40 : 32, delay = drinkTicks + nonnegative(state.deliveryTicks, 0)
    let savedHp = 0, tempoGain = 0, buffLoss = 0
    for (const fx of state.effects) {
      const name = nameOf(fx.name), level = Math.max(1, fx.amplifier + 1)
      // An old raw Mineflayer duration is not a fresh remaining duration. Unknown buffs still have a loss price.
      const remaining = fx.remainingTicks == null ? null : nonnegative(fx.remainingTicks, 0)
      const after = remaining == null ? 0 : Math.min(horizon, Math.max(0, remaining - delay))
      const lost = Math.min(horizon, Math.max(0, (remaining ?? horizon + delay) - delay))
      if (name === 'poison' && after > 0) savedHp += Math.min(Math.floor(after / interval(25, fx.amplifier)), Math.max(0, Math.ceil(state.health - 1)))
      if (item === 'honey_bottle') continue
      if (name === 'wither') savedHp += Math.floor(after / interval(40, fx.amplifier))
      if (name === 'slowness') tempoGain += Math.min(1, .15 * level) * after * damage
      if (name === 'weakness') tempoGain += 4 * level * after / 20
      if (name === 'strength') buffLoss += 3 * level * lost / 20
      if (name === 'speed') buffLoss += .2 * level * lost * damage
      if (name === 'resistance') buffLoss += Math.min(1, .2 * level) * lost * incoming
      if (name === 'fire_resistance') buffLoss += lost * incoming * (state.burning ? 1 : .25)
      if (name === 'slow_falling') buffLoss += lost * incoming * (state.airborne ? 1 : .25)
      if (name === 'regeneration') buffLoss += Math.min(Math.floor(lost / interval(50, fx.amplifier)), Math.max(0, (state.maxHealth ?? 20) - state.health) + lost * incoming)
      if (name === 'absorption') buffLoss += Math.min(state.absorption ?? 4 * level, lost > 0 ? Infinity : 0)
    }
    const benefit = savedHp + tempoGain
    const cost = buffLoss + delay * (damage + exposure) + nonnegative(state.resourceCost?.[item], .25)
    const candidate = { item, drinkTicks, utility: benefit - cost, benefit, savedHp, tempoGain, buffLoss, cost }
    if (candidate.utility > 0 && (!best || candidate.utility > best.utility)) best = candidate
  }
  return best
}

type EffectTracker = { life: any; ended: boolean; receipts: Map<number, { effect: any; at: number }> }
const trackers = new WeakMap<object, EffectTracker>()
const nowOf = bot => bot.ndClock?.now?.() ?? clock.now()
function effectTracker(bot: any): EffectTracker {
  let track = trackers.get(bot)
  if (track) {
    if (track.life !== bot.entity) { track.life = bot.entity; track.receipts.clear() }
    return track
  }
  track = { life: bot.entity, ended: false, receipts: new Map() }; trackers.set(bot, track)
  const reset = () => { track.life = bot.entity; track.receipts.clear() }
  const start = (entity, effect) => {
    if (entity === bot.entity && effect && Number.isFinite(effect.id)) {
      if (track.life !== entity) reset()
      track.receipts.set(effect.id, { effect, at: nowOf(bot) })
    }
  }
  const end = (entity, effect) => { if (entity === bot.entity && effect) track.receipts.delete(effect.id) }
  const close = () => {
    track.ended = true; reset()
    for (const [event, fn] of listeners) bot.removeListener?.(event, fn)
  }
  const listeners: [string, (...args: any[]) => void][] = [['entityEffect', start], ['entityEffectEnd', end], ['spawn', reset], ['respawn', reset], ['death', reset], ['end', close]]
  for (const [event, fn] of listeners) bot.on?.(event, fn)
  return track
}
const inventoryItems = bot => (bot.inventory?.slots || bot.inventory?.items?.() || []).filter(Boolean)
const count = (bot, name) => inventoryItems(bot).reduce((n, item) => n + (item.name === name ? item.count : 0), 0)

/** Own client receipts only; listener installation cannot recover the age of effects received before this call. */
export function ownAntidoteState(bot: any, context: AntidoteContext = {}): AntidoteState {
  const track = effectTracker(bot), now = context.now ?? nowOf(bot), effects: AntidoteEffect[] = []
  for (const [rawId, fx] of Object.entries<any>(bot.entity?.effects || {})) {
    const id = Number(rawId), definition = bot.registry?.effects?.[id] || Object.values<any>(bot.registry?.effectsByName || {}).find(x => x.id === id)
    if (!definition) continue
    const receipt = track.receipts.get(id)
    const known = receipt?.effect === fx && Number.isFinite(fx.duration) && fx.duration >= 0 && now >= receipt.at
    effects.push({ name: nameOf(definition.name), amplifier: fx.amplifier ?? 0,
      remainingTicks: known ? Math.max(0, fx.duration - (now - receipt.at) / 50) : null })
  }
  if (bot._ndFrUntil > now && !effects.some(x => x.name === 'fire_resistance')) effects.push({ name: 'fire_resistance', amplifier: 0, remainingTicks: (bot._ndFrUntil - now) / 50 })
  let absorption: number | undefined
  try { absorption = require('../read').absorptionOf(bot, bot.entity) } catch {}
  return { ...context, now, health: bot.health ?? 0, maxHealth: Math.max(bot.health || 0, bot.entity?.attributes?.['minecraft:max_health']?.value || 20),
    absorption, alive: !track.ended && (bot.health ?? 0) > 0, burning: !!bot.entity?.isInLava || !!(bot.entity?.metadata?.[0] & 1),
    airborne: bot.entity?.onGround === false, effects, inventory: { honey_bottle: count(bot, 'honey_bottle'), milk_bucket: count(bot, 'milk_bucket') } }
}

export function antidoteReport(bot: any, context: AntidoteContext = {}) {
  const state = ownAntidoteState(bot, context), choice = chooseAntidote(state)
  const need = choice ? null : chooseAntidote({ ...state, inventory: { honey_bottle: 1, milk_bucket: 1 }, deliveryTicks: context.deliveryTicks ?? 40 })
  return { state, choice, need, using: !!bot._ndAntidoteDrinking }
}

/** The caller must supply an actual consumption receipt, never equip or status9 alone. */
export function finishAntidote(bot: any, itemName: string, consumed: boolean): boolean {
  if (consumed && itemName === 'milk_bucket') bot._ndFrUntil = 0
  return consumed
}

export async function antidoteTurn(ctx: any, turn: any): Promise<boolean> {
  const bot = ctx.bot, life = bot?.entity
  if (!life || ctx.ctl?.aborted || ctx.selfDied || !(bot.health > 0) || bot._ndAntidoteDrinking || turn.punishAfterRecovery) return false
  const state = ownAntidoteState(bot)
  // Use this turn's public reach/cooldown and existing damage estimate when available, never foe HP.
  if (turn.seesBody === false) state.damagePerTick = 0
  else if (turn.seesBody === true && Number.isFinite(turn.r)) {
    const dm = require('./damage-model'), rules = require('./rules'), weapon = ctx.weapon ?? bot.heldItem
    const delay = Math.max(1, dm.attackDelayTicks(weapon?.name))
    const hit = Number.isFinite(turn.meleeDmg) ? Math.max(0, turn.meleeDmg) : dm.attackDamage(weapon?.name)
    const approach = Math.max(0, turn.r - rules.HIT_REACH) / require('../tempo').WALK_BPT
    const ready = Math.max(0, (ctx.nextReady || 0) - nowOf(bot)) / 50
    state.damagePerTick = hit / delay * Math.max(0, 40 - Math.max(approach, ready)) / 40
  }
  const choice = chooseAntidote(state), consume = ctx.consumeItem ?? ctx.pvpSkills?.consumeItem
  if (!choice || !consume) return false
  const item = inventoryItems(bot).find(x => x.name === choice.item && x.count > 0)
  if (!item) return false
  let ended = false, accepted = false, error: string | null = null
  const dead = () => { ended = true }, sameLife = () => !ended && bot.entity === life && bot.health > 0
  const abort = () => !!ctx.ctl?.aborted || !!ctx.selfDied || !sameLife()
  for (const event of ['death', 'respawn', 'end']) bot.on(event, dead)
  const before = count(bot, choice.item), removed: string[] = []
  const endEffect = (entity, fx) => { if (entity === life && fx) removed.push(String(fx.id)) }
  bot.on('entityEffectEnd', endEffect)
  bot._ndAntidoteDrinking = { item: choice.item, startedAt: nowOf(bot) }
  try {
    ctx.pathTo?.(false); ctx.pathing = false; ctx.clear?.()
    accepted = await consume.call(ctx, item, abort, { onPunish: () => { turn.punishAfterRecovery = true } })
  } catch (err) { error = String(err) }
  finally {
    delete bot._ndAntidoteDrinking
    for (const event of ['death', 'respawn', 'end']) bot.removeListener(event, dead)
    bot.removeListener('entityEffectEnd', endEffect)
    if (sameLife() && !ctx.ctl?.aborted) {
      try { ctx.clear?.(); await ctx.holdWeapon?.() } catch (err) { error = String(err) }
    }
  }
  const consumed = accepted === true && sameLife() && count(bot, choice.item) < before
  finishAntidote(bot, choice.item, consumed)
  const after = ownAntidoteState(bot), cleared = consumed && (choice.item === 'honey_bottle'
    ? !after.effects.some(x => x.name === 'poison') : after.effects.length === 0)
  const receipt = { ...choice, damagePerTick: state.damagePerTick ?? .04, consumed, cleared, removedEffectIds: removed, error, at: nowOf(bot) }
  if (ctx.st) ctx.st.antidote = receipt
  bot._ndAntidoteLast = receipt
  if (consumed) ctx.used?.('выпил ' + choice.item + (cleared ? ': очистка подтверждена' : ': очистка пока не подтверждена'))
  return consumed
}
