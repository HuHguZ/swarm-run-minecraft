import { PassengerWitness, runBoatTrap, type BoatTrapResult } from './enderman-boat-graph'
type Body = Record<string, any>
import * as clock from '../game-clock'
import pick = require('../pick')
import * as items from '../items'
import perception = require('../perception')
import * as boatPlacement from './boat-placement'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const woods = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo']

export function cheapBoatWood(bot: Body): string | null {
  const stock: Record<string, number> = items.countItems(bot)
  const table = stock.crafting_table || bot.findBlock?.({ matching: (block: Body) => block.name === 'crafting_table', maxDistance: 4 })
  if (!table) return null
  return woods.find(wood => (stock[`${wood}_planks`] || 0) >= 5 ||
    (stock[`${wood}_log`] || 0) + (stock[`stripped_${wood}_log`] || 0) >= 2) || null
}
function dryBase(bot: Body, base: Body & boatPlacement.BoatPosition): boolean {
  if (!boatPlacement.boatBaseVisible(bot, base)) return false
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const floor = bot.blockAt(base.offset(dx, 0, dz))
    if (!floor || floor.boundingBox !== 'block' || /magma|lava|fire|campfire|cactus/.test(floor.name)) return false
    for (let y = 1; y <= 3; y++) {
      const block = bot.blockAt(base.offset(dx, y, dz))
      if (!block || block.boundingBox !== 'empty' || /water|lava|fire/.test(block.name)) return false
    }
  }
  return true
}
export function boatTarget(session: Body): Body | null {
  const bot = session.bot
  if (!bot?.entity || bot.entity.isInWater || bot.entity.isInLava || !bot.entity.onGround || bot.health < 14 ||
    !items.bestWeapon(bot) || (!boatPlacement.boatItem(bot) && !cheapBoatWood(bot))) return null
  const entities = Object.values(bot.entities) as Body[]
  const me = bot.entity.position
  return entities.filter(entity => entity?.name === 'enderman' && entity.isValid !== false && entity.position &&
    entity.position.distanceTo(me) >= 6 && entity.position.distanceTo(me) <= 14 &&
    perception.canSeePoint(bot, entity.position.offset(0, 2.55, 0)))
    .filter(entity => !entities.some(other => other !== entity && other !== bot.entity && other?.position &&
      /^(enderman|zombified_piglin|piglin|piglin_brute|hoglin|zoglin|blaze|skeleton|wither_skeleton|creeper|zombie|husk|spider)$/.test(other.name || '') &&
      other.position.distanceTo(me) < 8))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
}
export async function tryEndermanBoat(session: Body, ctl: Body & boatPlacement.BoatController, target: Body, options: { captureMs?: number; killMs?: number } = {}): Promise<BoatTrapResult> {
  const bot = session.bot
  const me = bot.entity.position
  const dx = target.position.x - me.x; const dz = target.position.z - me.z
  const distance = Math.hypot(dx, dz) || 1
  const base = new Vec3(Math.floor(me.x + dx / distance * 2.2), Math.floor(me.y) - 1, Math.floor(me.z + dz / distance * 2.2))
  const witness = new PassengerWitness()
  const dead = new Set<number>()
  const onPassengers = ({ entityId, passengers }: { entityId: number; passengers: number[] }) => {
    if (Number.isInteger(entityId) && Array.isArray(passengers)) witness.record(entityId, passengers)
  }
  const onDead = (entity: Body) => { if (entity?.id === target.id) dead.add(entity.id) }
  bot._client.on('set_passengers', onPassengers)
  bot.on('entityDead', onDead)
  const valid = () => target.isValid !== false && bot.entities[target.id] === target
  const supported = () => {
    if (!bot.entity?.position) return false
    const floor = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    return !!floor && floor.boundingBox === 'block' && !/magma|lava|fire|campfire|cactus/.test(floor.name) &&
      bot.entity.position.y - floor.position.y - 1 <= .7
  }
  const safe = () => !ctl.aborted && bot.health >= 12 && supported() && !bot.entity.isInLava && !bot.entity.isInWater &&
    !Object.values(bot.entities).some((entry: Body) => entry !== target && entry !== bot.entity && entry?.position &&
      /^(enderman|piglin_brute|hoglin|zoglin|blaze|skeleton|wither_skeleton|creeper|zombie|husk|spider)$/.test(entry.name || '') && entry.position.distanceTo(bot.entity.position) < 6)
  let swingAt = 0
  let boatId: number | undefined
  const previousEncounter = bot._ndEndermanBoatEncounter
  let encounter: Body | undefined
  const result = await runBoatTrap({
    now: () => clock.now(), sleep: (ms: number) => clock.sleep(ms),
    available: () => !!boatPlacement.boatItem(bot), craftable: () => !!cheapBoatWood(bot),
    async craft() {
      const wood = cheapBoatWood(bot)
      if (!wood) return false
      const actions: typeof import('../actions') = require('../actions')
      if ((items.countOf(bot, `${wood}_planks`) || 0) < 5) await actions.craft(session, ctl, { item: `${wood}_planks`, count: 8 })
      await actions.craft(session, ctl, { item: wood === 'bamboo' ? 'bamboo_raft' : `${wood}_boat`, count: 1 })
      return !!boatPlacement.boatItem(bot)
    },
    async place(maxMs: number) {
      if (!dryBase(bot, base) || maxMs <= 0) return null
      try { bot.pathfinder.setGoal(null) } catch {}
      bot.clearControlStates()
      const placed = await boatPlacement.placeBoatOn(session, ctl, { at: base, maxMs })
      boatId = placed.ok ? placed.boat.id : undefined
      if (boatId !== undefined) {
        encounter = { targetId: target.id, boatId,
          expiresAt: clock.now() + (options.captureMs ?? 10000) + (options.killMs ?? 25000), safe }
        bot._ndEndermanBoatEncounter = encounter
      }
      return boatId ?? null
    }, safe, targetValid: valid,
    captured: (boat: number) => !!bot.entities[boat] && witness.has(boat, target.id), dead: () => dead.has(target.id),
    async lure(elapsedMs: number) {
      if (!valid()) return
      const at = target.position.offset(0, elapsedMs < 1200 && target.position.distanceTo(bot.entity.position) > 4 ? 2.55 : .8, 0)
      if (perception.canSeePoint(bot, at)) await bot.lookAt(at, true)
    },
    async attack() {
      const weapon = items.bestWeapon(bot)
      if (!weapon || clock.now() < swingAt || boatId === undefined || !witness.has(boatId, target.id)) return false
      if (!bot.heldItem || bot.heldItem.name !== weapon.name) { await bot.equip(weapon, 'hand'); swingAt = clock.now() + (require('../pvp') as typeof import('../pvp')).cooldownMs(weapon); return false }
      const aim = pick.aim(bot, target, { range: 2.9 })
      if (!aim?.point) return false
      await bot.lookAt(aim.point, true)
      if (!safe() || !valid() || !witness.has(boatId, target.id) || !pick.aim(bot, target, { range: 2.9 })?.point) return false
      bot.attack(target)
      swingAt = clock.now() + (require('../pvp') as typeof import('../pvp')).cooldownMs(weapon)
      return true
    },
    async cleanup() {
      if (bot._ndEndermanBoatEncounter === encounter) bot._ndEndermanBoatEncounter = previousEncounter
      bot._client.removeListener('set_passengers', onPassengers)
      bot.removeListener('entityDead', onDead)
      try { bot.pathfinder.setGoal(null); bot.clearControlStates(); bot.deactivateItem() } catch {}
      const weapon = items.bestWeapon(bot)
      if (weapon && !ctl.aborted) try { await bot.equip(weapon, 'hand') } catch {}
      try { await bot.look(bot.entity.yaw, -.5, true) } catch {}
    }
  }, options)
  return { ...result, observed: { interrupted: !!ctl.aborted, hp: bot.health,
    me: bot.entity?.position, target: target.position, targetValid: valid(),
    boat: boatId === undefined ? null : bot.entities[boatId]?.position,
    by: ctl.interruptedBy, tactics: session.tactics?.snapshot?.() } }
}
