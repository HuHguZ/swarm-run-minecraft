'use strict'
// Бутылки опыта под ноги (гонка вооружений, s7 06.10): уровни для стола зачарований лаборатории.
// Бросок — use_item с бутылкой в руке, взгляд вниз (как mend в crystal.ts); сферы впитываются по одной раз в
// 2 тика (Player.takeXpDelay) — стоять, пока рядом есть сферы, не дольше 4 с.
import * as gameClock from '../game-clock'

async function drink (session, ctl, { max = 64 }: any = {}) {
  const bot = session.bot
  const level = () => (bot.experience && bot.experience.level) || 0
  const level0 = level()
  const next = () => bot.inventory.items().find(i => i.name === 'experience_bottle')
  let thrown = 0
  if (!next()) return { thrown, level: level0, gained: 0 }
  await bot.look(bot.entity.yaw, -Math.PI / 2, true)
  while (thrown < max && !ctl.aborted) {
    if (!bot.heldItem || bot.heldItem.name !== 'experience_bottle') { const it = next(); if (!it) break; await bot.equip(it, 'hand') }
    bot.activateItem()
    thrown++
    await gameClock.sleep(100)
  }
  try { bot.deactivateItem() } catch {}
  const orbs = () => (Object.values(bot.entities) as any[]).some(e => e && e.name === 'experience_orb' && e.position && e.position.distanceTo(bot.entity.position) < 6)
  const t0 = gameClock.now()
  await gameClock.sleep(300)
  while (orbs() && gameClock.now() - t0 < 4000 && !ctl.aborted) await gameClock.sleep(100)
  return { thrown, level: level(), gained: level() - level0 }
}

export { drink }
