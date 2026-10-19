// Бой у спавнера ифритов «мечом по месту» (ND_BLAZE_MELEE=1, 16.10, Claude-сим). Сцены у спавнера (blz-scene, tw-n23):
// holdSpawner с коробкой/окном/«тишиной» давал 0–1 стержня и смерти — тело строило коробку и «лечилось» под ударами ифритов
// вплотную, а под огнестойкостью стояло в 4 бл. от ифритов и не подходило (bfr-5974-601: 400 с, 1 взмах).
// Механика (jar 1.21.11, Blaze$BlazeAttackGoal.tick): d² < 4 — удар вплотную раз в 20 тиков и полёт к цели; дальше, при луче, —
// очередь: заряд 60 тиков, 3 шара через 6, откат 100; ифрит сам не подлетает, пока видит цель. Значит, ифрита в досягаемости бить
// сразу (не строить и не лечиться под ним), к ифриту на высоте глаз ±2 — подходить; без огнестойкости — щит к заряженному,
// отлёжка в коробке (boxRest) при малом хп, когда вплотную никого. Удар — только по тому, что видит прицел (pick.aim/canHit).
import * as gameClock from './game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from './movement'
import { countOf } from './items'

const REACH = 2.95

async function meleeCamp (session, ctl, { spawner, want, deadline, dead, setPhase = (_: string) => {} }: any) {
  const bot = session.bot
  const B: typeof import('./blaze') = require('./blaze')
  const pick: typeof import('./pick') = require('./pick')
  const actions: typeof import('./actions') = require('./actions')
  const guard = (require('./combat') as typeof import('./combat')).makeShield(session, ctl, { shield: 'ranged' })
  const radar = B.makeRadar(bot)
  const saved = bot.pathfinder.movements
  bot.pathfinder.setMovements(B.fightMoves(session))
  // rests/foes/shieldMs — те же поля, что у holdSpawner: farmRods собирает из них итог (doctrine).
  const out: any = { mode: 'melee', melee: 0, hits: 0, approaches: 0, rests: [], foes: [], shieldMs: 0, arrows: 0, eats: 0, collects: 0 }
  const dead0 = dead.size
  const onHurt = e => { if (e && e.name === 'blaze') out.hits++ }
  bot.on('entityHurt', onHurt)
  let lastSwing = 0, swapAt = 0, goalAt = 0, phase = '', focus = null, jumpAt = 0
  const onHeld = () => { swapAt = gameClock.now() }
  bot.on('heldItemChanged', onHeld)
  const phaseTo = (s: string) => { if (s !== phase) { phase = s; setPhase(s) } }
  const fr = () => B.hasEffect(bot, 'fire_resistance')
  const stopWalk = () => { try { bot.pathfinder.setGoal(null) } catch {} }
  const sword = async () => {
    const w = (require('./items') as typeof import('./items')).bestWeapon(bot)
    if (w && bot.heldItem?.name !== w.name) { try { await bot.equip(w, 'hand') } catch {} }
  }
  const eyeDy = e => B.blazeEye(e).y - pick.eyeOf(bot).y
  try {
    // Зелье огнестойкости в рюкзаке, а эффекта нет (bnf9 n39: «выпил», эффект так и не пришёл — шары и горение до смерти) —
    // выпить снова и дождаться эффекта до первого взмаха (смена предмета в руке обрывает питьё).
    for (let k = 0; k < 2 && !fr() && !ctl.aborted; k++) {
      const d = await B.drinkFireResistance(bot)
      if (!/^выпил/.test(String(d))) break
      for (let i = 0; i < 40 && !fr(); i++) await sleep(100)
      out.drinks = (out.drinks || 0) + 1
    }
    await sword()
    try { await guard.wear() } catch {}
    while (!ctl.aborted && (bot.health ?? 0) > 0) {
      const now = gameClock.now()
      if (countOf(bot, 'blaze_rod') >= want) { out.stopped = 'набрал'; break }
      if (now >= deadline) { out.stopped = 'время вышло'; break }
      const hp = bot.health ?? 0
      const blazes = B.liveBlazes(bot, dead, 24)
      // 1. Ифрит в досягаемости — бить на откате (смена предмета обнуляет откат — Player.resetAttackStrengthTicker).
      // Иссушитель и магмовый куб у спавнера бьют вплотную (bnf4-5974-603: смерть от иссушителя, пока цикл бил только ифритов).
      const others = (Object.values(bot.entities) as any[]).filter(e => e && /^(wither_skeleton|magma_cube)$/.test(e.name) && e.position && e.isValid !== false)
      const inReach = [...blazes, ...others].filter(e => B.reachTo(bot, e) <= REACH && pick.canHit(bot, e)).sort((a, b) => B.reachTo(bot, a) - B.reachTo(bot, b))
      if (inReach.length) {
        stopWalk()
        // Бить одного до смерти (отбрасывание и смена цели размазывали урон: bn-5974-601 — 26 попаданий, 1 убийство).
        // Иссушитель в досягаемости — первым (удар 8 + иссушение, bnf6/bnf8 на −2642…: смерти от иссушителя при фокусе на ифрите).
        const e = inReach.find(x => x.name === 'wither_skeleton') || inReach.find(x => x.id === focus) || inReach[0]
        focus = e.id
        const ready = now - Math.max(lastSwing, swapAt) >= (require('./pvp') as typeof import('./pvp')).cooldownMs(bot.heldItem)
        // Крит (Player.attack: падение, не на земле, не в воде/на лестнице, без слепоты) ×1.5: 9 вместо 6 — ифрит за 3 удара.
        // Прыжок за откат до готовности; удар — на спуске. Без опоры над головой (потолок гасит прыжок).
        const v = bot.entity.velocity, falling = !bot.entity.onGround && v.y < -0.08 && !bot.entity.isInWater
        if (!ready && bot.entity.onGround && now - jumpAt > 500 && now - Math.max(lastSwing, swapAt) >= (require('./pvp') as typeof import('./pvp')).cooldownMs(bot.heldItem) - 350) {
          const head = bot.blockAt(bot.entity.position.offset(0, 2.2, 0))
          if (!head || head.boundingBox === 'empty') { jumpAt = now; bot.setControlState('jump', true); gameClock.setTimeout(() => bot.setControlState('jump', false), 100) }
        }
        if (ready && (falling || bot.entity.onGround && now - jumpAt > 700)) {
          const aim = pick.aim(bot, e)
          if (aim?.point) {
            try { await guard.raise(false) } catch {}
            phaseTo('меч')
            try { await bot.lookAt(aim.point, true); bot.attack(e); lastSwing = gameClock.now(); out.melee++; if (falling) out.crits = (out.crits || 0) + 1 } catch {}
          }
        } else if (!ready && (!fr() || hp < 12) && !(bot.entity.onGround && now - jumpAt < 450)) {
          // Между взмахами — щит к ифриту и под огнестойкостью: удар вплотную (6, BlazeAttackGoal раз в 20 тиков) щит гасит спереди
          // (bnf3-6185-601: 3 убийства и смерть от ударов вплотную под FR). Поднят ≥5 тиков до удара (BlocksAttacks.blockDelay).
          try { await bot.lookAt(B.blazeEye(e), true); await guard.raise(true) } catch {}
        }
        await sleep(50)
        continue
      }
      // 1б. Ифрит чуть выше досягаемости (до +1.2 по высоте, рядом по горизонтали) — прыжок: удар на спуске, он же крит.
      const overhead = blazes.find(e => pick.canHit(bot, e, { range: REACH + 1.2 }) && B.reachTo(bot, e) <= REACH + 1.2 && eyeDy(e) > 0.3)
      if (overhead && bot.entity.onGround && now - jumpAt > 450 && now - Math.max(lastSwing, swapAt) >= (require('./pvp') as typeof import('./pvp')).cooldownMs(bot.heldItem) - 300) {
        stopWalk()
        focus = overhead.id
        try { await guard.raise(false); await bot.lookAt(B.blazeEye(overhead), true) } catch {}
        jumpAt = now; bot.setControlState('jump', true); gameClock.setTimeout(() => bot.setControlState('jump', false), 100)
        phaseTo('прыжок к ифриту')
        await sleep(50)
        continue
      }
      const close = blazes.some(e => e.position.distanceTo(bot.entity.position) < 4)
      // 1в. Огнестойкость кончилась (3 мин на зелье), а зелья ещё есть — допить, пока вплотную никого (bnfa-7564-662: 7 стержней,
      // эффект кончился на 6-й минуте боя — сгорел и потерял стержни).
      // Продлить заранее: за 15 с до конца выпитой огнестойкости (bnfc-7564-684: сгорел на 200-й с, на исходе первого зелья).
      const frEnding = !!bot._ndFrUntil && bot._ndFrUntil - now < 15000
      if ((!fr() || frEnding) && !close && B.drinkable?.(bot)) {
        stopWalk()
        try { await guard.raise(false) } catch {}
        phaseTo('огнестойкость')
        await B.drinkFireResistance(bot, { renew: frEnding })
        for (let i = 0; i < 40 && !fr(); i++) await sleep(100)
        out.drinks = (out.drinks || 0) + 1
        continue
      }
      // 2. Без огнестойкости и мало хп, вплотную никого — отлёжка в коробке (поесть, отлечиться) и назад.
      if (!fr() && hp < 9 && !close) {
        stopWalk()
        try { await guard.raise(false) } catch {}
        phaseTo('отлёжка')
        const r = await B.boxRest(session, ctl, { toward: spawner, until: 18, maxMs: 60000 })
        out.rests.push({ rested: !!r.rested, why: r.why, hp: Math.round(bot.health ?? 0) })
        if (!r.rested && (bot.health ?? 0) < 7) { out.stopped = `хп ${Math.round(bot.health ?? 0)}, отлёжка не вышла: ${r.why || '?'}`; out.bail = true; break }
        await sword()
        continue
      }
      // 3. Поесть, пока вплотную никого.
      if ((bot.food ?? 20) < 17 && !close) {
        stopWalk()
        try { await guard.raise(false) } catch {}
        phaseTo('еда')
        try { await actions.eat(session, {}); out.eats++ } catch {}
        await sword()
        continue
      }
      // 4. Стержни на полу рядом, вплотную никого.
      // Под огнестойкостью — и при ифритах в 3+ бл. (bnf4-7564-604: 22 убийства, подобрано 4 стержня).
      const pickupClear = fr() ? !blazes.some(e => B.reachTo(bot, e) <= REACH + 0.5) : !close
      if (pickupClear && B.droppedRods(bot, 12, { reachable: true }) > 0) {
        try { await guard.raise(false) } catch {}
        phaseTo('сбор')
        await B.collectRods(bot, ctl, 12, 5000, { stopIf: () => B.liveBlazes(bot, dead, fr() ? 2 : 3).length > 0 })
        out.collects++
        continue
      }
      // 5. Подойти к видимому ифриту на высоте глаз (−2…+2): под огнестойкостью — всегда, без неё — с 12+ хп.
      // Ифрит висит над целью на triangle(0.5, 6.891) от её глаз (Blaze.customServerAiStep, смена раз в 100 тиков) — чаще всего на
      // уровне глаз: под огнестойкостью встать под ним и ждать спуска/прыгать; без неё — только к тем, кто на высоте глаз ±2.
      const target = blazes.filter(e => B.seesMe(bot, e) && eyeDy(e) >= -2 && eyeDy(e) <= (fr() ? 5 : 2) && e.position.distanceTo(bot.entity.position) <= 12)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (target && (fr() || hp >= 12)) {
        // Без огнестойкости — подход со щитом к цели: шар спереди гасится целиком и не поджигает (BlocksAttacks, фронт 90°); шаг медленнее,
        // зато очередь на подходе не жжёт (bn5: смерть за 25–570 с от шаров и горения).
        if (!fr()) { try { await bot.lookAt(B.blazeEye(target), true); await guard.raise(true) } catch {} } else { try { await guard.raise(false) } catch {} }
        if (now - goalAt > 400) {
          goalAt = now
          phaseTo('к ифриту')
          out.approaches++
          const f = B.floorUnder(bot, target.position) || target.position.floored()
          try { bot.pathfinder.setGoal(new goals.GoalNear(f.x, f.y, f.z, 1), true) } catch {}
        }
        await sleep(100)
        continue
      }
      // 6. Без огнестойкости — щит к заряженному с лучом.
      const charged = !fr() && blazes.find(e => B.seesMe(bot, e) && radar.charged(e))
      if (charged) {
        stopWalk()
        phaseTo('щит')
        try { await bot.lookAt(B.blazeEye(charged), true); await guard.raise(true) } catch {}
        await sleep(50)
        continue
      }
      // 7. Никого в досягаемости — стоять у спавнера (спавн в ±4 от него, работает при игроке в 16).
      try { await guard.raise(false) } catch {}
      if (spawner && bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) > 3.5 && now - goalAt > 800) {
        goalAt = now
        phaseTo('к спавнеру')
        try { bot.pathfinder.setGoal(new goals.GoalNear(spawner.x, spawner.y, spawner.z, 2), true) } catch {}
      } else phaseTo('жду ифритов')
      await sleep(150)
    }
  } finally {
    stopWalk()
    try { await guard.raise(false) } catch {}
    try { radar.stop() } catch {}
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('heldItemChanged', onHeld)
    try { bot.pathfinder.setMovements(saved) } catch {}
  }
  out.at = xyz(bot.entity.position)
  out.kills = dead.size - dead0
  if (!out.stopped && ctl.aborted) out.stopped = 'прервано'
  return out
}

export { meleeCamp }
