'use strict'
// Бой с драконом (fightDragon) — шаги оборота: опасность и эндермены, здоровье, запасы (вода, эндерняк), станция
// кроватей у фонтана, бой без станции (меч сидящему, кристаллы, место у портала, стрелы, ожидание).
import {
  gameClock, findItem, FILLER_RE, sleep, CENTER, stepTo, dragonOf, phaseOf, PHASE, digDownTo, SITTING
} from '../dig-down-to'
import { hunters, doing, pickSpot, nearPillar, overCloud, crystalsOf, nearEdge } from '../fall-guard'
import { dangerAt, countOf, evade, lookAtSafe } from '../evade-raw'
import { waterToHotbar, onSpike, getDown, onOwnPillar, tidy, bedHere, rangedShot, chooseStation } from '../station-plan'
import { headPoint } from '../pillar-plan'
import { sitRec, blindKnown, hazardNow } from './sight-zones'
import { refillBucket, walkTo, heal, clearOfClouds, hideAndHeal, fightEnderman } from './walk'
import { perchAttack } from './perch'
import { destroyCrystals, mineEndStone } from './crystals'
import { type Fight, type FightTick, type Turn } from './fight-state'
import { stationStep } from './station'

export async function fightSurvive (fx: Fight, t: FightTick): Promise<Turn> {
  const { session, ctl, rep, stats, bot } = fx
  const { ph, ctx } = t
  const me = t.me = bot.entity.position
  // 1. Опасность под ногами — отойти.
  const bad = dangerAt(bot, me, ctx)
  if (bad) { await evade(bot, ctl, stats, { ...bad, ctx }); return 'next' }
  // 2. Злой эндермен (бил нас) — отбиться; посадку не бросать ради него,
  // если кровать у головы уже ждёт.
  const angry = hunters(bot, 3.5).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
  const window = t.window = SITTING.has(ph) || ph === PHASE.LANDING || ph === PHASE.TAKEOFF
  if (angry && !(window && fx.st && bedHere(bot, fx.st))) {
    await fightEnderman(session, ctl, stats, angry, () => {
      const p2 = phaseOf(bot, dragonOf(bot))
      return !!fx.st && (p2 === PHASE.LANDING || SITTING.has(p2)) && bedHere(bot, fx.st)
    })
    await sleep(50)
    return 'next'
  }
  // 3. Здоровье. Есть — 1.6 с: в окне посадки у готовой кровати не есть,
  // если хп терпит (станция держит облако огня выше нас).
  const busy = t.busy = window && fx.st && bedHere(bot, fx.st)
  // Стоим на блоке над облаком (рефлекс или «на блок» подняли) — не сходить
  const perched = t.perched = overCloud(bot)
  if (perched) stats.overCloud = (stats.overCloud || 0) + 1
  if (!perched && !window && onSpike(bot)) { await getDown(session, ctl, stats); return 'next' }
  {
    const pil = onOwnPillar(bot)
    if (pil) {
      doing(ctl, 'pillar:down')
      if (ctl.trace) ctl.trace.ev('pillarDown', { n: pil.n, gy: pil.gy })
      await digDownTo(bot, ctl, pil.gy, pil.n + 2)
      return 'next'
    }
  }
  if (bot.health <= 7 && !window && !perched) { await hideAndHeal(session, ctl, rep, stats, { until: 16 }); return 'next' }
  if (bot.health <= 14 && !window && !perched) await clearOfClouds(session, ctl, stats)
  if ((bot.health <= 14 || bot.food < 16) && !(busy && bot.health > 8)) await heal(session, ctl, rep, stats, { hard: bot.health <= 14 })
}

export async function fightSupplies (fx: Fight, t: FightTick): Promise<Turn> {
  const { session, ctl, stats, bot } = fx
  const { window, perched } = t
  // 4. Кровати. Пока летает — заранее построенная станция у фонтана (не
  if (!window) fx.dyn = null
  // Блоков на станцию (10) и заслоны нет — наломать эндерняка, пока летает.
  const lowBlocks = countOf(bot, FILLER_RE) < (ctl.beds && countOf(bot, /_bed$/) > 0 ? 14 : 6)
  if (!bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket') && findItem(bot, /^water_bucket$/)) await waterToHotbar(bot)
  if (!window && !perched && gameClock.now() >= fx.refillAt && !findItem(bot, /^water_bucket$/) && findItem(bot, /^bucket$/)) {
    fx.refillAt = gameClock.now() + 20000
    await refillBucket(session, ctl, stats)
    return 'next'
  }
  if (lowBlocks && !window && !perched && gameClock.now() >= fx.mineRetry && findItem(bot, /_pickaxe$/)) {
    const got = await mineEndStone(session, ctl, 20, stats)
    if (got < 4) fx.mineRetry = gameClock.now() + 30000
    return 'next'
  }
}

export async function fightStation (fx: Fight, t: FightTick): Promise<Turn> {
  const { session, ctl, rep, stats, bot, track, d } = fx
  const { ph, window } = t
  if (ctl.beds && countOf(bot, /_bed$/) > 0 && countOf(bot, FILLER_RE) > 0) {
    if (!fx.st && !window && gameClock.now() >= fx.stationRetry) {
      fx.st = chooseStation(bot, fx.stFails)
      if (!fx.st) {
        stats.stationNone = chooseStation.why
        fx.stationRetry = gameClock.now() + 5000
      } else {
        stats.stations = (stats.stations || 0) + 1
        if (ctl.trace) ctl.trace.ev('station', { key: fx.st.key, B: [fx.st.B.x, fx.st.B.y, fx.st.B.z], yb: fx.st.yb, g: fx.st.g, place: fx.st.place.length })
      }
    }
    // 25 тиков без рёва (Sensing у дракона не очищается — EnderDragon.aiStep
    const blind = ph === PHASE.SCANNING && blindKnown(sitRec)
    let use = window ? fx.dyn : fx.st
    // Поправка по замеру (e2e10, 2026-09-26): к игроку на B (11 блоков от
    const settled = ph === PHASE.ROARING || ph === PHASE.FLAMING || blind
    if (window && !use && fx.st) {
      const near = headPoint(bot, d, track, 0).distanceTo(fx.st.blast) <= 4.5
      if (near || ph === PHASE.LANDING || ph === PHASE.TAKEOFF || (SITTING.has(ph) && !settled)) use = fx.st
    }
    // Без станции у головы — perchAttack (видящему — кровать или меч; слепому —
    if (window && !use && SITTING.has(ph)) { await perchAttack(session, ctl, rep, stats, track); await sleep(50); return 'next' }
    if (use) {
      const r = await stationStep(session, ctl, rep, stats, track, use, d, ph)
      if (r === 'далеко') {
        // Голова ушла от станции (довернулся) — собрать заново под ней.
        stats.stationFar = (stats.stationFar || 0) + 1
        if (use === fx.dyn) fx.dyn = null
        else if (SITTING.has(ph)) fx.dyn = null
        return 'next'
      }
      if (r === 'fail') {
        if (use === fx.st) {
          fx.stFails.set(fx.st.key, (fx.stFails.get(fx.st.key) || 0) + 1)
          if (ctl.trace) ctl.trace.ev('stationFail', { key: fx.st.key })
          fx.st = null
        } else fx.dyn = null
        return 'next'
      }
      // Станция под облаком — обычный бой (лук, уход от угроз) поодаль.
      if (r !== 'готово' && r !== 'облако') return 'next'
    }
  }
}

export async function fightFlying (fx: Fight, t: FightTick): Promise<Turn> {
  const { session, ctl, rep, stats, bot, track, d, deadline } = fx
  const { ph, parts, me, window, perched } = t
  const stationed = !!fx.st && ctl.beds && countOf(bot, /_bed$/) > 0
  // 5. Без станции: сидит — к голове с мечом (только видящий, см. perchAttack).
  if (!stationed && SITTING.has(ph)) { await perchAttack(session, ctl, rep, stats, track); await sleep(50); return 'next' }
  // Кристалл на обелиске ещё жив (не сбили в начале) — снова за ним, пока
  // дракон летает: иначе он лечит дракона на 2 хп/с (d5-17, d5-22).
  if (!window && !perched && gameClock.now() >= fx.crystalRetry && crystalsOf(bot).some(c => c.pillar)) {
    fx.crystalRetry = gameClock.now() + 60000
    stats.crystalRetry = (stats.crystalRetry || 0) + 1
    if (ctl.trace) ctl.trace.ev('crystalRetry', { left: crystalsOf(bot).filter(c => c.pillar).length })
    await destroyCrystals(session, ctl, rep, stats, { deadline: Math.min(deadline, gameClock.now() + 150000) })
    return 'next'
  }
  // 6. Летает: без станции — держаться у портала в 10–16 блоках.
  const fromC = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
  // Садится, сидит, взлетает — не возвращаться к фонтану (там его крылья и
  // коридор взлёта): отошли от них — там и стоять до конца посадки.
  if (!stationed && !window && !perched && (fromC > 18 || fromC < 7 || nearEdge(bot, me, 2))) {
    const spot = pickSpot(bot, CENTER, { rMin: 9, rMax: 14, avoid: f => nearPillar(bot, f, 2) })
    doing(ctl, 'fight:reposition')
    if (spot) {
      if (spot.feet.distanceTo(me) > 8) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 12000 })
      else await stepTo(bot, ctl, spot.feet, { ms: 2500, stopAt: 0.5 })
    } else await sleep(200)
    return 'next'
  }
  const hazardSoon = () => !!hazardNow(bot)
  // 7. Стрелы по летящему (сидящему — без толку: onHurt → 0).
  if (!window && gameClock.now() - fx.lastShot > 300 && countOf(bot, /arrow$/) > 0) {
    const dist = d.position.distanceTo(me)
    const good = dist < 44 && (ph === PHASE.STRAFE || ph === PHASE.CHARGING || ph === PHASE.APPROACH || dist < 30)
    if (good && !hazardSoon()) {
      doing(ctl, 'fight:shoot')
      await rangedShot(session, ctl, stats, track, d, hazardSoon)
      fx.lastShot = gameClock.now()
      return 'next'
    }
  }
  // Пока ждём — смотреть на дракона (но не в глаза эндерменам) и есть.
  if (bot.food < 18 && !window) await tidy(session, ctl, rep, stats)
  await lookAtSafe(bot, parts.bodyC)
  await sleep(100)
}
