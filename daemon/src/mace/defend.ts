import * as gameClock from '../game-clock'
// Булава (mace.ts): защита от булавы сверху — щит к нему, шаг из-под него, не стоять под ним.
// ---------------------------------------------------------------- защита

// Ответ на «булаву сверху». Щит надет — поднять к нему (5 тиков до того,
// как держит: поднимать сразу, пока он ещё летит вверх); почти над головой —
// шаг назад, чтобы горизонталь до него не была нулём. Щита нет или поздно —
// в сторону от точки, куда он сядет (его руль в воздухе — ~0.02 б/т²), спринтом.
// Сидит сверху с булавой — не стоять под ним: отойти на 3.6+.
export function defend (bot, t, { guard = null, entity: e = null, vel = null, set, keyDir, stepSafe, stats = null }: any = {}) {
  const shield = guard?.stats?.worn && bot.inventory?.slots?.[45]?.name === 'shield' && (bot._ndShieldDisabledUntil || 0) <= gameClock.now()
  const setKeys = (k) => { for (const x of ['forward', 'back', 'left', 'right']) set(x, x === k); set('sprint', k === 'forward'); set('jump', false) }
  if (t.kind === 'above') {
    setKeys(stepSafe(keyDir(bot, 'back')) ? 'back' : null)
    return 'не стою под ним — он сверху с булавой'
  }
  // Щит держит только через 5 тиков после подъёма (Items.SHIELD:
  // BlocksAttacks(0.25F, …) — blockDelayTicks 5) и тик — на доставку: до удара
  // меньше 6 тиков, а щит ещё не поднят — не успеет, уходить (арена 2026-09-26:
  // «булава сверху: щит 1, уклон 1, получил 20» — щит подняли за 3 тика).
  if (shield && (t.eta >= 6 || t.shielded)) {
    guard.raise(true)
    if (stats && !t.shielded) { t.shielded = true; stats.shieldUps++ }
    // Над самой головой щит не держит (горизонталь 0) — шаг назад.
    setKeys(t.dh < 0.7 && stepSafe(keyDir(bot, 'back')) ? 'back' : null)
    set('sprint', false)
    return 'щит к булаве сверху'
  }
  // Шаг в сторону: куда дальше от точки, где он сядет.
  const me = bot.entity.position
  let land = e && e.position ? e.position : null
  if (land && vel) { const v = vel() || { x: 0, z: 0 }, k = (1 - .91 ** Math.min(t.eta, 40)) / .09; land = land.offset(v.x * k, 0, v.z * k) }
  let best = null
  for (const k of ['back', 'left', 'right', 'forward']) {
    const dir = keyDir(bot, k)
    if (!stepSafe(dir)) continue
    const q = me.offset(dir.x * 2, 0, dir.z * 2)
    const dd = land ? Math.hypot(q.x - land.x, q.z - land.z) : 0
    if (!best || dd > best.dd) best = { k, dd }
  }
  if (!best) return null
  for (const x of ['forward', 'back', 'left', 'right']) set(x, x === best.k)
  set('sprint', true)
  if (stats && !t.dodged) { t.dodged = true; stats.dodges++ }
  return 'ушёл из-под булавы'
}
