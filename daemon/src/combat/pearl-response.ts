import { predictPearl, planPearlResponse, pearlHeightWorth, type ObservedPearl, type PearlPrediction, type PearlResponsePlan } from './pearl-intercept'

import * as clock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import pick = require('../pick')
import * as pearls from '../pearl-hop'
import * as throws from '../throw'
import mace = require('../mace')
import * as spear from '../spear'
import flight = require('../elytra')
interface Control { aborted: boolean }
interface ResponseOptions {
  enemy(): any
  used(text: string): void
  webAt?(at: any, ctl: Control): Promise<boolean>
}
interface HeightPlan { kind: 'PearlHeightDive'; at: any; teleport: any; enemyId: number; height: number }

export function createPearlResponse(bot: any, options: ResponseOptions) {
  const observed = new Map<number, ObservedPearl>()
  const handled = new Set<number>()
  const stats: Record<string, any> = { predictions: 0, intercepts: 0, counters: 0, traps: 0, heightDives: 0, phases: [] }
  let heightAt = -Infinity
  let nextHeightScan = 0
  const vec = (p: any) => new Vec3(p.x, p.y, p.z)
  const visible = (point: any) => {
    const eye = pick.eyeOf(bot)
    const d = vec(point).minus(eye)
    try { return !bot.world.raycast(eye, d.scaled(1 / Math.max(0.001, d.norm())), d.norm() - 0.15, (b: any) => b?.boundingBox === 'block') } catch { return false }
  }
  const onSpawn = (entity: any) => {
    if (!/^(ender_pearl|thrown_ender_pearl)$/.test(entity?.name ?? '') || !entity.position || !visible(entity.position)) return
    const enemy = options.enemy()
    if (!enemy?.position || enemy.position.distanceTo(entity.position) > 3 || bot.entity.position.distanceTo(entity.position) < 2) return
    observed.set(entity.id, { id: entity.id, ownerId: enemy.id, position: { ...entity.position },
      velocity: { ...(entity.velocity ?? { x: 0, y: 0, z: 0 }) }, observedAt: clock.now(), visible: true, alive: true })
  }
  const onMove = (entity: any) => {
    const old = observed.get(entity?.id)
    if (!old) return
    if (!visible(entity.position)) { observed.delete(entity.id); return }
    const ticks = Math.max(1, (clock.now() - old.observedAt) / 50)
    const velocity = { x: (entity.position.x - old.position.x) / ticks,
      y: (entity.position.y - old.position.y) / ticks, z: (entity.position.z - old.position.z) / ticks }
    observed.set(entity.id, { ...old, position: { ...entity.position }, velocity, observedAt: clock.now() })
  }
  const onGone = (entity: any) => { observed.delete(entity?.id); handled.delete(entity?.id) }
  bot.on('entitySpawn', onSpawn)
  bot.on('entityMoved', onMove)
  bot.on('entityGone', onGone)
  const world = {
    trace(from: any, to: any) {
      const a = vec(from); const d = vec(to).minus(a); const length = d.norm()
      for (let n = 0; n <= Math.ceil(length * 2); n++) {
        const at = a.plus(d.scaled(n / Math.max(1, Math.ceil(length * 2))))
        if (!bot.blockAt(at, false)) return 'unloaded' as const
      }
      const hit = bot.world.raycast(a, d.scaled(1 / Math.max(length, 0.001)), length, (b: any) => b?.boundingBox === 'block')
      return hit ? { point: hit.intersect ?? hit.position.offset(0.5, 1, 0.5) } : null
    }
  }
  const prediction = (id: number): PearlPrediction | null => {
    const seen = observed.get(id)
    if (!seen || handled.has(id) || seen.ownerId !== options.enemy()?.id || !bot.entities[id] || !visible(bot.entities[id].position)) return null
    try { return predictPearl(seen, world, clock.now()) } catch { return null }
  }
  const routeClear = (point: any) => {
    const me = bot.entity.position
    if (Math.abs(point.y - me.y) > 1.5 || bot.entity.elytraFlying) return false
    const W = flight.worldOf(bot)
    const distance = Math.hypot(point.x - me.x, point.z - me.z)
    for (let t = 0; t <= distance; t += 0.7) {
      const fraction = t / Math.max(distance, 0.001)
      const x = me.x + (point.x - me.x) * fraction; const z = me.z + (point.z - me.z) * fraction
      const floor = W.floorBelow(x, me.y + 0.5, z, 2)
      if (!floor || floor.lava || floor.water || Math.abs(floor.top - me.y) > 0.7 || W.boxHit(x, me.y + 0.05, z)) return false
    }
    return true
  }
  const occupied = (point: any) => Object.values(bot.entities).some((entity: any) => entity !== bot.entity && entity.position && entity.type !== 'object' && entity.position.distanceTo(vec(point)) < 1)
  const arrival = (point: any) => {
    try { const result = pearls.settle(pearls.worldOf(bot), point); return result.ok && !result.edge1 } catch { return false }
  }
  const heightPlan = (): HeightPlan | null => {
    if (clock.now() < nextHeightScan || clock.now() - heightAt < 15000 || !bot.entity.onGround || bot.health <= 15) return null
    nextHeightScan = clock.now() + 1500
    const enemy = options.enemy()
    const items = bot.inventory.items()
    if (!enemy?.position || enemy.isValid === false || !items.some((i: any) => i.name === 'ender_pearl') || !items.some((i: any) => i.name === 'mace' || spear.isSpear(i.name))) return null
    const W = flight.worldOf(bot)
    const eye = bot.entity.position.offset(0, 1.52, 0)
    const velocity = bot.entity.velocity ?? { x: 0, y: 0, z: 0 }
    for (let height = 4; height <= 8; height += 2) for (let angle = 0; angle < 8; angle++) {
      const yaw = angle * Math.PI / 4
      const at = enemy.position.offset(Math.sin(yaw) * 3, height + 1, Math.cos(yaw) * 3)
      const block = bot.blockAt(at, false)
      if (!block || block.boundingBox !== 'block') continue
      const sol = throws.aim(eye, at, throws.KINDS.ender_pearl, velocity, false)
      if (!sol) continue
      const landed = throws.landing(bot, eye, sol.yaw, sol.pitch, throws.KINDS.ender_pearl, velocity, false)
      if (!landed?.tp || landed.void) continue
      const tp = landed.tp
      const floor = W.floorBelow(tp.x, tp.y + 0.5, tp.z, 2)
      if (!floor || floor.lava || floor.water || Math.abs(floor.top - tp.y) > 1) continue
      const dx = enemy.position.x - tp.x; const dz = enemy.position.z - tp.z; const d = Math.hypot(dx, dz)
      const exit = tp.offset(dx / Math.max(d, 0.001), 0, dz / Math.max(d, 0.001))
      const exitFloor = W.floorBelow(exit.x, tp.y + 0.5, exit.z, 2)
      const recovery = W.floorBelow(enemy.position.x, enemy.position.y + 0.5, enemy.position.z, 3)
      const safe = pearlHeightWorth({ impact: at, teleport: tp, enemy: enemy.position,
        visible: visible(tp), loaded: true, bodyClear: !W.boxHit(tp.x, tp.y + 0.05, tp.z),
        exitClear: !W.boxHit(exit.x, exit.y + 0.05, exit.z) && (!exitFloor || exitFloor.top < floor.top - 1),
        safeRecovery: !!recovery && !recovery.lava && !recovery.water && bot.health - pearls.pearlDamage(bot) - Math.max(0, height - 3) > 8,
        health: bot.health, pearlDamage: pearls.pearlDamage(bot), hasPearl: true, hasWeapon: true, interrupted: false })
      if (safe) return { kind: 'PearlHeightDive', at, teleport: tp, enemyId: enemy.id, height }
    }
    return null
  }
  const decide = (ctx: any = {}): PearlResponsePlan | HeightPlan | null => {
    if (ctx.interrupted || bot.health <= 8) return null
    for (const [id, seen] of observed) {
      if (clock.now() - seen.observedAt > 1500) { observed.delete(id); continue }
      const predicted = prediction(id)
      if (!predicted) continue
      stats.predictions++
      const items = bot.inventory.items()
      const plan = planPearlResponse(predicted, { position: bot.entity.position, health: bot.health,
        pearlDamage: pearls.pearlDamage(bot), pearls: items.filter((i: any) => i.name === 'ender_pearl').reduce((n: number, i: any) => n + i.count, 0),
        cobwebs: options.webAt ? items.filter((i: any) => i.name === 'cobweb').reduce((n: number, i: any) => n + i.count, 0) : 0,
        interrupted: false, safeArrival: arrival(vec(predicted.teleport)), occupied: occupied(predicted.teleport),
        routeClear: routeClear(predicted.teleport), walkingBlocksPerTick: 0.28 })
      if (plan) return plan
    }
    return heightPlan()
  }
  const valid = (ctl: Control, id: number) => !ctl.aborted && bot.health > 8 && options.enemy()?.id === id && options.enemy()?.isValid !== false
  const throwTo = async (ctl: Control, point: any, enemyId: number, check: () => boolean): Promise<throws.ThrowResult> => {
    const item = bot.inventory.items().find((i: any) => i.name === 'ender_pearl')
    if (!item || !valid(ctl, enemyId)) return { thrown: false }
    return throws.throwAt(bot, point, { item, preferOffhand: true, onAim: (shot: any) => valid(ctl, enemyId) && check()
      && bot.health > pearls.pearlDamage(bot) + 8 && shot.land?.tp && !shot.land.void && arrival(shot.land.tp) })
  }
  const runHeight = async (ctl: Control, plan: HeightPlan) => {
    heightAt = clock.now()
    stats.phases.push('PearlGainHeight')
    const start = bot.entity.position.clone()
    const shot = await throwTo(ctl, plan.at, plan.enemyId, () => visible(plan.teleport))
    if (!shot.thrown) return { ok: false, why: 'height pearl cancelled' }
    stats.phases.push('ConfirmTeleport')
    const deadline = clock.now() + shot.ticks * 50 + 1500
    while (valid(ctl, plan.enemyId) && clock.now() < deadline && bot.entity.position.distanceTo(start) < 4) await clock.sleep(50)
    if (!valid(ctl, plan.enemyId) || bot.entity.position.distanceTo(plan.teleport) > 3 || !bot.entity.onGround) { stats.phases.push('Recover'); return { ok: false, why: 'height teleport not confirmed' } }
    const weapon = bot.inventory.items().find((i: any) => i.name === 'mace') ?? bot.inventory.items().find((i: any) => spear.isSpear(i.name))
    if (!weapon) return { ok: false }
    await bot.equip(weapon, 'hand')
    const armed = clock.now()
    while (valid(ctl, plan.enemyId) && clock.now() - armed < (weapon.name === 'mace' ? 1550 : spear.chargeTicks(weapon.name) * 50 + 60)) await clock.sleep(50)
    if (!valid(ctl, plan.enemyId)) return { ok: false, why: 'height dive interrupted' }
    stats.phases.push('DiveStrike')
    const target = options.enemy()
    await bot.lookAt(target.position.offset(0, 0.9, 0), true)
    const jumpEnd = clock.now() + 800
    while (valid(ctl, plan.enemyId) && bot.entity.onGround && clock.now() < jumpEnd) { bot.setControlState('forward', true); await clock.sleep(50) }
    bot.setControlState('forward', false)
    let result: any = { hit: false }
    if (valid(ctl, plan.enemyId) && !bot.entity.onGround) {
      if (weapon.name === 'mace') result = await mace.descend(bot, ctl, target, { vel: () => target.velocity ?? { x: 0, y: 0, z: 0 }, swap: false, maxMs: 1800 })
      else result = await spear.jab(bot, target, { abortIf: () => !valid(ctl, plan.enemyId) })
      stats.heightDives++
      options.used('pearl height dive')
    }
    stats.phases.push('Recover')
    return { ok: true, ...result }
  }
  const run = async (ctl: Control, plan: PearlResponsePlan | HeightPlan) => {
    if (plan.kind === 'PearlHeightDive') return runHeight(ctl, plan)
    const id = plan.prediction.id
    const enemyId = plan.prediction.ownerId
    const current = prediction(id)
    if (!current || !valid(ctl, enemyId) || vec(current.teleport).distanceTo(vec(plan.at)) > 2) return { ok: false, why: 'observed pearl changed' }
    if (plan.kind === 'TrapArrival') {
      const trapped = !!(options.webAt && await options.webAt(vec(current.teleport), ctl))
      if (trapped) { handled.add(id); stats.traps++; options.used('trap visible pearl arrival') }
      return { ok: trapped }
    }
    if (plan.kind === 'CounterPearl') {
      const me = bot.entity.position; const at = vec(current.teleport)
      const d = Math.hypot(me.x - at.x, me.z - at.z)
      const point = at.offset((me.x - at.x) / Math.max(0.001, d) * 2.5, 0, (me.z - at.z) / Math.max(0.001, d) * 2.5)
      const shot = await throwTo(ctl, point, enemyId, () => !!prediction(id) && !occupied(point))
      if (shot.thrown) { handled.add(id); stats.counters++; options.used('counter visible pearl') }
      return { ok: !!shot.thrown, ...shot }
    }
    const deadline = clock.now() + Math.min(1200, current.ticks * 50)
    while (valid(ctl, enemyId) && clock.now() < deadline) {
      const fresh = prediction(id)
      if (!fresh || vec(fresh.teleport).distanceTo(vec(plan.at)) > 2 || !routeClear(fresh.teleport)) break
      const point = vec(fresh.teleport)
      if (bot.entity.position.distanceTo(point) <= 2.5) { handled.add(id); stats.intercepts++; options.used('intercept visible pearl arrival'); break }
      await bot.lookAt(point.offset(0, 1.3, 0), true)
      bot.setControlState('forward', true); bot.setControlState('sprint', true)
      await clock.sleep(50)
    }
    if (!ctl.aborted) { bot.setControlState('forward', false); bot.setControlState('sprint', false) }
    return { ok: handled.has(id) }
  }
  return { decide, run, report: () => stats, close: () => {
    bot.removeListener('entitySpawn', onSpawn); bot.removeListener('entityMoved', onMove); bot.removeListener('entityGone', onGone)
    observed.clear(); handled.clear()
  } }
}
