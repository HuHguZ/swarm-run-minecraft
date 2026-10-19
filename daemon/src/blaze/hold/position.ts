'use strict'
// Бой у спавнера — шаги цикла про место боя: новый обзор крепости без спавнера, подход к дальнему ифриту на выстрел,
// другая точка боя / окно / помост / ифрит за стеной, возврат к месту боя или в шалаш.
import * as gameClock from '../../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from '../../movement'
import { log, liveBlazes } from '../targets'
import { walkNear } from '../approach'
import { BOW_MAX, myEye, blazeEye, seesMe } from '../radar'
import { floorUnder, choosePost, windowForPost } from '../post'
import { type HoldState, type Tick, type Turn, fireproof, equipSword, setShield, stopWalking, inBunker, refreshReach } from './state'

// --- блейзы рядом, но ни одного не видно 6 с (висят над помостом, за
// стеной): другая точка боя с видом на куб спавна. Замер 8: у края
// помоста трое в 3–7 блоках, не видно ни одного, 2 стержня за 3 минуты.
export async function stepAcquire (hs: HoldState, t: Tick): Promise<Turn> {
  const { session, bot, ctl, deadline, spawner, out, setPhase } = hs
  const { now, vis, quiet } = t
  if (vis.length) hs.lastVisAt = now
  // Без увиденного спавнера скрытая сущность не задаёт точную цель хода.
  // Уже увиденная крепость и её видимый пол дают следующий законный обзор.
  if (!hs.bunker && !spawner && !vis.length && now - hs.lastVisAt > 6000 && quiet > 1500 && process.env.ND_BLAZE_NOSP_APPROACH !== '0') {
    const fortress: typeof import('../../fortress') = require('../../fortress')
    const known = fortress.placeOf(session, fortress.PLACE)
    if (!known || (require('../../worlds') as typeof import('../../worlds')).worldOfRecord(known) !== 'the_nether') {
      hs.stopped = 'ифритов и спавнера не видно, увиденная крепость неизвестна — нужен поиск'
      return 'stop'
    }
    const from = bot.entity.position.clone()
    setPhase('новый обзор увиденной крепости')
    const view = await fortress.tour(session, ctl, { hops: 1, deadline: Math.min(deadline, now + 6000) })
    const spawners = view.spawners || []
    const seenBlazes = view.blazes?.seen || 0
    out.views = (out.views || 0) + 1
    log('новый обзор без спавнера', { n: out.views, from: xyz(from), at: xyz(bot.entity.position), seen: view.seen, spawners: spawners.length, blazes: seenBlazes })
    if (spawners.length) {
      out.spawners = spawners.map(xyz)
      hs.stopped = 'увидел спавнер — следующий бой у него'
      return 'stop'
    }
    if (bot.entity.position.distanceTo(from) < 0.8 && !seenBlazes) {
      hs.stopped = 'нового обзора крепости не достиг — нужен другой подход'
      return 'stop'
    }
    hs.home = bot.entity.position.floored()
    hs.idleSince = hs.lastVisAt = gameClock.now()
    return 'next'
  }
}

// Видны, но все дальше дальности лука (sr-k-3 10.10: «vis 3, shoot 0» 127 раз, ифриты в 25–30 бл., 0 убийств за 400 с) — подойти
// к ближнему на 12 бл. по той же цене, что к ифриту за стеной.
export async function stepFarBlaze (hs: HoldState, t: Tick): Promise<Turn> {
  const { bot, ctl, ctx, out, setPhase } = hs
  const { now, vis, quiet, bowOk, shootable } = t
  const bowReach = now - (out.killAt || ctx.t0 || now) > 60000 ? 24 : BOW_MAX
  if (!hs.bunker && bowOk && vis.length && !shootable.length && quiet > 1500 && hs.farApproaches < 8 &&
    vis.every((e: any) => e.position.distanceTo(bot.entity.position) > bowReach) && (bot.health ?? 0) >= (fireproof(hs) ? 12 : 16)) {
    const near: any = vis.slice().sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    hs.farApproaches++
    out.farApproaches = hs.farApproaches
    setPhase('к дальнему ифриту на выстрел')
    log('к дальнему ифриту', { n: hs.farApproaches, d: Math.round(near.position.distanceTo(bot.entity.position)), to: xyz(near.position) })
    await walkNear(bot, ctl, floorUnder(bot, near.position) || near.position.floored(), 12, 8000)
    return 'next'
  }
}

export async function stepRepost (hs: HoldState, t: Tick): Promise<Turn> {
  const { session, bot, ctl, dead, spawner, out, setPhase } = hs
  const { now, blazes, quiet } = t
  if (!hs.bunker && spawner && blazes.some((e : any) => e.position.distanceTo(bot.entity.position) < 16) && now - hs.lastVisAt > 6000 && quiet > 1500 && hs.reposts < 12) {
    await setShield(hs, false)
    const np = choosePost(bot, spawner, hs.home)
    hs.lastVisAt = now
    hs.reposts++
    if (np && !np.pos.equals(bot.entity.position.floored())) {
      setPhase('другая точка боя')
      hs.home = np.pos
      out.reposts = (out.reposts || 0) + 1
      log('другая точка', { ...xyz(np.pos), view: np.view, h: np.h })
      await walkNear(bot, ctl, np.pos, 0, 8000)
      return 'next'
    }
    const window = windowForPost(bot, spawner)
    if (window && !ctl.aborted) {
      stopWalking(hs)
      setPhase('окно к залу спавнера')
      const dug = await (require('../../tools') as typeof import('../../tools')).breakFast(bot, window.pos, { maxMs: 8000 })
      log('окно к залу спавнера', { at: xyz(window.pos), gain: window.gain, ...dug })
      await equipSword(hs)
      if (dug.ok) {
        out.windows = (out.windows || 0) + 1
        refreshReach(hs)
        hs.lastVisAt = gameClock.now()
        return 'next'
      }
    }
    // Точки обзора нет, а тело ниже/выше помоста и вплотную пусто — ходом по сетке на пол зала (s1-post14/15 06.10: с y66
    // при спавнере y69 ни одного убийства за 6 мин).
    if ((Math.floor(bot.entity.position.y) < spawner.y - 1 || Math.floor(bot.entity.position.y) > spawner.y + 2) && !liveBlazes(bot, dead, 5).some(e => seesMe(bot, e)) && process.env.ND_NE_ROUTE !== '0' && (out.levelRoutes || 0) < 3) {
      out.levelRoutes = (out.levelRoutes || 0) + 1
      setPhase('на помост')
      // S1f (вслепую — сетки копии нет, routeTo отказывал сразу): ход к полу зала pathfinder'ом со ступенями/столбом (fortress.climbTo),
      // как игрок поднимается к помосту (s1f-D1-1: спавнер увиден с 11 бл. ниже — «за стеной, точки обзора нет», 0 стержней).
      const NRg = (require('../../nether-route') as typeof import('../../nether-route')).gridOf(session)
      const rr: Partial<import('../../nether-route').NetherRouteResult> = NRg || process.env.ND_BLAZE_CLIMB === '0'
        ? await (require('../../nether-route') as typeof import('../../nether-route')).routeTo(session, ctl, { x: spawner.x, y: spawner.y, z: spawner.z, r: 2, dy: 0, solidFloor: true, frKeep: 1, ironOk: true, abortNear: { re: '^blaze$', r: 4 }, timeoutSeconds: 40 }).catch(e => ({ ok: false, why: e.message }))
        : await (require('../../fortress') as typeof import('../../fortress')).climbTo(session, ctl, spawner.offset(Math.sign(bot.entity.position.x - spawner.x) * 3 || 3, -1, Math.sign(bot.entity.position.z - spawner.z) * 3), gameClock.now() + 40000).then(w => ({ ok: w.ok, why: w.error, steps: null })).catch(e => ({ ok: false, why: e.message }))
      log(NRg ? 'на помост по сетке' : 'на помост ступенями', { ok: rr.ok, why: rr.why, steps: rr.steps, at: xyz(bot.entity.position) })
      await equipSword(hs)
      return 'next'
    }
    if (hs.reposts >= 2) {
      // Точки обзора нет — подойти к ближайшему скрытому ифриту: из-за угла
      // он виден, дальше меч/щит основного цикла. Ферма 2026-09-29: 4 из 4
      // боёв кончились «за стеной» за ~55 с, основной мир так же.
      const hidden: any = blazes.filter((e : any) => e.position.distanceTo(bot.entity.position) < 16)
        .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      // Под огнестойкостью подход к скрытому ифриту безопасен (шары не жгут) — заходов больше: лук+зелье neF-blz-5 02.10
      // кончил бой на 6 из 7 тремя «за стеной» подряд.
      // S1f: без огнестойкости подход к скрытому ифриту — цена: у цели ещё ифриты (в 6 бл.) — это клетка спавна, вплотную каждый бьёт
      // 3.4 (удар 6 по железу) раз в ~1 с и шарами по 2.7: s1f-FA-3 — «к ифриту за стеной» к помосту (4 ифрита), хп 20 → 0 за 3 с.
      // Подход — только к одиночке и с хп ≥ 16 (ожидаемый урон ~2 ударов). ND_BLAZE_APPROACH_PRICE=0 — прежнее (хп ≥ 12).
      const crowdAt = hidden ? blazes.filter((e: any) => e !== hidden && e.position.distanceTo(hidden.position) < 6).length : 0
      const approachOk = fireproof(hs) || process.env.ND_BLAZE_APPROACH_PRICE === '0' ? (bot.health ?? 0) >= 12 : crowdAt === 0 && (bot.health ?? 0) >= 16
      if (hidden && !approachOk) log('к ифриту за стеной — не иду', { crowd: crowdAt, hp: Math.round(bot.health ?? 0), fr: fireproof(hs) })
      if (hidden && hs.approaches < (fireproof(hs) ? 14 : 6) && approachOk) {
        hs.approaches++
        out.approaches = hs.approaches
        setPhase('к ифриту за стеной')
        log('к ифриту за стеной', { n: hs.approaches, to: xyz(hidden.position) })
        await walkNear(bot, ctl, floorUnder(bot, hidden.position) || hidden.position.floored(), 2, 6000)
        hs.lastVisAt = gameClock.now()
        return 'next'
      }
      hs.stopped = 'ифриты за стеной, доступной точки обзора нет — бой без прогресса прекращён'
      return 'stop'
    }
  }
}

// --- без шалаша: далеко от места боя (отдых бегом, погоня) — назад; шаг к низкому блейзу; коробка брошена; назад в шалаш.
export async function stepReturn (hs: HoldState, t: Tick): Promise<Turn> {
  const { bot, setPhase } = hs
  const { now, vis, quiet } = t
  if (!hs.bunker && hs.home && bot.entity.position.distanceTo(hs.home) > 8 && quiet > 1500) {
    await setShield(hs, false)
    if (gameClock.now() - hs.goalAt > 800) {
      hs.goalAt = gameClock.now()
      setPhase('назад к спавнеру')
      try { bot.pathfinder.setGoal(new goals.GoalNear(hs.home.x, hs.home.y, hs.home.z, 2), true) } catch {}
    }
    await sleep(100)
    return 'next'
  }
  // --- без шалаша: шаг к низкому блейзу в тишине (меч).
  if (!hs.bunker) {
    const stepTo: any = vis.filter((e : any) => {
      const dyEye = blazeEye(e).y - myEye(bot).y
      const flat = Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)
      return dyEye < 1.8 && dyEye > -2.5 && flat < 7
    }).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (stepTo && quiet > 1200) {
      await setShield(hs, false)
      const f = floorUnder(bot, stepTo.position)
      if (f && gameClock.now() - hs.goalAt > 400) {
        hs.goalAt = gameClock.now()
        setPhase('шаг к блейзу')
        try { bot.pathfinder.setGoal(new goals.GoalNear(f.x, f.y, f.z, 1.5), true) } catch {}
      }
      await sleep(100)
      return 'next'
    }
  } else if (!inBunker(hs) && hs.bunker.window && now - (hs.bunker.outSince || (hs.bunker.outSince = now)) > 15000) {
    log('коробка брошена', { at: xyz(bot.entity.position) })
    hs.bunker = null
    return 'next'
  } else if (!inBunker(hs)) {
    await setShield(hs, false)
    if (gameClock.now() - hs.goalAt > 800) {
      hs.goalAt = gameClock.now()
      setPhase('назад в шалаш')
      try { bot.pathfinder.setGoal(new goals.GoalBlock(hs.bunker.cell.x, hs.bunker.cell.y, hs.bunker.cell.z), true) } catch {}
    }
    await sleep(100)
    return 'next'
  }
  if (hs.bunker) hs.bunker.outSince = 0
  stopWalking(hs)
}
