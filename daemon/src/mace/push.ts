// Булава (mace.ts): толчок зарядом ветра — сброс в яму (прогон тела), когда толкать, выстрел с упреждением.
import { Vec3 } from './world'
import * as edges from '../edges'
import * as pick from '../pick'
import { WIND_SPEED, SWAP, yawTo } from './consts'
import { install, offWind, windReady, ensureHotbar, fireWind } from './hands'
import { grounded } from './world'

// ---------------------------------------------------------------- толчок

// Толчок зарядом по нему: прямое попадание — 1 урона (LivingEntity.
// hurtServer → knockback 0.4 по полёту снаряда, вверх до 0.4) и всплеск на
// его рамке (у ног: (1 − 0.63/2.4)·1.22 ≈ 0.9 «от центра к глазам» — вбок ~0.35,
// вверх ~0.83). Щит гасит урон и его толчок, всплеск — нет. Оценка снизу:
// только всплеск, по нему — прогон тела edges.knockRun (падение в яму/пустоту).
function pushVelocity (bot, e, from, { blocking = false }: any = {}) {
  const dx = e.position.x - from.x; const dz = e.position.z - from.z
  const n = Math.hypot(dx, dz) || 1
  const h = 0.35 + (blocking ? 0 : 0.4)
  const up = !grounded(bot, e) ? 0.3 : (blocking ? 0.8 : 0.9)
  return new Vec3(dx / n * h, up, dz / n * h)
}

export function knockOff (bot, e, { blocking = false }: any = {}) {
  try {
    const cache = new Map()
    if (!edges.hazardAround(bot, e.position, 5, cache)) return false
    const base = edges.stateOf(bot)
    const v = pushVelocity(bot, e, bot.entity.position, { blocking })
    const face = yawTo(e.position, bot.entity.position)
    const r = edges.knockRun(bot, base, e.position, v, grounded(bot, e), face, true, cache)
    return !!(r && r.fall)
  } catch { return false }
}

// Чем толкнуть сейчас — или null. Порядок: в яму (сброс насмерть), со столба
// (ниже всплеска — урон от падения, и он снова внизу), сбить еду/лук (он
// медленный, 1 урона, а бот-противник бросает глоток от удара), сбить рывок,
// пока свой удар не заряжен.
export function pushPlan (bot, e, { sees = true, theyUp = false, busy = null, closing = 0, cooldownLeft = 0, blocking = false }: any = {}) {
  if (!sees || !windReady(bot)) return null
  if (!e || !e.position || e.isValid === false) return null
  if (knockOff(bot, e, { blocking })) return { why: 'в яму' }
  if (theyUp) return { why: 'со столба' }
  if (busy) return { why: busy }
  if (closing > 0.18 && cooldownLeft > 300) return { why: 'сбил рывок' }
  return null
}

// Выстрел зарядом в него: прямая без гравитации, скорость 1.5 + своё
// смещение (x,z — всегда, y — в воздухе). Цель — его ноги + 0.3 с упреждением
// по его скорости (включая вертикаль в воздухе) и проверкой стен (windBlockImpact).
export async function windPush (bot, e, { vel = null, swap = SWAP, allies = [] }: any = {}) {
  install(bot)
  if (!offWind(bot) && !(await ensureHotbar(bot, ['wind_charge']))) return { fired: false, why: 'заряда нет в хотбаре' }
  const { windLaunch, windBlockImpact } = require('../combat/team-wind') as typeof import('../combat/team-wind')
  const { observedVelocity } = require('../bow/track') as typeof import('../bow/track')
  const r = await fireWind(bot, (moved) => {
    if (!e?.position || e.isValid === false) return null
    const u = new Vec3(moved?.x || 0, bot.entity.onGround ? 0 : (moved?.y || 0), moved?.z || 0)
    const from = pick.eyeOf(bot)
    const tv = (vel ? vel() : observedVelocity(e)) || { x: 0, y: 0, z: 0 }
    const airborne = e.onGround === false && Number.isFinite(tv.y) && Math.abs(tv.y) > 1e-4
    const leadY = (ticks: number) => {
      if (!airborne) return 0
      const whole = Math.floor(Math.max(0, ticks)), frac = Math.max(0, ticks) - whole
      let dy = 0, vy = tv.y
      for (let k = 0; k < whole; k++) { dy += vy; vy = (vy - 0.08) * 0.98 }
      return dy + vy * frac
    }
    let t = from.distanceTo(e.position) / WIND_SPEED
    let P = e.position.offset(0, 0.3, 0)
    let launch: ReturnType<typeof windLaunch> = null
    for (let i = 0; i < 4; i++) {
      P = new Vec3(e.position.x + (tv.x || 0) * t, e.position.y + 0.3 + leadY(t), e.position.z + (tv.z || 0) * t)
      launch = windLaunch(from, P, u)
      if (!launch) return null
      t = launch.time
    }
    if (!launch) return null
    const dist = P.distanceTo(from), speed = launch.velocity.norm()
    if (dist > 0.35 && speed > 1e-6) {
      const hit = windBlockImpact(bot, from, launch.direction, dist - 0.35, speed)
      if (hit) return null
    }
    return { yaw: launch.yaw, pitch: launch.pitch }
  }, { swap, allies, packetAim: true })
  return r
}
