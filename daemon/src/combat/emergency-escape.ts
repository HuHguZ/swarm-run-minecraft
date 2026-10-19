import sky = require('../elytra')
import * as pearls from '../pearl-hop'
import * as projectiles from '../throw'
import * as clock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

export type EmergencyEscapeKind = 'flight' | 'pearl'
export interface EmergencyEscapeState {
  flightReady: boolean
  pearlReady: boolean
  landing: { x: number; y: number; z: number } | null
}

export function lavaFallFloor(bot: any): number | null {
  const forecast = bot._ndClutch?.forecast
  const entity = bot.entity
  const at = clock.now()
  if (!forecast?.landing?.lava || !Number.isFinite(forecast.landing.top) || forecast.excluded || forecast.ground ||
      !entity?.position || entity.onGround || entity.isInLava || !(entity.velocity?.y < -.08) ||
      at - forecast.at < 0 || at - forecast.at > 150 || entity.position.distanceTo(forecast.from) > 1) return null
  // The coast forecast can precede this validated movement frame. Check its
  // current owner at either native endpoint, as clutch does; damage, drift,
  // expiry and controller cleanup immediately restore the normal rescue.
  const marker = bot._ndParkourForecast
  if (marker?.from && Number.isFinite(marker.until) && marker.until > at && bot.health >= marker.hp &&
      Math.min(entity.position.distanceTo(marker.from), marker.next ? entity.position.distanceTo(marker.next) : Infinity) <= .1) return null
  return forecast.landing.top
}

export function createEmergencyEscape(bot: any, { away = null }: { away?: (() => any) | null } = {}) {
  const snapshot = (): EmergencyEscapeState => {
    if (!bot.entity?.position || bot.health <= 0 || bot.currentWindow) return { flightReady: false, pearlReady: false, landing: null }
    const equipment = sky.kit(bot)
    const pearl = bot.inventory.items().some((item: any) => item.name === 'ender_pearl')
    if (!pearl && !(equipment.elytra && equipment.rockets > 0)) return { flightReady: false, pearlReady: false, landing: null }
    const world = sky.worldOf(bot)
    const threat = away?.() ?? null
    const lavaFloor = lavaFallFloor(bot)
    const lava = bot.entity.isInLava || bot.blockAt(bot.entity.position)?.name === 'lava' || lavaFloor !== null
    const landing = sky.landingSpot(bot, world, { near: bot.entity.position, floorY: Math.min(bot.entity.position.y, lavaFloor ?? bot.entity.position.y), radius: 48, away: threat, minFromAway: threat && !lava ? 18 : 0 })
    const launchClear = bot.entity.isInLava ? sky.lavaLaunchClear(bot) : sky.headroom(world, bot.entity.position, 6) >= 4
    return { landing, flightReady: !!landing && launchClear && equipment.elytra && equipment.rockets > 0,
      pearlReady: !!landing && pearl && bot.health > pearls.pearlDamage(bot) + 1 }
  }
  const safe = (point: any) => {
    const settled = pearls.settle(pearls.worldOf(bot), point)
    return !!settled?.ok && !settled.edge1
  }
  const run = async (ctl: { aborted: boolean }, kind: EmergencyEscapeKind) => {
    const state = snapshot()
    if (ctl.aborted || !state.landing || !state[kind === 'flight' ? 'flightReady' : 'pearlReady']) return { ok: false, why: 'escape capability unavailable' }
    const at = new Vec3(state.landing.x, state.landing.y, state.landing.z)
    if (!safe(at)) return { ok: false, why: 'escape landing changed' }
    if (kind === 'flight') {
      if (!sky.gliding(bot.entity)) {
        const yaw = Math.atan2(-(at.x - bot.entity.position.x), -(at.z - bot.entity.position.z))
        const launched = await sky.takeoff(bot, ctl, { pitch: 1.2, yaw, liquidStart: true })
        if (!launched.ok || ctl.aborted) return { ok: false, why: launched.why ?? 'escape interrupted' }
      }
      await sky.fly(bot, ctl, { maxMs: 1800, goal: () => ({ kind: 'point', at: at.offset(0, 6, 0), reach: true, minY: at.y + 3 }),
        until: () => ctl.aborted || !safe(at) ? 'escape landing cancelled' : bot.entity.position.distanceTo(at) < 9 && bot.entity.position.y > at.y + 4 ? 'clear of fire' : null,
        noRocket: () => true })
      if (ctl.aborted || !safe(at)) return { ok: false, why: 'escape interrupted' }
      const landed = await sky.land(bot, ctl, { at, away: away?.() ?? null, maxMs: 5000 })
      if (ctl.aborted) return { ok: false, why: 'escape interrupted' }
      if (bot.entity.onGround && safe(bot.entity.position)) return { ...landed, ok: true, at: bot.entity.position.clone(), landingError: bot.entity.position.distanceTo(at) }
      return landed
    }
    const from = bot.entity.position.clone()
    const item = bot.inventory.items().find((item: any) => item.name === 'ender_pearl')
    const rejected: Record<string, number> = {}
    const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1 }
    const result = await projectiles.throwAt(bot, null, { item, preferOffhand: true,
      pick: (ctx: any) => {
        const yaw = Math.atan2(-(at.x - ctx.from.x), -(at.z - ctx.from.z))
        const threat = away?.()
        const lava = bot.entity.isInLava || bot.blockAt(bot.entity.position)?.name === 'lava' || lavaFallFloor(bot) !== null
        const direct = projectiles.aim(ctx.from, at, projectiles.KINDS.ender_pearl, ctx.moved, ctx.airborne)
        let best: any = null
        const directions = [yaw, yaw - .3, yaw + .3, ...Array.from({ length: 16 }, (_, i) => i * Math.PI / 8)]
        const shots = [
          ...(direct ? [direct] : []),
          ...directions.flatMap(yaw => [5, 15, 25, 35, 45, 55, 65, 75, 80, 85, 88].map(degrees => ({ yaw, pitch: degrees * Math.PI / 180 })))
        ]
        for (const { yaw: aimedYaw, pitch } of shots) {
          const land = ctx.landing(aimedYaw, pitch)
          if (!land?.tp || land.void) { reject(land?.void ? 'void' : 'unloaded trajectory'); continue }
          const settled = pearls.settle(pearls.worldOf(bot), land.tp)
          if (!settled?.ok || settled.edge1) { reject(settled?.why ?? 'landing edge'); continue }
          const distance = Math.hypot(land.tp.x - ctx.from.x, land.tp.z - ctx.from.z)
          const fromThreat = threat ? Math.hypot(land.tp.x - threat.x, land.tp.z - threat.z) : 18
          if (distance < (lava ? 2 : 6) || fromThreat < (lava ? 0 : 12)) { reject('too close'); continue }
          if (lava) return { yaw: aimedYaw, pitch, at: land.tp, ticks: land.ticks }
          const score = Math.min(fromThreat, 30) - land.tp.distanceTo(at) - Math.max(0, land.tp.y - at.y) * .5
          if (!best || score > best.score) best = { yaw: aimedYaw, pitch, score, at: land.tp, ticks: land.ticks }
        }
        return best
      },
      onAim: (shot: any) => !ctl.aborted && !shot.land?.void && shot.land?.tp && safe(shot.land.tp)
        && bot.health > pearls.pearlDamage(bot) + 1 })
    bot._ndReflexSession?.bus?.emit('escape_pearl', { shot: result, health: bot.health, position: bot.entity.position.clone() })
    if (!result.thrown) return { ok: false, why: `${result.why ?? 'escape pearl not thrown'}: ${JSON.stringify(rejected)}`, predicted: result.land }
    const began = clock.now()
    const deadline = Math.max(4000, ((result.ticks ?? 70) + 10) * 50)
    while (!ctl.aborted && bot.health > 0 && clock.now() - began < deadline) {
      if (bot.entity.position.distanceTo(from) > 2 && safe(bot.entity.position)) return { ok: true, pearl: true, at: bot.entity.position.clone() }
      await clock.sleep(50)
    }
    return { ok: false, why: ctl.aborted ? 'escape interrupted' : 'escape teleport unconfirmed' }
  }
  return { snapshot, run }
}
