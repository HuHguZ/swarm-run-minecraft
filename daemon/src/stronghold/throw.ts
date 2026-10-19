'use strict'
// Поиск крепости (stronghold.ts): бросок ока — подняться для броска, проследить полёт, подобрать выпавшее.
import { goals } from 'mineflayer-pathfinder'
import * as gameClock from '../game-clock'
import { Vec3 } from 'vec3'
import { sleep, xyz } from '../movement'
import { countOf, itemNamed } from '../items'
import { DEG, EYE_REACH, POS_ERR, SIGMA_MIN, r1, snap16, withTimeout } from './rings'


// ------------------------------------------------------------------ бросок

// Один бросок и замер траектории. Отдаёт точку появления ока (точно), где оно
// висело к концу полёта, направление (bearing, радианы, компас), его σ, и
// near — угол чанка ближе 12 блоков (око пошло вниз, к y=0): тогда corner —
// сам угол, куда око пришло.
// Упавшее око — назад в рюкзак (лаборатория этапов 2026-09-27: 7 из 8
// брошенных очей «lost» — в воде у берега бот за ними не шёл, на деревьях
// джунглей — «выше 8 блоков»). Око падает в ~12 блоках от броска: по суше —
// pathfinder (копать листву и строить столб он умеет), в воде — вплавь
// руками (pathfinder из воды не выплывает, movement.escapeWater), потом на
// берег. В лаву — не лезть.
// Око на кроне дерева (лаборатория: око на листве в 8 блоках над землёй,
// pathfinder «partial» 37 с): встать под ним, столбом вверх до листвы над
// головой, сломать её — око падает на нас. Потом столб разобрать.
async function climbFor (bot, ctl, item) {
  const { towerUp }: typeof import('../build') = require('../build')
  const { standable }: typeof import('../walkable') = require('../walkable')
  const tools: typeof import('../tools') = require('../tools')
  const p = item.position.floored()
  // Клетка под ним или рядом (до 2 по горизонтали): столб рядом тоже годится —
  // подбор берёт на блок вбок (коробка тела +1), лишь бы встать на его высоту.
  const spots = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    for (let dy = 1; dy <= 24; dy++) { const c = p.offset(dx, -dy, dz); if (standable(bot, c)) { spots.push({ c, h: Math.hypot(dx, dz) }); break } }
  }
  spots.sort((a, b) => a.h - b.h)
  let ground = null
  for (const sp of spots.slice(0, 6)) {
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(sp.c.x, sp.c.y, sp.c.z)), 12000) } catch { try { bot.pathfinder.setGoal(null) } catch {} }
    if (bot.entity.position.floored().equals(sp.c)) { ground = sp.c; break }
    if (!bot.entities[item.id]) return { ok: true }
  }
  if (!ground) return { ok: false, why: spots.length ? 'под него не дошёл' : 'под ним не на чем стоять' }
  const base = ground
  let placed = 0
  let stepped = false
  // С вершины столба око в 1.5–2 блоках вбок не подбирается (подбор — коробка
  // тела +1 по горизонтали): шаг к нему по листве крадучись (с края не
  // упасть) и назад на столб. Лаборатория 2026-09-27, джунгли: 2 из 7 упавших
  // так и остались на кроне («не достал»).
  const sneakStep = async () => {
    const top = bot.entity.position.clone()
    const xz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
    try {
      bot.setControlState('sneak', true)
      const t0 = gameClock.now()
      while (!ctl.aborted && gameClock.now() - t0 < 3500 && bot.entities[item.id] && xz(bot.entity.position, item.position) > 0.4) {
        await bot.lookAt(new Vec3(item.position.x, bot.entity.position.y + 1.62, item.position.z), true).catch(() => {})
        bot.setControlState('forward', true)
        await sleep(50)
      }
      bot.setControlState('forward', false)
      await sleep(300)
      const t1 = gameClock.now()
      while (!ctl.aborted && gameClock.now() - t1 < 3500 && xz(bot.entity.position, top) > 0.25) {
        await bot.lookAt(new Vec3(top.x, bot.entity.position.y + 1.62, top.z), true).catch(() => {})
        bot.setControlState('forward', true)
        await sleep(50)
      }
    } finally {
      bot.clearControlStates()
    }
  }
  for (let i = 0; i < 26 && !ctl.aborted && bot.entities[item.id]; i++) {
    const feet = bot.entity.position.floored()
    if (item.position.y - feet.y < 0.6) {
      await sleep(400)
      if (!stepped && bot.entities[item.id] && Math.abs(item.position.y - bot.entity.position.y) < 1.2) { stepped = true; await sneakStep() }
      continue
    }
    const above = bot.blockAt(feet.offset(0, 2, 0))
    if (above && above.boundingBox === 'block') {
      try { await tools.breakFast(bot, above.position, { maxMs: 3000 }) } catch {}
      await sleep(600)
      continue
    }
    const r = await towerUp(bot, ctl, 1)
    if (!r.placed) break
    placed++
  }
  await sleep(600)
  // Вниз: свой столб — из-под ног (блоки назад в рюкзак).
  for (let i = 0; i < placed + 2 && !ctl.aborted; i++) {
    const feet = bot.entity.position.floored()
    if (feet.y <= base.y) break
    const b = bot.blockAt(feet.offset(0, -1, 0))
    if (!b || b.boundingBox !== 'block') break
    try { await tools.breakFast(bot, b.position, { maxMs: 3000 }) } catch { break }
    await sleep(450)
  }
  return { ok: !bot.entities[item.id], placed }
}

async function fetchDrop (bot, ctl, item, had, { maxMs = 30000 }: any = {}) {
  const { inWater, escapeWater }: typeof import('../movement') = require('../movement')
  const t0 = gameClock.now()
  let how = 'пешком'
  let swam = 0
  try {
    while (!ctl.aborted && bot.entities[item.id] && item.isValid !== false && gameClock.now() - t0 < maxMs) {
      const p = item.position
      const cell = bot.blockAt(p.floored())
      const under = bot.blockAt(p.floored().offset(0, -1, 0))
      if ([cell, under].some(b => b && /lava/.test(b.name))) return { ok: false, how, why: 'в лаве' }
      if (p.y < bot.entity.position.y - 24) return { ok: false, how, why: 'глубоко внизу' }
      const wet = [cell, under].some(b => b && /water|bubble_column/.test(b.name))
      if (wet || inWater(bot)) {
        how = 'вплавь'
        swam++
        try { bot.pathfinder.setGoal(null) } catch {}
        await bot.lookAt(new Vec3(p.x, bot.entity.position.y + 0.4, p.z), true).catch(() => {})
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        await sleep(150)
        continue
      }
      bot.clearControlStates()
      try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)), 12000) } catch { try { bot.pathfinder.setGoal(null) } catch {} }
      if (bot.entities[item.id] && item.position.distanceTo(bot.entity.position) < 4) {
        // Рядом, а не подобрал: встать в его клетку (подбор — коробка тела +1).
        const c = item.position.floored()
        try { await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(c.x, c.y, c.z)), 5000) } catch { try { bot.pathfinder.setGoal(null) } catch {} }
      }
      // Выше головы и не дойти — на крону столбом.
      if (bot.entities[item.id] && item.position.y - bot.entity.position.y > 1.6) {
        how = 'столбом'
        const c = await climbFor(bot, ctl, item)
        if (!c.ok && bot.entities[item.id]) return { ok: countOf(bot, 'ender_eye') >= had, how, why: c.why || 'не достал', seconds: Math.round((gameClock.now() - t0) / 1000) }
      }
      await sleep(300)
    }
  } finally {
    try { bot.clearControlStates() } catch {}
  }
  let back = null
  if (inWater(bot)) back = await escapeWater(bot, ctl, { timeoutMs: 25000 }).catch(e => ({ ok: false, error: e.message }))
  return { ok: countOf(bot, 'ender_eye') >= had, how, seconds: Math.round((gameClock.now() - t0) / 1000), back: back ? back.ok : undefined }
}

export async function throwEye (session, ctl) {
  const bot = session.bot
  const eye = itemNamed(bot, 'ender_eye')
  if (!eye) throw new Error('ока эндера нет: оно крафтится из жемчуга эндера и огненного порошка')
  // В Аду и Краю генератор без колец: findNearestMapStructure → null, и
  // EnderEyeItem.use возвращает CONSUME, ничего не бросив (око цело).
  const dim = String((bot.game && bot.game.dimension) || 'overworld').replace(/^minecraft:/, '')
  if (dim !== 'overworld') return { thrown: false, why: `в ${dim === 'the_nether' ? 'Аду' : 'Краю'} око не летит: крепости только в верхнем мире (для Ада — mode=blind)` }
  await bot.equip(eye, 'hand')
  const had = countOf(bot, 'ender_eye')
  const me = bot.entity.position.clone()

  let flying = null
  let start = null
  let gone = false
  let dropped = null
  const track = []
  const t0 = gameClock.now()
  const onSpawn = (e) => {
    if (!e || !e.position) return
    if (!flying) {
      if (e.name !== 'eye_of_ender' || e.position.distanceTo(me) > 4) return
      flying = e
      // Точка появления — из пакета spawn_entity, пока ни одной дельты не пришло.
      start = e.position.clone()
      track.push({ ms: gameClock.now() - t0, p: start })
      return
    }
    // Око кончилось, и на его месте появился предмет — не разбилось
    // (EyeOfEnder.tick: surviveAfterDeath → new ItemEntity в точке ока). Это
    // и есть «видно глазами»: упало или рассыпалось.
    if (!dropped && e.name === 'item' && track.length && e.position.distanceTo(track[track.length - 1].p) < 2.5) dropped = e
  }
  const onMove = (e) => { if (flying && e === flying) track.push({ ms: gameClock.now() - t0, p: e.position.clone() }) }
  const onGone = (e) => { if (flying && e === flying) gone = true }
  bot.on('entitySpawn', onSpawn)
  bot.on('entityMoved', onMove)
  bot.on('entityGone', onGone)
  try {
    // Взгляд вверх — чтобы клик не попал в рамку портала (EnderEyeItem.use:
    // по рамке end_portal_frame око не летит, а вставляется).
    await bot.look(bot.entity.yaw, 0.6, true)
    await sleep(50)
    bot.activateItem()
    while (!flying && gameClock.now() - t0 < 1500 && !ctl.aborted) await sleep(25)
    if (!flying) {
      return { thrown: false, why: 'око не полетело: сервер не создал сущность (в Аду и Краю крепостей нет — око не бросается)' }
    }
    // Полёт — 80 тиков; к 34-му око уже у цели. Ждём ухода сущности, но не
    // дольше 5 с.
    while (!gone && flying.isValid !== false && bot.entities[flying.id] && gameClock.now() - t0 < 5000 && !ctl.aborted) await sleep(50)
    const last = track[track.length - 1].p
    const dx = last.x - start.x
    const dz = last.z - start.z
    const flew = Math.hypot(dx, dz)
    // Вверх или вниз: цель дальше 12 — на 8 выше старта, ближе — y=0.
    const peak = track.reduce((m, s) => Math.max(m, s.p.y), -Infinity)
    const up = peak > start.y + 0.5
    const near = !up && flew < EYE_REACH - 0.3
    const bearing = flew > 0.5 ? Math.atan2(dx, dz) : null
    const sigma = flew > 0.5 ? Math.max(SIGMA_MIN, POS_ERR * Math.SQRT2 / flew) : null
    // Предмет на месте ока — в том же тике, что и уход ока; пакеты — рядом.
    const t1 = gameClock.now()
    while (!dropped && gameClock.now() - t1 < 800) await sleep(50)
    let lost = false
    let fetched = null
    if (dropped) {
      // Падает с высоты цели (+8 над броском): дождаться, пока ляжет, и
      // подойти. Общий подборщик шёл к стопке в воздухе и сдавался.
      let lastY = null
      let still = 0
      const t2 = gameClock.now()
      while (bot.entities[dropped.id] && gameClock.now() - t2 < 3500 && still < 3) {
        const y = dropped.position.y
        still = lastY !== null && Math.abs(y - lastY) < 0.01 ? still + 1 : 0
        lastY = y
        await sleep(100)
      }
      // За оком — и по суше, и вплавь (fetchDrop); в лаву — нет.
      if (bot.entities[dropped.id] && !ctl.aborted) {
        fetched = await fetchDrop(bot, ctl, dropped, had)
        const t3 = gameClock.now()
        while (bot.entities[dropped.id] && gameClock.now() - t3 < 1500) await sleep(100)
      }
      lost = countOf(bot, 'ender_eye') < had
    }
    const left = countOf(bot, 'ender_eye')
    return {
      thrown: true,
      from: xyz(me),
      // Точная точка появления ока и где оно висело в конце (для решателя).
      start: { x: start.x, y: start.y, z: start.z },
      end: { x: last.x, y: last.y, z: last.z },
      landed: xyz(last),
      flew: r1(flew),
      samples: track.length,
      bearingDeg: bearing === null ? null : Math.round(bearing * DEG * 1000) / 1000,
      bearing,
      sigma,
      sigmaDeg: sigma === null ? null : +(sigma * DEG).toFixed(4),
      up,
      near,
      corner: near ? { x: snap16(last.x), z: snap16(last.z) } : undefined,
      // Прежнее имя для endportal.js: око не ушло вверх — крепость под нами.
      below: near,
      // Разбилось — предмета на месте ока не было (20%: nextInt(5) == 0);
      // упало, но не подобрал (вода, дерево, обрыв) — lost.
      broke: !dropped,
      lost: lost || undefined,
      fetched: fetched ? { how: fetched.how, s: fetched.seconds, why: fetched.why } : undefined,
      eyesLeft: left
    }
  } finally {
    bot.removeListener('entitySpawn', onSpawn)
    bot.removeListener('entityMoved', onMove)
    bot.removeListener('entityGone', onGone)
  }
}
