import { evaluateAerial, type AerialDecision, type AerialActor } from './aerial-graph'
import { beginAerialRecovery } from './aerial-recovery'

const clock = require('../game-clock')
const Vec3 = require('vec3')
const spear = require('../spear')
const pick = require('../pick')
const pearls = require('../pearl-hop')
const projectiles = require('../throw')
const bow = require('../bow')
const ranged = require('../ranged')

interface FlightControl { aborted: boolean }
interface FlightOperations {
  enemy(): any
  worldOf(bot: any): any
  kit(bot: any): { elytra: boolean; rockets: number; mace: boolean; chest: boolean }
  landingSpot(bot: any, world: any, options: any): any
  gliding(entity: any): boolean
  predictGlider(entity: any, velocity: any, ticks: number): any
  takeoff(bot: any, ctl: FlightControl, options: any): Promise<any>
  fly(bot: any, ctl: FlightControl, options: any): Promise<any>
  land(bot: any, ctl: FlightControl, options: any): Promise<any>
  swapChest(bot: any, name: string, options?: any): Promise<any>
  startGlide(bot: any): boolean
  allow(): void
  used(name: string): void
  stats: Record<string, any>
}

export function createAerialCombat(bot: any, operations: FlightOperations) {
  const { stats, enemy } = operations
  let landing: any = null
  let landingAt = -Infinity
  let landingTarget = -1
  let pearlAt = -Infinity
  let rangedAt = -Infinity
  const actor = (entity: any, velocity = entity?.velocity): AerialActor => ({
    id: entity.id, position: entity.position, velocity: velocity ?? { x: 0, y: 0, z: 0 },
    flying: operations.gliding(entity), grounded: !!entity.onGround, alive: entity.isValid !== false
  })
  const valid = (ctl: FlightControl, id: number) => !ctl.aborted && bot.health > 0 && enemy()?.id === id && enemy()?.isValid !== false
  const safeLanding = (target: any) => {
    if (clock.now() - landingAt < 250 && landingTarget === target?.id) return landing
    const world = operations.worldOf(bot)
    const near = target?.position ?? bot.entity.position
    const floor = world.floorBelow(near.x, near.y + 1, near.z, 160)
    landing = floor && !floor.lava && !floor.water
      ? operations.landingSpot(bot, world, { near, floorY: floor.top, radius: 12 }) : null
    landingAt = clock.now()
    landingTarget = target?.id ?? -1
    return landing
  }
  const corridor = (target: any) => {
    if (!target?.position) return false
    const from = pick.eyeOf(bot)
    const to = target.position.offset(0, operations.gliding(target) ? 0.3 : 0.9, 0)
    const d = to.minus(from)
    const distance = d.norm()
    try { return !bot.world.raycast(from, d.scaled(1 / Math.max(distance, 0.001)), distance, (b: any) => b?.boundingBox === 'block') } catch { return false }
  }
  const decide = (ctl: FlightControl = { aborted: false }, ctx: any = {}): AerialDecision => {
    const target = enemy()
    const equipment = operations.kit(bot)
    const inventory = bot.inventory.items()
    const spearItem = inventory.find((item: any) => spear.isSpear(item.name))
    return evaluateAerial({
      self: actor(bot.entity), target: target?.position ? actor(target, ctx.vel?.() ?? target.velocity) : null,
      health: bot.health ?? 20, interrupted: ctl.aborted, safeLanding: safeLanding(target), corridorClear: corridor(target),
      rangedReady: clock.now() - rangedAt >= 1500,
      equipment: { elytra: equipment.elytra, rockets: equipment.rockets,
        chestplate: equipment.chest, mace: equipment.mace, spear: !!spearItem,
        ranged: inventory.some((item: any) => item.name === 'bow') && inventory.some((item: any) => /arrow$/.test(item.name)) || ranged.crossbows(bot).some((entry: any) => entry.info.loaded),
        pearls: clock.now() - pearlAt > 5000 ? inventory.filter((item: any) => item.name === 'ender_pearl').reduce((n: number, item: any) => n + item.count, 0) : 0 },
      maceReady: bot.heldItem?.name === 'mace' && clock.now() - (bot._ndMaceHeldAt ?? clock.now()) >= 1550,
      spearReady: !!spearItem && bot.heldItem?.name === spearItem.name && spear.readyIn(bot, spearItem.name) <= 0,
      fallDistance: bot._ndElytra?.fd ?? 0, pearlDamage: pearls.pearlDamage(bot)
    })
  }
  const remember = (decision: AerialDecision) => {
    const nodes = stats.aerialNodes ?? (stats.aerialNodes = {})
    nodes[decision.node] = (nodes[decision.node] ?? 0) + 1
    bot._ndAerialDecision = decision
  }
  const readyStrike = (decision: AerialDecision, target: any) => {
    if (decision.node === 'SpearStrike') return spear.jabReach(bot, target).ok
    if (decision.node === 'DiveStrike') return pick.canHit(bot, target, { eye: pick.eyeOf(bot), range: 2.9 })
    return decision.node === 'RangedVolley' || decision.node === 'PearlReposition' || decision.node === 'SafeLanding'
  }
  const strikeMace = async (ctl: FlightControl, target: any) => {
    const recoveryDone = beginAerialRecovery(bot, ctl)
    const swapped = await operations.swapChest(bot, 'chest', { hand: 'off' })
    if (!swapped.ok || !valid(ctl, target.id)) { recoveryDone(); return { ok: false, why: 'mace window cancelled' } }
    bot._ndDescend = true
    let hit = false
    try {
      await clock.sleep(50)
      const eye = pick.eyeOf(bot)
      if (valid(ctl, target.id) && bot.entity.velocity.y < 0 && pick.canHit(bot, target, { eye, range: 2.9 })) {
        const aim = pick.aim(bot, target, { eye, range: 2.9 })
        await bot.lookAt(aim.point, true)
        if (valid(ctl, target.id) && pick.canHit(bot, target, { eye, range: 2.9 })) {
          bot.attack(target)
          hit = true
          stats.airSmashes = (stats.airSmashes ?? 0) + 1
          operations.used('midair-mace')
        }
      }
    } finally {
      if (!ctl.aborted && !bot.entity.onGround) {
        await operations.swapChest(bot, 'elytra', { hand: 'off' })
        if (!ctl.aborted) operations.startGlide(bot)
      }
      bot._ndDescend = null
      if (ctl.aborted || bot.entity.onGround) recoveryDone()
    }
    return { ok: hit, hit, why: hit ? 'midair mace attack' : 'target moved out of reach' }
  }
  const reposition = async (ctl: FlightControl, decision: AerialDecision, target: any) => {
    const item = bot.inventory.items().find((item: any) => item.name === 'ender_pearl')
    const at = decision.selected?.target
    if (!item || !at || !valid(ctl, target.id)) return { ok: false }
    const world = pearls.worldOf(bot)
    const result = await projectiles.throwAt(bot, new Vec3(at.x, at.y + 0.1, at.z), {
      item, preferOffhand: true,
      onAim: (shot: any) => {
        const landed = shot.land?.tp && pearls.settle(world, shot.land.tp)
        return valid(ctl, target.id) && bot.health > pearls.pearlDamage(bot) + 8 && !shot.land?.void && landed?.ok && !landed.edge1
      }
    })
    if (result.thrown) { pearlAt = clock.now(); stats.airPearls = (stats.airPearls ?? 0) + 1; operations.used('midflight-pearl') }
    return { ok: !!result.thrown, ...result }
  }
  const fireRanged = async (ctl: FlightControl, target: any, ctx: any) => {
    rangedAt = clock.now()
    const stop = () => {
      if (!valid(ctl, target.id) || bot.health <= 8 || !operations.gliding(bot.entity)) return true
      const flight = require('../elytra').rollout(operations.worldOf(bot), bot.entity.position, bot.entity.velocity,
        bot.entity.yaw, bot.entity.pitch, bot.fireworkRocketDuration ?? 0, 8)
      return !!flight.kind
    }
    const onHit = () => { stats.airArrowHits = (stats.airArrowHits ?? 0) + 1 }
    const crossbow = ranged.crossbows(bot).find((entry: any) => entry.info.loaded)
    const shot = crossbow
      ? await ranged.fire(bot, target, crossbow.item, { velFn: ctx.vel, shouldStop: stop, onHit })
      : await bow.shoot(bot, target, { velFn: ctx.vel, shouldStop: stop, onHit, follow: false })
    if (shot.fired || shot.shot) { stats.airArrows = (stats.airArrows ?? 0) + 1; operations.used('midair-' + (crossbow ? 'crossbow' : 'bow')) }
    return { ok: !!(shot.fired || shot.shot), ...shot, node: 'RangedVolley' }
  }
  const run = async (ctl: FlightControl, ctx: any = {}) => {
    const target = enemy()
    if (!target?.position || !valid(ctl, target.id)) return { ok: false, note: 'aerial target lost' }
    operations.allow()
    if (!operations.gliding(bot.entity)) {
      const launch = await operations.takeoff(bot, ctl, { pitch: 0.45, stats })
      if (!launch.ok || !valid(ctl, target.id)) return launch
    }
    const inventory = bot.inventory.items()
    const weapon = bot.entity.position.y > target.position.y + 3
      ? inventory.find((item: any) => item.name === 'mace')
      : inventory.find((item: any) => spear.isSpear(item.name))
    if (weapon && bot.heldItem?.name !== weapon.name) await bot.equip(weapon, 'hand')
    let decision = decide(ctl, ctx)
    remember(decision)
    if (decision.node === 'SafeLanding') return operations.land(bot, ctl, { at: decision.selected?.target, stats })
    if (decision.node === 'PearlReposition') return reposition(ctl, decision, target)
    if (decision.node === 'RangedVolley') return fireRanged(ctl, target, ctx)
    if (!readyStrike(decision, target)) {
      await operations.fly(bot, ctl, {
        maxMs: 1500, stats,
        goal: () => ({ kind: 'strike', at: (ticks: number) => operations.predictGlider(target, ctx.vel?.() ?? target.velocity ?? { x: 0, y: 0, z: 0 }, ticks), within: 3.5 }),
        until: () => {
          if (!valid(ctl, target.id)) return 'aerial target changed'
          decision = decide(ctl, ctx)
          if (!decision.selected) return 'no safe aerial continuation'
          return readyStrike(decision, target) ? decision.node : null
        },
        rocketIf: (state: any) => bot.entity.position.distanceTo(target.position) > 10 && Math.hypot(state.v.x, state.v.z) < 0.8
      })
      decision = decide(ctl, ctx)
      remember(decision)
    }
    if (!valid(ctl, target.id)) return { ok: false, note: 'aerial interrupted' }
    if (decision.node === 'RangedVolley') return fireRanged(ctl, target, ctx)
    if (decision.node === 'DiveStrike' && readyStrike(decision, target)) return strikeMace(ctl, target)
    if (decision.node === 'SpearStrike' && readyStrike(decision, target)) {
      const result = await spear.jab(bot, target, { abortIf: () => !valid(ctl, target.id) })
      if (result.ok) { stats.airJabs = (stats.airJabs ?? 0) + 1; operations.used('midair-spear') }
      return result
    }
    if (decision.node === 'PearlReposition') return reposition(ctl, decision, target)
    if (decision.node === 'SafeLanding') return operations.land(bot, ctl, { at: decision.selected?.target, stats })
    return { ok: true, note: 'aerial intercept replanned', node: decision.node }
  }
  return { decide, run }
}
