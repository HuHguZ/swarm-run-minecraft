'use strict'
// Око эндера из стержней и жемчуга — тем же mc_craft, что и всё остальное.
// Ложь, которую ловит сцена: «скрафтил 6» при пустом рюкзаке. mineflayer 4.37.1
// на 1.21.11 при нескольких заходах бесформенного рецепта из разных предметов
// (ender_eye: порошок + жемчуг) «забирал» результат только у себя: ответ
// «missing ingredient», порошок и жемчуг застряли в сетке 2x2, оков 0 (прогон
// 2026-09-25). actions.js craftWithNudge теперь крафтит такие по одному и ждёт
// результат в рюкзаке.
//
// [ OK ] 3 стержня → blaze_powder ×6 (рецепт даёт 2 с одного);
// [ OK ] 6 порошка + 6 жемчуга → ender_eye ×6, в рюкзаке ровно 6 оков и ни
//        порошка, ни жемчуга не осталось (ничего не застряло в сетке).
//
// Запуск: node try-eyes.js (демон NeuroNether на 8772).
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8772'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const inv = async () => (((await call('status')) || {} as Record<string, any>).state || {} as Record<string, any>).inventory || {} as Record<string, any>

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  try {
    await kit.cmd('/clear @s')
    await kit.cmd('/give @s minecraft:blaze_rod 3')
    await kit.cmd('/give @s minecraft:ender_pearl 6')
    await sleep(800)
    const a = await call('craft', { item: 'blaze_powder', count: 6 })
    const i1 = await inv()
    check('3 стержня → blaze_powder ×6', a.status === 'done' && i1.blaze_powder === 6 && !i1.blaze_rod, `${a.status} ${a.error || ''} ${JSON.stringify(i1)}`)
    const b = await call('craft', { item: 'ender_eye', count: 6 })
    await sleep(500)
    const i2 = await inv()
    check('ender_eye ×6 и ничего не застряло в сетке', b.status === 'done' && i2.ender_eye === 6 && !i2.blaze_powder && !i2.ender_pearl, `${b.status} ${b.error || ''} ${JSON.stringify(i2)}`)
  } catch (e) {
    failures++
    console.log('   [ПЛОХО] сцена оборвалась:', e.message)
  } finally {
    console.log(failures ? `\nИТОГ: ПЛОХО — ${failures}` : '\nИТОГ: всё зелёное')
    if (failures) process.exitCode = 1
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
