'use strict'
// Элитры (elytra.ts): константы физики и полёта, флаги окружения, мелкие помощники, ожидание тика.
const gameClock: typeof import('../game-clock') = require('../game-clock')

const TICK_MS = 50
const G = 0.08
const EYE = 1.62
const EYE_FLY = 0.4
const HALF = Math.fround(0.6) / 2
const BODY_H = 1.8
const FLY_H = 0.6
const REACH = 3.0
const SAFE_FALL = 3
const LAND_FD = Number(process.env.ND_LAND_FD ?? 2)
const ROCKET_BOOST = 1.5
const ROCKET_MAX_TICKS = 40
// Запас ракет на спасение из пропасти (пользователь 25.10: «падают в обрыв под Колизеем — умирают, а на элитрах можно улететь»;
// падения на арене: элитры есть, ракет 0 — все ушли на перелёты за лутом; без ракеты планер до линии смерти не дотягивает).
// Обычный полёт и взлёт этот запас не тратят; тратят спасение (fly_to rescue) и уход от врага (escape).
const RESCUE_ROCKETS = 3
const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
const DEBUG = !!process.env.ND_DEBUG_ELYTRA
// ND_ELYTRA=0 — не летать в бою (прогон «до»); защита от летуна остаётся.
const ON = process.env.ND_ELYTRA !== '0'
// Рефлекс столкновения в полёте без руля (install); ND_ELYTRA_GUARD=0 — выкл.
const GUARD = process.env.ND_ELYTRA_GUARD !== '0'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
const yawTo = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z))
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
const r2 = (x) => Math.round(x * 100) / 100

const nextTick = (bot) => new Promise<any>(resolve => {
  const on = () => { gameClock.clearTimeout(t); resolve(true) }
  const t = gameClock.setTimeout(() => { bot.removeListener('physicsTick', on); resolve(false) }, 300)
  bot.once('physicsTick', on)
})

export {
  TICK_MS, G, EYE, EYE_FLY, HALF, BODY_H, FLY_H, REACH, SAFE_FALL, LAND_FD, ROCKET_BOOST, ROCKET_MAX_TICKS, RESCUE_ROCKETS, KEYS, DEBUG, ON, GUARD, clamp, sleep, yawTo, wrap, r2, nextTick
}
