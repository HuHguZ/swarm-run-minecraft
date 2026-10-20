'use strict'
// Стержни ифрита (farmRods) — старый цикл боя (p.legacy, для сравнения с holdSpawner): шаги оборота в прежнем порядке
// тела while; шаг возвращает 'next' (прежний continue), 'stop' (прежний break) или ничего (дальше по шагам).
import * as gameClock from '../../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from '../../movement'
import { countOf, itemNamed } from '../../items'
import { log, reachTo, seesMob, nearestBlaze, droppedRods, watchers } from '../targets'
import { hasEffect } from '../potions'
import { collectRods, snowballAt, makeTrack, walkNear, takeCover, rest } from '../approach'
import { type RodsFarm, SNOW_RANGE, SWORD_REACH, CHASE_FROM_COVER, LEASH } from './state'

export type Turn = 'next' | 'stop' | undefined

// Значения одного оборота, общие для шагов (прежние const внутри while).
export interface RodsTick {
  hp?: number
  watching?: number
  fireproof?: boolean
  blaze?: any
}

export async function legacyLimits (fr: RodsFarm, tk: RodsTick): Promise<Turn> {
  const { bot, ctl, session } = fr
  const have = countOf(bot, 'blaze_rod')
  tk.hp = Math.round(bot.health ?? 0)
  if (ctl.aborted) { fr.stopped = 'прервано'; return 'stop' }
  if (have >= fr.want) return 'stop'
  if (gameClock.now() > fr.deadline) { fr.stopped = 'время вышло'; return 'stop' }
  // Сначала отдых за углом, и только если его нет — конец боя.
  if (fr.restsLeft > 0 && tk.hp <= fr.restAt) {
    fr.restsLeft--
    fr.phase = 'отдых'
    const r = await rest(session, ctl, fr.dead)
    fr.rests.push(r)
    log('отдых', r)
    if (r.rested) return 'next'
    fr.restsLeft = 0
  }
  if (tk.hp <= fr.retreatAt) { fr.stopped = `хп ${tk.hp} — дальше не дерусь (порог ${fr.retreatAt})`; fr.bail = true; return 'stop' }
  if (fr.highTimeouts >= 3) {
    fr.stopped = 'блейз держится выше досягаемости меча, а бить издалека нечем: нужен лук со стрелами или снежки'
    return 'stop'
  }
}

export async function legacyEat (fr: RodsFarm): Promise<void> {
  const { bot, session } = fr
  // Автопилот в намерении не ест (autopilot.js bodyBusy) — ест бой сам,
  // между блейзами, пока шары не летят.
  if ((bot.food ?? 20) <= 14) {
    try {
      const r = await fr.actions.eat(session, {})
      if (r && r.ate) fr.ate.push(r.ate)
    } catch {}
  }
}

export async function legacyCover (fr: RodsFarm, tk: RodsTick): Promise<Turn> {
  const { bot, ctl } = fr
  // Больше двух видят нас — сначала укрытие, потом бой (замер (а): пять
  // блейзов разом сняли 20 хп за 24 с, и бот умер посреди второго боя).
  tk.watching = watchers(bot, fr.dead)
  if (gameClock.now() - fr.lastBeat > 2000) {
    fr.lastBeat = gameClock.now()
    log('шаг', { t: Math.round((gameClock.now() - fr.t0) / 1000), hp: tk.hp, watching: tk.watching, fire: !!(bot.entity.metadata && (bot.entity.metadata[0] & 1)), pos: xyz(bot.entity.position) })
  }
  // Под огнестойкостью шары не жгут вовсе (fireball в #is_fire) — прятаться
  // не от чего, опасен только удар в упор, и бой идёт в открытую.
  tk.fireproof = hasEffect(bot, 'fire_resistance')
  // Под зельем угол не нужен: иначе сторож «не гоняться из укрытия»
  // держал бы тело там вечно (прогон с зельем простоял 396 с при шести
  // видящих и не ударил ни разу).
  if (tk.fireproof) fr.anchor = null
  if (!tk.fireproof && fr.covers.length < 12 && tk.watching >= 2 && gameClock.now() - fr.coverFailAt > 15000) {
    fr.phase = 'укрытие'
    const c = await takeCover(bot, ctl, fr.dead)
    fr.covers.push(c)
    log('укрытие', { watching: tk.watching, hp: Math.round(bot.health ?? 0), ...c })
    if (c.at) { fr.coverAt = gameClock.now(); fr.anchor = new Vec3(c.at.x, c.at.y, c.at.z); fr.farSince = 0 } else { fr.coverFailAt = gameClock.now(); fr.coverFails++ }
    return 'next'
  }
  // Трое и больше видят, укрыться не вышло дважды, а огнестойкости нет —
  // это не бой, а тир по нам: 4–5 блейзов в железе снимают 20 хп за 8 с
  // открытого стояния (замеры (а)). Уйти, пока хп есть, и сказать почему.
  // Или: укрыться только что не вышло, а видят трое — ждать второго отказа
  // значит стоять под очередями (прогон (г): 16 → 5 хп между отказами).
  if (!tk.fireproof && tk.watching >= 3 && (fr.coverFails >= 2 || gameClock.now() - fr.coverFailAt < 15000)) {
    fr.stopped = `видят сразу ${tk.watching} блейза, а укрыться не вышло — под перекрёстным огнём не стою. ` +
      'Нужна огнестойкость (зелье: бартер пиглинов или варка) или укрытие у спавнера — поставь блоки и позови снова'
    fr.bail = true
    return 'stop'
  }
}

export async function legacyTarget (fr: RodsFarm, tk: RodsTick): Promise<Turn> {
  const { bot, ctl } = fr
  tk.blaze = nearestBlaze(bot, fr.radius, fr.skip.size ? new Set([...fr.dead, ...fr.skip]) : fr.dead)
  if (!tk.blaze) {
    if (droppedRods(bot, 12) > 0) {
      fr.phase = 'сбор'
      await collectRods(bot, ctl, 12, 6000)
      return 'next'
    }
    const idle = gameClock.now() - fr.idleSince
    if (idle > (fr.spawner ? 50000 : fr.toured ? 30000 : 6000)) {
      fr.stopped = fr.spawner
        ? `спавнер молчит ${Math.round(idle / 1000)}с (блейзов в ${fr.radius} бл. нет) — встань в 16 блоках от него на ${fr.spawner.x},${fr.spawner.y},${fr.spawner.z}`
        : `блейзов в ${fr.radius} блоках больше не вижу`
      return 'stop'
    }
    fr.phase = 'ожидание'
    await sleep(400)
    return 'next'
  }
  fr.idleSince = gameClock.now()
  // Только что ушли в укрытие и никого не видно — подождать, пока выйдут
  // из-за угла, а не гнаться pathfinder'ом обратно под огонь.
  if (!seesMob(bot, tk.blaze) && gameClock.now() - fr.coverAt < 6000) {
    await sleep(400)
    return 'next'
  }
  // Ближайший за стеной, и мы не в укрытии — подойти, а не звать бой:
  // бой по невидимому отвечает «не видно — за стеной» сразу, и прогон 11
  // крутил так четырнадцать «боёв» подряд у крепости без спавнера.
  if (!seesMob(bot, tk.blaze) && !fr.anchor) {
    if (fr.unseenWalks < 6) {
      fr.unseenWalks++
      fr.phase = 'к невидимому'
      await walkNear(bot, ctl, tk.blaze.position.floored(), 6, 8000)
      return 'next'
    }
    fr.skip.add(tk.blaze.id)
    fr.unseenWalks = 0
    return 'next'
  }
  fr.unseenWalks = 0
}

export async function legacySnow (fr: RodsFarm, tk: RodsTick): Promise<Turn> {
  const { bot } = fr
  // Висит выше меча и видно — снежок, пока есть: 3 урона без сближения.
  const r = reachTo(bot, tk.blaze)
  // Только один на один: стоя с поднятой рукой под тремя очередями, бот
  // сгорал с 20 до 10 хп за шестнадцать снежков (замер (а), третий прогон).
  if (r > SWORD_REACH + 0.3 && r <= SNOW_RANGE && tk.watching <= 1 && itemNamed(bot, 'snowball') && seesMob(bot, tk.blaze)) {
    const track = makeTrack(tk.blaze)
    track.update()
    await sleep(100)
    track.update()
    fr.phase = 'снежки'
    const s = await snowballAt(bot, tk.blaze, track).catch(() => null)
    if (s && s.thrown) fr.thrown++
    await sleep(200)
    return 'next'
  }
}

export async function legacyFar (fr: RodsFarm, tk: RodsTick): Promise<Turn> {
  // Из укрытия за далёким не гоняться: погоня через всю комнату увела тело
  // на 15 блоков от угла, и обратный путь под двумя очередями стоил 11 хп
  // (замер (а), шестой прогон). Далёкого бьют лук и снежки; мечом — только
  // того, кто сам подлетел, или если ждать уже 15 с, а видит нас он один.
  if (fr.anchor && tk.blaze.position.distanceTo(fr.anchor) > CHASE_FROM_COVER) {
    if (!fr.farSince) fr.farSince = gameClock.now()
    if (gameClock.now() - fr.farSince < 15000 || tk.watching > 1) {
      await sleep(400)
      return 'next'
    }
  } else {
    fr.farSince = 0
  }
}

export async function legacyFight (fr: RodsFarm, tk: RodsTick): Promise<Turn> {
  const { bot, ctl, session, p } = fr
  // Из укрытия без огнестойкости — на поводке: бой гнался за блейзом на 13
  // блоков от угла, и там тело увидели одиннадцать (try-blaze-rods (г),
  // 2026-09-25: смерть). Дальше LEASH от угла — бой обрывается, назад в угол.
  const sub = { aborted: false, onAbort: [] }
  const leash = gameClock.setInterval(() => {
    const far = fr.anchor && !tk.fireproof && bot.entity && bot.entity.position.distanceTo(fr.anchor) > LEASH
    if ((ctl.aborted || far) && !sub.aborted) {
      sub.aborted = true
      for (const fn of sub.onAbort) { try { fn() } catch {} }
    }
  }, 150)
  fr.phase = 'бой'
  const f = await fr.combat.fight(session, sub, {
    // Именно этого, видимого (combat.findTarget «#id»). По имени бой брал
    // ближайшего вообще — за стеной — и уводил тело из укрытия под огонь
    // остальных: «blaze не видно — за стеной» дважды за прогон.
    target: '#' + tk.blaze.id,
    purpose: 'resource',
    resourceGoal: { item: 'blaze_rod', count: fr.want },
    allowRanged: p.allowRanged,
    clearArea: 0,
    retreatAtHealth: fr.restsLeft > 0 ? fr.restAt : fr.retreatAt,
    // Короткий бой: погоня за одним выводит из укрытия под остальных, и
    // решение «где стоять» надо пересматривать чаще (второй бой того же
    // прогона — 20 → 11 хп при двух видящих).
    timeoutSeconds: 12,
    shield: p.shield || 'ranged'
  }).catch(e => ({ error: String(e.message || e) })).finally(() => gameClock.clearInterval(leash))
  if (sub.aborted && !ctl.aborted) f.leashed = true
  const brief = {
    killed: f.killed || (f.kills ? f.kills.join(', ') : undefined),
    swings: f.swings,
    arrows: f.arrows,
    hp: f.hp,
    why: f.leashed ? `поводок: дальше ${LEASH} бл. от укрытия не гонюсь` : (f.error || f.lost || f.stopped || (f.timeout ? 'время боя вышло' : undefined))
  }
  fr.fights.push(brief)
  log('бой', { watching: tk.watching, ...brief })
  // «Не достал»: бой кончился по времени, а ни взмаха, ни стрелы не было.
  if ((f.timeout || (!brief.killed && /время/.test(brief.why || ''))) && !f.swings && !f.arrows) {
    fr.highTimeouts++
  } else if (brief.killed) {
    fr.highTimeouts = 0
  }
  if ((f.retreated || f.lowHealth) && fr.restsLeft <= 0) { fr.stopped = `отошёл: ${f.mode || f.why || 'мало хп'}`; return 'stop' }
  fr.phase = 'сбор'
  await collectRods(bot, ctl, 10, 5000)
  // Бой увёл от угла — назад, пока новые не набежали.
  if (fr.anchor && bot.entity.position.distanceTo(fr.anchor) > 5 && !ctl.aborted) {
    fr.phase = 'назад в укрытие'
    await walkNear(bot, ctl, fr.anchor, 0, 8000)
  }
}

// Порядок шагов оборота — порядок веток прежнего тела while.
const LEGACY_STEPS: ((fr: RodsFarm, tk: RodsTick) => Promise<Turn | void>)[] = [
  legacyLimits, legacyEat, legacyCover, legacyTarget, legacySnow, legacyFar, legacyFight
]

// Старый цикл боя: крутится, только пока p.legacy (иначе бой уже провёл holdSpawner).
export async function rodsLegacy (fr: RodsFarm) {
  const { p } = fr
  fr.idleSince = gameClock.now()
  turn: while (p.legacy) {
    const tk: RodsTick = {}
    for (const step of LEGACY_STEPS) {
      const r = await step(fr, tk)
      if (r === 'stop') break turn
      if (r === 'next') continue turn
    }
  }
}
