'use strict'
// Крепость и портал в Край (endportal.ts): общее — место в памяти, кирпич крепости, честный спуск, ходьба, чешуйницы, видимые рамки.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
const { stuckGuard }: typeof import('../movement') = require('../movement')
const { seesBlock }: typeof import('../sight') = require('../sight')

const PLACE = 'крепость'
const ROOM = 'портал в Край'

// Кирпич крепости. Каменный кирпич в верхнем мире сам по себе не растёт —
// увидел его под землёй, значит, ты в крепости (или в руинах/иглу, что
// отличит только комната).
const BRICKS = /^(stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|infested_(stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks)|stone_brick_stairs|mossy_stone_brick_stairs|stone_brick_slab|iron_bars|end_portal_frame)$/

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// Честный спуск (S5e 07.10, AGENTS.md «как на случайном сиде»): решения шахты, штрека и выбора колонки — только по видимому
// (луч глаз) и слышимому; толща не читается. scan («полный скан») и ND_HONEST_SHAFT=0 — прежний ход по прогруженным чанкам.
function honestDescent () { return process.env.ND_HONEST_SHAFT !== '0' && (require('../perception/knowledge') as typeof import('../perception/knowledge')).level() !== 'scan' }

// Клетка, как её знает игрок: в честном режиме — только видимая сейчас (иначе null — «не знаю»).
function look (bot, p) {
  if (!honestDescent()) return bot.blockAt(p)
  try { return (require('../perception/eyes') as typeof import('../perception/eyes')).seesNow(bot, p) ? bot.blockAt(p) : null } catch { return null }
}
const log = (what, o) => console.log('[stronghold]', what, JSON.stringify(o))

function placeOf (session, name) {
  const places = (session.journal.state && session.journal.state.places) || {}
  return places[name] || null
}

function savePlace (session, name, rec, journalText) {
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[name] = { ...(s.places[name] || {}), ...rec }
  })
  if (journalText) session.journal.append(name, journalText, new Vec3(rec.x, rec.y ?? 0, rec.z))
}

async function walkTo (bot, ctl, target, range, ms) {
  const guard = stuckGuard(bot, ctl, 10000)
  let timer = null
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, range)),
      guard.promise,
      new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), Math.max(500, ms)) }),
      // Обрыв (nether.guarded: ударили по дороге) — не ждать конца пути.
      new Promise<any>((_resolve, reject) => { if (ctl && Array.isArray(ctl.onAbort)) ctl.onAbort.push(() => reject(new Error('прервано'))) })
    ])
    return { ok: true }
  } catch (e) {
    try { bot.pathfinder.setGoal(null) } catch {}
    return { ok: false, error: e.message }
  } finally {
    guard.stop()
    if (timer) gameClock.clearTimeout(timer)
  }
}

// Кирпич с чешуйницей (infested_*) выглядит как обычный, но сломать его —
// выпустить чешуйницу, а она зовёт соседних (лаборатория 2026-09-27, прогон
// 16: «slain by Silverfish»; первый кирпич шахты у -1024,5680 — infested).
// На время работы в крепости pathfinder их не ломает (blocksCantBreak).
const INFESTED = /^infested_/
function noInfested (bot) {
  const mv = bot.pathfinder && bot.pathfinder.movements
  const added = []
  if (mv && mv.blocksCantBreak) {
    for (const b of ((Object.values(bot.registry.blocksByName) as any[]) as any)) {
      if (INFESTED.test(b.name) && !mv.blocksCantBreak.has(b.id)) { mv.blocksCantBreak.add(b.id); added.push(b.id) }
    }
  }
  return () => { for (const id of added) { try { mv.blocksCantBreak.delete(id) } catch {} } }
}

// Рамки, которые ВИДНО (луч от глаз): рамку за стеной честно не замечаем.
function visibleOf (bot, ids, radius, count = 64) {
  const out = []
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count })
  for (const p of found) {
    const b = bot.blockAt(p)
    if (b && seesBlock(bot, b)) out.push(b)
  }
  return out
}

export {
  PLACE, ROOM, BRICKS, clamp, honestDescent, look, log, placeOf, savePlace, walkTo, INFESTED, noInfested, visibleOf
}
