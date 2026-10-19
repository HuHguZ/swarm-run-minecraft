'use strict'
// Зачарование: окна стола и наковальни (открыть, положить, забрать, свойства окна) и выбор предложения стола.
import * as gameClock from '../game-clock'
import { sleep } from '../movement'
import { withTimeout } from '../build'
import { enchantName, worthFor, ENCH, kindOf, enchantsOf, tierOf, orderOf } from './facts'

// ------------------------------------------------------------ окна

async function closeAny (bot) {
  const w = bot.currentWindow
  if (!w) return
  try { if (typeof w.close === 'function') w.close(); else bot.closeWindow(w) } catch {}
  await sleep(250)
}

// Окно на 1.21.11 открывается не с первого раза (containers.js raceOpen) —
// три попытки, опоздавшее окно закрываем сами.
export async function openBlockWindow (bot, block, what) {
  let last = null
  for (let i = 0; i < 3; i++) {
    await closeAny(bot)
    let gaveUp = false
    const opening = bot.openBlock(block)
    opening.then(w => { if (gaveUp && bot.currentWindow === w) { try { w.close() } catch {} } }, () => {})
    try {
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
      return await withTimeout(opening, 6000, `${what} не открылся`)
    } catch (e) {
      gaveUp = true
      last = e
      await sleep(400)
    }
  }
  throw last || new Error(`${what} не открылся`)
}

// Положить РОВНО один предмет (правый клик) — стол и стойка берут по одному.
// Номер клетки читаем ДО кликов: prismarine-windows переписывает item.slot у
// того же объекта, когда он переезжает (проба 2026-09-25 — второй клик ушёл
// не туда).
export async function putOne (bot, win, item, dest) {
  const src = item.slot
  await bot.clickWindow(src, 0, 0)
  await bot.clickWindow(dest, 1, 0)
  if (win.selectedItem) await bot.clickWindow(src, 0, 0)
  await sleep(120)
}
export async function putAll (bot, win, item, dest) {
  const src = item.slot
  await bot.clickWindow(src, 0, 0)
  await bot.clickWindow(dest, 0, 0)
  if (win.selectedItem) await bot.clickWindow(src, 0, 0)
  await sleep(120)
}
export async function takeOut (bot, win, slot) {
  if (!win.slots[slot]) return false
  try { await bot.putAway(slot); return true } catch { return false }
}

// Свойства окна (craft_progress_bar = container_set_data) с отметкой времени.
export function watchProps (bot, win) {
  const st: any = { props: {}, at: 0 }
  const on = p => { if (p.windowId !== win.id) return; st.props[p.property] = p.value; st.at = gameClock.now() }
  bot._client.on('craft_progress_bar', on)
  st.stop = () => bot._client.removeListener('craft_progress_bar', on)
  return st
}
export async function freshProps (st, since, ms = 3000) {
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < ms && st.at <= since) await sleep(50)
  await sleep(250)
  return st.at > since
}

// ------------------------------------------------------------ выбор

export function offersOf (bot, st) {
  const p = st.props
  return [0, 1, 2].map(i => {
    const clue = p[4 + i] ?? -1
    return {
      slot: i,
      cost: p[i] || 0,
      clue: clue >= 0 ? enchantName(bot, clue) : null,
      clueLevel: p[7 + i] ?? -1
    }
  })
}

export function worthOfOffer (kind, o) {
  if (!o.clue) return 0
  const w = worthFor(kind, o.clue)
  const max = (ENCH[o.clue] && ENCH[o.clue][0]) || 1
  return w.w * (0.4 + 0.6 * Math.min(1, Math.max(1, o.clueLevel) / max))
}

// Лучшая строка: ценность подсказки + доля за цену (дорогая строка часто даёт
// два-три зачарования) − уровни, которые уйдут. Доля за цену мала нарочно:
// сила II за 2 уровня луку полезнее прочности III за 3 (прогон try-enchant).
export function rankOffers (kind, offers, { level, lapis }: any) {
  return offers
    .filter(o => o.cost > 0)
    .map(o => {
      const worth = worthOfOffer(kind, o)
      const w = o.clue ? worthFor(kind, o.clue) : null
      return {
        ...o,
        worth: Math.round(worth * 10) / 10,
        score: worth + o.cost * 0.1 - (o.slot + 1) * 0.4,
        junk: !!(w && w.w < 2),
        why: w ? w.why : null,
        affordable: level >= o.cost && level >= o.slot + 1 && lapis >= o.slot + 1
      }
    })
    .sort((a, b) => b.score - a.score)
}

// Что зачаровать первым: лучшая незачарованная вещь по пользе и материалу.
export function chooseTargets (bot, { goal = 'default', count = 1, allowCheap = false }: any = {}) {
  const seen = new Set()
  const cand = []
  for (const it of bot.inventory.items()) {
    const kind = kindOf(it.name)
    if (!kind || kind === 'book') continue
    if (enchantsOf(bot, it).length) continue
    const tier = tierOf(it.name)
    if (!allowCheap && tier < 1) continue
    if (seen.has(it.name)) continue
    seen.add(it.name)
    cand.push({ item: it, kind, score: orderOf(kind, goal) * (0.6 + 0.1 * tier) })
  }
  // Надетое тоже в счёт: броню снимать не надо — стол берёт её из рюкзака, а
  // надетую сначала снимем (см. run).
  for (const slot of [5, 6, 7, 8]) {
    const it = bot.inventory.slots[slot]
    if (!it) continue
    const kind = kindOf(it.name)
    if (!kind || enchantsOf(bot, it).length || seen.has(it.name)) continue
    if (!allowCheap && tierOf(it.name) < 1) continue
    seen.add(it.name)
    cand.push({ item: it, kind, worn: true, score: orderOf(kind, goal) * (0.6 + 0.1 * tierOf(it.name)) })
  }
  cand.sort((a, b) => b.score - a.score)
  return cand.slice(0, count)
}
