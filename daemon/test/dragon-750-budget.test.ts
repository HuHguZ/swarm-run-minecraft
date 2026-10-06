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

test('окно точности: только с ND_PRECISION_TPS, включается раз и возвращает прежний темп', () => {
  const { precisionWindow, precisionOff } = require('../src/dragon/precision')
  const gameClock = require('../src/game-clock')
  const said = []
  const bot: any = { chat: (m) => said.push(m) }
  const was = process.env.ND_PRECISION_TPS
  const c = new gameClock.GameClock({ manual: true }); c.setState({ tick_rate: 750 }); gameClock.activate(c)
  try {
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
    if (was == null) delete process.env.ND_PRECISION_TPS; else process.env.ND_PRECISION_TPS = was
    c.dispose(); gameClock.activate(null)
  }
})

test('фильтр взгляда: исходящий поворот в глаза эндермену опускается, прочие пакеты — как были', () => {
  const Vec3 = require('vec3')
  const { stareFilter } = require('../src/dragon/fall-guard')
  const sent = []
  const bot: any = { entity: { position: new Vec3(0, 64, 0) }, entities: { 5: { id: 5, name: 'enderman', position: new Vec3(0, 64 + 1.62 - 2.55, -20) } }, _client: { write: (n, d) => sent.push([n, d]) } }
  const stats: any = {}
  const off = stareFilter(bot, stats)
  // взгляд на север (yaw 0 у mineflayer = −z), горизонтально: глаза эндермена на уровне глаз — в упор
  bot._client.write('look', { yaw: 180, pitch: 0, flags: {} })
  bot._client.write('position_look', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: {} }) // на юг — мимо
  bot._client.write('use_item', { hand: 0 })
  off()
  assert.ok(sent[0][1].pitch > 3, `pitch ${sent[0][1].pitch}`)
  assert.equal(sent[1][1].pitch, 0)
  assert.equal(sent[2][0], 'use_item')
  assert.equal(stats.stareCut, 1)
  bot._client.write('look', { yaw: 180, pitch: 0 })
  assert.equal(sent[3][1].pitch, 0)
})

test('титры после выходного портала: дракон-навык сразу отвечает perform_respawn (часы не встают)', async () => {
  const { EventEmitter } = require('node:events')
  const d = require('../src/dragon/dragon')
  const client: any = new EventEmitter(); const sent = []
  client.write = (n, data) => sent.push([n, data])
  const bot: any = { _client: client, supportFeature: () => false, pathfinder: null }
  const session: any = { bot }
  const ctl: any = {}
  // бой падает сразу (не в Энде) — обёртка всё равно снимает слушателя
  bot.game = { dimension: 'overworld' }; bot.entity = null; bot.health = 20; bot.inventory = { items: () => [], slots: [] }
  const run = d.dragon(session, ctl, {}).catch(() => {})
  client.emit('game_state_change', { reason: 4, gameMode: 1 })
  await run
  client.emit('game_state_change', { reason: 4, gameMode: 1 })
  assert.deepEqual(sent.filter(([n]) => n === 'client_command').length, 1)
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
  try {
    process.env.ND_PRECISION_TPS = '20'
    const ctl: any = {}
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
    if (was == null) delete process.env.ND_PRECISION_TPS; else process.env.ND_PRECISION_TPS = was
    c.dispose(); gameClock.activate(null)
  }
})
