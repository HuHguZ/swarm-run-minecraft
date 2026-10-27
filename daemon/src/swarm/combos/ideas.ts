import type { Vec3 } from 'vec3'
import * as pick from '../../pick'
import { isAlly } from '../../combat/ally-safety'
import { IFRAME_TICKS, ticksToCharge, instantHeal } from '../../pvp/damage-model'
import { potionOf } from '../../pvp/potions'
import { isPlayer } from '../../pvp/rules'
import { seesPlayer } from '../../pvp/last-seen'
import { throwAt } from '../../throw'
import { nearSplash, unsafeSplash } from './splash-safety'

type Control = { aborted: boolean }
type Timing = { delayTicks?: number; ctl?: Control }
const stopped = (bot: any, ctl?: Control) => !!ctl?.aborted || !bot.entity || bot.health <= 0
const wait = async (bot: any, ticks: number) => { if (ticks > 0) await bot.waitForTicks(ticks) }

/** A sent packet is an attempt; only the stand's damage telemetry proves a hit. */
export async function strike(bot: any, target: any, { weapon, delayTicks = 0, ctl }: Timing & { weapon?: string } = {}) {
  if (stopped(bot, ctl) || !target?.position || target.isValid === false || target.id === bot.entity.id || isAlly(bot, target)) return { sent: false, why: 'invalid_target' }
  if (weapon && bot.heldItem?.name !== weapon) {
    const item = bot.inventory.items().find(i => i.name === weapon)
    if (!item) return { sent: false, why: 'missing_weapon' }
    await bot.equip(item, 'hand')
    await wait(bot, ticksToCharge(weapon))
  }
  await wait(bot, delayTicks)
  if (stopped(bot, ctl)) return { sent: false, why: 'cancelled' }
  const aim = pick.aim(bot, target)
  if (!aim?.point) return { sent: false, why: 'no_visible_reach' }
  await bot.lookAt(aim.point, true)
  if (stopped(bot, ctl) || target.isValid === false || target.id === bot.entity.id || isAlly(bot, target) || !pick.canHit(bot, target)) return { sent: false, why: 'aim_changed' }
  bot.deactivateItem()
  const blocked = bot._ndBlockedHits || 0
  bot.attack(target)
  return { sent: (bot._ndBlockedHits || 0) === blocked, why: (bot._ndBlockedHits || 0) === blocked ? 'packet_sent' : 'pick_guard' }
}

/** Call once per actor together; the caller owns approach, target selection and the round deadline. */
export async function runMeleeCombo(bot: any, target: any, { kind, index, count, rounds = 3, delayTicks = 0, ctl }:
  Timing & { kind: 'simultaneous' | 'stagger' | 'shield-break'; index: number; count: number; rounds?: number }) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count || !Number.isInteger(rounds) || rounds < 1)
    throw new Error('combo index/count/rounds')
  const axe = kind === 'shield-break' && index === 0
  const item = bot.inventory.items().find(i => (axe ? /_axe$/ : /_sword$/).test(i.name))
  const result = { sent: 0, attempts: 0, refused: [] as string[], weapon: item?.name ?? null }
  if (!item || stopped(bot, ctl)) { result.refused.push(item ? 'cancelled' : 'missing_weapon'); return result }
  if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand')
  // One common warmup keeps the axe opener ahead of swords after equipping resets their charge.
  await wait(bot, ticksToCharge('stone_axe') + delayTicks + (kind === 'simultaneous' ? 0 : index * IFRAME_TICKS))
  const period = kind === 'simultaneous' ? ticksToCharge(item.name) : Math.max(count * IFRAME_TICKS, ticksToCharge(item.name))
  for (let round = 0; round < rounds && !stopped(bot, ctl); round++) {
    if (round) await wait(bot, period)
    if (stopped(bot, ctl)) break
    result.attempts++
    const r = await strike(bot, target, { ctl })
    if (r.sent) result.sent++
    else result.refused.push(r.why)
  }
  return result
}

async function holdPotion(bot: any, wanted: any) {
  if (bot.heldItem?.slot !== wanted.slot || potionOf(bot.heldItem) !== potionOf(wanted)) await bot.equip(wanted, 'hand')
  return bot.heldItem?.name === 'splash_potion' && potionOf(bot.heldItem) === potionOf(wanted)
}

/** Assault actors wait outside the splash; the caller starts entry after the returned flight ticks. */
export async function debuffOpening(bot: any, target: any, { kind, allies = [], delayTicks = 0, ctl }:
  Timing & { kind: 'weakness' | 'slowness'; allies?: any[] }) {
  await wait(bot, delayTicks)
  if (stopped(bot, ctl) || !target?.position || !pick.canHit(bot, target, { range: 32 }) || isAlly(bot, target)) return { thrown: false, why: 'unseen_target' }
  let unsafe = unsafeSplash(bot, target, allies)
  if (unsafe) return { thrown: false, why: unsafe }
  const item = bot.inventory.items().find(i => i.name === 'splash_potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === kind)
  if (!item) return { thrown: false, why: 'missing_potion' }
  if (!await holdPotion(bot, item)) return { thrown: false, why: 'wrong_potion' }
  const result = await throwAt(bot, () => target.position.offset(0, .1, 0), { item: bot.heldItem, jump: 'auto', onAim: shot => {
    if (stopped(bot, ctl) || target.isValid === false || isAlly(bot, target) || !pick.canHit(bot, target, { range: 32 }) || potionOf(bot.heldItem) !== potionOf(item)) return false
    unsafe = unsafeSplash(bot, target, allies, shot)
    return !unsafe
  } })
  return unsafe ? { ...result, why: unsafe } : result
}

/** Cluster healing after separation; allied HP is team telemetry, enemy HP is never inspected. */
export async function splashMedic(bot: any, allies: any[], enemies: any[], { delayTicks = 0, ctl }: Timing = {}) {
  await wait(bot, delayTicks)
  if (stopped(bot, ctl)) return { thrown: false, why: 'cancelled' }
  const foes = () => [...enemies, ...allies.filter(isPlayer), ...Object.values<any>(bot.entities || {}).filter(isPlayer)].filter(e =>
    e?.position && e.isValid !== false && e.id !== bot.entity.id && !isAlly(bot, e) && bot.players?.[e.username]?.gamemode !== 3 &&
    e._ndVisible !== false && seesPlayer(bot, e))
  const threats = foes()
  if (threats.some(e => nearSplash(bot, e, bot.entity.position))) return { thrown: false, why: 'enemy_at_launch' }
  const injured = allies.filter(e => e?.position && (!isPlayer(e) || isAlly(bot, e)) && e.health > 0 && e.health < 20 && pick.canHit(bot, e, { range: 6 }))
  const item = bot.inventory.items().find(i => i.name === 'splash_potion' && /^(strong_)?healing$/.test(potionOf(i) || ''))
  if (!item) return { thrown: false, why: 'missing_healing' }
  const heal = instantHeal(potionOf(item) === 'strong_healing' ? 1 : 0)
  let best: { at: Vec3; gain: number } | null = null
  for (let a = 0; a < injured.length; a++) for (let b = a + 1; b < injured.length; b++) {
    const at = injured[a].position.plus(injured[b].position).scaled(.5)
    if (bot.entity.position.distanceTo(at) > 5.5 || threats.some(e => nearSplash(bot, e, at))) continue
    const nearby = injured.filter(e => e.position.distanceTo(at) <= 2)
    if (nearby.length < 2) continue
    const gain = nearby.reduce((sum, e) => sum + Math.min(20 - e.health, heal * (1 - e.position.distanceTo(at) / 4)), 0)
    if (!best || gain > best.gain) best = { at, gain }
  }
  if (!best) return { thrown: false, why: 'no_separated_cluster' }
  if (!await holdPotion(bot, item)) return { thrown: false, why: 'wrong_potion' }
  const at = best.at
  return throwAt(bot, at.offset(0, .1, 0), { item: bot.heldItem, onAim: shot => {
    const land = shot.land?.at
    return !stopped(bot, ctl) && !!land && potionOf(bot.heldItem) === potionOf(item) &&
      injured.filter(e => (!isPlayer(e) || isAlly(bot, e)) && nearSplash(bot, e, land)).length >= 2 &&
      !foes().some(e => nearSplash(bot, e, bot.entity.position) || nearSplash(bot, e, land) || nearSplash(bot, e, at))
  } })
}
