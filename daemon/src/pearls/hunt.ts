'use strict'
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import { countOf, bestWeapon } from '../items'
import * as worlds from '../worlds'
import { SWING_MS, clamp, log, meta, seesMob, walkTo, pickUp, stepInto } from './common'
import { eyesSeen, nearestEnderman, reachTo, searchWalk, openFight } from './aim'
import { hideoutPlan, digHideout, climbOut } from './shelter'
import { huntPillar } from './hunt-pillar'
import { huntTunnel } from './hunt-tunnel'
import { huntFoxhole } from './foxhole'
import { huntDuel } from './duel'

// S1e 07.10: сколько разных эндерменов было в виду (луч к телу, 64 бл.) за вызов охоты — кампания прекращает заходы, где их нет
// (S1d: 23–40 мин охоты «без единого в виду»), и считает по этому цену жемчуга эндерменами.
async function hunt (session, ctl, p: any = {}) {
  const bot = session.bot
  const ids = new Set()
  const peek = () => { try { for (const e of Object.values(bot.entities) as any[]) if (e && e.name === 'enderman' && e.position && e.position.distanceTo(bot.entity.position) <= 64 && seesMob(bot, e)) ids.add(e.id) } catch {} }
  peek()
  const timer = gameClock.setInterval(peek, 1000)
  try {
    const r: any = await huntStyled(session, ctl, p)
    peek()
    return { ...r, seenEndermen: ids.size }
  } finally { gameClock.clearInterval(timer) }
}

async function huntStyled (session, ctl, p: any = {}) {
  const boatSkill: typeof import('../combat/enderman-boat') = require('../combat/enderman-boat')
  const target = p.boatTrap === false ? null : boatSkill.boatTarget(session)
  if (!target) return huntLegacy(session, ctl, p.style === 'boat' ? { ...p, style: 'foxhole' } : p)
  const bot = session.bot
  const before = countOf(bot, 'ender_pearl')
  const wanted = Math.max(1, p.count ?? 4)
  const began = gameClock.now()
  const result = await boatSkill.tryEndermanBoat(session, ctl, target)
  if (result.killed && !ctl.aborted && bot.health > 0) {
    await sleep(1300)
    await pickUp(bot, ctl, 6, 2500)
  }
  const now = countOf(bot, 'ender_pearl')
  const gained = now - before
  const seconds = (gameClock.now() - began) / 1000
  const remaining = (p.timeoutSeconds ?? 240) - seconds
  const detail = { mode: 'hunt', style: 'лодка', boatTrap: result, kills: result.killed ? 1 : 0,
    pearls: { before, now, gained, want: before + wanted }, seconds: Math.round(seconds),
    stopped: result.why, note: result.killed ? 'Эндермен посажен в лодку подтверждённым пакетом пассажиров и убит.' : 'Лодка не поймала эндермена: ' + result.why }
  log('лодка', result)
  if (gained >= wanted || p.boatOnly === true || ctl.aborted || bot.health <= 0 || remaining < 30) return detail
  const fallback = await huntLegacy(session, ctl, { ...p, style: p.style === 'boat' ? 'foxhole' : p.style,
    count: wanted - gained, timeoutSeconds: remaining })
  const final = countOf(bot, 'ender_pearl')
  return { ...fallback, boatTrap: result, kills: (fallback.kills || 0) + (result.killed ? 1 : 0),
    pearls: { before, now: final, gained: final - before, want: before + wanted }, seconds: Math.round((gameClock.now() - began) / 1000) }
}

async function huntLegacy (session, ctl, p: any = {}) {
  if (process.env.ND_HUNT_OPEN_GROUND === '1' && worlds.worldOf(session.bot) === 'the_nether' && (!p.style || p.style === 'foxhole' || p.style === 'tunnel')) return huntTunnel(session, ctl, p)
  if (p.style === 'duel') return huntDuel(session, ctl, p)
  if (p.style === 'foxhole') return huntFoxhole(session, ctl, p)
  if (p.style === 'pillar') return huntPillar(session, ctl, p)
  if (p.style !== 'shaft') return huntTunnel(session, ctl, p)
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const radius = clamp(p.radius ?? 40, 8, 64)
  const pearls0 = countOf(bot, 'ender_pearl')
  const want = pearls0 + Math.max(1, p.count ?? 4)
  const hp0 = Math.round(bot.health ?? 20)
  const retreatAt = clamp(p.retreatAtHealth ?? 8, 3, 16)
  const kills = []
  const dead = new Set()
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'enderman') hurtAt.set(e.id, gameClock.now()) }
  const onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || dead.has(e.id) || !e.position) return
    if (e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    dead.add(e.id)
    kills.push({ at: xyz(e.position), t: Math.round((gameClock.now() - t0) / 1000) })
  }
  const onGone = e => onDead(e, 'gone')
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  const rounds = []
  let stopped = null
  let hide = null
  // Не разозлился, не дошёл, не пришёл к шахте — следующий, а не конец охоты
  // (лаборатория: первый же «не поймал взгляд» кончал вызов, 1 жемчуг за 5).
  const skip = new Set()
  let fails = 0
  let searches = 0
  try {
    const weapon = bestWeapon(bot)
    while (!ctl.aborted) {
      if (countOf(bot, 'ender_pearl') >= want) break
      if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
      if ((bot.health ?? 20) <= retreatAt) { stopped = `хп ${Math.round(bot.health)} — дальше не охочусь`; break }
      // Автопилот в намерении не ест — между раундами ест охота сама: хп
      // восстанавливаются только при сытости 18+.
      if ((bot.food ?? 20) <= 16) {
        try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {}
      }
      const em: any = nearestEnderman(bot, radius, skip.size ? new Set([...dead, ...skip]) : dead)
      if (!em) {
        // Никого на виду — пройтись: в лесу за грибами их не видно с места.
        if (searches < 4 && deadline - gameClock.now() > 30000) {
          searches++
          if (hide) { await climbOut(bot, ctl, hide).catch(() => null); hide = null }
          const w = await searchWalk(bot, ctl, rounds.length ? 20 : 16)
          log('поиск', { n: searches, to: w })
          continue
        }
        stopped = `эндерменов в ${radius} блоках не вижу` + (worlds.worldOf(bot) === 'the_nether' ? ' (в Аду их больше всего в искажённом лесу — warped_forest)' : ' (в верхнем мире они ходят ночью)')
        break
      }
      const round: any = { enderman: em.id, from: Math.round(em.position.distanceTo(bot.entity.position)) }
      rounds.push(round)
      if (hide) { round.climbFirst = await climbOut(bot, ctl, hide); hide = null }
      // Сначала место для норы, потом злить: без плана — шаг в сторону.
      let plan = hideoutPlan(bot, mcData)
      if (!plan) {
        // Ближайшая связанная клетка, где нора выйдет (в Аду под ногами
        // пустоты и карманы лавы — случайный шаг попадал в них трижды из трёх).
        const { walkable }: typeof import('../walkable') = require('../walkable')
        const spot = walkable(bot, bot.entity.position, { radius: 12, maxNodes: 2500 })
          .find(n => n.d >= 1 && hideoutPlan(bot, mcData, n.pos))
        if (spot) {
          const w = await walkTo(bot, ctl, spot.pos, 0, 12000)
          if (!bot.entity.position.floored().equals(spot.pos)) await stepInto(bot, spot.pos)
          const at = bot.entity.position.floored()
          round.moved = { ...xyz(spot.pos), ok: w.ok, at: at.equals(spot.pos) ? undefined : xyz(at) }
          plan = hideoutPlan(bot, mcData)
          if (!plan) round.moved.replan = !!hideoutPlan(bot, mcData, spot.pos)
        }
      }
      if (!plan) {
        skip.add(em.id)
        log('раунд', { ...round, skipped: 'нет места под нору' })
        if (++fails >= 4) { stopped = 'места под нору (шахта 3-4 и штрек под потолком) рядом не нашёл'; break }
        continue
      }
      round.plan = { depth: plan.depth, dir: plan.dir }
      // 1. Разозлить: взгляд в глаза — с земли, из ямы их не видно (первый
      //    прогон: яма, потом 30 с взгляда в край ямы, эндермен так и не
      //    разозлился). Смотреть, пока он дальше 4 блоков: ближе под взглядом он
      //    уходит телепортом.
      if (hide) { round.climbFirst = await climbOut(bot, ctl, hide); hide = null }
      const angryBefore = !!meta(bot, em, 'creepy')
      const tA = gameClock.now()
      const stare = { looks: 0, blind: 0 }
      try { bot.clearControlStates() } catch {}
      while (!ctl.aborted && gameClock.now() - tA < 8000 && !meta(bot, em, 'creepy') && em.isValid !== false) {
        const eyes = em.position.offset(0, 2.55, 0)
        if (em.position.distanceTo(bot.entity.position) < 5) break
        if (eyesSeen(bot, em)) { await bot.lookAt(eyes, true); stare.looks++ } else stare.blind++
        // Глаз не видно 2 с — не ждать восьми: идти и ударить.
        if (stare.blind >= 20 && !stare.looks) break
        await sleep(100)
      }
      round.angry = !!meta(bot, em, 'creepy') || angryBefore
      round.stare = stare
      // Взгляд не поймал (он отвернулся, ушёл за угол, телепортнулся) — один
      // удар мечом злит наверняка: удар игрока без телепорта, цель — мы.
      if (!round.angry && em.isValid !== false && em.position.distanceTo(bot.entity.position) < 24) {
        await walkTo(bot, ctl, em.position.floored(), 2, 12000)
        if (reachTo(bot, em) <= 3.0) {
          if (weapon) { try { await bot.equip(weapon, 'hand') } catch {} }
          try { await bot.lookAt(em.position.offset(0, 0.5, 0), true); bot.attack(em); round.poked = true } catch {}
          await sleep(300)
          round.angry = !!meta(bot, em, 'creepy') || !!round.poked
        }
      }
      if (!round.angry) {
        skip.add(em.id)
        log('раунд', { ...round, skipped: 'не разозлил и не дошёл' })
        if (++fails >= 4) { stopped = 'четверых подряд не разозлил: взгляд в глаза не ловится, дойти не выходит'; break }
        continue
      }
      // Разозлили ударом — он рядом, копать при нём нельзя: бой на месте.
      if (round.poked) {
        const f = await openFight(session, ctl, em, { retreatAt, dead })
        round.open = f
        log('раунд', round)
        if (f.killed) { fails = 0; await pickUp(bot, ctl, 6, 4000) } else { skip.add(em.id); if (++fails >= 4) { stopped = 'после удара не добил: бой на месте не вышел'; break } }
        continue
      }
      // 2. Сразу прочь глазами и вниз: шахта и штрек — семь блоков породы,
      //    с киркой это пара секунд, злой эндермен с 8 блоков идёт две-три.
      try { await bot.look(bot.entity.yaw, -Math.PI / 2, true) } catch {}
      const h = await digHideout(bot, ctl, mcData, plan)
      round.hideout = h.ok ? `шахта ${h.shaft.x},${h.shaft.y},${h.shaft.z}, стою в ${h.stand.x},${h.stand.y},${h.stand.z}` : h.why
      if (!h.ok) {
        if (h.shaft) hide = { shaft: h.shaft, stand: h.shaft, top: h.shaft.offset(0, 3, 0) }
        // Злой уже идёт, а норы нет — бой на месте: меч в тело, щит между ударами.
        const f = await openFight(session, ctl, em, { retreatAt, dead })
        round.open = f
        log('раунд', round)
        if (f.killed) { fails = 0; await pickUp(bot, ctl, 6, 4000) } else { skip.add(em.id); if (++fails >= 4) { stopped = `укрытие не вышло: ${h.why}`; break } }
        continue
      }
      hide = h
      // 3. Ждать в штреке и бить в ноги того, кто спрыгнет в шахту. На голову
      //    не смотреть: взгляд в глаза ближе 4 блоков — и он уходит телепортом.
      try { await bot.lookAt(hide.shaft.offset(0.5, 0.3, 0.5), true) } catch {}
      if (weapon) { try { await bot.equip(weapon, 'hand') } catch {} }
      const tB = gameClock.now()
      let swings = 0
      let lastSwing = 0
      // Свидетель «укрытие держит»: хп, потерянные уже В штреке (до него —
      // пока копал — эндермен бить может, это цена, а не сбой).
      const hpHide = bot.health ?? 20
      let hpMin = hpHide
      round.hpAtHide = Math.round(hpHide)
      while (!ctl.aborted && gameClock.now() - tB < 30000 && em.isValid !== false && !dead.has(em.id)) {
        hpMin = Math.min(hpMin, bot.health ?? 20)
        round.hurtInHide = Math.round(hpHide - hpMin)
        if ((bot.health ?? 20) <= retreatAt) break
        const r = reachTo(bot, em)
        if (r <= 3.0 && gameClock.now() - lastSwing >= SWING_MS) {
          try {
            await bot.lookAt(em.position.offset(0, 0.3, 0), true)
            bot.attack(em)
            swings++
            lastSwing = gameClock.now()
          } catch {}
        }
        await sleep(60)
      }
      round.swings = swings
      round.killed = dead.has(em.id)
      round.seconds = Math.round((gameClock.now() - tB) / 1000)
      log('раунд', round)
      if (round.killed) {
        // Жемчуг лежит на дне шахты, где он умер: два шага туда.
        await sleep(900)
        const t1 = hide.shaft.plus(hide.stand.minus(hide.shaft).scaled(0.5)).floored()
        await stepInto(bot, t1)
        await stepInto(bot, hide.shaft)
        await pickUp(bot, ctl, 3, 3000)
        fails = 0
      } else if (!round.swings) {
        // Не пришёл за 30 с — либо не злой, либо дороги к шахте нет: следующий.
        skip.add(em.id)
        if (++fails >= 4) {
          stopped = round.angry ? 'эндермены злые, но к шахте не приходят' : 'не разозлился: взгляд в глаза не поймал (нужен луч до его глаз и дальше 4 блоков)'
          break
        }
      }
    }
  } finally {
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entityDead', onDead)
    bot.removeListener('entityGone', onGone)
  }
  const out = await climbOut(bot, ctl, hide).catch(() => null)
  const pearls = countOf(bot, 'ender_pearl')
  const detail: any = {
    mode: 'hunt',
    pearls: { before: pearls0, now: pearls, gained: pearls - pearls0, want },
    kills: kills.length,
    rounds: rounds.slice(-6),
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    climbedOut: out ? out.ok : undefined,
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (pearls < want) {
    detail.need = { what: 'ender_pearl', count: want - pearls, have: pearls }
    detail.stopped = `${stopped || 'встал'} — жемчуга ${pearls} из ${want} (убил ${kills.length}; игра даёт 0..1 с эндермена, в среднем 0.5)`
  }
  detail.note = `Жемчуг +${detail.pearls.gained} (теперь ${pearls}), эндерменов убито ${kills.length}. ` +
    'Приём: шахта в 3 блока и штрек высотой 2 от её дна — эндермен (2.9) в штрек не влезает и со дна шахты не достаёт, ' +
    'а меч из штрека бьёт его в ноги; в глаза ему смотрю только издали, чтобы разозлить.'
  return detail
}

export { hunt }
