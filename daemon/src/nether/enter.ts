'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz } from '../movement'
import { placeBlockAt, pickFiller } from '../build'
import { itemNamed, countOf } from '../items'
import * as worlds from '../worlds'
import { FRAME_BLOCK, IGNITERS, isFluid, PROTECTED, reader, neighbours, sameCell } from './shape'
import { findFrames, rememberPortal, igniterShortfall } from './plan'
import { sleep, walkNear, inReach, clearCells } from './dig'
import { walkToward } from './walk'
import { portal } from './frame'

// ------------------------------------------------------------ going through

// Меньше этого в портал не шагаем: по ту сторону может ждать лава, гаст или
// толпа у портала, а назад — ещё несколько секунд стояния в портале прибытия.
const MIN_ENTER_HP = 10
// Сколько стоять в портале, прежде чем сказать «перехода нет». Задержка игрока
// в выживании — правило players_nether_portal_default_delay (80 тиков = 4с),
// плюс кулдаун портала, если только что прошли обратным ходом (см. ответ
// enter: heldSeconds). 25с — с запасом на оба.
const HOLD_LIMIT_MS = 25000
// Столько ждём «устроился» от трекера мира после смены (worlds.js READY_MS).
const SETTLE_MS = 15000
const cellKey = p => `${p.x},${p.y},${p.z}`

// Все клетки одного портала: заливка по nether_portal от найденной. Ось — из
// состояния блока (axis x: плоскость X-Y, тонкий по Z; axis z — наоборот), так
// что рамы не 2x3 и порталы, поставленные сервером, понимаются так же.
function portalCells (bot, start, max = 441) {
  const seen = new Set([cellKey(start)])
  const cells = [start]
  for (let i = 0; i < cells.length && cells.length < max; i++) {
    for (const n of neighbours(cells[i])) {
      const k = cellKey(n)
      if (seen.has(k)) continue
      seen.add(k)
      const b = bot.blockAt(n)
      if (b && b.name === 'nether_portal') cells.push(n)
    }
  }
  return cells
}

function describePortal (bot, start) {
  const cells = portalCells(bot, start)
  let axis = 'x'
  try { axis = (bot.blockAt(start).getProperties().axis) || 'x' } catch {}
  const minY = Math.min(...cells.map(c => c.y))
  const bottom = cells.filter(c => c.y === minY)
  const origin = new Vec3(Math.min(...cells.map(c => c.x)), minY, Math.min(...cells.map(c => c.z)))
  return { cells, axis, bottom, origin, keys: new Set(cells.map(cellKey)) }
}

// Ближайший горящий портал в scan. Портал — свой, его видно, поэтому
// bot.findBlocks, а не честное зрение: вопрос тут «где дверь», а не «что вижу».
/** A lit portal is ours when one of its cells is within 8 bl. of the remembered standing spot of this world. */
function notForeign (door, recV) { return door.cells.some(c => c.distanceTo(recV) <= 8) }
const xyzOf = v => ({ x: v.x, y: v.y, z: v.z })

function findLitPortal (bot, mcData, scan, near = null) {
  const ids = [mcData.blocksByName.nether_portal.id]
  const at = near || bot.entity.position
  const found = bot.findBlocks({ matching: ids, maxDistance: scan, count: 64, point: near || undefined })
  if (!found.length) return null
  found.sort((a, b) => a.distanceTo(at) - b.distanceTo(at))
  return describePortal(bot, found[0])
}

// Клетка, где можно стоять у портала и из которой шаг ведёт внутрь: пол
// твёрдый, ноги и голова свободны, и ни портала, ни огня, ни лавы.
function clearStand (read, p) {
  const g = read(p.offset(0, -1, 0))
  const f = read(p)
  const h = read(p.offset(0, 1, 0))
  if (!g || !f || !h) return false
  if (g.boundingBox !== 'block' || /lava|magma_block|campfire/.test(g.name)) return false
  for (const b of [f, h]) {
    if (b.boundingBox !== 'empty' || /lava|water|fire|portal|gateway/.test(b.name)) return false
  }
  return true
}

// A missing doorstep is one placement, not a reason to abandon a lit portal.
// Only ordinary terrain may be cleared; the frame and containers stay intact.
function doorwayPlan (read, p) {
  const floor = p.offset(0, -1, 0)
  const g = read(floor)
  if (!g || /lava|water|bubble_column|magma_block|campfire|fire/.test(g.name)) return null
  const missingFloor = /^(air|cave_air|void_air)$/.test(g.name)
  if (!missingFloor && g.boundingBox !== 'block') return null
  const dig = []
  for (const c of [p, p.offset(0, 1, 0)]) {
    const b = read(c)
    if (!b || /lava|water|bubble_column|fire|portal|gateway/.test(b.name)) return null
    if (b.boundingBox === 'empty') continue
    if (b.diggable === false || PROTECTED.test(b.name) || b.name === FRAME_BLOCK || /sand$|gravel$/.test(b.name)) return null
    // Keep the plug between the body and any neighbouring liquid.
    if (neighbours(c).some(n => isFluid(read(n)))) return null
    dig.push(c)
  }
  return { pos: p, floor: missingFloor ? floor : null, dig }
}

async function prepareDoorway (session, ctl, door, deadline) {
  const bot = session.bot
  const read = reader(bot)
  const candidates = doorways(door).map(d => ({ ...d, plan: doorwayPlan(read, d.pos) }))
    .filter(d => d.plan && (d.plan.floor || d.plan.dig.length))
    .sort((a, b) => (a.plan.dig.length + !!a.plan.floor) - (b.plan.dig.length + !!b.plan.floor) ||
      a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position))
  const result: any = { placed: 0, dug: 0 }
  for (const d of candidates) {
    if (ctl.aborted || gameClock.now() > deadline) break
    const target = d.plan.floor || d.plan.dig[0]
    if (!(await inReach(session, ctl, target))) continue
    const plan = doorwayPlan(read, d.pos)
    if (!plan) continue
    if (plan.floor) {
      if (!pickFiller(bot, { steady: true })) { result.stopped = 'нет блока для пола у портала'; break }
      const put = await placeBlockAt(bot, plan.floor, { steady: true, honest: true, timeoutMs: 2000 })
      if (!put.ok) { result.stopped = put.reason; continue }
      if (!put.already) result.placed++
    }
    for (const c of plan.dig) {
      if (ctl.aborted || gameClock.now() > deadline || !doorwayPlan(read, d.pos)) break
      const r = await clearCells(session, ctl, [c])
      result.dug += r.dug
      if (r.stopped) { result.stopped = r.stopped; break }
    }
    if (clearStand(read, d.pos)) return { ...result, at: xyz(d.pos), ok: true }
  }
  return { ...result, ok: false }
}

// Пороги: по одной клетке с каждой стороны от нижнего ряда портала, поперёк
// его плоскости.
function doorways (portal) {
  const perp = portal.axis === 'x' ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0)
  const out = []
  for (const c of portal.bottom) {
    for (const side of [1, -1]) out.push({ pos: c.plus(perp.scaled(side)), cell: c, side })
  }
  return out
}

// Последний шаг — клавишами, не pathfinder'ом: портал у него в blocksToAvoid
// (worlds.js tuneMovements), и так и должно быть для всех остальных дорог.
// Идём к центру клетки и отпускаем клавишу в 0.15 от него — инерция доносит
// ещё на десятую, а портал внутри клетки тоньше её.
async function stepTo (bot, ctl, target, { ms = 3000 }: any = {}) {
  const t0 = gameClock.now()
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      const pos = bot.entity.position
      const dx = target.x - pos.x
      const dz = target.z - pos.z
      if (Math.hypot(dx, dz) < 0.15) return true
      await bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', true)
      await sleep(50)
    }
    return false
  } finally {
    try { bot.setControlState('forward', false) } catch {}
  }
}

const insidePortal = (bot, portal) => {
  const f = bot.entity.position.floored()
  return portal.keys.has(cellKey(f)) || portal.keys.has(cellKey(f.offset(0, 1, 0)))
}

function portalChanged (session, bot, from, seq) {
  // Stop using overworld coordinates as soon as the header changes, even if
  // the arrival witness is still loading or came from a new connection.
  const wc = session.worldChange
  return worlds.worldOf(bot) !== from || !!(wc && wc.seq > seq && wc.to && wc.to !== from)
}

// Что вокруг портала прибытия: лава в 4 блоках и враги, которых видно в 16.
function surroundings (bot, mcData) {
  const { HOSTILES }: typeof import('../combat') = require('../combat')
  const { canSeePoint }: typeof import('../perception') = require('../perception')
  const me = bot.entity.position
  let lava = []
  try {
    lava = bot.findBlocks({ matching: [mcData.blocksByName.lava.id], maxDistance: 4, count: 30 })
  } catch {}
  const hostiles = (Object.values(bot.entities) as any[])
    .filter((e : any) => e && e !== bot.entity && e.position && HOSTILES.has(e.name) && e.position.distanceTo(me) <= 16 &&
      canSeePoint(bot, e.position.offset(0, (e.height || 1) * 0.6, 0)))
    .map((e : any) => ({ name: e.name, dist: Math.round(e.position.distanceTo(me) * 10) / 10 }))
    .sort((a, b) => a.dist - b.dist)
  const nearestLava = lava.length ? Math.round(Math.min(...lava.map(p => p.distanceTo(me))) * 10) / 10 : null
  return { lava: lava.length, nearestLava, hostiles }
}

// Вход в портал (enter) — состояние вызова. Прежние let замыкания enter — поля объекта en (EnterRun). Фаза возвращает
// итог вызова (конец) или ничего (дальше по фазам); порядок — EN_PHASES.
interface EnterRun {
  session: any
  ctl: any
  p: any
  bot: any
  mcData: any
  read: any
  from: any
  scan: number
  deadline: number
  base: any
  key: string
  rec: any
  door: any
  lit: any
  spot: any
  seq0: number
  heldSeconds: number
  wc: any
  to: any
  departure: any
  arrival: any
  out: any
  stillInside: boolean
}

function enOpen (session, ctl, p: any = {}): EnterRun {
  const bot = session.bot
  const mcData = session.mcData
  const en = { session, ctl, p, bot, mcData } as EnterRun
  en.read = reader(bot)
  en.from = worlds.worldOf(bot)
  en.scan = Math.max(4, Math.min(32, p.scan ?? 16))
  en.deadline = gameClock.now() + Math.max(20, Math.min(600, p.timeoutSeconds ?? 90)) * 1000 - 3000
  en.base = { mode: 'enter', world: en.from }
  return en
}

// Хп и огниво: без них в портал не шагать.
function enGate (en: EnterRun) {
  const { bot, p } = en
  const hp = Math.round(bot.health ?? 0)
  // Домой из Ада без еды — лечиться здесь нечем, ожидание хп не прибавит (b3-5-2 14.10: хп 8 в 1 бл. от портала домой,
  // «в портал не шагаю» ×сотни ходов до конца кампании). Наверху — еда и свой портал; порог — только в Ад.
  const foodless = () => !(bot.inventory?.items?.() || []).some(i => /^(cooked_|bread$|baked_potato$|golden_carrot$|apple$|carrot$|melon_slice$|sweet_berries$|pumpkin_pie$|beef$|porkchop$|mutton$|chicken$|rabbit$|cod$|salmon$|potato$|beetroot$|dried_kelp$|cookie$|mushroom_stew$|beetroot_soup$|rabbit_stew$|golden_apple$|enchanted_golden_apple$)/.test(i.name))
  // ND_OW_ENTER_LOWHP=1: и в Ад из верхнего мира без еды при сытости < 18 — лечиться нечем и здесь, ожидание хп не прибавит, а ночная охота
  // с 9 хп дороже входа (прибытие сразу в укрытие). owN4-owC12-07: портал на 4-й мин, «на 9 хп в портал не шагаю» до конца прогона.
  const noHeal = process.env.ND_OW_ENTER_LOWHP === '1' && worlds.worldOf(bot) === 'overworld' && hp >= 6 && foodless() && (bot.food ?? 20) < 18
  if (hp < MIN_ENTER_HP && !noHeal && !(process.env.ND_NE_NO_GIVEUP === '1' && p.noGiveupReturn === true && en.from === 'the_nether') && !(worlds.worldOf(bot) === 'the_nether' && hp >= 4 && foodless())) {
    return {
      ...en.base,
      went: false,
      stopped: `На ${hp} хп в портал не шагаю: по ту сторону может быть лава, гаст или толпа у портала, а ` +
        `назад — снова стоять в портале. Поешь и подожди до ${MIN_ENTER_HP}+ (mc_eat, mc_wait), потом зови снова.`
    }
  }
  if (en.from === 'overworld' && !IGNITERS.some(n => itemNamed(bot, n)) && !p.noIgniter) {
    const s = igniterShortfall(bot)
    return {
      ...en.base,
      went: false,
      need: s.need,
      stopped: 'В Ад без огнива не пойду: гаст взрывом гасит портал, и без огнива дорога домой закрыта. ' + s.stopped
    }
  }
}

async function enFind (en: EnterRun) {
  const { bot, session, ctl, p, mcData } = en
  // --- 1. Портал своего мира: горящий рядом, иначе из памяти, иначе рама без огня.
  const places = (session.journal.state && session.journal.state.places) || {}
  en.key = worlds.portalKey(en.from)
  en.rec = places[en.key] && worlds.worldOfRecord(places[en.key]) === en.from ? places[en.key] : null
  // Горящий портал не наш (S1d: 7777… s1c-H-2/F-3/I-2 — чужой портал у маршрута к бастиону увёл тело в верхний мир к
  // −579,68,43, петля EnterNether): при записи своего портала в этом мире — сперва он, ближайший — только без записи.
  const recV = en.rec ? new Vec3(en.rec.x, en.rec.y, en.rec.z) : null
  const ours = d => !d || !recV || p.anyPortal || notForeign(d, recV)
  en.door = findLitPortal(bot, mcData, en.scan)
  if (!ours(en.door)) { en.base.foreignPortal = xyzOf(en.door.origin); en.door = null }
  let walked = null
  if (!en.door && en.rec) {
    const target = new Vec3(en.rec.x, en.rec.y, en.rec.z)
    if (bot.entity.position.distanceTo(target) > en.scan - 2) {
      walked = await walkToward(session, ctl, target, en.deadline)
      if (ctl.aborted) return { ...en.base, went: false, stopped: 'прервано по дороге к порталу' }
      if (!walked.ok) {
        return {
          ...en.base,
          went: false,
          walked,
          awayBlocks: Math.round(bot.entity.position.distanceTo(target)),
          stopped: `до портала из памяти («${en.key}» на ${en.rec.x},${en.rec.y},${en.rec.z}) не дошёл: ${walked.error}. ` +
            'Подойди ближе mc_goto и позови снова.'
        }
      }
    }
    en.door = findLitPortal(bot, mcData, en.scan, recV)
    if (!ours(en.door)) { en.base.foreignPortal = xyzOf(en.door.origin); en.door = null }
  }
  en.lit = null
  if (!en.door) {
    const obs = bot.findBlocks({ matching: [mcData.blocksByName[FRAME_BLOCK].id], maxDistance: en.scan, count: 64 })
    const frames = findFrames(en.read, obs)
    if (frames.some(f => !f.lit) && IGNITERS.some(n => itemNamed(bot, n))) {
      en.lit = await portal(session, ctl, { scan: en.scan, timeoutSeconds: Math.max(20, Math.round((en.deadline - gameClock.now()) / 1000)) })
      en.door = findLitPortal(bot, mcData, en.scan)
    }
  }
  if (!en.door) {
    return {
      ...en.base,
      went: false,
      lit: en.lit ? { stopped: en.lit.stopped, portalBlocks: en.lit.portalBlocks } : undefined,
      stopped: `ПЕРЕХОДА НЕТ: горящего портала в ${en.scan} блоках не вижу` +
        (en.rec ? ` (в памяти «${en.key}» на ${en.rec.x},${en.rec.y},${en.rec.z})` : `, и «${en.key}» в памяти нет`) +
        (en.from === 'overworld' ? '. Построить: mc_portal mode=build.' : '. Портал прибытия мог погаснуть от гаста — зажечь огнивом: mc_portal mode=build рядом с рамой.')
    }
  }
}

async function enThreshold (en: EnterRun) {
  const { bot, session, ctl } = en
  // --- 2. На порог.
  const me = bot.entity.position
  let spots = doorways(en.door).filter(d => clearStand(en.read, d.pos))
    .sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me))
  if (!spots.length) {
    en.base.access = await prepareDoorway(session, ctl, en.door, Math.min(en.deadline, gameClock.now() + 30000))
    spots = doorways(en.door).filter(d => clearStand(en.read, d.pos))
      .sort((a, b) => a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position))
  }
  if (!spots.length) {
    return {
      ...en.base,
      went: false,
      portal: { inner: xyz(en.door.origin), axis: en.door.axis, blocks: en.door.cells.length },
      stopped: 'К порталу не подойти: ни с одной стороны нижнего ряда нет клетки, где встать (пол, ноги и голова свободны). ' +
        (en.base.access?.stopped || 'Безопасно восстановить порог не удалось.')
    }
  }
  en.spot = null
  let climbTried = false
  for (const s of spots.slice(0, 4)) {
    if (ctl.aborted || gameClock.now() > en.deadline) break
    const approach = await walkNear(session, ctl, s.pos, 0)
    if (!approach.ok && !climbTried && s.pos.y - bot.entity.position.y > 3 && !ctl.aborted) {
      climbTried = true
      en.base.approach = await walkToward(session, ctl, s.pos, en.deadline, { range: 0 })
    }
    if (sameCell(bot.entity.position, s.pos)) { en.spot = s; break }
  }
  if (!en.spot) {
    return {
      ...en.base,
      went: false,
      awayBlocks: Math.round(bot.entity.position.distanceTo(spots[0].pos)),
      stopped: ctl.aborted ? 'прервано у портала' : 'до порога портала не дошёл ни с одной стороны — позови ещё раз или подойди mc_goto'
    }
  }
}

async function enHold (en: EnterRun) {
  const { bot, session, ctl } = en
  // --- 3. Шаг внутрь и стояние. Переход засчитывается только по смене мира.
  en.seq0 = session.worldChange ? session.worldChange.seq : 0
  const changed = () => portalChanged(session, bot, en.from, en.seq0)
  const centre = en.spot.cell.offset(0.5, 0, 0.5)
  const t0 = gameClock.now()
  let inAt = null
  let steps = 0
  while (!changed()) {
    if (ctl.aborted || gameClock.now() > en.deadline || gameClock.now() - t0 > HOLD_LIMIT_MS) break
    if (!insidePortal(bot, en.door)) {
      if (steps >= 4) break
      steps++
      await stepTo(bot, ctl, centre, { ms: 2500 })
    }
    if (inAt === null && insidePortal(bot, en.door)) inAt = gameClock.now()
    await sleep(100, ctl)
  }
  en.heldSeconds = inAt ? Math.round((gameClock.now() - inAt) / 100) / 10 : 0
  if (!changed()) {
    // Обрыв или «сервер не пустил»: из портала — назад на порог.
    if (insidePortal(bot, en.door)) await stepTo(bot, { aborted: false }, en.spot.pos.offset(0.5, 0, 0.5), { ms: 1500 })
    return {
      ...en.base,
      went: false,
      heldSeconds: en.heldSeconds,
      steps,
      out: !insidePortal(bot, en.door),
      stopped: ctl.aborted
        ? `прервано: простоял в портале ${en.heldSeconds}с, мир тот же — вышел обратно на порог`
        : `ПЕРЕХОДА НЕТ: простоял в портале ${en.heldSeconds}с, мир тот же — сервер не пускает или портал не рабочий. ` +
          'Проверь правило allow_entering_nether_using_portals и что внутри рамы 6 клеток портала (mc_observe).'
    }
  }
}

async function enArrive (en: EnterRun) {
  const { bot, session, ctl, mcData } = en
  // --- 4. Прибытие: ждём «устроился» от трекера.
  const t1 = gameClock.now()
  const arrivalReady = () => session.worldChange && session.worldChange.seq > en.seq0 &&
    session.worldChange.from === en.from && session.worldChange.to === worlds.worldOf(bot) && session.worldChange.ready
  while (!arrivalReady() && gameClock.now() - t1 < SETTLE_MS && !ctl.aborted) await sleep(100)
  en.wc = session.worldChange
  en.to = worlds.worldOf(bot)
  en.departure = { world: en.from, ...xyz(en.spot.pos) }
  // Портал прибытия — в память сразу, только чтением блоков: шаги ниже рвёт тактика (s1-post08 06.10: Shield прервал вход
  // сразу после смены мира, «портал (ад)» не записался, и LeaveNether с 10 очами стоял «ПЕРЕХОДА НЕТ» в 150 бл. от портала).
  if (en.to !== en.from) {
    try {
      const early = findLitPortal(bot, mcData, 4)
      if (early) rememberPortal(session, { ...xyz(bot.entity.position.floored()), dimension: en.to, axis: early.axis, inner: xyz(early.origin), lit: true, mine: false, leadsTo: en.departure })
    } catch {}
  }
  if (!arrivalReady()) {
    return {
      ...en.base,
      went: true,
      ready: false,
      from: en.departure,
      to: { world: en.to },
      heldSeconds: en.heldSeconds,
      stopped: `Мир сменился (${worlds.worldName(en.from)} → ${worlds.worldName(en.to)}), но тело не устроилось за ${SETTLE_MS / 1000}с: ` +
        'позиции от сервера нет или мир под ногами не прогружен. Подожди mc_wait 5 и посмотри mc_observe.'
    }
  }
  // Колонки вокруг приходят не разом: портал прибытия надо прочитать целиком.
  for (let i = 0; i < 20; i++) {
    const b = bot.blockAt(bot.entity.position.offset(0, 0.5, 0))
    if (b) break
    await sleep(100)
  }
  await sleep(250)
}

async function enExit (en: EnterRun) {
  const { bot, session, ctl, mcData } = en
  // --- 5. Из портала прибытия — на порог.
  en.arrival = null
  const feet = bot.entity.position.floored()
  for (const c of [feet, feet.offset(0, 1, 0)]) {
    const b = bot.blockAt(c)
    if (b && b.name === 'nether_portal') { en.arrival = describePortal(bot, c); break }
  }
  if (!en.arrival) en.arrival = findLitPortal(bot, mcData, 4)
  en.out = null
  if (en.arrival) {
    const here = bot.entity.position
    const exits = doorways(en.arrival).filter(d => clearStand(en.read, d.pos))
      .sort((a, b) => a.pos.distanceTo(here) - b.pos.distanceTo(here))
    for (const e of exits.slice(0, 4)) {
      await stepTo(bot, { aborted: false }, e.pos.offset(0.5, 0, 0.5), { ms: 2500 })
      if (!insidePortal(bot, en.arrival)) { en.out = bot.entity.position.floored(); break }
    }
    if (!en.out && !insidePortal(bot, en.arrival)) en.out = bot.entity.position.floored()
    // Чистого порога у портала прибытия нет (камень, обрыв без пола): расчистить ближний, как у портала ухода
    // (prepareDoorway: пол заложить, камень выкопать, у жидкости не трогать) — neF-map23-2 02.10: тело осталось в
    // портале прибытия, и штрек, и ноги к бастиону и спавнеру отказали на месте 6 раз подряд.
    if (!en.out && insidePortal(bot, en.arrival)) {
      const pd: any = await prepareDoorway(session, ctl, en.arrival, gameClock.now() + 15000).catch(e => ({ ok: false, stopped: e.message }))
      if (pd.ok && pd.at) {
        await stepTo(bot, { aborted: false }, new Vec3(pd.at.x + 0.5, pd.at.y, pd.at.z + 0.5), { ms: 2500 })
        if (!insidePortal(bot, en.arrival)) en.out = bot.entity.position.floored()
      }
    }
  } else {
    en.out = bot.entity.position.floored()
  }
  en.stillInside = en.arrival ? insidePortal(bot, en.arrival) : false
}

function enReport (en: EnterRun) {
  const { bot, session, mcData } = en
  // --- 6. Осмотр и память: пара порталов, каждый в своём мире.
  const around = surroundings(bot, mcData)
  const standAt = en.out || bot.entity.position.floored()
  const arrivalPlace = en.arrival
    ? rememberPortal(session, {
      ...xyz(standAt),
      dimension: en.to,
      axis: en.arrival.axis,
      inner: xyz(en.arrival.origin),
      lit: true,
      mine: false,
      leadsTo: en.departure
    })
    : null
  const sameAsRecord = en.rec && Math.abs(en.rec.x - en.spot.pos.x) <= 4 && Math.abs(en.rec.y - en.spot.pos.y) <= 4 && Math.abs(en.rec.z - en.spot.pos.z) <= 4
  const departurePlace = rememberPortal(session, {
    ...xyz(en.spot.pos),
    dimension: en.from,
    axis: en.door.axis,
    inner: xyz(en.door.origin),
    lit: true,
    mine: sameAsRecord ? en.rec.mine : false,
    leadsTo: { world: en.to, ...xyz(standAt) }
  })
  const ratio = worlds.scaleOf(en.from) / worlds.scaleOf(en.to)
  const predicted = { x: Math.floor(en.spot.pos.x * ratio), z: Math.floor(en.spot.pos.z * ratio) }
  const toKey = worlds.portalKey(en.to)
  const home = en.arrival ? Math.round(standAt.distanceTo(en.arrival.bottom[0])) : null

  const detail: any = {
    ...en.base,
    went: true,
    ready: true,
    from: en.departure,
    to: { world: en.to, ...xyz(bot.entity.position) },
    heldSeconds: en.heldSeconds,
    settledMs: en.wc.ms,
    out: en.out ? xyz(en.out) : null,
    inPortal: en.stillInside || undefined,
    arrivalPortal: en.arrival ? { inner: xyz(en.arrival.origin), axis: en.arrival.axis, blocks: en.arrival.cells.length } : null,
    predicted,
    place: arrivalPlace ? { key: toKey, x: arrivalPlace.x, y: arrivalPlace.y, z: arrivalPlace.z, leadsTo: arrivalPlace.leadsTo } : null,
    departure: { key: en.key, leadsTo: departurePlace.leadsTo },
    around,
    lit: en.lit ? { portalBlocks: en.lit.portalBlocks, built: en.lit.built } : undefined,
    gear: { flint_and_steel: countOf(bot, 'flint_and_steel'), obsidian: countOf(bot, FRAME_BLOCK) }
  }
  const danger = []
  if (around.nearestLava !== null && around.nearestLava <= 3) danger.push(`лава в ${around.nearestLava} бл.`)
  if (around.hostiles.length) danger.push('вижу: ' + around.hostiles.slice(0, 4).map(h => `${h.name} ${h.dist}`).join(', '))
  if (en.stillInside || !en.out) {
    detail.stopped = `Я ${worlds.inWorld(en.to)}, но из портала прибытия не вышел: вокруг нет клетки, где встать. ` +
      'Постою — и портал вернёт обратно. Выйти руками: mc_goto на 2 блока в сторону.'
  }
  detail.note = `Я ${worlds.inWorld(en.to)} на ${detail.to.x},${detail.to.y},${detail.to.z}. Простоял в портале ${en.heldSeconds}с. ` +
    (en.arrival ? `Портал домой в ${home} бл., записал как «${toKey}» (ведёт к «${en.key}»). ` : 'Портала прибытия рядом не нашёл — запиши место сам. ') +
    `Координаты ${worlds.ofWorld(en.from)} здесь не действуют — обратно тем же вызовом.` +
    (danger.length ? ` Осторожно: ${danger.join('; ')}.` : '')
  return detail
}

// Фазы перехода по порядку прежнего тела enter.
const EN_PHASES: ((en: EnterRun) => any)[] = [enGate, enFind, enThreshold, enHold, enArrive, enExit, enReport]

// Один вызов — один переход: дойти до портала своего мира, шагнуть, дождаться
// смены мира (свидетель — трекер worlds.js, а не «постоял»), выйти из портала
// прибытия, осмотреться и записать пару порталов, каждый под ключом своего мира
// и со ссылкой leadsTo на другой.
async function enter (session, ctl, p: any = {}) {
  const en = enOpen(session, ctl, p)
  for (const phase of EN_PHASES) {
    const r = await phase(en)
    if (r !== undefined) return r
  }
}

export {
  describePortal, notForeign, findLitPortal, clearStand, doorwayPlan, prepareDoorway, doorways, portalChanged,
  enter
}
