'use strict'
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { xyz } from '../movement'
import * as pack from '../pack'
import { sleep, dimOf, flat, v3, keyOf, withTimeout } from './common'
import { CONTAINER_NAMES, KINDS, STRUCTURE_PLACES } from './kinds'
import { lootedSet, markLooted } from './memory'
import { decide, merge, bagCounts, bagGain, withGain } from './worth'
import { playerMarks, armTraps, walk, canReach, digAt, piglinsWatching, containersNear } from './site'
import { air, headWet, breathe, underwater, swimming, swimTo, withAir } from './water'
import { digToSee, diveToChest } from './dig'

// Открыть сундук, взять ценное по decide(), хлам оставить. Отчёт с «зачем».
// Под водой — до трёх нырков: воздуха меньше 7 из 20 — всплыть, отдышаться.
async function takeWorth (session, ctl, pos, opts: any = {}) {
  const r = await withAir(session, ctl, sub => takeOnce(session, sub, pos, opts))
  if (!r) throw new Error('прервано')
  return r
}

async function takeOnce (session, ctl, pos, { kind = null, visibleOnly = false, stay = false, deadline: callerDeadline = Infinity }: any = {}) {
  const bot = session.bot
  const containers: typeof import('../containers') = require('../containers')
  const at = xyz(v3(pos))
  if (kind === 'bastion') {
    const eyes = piglinsWatching(bot)
    if (eyes.length) return { at, stopped: `${eyes.length} пиглин(ов) видят — откроешь, озлобятся все в ±16 блоках (золотая броня не спасёт)`, took: {} }
  }
  // Место заранее: при открытом окне выкинуть нельзя.
  if (bot.inventory.emptySlotCount() < 3) {
    try { await pack.makeRoom(bot, { slots: 3, forItem: 'iron_ingot' }) } catch {}
  }
  const deadline = Math.min(gameClock.now() + 25000, callerDeadline)
  if (ctl.aborted || gameClock.now() >= deadline) return { at, took: {}, stopped: 'время добычи вышло или прервано' }
  armTraps(session)
  // В воде — подплыть, если сундук не в прицеле на досягаемости (ферма 14.10, корабль −220,−952: видно в дыру палубы с 3.7 бл.,
  // а заплыв «до 3.4» упирался в край дыры, пока не кончился воздух).
  const aimable = () => !!(require('../pick') as typeof import('../pick')).blockAim(bot, v3(at), { range: 4.4, seeThrough: null })
  if (!stay && (underwater(bot, at) || swimming(bot)) && !aimable()) await swimTo(session, ctl, at, { reach: 3.4, ms: Math.max(0, deadline - gameClock.now()) })
  // Сундук не открывается под блоком-проводником (ChestBlock.isChestBlockedAt → isRedstoneConductor: полный куб, не
  // стекло и не листва; плита, ступень, люк, забор и вода над сундуком не мешают): в трюме корабля над ним палуба —
  // сломать её, как сделал бы человек; не видна — сперва до вида.
  // Крышка — какой её видно (ревью Codex q2: тип скрытого блока над сундуком читался до вида): не видна — сперва до вида.
  const lidPos = v3(at).offset(0, 1, 0)
  const eyes: typeof import('../perception/eyes') = require('../perception/eyes')
  if (visibleOnly && !stay && !eyes.seesNow(bot, lidPos)) await digToSee(session, ctl, lidPos, { ms: 15000 })
  const lid = eyes.seesNow(bot, lidPos) ? bot.blockAt(lidPos) : null
  const cube = b => !!b && b.boundingBox === 'block' && Array.isArray(b.shapes) && b.shapes.length === 1 && b.shapes[0].join(',') === '0,0,0,1,1,1' &&
    !/chest|barrel|glass|leaves|^ice$|_ice$|barrier|slime|honey|soul_sand|tnt|glowstone|sea_lantern|beacon|observer|piston|redstone_block/.test(b.name)
  if (cube(lid) && !(eyes.seesNow(bot, v3(at)) && (bot.blockAt(v3(at)) || {}).name === 'barrel')) {
    const pick: typeof import('../pick') = require('../pick')
    if (visibleOnly && !pick.blockSeen(bot, lid.position, { range: 4.6 })) {
      if (stay) return { at, took: {}, stopped: 'крышку отсюда не вижу' }
      await digToSee(session, ctl, lid.position, { ms: 15000 })
    }
    if (visibleOnly && !pick.blockSeen(bot, lid.position, { range: 4.6 })) return { at, took: {}, stopped: 'крышка сундука закрыта невидимым блоком' }
    await digAt(session, ctl, lid.position, { maxMs: 20000, walkMs: stay ? 0 : 20000 })
  }
  if (process.env.ND_DEBUG_STRUCT) console.log('[take]', JSON.stringify(at), 'me', bot.entity.position.toString(), 'eye→', (require('../pick') as typeof import('../pick')).eyeOf(bot).distanceTo(v3(at).offset(0.5, 0.5, 0.5)).toFixed(2), 'lid', lid && lid.name, 'aim', aimable())
  // Открывать — без приседа: присед с предметом в руке — «второе действие», сундук не открывается
  // (ServerPlayerGameMode.useItemOn: isSecondaryUseActive && предмет в руке → мимо блока; ферма 14.10, трюм −220,−952).
  bot.setControlState('sneak', false)
  const { block, win } = await containers.findAndOpen(session, ctl, { ...at, visibleOnly, stay }, deadline)
  const shut = containers.guardWindow(ctl, win)
  let pass = null
  const plan = []
  try {
    const byName = new Map()
    const ctx = {}
    for (const it of win.containerItems()) {
      const d = decide(bot, it, ctx)
      const cur = byName.get(it.name)
      if (cur) { cur.count += it.count; if (d.take && !cur.take) Object.assign(cur, d) } else byName.set(it.name, { name: it.name, count: it.count, ...d })
    }
    plan.push(...byName.values())
    const names = plan.filter(p => p.take).sort((a, b) => b.prio - a.prio).map(p => p.name)
    pass = await containers.withdrawPass(bot, session.mcData, win, names, { deadline, ctl })
  } finally {
    shut()
    await sleep(150)
  }
  // Взято не всё (прервали, не влезло) — сундук не «взят»: вернуться можно (ревью Codex q2).
  if (!ctl.aborted && !(pass && pass.stopped) && !Object.keys((pass && pass.left) || {}).length) markLooted(session, keyOf(block.position))
  const took = (pass && pass.took) || {}
  const why = {}
  for (const p of plan) if (took[p.name]) why[p.name] = p.why
  const left = {}
  for (const p of plan) if (!p.take) left[p.name] = p.count
  const text = (Object.entries(took) as [string, any][]).map(([k, v]) => `${k}×${v}`).join(', ') || 'ничего ценного'
  try { session.journal.append('лут', `${(KINDS[kind] || {}).ru || 'сундук'} ${at.x},${at.y},${at.z}: ${text}`, bot.entity.position) } catch {}
  return { at, kind: block.name, took, why, left, notTaken: pass && Object.keys(pass.left || {}).length ? pass.left : undefined, stopped: (pass && pass.stopped) || undefined }
}

// Вагонетка с сундуком: shift-клик только ценного.
async function takeCart (session, ctl, cart) {
  const bot = session.bot
  const t0 = gameClock.now()
  bot.pathfinder.setGoal(new goals.GoalFollow(cart, 2))
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  while (!ctl.aborted && gameClock.now() - t0 < 30000 && cart.isValid !== false && cart.position.distanceTo(bot.entity.position) > 3) await sleep(200)
  bot.pathfinder.setGoal(null)
  if (cart.position.distanceTo(bot.entity.position) > 3.5) return { stopped: 'не дошёл до вагонетки', took: {} }
  const win = await withTimeout(bot.openContainer(cart), 6000, 'вагонетка не открылась')
  const took = {}
  const why = {}
  const left = {}
  try {
    const ctx = {}
    const items = win.containerItems().map(it => ({ it, d: decide(bot, it, ctx) })).sort((a, b) => b.d.prio - a.d.prio)
    for (const { it, d } of items) {
      if (!d.take) { left[it.name] = (left[it.name] || 0) + it.count; continue }
      try { await bot.clickWindow(it.slot, 0, 1); took[it.name] = (took[it.name] || 0) + it.count; why[it.name] = d.why } catch {}
      await sleep(120)
    }
  } finally { try { win.close() } catch {} }
  markLooted(session, `cart:${cart.id}`)
  return { at: xyz(cart.position), kind: 'chest_minecart', took, why, left }
}

async function lootAll (session, ctl, rec, out, p) {
  const bot = session.bot
  const K = KINDS[rec.kind]
  const R = rec.lootR || K.lootR || K.r
  if (!R) return
  const done = lootedSet(session)
  const center = { x: rec.x, y: rec.y, z: rec.z }
  let list0 = containersNear(session, center, R, rec.yR || K.yR || 16).filter(q => !done.has(keyOf(q)))
  const planned = ((rec.tf && rec.tf.chests) || []).filter(c => Number.isFinite(c.y) && c.p > 0)
  // Стоять на месте (плита храма цела — по камере не ходить; ревью Codex q2): только сундуки в досягаемости и в прицеле.
  const hereOnly = q => canReach(bot, q) && !!(require('../pick') as typeof import('../pick')).blockAim(bot, v3(q), { range: 4.3, seeThrough: null })
  if (rec.stay) list0 = list0.filter(hereOnly)
  // Сундуков не видно, а «пирог» F3 считает их в прорисовке (сундук без клетки) — обход: 4 точки вокруг центра постройки,
  // глаза смотрят по ходу (S8d, аудит S10 №11). Бочку «пирог» не видит. ND_STRUCT_EYES=0 — без обхода. Шаблон узнан —
  // обход не нужен: где сундуки, известно.
  if (!rec.stay && !list0.length && !planned.length && process.env.ND_STRUCT_EYES !== '0') {
    let pieN = 0
    try { const pp = (require('../perception/senses') as typeof import('../perception/senses')).pie(bot, { range: Math.min(96, bot.entity.position.distanceTo(v3(center)) + R) }); pieN = (pp && pp.byType && (pp.byType.chest || 0)) || 0 } catch {}
    const ring = Math.max(6, Math.min(R, 14))
    for (const [dx, dz] of pieN ? [[1, 0], [0, 1], [-1, 0], [0, -1]] : []) {
      if (ctl.aborted || list0.length) break
      try { await walk(session, ctl, new goals.GoalNear(center.x + dx * ring, Number.isFinite(center.y) ? center.y : bot.entity.position.y, center.z + dz * ring, 3), 9000) } catch {}
      try { (require('../perception/eyes') as typeof import('../perception/eyes')).nearest(bot, CONTAINER_NAMES, { fresh: true, max: 1 }) } catch {}
      list0 = containersNear(session, center, R, rec.yR || K.yR || 16).filter(q => !done.has(keyOf(q)))
    }
  }
  const list = list0
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  const places = (session.journal.state && session.journal.state.places) || {}
  const here = dimOf(bot)
  for (const q of list) {
    if (ctl.aborted) break
    if ((bot.health ?? 20) < 8) { out.lines.push(`⚠ ${Math.round(bot.health)} хп — остальные сундуки потом`); break }
    const marks = p.force ? [] : playerMarks(bot, q, rec.kind)
    // Наша база рядом — не лут (как loot.js).
    const base = (Object.entries(places) as [string, any][]).some(([n, pl]: any) => pl && typeof pl.x === 'number' && !STRUCTURE_PLACES.has(n) &&
      (pl.dimension || 'overworld') === here && Math.hypot(pl.x - q.x, pl.z - q.z) < 24 && Math.abs((pl.y ?? q.y) - q.y) < 16)
    if (base) marks.push('рядом наша база')
    if (marks.length) { out.skipped.push({ at: xyz(q), why: `поставил игрок? ${marks.join(', ')} — без решения человека не трогаю` }); continue }
    try {
      // Открыть — только в прицеле (не сквозь стену): visibleOnly.
      const bag0 = bagCounts(bot)
      const r = withGain(bot, bag0, await takeWorth(session, ctl, q, { kind: rec.kind, visibleOnly: true, stay: !!rec.stay }))
      out.chests.push({ at: r.at, took: r.took, stopped: r.stopped })
      merge(out, r)
      if (r.stopped) out.lines.push(`⚠ сундук ${r.at.x},${r.at.y},${r.at.z}: ${r.stopped}`)
    } catch (e) {
      out.chests.push({ at: xyz(q), error: e.message })
    }
  }
  // Сундуки шаблона, которых не видно (в трюме, под песком, в доме, в камере): ближний первым — довести до вида
  // (digToSee: копать то, что на луче к клетке), увидел сундук — открыть; на клетке не сундук — вариант не тот, мимо.
  let todo = planned.filter(c => (!rec.stay || hereOnly(c)) && !lootedSet(session).has(keyOf(c)) && !lootedSet(session).has(`miss:${keyOf(c)}`))
  while (todo.length && !ctl.aborted) {
    if ((bot.health ?? 20) < 8) { out.lines.push(`⚠ ${Math.round(bot.health)} хп — сундуки шаблона потом`); break }
    const me = bot.entity.position
    todo.sort((a, b) => me.distanceTo(v3(a)) - me.distanceTo(v3(b)))
    const c = todo.shift()
    // Глубже 16 бл. под водой без дверей на карман — не ныряю (15 с воздуха: вниз и наверх не успеть; ферма 14.10, корабль
    // на 20 бл. — утонул трижды); с дверями — до 26.
    const surfY = bot._ndSurface ? bot._ndSurface.y : (swimming(bot) ? bot.entity.position.y : 62)
    const doors = process.env.ND_AIR_POCKET === '1' && bot.inventory.items().some(i => /_door$/.test(i.name) && i.name !== 'iron_door')
    if (c.wet && surfY - c.y > (doors ? 26 : 16)) { out.lines.push(`⚠ сундук ${c.table} на ${Math.round(surfY - c.y)} бл. под водой${doors ? '' : ' без дверей на карман воздуха'} — не ныряю`); continue }
    const t0 = gameClock.now()
    const bag0 = bagCounts(bot)
    try {
      const r0 = await withAir(session, ctl, async sub => {
        const got = rec.stay ? hereOnly(c) : c.wet && (swimming(bot) || headWet(bot)) ? await diveToChest(session, sub, c, { ms: 40000 }) : await digToSee(session, sub, c, { ms: c.wet ? 40000 : 60000, wet: c.wet })
        if (!got) return { miss: 'не вскрыл' }
        const b = bot.blockAt(v3(c))
        if (!b || !/^(chest|trapped_chest|barrel)$/.test(b.name)) return { miss: `на клетке ${b ? b.name : '—'}` }
        try {
          return await takeOnce(session, sub, c, { kind: rec.kind, visibleOnly: true, stay: !!rec.stay })
        } catch (e) {
          // Видна краем, а луч к середине упёрся в соседа (ферма 14.10, храм 16,160: ниша сбоку) — шаг ближе и снова.
          if (rec.stay || !/не в прицеле/.test(String(e.message)) || sub.aborted) throw e
          try { await walk(session, sub, new goals.GoalNear(c.x, c.y, c.z, 1), 10000) } catch {}
          await digToSee(session, sub, c, { ms: 15000, wet: c.wet })
          return takeOnce(session, sub, c, { kind: rec.kind, visibleOnly: true, stay: !!rec.stay })
        }
      }, c.wet ? 4 : 1)
      const g = bagGain(bot, bag0)
      const r = r0 && !r0.miss ? withGain(bot, bag0, r0) : (!r0 && Object.keys(g).length ? { at: xyz(c), took: g, stopped: 'нырок оборван — взято, что успел' } : r0)
      const sec = Math.round((gameClock.now() - t0) / 1000)
      if (!r || r.miss) {
        if (r && /на клетке/.test(r.miss)) {
          markLooted(session, `miss:${keyOf(c)}`)
          // На клетке не сундук — её гипотезы неверны: их клетки, которых нет у других гипотез, не копать.
          if (Array.isArray(c.hyps)) todo = todo.filter(q => !Array.isArray(q.hyps) || q.hyps.some(h => !c.hyps.includes(h)))
        }
        out.chests.push({ at: xyz(c), planned: true, error: (r && r.miss) || 'прервано', sec })
        out.lines.push(`⚠ сундук шаблона ${c.x},${c.y},${c.z} (${c.table}): ${(r && r.miss) || 'прервано'} за ${sec} с`)
        continue
      }
      out.chests.push({ at: r.at, planned: true, table: c.table, took: r.took, stopped: r.stopped, sec })
      merge(out, r)
      // Сундук на клетке — верны гипотезы этой клетки: клетки только других гипотез (зеркало, сдвиг) — мимо (ферма 14.10,
      // храм джунглей 18,-168: две гипотезы, лишние 13 с на пустые клетки).
      if (Array.isArray(c.hyps)) todo = todo.filter(q => !Array.isArray(q.hyps) || q.hyps.some(h => c.hyps.includes(h)))
      if (r.stopped) out.lines.push(`⚠ сундук ${r.at.x},${r.at.y},${r.at.z}: ${r.stopped}`)
    } catch (e) {
      out.chests.push({ at: xyz(c), planned: true, error: e.message })
    }
    // Взял под водой — сразу наверх, пока воздуха больше, чем у тактики (Surface при ≤ 8 рвёт навык): следующий нырок — с полным.
    if (headWet(bot) && air(bot) < 16) await breathe(bot, ctl, 15000, session)
    todo = todo.filter(q => !lootedSet(session).has(keyOf(q)))
  }
  if (rec.stay) return
  // Вагонетки с сундуком (шахта).
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (ctl.aborted) break
    if (!e || e.name !== 'chest_minecart' || !e.position) continue
    if (flat(e.position, center) > R || done.has(`cart:${e.id}`)) continue
    // Вагонетка шахты под постройкой (деревня над шахтой: 4 × «не дошёл до вагонетки» по 30 с, ферма 14.10) — только на её уровне и на виду.
    if (Math.abs(e.position.y - (Number.isFinite(center.y) ? center.y : bot.entity.position.y)) > (rec.yR || K.yR || 16) || !(require('../perception/eyes') as typeof import('../perception/eyes')).seesNow(bot, e.position.offset(0, 0.5, 0))) continue
    try {
      const r = await takeCart(session, ctl, e)
      out.chests.push({ at: r.at, cart: true, took: r.took, stopped: r.stopped })
      merge(out, r)
    } catch (err) { out.chests.push({ at: xyz(e.position), cart: true, error: err.message }) }
  }
}

export { takeWorth, takeOnce, takeCart, lootAll }
