'use strict'
// Зачарование: книги на наковальне — оценка и работа.
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import actions = require('../actions')
import { countOf } from '../items'
import { WANT, kindOf, enchantsOf, repairCostOf, conflicts, ENCH, worthFor, tierOf, orderOf, levelOf, fmtEnch } from './facts'
import { openBlockWindow, watchProps, putOne, freshProps, takeOut } from './window'
import { craftUpTo, walkNear } from './table'

// ------------------------------------------------------------ наковальня

// Что игра вообще примет на вещь этого вида (supported_items чар, по WANT +
// прочность/починка на всё с прочностью).
function supports (kind, name) {
  if (WANT[kind] && WANT[kind][name]) return true
  return kind !== 'book' && ['unbreaking', 'mending', 'vanishing_curse'].includes(name)
}

// Оценка цены по AnvilMenu.createResult: штрафы обоих + за каждое принятое
// зачарование anvil_cost (у книги /2, не меньше 1) × итоговый уровень;
// несовместимое или неподходящее — +1 и мимо. gain — польза: только то, что
// реально подняло уровень (сила 3 на лук с силой 4 — ноль, а уровни уйдут).
export function anvilEstimate (bot, left, right) {
  const kind = kindOf(left.name)
  const isBook = right.name === 'enchanted_book'
  const have = enchantsOf(bot, left)
  const add = enchantsOf(bot, right)
  let cost = repairCostOf(left) + repairCostOf(right)
  const result = new Map(have.map(e => [e.name, e.level]))
  let applied = 0
  let gain = 0
  for (const e of add) {
    const cur = result.get(e.name) || 0
    if (!supports(kind, e.name) || have.some(h => conflicts(h.name, e.name))) { cost += 1; continue }
    const max = (ENCH[e.name] && ENCH[e.name][0]) || 1
    const lvl = Math.min(max, cur === e.level ? cur + 1 : Math.max(cur, e.level))
    let per = (ENCH[e.name] && ENCH[e.name][1]) || 1
    if (isBook) per = Math.max(1, Math.floor(per / 2))
    cost += per * lvl
    if (lvl > cur) { applied++; gain += worthFor(kind, e.name).w * (lvl - cur) / max }
    result.set(e.name, lvl)
  }
  return { cost, applied, gain: Math.round(gain * 10) / 10, result: [...result].map(([name, level]) => ({ name, level })) }
}

function findAnvil (bot, mcData, r = 16) {
  const ids = ['anvil', 'chipped_anvil', 'damaged_anvil'].map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter(Boolean)
  return bot.findBlock({ matching: ids, maxDistance: r })
}

export async function anvilRun (session, ctl, p, lines) {
  const bot = session.bot
  const mcData = session.mcData
  const books = bot.inventory.items().filter(i => i.name === 'enchanted_book')
  if (!books.length) throw new Error('нет зачарованной книги — наковальня переносит чары с книги на вещь')
  // Цель: названная, иначе лучшая вещь, которой подходит книга.
  const worn = [5, 6, 7, 8].map(s => bot.inventory.slots[s]).filter(Boolean)
  const targets = [...bot.inventory.items(), ...worn].filter(i => kindOf(i.name) && kindOf(i.name) !== 'book' && (!p.item || i.name === p.item))
  let best = null
  for (const t of targets) {
    const kind = kindOf(t.name)
    for (const b of books) {
      if (p.book && !enchantsOf(bot, b).some(e => e.name === p.book)) continue
      const est = anvilEstimate(bot, t, b)
      if (!est.applied || est.cost >= 40 || est.gain < 1) continue
      // Незачарованную алмазную вещь слабой книгой не портим: после наковальни
      // стол её уже не примет, а там ждут 30 уровней с 2-3 чарами.
      if (!p.item && tierOf(t.name) >= 4 && !enchantsOf(bot, t).length && est.gain < 6) continue
      const score = est.gain * orderOf(kind, p.goal || 'default') * tierOf(t.name) - est.cost * 0.2
      if (!best || score > best.score) best = { t, b, est, score, kind }
    }
  }
  if (!best) throw new Error('нет пары «вещь + книга», где книга что-то даёт и дешевле 40 уровней')
  if (levelOf(bot) < best.est.cost) {
    return { skipped: `нужно ~${best.est.cost} ур., у меня ${levelOf(bot)}`, need: { what: 'уровни опыта', count: best.est.cost, have: levelOf(bot) } }
  }

  let anvil = findAnvil(bot, mcData, 16)
  if (!anvil) {
    if (!countOf(bot, 'anvil')) {
      if (countOf(bot, 'iron_block') < 3) await craftUpTo(session, ctl, 'iron_block', 3)
      const r = await craftUpTo(session, ctl, 'anvil', 1)
      if (!r.have) throw new Error('наковальни нет: 3 железных блока + 4 слитка (31 слиток)' + (r.error ? ` — ${r.error}` : ''))
    }
    await actions.place(session, ctl, { block: 'anvil' })
    await sleep(300)
    anvil = findAnvil(bot, mcData, 6)
    if (!anvil) throw new Error('наковальня не встала')
  }
  await walkNear(bot, anvil.position, 2)
  const bookEnch = enchantsOf(bot, best.b)
  const itemName = best.t.name
  const itemSig = JSON.stringify(enchantsOf(bot, best.t))
  // Надетое — снять (наковальня берёт из рюкзака), потом надеть обратно.
  const wornDest = best.t.slot >= 5 && best.t.slot <= 8 ? { 5: 'head', 6: 'torso', 7: 'legs', 8: 'feet' }[best.t.slot] : null
  if (wornDest) { try { await bot.unequip(wornDest) } catch {} await sleep(300) }
  const win = await openBlockWindow(bot, anvil, 'наковальня')
  const st: any = watchProps(bot, win)
  try {
    // Окно открылось сразу после стола/снятия брони — копия рюкзака в нём
    // может прийти чуть позже (прогон try-enchant: «пропали» на первом заходе).
    const find = () => ({
      it: win.items().find(i => i.name === itemName && JSON.stringify(enchantsOf(bot, i)) === itemSig),
      bk: win.items().find(i => i.name === 'enchanted_book' && JSON.stringify(enchantsOf(bot, i)) === JSON.stringify(bookEnch))
    })
    let got = find()
    for (let i = 0; i < 15 && (!got.it || !got.bk); i++) { await sleep(200); got = find() }
    const { it, bk } = got
    if (!it || !bk) throw new Error('вещь или книга пропали из рюкзака')
    await putOne(bot, win, it, 0)
    const since = gameClock.now()
    await putOne(bot, win, bk, 1)
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 3000 && !win.slots[2]) await sleep(50)
    await freshProps(st, since, 1500)
    const cost = st.props[0] ?? best.est.cost
    if (!win.slots[2]) throw new Error('наковальня не собрала результат')
    if (cost >= 40) throw new Error(`слишком дорого: ${cost} ур. (40 — потолок наковальни)`)
    if (levelOf(bot) < cost) throw new Error(`нужно ${cost} ур., у меня ${levelOf(bot)}`)
    const result = enchantsOf(bot, win.slots[2])
    await bot.putAway(2)
    await sleep(300)
    if (wornDest) {
      try { win.close() } catch {}
      await sleep(600)
      const back = bot.inventory.items().find(i => i.name === itemName)
      if (back) { try { await bot.equip(back, wornDest) } catch {} }
    }
    return {
      anvil: xyz(anvil.position),
      item: itemName,
      book: fmtEnch(bookEnch),
      cost,
      got: result,
      // Только то, что реально поднялось: чужая книге часть (сила на ботинках) — мимо.
      why: result.filter(r => { const b = bookEnch.find(e => e.name === r.name); const was = JSON.parse(itemSig).find(e => e.name === r.name); return b && (!was || r.level > was.level) })
        .map(e => `${e.name} ${e.level}: ${worthFor(best.kind, e.name).why}`),
      note: 'каждая работа на наковальне удваивает штраф вещи — самое ценное клади первым'
    }
  } finally {
    st.stop()
    try { if (bot.currentWindow === win) { await takeOut(bot, win, 0); await takeOut(bot, win, 1) } } catch {}
    try { win.close() } catch {}
    await sleep(500)
  }
}
