import { Vec3 } from 'vec3'

// Predict the available fall and steering with the same integrator as the real body.
export function chainChoice(bot: any, candidates: any[], { peak = bot.entity.position.y, hp = () => ({ lo: 0, hi: 20 }), velocity = () => ({ x: 0, y: 0, z: 0 }), arena = null, launch = false }: any = {}) {
  const mace: typeof import('../mace') = require('../mace'), dm: typeof import('../pvp/damage-model') = require('../pvp/damage-model')
  const { seesPlayer, visiblePlayerItem }: typeof import('../pvp/last-seen') = require('../pvp/last-seen')
  const observed = (require('../pvp/search') as typeof import('../pvp/search')).observedCollision(bot)
  const world = { getBlock: p => observed.blockAt(p) }
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
    const entity = { id: raw.id, username: raw.username, name: raw.name, type: raw.type, position: raw.position, width: raw.width, height: raw.height, yaw: raw.yaw, isValid: raw.isValid, equipment: gear, metadata }
    if (mace.shieldAtUs(bot, entity)) continue
    const targetVelocity = velocity(entity), state = (require('../edges') as typeof import('../edges')).stateOf(bot)
    if (launch) {
      const support = (require('../navigation/geometry') as typeof import('../navigation/geometry')).supportAt(observed, state.pos, .05)
      if (!state.onGround || !support) continue
      state.control = { forward: false, back: false, left: false, right: false, jump: true, sprint: false, sneak: false }
      try { sim(state, world); sim(state, world) } catch { continue }
      const burst = new Vec3(state.pos.x, support.top + .25, state.pos.z)
      state.vel = state.vel.plus((require('./team-wind') as typeof import('./team-wind')).windImpulse(bot, state.pos, burst))
      state.control.jump = false
    }
    let top = Math.max(peak, state.pos.y), contact = null
    for (let t = 1; t <= 100; t++) {
      const at = entity.position.offset((targetVelocity.x || 0) * t, (targetVelocity.y || 0) * t, (targetVelocity.z || 0) * t)
      const dx = at.x - state.pos.x, dz = at.z - state.pos.z
      state.yaw = Math.atan2(-dx, -dz)
      state.control = { forward: Math.hypot(dx, dz) > .75, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
      try { sim(state, world) } catch { break }
      if (arena && (Math.abs(state.pos.x - arena.x) + .3 > arena.r || Math.abs(state.pos.z - arena.z) + .3 > arena.r || state.pos.y <= (arena.killY ?? -64))) { contact = null; break }
      top = Math.max(top, state.pos.y)
      const eye = state.pos.offset(0, 1.62, 0)
      const reach = Math.hypot(Math.max(0, Math.abs(eye.x - at.x) - .3), Math.max(0, eye.y - at.y - 1.8, at.y - eye.y), Math.max(0, Math.abs(eye.z - at.z) - .3))
      if (state.vel.y < 0 && top - state.pos.y > 1.6 && reach < mace.REACH - .1) contact = { fall: top - state.pos.y, ticks: t }
      if (state.onGround || state.isInLava || state.isInWater) break
    }
    if (!contact) continue
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
