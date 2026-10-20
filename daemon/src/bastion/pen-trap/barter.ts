'use strict'
// Загон пиглинов (penTrade) — торг с загоном: каждому свободному — слиток, по кругу; хлам в траншею; пополнение загона
// приманкой в траншею.
import { gameClock, mobs, isBaby, sleep } from '../take-gold-block'
import * as BF from '../../barter-flow'
import { ADMIRE_MS, V, inPen, trenchAim, handOne } from './plan'
import { type PenTrade } from './state'
import PG = require('../predict-gold')

export async function penBarter (pt: PenTrade) {
  const { bot, ctl, opts } = pt
  // 4. Торг с загоном: каждому свободному — слиток, по кругу.
  pt.r.penned = true
  const tt = gameClock.now()
  let lastPen = tt + (pt.lureFirst ? Math.max(0, (opts.catchSeconds ?? 90) * 1000 - 20000) : pt.openAll ? 40000 : 0)
  let lastLure = 0
  let penAtLure = pt.r.captured
  pt.r.lures = 0; pt.r.penMax = pt.r.captured
  const open = [...pt.broke]
  const isIngot = e => { try { const d = e.getDroppedItem && e.getDroppedItem(); return d && d.name === 'gold_ingot' } catch { return false } }
  while (!ctl.aborted && gameClock.now() < pt.until - 3000) {
    if (!(await pt.canContinue())) return pt.r
    if (pt.done()) { pt.r.stopped = 'цель'; break }
    if (!(await pt.goldLeft())) { pt.r.stopped = 'слитки кончились'; break }
    if ((bot.health ?? 20) < 8) { pt.r.stopped = `хп ${Math.round(bot.health)}`; break }
    const pen = pt.adults(8).filter(e => inPen(pt.plan, e))
    pt.trace()
    pt.r.penMax = Math.max(pt.r.penMax, pen.length)
    if (pen.length) lastPen = gameClock.now()
    else if (gameClock.now() - lastPen > 20000) { pt.r.stopped = 'в загоне никого'; break }
    // Рюкзак почти полон — хлам ямы (pitJunk) в траншею: в полный рюкзак добыча не идёт и лежит у ног
    // (s2-lure03: 190 сделок, доставка 82–92 % против 100 % при 90 сделках).
    if (typeof bot.inventory.emptySlotCount === 'function' && bot.inventory.emptySlotCount() < 3) {
      const ta = trenchAim(bot, pt.plan, open, (require('../../drops') as typeof import('../../drops')).blockGetter(bot))
      if (ta) for (const it of PG.pitJunk(bot)) { try { await bot.lookAt(ta.aim, true); await sleep(80); await bot.tossStack(it); pt.r.junked = (pt.r.junked || 0) + it.count } catch {} }
    }
    const free = pen.filter(e => BF.ready(bot, e, pt.busyUntil))
    let n = 0
    for (const pg of free) {
      if (!(await pt.canContinue())) return pt.r
      if (pt.done()) { pt.r.stopped = 'цель'; break }
      if (!(await pt.goldLeft())) { pt.r.stopped = 'слитки кончились'; break }
      if (!(await pt.canContinue())) return pt.r
      if (await handOne(bot, [pg], pt.eye())) { pt.busyUntil.set(pg.id, gameClock.now() + ADMIRE_MS); n++; pt.r.handed3++ }
    }
    // Пополнение (приём спидраннеров «скинуть в яму»): все в загоне разглядывают — второй слиток они не поднимут
    // (PiglinAi.wantsToPickup: золото в левой руке), малышей в загоне нет, снаружи взрослый в 9 бл. (GoToWantedItem 9)
    // — слиток в траншею: он пойдёт за ним и упадёт в загон.
    // Новый взрослый уже упал за прошлой приманкой: можно собирать следующего, пока пойманные заняты золотом.
    if (opts.refill !== false && !n && !free.length && pen.length < (opts.penMax ?? 6) && (gameClock.now() - lastLure > 8000 || pen.length > penAtLure)) {
      const Zc = V(pt.plan.lanes.find(l => l.k === 0).Z).offset(0.5, 0, 0.5)
      const babyIn = [...pt.seenBabies.values()].some(e => inPen(pt.plan, e))
      const lying = (Object.values(bot.entities) as any[]).some(e => e.name === 'item' && e.position && inPen(pt.plan, e) && isIngot(e))
      // За закрытым ртом — только последние увиденные позиции, без живого рентгена.
      const outside = [...pt.seenAdults.values()].filter(e => !inPen(pt.plan, e) && e.free && e.position.distanceTo(Zc) <= 9)
      // Малыш ближе к траншее, чем ближайший взрослый, и в 5 бл. — успеет первым, слиток пропадёт; ждём (s2-lure06:
      // прежнее «малыш в 5 бл.» держало загон на 5–8 при 369–582 ожиданиях).
      const nearestAdult = Math.min(...outside.map(e => e.position.distanceTo(Zc)))
      const babyNear = [...pt.seenBabies.values()].some(e => !inPen(pt.plan, e) && e.position.distanceTo(Zc) <= Math.min(5, nearestAdult + 0.5))
      if (babyNear && !babyIn && !lying && outside.length) pt.r.lureBabyWait = (pt.r.lureBabyWait || 0) + 1
      if (!babyIn && !babyNear && !lying && outside.length) {
        const ta = trenchAim(bot, pt.plan, open, (require('../../drops') as typeof import('../../drops')).blockGetter(bot))
        if (ta && await pt.canContinue() && await PG.tossOut(bot, pt.plan, 'gold_ingot', 1, ta.aim)) { pt.r.lures++; lastLure = gameClock.now(); penAtLure = pen.length }
        else if (!ta) pt.r.lureNoAim = (pt.r.lureNoAim || 0) + 1
      }
    }
    await sleep(n ? 50 : 150)
  }
  pt.r.phases.trade = +((gameClock.now() - tt) / 1000).toFixed(1)
  pt.r.penNow = pt.adults(8).filter(e => inPen(pt.plan, e)).length
  pt.r.babiesInPen = mobs(bot, 'piglin', 8).filter(e => isBaby(bot, e) && inPen(pt.plan, e)).length
  pt.r.ok = true
  return pt.r
}
