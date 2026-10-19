'use strict'
// Бой у спавнера — начало захода (прежнее начало try в holdSpawner): готовность к бою, коробка с окном или шалаш,
// ход к точке боя. Итог — объект для немедленного возврата из holdSpawner или undefined (бой дальше).
import { sleep, xyz } from '../../movement'
import { itemNamed } from '../../items'
import { canUseRanged } from '../../play-policy'
import * as survival from '../../combat-safety'
import { log, liveBlazes, blocksHave, arrowsHave } from '../targets'
import { walkNear } from '../approach'
import { choosePost } from '../post'
import { planBunker, planKillBox, buildBunker } from '../bunker'
import { type HoldState, p0, equipSword, foesNow, checkSafety, refreshReach, witherPit, fireproof, frOnlyBlazes, nofrOnlyBlazes } from './state'
import { restNow } from './rest'

export async function startHold (hs: HoldState) {
  const { session, bot, ctl, ctx, spawner, guard, out, setPhase } = hs
  await equipSword(hs)
  await guard.wear()
  await witherPit(hs)
  hs.home = bot.entity.position.floored()
  refreshReach(hs)
  // Позвали с малым хп (прошлый вызов кончился на 2–3 хп): сначала поесть и
  // отлежаться (замер 35: второй вызов на 2 хп — смерть через 1 с по дороге
  // «к точке боя», горел).
  const preparation = checkSafety(hs, 'start')
  out.safety = preparation
  if ((preparation.action === 'leave' && !frOnlyBlazes(hs) && !(nofrOnlyBlazes(hs) && (bot.health ?? 0) >= 14)) || preparation.action === 'dead') {
    setPhase('отказ от неподготовленного боя')
    out.safety = preparation
    if (preparation.action !== 'dead') out.escape = await survival.disengage(session, ctl, () => foesNow(hs))
    return { ...out, stopped: preparation.reason, bail: true }
  }
  if (preparation.action === 'recover' && !ctl.aborted) {
    const r = await restNow(hs)
    out.rests.push({ ...r, atStart: true })
    log('отдых до боя', r)
    if (!r.rested) return { ...out, stopped: r.why || 'не восстановился до боя', bail: true }
  }
  if (spawner && p0(ctx).clearSpawner !== false && process.env.ND_BLAZE_CLEAR !== '0') (require('../../blaze-clear') as typeof import('../../blaze-clear')).observe(bot, spawner)
  const built = await buildShelter(hs)
  if (built) return built
  await goToPost(hs)
}

// --- шалаш
// Шалаш — по желанию (bunker: true): замер 7 — из-под крыши видно только
// до 37° вверх, блейзы у спавнера висят выше и за минуту не показались ни
// разу; открытый бой с точки обзора дал 5 стержней за 77 с (замер 3).
async function buildShelter (hs: HoldState) {
  const { session, bot, ctl, ctx, spawner, out, setPhase } = hs
  if (spawner && !fireproof(hs) && p0(ctx).box !== false && p0(ctx).bunker !== true) {
    // Без лука и стрел коробка — ближняя, под меч (2 бл. от спавнера): к дальнему окну ифриты не подлетают, «стрелы кончились»
    // (blz-lsb-7/blz-std-5 14.10: коробка в 3–7.5 бл. без лука — 0 убийств, смерть). Ревью Codex 14.10.
    const ranged = itemNamed(bot, 'bow') && arrowsHave(bot) > 0 && canUseRanged(session, { name: 'blaze' }, p0(ctx))
    const plan = planKillBox(bot, spawner, blocksHave(bot), ranged ? {} : { hMin: 1.4, hMax: 3.2, hBest: 2, lowWindow: p0(ctx).lowWindow === true })
    if (plan.none) {
      out.bunker = { built: false, kind: 'окно', why: 'места под коробку с окном нет', tried: plan.tried }
      if (p0(ctx).lowWindow === true) return { ...out, stopped: 'эксперимент: места под щель нет', bail: true }
    } else {
      setPhase('коробка с окном')
      const b = await buildBunker(session, ctl, plan, setPhase)
      out.bunker = { built: b.ok, kind: plan.lowWindow ? 'ножная щель' : 'окно', cell: xyz(plan.cell), front: xyz(plan.front), h: plan.h, seen: plan.seen, placed: b.placed, open: b.open, roofed: b.roofed, failed: b.failed, why: b.why }
      if (b.ok) hs.bunker = { cell: plan.cell, front: plan.front, window: true, win: plan.win, lowWindow: plan.lowWindow }
      else if (plan.lowWindow) return { ...out, stopped: 'эксперимент: щель не построена', bail: true }
      else hs.boxPlan = plan
    }
    log('коробка с окном', out.bunker)
  }
  if (spawner && !fireproof(hs) && p0(ctx).bunker === true) {
    const plan = planBunker(bot, spawner, blocksHave(bot))
    if (plan.none) {
      out.bunker = { built: false, why: 'места под шалаш нет', tried: plan.tried }
    } else {
      const b = await buildBunker(session, ctl, plan, setPhase)
      out.bunker = { built: b.ok, cell: xyz(plan.cell), front: xyz(plan.front), h: plan.h, seen: plan.seen, placed: b.placed, open: b.open, roofed: b.roofed, failed: b.failed, why: b.why }
      // Без крыши шалаш хуже открытого боя: сверху (до 7 блоков над глазами) видят
      // в клетку со всех сторон.
      if (b.ok) hs.bunker = { cell: plan.cell, front: plan.front }
    }
    log('шалаш', out.bunker)
  }
}

// Без шалаша — точка боя с видом на куб спавна.
async function goToPost (hs: HoldState) {
  const { session, bot, ctl, dead, spawner, out, setPhase } = hs
  if (!hs.bunker && spawner) {
    const post = choosePost(bot, spawner)
    // Ифриты уже вплотную — бой с места, а не ход к точке: по дороге (3.6 бл.) тело не отвечало и получило 10 ударов
    // (s1-post06 06.10: 32 урона в фазе «к точке боя», смерть до первого взмаха). Основной цикл бьёт тех, кто в досягаемости.
    const pressed = liveBlazes(bot, dead, 5).length
    if (post && pressed) log('точка боя: ифриты вплотную — бьюсь с места', { pressed, post: xyz(post.pos) })
    if (post && !pressed) {
      out.post = { ...xyz(post.pos), h: post.h, view: post.view, cover: post.cover, edge: post.edge }
      setPhase('к точке боя')
      // Под охраной (nether.guarded): ударили по дороге — ответ обидчику, потом снова к точке. neF-fB25-1 02.10: магмовые
      // кубы 9 ударов (12.5 хп) за 12 с ходьбы без ответа, затем блейзы — смерть до первого выстрела.
      // Ифрит догнал вплотную или −4 хп по дороге — ход бросить, бой с места (основной цикл: щит и меч по тем, кто в
      // досягаемости). sr-l-3 10.10: 8 ударов вплотную по 3.4 «к точке боя», смерть до первого взмаха.
      const hp0 = bot.health ?? 20
      const pressedNow = () => liveBlazes(bot, dead, 3.5).length > 0 || (bot.health ?? 20) < hp0 - 4
      for (let k = 0; k < 3 && !ctl.aborted && !pressedNow(); k++) {
        let done = false
        const w = await (require('../../nether') as typeof import('../../nether')).guarded(session, ctl, sub => Promise.race([
          walkNear(bot, sub, post.pos, 0, 12000).finally(() => { done = true }),
          (async () => { while (!done && !sub.aborted) { if (pressedNow()) { try { bot.pathfinder.setGoal(null) } catch {} return { pressed: true } } await sleep(100) } return {} })()
        ])).catch(() => ({}))
        if (w && w.pressed) { log('к точке боя: догнали — бьюсь с места', { hp: Math.round(bot.health ?? 0), near: liveBlazes(bot, dead, 3.5).length }); break }
        if (!w || !w.fought) break
      }
      hs.home = post.pos
    }
    log('точка боя', out.post || { none: true })
  }
}
