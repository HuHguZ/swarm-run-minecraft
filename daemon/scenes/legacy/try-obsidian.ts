'use strict'
import * as gameClock from '../../src/game-clock'
// Ведро и обсидиан (src/obsidian.js): набрать воду, залить лаву, добыть
// обсидиан алмазной киркой — то, без чего честный портал в Ад не построить.
//
// Сцена на своей площадке x=1700: каменная плита, в ней лужа лавы 3x3 глубиной
// 1 (под ней камень — дроп не сгорит), лужа 2x2 глубиной 2 (под верхним слоем
// лава — такой обсидиан ломать нельзя) и один источник воды в стороне.
import WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
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
async function cmd (text) { await call('say', { text }); await sleep(450) }

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

const X = 1700
const Y = 100
const Z = 1600

async function inv () {
  const s: any = await call('status')
  return (s.state && s.state.inventory) || {} as Record<string, any>
}

async function arena () {
  await cmd(`/tp @s ${X + 0.5} ${Y + 2} ${Z + 0.5}`)
  await cmd('/effect give @s minecraft:slow_falling 5 0 true')
  await sleep(2500)
  await cmd(`/fill ${X - 10} ${Y - 4} ${Z - 10} ${X + 10} ${Y - 1} ${Z + 10} minecraft:stone`)
  await cmd(`/fill ${X - 10} ${Y} ${Z - 10} ${X + 10} ${Y + 6} ${Z + 10} minecraft:air`)
  // Лужа 3x3, глубина 1: лава на Y-1, под ней камень.
  await cmd(`/fill ${X + 3} ${Y - 1} ${Z - 1} ${X + 5} ${Y - 1} ${Z + 1} minecraft:lava`)
  // Лужа 2x2, глубина 2: лава на Y-1 и Y-2.
  await cmd(`/fill ${X - 5} ${Y - 2} ${Z + 4} ${X - 4} ${Y - 1} ${Z + 5} minecraft:lava`)
  // Источник воды в ямке.
  await cmd(`/setblock ${X - 4} ${Y - 1} ${Z - 4} minecraft:water`)
  await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5}`)
  await sleep(1500)
}

async function main () {
  await new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  try { await call('connect') } catch (e) { console.log('connect:', e.message) }
  await sleep(2000)
  await cmd('/difficulty peaceful')

  console.log('сцена: плита, лава 3x3 (мелкая), лава 2x2 (глубокая), источник воды')
  await arena()

  // (а) Без алмазной кирки — отказ до всякого дела, с need.
  await cmd('/clear @s')
  await cmd('/give @s minecraft:iron_pickaxe')
  await cmd('/give @s minecraft:bucket')
  {
    const r: any = await call('obsidian', { count: 4, timeoutSeconds: 60 })
    const d = r.detail || {} as Record<string, any>
    check('(а) без алмазной кирки — need diamond_pickaxe', d.need && d.need.what === 'diamond_pickaxe', d.stopped || r.error)
  }

  // (б) Набрать воду пустым ведром.
  {
    const r: any = await call('bucket', { fluid: 'water' })
    const i = await inv()
    check('(б) ведро воды набрано', (i.water_bucket || 0) >= 1, JSON.stringify(r.detail || r.error))
  }

  // (в) Обсидиан из лужи 3x3.
  await cmd('/give @s minecraft:diamond_pickaxe')
  {
    const t0 = gameClock.now()
    const r: any = await call('obsidian', { count: 6, timeoutSeconds: 240 })
    const d = r.detail || {} as Record<string, any>
    const i = await inv()
    check('(в) 6 обсидиана из мелкой лужи', (i.obsidian || 0) >= 6,
      `за ${Math.round((gameClock.now() - t0) / 1000)} с: got ${d.got}, poured ${d.poured}, stopped ${d.stopped || '-'}, skipped ${JSON.stringify(d.skipped || {} as Record<string, any>)}`)
    check('(в) ведро воды вернулось в рюкзак', (i.water_bucket || 0) >= 1, JSON.stringify(i))
  }

  // (г) Глубокая лужа: верхний слой над лавой не ломает.
  {
    await cmd('/clear @s minecraft:obsidian')
    const r: any = await call('obsidian', { count: 4, timeoutSeconds: 120 })
    const d = r.detail || {} as Record<string, any>
    const skippedLava = d.skipped && Object.keys(d.skipped).some(k => /лава/.test(k))
    check('(г) обсидиан над лавой пропущен', skippedLava || (d.got || 0) === 0 || !!d.stopped,
      `got ${d.got}, skipped ${JSON.stringify(d.skipped || {} as Record<string, any>)}, stopped ${d.stopped || '-'}`)
  }

  await cmd('/difficulty normal')
  console.log(failures ? `\nПЛОХО: ${failures}` : '\nвсё зелёное')
  ws.close()
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('сцена упала:', e); process.exit(2) })
