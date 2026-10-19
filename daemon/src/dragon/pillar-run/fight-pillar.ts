'use strict'
// Бой с драконом (fightDragon) — шаг оборота «станция у столба» (ctl.pillarMode, только кровати): сперва отбиться от
// эндермена, ранний кристалл, меч из чаши без кроватей, постройка столба, вход в чашу, цепочка кроватей на снижении.
import {
  gameClock, Vec3, sleep, dragonOf, phaseOf, PHASE, SITTING, isAirish, envv, runnerOn, pillarTriesMax, PILLAR_BAD
} from '../dig-down-to'
import { hunters, doing, r1, podiumTop } from '../fall-guard'
import { countOf } from '../evade-raw'
import { pillarPlanAutoAsync } from '../station-plan'
import { approachFar, RUN_SWORD, stationBedPlaced, runnerPlan, pillarPlan, pillarKey } from '../pillar-plan'
import { fightEnderman } from './walk'
import { earlyCrystalStep } from './crystals'
import { runnerSword } from './sword'
import { pillarBuild, pillarEnter } from './pillar-build'
import { pillarRun } from './runner'
import { type Fight, type FightTick, type Turn } from './fight-state'

// Станция у столба (ctl.pillarMode): строится, пока дракон далеко; на каждом снижении — цепочка кроватей.
export async function fightPillar (fx: Fight, t: FightTick): Promise<Turn> {
  const { session, ctl, rep, stats, bot, track, feed, d } = fx
  const { ph, hp } = t
  if (ctl.bedsOnly && ctl.pillarMode) {
    // 02.10 (rs6-s3, смерть): эндермен бил 10 раз за 9 с, пока бот снова и снова входил в чашу (pillar:enter): вход
    // отказывал «эндермен бьёт», а ветка станции стоит раньше отбоя (п. 2 ниже) — до него цикл не доходил. Сперва отбиться.
    const pest: any = hunters(bot, 4).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (pest && ph !== PHASE.LANDING) {
      if (ctl.trace) ctl.trace.ev('pestFirst', { ph, hp: r1(bot.health), at: [r1(pest.position.x), r1(pest.position.y), r1(pest.position.z)] })
      await fightEnderman(session, ctl, stats, pest, () => { const p2 = phaseOf(bot, dragonOf(bot)); return p2 === PHASE.LANDING })
      await sleep(50)
      return 'next'
    }
    if (await earlyCrystalStep(session, ctl, stats, d, ph)) return 'next'
    // R: кровати кончились, дракон снижается или сидит — меч из чаши (runnerSword, ND_RUN_SWORD=1), раз на посадку
    if (RUN_SWORD() && ctl.pillar && ctl.pillar.built && ctl.pillar.plan && ctl.pillar.plan.runner && countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl) &&
        (ph === PHASE.LANDING || SITTING.has(ph)) && hp != null && hp > 0 && bot.health >= 10) {
      const key = d.id + ':' + fx.ocLandStart
      if (ctl.swordKey !== key) { ctl.swordKey = key; ctl.swordN = 0 }
      // выход по опасности прогноза («R: голова/шея/крыло») — снова, когда пройдёт (до 6 входов на посадку)
      if (ctl.swordN < 6 && ctl.swordDone !== key) {
        ctl.swordN++
        doing(ctl, 'pillar:sword')
        const f = await runnerSword(session, ctl, stats, track, feed, ctl.pillar.plan)
        if (ctl.trace) ctl.trace.ev('runnerSword', f)
        ;(rep.dragon.sword || (rep.dragon.sword = [])).push({ hits: f.hits, by: f.by, hp0: f.hp0, hpMin: f.hpMin, why: f.why })
        if (!/^R: /.test(f.why || '')) ctl.swordDone = key
        else await sleep(150)
        return 'next'
      }
    }
    const far = ph === PHASE.HOLDING || ph === PHASE.STRAFE || ph === PHASE.CHARGING || (ph === PHASE.APPROACH && approachFar(d))
    const nearC = Math.hypot(bot.entity.position.x - 0.5, bot.entity.position.z - 0.5) < 30
    // не чаще раза в 2.5 с (pil5-28: 6 попыток за 3 с у облака — и больше ни одной за бой)
    if ((!ctl.pillar || !ctl.pillar.built) && far && nearC && (ctl.pillarTries || 0) < pillarTriesMax() && gameClock.now() >= (ctl.pillarNext || 0) && (runnerOn() || countOf(bot, /^(obsidian|crying_obsidian)$/) >= 1) && !hunters(bot, 6).length && bot.health >= 12) {
      ctl.pillarTries = (ctl.pillarTries || 0) + 1
      ctl.pillarNext = gameClock.now() + 2500
      const P0 = podiumTop(bot)
      const tP = gameClock.now()
      // план — заново на каждую попытку (hb6: план «на весь бой» устаревал после частичной стройки и окопа —
      let pp = null; let rNo = null
      // 03.10 (rs18-s8, ca1-s8: «мало обсидиана» до конца боя): план R недостроен (часть обсидиана уже стоит) — продолжать его же:
      // новый расчёт с этими блоками в мире выбирал другой план (seen 0.84 → 0.76), а на его клетки обсидиана в рюкзаке не хватало.
      const partial = ctl.partialPlan
      if (partial && P0 === partial.P0 && runnerOn()) {
        const okObs = (partial.pp.cells || []).filter(c => /obsidian/.test(c[3])).every(c => { const b = bot.blockAt(new Vec3(c[0], c[1], c[2])); return b && (/obsidian/.test(b.name) || isAirish(b)) })
        if (okObs) pp = partial.pp; else ctl.partialPlan = null
      }
      if (!pp && P0 != null && runnerOn() && (ctl.runnerNull || 0) < 2) { pp = runnerPlan(bot, P0); if (!pp) { ctl.runnerNull = (ctl.runnerNull || 0) + 1; rNo = runnerPlan.why } }
      if (P0 != null && !pp && (envv('ND_RUNNER') !== '1' || (ctl.runnerNull || 0) >= 2)) pp = await pillarPlanAutoAsync(bot, P0, PILLAR_BAD ? (ctl.pillarBad || (ctl.pillarBad = new Map())) : null)
      if (ctl.trace) ctl.trace.ev('pillarPlan', pp ? { ms: gameClock.now() - tP, R: !!pp.runner, try: ctl.pillarTries, H: [pp.H.x, pp.yb, pp.H.z], F: [pp.F.x, pp.F.z], B: [pp.B.x, pp.feet.y, pp.B.z], dig: pp.dig, nObs: pp.nObs, seen: pp.seen, n: (pillarPlan.all || []).length, ...(rNo ? { rNo } : {}) } : { ms: gameClock.now() - tP, no: rNo || pillarPlan.why, P: P0 })
      if (pp) {
        doing(ctl, 'pillar:build')
        const rb = await pillarBuild(session, ctl, stats, pp)
        if (pp.runner && rb && !rb.ok) {
          const placedObs = (pp.cells || []).filter(c => /obsidian/.test(c[3]) && /obsidian/.test((bot.blockAt(new Vec3(c[0], c[1], c[2])) || {}).name || '')).length
          if (placedObs > 0) ctl.partialPlan = { pp, P0 }
        } else if (rb && rb.ok) ctl.partialPlan = null
        // ждали дракона (садится / не кружит) — не попытка: столбик для опоры над столбом ставится только пока кружит
        if (rb && !rb.ok && /дракон|опасно/.test(rb.why || '')) ctl.pillarTries--
        else if (PILLAR_BAD && rb && !rb.ok && !/эндермен|мало хп/.test(rb.why || '')) ctl.pillarBad.set(pillarKey(pp), (ctl.pillarBad.get(pillarKey(pp)) || 0) + 1)
      }
      return 'next'
    }
    if (ctl.pillar && ctl.pillar.built && ph === PHASE.APPROACH) {
      doing(ctl, 'pillar:enter')
      await pillarEnter(session, ctl, ctl.pillar.plan)
      await sleep(50)
      return 'next'
    }
    if (ctl.pillar && ctl.pillar.built && ph === PHASE.LANDING) {
      const key = d.id + ':' + fx.ocLandStart
      if (key !== ctl.pillarKey) {
        ctl.pillarKey = key
        await pillarRun(session, ctl, stats, track, feed)
        return 'next'
      }
    }
  }
}
