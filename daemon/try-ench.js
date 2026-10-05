'use strict'
const gameClock = require('./src/game-clock')
// Чары 1.21.11 глазами тела (арена с чарами, 2026-09-26): видит ли бот чары
// выданного предмета и копает ли зачарованной киркой быстрее — по своей оценке
// и на сервере.
//
//   ND_WS=ws://127.0.0.1:8785 ND_WS2=ws://127.0.0.1:8786 node try-ench.js
//
// Первый демон — оп: выдаёт, ставит блоки и копает. Второй стоит рядом и
// смотрит на тот же блок: его мир — только то, что прислал сервер, так что
// «воздух» у него = сервер принял ломку. У копающего bot.dig кончается по
// своему предсказанию (mineflayer сам ставит воздух), правда — через паузу.
//
// Что сравнивается для каждого блока и инструмента:
//   est    — tools.digMs (чем тело выбирает инструмент), best — bestFor,
//   held   — bot.digTime тем, что в руке (столько mineflayer ждёт «докопал»),
//   dig    — bot.dig на деле: сколько шло и что стало с блоком у обоих;
//   force  — «докопал» ровно через N мс без своей оценки: простая кирка через
//            время «Эффективности V» сервером не принимается, зачарованная —
//            принимается (то есть чары считает и сервер).
// Ванильные числа (Player.getDestroySpeed, BlockState.getDestroyProgress):
// обсидиан алмазной киркой 9.4 с, с «Эффективностью V» (+26 скорости) 2.25 с;
// булыжник 0.4 с и 0.1 с; паутина мечом 0.4 с, рукой 20 с.
const WebSocket = require('ws')

// Both bots share server ticks; keep the first connection as the time source.
let clockSource = null
function client (url) {
  clockSource ??= url
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString()); if (url === clockSource) gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}

const A = client(process.env.ND_WS || 'ws://127.0.0.1:8785')
const B = client(process.env.ND_WS2 || 'ws://127.0.0.1:8786')
const sleep = ms => gameClock.sleep(ms)
const cmd = async (text) => { await A.call('say', { text }); await sleep(250) }
// Место проверки — в стороне от арены (200 100 200, R 15).
const X = Number(process.env.T_X || 260); const Y = Number(process.env.T_Y || 100); const Z = Number(process.env.T_Z || 200)
const at = { x: X + 1, y: Y, z: Z }

async function setBlock (name) {
  await cmd(`/setblock ${at.x} ${at.y} ${at.z} minecraft:${name}`)
  await sleep(500)
}
async function give (items) {
  await cmd('/clear NeuroDown')
  await cmd('/item replace entity NeuroDown armor.head with minecraft:diamond_helmet')
  for (const it of items) await cmd(`/give NeuroDown ${it} 1`)
  await sleep(700)
}
const seen = async () => { const r = await B.call('dig_time', at).catch(e => ({ detail: { block: 'ошибка ' + e.message } })); return r.detail ? r.detail.block : r.error }

async function probe (label, blockName, hold, extra = {}) {
  await setBlock(blockName)
  const est = await A.call('dig_time', { ...at, hold }).catch(e => ({ error: e.message }))
  const d = est.detail || {}
  const byItem = (d.by || []).map(x => `${x.item}=${x.ms}`).join(' ')
  const line = [`${label} | ${blockName}: est[${byItem}] best=${d.best ? d.best.item + ' ' + d.best.ms : '?'} held(${d.held})=${d.heldMs}`]
  const r = await A.call('dig_time', { ...at, hold, dig: !extra.ms, ...extra, settleMs: 900 }).catch(e => ({ error: e.message }))
  const rd = r.detail || { digError: r.error }
  const other = await seen()
  if (extra.ms) line.push(`force ${extra.ms} мс → у копающего ${rd.after}, у соседа ${other}`)
  else line.push(`dig ${rd.digMs} мс${rd.digError ? ' ОШИБКА ' + rd.digError : ''} (в руке после: ${rd.heldAfter}) → у копающего ${rd.after}, у соседа ${other}`)
  console.log(line.join('\n    '))
  return { est: d, dig: rd, other }
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
    await cmd('/gamerule send_command_feedback false')
    await cmd(`/tp NeuroDown ${X} ${Y + 1} ${Z}`)
    await sleep(1200)
    await cmd(`/fill ${X - 3} ${Y - 1} ${Z - 4} ${X + 4} ${Y - 1} ${Z + 4} minecraft:smooth_stone`)
    await cmd(`/fill ${X - 3} ${Y} ${Z - 4} ${X + 4} ${Y + 3} ${Z + 4} minecraft:air`)
    await cmd(`/tp NeuroDown ${X}.5 ${Y} ${Z}.5 -90 20`)
    await cmd(`/tp NeuroDown2 ${X}.5 ${Y} ${Z + 3}.5 180 20`)
    await sleep(1500)

    // 1. Что бот видит в выданном предмете.
    await give(['diamond_pickaxe[enchantments={efficiency:5}]', 'diamond_sword[enchantments={sharpness:3,fire_aspect:1}]'])
    const st = await A.call('status', { enchants: true })
    console.log('status enchants:', JSON.stringify(st.detail && st.detail.enchants))

    // 2. Зачарованная кирка и меч.
    await probe('кирка эфф.V', 'obsidian', 'diamond_pickaxe')
    await probe('кирка эфф.V', 'cobblestone', 'diamond_pickaxe')
    await probe('меч остр.III', 'cobweb', 'diamond_sword')
    // Контроль: «докопал» через 2.4 с зачарованной — сервер должен принять.
    await probe('кирка эфф.V', 'obsidian', 'diamond_pickaxe', { ms: 2400 })

    // 3. Простые — для сравнения; и простая кирка через время эфф.V — не примет.
    await give(['diamond_pickaxe', 'diamond_sword'])
    await probe('кирка простая', 'obsidian', 'diamond_pickaxe')
    await probe('кирка простая', 'cobblestone', 'diamond_pickaxe')
    await probe('меч простой', 'cobweb', 'diamond_sword')
    await probe('кирка простая', 'obsidian', 'diamond_pickaxe', { ms: 2400 })
    await setBlock('air')
  } catch (e) {
    console.log('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
  }
})()
