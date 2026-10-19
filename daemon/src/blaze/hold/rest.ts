'use strict'
// Бой у спавнера — отдых посреди боя (прежний restNow замыкания holdSpawner): щит до укрытия, отрыв и лечение за
// стенкой/в толще, шалаш, коробка, бегство.
import * as gameClock from '../../game-clock'
import { sleep, xyz } from '../../movement'
import { standable } from '../../walkable'
import { seesBlock } from '../../sight'
import * as survival from '../../combat-safety'
import { log, liveBlazes, FOOD_RE } from '../targets'
import { rest } from '../approach'
import { losClear, blazeEye, seesMe } from '../radar'
import { DOOR_SIDES, digInNear } from '../post'
import { boxRest, shutDoor, openDoor } from '../bunker'
import {
  type HoldState, fireproof, equipSword, setShield, stopWalking, inBunker, doorPoint, meleeThreat, foesNow, dangersNow, faceFor
} from './state'

// Отдых: в шалаше — заложить дверь; без шалаша — коробка.
export async function restNow (hs: HoldState) {
  stopWalking(hs)
  if (process.env.ND_BLAZE_WORLD_STATE !== '0' && !fireproof(hs)) await shieldBeforeRest(hs)
  // Нельзя опустить щит и строить/есть под рукой. Отрыв тот же, что в PvP;
  // затем существующее бегство от стрелков ищет разрыв линии огня.
  await setShield(hs, false)
  let escape = null
  if (!inBunker(hs)) {
    const away = await restAway(hs)
    if (away.result) return away.result
    escape = away.escape
  }
  if (inBunker(hs)) return restInBunker(hs)
  return restInBox(hs, escape)
}

// Без огнестойкости: соседний угол, закрывающий лучи и пути шаров, затем щит, пока летят шары и видящие в окне очереди.
async function shieldBeforeRest (hs: HoldState) {
  const { bot, ctl, dead, deadline, radar, guard, setPhase } = hs
  const blazes = liveBlazes(bot, dead, 48)
  // A connected neighbouring corner is cheaper than digging a pit under the current volley.
  const feet = bot.entity.position.floored()
  const exposed = blazes.some(e => seesMe(bot, e)) || radar.incoming(gameClock.now()).length > 0
  const corner = exposed && !inBunker(hs) && DOOR_SIDES.map(d => feet.plus(d)).find(pos =>
    seesBlock(bot, bot.blockAt(pos.offset(0, -1, 0))) && standable(bot, pos) &&
    [0, 1].every(y => !/fire|lava/.test(bot.blockAt(pos.offset(0, y, 0))?.name || '')) &&
    blazes.every(e => !losClear(bot, blazeEye(e), pos.offset(0.5, 1.62, 0.5))) &&
    radar.incoming(gameClock.now()).every(b => !losClear(bot, b.from, pos.offset(0.5, 0.9, 0.5))))
  if (corner) {
    const key = JSON.stringify([xyz(feet), xyz(corner), [-1, 0, 1].map(y => bot.blockAt(corner.offset(0, y, 0))?.stateId),
      blazes.filter(e => e.position.distanceTo(corner) < 2).map(e => [e.id, xyz(e.position)])])
    if (key !== hs.blockedCorner) {
      hs.blockedCorner = key
      const from = blazes.filter(e => seesMe(bot, e)).map(blazeEye)
      await setShield(hs, true, from.length ? faceFor(hs, from) : null)
      setPhase('за соседний угол до лечения')
      await (require('../../sealed') as typeof import('../../sealed')).stepMove(bot, ctl, { kind: 'flat', to: corner }).catch(() => null)
    }
  }
  // The existing radar ends this wait when the physical volley/flight ends or its ray is closed.
  while (!ctl.aborted && (bot.health ?? 0) > 0 && gameClock.now() < deadline && guard.stats.worn) {
    const vis = liveBlazes(bot, dead, 48).filter(e => seesMe(bot, e))
    const from = [...dangersNow(hs, vis, gameClock.now()), ...radar.incoming(gameClock.now()).map(b => b.from)]
    if (!from.length) break
    setPhase('щит до укрытия для лечения')
    await setShield(hs, true, faceFor(hs, from))
    await sleep(50)
  }
}

// Вне шалаша: отрыв, яма на месте, стенка от стрелков, лечение за укрытием. result — итог отдыха (прежний return из
// restNow); без него — дальше коробка/бегство с этим escape.
async function restAway (hs: HoldState): Promise<{ escape: any, result?: any }> {
  const { session, bot, ctl, dead, deadline, combat, actions, out, setPhase } = hs
  setPhase('отрыв до лечения')
  // Без FR под лучами ифритов бег — под залпами (s1c-L-4 06.10: «отрыв до лечения» 14.8 шарами и огнём, смерть): ифрит вплотную
  // не повод бежать — сперва в толщу на месте (две копки; в яме 1×1 с крышкой его удар и шары не достают), бег — если не вышло.
  const nofrSeen = !fireproof(hs) && liveBlazes(bot, dead, 24).some(e => seesMe(bot, e))
  // Бег (kite) — только от ифрита вплотную. От стрелков бег — спиной под
  // очереди: на ферме 2026-09-29 «отрыв до лечения» дал 14–18 из 20
  // смертельного урона. Без ближнего врага — сразу стенка (ниже).
  // S1d 07.10: ифрит вплотную — и под FR сперва яма 3 с крышкой (удар ифрита требует луча и d² < 4 — в закрытой яме его нет), а не
  // отрыв: «не удалось разорвать контакт для лечения» — 3 из 5 смертей у спавнера в серии s1d-F (F22-1, F21b-1, F21b-4). ND_PIT_MELEE=0 — прежнее.
  const usePit = nofrSeen || (process.env.ND_PIT_MELEE !== '0' && !!meleeThreat(hs))
  const escape: any = meleeThreat(hs) && !usePit ? await survival.disengage(session, ctl, () => foesNow(hs)) : { clear: true, how: nofrSeen ? 'без бега: без FR — в толщу' : usePit ? 'без бега: ифрит вплотную — в толщу' : 'без бега: вплотную никого' }
  if (!escape.clear) {
    const enemy = meleeThreat(hs) || foesNow(hs)[0]
    if (enemy && (bot.health ?? 0) > 0 && !ctl.aborted) escape.cover = await combat.retreat(session, ctl, enemy)
    if (meleeThreat(hs) || (bot.health ?? 0) <= 0 || ctl.aborted) return { escape, result: { rested: false, why: 'не удалось разорвать контакт для лечения', escape } }
  }
  // Без огнестойкости под лучами ифритов — отлёжка в толще на месте (2 вниз + крышка, digInPlace: две копки и один блок),
  // а не стройка коробки под залпами со снятым щитом (s1c-N-2 06.10: фаза «коробка» — 4 шара подряд, 17 урона, смерть).
  // Отлечился — крышку сломать, столб 2 под себя и бой дальше; наверх не вышел — конец захода в толще (dugIn).
  if (usePit || (!fireproof(hs) && liveBlazes(bot, dead, 24).some(e => seesMe(bot, e)))) {
    setPhase('в толщу отлечиться')
    const dug: any = await digInNear(bot, ctl).catch(e => ({ ok: false, why: e.message }))
    log('в толщу отлечиться', dug)
    if (dug.ok && dug.sealed) {
      const hp0 = Math.round(bot.health ?? 0)
      const t0 = gameClock.now()
      while (!ctl.aborted && gameClock.now() - t0 < Math.min(60000, Math.max(0, deadline - gameClock.now() - 15000)) && (bot.health ?? 0) < 19) {
        if ((bot.food ?? 20) < 20) { try { await actions.eat(session, {}) } catch {} }
        if ((bot.food ?? 20) < 18 && !bot.inventory.items().some(i => FOOD_RE.test(i.name))) break
        await sleep(500)
      }
      const hp1 = Math.round(bot.health ?? 0)
      const top = bot.entity.position.floored().offset(0, 2, 0)
      if ((bot.health ?? 0) >= 14 && !ctl.aborted) {
        try { const b = bot.blockAt(top); if (b && b.boundingBox === 'block') await (require('../../sealed') as typeof import('../../sealed')).digCell(bot, top) } catch {}
        const up = await (require('../../build') as typeof import('../../build')).towerUp(bot, ctl, dug.depth || 2, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
        if (up && up.ok) return { escape, result: { rested: hp1 >= 18, where: 'яма на месте', hp: `${hp0} -> ${hp1}`, seconds: Math.round((gameClock.now() - t0) / 1000), escape } }
      }
      hs.stopped = `отлёжка в толще: хп ${hp0} -> ${hp1}, наверх не вышел — остаюсь в яме`
      hs.bail = true
      out.dugIn = { ok: true, sealed: !!dug.sealed, at: xyz(bot.entity.position) }
      return { escape, result: { rested: false, where: 'яма на месте', why: hs.stopped, escape } }
    }
  }
  if (liveBlazes(bot, dead, 24).some(e => seesMe(bot, e))) {
    setPhase('из линии огня до лечения')
    const shooter = liveBlazes(bot, dead, 24).find(e => seesMe(bot, e))
    // Та же быстрая стенка/укрытие, что у обычного боя: сначала закрыть
    // огонь двумя блоками, а не восемь секунд бежать под очередями.
    escape.cover = await combat.retreat(session, ctl, shooter, { timeoutMs: 4000 })
    if (meleeThreat(hs) || (bot.health ?? 0) <= 0 || ctl.aborted) return { escape, result: { rested: false, why: 'враг догнал до укрытия', escape } }
  }
  const safe = () => !foesNow(hs).some(e => seesMe(bot, e))
  if (safe()) {
    setPhase('лечение за общим укрытием')
    const healed = await survival.recover(session, ctl, { safe, until: 19,
      maxMs: Math.min(30000, Math.max(0, deadline - gameClock.now() - 2000)) })
    if (healed.rested) return { escape, result: { ...healed, where: 'за стенкой или углом', escape } }
    if (healed.hazard) {
      setPhase('из опасного блока вместо лечения')
      escape.hazard = await survival.disengage(session, ctl, () => foesNow(hs))
      return { escape, result: { ...healed, escape } }
    }
    if (ctl.aborted || (bot.health ?? 0) <= 0 || safe()) return { escape, result: { ...healed, escape } }
  }
  return { escape }
}

async function restInBunker (hs: HoldState) {
  const { session, bot, ctl, actions, guard, setPhase } = hs
  setPhase('отдых в шалаше')
  const hp0 = Math.round(bot.health ?? 0)
  const shut = await shutDoor(bot, hs.bunker)
  if (!shut) {
    await setShield(hs, true, doorPoint(hs))
    return { rested: false, where: 'шалаш', shut: false, why: 'окно не закрыто — не ем' }
  }
  const t0 = gameClock.now()
  let ate = 0
  while (!ctl.aborted && gameClock.now() - t0 < 60000 && ((bot.health ?? 0) < 19 || (bot.food ?? 20) < 18)) {
    if ((bot.food ?? 20) < 20) { try { const r = await actions.eat(session, {}); if (r && r.ate) ate++ } catch {} }
    if ((bot.food ?? 20) < 18 && !bot.inventory.items().some(i => FOOD_RE.test(i.name))) break
    await sleep(500)
  }
  const rested = !ctl.aborted && (bot.health ?? 0) >= 19 && (bot.food ?? 0) >= 18
  if (!rested) return { rested: false, where: 'шалаш', shut, opened: false, why: 'лечение не завершено — окно закрыто' }
  // raise() подтверждает использование; blocking() также проверяет пять тиков.
  await equipSword(hs)
  await setShield(hs, true, doorPoint(hs))
  for (let k = 0; k < 20 && !guard.blocking() && !ctl.aborted; k++) await sleep(50)
  if (!guard.blocking()) return { rested: false, where: 'шалаш', shut, opened: false, why: 'щит не готов — окно закрыто' }
  const opened = await openDoor(bot, hs.bunker)
  if (!opened) return { rested: false, where: 'шалаш', shut, opened: false, why: 'окно не открылось' }
  await equipSword(hs)
  await setShield(hs, true, doorPoint(hs))
  return { rested, why: rested ? undefined : 'шалаш не дал восстановиться', where: 'шалаш', shut, opened, hp: `${hp0} -> ${Math.round(bot.health ?? 0)}`, seconds: Math.round((gameClock.now() - t0) / 1000), ate: ate || undefined }
}

async function restInBox (hs: HoldState, escape) {
  const { session, bot, ctl, dead, deadline, spawner, actions, setPhase } = hs
  // Ифрит вплотную — не строить у него под рукой: сразу бегство (ниже).
  const r: any = meleeThreat(hs) ? { rested: false, threat: true, why: 'враг вплотную — коробку не строю' }
    : await boxRest(session, ctl, { toward: spawner || null, onPhase: setPhase, threat: () => !!meleeThreat(hs),
      maxMs: Math.min(60000, Math.max(0, deadline - gameClock.now() - 2000)),
      hardMs: Math.min(150000, Math.max(0, deadline - gameClock.now() - 2000)) })
  if (r.rested) {
    if (r.exited === false) { hs.stopped = 'отлечился, но из коробки не вышел — нужен безопасный проход'; hs.bail = true }
    return { ...r, escape }
  }
  if (r.sealed && !r.rested) return { ...r, escape }
  // Коробка не закрылась — за угол, где ни один не видит (старый отдых), а нет
  // угла — бегом прочь от них, и поесть там.
  setPhase('отдых за углом')
  const r2 = r.threat ? { rested: false, why: 'враг вплотную' } : await rest(session, ctl, dead, { until: 18, maxMs: 40000 })
  if (r2.rested) return { ...r2, box: r }
  setPhase('бегство на отдых')
  let fled = null
  try { fled = await (require('../../flee') as typeof import('../../flee')).smartFlee(session, ctl, { timeoutMs: 12000, safeDist: 24, reason: 'блейзы' }) } catch (e) { fled = { error: e.message } }
  const t1 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t1 < 30000 && (bot.health ?? 0) < 18 && !liveBlazes(bot, dead, 32).some(e => seesMe(bot, e))) {
    if ((bot.food ?? 20) < 20) { try { await actions.eat(session, {}) } catch {} }
    await sleep(500)
  }
  return { rested: (bot.health ?? 0) >= 18 && (bot.food ?? 0) >= 18,
    why: 'укрытие не позволило восстановиться', where: 'бегство', escape,
    fled: fled && (fled.mode || fled.error), hp: Math.round(bot.health ?? 0), box: r, cover: r2.why }
}
