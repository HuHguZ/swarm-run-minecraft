'use strict'
const gameClock = require('./src/game-clock')
// Короткие падения 7–9 блоков посреди боя (edges.installFallGuard, 2026-09-26):
// в арене со столба и с крыши коробки ведро «срабатывало», а воды не было —
// бой в те же тики менял предмет и взгляд. Здесь NeuroDown дерётся с
// NeuroDown2 на каменной площадке, хотбар полон (меч, булава, лук, блоки,
// яблоки), ведро воды в хотбаре; его поднимают на H блоков над полом рядом с
// противником, и он падает посреди боя. Итог: хп, была ли вода (блок воды под
// ним в миг посадки — по пакетам демона [mlg]) и забрал ли её.
//   A=ws://127.0.0.1:8785 B=ws://127.0.0.1:8786 node try-mlg-short.js [раз на высоту]
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
const A = client(process.env.A || 'ws://127.0.0.1:8785')
const B = client(process.env.B || 'ws://127.0.0.1:8786')
const cmd = async (text) => { await A.call('say', { text }); await sleep(120) }
const N = Number(process.argv[2] || 3)
const X = 300; const FLOOR = 150; const Z = 300

async function state (c) { const s = await c.call('status').catch(() => null); return s && s.state }

async function trial (h, mace) {
  await cmd('/clear NeuroDown')
  await cmd('/effect clear NeuroDown')
  const bar = ['diamond_sword', mace ? 'mace' : 'bow', 'cobblestone 64', 'golden_apple 4', 'ender_pearl 4', 'water_bucket', 'diamond_axe', 'arrow 32', 'cooked_beef 8']
  for (let i = 0; i < bar.length; i++) { const [n, c] = bar[i].split(' '); await A.call('say', { text: `/item replace entity NeuroDown hotbar.${i} with minecraft:${n} ${c || 1}` }) }
  for (const [s, it] of [['head', 'iron_helmet'], ['chest', 'iron_chestplate'], ['legs', 'iron_leggings'], ['feet', 'iron_boots']]) await cmd(`/item replace entity NeuroDown armor.${s} with minecraft:${it}`)
  await cmd('/effect give NeuroDown minecraft:instant_health 1 5 true')
  await cmd('/effect give NeuroDown2 minecraft:instant_health 1 5 true')
  await cmd(`/tp NeuroDown2 ${X + 2.5} ${FLOOR + 1} ${Z + 0.5}`)
  await cmd(`/tp NeuroDown ${X - 1.5} ${FLOOR + 1} ${Z + 0.5}`)
  await sleep(700)
  const fight = A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: 14, retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  await sleep(1800)
  const s0 = await state(A)
  const hp0 = s0 ? s0.health : null
  await cmd(`/tp NeuroDown ${X + 0.5} ${FLOOR + 1 + h} ${Z + 0.5}`)
  const t0 = gameClock.now()
  let landed = null
  while (gameClock.now() - t0 < 6000) {
    const s = await state(A)
    if (s && s.pos && !landed && s.pos.y < FLOOR + 2.2) landed = { at: gameClock.now() - t0, hp: s.health }
    if (landed && gameClock.now() - t0 > landed.at + 2200) break
    await sleep(100)
  }
  const s1 = await state(A)
  const hp1 = s1 ? s1.health : null
  await A.call('stop').catch(() => {})
  const r: any = await fight
  const inv = (s1 && s1.inventory) || {} as Record<string, any>
  const tricks = (r && r.detail && r.detail.tricks) || {} as Record<string, any>
  const mlg = Object.entries<any>(tricks).filter(([k]: any) => /MLG|вода под себя|булава/.test(k)).map(([k, v]: any) => `${k}×${v}`).join(', ')
  const lost = hp0 != null && hp1 != null ? Math.round((hp0 - hp1) * 10) / 10 : null
  console.log(`H=${h}${mace ? ' (булава в хотбаре)' : ''}: хп ${hp0} -> ${hp1} (−${lost}) | ведро воды ${inv.water_bucket ? 'в рюкзаке' : 'нет'}, пустое ${inv.bucket || 0} | ${mlg || 'MLG не было'}`)
  await sleep(600)
  return { lost, picked: !!inv.water_bucket }
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    await cmd('/gamerule fall_damage true')
    await cmd('/gamerule send_command_feedback false')
    // Площадка — в загруженных чанках (иначе /fill молча не ставит пол и падение — 45 бл.).
    await cmd(`/forceload add ${X - 10} ${Z - 10} ${X + 10} ${Z + 10}`)
    await cmd(`/tp NeuroDown ${X} ${FLOOR + 3} ${Z}`); await cmd(`/tp NeuroDown2 ${X + 2} ${FLOOR + 3} ${Z}`)
    await sleep(2500)
    await cmd(`/fill ${X - 8} ${FLOOR} ${Z - 8} ${X + 8} ${FLOOR} ${Z + 8} minecraft:stone`)
    await cmd(`/fill ${X - 8} ${FLOOR + 1} ${Z - 8} ${X + 8} ${FLOOR + 14} ${Z + 8} minecraft:air`)
    await cmd('/clear NeuroDown2')
    await cmd('/item replace entity NeuroDown2 hotbar.0 with minecraft:iron_sword')
    const res = []
    for (let i = 0; i < N; i++) for (const h of [7, 8, 9]) res.push({ h, ...(await trial(h, i % 2 === 1)) })
    const hurt = res.filter(r => r.lost > 0.5)
    console.log(`ИТОГ: ${res.length} падений 7–9 бл. посреди боя — урон в ${hurt.length} (${hurt.map(r => `H${r.h} −${r.lost}`).join(', ') || 'ни в одном'}), воду забрал ${res.filter(r => r.picked).length}/${res.length}`)
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    await cmd(`/forceload remove ${X - 10} ${Z - 10} ${X + 10} ${Z + 10}`).catch(() => {})
    await cmd('/gamerule send_command_feedback true').catch(() => {})
    A.ws.close(); B.ws.close()
  }
})()
