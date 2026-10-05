'use strict'
const gameClock = require('./src/game-clock')
const { createGameBot } = require('./scene-kit')
// Посадка в огонь (mace.descend, 2026-09-26): прогон физики до земли видит
// лаву под точкой посадки и находит клавиши, с которыми сядем мимо. Голый
// клиент NeuroEnd (оп на end) висит в 9 блоках над площадкой, под ним лава
// 1×1 (прямо под ногами) или 3×3; спрашиваем mace.landing без клавиш и с
// каждой из восьми сторон, потом отпускаем и падаем с выбранными клавишами.
//   MC_PORT=25568 node try-burnland.js
const mace = require('./src/mace')

const PORT = Number(process.env.MC_PORT || 25568)
const sleep = ms => gameClock.sleep(ms)
const X = 700; const Y = 150; const Z = 700

;(async () => {
  const bot = createGameBot({ host: '127.0.0.1', port: PORT, username: 'NeuroEnd', version: '1.21.11', auth: 'offline' }, { primary: true })
  await new Promise((resolve, reject) => { bot.once('spawn', resolve); bot.once('error', reject) })
  const cmd = async (t) => { bot.chat(t); await sleep(200) }
  try {
    await cmd('/execute in minecraft:overworld run tp NeuroEnd 700 170 700')
    await sleep(1500)
    await cmd(`/forceload add ${X - 8} ${Z - 8} ${X + 8} ${Z + 8}`)
    await cmd('/gamemode survival NeuroEnd')
    await cmd('/effect give NeuroEnd minecraft:resistance 60 4 true')
    await cmd('/effect give NeuroEnd minecraft:fire_resistance 60 0 true')
    for (const size of [0, 1]) {
      await cmd(`/fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y - 1} ${Z + 6} minecraft:stone`)
      await cmd(`/fill ${X - 6} ${Y} ${Z - 6} ${X + 6} ${Y + 12} ${Z + 6} minecraft:air`)
      await cmd(`/fill ${X - size} ${Y - 1} ${Z - size} ${X + size} ${Y - 1} ${Z + size} minecraft:lava`)
      // Сразу после телепорта (пакет позиции — forcedMove) тело ещё почти висит:
      // считаем посадку до того, как упадём (9 бл. — ~1 с).
      const moved = new Promise(r => bot.once('forcedMove', r))
      bot.chat(`/tp NeuroEnd ${X + 0.5} ${Y + 9} ${Z + 0.5} 0 0`)
      await moved
      const here = mace.landing(bot, mace.NO_KEYS)
      const cands = mace.AIR_KEYS.map(k => ({ k: Object.keys(k).filter(x => k[x]).join('+') || 'без клавиш', l: mace.landing(bot, k) }))
      const safe = cands.filter(c => c.l && !c.l.burn)
      console.log(`[лава ${2 * size + 1}×${2 * size + 1}] без клавиш: ${here ? (here.burn ? 'В ОГОНЬ' : 'чисто') + ` (${here.at.x.toFixed(2)}, ${here.at.y.toFixed(2)}, ${here.at.z.toFixed(2)}, ${here.t} тиков)` : 'нет прогона'} | чистые стороны: ${safe.map(c => c.k).join(', ') || 'нет'}`)
      // Падаем с первой чистой стороной — где сели на самом деле.
      const pick = safe.find(c => c.k !== 'без клавиш')
      if (pick) for (const x of ['forward', 'back', 'left', 'right']) bot.setControlState(x, !!mace.AIR_KEYS.find(k => (Object.keys(k).filter(y => k[y]).join('+') || 'без клавиш') === pick.k)[x])
      const t0 = gameClock.now()
      while (!bot.entity.onGround && !bot.entity.isInLava && gameClock.now() - t0 < 4000) await sleep(50)
      await sleep(150)
      const feet = bot.blockAt(bot.entity.position.floored())
      const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      console.log(`   упал с «${pick ? pick.k : '—'}»: ${bot.entity.position.x.toFixed(2)}, ${bot.entity.position.z.toFixed(2)} — ногами в ${feet && feet.name}, под ногами ${under && under.name}${bot.entity.isInLava ? ' (В ЛАВЕ)' : ''}`)
      bot.clearControlStates()
      await sleep(500)
    }
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    await cmd(`/fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y - 1} ${Z + 6} minecraft:stone`).catch(() => {})
    await cmd(`/forceload remove ${X - 8} ${Z - 8} ${X + 8} ${Z + 8}`).catch(() => {})
    bot.quit()
    gameClock.wall.setTimeout(() => process.exit(), 500)
  }
})()
