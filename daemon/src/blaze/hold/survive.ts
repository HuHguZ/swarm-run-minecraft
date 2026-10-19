'use strict'
// Бой у спавнера — шаги цикла про выживание (прежнее начало тела while в holdSpawner): набрал/время, опыт «ножная
// щель», конец огнестойкости, страж, иссушитель, еда, вердикт safety и отдых, шаг из огня.
import * as gameClock from '../../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from '../../movement'
import { countOf } from '../../items'
import * as survival from '../../combat-safety'
import { log, reachTo, lavaNear, liveBlazes, FOOD_RE, blocksHave } from '../targets'
import { hasEffect, drinkFireResistance } from '../potions'
import { myEye, seesMe } from '../radar'
import { DOOR_SIDES, solidB } from '../post'
import { planKillBox } from '../bunker'
import {
  type HoldState, type Tick, type Turn, fireproof, equipSword, swingFor, setShield, stopWalking, inBunker, doorPoint,
  meleeThreat, foesNow, checkSafety, witherPit, frOnlyBlazes, nofrOnlyBlazes
} from './state'
import { restNow } from './rest'

// Набрал — но ифриты с лучом к нам рядом: под огнестойкостью добить их здесь (до 60 с), а не уходить из навыка под удары —
// выход из боя после «набрал» убивал (s1-LG-3 06.10: 5 стержней на 6-й мин, «закопаться» под ифритами 17 → 2 хп, смерть).
export function stepEnough (hs: HoldState, t: Tick): Turn {
  const { bot, dead, want, deadline, out } = hs
  const { now } = t
  if (countOf(bot, 'blaze_rod') >= want) {
    const pressing = liveBlazes(bot, dead, 8).some(e => seesMe(bot, e))
    if (!pressing || !fireproof(hs) || (bot.health ?? 0) < 6) return 'stop'
    if (!out.clearUntil) { out.clearUntil = now + 60000; log('набрал — добиваю ифритов рядом', { n: liveBlazes(bot, dead, 8).length, hp: Math.round(bot.health ?? 0) }) }
    if (now > out.clearUntil) return 'stop'
  }
  if (now > deadline) { hs.stopped = 'время вышло'; return 'stop' }
}

// shortcut: эксперимент проверяет удары из щели; приманивание и сбор проверяются отдельной сценой.
export async function stepLowWindow (hs: HoldState, t: Tick): Promise<Turn> {
  const { bot, ctx, dead, out, guard, radar, setPhase } = hs
  const { now } = t
  if (!hs.bunker?.lowWindow) return
  if (!inBunker(hs)) { hs.stopped = 'эксперимент: тело вышло из щели'; hs.bail = true; return 'stop' }
  try { bot.pathfinder.setGoal(null) } catch {}
  for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(key, false)
  if (!bot.getControlState('sneak')) { hs.lowWindowCrouchAt = now; bot.setControlState('sneak', true) }
  setPhase('щит у ножной щели')
  const blazes = liveBlazes(bot, dead, 32)
  const intact = solidB(bot.blockAt(hs.bunker.cell.offset(0, -1, 0))) && solidB(bot.blockAt(hs.bunker.cell.offset(0, 2, 0))) &&
    DOOR_SIDES.every(s => [0, 1].every(y => s.equals(hs.bunker.front) && y === 0 || solidB(bot.blockAt(hs.bunker.cell.plus(s).offset(0, y, 0)))))
  const fire = [0, 1].some(y => /fire|lava/.test(bot.blockAt(hs.bunker.cell.offset(0, y, 0))?.name || '')) || !!(bot.entity.metadata?.[0] & 1)
  if (!intact || fire || blazes.some(e => seesMe(bot, e)) || foesNow(hs).some(e => e.name !== 'blaze')) {
    hs.stopped = 'эксперимент: укрытие нарушено, огонь или другой враг'; hs.bail = true; return 'stop'
  }
  if ((bot.health ?? 0) < 19 || (bot.food ?? 20) < 18) {
    const r = await restNow(hs); out.rests.push(r)
    if (!r.rested) { hs.stopped = r.why || 'эксперимент: не вылечился'; hs.bail = true; return 'stop' }
    await equipSword(hs); return 'next'
  }
  await setShield(hs, true, doorPoint(hs))
  const e = blazes.filter(e => (require('../../pick') as typeof import('../../pick')).canHit(bot, e)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
  if (now - hs.lastBeat > 2000) {
    hs.lastBeat = now
    log('ножная щель', { t: Math.round((now - ctx.t0) / 1000), hp: bot.health, food: bot.food, melee: out.melee, hits: out.hits, kills: ctx.kills?.length, rods: countOf(bot, 'blaze_rod'), canHit: !!e, eye: myEye(bot), blocking: guard.blocking(), at: xyz(bot.entity.position) })
  }
  if (gameClock.now() - hs.lowWindowCrouchAt >= 250 && guard.blocking() && !radar.incoming(gameClock.now()).length && e && await swingFor(hs, e)) setPhase('меч из ножной щели')
  if (gameClock.now() - hs.lastSwing > 75000) { hs.stopped = 'эксперимент: 75 с без удара из щели'; return 'stop' }
  await sleep(50)
  return 'next'
}

export async function stepFireResistance (hs: HoldState, t: Tick): Promise<Turn> {
  const { bot, ctx, dead, spawner, out, setPhase } = hs
  if (hs.startedFireproof && !fireproof(hs) && !out.frLostAt) {
    let d = await drinkFireResistance(bot)
    // Эффект приходит отдельным пакетом после глотка — до 4 с (ферма 02.10 neF-blz-4: через 2 с ещё «нет» → зря кончил бой).
    for (let i = 0; i < 40 && d === 'выпил fire_resistance' && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
    // Не подействовало, а зелья ещё есть — ещё раз (D2-25 03.10: 10 зелий в рюкзаке, «новое зелье не подействовало»,
    // бой брошен — следующий вызов шёл «к точке боя» без огнестойкости: удары вплотную, смерть).
    for (let k = 0; k < 2 && !hasEffect(bot, 'fire_resistance') && d === 'выпил fire_resistance'; k++) {
      d = await drinkFireResistance(bot)
      for (let i = 0; i < 40 && d === 'выпил fire_resistance' && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
    }
    log('огнестойкость кончилась', { drank: d, now: hasEffect(bot, 'fire_resistance') })
    if (!fireproof(hs)) {
      // Огнестойкость — плюс к безопасности, не допуск (решение пользователя 06.10 22:33): бой дальше по механике ифрита — щит
      // на залп (радар заряда), меч между залпами, коробка с окном в тишине, отдых в укрытии при малом хп и возврат.
      out.frLostAt = gameClock.now()
      setPhase('бой без огнестойкости')
      if (!hs.bunker && !hs.boxPlan && spawner) {
        const plan = planKillBox(bot, spawner, blocksHave(bot))
        if (!plan.none) { hs.boxPlan = plan; hs.boxTries = 0; hs.boxRetryAt = 0 }
      }
      log('огнестойкость кончилась — бой дальше без неё', { drank: d, hp: Math.round(bot.health ?? 0), box: hs.boxPlan ? xyz(hs.boxPlan.cell) : null })
      if ((bot.health ?? 0) < ctx.restAt || (bot.health ?? 0) < 16 && liveBlazes(bot, dead, 16).filter(e => seesMe(bot, e)).length >= 2) {
        const r = await restNow(hs)
        out.rests.push(r)
        if (!r.rested && (bot.health ?? 0) < 10) { hs.stopped = `огнестойкость кончилась, хп ${Math.round(bot.health ?? 0)}, отдых не вышел: ${r.why || 'нет укрытия'}`; hs.bail = true; return 'stop' }
        await equipSword(hs)
      }
      return 'next'
    }
  }
}

// ND_GUARD=1 (ne-guard): иссушитель/магмовый куб/злой пиглин бьёт или иссушитель вплотную — ответ сразу (столб 3,
// коробка, бой со щитом), а не «бегство» под ударами (B0-26 03.10: под огнестойкостью у помоста — магмовый куб и два
// удара иссушителя за 2 с в «бегстве», refuge не спас).
export async function stepGuard (hs: HoldState, t: Tick): Promise<Turn> {
  const { session, bot, ctl, out } = hs
  if (process.env.ND_GUARD !== '0') {
    const G: typeof import('../../ne-guard') = require('../../ne-guard')
    const h = G.hot(bot)
    if (h) {
      await setShield(hs, false)
      const rr = await G.react(session, ctl, { force: h, sitMs: 15000 })
      if (rr.cancelled || ctl.aborted || session.bot !== bot) { hs.stopped = 'прервано'; return 'stop' }
      if (rr.acted !== false) {
        out.guards = (out.guards || 0) + 1
        log('страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) })
        await equipSword(hs)
        return 'next'
      }
    }
  }
  if (await witherPit(hs)) { await equipSword(hs); return 'next' }
  // Без FR бой держится на отдыхе с едой; еда кончается — закончить заход в толще, а не дойти до «нечем восстановить здоровье»
  // и бега под залпами (s1c-F-9 06.10: без FR 110.9 урона за бой, отдыхи в коробке, еда кончилась — бег, смерть).
  if (!fireproof(hs) && bot.inventory.items().filter(i => FOOD_RE.test(i.name)).reduce((n, i) => n + i.count, 0) <= 2 && (bot.health ?? 20) < 18) {
    hs.stopped = 'без огнестойкости еда кончается — заход заканчиваю в толще'
    hs.bail = true
    return 'stop'
  }
}

// Вердикт safety: отдых вместо ухода, уход, бой под огнестойкостью с малым хп, отдых по запросу, отлёжка без FR.
export async function stepSafety (hs: HoldState, t: Tick): Promise<Turn> {
  const { session, bot, ctl, dead, combat, actions, guard, out } = hs
  const hp = t.hp = bot.health ?? 0
  const risk = checkSafety(hs, 'continue')
  if (risk.action === 'leave' && nofrOnlyBlazes(hs) && !frOnlyBlazes(hs)) {
    out.safety = risk
    const r = await restNow(hs)
    out.rests.push(r)
    log('отдых вместо ухода', { why: risk.reason, ...r })
    if (hs.bail) return 'stop'
    if (!r.rested && (bot.health ?? 0) < 14) { hs.stopped = `${risk.reason}; отдых не вышел: ${r.why || 'нет укрытия'}`; hs.bail = true; return 'stop' }
    await equipSword(hs)
    await guard.wear()
    return 'next'
  }
  if ((risk.action === 'leave' && !frOnlyBlazes(hs)) || risk.action === 'dead') {
    out.safety = risk; hs.stopped = risk.reason; hs.bail = true
    if (risk.action !== 'dead') {
      await setShield(hs, false)
      out.escape = await survival.disengage(session, ctl, () => foesNow(hs))
      if (!out.escape.clear && !ctl.aborted && (bot.health ?? 0) > 0) {
        const enemy = meleeThreat(hs) || foesNow(hs)[0]
        if (enemy) out.escape.cover = await combat.retreat(session, ctl, enemy)
      }
    }
    return 'stop'
  }
  // Под огнестойкостью ифрит опасен только вплотную (3.4 за удар в железе): отдых с «бегством» при 16–19 хп гибелен —
  // уход с помоста, падение, ифриты догоняют (s1-post10 06.10: 3 стержня, «бегство на отдых» при 16.6 хп → 1.5 хп → смерть).
  // Бой со щитом дальше до 5 хп, если вокруг одни ифриты.
  // Запас хп — на удары тех, кто вплотную (3.4 в железе каждый): с толпой у тела порог выше (s1c-B-6 06.10: 4 ифрита рядом,
  // «держу до 5 хп» — 20 → 0 до первого отдыха).
  const nearBlazes = liveBlazes(bot, dead, 3).length
  // S1e: запас — ожидаемый урон, пока убиваем тех, кто вплотную, по одному: удар ифрита вплотную 6 раз в 20 тиков (Blaze ATTACK_DAMAGE 6,
  // BlazeAttackGoal attackTime 20) — 3.4 по железу в секунду с каждого; ифрит 20 хп — 4 удара мечом на откате 0.625 с ≈ 2.5 с. С n
  // вплотную — 3.4·2.5·n(n+1)/2 (+4 на отход в яму): 1 — 12.5 хп, 2 — 29.5 (держать нельзя). Было 3.4·n + 2 (5.4 / 8.8): тело
  // доходило до 2–6 хп, и отход уже не успевал (s1e-K4-4, K4-7). ND_FR_HOLD=0 — прежнее.
  const holdNeed = process.env.ND_FR_HOLD === '0' ? Math.max(5, 3.4 * nearBlazes + 2) : 3.4 * 2.5 * nearBlazes * (nearBlazes + 1) / 2 + 4
  const holdUnderFr = fireproof(hs) && hp >= holdNeed && foesNow(hs).every((e: any) => e.name === 'blaze')
  // Под FR с малым хп — поесть, когда вплотную никого (отдых с уходом гибелен: s1-LA-3 06.10 — 4 стержня, «хп 7, укрытие
  // не позволило», убежище «CORNERED» → смерть). Порог боя со щитом — 5 хп (был 9).
  if (holdUnderFr && hp < 14 && (bot.food ?? 20) < 20 && !liveBlazes(bot, dead, 4).some(e => reachTo(bot, e) <= 2.6) && gameClock.now() - (out.frEatAt || 0) > 4000) {
    out.frEatAt = gameClock.now()
    await setShield(hs, false)
    try { await actions.eat(session, {}); out.frEats = (out.frEats || 0) + 1 } catch {}
    await equipSword(hs)
    return 'next'
  }
  if (risk.action === 'recover' && holdUnderFr && gameClock.now() - (out.frHoldLogAt || 0) > 5000) { out.frHoldLogAt = gameClock.now(); out.frHolds = (out.frHolds || 0) + 1; log('отдых отложен: огнестойкость, вокруг одни ифриты', { hp: Math.round(hp) }) }
  if (risk.action === 'recover' && !holdUnderFr) {
    out.safety = risk
    const r = await restNow(hs)
    out.rests.push(r)
    log('отдых', r)
    // Отдых «не завершён», а хп уже 14+ (neF-e2e-3 02.10: «хп 20, не восстановился» — заход кончился на 1 стержне):
    // бой дальше; конец захода — только когда хп так и осталось низким.
    if (!r.rested && (bot.health ?? 0) < 14) { hs.stopped = `хп ${Math.round(bot.health ?? 0)}, не восстановился: ${r.why || r.cover || 'нет безопасного отдыха'}`; hs.bail = true; return 'stop' }
    await equipSword(hs)
    await guard.wear()
    return 'next'
  }
  // Без огнестойкости под лучами двух и больше ифритов урон за секунды — шары, горение, удары вплотную (s1c-B-3 06.10: FR
  // кончилась на 17 хп при 5 ифритах, 18 → 3 за 2 с; в толщу — поздно). Порог отлёжки в толще — 16 хп, а не общий 12.
  if (!fireproof(hs) && hp < 16 && gameClock.now() - (out.nofrRestAt || 0) > 5000 &&
      liveBlazes(bot, dead, 16).filter(e => seesMe(bot, e)).length >= 2) {
    out.nofrRestAt = gameClock.now()
    const r = await restNow(hs)
    out.rests.push(r)
    log('отдых без FR под ифритами', { hp: Math.round(hp), ...r })
    if (hs.bail) return 'stop'
    if (!r.rested && (bot.health ?? 0) < 12) { hs.stopped = `хп ${Math.round(bot.health ?? 0)} без огнестойкости, отдых не вышел: ${r.why || 'нет укрытия'}`; hs.bail = true; return 'stop' }
    await equipSword(hs)
    return 'next'
  }
}

// Огонь под ногами: шар, пролетевший мимо, поджигает клетку у места
// удара (SmallFireball.onHitBlock), и тело в ней горит 8 с (FireBlock.
// entityInside). Замер 8: 7 хп огня без единого попадания шара. Шаг на
// соседнюю клетку без огня — раньше щита.
export async function stepOutOfFire (hs: HoldState, t: Tick): Promise<Turn> {
  const { bot, out, setPhase } = hs
  {
    const feet = bot.entity.position.floored()
    const inFire = [feet, feet.offset(0, 1, 0)].some(q => { const b = bot.blockAt(q); return b && /fire/.test(b.name) })
    if (inFire) {
      const { standable }: typeof import('../../walkable') = require('../../walkable')
      const to = DOOR_SIDES.map(d => feet.plus(d)).find(q => standable(bot, q) && !lavaNear(bot, q, 1) &&
        ![q, q.offset(0, 1, 0)].some(c => { const b = bot.blockAt(c); return b && /fire/.test(b.name) }))
      if (to) {
        await setShield(hs, false)
        setPhase('из огня')
        out.fireSteps = (out.fireSteps || 0) + 1
        try { bot.pathfinder.setGoal(new goals.GoalBlock(to.x, to.y, to.z)) } catch {}
        await sleep(400)
        stopWalking(hs)
        return 'next'
      }
    }
  }
}
