'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { voidBelow } = require('../src/dragon/dig-down-to')
const { scalePathBudget } = require('../src/dragon/dragon')

test('750 TPS: бюджет A* в игровом времени на бой, после боя — прежний', () => {
  const bot: any = { pathfinder: { tickTimeout: 40, thinkTimeout: 5000 } }
  const undo = scalePathBudget(bot, 750)
  assert.ok(bot.pathfinder.tickTimeout >= 1 && bot.pathfinder.tickTimeout < 1.1, `срез ${bot.pathfinder.tickTimeout}`)
  assert.equal(bot.pathfinder.thinkTimeout, 500)
  undo()
  assert.deepEqual(bot.pathfinder, { tickTimeout: 40, thinkTimeout: 5000 })
  const at20 = scalePathBudget(bot, 20); at20()
  assert.deepEqual(bot.pathfinder, { tickTimeout: 40, thinkTimeout: 5000 })
})

test('voidBelow по номерам состояний совпадает с blockAt и не строит Block', () => {
  // столб: камень на y 40, воздух выше; колонна x=1 пустая
  const solid = new Set(['0,40,0'])
  const registry = { blocksByStateId: { 0: { name: 'air', boundingBox: 'empty' }, 1: { name: 'end_stone', boundingBox: 'block' } } }
  let built = 0
  const world = { getColumnAt: () => ({}), getBlockStateId: (p) => solid.has(`${p.x},${p.y},${p.z}`) ? 1 : 0 }
  const fast: any = { registry, world, blockAt: () => { built++; return null } }
  const slow: any = { blockAt: (p) => ({ name: solid.has(`${p.x},${p.y},${p.z}`) ? 'end_stone' : 'air', boundingBox: solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' }) }
  for (const [x, y, d] of [[0.5, 50, 64], [0.5, 50, 5], [1.5, 50, 64], [0.5, 41, 1], [0.5, 40, 3]]) {
    assert.equal(voidBelow(fast, x, y, 0.5, d), voidBelow(slow, x, y, 0.5, d), `${x},${y},${d}`)
  }
  assert.equal(built, 0)
  assert.equal(voidBelow(fast, 0.5, 50, 0.5, 64), false)
  assert.equal(voidBelow(fast, 1.5, 50, 0.5, 64), true)
})

test('щелчок кровати: +1 тик на 20 TPS, 0 на 750, ND_CLICK_LEAD переопределяет', () => {
  const { clickLead } = require('../src/dragon/pillar-run')
  const was = process.env.ND_CLICK_LEAD
  delete process.env.ND_CLICK_LEAD
  try {
    assert.equal(clickLead(20), 1)
    assert.equal(clickLead(750), 0)
    process.env.ND_CLICK_LEAD = '1'
    assert.equal(clickLead(750), 1)
  } finally { if (was == null) delete process.env.ND_CLICK_LEAD; else process.env.ND_CLICK_LEAD = was }
})

test('пакеты дракона пачками: тики — по пути, миг — по пакету без задержки разбора (750); на 20 — отметка как есть', () => {
  const { feedTicks } = require('../src/dragon/pillar-run')
  const gameClock = require('../src/game-clock')
  const c = new gameClock.GameClock({ manual: true }); c.setState({ tick_rate: 750 }); gameClock.activate(c)
  try {
  // настоящие пакеты — раз в 3 тика (150 мс), скорость 0.8 бл/тик; разбор: первый вовремя, дальше пачками по 2–3
  const stamps = [0, 300, 300, 450, 900, 900, 900, 1050]
  const list = []
  stamps.forEach((t, i) => { const r: any = { id: 7, t, x: i * 2.4, y: 70, z: 0, vx: 0.8, vy: 0, vz: 0 }; feedTicks(list, r); list.push(r) })
  assert.deepEqual(list.map(r => r.tick), [0, 3, 6, 9, 12, 15, 18, 21])
  assert.deepEqual(list.map(r => r.tt), list.map(r => r.tick * 50))
  // без скорости — по отметкам, как раньше
  const l2 = []
  for (const t of [0, 150, 300]) { const r: any = { id: 1, t, x: 0, y: 0, z: 0, vx: null }; feedTicks(l2, r); l2.push(r) }
  assert.deepEqual(l2.map(r => r.tick), [0, 3, 6])
  c.setState({ tick_rate: 20 })
  const l3 = []
  ;[0, 300, 300].forEach((t, i) => { const r: any = { id: 3, t, x: i * 2.4, y: 70, z: 0, vx: 0.8, vy: 0, vz: 0 }; feedTicks(l3, r); l3.push(r) })
  assert.deepEqual(l3.map(r => r.tt), [0, 300, 300])
  } finally { c.dispose(); gameClock.activate(null) }
})

test('щелчок кровати по ровным часам: не раньше untilMono, без игрового until', async () => {
  const gameClock = require('../src/game-clock')
  const Vec3 = require('vec3')
  const { clickBedAt } = require('../src/dragon/pillar-plan')
  let at = null
  const bot: any = { setControlState () {}, swingArm () {}, _client: { write: (name) => { if (name === 'block_place' && at == null) at = gameClock.wall.monotonic() } } }
  const hit = { point: new Vec3(0.5, 0.5625, 0.5), block: { position: new Vec3(0, 0, 0) } }
  const want = gameClock.wall.monotonic() + 8
  const seq = await clickBedAt(bot, hit, { aimed: true, untilMono: want })
  assert.ok(at != null && at >= want, `щелчок ${at} раньше ${want}`)
  assert.ok(at - want < 20, `опоздал на ${at - want} мс`)
  assert.ok(seq > 0)
})

// Мир слота фермы для окна точности (precision.farmWorld): порт 25601..25632 и бот NeuroFarm<i>.
function asFarm () {
  const cfg = require('../src/config'); const was = { port: cfg.port, username: cfg.username }
  cfg.port = 25601; cfg.username = 'NeuroFarm1'
  return () => Object.assign(cfg, was)
}

test('окно точности: только на ферме и с ND_PRECISION_TPS, включается раз и возвращает прежний темп', () => {
  const { precisionWindow, precisionOff } = require('../src/dragon/precision')
  const gameClock = require('../src/game-clock')
  const cfg = require('../src/config')
  const said = []
  const bot: any = { chat: (m) => said.push(m) }
  const was = process.env.ND_PRECISION_TPS
  const c = new gameClock.GameClock({ manual: true }); c.setState({ tick_rate: 750 }); gameClock.activate(c)
  const unfarm = asFarm()
  try {
    // основной мир (25569, NeuroDown): переменная задана — команда всё равно не уходит
    process.env.ND_PRECISION_TPS = '20'
    cfg.port = 25569; cfg.username = 'NeuroDown'
    assert.equal(precisionWindow(bot, {}, true), null)
    cfg.port = 25601; cfg.username = 'NeuroFarm1'
    delete process.env.ND_PRECISION_TPS
    assert.equal(precisionWindow(bot, {}, true), null)
    process.env.ND_PRECISION_TPS = '20'
    const ctl: any = {}
    assert.deepEqual(precisionWindow(bot, ctl, true), { on: 20, was: 750 })
    assert.equal(precisionWindow(bot, ctl, true), null)
    assert.deepEqual(precisionWindow(bot, ctl, false), { off: 750 })
    assert.equal(precisionOff(bot, ctl), null)
    assert.deepEqual(said, ['/tick rate 20', '/tick rate 750'])
  } finally {
    unfarm()
    if (was == null) delete process.env.ND_PRECISION_TPS; else process.env.ND_PRECISION_TPS = was
    c.dispose(); gameClock.activate(null)
  }
})

test('честный отвод взгляда: голова опускается в теле, пакет совпадает с телом; за блоком эндермен не в счёт', () => {
  const Vec3 = require('vec3')
  const { EventEmitter } = require('node:events')
  const { lookGuard } = require('../src/dragon/fall-guard')
  const sent = []
  let wall = false
  const bot: any = new EventEmitter()
  Object.assign(bot, { entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 }, entities: { 5: { id: 5, name: 'enderman', position: new Vec3(0, 64 + 1.62 - 2.55, -20) } },
    _client: { write: (n, d) => sent.push([n, d]) },
    blockAt: p => wall && p.z === -10 && p.y === 65 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', boundingBox: 'empty' } })
  const stats: any = {}
  const off = lookGuard(bot, stats)
  // (1) тело смотрит на север (yaw 0 = −z) в глаза: тик физики опускает голову В ТЕЛЕ до отправки
  bot.emit('physicsTick')
  assert.ok(bot.entity.pitch < -0.05, `pitch тела ${bot.entity.pitch}`)
  assert.equal(stats.guarded, 1)
  // (2) поздний поворот в глаза, ушедший мимо тика, — опускается и в пакете, и в теле одинаково
  bot._client.write('look', { yaw: 180, pitch: 0, flags: {} })
  assert.ok(sent[0][1].pitch > 3, `pitch пакета ${sent[0][1].pitch}`)
  assert.ok(Math.abs(-sent[0][1].pitch * Math.PI / 180 - bot.entity.pitch) < 1e-9, 'тело и сервер видят один поворот')
  bot._client.write('position_look', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: {} }) // на юг — мимо
  assert.equal(sent[1][1].pitch, 0)
  bot._client.write('use_item', { hand: 0, rotation: { x: 180, y: 0 } }) // бросок не уводим
  assert.deepEqual(sent[2][1].rotation, { x: 180, y: 0 })
  // (3) блок между глазами и глазами эндермена (COLLIDER) — не взгляд, голову не опускать
  wall = true; bot.entity.pitch = 0
  bot.emit('physicsTick')
  assert.equal(bot.entity.pitch, 0)
  off()
  bot._client.write('look', { yaw: 180, pitch: 0 })
  assert.equal(sent[3][1].pitch, 0)
})

test('титры после выходного портала: ответ perform_respawn и после конца навыка (s5-e23-s7), повтор до respawn', async () => {
  const { EventEmitter } = require('node:events')
  const d = require('../src/dragon/dragon')
  const client: any = new EventEmitter(); const sent = []
  client.write = (n, data) => sent.push([n, data])
  const bot: any = { _client: client, supportFeature: () => false, pathfinder: null }
  const session: any = { bot }
  const ctl: any = {}
  // бой падает сразу (не в Энде), ответ на титры остаётся у демона
  bot.game = { dimension: 'overworld' }; bot.entity = null; bot.health = 20; bot.inventory = { items: () => [], slots: [] }
  await d.dragon(session, ctl, {}).catch(() => {})
  client.emit('game_state_change', { reason: 'win_game', gameMode: 0 }) // титры уже видел: mineflayer сам не отвечает
  assert.deepEqual(sent.filter(([n]) => n === 'client_command'), [['client_command', { actionId: 0 }]])
  client.emit('respawn', {})
  client.emit('game_state_change', { reason: 'rain_level_change', gameMode: 0 })
  assert.equal(sent.length, 1)
  assert.equal(bot._ndCredits.answered, 1)
})

test('окно точности: облако рядом включает 20 тиков и держит ещё 3 игровых с', () => {
  const Vec3 = require('vec3')
  const gameClock = require('../src/game-clock')
  const { precisionTick } = require('../src/dragon/precision')
  const was = process.env.ND_PRECISION_TPS
  const c = new gameClock.GameClock({ manual: true }); c.setState({ tick_rate: 750 }); gameClock.activate(c)
  const said = []
  const cloud = { id: 9, name: 'area_effect_cloud', position: new Vec3(3, 61, 0), metadata: [] }
  const bot: any = { chat: (m) => said.push(m), entity: { position: new Vec3(0, 61, 0), id: 1 }, entities: { 9: cloud }, registry: { entitiesByName: {} } }
  const unfarm = asFarm()
  try {
    process.env.ND_PRECISION_TPS = '20'
    const ctl: any = { pillar: { built: true } } // станция готова — окно подхода закрыто, остаётся окно по опасности
    precisionTick(bot, ctl)
    assert.deepEqual(said, ['/tick rate 20'])
    delete bot.entities[9]
    c.advanceTicks(40) // 2 с — ещё держит
    precisionTick(bot, ctl)
    assert.equal(said.length, 1)
    c.advanceTicks(30) // 3.5 с после облака — отпускает
    precisionTick(bot, ctl)
    assert.deepEqual(said, ['/tick rate 20', '/tick rate 750'])
  } finally {
    unfarm()
    if (was == null) delete process.env.ND_PRECISION_TPS; else process.env.ND_PRECISION_TPS = was
    c.dispose(); gameClock.activate(null)
  }
})

test('окно точности: подход с платформы — 20 тиков с начала навыка до станции или 40 игр. с (s5c-d1-s6)', () => {
  const Vec3 = require('vec3')
  const gameClock = require('../src/game-clock')
  const { precisionTick } = require('../src/dragon/precision')
  const cfg = require('../src/config'); const was = { port: cfg.port, username: cfg.username, env: process.env.ND_PRECISION_TPS }
  cfg.port = 25601; cfg.username = 'NeuroFarm1'; process.env.ND_PRECISION_TPS = '20'
  const c = new gameClock.GameClock({ manual: true }); c.setState({ tick_rate: 750 }); gameClock.activate(c)
  const said = []
  const bot: any = { chat: (m) => said.push(m), entity: { position: new Vec3(100, 49, 0), id: 1 }, entities: {}, registry: { entitiesByName: {} } }
  try {
    const ctl: any = { started: gameClock.now() }
    precisionTick(bot, ctl)
    assert.deepEqual(said, ['/tick rate 20'], 'подход — окно сразу')
    c.advanceTicks(20 * 41)
    precisionTick(bot, ctl)
    assert.deepEqual(said, ['/tick rate 20', '/tick rate 750'], 'через 40 с без опасности — прежний темп')
    const ctl2: any = { started: gameClock.now(), pillar: { built: true } }
    precisionTick(bot, ctl2)
    assert.equal(said.length, 2, 'станция готова — подход кончился')
  } finally {
    Object.assign(cfg, { port: was.port, username: was.username }); if (was.env == null) delete process.env.ND_PRECISION_TPS; else process.env.ND_PRECISION_TPS = was.env
    c.dispose(); gameClock.activate(null)
  }
})
