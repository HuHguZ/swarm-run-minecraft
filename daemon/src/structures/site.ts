'use strict'
import { goals } from 'mineflayer-pathfinder'
import { raySees, eyePos } from '../perception'
import { v3, withTimeout } from './common'
import { CONTAINER_NAMES, TRAP_BLOCKS } from './kinds'

// ------------------------------------------------------------------ чужой сундук

// Признаки руки игрока у сундука. kind — в какой постройке он стоит:
// кровати в деревне и рамка на корабле Края — свои у игры.
function playerMarks (bot, pos, kind = null) {
  const out = []
  const p = v3(pos)
  const near = (re, r) => {
    try { return bot.findBlock({ matching: b => !!b && re.test(b.name), maxDistance: r, point: p }) } catch { return null }
  }
  if (near(/_sign$|_hanging_sign$/, 4)) out.push('табличка рядом')
  if (near(/^(ender_chest|[a-z_]*shulker_box|anvil|chipped_anvil|damaged_anvil|enchanting_table|beacon|jukebox|respawn_anchor)$/, 4)) out.push('эндер-сундук/шалкер/наковальня/стол чар рядом')
  const below = bot.blockAt(p.offset(0, -1, 0))
  const above = bot.blockAt(p.offset(0, 1, 0))
  if ((below && below.name === 'hopper') || (above && above.name === 'hopper')) out.push('воронка у сундука (сортировка)')
  if (kind !== 'village' && kind !== 'igloo' && near(/_bed$/, 5)) out.push('кровать рядом — не деревня')
  if (kind !== 'end_city') {
    for (const e of ((Object.values(bot.entities) as any[]) as any)) {
      if (e && /item_frame$|^armor_stand$/.test(e.name || '') && e.position && e.position.distanceTo(p) < 4) { out.push('рамка/стойка рядом'); break }
    }
  }
  return out
}

// ------------------------------------------------------------------ тело

function armTraps (session) {
  const bot = session.bot
  try { session.updateMovements() } catch {}
  const m = bot.pathfinder && bot.pathfinder.movements
  if (!m || !m.blocksToAvoid) return
  for (const n of TRAP_BLOCKS) {
    const b = bot.registry.blocksByName[n]
    if (b) m.blocksToAvoid.add(b.id)
  }
}

async function walk (session, ctl, goal, ms) {
  const bot = session.bot
  if (ctl.aborted) throw new Error('прервано')
  armTraps(session)
  const stop = () => { try { bot.pathfinder.setGoal(null) } catch {} }
  ctl.onAbort.push(stop)
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, `не дошёл за ${Math.round(ms / 1000)} с`)
  } finally {
    stop()
  }
}

function canReach (bot, pos, reach = 4.3) {
  return v3(pos).offset(0.5, 0.5, 0.5).distanceTo((require('../pick') as typeof import('../pick')).eyeOf(bot)) <= reach
}

// Сломать блок: подойти, взять лучший инструмент (или названный), копать.
// Копать — только то, что в прицеле (AGENTS.md: не сквозь стены; ревью Codex q2: копка доски за камнем уходила): точка
// контура блока, до которой луч из глаз не упирается ни в блок (стекло тоже, для действия), ни в живое; на неё взгляд, копка
// без своего доворота mineflayer. Без контура (посевы, трава) — луч в клетку (eyes.seesNow). walkMs ≤ 1 — не ходить.
async function digAt (session, ctl, pos, { tool = null, maxMs = 15000, walkMs = 25000 }: any = {}) {
  const bot = session.bot
  const pick: typeof import('../pick') = require('../pick')
  const p = v3(pos).floored()
  if (ctl.aborted) return { ok: false, why: 'прервано' }
  const aimAt = () => pick.blockAim(bot, p, { range: 4.5, seeThrough: null }) || ((require('../perception/eyes') as typeof import('../perception/eyes')).seesNow(bot, p) ? p.offset(0.5, 0.5, 0.5) : null)
  const ready = () => canReach(bot, p) && !!aimAt()
  if (!ready() && walkMs > 1) {
    for (const g of [() => new goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), () => new goals.GoalNear(p.x, p.y, p.z, 2)]) {
      if (ctl.aborted) break
      try { await walk(session, ctl, g(), walkMs) } catch {}
      if (ready()) break
    }
  }
  if (!canReach(bot, p)) return { ok: false, why: 'не дотянуться' }
  if (!aimAt()) return { ok: false, why: 'не в прицеле' }
  const b = bot.blockAt(p)
  if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'water') return { ok: true, name: b && b.name }
  const name = b.name
  try {
    const it = tool ? bot.inventory.items().find(i => i.name === tool) : (require('../tools') as typeof import('../tools')).bestFor(bot, b).item
    if (it && (!bot.heldItem || bot.heldItem.name !== it.name)) await bot.equip(it, 'hand')
  } catch {}
  // Прервали (сторож воздуха, бой) — копку бросить сразу, а не докапывать секундами под водой.
  let digging = false
  const stop = () => { if (digging) { try { bot.stopDigging() } catch {} } }
  if (Array.isArray(ctl.onAbort)) ctl.onAbort.push(stop)
  try {
    if (ctl.aborted) return { ok: false, name, why: 'прервано' }
    const aim = aimAt() // после экипировки — заново: тело могло сдвинуться
    if (!aim) return { ok: false, name, why: 'не в прицеле' }
    await bot.lookAt(aim, true)
    if (ctl.aborted) return { ok: false, name, why: 'прервано' }
    digging = true
    await withTimeout(bot.dig(b, 'ignore', undefined, ctl), maxMs, 'копал слишком долго')
  } catch (e) { return { ok: false, name, why: e.message } } finally {
    stop()
    const i = Array.isArray(ctl.onAbort) ? ctl.onAbort.indexOf(stop) : -1
    if (i >= 0) ctl.onAbort.splice(i, 1)
  }
  const now = bot.blockAt(p)
  return { ok: !now || now.name !== name, name }
}

async function pickUp (bot, ctl, radius = 6, ms = 6000) {
  try { return await (require('../actions') as typeof import('../actions')).collectNearbyDrops(bot, ctl, { radius, timeoutMs: ms }) } catch { return null }
}

function hostileNear (bot, r = 10) {
  try { return (require('../combat') as typeof import('../combat')).nearestHostile(bot, r) } catch { return null }
}

// Зачистить мобов вокруг (спавнер данжа): бить, пока есть кого, но не
// ниже 8 хп. combat.fight сам выбирает оружие и щит.
async function clearMobs (session, ctl, out, { radius = 12, rounds = 4 }: any = {}) {
  const bot = session.bot
  const combat: typeof import('../combat') = require('../combat')
  for (let i = 0; i < rounds && !ctl.aborted; i++) {
    const e = hostileNear(bot, radius)
    if (!e) break
    if ((bot.health ?? 20) < 8) { out.lines.push(`⚠ ${Math.round(bot.health)} хп — с мобами у спавнера не дерусь`); return false }
    // Пиглины в бастионе — не цель: драка поднимет весь бастион.
    if (/^(piglin|piglin_brute|zombified_piglin|enderman)$/.test(e.name)) break
    try {
      const r = await combat.fight(session, ctl, { target: e.name, timeoutSeconds: 30, clearArea: radius, retreatAtHealth: 7 })
      out.fought.push(`${e.name}${r && (r.killed || (r.kills && r.kills.length)) ? ' убит' : ''}`)
    } catch (err) { out.fought.push(`${e.name}: ${err.message}`); break }
  }
  return true
}

// Пиглины, которые увидят, как открываем сундук (куб ±16 и луч).
function piglinsWatching (bot) {
  const me = bot.entity.position
  const eye = eyePos(bot)
  return (Object.values(bot.entities) as any[]).filter((e : any) => e && /^piglin(_brute)?$/.test(e.name || '') && e.position &&
    Math.abs(e.position.x - me.x) <= 16.3 && Math.abs(e.position.y - me.y) <= 16.9 && Math.abs(e.position.z - me.z) <= 16.3 &&
    raySees(bot, e.position.offset(0, 1.6, 0), eye))
}

// Пиглины, которых разозлит сломанный золотой блок: ВСЕ в ±16, без луча
// (Block.playerWillDestroy → PiglinAi.angerNearbyPiglins(level, player, false);
// исходники 1.21.11, 2026-09-26). Для сундука взгляд нужен, для блока — нет.
function piglinsNear (bot) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'piglin' && e.position &&
    Math.abs(e.position.x - me.x) <= 16.3 && Math.abs(e.position.y - me.y) <= 16.9 && Math.abs(e.position.z - me.z) <= 16.3)
}

// S8d (аудит S10 №11/№12): блоки постройки — как нашёл бы игрок: память глаз + оглядеться (eyes.locate), а не findBlocks
// сквозь стены. На уровне знания scan eyes.locate сам берёт findBlocks (знание карты). ND_STRUCT_EYES=0 — прежнее (findBlocks).
function seenNear (bot, names, center, R, max = 32) {
  const c = v3(center)
  if (process.env.ND_STRUCT_EYES === '0') {
    const ids = names.map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
    try { return bot.findBlocks({ matching: ids, point: c, maxDistance: R, count: max }) } catch { return [] }
  }
  const radius = Math.min(160, bot.entity.position.distanceTo(c) + R)
  try { return (require('../perception/eyes') as typeof import('../perception/eyes')).locate(bot, names, { radius, max: max * 2, rays: 600, filter: q => q.distanceTo(c) <= R }).slice(0, max) } catch { return [] }
}
function containersNear (session, center, R, yR = 16) {
  return seenNear(session.bot, CONTAINER_NAMES, center, R, 32).filter(p => Math.abs(p.y - center.y) <= yR)
}

export {
  playerMarks, armTraps, walk, canReach, digAt, pickUp, clearMobs, piglinsWatching, piglinsNear, seenNear,
  containersNear
}
