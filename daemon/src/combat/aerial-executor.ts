import { evaluateAerial, type AerialDecision, type AerialActor } from './aerial-graph'
import { beginAerialRecovery } from './aerial-recovery'

import * as clock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as spear from '../spear'
import pick = require('../pick')
import * as pearls from '../pearl-hop'
import * as projectiles from '../throw'
import bow = require('../bow')
import * as ranged from '../ranged'
import { fallStep, reachFromBox } from '../elytra/physics'
import { EYE, BODY_H, REACH, TICK_MS, RESCUE_ROCKETS } from '../elytra/consts'
import { flightControl } from '../elytra/install'
import { rocketForecast } from '../elytra/rocket-forecast'
import { usingOf } from '../pvp/combat-observe'
import { windInside, type WindArena } from './team-wind'

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
  arena?: WindArena
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
  const shielded = (target: any) => usingOf(bot, target)?.name === 'shield'
  const maceReady = () => bot.heldItem?.name === 'mace' && clock.now() - (bot._ndMaceHeldAt ?? clock.now()) >= 33 * TICK_MS
  // Сбрасываем элитры по прогнозу свободного падения, а не ждём разгона в glide.
  const dropWindow = (target: any, velocity = target?.velocity, initialFall = 0) => {
    if (!target?.position || target._ndVisible === false || operations.gliding(target) || shielded(target)) return false
    const world = operations.worldOf(bot), p = { ...bot.entity.position }, v = { ...bot.entity.velocity }
    const tv = velocity ?? { x: 0, y: 0, z: 0 }
    let fall = initialFall
    for (let ticks = 0; ticks <= 40; ticks++) {
      if (!windInside(p, operations.arena) || world.boxHit(p.x, p.y, p.z, BODY_H)) return false
      const at = new Vec3(target.position.x + tv.x * ticks, target.position.y + tv.y * ticks, target.position.z + tv.z * ticks)
      if (p.y <= at.y + .6) return false
      if (v.y < 0 && fall > 1.5 && reachFromBox(new Vec3(p.x, p.y + EYE, p.z), at, .6, pick.hitboxOf(bot, target).h) <= REACH - .25) return true
      const before = { ...p }
      fallStep(p, v); fall += Math.max(0, before.y - p.y)
      // Быстрый снос не должен перескочить стену между двумя тиками.
      const steps = Math.max(1, Math.ceil(Math.hypot(p.x - before.x, p.y - before.y, p.z - before.z) / .35))
      for (let i = 1; i <= steps; i++) {
        const q = new Vec3(before.x + (p.x - before.x) * i / steps, before.y + (p.y - before.y) * i / steps, before.z + (p.z - before.z) * i / steps)
        if (!windInside(q, operations.arena) || world.boxHit(q.x, q.y, q.z, BODY_H)) return false
      }
    }
    return false
  }
  const decide = (ctl: FlightControl = { aborted: false }, ctx: any = {}): AerialDecision => {
    const target = enemy()
    const equipment = operations.kit(bot)
    const inventory = bot.inventory.items()
    const spearItem = inventory.find((item: any) => spear.isSpear(item.name))
    return evaluateAerial({
      self: actor(bot.entity), target: target?.position ? actor(target, ctx.vel?.() ?? target.velocity) : null,
      health: bot.health ?? 20, interrupted: ctl.aborted, safeLanding: safeLanding(target), corridorClear: corridor(target),
      rangedReady: clock.now() - rangedAt >= 1500 && !!target?.position && bow.hasObservedVelocity(target),
      // A new takeoff cannot spend the reserve kept by its executor.
      equipment: { elytra: equipment.elytra, rockets: Math.max(0, equipment.rockets - (operations.gliding(bot.entity) ? 0 : RESCUE_ROCKETS)),
        chestplate: equipment.chest, mace: equipment.mace, spear: !!spearItem,
        ranged: inventory.some((item: any) => item.name === 'bow') && inventory.some((item: any) => /arrow$/.test(item.name)) || ranged.crossbows(bot).some((entry: any) => entry.info.loaded),
        pearls: clock.now() - pearlAt > 5000 ? inventory.filter((item: any) => item.name === 'ender_pearl').reduce((n: number, item: any) => n + item.count, 0) : 0 },
      maceDropReady: bot.heldItem?.name === 'mace' && dropWindow(target, ctx.vel?.() ?? target?.velocity),
      maceReady: maceReady(),
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
    if (decision.node === 'DiveStrike') return true
    return decision.node === 'RangedVolley' || decision.node === 'PearlReposition' || decision.node === 'SafeLanding'
  }
  const strikeMace = async (ctl: FlightControl, target: any) => {
    ctl = flightControl(bot, ctl)
    const recoveryDone = beginAerialRecovery(bot, ctl, 2500)
    const mark = { at: clock.now() }
    let hit = false
    bot._ndDescend = mark
    bot._ndElytra.driving = (bot._ndElytra.driving || 0) + 1
    try {
      const swapped = await operations.swapChest(bot, 'chest', { hand: 'off', ctl })
      if (!swapped.ok || !valid(ctl, target.id)) return { ok: false, why: 'mace window cancelled' }
      // После подтверждения нагрудника ждём настоящее падение и видимую рамку.
      for (let ticks = 0; ticks < 40 && valid(ctl, target.id) && !bot.entity.onGround && !operations.gliding(target) && !shielded(target) && bot.heldItem?.name === 'mace'; ticks++) {
        await clock.sleep(TICK_MS)
        operations.allow()
        const eye = pick.eyeOf(bot)
        if (!valid(ctl, target.id) || operations.gliding(target) || shielded(target)) break
        if (bot.entity.elytraFlying) continue
        if (!pick.canHit(bot, target, { eye, range: 2.9 })) {
          if (!dropWindow(target, target.velocity, bot._ndElytra.fd)) break
          continue
        }
        if (bot._ndElytra.fd <= 1.5 || bot.entity.velocity.y >= 0) continue
        const aim = pick.aim(bot, target, { eye, range: 2.9 })
        if (!aim) continue
        await bot.lookAt(aim.point, true)
        if (valid(ctl, target.id) && maceReady() && !operations.gliding(target) && !shielded(target) && !bot.entity.elytraFlying && !bot.entity.onGround && bot._ndElytra.fd > 1.5 && bot.entity.velocity.y < 0 && pick.canHit(bot, target, { range: 2.9 })) {
          bot.attack(target)
          hit = true
          stats.airSmashes = (stats.airSmashes ?? 0) + 1
          operations.used('midair-mace')
          break
        }
      }
    } finally {
      // Отмена может потребовать спасения; новый владелец полёта отзывает и этот свап.
      const recoveryCtl = flightControl(bot, ctl, true)
      try {
        if (!recoveryCtl.aborted && !bot.entity.onGround) {
          const restored = await operations.swapChest(bot, 'elytra', { hand: 'off', ctl: recoveryCtl })
          if (restored.ok && !recoveryCtl.aborted) operations.startGlide(bot)
        }
      } finally {
        if (bot._ndDescend === mark) bot._ndDescend = null
        bot._ndElytra.driving = Math.max(0, bot._ndElytra.driving - 1)
        if (recoveryCtl.aborted || bot.entity.onGround) recoveryDone()
      }
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
      const flight = (require('../elytra') as typeof import('../elytra')).rollout(operations.worldOf(bot), bot.entity.position, bot.entity.velocity,
        bot.entity.yaw, bot.entity.pitch, rocketForecast(bot).boost, 8)
      return !!flight.kind
    }
    const onHit = () => { stats.airArrowHits = (stats.airArrowHits ?? 0) + 1 }
    const crossbow = ranged.crossbows(bot).find((entry: any) => entry.info.loaded)
    const shot = crossbow
      ? await ranged.fire(bot, target, crossbow.item, { velFn: ctx.vel, shouldStop: stop, onHit })
      : await bow.shoot(bot, target, { velFn: ctx.vel, shouldStop: stop, onHit, follow: false })
    if (shot.fired || shot.shot) { stats.airArrows = (stats.airArrows ?? 0) + 1; operations.used('midair-' + (crossbow ? 'crossbow' : 'bow')) }
    return { ok: !!(shot.fired || shot.shot), ...shot, node: 'RangedVolley',
      note: shot.fired || shot.shot ? undefined : 'воздушный залп: ' + (shot.why || 'выстрел не подтверждён') }
  }
  const run = async (ctl: FlightControl, ctx: any = {}) => {
    const target = enemy()
    if (!target?.position || !valid(ctl, target.id)) return { ok: false, note: 'aerial target lost' }
    if (!operations.gliding(bot.entity) && !decide(ctl, ctx).selected) return { ok: false, note: 'воздушный бой: взлёт недоступен' }
    operations.allow()
    if (!operations.gliding(bot.entity)) {
      const launch = await operations.takeoff(bot, ctl, { pitch: 0.45, stats })
      if (!launch.ok || !valid(ctl, target.id)) return launch
    }
    const inventory = bot.inventory.items()
    const weapon = !operations.gliding(target) && !shielded(target) && bot.entity.position.y > target.position.y + 3
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
        maxMs: 1500, stats, phase: 'воздушный бой',
        // Цель «strike» — модель пике с булавой (свап на нагрудник и свободное падение: пол после точки удара не в цене,
        // высота падения — в плюс). Для копья это пике в пол: офлайн (research/claude-1006/s7d/strikesim.js) — касание
        // с высотой падения 5–20 (урон 3–18), в колизее s7d-n-30 — 5 из 10 «fell from a high place» (S7d). Копьё —
        // пролёт мимо его груди (point + reach) над полом (gap), пол и высота падения в цене как у всех полётов.
        goal: () => {
          const at = (ticks: number) => operations.predictGlider(target, ctx.vel?.() ?? target.velocity ?? { x: 0, y: 0, z: 0 }, ticks)
          // Пролёт не вплотную, а в 3 бл. от его груди с моей стороны: копьё бьёт на 2–4.5 бл. (ближе 2 — «мёртвая зона»;
          // s7d-z-27p р.5 — 2 мин «midair-spear» на 1.5–2.3 бл. без попадания, ничья по застою).
          const stand = (ticks: number) => {
            const c = at(ticks).offset(0, 1.2, 0); const m = bot.entity.position
            const dx = m.x - c.x; const dy = m.y + 0.4 - c.y; const dz = m.z - c.z; const n = Math.hypot(dx, dy, dz) || 1
            return c.offset(dx / n * 3, dy / n * 3, dz / n * 3)
          }
          return decision.node === 'DiveStrike' ? { kind: 'strike', at, within: 3.5 } : { kind: 'point', at: stand, reach: true, gap: 1.0 }
        },
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
  const afterLance = async (ctl: FlightControl, ctx: any = {}) => {
    const target = enemy()
    if (!target?.position || !valid(ctl, target.id) || !operations.gliding(bot.entity)) return null
    const equipment = operations.kit(bot)
    const mace = bot.inventory.items().find((item: any) => item.name === 'mace')
    if (!mace || !equipment.chest || operations.gliding(target) || shielded(target) || target._ndVisible === false ||
      bot.entity.position.y <= target.position.y + 3) return null
    const wait = bot.heldItem?.name === 'mace' ? Math.max(0, 33 * TICK_MS - (clock.now() - (bot._ndMaceHeldAt || clock.now()))) : 33 * TICK_MS
    const decision = decide(ctl, ctx)
    // К цене пике графа добавляем заряд; сравниваем с доступным ударом, новым заходом и посадкой.
    const alternative = decision.candidates.find(candidate => candidate.id !== 'DiveStrike' &&
      (candidate.id !== 'SpearStrike' || readyStrike({ node: candidate.id, candidates: [] }, target)))
    const distance = bot.entity.position.distanceTo(target.position)
    if (bot.health <= 8 || !safeLanding(target) || !corridor(target) || !decision.selected ||
      1 + wait / 1000 + distance / 20 >= (alternative?.cost ?? Infinity)) return null
    try {
      if (bot.heldItem?.name !== 'mace') {
        await bot.equip(mace, 'hand')
        bot._ndMaceHeldAt = clock.now()
      }
    } catch { return null }
    const stop = () => !valid(ctl, target.id) || !operations.gliding(bot.entity) || operations.gliding(target) ||
      shielded(target) || bot.heldItem?.name !== 'mace' || bot.health <= 8
    if (stop()) return null
    if (decide(ctl, ctx).node !== 'DiveStrike') await operations.fly(bot, ctl, {
      maxMs: wait + 1500, stats, phase: 'таран: заряд булавы',
      // Пока заряжается, набираем высоту, не ведём незаряженную булаву в пол.
      goal: () => ({ kind: 'point', at: operations.predictGlider(target, ctx.vel?.() ?? target.velocity, 4).offset(0, 7, 0), reach: true, gap: 3 }),
      rocketIf: (state: any) => state.p.y < target.position.y + 4 ? true : null,
      onTick: () => operations.allow(),
      until: () => stop() ? 'пике отменено' : decide(ctl, ctx).node === 'DiveStrike' ? 'булава готова' : null
    })
    const next = decide(ctl, ctx)
    if (stop() || next.node !== 'DiveStrike') return null
    remember(next)
    return strikeMace(ctl, target)
  }
  return { decide, run, afterLance }
}
