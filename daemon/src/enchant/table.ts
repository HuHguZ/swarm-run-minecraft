'use strict'
// Зачарование: стол на месте — найти или поставить, расчистить кольцо, сделать и расставить полки, подойти.
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from '../movement'
import { withTimeout, placeBlockAt } from '../build'
import actions = require('../actions')
import { countOf, equipBestTool } from '../items'
import { REPLACEABLE, MAX_SHELVES, shelfPower, shelfCells } from './facts'

// ------------------------------------------------------------ стол

export function findTable (bot, mcData, r = 16) {
  const id = mcData.blocksByName.enchanting_table.id
  return bot.findBlock({ matching: id, maxDistance: r })
}

// Площадка 5x5 под стол с кольцом полок: пол сплошной, два слоя свободны.
function siteCost (bot, c) {
  let dig = 0
  let fill = 0
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const floor = bot.blockAt(c.offset(dx, -1, dz))
      if (!floor) return null
      if (/water|lava/.test(floor.name)) return null
      if (floor.boundingBox !== 'block') fill++
      for (let dy = 0; dy <= 1; dy++) {
        const b = bot.blockAt(c.offset(dx, dy, dz))
        if (!b || /water|lava/.test(b.name)) return null
        if (b.boundingBox === 'block' && !REPLACEABLE.test(b.name)) dig++
      }
    }
  }
  return { dig, fill, cost: dig * 2 + fill * 3 }
}
function pickSite (bot) {
  const me = bot.entity.position.floored()
  let best = null
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const c = me.offset(dx, dy, dz)
        const s = siteCost(bot, c)
        if (!s) continue
        const cost = s.cost + Math.abs(dx) * 0.3 + Math.abs(dz) * 0.3 + Math.abs(dy)
        if (!best || cost < best.cost) best = { c, ...s, cost }
      }
    }
  }
  return best
}

export async function walkNear (bot, pos, range, ms = 12000) {
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)), ms, 'не дошёл')
  } catch {} finally { try { bot.pathfinder.setGoal(null) } catch {} }
  return bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= range + 1.5
}
async function standAt (bot, cell, ms = 10000) {
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(cell.x, cell.y, cell.z)), ms, 'не встал')
  } catch {} finally { try { bot.pathfinder.setGoal(null) } catch {} }
  return bot.entity.position.floored().equals(cell)
}

// Площадку ровняем сами: копаем лишнее, досыпаем пол. Недорого на ровном.
async function clearSite (session, ctl, c) {
  const bot = session.bot
  let dug = 0
  let filled = 0
  for (let dy = 1; dy >= 0; dy--) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (ctl.aborted) return { dug, filled }
        const p = c.offset(dx, dy, dz)
        const b = bot.blockAt(p)
        if (!b || b.boundingBox !== 'block' || REPLACEABLE.test(b.name)) continue
        if (bot.entity.position.distanceTo(p) > 4) await walkNear(bot, p, 2, 6000)
        try { await equipBestTool(bot, b); await withTimeout(bot.dig(b, true), 8000, 'не копается'); dug++ } catch {}
      }
    }
  }
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (ctl.aborted) return { dug, filled }
      const p = c.offset(dx, -1, dz)
      const b = bot.blockAt(p)
      if (!b || b.boundingBox === 'block') continue
      if (bot.entity.position.distanceTo(p) > 4) await walkNear(bot, p, 2, 6000)
      const r = await placeBlockAt(bot, p, { timeoutMs: 1500 })
      if (r.ok) filled++
    }
  }
  return { dug, filled }
}

// Скрафтить, если чего-то не хватает, через обычный крафт (actions.craft — он
// сам ставит и забирает верстак). Возвращает, сколько теперь есть.
// Большой заказ (135 бумаги) mineflayer за один bot.craft не доводит — на
// 1.21.11 длинная серия кликов в окне верстака рвётся на середине (прогон
// try-enchant: из 45 заходов прошло 29). Поэтому порциями и до упора, пока
// растёт.
export async function craftUpTo (session, ctl, name, want) {
  const bot = session.bot
  const start = countOf(bot, name)
  let error = null
  for (let i = 0; i < 12 && !ctl.aborted; i++) {
    const have = countOf(bot, name)
    if (have >= want) break
    try {
      await actions.craft(session, ctl, { item: name, count: Math.min(want - have, 24), spendReserve: true })
      error = null
    } catch (e) { error = e.message }
    await sleep(700) // invsync: полная копия рюкзака приходит после закрытия окна
    if (countOf(bot, name) <= have) break
  }
  const have = countOf(bot, name)
  return { have, crafted: have - start, error: have >= want ? undefined : error || undefined }
}

// Книги → полки: бумага из тростника, книга = 3 бумаги + кожа.
async function makeShelves (session, ctl, want, lines) {
  const bot = session.bot
  let shelves = countOf(bot, 'bookshelf')
  if (shelves >= want) return shelves
  const need = want - shelves
  const books = countOf(bot, 'book')
  if (books < need * 3) {
    const paperNeed = (need * 3 - books) * 3
    if (countOf(bot, 'paper') < paperNeed && countOf(bot, 'sugar_cane') >= 3) {
      await craftUpTo(session, ctl, 'paper', Math.min(paperNeed, countOf(bot, 'paper') + Math.floor(countOf(bot, 'sugar_cane') / 3) * 3))
    }
    const canBooks = Math.min(Math.floor(countOf(bot, 'paper') / 3), countOf(bot, 'leather'))
    if (canBooks > 0) await craftUpTo(session, ctl, 'book', books + Math.min(canBooks, need * 3 - books))
  }
  const canShelves = Math.min(need, Math.floor(countOf(bot, 'book') / 3))
  if (canShelves > 0) {
    const r = await craftUpTo(session, ctl, 'bookshelf', shelves + canShelves)
    if (r.error) lines.push(`⚠ полки не скрафтил: ${r.error}`)
  }
  shelves = countOf(bot, 'bookshelf')
  return shelves
}

// Поставить стол (и полки вокруг, если есть). Возвращает блок стола.
export async function setupTable (session, ctl, { shelves: wantShelves = MAX_SHELVES, lines = [] }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  let table = findTable(bot, mcData, 16)
  const report: any = { placedTable: false, placedShelves: 0 }

  if (!table) {
    if (!countOf(bot, 'enchanting_table')) {
      if (!countOf(bot, 'book') && countOf(bot, 'paper') < 3 && countOf(bot, 'sugar_cane') >= 3) await craftUpTo(session, ctl, 'paper', 3)
      if (!countOf(bot, 'book')) await craftUpTo(session, ctl, 'book', 1)
      const r = await craftUpTo(session, ctl, 'enchanting_table', 1)
      if (!r.have) {
        throw new Error('стола нет и не из чего: стол = книга + 2 алмаза + 4 обсидиана (книга = 3 бумаги + кожа, бумага = 3 тростника)' +
          (r.error ? ` — ${r.error}` : ''))
      }
    }
    if (ctl.aborted) throw new Error('прервано')
    const site = pickSite(bot)
    if (!site) throw new Error('рядом нет площадки 5x5 под стол с полками (вода/лава или мир не прогружен)')
    const c = site.c
    await walkNear(bot, c, 2)
    if (site.dig || site.fill) {
      const cl = await clearSite(session, ctl, c)
      if (cl.dug || cl.filled) lines.push(`▸ площадка: выкопал ${cl.dug}, досыпал пол ${cl.filled}`)
    }
    // Встать в кольцо 1 (оно и есть зазор под правило полок), стол — в центр.
    await standAt(bot, c.offset(1, 0, 0))
    const r = await placeBlockAt(bot, c, { item: 'enchanting_table', timeoutMs: 3000 })
    await sleep(200)
    table = bot.blockAt(c)
    if (!table || table.name !== 'enchanting_table') throw new Error(`стол не встал: ${r.reason || 'не знаю почему'}`)
    report.placedTable = true
    report.table = xyz(c)
  }
  report.table = xyz(table.position)

  // Полки: нижний слой кольца 2, дверь — клетка (0,0,-2). 15 = потолок игры.
  const power0 = shelfPower(bot, table.position)
  const want = Math.min(MAX_SHELVES, wantShelves)
  if (power0.counted < want) {
    const have = await makeShelves(session, ctl, want - power0.counted, lines)
    if (have > 0) {
      const c = table.position
      const door = c.offset(0, 0, -2)
      const slots = shelfCells(c).map(s => c.plus(s.off)).filter(p => !p.equals(door))
        // нижний слой сперва: его видно и ставится он на пол
        .sort((a, b) => a.y - b.y)
      // Зазор (кольцо 1) должен быть пуст — это правило стола, не наша прихоть.
      for (const s of shelfCells(c)) {
        const g = bot.blockAt(c.plus(s.gap))
        if (g && g.boundingBox === 'block' && !g.position.equals(c) && g.name !== 'bookshelf') {
          try { await equipBestTool(bot, g); await withTimeout(bot.dig(g, true), 8000, 'не копается') } catch {}
        }
      }
      if (!bot.entity.position.floored().equals(c.offset(1, 0, 0))) await standAt(bot, c.offset(1, 0, 0))
      let placed = 0
      for (const p of slots) {
        if (ctl.aborted || !countOf(bot, 'bookshelf')) break
        if (shelfPower(bot, c).counted >= want) break
        const b = bot.blockAt(p)
        if (!b || b.name === 'bookshelf') continue
        if (b.boundingBox === 'block' && !REPLACEABLE.test(b.name)) continue
        const r = await placeBlockAt(bot, p, { item: 'bookshelf', timeoutMs: 1500 })
        if (r.ok && !r.already) placed++
      }
      report.placedShelves = placed
    }
  }
  const power = shelfPower(bot, table.position)
  report.shelves = power.counted
  if (power.blocked) lines.push(`⚠ ${power.blocked} полок не считаются: между ними и столом не воздух`)
  return { table, report }
}

// ------------------------------------------------------------ зачарование

// Встать так, чтобы стол был под рукой (кольцо 1, если свободно).
export async function approachTable (bot, table) {
  if (bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5)) <= 3.5) return
  const c = table.position
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
    const cell = c.offset(dx, 0, dz)
    const b = bot.blockAt(cell)
    const h = bot.blockAt(cell.offset(0, 1, 0))
    if (b && h && b.boundingBox === 'empty' && h.boundingBox === 'empty') {
      if (await standAt(bot, cell, 8000)) return
    }
  }
  await walkNear(bot, c, 2)
}

// Снять надетое, если его зачаровываем (стол берёт вещь из рюкзака).
export async function unwearIfNeeded (bot, target) {
  if (target.item.slot >= 5 && target.item.slot <= 8) {
    const dest = { 5: 'head', 6: 'torso', 7: 'legs', 8: 'feet' }[target.item.slot]
    try { await bot.unequip(dest) } catch {}
    await sleep(300)
    target.rewear = dest
  }
}
