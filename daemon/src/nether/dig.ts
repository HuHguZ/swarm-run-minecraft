'use strict'
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { xyz, stuckGuard, unstick, gotoPath } from '../movement'
import { placeBlockAt, withTimeout } from '../build'
import { equipBestTool, missingHarvestTool } from '../items'
import { PORTAL_EMPTY, REACH, eyes, centre, sameCell } from './shape'

// ---------------------------------------------------------------- doing it

function sleep (ms, ctl?: any) {
  return new Promise<any>(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve(undefined) })
  })
}

async function walkNear (session, ctl, target, range = 1) {
  const bot = session.bot
  if (bot.entity.position.distanceTo(target.offset(0.5, 0, 0.5)) <= range + 0.5) return { ok: true, walked: false }
  const guard = stuckGuard(bot, ctl)
  const path = gotoPath(bot, new goals.GoalNear(target.x, target.y, target.z, range))
  try {
    await Promise.race([
      path,
      guard.promise
    ])
    if (bot.entity.position.distanceTo(target.offset(0.5, 0, 0.5)) > range + 0.5) return { ok: false, walked: true, error: 'pathfinder не дошёл к цели' }
    return { ok: true, walked: true }
  } catch (e) {
    path.cancel?.()
    try { bot.pathfinder.setGoal(null) } catch {}
    await unstick(bot)
    return { ok: false, walked: true, error: e.message }
  } finally {
    path.cancel?.()
    guard.stop()
  }
}

// The server refuses a dig or a placement past the interaction range (4.5 on
// 1.21), and every refusal is silent — the block simply stays. A site chosen
// four blocks away can have a far corner seven blocks off, so the body walks to
// whatever it is about to touch instead of reaching for it.
async function inReach (session, ctl, cell) {
  const bot = session.bot
  if (eyes(bot).distanceTo(centre(cell)) <= REACH) return true
  await walkNear(session, ctl, cell, 2)
  return eyes(bot).distanceTo(centre(cell)) <= REACH + 0.5
}

async function clearCells (session, ctl, cells) {
  const bot = session.bot
  let dug = 0
  const pending = cells.slice()
  while (pending.length) {
    if (ctl.aborted) return { dug, stopped: 'прервано' }
    let next = 0
    if (process.env.ND_FRAME_FRONTIER !== '0') {
      // Top-down remains the preference, but an opaque upper/far cell may be
      // exposed only by another cell in this same approved clearing list.
      // Never enlarge that list or swing through the occluding block.
      for (const c of pending) {
        const b = bot.blockAt(c)
        if (!b) return { dug, stopped: `клетка ${c.x},${c.y},${c.z} не прогружена` }
        if (/water|lava/.test(b.name)) return { dug, stopped: `${b.name} внутри рамы — сначала заделать источник` }
      }
      const visible = pending.findIndex(c => {
        const b = bot.blockAt(c)
        return !PORTAL_EMPTY.test(b.name) && eyes(bot).distanceTo(centre(c)) <= REACH && (require('../sight') as typeof import('../sight')).seesBlock(bot, b)
      })
      if (visible >= 0) next = visible
    }
    const c = pending.splice(next, 1)[0]
    const b = bot.blockAt(c)
    if (!b) return { dug, stopped: `клетка ${c.x},${c.y},${c.z} не прогружена` }
    if (PORTAL_EMPTY.test(b.name)) continue
    if (/water|lava/.test(b.name)) return { dug, stopped: `${b.name} внутри рамы — сначала заделать источник` }
    if (!(await inReach(session, ctl, c))) return { dug, stopped: `до ${b.name} на ${c.x},${c.y},${c.z} не дотянуться` }
    if (!(require('../sight') as typeof import('../sight')).seesBlock(bot, b)) return { dug, stopped: `${b.name} не виден в прицеле` }
    const problem = missingHarvestTool(bot, b, session.mcData)
    const byHand = problem && (b.hardness ?? 99) >= 0 && (b.hardness ?? 99) <= 2 && !/obsidian|bedrock|portal/.test(b.name)
    if (problem && !byHand) return { dug, stopped: problem }
    try {
      await equipBestTool(bot, b)
      // 20s and not 8: the same wrapper mining.js uses. Nothing here is
      // obsidian, but gravel refilling the slot and a dropped swing both cost
      // whole seconds, and a wrapper that fires early leaves a half-cleared hole.
      await withTimeout(bot.dig(b), 20000, `${b.name} не ломается`)
      dug++
      await sleep(120, ctl)
      const after = bot.blockAt(c)
      if (!after || !PORTAL_EMPTY.test(after.name)) return { dug, stopped: `${b.name} остался на ${c.x},${c.y},${c.z} после копки` }
    } catch (e) {
      return { dug, stopped: `${b.name} на ${c.x},${c.y},${c.z}: ${e.message}` }
    }
  }
  return { dug }
}

// Штрек по Аду к точке — когда ногами не пройти. pathfinder в Аду встаёт у
// лавовых озёр и обрывов («путь длиной 0», try-nether-trip 2026-09-25: разведка
// крепости простояла на 205,84,112 восемь взглядов подряд), а netherrack
// (твёрдость 0.4) кирка берёт за доли секунды — так ходят и спидраннеры.
// Шаг — две клетки в сторону цели по большей оси (не вышло — по меньшей); с
// minY — ступенькой вниз, пока выше. Клетку с лавой (или лавой рядом, или
// лавой под полом) не трогаем: эта ось закрыта. Пустоту под ногами
// закладываем блоком. Кирпич крепости в забое — готовый ответ разведке.
// Ответ в форме endportal.tunnelUnder: { ok, dug, moved, placed, lava, why, bricks }.
const HEAT = /lava|water/
const BRICK = /^nether_brick/
async function bore (session, ctl, target, { deadline = gameClock.now() + 60000, maxSteps = 24, minY = null, maxY = null, throughBricks = false }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  let dug = 0
  let moved = 0
  let placed = 0
  let lava = 0
  const hot = c => {
    for (const n of [c, c.offset(1, 0, 0), c.offset(-1, 0, 0), c.offset(0, 0, 1), c.offset(0, 0, -1), c.offset(0, 1, 0)]) {
      const b = bot.blockAt(n)
      if (!b) return 'непрогруженный мир'
      if (HEAT.test(b.name)) return b.name
    }
    return null
  }
  const out = (ok, extra: any = {}) => ({ ok, dug, moved, placed, lava: lava || undefined, at: xyz(bot.entity.position), ...extra })
  const settle = async c => {
    // dig() рисует local air раньше сервера. Видимый падающий блок ещё может
    // заполнить клетку; дождаться оседания и перечитать, не шагать в прогноз.
    while (true) {
      if (ctl.aborted) return 'прервано'
      if (gameClock.now() >= deadline) return 'время вышло'
      const heat = hot(c)
      if (heat) { if (/lava/.test(heat)) lava++; return `у забоя ${heat}` }
      if (bot.blockAt(c)?.boundingBox !== 'empty' || !(require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot, { radius: REACH + 1 }).some(e =>
        e.seen && e.name === 'falling_block' && e.pos && Math.floor(e.pos.x) === c.x && Math.floor(e.pos.z) === c.z && e.pos.y >= c.y)) return null
      await sleep(50, ctl)
    }
  }
  try { bot.pathfinder.setGoal(null) } catch {}
  for (let s = 0; s < maxSteps; s++) {
    if (ctl.aborted) return out(false, { why: 'прервано' })
    if (gameClock.now() > deadline) return out(false, { why: 'время вышло' })
    const f = bot.entity.position.floored()
    // On a low collision floor (soul sand), floored feet name the support
    // itself. Start the tunnel above its actual top instead of digging it out.
    const support = (require('../navigation/geometry') as typeof import('../navigation/geometry')).supportAt(bot, bot.entity.position, .04)
    if (support) f.y = Math.ceil(support.top)
    const ddx = target.x - f.x
    const ddz = target.z - f.z
    if (Math.abs(ddx) <= 1 && Math.abs(ddz) <= 1) return out(true)
    const axes = Math.abs(ddx) >= Math.abs(ddz)
      ? [[Math.sign(ddx), 0], [0, Math.sign(ddz)]]
      : [[0, Math.sign(ddz)], [Math.sign(ddx), 0]]
    // Ступенькой вниз, пока выше minY; вверх — пока ниже maxY (дорога домой
    // к порталу на y=116 из крепости на y=47).
    const dys = minY !== null && f.y > minY ? [-1, 0] : maxY !== null && f.y < maxY ? [1, 0] : [0]
    let stepped = false
    let why = null
    for (const [sx, sz] of axes) {
      if (stepped) break
      if (!sx && !sz) continue
      for (const dy of dys) {
        const feet = f.offset(sx, dy, sz)
        const head = feet.offset(0, 1, 0)
        // Вниз ступенькой тело проходит и клетку над новой головой, вверх —
        // клетку над своей головой (прыжок).
        const cells = dy < 0 ? [head.offset(0, 1, 0), head, feet] : dy > 0 ? [f.offset(0, 2, 0), head, feet] : [head, feet]
        const heat = cells.map(hot).find(Boolean)
        if (heat) { if (/lava/.test(heat)) lava++; why = `у забоя ${heat}`; continue }
        const floor = bot.blockAt(feet.offset(0, -1, 0))
        if (!floor) { why = 'непрогруженный мир'; continue }
        if (HEAT.test(floor.name)) { lava++; why = 'под полом забоя лава'; continue }
        const brick = cells.map(c => bot.blockAt(c)).find(b => b && BRICK.test(b.name))
        // Разведке кирпич — ответ; дороге домой — просто стена (прогон 12:
        // из коридора крепости штрек «находил» её на каждом шаге и не шёл).
        if (brick && !throughBricks) return out(true, { bricks: { name: brick.name, at: xyz(brick.position) } })
        let err = null
        for (const c of cells) {
          // Гравий сыплется сверху — до четырёх раз в ту же клетку.
          for (let k = 0; k < 4 && !err; k++) {
            if (ctl.aborted) return out(false, { why: 'прервано' })
            if (gameClock.now() >= deadline) return out(false, { why: 'время вышло' })
            const heat = hot(c)
            if (heat) { if (/lava/.test(heat)) lava++; err = `у забоя ${heat}`; break }
            err = await settle(c)
            if (err) break
            const b = bot.blockAt(c)
            if (!b || (b.boundingBox === 'empty' && !/fire/.test(b.name))) break
            // Спавнер не ломать: штрек к залу блейзов (fortress climbTo) и к комнате крепости шёл прямо на него.
            if (b.diggable === false || /bedrock|portal|^spawner$/.test(b.name)) { err = `${b.name} не копается`; break }
            // Кирпич с чешуйницей не ломать: выпущенная зовёт соседних (ферма,
            // штрек к комнате крепости A — «slain by Silverfish»).
            if (/^infested_/.test(b.name)) { err = `${b.name} — там чешуйница`; break }
            const cut = await clearCells(session, ctl, [c])
            dug += cut.dug
            await sleep(60, ctl)
            err = await settle(c)
            if (err) break
            const remaining = bot.blockAt(c)
            if (!cut.stopped && remaining && /^(gravel|sand|red_sand)$/.test(remaining.name)) cut.stopped = `${b.name} остался на ${c.x},${c.y},${c.z} после копки`
            if (cut.stopped) {
              const refilled = cut.dug > 0 && cut.stopped === `${b.name} остался на ${c.x},${c.y},${c.z} после копки` &&
                remaining && /^(gravel|sand|red_sand)$/.test(remaining.name)
              if (!refilled || k === 3) err = cut.stopped
            }
          }
          if (err) break
        }
        if (err) { why = err; continue }
        if (ctl.aborted) return out(false, { why: 'прервано' })
        // Вскрыли лаву копкой — назад не лезем.
        const after = cells.map(hot).find(h => h && /lava/.test(h))
        if (after) { lava++; why = `вскрыл ${after}`; continue }
        const fl = bot.blockAt(feet.offset(0, -1, 0))
        if (fl && fl.boundingBox !== 'block') {
          const below = bot.blockAt(feet.offset(0, -2, 0))
          if (below && HEAT.test(below.name)) { lava++; why = 'под забоем пустота над лавой'; continue }
          const r = await placeBlockAt(bot, feet.offset(0, -1, 0), { steady: true }).catch(e => ({ ok: false, reason: e.message }))
          if (!r.ok) { why = `пол забоя не заложить: ${r.reason}`; continue }
          placed++
        }
        const t0 = gameClock.now(), from = bot.entity.position.clone()
        const landed = () => {
          const p = bot.entity.position, v = bot.entity.velocity || { x: 0, z: 0 }
          return sameCell(p, feet) && bot.entity.onGround && Math.hypot(p.x - feet.x - .5, p.z - feet.z - .5) < .2 && Math.hypot(v.x, v.z) < .03
        }
        try {
          while (!ctl.aborted && gameClock.now() - t0 < 1800 && !landed()) {
            if (dy <= 0 && bot.entity.position.y < feet.y - .2) break
            const steer = (require('../blockmoves') as typeof import('../blockmoves')).steerTo(bot, bot.entity, { x: feet.x + .5, z: feet.z + .5 }, false)
            await bot.look(steer.yaw, 0, true)
            bot.setControlState('forward', steer.forward)
            bot.setControlState('jump', dy > 0 && bot.entity.position.y < feet.y)
            await sleep(50)
          }
        } finally { try { bot.setControlState('forward', false); bot.setControlState('jump', false) } catch {} }
        if (landed()) { moved++; stepped = true; break }
        if (bot.entity.position.distanceTo(from) > .25) return out(false, { why: 'клетка после шага изменилась — нужен новый обзор' })
        why = 'в забой не шагнуть'
      }
    }
    if (!stepped) return out(false, { why: why || 'штрек не пошёл' })
  }
  return out(false, { why: `за ${maxSteps} шагов штреком не дошёл` })
}

export { sleep, walkNear, inReach, clearCells, bore }
