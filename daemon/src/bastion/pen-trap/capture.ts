'use strict'
// Загон пиглинов (penTrade) — фазы до торга с загоном: стройка из ямы, яма до поимки (обычная яма в gather, своя петля
// вручения и приманок), поимка люком. Фаза возвращает итог вызова (r) или ничего (дальше).
import { gameClock, mobs, aggressive, admiring, sleep, centerIn } from '../take-gold-block'
import * as BF from '../../barter-flow'
import { ADMIRE_MS, V, inStrip, lanesUnder, inPen, digSeen, handOne } from './plan'
import { type PenTrade } from './state'
import PG = require('../predict-gold')

export async function penBuild (pt: PenTrade) {
  const { bot } = pt
  // 1. Стройка из ямы: B (голова, ноги), траншея Z0, окна W±p, траншеи Z±p через Z0.
  const tb = gameClock.now()
  const steps = [pt.plan.Bh, pt.plan.Bf, pt.plan.lanes.find(l => l.k === 0).Z, ...pt.plan.lanes.filter(l => l.k).flatMap(l => [l.W])]
  // r.own — выкопанное стройкой (замкнутый свой воздух): trade() добавляет его в st.sealedState.own, чтобы следующий
  // вызов у этой же ямы (загон не закрылся) построил загон на готовых клетках.
  pt.r.own = []
  for (const q of steps) {
    if (!(await pt.canContinue())) return pt.r
    const s = await digSeen(bot, q)
    if (s !== 'ok' && s !== 'air') return Object.assign(pt.r, { ok: false, stopped: `стройка: ${q.x},${q.y},${q.z} ${s}` })
    pt.r.own.push(`${q.x},${q.y},${q.z}`)
  }
  for (const l of pt.plan.lanes.filter(l => l.k)) {
    if (!(await pt.canContinue())) return pt.r
    const s = await digSeen(bot, l.Z)
    if (s !== 'ok' && s !== 'air') { pt.plan.lanes = pt.plan.lanes.filter(x => x !== l); pt.r.laneDropped = (pt.r.laneDropped || []).concat(`${l.k}:${s}`) } else pt.r.own.push(`${l.Z.x},${l.Z.y},${l.Z.z}`)
  }
  pt.r.lanes = pt.plan.lanes.length
  pt.r.phases.build = +((gameClock.now() - tb) / 1000).toFixed(1)
}

export async function penLure (pt: PenTrade) {
  const { bot, session, ctl, bo, opts } = pt
  // 2. Яма до поимки.
  const tl = gameClock.now()
  pt.frozen = []
  // Своя петля «ямы с терпением» (вручение + приманки на пол, ≤catchSeconds): freeze — всегда; gather — после того,
  // как boothTrade сдался («пиглины не подходят 30 с», «яма не работает»), а взрослые в 12 бл. от люка есть.
  let ownLoop = pt.mode === 'freeze'
  let catchFrom = tl
  if (pt.mode === 'gather') {
    // Обычная яма (boothTrade: вручение «чей бросок долетит», приманки, хлам, её правила остановки), пока у люка не
    // соберутся ≥gatherNear взрослых при запасе времени ≥40 с; не собрались — вызов и был торгом ямы (ok, penned:false).
    // Раунд 1 вместо этого торговал упрощённой ямой ≤90 с и отказывал «к люку не собрались» (s2-bast04/05: 3 из 13).
    const BT: typeof import('../booth-trade') = require('../booth-trade')
    const st = opts.st || { traded: 0, gained: {}, barters: [], tossed: [] }
    const gathered = () => {
      pt.trace()
      pt.nearN = pt.adults(12).filter(e => !aggressive(bot, e) && e.position.distanceTo(pt.T0) <= (opts.gatherRadius ?? 4)).length
      return pt.nearN >= (opts.gatherNear ?? 2) && pt.until - gameClock.now() > 40000
    }
    const bt = await BT.boothTrade(session, ctl, st, bo, pt.until, { keep: pt.keep, done: () => pt.done() || gathered(), settle: false })
    pt.r.pit = { handed: bt.handed || 0, tossed: bt.tossed || 0, stopped: bt.stopped, seconds: bt.seconds }
    pt.r.handed1 = pt.r.pit.handed; pt.r.lures1 = pt.r.pit.tossed
    pt.r.phases.lure = +((gameClock.now() - tl) / 1000).toFixed(1)
    pt.r.nearAtCapture = pt.nearN
    const gaveUp = /не подходят|не работает|не доносит/.test(bt.stopped || '')
    const around = pt.adults(16).filter(e => !aggressive(bot, e) && e.position.distanceTo(pt.T0) <= 12).length
    if (gaveUp && opts.patience !== false && pt.until - gameClock.now() > 60000 && around >= 1) { ownLoop = true; pt.r.patience = { after: bt.stopped, around }; catchFrom = gameClock.now() }
    else if (bt.stopped !== 'цель' || pt.done()) { pt.r.ok = true; pt.r.penned = false; pt.r.stopped = bt.stopped; return pt.r }
  }
  const want = Math.min(opts.want ?? pt.plan.lanes.length, pt.plan.lanes.length)
  const catchUntil = Math.min(pt.until - (pt.mode === 'gather' ? 40000 : 20000), catchFrom + (opts.catchSeconds ?? 90) * 1000)
  const gb = (require('../../drops') as typeof import('../../drops')).blockGetter(bot)
  // Подобравший слиток с пола тоже стоит 119 тиков (pickUpItem → stopWalking + admire): время — с первого взгляда.
  const since = new Map()
  let lastAct = catchFrom; let lures1 = pt.r.lures1 || 0; const lures1Max = lures1 + 6; let lureAims = null
  while (ownLoop && !ctl.aborted && gameClock.now() < catchUntil) {
    if (!(await pt.canContinue())) return pt.r
    if (pt.done()) { pt.r.stopped = 'цель'; break }
    if (!(await pt.goldLeft())) { pt.r.stopped = 'слитки кончились'; break }
    if ((bot.health ?? 20) < 8) { pt.r.stopped = `хп ${Math.round(bot.health)}`; break }
    await PG.unholdGold(bot)
    const now = gameClock.now()
    for (const e of pt.adults()) { if (!admiring(e)) since.delete(e.id); else if (!since.has(e.id)) since.set(e.id, pt.handedAt.has(e.id) && now - pt.handedAt.get(e.id) < ADMIRE_MS ? pt.handedAt.get(e.id) : now) }
    pt.frozen = pt.adults().filter(e => since.has(e.id) && now - since.get(e.id) < ADMIRE_MS - 2500 && inStrip(pt.plan, e))
    const oldest = Math.min(...pt.frozen.map(e => since.get(e.id)))
    pt.trace()
    if (pt.mode === 'freeze' && (pt.frozen.length >= want || (pt.frozen.length && now - oldest > 2000))) break
    if (pt.mode === 'gather') {
      pt.nearN = pt.adults(12).filter(e => !aggressive(bot, e) && e.position.distanceTo(pt.T0) <= (opts.gatherRadius ?? 4)).length
      if (pt.nearN >= (opts.gatherNear ?? 2)) { pt.r.stopped = undefined; break }
    }
    if (mobs(bot, 'piglin_brute', 8, V(pt.plan.lanes[0].T)).some(pt.visible)) { await sleep(500); continue }
    const e0 = pt.eye()
    const ready = pt.adults(8).filter(e => BF.ready(bot, e, pt.busyUntil) && PG.rayClear(gb, e0, e.position.offset(0, 1.6, 0)) && PG.throwLands(bot, e.position, bot.entity.position, gb).ok)
      .sort((a, b) => Number(inStrip(pt.plan, b)) - Number(inStrip(pt.plan, a)) || PG.distToBox(e0, a) - PG.distToBox(e0, b))
    const pg = await handOne(bot, ready, e0)
    if (pg) { pt.handedAt.set(pg.id, gameClock.now()); pt.busyUntil.set(pg.id, gameClock.now() + ADMIRE_MS); pt.r.handed1++; lastAct = gameClock.now() } else if (gameClock.now() - lastAct > 15000 && lures1 < lures1Max) {
      // 15 с никого в руке — приманка на пол у рта (прицелы ямы pitLures: бросок подобравшего долетит к нам).
      lureAims = lureAims || PG.pitLures(bot, bo)
      const L = lureAims.find(x => x.score >= 5)
      if (L && await PG.tossOut(bot, bo, 'gold_ingot', 1, L.aim)) { lures1++; pt.r.lures1 = lures1 }
      lastAct = gameClock.now()
    }
    await sleep(pg ? 100 : 300)
  }
  if (ownLoop) pt.r.phases.lure = +((gameClock.now() - tl) / 1000).toFixed(1)
  pt.r.frozen = pt.frozen.length
  pt.r.nearAtCapture = pt.nearN
  if (pt.mode === 'freeze' && !pt.frozen.length) { pt.r.ok = false; pt.r.stopped = pt.r.stopped || 'никто не встал над люком'; return pt.r }
  if (pt.mode === 'gather' && pt.nearN < (opts.gatherNear ?? 2)) { pt.r.ok = true; pt.r.penned = false; pt.r.stopped = pt.r.stopped || (pt.r.patience ? pt.r.patience.after + '; к люку не собрались' : 'к люку не собрались'); return pt.r }
}

export async function penCapture (pt: PenTrade) {
  const { bot, ctl } = pt
  // 3. Поимка: рот закрыть, шаг в B, закрыть P, сломать пол под замершими.
  const tc = gameClock.now()
  if (!(await pt.canContinue())) return pt.r
  if (!(await pt.SL.fillCell(bot, V(pt.plan.M)))) { pt.r.ok = false; pt.r.stopped = 'рот не закрылся'; return pt.r }
  const { stepCell }: typeof import('../booth-trade') = require('../booth-trade')
  // Ноги на песке душ — на 0.125 ниже клетки (как sealed.feetCell).
  const inCell = c => { const p = bot.entity.position; const f = p.floored(); const y = bot.entity.onGround && p.y - f.y >= 0.8 ? f.y + 1 : f.y; return f.x === c.x && f.z === c.z && y === c.y }
  // Поимка сорвалась после закрытого рта — вернуть яму (шаг в P, рот открыть через видимую грань), чтобы торг ямы
  // мог продолжиться (s2b-alt06 k=1,5: «в B не шагнул» оставлял закрытую яму).
  const undo = async why => {
    if (!inCell(pt.plan.P)) { await stepCell(bot, V(pt.plan.P), false); await centerIn(bot, V(pt.plan.P), 1500) }
    const m = inCell(pt.plan.P) ? await digSeen(bot, pt.plan.M) : 'не в P'
    pt.r.reopened = m
    pt.r.ok = false; pt.r.stopped = why; return pt.r
  }
  for (let i = 0; i < 3 && !inCell(pt.plan.Bf) && !ctl.aborted; i++) {
    await stepCell(bot, V(pt.plan.Bf), false)
    await centerIn(bot, V(pt.plan.Bf), 1500)
  }
  if (!inCell(pt.plan.Bf)) return undo('в B не шагнул')
  pt.standingAt = V(pt.plan.Bf).offset(0.5, 0, 0.5)
  // Рамка тела ещё на краю P (центровка не успела) — сервер не ставит блок в тело: центровать и повторить
  // (s2b-alt03 k=13: «клетка P не закрылась» при закрытом рте).
  let pFilled = false
  for (let i = 0; i < 4 && !pFilled && !ctl.aborted; i++) {
    if (i) { await centerIn(bot, V(pt.plan.Bf), 1500); await sleep(200) }
    pFilled = await pt.SL.fillCell(bot, V(pt.plan.P))
  }
  if (!pFilled) return undo('клетка P не закрылась')
  if (pt.openAll) {
    for (const l of pt.plan.lanes) {
      if (!(await pt.canContinue())) return pt.r
      const s = await digSeen(bot, l.Y)
      if (s === 'ok' || s === 'air') pt.broke.add(l.k); else pt.r.trapdoor = (pt.r.trapdoor || []).concat(`${l.k}:${s}`)
    }
    if (!pt.broke.size) { pt.r.ok = false; pt.r.stopped = 'люки не открылись'; return pt.r }
  }
  for (const e of pt.frozen) {
    if (!bot.entities[e.id] || !inStrip(pt.plan, e)) continue
    for (const l of lanesUnder(pt.plan, e)) {
      if (pt.broke.has(l.k)) continue
      if ([...pt.seenBabies.values()].some(b => lanesUnder(pt.plan, b).includes(l))) continue
      const s = await digSeen(bot, l.Y)
      if (s === 'ok' || s === 'air') pt.broke.add(l.k); else pt.r.trapdoor = (pt.r.trapdoor || []).concat(`${l.k}:${s}`)
    }
  }
  for (let i = 0; i < 20 && !pt.adults(8).some(e => inPen(pt.plan, e)); i++) await sleep(100)
  await sleep(400)
  pt.r.captured = pt.adults(8).filter(e => inPen(pt.plan, e)).length
  pt.r.phases.capture = +((gameClock.now() - tc) / 1000).toFixed(1)
  pt.r.opened = [...pt.broke]
  if (!pt.openAll && !pt.r.captured) { pt.r.ok = false; pt.r.stopped = 'не упал'; return pt.r }
}
