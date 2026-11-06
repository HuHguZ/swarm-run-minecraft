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
// по его скорости: всплеск у ног подкидывает выше всего.
export async function windPush (bot, e, { vel = () => ({ x: 0, y: 0, z: 0 }), swap = SWAP, allies = [] }: any = {}) {
  install(bot)
  if (!offWind(bot) && !(await ensureHotbar(bot, ['wind_charge']))) return { fired: false, why: 'заряда нет в хотбаре' }
  let lastPos = bot.entity.position.clone()
  const r = await fireWind(bot, () => {
    const p = bot.entity.position
    const u = { x: p.x - lastPos.x, y: bot.entity.onGround ? 0 : p.y - lastPos.y, z: p.z - lastPos.z }
    const from = pick.eyeOf(bot)
    const tv = vel() || { x: 0, y: 0, z: 0 }
    let t = from.distanceTo(e.position) / WIND_SPEED
    let P = null
    for (let i = 0; i < 4; i++) {
      P = new Vec3(e.position.x + tv.x * t, e.position.y + 0.3, e.position.z + tv.z * t)
      t = from.distanceTo(P) / WIND_SPEED
    }
    const w = P.minus(from).scaled(1 / Math.max(1, t))
    const d = new Vec3(w.x - u.x, w.y - u.y, w.z - u.z)
    return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) }
  }, { swap, allies, before: () => { lastPos = bot.entity.position.clone() } })
  return r
}
