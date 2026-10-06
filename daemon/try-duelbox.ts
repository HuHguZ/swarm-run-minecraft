'use strict'
const gameClock = require('./src/game-clock')
const { createGameBot } = require('./scene-kit')
// Коробка в дуэли (2026-09-26, пользователь: «крепость бессмысленна — он её
// всё равно пробивает; надо, чтобы сопернику пришлось ломать киркой»).
// NeuroDown побит (10 хп), с обсидианом, булыжником и яблоками; NeuroDown2 с
// киркой начинает бой с DIST блоков. Оба дерутся. Зритель смотрит: встала ли
// коробка вокруг A, из чего, когда её вскрыли, и были ли попадания по A, пока
// коробка целая (сквозь блок — их быть не должно).
//   A=ws://127.0.0.1:88NN B=ws://127.0.0.1:89NN MC_PORT=256NN node try-duelbox.js   (только слот фермы NN, arms-guard; 25565/8791 — запрещено)
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
  const ready = new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}
const sleep = ms => gameClock.sleep(ms)
require('./arms-guard').farmOnly({ ws: [process.env.A, process.env.B], mc: [process.env.MC_PORT] })
const A = client(process.env.A)
const B = client(process.env.B)
async function cmd (text) { await A.call('say', { text }); await sleep(40) }
const X = 1000; const Y = 150; const Z = 1100
const SECONDS = Number(process.env.SECONDS || 45)
const DIST = Number(process.env.DIST || 18)

async function observer () {
  const ob = createGameBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT), username: 'Probe1', version: '1.21.11', auth: 'offline' })
  await new Promise<any>((resolve, reject) => { ob.once('spawn', resolve); ob.once('error', reject); ob.once('kicked', reject) })
  await sleep(4000)
  ob.chat('/gamemode spectator'); await sleep(300)
  ob.chat(`/tp Probe1 ${X + 0.5} ${Y + 14} ${Z + 0.5} 0 90`); await sleep(800)
  return ob
}
const solid = (ob, p) => { const b = ob.blockAt(p); return b && b.boundingBox === 'block' ? b.name : null }
function boxAround (ob, feet) {
  let walls = 0
  const mats: Record<string, any> = {} as Record<string, any>
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const a = solid(ob, feet.offset(dx, 0, dz))
    const b = solid(ob, feet.offset(dx, 1, dz))
    if (a && b) { walls++; mats[a] = (mats[a] || 0) + 1; mats[b] = (mats[b] || 0) + 1 }
  }
  const roof = solid(ob, feet.offset(0, 2, 0))
  if (roof) mats[roof] = (mats[roof] || 0) + 1
  return { walls, roof: !!roof, sealed: walls === 4 && !!roof, mats }
}

async function round (ob, k) {
  await cmd(`/fill ${X - 26} ${Y - 1} ${Z - 26} ${X + 26} ${Y - 1} ${Z + 26} minecraft:stone`)
  await cmd(`/fill ${X - 26} ${Y} ${Z - 26} ${X + 26} ${Y + 14} ${Z + 26} minecraft:air`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..40]`)
  for (const who of ['NeuroDown', 'NeuroDown2']) {
    await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`)
    await cmd(`/item replace entity ${who} armor.chest with minecraft:iron_chestplate`)
  }
  for (const it of ['diamond_sword', 'diamond_pickaxe', 'obsidian 16', 'cobblestone 64', 'golden_apple 3']) { const [n, c] = it.split(' '); await cmd(`/give NeuroDown minecraft:${n} ${c || 1}`) }
  for (const it of ['diamond_sword', 'diamond_pickaxe', 'cobblestone 32', 'golden_apple 1']) { const [n, c] = it.split(' '); await cmd(`/give NeuroDown2 minecraft:${n} ${c || 1}`) }
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z + DIST + 0.5} 180 0`)
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${who} minecraft:saturation 1 20 true`) }
  await sleep(1200)
  await cmd(`/damage NeuroDown ${Number(process.env.DMG || 10)} minecraft:generic`)
  await sleep(600)
  const t0 = gameClock.now()
  let hp = (((await A.call('status')) as any).state || {} as Record<string, any>).health ?? 20
  const ev: Record<string, any> = { built: 0, mats: null, breached: 0, hits: [], hpMax: hp, hpMin: hp }
  let polling = true
  const poll = (async () => {
    while (polling) {
      const e = ob.players.NeuroDown && ob.players.NeuroDown.entity
      let sealed = false
      if (e) {
        const bx = boxAround(ob, e.position.floored())
        sealed = bx.sealed
        if (sealed && !ev.built) { ev.built = gameClock.now() - t0; ev.mats = bx.mats }
        if (ev.built && !sealed && !ev.breached) ev.breached = gameClock.now() - t0
      }
      try {
        const h = (((await A.call('status')) as any).state || {} as Record<string, any>).health
        if (h != null && h < hp - 0.4) ev.hits.push({ t: gameClock.now() - t0, dmg: +(hp - h).toFixed(1), sealed })
        if (h != null) { hp = h; ev.hpMax = Math.max(ev.hpMax, h); ev.hpMin = Math.min(ev.hpMin, h) }
      } catch {}
      await sleep(100)
    }
  })()
  const fa = A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  const fb = B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  const [ra, rb] = await Promise.all([fa, fb])
  polling = false
  await poll
  await A.call('stop').catch(() => {}); await B.call('stop').catch(() => {})
  const pick = (r) => Object.entries<any>(((r && r.detail) || {} as Record<string, any>).tricks || {} as Record<string, any>).filter(([k]: any) => /коробк|стенк|киркой|дыр|латал|крепк|зелье в его|караул|лечусь|съел|выпил/.test(k)).map(([k, v]: any) => `${k}×${v}`).join(', ')
  const through = ev.hits.filter(h => h.sealed)
  const killed = (r) => ((r && r.detail) || {} as Record<string, any>).killed ? ' УБИЛ' : ''
  console.log(`[дуэль #${k}] A ${ra.status}${killed(ra)} / B ${rb.status}${killed(rb)} | коробка ${ev.built ? 'встала на ' + (ev.built / 1000).toFixed(1) + ' с ' + JSON.stringify(ev.mats) : 'не строилась'}${ev.breached ? ', вскрыта на ' + (ev.breached / 1000).toFixed(1) + ' с' : ''} | хп A мин ${ev.hpMin} макс ${ev.hpMax} | попаданий по A ${ev.hits.length}, сквозь целую коробку ${through.length}`)
  console.log(`   A: ${pick(ra) || '-'}`)
  console.log(`   B: ${pick(rb) || '-'}`)
  return through.length
}

;(async () => {
  let ob = null
  try {
    await A.ready; await B.ready
    await A.call('connect').catch(() => {}); await B.call('connect').catch(() => {})
    await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
    await cmd('/gamerule send_command_feedback false')
    await cmd('/difficulty peaceful')
    await cmd('/time set day')
    await cmd(`/forceload add ${X - 28} ${Z - 28} ${X + 28} ${Z + 28}`)
    await cmd('/op Probe1')
    ob = await observer()
    let through = 0
    const reps = Number(process.env.REPS || 2)
    for (let k = 1; k <= reps; k++) through += await round(ob, k)
    console.log(`ИТОГО: попаданий сквозь целую коробку ${through}`)
    await cmd(`/forceload remove ${X - 28} ${Z - 28} ${X + 28} ${Z + 28}`)
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    if (ob) try { ob.quit() } catch {}
    A.ws.close(); B.ws.close()
    gameClock.wall.setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
