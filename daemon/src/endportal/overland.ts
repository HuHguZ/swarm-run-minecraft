'use strict'
// Крепость и портал в Край (endportal.ts): дорога к крепости поверху: вплавь, мост, просека, другие крепости кольца, море.
import * as gameClock from '../game-clock'
import { Vec3 } from 'vec3'
import { sleep, travelXZ } from '../movement'
import { equipBestTool, missingHarvestTool } from '../items'
import { log } from './common'

// Открытая вода без берега в 24 блоках (лаборатория 2026-09-27: тело в
// океане, escapeWater 25 с плавал на месте — берега не видно, и goStronghold
// трижды отвечал «не смог выбраться из воды»). Плыть к цели по поверхности,
// пока в 24 блоках не покажется суша (дальше — обычный выход из воды).
// Вплавь к цели через воду: зайти в воду, держать курс и прыжок (всплывать),
// пока не выйдем на сушу (1.5 с не в воде) или не выйдет время.
async function swimAcross (bot, ctl, target, ms = 90000) {
  const { inWater }: typeof import('../movement') = require('../movement')
  const t0 = gameClock.now()
  const start = bot.entity.position.clone()
  let dry = 0
  let wasWet = false
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      const me = bot.entity.position
      if (Math.hypot(target.x - me.x, target.z - me.z) <= 6) break
      await bot.lookAt(new Vec3(target.x, me.y + 1.2, target.z), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(250)
      if (inWater(bot)) { wasWet = true; dry = 0 } else if (wasWet) { dry += 250; if (dry >= 1500) break }
      // Не заходит в воду 8 с (обрыв, стена) — стоп.
      if (!wasWet && gameClock.now() - t0 > 8000) break
    }
  } finally { try { bot.clearControlStates() } catch {} }
  return { moved: Math.round(bot.entity.position.distanceTo(start)), seconds: Math.round((gameClock.now() - t0) / 1000), ashore: wasWet && dry >= 1500 }
}

async function swimToward (bot, ctl, target, ms = 90000) {
  const { inWater, findNearestLand }: typeof import('../movement') = require('../movement')
  if (!inWater(bot) || findNearestLand(bot, 24)) return { swam: false }
  const t0 = gameClock.now()
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms && inWater(bot) && !findNearestLand(bot, 24)) {
      const me = bot.entity.position
      await bot.lookAt(new Vec3(target.x, me.y + 1.2, target.z), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(400)
    }
  } finally {
    try { bot.clearControlStates() } catch {}
  }
  return { swam: true, seconds: Math.round((gameClock.now() - t0) / 1000), land: !!findNearestLand(bot, 24) }
}

// Мост по воде (лаборатория 2026-09-27: в воду pathfinder заходит, а выходит
// плохо — «не смог выбраться из воды» у двух крепостей из трёх). С берега:
// блок в клетку воды перед ногами на уровне опоры (вода заменяется), шаг на
// него крадучись, дальше — пока впереди не суша. Блоков — сколько дадут.
function surfaceWet (bot, x, z, fromY) {
  for (let y = fromY + 6; y >= fromY - 8; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return null
    if (/water/.test(b.name)) return true
    if (b.boundingBox === 'block') return false
  }
  return null
}

// Сколько воды на прямой отсюда до цели (по поверхности, шаг 2), и где берег.
// run — длина первой полосы воды; open — берега за ней не видно (вода до края
// прогруженного или до maxDist, а цель дальше).
function waterOnLine (bot, target, maxDist = 96) {
  const me = bot.entity.position
  const dx = target.x - me.x; const dz = target.z - me.z
  const len = Math.hypot(dx, dz) || 1
  const dist = Math.min(maxDist, len)
  let wet = 0; let firstWet = null; let lastDry = 0
  let run = 0; let runEnded = false; let lastT = 0; let lastWet = false
  for (let t = 2; t <= dist; t += 2) {
    const x = Math.floor(me.x + dx / len * t); const z = Math.floor(me.z + dz / len * t)
    const w = surfaceWet(bot, x, z, Math.floor(me.y))
    if (w === null) break
    lastT = t; lastWet = w
    if (w) { wet += 2; if (firstWet === null) firstWet = t; if (!runEnded) run += 2 } else if (firstWet === null) lastDry = t; else runEnded = true
  }
  const open = firstWet !== null && !runEnded && lastWet && lastT < len - 2
  return { wet, firstWet, lastDry, run, open }
}

// Блоков на мост в рюкзаке (без песка и гравия: падают).
function fillerCount (bot) {
  const { FILLER }: typeof import('../build') = require('../build')
  return bot.inventory.items().filter(i => (FILLER.includes(i.name) && !/sand|gravel/.test(i.name)) || /_planks$/.test(i.name)).reduce((n, i) => n + i.count, 0)
}

// Другие крепости кольца 0 — на ±120° от этой (generateRingPositions: spread 3,
// шаг угла 2π/3; радиус у каждой свой, 1408..2688).
function altStrongholds (corner) {
  const ang = Math.atan2(corner.x, corner.z)
  return [2 * Math.PI / 3, -2 * Math.PI / 3].map(d => ({ bearingDeg: Math.round((ang + d) * 180 / Math.PI), ringFrom: 1408, ringTo: 2688 }))
}

async function bridgeAcross (bot, ctl, target, { maxBlocks = 64, deadline = gameClock.now() + 120000 }: any = {}) {
  const { placeBlockAt, pickFiller }: typeof import('../build') = require('../build')
  let placed = 0
  let dryRun = 0
  try {
    bot.setControlState('sneak', true)
    for (let i = 0; i < 300 && !ctl.aborted && gameClock.now() < deadline; i++) {
      const me = bot.entity.position
      const dx = target.x - me.x; const dz = target.z - me.z
      if (Math.hypot(dx, dz) < 3) break
      const [sx, sz] = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
      const feet = me.floored()
      const next = feet.offset(sx, 0, sz)
      const nb = bot.blockAt(next); const hb = bot.blockAt(next.offset(0, 1, 0))
      const under = next.offset(0, -1, 0)
      const ub = bot.blockAt(under)
      if (!nb || !ub) break
      // Стена впереди — мост кончился, дальше ноги.
      if (nb.boundingBox === 'block' || (hb && hb.boundingBox === 'block')) break
      const wetAhead = /water/.test(ub.name) || /water/.test(nb.name) || (ub.boundingBox === 'empty' && /water/.test((bot.blockAt(under.offset(0, -1, 0)) || {}).name || ''))
      if (!wetAhead && ub.boundingBox === 'block') {
        // Суша: ещё три шага суши — и хватит.
        if (++dryRun >= 3) break
      } else {
        dryRun = 0
        if (placed >= maxBlocks || !pickFiller(bot, { steady: true })) return { ok: false, placed, why: 'блоки на мост кончились' }
        if (ub.boundingBox !== 'block') {
          const r = await placeBlockAt(bot, under, { timeoutMs: 1200, steady: true })
          if (!r.ok) return { ok: false, placed, why: `блок в воду не встал: ${r.reason}` }
          if (!r.already) placed++
        }
        // Вода на уровне ног впереди (глубже на блок) — ещё и туда.
        if (/water/.test(nb.name)) {
          const r2 = await placeBlockAt(bot, next, { timeoutMs: 1200, steady: true })
          if (r2.ok && !r2.already) placed++
        }
      }
      // Шаг вперёд.
      const t0 = gameClock.now()
      const goal = (/water/.test(nb.name) ? next.offset(0, 1, 0) : next)
      while (gameClock.now() - t0 < 1800 && !bot.entity.position.floored().equals(goal) && !bot.entity.position.floored().equals(next)) {
        await bot.lookAt(goal.offset(0.5, 1.6, 0.5), true).catch(() => {})
        bot.setControlState('forward', true)
        if (/water/.test(nb.name)) bot.setControlState('jump', true)
        await sleep(50)
      }
      bot.setControlState('forward', false)
      bot.setControlState('jump', false)
    }
  } finally {
    try { bot.clearControlStates() } catch {}
  }
  return { ok: true, placed }
}

// Прорубиться к цели на несколько блоков (джунгли: тело встаёт в кустах и
// листве, pathfinder «success», а тело стоит — лаборатория, прогон 9, 6 минут
// на одном месте). Ноги и голова впереди — сломать (листва — мгновенно), шаг.
async function chopToward (bot, ctl, mcData, target, steps = 6) {
  let moved = 0
  for (let i = 0; i < steps && !ctl.aborted; i++) {
    const me = bot.entity.position
    const dx = target.x - me.x; const dz = target.z - me.z
    const [sx, sz] = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
    const feet = me.floored()
    const next = feet.offset(sx, 0, sz)
    let up = 0
    // Ступенька: впереди блок, над ним воздух — шагнуть вверх.
    const nb = bot.blockAt(next)
    if (nb && nb.boundingBox === 'block' && !/leaves|log|vine|bush|grass|fern|bamboo/.test(nb.name)) {
      const a1 = bot.blockAt(next.offset(0, 1, 0)); const a2 = bot.blockAt(next.offset(0, 2, 0))
      if (a1 && a1.boundingBox === 'empty' && a2 && a2.boundingBox === 'empty') up = 1
    }
    const goal = next.offset(0, up, 0)
    for (const c of [goal, goal.offset(0, 1, 0), feet.offset(0, 2, 0)]) {
      const b = bot.blockAt(c)
      if (!b || b.boundingBox === 'empty') continue
      if (/water|lava/.test(b.name)) return moved
      if (missingHarvestTool(bot, b, mcData)) return moved
      try { await equipBestTool(bot, b); await bot.dig(b) } catch { return moved }
    }
    const t0 = gameClock.now()
    try {
      while (gameClock.now() - t0 < 1500 && !bot.entity.position.floored().equals(goal)) {
        await bot.lookAt(goal.offset(0.5, 1.6, 0.5), true)
        bot.setControlState('forward', true)
        if (up) bot.setControlState('jump', true)
        await sleep(50)
      }
    } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
    if (!bot.entity.position.floored().equals(goal)) return moved
    moved++
  }
  return moved
}

// Дойти до точки: отрезками по 24; на прямой вода — мост; застрял — nether.walkToward
// (обход вбок и штрек).
async function walkOrBridge (session, ctl, corner, deadline) {
  const bot = session.bot
  const legs = []
  let bridged = 0
  let boats = 0
  // Сторож хода: витки без сдвига на 1 бл. — не крутить 40 пустых витков за миг (s5e-A-4 07.10: у воды над лестницей «время
  // вышло» в каждом вызове за 0 с, 25 мин пауз этапа).
  let idle = 0
  let lastAt = null
  for (let k = 0; k < 40 && !ctl.aborted && gameClock.now() < deadline; k++) {
    const me = bot.entity.position
    const dist = Math.hypot(corner.x - me.x, corner.z - me.z)
    if (dist <= 8) return { ok: true, legs, bridged }
    if (lastAt && me.distanceTo(lastAt) < 1) { if (++idle >= 4) return { ok: false, legs, bridged, error: `хода нет: ${idle} витков на месте у ${Math.round(me.x)},${Math.round(me.y)},${Math.round(me.z)} (${Math.round(dist)} бл. до цели)` } } else idle = 0
    lastAt = me.clone()
    const wl = waterOnLine(bot, corner, 96)
    if (wl.firstWet !== null && wl.firstWet <= 6) {
      // Мост — через реку и озеро. Море (берега не видно, 24+ блоков) или воды
      // больше, чем блоков, — не начинать (лаборатория 2026-09-27: крепость под
      // морем, 40 блоков моста в воду и стоп посреди моря в 215 блоках от неё).
      const have = fillerCount(bot)
      if (wl.open && wl.run >= 24) {
        // Море или большое озеро — лодкой, как спидраннеры (ride.js: сделать из 5
        // досок, спустить, плыть к цели, у берега высадка и лодку с собой).
        // Ферма, крепость A: с севера к ней «воды 94–96+ блоков по прямой».
        if (boats < 3 && !ctl.aborted && gameClock.now() < deadline - 30000) {
          boats++
          const before = bot.entity.position.clone()
          let r = null
          try { r = await (require('../ride') as typeof import('../ride')).run(session, ctl, { kind: 'boat', mode: 'go', x: corner.x, z: corner.z, timeoutSeconds: Math.max(30, Math.min(240, Math.round((deadline - gameClock.now()) / 1000) - 10)) }) } catch (e) { r = { stopped: e.message } }
          const moved = Math.round(bot.entity.position.distanceTo(before))
          legs.push({ boat: true, moved, arrived: !!(r && r.arrived), stopped: r && r.stopped })
          log('лодкой', { moved, arrived: !!(r && r.arrived), stopped: r && r.stopped })
          if (moved >= 16) continue
          // Лодку не спустить (у берега мелко, открытой воды в 4 блоках нет) —
          // вплавь поперёк озера, как человек: поверху, прыжком держаться у
          // поверхности, до суши на том берегу (ферма, крепость A: над портальной
          // комнатой озеро ~100 блоков, лодка «спустить некуда» в 2 из 5).
          const sw = await swimAcross(bot, ctl, corner, Math.min(120000, Math.max(0, deadline - gameClock.now() - 20000)))
          legs.push({ swim: true, ...sw })
          log('вплавь', sw)
          if (sw.moved >= 16) continue
        }
        legs.push({ sea: wl.run, open: wl.open, have })
        return { ok: false, legs, bridged, sea: { run: wl.run, open: wl.open, have }, error: `впереди море: воды ${wl.run}+ блоков по прямой, берега не видно (блоков на мост ${have})` }
      }
      const bridgeFailed = legs.some(l => l.bridge !== undefined && !l.ok)
      if (wl.run > have - 6 || bridgeFailed) {
        // Озеро шире, чем блоков, но тот берег виден (прогон 20: «вода 44, блоков
        // 40» — стоп, а прогон 12 отсюда же дошёл): на тот берег ногами —
        // pathfinder обойдёт или переплывёт; не вышло — выбраться и в обход.
        const me2 = bot.entity.position
        const d2 = Math.hypot(corner.x - me2.x, corner.z - me2.z) || 1
        const far = Math.min(d2, wl.firstWet + wl.run + 4)
        const fx = Math.round(me2.x + (corner.x - me2.x) / d2 * far)
        const fz = Math.round(me2.z + (corner.z - me2.z) / d2 * far)
        const w = await (require('../nether') as typeof import('../nether')).guarded(session, ctl, sub => travelXZ(bot, sub, fx, fz, { range: 3, retries: 1, deadline: Math.min(deadline, gameClock.now() + 90000) }))
        legs.push({ acrossWater: wl.run, to: { x: fx, z: fz }, ok: w.ok, error: w.ok ? undefined : w.error })
        if (!w.ok) {
          const { inWater, escapeWater }: typeof import('../movement') = require('../movement')
          if (inWater(bot)) await escapeWater(bot, ctl, { timeoutMs: 20000 })
          if (legs.filter(l => l.acrossWater && !l.ok).length >= 2) return { ok: false, legs, bridged, error: `впереди вода ${wl.run} блоков (блоков на мост ${have}): ни обойти, ни переплыть не вышло — ${w.error}` }
        }
        continue
      }
      const b = await bridgeAcross(bot, ctl, corner, { maxBlocks: 64, deadline: Math.min(deadline, gameClock.now() + 120000) })
      bridged += b.placed
      legs.push({ bridge: b.placed, ok: b.ok, why: b.why })
      // Мост не встал (глубоко, не к чему прислонить блок; прогон 23) — дальше
      // ногами/вплавь на тот берег (ветка выше), без второго моста.
      if (!b.ok && /кончились/.test(b.why || '')) return { ok: false, legs, bridged, error: b.why }
      continue
    }
    const step = wl.firstWet !== null ? Math.min(36, Math.max(3, wl.firstWet - 3)) : Math.min(24, dist)
    const tx = Math.round(me.x + (corner.x - me.x) / dist * step)
    const tz = Math.round(me.z + (corner.z - me.z) / dist * step)
    // Под охраной: ударили по дороге (джунгли: зомби, скелеты) — бой и дальше.
    const w = await (require('../nether') as typeof import('../nether')).guarded(session, ctl, sub => travelXZ(bot, sub, tx, tz, { range: 2, retries: 1, deadline: Math.min(deadline, gameClock.now() + 40000) }))
    if (w.fought) { legs.push({ fought: w.fought }); if ((bot.health ?? 20) < 8) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} } continue }
    legs.push({ to: { x: tx, z: tz }, ok: w.ok, error: w.ok ? undefined : w.error })
    if (!w.ok) {
      const { inWater, escapeWater }: typeof import('../movement') = require('../movement')
      if (inWater(bot)) await escapeWater(bot, ctl, { timeoutMs: 20000 })
      // Не сдвинулись с места — прорубиться вперёд.
      if (bot.entity.position.distanceTo(me) < 2) {
        const c = await chopToward(bot, ctl, session.mcData, corner, 8)
        legs.push({ chop: c })
        if (c >= 2) continue
      }
      // Обход вбок отрезками и штрек (nether.walkToward) — к самой цели, а не к
      // концу отрезка: для цели ближе 24 он ничего не делает.
      const nw = await (require('../nether') as typeof import('../nether')).walkToward(session, ctl, { x: corner.x, y: Math.floor(bot.entity.position.y), z: corner.z }, Math.min(deadline, gameClock.now() + 90000), { range: 6, xz: true })
      legs.push({ around: true, ok: !!(nw && nw.ok) })
      if (legs.filter(l => l.around && !l.ok).length >= 3) return { ok: false, legs, bridged, error: w.error }
    }
  }
  const me = bot.entity.position
  return { ok: Math.hypot(corner.x - me.x, corner.z - me.z) <= 10, legs, bridged, error: 'время вышло' }
}

// Крепость под морем: у лестницы старта (угол+4) поверхность — вода, и сухой
// земли в 14 блоках нет (goAround копать не с чего). Другие две крепости
// кольца 0 — на ±120° от этой (generateRingPositions: spread 3, шаг угла 2π/3;
// радиус у каждой свой, 1408..2688), их ищут оком оттуда.
function oceanAt (bot, corner) {
  const x = corner.x + 4; const z = corner.z + 4
  const y0 = Math.floor(bot.entity.position.y)
  const wet = surfaceWet(bot, x, z, y0)
  if (wet !== true) return null
  for (let r = 2; r <= 14; r++) {
    for (let d = -r; d <= r; d++) {
      for (const [a, b] of [[x + d, z - r], [x + d, z + r], [x - r, z + d], [x + r, z + d]]) {
        if (surfaceWet(bot, a, b, y0) === false) return null
      }
    }
  }
  return { ocean: true, alternatives: altStrongholds(corner) }
}

// Над головой до высоты мира — ни одного твёрдого блока (небо).
function skyAbove (bot) {
  const f = bot.entity.position.floored()
  for (let y = f.y + 2; y < f.y + 80; y++) {
    const b = bot.blockAt(new Vec3(f.x, y, f.z))
    if (!b) return true
    if (b.boundingBox === 'block') return false
  }
  return true
}

export {
  swimAcross, swimToward, surfaceWet, waterOnLine, fillerCount, altStrongholds, bridgeAcross, chopToward, walkOrBridge, oceanAt, skyAbove
}
