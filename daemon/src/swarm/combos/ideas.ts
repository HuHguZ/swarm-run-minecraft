import * as pick from '../../pick'
import { allyAt, isAlly } from '../../combat/ally-safety'
import { IFRAME_TICKS, ticksToCharge, regenInterval } from '../../pvp/damage-model'
import { POTION } from '../../pvp/hp-estimate'
import { potionOf } from '../../pvp/potions'
import { isPlayer } from '../../pvp/rules'
import { createLastSeen, seesPlayer } from '../../pvp/last-seen'
import { aim, KINDS, throwAt } from '../../throw'
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

export type HealReports = Record<string, { hp: number; untilTick: number }>
type Care = { patient: any; reports?: HealReports; clockId?: string }
/** Group practice needs two patients. An assigned medic can also treat one. */
export async function splashMedic(bot: any, allies: any[], enemies: any[], { delayTicks = 0, ctl, care }: Timing & { care?: Care } = {}) {
  await wait(bot, delayTicks)
  if (stopped(bot, ctl)) return { thrown: false, why: 'cancelled' }
  const foes = () => [...new Set([...enemies, ...allies.filter(isPlayer), ...Object.values<any>(bot.entities || {}).filter(isPlayer)])].filter(e =>
    e?.position && e.isValid !== false && e.id !== bot.entity.id && !isAlly(bot, e) && bot.players?.[e.username]?.gamemode !== 3 &&
    e._ndVisible !== false && seesPlayer(bot, e))
  const threats = foes()
  let blocker = threats.find(e => nearSplash(bot, e, bot.entity.position))
  const unsafe = e => ({ thrown: false, why: 'enemy_at_launch', threat: e.username })
  if (blocker) return unsafe(blocker)
  const visible = e => e?.position && e.isValid !== false && e._ndVisible !== false && bot.entity.position.distanceTo(e.position) < 7 &&
    (!care || bot.players?.[e.username]?.entity === e) && (!isPlayer(e) ||
    isAlly(bot, e) && bot.players?.[e.username]?.gamemode !== 3 && seesPlayer(bot, e)) && pick.canHit(bot, e, { range: 6 })
  const deficit = e => {
    if (e === bot.entity) return Math.max(0, 20 - bot.health)
    if (care && !care.reports) return e === care.patient ? Infinity : 0
    const report = care?.reports?.[e.username]
    const hp = care ? report && care.clockId === bot.ndClock?.id && bot.ndClock?.ticks <= report.untilTick && report.hp : e.health
    return Number.isFinite(hp) && hp > 0 ? Math.max(0, 20 - hp) : 0
  }
  const injured = allies.filter(e => visible(e) && deficit(e) > 0)
  if (care && !injured.includes(care.patient)) return { thrown: false, why: 'no_wounded_patient' }
  if (care && bot.health > 0 && bot.health < 20) injured.push(bot.entity)
  const potions = bot.inventory.items().filter(i => i.name === 'splash_potion')
  const item = potions.find(i => /^(strong_)?healing$/.test(potionOf(i) || '')) ||
    (care && potions.find(i => /^(long_|strong_)?regeneration$/.test(potionOf(i) || '')))
  if (!item) return { thrown: false, why: 'missing_healing' }
  const effect = POTION[potionOf(item)!]
  const heal = effect.heal ?? effect.regenTicks / regenInterval(effect.regenAmp)
  let best: { members: any[]; gain: number } | null = null
  const groups: any[][] = []
  for (let a = 0; a < injured.length; a++) for (let b = a + 1; b < injured.length; b++)
    groups.push([injured[a], injured[b]])
  if (care) groups.push([care.patient])
  const center = (a, b) => b ? a.plus(b).scaled(.5) : a
  for (const members of groups) {
    const at = center(members[0].position, members[1]?.position)
    if (bot.entity.position.distanceTo(at) > 5.5) continue
    const nearby = injured.filter(e => e.position.distanceTo(at) < 4)
    if (care ? !nearby.includes(care.patient) : nearby.length < 2) continue
    const threat = threats.find(e => nearSplash(bot, e, at))
    if (threat) { blocker = threat; continue }
    const gain = nearby.reduce((sum, e) => sum + Math.min(deficit(e), heal * (1 - e.position.distanceTo(at) / 4)), 0)
    if (!best || gain > best.gain) best = { members, gain }
  }
  if (!best) return blocker ? unsafe(blocker) : { thrown: false, why: 'no_separated_cluster' }
  const sight = createLastSeen(bot)
  const viewOf = e => e === bot.entity || !isPlayer(e) ? e : sight.observe(e)
  const forecast = (e, ticks) => /^(rel_entity_move|entity_move_look)$/.test(e._ndPositionReceipts?.[1]?.kind) && e._ndPositionReceipts?.[0]
    ? allyAt(bot, e, ticks) : e.position
  const wounded = e => (e === bot.entity || visible(e)) && deficit(e) > 0
  const group = best.members
  try {
    for (const e of [...group, ...threats]) viewOf(e)
    if (!await holdPotion(bot, item)) return { thrown: false, why: 'wrong_potion' }
    blocker = null
    const result = await throwAt(bot, null, { item: bot.heldItem, collideEntities: true, pick: ({ from, moved, airborne }) => {
      if (stopped(bot, ctl) || care && !wounded(care.patient)) return null
      let members = group.filter(wounded)
      if (members.length !== group.length && care) members = [care.patient]
      if (!members.length || !care && members.length < 2) return null
      const [a, b] = members.map(viewOf)
      if (!a || a._ndVisible === false || b?._ndVisible === false) return null
      const target = ticks => center(forecast(a, ticks), b && forecast(b, ticks)).offset(0, .1, 0)
      return aim(from, target, KINDS.splash_potion, moved, airborne)
    }, onAim: shot => {
      const land = shot.land?.at
      if (stopped(bot, ctl) || !land || potionOf(bot.heldItem) !== potionOf(item)) return false
      const ticks = shot.land.ticks
      blocker = foes().find(e => {
        if (nearSplash(bot, e, bot.entity.position) || nearSplash(bot, e, land) || nearSplash(bot, e, shot.sol.at)) return true
        const view = viewOf(e)
        if (!view || view._ndVisible === false) return false
        // Evaluate the same splash against the hitbox displaced by observed motion until impact.
        return nearSplash(bot, view, land.minus(forecast(view, ticks).minus(view.position)))
      })
      if (blocker) return false
      const reached = injured.filter(e => {
        if (!wounded(e)) return false
        const view = viewOf(e)
        return view && view._ndVisible !== false && forecast(view, ticks).distanceTo(land) < 4
      })
      return care ? reached.includes(care.patient) : reached.length >= 2
    } })
    return blocker ? unsafe(blocker) : result
  } finally { sight.close() }
}
