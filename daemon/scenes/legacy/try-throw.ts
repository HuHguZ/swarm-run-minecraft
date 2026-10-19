'use strict'
import * as gameClock from '../../src/game-clock'
// Тир бросков: жемчуг и оседающие зелья в точки на полу — стоя, в стрейфе,
// на бегу, пятясь и в прыжке. Правда из игры: жемчуг переносит бота туда, где
// упал, оседающее зелье оставляет облако там, где разбилось. Сравнение
// прошлого прицела (old) с точной физикой (exact).
//   ND_WS=ws://127.0.0.1:8767 node try-throw.js [pearl|potion|all] [exact|old|both]
import WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8767')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})
ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => gameClock.sleep(ms)
async function cmd (text) { await call('say', { text }); await sleep(300) }

const X = -700; const Y = 100; const Z = -700
const WHAT = process.argv[2] || 'all'
const MODES = (process.argv[3] || 'both') === 'both' ? ['old', 'exact'] : [process.argv[3]]
// Разгон 0.9 с: бегом это ~5 блоков к цели, пятясь ~3.5 от неё.
const RUNUP = { still: 0, strafe: 0, jump: 0, run: 5, back: -3.5 }

async function setup () {
  await call('connect')
  await call('temper', { enabled: false })
  await cmd(`/tp @s ${X} ${Y + 2} ${Z}`)
  await sleep(1500)
  await cmd('/gamerule spawn_mobs false')
  await cmd(`/kill @e[type=!player,distance=..80]`)
  await cmd(`/fill ${X - 30} ${Y - 1} ${Z - 20} ${X + 30} ${Y - 1} ${Z + 45} minecraft:stone`)
  await cmd(`/fill ${X - 30} ${Y} ${Z - 20} ${X + 30} ${Y + 20} ${Z + 45} minecraft:air`)
  await cmd('/effect give @s minecraft:resistance 99999 4 true')
  await cmd('/effect give @s minecraft:saturation 99999 1 true')
}

async function one (item, dist, side, move, mode) {
  // Цель — точка на полу на dist вперёд (+z) и side вбок; бот стоит так,
  // чтобы к моменту броска до неё было около dist.
  const tx = X + side + 0.5; const tz = Z + dist + 0.5
  const back = RUNUP[move] || 0
  const len = Math.hypot(side, dist)
  const sx = X + 0.5 - side / len * back; const sz = Z + 0.5 - dist / len * back
  await cmd(`/tp @s ${sx.toFixed(2)} ${Y} ${sz.toFixed(2)} 0 0`)
  await cmd('/kill @e[type=area_effect_cloud]')
  await sleep(700)
  const r: any = await call('throw', { item, to: { x: tx, y: Y, z: tz }, move, mode }).catch(e => ({ error: e.message }))
  const d = r.detail || r
  return d
}

async function lane (item, label, cases, refill) {
  for (const mode of MODES) {
    await cmd('/clear @s')
    await refill()
    const errs = []
    const lines = []
    for (const [dist, side, move] of cases) {
      const d = await one(item, dist, side, move, mode)
      if (d.err != null) errs.push(d.err)
      lines.push(`${move} ${dist}${side ? '/' + side : ''}: ${d.err != null ? d.err.toFixed(2) : (d.why || d.error || 'не упал')}` +
        (d.modelErr != null ? ` (модель ${d.modelErr.toFixed(2)})` : ''))
      await sleep(item === 'ender_pearl' ? 1100 : 400)
    }
    const within1 = errs.filter(e => e <= 1).length
    const avg = errs.length ? (errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2) : '-'
    console.log(`\n=== ${label} [${mode}] средний промах ${avg} бл, в пределах 1 блока ${within1}/${cases.length}`)
    for (const l of lines) console.log('  ' + l)
  }
}

ws.on('open', async () => {
  try {
    await setup()
    const moves = ['still', 'strafe', 'run', 'back', 'jump']
    if (WHAT === 'pearl' || WHAT === 'all') {
      const cases = []
      for (const m of moves) for (const [d, s] of [[10, 0], [20, 0], [30, 0], [18, 10]]) cases.push([d, s, m])
      await lane('ender_pearl', 'жемчуг', cases, () => cmd('/give @s minecraft:ender_pearl 64'))
    }
    if (WHAT === 'potion' || WHAT === 'all') {
      const cases = []
      for (const m of moves) for (const [d, s] of [[4, 0], [7, 0], [9, 0], [6, 4]]) cases.push([d, s, m])
      await lane('lingering_potion', 'зелье', cases, () => cmd('/give @s minecraft:lingering_potion[potion_contents={potion:"minecraft:slowness"}] 24'))
    }
  } catch (e) {
    console.error('FAILED:', e.stack || e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
