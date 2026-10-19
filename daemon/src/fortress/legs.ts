'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { travelXZ, gotoPath } from '../movement'
import * as worlds from '../worlds'
import { log, bastionNear } from './look'

// Крепость Ада стоит в полосе y 48..70 (NetherFortressStructure:
// moveInsideHeights(random, 48, 70)). Сверху её кирпич закрыт породой: прогон
// 2026-09-25 прошёл прямо над крепостью по y=115 — лучом проверено 473 места,
// видно 0. Поэтому, пока тело выше 80, отрезок целится на 12 ниже (до 64):
// pathfinder сам ищет спуск и копает — ломать блок у жидкости он не станет
// (Movements.dontCreateFlow). Не вышло вниз — тот же отрезок по горизонтали.
async function legTo (session, ctl, tx, tz, deadline, { onOpen = null, stop = null }: any = {}) {
  const nether: typeof import('../nether') = require('../nether')
  // Без золотой вещи — закрытым штреком (nether-cover, план координатора 14.10): в толще не видят пиглины, гасты и скелеты,
  // под ногами нет обрыва; устье в пещеру — окно (onOpen — взгляд поиска). Не вышло — как прежде (поверху — цена).
  const bot = session.bot
  // С золотом — тоже штреком у бастиона (48 бл.: бруты бьют при любом золоте, g4-5-1: брут и хоглин у бастиона, смерть за 1.5 с;
  // дальше — к крепости — поверху: штрек над лавовым морем застревал, g7-6-1) и при
  // видимых брутах, хоглинах, гастах.
  const coverNeeded = () => !(require('../bastion/take-gold-block') as typeof import('../bastion/take-gold-block')).goldWorn(bot) || bastionNear(session, bot.entity.position, 48) ||
    (() => { try { return (require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot, { radius: 40 }).some(e => e.seen && /^(piglin_brute|hoglin|zoglin|ghast)$/.test(e.name)) } catch { return false } })()
  if (process.env.ND_NE_COVER !== '0' && worlds.worldOf(bot) === 'the_nether' && coverNeeded() && gameClock.now() < deadline) {
    await keepPicks(session, ctl)
    const d0 = Math.hypot(tx - bot.entity.position.x, tz - bot.entity.position.z)
    const c = await (require('../nether-cover') as typeof import('../nether-cover')).closedBore(session, ctl, { x: tx, z: tz }, {
      deadline: Math.min(deadline, gameClock.now() + 60000), maxSteps: 24, onOpen, stop, goldOk: () => !piglinsAround(bot), minY: 40
    })
    log('закрытый штрек', { to: { x: tx, z: tz }, ok: c.ok, moved: c.moved, dug: c.dug, placed: c.placed, mouths: c.mouths, corridor: c.corridor || undefined, gold: c.gold || undefined, down: c.down || undefined, unsealed: c.unsealed || undefined, why: c.why, at: c.at, view: c.view ? { seen: c.view.seen, bastion: !!c.view.bastion } : undefined })
    // Руда из стен штрека — «золото по пути»: как хватит на 4 слитка, сразу ботинки (верстак — из рюкзака, в штреке).
    if (c.gold && !ctl.aborted) { try { if (await (require('../bastion/take-gold-block') as typeof import('../bastion/take-gold-block')).armGold(session, ctl)) log('золото из стен штрека: броня надета', {}) } catch {} }
    // Успех — по пройденному к цели (Codex q9: шаги туда-сюда у устья — не продвижение).
    const gain = d0 - Math.hypot(tx - bot.entity.position.x, tz - bot.entity.position.z)
    if (c.ok || gain >= 8 || (c.view && stop && stop(c.view))) return { ok: true, bored: c.dug, covered: true, view: c.view }
    if (ctl.aborted) return { ok: false, error: 'прервано' }
    // Поверху без золотой вещи не идём (d5-5-1, d7-6-1: отрезок ногами — уступ над лавовым морем, падение): отрезок закрыт.
    if (process.env.ND_NE_COVER_WALK !== '1') return { ok: false, error: `закрытый штрек: ${c.why}`, bored: c.dug, covered: true, view: c.view }
  }
  // Без нашего золота пиглины бьют всё, что видят (NEAREST_TARGETABLE_PLAYER_NOT_WEARING_GOLD — сенсор с лучом): видны в 24 бл.
  // или слышны ближе 16 — отрезок штреком, а не поверху (b11-6-2 14.10: поиск бастиона поверху, смерть через минуту). Штрек
  // медленнее — цена; не вышел — как прежде ногами.
  if (piglinsAround(session.bot) && process.env.ND_NE_PIGLIN_BORE !== '0' && gameClock.now() < deadline) {
    const b = await nether.bore(session, ctl, { x: tx, z: tz }, { deadline: Math.min(deadline, gameClock.now() + 40000), maxSteps: 20, minY: 40 })
    if (b.ok || b.moved >= 8) return { ok: true, bored: b.dug, bricks: b.bricks }
    if (ctl.aborted) return { ok: false, error: 'прервано' }
  }
  // Отрезок под охраной: ударили — бой с обидчиком, а не следующий отрезок
  // (nether.js guarded: эндермен убил тело посреди разведки, 2026-09-25).
  const w = await nether.guarded(session, ctl, sub => walkLeg(session.bot, sub, tx, tz, deadline))
  if (w.fought) return w
  if (w.ok || ctl.aborted || gameClock.now() > deadline) return w
  // Ногами не вышло (лавовое озеро, обрыв, «путь длиной 0») — штреком по
  // netherrack на высоту крепости (nether.js bore): забой сам не трогает лаву.
  const b = await nether.bore(session, ctl, { x: tx, z: tz }, {
    deadline: Math.min(deadline, gameClock.now() + 40000), maxSteps: 20, minY: 64
  })
  if (b.ok || b.moved >= 8) return { ok: true, bored: b.dug, bricks: b.bricks }
  return { ok: false, error: `${w.error}; штрек: ${b.why}`, bored: b.dug || undefined }
}

// Итог отрезка: подъём/спуск ступенями (up/down) или отчёт travelXZ.
interface LegResult { ok: boolean; up?: number; down?: number; error?: string; [key: string]: any }
async function walkLeg (bot, ctl, tx, tz, deadline): Promise<LegResult> {
  const y = bot.entity.position.floored().y
  // S1f (вслепую — ход без сетки уводил к лавовому морю y 31: s1f-A2-2 разведка и поиск бастиона на y 31–39, смерть в лаве на 6-й мин;
  // S1e M4 — 4 смерти в лаве у y 24–38): ниже 44 отрезок целится вверх (до 56, +12 за отрезок) — ступенями/штреком по незераку,
  // как игрок уходит от берега лавы; не вышло — тот же отрезок по горизонтали. ND_NE_RISE=0 — прежнее.
  const low = y < 44 && process.env.ND_NE_RISE !== '0'
  if (y > 80 || low) {
    const ty = low ? Math.min(56, y + 12) : Math.max(64, y - 12)
    const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
    const { stuckGuard }: typeof import('../movement') = require('../movement')
    const guard = stuckGuard(bot, ctl, 8000)
    const path = gotoPath(bot, new goals.GoalNear(tx, ty, tz, 4))
    let timer = null
    try {
      await Promise.race([
        path,
        guard.promise,
        new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), Math.max(1000, Math.min(15000, deadline - gameClock.now()))) })
      ])
      const p = bot.entity.position
      if (Math.hypot(p.x - tx, p.z - tz) <= 6 && (low ? p.y > y : p.y < y)) return { ok: true, ...(low ? { up: Math.round(p.y - y) } : { down: Math.round(y - p.y) }) }
    } catch {
      try { bot.pathfinder.setGoal(null) } catch {}
    } finally {
      path.cancel?.()
      guard.stop()
      if (timer) gameClock.clearTimeout(timer)
    }
  }
  // 20 с на отрезок в 16 блоков: дольше — это pathfinder, копающий путь с
  // перерасчётом на каждый сломанный блок («reset: block_updated», прогон 7:
  // минута на 8 блоков); штрек (bore) то же пройдёт за 15 с.
  return travelXZ(bot, ctl, tx, tz, { range: 3, retries: 0, deadline: Math.min(deadline, gameClock.now() + 20000) })
}

// S1f: блоки в Аду кончаются посреди разведки (мост, подмости, клатч на каждом прыжке через щель: s1f-C1-2 — «клатч молчит:
// блоков 0» над лавой, падение с y 49 в лаву; B0b-1 — «на коробку блоков нет»; G1-3 — то же с 12). Меньше 24 строительных — незерак рядом (видимый,
// actions.mine, радиус 12, до 56), не чаще раза в игровую минуту. ND_NE_KEEP_BLOCKS=0 — выкл.
async function keepBlocks (session, ctl, { min = 24, want = 56 }: any = {}) {
  const bot = session.bot
  if (process.env.ND_NE_KEEP_BLOCKS === '0' || worlds.worldOf(bot) !== 'the_nether' || ctl.aborted) return null
  // Закрытый штрек даёт незерак сам (два блока на шаг); копка вокруг — выход из укрытия.
  if (process.env.ND_NE_COVER !== '0' && !(require('../bastion/take-gold-block') as typeof import('../bastion/take-gold-block')).goldWorn(bot)) return null
  const have = (require('../pack') as typeof import('../pack')).buildCount(bot, 'the_nether')
  if (have >= min || gameClock.now() < (bot._ndKeepBlocksAt || 0)) return null
  bot._ndKeepBlocksAt = gameClock.now() + 60000
  let r = null
  try { r = await (require('../actions') as typeof import('../actions')).mine(session, ctl, { block: 'netherrack', count: want - have, radius: 12 }) } catch (e) { r = { error: e.message } }
  const now = (require('../pack') as typeof import('../pack')).buildCount(bot, 'the_nether')
  log('блоки: добрал незерак', { was: have, now, error: r && r.error })
  return now - have
}

// Закрытый штрек ест кирки (1×2 — два блока на шаг; три кирки набора — ~256 бл. хода, Codex q9): запас каменных из булыжника
// рюкзака, 4 доски — на новый верстак (c19-7-3: верстак потерян, досок 2 — кирок нет). Не чаще раза в игровую минуту.
async function keepPicks (session, ctl) {
  const T: typeof import('../tunnel') = require('../tunnel')
  const bot = session.bot
  if (T.lowUses(bot) >= 100 || gameClock.now() < (bot._ndKeepPicksAt || 0) || ctl.aborted) return
  bot._ndKeepPicksAt = gameClock.now() + 60000
  // Верстак в рюкзаке — доски на запасной не держать: 4 доски = 4 кирки (g5-7-1: палок нет у крепости — «домой за недостающим»).
  const table = bot.inventory.items().some(i => i.name === 'crafting_table')
  try { log('кирки: запас', { made: await T.restockPicks(session, ctl, 2, { reservePlanks: table ? 0 : 4 }), uses: T.lowUses(bot) }) } catch (e) { log('кирки: запас', { error: e.message }) }
}

// Пиглины, которым мы враги (без нашей золотой вещи): на виду в 24 бл. или слышны ближе 16 за 10 с.
function piglinsAround (bot) {
  try {
    if (!bot.inventory || (require('../bastion/take-gold-block') as typeof import('../bastion/take-gold-block')).goldWorn(bot)) return false
    const seen = (require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot, { radius: 32 }).some(e => e.seen && e.name === 'piglin' && e.dist != null && e.dist <= 24)
    return seen || (require('../perception/senses') as typeof import('../perception/senses')).heard(bot, { sinceMs: 10000 }).some(h => h.who === 'piglin' && h.band !== 'далеко')
  } catch { return false }
}

// Золото Ада по пути (пользователь 14.10: «можно по пути накопать, пока идёшь к нужным структурам в аду» — не отдельной фазой):
// руда Ада и позолоченный чернокамень на виду и рядом. Крюк — ценой против нужды: без золотой брони до 10 бл. (ботинки — 4 слитка,
// 36 самородков), с бронёй — до 5 бл. (остальное — на бартер). Не на глазах у пиглинов: Block.playerWillDestroy злит взрослых
// в коробке ±16 без луча (requireLineOfSight=false, 1.21.11) — пиглин на виду в 24 бл. или слышен ближе 16 — не копать.
// Самородки — в слитки, как наберётся 9; первая броня — как хватит на 4 слитка (armGold).
async function goldOnTheWay (session, ctl) {
  const bot = session.bot
  if (process.env.ND_GOLD_WAY === '0' || !bot.inventory || !bot.registry?.blocksByName || worlds.worldOf(bot) !== 'the_nether' || ctl.aborted ||
    gameClock.now() < (bot._ndGoldWayAt || 0)) return null
  const T: typeof import('../bastion/take-gold-block') = require('../bastion/take-gold-block')
  // Закрытый штрек сам копает руду в своих стенах; ходить к видимой руде поверху — выход из укрытия (нет).
  if (process.env.ND_NE_COVER !== '0' && !T.goldWorn(bot)) return null
  const worn = T.goldWorn(bot)
  const R = worn ? 5 : 10
  const ids = ['nether_gold_ore', 'gilded_blackstone'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)
  const seen = (require('../sight') as typeof import('../sight')).visibleOf(bot, ids, R, { max: 6 })
  if (!seen.length) return null
  bot._ndGoldWayAt = gameClock.now() + 15000
  const eyesSeen = (require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot, { radius: 24 }).filter(e => e.seen && /^piglin(_brute)?$/.test(e.name))
  const earsNear = (require('../perception/senses') as typeof import('../perception/senses')).heard(bot, { sinceMs: 10000 }).filter(h => /^piglin(_brute)?$/.test(h.who || '') && h.band !== 'далеко')
  if (eyesSeen.length || earsNear.length) { log('золото по пути: пиглины рядом — не трогаю', { seen: eyesSeen.length, heard: earsNear.length }); return null }
  const count = (n: string) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const nug0 = count('gold_nugget') + 9 * count('gold_ingot')
  let r: any = null
  try { r = await (require('../actions') as typeof import('../actions')).mine(session, ctl, { block: 'nether_gold_ore,gilded_blackstone', count: Math.min(4, seen.length), radius: R, avoidPiglinAggro: true }) } catch (e) { r = { error: e.message } }
  if (!worn) { try { await T.armGold(session, ctl) } catch {} }
  else if (count('gold_nugget') >= 9) { try { await (require('../actions') as typeof import('../actions')).craft(session, ctl, { item: 'gold_ingot', count: Math.floor(count('gold_nugget') / 9) }) } catch {} }
  log('золото по пути', { dug: r && r.dug, stopped: (r && (r.stopped || r.error)) || undefined, nuggets: count('gold_nugget') + 9 * count('gold_ingot') - nug0, worn: T.goldWorn(bot) })
  return r
}

// Тронный зал по видимому кирпичу: подойти к видимому кирпичу, оглядеться,
// следующий — самый далёкий от уже пройденных мест, пока не увиден спавнер
// или не кончились шаги. Для blaze.js, когда крепость найдена, а спавнера
// не видно ни глазами, ни в памяти.
async function climbTo (session, ctl, top, deadline) {
  const bot = session.bot
  // Точка бывает простым {x,y,z} (toSpawnerBody: клетка в 3.5 бл. от спавнера) — blockAt с ним падал «pos.floored is not a function» (c13-7-2).
  top = new Vec3(top.x, top.y, top.z)
  const floor = bot.blockAt(top)
  const exact = !!floor?.shapes?.some(s => s[0] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1) &&
    (require('../pick') as typeof import('../pick')).blockSeen(bot, floor.position)
  const w = await climbWalk(session, ctl, top, deadline, { exact })
  if (w.ok || w.fought || ctl.aborted || gameClock.now() > deadline) return w
  if (!exact && top.y + 1 - bot.entity.position.y < 3) return w
  // Ногами наверх не вышло (в Аду pathfinder без столба 1x1, worlds.js) —
  // ступеньками штрека: вверх на 1 за шаг к точке, пустоту под ногами
  // закладывает наш placeBlockAt.
  const b = await (require('../nether') as typeof import('../nether')).bore(session, ctl, { x: top.x, z: top.z }, {
    deadline: Math.min(deadline, gameClock.now() + 60000), maxSteps: 40, maxY: top.y + 1, throughBricks: true
  })
  const p = bot.entity.position
  return (exact ? p.distanceTo(new Vec3(top.x + 0.5, top.y + 1, top.z + 0.5)) <= 0.8
    : p.y >= top.y - 1 && Math.hypot(p.x - top.x, p.z - top.z) <= 6)
    ? { ok: true, bored: b.dug, placed: b.placed }
    : { ok: false, error: `${w.error}; ступеньками: ${b.why || 'не дошёл'}`, bored: b.dug }
}

async function climbWalk (session, ctl, top, deadline, { exact = false }: any = {}) {
  const bot = session.bot
  const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const { stuckGuard }: typeof import('../movement') = require('../movement')
  return (require('../nether') as typeof import('../nether')).guarded(session, ctl, async sub => {
    const guard = stuckGuard(bot, sub, 10000)
    let timer = null
    // Подъём на 20–30 блоков столбом — длинный поиск: 5 с по умолчанию
    // pathfinder'у не хватало («Took to long to decide path»).
    const think = bot.pathfinder.thinkTimeout
    bot.pathfinder.thinkTimeout = Math.max(think || 0, 12000)
    const path = gotoPath(bot, exact ? new goals.GoalBlock(top.x, top.y + 1, top.z) : new goals.GoalNear(top.x, top.y + 1, top.z, 3))
    try {
      await Promise.race([
        path,
        guard.promise,
        new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), Math.max(1000, Math.min(40000, deadline - gameClock.now()))) })
      ])
      const p = bot.entity.position
      return p.distanceTo(new Vec3(top.x + 0.5, top.y + 1, top.z + 0.5)) <= (exact ? 0.8 : 5) ? { ok: true } : { ok: false, error: 'на мост не вышел' }
    } catch (e) {
      try { bot.pathfinder.setGoal(null) } catch {}
      return { ok: false, error: e.message }
    } finally {
      path.cancel?.()
      bot.pathfinder.thinkTimeout = think
      guard.stop()
      if (timer) gameClock.clearTimeout(timer)
    }
  })
}

export { legTo, walkLeg, keepBlocks, goldOnTheWay, climbTo, climbWalk }
