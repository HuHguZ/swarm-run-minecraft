'use strict'
// Дуэль (huntDuel) — шаги оборота цикла охоты, в прежнем порядке тела while: шаг возвращает 'next' (прежний
// continue), 'stop' (прежний break) или ничего (дальше по шагам). Порядок — DUEL_STEPS в pearls/duel.ts.
import * as gameClock from '../../game-clock'
import { sleep, xyz } from '../../movement'
import { countOf, bestWeapon } from '../../items'
import { towerUp } from '../../build'
import { SWING_MS, log, meta, seesMob, ents, walkTo, pickUp, digCell } from '../common'
import { eyesSeen, reachTo, searchWalk, lavaAround, openFight } from '../aim'
import { trappedEm } from '../shelter'
import { type DuelHunt, duelVantage, duelLookout } from './state'

export type Turn = 'next' | 'stop' | undefined

// Значения одного оборота, общие для шагов (прежние const/let внутри while).
export interface DuelTick {
  me?: any
  all?: any[]
  em?: any
  round?: any
  safeHere?: boolean
  hpA?: number
  f?: any
}

export function duelLimits (dh: DuelHunt): Turn {
  const { bot } = dh
  if (countOf(bot, 'ender_pearl') >= dh.want) return 'stop'
  if (gameClock.now() > dh.deadline) { dh.stopped = 'время вышло'; return 'stop' }
}

export async function duelRest (dh: DuelHunt): Promise<Turn> {
  const { bot, ctl, session } = dh
  // Лечиться до боя: сытость 18+ и хп 16+. Хп мало — в коробку 1x1 с
  // крышей (blaze.boxRest): злой эндермен без луча не бьёт (MeleeAttackGoal:
  // hasLineOfSight) и через 60 тиков теряет цель (лаборатория, дуэль 1:
  // двоих убил, третий злой пришёл на 12 хп — смерть).
  // Злой уже рядом — бой (от эндермена не уйти: телепорт), коробка при нём
  // не закрывается («в клетке стоит enderman», дуэль 2: смерть).
  const me0 = bot.entity.position
  const angryNow = ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && meta(bot, e, 'creepy') && e.position.distanceTo(me0) < 16)
  if ((bot.health ?? 20) < 16 && !angryNow) {
    const r: Awaited<ReturnType<typeof import('../../blaze').boxRest>> = await (require('../../blaze') as typeof import('../../blaze')).boxRest(session, ctl, { toward: null, until: 19, maxMs: 60000 }).catch(e => ({ rested: false, why: e.message }))
    dh.rests.push({ hp: r.hp, s: r.seconds, ok: r.rested, why: r.why })
    log('отдых', r)
    if (!r.rested) { try { await (require('../../actions') as typeof import('../../actions')).eat(session, {}) } catch {} ; await sleep(1500) }
    return 'next'
  }
  if ((bot.food ?? 20) <= 17) { try { await (require('../../actions') as typeof import('../../actions')).eat(session, {}) } catch {} }
}

export async function duelSurvey (dh: DuelHunt, tk: DuelTick): Promise<Turn> {
  const { bot } = dh
  tk.me = bot.entity.position
  tk.all = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false)
  const angry = tk.all.filter((e : any) => meta(bot, e, 'creepy') && e.position.distanceTo(tk.me) < 16 && (e.position.distanceTo(tk.me) < 4 || (!dh.skip.has(e.id) && seesMob(bot, e))))
  // Злить нового — только если злых в 24 блоках нет вовсе.
  // Злой, который 15 с не подходит (застрял за обрывом), — не в счёт на минуту
  // (прогон дуэли 3: бот простоял 6 минут, ожидая застрявшего).
  const angryNear = tk.all.some((e : any) => meta(bot, e, 'creepy') && e.position.distanceTo(tk.me) < 24 && !((dh.ignoreAngry.get(e.id) || 0) > gameClock.now()))
  tk.em = angry.sort((a: any, b: any) => a.position.distanceTo(tk.me) - b.position.distanceTo(tk.me))[0] || null
  tk.round = { t: Math.round((gameClock.now() - dh.t0) / 1000) }
  if (!tk.em && angryNear) {
    if (!dh.angryWait) dh.angryWait = gameClock.now()
    if (gameClock.now() - dh.angryWait > 15000) {
      for (const e of (tk.all as any)) if (meta(bot, e, 'creepy')) dh.ignoreAngry.set(e.id, gameClock.now() + 60000)
      dh.angryWait = 0
    }
    await sleep(1000)
    return 'next'
  }
  dh.angryWait = 0
}

export async function duelPoke (dh: DuelHunt, tk: DuelTick): Promise<Turn> {
  const { bot, ctl, p } = dh
  tk.safeHere = dh.safeSpot(bot.entity.position.floored())
  if (!tk.em && tk.safeHere && p.poke !== false && !dh.angryClose(16)) {
    // Глаз не видно (искажённый лес: грибы и лозы — на двойнике мира
    // прохождения 66 эндерменов в 48 блоках, видимых глаз 0; штрек — 0
    // убийств за 400 с): разозлить УДАРОМ. Удар игрока злит эндермена без
    // всякого взгляда и без телепорта (EnderMan.hurtServer: телепорт — только
    // от снаряда или без живого обидчика; цель — обидчик, HurtByTargetGoal).
    const calm: any = tk.all.filter((e : any) => !dh.skip.has(e.id) && !meta(bot, e, 'creepy') && e.position.distanceTo(tk.me) <= 16 && !trappedEm(bot, e) &&
      !tk.all.some((o : any) => o !== e && o.position.distanceTo(e.position) < 4) &&
      !ents(bot).some((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(e.position) < 10) &&
      e.position.distanceTo(dh.home0) < 64 && dh.safeSpot(e.position.floored()))
      .sort((a: any, b: any) => a.position.distanceTo(tk.me) - b.position.distanceTo(tk.me))[0]
    if (calm) {
      const pk: any = { id: calm.id, from: Math.round(calm.position.distanceTo(tk.me)) }
      const tP = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tP < 15000 && calm.isValid !== false && bot.entities[calm.id] && !meta(bot, calm, 'creepy')) {
        if (reachTo(bot, calm) <= 2.9) {
          const a = (require('../../pick') as typeof import('../../pick')).aim(bot, calm)
          if (a && a.point) {
            const w = bestWeapon(bot)
            if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) { try { await bot.equip(w, 'hand') } catch {} }
            dh.pitchCap = -0.35
            try { await bot.lookAt(calm.position.offset(0, 0.6, 0), true) } catch {}
            try { bot.attack(calm); pk.hit = true } catch {}
            await sleep(400)
            break
          }
        }
        bot._ndNoMobAvoid = true
        try { pk.walk = (await walkTo(bot, ctl, calm.position.floored(), 1, 3000, () => dh.angryClose(6))).error || 'ok' } finally { bot._ndNoMobAvoid = false }
        pk.dist = Math.round(reachTo(bot, calm) * 10) / 10
      }
      dh.pitchCap = -0.5
      pk.angry = !!meta(bot, calm, 'creepy')
      pk.s = Math.round((gameClock.now() - tP) / 1000)
      log('удар-вызов', pk)
      if (pk.angry) { dh.idle = 0; return 'next' }
      dh.skip.add(calm.id); gameClock.setTimeout(() => dh.skip.delete(calm.id), 30000)
    }
  }
}

export async function duelScout (dh: DuelHunt, tk: DuelTick): Promise<Turn> {
  const { bot, ctl } = dh
  if (!tk.em) {
    const cand = tk.safeHere ? dh.pickTarget(tk.all, tk.me) : null
    if (!cand && dh.idle % 3 === 0) {
      const v = duelVantage(dh, tk.all)
      if (v) {
        log('обзор', { to: xyz(v.pos), seen: v.seen, steps: v.d, checked: v.checked })
        await walkTo(bot, ctl, v.pos, 0, 15000, () => dh.angryClose(6))
        dh.idle++
        return 'next'
      }
    }
    if (!cand && tk.safeHere && dh.idle % 3 === 1) {
      // С земли в лесу глаз не видно (прогоны 41–44: 20 эндерменов в 6..28,
      // видимых глаз 0): вышка в 3 блока здесь же — осмотреться сверху,
      // разозлить, спуститься и драться на земле (бой на земле 0–3 хп).
      const lo: any = await duelLookout(dh)
      log('вышка', lo)
      if (lo.angry) { dh.idle = 0; return 'next' }
    }
  }
}

export async function duelChoose (dh: DuelHunt, tk: DuelTick): Promise<Turn> {
  const { bot, ctl } = dh
  if (!tk.em) {
    tk.em = !tk.safeHere ? null : tk.all.filter((e : any) => !dh.skip.has(e.id) && eyesSeen(bot, e))
      // До 28 блоков (прогоны 41–42: в 6..20 ни у кого не видно глаз, 5 мин поиска;
      // допуск взгляда на 28 блоках — 2.4°, lookAt точен, дальний злой
      // телепортируется к нам сам: EndermanLookForPlayerGoal, дальше 16).
      .filter((e : any) => { const d = e.position.distanceTo(tk.me); return d >= 6 && d <= 28 })
      // В лесу по 20 штук в 48 блоках — «никого в 16» не бывает: рядом с ним
      // никого в 6 и ни одного злого в 16.
      .filter((e : any) => !tk.all.some((o : any) => o !== e && (o.position.distanceTo(e.position) < 3 || (meta(bot, o, 'creepy') && !((dh.ignoreAngry.get(o.id) || 0) > gameClock.now()) && !trappedEm(bot, o) && o.position.distanceTo(e.position) < 16))))
      // Зомби-пиглины рядом — нет: удар с размаха задевает соседей, и стая злится
      // (дуэль 5: «slain by Zombified Piglin»).
      .filter((e : any) => !ents(bot).some((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(e.position) < 10))
      // Далеко от места старта не уходить (искажённый лес кончается).
      .filter((e : any) => e.position.distanceTo(dh.home0) < 64 && !trappedEm(bot, e))
      .sort((a: any, b: any) => a.position.distanceTo(tk.me) - b.position.distanceTo(tk.me))[0] || null
    if (!tk.em) {
      if (++dh.idle > 6) {
        dh.idle = 0
        // Далеко ушли — назад к месту старта, иначе поиск дальше.
        if (bot.entity.position.distanceTo(dh.home0) > 40 || bot.entity.position.y < dh.home0.y - 10) { await walkTo(bot, ctl, dh.home0.floored(), 4, 20000); return 'next' }
        {
          const me1 = bot.entity.position
          const inR = tk.all.filter((e : any) => { const d = e.position.distanceTo(me1); return d >= 6 && d <= 28 })
          const eyes = inR.filter(e => eyesSeen(bot, e))
          log('никого', { all: tk.all.length, inRange: inR.length, eyes: eyes.length, angry: tk.all.filter(e => meta(bot, e, 'creepy')).length, trapped: tk.all.filter(e => trappedEm(bot, e)).length, skip: dh.skip.size, y: Math.round(me1.y) })
        }
        const w = await searchWalk(bot, ctl, 24, () => dh.angryClose(6), { high: true })
        log('поиск', { to: w })
      } else await sleep(1500)
      return 'next'
    }
    dh.idle = 0
    dh.pitchCap = null
    const tA = gameClock.now()
    let looks = 0
    while (!ctl.aborted && gameClock.now() - tA < 5000 && !meta(bot, tk.em, 'creepy') && tk.em.isValid !== false) {
      if (eyesSeen(bot, tk.em)) { await bot.lookAt(tk.em.position.offset(0, 2.55, 0), true); looks++ }
      await sleep(100)
    }
    dh.pitchCap = -0.5
    tk.round.looks = looks
    if (!meta(bot, tk.em, 'creepy')) { dh.skip.add(tk.em.id); return 'next' }
  } else tk.round.already = true
}

export async function duelFight (dh: DuelHunt, tk: DuelTick): Promise<void> {
  const { bot, ctl, session } = dh
  try { await bot.look(bot.entity.yaw, -0.5, true) } catch {}
  tk.hpA = bot.health ?? 20
  // До конца: отход от эндермена бесполезен, бой кончается его смертью или нашей;
  // новые бои — только с 16+ хп (отдых в коробке до них).
  // Свой бой (openFight): ждать его на месте со щитом, бить в тело сразу
  // после его взмаха. combat.fight с опущенным взглядом не бил (прогон 38:
  // 4 боя, 0–4 взмаха, 0 убийств), а без него злил чужих.
  dh.pitchCap = -0.35
  // Двое злых уже в 8 блоках — сразу столб, без боя на земле (двойник мира
  // прохождения: трое злых сняли 20 хп за 12 с).
  const crowdNow = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dh.deadIds.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < 8).length >= 2
  tk.f = crowdNow ? { crowd: true, swings: 0 } : await openFight(session, ctl, tk.em, { retreatAt: 13, dead: dh.deadIds, maxMs: 40000 }).catch(e => ({ error: e.message }))
  dh.pitchCap = -0.5
  // Хп 10 и он жив — столб в 3 блока прямо здесь: его коробка удара раздута
  // только по горизонтали, до ног на +3 он не достаёт, а меч сверху бьёт его
  // голову (дуэль 3: смерть на 12 хп от второго злого).
  if (tk.em.isValid !== false && bot.entities[tk.em.id] && !ctl.aborted && ((bot.health ?? 20) <= 13 || tk.f.crowd)) {
    const base = bot.entity.position.floored()
    const up = await towerUp(bot, ctl, 3)
    tk.round.pillar = up.placed
    const w = bestWeapon(bot)
    if (w) { try { await bot.equip(w, 'hand') } catch {} }
    const tP = gameClock.now()
    let last = 0
    let nearAt = gameClock.now()
    while (!ctl.aborted && gameClock.now() - tP < 30000 && tk.em.isValid !== false && bot.entities[tk.em.id]) {
      // Злые к столбу не идут 10 с (стоят в 6+ блоках) — слезть и дальше: на
      // двойнике три столба подряд по 35 с без единого взмаха.
      if (ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dh.deadIds.has(e.id) && meta(bot, e, 'creepy') && reachTo(bot, e) < 6)) nearAt = gameClock.now()
      if (gameClock.now() - nearAt > 10000) break
      // Со столба бьём любого злого, кто под нами в досягаемости (их бывает двое).
      const near: any = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dh.deadIds.has(e.id) && meta(bot, e, 'creepy') && reachTo(bot, e) <= 3.0)
        .sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0] || tk.em
      const r = reachTo(bot, near)
      try { await bot.lookAt(near.position.offset(0, 2.2, 0), true) } catch {}
      if (r <= 3.0 && gameClock.now() - last >= SWING_MS) { try { bot.attack(near); last = gameClock.now() } catch {} }
      if ((bot.food ?? 20) < 18 && r > 4) { try { await (require('../../actions') as typeof import('../../actions')).eat(session, {}) } catch {} }
      await sleep(80)
    }
    tk.f = { ...tk.f, killed: tk.em.isValid === false || !bot.entities[tk.em.id], fromPillar: true }
    // Вниз: свой столб из-под ног.
    for (let i = 0; i < 4 && !ctl.aborted; i++) {
      const feet = bot.entity.position.floored()
      if (feet.y <= base.y) break
      const e2 = await digCell(bot, session.mcData, feet.offset(0, -1, 0))
      if (e2) break
      await sleep(400)
    }
  }
}

export async function duelAfter (dh: DuelHunt, tk: DuelTick): Promise<void> {
  const { bot, ctl, session } = dh
  const lost = Math.max(0, tk.hpA - (bot.health ?? 0))
  dh.hpSpent += lost
  await sleep(300)
  if (tk.f.target && tk.f.target !== tk.em) { tk.round.retarget = tk.f.retargets; tk.em = tk.f.target }
  tk.round.killed = dh.deadIds.has(tk.em.id)
  tk.round.swings = tk.f.swings
  if (tk.f.stale) { tk.round.stale = true; dh.ignoreAngry.set(tk.em.id, gameClock.now() + 60000) }
  tk.round.his = tk.f.hisSwings
  tk.round.blocked = tk.f.blocked
  tk.round.hpLost = Math.round(lost * 10) / 10
  tk.round.why = tk.f.error || tk.f.stopped || tk.f.mode || undefined
  if (tk.round.killed) {
    dh.kills++
    // Лут падает, когда тело убирают (через 20 тиков после смерти), там, где
    // он умер, — а отброс ударом уносит его на 2–4 блока (прогон 40: 6
    // убийств, 1 жемчуг: подбор в 6 блоках от себя сразу после боя).
    const deathAt = tk.em.position.clone()
    await sleep(1300)
    const isPearl = e => { try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'ender_pearl' } catch { return false } }
    let drops = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(deathAt) < 10 && !lavaAround(bot, e.position))
    if (!drops.length) {
      // Метаданные предмета приходят позже самого предмета — ещё раз через 1.5 с.
      await sleep(1500)
      drops = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(deathAt) < 12 && !lavaAround(bot, e.position))
    }
    tk.round.drop = drops.length
    tk.round.items = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(deathAt) < 12).map((e : any) => { try { const it = e.getDroppedItem(); return it ? it.name : '?' } catch { return '!' } }).join(',') || undefined
    tk.round.pearlsNow = countOf(bot, 'ender_pearl')
    for (const d of (drops as any)) {
      if (!bot.entities[d.id] || ctl.aborted) continue
      await walkTo(bot, ctl, d.position.floored(), 0, 7000)
      await pickUp(bot, ctl, 3, 1500)
    }
    await pickUp(bot, ctl, 6, 2000)
  } else { dh.skip.add(tk.em.id); gameClock.setTimeout(() => dh.skip.delete(tk.em.id), 20000) }
  dh.rounds.push(tk.round)
  log('дуэль', tk.round)
  if ((bot.health ?? 20) <= dh.retreatAt) {
    // Отойти и отъесться: злых рядом нет — есть; есть — уйти.
    try { await (require('../../actions') as typeof import('../../actions')).eat(session, {}) } catch {}
  }
}
