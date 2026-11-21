import { Vec3 } from 'vec3'
import * as pick from '../pick'
import { bodyClear, supportAt } from '../navigation/geometry'
import { landingDamage } from '../navigation/landing'
import { burnAt, NO_KEYS, reachFrom } from '../mace/world'
import { descentSteering } from '../mace/descend'

// Predict the available fall and steering with the same integrator as the real body.
export function chainChoice(bot: any, candidates: any[], { peak = bot.entity.position.y, hp = () => ({ lo: 0, hi: 20 }), velocity = () => ({ x: 0, y: 0, z: 0 }), arena = null, launch = false, safeLanding = false, upperApproach = false }: any = {}) {
  const mace: typeof import('../mace') = require('../mace'), dm: typeof import('../pvp/damage-model') = require('../pvp/damage-model')
  const { seesPlayer, visiblePlayerItem }: typeof import('../pvp/last-seen') = require('../pvp/last-seen')
  const observed = (require('../pvp/search') as typeof import('../pvp/search')).observedCollision(bot)
  const world = { getBlock: p => observed.blockAt(p) }
  const unknown = { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
  const aimWorld = { entity: bot.entity, registry: bot.registry, blockAt: p => observed.blockAt(p) || unknown }
  const sim = (bot._ndSimOrig || bot.physics?.simulatePlayer)?.bind(bot.physics)
  if (!sim) return null
  const ownMace = bot.inventory.items().find(it => it.name === 'mace')
  if (!ownMace) return null
  const read: typeof import('../read') = require('../read'), ench = name => read.enchLevel(bot, ownMace, name)
  let best = null
  for (const raw of candidates) {
    if (!raw?.position || raw.isValid === false || raw.id === bot.entity.id || !seesPlayer(bot, raw)) continue
    const gear = (raw.equipment || []).map(visiblePlayerItem)
    const metadata = []; metadata[0] = raw.metadata?.[0]; metadata[8] = raw.metadata?.[8]
    const entity = { id: raw.id, uuid: raw.uuid, username: raw.username, name: raw.name, type: raw.type, position: raw.position, width: raw.width, height: raw.height, yaw: raw.yaw, isValid: raw.isValid, equipment: gear, metadata }
    if (mace.shieldAtUs(bot, entity)) continue
    const targetBox = pick.hitboxOf(bot, raw)
    const projected = { ...entity, width: targetBox.w, height: targetBox.h }
    // The PvP observer tracks motion on the visible candidate, not on the gear snapshot.
    const targetVelocity = velocity(raw), state = (require('../edges') as typeof import('../edges')).stateOf(bot)
    const raised = launch && safeLanding && (upperApproach || entity.position.y > state.pos.y + 1)
    if (raised && !supportAt(observed, entity.position, .05)) continue
    let impulseY: number | undefined
    if (launch) {
      const support = supportAt(observed, state.pos, .05)
      if (!state.onGround || !support) continue
      state.control = { forward: false, back: false, left: false, right: false, jump: true, sprint: false, sneak: false }
      try { sim(state, world); sim(state, world) } catch { continue }
      impulseY = state.pos.y
      const burst = new Vec3(state.pos.x, support.top + .25, state.pos.z)
      state.vel = state.vel.plus((require('./team-wind') as typeof import('./team-wind')).windImpulse(bot, state.pos, burst))
      state.control.jump = false
    }
    let top = Math.max(peak, state.pos.y), contact = null, landed = false, braking = false
    for (let t = 1; t <= 100; t++) {
      const at = entity.position.offset((targetVelocity.x || 0) * t, (targetVelocity.y || 0) * t, (targetVelocity.z || 0) * t)
      const dx = at.x - state.pos.x, dz = at.z - state.pos.z
      if (raised && (braking || contact && t > contact.ticks + 1)) {
        state.control = { ...NO_KEYS }
      } else if (raised) {
        // The executor steers to the near side for a swing. Landing on the target's cell proves nothing about that lip.
        const steering = descentSteering(state.pos, state.vel, at, targetVelocity, state.yaw)
        state.yaw = steering.yaw
        state.control = steering.keys
      } else {
        state.yaw = Math.atan2(-dx, -dz)
        state.control = { forward: Math.hypot(dx, dz) > .75, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
      }
      try { sim(state, world) } catch { break }
      if (arena && (Math.abs(state.pos.x - arena.x) + .3 > arena.r || Math.abs(state.pos.z - arena.z) + .3 > arena.r || state.pos.y <= (arena.killY ?? -64))) { contact = null; break }
      if (safeLanding && !bodyClear(observed, state.pos)) break
      // Native gravity can already make vel.y negative on touchdown. The executor has lost the smash by that tick.
      if (state.onGround || state.isInLava || state.isInWater) {
        // Repricing runs before the current movement packet. A target can still be struck in the
        // present airborne frame even though the first forecast step has already reached the floor.
        if (t === 1 && !launch && state.onGround && !state.isInLava && !state.isInWater &&
            !bot.entity.onGround && bot.entity.velocity.y < 0 && peak - bot.entity.position.y > 1.6) {
          const eye = pick.eyeOf(bot)
          if (reachFrom(eye, projected, bot) <= mace.REACH - .05 && pick.canHit(aimWorld, projected, { eye, range: mace.REACH }))
            contact = { fall: peak - bot.entity.position.y, ticks: 0 }
        }
        if (safeLanding && state.onGround && !state.isInLava && !state.isInWater) {
          const floor = supportAt(observed, state.pos, .04)
          const safe = !!floor && !burnAt(observed, state.pos) &&
            landingDamage(floor.block, top - state.pos.y, bot.entity.attributes, impulseY === undefined ? Infinity : impulseY - state.pos.y) === 0
          if (safe && raised && Math.hypot(state.vel.x, state.vel.z) > .003) { braking = true; continue }
          landed = safe
        }
        break
      }
      if (braking) break // The remaining horizontal impulse carried the body off its landing.
      top = Math.max(top, state.pos.y)
      const eye = state.pos.offset(0, 1.62, 0)
      const reach = Math.hypot(Math.max(0, Math.abs(eye.x - at.x) - projected.width / 2), Math.max(0, eye.y - at.y - projected.height, at.y - eye.y), Math.max(0, Math.abs(eye.z - at.z) - projected.width / 2))
      projected.position = at
      // A visible opponent can still be behind glass or bars at the predicted contact.
      const fall = top - state.pos.y
      if (state.vel.y < 0 && fall > 1.6 && reach < mace.REACH - .1 && (!raised || !contact) &&
          pick.canHit(aimWorld, projected, { eye, range: mace.REACH })) {
        if (raised) {
          const nextEye = eye.plus(state.vel)
          const next = { ...projected, position: at.offset(targetVelocity.x || 0, targetVelocity.y || 0, targetVelocity.z || 0) }
          if (!supportAt(observed, state.pos, .05 - state.vel.y) && reachFrom(nextEye, next) <= mace.REACH - .1 && fall <= 14) continue
        }
        contact = { fall, ticks: t }
      }
    }
    if (!contact || safeLanding && !landed) continue
    const armor = gear.slice(2, 6).filter(Boolean), def = dm.defenseOf(armor)
    const heldTicks = bot._ndMaceHeldAt ? Math.max(0, ((require('../game-clock') as typeof import('../game-clock')).now() - bot._ndMaceHeldAt) / 50) : 0
    const rawDamage = mace.smashDamage(contact.fall, { base: 6, charge: Math.min(1, (heldTicks + contact.ticks) / 33), density: ench('density') })
    const min = dm.afterDefense(rawDamage, 'melee', { ...def, prot: armor.filter(it => it.enchanted).length * 4 }, { breach: ench('breach') })
    const max = dm.afterDefense(rawDamage, 'melee', def, { breach: ench('breach') })
    const health = hp(entity) || { lo: 0, hi: 20 }, lethal = min >= Math.max(1, health.hi)
    const danger = dm.attackDamage(gear[0]?.name) + def.armor + def.tough + (gear.some(it => it?.enchanted) ? 5 : 0)
    const score = (lethal ? 1000 + danger * 10 : Math.min(1, min / Math.max(1, health.hi)) * 100) - contact.ticks * .1
    if (!best || score > best.score) best = { entity, ...contact, damage: { min, max }, health, lethal, danger, score }
  }
  return best
}
