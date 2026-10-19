'use strict'
import * as gameClock from './game-clock'
// Дорога к крепости через Ад — как у спидраннеров (mc_stronghold mode=travel,
// 2026-09-26).
//
// Блок Ада — восемь блоков верхнего мира (dimension_type/the_nether.json:
// coordinate_scale 8). Поэтому к далёкой крепости не идут пешком:
//   1. куда — крепость в памяти (два ока, stronghold.js, угол чанка точно);
//      нет её, а тело в Аду (око там не летит) — слепая точка
//      stronghold.blindPlan: радиус 1750 от 0,0 по своему лучу;
//   2. далеко — через Ад: в свой портал (nether.enter), в Аду — к точке
//      (x/8, z/8) и там рама (nether.link: 10 обсидиана и огниво), шаг в неё.
//      PortalForcer (1.21.11): выходя в верхний мир, сервер ищет готовый
//      портал в 128 блоках от (8x, 8z), нет — строит свой в 16 от неё; точка
//      выхода — позиция тела в портале ×8, так что рама в 2–3 блоках от точки
//      Ада даёт выход в ~16–24 блоках от крепости;
//      обсидиана нет, а алмазная кирка есть — разобрать раму портала прибытия
//      и нести с собой (приём спидраннеров; верхний портал дома горит и дальше);
//   3. наверху — endportal.goStronghold: к лестнице старта (угол +4,+4), шахта.
// Каждый вызов смотрит, в каком мире тело и где, и продолжает с того шага.

import { goals } from 'mineflayer-pathfinder'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from './movement'
import { itemNamed, countOf, equipBestTool, missingHarvestTool } from './items'
import { collectNearbyDrops } from './actions'
import * as worlds from './worlds'
import nether = require('./nether')
import * as stronghold from './stronghold'
import endportal = require('./endportal')

const SCALE = 8
const FRAME_NEED = 10
// Грубые скорости для выбора дороги (замер 2026-09-26, try-speedrun.js):
// верх — пешком по рельефу ~3 бл/с, Ад — ~2 бл/с (обходы лавы, штреки),
// переход порталом ~20 с, рама с поджигом ~60 с, разобрать раму ~110 с.
const OVER_BPS = 3
const NETHER_BPS = 2
const ENTER_S = 20
const LINK_S = 60
const TAKE_S = 110

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
// Срок без висящего таймера: проигравший в гонке не должен потом бросать
// необработанное исключение.
function withTimeout (promise, ms, msg) {
  let timer = null
  return Promise.race([promise, new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error(msg)), ms) })])
    .finally(() => gameClock.clearTimeout(timer))
}
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const log = (what, o) => console.log('[travel]', what, JSON.stringify(o))

function placeOf (session, key) {
  const places = (session.journal.state && session.journal.state.places) || {}
  return places[key] || null
}

function igniter (bot) { return nether.IGNITERS.find(n => itemNamed(bot, n)) || null }
function diamondPick (bot) { return nether.OBSIDIAN_TOOLS.some(n => itemNamed(bot, n)) }

// Сколько секунд пешком и через Ад (оценка, чтобы выбрать дорогу).
function routeCost (bot, session, target) {
  const me = bot.entity.position
  const D = flat(me, target)
  const home = placeOf(session, worlds.portalKey('overworld'))
  const h = home && worlds.worldOfRecord(home) === 'overworld' ? flat(me, home) : Infinity
  const obs = countOf(bot, 'obsidian')
  const take = obs >= FRAME_NEED ? 0 : diamondPick(bot) ? TAKE_S : Infinity
  const walk = D / OVER_BPS
  const viaNether = h / OVER_BPS + ENTER_S + take + D / SCALE / NETHER_BPS + LINK_S + ENTER_S
  return { D: Math.round(D), toHome: Number.isFinite(h) ? Math.round(h) : null, walkS: Math.round(walk), netherS: Number.isFinite(viaNether) ? Math.round(viaNether) : null, obsidian: obs, takeFrame: take === TAKE_S }
}

// Разобрать раму портала рядом (алмазной киркой) — обсидиан с собой. Клетки
// рамы — обсидиан вплотную к клеткам портала в его плоскости (и углы, и
// площадка под ним, если сервер строил её в воздухе: PortalForcer.createPortal).
async function takeFrame (session, ctl, { need = FRAME_NEED, deadline }: any) {
  const bot = session.bot
  const mcData = session.mcData
  const out: any = { took: 0, tried: 0, errors: [] }
  const door = nether.findLitPortal(bot, mcData, 10)
  const obsId = mcData.blocksByName.obsidian.id
  let cells = []
  if (door) {
    const keys = door.keys
    const along = door.axis === 'z' ? [0, 1] : [1, 0]
    const seen = new Set()
    for (const c of door.cells) {
      for (let du = -1; du <= 1; du++) {
        for (let dy = -1; dy <= 1; dy++) {
          const n = c.offset(along[0] * du, dy, along[1] * du)
          const k = `${n.x},${n.y},${n.z}`
          if (keys.has(k) || seen.has(k)) continue
          seen.add(k)
          const b = bot.blockAt(n)
          if (b && b.type === obsId) cells.push(n)
        }
      }
    }
  } else {
    // Рама без огня (гаст погасил) — любой обсидиан в 5 блоках.
    cells = bot.findBlocks({ matching: [obsId], maxDistance: 5, count: 24 })
  }
  if (!cells.length) return { ...out, why: 'рамы рядом не вижу' }
  const start0 = countOf(bot, 'obsidian')
  const feet = () => bot.entity.position.floored()
  for (let guard = 0; guard < 24 && countOf(bot, 'obsidian') < need && !ctl.aborted && gameClock.now() < deadline; guard++) {
    const me = bot.entity.position
    const eye = me.offset(0, 1.62, 0)
    // Не копать то, на чём стоим, и то, что держит нас над лавой.
    const left = cells.filter(c => {
      const b = bot.blockAt(c)
      if (!b || b.type !== obsId) return false
      const f = feet()
      return !(c.x === f.x && c.z === f.z && c.y === f.y - 1)
    })
    if (!left.length) break
    left.sort((a, b) => eye.distanceTo(a.offset(0.5, 0.5, 0.5)) - eye.distanceTo(b.offset(0.5, 0.5, 0.5)))
    const c = left[0]
    if (eye.distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.3) {
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(c.x, c.y, c.z, 2)), 12000, 'не подошёл за 12 с')
      } catch (e) {
        try { bot.pathfinder.setGoal(null) } catch {}
        out.errors.push(e.message)
        cells = cells.filter(x => !x.equals(c))
        continue
      }
    }
    const b = bot.blockAt(c)
    const problem = missingHarvestTool(bot, b, mcData)
    if (problem) { out.why = problem; break }
    out.tried++
    try {
      await equipBestTool(bot, b)
      // mineflayer считает обсидиану 75 с (minecraft-data без алмаза в
      // материалах, nether.js OBSIDIAN_SECONDS), сервер ломает за 9.4 с.
      await withTimeout(bot.dig(b, true), 20000, 'копал дольше 20 с')
    } catch (e) {
      out.errors.push(e.message)
      try { bot.stopDigging() } catch {}
    }
    await sleep(250)
  }
  await collectNearbyDrops(bot, ctl, { radius: 7, timeoutMs: 5000 })
  out.took = countOf(bot, 'obsidian') - start0
  out.obsidian = countOf(bot, 'obsidian')
  if (out.errors.length > 4) out.errors = out.errors.slice(-4)
  return out
}

// Порог у рамы, чтобы шагнуть внутрь. nether.portal строит раму там, где есть
// где встать самому, а порог перед нижним рядом может висеть над пропастью
// (прогон 2026-09-26, Ад у -242,-10: рама на краю обрыва, enter — «к порталу не
// подойти»). Пол под порогом с ближней стороны и по клетке по краям — выступ
// перед всей рамой.
async function ensureDoorway (session, ctl) {
  const bot = session.bot
  const { placeBlockAt }: typeof import('./build') = require('./build')
  const read = nether.reader(bot)
  const door = nether.findLitPortal(bot, session.mcData, 8)
  if (!door) return { ok: false, why: 'горящего портала рядом нет' }
  const ways = nether.doorways(door)
  if (ways.some(d => nether.clearStand(read, d.pos))) return { ok: true, already: true }
  const me = bot.entity.position
  const u = door.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 }
  const placed = []
  for (const side of [...new Set(ways.slice().sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me)).map(d => d.side))]) {
    const row = ways.filter(d => d.side === side).map(d => d.pos)
    const ends = [row[0].offset(-u.x, 0, -u.z), row[row.length - 1].offset(u.x, 0, u.z)]
    for (const pos of [...row, ...ends]) {
      if (ctl.aborted) break
      const floor = pos.offset(0, -1, 0)
      const b = bot.blockAt(floor)
      if (b && b.boundingBox === 'block') continue
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(floor.offset(0.5, 0.5, 0.5)) > 4.4) {
        try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(floor.x, floor.y + 1, floor.z, 2)), 10000, 'не подошёл') } catch { try { bot.pathfinder.setGoal(null) } catch {} }
      }
      const r = await placeBlockAt(bot, floor, {})
      placed.push({ at: xyz(floor), ok: !!r.ok, why: r.ok ? undefined : r.reason })
    }
    if (ways.some(d => nether.clearStand(read, d.pos))) break
  }
  return { ok: ways.some(d => nether.clearStand(read, d.pos)), placed }
}

// Камера под раму выхода (S5d 07.10). У точки Ада тело обычно в штреке 1×2 в толще: s5d-p1-1 — «Не расчистил место под
// раму: netherrack не виден в прицеле» ×2 (клетки рамы за стенкой штрека, а копать вне списка рамы стройка не берётся),
// s1d-M-5 — «лава в 2 бл.». Камера 2 вглубь × 4 вширь × 3 ввысь перед телом — по одной из 4 сторон с твёрдым полом и без
// лавы/воды в 2 бл. от будущей рамы (и ряд, где стоит тело: потолок штрека не заслоняет верх рамы); копка фронтом (только
// видимые клетки, шаги по камере), клетки рамы — тоже здесь; потом обычная стройка.
const CH_DEPTH = 2
const CH_B0 = -1
const CH_B1 = 2
const CH_HIGH = 3
const CH_KEEP = /^(bedrock|obsidian|crying_obsidian|spawner|ancient_debris|chest|trapped_chest|barrel|gold_block|gilded_blackstone|nether_portal|respawn_anchor)$/
const FLUID = /^(lava|water|flowing_lava|flowing_water|bubble_column)$/
const FALLING = /^(gravel|sand|red_sand|suspicious_gravel|suspicious_sand|[a-z_]*concrete_powder)$/
function chamberPlan (read, feet) {
  const opts = []
  const why = []
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const at = (a, b, h) => feet.offset(dx * a - dz * b, h, dz * a + dx * b)
    const cells = []
    let bad = null
    for (let a = 0; a <= CH_DEPTH && !bad; a++) {
      for (let b = CH_B0; b <= CH_B1 && !bad; b++) {
        const fl = read(at(a, b, -1))
        if (!fl) { bad = 'не прогружено'; break }
        if (fl.boundingBox !== 'block' || /magma/.test(fl.name)) { bad = 'нет пола'; break }
        for (let h = 0; h < CH_HIGH; h++) {
          const c = at(a, b, h)
          const k = read(c)
          if (!k) { bad = 'не прогружено'; break }
          if (FLUID.test(k.name)) { bad = k.name; break }
          if (k.boundingBox !== 'block') continue
          if (CH_KEEP.test(k.name)) { bad = k.name; break }
          cells.push(c)
        }
      }
    }
    // Гравий/песок в камере и над ней — сыплется в раму и на голову (s5d-H-2 07.10: точка Ада на y 24, «gravel не виден»,
    // тело завалило, клетка рамы под ногами «blockUpdate did not fire» ×8).
    for (let a = 0; a <= CH_DEPTH && !bad; a++) for (let b = CH_B0; b <= CH_B1 && !bad; b++) for (let h = 0; h <= CH_HIGH + 2; h++) {
      const k = read(at(a, b, h))
      if (k && FALLING.test(k.name)) { bad = k.name; break }
    }
    // Рама займёт ряды h −1 и 3 и стороны b −1/2: лава и вода — не ближе 2 от любой её клетки (nether.judge LAVA_KEEP 2).
    for (let a = -1; a <= CH_DEPTH + 2 && !bad; a++) {
      for (let b = CH_B0 - 2; b <= CH_B1 + 2 && !bad; b++) {
        for (let h = -3; h <= CH_HIGH + 2; h++) {
          const k = read(at(a, b, h))
          if (k && FLUID.test(k.name)) { bad = `${k.name} рядом`; break }
        }
      }
    }
    if (bad) { why.push(bad); continue }
    opts.push({ dir: { x: dx, z: dz }, cells, dig: cells.length })
  }
  opts.sort((p, q) => p.dig - q.dig)
  return opts.length ? { ok: true, feet, ...opts[0] } : { ok: false, why: [...new Set(why)].join(', ') }
}

// Копка фронтом: только видимые клетки списка в досягаемости; не видно ничего — шаг на клетку стояния (stands), ближе к остатку.
async function digVisible (session, ctl, cells, stands, until) {
  const bot = session.bot
  const { seesBlock }: typeof import('./sight') = require('./sight')
  const solid = () => cells.filter(c => { const b = bot.blockAt(c); return b && b.boundingBox === 'block' })
  let dug = 0
  let moves = 0
  while (!ctl.aborted && gameClock.now() < until) {
    const left = solid()
    if (!left.length) return { ok: true, dug }
    if (left.some(c => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => FLUID.test(bot.blockAt(c.offset(x, y, z))?.name || '')))) {
      return { ok: false, dug, why: 'за стенкой жидкость' }
    }
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const vis = left.map(c => ({ c, b: bot.blockAt(c), d: eye.distanceTo(c.offset(0.5, 0.5, 0.5)) }))
      .filter(x => x.d <= 4.4 && seesBlock(bot, x.b)).sort((p, q) => p.d - q.d)
    if (!vis.length) {
      if (++moves > 8) return { ok: false, dug, why: 'клетки не видны' }
      const here = bot.entity.position.floored()
      const read = nether.reader(bot)
      const spots = stands.filter(c => !c.equals(here) && nether.clearStand(read, c))
        .sort((p, q) => p.distanceTo(left[0]) - q.distanceTo(left[0]))
      if (!spots.length) return { ok: false, dug, why: 'клетки не видны, встать некуда' }
      const s = spots[(moves - 1) % spots.length]
      try { await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(s.x, s.y, s.z)), 8000, 'не шагнул') } catch { try { bot.pathfinder.setGoal(null) } catch {} }
      continue
    }
    const { b } = vis[0]
    try {
      await equipBestTool(bot, b)
      await withTimeout(bot.dig(b), 8000, `${b.name} не ломается`)
      dug++
    } catch (e) { return { ok: false, dug, why: `${b.name}: ${e.message}` } }
    await sleep(100)
  }
  return { ok: !solid().length, dug, why: 'время' }
}

// Клетки стояния у рамы: свободные (пол, ноги и голова) в 3 бл. от её клеток — откуда копать то, что из одной точки не видно.
function standsNear (read, cells, feet) {
  const out = [feet]
  const seen = new Set([feet.toString()])
  for (const c of cells) {
    for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 1; dy++) for (let dz = -3; dz <= 3; dz++) {
      const p = c.offset(dx, dy, dz)
      const k = p.toString()
      if (seen.has(k)) continue
      seen.add(k)
      if (nether.clearStand(read, p)) out.push(p)
    }
  }
  return out.slice(0, 80)
}

// Клетки, которые стройка будет копать сама (ряды рамы, отверстие), — здесь, фронтом и с шагами вокруг: у clearCells стояние
// одно, и потолок штрека/стенка заслоняют часть рамы (s5d-p2/p3: «netherrack не виден в прицеле»). Повтор плана после копки.
async function preDig (session, ctl, feet, until, extraStands = []) {
  const bot = session.bot
  let dug = 0
  let site = null
  for (let k = 0; k < 3 && !ctl.aborted; k++) {
    site = nether.planPortal(nether.reader(bot), feet)
    if (!site.ok) return { ok: false, dug, why: `места нет: ${site.reasons}` }
    // Гравий над рамой — не здесь (сыплется в отверстие и на голову, s5d-H-2): к камере в другом месте.
    if ([...site.plan.inner, ...site.plan.frame].some(c => [1, 2, 3].some(dy => FALLING.test(bot.blockAt(c.offset(0, dy, 0))?.name || '')))) return { ok: false, dug, why: 'гравий/песок над рамой' }
    const todo = [...site.plan.dig, ...site.plan.inner]
    if (!todo.some(c => bot.blockAt(c)?.boundingBox === 'block')) break
    const stands = [...standsNear(nether.reader(bot), [...site.plan.frame, site.plan.stand], feet), ...extraStands]
    const d = await digVisible(session, ctl, todo, stands, until)
    dug += d.dug
    if (!d.ok) return { ok: false, dug, why: `клетки рамы: ${d.why}` }
  }
  // Встать ровно на клетку стояния плана: стройка ходит к ней с допуском 1, а после докопки клетки рамы проходимы — тело
  // вставало в раму («Не встали: …: это моя же клетка», s5d-N-1). С неё же стройка выберет ту же площадку.
  const st = site && site.ok ? site.plan.stand : feet
  if (!bot.entity.position.floored().equals(st)) {
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(st.x, st.y, st.z)), 8000, 'не встал') } catch { try { bot.pathfinder.setGoal(null) } catch {} }
  }
  return { ok: !!(site && site.ok), dug }
}

// Ближняя клетка, где камера ставится (s5d-p3-1: у точки выхода «нет пола, lava рядом» — тело на краю лавового озера).
function chamberSpot (read, from, N, { radius = 6, max = 48 }: any = {}) {
  const cand = []
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -3; dy <= 3; dy++) {
    const p = from.offset(dx, dy, dz)
    if (Math.hypot(p.x - N.x, p.z - N.z) > 11) continue
    if (nether.clearStand(read, p)) cand.push(p)
  }
  cand.sort((a, b) => a.distanceTo(from) - b.distanceTo(from))
  let best = null
  for (const p of cand.slice(0, max)) {
    const pl = chamberPlan(read, p)
    if (!pl.ok) continue
    const score = pl.dig + 2 * p.distanceTo(from)
    if (!best || score < best.score) best = { ...pl, at: p, score }
  }
  return best
}

// Подготовка места под раму выхода, по нарастающей: (1) докопать клетки рамы с шагами вокруг; (2) камера здесь;
// (3) камера на ближней годной клетке (в 11 бл. от точки Ада). После — обычная стройка (ND_EXIT_CHAMBER=0 — выкл.).
async function exitChamber (session, ctl, { deadline, N }: any) {
  const bot = session.bot
  const until = Math.min(deadline, gameClock.now() + 90000)
  let feet = bot.entity.position.floored()
  const first = await preDig(session, ctl, feet, until)
  if (first.ok) return { ok: true, how: 'клетки рамы', dug: first.dug }
  let plan = chamberPlan(nether.reader(bot), feet)
  let how = 'камера здесь'
  if (!plan.ok && N) {
    const spot = chamberSpot(nether.reader(bot), feet, N)
    if (!spot) return { ok: false, dug: first.dug, why: `${first.why}; камеру не поставить ни здесь (${plan.why}), ни рядом` }
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(spot.at.x, spot.at.y, spot.at.z)), 15000, 'не дошёл') } catch { try { bot.pathfinder.setGoal(null) } catch {} }
    if (!bot.entity.position.floored().equals(spot.at)) return { ok: false, dug: first.dug, why: `до места камеры ${spot.at} не дошёл` }
    how = `камера в ${Math.round(spot.at.distanceTo(feet))} бл.`
    feet = spot.at
    plan = spot
  }
  if (!plan.ok) return { ok: false, dug: first.dug, why: `${first.why}; камеру не поставить: ${plan.why}` }
  const stands = [feet, ...plan.cells.filter(c => c.y === feet.y)]
  const ch = await digVisible(session, ctl, plan.cells, stands, until)
  if (!ch.ok) return { ok: false, dug: first.dug + ch.dug, dir: plan.dir, why: `камера: ${ch.why}` }
  const pd = await preDig(session, ctl, feet, until, stands)
  return { ok: pd.ok, how, dug: first.dug + ch.dug + pd.dug, dir: plan.dir, at: xyz(feet), why: pd.ok ? undefined : pd.why }
}
// Порог у новой рамы выхода — ноги и голова свободны хотя бы с одной стороны: рама в толще стоит вплотную к стенке камеры,
// а prepareDoorway в enter копает из одной точки («К порталу не подойти … netherrack не виден в прицеле», s5d-G-1 07.10).
// Копка фронтом с шагами вокруг (digVisible), только клетки порога из doorwayPlan (жидкость рядом, сундук, рама — нет).
async function openDoorway (session, ctl, deadline) {
  const bot = session.bot
  const read = nether.reader(bot)
  const door = nether.findLitPortal(bot, session.mcData, 8)
  if (!door) return { ok: false, why: 'горящего портала рядом нет' }
  const ways = nether.doorways(door)
  if (ways.some(d => nether.clearStand(read, d.pos))) return { ok: true, already: true }
  const plans = ways.map(d => ({ d, plan: nether.doorwayPlan(read, d.pos) })).filter(x => x.plan && !x.plan.floor)
    .sort((x, y) => x.plan.dig.length - y.plan.dig.length || x.d.pos.distanceTo(bot.entity.position) - y.d.pos.distanceTo(bot.entity.position))
  const until = Math.min(deadline, gameClock.now() + 30000)
  let dug = 0
  for (const { d, plan } of plans) {
    if (ctl.aborted || gameClock.now() > until) break
    const r = await digVisible(session, ctl, plan.dig, standsNear(read, [d.pos], bot.entity.position.floored()), until)
    dug += r.dug
    if (nether.clearStand(nether.reader(bot), d.pos)) return { ok: true, dug, at: xyz(d.pos) }
  }
  return { ok: false, dug, why: plans.length ? 'порог не открылся' : 'годного порога нет' }
}
const siteProblem = r => /Места под раму нет|Не расчистил место под раму/.test(String((r && (r.stopped || r.reason)) || ''))

async function travel (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 300, 30, 600) * 1000 - 4000
  const left = () => Math.max(20, Math.round((deadline - gameClock.now()) / 1000))
  const legs = []
  let target = null
  const done = (extra: any = {}) => {
    const me = bot.entity.position
    const out = {
      world: worlds.worldOf(bot),
      at: xyz(me),
      target: target ? { x: target.x, z: target.z, from: target.from } : null,
      away: target && worlds.worldOf(bot) === 'overworld' ? Math.round(flat(me, target)) : undefined,
      legs,
      seconds: Math.round((gameClock.now() - t0) / 1000),
      ...extra
    }
    return out
  }
  // Рамы не ломать дорогой: с алмазной киркой pathfinder копает и обсидиан, а
  // порог у рамы на обрыве — самый дешёвый путь сквозь её столб (прогон
  // 2026-09-26: столб рамы выкопан, портал погас, enter — «портала не вижу»).
  // Разбирает раму только takeFrame, своим bot.dig.
  const noFrames = () => {
    const mv = bot.pathfinder && bot.pathfinder.movements
    if (!mv || !mv.blocksCantBreak) return
    for (const n of ['obsidian', 'crying_obsidian']) {
      const b = mcData.blocksByName[n]
      if (b && !mv.blocksCantBreak.has(b.id)) { mv.blocksCantBreak.add(b.id); guarded.push([mv, b.id]) }
    }
  }
  const guarded = []
  const step = async (what, fn) => {
    const s0 = gameClock.now()
    let r
    noFrames()
    try { r = await fn() } catch (e) { r = { stopped: e.message } }
    const rec = { what, s: Math.round((gameClock.now() - s0) / 1000) }
    for (const k of ['went', 'built', 'lit', 'took', 'tried', 'errors', 'obsidian', 'stopped', 'why', 'offBlocks', 'p', 'dist', 'how', 'dug', 'at']) if (r && r[k] !== undefined) rec[k] = r[k]
    legs.push(rec)
    log(what, rec)
    return r || {}
  }

  if (worlds.worldOf(bot) === 'the_end') return { stopped: 'я в Краю — к крепости отсюда только через дракона и выходной портал' }
  try {
    return await travelSteps()
  } finally {
    for (const [mv, id] of guarded) mv.blocksCantBreak.delete(id)
  }

  async function travelSteps () {
  // --- 1. Куда
  if (Number.isFinite(p.x) && Number.isFinite(p.z)) target = { x: Math.round(p.x), z: Math.round(p.z), from: 'задано' }
  if (!target) {
    const rec = placeOf(session, stronghold.PLACE)
    if (rec && Number.isFinite(rec.x)) target = { x: rec.x + (rec.refined ? 4 : 0), z: rec.z + (rec.refined ? 4 : 0), from: rec.refined ? 'крепость (лестница старта)' : 'крепость (примерно)', stronghold: true }
  }
  if (!target && worlds.worldOf(bot) === 'overworld') {
    if (!itemNamed(bot, 'ender_eye')) return done({ stopped: 'крепость неизвестна, а ока нет: сначала око (жемчуг + огненный порошок)' })
    const f = await step('find', () => stronghold.findStronghold(session, ctl, { timeoutSeconds: Math.min(240, left()) }))
    if (!f.at) return done({ stopped: `крепость не нашёл: ${f.stopped || 'броски не сошлись'}`, find: f })
    target = { x: f.at.x + (f.refined ? 4 : 0), z: f.at.z + (f.refined ? 4 : 0), from: 'око', stronghold: true }
  }
  if (!target) {
    const b = stronghold.blindPlan(bot.entity.position, worlds.worldOf(bot))
    target = { x: b.overworld.x, z: b.overworld.z, from: 'слепая точка', blind: b }
  }

  // --- 2. Шаги по мирам
  for (let i = 0; i < 8 && !ctl.aborted && gameClock.now() < deadline; i++) {
    const world = worlds.worldOf(bot)
    if (world === 'overworld') {
      const cost = routeCost(bot, session, target)
      // Пришли (или слепая точка достигнута): крепость — вниз к лестнице;
      // слепая — бросать око, и дальше тем же циклом (портал уже рядом).
      const arriveR = target.stronghold ? 64 : 96
      if (cost.D <= arriveR) {
        if (target.blind) {
          if (!itemNamed(bot, 'ender_eye')) return done({ arrived: true, stopped: 'слепая точка: ока нет — бросать нечем' })
          const f = await step('find', () => stronghold.findStronghold(session, ctl, { timeoutSeconds: Math.min(240, left()) }))
          if (!f.at) return done({ arrived: true, stopped: `на слепой точке: ${f.stopped || 'броски не сошлись'}`, find: f })
          target = { x: f.at.x + (f.refined ? 4 : 0), z: f.at.z + (f.refined ? 4 : 0), from: 'око', stronghold: true }
          continue
        }
        // Своя цель (x,z) — не крепость: пришли, и всё.
        if (p.go === false || !target.stronghold) return done({ arrived: true })
        const g = await step('go', () => endportal.goStronghold(session, ctl, { timeoutSeconds: left() }))
        return done({ arrived: true, go: g, stopped: g.went ? undefined : g.stopped })
      }
      const netherOk = cost.netherS !== null && !!igniter(bot) && p.route !== 'walk'
      const pick = p.route === 'nether' ? 'nether' : (netherOk && cost.netherS < cost.walkS * 0.8 ? 'nether' : 'walk')
      legs.push({ what: 'route', pick, ...cost })
      if (pick === 'walk' || !netherOk) {
        const why = !netherOk && p.route === 'nether'
          ? (cost.netherS === null ? (cost.toHome === null ? 'портала домой в памяти нет' : `обсидиана ${cost.obsidian}/10 и нет алмазной кирки разобрать раму`) : 'нечем поджечь раму (огниво или огненный заряд)')
          : null
        if (why) return done({ stopped: `через Ад не выйдет: ${why}`, need: cost.obsidian < FRAME_NEED ? { what: 'obsidian', count: FRAME_NEED, have: cost.obsidian } : undefined })
        if (target.stronghold && p.go !== false) {
          const g = await step('go', () => endportal.goStronghold(session, ctl, { timeoutSeconds: left() }))
          return done({ route: 'walk', go: g, stopped: g.went ? undefined : g.stopped })
        }
        const w = await step('walk', async () => {
          const { travelXZ }: typeof import('./movement') = require('./movement')
          return travelXZ(bot, ctl, target.x, target.z, { range: 8, retries: 3, deadline })
        })
        if (!w.ok) return done({ route: 'walk', stopped: `пешком не дошёл: ${w.error}` })
        continue
      }
      const e = await step('enter', () => nether.enter(session, ctl, { timeoutSeconds: Math.min(180, left()) }))
      if (!e.went) return done({ route: 'nether', stopped: `в Ад не прошёл: ${e.stopped}` })
      continue
    }
    if (world === 'the_nether') {
      const N = { x: Math.floor(target.x / SCALE), z: Math.floor(target.z / SCALE) }
      const lit = nether.findLitPortal(bot, mcData, 16)
      const atN = lit && flat(lit.bottom[0], N) <= 12
      // Уже у точки (рама недостроена прошлым вызовом или ещё не начата) —
      // обычная стройка: она достраивает свою площадку и берёт из рюкзака
      // только недостающие блоки (link требует все 10 в рюкзаке).
      const nearN = flat(bot.entity.position, N) <= 12
      // Нет места под раму (толща, штрек, лава в 2 бл.) — камера перед телом и та же стройка ещё раз (ND_EXIT_CHAMBER=0 — выкл.).
      const buildHere = async () => {
        let B = await step('build', () => nether.portal(session, ctl, { mode: 'build', timeoutSeconds: Math.min(180, left()) }))
        if (!B.lit && !B.portalBlocks && siteProblem(B) && process.env.ND_EXIT_CHAMBER !== '0') {
          const ch = await step('chamber', () => exitChamber(session, ctl, { deadline, N }))
          if (ch.ok) B = await step('build', () => nether.portal(session, ctl, { mode: 'build', timeoutSeconds: Math.min(180, left()) }))
        }
        // Рама неполная (блок не встал: тело в клетке рамы, нет опоры с этой стороны) — встать на свободную клетку стояния этой
        // же рамы и достроить; иначе повтор выбирал новую площадку под 10 при 5 в рюкзаке (s5d-H-7 07.10: «9 из 10» → «обсидиана 5/10»).
        for (let k = 0; k < 2 && !B.lit && !B.portalBlocks && /рама неполная/.test(String(B.stopped || '')) && B.site && process.env.ND_EXIT_CHAMBER !== '0'; k++) {
          const o = new Vec3(B.site.x, B.site.y, B.site.z)
          const ax = B.site.axis
          const env = [...nether.innerCells(o, ax), ...nether.frameCells(o, ax), ...nether.cornerCells(o, ax)]
          const read = nether.reader(bot)
          const here = bot.entity.position.floored()
          const spot = nether.standSpots(o, ax, env).map(s => s.pos).filter(p => !p.equals(here) && nether.clearStand(read, p))
            .sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[k]
          if (!spot) break
          try { await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(spot.x, spot.y, spot.z)), 8000, 'не встал') } catch { try { bot.pathfinder.setGoal(null) } catch {} }
          B = await step('build', () => nether.portal(session, ctl, { mode: 'build', timeoutSeconds: Math.min(180, left()) }))
        }
        return B
      }
      if (!atN && nearN && igniter(bot)) {
        const B = await buildHere()
        if (!B.lit && !B.portalBlocks) return done({ stopped: `рама у точки Ада ${N.x},${N.z} не готова: ${B.stopped || B.reason || 'не зажглась'}`, build: B })
      } else if (!atN) {
        if (countOf(bot, 'obsidian') < FRAME_NEED) {
          if (!diamondPick(bot)) return done({ stopped: `обсидиана ${countOf(bot, 'obsidian')}/10, алмазной кирки разобрать раму нет`, need: { what: 'obsidian', count: FRAME_NEED, have: countOf(bot, 'obsidian') } })
          const tf = await step('takeFrame', () => takeFrame(session, ctl, { deadline }))
          if (countOf(bot, 'obsidian') < FRAME_NEED) return done({ stopped: `раму разобрал не всю: обсидиана ${countOf(bot, 'obsidian')}/10${tf.why ? ` (${tf.why})` : ''}`, takeFrame: tf })
        }
        if (!igniter(bot)) return done({ stopped: 'поджечь новую раму нечем: огниво (железо + кремень) или огненный заряд', need: { what: 'flint_and_steel', count: 1, have: 0 } })
        let L = await step('link', () => nether.portal(session, ctl, { mode: 'link', x: target.x, z: target.z, timeoutSeconds: left() }))
        if (!L.lit && !L.portalBlocks && siteProblem(L) && flat(bot.entity.position, N) <= 12) L = await buildHere()
        if (!L.lit && !L.portalBlocks) return done({ stopped: `рамы у точки Ада ${N.x},${N.z} нет: ${L.stopped || L.reason || 'не зажглась'}`, link: L })
      }
      if (process.env.ND_EXIT_CHAMBER !== '0') { const od = await openDoorway(session, ctl, deadline); if (!od.already) legs.push({ what: 'doorwayDig', ok: od.ok, dug: od.dug, why: od.why }) }
      const dw = await ensureDoorway(session, ctl)
      if (!dw.already) legs.push({ what: 'doorway', ok: dw.ok, placed: dw.placed, why: dw.why })
      const e = await step('enter', () => nether.enter(session, ctl, { timeoutSeconds: Math.min(120, left()) }))
      if (!e.went) return done({ stopped: `из Ада не вышел: ${e.stopped}` })
      continue
    }
    break
  }
  const out = done({ stopped: ctl.aborted ? 'прервано' : 'время вышло — позови ещё раз, продолжу с этого места' })
  return out
  }
}

export { travel, takeFrame, routeCost, ensureDoorway, chamberPlan, chamberSpot, exitChamber, openDoorway }
