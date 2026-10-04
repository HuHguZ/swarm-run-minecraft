'use strict'
// Человек в бою (showman.js, 2026-09-26) — две сцены на тестовом сервере.
//
//  swing  — замер: сбрасывает ли взмах в воздух (arm_animation, bot.swingArm)
//           заряд удара на сервере Paper 1.21.11. Два голых бота на mineflayer:
//           HmAtk бьёт HmDummy железным мечом (6 урона с полным зарядом) —
//           просто так, после трёх взмахов в воздух и (контроль) после смены
//           слота туда-обратно, которая заряд сбрасывает (Player.tick).
//           Естественная регенерация на замер выключена.
//  mirror — «человек» Vasya (скрипт) приседает и кивает NeuroDown'у, потом
//           подходит на край руки и машет мимо; NeuroDown дерётся с ним.
//           Зритель Petya в стороне пишет, что видел от NeuroDown: присед,
//           взмахи, кивки (качание головы вверх-вниз), всё с метками времени.
//
//   ARENA_A=ws://127.0.0.1:8785 MC_PORT=25568 node try-showman.js swing|mirror [повторов]
const WebSocket = require('ws')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')

function client (url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
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
const sleep = ms => new Promise(r => setTimeout(r, ms))
const A = client(process.env.ARENA_A || 'ws://127.0.0.1:8785')
const NA = 'NeuroDown'
const PORT = Number(process.env.MC_PORT || 25568)
const X = 60; const Y = 150; const Z = 60
const cmd = async (t) => { await A.call('say', { text: t }); await sleep(120) }
const MODE = process.argv[2] || 'mirror'
const N = Number(process.argv[3] || 3)

function join (username) {
  return new Promise((resolve, reject) => {
    const b = mineflayer.createBot({ host: '127.0.0.1', port: PORT, username, version: '1.21.11', auth: 'offline' })
    b.once('spawn', () => resolve(b))
    b.once('error', reject)
    b.once('kicked', r => reject(new Error('kicked ' + JSON.stringify(r))))
  })
}
const face = async (b, pos) => { try { await b.lookAt(pos, true) } catch {} }

async function platform () {
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} minecraft:stone`)
  await cmd(`/fill ${X - 12} ${Y} ${Z - 12} ${X + 12} ${Y + 5} ${Z + 12} minecraft:air`)
}

async function swing () {
  await A.ready
  await A.call('connect').catch(() => {})
  await platform()
  const atk = await join('HmAtk')
  const dum = await join('HmDummy')
  await sleep(1000)
  await cmd('/gamerule natural_regeneration false')
  for (const w of ['HmAtk', 'HmDummy']) { await cmd(`/clear ${w}`); await cmd(`/effect clear ${w}`); await cmd(`/gamemode survival ${w}`) }
  await cmd('/give HmAtk minecraft:iron_sword 1')
  await cmd(`/tp ${NA} ${X - 8} ${Y} ${Z - 8}`)
  const out = { full: [], afterAirSwings: [], afterSlotSwap: [] }
  const trial = async (kind) => {
    await cmd(`/tp HmDummy ${X + 0.5} ${Y} ${Z + 0.5} 90 0`)
    await cmd(`/tp HmAtk ${X - 1.5} ${Y} ${Z + 0.5} -90 0`)
    await cmd('/effect give HmDummy minecraft:instant_health 1 10 true')
    await sleep(1600) // заряд полный (12.5 тика), неуязвимость прошла
    const sword = atk.inventory.items().find(i => i.name === 'iron_sword')
    if (sword && (!atk.heldItem || atk.heldItem.name !== 'iron_sword')) { await atk.equip(sword, 'hand'); await sleep(1600) }
    await face(atk, dum.entity.position.offset(0, 1.2, 0))
    const hp0 = dum.health
    if (kind === 'afterAirSwings') { for (let i = 0; i < 3; i++) { atk.swingArm(); await sleep(60) } }
    if (kind === 'afterSlotSwap') { const s = atk.quickBarSlot; atk.setQuickBarSlot((s + 1) % 9); await sleep(60); atk.setQuickBarSlot(s); await sleep(60) }
    const target = atk.nearestEntity(e => e.username === 'HmDummy')
    atk.attack(target)
    await sleep(500)
    const dmg = Math.round((hp0 - dum.health) * 100) / 100
    out[kind].push(dmg)
    console.log(kind, 'hp', hp0, '->', dum.health, 'урон', dmg)
  }
  for (let i = 0; i < N; i++) {
    await trial('full')
    await trial('afterAirSwings')
    await trial('afterSlotSwap')
  }
  await cmd('/gamerule natural_regeneration true')
  console.log('ИТОГ', JSON.stringify(out))
  atk.quit(); dum.quit()
  process.exit(0)
}

// Качание головы наблюдаемого: сколько раз сменил направление с размахом
// ≥ 0.3 рад (как showman.readGestures).
function nodCounter () {
  let ext = null; let dir = 0; let n = 0
  return (v) => {
    if (ext === null) { ext = v; return n }
    const dv = v - ext
    if (dir >= 0 && dv <= -0.3) { dir = -1; ext = v; n++ } else if (dir <= 0 && dv >= 0.3) { dir = 1; ext = v; n++ } else if ((dir > 0 && v > ext) || (dir < 0 && v < ext)) ext = v
    return n
  }
}

async function mirror () {
  await A.ready
  await A.call('connect').catch(() => {})
  await platform()
  const vas = await join('Vasya')
  const pet = await join('Petya')
  await sleep(1000)
  for (const w of [NA, 'Vasya', 'Petya']) { await cmd(`/clear ${w}`); await cmd(`/effect clear ${w}`); await cmd(`/gamemode survival ${w}`) }
  for (const it of ['iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await cmd(`/give ${NA} minecraft:${it} 1`)
  await cmd(`/tp ${NA} ${X - 5.5} ${Y} ${Z + 0.5} -90 0`)
  await cmd(`/tp Vasya ${X + 3.5} ${Y} ${Z + 0.5} 90 0`)
  await cmd(`/tp Petya ${X - 1} ${Y} ${Z + 9} 180 0`)
  await sleep(900)
  await A.call('armor').catch(() => null)
  await cmd(`/effect give ${NA} minecraft:instant_health 1 10 true`)
  await cmd('/effect give Vasya minecraft:instant_health 1 10 true')
  await cmd('/effect give Vasya minecraft:resistance 60 3 true')
  await sleep(800)
  const nd = () => vas.players[NA] && vas.players[NA].entity
  const ndP = () => pet.players[NA] && pet.players[NA].entity
  const t0 = Date.now()
  const at = () => ((Date.now() - t0) / 1000).toFixed(2)
  const log = []
  const note = (who, what) => { const line = `${at()}с ${who}: ${what}`; log.push(line); console.log(line) }
  // Зритель: присед, взмахи, кивки NeuroDown.
  const pc = nodCounter()
  let nods = 0
  pet.on('entityCrouch', e => { if (e.username === NA) note('Petya видит', 'NeuroDown присел') })
  pet.on('entitySwingArm', e => { if (e.username === NA) note('Petya видит', 'NeuroDown взмахнул рукой') })
  const pitchTimer = setInterval(() => {
    const e = ndP()
    if (!e) return
    const n = pc(e.pitch || 0)
    if (n !== nods) { nods = n; if (n % 2 === 0) note('Petya видит', `NeuroDown качнул головой вверх-вниз (${n / 2})`) }
  }, 50)
  vas.on('death', () => note('Vasya', 'умер'))
  // Бой: NeuroDown против Vasya.
  const fight = A.call('fight', { target: 'Vasya', allowPlayer: true, timeoutSeconds: 35, retreatAtHealth: 3 }).catch(e => ({ status: 'failed', error: e.message }))
  let done = false
  fight.then(() => { done = true })
  // Vasya: сперва кивает ×3, потом присед ×3 — оба «привет», глядя на него.
  await sleep(300)
  if (nd()) {
    note('Vasya', 'кивает ×3')
    const p = nd().position.offset(0, 1.6, 0)
    const me = vas.entity.position.offset(0, 1.62, 0)
    const yaw = Math.atan2(-(p.x - me.x), -(p.z - me.z))
    for (let i = 0; i < 3; i++) { await vas.look(yaw, -0.6, true); await sleep(180); await vas.look(yaw, 0.05, true); await sleep(180) }
  }
  await sleep(900)
  if (nd()) await face(vas, nd().position.offset(0, 1.6, 0))
  note('Vasya', 'приседает ×3, глядя на NeuroDown')
  for (let i = 0; i < 3; i++) { vas.setControlState('sneak', true); await sleep(200); vas.setControlState('sneak', false); await sleep(200) }
  await sleep(1200)
  // Держит дистанцию 3.3–4.2 по земле и машет — клик мимо, как у человека,
  // который бьёт с края и не достаёт.
  note('Vasya', 'держит край руки и машет')
  let hp = vas.health
  const tWalk = Date.now()
  let swungAt = 0
  while (!done && Date.now() - tWalk < 16000 && vas.health > 0) {
    const e = nd()
    if (!e) break
    if (vas.health < hp - 0.01) note('Vasya', `получил урон ${(hp - vas.health).toFixed(2)}`)
    hp = vas.health
    await face(vas, e.position.offset(0, 1.6, 0))
    const eye = vas.entity.position.offset(0, 1.62, 0)
    const d = Math.hypot(e.position.x - eye.x, e.position.z - eye.z)
    vas.setControlState('forward', d > 4.2)
    vas.setControlState('back', d < 3.3)
    if (d >= 3.3 && d <= 4.2 && Date.now() - swungAt > 700) { vas.swingArm(); swungAt = Date.now(); note('Vasya', `машет мимо с ${d.toFixed(2)} бл. по земле`) }
    await sleep(50)
  }
  vas.setControlState('back', false)
  vas.setControlState('forward', false)
  const res = await fight
  await sleep(3500) // победный жест — рефлекс после боя
  clearInterval(pitchTimer)
  const d = res.detail || {}
  console.log('БОЙ:', res.status, d.killed ? 'убил ' + d.killed : d.lost || d.timeout || '', 'хп', d.hp)
  console.log('HUMAN:', JSON.stringify(d.human))
  console.log('ПРИЁМЫ:', JSON.stringify(d.tricks))
  console.log('ЛЕНТА:\n' + log.join('\n'))
  vas.quit(); pet.quit()
  process.exit(0)
}

;(MODE === 'swing' ? swing() : mirror()).catch(e => { console.error(e); process.exit(1) })
