'use strict'
const gameClock = require('./src/game-clock')
const { createGameBot } = require('./scene-kit')
// Честный спринт (itemuse.js, 2026-09-26): скорость и пакеты спринта при
// зажатом спринте без «вперёд» — вбок, назад, вперёд+назад — у голого
// mineflayer и с правилом клиента (LocalPlayer.aiStep: canStartSprinting /
// shouldStopRunSprinting — нужен «вперёд»). Один клиент NeuroEnd (оп на end).
//   MC_PORT=25568 node try-sprintfair.js
const itemuse = require('./src/itemuse')

const PORT = Number(process.env.MC_PORT || 25568)
const sleep = ms => gameClock.sleep(ms)
const X = 500; const Y = 150; const Z = 500
const ticks = (bot, n) => new Promise<void>(resolve => { let k = 0; const f = () => { if (++k >= n) { bot.removeListener('physicsTick', f); resolve() } }; bot.on('physicsTick', f) })

;(async () => {
  const bot = createGameBot({ host: '127.0.0.1', port: PORT, username: 'NeuroEnd', version: '1.21.11', auth: 'offline' }, { primary: true })
  await new Promise<any>((resolve, reject) => { bot.once('spawn', resolve); bot.once('error', reject) })
  const cmd = async (t) => { bot.chat(t); await sleep(150) }
  let starts = 0; let stops = 0
  const w0 = bot._client.write
  bot._client.write = function (name, p) {
    if (name === 'entity_action' && p) { if (p.actionId === 'start_sprinting' || p.actionId === 3) starts++; else if (p.actionId === 'stop_sprinting' || p.actionId === 4) stops++ }
    return w0.apply(this, arguments)
  }
  try {
    await cmd(`/fill ${X - 20} ${Y - 1} ${Z - 20} ${X + 20} ${Y - 1} ${Z + 20} minecraft:stone`)
    await cmd(`/fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y + 3} ${Z + 20} minecraft:air`)
    await cmd('/effect clear NeuroEnd'); await cmd('/gamemode survival NeuroEnd')
    await cmd('/effect give NeuroEnd minecraft:saturation 30 5 true')
    const run = async (label: any, keys: any, jump: any = false) => {
      await cmd(`/tp NeuroEnd ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
      await sleep(600)
      bot.clearControlStates()
      await bot.look(Math.PI, 0, true)
      await ticks(bot, 3)
      starts = 0; stops = 0
      for (const k of keys) bot.setControlState(k, true)
      bot.setControlState('sprint', true)
      if (jump) bot.setControlState('jump', true)
      await ticks(bot, 10)
      const p0 = bot.entity.position.clone()
      await ticks(bot, 20)
      const v = Math.hypot(bot.entity.position.x - p0.x, bot.entity.position.z - p0.z) / 20
      const sprintNow = bot.getControlState('sprint')
      bot.clearControlStates()
      await ticks(bot, 10)
      return `${label}: ${v.toFixed(3)} б/т, спринт ${sprintNow ? 'да' : 'нет'}, START ${starts} STOP ${stops}`
    }
    const cases = [['вперёд', ['forward']], ['вбок', ['left']], ['назад', ['back']], ['вперёд+назад', ['forward', 'back']], ['вперёд+вбок', ['forward', 'left']], ['вбок с прыжками', ['left'], true]]
    const res = { голый: [], честный: [] }
    for (const [label, keys, jump] of cases) res['голый'].push(await run(label, keys, jump))
    itemuse.install(bot)
    await ticks(bot, 5)
    for (const [label, keys, jump] of cases) res['честный'].push(await run(label, keys, jump))
    for (const [k, v] of Object.entries<any>(res)) { console.log(`[${k}]`); for (const l of v) console.log('  ' + l) }
    console.log('itemuse:', JSON.stringify(bot._ndUse.stats))
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    bot.quit()
    gameClock.wall.setTimeout(() => process.exit(), 500)
  }
})()
