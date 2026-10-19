'use strict'
// Бой у спавнера — шаги цикла про сам бой: обзор ифритов, чужие враги, щит под залпом, достройка коробки, меч, лук.
import * as gameClock from '../../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from '../../movement'
import { countOf, itemNamed } from '../../items'
import { canUseRanged } from '../../play-policy'
import { log, reachTo, seesMob, ents, liveBlazes, bystanderOnLine, OTHER_FOES, arrowsHave } from '../targets'
import { makeTrack, walkNear } from '../approach'
import { MELEE, swingMs, BOW_MIN, BOW_MAX, NEAR, myEye, floorBelow, aimFrac, blazeEye, seesMe } from '../radar'
import { buildBunker } from '../bunker'
import {
  type HoldState, type Tick, type Turn, p0, fireproof, lockOwner, equipSword, swingFor, setShield, stopWalking, inBunker,
  meleeThreat, checkSafety, dangersNow, faceFor
} from './state'
import { restNow } from './rest'

async function meleeGuarded (session, ctl, foe, { guard, bailAt = 7, maxMs = 25000, face = null, shouldStop = null }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  let swings = 0
  let last = 0
  let blocks = guard.stats.blocked
  let blockAt = 0
  const hp0 = Math.round(bot.health ?? 20)
  let why = null
  try {
    while (!ctl.aborted && gameClock.now() - t0 < maxMs && foe.isValid !== false && bot.entities[foe.id]) {
      await sleep(40)
      if ((bot.health ?? 20) <= bailAt) { why = 'мало хп'; break }
      if (shouldStop && shouldStop()) { why = 'общая опасность'; break }
      const aim = foe.position.offset(0, (foe.height || 1.8) * 0.6, 0)
      try { await bot.lookAt(aim, true) } catch {}
      if (guard.stats.blocked > blocks) { blocks = guard.stats.blocked; blockAt = gameClock.now() }
      const r = reachTo(bot, foe)
      const win = gameClock.now() - blockAt < 700 || gameClock.now() - Math.max(last, t0) > 1200
      if (r <= MELEE && gameClock.now() - last >= swingMs(bot) && win) {
        await guard.raise(false)
        try { bot.attack(foe); swings++; last = gameClock.now() } catch {}
        continue
      }
      if (r > 6) { why = 'ушёл'; break }
      if (r > MELEE) {
        // Шаг к нему без щита — только если он не рядом со своей атакой.
        try { bot.pathfinder.setGoal(new goals.GoalFollow(foe, 1.5), true) } catch {}
        if (r < 4) await guard.raise(true)
        else await guard.raise(false)
        continue
      }
      try { bot.pathfinder.setGoal(null) } catch {}
      await guard.raise(true)
    }
  } finally {
    try { bot.pathfinder.setGoal(null) } catch {}
  }
  return { killed: foe.isValid === false || !bot.entities[foe.id], swings, hp: `${hp0} -> ${Math.round(bot.health ?? 0)}`, why }
}

// Ифриты в 32 блоках и видящие нас; раз в 2 с — строка «шаг» в лог (и место в рюкзаке под стержни).
export async function stepSurvey (hs: HoldState, t: Tick): Promise<void> {
  const { bot, ctx, dead, radar, out } = hs
  const { now, hp } = t
  const blazes = t.blazes = liveBlazes(bot, dead, 32)
  const vis = t.vis = blazes.filter(e => seesMe(bot, e))
  if (gameClock.now() - hs.lastBeat > 2000) {
    hs.lastBeat = gameClock.now()
    // Рюкзак полон — стержни не подбираются (B16f21 03.10): лишнее за спину.
    if (process.env.ND_NE_ROUTE !== '0' && bot.inventory.emptySlotCount() < 3 && !vis.some((e : any) => e.position.distanceTo(bot.entity.position) < 4)) { try { await (require('../../nether-route') as typeof import('../../nether-route')).makeRoom(bot, 5) } catch {} }
    const me = bot.entity.position
    log('шаг', { t: Math.round((now - ctx.t0) / 1000), hp: Math.round(hp), rods: countOf(bot, 'blaze_rod'), kills: ctx.kills ? ctx.kills.length : undefined, melee: out.melee, hits: out.hits, noLease: out.swingNoLease, lease: lockOwner(hs), arrows: out.arrows, shield: hs.shieldOn, inB: !!inBunker(hs), fire: !!(bot.entity.metadata && (bot.entity.metadata[0] & 1)), pos: xyz(me), b: blazes.slice(0, 6).map((e : any) => [Math.round(e.position.distanceTo(me) * 10) / 10, Math.round((blazeEye(e).y - myEye(bot).y) * 10) / 10, seesMe(bot, e) ? 1 : 0, Math.min(99, Math.round(radar.untilDanger(e, now) / 100) / 10)]) })
  }
}

// --- чужие рядом (иссушитель, магмакуб) — обычный бой.
export async function stepOtherFoes (hs: HoldState, t: Tick): Promise<Turn> {
  const { session, bot, ctl, ctx, dead, combat, guard, out, setPhase } = hs
  const { hp, vis } = t
  const foes = (Object.values(bot.entities) as any[]).filter((e : any) => e && OTHER_FOES.has(e.name) && e.position && e.isValid !== false &&
    e.position.distanceTo(bot.entity.position) <= 6 && seesMob(bot, e))
  if (foes.length) {
    const f: any = foes.sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    // Иссушитель бьёт 8 (в железе 4.5) дважды в секунду под огнём шаров —
    // замер 10: смерть с 11.5 хп за 3 с. Мало хп — сперва коробка.
    // Без огнестойкости бой с иссушителем под шарами блейзов — тир по нам (ферма 02.10 neF-blz-2: «slain by Wither
    // Skeleton», огонь 17 + шары 13.5): закрыться и кончить заход (разбор Codex ne-blaze.md, правка 2).
    // Отход в укрытие и возврат, а не конец боя: отлечился — бой дальше.
    if (!fireproof(hs) && vis.length && f.name !== 'magma_cube') {
      const r = await restNow(hs)
      out.rests.push(r)
      log('отдых', { from: f.name, crossfire: true, ...r })
      if (!r.rested && (bot.health ?? 0) < 14) { hs.stopped = 'чужой враг под огнём блейзов без огнестойкости, отдых не вышел'; hs.bail = true; return 'stop' }
      await equipSword(hs)
      return 'next'
    }
    if (hp < 13 && f.name !== 'magma_cube') {
      const r = await restNow(hs)
      out.rests.push(r)
      log('отдых', { from: f.name, ...r })
      if (!r.rested) { hs.stopped = r.why || 'отдых не завершён'; hs.bail = true; return 'stop' }
      await equipSword(hs)
      return 'next'
    }
    await setShield(hs, false)
    stopWalking(hs)
    setPhase('бой: ' + f.name)
    // Ближний бой — щит между взмахами ('always'): удар моба в поднятый
    // щит гасится целиком и отбрасывает его самого (applyItemBlocking →
    // blockUsingItem). Стрелку — 'ranged'.
    const melee = f.name !== 'skeleton' && f.name !== 'ghast'
    const r = melee
      ? await meleeGuarded(session, ctl, f, { guard, bailAt: Math.max(ctx.bailAt, 8), shouldStop: () => checkSafety(hs, 'continue').action === 'leave' || dangersNow(hs, liveBlazes(bot, dead, 32).filter(e => seesMe(bot, e)), gameClock.now()).length > 0 }).catch(e => ({ error: e.message }))
      : await combat.fight(session, ctl, { target: '#' + f.id, purpose: 'defense', allowRanged: p0(ctx).allowRanged, timeoutSeconds: 20, retreatAtHealth: Math.max(ctx.bailAt, 9), shield: 'ranged' }).catch(e => ({ error: e.message }))
    hs.shieldOn = false
    try { await guard.raise(false) } catch {}
    log('чужой', { name: f.name, ...r })
    out.foes.push({ name: f.name, killed: !!r.killed || !!(r.kills && r.kills.length), hp: Math.round(bot.health ?? 0) })
    await equipSword(hs)
    if (hs.bunker && !inBunker(hs)) await walkNear(bot, ctl, hs.bunker.cell, 0, 8000)
    return 'next'
  }
}

export async function stepDangers (hs: HoldState, t: Tick): Promise<Turn> {
  const { bot, radar, setPhase } = hs
  const { now, blazes, vis } = t
  const dangers = dangersNow(hs, vis, now)
  // Опасен тот, кого достаёт меч, и шаров к нам не летит: бить его, а не
  // стоять за щитом (замер 23: блейз в 1.3 блока, заряжен, 0 взмахов за 20 с).
  if (dangers.length && gameClock.now() - hs.lastSwing >= swingMs(bot) && !radar.incoming(now).length) {
    const close: any = blazes.filter((e : any) => reachTo(bot, e) <= MELEE && (require('../../pick') as typeof import('../../pick')).canHit(bot, e))
      .sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
    if (close && await swingFor(hs, close)) {
      setPhase('меч под огнём')
      await sleep(80)
      await setShield(hs, true, faceFor(hs, dangers))
      return 'next'
    }
  }
  if (dangers.length) {
    stopWalking(hs)
    setPhase('щит')
    if (!bot.heldItem || !hs.weapon || bot.heldItem.name !== hs.weapon.name) await equipSword(hs)
    await setShield(hs, true, faceFor(hs, dangers))
    await sleep(50)
    return 'next'
  }
}

// --- достроить коробку в тишине.
export async function stepBoxRetry (hs: HoldState, t: Tick): Promise<Turn> {
  const { session, ctl, radar, out, setPhase } = hs
  const { now, vis } = t
  if (!hs.bunker && hs.boxPlan && hs.boxTries < 4 && now > hs.boxRetryAt && !meleeThreat(hs) &&
      !vis.some(e => radar.untilDanger(e, now) < 2500)) {
    hs.boxTries++
    await setShield(hs, false)
    setPhase('достройка коробки')
    const b = await buildBunker(session, ctl, hs.boxPlan, setPhase)
    log('достройка коробки', { n: hs.boxTries, ok: b.ok, placed: b.placed, open: b.open, roofed: b.roofed, failed: b.failed })
    if (b.ok) { hs.bunker = { cell: hs.boxPlan.cell, front: hs.boxPlan.front, window: true, win: hs.boxPlan.win, lowWindow: hs.boxPlan.lowWindow }; hs.boxPlan = null; out.bunker = { ...(out.bunker || {}), built: true, retries: hs.boxTries } } else hs.boxRetryAt = gameClock.now() + 8000
    await equipSword(hs)
    return 'next'
  }
}

// --- меч: видимый в досягаемости.
export async function stepMelee (hs: HoldState, t: Tick): Promise<Turn> {
  const { bot, guard, setPhase } = hs
  const { now, hp, blazes } = t
  const inReach = blazes.filter((e : any) => reachTo(bot, e) <= MELEE && (require('../../pick') as typeof import('../../pick')).canHit(bot, e))
    .sort((a, b) => reachTo(bot, a) - reachTo(bot, b))
  if (inReach.length) {
    hs.idleSince = now
    stopWalking(hs)
    const e: any = inReach[0]
    // Блейз в 2 блоках бьёт сам раз в 20 тиков (BlazeAttackGoal, d² < 4):
    // щит к нему, взмах — сразу после его удара в щит или если он молчит
    // 1.2 с (замер 12: 24 хп ударами блейзов у спавнера).
    if (guard.stats.blocked > hs.seenBlocks) { hs.seenBlocks = guard.stats.blocked; hs.blockAt = gameClock.now() }
    const close = e.position.distanceTo(bot.entity.position) < 2.4
    // Под огнестойкостью и с 12+ хп — бить на каждом откате (625 мс), не ждать удара в щит: вплотную ифрит наносит лишь 3.4, а
    // убитый перестаёт бить совсем (s1-LF-1/LA-6 06.10: ифриты вплотную, 4–6 попаданий за 15 с, 0 убийств).
    // …но не когда вплотную двое и больше: удары ифритов вплотную идут чаще, чем мы их убиваем (s1c-B-6 06.10: под FR 4 ифрита в
    // 4 бл., 6 ударов по 3.4 за пару секунд, 20 → 0) — тогда щит к ближнему и удар после блока, как без FR.
    const crowd = blazes.filter((b: any) => b.position.distanceTo(bot.entity.position) < 2.6).length
    const window = (fireproof(hs) && hp >= 12 && crowd <= 1) || !close || gameClock.now() - hs.blockAt < 700 || gameClock.now() - hs.lastSwing > 1200
    if (window && await swingFor(hs, e)) {
      setPhase('меч')
    } else {
      await setShield(hs, true, blazeEye(e))
    }
    await sleep(50)
    return 'next'
  }
}

// --- лук: ближайший видимый, если до ближайшей очереди видящих > 1.5 с.
export async function stepBow (hs: HoldState, t: Tick): Promise<Turn> {
  const { session, bot, ctx, dead, radar, out, setPhase } = hs
  const { now, blazes, vis } = t
  // Под огнестойкостью очереди не страшны (шар и горение — #is_fire): «тихо» всегда, лук стреляет без пауз под очередь
  // (разбор Codex ne-blaze.md, правка 3).
  const quiet: any = t.quiet = fireproof(hs) ? Infinity : vis.filter((e : any) => e.position.distanceTo(bot.entity.position) <= NEAR).reduce((m, e) => Math.min(m, radar.untilDanger(e)), Infinity)
  const bowOk = t.bowOk = itemNamed(bot, 'bow') && arrowsHave(bot) > 0 && canUseRanged(session, { name: 'blaze' }, p0(ctx))
  // Без убийств 60 с — стрелять и по ифриту без пола под ним: стержень может упасть ниже или пропасть, но убитый уступает место
  // новому из спавнера, а ждать над пустотой — 0 убийств за 400 с (s1c-P-3/P-7 06.10, 4120…: «время вышло», «за стеной»).
  const kills0 = (ctx.kills || []).length
  if (kills0 !== out.killsSeen) { out.killsSeen = kills0; out.killAt = now }
  const anyFloor = now - (out.killAt || ctx.t0 || now) > 60000
  // …и дальше BOW_MAX (sr-g-3 10.10: ифриты висят в 15.2–15.6 бл., «shoot 0» 400 с, лук и 64 стрелы целы, 0 убийств).
  const bowMax = anyFloor ? 24 : BOW_MAX
  const shootable = t.shootable = blazes.filter((e : any) => { const d = e.position.distanceTo(bot.entity.position); return d >= BOW_MIN && d <= bowMax && aimFrac(bot, e) !== null && now - (hs.noShot.get(e.id) || 0) > 2500 && (anyFloor || floorBelow(bot, e, bot.entity.position, hs.reach)) && !bystanderOnLine(bot, e) })
    .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  if (now - (out.dropAt || 0) > 10000) {
    out.dropAt = now
    const drops = ents(bot).filter((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 32)
      .map((e : any) => { let n = '?'; try { const it = e.getDroppedItem && e.getDroppedItem(); n = it ? it.name : '?' } catch {} return [n, xyz(e.position)] })
    log('лут', { kills: (ctx.kills || []).map(k => k.at), drops })
  }
  if (now - (out.dbgAt || 0) > 2000) { out.dbgAt = now; log('выбор', { vis: vis.length, shoot: shootable.length, seen: blazes.filter(e => seesMob(bot, e)).length, quiet: quiet === Infinity ? 'inf' : Math.round(quiet), bowOk: !!bowOk, inB: !!inBunker(hs) }) }
  if (bowOk && shootable.length && quiet > 1300 && (!hs.bunker || inBunker(hs))) {
    hs.idleSince = now
    stopWalking(hs)
    await setShield(hs, false)
    const e: any = shootable[0]
    const track = makeTrack(e)
    track.update()
    setPhase('лук')
    const t1 = gameClock.now()
    const frac = aimFrac(bot, e) ?? 0.55
    const r = await (require('../../bow') as typeof import('../../bow')).shoot(bot, e, {
      velFn: () => { track.update(); return track.vel() },
      // Точка прицела — видимая часть коробки (aimFrac), с упреждением.
      point: t => { track.update(); const v = track.vel(); return e.position.offset(v.x * t, (e.height || 1.8) * frac + v.y * t, v.z * t) },
      follow: false,
      mode: 'settle',
      shouldStop: () => {
        const n = gameClock.now()
        if (!canUseRanged(session, e, p0(ctx))) return true
        if (!e.isValid) return true
        if (meleeThreat(hs) || checkSafety(hs, 'continue').action === 'leave') return true
        if (fireproof(hs)) return false
        if (radar.incoming(n).some(b => b.eta < 900)) return true
        return liveBlazes(bot, dead, 32).some((b : any) => seesMe(bot, b) && b.position.distanceTo(bot.entity.position) <= NEAR && radar.untilDanger(b, n) < 300)
      }
    }).catch(err => ({ shot: false, why: err.message }))
    if (r.shot) { out.arrows++; hs.lastBow = gameClock.now() } else if (r.blocked || /не долетит/.test(r.why || '')) { hs.noShot.set(e.id, gameClock.now()) }
    if (!r.shot) log('лук', { d: Math.round(e.position.distanceTo(bot.entity.position) * 10) / 10, why: r.why })
    if (gameClock.now() - t1 < 200) await sleep(200)
    await equipSword(hs)
    return 'next'
  }
}
