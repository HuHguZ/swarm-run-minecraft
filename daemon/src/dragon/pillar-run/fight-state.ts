'use strict'
// Бой с драконом (fightDragon, dragon/pillar-run/fight.ts) — состояние боя и мелочи над ним. Прежние let замыкания
// fightDragon — поля объекта fx (Fight), прежние active/pause/lookFor — функции с fx первым аргументом. Оборот цикла боя —
// шаги fight-steps, fight-pillar, fight-beds: шаг возвращает 'next' (следующий оборот), 'stop' (конец цикла) или ничего.
import {
  gameClock, cloudsOf, dbg, sleep, CENTER, yieldTick, dragonOf, phaseOf, PHASE, SITTING, partsOf, PHASE_RU, hpOf, fireballsOf, makeTrack
} from '../dig-down-to'
import { doing, pickSpot, breathOf } from '../fall-guard'
import { portalBlocks, noteTakeoff, takeoffSeen } from '../pillar-plan'
import { dragonZones } from './sight-zones'
import { walkTo } from './walk'
import { makeDragonFeed } from './feed'

export type Turn = 'next' | 'stop' | undefined

export interface Fight {
  session: any
  ctl: any
  rep: any
  stats: any
  deadline: number
  perches: number
  bot: any
  track: any
  feed: any
  ocLandKey: any
  ocLandStart: number
  ocPrevPh: any
  d: any
  hpLog: number[]
  lastPhase: any
  lastShot: number
  won: boolean
  // Станция кроватей: ось, число неудач по осям, когда пробовать снова.
  st: any
  dyn: any
  stFails: Map<any, number>
  stationRetry: number
  // Когда дракон последний раз поворачивался (голова «встала» — можно
  // собирать станцию под ней).
  yawWas: any
  yawSince: number
  sitStart: number
  mineRetry: number
  refillAt: number
  crystalRetry: number
}

// Значения одного оборота (прежние const тела while): фаза, хп, части и зоны дракона, кровати, окно посадки, где мы.
export interface FightTick {
  ph?: any
  hp?: any
  parts?: any
  z?: any
  ctx?: any
  bedsN?: number
  finish?: boolean
  keepBeds?: boolean
  builtPl?: any
  holdPh?: boolean
  inTrench?: boolean
  holdOut?: boolean
  me?: any
  window?: boolean
  busy?: any
  perched?: any
  bedsSpent?: boolean
  finishBow?: boolean
}

export function openFight (session, ctl, rep, stats, deadline, perches): Fight {
  const bot = session.bot
  const track = makeTrack(bot)
  const feed = ctl.feed || (ctl.feed = makeDragonFeed(bot))
  feed.onSit = o => { if (ctl.trace) ctl.trace.ev('ocSit', o) }
  return { session, ctl, rep, stats, deadline, perches, bot, track, feed, ocLandKey: null, ocLandStart: 0, ocPrevPh: null } as Fight
}

// Дракон найден — счётчики боя (прежние let после первого поиска).
export function armFight (fx: Fight) {
  fx.hpLog = []
  fx.lastPhase = null
  fx.lastShot = 0
  fx.won = false
  fx.st = null
  fx.dyn = null
  fx.stFails = new Map()
  fx.stationRetry = 0
  fx.yawWas = null
  fx.yawSince = gameClock.now()
  fx.sitStart = 0
  fx.mineRetry = 0
  fx.refillAt = 0
  fx.crystalRetry = gameClock.now() + 20000
  fx.stats.perchCount = fx.stats.perchCount || 0
}

export function fightActive (fx: Fight) {
  const { session, ctl, bot } = fx
  return !ctl.aborted && session.bot === bot && bot.isAlive !== false && bot.health > 0 && /end/.test(bot.game.dimension)
}

export function fightPause (fx: Fight, ms) {
  return new Promise<void>(resolve => {
    let timer; let poll
    const done = () => { gameClock.clearTimeout(timer); gameClock.wall.clearInterval(poll); resolve() }
    timer = gameClock.setTimeout(done, ms)
    // Game time can stop after disconnect; lifecycle cancellation must still finish.
    poll = gameClock.wall.setInterval(() => { if (!fightActive(fx) || gameClock.now() >= fx.deadline) done() }, 50)
  })
}

// «Не видно» — ещё не «убит»: убит, только если выходной портал горит. Иначе
export async function fightLookFor (fx: Fight, ms) {
  const { session, ctl, bot, track, deadline } = fx
  const t0 = gameClock.now()
  let dd = track.tick()
  while (!dd && fightActive(fx) && gameClock.now() - t0 < ms && gameClock.now() < deadline) {
    // A missing island must still let disconnect, death and clock packets run.
    await yieldTick()
    if (!fightActive(fx) || gameClock.now() >= deadline || gameClock.now() - t0 >= ms) break
    if (portalBlocks(bot).length) return null
    doing(ctl, 'fight:search')
    const m = bot.entity.position
    if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) > 18) {
      const spot = pickSpot(bot, CENTER, { rMin: 8, rMax: 16 })
      if (spot) await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 20000 })
      else await fightPause(fx, 500)
    } else await fightPause(fx, 500)
    if (!fightActive(fx)) return null
    dd = track.tick()
  }
  return dd
}

// Дракон в прорисовке (пропал — поиск или победа), фаза и хп в итог, зоны дракона на этот оборот.
export async function fightTrack (fx: Fight, t: FightTick): Promise<Turn> {
  const { rep, stats, bot, track, perches, hpLog } = fx
  const d = fx.d = track.tick()
  if (!d) {
    // Исчез после «умирает» — победа. Иначе улетел из прорисовки.
    if (fx.lastPhase === PHASE.DYING) { fx.won = true; return 'stop' }
    await fightPause(fx, 250)
    if (!fightActive(fx)) return 'stop'
    if (!dragonOf(bot) && fx.lastPhase === PHASE.DYING) { fx.won = true; return 'stop' }
    if (!dragonOf(bot) && !(await fightLookFor(fx, 30000))) {
      if (!fightActive(fx)) return 'stop'
      if (portalBlocks(bot).length) { fx.won = true; return 'stop' }
      rep.dragon.lost = 'дракона не видно 30 с, выходной портал не горит'
      return 'stop'
    }
    return 'next'
  }
  const ph = t.ph = phaseOf(bot, d)
  const hp = t.hp = hpOf(bot, d)
  if (fx.yawWas == null || Math.abs(d.yaw - fx.yawWas) > 0.01) { fx.yawWas = d.yaw; fx.yawSince = gameClock.now() }
  if (SITTING.has(ph) && !fx.sitStart) fx.sitStart = gameClock.now()
  if (!SITTING.has(ph)) fx.sitStart = 0
  noteTakeoff(d, ph, gameClock.now())
  if (ph !== fx.lastPhase) {
    stats.phases.push(`${PHASE_RU[ph] ?? ph}${hp != null ? ` (${Math.round(hp)})` : ''}`)
    dbg('phase', PHASE_RU[ph], 'hp', hp)
    if (ph === PHASE.SCANNING && fx.lastPhase === PHASE.LANDING) stats.perchCount++
    fx.lastPhase = ph
  }
  if (hp != null && (!hpLog.length || hpLog[hpLog.length - 1] !== Math.round(hp))) hpLog.push(Math.round(hp))
  // в той фазе, где сидел (EnderDragon.hurt: DYING только если !isSitting),
  if (hp != null && hp <= 0) { fx.won = true; return 'stop' }
  if (ph === PHASE.DYING) { fx.lastPhase = PHASE.DYING; await sleep(200); return 'next' }
  // Проверка приёма (сцена): столько посадок — и хватит (когда посадка кончилась).
  if (perches && stats.perchCount >= perches && !SITTING.has(ph) && ph !== PHASE.LANDING && ph !== PHASE.TAKEOFF) { rep.dragon.stoppedAfterPerches = perches; return 'stop' }

  const parts = t.parts = partsOf(bot, d, track)
  const z: any = t.z = dragonZones(bot)
  const ctx: any = t.ctx = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot), parts: z.parts ? parts : null, breath: null, prefer: null, sweep: z.sweep, wings: z.wings, wingKind: z.wingKind, wingAway: z.wingAway, wingAxis: z.wingAxis, landing: z.landing }
  // Облако огня предсказывать только на рёве: высматривая, дракон ещё
  if (ph === PHASE.ROARING) ctx.breath = breathOf(bot, d, parts)
  if (z.charge) ctx.charge = z.charge
  // Один цикл: снижается — кровать у места головы сидящего, щелчок в тик до посадки.
  if (ph === PHASE.LANDING && fx.ocPrevPh !== PHASE.LANDING) fx.ocLandStart = gameClock.now()
  fx.ocPrevPh = ph
}

// Итог боя в отчёт (после цикла).
export function fightReport (fx: Fight) {
  const { ctl, rep, stats, bot, hpLog, won } = fx
  rep.dragon.hpLog = hpLog.slice(-40)
  rep.dragon.won = won
  if (!won && !fightActive(fx) && !rep.dragon.lost) rep.dragon.lost = 'бой прерван: тело сменилось, погибло или вышло из Края'
  if (won && ctl.started) rep.timing.killed = Math.round((gameClock.now() - ctl.started) / 1000)
  if (stats.perchCount) rep.dragon.perchCount = stats.perchCount
  if (stats.bedPerches && stats.bedPerches.length) rep.dragon.bedPerches = stats.bedPerches.slice(-12).map(({ key, ...p }: any) => p)
  {
    const dd0 = dragonOf(bot)
    const tr = dd0 && takeoffSeen.get(dd0.id)
    if (tr && tr.az.length) rep.dragon.takeoffAz = tr.az.map(a => Math.round(a * 180 / Math.PI))
  }
  if (stats.stations) rep.dragon.station = { built: stats.stations, blocks: stats.stationBlocks || 0, none: stats.stationNone }
  const dd = dragonOf(bot)
  rep.dragon.hpNow = won ? 0 : (dd ? Math.round(hpOf(bot, dd) ?? 0) : null)
}
