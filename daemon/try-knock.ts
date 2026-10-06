'use strict'
const gameClock = require('./src/game-clock')
// Замер отбрасывания против модели edges.js (та же формула LivingEntity.
// knockback и та же физика prismarine-physics). NeuroDown2 стоит на ровном
// камне, по нему /damage ... by NeuroDown из точки в 2 блоках — это толчок
// 0.4 от источника (LivingEntity.hurtServer). Сравниваем путь с моделью.
//   ND_WS=ws://127.0.0.1:8781 ND_WS2=ws://127.0.0.1:8782 node try-knock.js
const WebSocket = require('ws')
const Vec3 = require('vec3')

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

// Модель: плоский камень под y=100, тело стоит, толчок 0.4 по +x.
function model (strength, sprintExtra = 0) {
  const { Physics } = require('prismarine-physics')
  const mcData = require('minecraft-data')('1.21.11')
  const Block = require('prismarine-block')('1.21.11')
  const stone = mcData.blocksByName.stone.defaultState
  const air = mcData.blocksByName.air.defaultState
  const world = { getBlock: (p) => { const b = Block.fromStateId(p.y < 100 ? stone : air, 0); b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b } }
  const phys = Physics(mcData, world)
  const edges = require('./src/edges')
  let v = edges.knockback(new Vec3(0, -0.0784, 0), strength, -1, 0, true)
  if (sprintExtra) v = edges.knockback(v, sprintExtra, -1, 0, true)
  const st = {
    pos: new Vec3(0.5, 100, 0.5), vel: v, onGround: true, isInWater: false, isInLava: false, isInWeb: false,
    isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, jumpTicks: 0, jumpQueued: false,
    fireworkRocketDuration: 0, attributes: {} as Record<string, any>, yaw: 0, pitch: 0,
    control: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    jumpBoost: 0, speed: 0, slowness: 0, dolphinsGrace: 0, slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false
  }
  let flight = 0
  for (let t = 0; t < 60; t++) { phys.simulatePlayer(st, world); if (!st.onGround) flight++ }
  return { dx: st.pos.x - 0.5, air: flight }
}

;(async () => {
  const A = client(process.env.ND_WS || 'ws://127.0.0.1:8781')
  const B = client(process.env.ND_WS2 || 'ws://127.0.0.1:8782')
  try {
    const m1 = model(0.4)
    const m2 = model(0.4, 0.5)
    console.log(`модель: обычный удар 0.4 — ${m1.dx.toFixed(2)} бл. (в воздухе ${m1.air} тиков); со спринтом 0.4+0.5 — ${m2.dx.toFixed(2)} бл. (${m2.air} тиков)`)
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    const say = async (t) => { await A.call('say', { text: t }); await sleep(250) }
    const X = 100; const Y = 100; const Z = 100
    await say(`/fill ${X - 10} ${Y - 1} ${Z - 10} ${X + 10} ${Y - 1} ${Z + 10} minecraft:stone`)
    await say(`/fill ${X - 10} ${Y} ${Z - 10} ${X + 10} ${Y + 4} ${Z + 10} minecraft:air`)
    await say('/effect give NeuroDown2 minecraft:resistance 30 4 true')
    const runs = []
    for (let i = 0; i < 3; i++) {
      await say(`/tp NeuroDown2 ${X + 0.5} ${Y} ${Z + 0.5} 90 0`)
      await say(`/tp NeuroDown ${X - 1.5} ${Y} ${Z + 0.5} -90 0`)
      await sleep(1200)
      const s0 = ((await B.call('phys')) as any).detail.pos
      await say('/damage NeuroDown2 1 minecraft:player_attack by NeuroDown')
      await sleep(1500)
      const s1 = ((await B.call('phys')) as any).detail.pos
      runs.push(s1.x - s0.x)
      console.log(`замер ${i + 1}: сдвиг по x ${(s1.x - s0.x).toFixed(2)} (z ${(s1.z - s0.z).toFixed(2)})`)
    }
    const avg = runs.reduce((a, b) => a + b, 0) / runs.length
    console.log(`ИТОГ: обычный толчок — замер ${avg.toFixed(2)} бл., модель ${m1.dx.toFixed(2)} бл.`)
  } catch (e) {
    console.error('FAILED:', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
  }
})()
