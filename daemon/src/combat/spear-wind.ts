import { Vec3 } from 'vec3'
import * as spear from '../spear'
import * as pick from '../pick'
import * as dm from '../pvp/damage-model'
import * as read from '../read'
import { observePlayerGear, seesPlayer } from '../pvp/last-seen'
import { leadTarget, observedVelocity } from '../bow/track'
import { bodyClear, supportAt } from '../navigation/geometry'
import edges = require('../edges')
import { lanceHits, lanceDamage, lanceCollider, ownSpearHit } from './aerial-lance'
import { allyWorld, allyOnSegment, visibleAllies, isAlly } from './ally-safety'
import { teamWindPlan, worldTick, type WindPairPlan, type WindReport, type WindArena } from './team-wind'

/** HP and nominal 20 Hz time share the ordinary attack's own damage rate; no guessed boost coefficient. */
export function spearWindPrice({ damage, ticks, setupTicks, ordinary, incomingDps, health }: any) {
  const seconds = (setupTicks + ticks) / 20, normalSeconds = ordinary.ticks / 20
  const self = incomingDps * seconds, ordinarySelf = incomingDps * normalSeconds
  // Both participants spend the shared preparation window; the thrower was otherwise idle.
  const rate = (damage - self) / Math.max(.05, seconds + setupTicks / 20)
  const normalRate = Math.max(0, (ordinary.damage - ordinarySelf) / Math.max(.05, normalSeconds))
  return { worth: Number.isFinite(rate) && health > self && rate > normalRate, rate, normalRate, self, healHp: self, seconds, setupTicks, windCharges: 1 }
}

// A native candidate budget, not a combat timer: subsequent fight turns continue at the next candidate using fresh observations.
const searchCursor = new WeakMap<object, { signature: string; next: number }>()
const CANDIDATES_PER_QUERY = 12
const vec = p => new Vec3(p.x, p.y, p.z)
const yawTo = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z))
function contact(bot, e, q, tick, foot, name, sharpness, defense) {
  const at = foot(tick), eye = vec(q.pos).offset(0, 1.62, 0), delta = at.offset(0, pick.hitboxOf(bot, e).h * .55, 0).minus(eye)
  const pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z)), c = Math.cos(pitch)
  const direction = new Vec3(-Math.sin(q.yaw) * c, Math.sin(pitch), -Math.cos(q.yaw) * c)
  const v = vec(q.vel), hisV = foot(tick + 1).minus(at), box = pick.hitboxOf(bot, e)
  if (!lanceHits(eye, direction, v, at, box.h, box.w)) return null
  const raw = lanceDamage(name, direction, v, hisV)
  if (!raw.dmg) return null
  const seen = allyWorld(bot)
  if (!lanceHits(eye, direction, v, at, box.h, box.w, lanceCollider(seen))) return null
  if (allyOnSegment(bot, visibleAllies(bot), eye.plus(direction.scaled(2)), eye.plus(direction.scaled(4.5 + Math.max(0, direction.dot(v)))), tick, 0, .125)) return null
  return { damage: dm.afterDefense(raw.dmg + dm.sharpBonus(sharpness), 'melee', defense), tick, pitch, rel: raw.rel }
}

function contactPrice(bot, plan: WindPairPlan, e, foot, sp, sharpness, defense, ordinary, setup, incomingDps, elapsed = 0) {
  for (let tick = Math.max(1, plan.receiver.boomTick + 1); tick < plan.receiver.steps.length; tick++) {
    const step = plan.receiver.steps[tick - 1], before = tick > 1 ? plan.receiver.steps[tick - 2].pos : plan.receiver.start
    const hit = contact(bot, e, { ...step, vel: vec(step.pos).minus(vec(before)) }, tick, foot, sp.item.name, sharpness, defense)
    if (!hit) continue
    const price = spearWindPrice({ damage: hit.damage, ticks: elapsed + plan.receiver.steps.length, setupTicks: setup, ordinary, incomingDps, health: bot.health })
    if (!price.worth) return false
    plan.spear = { target: e.username, name: sp.item.name, delay: Math.ceil(sp.spec.delay * 20), hitTick: tick, damage: hit.damage, ordinary, price }
    return true
  }
  return false
}

/** Fresh own observations price a remaining native flight, without borrowing the original later contact. */
export function repriceSpearWind(bot: any, plan: WindPairPlan, elapsed: number, incomingDps: number): boolean {
  const attack = plan.spear, e = (Object.values(bot.entities || {}) as any[]).find(e => e.username === attack?.target), sp = spear.spearOf(bot)
  if (!attack || !sp || !e || isAlly(bot, e) || !seesPlayer(bot, e)) return false
  const observed = allyWorld(bot), foot = leadTarget(e, () => observedVelocity(e), observed, 0)
  const gear = observePlayerGear(bot, e), armor = gear.equipment.slice(2).filter(Boolean), defense = dm.defenseOf(armor.map(i => ({ name: i.name })))
  defense.prot = armor.reduce((sum, i) => sum + (i.enchanted ? 4 : 0), 0) + gear.unknownArmorSlots * 4
  return contactPrice(bot, plan, e, foot, sp, read.enchLevel(bot, sp.item, 'sharpness') || 0, defense, attack.ordinary, attack.price.setupTicks, incomingDps, elapsed)
}

/** Reuse the existing whole-flight pair search; accept only a ready native kinetic contact worth its setup. */
export function spearWindPlan(bot: any, report: WindReport, target: string, { arena, incomingDps = 0 }: { arena?: WindArena; incomingDps?: number } = {}) {
  const result = { best: null as WindPairPlan | null, ordinary: null as { damage: number; ticks: number } | null, tried: 0, partial: false, gameTick: worldTick(bot), why: 'no_profitable_safe_spear_wind' }
  const e = (Object.values(bot.entities || {}) as any[]).find(e => e.username === target), sp = spear.spearOf(bot)
  if (!sp || !e || isAlly(bot, e) || !seesPlayer(bot, e) || !(bot.health > 0) || !Number.isFinite(incomingDps) || incomingDps < 0) return result
  const observed = allyWorld(bot), botView = { ...bot, blockAt: observed.blockAt }
  const delay = Math.ceil(sp.spec.delay * 20), setup = delay + 2, sharpness = read.enchLevel(bot, sp.item, 'sharpness') || 0
  const foot = leadTarget(e, () => observedVelocity(e), observed, 0)
  const gear = observePlayerGear(bot, e), armor = gear.equipment.slice(2).filter(Boolean)
  const defense = dm.defenseOf(armor.map(i => ({ name: i.name })))
  defense.prot = armor.reduce((sum, i) => sum + (i.enchanted ? 4 : 0), 0) + gear.unknownArmorSlots * 4
  const state = edges.cloneState(edges.stateOf(bot, edges.IDLE), edges.IDLE), sim = edges.simOf(botView), world = edges.worldOf(botView)
  let ordinary = { damage: 0, ticks: 90 }
  const improve = (damage, ticks) => { if (damage / ticks > ordinary.damage / ordinary.ticks) ordinary = { damage, ticks } }
  for (let tick = 1; tick <= 90; tick++) {
    state.yaw = yawTo(state.pos, foot(tick)); state.control = { ...edges.IDLE, forward: true, sprint: true }
    const before = state.pos.clone()
    sim(state, world)
    if (!bodyClear(botView, state.pos) || state.isInWater || state.isInLava) break
    // ServerPlayer.getKnownSpeed is accepted packet displacement, not next-tick velocity after ground drag.
    const hit = tick >= delay && contact(bot, e, { pos: state.pos, yaw: state.yaw, vel: state.pos.minus(before) }, tick, foot, sp.item.name, sharpness, defense)
    if (hit) improve(hit.damage, tick)
    const actor = { ...botView, entity: { ...bot.entity, position: state.pos, velocity: state.vel } }, target = { ...e, position: foot(tick) }
    for (const item of bot.inventory.items().filter(i => dm.isMeleeWeapon(i.name))) {
      if (!pick.canHit(actor, target, { range: spear.isSpear(item.name) ? 4.5 : 3 })) continue
      const ready = Math.max(tick, Math.ceil(dm.attackDelayTicks(item.name)))
      const sharp = read.enchLevel(bot, item, 'sharpness') || 0
      const raw = spear.isSpear(item.name) ? dm.jabRaw({ weapon: item.name, sharpness: sharp }) : dm.meleeRaw({ weapon: item.name, sharpness: sharp, crit: true })
      improve(dm.afterDefense(raw, 'melee', defense), ready)
    }
  }
  result.ordinary = ordinary
  const projected = foot(setup), bearing = yawTo(bot.entity.position, projected), direction = new Vec3(-Math.sin(bearing), 0, -Math.cos(bearing))
  const cell = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
  const signature = JSON.stringify([target, cell(bot.entity.position), cell(e.position), cell(report.position), sp.item.name])
  const cursor = searchCursor.get(bot), first = cursor?.signature === signature ? cursor.next : 0
  let skip = first
  for (const off of [-3, -1, 1, 3]) {
    const near = projected.plus(direction.scaled(off)), at = new Vec3(Math.floor(near.x) + .5, projected.y, Math.floor(near.z) + .5)
    const support = supportAt(botView, at, .1)
    if (!support) continue
    at.y = support.top
    const proposal = teamWindPlan(botView, report, at, { arena, candidateStart: skip, maxCandidates: CANDIDATES_PER_QUERY - result.tried, accept(plan) {
      return contactPrice(bot, plan, e, tick => foot(setup + tick), sp, sharpness, defense, ordinary, setup, incomingDps)
    } })
    result.tried += proposal.tried
    if (proposal.best) { searchCursor.delete(bot); return { ...result, best: proposal.best, why: undefined } }
    if (proposal.next !== null) { searchCursor.set(bot, { signature, next: first + result.tried }); return { ...result, partial: true } }
    skip = Math.max(0, skip - proposal.considered)
  }
  searchCursor.delete(bot)
  return result
}

/** A real use_item stays held through the received boost; only our damage_event confirms contact. */
export async function braceSpearWind(bot: any, ctl: any, plan: WindPairPlan) {
  const attack = plan.spear!, e = (Object.values(bot.entities || {}) as any[]).find(e => e.username === attack.target)
  const item = bot.inventory.items().find(i => i.name === attack.name)
  if (!item || !e || isAlly(bot, e) || !seesPlayer(bot, e)) return null
  if (bot.heldItem?.name !== attack.name) await bot.equip(item, 'hand')
  if (ctl.aborted || bot.heldItem?.name !== attack.name) return null
  const delta = e.position.offset(0, pick.hitboxOf(bot, e).h * .55, 0).minus(pick.eyeOf(bot))
  const aim = { yaw: Math.atan2(-delta.x, -delta.z), pitch: Math.atan2(delta.y, Math.hypot(delta.x, delta.z)) }
  await bot.look(aim.yaw, aim.pitch, true)
  if (ctl.aborted || !spear.teamSafe(bot) || !seesPlayer(bot, e)) return null
  let hit = false, cancelled = false, received = false
  const damage = pk => { if (received && !cancelled && ownSpearHit(pk, bot.entity.id, e.id)) { hit = true; bot.deactivateItem() } }
  bot._client.on('damage_event', damage)
  // KineticWeapon conditions expire after their native use-duration window. Start a fresh window for the shared preparation.
  if (bot.usingHeldItem) bot.deactivateItem()
  const started = worldTick(bot)
  bot.activateItem()
  return {
    readyAt: started === null ? Infinity : started + attack.delay + 1,
    boosted() { received = true },
    pitch(yaw: number) {
      const d = e.position.offset(0, pick.hitboxOf(bot, e).h * .55, 0).minus(pick.eyeOf(bot))
      const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
      if (!hit && (!bot.usingHeldItem || bot.heldItem?.name !== attack.name || !seesPlayer(bot, e) || !spear.teamSafe(bot) || !spear.teamSafe(bot, yaw, pitch))) { cancelled = true; bot.deactivateItem() }
      return hit || cancelled ? 0 : pitch
    },
    result: () => ({ target: attack.target, hit, cancelled, received, plannedDamage: attack.damage, ordinary: attack.ordinary, price: attack.price }),
    close() { bot._client.removeListener('damage_event', damage); bot.deactivateItem() }
  }
}
