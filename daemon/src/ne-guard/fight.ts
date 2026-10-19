'use strict'
// Страж Ада (ne-guard.ts): бой — сидя в укрытии и дуэль со щитом.
import * as gameClock from '../game-clock'
import { sleep } from '../movement'
import { meleeFoes, meleeName, rank, sees, shooterNear } from './foes'
import { guardCount } from './shelter'


// Сидеть в яме/на столбе, пока ближние рядом (≤ ms), есть, если голодно. Сверху (столб) — мечом по видимым.
let lastSitSwing = 0
export async function sit (session, ctl, ms, { swing = false, hitStop = false }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  let quiet = 0
  let swings = 0
  const g = bot._ndGuard
  // Со столба (swing) щит — между взмахами к ближайшему стрелку (арбалет пиглина, ифрит, гаст, скелет), иначе к ближнему: ходячие
  // снизу не достают, а стрела в спину на столбе — весь урон (сцена try-lab-ne-piglin 14.10, два с мечом и арбалет).
  const shield = swing && process.env.ND_SIT_SHIELD !== '0' && bot.inventory.slots[45]?.name === 'shield' ? (require('../combat') as typeof import('../combat')).makeShield(session, ctl, { shield: 'always' }) : null
  try {
    if (shield) await shield.wear()
    while (!ctl.aborted && gameClock.now() - t0 < ms && (bot.health ?? 0) > 0) {
      // Бьют сквозь «коробку» (диагональ, щель) — сидеть дальше нельзя (V2-1 03.10: брут на (−1,+1,−1) — 3 удара за 13 с, смерть).
      if (hitStop && g && g.hits.some(h => h.t > t0 + 300 && gameClock.now() - h.t < 1500 && meleeName(h.name || ''))) return { s: Math.round((gameClock.now() - t0) / 1000), swings, hit: true, left: meleeFoes(bot, 6).length }
      const foes = meleeFoes(bot, 6)
      if (!foes.length) { if (!quiet) quiet = gameClock.now(); if (gameClock.now() - quiet > 3000) break } else quiet = 0
      if (swing && foes.length) {
        const pick: typeof import('../pick') = require('../pick')
        const e: any = foes[0]
        if (pick.canHit(bot, e) && gameClock.now() - lastSitSwing > 640) {
          try {
            const sw = bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((a, b) => rank(b) - rank(a))[0]
            if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) await bot.equip(sw, 'hand')
            // В видимую точку его рамки (pick.aim), а не в грудь: из норы грудь за краем (ревью Codex q7).
            const aim = pick.aim(bot, e)
            if (aim?.point && !ctl.aborted) {
              await shield?.raise(false)
              await bot.lookAt(aim.point, true)
              bot.attack(e); lastSitSwing = gameClock.now(); swings++
            }
          } catch {}
        }
      }
      if (shield) {
        const face = shooterNear(bot) || foes[0]
        if (face) { try { await bot.lookAt(face.position.offset(0, (face.height || 1.8) * 0.8, 0), true) } catch {} }
        await shield.raise(true)
      }
      // @ts-expect-error eat(session, { item }): ctl попадает в опции (item не задан — ест любую еду), {} лишний; поведение не трогаю.
      if ((bot.food ?? 20) < 18 && (bot.health ?? 20) < 18) { try { await (require('../actions') as typeof import('../actions')).eat(session, ctl, {}) } catch {} }
      await sleep(250)
    }
  } finally { shield?.close() }
  return { s: Math.round((gameClock.now() - t0) / 1000), swings, left: meleeFoes(bot, 6).length }
}

// в прицеле (pick) — щит вниз, удар, щит снова. Враг дальше 3.2 и виден дольше 2 с — шаг к нему (щит поднят: арбалет).
export async function duel (session, ctl, target, ms = 15000, { crowdOk = false, lastStand = false }: any = {}) {
  const bot = session.bot
  const pick: typeof import('../pick') = require('../pick')
  const sw = bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((a, b) => rank(b) - rank(a))[0]
  if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} }
  const hasShield = !!(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield')
  const shield = hasShield ? (require('../combat') as typeof import('../combat')).makeShield(session, ctl, { shield: 'always' }) : null
  const imminent = () => hasShield && (require('../threats') as typeof import('../threats')).incoming(bot).find(p => p.ticks <= 10 && sees(bot, p.entity))
  const t0 = gameClock.now()
  let last = 0; let swings = 0; let far = 0; let foe = target
  const out: any = { swings: 0 }
  // Взмах в такт врага (ND_DUEL_TEMPO=0 — прежний «раз в 640 мс»): удар ходячего приходит в поднятый щит, а щиту после
  // подъёма нужно 5 тиков; откат врага после удара — 20 тиков (MeleeAttack.create(20)). Свой взмах — когда он нас сейчас не
  // достаёт (его рамка атаки — своя рамка + 0.83 по горизонтали, Mob.getAttackBoundingBox) или только что ударил; иначе щит
  // держим. Сцена try-lab-ne-piglin 14.10: взмах вслепую — пиглин бил в опущенный щит, 8 хп за раз.
  const swungAt = new Map()
  const onSwing = e => { if (e && e.id != null) swungAt.set(e.id, gameClock.now()) }
  bot.on('entitySwingArm', onSwing)
  const reachesUs = f => {
    const me = bot.entity.position
    const half = (f.width || 0.6) / 2 + 0.83 + 0.3
    return Math.abs(f.position.x - me.x) < half && Math.abs(f.position.z - me.z) < half && f.position.y < me.y + 1.8 && f.position.y + (f.height || 1.95) > me.y
  }
  // Щит выбит топором (cooldown) — такт не ждать: блока нет (ревью Codex q7).
  const shieldOff = () => gameClock.now() < (bot._ndShieldDisabledUntil || 0) || bot.inventory.slots[45]?.name !== 'shield'
  const tempoOk = f => !hasShield || shieldOff() || process.env.ND_DUEL_TEMPO === '0' || !reachesUs(f) ||
    gameClock.now() - (swungAt.get(f.id) ?? -Infinity) < 400 || gameClock.now() - Math.max(t0, swungAt.get(f.id) ?? -Infinity) > 2000
  try {
    await shield?.wear()
    while (!ctl.aborted && gameClock.now() - t0 < ms && (bot.health ?? 0) > 0) {
      if (!foe || foe.isValid === false || !bot.entities[foe.id]) {
        foe = meleeFoes(bot, 6)[0]
        if (!foe) { out.killed = true; break }
      }
      // A reachable walker arriving from another side takes precedence over the distant original shooter.
      const close: any = meleeFoes(bot, 4.5).find((e: any) => pick.aim(bot, e, { range: 3.2 })?.point)
      if (close && close !== foe && (!pick.aim(bot, foe, { range: 3.2 })?.point ||
          reachesUs(close) && !reachesUs(foe) || close.position.distanceTo(bot.entity.position) + 0.5 < foe.position.distanceTo(bot.entity.position))) {
        foe = close; far = 0
      }
      // Мало хп — уйти в коробку, если есть чем (иначе бой до конца: B2-3 03.10 — хп 7, стоп, коробки нет, смерть стоя).
      const canBox = guardCount(bot) >= 4
      if (((bot.health ?? 20) < 7 && canBox && !lastStand) || (!crowdOk && meleeFoes(bot, 6).length >= 3)) { out.stopped = (bot.health ?? 20) < 7 ? 'хп' : 'толпа'; break }
      // Не достать 4 с (за стеной, в щели, не подходит) — не стоять: бой не задался.
      if (gameClock.now() - Math.max(last, t0) > 4000 && !swings) { out.stopped = 'не достать'; break }
      const shot = imminent()
      if (shot) {
        // Fight держит руки: ближайший снаряд встречаем щитом, затем продолжаем того же врага.
        bot.setControlState('forward', false); far = 0
        try { await bot.lookAt(shot.entity.position, true) } catch {}
        await shield.raise(true)
        await sleep(60)
        continue
      }
      const d = foe.position.distanceTo(bot.entity.position)
      if (foe.name === 'blaze' && d >= 3.5) { out.stopped = 'блейз вне ближнего боя'; break }
      try { await bot.lookAt(foe.position.offset(0, (foe.height || 1.9) * 0.75, 0), true) } catch {}
      if (gameClock.now() - last >= 640 && pick.canHit(bot, foe) && tempoOk(foe)) {
        await shield?.raise(false)
        await sleep(50)
        if (ctl.aborted) break
        if (imminent()) continue
        // Удар — туда, куда видно (pick.aim), взгляд перед ним заново: после ожидания враг сдвинулся (ревью Codex q7).
        const aim = pick.aim(bot, foe)
        if (!aim?.point) { await shield?.raise(true); continue }
        try { await bot.lookAt(aim.point, true) } catch {}
        try { bot.attack(foe); swings++; last = gameClock.now() } catch {}
        await sleep(50)
        await shield?.raise(true)
      } else await shield?.raise(true)
      if (d > 3.2 && sees(bot, foe)) { if (!far) far = gameClock.now() } else far = 0
      // Шаг к врагу — только если шаг безопасен (S4c 07.10, замечание проверки г): клавиша «вперёд» к ифриту/иссушителю за краем
      // моста вела тело в пустоту или лаву; moves.stepSafe — обрыв > 3, лава/огонь/магма под шагом.
      bot.setControlState('forward', !!(far && gameClock.now() - far > 2000 && d > 3.2 && d < 10) && (require('../moves') as typeof import('../moves')).stepSafe(bot, (require('../moves') as typeof import('../moves')).keyDir(bot, 'forward')))
      await sleep(60)
    }
  } finally { bot.setControlState('forward', false); shield?.close(); bot.removeListener('entitySwingArm', onSwing) }
  out.swings = swings
  out.s = Math.round((gameClock.now() - t0) / 1000)
  return out
}
