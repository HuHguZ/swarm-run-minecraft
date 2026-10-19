'use strict'
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from '../movement'
import { walkable, standable } from '../walkable'
import { seesBlock } from '../sight'
import { countOf, itemNamed } from '../items'
import { canUseRanged } from '../play-policy'
import * as survival from '../combat-safety'
import {
  log, reachTo, seesMob, ents, droppedRods, isRod, lavaNear, arrowsOnFloor, liveBlazes, sweepRisk,
  bystanderOnLine, OTHER_FOES, FOOD_RE, blocksHave, arrowsHave, shieldWear, witherClose
} from './targets'
import { hasEffect, drinkFireResistance } from './potions'
import { collectRods, makeTrack, walkNear, rest } from './approach'
import {
  SHIELD_LEAD_MS, MELEE, swingMs, BOW_MIN, BOW_MAX, NEAR, losClear, losClearBut, myEye, floorBelow, aimFrac,
  blazeEye, seesMe, blazeShieldPrice, makeRadar
} from './radar'
import { floorUnder, choosePost, windowForPost, fightMoves, DOOR_SIDES, solidB, pitFrom, digInNear } from './post'
import { boxRest, planBunker, planKillBox, buildBunker, shutDoor, openDoor } from './bunker'

// ND_BLAZE_FP=1 — под огнестойкостью вылазка за стержнями не рвётся шарами (03.10, поток nether).
// По умолчанию вкл. с 03.10 08:10 (B17: ≥ 7 стержней 2/3 со старым боем; до правки — стержни лежали, вылазки рвались);
// откат — ND_BLAZE_FP=0.
const FP_SORTIE = typeof process !== 'undefined' && process.env.ND_BLAZE_FP !== '0'

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

async function holdSpawner (session, ctl, ctx) {
  const bot = session.bot
  const combat: typeof import('../combat') = require('../combat')
  const actions: typeof import('../actions') = require('../actions')
  const { bestWeapon }: typeof import('../items') = require('../items')
  const { spawner, want, deadline, dead, setPhase, fireproof: fp } = ctx
  const out: any = { melee: 0, arrows: 0, blocks: 0, rests: [], sorties: 0, shieldMs: 0, foes: [], bunker: null, hits: 0, swingNoLease: 0 }
  let clearRevision = 0, clearChecked = ''
  const onClearBlock = () => { clearRevision++ }
  // Свидетель попадания — entityHurt ифрита, а не счёт взмахов (s1-post07 06.10: melee 17, убийств 0).
  const onBlazeHurt = e => { if (e && e.name === 'blaze') out.hits++ }
  bot.on('entityHurt', onBlazeHurt)
  const lockOwner = () => { try { return (require('../reflex-lock') as typeof import('../reflex-lock')).owner(session)?.source || null } catch { return null } }
  const guard = combat.makeShield(session, ctl, { shield: 'ranged' })
  const safety = survival.watch(bot)
  const radar = makeRadar(bot)
  const lookSpeed = bot.physics ? [bot.physics.yawSpeed, bot.physics.pitchSpeed] : null
  if (bot.physics) { bot.physics.yawSpeed = 1000; bot.physics.pitchSpeed = 1000 }
  const saved = bot.pathfinder.movements
  const moves = fightMoves(session)
  bot.pathfinder.setMovements(moves)
  let weapon = bestWeapon(bot)
  const equipSword = async () => {
    weapon = bestWeapon(bot)
    if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
  }
  // Нейтрал вплотную к ифриту — бить киркой: у кирки нет размашистого удара (Player.isSweepAttack — только меч), зомби-пиглины
  // не злятся; без нейтралов — меч (s1-LA-6 06.10: при запрете удара ифрит в 0.8 бл. бил безответно, смерть).
  const equipFor = async (e) => {
    if (!sweepRisk(bot, e)) return equipSword()
    const pk = bot.inventory.items().filter(i => /_pickaxe$/.test(i.name)).sort((a, b) => ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'].indexOf(b.name.split('_')[0]) - ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'].indexOf(a.name.split('_')[0]))[0]
    out.pickSwings = (out.pickSwings || 0) + 1
    if (pk && (!bot.heldItem || bot.heldItem.name !== pk.name)) { try { await bot.equip(pk, 'hand') } catch {} }
  }
  let lastSwing = gameClock.now()
  // Смена предмета в руке обнуляет откат удара (Player.tick → resetAttackStrengthTicker при смене main hand, 1.21.11).
  let swapAt = 0
  const onHeld = () => { swapAt = gameClock.now() }
  bot.on('heldItemChanged', onHeld)
  // Удар, только когда откат предмета в руке прошёл; оружие под цель (кирка при нейтрале рядом) — до проверки отката.
  const swingFor = async (e) => {
    await equipFor(e)
    if (gameClock.now() - Math.max(lastSwing, swapAt) < swingMs(bot)) return false
    const aim = (require('../pick') as typeof import('../pick')).aim(bot, e)
    if (!aim?.point) return false
    await setShield(false)
    try { await bot.lookAt(aim.point, true) } catch {}
    try { if (lockOwner()) out.swingNoLease++; bot.attack(e); lastSwing = gameClock.now(); out.melee++ } catch {}
    await setShield(true, inBunker() ? doorPoint() : blazeEye(e))
    return true
  }
  let idleSince = gameClock.now()
  // S1e: спавнер работает, только когда игрок в 16 бл. от его центра (BaseSpawner.isNearPlayer, requiredPlayerRange 16) — молчит
  // издали (s1e-B0-3: «спавнер молчит 50с — стою в 18 бл.» ×3, этап ифритов брошен) — подойти на 8 и ждать снова, а не уходить.
  let silentApproach = 0
  let lastBeat = 0
  let shieldOn = false
  let shieldAt = 0
  let goalAt = 0
  let stopped = null
  let bail = false
  let bunker = null
  let lastBow = gameClock.now()
  let lowWindowCrouchAt = 0
  let sortieAfter = 0
  let lastVisAt = gameClock.now()
  let reposts = 0
  let approaches = 0
  let farApproaches = 0
  let seenBlocks = 0
  let blockAt = 0
  // Коробку не достроили (блейз в клетке стены, сервер не ответил) — достроить
  // в тишине, до 4 раз (замер 18: «в клетке стоит blaze», 12 хп на стройке).
  let boxPlan = null
  let boxTries = 0
  let boxRetryAt = 0
  const noShot = new Map()
  const fireproof = () => fp || hasEffect(bot, 'fire_resistance')
  // Бой начат под огнестойкостью — она и держит его (шар и горение — #is_fire). Кончилась посреди боя — новое зелье
  // (ферма 02.10 neF-blz-3: 3 мин под зельем — 0 урона огнём, после — шары 10.8 и горение 5); нет зелья — отдых и
  // конец захода, а не продолжение тира без защиты (разбор Codex ne-blaze.md, правка 1).
  const startedFireproof = fireproof()
  const setShield = async (on, face = null) => {
    if (face) { try { await bot.lookAt(face, true) } catch {} }
    if (on) {
      if (!shieldOn) { shieldOn = true; shieldAt = gameClock.now() }
      await guard.raise(true)
    } else if (shieldOn) { shieldOn = false; out.shieldMs += gameClock.now() - shieldAt; await guard.raise(false) }
  }
  if (ctx.ledger) ctx.ledger.probe = () => ({ up: combat.shieldUp(bot), want: shieldOn, ms: shieldOn ? gameClock.now() - shieldAt : undefined })
  const stopWalking = () => { try { bot.pathfinder.setGoal(null) } catch {}; bot.clearControlStates() }
  const inBunker = () => bunker && bot.entity.position.floored().equals(bunker.cell)
  const doorPoint = () => bunker ? bunker.cell.plus(bunker.front).offset(0.5, 1.6, 0.5).plus(bunker.front.scaled(3)) : null
  // Близкий враг запрещает неподвижный отдых, но требует раннего отхода.
  const meleeThreat = () => liveBlazes(bot, dead, 6).find((e : any) => e.position.distanceTo(bot.entity.position) < 2.7 && seesMe(bot, e)) || null
  const foesNow = () => (require('../flee') as typeof import('../flee')).hostilesAround(bot, 24).map(h => h.e).filter(e => !dead.has(e.id))
  const checkSafety = phase => {
    const foes = foesNow()
    const risk = safety.check({ entities: foes, phase,
      expectedEnemy: phase === 'start' ? 'blaze' : null, minHealth: Math.max(8, ctx.restAt) })
    if (process.env.ND_BLAZE_WORLD_STATE === '0' || !foes.length || foes.some(e => e.name !== 'blaze') ||
        risk.action !== 'leave' || !/не переживу ближайший размен/.test(risk.reason || '')) return risk
    const vis = liveBlazes(bot, dead, 48).filter(e => seesMe(bot, e))
    const from = [...vis.map(blazeEye), ...radar.incoming(gameClock.now()).map(b => b.from)]
    const price = blazeShieldPrice(bot, vis, radar, guard, fireproof(), from.length ? faceFor(from) : null)
    if (price.cost >= (bot.health ?? 0)) return risk
    return { ...risk, action: 'fight', reason: 'размен по лучам, щиту и летящим шарам', blazeCost: price.cost }
  }
  // Опасность: видящие нас в окне очереди и летящие к нам шары.
  const dangersNow = (vis, now) => {
    const out2 = []
    if (fireproof()) return out2
    for (const e of vis) if (e.position.distanceTo(bot.entity.position) <= NEAR && radar.untilDanger(e, now) === 0) out2.push(blazeEye(e))
    for (const b of radar.incoming(now)) if (b.eta < 1600) out2.push(b.from)
    return out2
  }
  const faceFor = (dangers) => {
    const me = bot.entity.position
    if (inBunker()) return doorPoint()
    let sx = 0; let sz = 0
    for (const d of dangers) { const dx = d.x - me.x; const dz = d.z - me.z; const n = Math.hypot(dx, dz) || 1; sx += dx / n; sz += dz / n }
    if (Math.hypot(sx, sz) < 0.3 * dangers.length) return dangers.slice().sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0]
    return me.offset(sx * 4, 1.6, sz * 4)
  }
  let blockedCorner = null
  // Отдых: в шалаше — заложить дверь; без шалаша — коробка.
  const restNow = async () => {
    stopWalking()
    if (process.env.ND_BLAZE_WORLD_STATE !== '0' && !fireproof()) {
      const blazes = liveBlazes(bot, dead, 48)
      // A connected neighbouring corner is cheaper than digging a pit under the current volley.
      const feet = bot.entity.position.floored()
      const exposed = blazes.some(e => seesMe(bot, e)) || radar.incoming(gameClock.now()).length > 0
      const corner = exposed && !inBunker() && DOOR_SIDES.map(d => feet.plus(d)).find(pos =>
        seesBlock(bot, bot.blockAt(pos.offset(0, -1, 0))) && standable(bot, pos) &&
        [0, 1].every(y => !/fire|lava/.test(bot.blockAt(pos.offset(0, y, 0))?.name || '')) &&
        blazes.every(e => !losClear(bot, blazeEye(e), pos.offset(0.5, 1.62, 0.5))) &&
        radar.incoming(gameClock.now()).every(b => !losClear(bot, b.from, pos.offset(0.5, 0.9, 0.5))))
      if (corner) {
        const key = JSON.stringify([xyz(feet), xyz(corner), [-1, 0, 1].map(y => bot.blockAt(corner.offset(0, y, 0))?.stateId),
          blazes.filter(e => e.position.distanceTo(corner) < 2).map(e => [e.id, xyz(e.position)])])
        if (key !== blockedCorner) {
          blockedCorner = key
          const from = blazes.filter(e => seesMe(bot, e)).map(blazeEye)
          await setShield(true, from.length ? faceFor(from) : null)
          setPhase('за соседний угол до лечения')
          await (require('../sealed') as typeof import('../sealed')).stepMove(bot, ctl, { kind: 'flat', to: corner }).catch(() => null)
        }
      }
      // The existing radar ends this wait when the physical volley/flight ends or its ray is closed.
      while (!ctl.aborted && (bot.health ?? 0) > 0 && gameClock.now() < deadline && guard.stats.worn) {
        const vis = liveBlazes(bot, dead, 48).filter(e => seesMe(bot, e))
        const from = [...dangersNow(vis, gameClock.now()), ...radar.incoming(gameClock.now()).map(b => b.from)]
        if (!from.length) break
        setPhase('щит до укрытия для лечения')
        await setShield(true, faceFor(from))
        await sleep(50)
      }
    }
    // Нельзя опустить щит и строить/есть под рукой. Отрыв тот же, что в PvP;
    // затем существующее бегство от стрелков ищет разрыв линии огня.
    await setShield(false)
    let escape = null
    if (!inBunker()) {
      setPhase('отрыв до лечения')
      // Без FR под лучами ифритов бег — под залпами (s1c-L-4 06.10: «отрыв до лечения» 14.8 шарами и огнём, смерть): ифрит вплотную
      // не повод бежать — сперва в толщу на месте (две копки; в яме 1×1 с крышкой его удар и шары не достают), бег — если не вышло.
      const nofrSeen = !fireproof() && liveBlazes(bot, dead, 24).some(e => seesMe(bot, e))
      // Бег (kite) — только от ифрита вплотную. От стрелков бег — спиной под
      // очереди: на ферме 2026-09-29 «отрыв до лечения» дал 14–18 из 20
      // смертельного урона. Без ближнего врага — сразу стенка (ниже).
      // S1d 07.10: ифрит вплотную — и под FR сперва яма 3 с крышкой (удар ифрита требует луча и d² < 4 — в закрытой яме его нет), а не
      // отрыв: «не удалось разорвать контакт для лечения» — 3 из 5 смертей у спавнера в серии s1d-F (F22-1, F21b-1, F21b-4). ND_PIT_MELEE=0 — прежнее.
      const usePit = nofrSeen || (process.env.ND_PIT_MELEE !== '0' && !!meleeThreat())
      escape = meleeThreat() && !usePit ? await survival.disengage(session, ctl, foesNow) : { clear: true, how: nofrSeen ? 'без бега: без FR — в толщу' : usePit ? 'без бега: ифрит вплотную — в толщу' : 'без бега: вплотную никого' }
      if (!escape.clear) {
        const enemy = meleeThreat() || foesNow()[0]
        if (enemy && (bot.health ?? 0) > 0 && !ctl.aborted) escape.cover = await combat.retreat(session, ctl, enemy)
        if (meleeThreat() || (bot.health ?? 0) <= 0 || ctl.aborted) return { rested: false, why: 'не удалось разорвать контакт для лечения', escape }
      }
      // Без огнестойкости под лучами ифритов — отлёжка в толще на месте (2 вниз + крышка, digInPlace: две копки и один блок),
      // а не стройка коробки под залпами со снятым щитом (s1c-N-2 06.10: фаза «коробка» — 4 шара подряд, 17 урона, смерть).
      // Отлечился — крышку сломать, столб 2 под себя и бой дальше; наверх не вышел — конец захода в толще (dugIn).
      if (usePit || (!fireproof() && liveBlazes(bot, dead, 24).some(e => seesMe(bot, e)))) {
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
            try { const b = bot.blockAt(top); if (b && b.boundingBox === 'block') await (require('../sealed') as typeof import('../sealed')).digCell(bot, top) } catch {}
            const up = await (require('../build') as typeof import('../build')).towerUp(bot, ctl, dug.depth || 2, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
            if (up && up.ok) return { rested: hp1 >= 18, where: 'яма на месте', hp: `${hp0} -> ${hp1}`, seconds: Math.round((gameClock.now() - t0) / 1000), escape }
          }
          stopped = `отлёжка в толще: хп ${hp0} -> ${hp1}, наверх не вышел — остаюсь в яме`
          bail = true
          out.dugIn = { ok: true, sealed: !!dug.sealed, at: xyz(bot.entity.position) }
          return { rested: false, where: 'яма на месте', why: stopped, escape }
        }
      }
      if (liveBlazes(bot, dead, 24).some(e => seesMe(bot, e))) {
        setPhase('из линии огня до лечения')
        const shooter = liveBlazes(bot, dead, 24).find(e => seesMe(bot, e))
        // Та же быстрая стенка/укрытие, что у обычного боя: сначала закрыть
        // огонь двумя блоками, а не восемь секунд бежать под очередями.
        escape.cover = await combat.retreat(session, ctl, shooter, { timeoutMs: 4000 })
        if (meleeThreat() || (bot.health ?? 0) <= 0 || ctl.aborted) return { rested: false, why: 'враг догнал до укрытия', escape }
      }
      const safe = () => !foesNow().some(e => seesMe(bot, e))
      if (safe()) {
        setPhase('лечение за общим укрытием')
        const healed = await survival.recover(session, ctl, { safe, until: 19,
          maxMs: Math.min(30000, Math.max(0, deadline - gameClock.now() - 2000)) })
        if (healed.rested) return { ...healed, where: 'за стенкой или углом', escape }
        if (healed.hazard) {
          setPhase('из опасного блока вместо лечения')
          escape.hazard = await survival.disengage(session, ctl, foesNow)
          return { ...healed, escape }
        }
        if (ctl.aborted || (bot.health ?? 0) <= 0 || safe()) return { ...healed, escape }
      }
    }
    if (inBunker()) {
      setPhase('отдых в шалаше')
      const hp0 = Math.round(bot.health ?? 0)
      const shut = await shutDoor(bot, bunker)
      if (!shut) {
        await setShield(true, doorPoint())
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
      await equipSword()
      await setShield(true, doorPoint())
      for (let k = 0; k < 20 && !guard.blocking() && !ctl.aborted; k++) await sleep(50)
      if (!guard.blocking()) return { rested: false, where: 'шалаш', shut, opened: false, why: 'щит не готов — окно закрыто' }
      const opened = await openDoor(bot, bunker)
      if (!opened) return { rested: false, where: 'шалаш', shut, opened: false, why: 'окно не открылось' }
      await equipSword()
      await setShield(true, doorPoint())
      return { rested, why: rested ? undefined : 'шалаш не дал восстановиться', where: 'шалаш', shut, opened, hp: `${hp0} -> ${Math.round(bot.health ?? 0)}`, seconds: Math.round((gameClock.now() - t0) / 1000), ate: ate || undefined }
    }
    // Ифрит вплотную — не строить у него под рукой: сразу бегство (ниже).
    const r: any = meleeThreat() ? { rested: false, threat: true, why: 'враг вплотную — коробку не строю' }
      : await boxRest(session, ctl, { toward: spawner || null, onPhase: setPhase, threat: () => !!meleeThreat(),
        maxMs: Math.min(60000, Math.max(0, deadline - gameClock.now() - 2000)),
        hardMs: Math.min(150000, Math.max(0, deadline - gameClock.now() - 2000)) })
    if (r.rested) {
      if (r.exited === false) { stopped = 'отлечился, но из коробки не вышел — нужен безопасный проход'; bail = true }
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
    try { fled = await (require('../flee') as typeof import('../flee')).smartFlee(session, ctl, { timeoutMs: 12000, safeDist: 24, reason: 'блейзы' }) } catch (e) { fled = { error: e.message } }
    const t1 = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t1 < 30000 && (bot.health ?? 0) < 18 && !liveBlazes(bot, dead, 32).some(e => seesMe(bot, e))) {
      if ((bot.food ?? 20) < 20) { try { await actions.eat(session, {}) } catch {} }
      await sleep(500)
    }
    return { rested: (bot.health ?? 0) >= 18 && (bot.food ?? 0) >= 18,
      why: 'укрытие не позволило восстановиться', where: 'бегство', escape,
      fled: fled && (fled.mode || fled.error), hp: Math.round(bot.health ?? 0), box: r, cover: r2.why }
  }
  let home = null
  // Куда дойти ногами от места боя (для «стержень с этого поднять» и вылазок).
  let reach = null
  const refreshReach = () => {
    try { reach = new Set(walkable(bot, bot.entity.position, { radius: 20, maxNodes: 5000 }).map(n => `${n.pos.x},${n.pos.y},${n.pos.z}`)) } catch { reach = null }
    // Из закрытой коробки (второй вызов начинается в ней) ногами никуда — тогда
    // правило «пол в 5 ниже и 1 выше ног» (прогон 33: 0 выстрелов за вызов).
    log("куда дойти", { cells: reach ? reach.size : null, at: xyz(bot.entity.position) })
    if (reach && reach.size < 20) reach = null
  }
  const witherPit = async () => {
    const w = witherClose(bot)
    if (!w) return false
    await setShield(false)
    stopWalking()
    setPhase('яма от иссушителя')
    const ok = await pitFrom(session, ctl, out, w)
    return ok
  }
  try {
    await equipSword()
    await guard.wear()
    await witherPit()
    home = bot.entity.position.floored()
    refreshReach()
    // Позвали с малым хп (прошлый вызов кончился на 2–3 хп): сначала поесть и
    // отлежаться (замер 35: второй вызов на 2 хп — смерть через 1 с по дороге
    // «к точке боя», горел).
    const preparation = checkSafety('start')
    out.safety = preparation
    // Под огнестойкостью и среди одних ифритов «не переживу размен» — неверно (расчёт берёт удар 6 у каждого и шары): бой
    // начинать (s1-LE-10 06.10: «не переживу ближайший размен» на 20 хп при старте → навык вышел, смерть у спавнера).
    const onlyBlazes = () => foesNow().every((e: any) => e.name === 'blaze')
    const frOnlyBlazes = () => fireproof() && onlyBlazes() && (bot.health ?? 0) >= 9
    // Без огнестойкости среди одних ифритов вердикт «не переживу размен» (удар 6 каждого и шары) — не отказ: с 14+ хп бой по
    // механике ифрита, при малом хп — отлёжка в толще (restNow) и возврат (s1c-N-4 06.10: «не переживу» на 16 хп → бег → смерть).
    // Еды нет — отлёжка не лечит: тогда вердикт safety в силе.
    const nofrOnlyBlazes = () => !fireproof() && onlyBlazes() && (bot.health ?? 0) > 0 && bot.inventory.items().some(i => FOOD_RE.test(i.name))
    if ((preparation.action === 'leave' && !frOnlyBlazes() && !(nofrOnlyBlazes() && (bot.health ?? 0) >= 14)) || preparation.action === 'dead') {
      setPhase('отказ от неподготовленного боя')
      out.safety = preparation
      if (preparation.action !== 'dead') out.escape = await survival.disengage(session, ctl, foesNow)
      return { ...out, stopped: preparation.reason, bail: true }
    }
    if (preparation.action === 'recover' && !ctl.aborted) {
      const r = await restNow()
      out.rests.push({ ...r, atStart: true })
      log('отдых до боя', r)
      if (!r.rested) return { ...out, stopped: r.why || 'не восстановился до боя', bail: true }
    }
    if (spawner && p0(ctx).clearSpawner !== false && process.env.ND_BLAZE_CLEAR !== '0') (require('../blaze-clear') as typeof import('../blaze-clear')).observe(bot, spawner)
    // --- шалаш
    // Шалаш — по желанию (bunker: true): замер 7 — из-под крыши видно только
    // до 37° вверх, блейзы у спавнера висят выше и за минуту не показались ни
    // разу; открытый бой с точки обзора дал 5 стержней за 77 с (замер 3).
    if (spawner && !fireproof() && p0(ctx).box !== false && p0(ctx).bunker !== true) {
      // Без лука и стрел коробка — ближняя, под меч (2 бл. от спавнера): к дальнему окну ифриты не подлетают, «стрелы кончились»
      // (blz-lsb-7/blz-std-5 14.10: коробка в 3–7.5 бл. без лука — 0 убийств, смерть). Ревью Codex 14.10.
      const ranged = itemNamed(bot, 'bow') && arrowsHave(bot) > 0 && canUseRanged(session, { name: 'blaze' }, p0(ctx))
      const plan = planKillBox(bot, spawner, blocksHave(bot), ranged ? {} : { hMin: 1.4, hMax: 3.2, hBest: 2, lowWindow: p0(ctx).lowWindow === true })
      if (plan.none) {
        out.bunker = { built: false, kind: 'окно', why: 'места под коробку с окном нет', tried: plan.tried }
        if (p0(ctx).lowWindow === true) return { ...out, stopped: 'эксперимент: места под щель нет', bail: true }
      } else {
        setPhase('коробка с окном')
        const b = await buildBunker(session, ctl, plan, setPhase)
        out.bunker = { built: b.ok, kind: plan.lowWindow ? 'ножная щель' : 'окно', cell: xyz(plan.cell), front: xyz(plan.front), h: plan.h, seen: plan.seen, placed: b.placed, open: b.open, roofed: b.roofed, failed: b.failed, why: b.why }
        if (b.ok) bunker = { cell: plan.cell, front: plan.front, window: true, win: plan.win, lowWindow: plan.lowWindow }
        else if (plan.lowWindow) return { ...out, stopped: 'эксперимент: щель не построена', bail: true }
        else boxPlan = plan
      }
      log('коробка с окном', out.bunker)
    }
    if (spawner && !fireproof() && p0(ctx).bunker === true) {
      const plan = planBunker(bot, spawner, blocksHave(bot))
      if (plan.none) {
        out.bunker = { built: false, why: 'места под шалаш нет', tried: plan.tried }
      } else {
        const b = await buildBunker(session, ctl, plan, setPhase)
        out.bunker = { built: b.ok, cell: xyz(plan.cell), front: xyz(plan.front), h: plan.h, seen: plan.seen, placed: b.placed, open: b.open, roofed: b.roofed, failed: b.failed, why: b.why }
        // Без крыши шалаш хуже открытого боя: сверху (до 7 блоков над глазами) видят
        // в клетку со всех сторон.
        if (b.ok) bunker = { cell: plan.cell, front: plan.front }
      }
      log('шалаш', out.bunker)
    }
    // Без шалаша — точка боя с видом на куб спавна.
    if (!bunker && spawner) {
      const post = choosePost(bot, spawner)
      // Ифриты уже вплотную — бой с места, а не ход к точке: по дороге (3.6 бл.) тело не отвечало и получило 10 ударов
      // (s1-post06 06.10: 32 урона в фазе «к точке боя», смерть до первого взмаха). Основной цикл бьёт тех, кто в досягаемости.
      const pressed = liveBlazes(bot, dead, 5).length
      if (post && pressed) log('точка боя: ифриты вплотную — бьюсь с места', { pressed, post: xyz(post.pos) })
      if (post && !pressed) {
        out.post = { ...xyz(post.pos), h: post.h, view: post.view, cover: post.cover, edge: post.edge }
        setPhase('к точке боя')
        // Под охраной (nether.guarded): ударили по дороге — ответ обидчику, потом снова к точке. neF-fB25-1 02.10: магмовые
        // кубы 9 ударов (12.5 хп) за 12 с ходьбы без ответа, затем блейзы — смерть до первого выстрела.
        // Ифрит догнал вплотную или −4 хп по дороге — ход бросить, бой с места (основной цикл: щит и меч по тем, кто в
        // досягаемости). sr-l-3 10.10: 8 ударов вплотную по 3.4 «к точке боя», смерть до первого взмаха.
        const hp0 = bot.health ?? 20
        const pressedNow = () => liveBlazes(bot, dead, 3.5).length > 0 || (bot.health ?? 20) < hp0 - 4
        for (let k = 0; k < 3 && !ctl.aborted && !pressedNow(); k++) {
          let done = false
          const w = await (require('../nether') as typeof import('../nether')).guarded(session, ctl, sub => Promise.race([
            walkNear(bot, sub, post.pos, 0, 12000).finally(() => { done = true }),
            (async () => { while (!done && !sub.aborted) { if (pressedNow()) { try { bot.pathfinder.setGoal(null) } catch {} return { pressed: true } } await sleep(100) } return {} })()
          ])).catch(() => ({}))
          if (w && w.pressed) { log('к точке боя: догнали — бьюсь с места', { hp: Math.round(bot.health ?? 0), near: liveBlazes(bot, dead, 3.5).length }); break }
          if (!w || !w.fought) break
        }
        home = post.pos
      }
      log('точка боя', out.post || { none: true })
    }
    await equipSword()
    bot.on('blockUpdate', onClearBlock)
    while (!ctl.aborted && !bail) {
      // Каждый оборот — через таймер: ветка без sleep (вылазка, которой нечего
      // собрать) иначе держит цикл событий, и пакеты мира не читаются.
      await sleep(20)
      const now = gameClock.now()
      // Набрал — но ифриты с лучом к нам рядом: под огнестойкостью добить их здесь (до 60 с), а не уходить из навыка под удары —
      // выход из боя после «набрал» убивал (s1-LG-3 06.10: 5 стержней на 6-й мин, «закопаться» под ифритами 17 → 2 хп, смерть).
      if (countOf(bot, 'blaze_rod') >= want) {
        const pressing = liveBlazes(bot, dead, 8).some(e => seesMe(bot, e))
        if (!pressing || !fireproof() || (bot.health ?? 0) < 6) break
        if (!out.clearUntil) { out.clearUntil = now + 60000; log('набрал — добиваю ифритов рядом', { n: liveBlazes(bot, dead, 8).length, hp: Math.round(bot.health ?? 0) }) }
        if (now > out.clearUntil) break
      }
      if (now > deadline) { stopped = 'время вышло'; break }
      // shortcut: эксперимент проверяет удары из щели; приманивание и сбор проверяются отдельной сценой.
      if (bunker?.lowWindow) {
        if (!inBunker()) { stopped = 'эксперимент: тело вышло из щели'; bail = true; break }
        try { bot.pathfinder.setGoal(null) } catch {}
        for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(key, false)
        if (!bot.getControlState('sneak')) { lowWindowCrouchAt = now; bot.setControlState('sneak', true) }
        setPhase('щит у ножной щели')
        const blazes = liveBlazes(bot, dead, 32)
        const intact = solidB(bot.blockAt(bunker.cell.offset(0, -1, 0))) && solidB(bot.blockAt(bunker.cell.offset(0, 2, 0))) &&
          DOOR_SIDES.every(s => [0, 1].every(y => s.equals(bunker.front) && y === 0 || solidB(bot.blockAt(bunker.cell.plus(s).offset(0, y, 0)))))
        const fire = [0, 1].some(y => /fire|lava/.test(bot.blockAt(bunker.cell.offset(0, y, 0))?.name || '')) || !!(bot.entity.metadata?.[0] & 1)
        if (!intact || fire || blazes.some(e => seesMe(bot, e)) || foesNow().some(e => e.name !== 'blaze')) {
          stopped = 'эксперимент: укрытие нарушено, огонь или другой враг'; bail = true; break
        }
        if ((bot.health ?? 0) < 19 || (bot.food ?? 20) < 18) {
          const r = await restNow(); out.rests.push(r)
          if (!r.rested) { stopped = r.why || 'эксперимент: не вылечился'; bail = true; break }
          await equipSword(); continue
        }
        await setShield(true, doorPoint())
        const e = blazes.filter(e => (require('../pick') as typeof import('../pick')).canHit(bot, e)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
        if (now - lastBeat > 2000) {
          lastBeat = now
          log('ножная щель', { t: Math.round((now - ctx.t0) / 1000), hp: bot.health, food: bot.food, melee: out.melee, hits: out.hits, kills: ctx.kills?.length, rods: countOf(bot, 'blaze_rod'), canHit: !!e, eye: myEye(bot), blocking: guard.blocking(), at: xyz(bot.entity.position) })
        }
        if (gameClock.now() - lowWindowCrouchAt >= 250 && guard.blocking() && !radar.incoming(gameClock.now()).length && e && await swingFor(e)) setPhase('меч из ножной щели')
        if (gameClock.now() - lastSwing > 75000) { stopped = 'эксперимент: 75 с без удара из щели'; break }
        await sleep(50)
        continue
      }
      if (startedFireproof && !fireproof() && !out.frLostAt) {
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
        if (!fireproof()) {
          // Огнестойкость — плюс к безопасности, не допуск (решение пользователя 06.10 22:33): бой дальше по механике ифрита — щит
          // на залп (радар заряда), меч между залпами, коробка с окном в тишине, отдых в укрытии при малом хп и возврат.
          out.frLostAt = gameClock.now()
          setPhase('бой без огнестойкости')
          if (!bunker && !boxPlan && spawner) {
            const plan = planKillBox(bot, spawner, blocksHave(bot))
            if (!plan.none) { boxPlan = plan; boxTries = 0; boxRetryAt = 0 }
          }
          log('огнестойкость кончилась — бой дальше без неё', { drank: d, hp: Math.round(bot.health ?? 0), box: boxPlan ? xyz(boxPlan.cell) : null })
          if ((bot.health ?? 0) < ctx.restAt || (bot.health ?? 0) < 16 && liveBlazes(bot, dead, 16).filter(e => seesMe(bot, e)).length >= 2) {
            const r = await restNow()
            out.rests.push(r)
            if (!r.rested && (bot.health ?? 0) < 10) { stopped = `огнестойкость кончилась, хп ${Math.round(bot.health ?? 0)}, отдых не вышел: ${r.why || 'нет укрытия'}`; bail = true; break }
            await equipSword()
          }
          continue
        }
      }
      // ND_GUARD=1 (ne-guard): иссушитель/магмовый куб/злой пиглин бьёт или иссушитель вплотную — ответ сразу (столб 3,
      // коробка, бой со щитом), а не «бегство» под ударами (B0-26 03.10: под огнестойкостью у помоста — магмовый куб и два
      // удара иссушителя за 2 с в «бегстве», refuge не спас).
      if (process.env.ND_GUARD !== '0') {
        const G: typeof import('../ne-guard') = require('../ne-guard')
        const h = G.hot(bot)
        if (h) {
          await setShield(false)
          const rr = await G.react(session, ctl, { force: h, sitMs: 15000 })
          if (rr.cancelled || ctl.aborted || session.bot !== bot) { stopped = 'прервано'; break }
          if (rr.acted !== false) {
            out.guards = (out.guards || 0) + 1
            log('страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) })
            await equipSword()
            continue
          }
        }
      }
      if (await witherPit()) { await equipSword(); continue }
      // Без FR бой держится на отдыхе с едой; еда кончается — закончить заход в толще, а не дойти до «нечем восстановить здоровье»
      // и бега под залпами (s1c-F-9 06.10: без FR 110.9 урона за бой, отдыхи в коробке, еда кончилась — бег, смерть).
      if (!fireproof() && bot.inventory.items().filter(i => FOOD_RE.test(i.name)).reduce((n, i) => n + i.count, 0) <= 2 && (bot.health ?? 20) < 18) {
        stopped = 'без огнестойкости еда кончается — заход заканчиваю в толще'
        bail = true
        break
      }
      const hp = bot.health ?? 0
      const risk = checkSafety('continue')
      if (risk.action === 'leave' && nofrOnlyBlazes() && !frOnlyBlazes()) {
        out.safety = risk
        const r = await restNow()
        out.rests.push(r)
        log('отдых вместо ухода', { why: risk.reason, ...r })
        if (bail) break
        if (!r.rested && (bot.health ?? 0) < 14) { stopped = `${risk.reason}; отдых не вышел: ${r.why || 'нет укрытия'}`; bail = true; break }
        await equipSword()
        await guard.wear()
        continue
      }
      if ((risk.action === 'leave' && !frOnlyBlazes()) || risk.action === 'dead') {
        out.safety = risk; stopped = risk.reason; bail = true
        if (risk.action !== 'dead') {
          await setShield(false)
          out.escape = await survival.disengage(session, ctl, foesNow)
          if (!out.escape.clear && !ctl.aborted && (bot.health ?? 0) > 0) {
            const enemy = meleeThreat() || foesNow()[0]
            if (enemy) out.escape.cover = await combat.retreat(session, ctl, enemy)
          }
        }
        break
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
      const holdUnderFr = fireproof() && hp >= holdNeed && foesNow().every((e: any) => e.name === 'blaze')
      // Под FR с малым хп — поесть, когда вплотную никого (отдых с уходом гибелен: s1-LA-3 06.10 — 4 стержня, «хп 7, укрытие
      // не позволило», убежище «CORNERED» → смерть). Порог боя со щитом — 5 хп (был 9).
      if (holdUnderFr && hp < 14 && (bot.food ?? 20) < 20 && !liveBlazes(bot, dead, 4).some(e => reachTo(bot, e) <= 2.6) && gameClock.now() - (out.frEatAt || 0) > 4000) {
        out.frEatAt = gameClock.now()
        await setShield(false)
        try { await actions.eat(session, {}); out.frEats = (out.frEats || 0) + 1 } catch {}
        await equipSword()
        continue
      }
      if (risk.action === 'recover' && holdUnderFr && gameClock.now() - (out.frHoldLogAt || 0) > 5000) { out.frHoldLogAt = gameClock.now(); out.frHolds = (out.frHolds || 0) + 1; log('отдых отложен: огнестойкость, вокруг одни ифриты', { hp: Math.round(hp) }) }
      if (risk.action === 'recover' && !holdUnderFr) {
        out.safety = risk
        const r = await restNow()
        out.rests.push(r)
        log('отдых', r)
        // Отдых «не завершён», а хп уже 14+ (neF-e2e-3 02.10: «хп 20, не восстановился» — заход кончился на 1 стержне):
        // бой дальше; конец захода — только когда хп так и осталось низким.
        if (!r.rested && (bot.health ?? 0) < 14) { stopped = `хп ${Math.round(bot.health ?? 0)}, не восстановился: ${r.why || r.cover || 'нет безопасного отдыха'}`; bail = true; break }
        await equipSword()
        await guard.wear()
        continue
      }
      // Без огнестойкости под лучами двух и больше ифритов урон за секунды — шары, горение, удары вплотную (s1c-B-3 06.10: FR
      // кончилась на 17 хп при 5 ифритах, 18 → 3 за 2 с; в толщу — поздно). Порог отлёжки в толще — 16 хп, а не общий 12.
      if (!fireproof() && hp < 16 && gameClock.now() - (out.nofrRestAt || 0) > 5000 &&
          liveBlazes(bot, dead, 16).filter(e => seesMe(bot, e)).length >= 2) {
        out.nofrRestAt = gameClock.now()
        const r = await restNow()
        out.rests.push(r)
        log('отдых без FR под ифритами', { hp: Math.round(hp), ...r })
        if (bail) break
        if (!r.rested && (bot.health ?? 0) < 12) { stopped = `хп ${Math.round(bot.health ?? 0)} без огнестойкости, отдых не вышел: ${r.why || 'нет укрытия'}`; bail = true; break }
        await equipSword()
        continue
      }
      // Огонь под ногами: шар, пролетевший мимо, поджигает клетку у места
      // удара (SmallFireball.onHitBlock), и тело в ней горит 8 с (FireBlock.
      // entityInside). Замер 8: 7 хп огня без единого попадания шара. Шаг на
      // соседнюю клетку без огня — раньше щита.
      {
        const feet = bot.entity.position.floored()
        const inFire = [feet, feet.offset(0, 1, 0)].some(q => { const b = bot.blockAt(q); return b && /fire/.test(b.name) })
        if (inFire) {
          const { standable }: typeof import('../walkable') = require('../walkable')
          const to = DOOR_SIDES.map(d => feet.plus(d)).find(q => standable(bot, q) && !lavaNear(bot, q, 1) &&
            ![q, q.offset(0, 1, 0)].some(c => { const b = bot.blockAt(c); return b && /fire/.test(b.name) }))
          if (to) {
            await setShield(false)
            setPhase('из огня')
            out.fireSteps = (out.fireSteps || 0) + 1
            try { bot.pathfinder.setGoal(new goals.GoalBlock(to.x, to.y, to.z)) } catch {}
            await sleep(400)
            stopWalking()
            continue
          }
        }
      }
      const blazes = liveBlazes(bot, dead, 32)
      const vis = blazes.filter(e => seesMe(bot, e))
      if (gameClock.now() - lastBeat > 2000) {
        lastBeat = gameClock.now()
        // Рюкзак полон — стержни не подбираются (B16f21 03.10): лишнее за спину.
        if (process.env.ND_NE_ROUTE !== '0' && bot.inventory.emptySlotCount() < 3 && !vis.some((e : any) => e.position.distanceTo(bot.entity.position) < 4)) { try { await (require('../nether-route') as typeof import('../nether-route')).makeRoom(bot, 5) } catch {} }
        const me = bot.entity.position
        log('шаг', { t: Math.round((now - ctx.t0) / 1000), hp: Math.round(hp), rods: countOf(bot, 'blaze_rod'), kills: ctx.kills ? ctx.kills.length : undefined, melee: out.melee, hits: out.hits, noLease: out.swingNoLease, lease: lockOwner(), arrows: out.arrows, shield: shieldOn, inB: !!inBunker(), fire: !!(bot.entity.metadata && (bot.entity.metadata[0] & 1)), pos: xyz(me), b: blazes.slice(0, 6).map((e : any) => [Math.round(e.position.distanceTo(me) * 10) / 10, Math.round((blazeEye(e).y - myEye(bot).y) * 10) / 10, seesMe(bot, e) ? 1 : 0, Math.min(99, Math.round(radar.untilDanger(e, now) / 100) / 10)]) })
      }
      // --- чужие рядом (иссушитель, магмакуб) — обычный бой.
      const foes = (Object.values(bot.entities) as any[]).filter((e : any) => e && OTHER_FOES.has(e.name) && e.position && e.isValid !== false &&
        e.position.distanceTo(bot.entity.position) <= 6 && seesMob(bot, e))
      if (foes.length) {
        const f: any = foes.sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
        // Иссушитель бьёт 8 (в железе 4.5) дважды в секунду под огнём шаров —
        // замер 10: смерть с 11.5 хп за 3 с. Мало хп — сперва коробка.
        // Без огнестойкости бой с иссушителем под шарами блейзов — тир по нам (ферма 02.10 neF-blz-2: «slain by Wither
        // Skeleton», огонь 17 + шары 13.5): закрыться и кончить заход (разбор Codex ne-blaze.md, правка 2).
        // Отход в укрытие и возврат, а не конец боя: отлечился — бой дальше.
        if (!fireproof() && vis.length && f.name !== 'magma_cube') {
          const r = await restNow()
          out.rests.push(r)
          log('отдых', { from: f.name, crossfire: true, ...r })
          if (!r.rested && (bot.health ?? 0) < 14) { stopped = 'чужой враг под огнём блейзов без огнестойкости, отдых не вышел'; bail = true; break }
          await equipSword()
          continue
        }
        if (hp < 13 && f.name !== 'magma_cube') {
          const r = await restNow()
          out.rests.push(r)
          log('отдых', { from: f.name, ...r })
          if (!r.rested) { stopped = r.why || 'отдых не завершён'; bail = true; break }
          await equipSword()
          continue
        }
        await setShield(false)
        stopWalking()
        setPhase('бой: ' + f.name)
        // Ближний бой — щит между взмахами ('always'): удар моба в поднятый
        // щит гасится целиком и отбрасывает его самого (applyItemBlocking →
        // blockUsingItem). Стрелку — 'ranged'.
        const melee = f.name !== 'skeleton' && f.name !== 'ghast'
        const r = melee
          ? await meleeGuarded(session, ctl, f, { guard, bailAt: Math.max(ctx.bailAt, 8), shouldStop: () => checkSafety('continue').action === 'leave' || dangersNow(liveBlazes(bot, dead, 32).filter(e => seesMe(bot, e)), gameClock.now()).length > 0 }).catch(e => ({ error: e.message }))
          : await combat.fight(session, ctl, { target: '#' + f.id, purpose: 'defense', allowRanged: p0(ctx).allowRanged, timeoutSeconds: 20, retreatAtHealth: Math.max(ctx.bailAt, 9), shield: 'ranged' }).catch(e => ({ error: e.message }))
        shieldOn = false
        try { await guard.raise(false) } catch {}
        log('чужой', { name: f.name, ...r })
        out.foes.push({ name: f.name, killed: !!r.killed || !!(r.kills && r.kills.length), hp: Math.round(bot.health ?? 0) })
        await equipSword()
        if (bunker && !inBunker()) await walkNear(bot, ctl, bunker.cell, 0, 8000)
        continue
      }
      const dangers = dangersNow(vis, now)
      // Опасен тот, кого достаёт меч, и шаров к нам не летит: бить его, а не
      // стоять за щитом (замер 23: блейз в 1.3 блока, заряжен, 0 взмахов за 20 с).
      if (dangers.length && gameClock.now() - lastSwing >= swingMs(bot) && !radar.incoming(now).length) {
        const close: any = blazes.filter((e : any) => reachTo(bot, e) <= MELEE && (require('../pick') as typeof import('../pick')).canHit(bot, e))
          .sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
        if (close && await swingFor(close)) {
          setPhase('меч под огнём')
          await sleep(80)
          await setShield(true, faceFor(dangers))
          continue
        }
      }
      if (dangers.length) {
        stopWalking()
        setPhase('щит')
        if (!bot.heldItem || !weapon || bot.heldItem.name !== weapon.name) await equipSword()
        await setShield(true, faceFor(dangers))
        await sleep(50)
        continue
      }
      // --- достроить коробку в тишине.
      if (!bunker && boxPlan && boxTries < 4 && now > boxRetryAt && !meleeThreat() &&
          !vis.some(e => radar.untilDanger(e, now) < 2500)) {
        boxTries++
        await setShield(false)
        setPhase('достройка коробки')
        const b = await buildBunker(session, ctl, boxPlan, setPhase)
        log('достройка коробки', { n: boxTries, ok: b.ok, placed: b.placed, open: b.open, roofed: b.roofed, failed: b.failed })
        if (b.ok) { bunker = { cell: boxPlan.cell, front: boxPlan.front, window: true, win: boxPlan.win, lowWindow: boxPlan.lowWindow }; boxPlan = null; out.bunker = { ...(out.bunker || {}), built: true, retries: boxTries } } else boxRetryAt = gameClock.now() + 8000
        await equipSword()
        continue
      }
      // --- меч: видимый в досягаемости.
      const inReach = blazes.filter((e : any) => reachTo(bot, e) <= MELEE && (require('../pick') as typeof import('../pick')).canHit(bot, e))
        .sort((a, b) => reachTo(bot, a) - reachTo(bot, b))
      if (inReach.length) {
        idleSince = now
        stopWalking()
        const e: any = inReach[0]
        // Блейз в 2 блоках бьёт сам раз в 20 тиков (BlazeAttackGoal, d² < 4):
        // щит к нему, взмах — сразу после его удара в щит или если он молчит
        // 1.2 с (замер 12: 24 хп ударами блейзов у спавнера).
        if (guard.stats.blocked > seenBlocks) { seenBlocks = guard.stats.blocked; blockAt = gameClock.now() }
        const close = e.position.distanceTo(bot.entity.position) < 2.4
        // Под огнестойкостью и с 12+ хп — бить на каждом откате (625 мс), не ждать удара в щит: вплотную ифрит наносит лишь 3.4, а
        // убитый перестаёт бить совсем (s1-LF-1/LA-6 06.10: ифриты вплотную, 4–6 попаданий за 15 с, 0 убийств).
        // …но не когда вплотную двое и больше: удары ифритов вплотную идут чаще, чем мы их убиваем (s1c-B-6 06.10: под FR 4 ифрита в
        // 4 бл., 6 ударов по 3.4 за пару секунд, 20 → 0) — тогда щит к ближнему и удар после блока, как без FR.
        const crowd = blazes.filter((b: any) => b.position.distanceTo(bot.entity.position) < 2.6).length
        const window = (fireproof() && hp >= 12 && crowd <= 1) || !close || gameClock.now() - blockAt < 700 || gameClock.now() - lastSwing > 1200
        if (window && await swingFor(e)) {
          setPhase('меч')
        } else {
          await setShield(true, blazeEye(e))
        }
        await sleep(50)
        continue
      }
      // Под огнестойкостью очереди не страшны (шар и горение — #is_fire): «тихо» всегда, лук стреляет без пауз под очередь
      // (разбор Codex ne-blaze.md, правка 3).
      const quiet: any = fireproof() ? Infinity : vis.filter((e : any) => e.position.distanceTo(bot.entity.position) <= NEAR).reduce((m, e) => Math.min(m, radar.untilDanger(e)), Infinity)
      // --- лук: ближайший видимый, если до ближайшей очереди видящих > 1.5 с.
      const bowOk = itemNamed(bot, 'bow') && arrowsHave(bot) > 0 && canUseRanged(session, { name: 'blaze' }, p0(ctx))
      // Без убийств 60 с — стрелять и по ифриту без пола под ним: стержень может упасть ниже или пропасть, но убитый уступает место
      // новому из спавнера, а ждать над пустотой — 0 убийств за 400 с (s1c-P-3/P-7 06.10, 4120…: «время вышло», «за стеной»).
      const kills0 = (ctx.kills || []).length
      if (kills0 !== out.killsSeen) { out.killsSeen = kills0; out.killAt = now }
      const anyFloor = now - (out.killAt || ctx.t0 || now) > 60000
      // …и дальше BOW_MAX (sr-g-3 10.10: ифриты висят в 15.2–15.6 бл., «shoot 0» 400 с, лук и 64 стрелы целы, 0 убийств).
      const bowMax = anyFloor ? 24 : BOW_MAX
      const shootable = blazes.filter((e : any) => { const d = e.position.distanceTo(bot.entity.position); return d >= BOW_MIN && d <= bowMax && aimFrac(bot, e) !== null && now - (noShot.get(e.id) || 0) > 2500 && (anyFloor || floorBelow(bot, e, bot.entity.position, reach)) && !bystanderOnLine(bot, e) })
        .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
      if (now - (out.dropAt || 0) > 10000) {
        out.dropAt = now
        const drops = ents(bot).filter((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 32)
          .map((e : any) => { let n = '?'; try { const it = e.getDroppedItem && e.getDroppedItem(); n = it ? it.name : '?' } catch {} return [n, xyz(e.position)] })
        log('лут', { kills: (ctx.kills || []).map(k => k.at), drops })
      }
      if (now - (out.dbgAt || 0) > 2000) { out.dbgAt = now; log('выбор', { vis: vis.length, shoot: shootable.length, seen: blazes.filter(e => seesMob(bot, e)).length, quiet: quiet === Infinity ? 'inf' : Math.round(quiet), bowOk: !!bowOk, inB: !!inBunker() }) }
      if (bowOk && shootable.length && quiet > 1300 && (!bunker || inBunker())) {
        idleSince = now
        stopWalking()
        await setShield(false)
        const e: any = shootable[0]
        const track = makeTrack(e)
        track.update()
        setPhase('лук')
        const t1 = gameClock.now()
        const frac = aimFrac(bot, e) ?? 0.55
        const r = await (require('../bow') as typeof import('../bow')).shoot(bot, e, {
          velFn: () => { track.update(); return track.vel() },
          // Точка прицела — видимая часть коробки (aimFrac), с упреждением.
          point: t => { track.update(); const v = track.vel(); return e.position.offset(v.x * t, (e.height || 1.8) * frac + v.y * t, v.z * t) },
          follow: false,
          mode: 'settle',
          shouldStop: () => {
            const n = gameClock.now()
            if (!canUseRanged(session, e, p0(ctx))) return true
            if (!e.isValid) return true
            if (meleeThreat() || checkSafety('continue').action === 'leave') return true
            if (fireproof()) return false
            if (radar.incoming(n).some(b => b.eta < 900)) return true
            return liveBlazes(bot, dead, 32).some((b : any) => seesMe(bot, b) && b.position.distanceTo(bot.entity.position) <= NEAR && radar.untilDanger(b, n) < 300)
          }
        }).catch(err => ({ shot: false, why: err.message }))
        if (r.shot) { out.arrows++; lastBow = gameClock.now() } else if (r.blocked || /не долетит/.test(r.why || '')) { noShot.set(e.id, gameClock.now()) }
        if (!r.shot) log('лук', { d: Math.round(e.position.distanceTo(bot.entity.position) * 10) / 10, why: r.why })
        if (gameClock.now() - t1 < 200) await sleep(200)
        await equipSword()
        continue
      }
      // --- вылазка: стержни на полу, никто не заряжен — собрать и назад.
      const charging = vis.some(e => radar.charged(e))
      // Вылазка: стержень в 4 блоках — хватает 1.5 с тишины (два шага и назад);
      // дальше — 2.5 с и никто не заряжен. Замер 13: из коробки 4 убийства,
      // стержень лежал в 2.7 блока, а тишины в 2.5 с не было ни разу.
      const nearRod = droppedRods(bot, 4, { reachable: true }) > 0
      // Стрел мало, а на полу их хватает — тоже вылазка.
      const arrowRun = arrowsHave(bot) < 10 && arrowsOnFloor(bot, 14).length >= 3
      const quietAll: any = vis.reduce((m, e) => Math.min(m, radar.untilDanger(e)), Infinity)
      // Под огнестойкостью шар не жжёт вовсе (fireball в #is_fire) — опасен только удар вплотную. neF-XF22-2 03.10: под
      // зельем 24 убийства, 10 стержней в 1–5 бл. на полу, подобрано 0 — каждую вылазку рвал «шар летит».
      const danger = () => (FP_SORTIE && fireproof()) ? !!meleeThreat() : (radar.incoming(gameClock.now()).length > 0 || liveBlazes(bot, dead, 32).some(b => seesMe(bot, b) && radar.untilDanger(b) < 900))
      // Дальняя вылазка — только между волнами (живых блейзов в 20 блоках нет):
      // стержни лежат у спавнера, и при живых её рвало на полпути (замер 27:
      // 2 стержня в 8 блоках, 0 подобрано). Ближний стержень — при тишине.
      // «Между волнами» — ни одного живого в 20 бывает редко: у спавнера кто-то
      // висит всегда (замер 31: 14 убийств, 4 стержня на полу, 0 подобрано).
      // Годится и так: заряженных нет, тишина 2.5 с, у стержня в 6 блоках блейзов
      // нет; вылазка всё равно обрывается по опасности (stopIf).
      const rodsNear = ents(bot).filter((e : any) => e && e.name === 'item' && e.position && isRod(e) && e.position.distanceTo(bot.entity.position) <= 16)
      const calmRod = rodsNear.some((r : any) => !liveBlazes(bot, dead, 32).some((b : any) => b.position.distanceTo(r.position) < 6))
      const clear = !liveBlazes(bot, dead, 20).length || (calmRod && quietAll > 2500)
      // Вылазка — только с 14+ хп; обрыв на < 12 (замеры 34–35: весь урон
      // попыток со смертью — «сбор» и «назад в коробку», 13–26 хп за вызов).
      const sortieStop = () => danger() || (bot.health ?? 20) < 12
      const fpSortie = FP_SORTIE && fireproof() && (bot.health ?? 20) >= 12 && !meleeThreat() && droppedRods(bot, 12, { reachable: true }) > 0
      if (now > sortieAfter && (fpSortie || (!charging && (bot.health ?? 20) >= 14 && ((nearRod && quietAll > 1500) || (clear && (droppedRods(bot, 16, { reachable: true }) > 0 || arrowRun)))))) {
        await setShield(false)
        setPhase('вылазка за стержнями')
        out.sorties++
        const got = countOf(bot, 'blaze_rod')
        let walks = 0
        if (bunker && bunker.window && inBunker()) {
          // Из коробки с окном — дверью: блок под окном выломать, собрать,
          // вернуться, заложить.
          const door = bunker.cell.plus(bunker.front)
          try { await (require('../tools') as typeof import('../tools')).breakFast(bot, door, { maxMs: 3000 }) } catch {}
          walks = await collectRods(bot, ctl, 16, 9000, { arrows: arrowRun, stopIf: sortieStop })
          setPhase('назад в коробку')
          await walkNear(bot, ctl, bunker.cell, 0, 6000)
          if (!inBunker()) await walkNear(bot, ctl, bunker.cell, 0, 4000)
          if (inBunker()) {
            await (require('../fortify') as typeof import('../fortify')).centerInCell(bot)
            try { await (require('../build') as typeof import('../build')).placeBlockAt(bot, door, { timeoutMs: 900 }) } catch {}
          }
        } else {
          walks = await collectRods(bot, ctl, 10, 7000, { arrows: arrowRun, stopIf: sortieStop })
        }
        if (walks < 0) log('вылазка прервана', { walks: -walks - 1 })
        if (walks <= 0 || countOf(bot, 'blaze_rod') === got) sortieAfter = gameClock.now() + 8000
        if (bunker && !inBunker()) { setPhase('назад в шалаш'); await walkNear(bot, ctl, bunker.cell, 0, 8000) }
        continue
      }
      if (spawner && p0(ctx).clearSpawner !== false && process.env.ND_BLAZE_CLEAR !== '0') {
        const workWindow = () => {
          if (meleeThreat() || foesNow().some(e => e.name !== 'blaze')) return 0
          if (fireproof()) return Infinity
          return Math.min(...liveBlazes(bot, dead, 32).filter(e => seesMe(bot, e)).map(e => radar.untilDanger(e)), ...radar.incoming(gameClock.now()).map(b => b.eta)) - SHIELD_LEAD_MS
        }
        // Existing blazes and floor drops satisfy part of the demand before another spawn is useful.
        const remaining = Math.max(0, want - countOf(bot, 'blaze_rod') - droppedRods(bot, 16, { reachable: true }) - blazes.length * .5)
        const at = bot.entity.position
        const inventory = bot.inventory.items().filter(i => /_pickaxe$|^(tnt|flint_and_steel|fire_charge)$/.test(i.name)).map(i => `${i.name}:${i.count}:${i.durabilityUsed}:${JSON.stringify(i.enchants || [])}`).join(',')
        const state = `${clearRevision}/${at.x},${at.y},${at.z}/${remaining}/${inventory}/${fireproof()}/${workWindow() > 0}/${blazes.map(e => `${e.id}:${radar.charged(e)}`).join(',')}/${radar.incoming(gameClock.now()).length}`
        if (remaining && state !== clearChecked) {
          clearChecked = state
          const protectedCells = []
          for (const shelter of [bunker?.cell, boxPlan?.cell, home].filter(Boolean)) {
            for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = -1; y <= 3; y++) protectedCells.push(shelter.floored().offset(x, y, z))
          }
          const clearing: typeof import('../blaze-clear') = require('../blaze-clear')
          const plan = clearing.plan(bot, spawner, { rods: remaining, protectedCells, horizon: (deadline - gameClock.now()) / 1000, windowMs: workWindow() })
          if (plan) {
            await setShield(false)
            setPhase('расчистка спавнера')
            const safe = (remainingMs = 0) => countOf(bot, 'blaze_rod') < want && workWindow() > remainingMs && !!bot.entity.onGround && (fireproof() || !(bot.entity.metadata?.[0] & 1))
            const result = await clearing.execute(session, ctl, plan, safe)
            const receipt = { ...result, pos: xyz(plan.pos), mode: plan.mode, gain: plan.gain, beforeUpper: plan.beforeUpper, savedSeconds: plan.savedSeconds, costSeconds: plan.costSeconds, remaining }
            ;(out.clearing || (out.clearing = [])).push(receipt)
            log('расчистка спавнера', receipt)
            await equipSword()
            if (result.ok) clearRevision++
            continue
          }
        }
      }
      if (!blazes.length) {
        if (now - idleSince > (spawner ? 50000 : 8000)) {
          if (spawner && silentApproach < 2 && bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) > 15) {
            silentApproach++
            log('спавнер молчит издали — подхожу', { d: Math.round(bot.entity.position.distanceTo(spawner)), n: silentApproach })
            await walkNear(bot, ctl, spawner, 8, 15000)
            idleSince = gameClock.now()
            continue
          }
          stopped = spawner
            ? `спавнер молчит ${Math.round((now - idleSince) / 1000)}с (блейзов нет) — стою в ${Math.round(bot.entity.position.distanceTo(spawner))} бл. от него`
            : 'блейзов в 32 блоках больше не вижу'
          break
        }
      } else idleSince = now
      // --- блейзы рядом, но ни одного не видно 6 с (висят над помостом, за
      // стеной): другая точка боя с видом на куб спавна. Замер 8: у края
      // помоста трое в 3–7 блоках, не видно ни одного, 2 стержня за 3 минуты.
      if (vis.length) lastVisAt = now
      // Без увиденного спавнера скрытая сущность не задаёт точную цель хода.
      // Уже увиденная крепость и её видимый пол дают следующий законный обзор.
      if (!bunker && !spawner && !vis.length && now - lastVisAt > 6000 && quiet > 1500 && process.env.ND_BLAZE_NOSP_APPROACH !== '0') {
        const fortress: typeof import('../fortress') = require('../fortress')
        const known = fortress.placeOf(session, fortress.PLACE)
        if (!known || (require('../worlds') as typeof import('../worlds')).worldOfRecord(known) !== 'the_nether') {
          stopped = 'ифритов и спавнера не видно, увиденная крепость неизвестна — нужен поиск'
          break
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
          stopped = 'увидел спавнер — следующий бой у него'
          break
        }
        if (bot.entity.position.distanceTo(from) < 0.8 && !seenBlazes) {
          stopped = 'нового обзора крепости не достиг — нужен другой подход'
          break
        }
        home = bot.entity.position.floored()
        idleSince = lastVisAt = gameClock.now()
        continue
      }
      // Видны, но все дальше дальности лука (sr-k-3 10.10: «vis 3, shoot 0» 127 раз, ифриты в 25–30 бл., 0 убийств за 400 с) — подойти
      // к ближнему на 12 бл. по той же цене, что к ифриту за стеной.
      const bowReach = now - (out.killAt || ctx.t0 || now) > 60000 ? 24 : BOW_MAX
      if (!bunker && bowOk && vis.length && !shootable.length && quiet > 1500 && farApproaches < 8 &&
        vis.every((e: any) => e.position.distanceTo(bot.entity.position) > bowReach) && (bot.health ?? 0) >= (fireproof() ? 12 : 16)) {
        const near: any = vis.slice().sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
        farApproaches++
        out.farApproaches = farApproaches
        setPhase('к дальнему ифриту на выстрел')
        log('к дальнему ифриту', { n: farApproaches, d: Math.round(near.position.distanceTo(bot.entity.position)), to: xyz(near.position) })
        await walkNear(bot, ctl, floorUnder(bot, near.position) || near.position.floored(), 12, 8000)
        continue
      }
      if (!bunker && spawner && blazes.some((e : any) => e.position.distanceTo(bot.entity.position) < 16) && now - lastVisAt > 6000 && quiet > 1500 && reposts < 12) {
        await setShield(false)
        const np = choosePost(bot, spawner, home)
        lastVisAt = now
        reposts++
        if (np && !np.pos.equals(bot.entity.position.floored())) {
          setPhase('другая точка боя')
          home = np.pos
          out.reposts = (out.reposts || 0) + 1
          log('другая точка', { ...xyz(np.pos), view: np.view, h: np.h })
          await walkNear(bot, ctl, np.pos, 0, 8000)
          continue
        }
        const window = windowForPost(bot, spawner)
        if (window && !ctl.aborted) {
          stopWalking()
          setPhase('окно к залу спавнера')
          const dug = await (require('../tools') as typeof import('../tools')).breakFast(bot, window.pos, { maxMs: 8000 })
          log('окно к залу спавнера', { at: xyz(window.pos), gain: window.gain, ...dug })
          await equipSword()
          if (dug.ok) {
            out.windows = (out.windows || 0) + 1
            refreshReach()
            lastVisAt = gameClock.now()
            continue
          }
        }
        // Точки обзора нет, а тело ниже/выше помоста и вплотную пусто — ходом по сетке на пол зала (s1-post14/15 06.10: с y66
        // при спавнере y69 ни одного убийства за 6 мин).
        if ((Math.floor(bot.entity.position.y) < spawner.y - 1 || Math.floor(bot.entity.position.y) > spawner.y + 2) && !liveBlazes(bot, dead, 5).some(e => seesMe(bot, e)) && process.env.ND_NE_ROUTE !== '0' && (out.levelRoutes || 0) < 3) {
          out.levelRoutes = (out.levelRoutes || 0) + 1
          setPhase('на помост')
          // S1f (вслепую — сетки копии нет, routeTo отказывал сразу): ход к полу зала pathfinder'ом со ступенями/столбом (fortress.climbTo),
          // как игрок поднимается к помосту (s1f-D1-1: спавнер увиден с 11 бл. ниже — «за стеной, точки обзора нет», 0 стержней).
          const NRg = (require('../nether-route') as typeof import('../nether-route')).gridOf(session)
          const rr: Partial<import('../nether-route').NetherRouteResult> = NRg || process.env.ND_BLAZE_CLIMB === '0'
            ? await (require('../nether-route') as typeof import('../nether-route')).routeTo(session, ctl, { x: spawner.x, y: spawner.y, z: spawner.z, r: 2, dy: 0, solidFloor: true, frKeep: 1, ironOk: true, abortNear: { re: '^blaze$', r: 4 }, timeoutSeconds: 40 }).catch(e => ({ ok: false, why: e.message }))
            : await (require('../fortress') as typeof import('../fortress')).climbTo(session, ctl, spawner.offset(Math.sign(bot.entity.position.x - spawner.x) * 3 || 3, -1, Math.sign(bot.entity.position.z - spawner.z) * 3), gameClock.now() + 40000).then(w => ({ ok: w.ok, why: w.error, steps: null })).catch(e => ({ ok: false, why: e.message }))
          log(NRg ? 'на помост по сетке' : 'на помост ступенями', { ok: rr.ok, why: rr.why, steps: rr.steps, at: xyz(bot.entity.position) })
          await equipSword()
          continue
        }
        if (reposts >= 2) {
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
          const approachOk = fireproof() || process.env.ND_BLAZE_APPROACH_PRICE === '0' ? (bot.health ?? 0) >= 12 : crowdAt === 0 && (bot.health ?? 0) >= 16
          if (hidden && !approachOk) log('к ифриту за стеной — не иду', { crowd: crowdAt, hp: Math.round(bot.health ?? 0), fr: fireproof() })
          if (hidden && approaches < (fireproof() ? 14 : 6) && approachOk) {
            approaches++
            out.approaches = approaches
            setPhase('к ифриту за стеной')
            log('к ифриту за стеной', { n: approaches, to: xyz(hidden.position) })
            await walkNear(bot, ctl, floorUnder(bot, hidden.position) || hidden.position.floored(), 2, 6000)
            lastVisAt = gameClock.now()
            continue
          }
          stopped = 'ифриты за стеной, доступной точки обзора нет — бой без прогресса прекращён'
          break
        }
      }
      // --- без шалаша: далеко от места боя (отдых бегом, погоня) — назад.
      if (!bunker && home && bot.entity.position.distanceTo(home) > 8 && quiet > 1500) {
        await setShield(false)
        if (gameClock.now() - goalAt > 800) {
          goalAt = gameClock.now()
          setPhase('назад к спавнеру')
          try { bot.pathfinder.setGoal(new goals.GoalNear(home.x, home.y, home.z, 2), true) } catch {}
        }
        await sleep(100)
        continue
      }
      // --- без шалаша: шаг к низкому блейзу в тишине (меч).
      if (!bunker) {
        const stepTo: any = vis.filter((e : any) => {
          const dyEye = blazeEye(e).y - myEye(bot).y
          const flat = Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)
          return dyEye < 1.8 && dyEye > -2.5 && flat < 7
        }).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
        if (stepTo && quiet > 1200) {
          await setShield(false)
          const f = floorUnder(bot, stepTo.position)
          if (f && gameClock.now() - goalAt > 400) {
            goalAt = gameClock.now()
            setPhase('шаг к блейзу')
            try { bot.pathfinder.setGoal(new goals.GoalNear(f.x, f.y, f.z, 1.5), true) } catch {}
          }
          await sleep(100)
          continue
        }
      } else if (!inBunker() && bunker.window && now - (bunker.outSince || (bunker.outSince = now)) > 15000) {
        log('коробка брошена', { at: xyz(bot.entity.position) })
        bunker = null
        continue
      } else if (!inBunker()) {
        await setShield(false)
        if (gameClock.now() - goalAt > 800) {
          goalAt = gameClock.now()
          setPhase('назад в шалаш')
          try { bot.pathfinder.setGoal(new goals.GoalBlock(bunker.cell.x, bunker.cell.y, bunker.cell.z), true) } catch {}
        }
        await sleep(100)
        continue
      }
      if (bunker) bunker.outSince = 0
      stopWalking()
      // Огонь у ног (шары, прошедшие мимо, жгут пол помоста): в тишине — затушить
      // рукой, как игрок (огонь ломается мгновенно). Шаг в огонь — 8 с горения.
      if (!bunker && quiet > 2000 && now - (out.fireAt || 0) > 1500) {
        const feet = bot.entity.position.floored()
        let fire = null
        for (let x = -2; x <= 2 && !fire; x++) for (let z = -2; z <= 2 && !fire; z++) for (const y of [0, 1, -1]) {
          const b = bot.blockAt(feet.offset(x, y, z))
          if (b && b.name === 'fire') { fire = b; break }
        }
        out.fireAt = now
        if (fire && fire.position.offset(0.5, 0.5, 0.5).distanceTo(myEye(bot)) < 4.2 && losClearBut(bot, myEye(bot), fire.position.offset(0.5, 0.3, 0.5), [fire.position])) {
          await setShield(false)
          setPhase('тушу огонь')
          try { await bot.lookAt(fire.position.offset(0.5, 0.2, 0.5), true); await bot.dig(fire, true); out.fires = (out.fires || 0) + 1 } catch {}
          await equipSword()
          continue
        }
      }
      if ((bot.food ?? 20) < 18 && quiet > 2500) {
        await setShield(false)
        setPhase('еда')
        try { await actions.eat(session, {}) } catch {}
        await equipSword()
        continue
      }
      // Стрел нет, а к окну за 30 с никто не подлетел — из коробки их не
      // взять (замер 16: 7 убийств за 32 стрелы, потом ни одного). Выйти
      // дверью и драться у спавнера мечом; отдых — снова коробкой.
      // Стрел нет — новая коробка вплотную к спавнеру (1.4..3 блока): новые
      // блейзы появляются в ±4 от него, и меч через окно их достаёт. Выход в
      // открытый бой без стрел кончался смертью (замеры 19, 26: иссушитель).
      // По желанию (meleeBox: true): замер 30 — путь к коробке у спавнера шёл по
      // горящему помосту мимо иссушителя, 24 хп за переход, смерть. По умолчанию
      // без стрел — стоп словами (стрелы кончились), тело в коробке.
      if (p0(ctx).meleeBox === true && bunker && bunker.window && !bowOk && !bunker.melee && now - lastSwing > 20000 && now - lastBow > 20000 && quietAll > 3000) {
        // Дверь сначала: из закрытой коробки заливка «куда дойти» видит одну клетку.
        const door = bunker.cell.plus(bunker.front)
        try { await (require('../tools') as typeof import('../tools')).breakFast(bot, door, { maxMs: 3000 }) } catch {}
        const plan = planKillBox(bot, spawner, blocksHave(bot), { hMin: 1.4, hMax: 3.2, hBest: 2 })
        log('коробка для меча', plan.none ? { none: true, tried: plan.tried } : { cell: xyz(plan.cell), h: plan.h, seen: plan.seen })
        if (!plan.none) {
          const b = await buildBunker(session, ctl, plan, setPhase)
          if (b.ok) { bunker = { cell: plan.cell, front: plan.front, window: true, melee: true }; home = plan.cell; out.meleeBox = xyz(plan.cell) } else { boxPlan = plan; boxTries = 0; bunker = null; home = plan.cell }
          continue
        }
        // Места нет — дверь назад.
        try { await (require('../build') as typeof import('../build')).placeBlockAt(bot, door, { timeoutMs: 900 }) } catch {}
        bunker.melee = true
      }
      if (bunker && !bowOk && now - lastSwing > 30000 && now - lastBow > 30000) {
        stopped = arrowsHave(bot) > 0
          ? 'стрелы оставлены в резерве, а к окну коробки блейзы не подлетают — нужен ближний бой или явное разрешение стрелять; стою в коробке'
          : 'стрелы кончились, а к окну коробки блейзы не подлетают — нужны стрелы (или снежки); стою в коробке'
        out.needArrows = true
        break
      }
      setPhase('ожидание')
      const face = bunker ? doorPoint() : (vis.length ? blazeEye(vis[0]) : (spawner ? spawner.offset(0.5, 0.5, 0.5) : null))
      await setShield(!fireproof() && (vis.length > 0 || !!spawner), face)
      await sleep(100)
    }
    // Стержни у спавнера — собрать перед уходом (из коробки — дверью: закрытая
    // коробка держала тело, 4 стержня так и остались лежать, замер 31).
    // Не ниже 12 хп и с обрывом по опасности: этот сбор без проверок брал до
    // 26 хп за вызов (замеры 34–35), а стержни пролежат 5 минут — следующий
    // вызов их поднимет.
    const finalStop = () => (bot.health ?? 20) < 10 || radar.incoming(gameClock.now()).length > 0 || liveBlazes(bot, dead, 32).some(b => seesMe(bot, b) && radar.untilDanger(b) < 900)
    // Набрал — лежащие стержни не нужны; без FR сбор при ифритах в виду — под удары (s1c-L-1 06.10: без FR 12 убийств, 5 стержней,
    // затем «сбор» — 5 ударов вплотную и шары, 20 → 2).
    const calmFloor = fireproof() || !liveBlazes(bot, dead, 10).some(e => seesMe(bot, e))
    if (!bunker?.lowWindow && !ctl.aborted && !bail && droppedRods(bot, 16) > 0 && (bot.health ?? 20) >= 12 && countOf(bot, 'blaze_rod') < want && calmFloor) {
      await setShield(false)
      setPhase('сбор')
      if (bunker && inBunker()) { try { await (require('../tools') as typeof import('../tools')).breakFast(bot, bunker.cell.plus(bunker.front), { maxMs: 3000 }) } catch {} }
      await collectRods(bot, ctl, 16, 12000, { stopIf: finalStop })
      if (bunker && !inBunker()) { await walkNear(bot, ctl, bunker.cell, 0, 6000); if (inBunker()) { try { await (require('../build') as typeof import('../build')).placeBlockAt(bot, bunker.cell.plus(bunker.front), { timeoutMs: 900 }) } catch {} } }
    }
  } finally {
    if (bunker?.lowWindow && inBunker() && (bot.health ?? 0) > 0 && !ctl.aborted) {
      out.windowSealed = await shutDoor(bot, bunker).catch(() => false)
    }
    bot.removeListener('blockUpdate', onClearBlock)
    bot.removeListener('entityHurt', onBlazeHurt)
    bot.removeListener('heldItemChanged', onHeld)
    try { await setShield(false) } catch {}
    stopWalking()
    radar.stop()
    safety.close()
    guard.close()
    if (bot.physics && lookSpeed) { bot.physics.yawSpeed = lookSpeed[0]; bot.physics.pitchSpeed = lookSpeed[1] }
    try { bot.pathfinder.setMovements(saved) } catch {}
  }
  out.shield = guard.report()
  out.shieldWear = shieldWear(bot)
  out.radar = radar.stats
  out.arrowsLeft = arrowsHave(bot)
  return { ...out, stopped, bail }
}
const p0 = ctx => ctx.p || {}

export { holdSpawner }
