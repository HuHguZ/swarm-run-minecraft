'use strict'
// Жители: торговля.
import { withTimeout } from '../build'
import { nearestOf, isBaby, approach, countOf, sleep } from './basics'

// ------------------------------------------------------------------ жители

function tradeView (t, i) {
  const item = (it) => it && it.name ? `${it.name}×${it.count}` : null
  return {
    index: i,
    give: [item(t.inputItem1), t.hasItem2 ? item(t.inputItem2) : null].filter(Boolean).join(' + '),
    price: t.realPrice,
    get: item(t.outputItem),
    left: (t.maximumNbTradeUses || 0) - (t.nbTradeUses || 0),
    disabled: !!t.tradeDisabled
  }
}

// mode=list — что продаёт ближайший житель; buy — сделка index × times.
export async function trade (session, ctl, { mode = 'list', index = null, times = 1, want = null, radius = 24 }: any = {}) {
  const bot = session.bot
  const vs = nearestOf(bot, 'villager', e => !isBaby(e), radius)
  if (!vs.length) return { stopped: `не вижу взрослого жителя в ${radius} блоках` }
  const v: any = vs[0]
  if (!(await approach(bot, ctl, v, 2))) return { stopped: 'не подошёл к жителю' }
  try { await bot.lookAt(v.position.offset(0, 1.5, 0), true) } catch {}
  let win = null
  try {
    win = await withTimeout(bot.openVillager(v), 6000, 'окно торговли не открылось (безработный или ребёнок не торгует)')
  } catch (e) {
    return { stopped: e.message }
  }
  try {
    const list = (win.trades || []).map(tradeView)
    if (mode === 'list') return { villager: v.id, trades: list, text: list.map(t => `#${t.index}: ${t.give} → ${t.get}${t.left <= 0 || t.disabled ? ' (закончилось)' : ''}`).join('; ') }
    let i = index
    if ((i === null || i === undefined) && want) i = list.findIndex(t => t.get && t.get.startsWith(want + '×') && t.left > 0 && !t.disabled)
    if (i === null || i === undefined || i < 0 || !list[i]) return { trades: list, stopped: want ? `${want} этот житель не продаёт` : 'не сказано, какую сделку (index или want)' }
    const n = Math.max(1, Math.min(times, list[i].left))
    const before = countOf(bot, (list[i].get || '').split('×')[0])
    try {
      await withTimeout(bot.trade(win, i, n), 8000, 'сделка не прошла')
    } catch (e) {
      return { trades: list, stopped: /Not enough/.test(e.message) ? `не хватает на сделку: ${list[i].give} × ${n}` : e.message }
    }
    // Рюкзак, пока окно открыто, — замороженная копия (containers.js:
    // «bot.inventory freezes the moment a window is up»): считать после
    // закрытия.
    try { win.close() } catch {}
    win = null
    await sleep(250)
    const got = countOf(bot, (list[i].get || '').split('×')[0]) - before
    return { bought: list[i].get, times: n, got, paid: list[i].give }
  } finally {
    if (win) { try { win.close() } catch {} }
  }
}
