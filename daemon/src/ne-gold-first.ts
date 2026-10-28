'use strict'
// ND_NE_GOLD_FIRST=1 (поток ne 21.10, выкл.): первое в Аду без золота — золотые ботинки, как у спидраннера. Набор полного прохода
// (int7-s20-1): каменная кирка, ни золота, ни брони — пиглины бьют с первой секунды (10 входов: бруты/пиглины ×4). Здесь: видимая
// золотая руда Ада (луч глаз, 32 бл.) — к ней закрытым штреком (tunnel.tunnelTo с добором руды в стенах: sealed.bonusGold), руда
// злит пиглинов в ±16 без луча, но в закрытом штреке они тела не видят. 36 самородков (руда 2–6, ~9 руд) → 4 слитка → ботинки.
import * as gameClock from './game-clock'
import { countOf } from './items'

const log = (what, o) => console.log('[gold-first]', what, JSON.stringify(o))
const HOSTILE = /^(piglin|piglin_brute|hoglin|zoglin)$/
// Брут видел(ся) в r бл. от точки (последнее место или первое — его пост), по высоте ±10. c87-int2-s21: при 20 — мимо и руда 22,67,9
// в 19.6 бл. от брута на валу (в b86 с неё — ботинки без боя): 12 — пост брута (StrollAroundPoi HOME 8) + запас.
export const bruteNear = (spots: Array<{ x: number, y: number, z: number, assumedPatrolAnchor?: { x: number, y: number, z: number } }>, q, r = 20) =>
  spots.some(s => [s, s.assumedPatrolAnchor].some(p => p && Math.abs(p.y - q.y) <= 10 && Math.hypot(p.x - q.x, p.z - q.z) < r))

export async function goldFirst (session, ctl, p: any = {}) {
  const bot = session.bot
  const T: typeof import('./bastion/take-gold-block') = require('./bastion/take-gold-block')
  const tunnel: typeof import('./tunnel') = require('./tunnel')
  const sight: typeof import('./sight') = require('./sight')
  const deadline = gameClock.now() + Math.max(30, Math.min(600, Number(p.timeoutSeconds) || 300)) * 1000
  const nuggets = () => countOf(bot, 'gold_nugget') + 9 * countOf(bot, 'gold_ingot') + 81 * countOf(bot, 'gold_block')
  const out: any = { ores: 0, legs: 0, nuggets0: nuggets(), worn: T.goldWorn(bot), tried: [] }
  const tried = new Set<string>()
  const openGold = process.env.ND_BAST2_OPEN_GOLD === '1'
  // Железной кирки нет, а сырое железо есть — расплавить сейчас, в кармане прибытия (bastion.makeIronPick: печь, плавка, кирка): блок золота
  // бастиона ломается только железной и лучше (gold_block harvestTools 1.21.11); int2-s20/int6 несли сырое железо без плавки.
  if (!bot.inventory.items().some(i => /^(iron|diamond|netherite)_pickaxe$/.test(i.name)) && countOf(bot, 'raw_iron') + countOf(bot, 'iron_ingot') >= 3) {
    out.ironPick = await T.makeIronPick(session, ctl).catch(e => 'ошибка: ' + e.message)
    log('железная кирка', { ok: out.ironPick })
  }
  const oreId = bot.registry.blocksByName.nether_gold_ore?.id
  const E: typeof import('./perception/eyes') = require('./perception/eyes')
  const bastionIds = ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'chiseled_polished_blackstone', 'gold_block'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)
  // Увиденное — на теле между вызовами (оглядеться до укрытия и копка после него — два вызова), сброс — в другом измерении/месте.
  const mem = bot._ndGoldFirst && bot._ndGoldFirst.world === bot.world && bot.entity.position.distanceTo(bot._ndGoldFirst.home) < 64 ? bot._ndGoldFirst
    : (bot._ndGoldFirst = { world: bot.world, home: bot.entity.position.clone(), foes: [], bastion: [] })
  const seenFoes: Array<{ x: number, y: number, z: number }> = mem.foes, bastionSeen: any[] = mem.bastion, home0 = mem.home
  const notice = () => {
    for (const e of E.entities(bot, { radius: 48, rememberMs: 0, hearMs: 0 })) if (e.seen && e.pos && HOSTILE.test(e.name)) seenFoes.push({ x: e.pos.x, y: e.pos.y, z: e.pos.z })
    for (const b of sight.visibleOf(bot, bastionIds, 32, { max: 24 })) if (!bastionSeen.some(q => q.equals(b.position))) bastionSeen.push(b.position)
    if (seenFoes.length > 200) seenFoes.splice(0, seenFoes.length - 200)
  }
  // look: только оглядеться (до укрытия прибытия: из кармана в толще руды не видно — n82: «руды не видно» ×4); найденное — в память глаз.
  if (p.look) { const e = bot._ndEyes; for (let i = 0; i < 6 && e; i++) e.sweep({ rays: 1500, maxMs: 40 }); notice(); return { looked: true, ores: E.nearest(bot, 'nether_gold_ore', { max: 12, maxDist: 40 }).length } }
  // 25 с в конце — на слитки и ботинки (верстак): n84-int7 — 36/36 к сроку, ботинок нет.
  while (!T.goldWorn(bot) && !ctl.aborted && gameClock.now() < deadline - 25000) {
    if (nuggets() >= 36) { out.armed = await T.armGold(session, ctl).catch(() => false); break }
    // Руда у открытого: вскрытие — на глазах у пиглинов без золота (удар 8). На хп < 12 один такой взгляд — смерть (c94-int2-s20: хп 10,
    // пиглин 8 + 2.3 на 2-й мин) — сперва лечение (кампания: Heal в толще), золото потом.
    if ((bot.health ?? 20) < 12) { out.stopped = `хп ${Math.round(bot.health ?? 0)} — сперва лечение`; break }
    // Видимая сейчас и увиденная раньше (память глаз этого измерения) — ближняя первой.
    const Vec3: typeof import('vec3').Vec3 = require('vec3').Vec3
    // Руда у дома брута — мимо: видимая руда у открытого, её вскрытие открывает штрек на пост брута (n85/b86-int2-s21: руда 48,69,16 в
    // 14 бл. от брута 36,74,22 — 13 + 10 за 2 с). Бруты держатся дома (PiglinBruteAi: StrollAroundPoi HOME 8).
    const BM: typeof import('./brute-memory') = require('./brute-memory')
    BM.observe(bot, true)
    const posts = process.env.ND_NE_BRUTE_POSTS === '1' ? (require('./bastion/hyp-focus') as typeof import('./bastion/hyp-focus')).brutePosts(bot) : []
    // Руда у пиглинов и у бастиона — тоже мимо: без золота на теле пиглин бьёт с первого взгляда, а ломка руды злит всех в ±16 без луча
    // (b86-int12-s20: руда на валу бастиона 51,71,15 в 50 бл. от прибытия — пиглин 8 + 8 + 6). Увиденные пиглины/хоглины и блоки бастиона
    // копятся за вызов; руда — не дальше 40 бл. от места прибытия (дальше — дело поиска бастиона, а не ботинок).
    notice()
    const cand = [...sight.visibleOf(bot, [oreId], 32, { max: 12 }).map(b => b.position),
      ...E.nearest(bot, 'nether_gold_ore', { max: 16, maxDist: 40 }).map(r => new Vec3(r.x, r.y, r.z))]
      .filter(q => !tried.has(q.x + ',' + q.y + ',' + q.z) && bot.blockAt(q)?.name === 'nether_gold_ore' && !bruteNear(BM.spots(bot), q, 12) && !bruteNear(posts, q, 10) &&
        !bruteNear(seenFoes, q, 10) && !bastionSeen.some(b => b.distanceTo(q) < 6) && q.distanceTo(home0) <= (openGold ? 64 : 40))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    // ND_BAST2_OPEN_GOLD: руды не видно (−9170: прибытие в лесу/долине, 0 руд в памяти) — до 2 коротких разведок ногами за рудой
    // (actions.explore: память глаз, затем лучи по 24 бл.), пока стражи не видно; потом — как прежде, дело поиска бастиона.
    if (!cand.length && openGold && (out.explores || 0) < 2 && openSafe(bot) && deadline - gameClock.now() > 60000) {
      out.explores = (out.explores || 0) + 1
      const w = await watched(bot, ctl, sub => (require('./actions') as typeof import('./actions')).explore(session, sub, { block: 'nether_gold_ore', radius: 32, stepDistance: 24, timeoutSeconds: 60 }))
      const ex: any = w.result || {}
      out.explored = { found: !!ex.found, note: w.alarm || w.err || ex.note, at: ex.now }
      if (w.alarm) break
      continue
    }
    if (!cand.length) { out.stopped = 'золотой руды не видно и в памяти нет'; break }
    const ore = cand[0]
    tried.add(`${ore.x},${ore.y},${ore.z}`)
    const before = nuggets()
    // ND_BAST2_OPEN_GOLD=1 (поток bast2 27.10, выкл.): пиглинов, брутов и хоглинов не видно и не слышно — к руде ногами, как спидраннер.
    // Закрытый штрек к руде у открытого почти не доходит (sr27-bast R-P: «к руде вплотную пути нет», «ближе не подойти», «время» —
    // ботинки 1 раз из 20); ногами с тех же снимков r0-s2: 14 руд в памяти глаз, 56 самородков за 2 подхода. Видна стража — штрек, как был.
    const safe = openGold && openSafe(bot)
    if (openGold && !safe) out.guarded = (out.guarded || 0) + 1
    if (safe) {
      const op = await openOre(session, ctl, bot, ore, deadline)
      const got = nuggets() - before
      if (got > 0) out.ores += op.dug || 1
      out.open = (out.open || 0) + 1
      out.tried.push({ ore: { x: ore.x, y: ore.y, z: ore.z }, open: true, ok: op.ok, why: op.why, dug: op.dug, got })
      if (op.ok || got > 0 || ctl.aborted) continue
    }
    // Штрек по Аду целится в круг 3 бл. (последний кусок: допуск ≥ 3) — к руде вплотную добирает короткий закрытый план.
    const tr: any = await tunnel.tunnelTo(session, ctl, ore, { radius: 3, bonus: true, deadline: Math.min(deadline, gameClock.now() + 90000) }).catch(e => ({ ok: false, why: e.message }))
    out.legs++
    if (tr.ok) tr.dig = await digOre(session, ctl, bot, ore, tr.own, deadline)
    const got = nuggets() - before
    if (got > 0) out.ores += tr.ores || 1
    out.tried.push({ ore: { x: ore.x, y: ore.y, z: ore.z }, ok: tr.ok, why: tr.why, ores: tr.ores, dig: tr.dig, got })
    if (out.legs >= 30) { out.stopped = 'много заходов'; break }
  }
  if (!T.goldWorn(bot) && nuggets() >= 36) out.armed = await T.armGold(session, ctl).catch(() => false)
  out.worn = T.goldWorn(bot)
  out.nuggets = nuggets()
  out.tried = out.tried.slice(-6)
  log('итог', out)
  return { ...out, note: out.worn ? `Золото на теле (${out.ores} руд, самородков ${out.nuggets})` : `Золотой брони нет: самородков ${out.nuggets}/36; ${out.stopped || 'время'}` }
}

// ND_BAST2_OPEN_GOLD: стражи золота на виду (пиглин, хоглин в 20; брут в 24 — сенсор пиглина 16 бл. + запас) или слышны ближе 8 за
// 10 с — открыто не копать. 32 «на виду» у бастиона −2642 закрывали открытую копку на весь заход (sr27-bast2-s1: 0 открытых подходов).
export const guardsNear = (seen: Array<{ name: string, seen?: boolean, dist?: number }>, heard: Array<{ who?: string, band?: string }>) =>
  seen.some(e => e.seen && HOSTILE.test(e.name) && (e.dist ?? 0) <= (e.name === 'piglin_brute' ? 24 : 20)) ||
  heard.some(h => HOSTILE.test(h.who || '') && /рядом|близко/.test(h.band || ''))
export function openSafe (bot) {
  try {
    return !guardsNear((require('./perception/eyes') as typeof import('./perception/eyes')).entities(bot, { radius: 32 }),
      (require('./perception/senses') as typeof import('./perception/senses')).heard(bot, { sinceMs: 10000 }))
  } catch { return false }
}

// Открытый ход под присмотром (подход к руде, разведка): стража показалась или ударили (стрела пиглина из-за угла: sr27-bast2-B
// слот 14, −2642 gA — подход шёл дальше под стрелами, 20 → 5 хп) — путь бросить; дальше штрек или конец ботинок.
async function watched (bot, ctl, run) {
  const hp0 = bot.health ?? 20
  let alarm = ''
  let timer = null
  const sub = Object.create(ctl, { aborted: { get: () => ctl.aborted || !!alarm } })
  const watch = () => {
    if (!openSafe(bot)) alarm = 'стража на виду'
    else if ((bot.health ?? 20) < hp0 - 1) alarm = 'удар на открытом'
    if (alarm) { try { bot.pathfinder.setGoal(null) } catch {} ; return }
    timer = gameClock.setTimeout(watch, 250)
  }
  watch()
  let result = null, err = ''
  try { result = await run(sub) } catch (e) { err = e.message } finally { if (timer) gameClock.clearTimeout(timer) }
  return { alarm, result, err }
}

// Ногами к руде (pathfinder до точки, откуда грань видна), затем видимую руду рядом (вскрытые соседи жилы тоже) — actions.mine с
// осторожной проверкой пиглинов. Подход прервала стража — штрек к следующей.
async function openOre (session, ctl, bot, ore, deadline) {
  const A: typeof import('./actions') = require('./actions')
  const b = bot.blockAt(ore)
  if (!b || b.name !== 'nether_gold_ore') return { ok: false, why: 'на месте руды ' + (b && b.name) }
  const w = await watched(bot, ctl, sub => A.reachBlock(bot, b, sub))
  if (w.alarm || w.err) return { ok: false, why: w.alarm || w.err }
  if (ctl.aborted || gameClock.now() > deadline) return { ok: false, why: 'прервано' }
  if (!openSafe(bot)) return { ok: false, why: 'стража на виду' }
  const r: any = await A.mine(session, ctl, { block: 'nether_gold_ore', count: 6, radius: 6, avoidPiglinAggro: true }).catch(e => ({ error: e.message }))
  return { ok: !!r.dug, dug: r.dug || 0, why: r.error || r.stopped }
}

// Вплотную к руде (sealed.plan к соседней клетке, свои клетки штрека), сломать её через видимую грань: видимая руда — в стене у открытого,
// после неё в стене дыра 1×1 — подобрать самородки (выпадают в клетку руды) и сразу заложить дыру.
async function digOre (session, ctl, bot, ore, own0, deadline) {
  const SL: typeof import('./sealed') = require('./sealed')
  const { digSeenAll }: typeof import('./bastion/pen-trap') = require('./bastion/pen-trap')
  const { placeBlockAt }: typeof import('./build') = require('./build')
  const D: typeof import('./drops') = require('./drops')
  const view = SL.worldView(bot)
  const me = SL.bodyCells(bot)[0]
  const S: any = { own: new Set(own0 || []), exposed: true, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0, noBonus: true, deadline }
  for (const v of SL.bodyCells(bot)) S.own.add(SL.keyV(v))
  const goal = SL.adjacentGoal(ore, view.cls)
  if (!goal(me.x, me.y, me.z)) {
    const box = { x0: Math.min(me.x, ore.x) - 5, x1: Math.max(me.x, ore.x) + 5, y0: Math.min(me.y, ore.y) - 4, y1: Math.max(me.y, ore.y) + 4, z0: Math.min(me.z, ore.z) - 5, z1: Math.max(me.z, ore.z) + 5 }
    // Видимая руда — у открытого: соседние с ней клетки касаются воздуха; вскрывать можно только вплотную к руде (±1), иначе пути нет
    // (n83-int2-s21: «к руде вплотную пути нет» ×12).
    const near = ck => { const [x, y, z] = ck.split(',').map(Number); return Math.abs(x - ore.x) <= 1 && Math.abs(y - ore.y) <= 1 && Math.abs(z - ore.z) <= 1 }
    const base = { cls: view.cls, dig: view.dig, own: S.own, starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }], goal, h: SL.manhattan(ore), box, maxNodes: 20000, vup: SL.fillerCount(bot) >= 6 }
    let r = await SL.plan(base)
    if (!r.ok) { r = await SL.plan({ ...base, breachOk: near, breachCost: 6 }); if (r.ok) S.breachOk = (ck, nk) => near(ck) || near(nk) }
    if (!r.ok) return { ok: false, why: 'к руде вплотную пути нет' }
    const ex = await SL.execute(session, ctl, r.path, S)
    if (!ex.ok) return { ok: false, why: ex.why }
  }
  const b = bot.blockAt(ore)
  if (!b || b.name !== 'nether_gold_ore') return { ok: false, why: 'на месте руды ' + (b && b.name) }
  const dr = await digSeenAll(bot, [ore])
  if (dr !== 'ok') return { ok: false, why: 'руда не копается: ' + dr }
  await new Promise(r => gameClock.setTimeout(r, 400))
  await D.collect(bot, ctl, { radius: 2.5, timeoutMs: 1500, from: ore, match: (e, st) => st?.name === 'gold_nugget' }).catch(() => null)
  const plug = await placeBlockAt(bot, ore, { honest: true, timeoutMs: 1500 }).catch(e => ({ ok: false, reason: e.message }))
  return { ok: true, plug: !!plug?.ok }
}
