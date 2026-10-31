// Учёт трат зарядов ветра (ND_WIND_SPEND=1, 29.10, Claude): каждый бросок — use предмета wind_charge (рука или левая рука);
// источник — первый файл стека вне этого модуля и обёрток рук; раз в 30 с — «[wind-spend] {источник: бросков}» в журнал демона.
import * as gameClock from './game-clock'
const SKIP = /wind-spend|edges[\\/]mlg|mace[\\/]hands|throw-hand|itemuse|reflex-lock|projectile-evasion|node:|internal/
export function sourceOf (stack = '') {
  for (const line of stack.split('\n').slice(1)) {
    // Обёртки activateItem (рука клатча edges/mlg, ranged, свой учёт) — не источник броска.
    if (/activateItem/.test(line)) continue
    const m = line.match(/[\\/](daemon[\\/]src[\\/][^:()]+)\.js/)
    if (m && !SKIP.test(m[1])) return m[1].replace(/\\/g, '/').replace(/^daemon\/src\//, '')
  }
  return '?'
}
export function install (bot, session = null) {
  if (process.env.ND_WIND_SPEND !== '1' || !bot || bot._ndWindSpend || typeof bot.activateItem !== 'function') return
  const counts: Record<string, number> = {}
  bot._ndWindSpend = counts
  const raw = bot.activateItem.bind(bot)
  bot.activateItem = (off?: boolean, ...rest: any[]) => {
    const item = off ? bot.inventory?.slots?.[45] : bot.heldItem
    if (item?.name === 'wind_charge') { const k = sourceOf(new Error().stack) + (session?.current?.name ? '@' + session.current.name : ''); counts[k] = (counts[k] || 0) + 1 }
    return raw(off, ...rest)
  }
  const t = gameClock.wall.setInterval(() => { if (Object.keys(counts).length) { console.log('[wind-spend]', JSON.stringify(counts)); for (const k of Object.keys(counts)) delete counts[k] } }, 30000)
  t.unref?.(); bot.once?.('end', () => gameClock.wall.clearInterval(t))
}
