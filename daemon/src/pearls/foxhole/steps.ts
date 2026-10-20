'use strict'
// Окоп (huntFoxhole) — шаги оборота цикла охоты, в прежнем порядке веток тела while: шаг возвращает 'next'
// (прежний continue), 'stop' (прежний break) или ничего (дальше по шагам). Порядок — FOX_STEPS в pearls/foxhole.ts.
import * as gameClock from '../../game-clock'
import { sleep, xyz } from '../../movement'
import { countOf } from '../../items'
import { SWING_MS, POKE_R, log, ents, walkTo, pickUp } from '../common'
import { safeAim, reachTo, lavaAround, openFight } from '../aim'
import { trappedEm } from '../shelter'
import { foxExit, foxEnter } from './site'
import { type FoxHunt, foxStare, foxStarePool, foxNewSite, foxFightOpen } from './state'

export type Turn = 'next' | 'stop' | undefined

// Значения одного оборота, общие для шагов (прежние const внутри while).
export interface FoxTick {
  all?: any[]
}

// Раз в 30 с — почему некого звать (прежнее huntFoxhole._why).
const pokeWhy: { at?: number } = {}

export function stepLimits (fh: FoxHunt): Turn {
  const { bot } = fh
  if (countOf(bot, 'ender_pearl') >= fh.want) return 'stop'
  if (gameClock.now() > fh.deadline) { fh.stopped = 'время вышло'; return 'stop' }
  // Без кирки окоп не копается — выйти, пусть этап сделает запасные (campaign spares).
  if (!bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) { fh.stopped = 'кирка кончилась'; return 'stop' }
}

export async function stepReturn (fh: FoxHunt): Promise<Turn> {
  const { bot, ctl } = fh
  if (!fh.inHole()) {
    if (await foxFightOpen(fh)) return 'next'
    const ok = await foxEnter(bot, ctl, fh.fox)
    if (!ok) {
      log('окоп: не вернулся', { at: xyz(bot.entity.position) })
      if (await foxFightOpen(fh)) return 'next'
      fh.bad.push(fh.fox.P)
      const s = await foxNewSite(fh)
      if (!s.ok) { fh.stopped = `в окоп не вернулся, новый не вышел: ${s.why}`; return 'stop' }
      fh.fox = s.fox
      fh.moves++
      return 'next'
    }
  }
}

export async function stepTend (fh: FoxHunt, tick: FoxTick): Promise<void> {
  const { bot, session } = fh
  // Есть и лечиться — в окопе безопасно.
  if ((bot.food ?? 20) <= 16 || ((bot.health ?? 20) < 16 && (bot.food ?? 20) < 20)) { try { await (require('../../actions') as typeof import('../../actions')).eat(session, {}) } catch {} }
  const all = fh.endermen()
  for (const e of (all as any)) {
    if (!fh.angry(e)) { fh.angrySince.delete(e.id); continue }
    fh.recentAngry.set(e.id, gameClock.now())
    if (!fh.angrySince.has(e.id)) fh.angrySince.set(e.id, gameClock.now())
    else if (gameClock.now() - fh.angrySince.get(e.id) > 25000 && reachTo(bot, e) > 3.2) fh.ignore.set(e.id, gameClock.now() + 60000)
  }
  tick.all = all
}

export async function stepStrike (fh: FoxHunt, tick: FoxTick): Promise<Turn> {
  const { bot, ctl, session, mcData } = fh
  const { all } = tick
  // 1. В досягаемости — бить в тело (в глаза не смотреть).
  // Запас 0.2 до 3.0: сервер меряет досягаемость от своей позиции тела, и на краю
  // взмахи не засчитывались (foxhole-11, слот 19: 31 взмах, эндермен жив).
  const zpNear = ents(bot).filter((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(bot.entity.position) < 8)
  const near: any = all.filter((e : any) => reachTo(bot, e) <= 2.8 && safeAim(bot, e) && !zpNear.some((o : any) => o.position.distanceTo(e.position) < 3)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
  if (near) {
    fh.lastReach = gameClock.now()
    if (fh.weapon && (!bot.heldItem || bot.heldItem.name !== fh.weapon.name)) { try { await bot.equip(fh.weapon, 'hand') } catch {} }
    const r: any = { id: near.id, t: Math.round((gameClock.now() - fh.t0) / 1000), swings: 0, angry: fh.angry(near) }
    const hpA = bot.health ?? 20
    const onMe0 = fh.hitsOnMe
    let last = 0
    const tA = gameClock.now()
    let gone = 0
    // Сколько взмахов дошло (его entityHurt) — на ферме бывало 31–37 взмахов без
    // убийства, а он в это время бил нас в яме (foxhole-13, слоты 15 и 19).
    let landed = 0
    const onHit = e => { if (e && e.id === near.id) landed++ }
    bot.on('entityHurt', onHit)
    // Щит между взмахами: яма бережёт от луча, но не от всего (эндермен уносит
    // блоки стенки — нилий #enderman_holdable — и бьёт сбоку).
    const guard = (require('../../combat') as typeof import('../../combat')).makeShield(session, ctl, { shield: 'ranged' })
    try {
      await guard.wear()
      while (!ctl.aborted && gameClock.now() - tA < 30000 && near.isValid !== false && bot.entities[near.id] && !fh.dead.has(near.id)) {
        const aim = reachTo(bot, near) <= 2.8 ? safeAim(bot, near) : null
        if (!aim) { if (!gone) gone = gameClock.now(); if (gameClock.now() - gone > 6000) break; await sleep(100); continue }
        gone = 0
        try { await bot.lookAt(aim.pt, true) } catch {}
        if (gameClock.now() - last >= SWING_MS) {
          await guard.raise(false)
          if (fh.weapon && (!bot.heldItem || bot.heldItem.name !== fh.weapon.name)) { try { await bot.equip(fh.weapon, 'hand') } catch {} }
          try { bot.attack(near); r.swings++; fh.hits++; last = gameClock.now() } catch {}
        } else if (gameClock.now() - last > 150) await guard.raise(true)
        await sleep(60)
      }
    } finally {
      bot.removeListener('entityHurt', onHit)
      try { await guard.raise(false) } catch {}
      guard.close()
    }
    r.landed = landed
    fh.pitchCap = -0.35
    await sleep(250)
    r.killed = fh.dead.has(near.id)
    r.hpLost = Math.round((hpA - (bot.health ?? 20)) * 10) / 10
    r.hitsOnMe = fh.hitsOnMe - onMe0
    if (r.killed) {
      fh.kills++
      fh.lastChance = gameClock.now()
      const at = near.position.clone()
      await sleep(1500)
      const had = countOf(bot, 'ender_pearl')
      const lying = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && fh.isPearl(e) && e.position.distanceTo(at) < 8 && !lavaAround(bot, e.position))
      r.drop = lying.length
      // Не подобралось из ямы само, злых рядом нет — выйти и подобрать.
      if (lying.length && !fh.endermen().some((e : any) => fh.angry(e) && !fh.ignored(e) && e.position.distanceTo(bot.entity.position) < 12)) {
        if (await foxExit(bot, ctl, mcData, fh.fox)) {
          for (const it of (lying as any)) {
            if (!bot.entities[it.id] || ctl.aborted) continue
            // S1e: до 1 бл. по горизонтали, а не «в клетку предмета» (лаборатория s1e-L3: 18 убийств → подобрано 2, «собрал лежащий
            // жемчуг got 0» ×122 — жемчуг на крыше окопа и на наростах, клетка недостижима); коробка подбора (+1 вширь, +0.5 вверх)
            // достаёт его с соседней клетки.
            await walkTo(bot, ctl, it.position, 1, 5000, () => fh.endermen().some((e : any) => fh.angry(e) && e.position.distanceTo(bot.entity.position) < 6), true)
            await sleep(300)
          }
          await foxEnter(bot, ctl, fh.fox)
        }
      }
      r.got = countOf(bot, 'ender_pearl') - had
    } else fh.skip.set(near.id, gameClock.now() + 15000)
    r.pearls = countOf(bot, 'ender_pearl')
    fh.rounds.push(r)
    log('окоп: бой', r)
    return 'next'
  }
}

export async function stepPending (fh: FoxHunt): Promise<Turn> {
  // 2. Злые идут — ждать (взгляд вниз).
  const pend = fh.pending()
  if (pend.length) { fh.lastChance = gameClock.now(); fh.lastReach = gameClock.now(); await sleep(400); return 'next' }
}

export async function stepStareHere (fh: FoxHunt): Promise<Turn> {
  // 3. Злить отсюда: глаза видно из ямы (щель под крышей).
  const pool = foxStarePool(fh)
  if (pool.length) {
    fh.lastChance = gameClock.now()
    await foxStare(fh, pool[0], 5000)
    return 'next'
  }
}

export async function stepPoke (fh: FoxHunt): Promise<Turn> {
  const { bot, ctl, session, mcData, p } = fh
  // 4. Глаз не видно и из ямы, и с земли (искажённый лес: на ферме 0 видимых
  // глаз при 4–7 эндерменах в 24 блоках) — удар-вызов ближнего спокойного:
  // выйти, дойти (до POKE_R от ямы), ударить раз и сразу назад под крышу.
  // Удар живого не телепортирует (EnderMan.hurtServer); злой идёт за нами
  // к яме и там уже не достаёт. Соседей у него в 3 блоках нет — взмах мечом
  // задевает соседей и злит и их. Дойти до ямы он должен уметь (reach).
  const hole = fh.fox.P.offset(0.5, 0, 0.5)
  const pool2 = fh.endermen()
  if (pool2.some((e : any) => !trappedEm(bot, e) && e.position.distanceTo(hole) <= POKE_R && fh.canCome(e))) fh.lastNear = gameClock.now()
  if (p.poke === true && gameClock.now() - fh.lastPoke > 6000) {
    const calm: any = pool2.filter((e : any) => !fh.angry(e) && !fh.skipped(e) && !trappedEm(bot, e) && e.position.distanceTo(hole) <= POKE_R &&
      Math.abs(e.position.y - fh.fox.P.y) <= 6 && fh.canCome(e) && !pool2.some((o : any) => o !== e && o.position.distanceTo(e.position) < 3))
      .sort((a: any, c: any) => a.position.distanceTo(hole) - c.position.distanceTo(hole))[0]
    // Раз в 30 с — почему некого звать (кто в POKE_R и что мешает).
    if (!calm && gameClock.now() - (pokeWhy.at || 0) > 30000) {
      pokeWhy.at = gameClock.now()
      const why = {}
      const inc = k => { why[k] = (why[k] || 0) + 1 }
      for (const e of (pool2 as any)) {
        if (e.position.distanceTo(hole) > POKE_R) continue
        if (fh.angry(e)) inc('злой')
        else if (fh.skipped(e)) inc('пропуск')
        else if (trappedEm(bot, e)) inc('заперт')
        else if (Math.abs(e.position.y - fh.fox.P.y) > 6) inc('высота')
        else if (!fh.canCome(e)) inc('не дойдёт')
        else inc('сосед')
      }
      if (Object.keys(why).length) log('окоп: звать некого', why)
    }
    if (calm) {
      fh.lastPoke = gameClock.now()
      fh.pokes++
      const pk: any = { id: calm.id, from: Math.round(calm.position.distanceTo(hole)), hit: false }
      const hp1 = bot.health ?? 20
      if (await foxExit(bot, ctl, mcData, fh.fox)) {
        const tP = gameClock.now()
        bot._ndNoMobAvoid = true
        try {
          while (!ctl.aborted && gameClock.now() - tP < 10000 && calm.isValid !== false && bot.entities[calm.id] && !fh.angry(calm)) {
            if (reachTo(bot, calm) <= 2.9) {
              const a = (require('../../pick') as typeof import('../../pick')).aim(bot, calm)
              if (a && a.point) {
                if (fh.weapon && (!bot.heldItem || bot.heldItem.name !== fh.weapon.name)) { try { await bot.equip(fh.weapon, 'hand') } catch {} }
                try { await bot.lookAt(calm.position.offset(0, 0.6, 0), true) } catch {}
                try { bot.attack(calm); pk.hit = true } catch {}
                break
              }
            }
            await walkTo(bot, ctl, calm.position.floored(), 1, 1500)
          }
        } finally { bot._ndNoMobAvoid = false }
        // Разозлили — бой тут же, лицом и со щитом (openFight: один на один,
        // двое злых в 6 блоках или мало хп — выход), а не бегом к яме спиной
        // к нему: на ферме злой догонял и бил по дороге (foxhole-9 слот 13:
        // −8.8 хп за обратный путь с 15 блоков, потом смерть у ямы).
        if (pk.hit && fh.angry(calm) && calm.isValid !== false && bot.entities[calm.id]) {
          const f: any = await openFight(session, ctl, calm, { retreatAt: 10, dead: fh.dead, maxMs: 30000 }).catch(e => ({ error: e.message }))
          pk.fight = { killed: fh.dead.has(calm.id), swings: f && f.swings, crowd: f && f.crowd || undefined, stale: f && f.stale || undefined }
          if (pk.fight.killed) {
            fh.kills++
            await sleep(1500)
            await pickUp(bot, ctl, 6, 2500)
          }
        }
        await foxEnter(bot, ctl, fh.fox)
        pk.angry = fh.angry(calm)
        pk.s = Math.round((gameClock.now() - tP) / 1000)
        pk.hpLost = Math.round((hp1 - (bot.health ?? 20)) * 10) / 10
        pk.pearls = countOf(bot, 'ender_pearl')
        log('окоп: удар-вызов', pk)
        if (pk.angry) { fh.aggros++; fh.lastChance = gameClock.now() } else fh.skip.set(calm.id, gameClock.now() + 30000)
      } else log('окоп: удар-вызов — из ямы не вышел', { id: calm.id, at: xyz(bot.entity.position) })
      return 'next'
    }
  }
}

export async function stepHot (fh: FoxHunt): Promise<Turn> {
  const { bot } = fh
  // 5. Выглянуть: крышу долой, на землю, злить взглядом до двух с полного
  // роста, и сразу назад под крышу. Раз в 45 с: на ферме с земли глаза
  // видно редко (выглядывал 30+ раз — «seen 0»), а каждый выход — риск.
  // Злой рядом (даже «забытый» — застрял или 25 с не подходил) — из ямы не
  // выходить: он и выйдет нам навстречу. Злость эндермена гаснет за 20–39 с
  // (NeutralMob, PERSISTENT_ANGER_TIME). foxhole-11, слот 19: выход к новому
  // месту при злом рядом — 16 → 2 хп и смерть.
  if (fh.endermen().some((e : any) => fh.hot(e) && !trappedEm(bot, e) && e.position.distanceTo(bot.entity.position) < 20)) { await sleep(700); return 'next' }
}

export async function stepPeek (fh: FoxHunt): Promise<Turn> {
  const { bot, ctl, mcData, p } = fh
  // Выглядывать — только по просьбе (peek: true): глаз с земли в лесу почти не видно
  // (ферма: «seen 0» в 30+ выглядываниях), а каждый выход — копка крыши и износ кирки.
  if (p.peek === true && gameClock.now() - fh.lastPeek > 45000) {
    fh.lastPeek = gameClock.now()
    fh.peeks++
    if (await foxExit(bot, ctl, mcData, fh.fox)) {
      const out = foxStarePool(fh, 28)
      let n = 0
      for (const t of out.slice(0, 4)) {
        if (n >= 2 || ctl.aborted) break
        if (fh.endermen().some((e : any) => fh.angry(e) && e.position.distanceTo(bot.entity.position) < 10)) break
        if (await foxStare(fh, t, 4000)) n++
      }
      if (out.length) fh.lastChance = gameClock.now()
      await foxEnter(bot, ctl, fh.fox)
      log('окоп: выглянул', { seen: out.length, angered: n })
    }
    return 'next'
  }
}

export async function stepLying (fh: FoxHunt): Promise<Turn> {
  const { bot, ctl, mcData } = fh
  // 5б. Жемчуг лежит рядом (выпал, а подобрать не дали злые, или с прошлого
  // вызова) — злых поблизости нет: выйти и собрать (основной бот 29.09 18:09:
  // «drop 1, got 0» — единственный за 400 с жемчуг остался лежать).
  const lying = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && fh.isPearl(e) &&
    e.position.distanceTo(bot.entity.position) < 16 && !lavaAround(bot, e.position))
  if (lying.length && !fh.endermen().some((e : any) => fh.hot(e) && e.position.distanceTo(bot.entity.position) < 10)) {
    const had = countOf(bot, 'ender_pearl')
    if (await foxExit(bot, ctl, mcData, fh.fox)) {
      for (const it of (lying as any)) {
        if (!bot.entities[it.id] || ctl.aborted) continue
        await walkTo(bot, ctl, it.position, 1, 6000, () => fh.endermen().some((e : any) => fh.angry(e) && e.position.distanceTo(bot.entity.position) < 6), true)
        await sleep(300)
      }
    }
    log('окоп: собрал лежащий жемчуг', { lying: lying.length, got: countOf(bot, 'ender_pearl') - had })
    return 'next'
  }
}

export async function stepStalk (fh: FoxHunt): Promise<Turn> {
  const { bot, ctl, mcData } = fh
  // 6. Подкрасться: в досягаемости из ямы никого 5 с — к ближнему спокойному
  // (до 40 блоков), окоп вплотную к нему (1.2–2.6 блока), и бить его из ямы:
  // злой рядом, но луча к нам нет — не бьёт (MeleeAttackGoal: hasLineOfSight).
  // Бой в открытую (удар-вызов с 15 блоков) убивал: ферма 29.09, foxhole-9 —
  // 3 смерти из 4 после вызова («slain by Enderman», −9…−12 хп на обратном пути).
  if (gameClock.now() - fh.lastReach > 5000 && fh.stalks < 20) {
    const me = bot.entity.position
    // Зомби-пиглины рядом с целью — нет: взмах задевает соседей, и злится вся стая
    // (foxhole-14r: «slain by Zombified Piglin»; то же правило у дуэли).
    const zp = ents(bot).filter((o : any) => o && o.name === 'zombified_piglin' && o.position)
    // Только тех, к кому есть клетка «куда дойду» в 1.2–2.6 блока по горизонтали и
    // ±1 по высоте: выбор «ближайшего по прямой» слал к эндерменам на уступах —
    // «мест нет, nodes 0» и «время вышло» по кругу (основной бот 29.09, 18:02–18:09).
    const { walkable }: typeof import('../../walkable') = require('../../walkable')
    const from = bot.entity.position.floored().equals(fh.fox.H) ? fh.fox.out : me
    const flood = walkable(bot, from, { radius: 40, maxNodes: 12000 })
    const spotFor = e => {
      let best = null
      for (const n of flood) {
        const dh = Math.hypot(n.pos.x + 0.5 - e.position.x, n.pos.z + 0.5 - e.position.z)
        if (dh < 1.2 || dh > 2.6 || Math.abs(n.pos.y - Math.floor(e.position.y)) > 1) continue
        if (!best || n.d < best.d) best = n
      }
      return best
    }
    const pick = fh.endermen().filter((e : any) => !fh.hot(e) && !fh.skipped(e) && !trappedEm(bot, e) && e.position.distanceTo(me) < 40 && !zp.some((o : any) => o.position.distanceTo(e.position) < 8))
      .map(e => ({ e, n: spotFor(e) })).filter(x => x.n).sort((a, c) => a.n.d - c.n.d)[0]
    const t: any = pick && pick.e
    // Брут, хоглин, гаст рядом — из окопа не выходить ни сдвинуться, ни подкрасться (chain6-14 30.09: окоп у
    // бастиона, «минуту некого злить — сдвинуться», вышел — брут; разбор Codex).
    const foesNear = ents(bot).some((e : any) => e && e.position && ((/^(piglin_brute|hoglin|zoglin|wither_skeleton)$/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 24) || (e.name === 'ghast' && e.position.distanceTo(bot.entity.position) < 48)))
    if (foesNear) { fh.lastChance = gameClock.now(); await sleep(700); return 'next' }
    if (!t) {
      // Спокойных, к кому дойти, в 40 нет — старое правило: минуту некого злить — сдвинуться.
      if (gameClock.now() - fh.lastChance > 60000 && fh.moves < 6) {
        fh.moves++
        fh.used.push(fh.fox.P)
        await foxExit(bot, ctl, mcData, fh.fox)
        const s = await foxNewSite(fh)
        log('окоп: новое место', s.ok ? { at: xyz(s.fox.P), n: fh.moves } : s)
        if (s.ok) fh.fox = s.fox
        fh.lastChance = gameClock.now()
      }
      await sleep(700)
      return 'next'
    }
    fh.stalks++
    fh.lastReach = gameClock.now()
    fh.used.push(fh.fox.P)
    await foxExit(bot, ctl, mcData, fh.fox)
    const st: any = { id: t.id, from: Math.round(t.position.distanceTo(bot.entity.position)), steps: pick.n.d }
    if (pick.n.pos.distanceTo(bot.entity.position) > 2) {
      const g = pick.n.pos
      const w = await walkTo(bot, ctl, g, 1, 15000, () => fh.endermen().some((e : any) => fh.angry(e) && e.position.distanceTo(bot.entity.position) < 6))
      st.walk = w.ok ? 'ok' : w.error
    }
    if (!bot.entities[t.id] || t.isValid === false || fh.angry(t)) { st.why = 'ушёл или злой'; log('окоп: подкрасться', st); fh.skip.set(t.id, gameClock.now() + 20000); return 'next' }
    const s = await foxNewSite(fh, { near: t.position.clone() })
    st.site = s.ok ? xyz(s.fox.P) : s.why
    st.dist = s.ok ? Math.round(t.position.distanceTo(s.fox.P.offset(0.5, 0, 0.5)) * 10) / 10 : undefined
    log('окоп: подкрасться', st)
    if (s.ok) { fh.fox = s.fox; fh.lastChance = gameClock.now() } else fh.skip.set(t.id, gameClock.now() + 30000)
    return 'next'
  }
}

export async function stepIdle (fh: FoxHunt): Promise<void> {
  await sleep(700)
}
