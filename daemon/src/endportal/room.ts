'use strict'
// Крепость и портал в Край (endportal.ts): разведка крепости до портальной комнаты (mode=room).
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { sleep, xyz }: typeof import('../movement') = require('../movement')
const { countOf }: typeof import('../items') = require('../items')
const { raySees, eyePos }: typeof import('../perception') = require('../perception')
const { walkable }: typeof import('../walkable') = require('../walkable')
const worlds: typeof import('../worlds') = require('../worlds')
import { PLACE, ROOM, BRICKS, clamp, honestDescent, log, placeOf, savePlace, walkTo, noInfested, visibleOf } from './common'
import { FLOOR, enterByBricks, breakIn } from './break-in'
import { goStronghold } from './go'

// ------------------------------------------------------------------ room

// Факел, если темно (свет блока < 5) и своего факела в 10 блоках нет: мобы
// спавнятся только при свете 0, факел (14) гасит спавн на ~12 блоков.
async function torchIfDark (bot, torches) {
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

// Разведка крепости: идти туда, где ещё не был, по клеткам, которые связаны с
// нами (walkable.js, «ощупью») и ВИДНЫ сейчас или были видны раньше (граница
// разведки). Цель — рамки end_portal_frame или спавнер чешуйниц, замеченные
// только лучом. Кирпич за стеной не подсказывает ничего.
async function findRoom (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 300, 30, 600) * 1000 - 4000
  if (worlds.worldOf(bot) !== 'overworld') return { found: false, stopped: 'крепости бывают только в верхнем мире' }
  const frameId = mcData.blocksByName.end_portal_frame.id
  const spawnerId = mcData.blocksByName.spawner.id
  const brickIds = (Object.values(mcData.blocksByName) as any[]).filter((b : any) => BRICKS.test(b.name)).map((b : any) => b.id)

  // Позвали прямо с поверхности (директор идёт find → room, минуя go): кирпича
  // рядом не видно, а крепость в памяти есть — сперва go (дойти, уточнить оком,
  // прокопаться к кирпичу), на него — до 60% срока, остальное — коридоры.
  let went = null
  const map = process.env.ND_ROOM_MAP !== '0' && (require('../stronghold') as typeof import('../stronghold')).mappedRoom(placeOf(session, PLACE))
  if (p.go !== false && ((!visibleOf(bot, brickIds, 12, 4).length && placeOf(session, PLACE)) || (map && !visibleOf(bot, [frameId], 16, 16).length))) {
    const secs = Math.max(30, Math.round((deadline - gameClock.now()) / 1000 * 0.6))
    went = await goStronghold(session, ctl, { ...p, timeoutSeconds: secs })
    if (!went.went) return { found: false, went, stopped: `до крепости не добрался: ${went.stopped}` }
  }

  // Обход крепости помнится между вызовами (ключ — крепость из памяти): раньше
  // каждый вызов room начинал заново от места, где стоит, и ходил теми же
  // коридорами (репетиция на двойнике мира прохождения, 2026-09-28: 85
  // переходов, 730 блоков, все — на восточной половине; комната — в 15 блоках
  // к западу, этажом выше; вызов оборвало low_health).
  const recK = placeOf(session, PLACE)
  const memKey = recK ? `${recK.x},${recK.z}` : 'нет'
  if (!session._roomExplore || session._roomExplore.key !== memKey) session._roomExplore = { key: memKey, visited: [], known: new Map(), failed: new Set() }
  const visited = session._roomExplore.visited
  const frontier = new Map()
  const known = session._roomExplore.known
  const failed = session._roomExplore.failed
  const key = v => `${v.x},${v.y},${v.z}`
  const legs = []
  let walked = 0
  let last = bot.entity.position.clone()
  const mark = () => {
    const f = bot.entity.position.floored()
    if (!visited.some(v => v.distanceTo(f) < 4)) visited.push(f)
    walked += bot.entity.position.distanceTo(last)
    last = bot.entity.position.clone()
  }
  const markTimer = gameClock.setInterval(mark, 500)
  ctl.onAbort.push(() => gameClock.clearInterval(markTimer))

  let seenFrames = []
  let digOuts = 0
  let lure = null
  let lureBest = null
  let lureStale = 0
  let lurePie = false
  let lurePrecise = false
  let vertTries = 0
  let lureBores = 0
  const usedLures = []
  const picks = new Map()
  let spawner = null
  let bricksSeen = 0
  // Стоим ещё в своей шахте у стены — сначала внутрь.
  const recS = placeOf(session, PLACE)
  // Точка отсчёта обхода — лестница старта (угол чанка старта + 4, высота —
  // где вошли); без крепости в памяти — где стоим.
  const origin = recS && Number.isFinite(recS.x)
    ? new Vec3(recS.x + (recS.refined ? 4 : 0), Number.isFinite(recS.y) ? recS.y : bot.entity.position.y, recS.z + (recS.refined ? 4 : 0))
    : bot.entity.position.clone()
  const restoreInfested = noInfested(bot)
  ctl.onAbort.push(restoreInfested)
  const torches = []
  let pre: any = { steps: [] }
  const eb = await enterByBricks(session, ctl, { deadline })
  log('вход по кирпичу', eb)
  if (eb.inside) session._roomExplore.entered = bot.entity.position.clone()
  else if (session._roomExplore.entered) {
    // Уже посещённый коридор — вернуться из штрека; повторный спуск уводил ниже крепости при каждом room.
    const back = session._roomExplore.entered
    const w = await walkTo(bot, ctl, back, 1, Math.min(30000, Math.max(0, deadline - gameClock.now())))
    legs.push({ why: 'назад в коридор', to: xyz(back), ok: w.ok })
  } else {
    pre = await breakIn(session, ctl, { deadline, tries: 8, toward: recS && recS.refined ? { x: recS.x + 4, z: recS.z + 4 } : null })
    if (pre.inside) session._roomExplore.entered = bot.entity.position.clone()
  }
  if (pre.steps.length) legs.push({ why: 'пробился внутрь', steps: pre.steps, inside: pre.inside })
  try {
    while (!ctl.aborted && gameClock.now() < deadline) {
      mark()
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
      // --- глаза
      seenFrames = visibleOf(bot, [frameId], 48, 24)
      if (seenFrames.length) break
      const sp = visibleOf(bot, [spawnerId], 32, 8)
      if (sp.length) {
        spawner = sp[0].position
        // Спавнер в крепости — на лестнице портальной комнаты: подойти к нему,
        // рамки откроются с площадки.
        const w = await walkTo(bot, ctl, spawner, 2, Math.min(20000, deadline - gameClock.now()))
        legs.push({ to: xyz(spawner), why: 'спавнер', ok: w.ok })
        seenFrames = visibleOf(bot, [frameId], 48, 24)
        if (seenFrames.length) break
      }
      bricksSeen = Math.max(bricksSeen, visibleOf(bot, brickIds, 16, 200).length)

      // --- граница: связанные клетки, видимые отсюда, далеко от посещённого
      const eye = eyePos(bot)
      const nodes = walkable(bot, bot.entity.position, { radius: 32, maxNodes: 8000, doors: true })
      // Всё нащупанное — в общую карту: из неё возвращаются к непройденному.
      // Прореженно (каждая четвёртая по сетке 2x2), чтобы карта не пухла.
      for (const n of nodes) {
        if ((n.pos.x & 1) || (n.pos.z & 1)) continue
        if (known.size < 40000) known.set(key(n.pos), n.pos)
      }
      let sampled = 0
      const fresh = []
      for (const n of nodes) {
        if (n.d < 3) continue
        const k = key(n.pos)
        if (failed.has(k)) continue
        if (visited.some(v => v.distanceTo(n.pos) < 5)) continue
        if (sampled++ > 1200) break
        if (raySees(bot, eye, n.pos.offset(0.5, 1.2, 0.5))) { frontier.set(k, n.pos); fresh.push(n) }
      }
      for (const [k, v] of frontier) if (visited.some(x => x.distanceTo(v) < 5)) frontier.delete(k)
      // Куда: самая ДАЛЬНЯЯ из видимых отсюда (в коридоре — его конец: взгляд
      // вдоль и шаг туда, как ходит человек); видимой нет — ближайшая из
      // запомненных (вернуться к непройденному ответвлению). «Ближайшая
      // всегда» топталась у старта: 150 переходов и 936 блоков за 9 минут, а
      // комната была в 45 блоках (прогон 2026-09-25).
      const me = bot.entity.position
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
      if (lure && lure.distanceTo(me) < 5 && !(lurePie && Math.abs(lure.y - me.y) >= 3 && vertTries < 3)) { usedLures.push(lure.clone ? lure.clone() : lure); lure = null }
      // «Пирог» F3 (S10): спавнер чешуйниц — только в портальной комнате крепости; пеленг его дуги из разных мест обхода →
      // пересечение (senses.triangulate) — место без клетки и без высоты (берём свою). Как спидраннеры: pie-ray к комнате.
      // ND_ROOM_PIE=0 — без «пирога».
      let pieLure = null
      let pieLurePrecise = false
      if (process.env.ND_ROOM_PIE !== '0') {
        try {
          const S: typeof import('../perception/senses') = require('../perception/senses')
          const arcs = S.pieArcs(bot, 'spawner', { fov: 20, step: 2 })
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
            if (pieLurePrecise) { const el = (require('../endportal-descent') as typeof import('../endportal-descent')).pieElevation(bot, Math.hypot(est.x - me.x, est.z - me.z)); if (el) ly = el.y }
            if (pieLurePrecise) pieLure = new Vec3(est.x, ly, est.z)
            else { const v = S.vecOf(arcs[0].center); pieLure = new Vec3(me.x + v.x * 24, me.y, me.z + v.z * 24) }
            // Дошёл до оценки, а рамок не видно — спавнер выше/ниже: эту точку не повторять (дальше звук лавы и обход).
            if (usedLures.some(u => Math.hypot(u.x - pieLure.x, u.z - pieLure.z) < 6)) pieLure = null
            if (pieLure && (!lure || pieLure.distanceTo(lure) > 6)) log('«пирог»: спавнер', { yaw: arcs[0].center, samples: ps.length, est: est ? { x: est.x, z: est.z, spread: est.spread, uncertainty: est.uncertainty } : null, precise: pieLurePrecise, lure: xyz(pieLure.floored()) })
          }
        } catch (e) { log('«пирог»: ошибка', { error: e.message }) }
      }
      // S10 (честное восприятие): чешуйницы — видимые лучом (место) или слышимые (сторона и полоса → точка-оценка), не все
      // в радиусе слежения; на уровне знания scan или ND_HONEST_LURE=0 — как было.
      const honestLure = process.env.ND_HONEST_LURE !== '0' && (require('../perception/knowledge') as typeof import('../perception/knowledge')).level() !== 'scan'
      const fish = !honestLure
        ? (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'silverfish' && e.position && e.isValid !== false && e.position.distanceTo(me) < 48)
        : (require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot, { radius: 48 }).filter((k: any) => k.name === 'silverfish')
          .map((k: any) => { const q = k.pos || k.lastPos || (k.heard && (require('../perception/senses') as typeof import('../perception/senses')).hearPoint(bot, k.heard)); return q ? { position: new Vec3(q.x, q.y, q.z) } : null }).filter(Boolean)
      if (fish.length) {
        const c = (fish.reduce((a: any, e: any) => a.plus(e.position), new Vec3(0, 0, 0)) as any).scaled(1 / fish.length)
        if (!lure || c.distanceTo(lure) > 4) log('чешуйницы', { n: fish.length, at: xyz(c.floored()) })
        lure = c; lurePie = false; lurePrecise = false
      } else if (pieLure) {
        if (!lure || pieLure.distanceTo(lure) > 6) { lure = pieLure; lureBest = null; lureStale = 0 }
        lurePie = true
        lurePrecise = pieLurePrecise
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
        if (heard && (!lure || heard.distanceTo(lure) > (honestLure ? 12 : 6))) { log('слышу лаву', { at: xyz(heard), d: Math.round(heard.distanceTo(me)) }); lure = heard; lurePie = false; lureBest = null; lureStale = 0 }
      }
      // К приманке коридорами не выходит (4 перехода без сближения на 2 блока) —
      // копать к ней штреком: спидраннеры так и делают — на звук сквозь стену
      // (кирпич крепости ~0.4 с железной киркой). Двойник 2: лава комнаты в 12–
      // 20 блоках за стенами, коридоры увели на другой этаж, 150 переходов.
      // У оценки «пирога» по горизонтали, а по высоте далеко — ступенями к её высоте (вверх/вниз), рамки откроются оттуда.
      if (lure && lurePie && honestDescent() && vertTries < 3 && Math.hypot(lure.x - me.x, lure.z - me.z) <= 8 && Math.abs(lure.y - me.y) >= 3 && !ctl.aborted && gameClock.now() < deadline - 20000) {
        vertTries++
        const v = await (require('../endportal-descent') as typeof import('../endportal-descent')).toLevel(session, ctl, Math.round(lure.y), { deadline: Math.min(deadline, gameClock.now() + 40000), bricks: BRICKS })
        legs.push({ why: 'к высоте спавнера', to: Math.round(lure.y), moved: v.moved, ok: v.ok, stop: v.why })
        log('к высоте спавнера («пирог»)', { from: Math.round(me.y), to: Math.round(lure.y), ok: v.ok, moved: v.moved, why: v.why })
        continue
      }
      if (lure) {
        const dl = me.distanceTo(lure)
        if (lureBest === null || dl < lureBest - 2) { lureBest = dl; lureStale = 0 } else lureStale++
        // «Пирог» с надёжным пересечением пеленгов — штрек сразу, без обхода коридоров (s5e-M-1:
        // 4.6 игр. мин коридорами и тупиками при оценке с разбросом 0.4).
        const piePrecise = lurePie && lurePrecise
        const xzNear = Math.hypot(lure.x - me.x, lure.z - me.z) <= 2
        if (!xzNear && lureStale >= (piePrecise ? 0 : lurePie ? 2 : 4) && lureBores < (lurePie ? 6 : 4) && !ctl.aborted && gameClock.now() < deadline - 20000) {
          lureBores++
          lureStale = 0
          const yLvl = Math.floor(lure.y) + 1
          try {
            const b = honestDescent()
              ? await (require('../endportal-descent') as typeof import('../endportal-descent')).honestBore(session, ctl, { x: Math.floor(lure.x), z: Math.floor(lure.z) }, { deadline: Math.min(deadline, gameClock.now() + (piePrecise ? 90000 : 45000)), maxSteps: piePrecise ? 48 : 24, bricks: BRICKS })
              : await (require('../nether') as typeof import('../nether')).bore(session, ctl, { x: Math.floor(lure.x), z: Math.floor(lure.z) }, {
                deadline: Math.min(deadline, gameClock.now() + 45000), maxSteps: 24, minY: yLvl, maxY: yLvl, throughBricks: true
              })
            legs.push({ why: 'к приманке штреком', to: xyz(lure.floored ? lure.floored() : lure), moved: b.moved, dug: b.dug, stop: b.why })
            log('штрек к приманке', { to: xyz(lure.floored ? lure.floored() : lure), moved: b.moved, dug: b.dug, why: b.why })
          } catch (e) { log('штрек к приманке', { error: e.message }) }
          continue
        }
      }
      const goal = lure || origin
      // Честный спуск — винтовая лестница: её клетки (пол — камень, не кирпич) связаны с коридором и видны; обход шёл бы по ней
      // назад к поверхности. Клетки без пола крепости — дороже на 20 (не запрет: проходы бывают и по камню пещер).
      const hold = honestDescent()
      const offHold = v => { if (!hold) return 0; const fl = bot.blockAt(v.offset(0, -1, 0)); return fl && FLOOR.test(fl.name) ? 0 : 20 }
      const score = v => v.distanceTo(goal) + 0.35 * v.distanceTo(me) + offHold(v)
      const live = fresh.filter(n => frontier.has(key(n.pos))).sort((a, b) => score(a.pos) - score(b.pos))
      const next = live.length
        ? live[0].pos
        : [...frontier.values()].sort((a, b) => score(a) - score(b))[0]
      if (!next) {
        // Видимой границы нет: коридор кончился дверью или завалом. Ощупью —
        // любая связанная клетка, где не был.
        const blind = nodes.filter(n => n.d >= 4 && !failed.has(key(n.pos)) && !visited.some(v => v.distanceTo(n.pos) < 5))
          .sort((a, b) => a.d - b.d)[0]
        if (blind) {
          frontier.set(key(blind.pos), blind.pos)
          continue
        }
        // И здесь всё пройдено — назад, к ближайшей из когда-либо нащупанных
        // клеток, где ещё не был (тупиковая библиотека на западе, а комната —
        // на востоке от старта: прогон у -3760,-3408 встал через 38 с).
        const back = [...known.values()]
          .filter(v => !failed.has(key(v)) && !visited.some(x => x.distanceTo(v) < 6))
          .sort((a, b) => (a.distanceTo(lure || origin) + 0.35 * a.distanceTo(me)) - (b.distanceTo(lure || origin) + 0.35 * b.distanceTo(me)))[0]
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
          if (lure && lureBores < 6 && honestDescent() && !ctl.aborted && gameClock.now() < deadline - 20000) {
            lureBores++
            const b = await (require('../endportal-descent') as typeof import('../endportal-descent')).honestBore(session, ctl, { x: Math.floor(lure.x), z: Math.floor(lure.z) }, { deadline: Math.min(deadline, gameClock.now() + 45000), maxSteps: 24, bricks: BRICKS })
            legs.push({ why: 'тупик — штрек к приманке', to: xyz(lure.floored ? lure.floored() : lure), moved: b.moved, dug: b.dug, stop: b.why })
            log('тупик — штрек к приманке', { to: xyz(lure.floored ? lure.floored() : lure), moved: b.moved, dug: b.dug, why: b.why })
            if (b.moved) continue
          }
          if (digOuts < 3 && !ctl.aborted && gameClock.now() < deadline - 20000) {
            digOuts++
            const bi = await breakIn(session, ctl, { deadline: Math.min(deadline, gameClock.now() + 40000), tries: 6, allowDescent: !session._roomExplore.entered })
            legs.push({ why: 'тупик — пробиваюсь', steps: bi.steps.slice(-4), inside: bi.inside })
            if (!bi.inside || walkable(bot, bot.entity.position, { radius: 8, maxNodes: 60, doors: true }).length < 20) {
              const me2 = bot.entity.position
              const ax = Math.abs(me2.x - origin.x) >= Math.abs(me2.z - origin.z)
              const dir = digOuts % 2 ? 1 : -1
              const tgt = ax ? { x: Math.round(me2.x + dir * 12), z: Math.round(me2.z) } : { x: Math.round(me2.x), z: Math.round(me2.z + dir * 12) }
              try {
                const b = honestDescent()
                  ? await (require('../endportal-descent') as typeof import('../endportal-descent')).honestBore(session, ctl, tgt, { deadline: Math.min(deadline, gameClock.now() + 40000), maxSteps: 12, bricks: BRICKS })
                  : await (require('../nether') as typeof import('../nether')).bore(session, ctl, tgt, { deadline: Math.min(deadline, gameClock.now() + 40000), maxSteps: 12, minY: Math.floor(me2.y), maxY: Math.floor(me2.y), throughBricks: true })
                legs.push({ why: 'тупик — штрек', to: tgt, moved: b.moved, dug: b.dug })
              } catch {}
            }
            continue
          }
          break
        }
        frontier.set(key(back), back)
        continue
      }
      frontier.delete(key(next))
      // В тёмных коридорах крепости — зомби и скелеты: переход под охраной
      // (nether.guarded: ударили — бой, еда, потом дальше). Лаборатория
      // 2026-09-27, джунгли 1232,2208: в крепость дошёл, 7 минут обходил
      // комнаты и умер от зомби («slain by Zombie»), ни разу не ответив.
      const w = await (require('../nether') as typeof import('../nether')).guarded(session, ctl, sub => walkTo(bot, sub, next, 1, Math.min(25000, deadline - gameClock.now())))
      await torchIfDark(bot, torches).catch(() => false)
      if (w.fought) {
        legs.push({ fought: w.fought })
        log('бой в крепости', w.fought)
        frontier.set(key(next), next)
        if ((bot.health ?? 20) < 8 && !ctl.aborted) {
          // Мало хп — поесть и постоять (сытость 18+ лечит), не ходить дальше вслепую.
          try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {}
          const tH = gameClock.now()
          while (!ctl.aborted && gameClock.now() - tH < 25000 && (bot.health ?? 20) < 14 && gameClock.now() < deadline) await sleep(1000)
        }
        continue
      }
      legs.push({ to: xyz(next), ok: w.ok, error: w.ok ? undefined : w.error })
      // Дошёл — сама цель тоже «пройдена»: mark() пишет клетку тела, только если
      // рядом (4) нет прежней отметки, и цель в 1 блоке от тела, но в 5+ от той
      // отметки, выбиралась снова и снова (двойник 2: 4 одинаковых перехода за
      // секунду). Та же цель трижды — в провал.
      if (w.ok) visited.push(next.floored ? next.floored() : next)
      const tk = key(next)
      picks.set(tk, (picks.get(tk) || 0) + 1)
      if (picks.get(tk) >= 3) failed.add(tk)
      log('переход', { to: xyz(next), ok: w.ok, frontier: frontier.size, visited: visited.length, t: Math.round((gameClock.now() - t0) / 1000) })
      if (!w.ok) failed.add(key(next))
      if (legs.length > 200) break
    }
  } finally {
    gameClock.clearInterval(markTimer)
    restoreInfested()
  }

  const detail: any = {
    found: seenFrames.length > 0,
    frames: seenFrames.length,
    spawner: spawner ? xyz(spawner) : undefined,
    legs: legs.length,
    walked: Math.round(walked),
    visited: visited.length,
    frontierLeft: frontier.size,
    bricksSeen,
    went: went ? { dug: went.dug, refined: went.refined, bricks: went.bricks, inside: went.inside, seconds: went.seconds, descentSeconds: went.descentSeconds, honest: went.honest } : undefined,
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (seenFrames.length) {
    const all = bot.findBlocks({ matching: [frameId], maxDistance: 12, point: seenFrames[0].position, count: 24 })
    const withEye = all.filter(pos => { const b = bot.blockAt(pos); return b && String(b.getProperties().eye) === 'true' }).length
    const c = all.reduce((a, v) => a.plus(v), new Vec3(0, 0, 0)).scaled(1 / all.length)
    const centre = { x: Math.floor(c.x), y: all[0].y, z: Math.floor(c.z) }
    detail.room = { centre, frames: all.length, withEye, empty: all.length - withEye }
    savePlace(session, ROOM, { ...centre, dimension: 'overworld', frames: all.length, withEye, note: `портальная комната: рамок ${all.length}, с оком ${withEye}` },
      `нашёл портальную комнату: центр ${centre.x},${centre.y},${centre.z}, рамок ${all.length}, с оком ${withEye}`)
    detail.note = `${went && Number.isFinite(went.descentSeconds) ? `(спуск ${went.descentSeconds} с) ` : ''}Вижу портальную комнату: ${all.length} рамок, с оком уже ${withEye}, пустых ${all.length - withEye}. ` +
      `Вставить: mc_stronghold mode=fill (глаз в рюкзаке ${countOf(bot, 'ender_eye')}).`
  } else {
    detail.stopped = ctl.aborted ? 'прервано' : (gameClock.now() >= deadline ? 'время вышло' : 'куда идти дальше, не вижу')
    detail.note = `${went && Number.isFinite(went.descentSeconds) ? `(спуск ${went.descentSeconds} с) ` : ''}Рамок не увидел: прошёл ${detail.walked} блоков, ${legs.length} переходов, кирпича видно ${bricksSeen}. ` +
      'Позови ещё раз — граница разведки строится заново от того места, где стою.'
  }
  return detail
}

export {
  torchIfDark, findRoom
}
