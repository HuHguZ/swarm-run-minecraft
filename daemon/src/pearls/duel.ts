'use strict'
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import { countOf, bestWeapon } from '../items'
import { towerUp } from '../build'
import { SWING_MS, clamp, log, meta, seesMob, ents, walkTo, pickUp, digCell } from './common'
import { clearRay, eyesSeen, reachTo, searchWalk, lavaAround, openFight } from './aim'
import { trappedEm } from './shelter'

// ------------------------------------------------------------ hunt: дуэль
// Честный бой один на один (style: 'duel'): эндермен, у которого в 16 блоках
// нет другого, взгляд в глаза с 6..20 блоков, потом combat.fight со щитом
// 'always' (его удар в поднятый щит гасится целиком и отбрасывает его). Между
// боями — еда. Меряем убийства в час и хп за убийство.
async function huntDuel (session, ctl, p: any = {}) {
  const bot = session.bot
  const combat: typeof import('../combat') = require('../combat')
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const pearls0 = countOf(bot, 'ender_pearl')
  const want = pearls0 + Math.max(1, p.count ?? 4)
  const hp0 = Math.round(bot.health ?? 20)
  const retreatAt = clamp(p.retreatAtHealth ?? 9, 4, 16)
  const rounds = []
  const skip = new Set()
  const rests = []
  const home0 = bot.entity.position.clone()
  // Убит — по смерти (entityDead) или пропаже в 12 блоках через <3 с после
  // нашего удара; «isValid false» бывает и у ушедшего телепортом (дуэль 4:
  // «убит» с двух взмахов).
  const deadIds = new Set()
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'enderman') hurtAt.set(e.id, gameClock.now()) }
  const onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || !e.position) return
    if (e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    deadIds.add(e.id)
  }
  const onGone = e => onDead(e, 'gone')
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  // Взгляд вниз всегда, кроме нарочного взгляда в глаза выбранному. Эндермен
  // злится на взгляд в глаза (EnderMan.isLookingAtMe: угол до его глаз меньше
  // acos(1 − 0.025/d) — 2.9° на 20 блоках), а тело ходило и дралось с pitch
  // около 0 и злило чужих: «второй злой» — в смертях дуэлей 1–7 (лаборатория
  // 2026-09-27); вблизи (< 4 бл.) взгляд в глаза ещё и телепортирует его прочь
  // посреди боя (EndermanLookForPlayerGoal.tick). В бою −20°: прицел на его
  // ногах и поясе (внутри его коробки до 3 блоков), до его глаз ≥ 30°.
  const onMeHurt = victim => {
    if (victim !== bot.entity) return
    const me = bot.entity.position
    const near = (Object.values(bot.entities) as any[]).filter((e : any) => e && e !== bot.entity && e.position && e.position.distanceTo(me) < 5 && e.type !== 'object' && e.name !== 'item')
      .map((e : any) => [e.name, e.id, Math.round(e.position.distanceTo(me) * 10) / 10, meta(bot, e, 'creepy') ? 1 : 0])
    log('удар по мне', { hp: Math.round((bot.health ?? 0) * 10) / 10, near })
  }
  bot.on('entityHurt', onMeHurt)
  let pitchCap = -0.5
  const capPitch = () => { if (pitchCap !== null && bot.entity && bot.entity.pitch > pitchCap) bot.entity.pitch = pitchCap }
  bot.on('physicsTick', capPitch)
  const ignoreAngry = new Map()
  // Где драться можно: в 2 блоках вокруг нет обрыва глубже 3 (удар эндермена
  // отбрасывает — прогон 51: «fell from a high place»), лавы в 4 блоках нет
  // (прогон 51: «tried to swim in lava to escape Ghast»).
  const safeSpot = (f) => {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        let depth = 0
        for (let dy = -1; dy >= -5; dy--) {
          const b = bot.blockAt(f.offset(dx, dy, dz))
          if (!b) break
          if (/lava/.test(b.name)) return false
          if (b.boundingBox === 'block') break
          depth++
        }
        if (depth > 3) return false
      }
    }
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -3; dy <= 1; dy++) { const b = bot.blockAt(f.offset(dx, dy, dz)); if (b && /lava/.test(b.name)) return false }
    return true
  }
  const angryClose = r => ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !deadIds.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < r)
  // Кого злить (глаза видно строгим лучом отсюда): 6..28 блоков, рядом с ним
  // никого в 3 и злых в 16 (кроме застрявших), пиглинов в 10 нет, не в яме,
  // не дальше 64 от места старта.
  const pickTarget = (all, me) => all.filter(e => !skip.has(e.id) && eyesSeen(bot, e))
    .filter(e => { const d = e.position.distanceTo(me); return d >= 6 && d <= 28 })
    .filter(e => !all.some(o => o !== e && (o.position.distanceTo(e.position) < 3 || (meta(bot, o, 'creepy') && !((ignoreAngry.get(o.id) || 0) > gameClock.now()) && !trappedEm(bot, o) && o.position.distanceTo(e.position) < 16))))
    .filter(e => !ents(bot).some((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(e.position) < 10))
    .filter(e => e.position.distanceTo(home0) < 64 && !trappedEm(bot, e))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
  // Откуда видно больше глаз: заливка «куда дойду» (24), каждая третья клетка
  // (до 200), луч от глаз клетки к глазам эндерменов 6..28 — как в pillarUp.
  const vantage = (all) => {
    const { walkable }: typeof import('../walkable') = require('../walkable')
    const nodes = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 3000 })
    const ems = all.filter(e => !skip.has(e.id) && !trappedEm(bot, e) && e.position.distanceTo(home0) < 64)
    if (!ems.length) return null
    let best = null
    let checked = 0
    for (let i = 0; i < nodes.length && checked < 200; i += 3) {
      const n = nodes[i]
      if (n.d < 3) continue
      if (!safeSpot(n.pos)) continue
      checked++
      const eye = n.pos.offset(0.5, 1.62, 0.5)
      let seen = 0
      for (const e of ems) {
        const d = e.position.distanceTo(eye)
        if (d < 6 || d > 28) continue
        if (clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++
      }
      const score = seen * 10 - n.d * 0.2
      if (seen && (!best || score > best.score)) best = { pos: n.pos, seen, score, d: n.d }
    }
    return best ? { ...best, checked } : null
  }
  const lookout = async () => {
    const feet = bot.entity.position.floored()
    const res: any = {}
    if (angryClose(10)) return { why: 'злой рядом' }
    for (let y = 2; y <= 5; y++) { const b = bot.blockAt(feet.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || /lava|water/.test(b.name)) return { why: 'над головой нет 4 блоков воздуха' } }
    if (lavaAround(bot, feet) || lavaAround(bot, feet.offset(0, -1, 0))) return { why: 'лава рядом' }
    try { await (require('../fortify') as typeof import('../fortify')).centerInCell(bot, 600) } catch {}
    const up = await towerUp(bot, ctl, 3)
    res.placed = up.placed || 0
    const top = bot.entity.position.floored()
    if (top.y - feet.y >= 2) {
      let target = null
      for (let k = 0; k < 4 && !target && !ctl.aborted && !angryClose(6); k++) {
        const all2 = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false)
        target = pickTarget(all2, bot.entity.position)
        if (k === 0) { const me3 = bot.entity.position; const inR = all2.filter((e : any) => { const d = e.position.distanceTo(me3); return d >= 6 && d <= 28 }); res.inRange = inR.length; clearRay.stats = {}; res.eyesTop = inR.filter(e => eyesSeen(bot, e)).length; res.blockedBy = clearRay.stats; res.y = Math.round(me3.y) }
        if (!target) { try { await bot.look(bot.entity.yaw + Math.PI / 2, -0.5, true) } catch {} ; await sleep(600) }
        else res.eyes = all2.filter(e => eyesSeen(bot, e)).length
      }
      if (target) {
        res.from = Math.round(target.position.distanceTo(bot.entity.position))
        pitchCap = null
        const tA = gameClock.now()
        while (!ctl.aborted && gameClock.now() - tA < 5000 && !meta(bot, target, 'creepy') && target.isValid !== false) {
          if (eyesSeen(bot, target)) await bot.lookAt(target.position.offset(0, 2.55, 0), true).catch(() => {})
          await sleep(100)
        }
        pitchCap = -0.5
        res.angry = !!meta(bot, target, 'creepy')
        if (!res.angry) skip.add(target.id)
      }
    } else res.why = `столб не вышел: ${up.reason || ''}`
    // Вниз: свой столб из-под ног (блоки — в рюкзак).
    for (let i = 0; i < 5 && !ctl.aborted; i++) {
      const f = bot.entity.position.floored()
      if (f.y <= feet.y) break
      const e2 = await digCell(bot, session.mcData, f.offset(0, -1, 0))
      if (e2) { res.down = e2; break }
      await sleep(300)
    }
    try { await bot.look(bot.entity.yaw, -0.5, true) } catch {}
    return res
  }
  let angryWait = 0
  let kills = 0
  let hpSpent = 0
  let stopped = null
  let idle = 0
  while (!ctl.aborted) {
    if (countOf(bot, 'ender_pearl') >= want) break
    if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
    // Лечиться до боя: сытость 18+ и хп 16+. Хп мало — в коробку 1x1 с
    // крышей (blaze.boxRest): злой эндермен без луча не бьёт (MeleeAttackGoal:
    // hasLineOfSight) и через 60 тиков теряет цель (лаборатория, дуэль 1:
    // двоих убил, третий злой пришёл на 12 хп — смерть).
    // Злой уже рядом — бой (от эндермена не уйти: телепорт), коробка при нём
    // не закрывается («в клетке стоит enderman», дуэль 2: смерть).
    const me0 = bot.entity.position
    const angryNow = ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && meta(bot, e, 'creepy') && e.position.distanceTo(me0) < 16)
    if ((bot.health ?? 20) < 16 && !angryNow) {
      const r: Awaited<ReturnType<typeof import('../blaze').boxRest>> = await (require('../blaze') as typeof import('../blaze')).boxRest(session, ctl, { toward: null, until: 19, maxMs: 60000 }).catch(e => ({ rested: false, why: e.message }))
      rests.push({ hp: r.hp, s: r.seconds, ok: r.rested, why: r.why })
      log('отдых', r)
      if (!r.rested) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} ; await sleep(1500) }
      continue
    }
    if ((bot.food ?? 20) <= 17) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} }
    const me = bot.entity.position
    const all = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false)
    const angry = all.filter((e : any) => meta(bot, e, 'creepy') && e.position.distanceTo(me) < 16 && (e.position.distanceTo(me) < 4 || (!skip.has(e.id) && seesMob(bot, e))))
    // Злить нового — только если злых в 24 блоках нет вовсе.
    // Злой, который 15 с не подходит (застрял за обрывом), — не в счёт на минуту
    // (прогон дуэли 3: бот простоял 6 минут, ожидая застрявшего).
    const angryNear = all.some((e : any) => meta(bot, e, 'creepy') && e.position.distanceTo(me) < 24 && !((ignoreAngry.get(e.id) || 0) > gameClock.now()))
    let em: any = angry.sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
    const round: any = { t: Math.round((gameClock.now() - t0) / 1000) }
    if (!em && angryNear) {
      if (!angryWait) angryWait = gameClock.now()
      if (gameClock.now() - angryWait > 15000) {
        for (const e of (all as any)) if (meta(bot, e, 'creepy')) ignoreAngry.set(e.id, gameClock.now() + 60000)
        angryWait = 0
      }
      await sleep(1000)
      continue
    }
    angryWait = 0
    const safeHere = safeSpot(bot.entity.position.floored())
    if (!em && safeHere && p.poke !== false && !angryClose(16)) {
      // Глаз не видно (искажённый лес: грибы и лозы — на двойнике мира
      // прохождения 66 эндерменов в 48 блоках, видимых глаз 0; штрек — 0
      // убийств за 400 с): разозлить УДАРОМ. Удар игрока злит эндермена без
      // всякого взгляда и без телепорта (EnderMan.hurtServer: телепорт — только
      // от снаряда или без живого обидчика; цель — обидчик, HurtByTargetGoal).
      const calm: any = all.filter((e : any) => !skip.has(e.id) && !meta(bot, e, 'creepy') && e.position.distanceTo(me) <= 16 && !trappedEm(bot, e) &&
        !all.some((o : any) => o !== e && o.position.distanceTo(e.position) < 4) &&
        !ents(bot).some((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(e.position) < 10) &&
        e.position.distanceTo(home0) < 64 && safeSpot(e.position.floored()))
        .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
      if (calm) {
        const pk: any = { id: calm.id, from: Math.round(calm.position.distanceTo(me)) }
        const tP = gameClock.now()
        while (!ctl.aborted && gameClock.now() - tP < 15000 && calm.isValid !== false && bot.entities[calm.id] && !meta(bot, calm, 'creepy')) {
          if (reachTo(bot, calm) <= 2.9) {
            const a = (require('../pick') as typeof import('../pick')).aim(bot, calm)
            if (a && a.point) {
              const w = bestWeapon(bot)
              if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) { try { await bot.equip(w, 'hand') } catch {} }
              pitchCap = -0.35
              try { await bot.lookAt(calm.position.offset(0, 0.6, 0), true) } catch {}
              try { bot.attack(calm); pk.hit = true } catch {}
              await sleep(400)
              break
            }
          }
          bot._ndNoMobAvoid = true
          try { pk.walk = (await walkTo(bot, ctl, calm.position.floored(), 1, 3000, () => angryClose(6))).error || 'ok' } finally { bot._ndNoMobAvoid = false }
          pk.dist = Math.round(reachTo(bot, calm) * 10) / 10
        }
        pitchCap = -0.5
        pk.angry = !!meta(bot, calm, 'creepy')
        pk.s = Math.round((gameClock.now() - tP) / 1000)
        log('удар-вызов', pk)
        if (pk.angry) { idle = 0; continue }
        skip.add(calm.id); gameClock.setTimeout(() => skip.delete(calm.id), 30000)
      }
    }
    if (!em) {
      const cand = safeHere ? pickTarget(all, me) : null
      if (!cand && idle % 3 === 0) {
        const v = vantage(all)
        if (v) {
          log('обзор', { to: xyz(v.pos), seen: v.seen, steps: v.d, checked: v.checked })
          await walkTo(bot, ctl, v.pos, 0, 15000, () => angryClose(6))
          idle++
          continue
        }
      }
      if (!cand && safeHere && idle % 3 === 1) {
        // С земли в лесу глаз не видно (прогоны 41–44: 20 эндерменов в 6..28,
        // видимых глаз 0): вышка в 3 блока здесь же — осмотреться сверху,
        // разозлить, спуститься и драться на земле (бой на земле 0–3 хп).
        const lo: any = await lookout()
        log('вышка', lo)
        if (lo.angry) { idle = 0; continue }
      }
    }
    if (!em) {
      em = !safeHere ? null : all.filter((e : any) => !skip.has(e.id) && eyesSeen(bot, e))
        // До 28 блоков (прогоны 41–42: в 6..20 ни у кого не видно глаз, 5 мин поиска;
        // допуск взгляда на 28 блоках — 2.4°, lookAt точен, дальний злой
        // телепортируется к нам сам: EndermanLookForPlayerGoal, дальше 16).
        .filter((e : any) => { const d = e.position.distanceTo(me); return d >= 6 && d <= 28 })
        // В лесу по 20 штук в 48 блоках — «никого в 16» не бывает: рядом с ним
        // никого в 6 и ни одного злого в 16.
        .filter((e : any) => !all.some((o : any) => o !== e && (o.position.distanceTo(e.position) < 3 || (meta(bot, o, 'creepy') && !((ignoreAngry.get(o.id) || 0) > gameClock.now()) && !trappedEm(bot, o) && o.position.distanceTo(e.position) < 16))))
        // Зомби-пиглины рядом — нет: удар с размаха задевает соседей, и стая злится
        // (дуэль 5: «slain by Zombified Piglin»).
        .filter((e : any) => !ents(bot).some((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(e.position) < 10))
        // Далеко от места старта не уходить (искажённый лес кончается).
        .filter((e : any) => e.position.distanceTo(home0) < 64 && !trappedEm(bot, e))
        .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
      if (!em) {
        if (++idle > 6) {
          idle = 0
          // Далеко ушли — назад к месту старта, иначе поиск дальше.
          if (bot.entity.position.distanceTo(home0) > 40 || bot.entity.position.y < home0.y - 10) { await walkTo(bot, ctl, home0.floored(), 4, 20000); continue }
          {
            const me1 = bot.entity.position
            const inR = all.filter((e : any) => { const d = e.position.distanceTo(me1); return d >= 6 && d <= 28 })
            const eyes = inR.filter(e => eyesSeen(bot, e))
            log('никого', { all: all.length, inRange: inR.length, eyes: eyes.length, angry: all.filter(e => meta(bot, e, 'creepy')).length, trapped: all.filter(e => trappedEm(bot, e)).length, skip: skip.size, y: Math.round(me1.y) })
          }
          const w = await searchWalk(bot, ctl, 24, () => angryClose(6), { high: true })
          log('поиск', { to: w })
        } else await sleep(1500)
        continue
      }
      idle = 0
      pitchCap = null
      const tA = gameClock.now()
      let looks = 0
      while (!ctl.aborted && gameClock.now() - tA < 5000 && !meta(bot, em, 'creepy') && em.isValid !== false) {
        if (eyesSeen(bot, em)) { await bot.lookAt(em.position.offset(0, 2.55, 0), true); looks++ }
        await sleep(100)
      }
      pitchCap = -0.5
      round.looks = looks
      if (!meta(bot, em, 'creepy')) { skip.add(em.id); continue }
    } else round.already = true
    try { await bot.look(bot.entity.yaw, -0.5, true) } catch {}
    const hpA = bot.health ?? 20
    // До конца: отход от эндермена бесполезен, бой кончается его смертью или нашей;
    // новые бои — только с 16+ хп (отдых в коробке до них).
    // Свой бой (openFight): ждать его на месте со щитом, бить в тело сразу
    // после его взмаха. combat.fight с опущенным взглядом не бил (прогон 38:
    // 4 боя, 0–4 взмаха, 0 убийств), а без него злил чужих.
    pitchCap = -0.35
    // Двое злых уже в 8 блоках — сразу столб, без боя на земле (двойник мира
    // прохождения: трое злых сняли 20 хп за 12 с).
    const crowdNow = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !deadIds.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < 8).length >= 2
    let f: any = crowdNow ? { crowd: true, swings: 0 } : await openFight(session, ctl, em, { retreatAt: 13, dead: deadIds, maxMs: 40000 }).catch(e => ({ error: e.message }))
    pitchCap = -0.5
    // Хп 10 и он жив — столб в 3 блока прямо здесь: его коробка удара раздута
    // только по горизонтали, до ног на +3 он не достаёт, а меч сверху бьёт его
    // голову (дуэль 3: смерть на 12 хп от второго злого).
    if (em.isValid !== false && bot.entities[em.id] && !ctl.aborted && ((bot.health ?? 20) <= 13 || f.crowd)) {
      const base = bot.entity.position.floored()
      const up = await towerUp(bot, ctl, 3)
      round.pillar = up.placed
      const w = bestWeapon(bot)
      if (w) { try { await bot.equip(w, 'hand') } catch {} }
      const tP = gameClock.now()
      let last = 0
      let nearAt = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tP < 30000 && em.isValid !== false && bot.entities[em.id]) {
        // Злые к столбу не идут 10 с (стоят в 6+ блоках) — слезть и дальше: на
        // двойнике три столба подряд по 35 с без единого взмаха.
        if (ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !deadIds.has(e.id) && meta(bot, e, 'creepy') && reachTo(bot, e) < 6)) nearAt = gameClock.now()
        if (gameClock.now() - nearAt > 10000) break
        // Со столба бьём любого злого, кто под нами в досягаемости (их бывает двое).
        const near: any = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !deadIds.has(e.id) && meta(bot, e, 'creepy') && reachTo(bot, e) <= 3.0)
          .sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0] || em
        const r = reachTo(bot, near)
        try { await bot.lookAt(near.position.offset(0, 2.2, 0), true) } catch {}
        if (r <= 3.0 && gameClock.now() - last >= SWING_MS) { try { bot.attack(near); last = gameClock.now() } catch {} }
        if ((bot.food ?? 20) < 18 && r > 4) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} }
        await sleep(80)
      }
      f = { ...f, killed: em.isValid === false || !bot.entities[em.id], fromPillar: true }
      // Вниз: свой столб из-под ног.
      for (let i = 0; i < 4 && !ctl.aborted; i++) {
        const feet = bot.entity.position.floored()
        if (feet.y <= base.y) break
        const e2 = await digCell(bot, session.mcData, feet.offset(0, -1, 0))
        if (e2) break
        await sleep(400)
      }
    }
    const lost = Math.max(0, hpA - (bot.health ?? 0))
    hpSpent += lost
    await sleep(300)
    if (f.target && f.target !== em) { round.retarget = f.retargets; em = f.target }
    round.killed = deadIds.has(em.id)
    round.swings = f.swings
    if (f.stale) { round.stale = true; ignoreAngry.set(em.id, gameClock.now() + 60000) }
    round.his = f.hisSwings
    round.blocked = f.blocked
    round.hpLost = Math.round(lost * 10) / 10
    round.why = f.error || f.stopped || f.mode || undefined
    if (round.killed) {
      kills++
      // Лут падает, когда тело убирают (через 20 тиков после смерти), там, где
      // он умер, — а отброс ударом уносит его на 2–4 блока (прогон 40: 6
      // убийств, 1 жемчуг: подбор в 6 блоках от себя сразу после боя).
      const deathAt = em.position.clone()
      await sleep(1300)
      const isPearl = e => { try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'ender_pearl' } catch { return false } }
      let drops = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(deathAt) < 10 && !lavaAround(bot, e.position))
      if (!drops.length) {
        // Метаданные предмета приходят позже самого предмета — ещё раз через 1.5 с.
        await sleep(1500)
        drops = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(deathAt) < 12 && !lavaAround(bot, e.position))
      }
      round.drop = drops.length
      round.items = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(deathAt) < 12).map((e : any) => { try { const it = e.getDroppedItem(); return it ? it.name : '?' } catch { return '!' } }).join(',') || undefined
      round.pearlsNow = countOf(bot, 'ender_pearl')
      for (const d of (drops as any)) {
        if (!bot.entities[d.id] || ctl.aborted) continue
        await walkTo(bot, ctl, d.position.floored(), 0, 7000)
        await pickUp(bot, ctl, 3, 1500)
      }
      await pickUp(bot, ctl, 6, 2000)
    } else { skip.add(em.id); gameClock.setTimeout(() => skip.delete(em.id), 20000) }
    rounds.push(round)
    log('дуэль', round)
    if ((bot.health ?? 20) <= retreatAt) {
      // Отойти и отъесться: злых рядом нет — есть; есть — уйти.
      try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {}
    }
  }
  bot.removeListener('entityHurt', onHurt)
  bot.removeListener('entityDead', onDead)
  bot.removeListener('entityGone', onGone)
  bot.removeListener('physicsTick', capPitch)
  bot.removeListener('entityHurt', onMeHurt)
  const pearls = countOf(bot, 'ender_pearl')
  const secs = Math.round((gameClock.now() - t0) / 1000)
  const detail: any = {
    mode: 'hunt',
    style: 'дуэль',
    pearls: { before: pearls0, now: pearls, gained: pearls - pearls0, want },
    kills,
    hpPerKill: kills ? Math.round(hpSpent / kills * 10) / 10 : null,
    killsPerHour: secs ? Math.round(kills * 3600 / secs) : 0,
    rests: rests.length ? rests : undefined,
    rounds: rounds.slice(-10),
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    seconds: secs
  }
  if (pearls < want) {
    detail.need = { what: 'ender_pearl', count: want - pearls, have: pearls }
    detail.stopped = `${stopped || 'встал'} — жемчуга ${pearls} из ${want} (убил ${kills})`
  }
  detail.note = `Жемчуг +${detail.pearls.gained}, убито ${kills} за ${secs} с, хп на убийство ${detail.hpPerKill}.`
  return detail
}

export { huntDuel }
