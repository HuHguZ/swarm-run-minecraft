'use strict'
const gameClock = require('./src/game-clock')
const { createGameBot } = require('./scene-kit')
// Всплеск заряда ветра под ногами — в паутине и без (mace.windSmash,
// 2026-09-26): в арене взлёт «не поднимал» с подписью «всплеск пришёл, vy
// 1.02 … vy max −0.08». Голый клиент NeuroEnd (оп на end): стоит на площадке,
// заряд из левой руки строго вниз; раз — чисто, раз — паутина в ногах, раз —
// паутина на уровне головы. Итог: скорость сразу после всплеска и высшая точка.
//   MC_PORT=25568 node try-webwind.js
const mace = require('./src/mace')
const edges = require('./src/edges')

const PORT = Number(process.env.MC_PORT || 25568)
const sleep = ms => gameClock.sleep(ms)
const X = 720; const Y = 150; const Z = 720

;(async () => {
  const bot = createGameBot({ host: '127.0.0.1', port: PORT, username: 'NeuroEnd', version: '1.21.11', auth: 'offline' }, { primary: true })
  await new Promise<any>((resolve, reject) => { bot.once('spawn', resolve); bot.once('error', reject) })
  edges.fixSelfKnockback(bot)
  mace.install(bot)
  const cmd = async (t) => { bot.chat(t); await sleep(200) }
  try {
    await cmd(`/execute in minecraft:overworld run tp NeuroEnd ${X} ${Y + 20} ${Z}`)
    await sleep(1500)
    await cmd(`/forceload add ${X - 6} ${Z - 6} ${X + 6} ${Z + 6}`)
    await cmd('/gamemode survival NeuroEnd')
    await cmd('/effect give NeuroEnd minecraft:resistance 60 4 true')
    for (const web of ['нет', 'в ногах', 'у головы']) {
      await cmd(`/fill ${X - 4} ${Y - 1} ${Z - 4} ${X + 4} ${Y - 1} ${Z + 4} minecraft:stone`)
      await cmd(`/fill ${X - 4} ${Y} ${Z - 4} ${X + 4} ${Y + 14} ${Z + 4} minecraft:air`)
      if (web === 'в ногах') await cmd(`/setblock ${X} ${Y} ${Z} minecraft:cobweb`)
      if (web === 'у головы') await cmd(`/setblock ${X} ${Y + 1} ${Z} minecraft:cobweb`)
      await cmd('/item replace entity NeuroEnd weapon.offhand with minecraft:wind_charge 8')
      await cmd(`/tp NeuroEnd ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
      await sleep(1500)
      let vyBoom = null; let peak = bot.entity.position.y; const y0 = bot.entity.position.y
      const onBoom = () => { if (vyBoom == null) vyBoom = bot.entity.velocity.y }
      bot._client.on('explosion', onBoom)
      const onT = () => { if (bot.entity.position.y > peak) peak = bot.entity.position.y }
      bot.on('physicsTick', onT)
      const r = await mace.fireWind(bot, () => ({ yaw: bot.entity.yaw, pitch: -Math.PI / 2 }), { hand: 'off' })
      await sleep(1500)
      bot._client.removeListener('explosion', onBoom)
      bot.removeListener('physicsTick', onT)
      console.log(`[паутина: ${web}] бросок ${r.fired ? 'ушёл' : 'нет: ' + r.why}, vy после всплеска ${vyBoom == null ? '—' : vyBoom.toFixed(2)}, подъём ${(peak - y0).toFixed(2)} бл., webOnBody до броска: ${web !== 'нет'}`)
      await sleep(600)
    }
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    await cmd(`/forceload remove ${X - 6} ${Z - 6} ${X + 6} ${Z + 6}`).catch(() => {})
    bot.quit()
    gameClock.wall.setTimeout(() => process.exit(), 500)
  }
})()
