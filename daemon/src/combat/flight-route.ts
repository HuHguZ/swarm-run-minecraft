import { FlightRouteGraph, type FlightGate } from './flight-route-graph'
import type { Position } from '../core/world-state'
import * as clock from '../game-clock'
import sky = require('../elytra')
const Vec3: typeof import('vec3').Vec3 = require('vec3')

export interface FlightRouteRequest { gates: FlightGate[]; landing: Position; timeoutSeconds?: number; gateSeconds?: number; rocketReserve?: number; arena?: import('./team-wind').WindArena }
export async function runFlightRoute(session: any, ctl: { aborted: boolean }, params: FlightRouteRequest) {
  const bot = session.bot
  ctl = sky.flightControl(bot, ctl)
  const graph = new FlightRouteGraph(params.gates)
  if (!Object.values(params.landing).every(Number.isFinite)) throw new Error('Flight route needs a finite landing point')
  const landing = new Vec3(params.landing.x, params.landing.y, params.landing.z)
  const inside = p => (require('./team-wind') as typeof import('./team-wind')).windInside(p, params.arena)
  if (!inside(bot.entity.position) || !inside(landing) || params.gates.some(g => !inside(g.center))) throw new Error('Flight route outside arena')
  const world = sky.worldOf(bot, { observed: !!params.arena })
  const floor = world.floorBelow(landing.x, landing.y, landing.z, 2)
  if (world.boxHit(landing.x, landing.y, landing.z, 1.8) || !floor || floor.lava || floor.water || Math.abs(floor.top - landing.y) > 1) throw new Error('Flight route landing is not loaded and clear')
  const first = graph.target()!
  const started = clock.now()
  const hpBefore = bot.health
  const rocketBefore = sky.rocketCount(bot)
  const statistics: Record<string, number> = {}
  const trace: Array<Record<string, unknown>> = []
  let collisionTicks = 0
  let ticks = 0
  let stop: string | null = null
  const observe = () => {
    ticks++
    const point = bot.entity.position.offset(0, sky.gliding(bot.entity) ? .3 : .9, 0)
    const crossed = graph.observe(point)
    if (crossed) session.bus.emit('flight_gate', { ...crossed, index: graph.index, gameMs: clock.now() - started })
    if (bot.entity.isCollidedHorizontally || bot.entity.isCollidedVertically && !bot.entity.onGround) collisionTicks++
    if (ticks % 20 === 0) trace.push({ gameMs: clock.now() - started, index: graph.index, p: { x: point.x, y: point.y, z: point.z },
      v: { ...bot.entity.velocity }, hp: bot.health, flying: sky.gliding(bot.entity) })
  }
  bot.on('physicsTick', observe)
  try {
    if (!sky.gliding(bot.entity)) {
      const rocket = bot.inventory.items().find(sky.plainRocket)
      if (rocket && !sky.plainRocket(bot.inventory.slots[45])) await bot.equip(rocket, 'off-hand')
      const launch = await sky.takeoff(bot, ctl, { pitch: 1.0, yaw: Math.atan2(-(first.x - bot.entity.position.x), -(first.z - bot.entity.position.z)), stats: statistics, arena: params.arena })
      if (!launch.ok) throw new Error(launch.why)
    }
    const timeout = Math.max(10, Math.min(300, params.timeoutSeconds ?? 120)) * 1000
    while (!graph.complete && !ctl.aborted && clock.now() - started < timeout) {
      const index = graph.index
      const gate = graph.gates[index]
      const flight = await sky.fly(bot, ctl, {
        arena: params.arena,
        maxMs: Math.max(2, Math.min(30, params.gateSeconds ?? 15)) * 1000,
        goal: () => {
          const target = graph.target()!
          return { kind: 'point', at: new Vec3(target.x, target.y, target.z), reach: true,
            minY: gate.center.y - gate.radius + 1, maxY: gate.center.y + gate.radius - 1 }
        },
        until: () => graph.index > index ? 'gate crossed' : bot.health <= 6 ? 'low health' : null,
        stats: statistics,
        noRocket: () => sky.rocketCount(bot) <= (params.rocketReserve ?? 2),
        rocketIf: (state: any) => Math.hypot(state.v.x, state.v.z) < .6 || state.p.y < gate.center.y - 2 && state.v.y < .1
      })
      if (graph.index === index) { stop = flight.why; break }
    }
    const landed = !ctl.aborted ? await sky.land(bot, ctl, { at: graph.complete ? landing : null, maxMs: 12000, stats: statistics, arena: params.arena }) : { ok: false, why: 'interrupted' }
    if (ctl.aborted && sky.gliding(bot.entity)) landAnyway(bot, ctl, params.arena, statistics)
    const position = bot.entity.position
    const ground = landed.ground || (bot.entity.onGround ? { ...position } : null)
    const landingError = ground ? landing.distanceTo(new Vec3(ground.x, ground.y, ground.z)) : position.distanceTo(landing)
    // Безопасно сесть вообще — задача land; маршрут обещает именно выбранную площадку, а не этаж ниже.
    // Тот же допуск 3 блока, что у сцены try-flight-route; высота — как у допуска опоры перед взлётом.
    const arrived = !!ground && landingError <= 3 && Math.abs(ground.y - landing.y) <= 1
    return { ok: graph.complete && landed.ok && arrived && !ctl.aborted, stopped: ctl.aborted ? 'interrupted' : stop ?? (!graph.complete ? 'route incomplete' : !landed.ok ? landed.why : !arrived ? 'landing_missed' : null),
      crossings: graph.crossings, expectedGates: graph.gates.length, collisionTicks, rockets: rocketBefore - sky.rocketCount(bot),
      gameMs: clock.now() - started, hpBefore, hp: bot.health,
      landing: { ...position }, ground, landingError, statistics, trace }
  } finally { bot.removeListener('physicsTick', observe) }
}

// Полёт прервали в воздухе — всё равно сесть, как после тарана (aerial-lance, lanceLand). Элитры без руля уносили бота за
// Колизей: стенд 21.10, слот 30 — за раунд 77 из 103 перелётов синих на насест прерваны, 50 вылетов за арену и смерть «как
// упавший». Садимся на ближайшую площадку внутри арены, а не на насест; прерывает посадку только смерть; потом нагрудник
// назад. Посадка идёт фоном: отчёт полёта возвращается сразу, его ждёт драйвер.
function landAnyway (bot: any, parentCtl: any, arena: any, stats: Record<string, number>) {
  const ctl = sky.flightControl(bot, parentCtl, true)
  if (ctl.aborted) return
  const inside = arena ? (x: number, z: number) => Math.abs(x - arena.x) <= arena.r - 1 && Math.abs(z - arena.z) <= arena.r - 1 : null
  const W = sky.worldOf(bot, { observed: !!arena })
  const at = sky.landingSpot(bot, W, { near: bot.entity.position, radius: 16, inside })
  stats.landAnyway = (stats.landAnyway || 0) + 1
  sky.land(bot, ctl, { at, stats, arena })
    .then(() => !ctl.aborted && !bot.entity.elytraFlying && sky.wearingElytra(bot) ? sky.chestDown(bot, ctl, { stats, arena }) : null)
    .catch(() => {})
}
