'use strict'
// Крепость и портал в Край (endportal.ts): разведка крепости (findRoom) — шаги оборота обхода: лечение, глаза (рамки,
// спавнер), граница разведки, приманка («пирог», чешуйницы, лава) и штрек к ней, выбор следующей клетки и переход.
// Шаг возвращает 'next' (следующий оборот), 'stop' (конец обхода) или ничего (дальше по шагам).
import * as gameClock from '../game-clock'
import { Vec3 } from 'vec3'
import { sleep, xyz } from '../movement'
import { raySees, eyePos } from '../perception'
import { walkable } from '../walkable'
import { BRICKS, honestDescent, log, walkTo, visibleOf } from './common'
import { FLOOR, breakIn } from './break-in'
import { type RoomRun, type RoomTick, type Turn, roomKey } from './room-state'

// ------------------------------------------------------------------ room

// Факел, если темно (свет блока < 5) и своего факела в 10 блоках нет: мобы
// спавнятся только при свете 0, факел (14) гасит спавн на ~12 блоков.
export async function torchIfDark (bot, torches) {
  const t = bot.inventory.items().find(i => i.name === 'torch')
  if (!t) return false
  const f = bot.entity.position.floored()
  const here = bot.blockAt(f)
  if (!here) return false
  if (typeof here.light === 'number' && here.light >= 5) return false
  if (torches.some(q => q.distanceTo(f) < 10)) return false
  const { withTimeout }: typeof import('../build') = require('../build')
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const c = f.offset(dx, 0, dz)
    const cb = bot.blockAt(c)
    const fl = bot.blockAt(c.offset(0, -1, 0))
    if (!cb || !/^(cave_)?air$/.test(cb.name) || !fl || fl.boundingBox !== 'block') continue
    try {
      await bot.equip(t, 'hand')
      await withTimeout(bot.placeBlock(fl, new Vec3(0, 1, 0)), 2500)
    } catch {}
    const got = bot.blockAt(c)
    if (got && /torch/.test(got.name)) { torches.push(c); return true }
  }
  return false
}

export async function roomHeal (rx: RoomRun, t: RoomTick): Promise<void> {
  const { session, ctl, bot, deadline } = rx
  // Лечиться, пока не поздно: в тёмных коридорах зомби и скелеты снимают
  // по 2–4 хп за бой, и обход умирал на третьем-четвёртом (репетиция:
  // «slain», хп 6 → 0). Врагов в 10 блоках нет — есть и стоять до 16.
  if ((bot.health ?? 20) < 12 && !(require('../combat') as typeof import('../combat')).nearestHostile(bot, 10)) {
    try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {}
    const tH = gameClock.now()
    while (!ctl.aborted && gameClock.now() - tH < 40000 && (bot.health ?? 20) < 16 && gameClock.now() < deadline && !(require('../combat') as typeof import('../combat')).nearestHostile(bot, 8)) {
      if ((bot.food ?? 20) < 18) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} }
      await sleep(1000)
    }
  }
}

export async function roomEyes (rx: RoomRun, t: RoomTick): Promise<Turn> {
  const { ctl, bot, deadline, frameId, spawnerId, brickIds, legs } = rx
  // --- глаза
  rx.seenFrames = visibleOf(bot, [frameId], 48, 24)
  if (rx.seenFrames.length) return 'stop'
  const sp = visibleOf(bot, [spawnerId], 32, 8)
  if (sp.length) {
    rx.spawner = sp[0].position
    // Спавнер в крепости — на лестнице портальной комнаты: подойти к нему,
    // рамки откроются с площадки.
    const w = await walkTo(bot, ctl, rx.spawner, 2, Math.min(20000, deadline - gameClock.now()))
    legs.push({ to: xyz(rx.spawner), why: 'спавнер', ok: w.ok })
    rx.seenFrames = visibleOf(bot, [frameId], 48, 24)
    if (rx.seenFrames.length) return 'stop'
    // ND_END2_PIE: дошёл до видимого спавнера, рамок нет — его трек «пирога» не комната.
    if (process.env.ND_END2_PIE === '1' && w.ok && rx.session._pieTrack) {
      for (const tr of rx.session._pieTrack.tracks) if (!tr.notRoom && tr.est && Math.hypot(tr.est.x - rx.spawner.x, tr.est.z - rx.spawner.z) <= 8) { tr.notRoom = 'дошёл до спавнера — рамок нет'; log('«пирог»: спавнер не комната', { track: tr.id, why: tr.notRoom }) }
    }
    // ND_SH_PIE_SKIP=1: дошёл до видимого спавнера, а рамок не видно — это не комната портала (данж: −9170, «пирог» вёл к спавнеру у
    // лестницы старта, комната — в 50 бл.; там же 8 зомби). Игрок это запоминает: из «пирога» этот спавнер больше не считать.
    if (process.env.ND_SH_PIE_SKIP === '1' && w.ok) {
      const ex = rx.session._roomExplore
      const nr = ex.notRoom || (ex.notRoom = [])
      if (!nr.some(p => p.distanceTo(rx.spawner) < 2)) { nr.push(rx.spawner.clone()); ex.pie = []; log('спавнер без рамок — не комната, из «пирога» вон', { at: xyz(rx.spawner) }) }
    }
  }
  rx.bricksSeen = Math.max(rx.bricksSeen, visibleOf(bot, brickIds, 16, 200).length)
}

// ND_SH_VPROBE=1 (sr27-end): стою у оценки «пирога» по горизонтали (надёжной), а рамок не видно — комната выше или ниже этажа
// коридоров. Высота «пирогом» на близкой дальности врёт на 5–10 бл. (p8-B −2642: оценка спавнера в комнате по x/z, высота −14…−17,
// тело штрекует на y −17, пол комнаты −11 — 34 мин под полом). Как игрок: ступенями вверх по 3 бл. (до +12), потом вниз (до −12) —
// сквозь кирпич, рамки/спавнер не копаются; каждый оборот глаза (roomEyes) смотрят рамки. Состояние — на крепость, через вызовы.
export async function roomVProbe (rx: RoomRun, t: RoomTick): Promise<Turn> {
  const { session, ctl, bot, deadline, legs } = rx
  if (process.env.ND_SH_VPROBE !== '1' || !honestDescent() || !rx.lure || !rx.lurePie || !rx.lurePrecise) return
  const me = bot.entity.position
  if (Math.hypot(rx.lure.x - me.x, rx.lure.z - me.z) > 4 || ctl.aborted || gameClock.now() > deadline - 20000) return
  const ex = session._roomExplore
  const key = `${Math.round(rx.lure.x / 6)},${Math.round(rx.lure.z / 6)}`
  if (!ex.vprobe || ex.vprobe.key !== key) ex.vprobe = { key, base: Math.floor(me.y), dir: rx.lure.y < me.y - 2 ? -1 : 1, turns: 0, flipped: false }
  const vp = ex.vprobe
  if (vp.turns >= 14) return
  vp.turns++
  const y = Math.floor(me.y)
  if ((vp.dir > 0 && y - vp.base >= 12) || (vp.dir < 0 && vp.base - y >= 12)) {
    if (vp.flipped) { vp.turns = 14; return }
    vp.dir = -vp.dir; vp.flipped = true
  }
  const D: typeof import('../endportal-descent') = require('../endportal-descent')
  const v = await D.toLevel(session, ctl, y + 3 * vp.dir, { deadline: Math.min(deadline, gameClock.now() + 30000), bricks: null, maxSteps: 4 })
  legs.push({ why: 'проба по высоте у «пирога»', dir: vp.dir, from: y, to: Math.floor(bot.entity.position.y), ok: v.ok, stop: v.why })
  log('проба по высоте у «пирога»', { dir: vp.dir, from: y, to: Math.floor(bot.entity.position.y), base: vp.base, ok: v.ok, why: v.why })
  if (!v.ok && !v.moved) { if (vp.flipped) vp.turns = 14; else { vp.dir = -vp.dir; vp.flipped = true } }
  return 'next'
}

export function roomFrontier (rx: RoomRun, t: RoomTick): void {
  const { bot, visited, frontier, known, failed } = rx
  // --- граница: связанные клетки, видимые отсюда, далеко от посещённого
  const eye = eyePos(bot)
  const nodes = t.nodes = walkable(bot, bot.entity.position, { radius: 32, maxNodes: 8000, doors: true })
  // Всё нащупанное — в общую карту: из неё возвращаются к непройденному.
  // Прореженно (каждая четвёртая по сетке 2x2), чтобы карта не пухла.
  for (const n of nodes) {
    if ((n.pos.x & 1) || (n.pos.z & 1)) continue
    if (known.size < 40000) known.set(roomKey(n.pos), n.pos)
  }
  let sampled = 0
  const fresh = t.fresh = []
  for (const n of nodes) {
    if (n.d < 3) continue
    const k = roomKey(n.pos)
    if (failed.has(k)) continue
    if (visited.some(v => v.distanceTo(n.pos) < 5)) continue
    if (sampled++ > 1200) break
    if (raySees(bot, eye, n.pos.offset(0.5, 1.2, 0.5))) { frontier.set(k, n.pos); fresh.push(n) }
  }
  for (const [k, v] of frontier) if (visited.some(x => x.distanceTo(v) < 5)) frontier.delete(k)
}

// «Пирог» F3: оценка места спавнера чешуйниц пеленгами из разных мест обхода (pieLure — точка, pieLurePrecise — надёжно).
function roomPieLure (rx: RoomRun, me) {
  const { session, bot, usedLures } = rx
  // «Пирог» F3 (S10): спавнер чешуйниц — только в портальной комнате крепости; пеленг его дуги из разных мест обхода →
  // пересечение (senses.triangulate) — место без клетки и без высоты (берём свою). Как спидраннеры: pie-ray к комнате.
  // ND_ROOM_PIE=0 — без «пирога».
  let pieLure = null
  let pieLurePrecise = false
  // ND_END2_PIE=1: каждая дуга спавнера — свой трек; данж и спавнер выше крепости — не комната (endportal/pie-track.ts).
  if (process.env.ND_ROOM_PIE !== '0' && process.env.ND_END2_PIE === '1') {
    try {
      const P: typeof import('./pie-track') = require('./pie-track')
      const notRoom = process.env.ND_SH_PIE_SKIP === '1' ? (session._roomExplore.notRoom || []) : []
      const store = P.pieStore(session, session._roomExplore.key)
      const fresh = P.pieObserve(bot, store, { skip: notRoom.length ? c => notRoom.some(p => Math.abs(p.x - c.x) <= 1 && Math.abs(p.y - c.y) <= 1 && Math.abs(p.z - c.z) <= 1) : null })
      const b = P.pieBest(bot, store, rx.origin)
      if (b) {
        pieLurePrecise = b.precise
        pieLure = new Vec3(b.at.x, b.precise && b.y !== null ? b.y : me.y, b.at.z)
        if (usedLures.some(u => Math.hypot(u.x - pieLure.x, u.z - pieLure.z) < 6)) pieLure = null
        if (pieLure && fresh && (!rx.lure || pieLure.distanceTo(rx.lure) > 6)) log('«пирог»: спавнер', { track: b.track, precise: b.precise, lure: xyz(pieLure.floored()), tracks: P.pieSummary(store) })
      }
    } catch (e) { log('«пирог»: ошибка', { error: e.message }) }
    return { pieLure, pieLurePrecise }
  }
  if (process.env.ND_ROOM_PIE !== '0') {
    try {
      const S: typeof import('../perception/senses') = require('../perception/senses')
      const notRoom = process.env.ND_SH_PIE_SKIP === '1' ? (session._roomExplore.notRoom || []) : []
      const arcs = S.pieArcs(bot, 'spawner', { fov: 20, step: 2, skip: notRoom.length ? c => notRoom.some(p => Math.abs(p.x - c.x) <= 1 && Math.abs(p.y - c.y) <= 1 && Math.abs(p.z - c.z) <= 1) : null })
      const ps = session._roomExplore.pie || (session._roomExplore.pie = [])
      if (arcs.length && !arcs[0].all && arcs[0].center !== null) {
        const last = ps[ps.length - 1]
        if (!last || Math.hypot(last.x - me.x, last.z - me.z) >= 4) ps.push({ x: me.x, z: me.z, yaw: arcs[0].center })
        if (ps.length > 8) ps.splice(0, ps.length - 8)
        const est = ps.length >= 2 ? S.triangulate(ps) : null
        pieLurePrecise = !!est && [est.x, est.z, est.spread, est.uncertainty].every(Number.isFinite) && est.spread <= 6 && est.uncertainty <= 6
        // Высота — «пирогом» по вертикали (наклон камеры) при известной горизонтальной дальности (s5e-Q-2: комната на 3 бл. выше
        // штрека — 4 штрека «за 24 шагов не дошёл»).
        let ly = me.y
        if (pieLurePrecise) { const el = (require('../endportal-descent') as typeof import('../endportal-descent')).pieElevation(bot, Math.hypot(est.x - me.x, est.z - me.z), { skip: notRoom.length ? c => notRoom.some(p => Math.abs(p.x - c.x) <= 1 && Math.abs(p.y - c.y) <= 1 && Math.abs(p.z - c.z) <= 1) : null }); if (el) ly = el.y; if (process.env.ND_PIE_YCAP === '1') ly = Math.min(ly, 52) }
        if (pieLurePrecise) pieLure = new Vec3(est.x, ly, est.z)
        else { const v = S.vecOf(arcs[0].center); pieLure = new Vec3(me.x + v.x * 24, me.y, me.z + v.z * 24) }
        // Дошёл до оценки, а рамок не видно — спавнер выше/ниже: эту точку не повторять (дальше звук лавы и обход).
        if (usedLures.some(u => Math.hypot(u.x - pieLure.x, u.z - pieLure.z) < 6)) pieLure = null
        if (pieLure && (!rx.lure || pieLure.distanceTo(rx.lure) > 6)) log('«пирог»: спавнер', { yaw: arcs[0].center, samples: ps.length, est: est ? { x: est.x, z: est.z, spread: est.spread, uncertainty: est.uncertainty } : null, precise: pieLurePrecise, lure: xyz(pieLure.floored()) })
      }
    } catch (e) { log('«пирог»: ошибка', { error: e.message }) }
  }
  return { pieLure, pieLurePrecise }
}

// Приманка: «пирог» (пеленг спавнера), чешуйницы (видно/слышно), звук лавы; пустая приманка — забыть.
export async function roomLure (rx: RoomRun, t: RoomTick): Promise<void> {
  const { session, bot, usedLures } = rx
  // Куда: самая ДАЛЬНЯЯ из видимых отсюда (в коридоре — его конец: взгляд
  // вдоль и шаг туда, как ходит человек); видимой нет — ближайшая из
  // запомненных (вернуться к непройденному ответвлению). «Ближайшая
  // всегда» топталась у старта: 150 переходов и 936 блоков за 9 минут, а
  // комната была в 45 блоках (прогон 2026-09-25).
  const me = t.me = bot.entity.position
  // Ближе к лестнице старта — раньше (обход «слоями» от старта): «самая
  // дальняя видимая» уводила вдоль коридоров за 100+ блоков — репетиция на
  // двойнике: 160 переходов, тело на y=9 в 90 блоках к востоку, а комната —
  // в 25 блоках к западу от лестницы, на её этаже. Счёт клетки: расстояние
  // до лестницы + треть пути от нас (не прыгать через всю крепость).
  // Чешуйницы — «слышно» комнату: спавнер чешуйниц стоит только на лестнице
  // портальной комнаты и работает, пока игрок в 16 блоках от него, — рождённые
  // им ползают рядом (сервер шлёт их позиции в радиусе слежения, как и звук у
  // человека). Видели чешуйниц — идём к ним, а не «слоями от старта».
  // Дошли до приманки, а рамок не видно — она пустая (лава в пещере): забыть.
  if (rx.lure && rx.lure.distanceTo(me) < 5 && !(rx.lurePie && Math.abs(rx.lure.y - me.y) >= 3 && rx.vertTries < 3)) { usedLures.push(rx.lure.clone ? rx.lure.clone() : rx.lure); rx.lure = null }
  const { pieLure, pieLurePrecise } = roomPieLure(rx, me)
  // S10 (честное восприятие): чешуйницы — видимые лучом (место) или слышимые (сторона и полоса → точка-оценка), не все
  // в радиусе слежения; на уровне знания scan или ND_HONEST_LURE=0 — как было.
  const honestLure = process.env.ND_HONEST_LURE !== '0' && (require('../perception/knowledge') as typeof import('../perception/knowledge')).level() !== 'scan'
  const fish = !honestLure
    ? (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'silverfish' && e.position && e.isValid !== false && e.position.distanceTo(me) < 48)
    : (require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot, { radius: 48 }).filter((k: any) => k.name === 'silverfish')
      .map((k: any) => { const q = k.pos || k.lastPos || (k.heard && (require('../perception/senses') as typeof import('../perception/senses')).hearPoint(bot, k.heard)); return q ? { position: new Vec3(q.x, q.y, q.z) } : null }).filter(Boolean)
  if (fish.length) {
    const c = (fish.reduce((a: any, e: any) => a.plus(e.position), new Vec3(0, 0, 0)) as any).scaled(1 / fish.length)
    if (!rx.lure || c.distanceTo(rx.lure) > 4) log('чешуйницы', { n: fish.length, at: xyz(c.floored()) })
    rx.lure = c; rx.lurePie = false; rx.lurePrecise = false
  } else if (pieLure) {
    if (!rx.lure || pieLure.distanceTo(rx.lure) > 6) { rx.lure = pieLure; rx.lureBest = null; rx.lureStale = 0 }
    rx.lurePie = true
    rx.lurePrecise = pieLurePrecise
  }
  // Лава — «слышно» тоже: клиент игры сам играет звуки лавы для лавы в 32
  // блоках (ClientLevel.animateTick → LavaFluid.animateTick), сквозь стены;
  // спидраннеры идут на этот звук — под рамками комнаты бассейн лавы. Берём
  // ближайшую лаву в 32 блоках на высоте крепости (±12 от ног).
  if (!fish.length && !pieLure) {
    const lavaId = bot.registry.blocksByName.lava.id
    let heard = null
    try {
      if (honestLure) {
        // S10: звук лавы клиента — только у лавы с воздухом сверху; наружу — румб 22.5° и дальность до 4 бл. (точка-оценка).
        const h = (require('../perception/senses') as typeof import('../perception/senses')).hearLavaPoint(bot, { radius: 32, maxDy: 12, skip: q => usedLures.some(u => u.distanceTo(new Vec3(q.x, q.y, q.z)) < 12) })
        heard = h ? new Vec3(h.at.x, h.at.y, h.at.z) : null
      } else {
        heard = bot.findBlocks({ matching: [lavaId], maxDistance: 32, count: 60 })
          .filter(q => Math.abs(q.y - me.y) <= 12 && !usedLures.some(u => u.distanceTo(q) < 10))
          .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0] || null
      }
    } catch {}
    // Оценка по звуку дрожит на шаг румба/дальности — приманку меняем, только если звук ушёл дальше 12 бл. (честный слух).
    if (heard && (!rx.lure || heard.distanceTo(rx.lure) > (honestLure ? 12 : 6))) { log('слышу лаву', { at: xyz(heard), d: Math.round(heard.distanceTo(me)) }); rx.lure = heard; rx.lurePie = false; rx.lureBest = null; rx.lureStale = 0 }
  }
}

export async function roomLureMove (rx: RoomRun, t: RoomTick): Promise<Turn> {
  const { session, ctl, deadline, legs } = rx
  const { me } = t
  // К приманке коридорами не выходит (4 перехода без сближения на 2 блока) —
  // копать к ней штреком: спидраннеры так и делают — на звук сквозь стену
  // (кирпич крепости ~0.4 с железной киркой). Двойник 2: лава комнаты в 12–
  // 20 блоках за стенами, коридоры увели на другой этаж, 150 переходов.
  // У оценки «пирога» по горизонтали, а по высоте далеко — ступенями к её высоте (вверх/вниз), рамки откроются оттуда.
  if (rx.lure && rx.lurePie && honestDescent() && rx.vertTries < 3 && Math.hypot(rx.lure.x - me.x, rx.lure.z - me.z) <= 8 && Math.abs(rx.lure.y - me.y) >= 3 && !ctl.aborted && gameClock.now() < deadline - 20000) {
    rx.vertTries++
    const v = await (require('../endportal-descent') as typeof import('../endportal-descent')).toLevel(session, ctl, Math.round(rx.lure.y), { deadline: Math.min(deadline, gameClock.now() + 40000), bricks: BRICKS })
    legs.push({ why: 'к высоте спавнера', to: Math.round(rx.lure.y), moved: v.moved, ok: v.ok, stop: v.why })
    log('к высоте спавнера («пирог»)', { from: Math.round(me.y), to: Math.round(rx.lure.y), ok: v.ok, moved: v.moved, why: v.why })
    return 'next'
  }
  if (rx.lure) {
    const dl = me.distanceTo(rx.lure)
    if (rx.lureBest === null || dl < rx.lureBest - 2) { rx.lureBest = dl; rx.lureStale = 0 } else rx.lureStale++
    // «Пирог» с надёжным пересечением пеленгов — штрек сразу, без обхода коридоров (s5e-M-1:
    // 4.6 игр. мин коридорами и тупиками при оценке с разбросом 0.4).
    const piePrecise = rx.lurePie && rx.lurePrecise
    const xzNear = Math.hypot(rx.lure.x - me.x, rx.lure.z - me.z) <= 2
    if (!xzNear && rx.lureStale >= (piePrecise ? 0 : rx.lurePie ? 2 : 4) && rx.lureBores < (rx.lurePie ? 6 : 4) && !ctl.aborted && gameClock.now() < deadline - 20000) {
      rx.lureBores++
      rx.lureStale = 0
      const yLvl = Math.floor(rx.lure.y) + 1
      try {
        const b = honestDescent()
          ? await (require('../endportal-descent') as typeof import('../endportal-descent')).honestBore(session, ctl, { x: Math.floor(rx.lure.x), z: Math.floor(rx.lure.z) }, { deadline: Math.min(deadline, gameClock.now() + (piePrecise ? 90000 : 45000)), maxSteps: piePrecise ? 48 : 24, bricks: BRICKS })
          : await (require('../nether') as typeof import('../nether')).bore(session, ctl, { x: Math.floor(rx.lure.x), z: Math.floor(rx.lure.z) }, {
            deadline: Math.min(deadline, gameClock.now() + 45000), maxSteps: 24, minY: yLvl, maxY: yLvl, throughBricks: true
          })
        legs.push({ why: 'к приманке штреком', to: xyz(rx.lure.floored ? rx.lure.floored() : rx.lure), moved: b.moved, dug: b.dug, stop: b.why })
        log('штрек к приманке', { to: xyz(rx.lure.floored ? rx.lure.floored() : rx.lure), moved: b.moved, dug: b.dug, why: b.why })
      } catch (e) { log('штрек к приманке', { error: e.message }) }
      return 'next'
    }
  }
}

export async function roomPick (rx: RoomRun, t: RoomTick): Promise<Turn> {
  const { session, ctl, bot, deadline, visited, frontier, known, failed, legs, origin } = rx
  const { nodes, fresh, me } = t
  const goal = rx.lure || origin
  // Честный спуск — винтовая лестница: её клетки (пол — камень, не кирпич) связаны с коридором и видны; обход шёл бы по ней
  // назад к поверхности. Клетки без пола крепости — дороже на 20 (не запрет: проходы бывают и по камню пещер).
  const hold = honestDescent()
  const offHold = v => { if (!hold) return 0; const fl = bot.blockAt(v.offset(0, -1, 0)); return fl && FLOOR.test(fl.name) ? 0 : 20 }
  const score = v => v.distanceTo(goal) + 0.35 * v.distanceTo(me) + offHold(v)
  const live = fresh.filter(n => frontier.has(roomKey(n.pos))).sort((a, b) => score(a.pos) - score(b.pos))
  const next = t.next = live.length
    ? live[0].pos
    : [...frontier.values()].sort((a, b) => score(a) - score(b))[0]
  if (!next) {
    // Видимой границы нет: коридор кончился дверью или завалом. Ощупью —
    // любая связанная клетка, где не был.
    const blind = nodes.filter(n => n.d >= 4 && !failed.has(roomKey(n.pos)) && !visited.some(v => v.distanceTo(n.pos) < 5))
      .sort((a, b) => a.d - b.d)[0]
    if (blind) {
      frontier.set(roomKey(blind.pos), blind.pos)
      return 'next'
    }
    // И здесь всё пройдено — назад, к ближайшей из когда-либо нащупанных
    // клеток, где ещё не был (тупиковая библиотека на западе, а комната —
    // на востоке от старта: прогон у -3760,-3408 встал через 38 с).
    const back = [...known.values()]
      .filter(v => !failed.has(roomKey(v)) && !visited.some(x => x.distanceTo(v) < 6))
      .sort((a, b) => (a.distanceTo(rx.lure || origin) + 0.35 * a.distanceTo(me)) - (b.distanceTo(rx.lure || origin) + 0.35 * b.distanceTo(me)))[0]
    if (!back) {
      log('тупик', { at: xyz(bot.entity.position), nodes: nodes.length, fresh: fresh.length, known: known.size, visited: visited.length, failed: failed.size, nodesFar: nodes.filter(n => n.d >= 4).length, ys: [...new Set(nodes.map(n => n.pos.y))].sort((x: any, y: any) => x - y).join(',') })
      // Тупик — пробиться: стенка крепости в один кирпич, за ней коридор
      // (breakIn: вниз по потолку, вбок сквозь стену к воздуху); затем
      // штрек в 12 блоков от лестницы старта — коридоры крепости густые, и
      // прямой штрек их пересекает. Раньше тупик кончал вызов сразу:
      // «куда идти дальше, не вижу» за 0 с (двойник 2, лестница после
      // прошлых обходов — 9 клеток).
      // Тупик, а приманка есть («пирог»/слух/чешуйницы) — штрек к ней на своём уровне, а не вниз сквозь пол (s5e-Q-2 07.10: тупик →
      // пробиться → честный вход ступенями вниз 46 → 30, а спавнер в 40 бл. по пеленгу).
      if (rx.lure && rx.lureBores < 6 && honestDescent() && !ctl.aborted && gameClock.now() < deadline - 20000) {
        rx.lureBores++
        const b = await (require('../endportal-descent') as typeof import('../endportal-descent')).honestBore(session, ctl, { x: Math.floor(rx.lure.x), z: Math.floor(rx.lure.z) }, { deadline: Math.min(deadline, gameClock.now() + 45000), maxSteps: 24, bricks: BRICKS })
        legs.push({ why: 'тупик — штрек к приманке', to: xyz(rx.lure.floored ? rx.lure.floored() : rx.lure), moved: b.moved, dug: b.dug, stop: b.why })
        log('тупик — штрек к приманке', { to: xyz(rx.lure.floored ? rx.lure.floored() : rx.lure), moved: b.moved, dug: b.dug, why: b.why })
        if (b.moved) return 'next'
      }
      if (rx.digOuts < 3 && !ctl.aborted && gameClock.now() < deadline - 20000) {
        rx.digOuts++
        const bi = await breakIn(session, ctl, { deadline: Math.min(deadline, gameClock.now() + 40000), tries: 6, allowDescent: !session._roomExplore.entered })
        legs.push({ why: 'тупик — пробиваюсь', steps: bi.steps.slice(-4), inside: bi.inside })
        if (!bi.inside || walkable(bot, bot.entity.position, { radius: 8, maxNodes: 60, doors: true }).length < 20) {
          const me2 = bot.entity.position
          const ax = Math.abs(me2.x - origin.x) >= Math.abs(me2.z - origin.z)
          const dir = rx.digOuts % 2 ? 1 : -1
          const tgt = ax ? { x: Math.round(me2.x + dir * 12), z: Math.round(me2.z) } : { x: Math.round(me2.x), z: Math.round(me2.z + dir * 12) }
          try {
            const b = honestDescent()
              ? await (require('../endportal-descent') as typeof import('../endportal-descent')).honestBore(session, ctl, tgt, { deadline: Math.min(deadline, gameClock.now() + 40000), maxSteps: 12, bricks: BRICKS })
              : await (require('../nether') as typeof import('../nether')).bore(session, ctl, tgt, { deadline: Math.min(deadline, gameClock.now() + 40000), maxSteps: 12, minY: Math.floor(me2.y), maxY: Math.floor(me2.y), throughBricks: true })
            legs.push({ why: 'тупик — штрек', to: tgt, moved: b.moved, dug: b.dug })
          } catch {}
        }
        return 'next'
      }
      return 'stop'
    }
    frontier.set(roomKey(back), back)
    return 'next'
  }
}

export async function roomWalk (rx: RoomRun, t: RoomTick): Promise<Turn> {
  const { session, ctl, bot, t0, deadline, visited, frontier, failed, legs, picks, torches } = rx
  const { next } = t
  frontier.delete(roomKey(next))
  // В тёмных коридорах крепости — зомби и скелеты: переход под охраной
  // (nether.guarded: ударили — бой, еда, потом дальше). Лаборатория
  // 2026-09-27, джунгли 1232,2208: в крепость дошёл, 7 минут обходил
  // комнаты и умер от зомби («slain by Zombie»), ни разу не ответив.
  const w = await (require('../nether') as typeof import('../nether')).guarded(session, ctl, sub => walkTo(bot, sub, next, 1, Math.min(25000, deadline - gameClock.now())))
  await torchIfDark(bot, torches).catch(() => false)
  if (w.fought) {
    legs.push({ fought: w.fought })
    log('бой в крепости', w.fought)
    frontier.set(roomKey(next), next)
    if ((bot.health ?? 20) < 8 && !ctl.aborted) {
      // Мало хп — поесть и постоять (сытость 18+ лечит), не ходить дальше вслепую.
      try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {}
      const tH = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tH < 25000 && (bot.health ?? 20) < 14 && gameClock.now() < deadline) await sleep(1000)
    }
    return 'next'
  }
  legs.push({ to: xyz(next), ok: w.ok, error: w.ok ? undefined : w.error })
  // Дошёл — сама цель тоже «пройдена»: mark() пишет клетку тела, только если
  // рядом (4) нет прежней отметки, и цель в 1 блоке от тела, но в 5+ от той
  // отметки, выбиралась снова и снова (двойник 2: 4 одинаковых перехода за
  // секунду). Та же цель трижды — в провал.
  if (w.ok) visited.push(next.floored ? next.floored() : next)
  const tk = roomKey(next)
  picks.set(tk, (picks.get(tk) || 0) + 1)
  if (picks.get(tk) >= 3) failed.add(tk)
  log('переход', { to: xyz(next), ok: w.ok, frontier: frontier.size, visited: visited.length, t: Math.round((gameClock.now() - t0) / 1000) })
  if (!w.ok) failed.add(roomKey(next))
  if (legs.length > 200) return 'stop'
}
