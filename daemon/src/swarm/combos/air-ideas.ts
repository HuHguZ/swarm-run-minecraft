import { Vec3 } from 'vec3'
import * as pick from '../../pick'
import * as read from '../../read'
import * as spear from '../../spear'
import { afterPacket, windReady, offWind } from '../../mace/hands'
import { WIND_CD_MS } from '../../mace/consts'
import { observeCharge } from '../../bow/charge'
import { aimMoving } from '../../bow/ballistics'
import { observedVelocity, hasObservedVelocity } from '../../bow/track'
import { bowShot } from '../../pvp/damage-model'
import { potionOf } from '../../pvp/potions'
import { firstArrow, readyArrow } from '../../ranged'
import { throwAt } from '../../throw'
import { isAlly, visibleAllies, allyOnSegment } from '../../combat/ally-safety'
import { WIND, windLaunch, windMovement } from '../../combat/team-wind'
import { windReleaseSafe } from '../../combat/wind-safety'
import * as clock from '../../game-clock'
import { strike } from './ideas'
import { unsafeSplash } from './splash-safety'
import { damageTypeName } from '../../gamedata'
import { seesPlayer } from '../../pvp/last-seen'

type Control = { aborted: boolean }
export type AirTiming = { ctl?: Control; delayTicks?: number }
export type AllyLaunch = AirTiming & { allowAlly?: boolean; allyHealth?: () => number; allySafe?: () => boolean }
const stopped = (bot: any, ctl?: Control) => !!ctl?.aborted || !bot.entity || !(bot.health > 0)
const wait = async (bot: any, ticks: number, ctl?: Control) => {
  for (let tick = 0; tick < ticks && !stopped(bot, ctl); tick++) await bot.waitForTicks(1)
}
const sees = (bot: any, target: any) => !!target?.position && target.isValid !== false && target.id !== bot.entity?.id && pick.canHit(bot, target, { range: 32 })
function allowed(bot: any, target: any, p: AllyLaunch, damage: number, visible = sees(bot, target)) {
  if (stopped(bot, p.ctl) || target?.id === bot.entity?.id || !visible) return false
  if (!isAlly(bot, target)) return !p.allowAlly
  return p.allowAlly === true && (p.allyHealth?.() ?? 0) > damage && p.allySafe?.() === true
}
const movement = (bot: any) => { const v = bot.entity.velocity.clone(); if (bot.entity.onGround) v.y = 0; return v }
const aligned = (bot: any, shot: any, error = WIND.dispersion) => Math.abs(Math.atan2(Math.sin(bot.entity.yaw - shot.yaw), Math.cos(bot.entity.yaw - shot.yaw))) <= error && Math.abs(bot.entity.pitch - shot.pitch) <= error
const release = (bot: any, action: () => any) => new Promise<any>((resolve, reject) => afterPacket(bot, () => {
  try { resolve(action()) } catch (e) { reject(e) }
}))

/** Explicit allied launches exclude only their consenting receiver from ordinary wind safety. */
export async function windAt(bot: any, target: any, p: AllyLaunch & { predict?: (target: any, velocity: any, flightTicks: number) => Vec3 } = {}) {
  const xyz = (v: any) => v ? { x: v.x, y: v.y, z: v.z } : null
  const snapshot = (velocity?: any) => {
    const visible = seesPlayer(bot, target), v = visible ? velocity ?? observedVelocity(target) : null, own = bot.entity
    const receipt = target?._ndPositionReceipts?.[1]
    return { ms: Date.now(), visible, target: visible ? xyz(target.position) : null,
      v: v ? { ...xyz(v), ageTicks: v.ageTicks ?? null, hasConfidence: hasObservedVelocity(target),
        receiptKind: receipt?.kind ?? null, clockReceiptMs: receipt?.t ?? null } : null,
      own: own ? { position: xyz(own.position), velocity: xyz(own.velocity), movement: xyz(windMovement(bot)),
        onGround: own.onGround, yaw: own.yaw, pitch: own.pitch } : null }
  }
  await wait(bot, p.delayTicks ?? 0, p.ctl)
  if (!allowed(bot, target, p, 1, seesPlayer(bot, target)) || !windReady(bot)) return { fired: false, why: 'unseen_or_unsafe_target' }
  const off = offWind(bot), item = off ? bot.inventory.slots[45] : bot.inventory.items().find(i => i.name === 'wind_charge')
  if (!item) return { fired: false, why: 'missing_charge' }
  if (!off && bot.heldItem?.slot !== item.slot) await bot.equip(item, 'hand')
  await wait(bot, 2, p.ctl)
  if (!allowed(bot, target, p, 1, seesPlayer(bot, target))) return { fired: false, why: 'cancelled_or_changed' }
  const from = pick.eyeOf(bot), v = observedVelocity(target), moved = windMovement(bot)
  let at = target.position.offset(0, .3, 0), shot = windLaunch(from, at, moved)
  for (let i = 0; i < 3 && shot; i++) {
    at = p.predict ? p.predict(target, v, shot.time) : target.position.offset(v.x * shot.time, .3 + v.y * shot.time, v.z * shot.time)
    shot = windLaunch(from, at, moved)
  }
  if (!shot) return { fired: false, why: 'no_intercept' }
  const aim = { ...snapshot(v), from: xyz(from), at: xyz(at),
    shot: { ...shot, velocity: xyz(shot.velocity), direction: xyz(shot.direction) } }
  await bot.look(shot.yaw, shot.pitch, true)
  await wait(bot, 1, p.ctl)
  return release(bot, () => {
    const released = snapshot()
    if (!allowed(bot, target, p, 1, seesPlayer(bot, target))) return { fired: false, why: 'cancelled_or_changed', check: 'target' }
    const now = pick.eyeOf(bot), delta = at.minus(now), length = delta.norm(), actualMove = windMovement(bot)
    const receiver = p.allowAlly ? target.username : undefined
    const check = !allowed(bot, target, p, 1, seesPlayer(bot, target)) ? 'target' : !windReady(bot) ? 'cooldown' : (off ? !offWind(bot) : bot.heldItem?.name !== 'wind_charge') ? 'equip' :
      !aligned(bot, shot) ? 'aim' : !length ? 'intercept' : pick.blockOnRay(bot, now, delta.scaled(1 / length), length) ? 'block' :
        !windReleaseSafe(bot, shot, actualMove, receiver) ? 'wind-team' : null
    if (check) return { fired: false, why: 'release_changed_or_unsafe', check }
    bot.activateItem(off); bot.usingHeldItem = false; bot._ndWindCd = clock.now() + WIND_CD_MS
    return { fired: true, ticks: shot.time, yaw: shot.yaw, pitch: shot.pitch, trace: { aim, release: released } }
  })
}

/** A native acknowledged draw; an allied shot also requires an unenchanted-damage bow and safe runway. */
export async function punchAt(bot: any, target: any, p: AllyLaunch & { drawTicks?: number; foe?: any } = {}) {
  const wanted = p.drawTicks ?? 6
  if (!Number.isInteger(wanted) || wanted < 3 || wanted > 20) return { fired: false, why: 'invalid_draw' }
  await wait(bot, p.delayTicks ?? 0, p.ctl)
  if (!allowed(bot, target, p, 0)) return { fired: false, why: 'unseen_or_unsafe_target' }
  // shortcut: stationary archers only; use accepted movement packets before testing moving archers.
  const anchor = bot.entity.position.clone()
  const stationary = () => !stopped(bot, p.ctl) && bot.entity.onGround && bot.entity.position.equals(anchor) && bot.entity.velocity.x === 0 && bot.entity.velocity.z === 0
  if (!stationary()) return { fired: false, why: 'moving_archer_not_supported' }
  const bow = bot.inventory.items().find(i => i.name === 'bow' && read.enchLevel(bot, i, 'punch') > 0 &&
    (!p.allowAlly || !read.enchLevel(bot, i, 'flame') && !read.enchLevel(bot, i, 'power')))
  const plain = bot.inventory.items().find(i => i.name === 'arrow')
  if (!bow || !plain || !await readyArrow(bot, plain)) return { fired: false, why: 'missing_safe_bow_or_arrow' }
  await bot.equip(bow, 'hand'); await wait(bot, 2, p.ctl)
  if (!allowed(bot, target, p, 0) || !stationary()) return { fired: false, why: 'cancelled_or_changed' }
  const charge = observeCharge(bot)
  let fired = false
  try {
    if (!charge.start()) return { fired: false, why: charge.why() }
    for (let tick = 0; tick < wanted + 40 && !charge.ready(wanted) && !charge.why() && stationary() && allowed(bot, target, p, 0); tick++) await wait(bot, 1, p.ctl)
    const confirmedTicks = charge.snapshot().confirmedTicks
    if (!charge.ready(wanted) || !stationary() || !allowed(bot, target, p, 0)) return { fired: false, why: charge.why() || 'draw_not_confirmed_or_cancelled' }
    if (p.allowAlly && (!p.foe?.position || (bot.entity.position.x - target.position.x) * (p.foe.position.x - target.position.x) +
      (bot.entity.position.z - target.position.z) * (p.foe.position.z - target.position.z) >= 0)) return { fired: false, why: 'not_behind_ally' }
    const from = pick.eyeOf(bot).offset(0, -.1, 0), v = observedVelocity(target), moved = movement(bot), speed = bowShot(confirmedTicks).speed
    const sol = aimMoving(from, ticks => target.position.offset(v.x * ticks, .9 + v.y * ticks, v.z * ticks), moved, !bot.entity.onGround, speed)
    if (!sol) return { fired: false, why: 'no_intercept' }
    let maxRawDamage = 0
    const safe = () => {
      if (!stationary() || !allowed(bot, target, p, 0) || firstArrow(bot)?.name !== 'arrow' || bot.heldItem?.slot !== bow.slot) return false
      const others = visibleAllies(bot).filter(e => !p.allowAlly || e.id !== target.id)
      let pos = pick.eyeOf(bot).offset(0, -.1, 0), vel = new Vec3(-Math.sin(sol.yaw) * Math.cos(sol.pitch), Math.sin(sol.pitch), -Math.cos(sol.yaw) * Math.cos(sol.pitch)).scaled(speed).plus(movement(bot))
      maxRawDamage = 0
      for (let t = 0; t < Math.ceil(sol.ticks) || others.length && pos.y >= (bot.game?.minY ?? -64); t++) {
        const fraction = t < Math.ceil(sol.ticks) ? Math.min(1, sol.ticks - t) : 1
        const duration = others.length ? 1 : fraction, len = vel.norm()
        const block = len && pick.blockOnRay(bot, pos, vel.scaled(1 / len), len * duration)
        if (block && t < Math.ceil(sol.ticks) && block.t <= len * fraction) return false
        const checked = block ? block.t / len : duration, step = vel.scaled(checked)
        const spread = speed * WIND.dispersion * Math.sqrt(3)
        if (allyOnSegment(bot, others, pos, pos.plus(step), t, checked, Math.fround(.3) + spread * (1 - .99 ** (t + 1)) / .01)) return false
        if (t < Math.ceil(sol.ticks)) {
          const base = Math.ceil((vel.norm() + spread * .99 ** t) * 2)
          maxRawDamage = Math.max(maxRawDamage, base + (confirmedTicks >= 20 ? Math.floor(base / 2) + 1 : 0))
        }
        if (block) break
        pos = pos.plus(vel); vel = new Vec3(vel.x * .99, vel.y * .99 - .05, vel.z * .99)
      }
      return allowed(bot, target, p, maxRawDamage)
    }
    if (!safe()) return { fired: false, why: 'blocked_trajectory' }
    await bot.look(sol.yaw, sol.pitch, true)
    await wait(bot, 1, p.ctl)
    return await release(bot, () => {
      const releasedTicks = charge.snapshot().confirmedTicks
      if (!safe() || !aligned(bot, sol) || !charge.ready(wanted) || bowShot(releasedTicks).speed !== speed) return { fired: false, why: 'release_changed_or_unsafe' }
      charge.close(); bot.deactivateItem(); fired = true
      return { fired: true, confirmedTicks: releasedTicks, drawTicks: wanted, ticks: sol.ticks, maxRawDamage }
    })
  } finally { if (fired) charge.close(); else charge.cancel() }
}

/** The server decides smash eligibility; Slow Falling still receives an ordinary attack attempt. */
export async function maceDive(bot: any, target: any, { ctl, delayTicks = 0, maxTicks = 80 }: AirTiming & { maxTicks?: number } = {}) {
  await wait(bot, delayTicks, ctl)
  if (stopped(bot, ctl) || !sees(bot, target) || isAlly(bot, target)) return { sent: false, why: 'unseen_target' }
  const mace = bot.inventory.items().find(i => i.name === 'mace')
  if (!mace) return { sent: false, why: 'missing_mace' }
  if (bot.heldItem?.slot !== mace.slot) await bot.equip(mace, 'hand')
  let peak = bot.entity.position.y
  try {
    for (let tick = 0; tick < maxTicks && !stopped(bot, ctl) && target.isValid !== false && !isAlly(bot, target); tick++) {
      peak = Math.max(peak, bot.entity.position.y)
      if (!sees(bot, target)) return { sent: false, why: 'lost_sight' }
      const delta = target.position.minus(bot.entity.position), horizontal = Math.hypot(delta.x, delta.z)
      await bot.lookAt(target.position.offset(0, .9, 0), true)
      bot.setControlState('forward', horizontal > .6); bot.setControlState('sprint', false)
      if (bot.entity.velocity.y < 0 && pick.aim(bot, target)?.point) {
        const observedDrop = peak - bot.entity.position.y, ownVy = bot.entity.velocity.y
        const hit = await release(bot, () => strike(bot, target, { ctl }))
        return { ...hit, observedDrop, ownVy, tick }
      }
      if (bot.entity.onGround) return { sent: false, why: 'landed_without_contact' }
      await wait(bot, 1, ctl)
    }
    return { sent: false, why: stopped(bot, ctl) ? 'cancelled' : 'contact_timeout' }
  } finally { bot.setControlState('forward', false); bot.setControlState('sprint', false) }
}

/** Hold real KineticWeapon use while another actor launches us; no simulated damage counts as a hit. */
export async function chargedSpear(bot: any, target: any, { ctl, delayTicks = 0, maxTicks = 80, stand = true }: AirTiming & { maxTicks?: number; stand?: boolean } = {}) {
  let firstReceipt: { ms: number; tick: number; packet: any } | null = null
  const report = (result: any) => ({ ...result, contactObserved: firstReceipt !== null, firstReceipt,
    endReason: result.why === 'contact_timeout' ? 'max_ticks' : result.why })
  await wait(bot, delayTicks, ctl)
  if (stopped(bot, ctl) || !sees(bot, target) || isAlly(bot, target)) return report({ started: false, why: 'unseen_target' })
  const item = bot.inventory.items().find(i => spear.isSpear(i.name))
  if (!item) return report({ started: false, why: 'missing_spear' })
  await bot.equip(item, 'hand'); bot.deactivateItem(); await wait(bot, 3, ctl)
  if (stopped(bot, ctl) || !sees(bot, target) || isAlly(bot, target)) return report({ started: false, why: 'cancelled_or_changed' })
  const readyTicks = Math.round(spear.SPEARS[item.name].delay * 20)
  let ticks = 0, why = 'contact_timeout'
  await bot.lookAt(target.position.offset(0, .9, 0), true)
  if (stopped(bot, ctl) || !sees(bot, target) || isAlly(bot, target) || !spear.teamSafe(bot)) return report({ started: false, why: 'cancelled_or_unsafe_ray' })
  spear.install(bot)
  const ownLife = bot.entity, targetId = target.id, tracked = bot.entities?.[targetId] === target
  let observing = true
  const receipt = (packet: any) => {
    const current = bot.entities?.[targetId]
    // Action cancellation can precede its public hit packet; observe it until this own-life scope detaches.
    if (!observing || firstReceipt || stopped(bot) || bot.entity !== ownLife || target.id !== targetId || target.isValid === false ||
      ((tracked || current) && current !== target) || bot.heldItem?.name !== item.name || isAlly(bot, target) ||
      packet?.entityId !== targetId || packet.sourceCauseId !== ownLife.id + 1 || packet.sourceDirectId !== ownLife.id + 1 ||
      damageTypeName(packet.sourceTypeId) !== 'spear') return
    firstReceipt = { ms: Date.now(), tick: ticks, packet: { ...packet } }
  }
  const detach = () => {
    observing = false
    bot._client.removeListener('damage_event', receipt)
    for (const event of ['end', 'death', 'respawn']) bot.removeListener(event, detach)
    bot.removeListener('entityGone', targetChanged); bot.removeListener('entitySpawn', targetChanged)
  }
  const targetChanged = (entity: any) => { if (entity === target || entity?.id === targetId) detach() }
  bot._client.on('damage_event', receipt)
  for (const event of ['end', 'death', 'respawn']) bot.on(event, detach)
  bot.on('entityGone', targetChanged); bot.on('entitySpawn', targetChanged)
  try {
    bot.activateItem()
    for (; ticks < maxTicks && !stopped(bot, ctl); ticks++) {
      if (!sees(bot, target) || isAlly(bot, target)) { why = 'lost_sight'; break }
      await bot.lookAt(target.position.offset(0, .9, 0), true)
      if (!spear.teamSafe(bot)) { why = 'ally_on_spear_ray'; break }
      bot.setControlState('jump', stand && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < .5)
      await wait(bot, 1, ctl)
    }
    return report({ started: true, ticks, readyTicks, why: stopped(bot, ctl) ? 'cancelled' : why })
  } finally {
    detach()
    try { bot.deactivateItem() } finally { bot.setControlState('jump', false) }
  }
}

/** One existing physics-planned flight, delayed by native ticks for the second echelon. */
export async function aerialPass(bot: any, target: any, { ctl, delayTicks = 0, maxTicks = 300, arena = null, vel = () => observedVelocity(target) }: AirTiming & { maxTicks?: number; arena?: any; vel?: () => any } = {}) {
  await wait(bot, delayTicks, ctl)
  if (stopped(bot, ctl) || !sees(bot, target) || isAlly(bot, target)) return { ok: false, why: 'unseen_target' }
  const flight = { get aborted() {
    const use = bot._ndUse?.cur, active = use ? use.hand === 0 && use.name === bot.heldItem?.name : bot.usingHeldItem
    return !!(stopped(bot, ctl) || !sees(bot, target) || isAlly(bot, target) || active && spear.isSpear(bot.heldItem?.name) && !spear.teamSafe(bot))
  } }
  return (require('../../combat/aerial-lance') as typeof import('../../combat/aerial-lance')).lance(bot, flight, target,
    { maxMs: maxTicks * 50, passes: 1, arena, vel, telemetryHp: () => null })
}

export async function slowFallingAt(bot: any, target: any, { ctl, delayTicks = 0, allies = [] }: AirTiming & { allies?: any[] } = {}) {
  await wait(bot, delayTicks, ctl)
  if (stopped(bot, ctl) || !sees(bot, target) || isAlly(bot, target)) return { thrown: false, why: 'unseen_target' }
  const unsafe = unsafeSplash(bot, target, allies)
  if (unsafe) return { thrown: false, why: unsafe }
  const item = bot.inventory.items().find(i => i.name === 'splash_potion' && /^(long_)?slow_falling$/.test(potionOf(i) || ''))
  if (!item) return { thrown: false, why: 'missing_slow_falling' }
  await bot.equip(item, 'hand')
  return throwAt(bot, () => target.position.offset(0, .1, 0), { item, jump: 'auto', onAim: shot => !stopped(bot, ctl) && sees(bot, target) &&
    !isAlly(bot, target) && potionOf(bot.heldItem) === potionOf(item) && !unsafeSplash(bot, target, allies, shot) })
}
