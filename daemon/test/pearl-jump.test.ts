'use strict'
// Жемчуг в прыжке (06.10): дальность, точка переноса против прогона модели, отказ у края/лавы/потолка.
// Тело — настоящая prismarine-physics (как у бота), «сервер» — сдвиг последнего пакета движения
// (getKnownMovement; вертикаль — только при onGround = false) и полёт жемчуга pearl-hop.simulate.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const { Physics, PlayerState } = require('prismarine-physics')
const mcData = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')('1.21.11')
const T = require('../src/throw')
const hop = require('../src/pearl-hop')

const K = T.KINDS.ender_pearl
const physics = Physics(mcData, null)
const IDLE = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

// Ровный камень с верхом y = 64; extra — Map 'x,y,z' -> имя блока.
function grid (extra = new Map()) {
  const cache = new Map()
  return (x, y, z) => {
    const key = `${x},${y},${z}`
    if (cache.has(key)) return cache.get(key)
    const name = extra.get(key) ?? (y < 64 ? 'stone' : 'air')
    const b = Block.fromStateId(mcData.blocksByName[name].defaultState, 0)
    b.position = new Vec3(x, y, z)
    cache.set(key, b)
    return b
  }
}

// Бот на prismarine-physics: тик = симуляция → physicsTick → «пакет движения» (сдвиг и onGround) → ndMovementSent.
function physBot (world = grid()) {
  const item = { name: 'ender_pearl', type: 1, slot: 36, count: 16 }
  const control = { ...IDLE }
  const bot: any = new EventEmitter()
  Object.assign(bot, {
    version: '1.21.11', registry: mcData, food: 20, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    inventory: { slots: [], items: () => [item] }, heldItem: item,
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, -0.0784, 0), onGround: true, height: 1.8,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: true,
      elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    setControlState: (k, v) => { control[k] = v },
    getControlState: k => control[k],
    blockAt: p => world(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    equip: async () => {},
    world: { raycast: (p, dir, len) => {
      // Только ровный пол y = 64 (верх камня) — как в grid() без extra.
      if (dir.y >= 0 || p.y + dir.y * len > 64) return null
      const t = (p.y - 64) / -dir.y
      const at = p.plus(dir.scaled(t))
      return { position: new Vec3(Math.floor(at.x), 63, Math.floor(at.z)), intersect: at, boundingBox: 'block', name: 'stone' }
    } }
  })
  const sent = { pos: bot.entity.position.clone(), moved: new Vec3(0, 0, 0), onGround: true }
  bot.uses = []
  bot.activateItem = () => bot.uses.push({ pos: bot.entity.position.clone(), yaw: bot.entity.yaw, pitch: bot.entity.pitch,
    known: sent.moved.clone(), onGround: sent.onGround })
  const getBlock = p => bot.blockAt(p)
  bot.tick = () => {
    physics.simulatePlayer(new PlayerState(bot, control), { getBlock }).apply(bot)
    bot.emit('physicsTick')
    sent.moved = bot.entity.position.minus(sent.pos); sent.pos = bot.entity.position.clone(); sent.onGround = bot.entity.onGround
    bot.emit('ndMovementSent')
  }
  return bot
}

async function drive (bot, work) {
  let live = true
  const loop = setInterval(() => { if (live) bot.tick() }, 1)
  try { return await work } finally { live = false; clearInterval(loop) }
}

// Сервер 1.21.11: жемчуг из глаз − 0.1, скорость взгляда × 1.5 + известный сдвиг (вертикаль — не на земле).
function serverTp (use, world = grid()) {
  const from = { x: use.pos.x, y: use.pos.y + 1.52, z: use.pos.z }
  const v = hop.velOf(use.yaw, use.pitch, { x: use.known.x, y: use.onGround ? 0 : use.known.y, z: use.known.z })
  const w = (x, y, z) => world(x, y, z)
  return hop.simulate(w, from, v).tp
}

test('дальность: прыжок на месте и с разбега дальше, чем с места (ровно, ±10 бл.)', () => {
  for (const dy of [-10, 0, 10]) {
    const still = hop.reach(dy - 1.52)
    const stand = hop.reach(dy - 1.52 - T.JUMP_VY, 'stand')
    const run = hop.reach(dy - 1.52 - T.JUMP_VY, 'run')
    assert.ok(stand > still + 8, `dy ${dy}: прыжок ${stand} против ${still}`)
    assert.ok(run > stand + 15, `dy ${dy}: разбег ${run} против ${stand}`)
  }
})

test('сдвиг тика отрыва в модели = прогон тела prismarine-physics', () => {
  for (const kind of ['stand', 'run']) {
    const bot = physBot()
    const ctl = { ...IDLE, forward: kind === 'run', sprint: kind === 'run' }
    const st = new PlayerState(bot, ctl)
    const feet = st.pos.clone()
    for (let t = 0; t < (kind === 'run' ? T.RUN_TICKS : 0); t++) physics.simulatePlayer(st, { getBlock: p => bot.blockAt(p) })
    const before = st.pos.clone()
    st.control.jump = true
    physics.simulatePlayer(st, { getBlock: p => bot.blockAt(p) })
    const moved = st.pos.minus(before)
    // yaw 0 у prismarine — взгляд на −z.
    const L = T.jumpLaunch(feet, kind, { x: 0, z: -1 })
    assert.equal(st.onGround, false)
    assert.ok(Math.abs(moved.y - L.moved.y) < 1e-6 && Math.abs(moved.z - L.moved.z) < 1e-3, `${kind}: ${moved} против ${JSON.stringify(L.moved)}`)
    assert.ok(Math.abs(st.pos.z - L.from.z) < 1e-3 && Math.abs(st.pos.y + 1.52 - L.from.y) < 1e-6, `${kind}: вылет`)
  }
})

test('throwAt в прыжке: бросок на тике отрыва, точка переноса = прогон сервера, цель за дальностью с места', async () => {
  for (const [dist, sprint, kind] of [[58, false, 'stand'], [82, true, 'run']] as const) {
    const target = new Vec3(0.5, 64, 0.5 - dist)
    const still = physBot()
    const r0 = await drive(still, T.throwAt(still, target, {}))
    assert.equal(r0.thrown, false, `${dist} бл. с места не долетает`)
    const bot = physBot()
    const r = await drive(bot, T.throwAt(bot, target, { jump: 'auto', sprint }))
    assert.equal(r.thrown, true, JSON.stringify(r))
    assert.equal(r.jump, kind)
    assert.equal(bot.uses.length, 1)
    const use = bot.uses[0]
    assert.equal(use.onGround, false, 'пакет броска — в воздухе')
    assert.ok(Math.abs(use.known.y - 0.42) < 1e-6, `вертикаль ${use.known.y}`)
    if (kind === 'run') assert.ok(Math.abs(Math.hypot(use.known.x, use.known.z) - T.RUN_H) < 0.01, `разбег ${use.known}`)
    const tp = serverTp(use)
    assert.ok(tp, 'сервер: жемчуг упал')
    assert.ok(Math.hypot(tp.x - r.land.x, tp.y - r.land.y, tp.z - r.land.z) < 0.02, `прогноз ${JSON.stringify(r.land)} против сервера ${JSON.stringify(tp)}`)
    assert.ok(Math.hypot(tp.x - target.x, tp.z - target.z) < 2, `перенос в ${JSON.stringify(tp)}, цель ${target}`)
    for (const c of ['forward', 'sprint', 'jump']) assert.equal(bot.getControlState(c), false, `клавиша ${c} отпущена`)
  }
})

test('auto: у края, у лавы и под потолком не прыгает; цель в дальности с места — без прыжка', () => {
  const far = new Vec3(0.5, 64, -60)
  const choose = (extra, target = far, sprint = false) => {
    const bot = physBot(grid(extra))
    return T.jumpChoice(bot, target, K, { jump: 'auto', sprint })
  }
  assert.equal(choose(new Map())?.kind, 'stand')
  assert.equal(choose(new Map(), new Vec3(0.5, 64, -30)), null, 'долетает и так')
  const edge = new Map(); for (let y = 54; y < 64; y++) edge.set(`1,${y},0`, 'air')
  assert.equal(choose(edge), null, 'край')
  assert.equal(choose(new Map([['-1,64,0', 'lava']])), null, 'лава рядом')
  assert.equal(choose(new Map([['0,66,0', 'stone']])), null, 'потолок')
  // Разбег: лава на полосе разбега — только прыжок на месте (если долетает) или ничего.
  const lane = new Map([['0,63,-3', 'lava']])
  assert.equal(choose(lane, new Vec3(0.5, 64, -82), true), null)
  assert.equal(choose(new Map(), new Vec3(0.5, 64, -82), true)?.kind, 'run')
})

test('planHop: прыжок расширяет выбор посадок, точка переноса — из точки вылета прыжка', () => {
  const w = (x, y, z) => grid()(x, y, z)
  const feet = new Vec3(0.5, 64, 0.5)
  const goal = new Vec3(0.5, 64, -150)
  const p0 = hop.planHop(w, feet, goal, { lateral: [0] }).plan
  const p1 = hop.planHop(w, feet, goal, { lateral: [0], jump: 'stand' }).plan
  const p2 = hop.planHop(w, feet, goal, { lateral: [0], jump: 'run' }).plan
  assert.ok(p0 && p1 && p2)
  assert.equal(p0.jump, null)
  assert.ok(p1.rem < p0.rem - 8 && p1.jump === 'stand', `прыжок ${p1.rem} против ${p0.rem}`)
  assert.ok(p2.rem < p1.rem - 15 && p2.jump === 'run', `разбег ${p2.rem} против ${p1.rem}`)
  // Точка переноса плана = полёт из точки вылета модели прыжка с её сдвигом.
  const J = T.jumpLaunch(feet, 'run', { x: 0, z: -1 })
  const tp = hop.simulate(w, J.from, hop.velOf(p2.yaw, p2.pitch, J.moved)).tp
  assert.ok(Math.hypot(tp.x - p2.tp.x, tp.y - p2.tp.y, tp.z - p2.tp.z) < 1e-9)
})
