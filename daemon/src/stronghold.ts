'use strict'
import * as gameClock from './game-clock'
// Поиск крепости оком эндера (mc_stronghold mode=find | throw | solve | blind).
//
// Механика — исходники 1.21.11 (extremeheat/extracted_minecraft_data, ветка
// client1.21.11, и data/ из server-1.21.11.jar; разобрано 2026-09-26):
//   * EnderEyeItem.use: око появляется в точке бросившего (x, y+рост/2, z) и
//     летит к signalTo(Vec3.atLowerCornerOf(findNearestMapStructure(...))) —
//     это StructurePlacement.getLocatePos стартового чанка крепости: угол
//     (16·cx, 0, 16·cz). У strongholds.json locate_offset не задан — ноль.
//     Какая крепость «ближайшая» — по расстоянию до середины чанка
//     (16·cx+8, 32, 16·cz+8), ChunkGenerator.getNearestGeneratedStructure.
//   * EyeOfEnder.signalTo: угол дальше 12 блоков по горизонтали — цель в 12
//     блоках в его сторону и на 8 выше; ближе — сам угол, и око ныряет к y=0.
//     Живёт 80 тиков, потом предмет (surviveAfterDeath = nextInt(5) > 0, 80%)
//     или «разбилось» (20%).
//   * EyeOfEnder.tick / updateDeltaMovement: каждый тик горизонтальная
//     скорость смотрит из следующей точки ПРЯМО на цель, так что по
//     горизонтали око идёт строго по прямой «точка броска → угол чанка»:
//     ~12 блоков за 32 тика (симуляция по формуле), дальше висит у цели.
//     Точка появления приходит точными double (spawn_entity), дальше —
//     дельты в 1/4096 блока (rel_entity_move). Направление по этим двум
//     точкам на 12 блоках — тысячные доли градуса, в разы точнее F3 у
//     человека (0.01°): бот смотрит на само око, как человек перекрестием,
//     только без дрожи руки. Рентгена тут нет — око видно всем.
//   * Крепости сидят на сетке чанков: угол кратен 16. Кольца —
//     ChunkGeneratorStructureState.generateRingPositions (count 128,
//     distance 32, spread 3): радиус кольца k = 4·32 + 6·32·k + (u−0.5)·2.5·32
//     чанков, в кольцах 3, 6, 10, 15, 21, 28, 36, 9 крепостей, потом сдвиг к
//     биому stronghold_biased_to до 112 блоков (findBiomeHorizontal, радиус
//     112, случайная подходящая клетка). Кольцо 0 — 1408..2688 блоков от 0,0.
//   * Старт — StrongholdPieces.StartPiece (StairsDown 5×11×5) от (16cx+2, 64,
//     16cz+2), вся постройка потом опущена (moveBelowSeaLevel: верх не выше
//     seaLevel−10). Лестничная башня — x+2..x+6, z+2..z+6: копать у (x+4, z+4).
//
// Решатель — как у Ninjabrain Bot (байесовский, по чанкам): кандидаты — углы
// чанков вдоль лучей бросков, вес кандидата = плотность колец × правдоподобие
// углов (гаусс, σ из точности замера). Один бросок — список вдоль луча с
// вероятностями, два из разных точек — обычно одна точка с p ≈ 1.

const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz, travelXZ } from './movement'
import { itemNamed, countOf } from './items'

const TAU = Math.PI * 2
const DEG = 180 / Math.PI
const EYE_REACH = 12 // EyeOfEnder.TOO_FAR_DISTANCE
// Ошибка позиции ока у клиента. Дельты движения — в 1/4096 блока от последней
// отправленной базы, база сервера точная, у клиента — округлённая: ошибка
// копится блужданием, ~22 пакета за полёт. Замер в игре (try-speedrun.js (у),
// 2026-09-26, 8 бросков с 500–1055 блоков против /locate): невязка угла RMS
// 0.00034° (5.9e-6 рад), худшая 0.0006° — это ~5e-5 блока на 12 блоках
// пролёта. Берём в 10 раз хуже: σ = 0.0005·√2/12 ≈ 5.9e-5 рад (0.0034°).
// Синтетика с этими σ (solvetest, 300 раскладок): один бросок — точный чанк в
// 93–97%, два из точек в 12–40 блоках — 100%, p ≥ 0.95 в 97–100%.
const POS_ERR = 0.0005
const SIGMA_MIN = 1e-5
const PLACE = 'крепость'

// Карта копии мира — подсказка маршрута, не запись «портал найден».
// Старый скан сохранял BB комнаты только в note; поддерживаем его без перескана.
function mappedRoom (rec) {
  if (!rec || (rec.dimension && rec.dimension !== 'overworld')) return null
  let room = rec.room || rec.portalRoom
  let bb = room && room.bb
  const m = /комната портала (-?\d+),(-?\d+),(-?\d+)\.\.(-?\d+),(-?\d+),(-?\d+)/.exec(rec.note || '')
  if (!bb && m && /карта/.test(rec.note)) bb = m.slice(1).map(Number)
  if (bb) {
    if (!Array.isArray(bb) || bb.length !== 6 || !bb.every(Number.isFinite)) return null
    const [x1, y1, z1, x2, y2, z2] = bb
    if (!((x2 - x1 === 10 && z2 - z1 === 15) || (x2 - x1 === 15 && z2 - z1 === 10)) || y2 - y1 !== 7) return null
    room = { x: Math.round((x1 + x2) / 2), y: y1 + 3, z: Math.round((z1 + z2) / 2) }
  } else room = room && (room.centre || room.center || room)
  if (!room || ![room.x, room.y, room.z].every(Number.isFinite) || room.y < -60 || room.y > 315 || Math.abs(room.x) > 29999984 || Math.abs(room.z) > 29999984) return null
  return { centre: { x: Math.floor(room.x), y: Math.floor(room.y), z: Math.floor(room.z) }, bb: bb ? bb.slice() : null }
}

function roomApproach (room, from) {
  const c = room.centre
  const y = c.y + 1 // выше рамок: под центром лава; идём к боковому проходу
  if (room.bb) {
    const [x1, , z1, x2, , z2] = room.bb
    if (x2 - x1 < z2 - z1) {
      const east = Math.abs(from.x - x2) < Math.abs(from.x - x1)
      return { shaft: { x: east ? x2 + 2 : x1 - 2, z: c.z }, target: { x: east ? x2 - 1 : x1 + 1, y, z: c.z } }
    }
    const south = Math.abs(from.z - z2) < Math.abs(from.z - z1)
    return { shaft: { x: c.x, z: south ? z2 + 2 : z1 - 2 }, target: { x: c.x, y, z: south ? z2 - 1 : z1 + 1 } }
  }
  // Только центр: первая стенка в 5 бл. от него, без спуска на центр лавы.
  const dx = from.x <= c.x ? -1 : 1
  return { shaft: { x: c.x + dx * 7, z: c.z }, target: { x: c.x + dx * 4, y, z: c.z } }
}

const wrap = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
// Компасный угол, как во всём демоне: 0 — юг (+z), 90° — восток (+x).
const bearingOf = (from, to) => Math.atan2(to.x - from.x, to.z - from.z)
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const snap16 = v => Math.round(v / 16) * 16
const r1 = v => Math.round(v * 10) / 10
function withTimeout (promise, ms) {
  let timer = null
  return Promise.race([promise, new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), ms) })])
    .finally(() => gameClock.clearTimeout(timer))
}

// Кольца — тот же цикл, что в generateRingPositions (целочисленное деление Java).
const RINGS = (() => {
  const out = []
  let spread = 3
  let inRing = 0
  let ring = 0
  for (let i = 0; i < 128; i++) {
    if (!out[ring]) out[ring] = { ring, n: 0, lo: (4 * 32 + 32 * ring * 6 - 40) * 16, hi: (4 * 32 + 32 * ring * 6 + 40) * 16 }
    out[ring].n++
    if (++inRing === spread) {
      ring++
      inRing = 0
      spread += Math.floor(2 * spread / (ring + 1))
      spread = Math.min(spread, 128 - i)
    }
  }
  return out
})()
// Сдвиг к биому (до 112) и угол чанка вместо середины (до 11) размывают края.
const RING_BLUR = 128

// Плотность крепостей на квадратный блок на расстоянии R от 0,0.
function ringDensity (R) {
  let d = 0
  for (const g of RINGS) {
    const lo = g.lo - RING_BLUR
    const hi = g.hi + RING_BLUR
    const area = Math.PI * (hi * hi - Math.max(0, lo) * Math.max(0, lo))
    const w = 1 / (1 + Math.exp((lo - R) / 24)) / (1 + Math.exp((R - hi) / 24))
    d += g.n / area * w
  }
  return d + 1e-14
}

// Око летит к БЛИЖАЙШЕЙ крепости (getNearestGeneratedStructure). Для кандидата
// первого кольца две другие крепости кольца стоят через ±120° (generateRingPositions:
// угол += 2π/3 на кольце из трёх), радиус у каждой свой (1408..2688, ±112 к биому).
// Вес кандидата × P(обе дальше него от точки броска) — как «closest stronghold»
// у Ninjabrain Bot (Posterior). Нужен одному броску: длинный луч из-за края
// кольца пересекает кольцо дважды, и дальний кандидат иначе не отличить
// (прогон 2026-09-26: с 2990 от 0,0 лучшим вышел угол в 3983 блоках).
// Кандидат дальних колец — ближайший, только если все три крепости первого
// кольца (угол θ0 любой) дальше него: g(t) по сетке θ0 и радиусов, один раз
// на решение (от точки броска зависит, от кандидата — только через t).
function farTable (from, maxDist) {
  const lo = RINGS[0].lo - 112
  const hi = RINGS[0].hi + 112
  const A = 48
  const K = 8
  const step = 50
  const g = []
  for (let t = 0; t <= maxDist + step; t += step) {
    let sum = 0
    for (let a = 0; a < A; a++) {
      let all = 1
      for (let j = 0; j < 3; j++) {
        const th = (a + 0.5) / A * TAU + j * TAU / 3
        let far = 0
        for (let i = 0; i < K; i++) {
          const r = lo + (i + 0.5) / K * (hi - lo)
          if (Math.hypot(Math.cos(th) * r - from.x, Math.sin(th) * r - from.z) > t) far++
        }
        all *= far / K
      }
      sum += all
    }
    g.push(sum / A)
  }
  return t => g[Math.min(g.length - 1, Math.round(t / step))]
}

function nearestFactor (c, from, far) {
  const R = Math.hypot(c.x + 8, c.z + 8)
  const t = flat(c, from)
  if (ringOf(R) !== 0) return Math.max(far ? far(t) : 1, 1e-6)
  const phi = Math.atan2(c.z + 8, c.x + 8)
  const lo = RINGS[0].lo - 112
  const hi = RINGS[0].hi + 112
  const K = 12
  let f = 1
  for (const dphi of [TAU / 3, -TAU / 3]) {
    let closer = 0
    for (let i = 0; i < K; i++) {
      const r = lo + (i + 0.5) / K * (hi - lo)
      if (Math.hypot(Math.cos(phi + dphi) * r - from.x, Math.sin(phi + dphi) * r - from.z) < t) closer++
    }
    f *= 1 - closer / K
  }
  return Math.max(f, 1e-3)
}

function ringOf (R) {
  for (const g of RINGS) if (R >= g.lo - RING_BLUR && R <= g.hi + RING_BLUR) return g.ring
  return null
}

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
  const { towerUp }: typeof import('./build') = require('./build')
  const { standable }: typeof import('./walkable') = require('./walkable')
  const tools: typeof import('./tools') = require('./tools')
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
  const { inWater, escapeWater }: typeof import('./movement') = require('./movement')
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

async function throwEye (session, ctl) {
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

// ------------------------------------------------------------------ решатель

// Бросок в виде, который ест решатель (и который лежит в памяти eyeThrows).
function asRay (t) {
  if (!t) return null
  const from = t.start || t.from
  if (!from) return null
  if (t.near && t.corner) return { from, near: true, corner: t.corner }
  if (!Number.isFinite(t.bearing)) return null
  return { from, bearing: t.bearing, sigma: t.sigma || Math.max(SIGMA_MIN, POS_ERR * Math.SQRT2 / Math.max(1, t.flew || EYE_REACH)) }
}

// Углы чанков у лучей: вдоль каждого луча шагом 4 блока, по 4 угла сетки
// вокруг точки. Настоящий угол лежит на луче с точностью σ·дальность (доли
// блока), так что он всегда среди них.
function candidates (rays, { maxDist = 9000, step = 4 }: any = {}) {
  const seen = new Map()
  for (const t of rays) {
    if (t.near) continue
    const dx = Math.sin(t.bearing)
    const dz = Math.cos(t.bearing)
    for (let s = EYE_REACH - 1; s <= maxDist; s += step) {
      const qx = t.from.x + dx * s
      const qz = t.from.z + dz * s
      const x0 = Math.floor(qx / 16) * 16
      const z0 = Math.floor(qz / 16) * 16
      for (const cx of [x0, x0 + 16]) {
        for (const cz of [z0, z0 + 16]) {
          const k = `${cx},${cz}`
          if (!seen.has(k)) seen.set(k, { x: cx, z: cz })
        }
      }
    }
  }
  return [...seen.values()]
}

// Точка наименьших квадратов по лучам (веса — 1/(σ·дальность)²): сырое
// пересечение, без сетки. Сверка: угол чанка рядом с ней — всё сошлось.
function lsPoint (rays, guess) {
  const far = rays.filter(t => !t.near)
  if (far.length < 2) return null
  let c = guess
  for (let it = 0; it < 4; it++) {
    let a11 = 0; let a12 = 0; let a22 = 0; let b1 = 0; let b2 = 0
    for (const t of far) {
      const nx = Math.cos(t.bearing)
      const nz = -Math.sin(t.bearing)
      const dist = c ? Math.max(32, flat(c, t.from)) : 1000
      const w = 1 / Math.pow(t.sigma * dist, 2)
      const k = nx * t.from.x + nz * t.from.z
      a11 += w * nx * nx; a12 += w * nx * nz; a22 += w * nz * nz; b1 += w * nx * k; b2 += w * nz * k
    }
    const det = a11 * a22 - a12 * a12
    if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return null
    c = { x: (b1 * a22 - b2 * a12) / det, z: (a11 * b2 - a12 * b1) / det }
  }
  return c
}

// Решение по броскам. Ответ: best {x, z, p, dist, ring, fromOrigin, stairs},
// другие кандидаты (top), сырое пересечение ls, невязки лучшего в градусах.
function solve (throws, { maxDist = 9000, top = 5, nearest = true }: any = {}) {
  const rays = throws.map(asRay).filter(Boolean)
  if (!rays.length) return null
  const last = rays[rays.length - 1]
  const near = rays.find(t => t.near)
  const dress = (c, p) => ({
    x: c.x,
    z: c.z,
    p: +p.toFixed(4),
    dist: Math.round(flat(c, last.from)),
    fromOrigin: Math.round(Math.hypot(c.x + 8, c.z + 8)),
    ring: ringOf(Math.hypot(c.x + 8, c.z + 8)),
    stairs: { x: c.x + 4, z: c.z + 4 }
  })
  if (near) {
    return { throws: rays.length, best: dress(near.corner, 1), top: [], near: true, note: 'око ушло вниз: угол чанка старта ближе 12 блоков, он и есть ответ' }
  }
  const cands = candidates(rays, { maxDist })
  const far = nearest ? farTable(rays[0].from, maxDist + 200) : null
  let max = -Infinity
  for (const c of cands) {
    let ll = 0
    for (const t of rays) {
      const d = flat(c, t.from)
      // Око ушло вверх — угол дальше 12 блоков от точки броска.
      if (d < EYE_REACH - 0.5) { ll = -Infinity; break }
      const e = wrap(bearingOf(t.from, c) - t.bearing) / t.sigma
      ll -= 0.5 * e * e
    }
    c.lp = ll + Math.log(ringDensity(Math.hypot(c.x + 8, c.z + 8))) + (nearest ? Math.log(nearestFactor(c, rays[0].from, far)) : 0)
    if (c.lp > max) max = c.lp
  }
  if (!Number.isFinite(max)) return { throws: rays.length, best: null, top: [], note: 'ни один угол чанка не согласуется с бросками' }
  let sum = 0
  for (const c of cands) { c.w = Math.exp(c.lp - max); sum += c.w }
  for (const c of cands) c.p = c.w / sum
  cands.sort((a, b) => b.p - a.p)
  const best = cands[0]
  const out: any = {
    throws: rays.length,
    best: dress(best, best.p),
    top: cands.slice(1, top).filter(c => c.p > 0.001).map(c => dress(c, c.p)),
    residualDeg: rays.map(t => +(wrap(bearingOf(t.from, best) - t.bearing) * DEG).toFixed(4)),
    sigmaDeg: rays.map(t => +(t.sigma * DEG).toFixed(4)),
    candidates: cands.length
  }
  // Один бросок: вдоль луча — распределение дальности (для решения «идти или
  // бросать ещё», и для слепого решения — где кольцо).
  if (rays.length === 1) {
    const ds = cands.filter(c => c.p > 1e-4).map(c => ({ d: flat(c, last.from), p: c.p })).sort((a, b) => a.d - b.d)
    let acc = 0
    const q = f => { acc = 0; for (const x of ds) { acc += x.p; if (acc >= f) return Math.round(x.d) } return ds.length ? Math.round(ds[ds.length - 1].d) : null }
    out.range = { p10: q(0.1), p50: q(0.5), p90: q(0.9) }
  }
  const ls = lsPoint(rays, best)
  if (ls) {
    out.ls = { x: r1(ls.x), z: r1(ls.z), offCorner: r1(flat(ls, best)) }
  }
  return out
}

// Старое пересечение двух лучей (для совместимости и сцен).
function intersect (p1, b1, p2, b2) {
  const d1 = { x: Math.sin(b1), z: Math.cos(b1) }
  const d2 = { x: Math.sin(b2), z: Math.cos(b2) }
  const den = d1.x * d2.z - d1.z * d2.x
  if (Math.abs(den) < 1e-9) return null
  const t = ((p2.x - p1.x) * d2.z - (p2.z - p1.z) * d2.x) / den
  if (t < 0) return null
  return { x: Math.round(p1.x + d1.x * t), z: Math.round(p1.z + d1.z * t), dist: Math.round(t) }
}

// ------------------------------------------------------------------ память

function rememberThrow (session, t) {
  const ray = asRay(t)
  if (!ray) return
  session.journal.patch(s => {
    const list = Array.isArray(s.eyeThrows) ? s.eyeThrows : []
    list.push({ ms: gameClock.now(), ...ray, flew: t.flew })
    s.eyeThrows = list.slice(-8)
  })
}

// Броски из памяти моложе maxAgeMin (для mode=solve: мозг бросал сам по одному).
function storedThrows (session, { maxAgeMin = 60 }: any = {}) {
  const list = (session.journal.state && session.journal.state.eyeThrows) || []
  const since = gameClock.now() - maxAgeMin * 60000
  return list.filter(t => t && t.ms >= since)
}

function save (session, sol) {
  const c = sol.best
  const refined = c.p >= 0.95
  const rec = {
    x: c.x,
    y: 30,
    z: c.z,
    dimension: 'overworld',
    refined,
    p: c.p,
    stairs: c.stairs,
    note: refined
      ? `угол стартового чанка по оку (p=${c.p}): лестница старта x+2..x+6, z+2..z+6 — копать у ${c.stairs.x},${c.stairs.z}`
      : `по оку, неточно (p=${c.p}): у места бросить ещё одно око`
  }
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[PLACE] = { ...rec }
  })
  session.journal.append(PLACE, `по оку эндера: угол чанка ${c.x}, ${c.z} (p=${c.p}, ${c.dist} бл.)`, session.bot.entity.position)
  return rec
}

function report (session, sol, throws, extra: any = {}) {
  const c = sol.best
  const rec = save(session, sol)
  return {
    stronghold: { x: c.x, z: c.z },
    // То же под именем, которое читает директор и кампания (memo.stronghold ← detail.at).
    at: { x: c.x, y: rec.y, z: c.z },
    stairs: c.stairs,
    p: c.p,
    refined: rec.refined,
    dist: c.dist,
    distFromFirst: throws[0] && throws[0].from ? Math.round(flat(c, throws[0].from)) : undefined,
    ring: c.ring,
    fromOrigin: c.fromOrigin,
    others: sol.top && sol.top.length ? sol.top.map(o => ({ x: o.x, z: o.z, p: o.p })) : undefined,
    ls: sol.ls,
    residualDeg: sol.residualDeg,
    throws: throws.map(t => ({ from: t.from, bearingDeg: t.bearingDeg, sigmaDeg: t.sigmaDeg, flew: t.flew, near: t.near || undefined, broke: t.broke || undefined, lost: t.lost || undefined })),
    eyesLeft: throws.length ? throws[throws.length - 1].eyesLeft : countOf(session.bot, 'ender_eye'),
    note: rec.refined
      ? `Крепость: угол чанка ${c.x},${c.z} (p=${c.p}), лестница старта у ${c.stairs.x},${c.stairs.z}, ${c.dist} бл. отсюда. ` +
        `Дальше mc_stronghold mode=go (копать у лестницы) или mode=travel (через Ад, если далеко).`
      : `Крепость примерно у ${c.x},${c.z} (p=${c.p}) — не уверен: брось ещё око из другой точки (mode=throw, потом mode=solve).`,
    ...extra
  }
}

// ------------------------------------------------------------------ find

// Суша ли в колонке (x, z) около высоты y: первый непустой блок сверху вниз —
// не вода и не лава. Непрогруженная колонка — «не знаю», то есть нет.
function dryAt (bot, x, z, y) {
  for (let yy = y + 8; yy >= y - 12; yy--) {
    const b = bot.blockAt(new Vec3(x, yy, z))
    if (!b) return false
    if (b.boundingBox === 'empty' && !/water|lava|bubble/.test(b.name)) continue
    return !/water|lava|bubble|kelp|seagrass/.test(b.name)
  }
  return false
}

// Броски до уверенности: первый — отсюда; дальше шаг вбок на sideways (и
// немного вперёд) и новый бросок, пока лучший угол не наберёт want (0.95), но
// не больше maxThrows. Каждый следующий отход — к лучшему кандидату и вбок в
// другую сторону: дорога не пропадает.
async function findStronghold (session, ctl, { sideways = 24, maxThrows = 4, want = 0.95, timeoutSeconds = 240 }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + timeoutSeconds * 1000 - 3000
  const throws = []
  const walks = []
  let sol = null
  let side = 1
  let misses = 0
  while (!ctl.aborted && gameClock.now() < deadline && throws.length < maxThrows) {
    if (!itemNamed(bot, 'ender_eye')) break
    if (throws.length) {
      // Отход: вбок от направления на лучшего кандидата и вперёд к нему.
      const me = bot.entity.position
      const toward = sol && sol.best ? bearingOf(me, sol.best) : throws[throws.length - 1].bearing
      const dist = sol && sol.best ? flat(me, sol.best) : 2000
      const fwd = throws.length === 1 ? sideways / 2 : Math.min(240, Math.max(sideways, dist * 0.12))
      // Сторона и отход — туда, где суша: в воду pathfinder заходит, а
      // выплывает плохо (прогон 2026-09-26 у моря: тело встало в воде до конца
      // срока). Сначала своя сторона, потом другая, потом ближе.
      let tx = null
      let tz = null
      for (const [sd, k] of [[side, 1], [-side, 1], [side, 0.5], [-side, 0.5], [side, 0.25]]) {
        const lat = sideways * k * sd
        const x = Math.round(me.x + Math.sin(toward) * fwd * k + Math.sin(toward + Math.PI / 2) * lat)
        const z = Math.round(me.z + Math.cos(toward) * fwd * k + Math.cos(toward + Math.PI / 2) * lat)
        if (tx === null) { tx = x; tz = z }
        if (dryAt(bot, x, z, Math.floor(me.y))) { tx = x; tz = z; side = sd; break }
      }
      const w = await travelXZ(bot, ctl, tx, tz, { range: 3, retries: 1, deadline: Math.min(deadline, gameClock.now() + 60000) })
      walks.push({ to: { x: tx, z: tz }, ok: w.ok, error: w.ok ? undefined : w.error })
      if (ctl.aborted) break
      side = -side
      // Не дошёл: бросить можно и отсюда — точности хватает и 3 блоков поперёк
      // прежнего луча (замер (у): невязка 0.0006° и хуже не бывала). Меньше —
      // другая сторона; два промаха подряд — стоп, сказать словами.
      const prev = throws[throws.length - 1]
      const off = Math.abs(Math.sin(bearingOf(prev.start, bot.entity.position) - prev.bearing)) * flat(prev.start, bot.entity.position)
      if (!w.ok && off < 3) {
        if (++misses >= 2) break
        continue
      }
      misses = 0
    }
    const t = await throwEye(session, ctl)
    if (!t.thrown) {
      if (!throws.length) return { stopped: t.why, throws: [] }
      break
    }
    throws.push(t)
    rememberThrow(session, t)
    sol = solve(throws)
    console.log('[stronghold] бросок', JSON.stringify({ n: throws.length, from: t.from, deg: t.bearingDeg, flew: t.flew, near: t.near, best: sol && sol.best, ls: sol && sol.ls }))
    if (t.near || (sol && sol.best && sol.best.p >= want && throws.length >= 2)) break
  }
  const seconds = Math.round((gameClock.now() - t0) / 1000)
  if (!sol || !sol.best) {
    return { stopped: ctl.aborted ? 'прервано' : (throws.length ? 'броски не сошлись ни в одном углу чанка' : 'ни одного броска: нет ока?'), throws, walks, seconds }
  }
  if (throws.length === 1 && !sol.near) {
    const r = report(session, sol, throws, { walks, seconds, range: sol.range })
    r.stopped = 'один бросок: направление есть, дальность — только по кольцу' + (itemNamed(bot, 'ender_eye') ? '' : ' (ока больше нет)')
    r.note = `Один бросок: ${throws[0].bearingDeg}°, крепость вероятнее всего в ${sol.range.p10}..${sol.range.p90} бл. (медиана ${sol.range.p50}). ` + r.note
    return r
  }
  return report(session, sol, throws, { walks: walks.length ? walks : undefined, seconds })
}

// mode=solve: решить по броскам из памяти (мозг бросал по одному mode=throw).
function solveStored (session, { maxAgeMin = 60 }: any = {}) {
  const list = storedThrows(session, { maxAgeMin })
  if (!list.length) return { stopped: `бросков в памяти за ${maxAgeMin} мин нет — mode=throw из двух точек в 30+ блоках друг от друга` }
  const sol = solve(list)
  if (!sol || !sol.best) return { stopped: 'броски из памяти не сходятся (разные крепости? броски из разных миров?)', throws: list.length }
  return report(session, sol, list.map(t => ({ from: t.from, bearingDeg: Number.isFinite(t.bearing) ? +(t.bearing * DEG).toFixed(3) : null, sigmaDeg: t.sigma ? +(t.sigma * DEG).toFixed(4) : null, flew: t.flew, near: t.near })), { fromMemory: list.length })
}

// ------------------------------------------------------------------ слепой переход

// Без ока (оно в Аду не летит: findNearestMapStructure в Аду — null) выйти из
// Ада там, где до ближайшей крепости первого кольца ближе всего. Монте-Карло по
// генератору колец (2026-09-26, 200 000 раскладок, сдвиг к биому — равномерно в
// круге 112): ожидаемое расстояние до ближайшей крепости от точки выхода на
// радиусе d от 0,0 —
const BLIND_TABLE = [
  // [d, E, медиана, 90%, P(<500)]
  [0, 1725, 1725, 2560, 0], [1200, 1213, 1249, 1732, 0.053], [1400, 1140, 1169, 1718, 0.096],
  [1600, 1097, 1104, 1735, 0.131], [1700, 1088, 1085, 1755, 0.144], [1800, 1089, 1078, 1782, 0.154],
  [1900, 1099, 1086, 1814, 0.154], [2000, 1117, 1102, 1855, 0.149], [2200, 1179, 1165, 1948, 0.133],
  [2400, 1272, 1261, 2059, 0.105], [2600, 1392, 1382, 2185, 0.072], [2800, 1532, 1523, 2321, 0.040]
]
const BLIND_R = 1750

function blindExpect (d) {
  const T = BLIND_TABLE
  if (d <= T[1][0]) {
    const a = T[0]; const b = T[1]; const f = d / b[0]
    return Math.round(a[1] + (b[1] - a[1]) * f)
  }
  for (let i = 1; i < T.length - 1; i++) {
    if (d <= T[i + 1][0]) {
      const a = T[i]; const b = T[i + 1]; const f = (d - a[0]) / (b[0] - a[0])
      return Math.round(a[1] + (b[1] - a[1]) * f)
    }
  }
  const z = T[T.length - 1]
  return Math.round(z[1] + (d - z[0]) * 0.7)
}

// Куда идти в Аду для слепого выхода: по своему лучу от 0,0 на радиус 1750
// верхнего мира (218 в Аду). pos — где тело, world — его мир.
function blindPlan (pos, world = 'the_nether') {
  const k = world === 'the_nether' ? 8 : 1
  const ox = pos.x * k
  const oz = pos.z * k
  const r = Math.hypot(ox, oz)
  const a = r > 16 ? Math.atan2(ox, oz) : Math.PI / 2
  const over = { x: Math.round(Math.sin(a) * BLIND_R), z: Math.round(Math.cos(a) * BLIND_R) }
  const nether = { x: Math.floor(over.x / 8), z: Math.floor(over.z / 8) }
  const walkNether = Math.round(Math.hypot(pos.x * k / 8 - nether.x, pos.z * k / 8 - nether.z))
  const now = blindExpect(r)
  const then = blindExpect(BLIND_R)
  return {
    overworld: over,
    nether,
    fromOriginNow: Math.round(r),
    expectNow: now,
    expectThere: then,
    gain: now - then,
    walkNether,
    note: `Слепой выход: Ад ${nether.x},${nether.z} = верх ${over.x},${over.z} (радиус ${BLIND_R}). До ближайшей крепости ` +
      `первого кольца оттуда в среднем ~${then} бл. (15% — ближе 500), отсюда ~${now}. Идти по Аду ${walkNether} бл. ` +
      'Там построить портал (mc_portal mode=link x,z), выйти и бросать око.'
  }
}

export {
  mappedRoom, roomApproach,
  throwEye, findStronghold, solve, solveStored, intersect, candidates, lsPoint, ringDensity, ringOf,
  blindPlan, blindExpect, storedThrows, rememberThrow, asRay, RINGS, PLACE, EYE_REACH, POS_ERR
}
