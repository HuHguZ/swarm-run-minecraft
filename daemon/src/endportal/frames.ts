'use strict'
// Крепость и портал в Край (endportal.ts): рамки: глаза в рамки, спавнер, вход в портал (mode=fill).
import * as gameClock from '../game-clock'
import { Vec3 } from 'vec3'
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from '../movement'
import { itemNamed, countOf, equipBestTool } from '../items'
import { eyePos } from '../perception'
import * as worlds from '../worlds'
import * as pick from '../pick'
import { ROOM, clamp, placeOf, savePlace, walkTo, visibleOf } from './common'

const REACH = 4.5

// ------------------------------------------------------------------ fill

function frameState (bot, pos) {
  const b = bot.blockAt(pos)
  if (!b || b.name !== 'end_portal_frame') return null
  const pr = b.getProperties()
  return { pos, eye: String(pr.eye) === 'true', facing: pr.facing }
}

function frameAim (bot, pos) {
  for (const face of [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]) {
    const point = pick.faceAim(bot, pos, face, { range: REACH })
    if (point) return { point, face }
  }
  return null
}

// Спавнер чешуйниц на лестнице комнаты рождает их, пока тело в 16 бл.; укусы рвут вставку глаз аварийным отходом
// автопилота (ферма 02.10, neF-sh-3: оба захода fill прерваны — EMERGENCY, затем хп 7 и LOW_HP, этап «в Энд не вошёл»).
// Сломать его до вставки (кирка — 1–2 с; только видимый: копать сквозь стену нельзя), рождённых рядом — добить.
async function breakRoomSpawner (session, ctl, anchor, deadline) {
  const bot = session.bot
  const id = bot.registry.blocksByName.spawner.id
  const sp = visibleOf(bot, [id], 20, 8).find(b => b.position.distanceTo(anchor) <= 8)?.position
  if (!sp) return null
  const out: any = { at: xyz(sp), broken: false }
  const c = sp.offset(0.5, 0.5, 0.5)
  if (eyePos(bot).distanceTo(c) > 4.2) await walkTo(bot, ctl, sp, 3, Math.max(1000, Math.min(20000, deadline - gameClock.now() - 60000)))
  const b = bot.blockAt(sp)
  if (!b || b.name !== 'spawner') { out.broken = true; return out }
  try {
    await equipBestTool(bot, b)
    const point = pick.blockAim(bot, sp, { range: 4.5, seeThrough: null })
    if (!point || ctl.aborted || gameClock.now() > deadline) { out.why = 'не дотянулся, не видно или прервано'; return out }
    await bot.lookAt(point, true)
    const check = pick.blockAim(bot, sp, { range: 4.5, seeThrough: null })
    if (!check || !check.equals(point) || ctl.aborted || gameClock.now() > deadline) { out.why = 'прицел или обстановка изменились'; return out }
    await bot.dig(b, 'ignore'); out.broken = true
  } catch (e) { out.why = e.message.slice(0, 80) }
  const fish = () => (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'silverfish' && e.position && e.position.distanceTo(bot.entity.position) < 8)
  if (out.broken && fish() && !ctl.aborted) {
    try { await (require('../combat') as typeof import('../combat')).fight(session, ctl, { timeoutSeconds: 20, retreatAtHealth: 6 }) } catch {}
    out.fought = true
  }
  return out
}

async function fillFrames (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 180, 20, 600) * 1000 - 3000
  const frameId = mcData.blocksByName.end_portal_frame.id
  const portalId = mcData.blocksByName.end_portal.id
  // Рамки комнаты: сначала видимые, от них — вся дюжина вокруг.
  const seen = visibleOf(bot, [frameId], 24, 24)
  const rec = placeOf(session, ROOM)
  const anchor = seen.length ? seen[0].position : (rec && worlds.worldOfRecord(rec) === worlds.worldOf(bot) ? new Vec3(rec.x, rec.y, rec.z) : null)
  if (!anchor) return { lit: false, stopped: 'рамок портала не вижу и в памяти их нет — сначала mc_stronghold mode=room' }
  // Запись из памяти далеко — это другая комната (или другая крепость): туда
  // вставка глаз не ходит, это работа room/go (прогон 2026-09-25: fill по
  // записи прошлой крепости 30 с шагал к ней за 5000 блоков).
  if (!seen.length && bot.entity.position.distanceTo(anchor) > 48) {
    return { lit: false, stopped: `рамок не вижу, а комната в памяти в ${Math.round(bot.entity.position.distanceTo(anchor))} блоках на ${anchor.x},${anchor.y},${anchor.z} — сначала дойди до неё (mc_stronghold mode=room)` }
  }
  if (bot.entity.position.distanceTo(anchor) > 10) {
    await walkTo(bot, ctl, anchor, 3, Math.min(30000, deadline - gameClock.now()))
  }
  const frames = bot.findBlocks({ matching: [frameId], maxDistance: 8, point: anchor, count: 24 })
    .map(pos => frameState(bot, pos)).filter(Boolean)
  const already = bot.findBlocks({ matching: [portalId], maxDistance: 8, point: anchor, count: 16 })
  if (already.length >= 9) {
    const c = already.reduce((a, v) => a.plus(v), new Vec3(0, 0, 0)).scaled(1 / already.length)
    const portal = { x: Math.floor(c.x), y: already[0].y, z: Math.floor(c.z) }
    if (p.enter) {
      const en: any = await enterPortal(session, ctl, portal, deadline)
      return { lit: true, already: true, portal, entered: en.entered, enter: en, stopped: en.entered ? undefined : `в портал не вошёл: ${en.why}` }
    }
    return {
      lit: true,
      already: true,
      portalBlocks: already.length,
      frames: frames.length,
      withEye: frames.filter(f => f.eye).length,
      placed: 0,
      portal: { x: Math.floor(c.x), y: already[0].y, z: Math.floor(c.z) },
      note: 'портал в Край уже горит — 9 клеток end_portal'
    }
  }
  const empty = frames.filter(f => !f.eye)
  const have = countOf(bot, 'ender_eye')
  if (frames.length < 12) {
    return { lit: false, frames: frames.length, stopped: `вижу только ${frames.length} рамок из 12 — подойди ближе к комнате (mc_stronghold mode=room) и позови снова` }
  }
  if (have < empty.length) {
    return {
      lit: false,
      frames: frames.length,
      withEye: frames.length - empty.length,
      need: { what: 'ender_eye', count: empty.length - have, have },
      stopped: `пустых рамок ${empty.length}, а глаз ${have} — не хватает ${empty.length - have}. ` +
        'Око: mc_craft item=ender_eye (blaze_powder + ender_pearl, бесформенный рецепт).'
    }
  }

  const spawnerRoom = await breakRoomSpawner(session, ctl, anchor, deadline).catch(e => ({ why: e.message }))
  const placed = []
  const failedAt = []
  const me0 = bot.entity.position
  // Ближние сначала, дальше — по кругу от текущего места.
  const order = empty.slice().sort((a, b) => a.pos.distanceTo(me0) - b.pos.distanceTo(me0))
  // Не дотянулся с 2 блоков — встать на уровень рамки (на соседнюю рамку) или
  // туда, откуда её видно (ферма, крепость A: 11 из 12 — одна рамка «не
  // дотянулся: 5 бл.», и портал не загорелся).
  for (const f of order) {
    if (ctl.aborted || gameClock.now() > deadline) break
    let aim = frameAim(bot, f.pos)
    if (!aim) {
      await walkTo(bot, ctl, f.pos, 2, Math.min(20000, deadline - gameClock.now()))
      aim = frameAim(bot, f.pos)
    }
    if (!aim && !f.retried) {
      f.retried = true
      // Не на саму рамку: внутри кольца — бассейн лавы под порталом (ферма,
      // крепость A: «tried to swim in lava» при заливке) — только туда, откуда
      // рамку видно с 4 блоков.
      for (const g of [new goals.GoalLookAtBlock(f.pos, bot.world, { reach: 4 })]) {
        if (aim || ctl.aborted) break
        try { await Promise.race([bot.pathfinder.goto(g), sleep(Math.min(15000, Math.max(1000, deadline - gameClock.now())))]) } catch {}
        try { bot.pathfinder.setGoal(null) } catch {}
        aim = frameAim(bot, f.pos)
      }
    }
    if (!aim) {
      failedAt.push({ at: xyz(f.pos), why: 'нет доступной прицелом грани рамки' })
      continue
    }
    const eyeItem = itemNamed(bot, 'ender_eye')
    if (!eyeItem) { failedAt.push({ at: xyz(f.pos), why: 'глаза кончились' }); break }
    try {
      await bot.equip(eyeItem, 'hand')
      if (ctl.aborted || gameClock.now() > deadline) break
      const block = bot.blockAt(f.pos)
      if (!block || block.name !== 'end_portal_frame' || String(block.getProperties().eye) === 'true') continue
      aim = frameAim(bot, f.pos)
      if (!aim) { failedAt.push({ at: xyz(f.pos), why: 'прицел изменился при смене предмета' }); continue }
      await bot.lookAt(aim.point, true)
      const check = frameAim(bot, f.pos)
      if (ctl.aborted || gameClock.now() > deadline) break
      if (!check || !check.point.equals(aim.point) || !check.face.equals(aim.face)) {
        failedAt.push({ at: xyz(f.pos), why: 'прицел изменился перед вставкой' }); continue
      }
      // activateBlock заново смотрит в центр блока; _genericPlace сохраняет проверенную грань рамки высотой 0.8125.
      await bot._genericPlace(block, aim.face, { forceLook: 'ignore', delta: aim.point.minus(f.pos), swingArm: 'right' })
    } catch (e) {
      failedAt.push({ at: xyz(f.pos), why: e.message.slice(0, 60) })
      continue
    }
    let ok = false
    for (let i = 0; i < 15 && !ok; i++) {
      await sleep(100)
      const s = frameState(bot, f.pos)
      ok = !!(s && s.eye)
    }
    if (ok) placed.push(xyz(f.pos))
    else failedAt.push({ at: xyz(f.pos), why: 'око не встало (сервер не подтвердил)' })
  }

  await sleep(400)
  const portal = bot.findBlocks({ matching: [portalId], maxDistance: 8, point: anchor, count: 16 })
  const after = bot.findBlocks({ matching: [frameId], maxDistance: 8, point: anchor, count: 24 })
    .map(pos => frameState(bot, pos)).filter(Boolean)
  const withEye = after.filter(f => f.eye).length
  const lit = portal.length >= 9
  const detail: any = {
    lit,
    portalBlocks: portal.length,
    frames: after.length,
    withEye,
    placed: placed.length,
    failed: failedAt.length ? failedAt : undefined,
    eyesLeft: countOf(bot, 'ender_eye'),
    spawner: spawnerRoom || undefined,
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (lit) {
    const c = portal.reduce((a, v) => a.plus(v), new Vec3(0, 0, 0)).scaled(1 / portal.length)
    detail.portal = { x: Math.floor(c.x), y: portal[0].y, z: Math.floor(c.z) }
    savePlace(session, ROOM, { ...detail.portal, dimension: 'overworld', lit: true, note: 'портал в Край ГОРИТ: 9 клеток end_portal; шаг внутрь — сразу Край (задержки нет)' },
      `портал в Край горит: центр ${detail.portal.x},${detail.portal.y},${detail.portal.z}`)
    detail.note = `Портал в Край горит: ${portal.length} клеток end_portal над лавой. Вставил ${placed.length} глаз(а). ` +
      'Шаг в портал переносит в Край сразу, без задержки, и назад оттуда только через дракона — не наступай случайно.'
    if (p.enter) {
      const en: any = await enterPortal(session, ctl, detail.portal, deadline + 3000)
      detail.entered = en.entered
      detail.enter = en
      if (!en.entered) detail.stopped = `портал горит, но войти не вышло: ${en.why}`
    }
  } else {
    detail.stopped = `портал не загорелся: с оком ${withEye} рамок из ${after.length}` +
      (failedAt.length ? `; не вышло: ${failedAt.slice(0, 3).map(f => f.why).join('; ')}` : '')
  }
  return detail
}

// Войти в горящий портал (fill enter:true): встать на рамку — её верх на
// +0.8125, портал вровень с рамками и без коллизии — и шагнуть к центру 3x3.
// Перенос мгновенный; свидетель — мир бота сменился на Край.
async function enterPortal (session, ctl, portal, deadline) {
  const bot = session.bot
  const from = worlds.worldOf(bot)
  const out: any = { tries: 0 }
  const frameId = session.mcData.blocksByName.end_portal_frame.id
  const centre = new Vec3(portal.x + 0.5, portal.y, portal.z + 0.5)
  const frames = bot.findBlocks({ matching: [frameId], maxDistance: 6, point: centre, count: 12 })
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  if (!frames.length) return { entered: false, why: 'рамок у портала не вижу' }
  const switched = new Promise<any>(resolve => {
    const f = () => { if (worlds.worldOf(bot) !== from) { bot.removeListener('respawn', f); resolve(true) } }
    bot.on('respawn', f)
    gameClock.setTimeout(() => { bot.removeListener('respawn', f); resolve(false) }, Math.max(3000, deadline - gameClock.now()))
  })
  for (const f of frames.slice(0, 4)) {
    if (ctl.aborted || gameClock.now() > deadline || worlds.worldOf(bot) !== from) break
    out.tries++
    const w = await walkTo(bot, ctl, f.offset(0.5, 1, 0.5), 0.6, Math.min(20000, deadline - gameClock.now()))
    if (!w.ok && bot.entity.position.distanceTo(f.offset(0.5, 1, 0.5)) > 2) { out.why = `к рамке не подошёл: ${w.error}`; continue }
    const t0 = gameClock.now()
    try {
      while (!ctl.aborted && gameClock.now() - t0 < 4000 && worlds.worldOf(bot) === from) {
        await bot.lookAt(centre.offset(0, 0.5, 0), true).catch(() => {})
        bot.setControlState('forward', true)
        bot.setControlState('jump', bot.entity.onGround && bot.entity.position.y < f.y + 0.7)
        await sleep(50)
      }
    } finally {
      bot.setControlState('forward', false)
      bot.setControlState('jump', false)
    }
    if (worlds.worldOf(bot) !== from) break
  }
  const ok = worlds.worldOf(bot) !== from || await Promise.race([switched, sleep(3000).then(() => false)])
  out.entered = ok && worlds.worldOf(bot) === 'the_end'
  out.world = worlds.worldOf(bot)
  if (!out.entered && !out.why) out.why = 'шагнул к центру, а мир не сменился'
  if (out.entered) {
    savePlace(session, ROOM, { ...portal, dimension: 'overworld', lit: true, entered: true, note: 'портал в Край горит; через него уже входил' }, 'вошёл в портал — я в Краю')
  }
  return out
}

export {
  REACH, frameState, frameAim, breakRoomSpawner, fillFrames, enterPortal
}
