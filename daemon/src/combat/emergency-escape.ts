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
  const session = bot._ndReflexSession, arena = session?.current?.params?.arena ?? session?._rescue?.arena
  const inside = (p: any) => !arena || (require('./team-wind') as typeof import('./team-wind')).windInside(p, arena)
  const contact = () => (require('../pvp/lava-exit') as typeof import('../pvp/lava-exit')).burnContact(bot)
  const lavaRescue = () => contact() === 'lava' &&
    !(require('../fightkit') as typeof import('../fightkit')).hasEffect(bot, 'fire_resistance')
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
      pearlReady: !!landing && pearl && (lavaRescue() ? projectiles.canSurvivePearl(bot) : bot.health > pearls.pearlDamage(bot) + 1) }
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
    const from = bot.entity.position.clone(), rescue = lavaRescue()
    let forced = false
    const onMove = () => { forced ||= !bot.entity.position.equals(from) }
    if (rescue) bot.on?.('forcedMove', onMove)
    try {
    const item = bot.inventory.items().find((item: any) => item.name === 'ender_pearl')
    const rejected: Record<string, number> = {}
    const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1 }
    const result = await projectiles.throwAt(bot, null, { item, preferOffhand: true,
      pick: (ctx: any) => {
        if (rescue) return projectiles.escapePick(bot, p => inside(p) ? 0 : -Infinity, { rescue: true, maxDrop: 4 })(ctx)
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
        && (rescue ? lavaRescue() && projectiles.canSurvivePearl(bot) && inside(shot.land.tp) &&
          (require('../navigation/geometry') as typeof import('../navigation/geometry')).bodyClear(bot, shot.land.tp, { water: true }) : bot.health > pearls.pearlDamage(bot) + 1) })
    bot._ndReflexSession?.bus?.emit('escape_pearl', { shot: result, health: bot.health, position: bot.entity.position.clone() })
    if (!result.thrown) return { ok: false, why: `${result.why ?? 'escape pearl not thrown'}: ${JSON.stringify(rejected)}`, predicted: result.land }
    const began = clock.now()
    const deadline = Math.max(4000, ((result.ticks ?? 70) + 10) * 50)
    while (!ctl.aborted && bot.health > 0 && clock.now() - began < deadline) {
      const p = bot.entity.position
      if ((rescue && forced || p.distanceTo(from) > 2) && safe(p) && (!rescue || inside(p) && !contact() &&
          (!result.land || p.distanceTo(new Vec3(result.land.x, result.land.y, result.land.z)) < 2) &&
          (require('../navigation/geometry') as typeof import('../navigation/geometry')).bodyClear(bot, p, { water: true }))) return { ok: true, pearl: true, at: p.clone() }
      await clock.sleep(50)
    }
    return { ok: false, why: ctl.aborted ? 'escape interrupted' : 'escape teleport unconfirmed' }
    } finally { if (rescue) bot.removeListener?.('forcedMove', onMove) }
  }
  return { snapshot, run }
}

// Жемчуг из пропасти (пользователь 25.10: «бот без элитр падает в обрыв под Колизеем — бросок жемчуга обратно, обязательно»;
// «кидать высоко, на другой уровень Колизея, подальше от врага, чтобы тот не достал»): в падении — броски на верхнюю грань
// опоры выше линии смерти внутри арены. Из тех, что перенесут раньше, чем тело пройдёт линию смерти, — выше и дальше от
// врагов; не успевает ни один — самый быстрый.
export function pitPearlScore(land: { tp: { x: number; y: number; z: number }; ticks: number }, { budget, foes, edge }: { budget: number; foes: { x: number; y: number; z: number }[]; edge?: boolean }) {
  const far = foes.length ? Math.min(...foes.map(f => Math.hypot(land.tp.x - f.x, land.tp.y - f.y, land.tp.z - f.z))) : 30
  return land.ticks <= budget ? 1000 + land.tp.y + Math.min(far, 30) * .7 - (edge ? 8 : 0) : -land.ticks
}

/** Ticks until a falling body (gravity .08, drag .98) drops below y. */
export function ticksToY(y0: number, vy0: number, y: number) {
  let p = y0, v = vy0
  for (let t = 0; t < 200; t++) { if (p < y) return t; v = (v - .08) * .98; p += v }
  return 200
}

export async function pitPearl(bot: any, ctl: { aborted: boolean }, { killY, arena, foes = [] }: { killY: number; arena?: any; foes?: { x: number; y: number; z: number }[] }) {
  const item = bot.inventory.items().find((i: any) => i.name === 'ender_pearl') ||
    (bot.inventory.slots[45]?.name === 'ender_pearl' ? bot.inventory.slots[45] : null)
  if (!item) return { ok: false, why: 'нет жемчуга' }
  const inside = (p: any) => !arena || (require('./team-wind') as typeof import('./team-wind')).windInside(p, arena)
  const rejected: Record<string, number> = {}
  const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1 }
  const from = bot.entity.position.clone()
  const budget = ticksToY(from.y, bot.entity.velocity.y, killY)
  // Listen for server `forcedMove` teleport packets BEFORE throwing so ultra-short (2-tick) rescue pearls
  // that land during `throwAt` or move < 3 blocks onto a nearby clutch block are reliably confirmed.
  let teleportedAt: any = null
  const onTeleport = () => {
    const p = bot.entity?.position
    if (p && p.y >= killY + 1) teleportedAt = p.clone()
  }
  bot.on?.('forcedMove', onTeleport)
  let result: any
  try {
    result = await projectiles.throwAt(bot, null, { item, preferOffhand: true,
      pick: (ctx: any) => {
        const world = pearls.worldOf(bot)
        const sweep = (yawOffset: number, pitches: number[]) => {
          let best: any = null
          for (let i = 0; i < 16; i++) for (const degrees of pitches) {
            const yaw = (i + yawOffset) * Math.PI / 8, pitch = degrees * Math.PI / 180
            const land = ctx.landing(yaw, pitch)
            if (!land?.tp || land.void) { reject(land?.void ? 'void' : 'unloaded'); continue }
            if (!land.block?.position) { reject('не на верх блока'); continue }
            const topFace = land.tp.y >= land.block.position.y + .9
            if (land.tp.y < killY + 1) { reject('ниже линии смерти'); continue }
            if (!inside(land.tp)) { reject('вне арены'); continue }
            const settled = pearls.settle(world, land.tp)
            // Side-face hits over open void still fail `settled.ok`; allow a side hit only when solid non-edge
            // ground sits directly beneath `land.tp` (e.g. inner rim/wall sitting on the arena deck).
            if (!topFace && (!settled?.ok || (settled.fall ?? 0) > 2 || settled.feet.y < killY + 1 || settled.edge1)) {
              reject('не на верх блока'); continue
            }
            if (!settled?.ok) { reject(settled?.why ?? 'нет опоры'); continue }
            const score = pitPearlScore(land, { budget, foes, edge: !!settled.edge1 }) + (topFace ? 3 : 0)
            if (!best || score > best.score) best = { yaw, pitch, score, at: land.tp, ticks: land.ticks }
          }
          return best
        }
        return sweep(0, [-30, -10, 5, 15, 25, 35, 45, 55, 65, 75, 85]) ??
          sweep(.5, [-20, 0, 10, 20, 30, 40, 50, 60, 70, 80])
      },
      onAim: (shot: any) => !ctl.aborted && !!shot.land?.tp && !shot.land.void })
    if (!result.thrown) return { ok: false, why: `${result.why ?? 'не бросил'}: ${JSON.stringify(rejected)}`, budget }
    const at = result.land?.tp, began = clock.now(), deadline = ((result.ticks ?? 60) + 20) * 50
    const confirm = (p: any) => ({ ok: true, pearl: true, at: p.clone(), y: Math.round(p.y), ticks: result.ticks, budget, error: at ? +p.distanceTo(at).toFixed(1) : null })
    if (teleportedAt) return confirm(teleportedAt)
    let last = bot.entity.position.clone()
    while (!ctl.aborted && bot.health > 0 && clock.now() - began < deadline) {
      if (teleportedAt) return confirm(teleportedAt)
      const p = bot.entity.position
      if (p.y >= killY + 1 && (p.distanceTo(last) > 3 ||
          (at && p.distanceTo(at) <= 1.8 && (p.distanceTo(from) > 1 || bot.entity.onGround)))) {
        return confirm(p)
      }
      last = p.clone()
      await clock.sleep(50)
    }
    if (teleportedAt) return confirm(teleportedAt)
    return { ok: false, why: ctl.aborted ? 'прервано' : bot.health <= 0 ? 'death' : 'перенос не подтверждён', ticks: result.ticks, budget, at }
  } finally {
    bot.removeListener?.('forcedMove', onTeleport)
  }
}
