'use strict'
// Рефлекс края: перед каждым тиком физики — не уведут ли нажатые клавиши тело с обрыва (guard).
// ---------------------------------------------------------------- рефлекс
import { SAFE_FALL, IDLE, FIX, clearance, hazardAround, run } from './forecast'
const gameClock: typeof import('../game-clock') = require('../game-clock')
// Клавиши на восемь сторон (без спринта) — для шага от края и руля в воздухе.
const DIRS8 = [
  { forward: true }, { back: true }, { left: true }, { right: true },
  { forward: true, left: true }, { forward: true, right: true }, { back: true, left: true }, { back: true, right: true }
].map(k => ({ ...IDLE, ...k }))

// Рефлекс на время боя. opts.margin() — запас от края, пока враг может
// ударить (его удар кидает на 2-4 блока: стоять вплотную к краю нельзя);
// сам край — никогда. Возвращает { stop, allow(depth, ms), stats }.
// Сторож края: stats — спасения, прыжки в воздух, простои, причины; без физики сторожа нет и stats пуст.
interface GuardStats { saves: number; air: number; idle: number; why: Record<string, number> }
function guard (bot, { margin = () => 0 }: any = {}): { stats: Partial<GuardStats>; allow (depth: number, ms?: number): void; stop (): void } {
  const ph = bot.physics
  if (!ph || typeof ph.simulatePlayer !== 'function') return { stop () {}, allow () {}, stats: {} }
  if (!bot._ndSimOrig) bot._ndSimOrig = ph.simulatePlayer
  const orig = bot._ndSimOrig
  const stats: GuardStats = { saves: 0, air: 0, idle: 0, why: {} }
  let lastGroundY = bot.entity ? bot.entity.position.y : 0
  let allowSafe = SAFE_FALL
  let allowUntil = 0
  let on = true
  // Настоящий тик от прогнозов (pathfinder тоже зовёт simulatePlayer) —
  // по объекту клавиш: mineflayer передаёт один и тот же объект каждый тик,
  // прогнозы создают свой на каждый расчёт.
  let realControl = null
  const seen = new WeakMap()
  const isReal = (c) => {
    if (realControl) return c === realControl
    const now = gameClock.now()
    const s = seen.get(c)
    if (!s) { seen.set(c, { last: now, n: 1 }); return false }
    if (now - s.last > 30) { s.n++; s.last = now }
    if (s.n >= 3) { realControl = c; return true }
    return false
  }
  const note = (why) => { stats.why[why] = (stats.why[why] || 0) + 1 }

  const filter = (state) => {
    if (state.onGround) lastGroundY = state.pos.y
    // A native movement plan already checked this exact body and its controls.
    // Keep the real integrator, but do not replace those controls with another
    // forecast while the confirmed owner remains healthy, current and nearby.
    const planned = bot._ndParkourForecast
    if (planned && planned.until > gameClock.now() && (bot.health ?? 0) >= planned.hp && state.pos.distanceTo(planned.from) <= .1) return
    // A supported body with no horizontal momentum or movement/jump request
    // cannot walk over an edge. Native physics still handles gravity, changed
    // support and fluid contact; actual motion or knockback resumes forecasting.
    if (state.onGround && state.vel.y <= 0 && Math.hypot(state.vel.x, state.vel.z) <= 1e-7 &&
      !state.control.forward && !state.control.back && !state.control.left && !state.control.right && !state.control.jump && !state.jumpQueued) { stats.idle++; return }
    if (state.isInWater || state.isInLava) return
    // Уже летим вниз с края — рулить поздно, дальше дело ведра (fallGuard).
    if (!state.onGround && state.pos.y < lastGroundY - 2) return
    const safe = gameClock.now() < allowUntil ? allowSafe : SAFE_FALL
    const groundY = state.onGround ? state.pos.y : lastGroundY
    const cache = new Map()
    // Дешёвая проверка: опасности в 5 блоках нет — нечего и считать.
    if (!hazardAround(bot, state.pos, 5, cache)) return
    const want = { ...IDLE }
    for (const k of Object.keys(IDLE)) want[k] = !!state.control[k]
    const m = state.onGround ? Math.max(0, margin() || 0) : 0
    const cur = state.onGround ? clearance(bot, state.pos, 1.2, cache, safe) : 0
    const opt = { groundY, cache, safe }
    const ok = (res) => {
      if (res.fall) return false
      if (!state.onGround || !res.rest) return true
      return clearance(bot, res.rest, 1.2, cache, safe) >= Math.min(m, cur - 0.05)
    }
    if (state.onGround) {
      const res = run(bot, state, want, { ...opt, hold: 2 })
      if (ok(res)) return
      const cands = []
      if (want.jump) cands.push({ ...want, jump: false })
      if (want.sprint) cands.push({ ...want, jump: false, sprint: false })
      if ((want.forward || want.back) && (want.left || want.right)) {
        cands.push({ ...IDLE, forward: want.forward, back: want.back })
        cands.push({ ...IDLE, left: want.left, right: want.right })
      }
      cands.push({ ...IDLE })
      cands.push({ ...IDLE, sneak: true })
      let pick = cands.find(c => ok(run(bot, state, c, { ...opt, hold: 2 })))
      if (!pick) {
        // Уже у самого края (отбросило): шаг туда, где запас больше.
        let best = -1
        for (const c of DIRS8) {
          const r = run(bot, state, c, { ...opt, hold: 3 })
          const sc = r.fall ? -1 : clearance(bot, r.rest, 1.2, cache, safe)
          if (sc > best) { best = sc; pick = c }
        }
        if (!pick || best < 0) pick = { ...IDLE, sneak: true }
        note('шаг от края')
      } else note(pick.sneak ? 'присел у края' : 'тормоз у края')
      stats.saves++
      // Метка «клавиши рефлекса»: спринт по правилам клиента (itemuse.js) их
      // спринт не включает (2026-09-26).
      state.control = { ...pick, _ndGuard: true }
      if (!pick.jump) state.jumpQueued = false
      return
    }
    // В воздухе (отбросило ударом, прыжок): куда сядем с этими клавишами —
    // клавиши до посадки (FIX, land), не на две секунды вперёд.
    const air = { ...opt, hold: 40, max: 40, land: FIX }
    const res = run(bot, state, { ...want, jump: false }, air)
    if (!res.fall) return
    let pick = null
    let bestT = -1
    // Рулить — как можно ближе к тому, чего хотел бой (FIX): сперва его же
    // клавиши без спринта, потом без клавиш, потом стороны по близости к его
    // ходу. Раньше первым шёл «вперёд со спринтом», что бы бой ни держал.
    let cands = [...DIRS8, { ...IDLE }]
    if (FIX) {
      const wx = (want.right ? 1 : 0) - (want.left ? 1 : 0)
      const wz = (want.forward ? 1 : 0) - (want.back ? 1 : 0)
      const sc = c => ((c.right ? 1 : 0) - (c.left ? 1 : 0)) * wx + ((c.forward ? 1 : 0) - (c.back ? 1 : 0)) * wz
      cands = [{ ...want, jump: false, sprint: false }, { ...IDLE }, ...DIRS8.slice().sort((a, b) => sc(b) - sc(a))]
    }
    for (const base of cands) {
      for (const sprint of [true, false]) {
        const c = { ...base, sprint: sprint && (base.forward || base.back || base.left || base.right) }
        const r = run(bot, state, c, air)
        if (!r.fall) { pick = c; bestT = Infinity; break }
        // Не спастись — тянуть к краю как можно дольше: может зацепиться.
        if (r.t > bestT) { bestT = r.t; pick = c }
      }
      if (bestT === Infinity) break
    }
    if (pick) {
      state.control = { ...pick, _ndGuard: true }
      state.jumpQueued = false
      stats.air++
      note(bestT === Infinity ? 'в полёте рулю от ямы' : 'в полёте тяну к краю')
    }
  }

  const wrapped = function (state, world) {
    try {
      if (on && state && state.control && typeof state.control === 'object' && isReal(state.control) && bot.entity) filter(state)
    } catch (e) {
      if (process.env.ND_DEBUG_EDGES) console.log('[edges] guard', e.message)
    }
    return orig.call(this, state, world)
  }
  ph.simulatePlayer = wrapped
  return {
    stats,
    // Намеренный спуск (со своего столба): падение до depth блоков — можно.
    // Клатч блоком (clutch.js) тоже видит намеренный спуск: bot._ndClutchAllowUntil.
    allow (depth, ms = 1500) {
      allowSafe = Math.max(SAFE_FALL, depth)
      allowUntil = gameClock.now() + ms
      bot._ndClutchAllowUntil = allowUntil
    },
    stop () {
      on = false
      if (bot._ndClutchAllowUntil === allowUntil) delete bot._ndClutchAllowUntil
      if (ph.simulatePlayer === wrapped) ph.simulatePlayer = orig
    }
  }
}

export { guard }
