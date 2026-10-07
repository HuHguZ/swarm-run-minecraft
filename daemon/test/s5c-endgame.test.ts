'use strict'
// S5c (06.10): подход к комнате крепости по карте копии мира — сухой вход дальше 14 бл. (комната под океаном).
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

// S5e (07.10): шахта и штрек по прогруженным чанкам (рентген толщи) — только «полный скан»; в rsg/ssg — честный спуск
// (endportal-descent, test/s5e-endgame). Эти тесты — про ход scan.
function scanFor (t: any) { const s = process.env.ND_KNOWLEDGE; process.env.ND_KNOWLEDGE = 'scan'; t.after(() => { if (s === undefined) delete process.env.ND_KNOWLEDGE; else process.env.ND_KNOWLEDGE = s }) }

test('сухой вход к комнате под океаном: ближайшая суша до 48 бл., вода и непрогруженное — не вход', (t) => {
  scanFor(t)
  const { dryEntry } = require('../src/endportal')
  // Море |x−100| < 30 (вода y 50..62, дно y 49), суша дальше (камень до y 64); x > 140 — чанк не прогружен.
  const blockAt = p => {
    if (p.x > 140) return null
    const sea = Math.abs(p.x - 100) < 30
    const top = sea ? 49 : 64
    if (p.y <= top) return { name: 'stone', boundingBox: 'block' }
    if (sea && p.y <= 62) return { name: 'water', boundingBox: 'empty' }
    return { name: 'air', boundingBox: 'empty' }
  }
  const bot: any = { entity: { position: new Vec3(60, 65, 0) }, blockAt }
  const d = dryEntry(bot, { x: 100, z: 0 })
  assert.ok(d, 'нашёл сушу')
  assert.ok(Math.abs(d.x - 100) >= 31 && d.r <= 48, JSON.stringify(d))
  assert.ok(d.x < 100, 'на прогруженном берегу (x > 140 — неизвестно)')
  assert.equal(dryEntry(bot, { x: 100, z: 0 }, 14), null, 'в 14 бл. суши нет')
})

// Тактика (узкая правка s5c 06.10): падение ведёт рефлекс клатча — тактика без выбранного действия навык не рвёт;
// угроза с действием (тонет — Surface) рвёт, как прежде.
test('тактика: падение под клатчем без действия не обрывает навык (s5c-f2-3: 49 обрывов goto), утопление — обрывает', () => {
  const { EventEmitter } = require('node:events')
  const { TacticalSystem } = require('../src/tactics/minecraft')
  const mk = (water: boolean) => {
    const bot: any = new EventEmitter()
    bot.version = '1.21.11'; bot.health = 20; bot.food = 20; bot.oxygenLevel = water ? 4 : 20
    bot.inventory = { slots: [], items: () => [{ name: 'iron_sword', count: 1 }] }
    bot.registry = { foodsByName: {}, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
    bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: !water, isInWater: water, effects: {}, metadata: [], yaw: 0, pitch: 0, velocity: new Vec3(0, 0, 0) }
    bot.entities = {}
    bot.game = { dimension: 'overworld', gameMode: 'survival' }
    bot.blockAt = (p: any) => p.y < 64 ? { name: 'stone', boundingBox: 'block', position: p.floored(), shapes: [[0, 0, 0, 1, 1, 1]] }
      : { name: water && p.y < 70 ? 'water' : 'air', boundingBox: 'empty', position: p.floored(), shapes: [] }
    bot.pathfinder = { setGoal: () => {}, setMovements: () => {}, stop: () => {} }
    bot.clearControlStates = () => {}
    if (!water) bot._ndClutch = { lastDecision: { action: 'water' } }
    const ctl: any = { aborted: false, onAbort: [], abort () { this.aborted = true } }
    const s: any = { bot, current: { name: 'goto', ctl }, reflex: null, bus: { emit: () => {} }, tempo: null }
    const t = s.tactics = new TacticalSystem(s)
    t.execute = () => new Promise(() => {})
    return { s, t, ctl }
  }
  const fall = mk(false)
  try { fall.t.attach(fall.s.bot); fall.t.update(true); assert.equal(fall.t.snapshot().threatLevel, 4); assert.equal(fall.ctl.aborted, false) } finally { fall.t.detach() }
  const drown = mk(true)
  try { drown.t.attach(drown.s.bot); drown.t.update(true); assert.ok(drown.t.snapshot().threatLevel >= 3); assert.equal(drown.ctl.aborted, true) } finally { drown.t.detach() }
})

// s5c-f4-4 (06.10): explore в воде без пути — travelXZ отказывал без единого таймера, цикл крутился микрозадачами, игровые
// часы не шли (срок не наступал), демон 100 % CPU 12+ мин. Теперь после отказа — пауза игрового времени, срок наступает.
test('explore: отрезок отказал сразу — цикл отдаёт события и кончается по сроку игровых часов', { timeout: 15000 }, async () => {
  const Vec3 = require('vec3')
  const gameClock = require('../src/game-clock')
  const { explore } = require('../src/actions')
  const mcData = require('minecraft-data')('1.21.11')
  const c = new gameClock.GameClock({ epoch: 0, stallMs: 0 }); c.setState({ tick_rate: 200 }); gameClock.activate(c); c.start()
  // В толще воды под камнем: ни берега, ни воздуха — escapeWater «нет пути» мгновенно.
  const bot: any = { entity: { position: new Vec3(0.5, 60, 0.5), isInWater: true, onGround: false, yaw: 0, pitch: 0, eyeHeight: 1.62 },
    blockAt: p => p.y >= 63 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p } : { name: 'water', boundingBox: 'empty', shapes: [], position: p },
    registry: mcData, game: { minY: -64, height: 384 }, world: { getColumn: () => null },
    pathfinder: { setGoal: () => {}, movements: null, goto: () => Promise.reject(new Error('нет пути')) },
    clearControlStates: () => {}, setControlState: () => {}, lookAt: async () => {}, oxygenLevel: 20, food: 20 }
  const session: any = { bot, mcData, cfg: { fairPlay: true } }
  try {
    const r = await explore(session, { aborted: false, onAbort: [] }, { block: 'iron_ore', timeoutSeconds: 3 })
    assert.equal(r.found, null)
    assert.ok(r.legs.length >= 1 && r.legs.length < 200, `отрезков ${r.legs.length}`)
    assert.ok(c.now() >= 3000, `игровые часы дошли до срока: ${c.now()}`)
  } finally { c.dispose(); gameClock.activate(null) }
})

test('шахта/штрек: снег без лопаты пробиваем руками (дроп не нужен), долгий удар — стоп (s5c-g2-3)', () => {
  const { cantDigThrough } = require('../src/endportal')
  const mcData = require('minecraft-data')('1.21.11')
  const Block = require('prismarine-block')('1.21.11')
  const snow = Block.fromStateId(mcData.blocksByName.snow_block.defaultState, 0)
  const obsidian = Block.fromStateId(mcData.blocksByName.obsidian.defaultState, 0)
  const bot: any = { registry: mcData, inventory: { items: () => [] }, heldItem: null, digTime: b => b.name === 'snow_block' ? 1000 : 250000 }
  assert.ok(require('../src/items').missingHarvestTool(bot, snow, mcData), 'для дропа снега нужна лопата')
  assert.equal(cantDigThrough(bot, snow, mcData), null)
  assert.ok(cantDigThrough(bot, obsidian, mcData), 'обсидиан руками — стоп')
})
