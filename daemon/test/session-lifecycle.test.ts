'use strict'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import path = require('node:path')
import * as vm from 'node:vm'
import { withClockFixture } from './clock-fixture'
import { EventEmitter } from 'node:events'
import { bodySource } from './source-fixture'
import { stubRequire } from './stub-require'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// Настоящий mineflayer тут не создаёт бота никогда: без host он пошёл бы на localhost:25565 — сервер пользователя.
// Сессия исполняется в vm целиком (фасад и части session/ одной областью, bodySource), mineflayer — заглушка; этот
// сторож ловит ошибку фикстуры, если код когда-нибудь дотянется до настоящего пакета.
;(require('mineflayer') as any).createBot = () => { throw new Error('session-lifecycle: настоящий mineflayer.createBot в тесте запрещён') }
const SESSION = path.join(__dirname, '../src/session.js')
test('parkour route honors a bounded extended game-time request without changing other action timeouts', () => {
  const parkour = (require('../src/session/resources') as typeof import('../src/session/resources')).parkour
  const session = { runIntent: (_name, _fn, options) => options }
  const target = { x: 0, y: 1, z: 0 }
  assert.equal(parkour.call(session, { mode: 'route', target, timeoutSeconds: 1000 }).timeoutMs, 1020000)
  assert.equal(parkour.call(session, { mode: 'route', target, timeoutSeconds: 10000 }).timeoutMs, 3620000)
  assert.equal(parkour.call(session, { mode: 'options', target, timeoutSeconds: 1000 }).timeoutMs, 620000)
  assert.equal(parkour.call(session, { mode: 'jump', target, timeoutSeconds: 1000 }).timeoutMs, 60000)
})

function fixture () {
  const bots = []
  const events = []
  const fallback = new Proxy({} as Record<string, any>, { get: () => () => {} })
  const req = stubRequire(SESSION, {
    vec3: Vec3,
    mineflayer: { createBot: () => bots.shift() },
    'minecraft-data': () => ({} as Record<string, any>),
    './play-policy': { configure: () => ({ mode: 'speedrun' }) },
    './build': { withTimeout: p => p },
    './gamedata': (require('../src/gamedata') as typeof import('../src/gamedata')),
    './tactics/minecraft': { TacticalSystem: class {
      enabled () { return false }
      attach () {}
      snapshot () { return null }
      observed () {}
    } },
    './reflex-lock': { on: () => false, wait: async () => {}, run: (_session, _ctl, fn) => fn(), cancel () {} }
  }, {}, { fallback: (name, real) => name.startsWith('./session/') ? real(name) : fallback })
  const context = { console: { log () {}, error () {} }, process: { env: {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    module: { exports: {} as Record<string, any> }, require: req }
  vm.runInNewContext(bodySource(SESSION), cjsContext(withClockFixture(context)))
  const { Session } = context.module.exports
  const journal = { state: {} as Record<string, any>, append () {}, patch: fn => fn(journal.state) }
  const s = new Session({ lowHealth: 6 }, { emit: (type, detail) => events.push({ type, ...detail }) }, journal)
  s.updateMovements = () => {}
  s.waitUntilWorldLoaded = async () => true
  s.state = () => ({ connected: !!s.bot })
  function bot () {
    const b: any = new EventEmitter()
    b.entity = { position: new Vec3(0.5, 64, 0.5) }
    b.registry = {} as Record<string, any>; b.version = '1.21.11'; b.health = 20
    b.loadPlugin = () => {}; b.quit = () => {}
    b.waitForChunksToLoad = async () => {}
    return b
  }
  return { s, bots, bot, events, req }
}

test('фикстура сессии: все заглушки живые, настоящий mineflayer недоступен', () => {
  const { s, bot, req } = fixture()
  const b = bot(); s.bot = b; s.wire(); s.cancel()
  assert.deepEqual(req.unmatched(), [])
  assert.throws(() => (require('mineflayer') as any).createBot({}), /запрещён/)
})

function setupAutopilot(s) {
  const fallback = new Proxy({}, { get: () => () => {} })
  const context: any = { module: { exports: {} }, console, process: { env: {} }, require(name) {
    if (name === './loot') return { seen: () => [{ lootable: true, kind: 'chest', guess: 'руины портала', at: { x: 3, y: 64, z: 0 } }] }
    if (name === './combat') return { nearestHostile: () => null }
    if (name === './gestures') return { hook() {} }
    if (name === './social') return { noticePlayers: async () => {} }
    if (name === './fightkit') return { autoUse: async () => {} }
    if (name === './gamedata') return (require('../src/gamedata') as typeof import('../src/gamedata'))
    return fallback
  }, setInterval: () => 1, clearInterval() {} }
  vm.runInNewContext(bodySource(path.join(__dirname, '../src/autopilot.js')), cjsContext(withClockFixture(context)))
  const auto = new context.module.exports.Autopilot(s, {})
  for (const method of ['hookTemper', 'hookDamage', 'syncDamageContext', 'hookCreeper', 'escapeWaterIfIdle', 'freeIfBuried', 'emergency', 'extinguish', 'fleeIfDying', 'eatIfHungry', 'wearArmor', 'noteDayPhase', 'heartbeat']) auto[method] = async () => {}
  let tools = 0, loot = 0, chest = 33, inventory = 0
  auto.keepTools = async () => { tools++ }
  s.autoLoot = async () => { loot++; inventory += chest; chest = 0; return { took: { iron_nugget: 24 } } }
  s.autopilot = auto
  return { auto, counts: () => ({ tools, loot, chest, inventory }), clear: () => { inventory = 0 } }
}

test('paused fresh bootstrap prevents autonomous chest loss throughout the pending connection and setup', async () => {
  const { s, bots, bot } = fixture()
  const b = bot(); bots.push(b)
  let loaded
  b.waitForChunksToLoad = () => new Promise(resolve => { loaded = resolve })
  const f = setupAutopilot(s)
  const connecting = s.connect({ bootstrapPaused: true })
  await f.auto.tick()
  assert.deepEqual(f.counts(), { tools: 0, loot: 0, chest: 33, inventory: 0 })
  b.emit('spawn'); await Promise.resolve()
  await f.auto.tick()
  assert.equal(f.counts().loot, 0)
  loaded(); await connecting
  // The actual scene clears only its setup inventory; no natural loot was consumed.
  f.clear(); await f.auto.tick()
  assert.equal(f.counts().chest, 33)
  await s.connect() // Status/retry callers do not silently release the setup pause.
  await f.auto.tick()
  assert.equal(f.counts().loot, 0)
  await s.connect({ bootstrapPaused: false })
  await f.auto.tick()
  assert.deepEqual(f.counts(), { tools: 1, loot: 1, chest: 0, inventory: 33 })
})

test('ordinary connect keeps autonomous tools and chest loot enabled', async () => {
  const { s, bots, bot } = fixture()
  const b = bot(); bots.push(b)
  const f = setupAutopilot(s)
  const connecting = s.connect(); b.emit('spawn'); await connecting
  await f.auto.tick()
  assert.deepEqual(f.counts(), { tools: 1, loot: 1, chest: 0, inventory: 33 })
})

test('bootstrap pause validates its explicit boolean before creating a bot', () => {
  const { s } = fixture()
  assert.throws(() => s.connect({ bootstrapPaused: 'true' }), /must be boolean/)
  assert.equal(s.bot, null)
})

test('failed handshake retries preserve an explicit bootstrap pause', async () => {
  const { s, bots, bot } = fixture()
  const old = bot(); bots.push(old)
  const first = s.connect({ bootstrapPaused: true })
  old.emit('error', new Error('chunks failed'))
  await assert.rejects(first, /chunks failed/)
  const next = bot(); bots.push(next)
  const connecting = s.connect(); next.emit('spawn'); await connecting
  const f = setupAutopilot(s)
  await f.auto.tick()
  assert.equal(f.counts().loot, 0)
})

test('explicit teardown after an unfinished setup restores ordinary connection autonomy', async () => {
  const { s, bots, bot } = fixture()
  const first = bot(); bots.push(first)
  const connecting = s.connect({ bootstrapPaused: true }); first.emit('spawn'); await connecting
  s.disconnect('fixture setup failed')
  const next = bot(); bots.push(next)
  const normal = s.connect(); next.emit('spawn'); await normal
  const f = setupAutopilot(s)
  await f.auto.tick()
  assert.equal(f.counts().loot, 1)
})

test('position-holding wait reserves the body while ordinary wait leaves autonomous movement available', () => {
  const { Session }: typeof import('../src/session') = require('../src/session')
  const { Autopilot }: typeof import('../src/autopilot') = require('../src/autopilot')
  const session: any = { runIntent(name, _worker, options) { this.current = { name }; return options } }
  const auto = new Autopilot(session, {})
  const ordinary = Session.prototype.wait.call(session, { seconds: 1 })
  assert.equal(ordinary.exclusive, false)
  assert.equal(auto.bodyBusy(), false)
  const held = Session.prototype.wait.call(session, { seconds: 1, holdPosition: true })
  assert.equal(held.exclusive, true)
  assert.equal(auto.bodyBusy(), true)
  assert.ok(held.interruptOn.includes('damage'))
  assert.ok(held.interruptOn.includes('death'))
  assert.throws(() => Session.prototype.wait.call(session, { holdPosition: 'yes' }), /must be boolean/)
})

test('сохранённое низкое здоровье при входе не считается новым уроном', () => {
  const { s, bot, events } = fixture()
  const b = bot(); s.bot = b; s.wire()
  b.health = 6; b.emit('health')
  assert.deepEqual(events, [])
  b.health = 5; b.emit('health')
  assert.deepEqual(events, [{ type: 'damage', health: 5, lost: 1 }])
})

test('реальный урон и пересечение опасного здоровья всё ещё прерывают работу', () => {
  const { s, bot, events } = fixture()
  const b = bot(); s.bot = b; s.wire()
  b.emit('health')
  b.health = 6; b.emit('health')
  assert.deepEqual(events, [
    { type: 'damage', health: 6, lost: 14 },
    { type: 'low_health', health: 6 }
  ])
})

test('вход с нулевым здоровьем сохраняет повторный запрос возрождения', () => {
  const { s, bot, events } = fixture()
  const b = bot(); s.bot = b; s.wire()
  try {
    b.health = 0; b.emit('health')
    assert.ok(s.respawnNudge)
    assert.deepEqual(events, [])
  } finally { clearInterval(s.respawnNudge) }
})

test('пакет здоровья старого соединения не меняет новую сессию', () => {
  const { s, bot, events } = fixture()
  const old = bot(); s.bot = old; s.wire(); old.emit('health')
  const current = bot(); s.bot = current; s.wire(); current.emit('health')
  old.health = 1; old.emit('health')
  assert.deepEqual(events, [])
  assert.equal(s.lastHealth, 20)
  current.health = 19; current.emit('health')
  assert.deepEqual(events, [{ type: 'damage', health: 19, lost: 1 }])
})

test('здоровье до spawn задаёт исходное состояние, следующий удар не теряется', async () => {
  const { s, bots, bot, events } = fixture()
  const b = bot(); bots.push(b)
  const promise = s.connect()
  b.health = 6; b.emit('health')
  assert.deepEqual(events, [])
  b.health = 5; b.emit('health')
  assert.deepEqual(events, [{ type: 'damage', health: 5, lost: 1 }])
  b.emit('spawn'); await promise
  b.health = 4; b.emit('health')
  assert.deepEqual(events, [
    { type: 'damage', health: 5, lost: 1 },
    { type: 'damage', health: 4, lost: 1 }
  ])
})
for (const event of ['end', 'kicked']) test(`поздний ${event} старого соединения не отключает новое`, () => {
  const { s, bot } = fixture()
  const old = bot(); const current = bot()
  s.bot = old; s.wire(); s.bot = current
  old.emit(event, 'old connection closed')
  assert.equal(s.bot, current)
  s.wire(); current.emit(event, 'current connection closed')
  assert.equal(s.bot, null)
})
test('connect ждёт чанки вокруг игрока до первых игровых действий', async () => {
  const { s, bots, bot } = fixture()
  const b = bot(); bots.push(b)
  let loaded
  b.waitForChunksToLoad = () => new Promise<any>(resolve => { loaded = resolve })
  s.wire = () => {}
  const promise = s.connect()
  const concurrent = s.connect()
  let ready = false
  promise.then(() => { ready = true })
  b.emit('spawn')
  await new Promise<any>(resolve => setImmediate(resolve))
  const premature = ready
  loaded?.()
  await promise
  await concurrent
  assert.equal(premature, false, 'соседний чанк с порталом ещё не пришёл')
})
test('ошибка настройки после spawn завершает connect отказом', async () => {
  const { s, bots, bot } = fixture()
  const b = bot(); bots.push(b)
  s.wire = () => { throw new Error('setup failed') }
  const promise = s.connect()
  b.emit('spawn')
  await assert.rejects(promise, /setup failed/)
  assert.equal(s.bot, null)
  assert.equal(s.connecting, null)
})
test('конверт намерения несёт машинный code исхода: TIMEOUT, DAMAGE, CHAT, код навыка, FAILED, OK', async () => {
  const { EventBus }: typeof import('../src/events') = require('../src/events')
  const { s } = fixture()
  s.bus = new EventBus()
  // Работа, которая отвечает отчётом на отмену (как длинные намерения), — без секунды ожидания.
  const endless = ctl => new Promise<any>(resolve => ctl.onAbort.push(() => resolve({ stopped: 'отменено' })))
  const t = await s.runIntent('dig', endless, { timeoutMs: 20 })
  assert.equal(t.status, 'timeout')
  assert.equal(t.code, 'TIMEOUT')

  let p = s.runIntent('goto', endless, { timeoutMs: 5000 })
  setTimeout(() => s.bus.emit('damage', { health: 12, lost: 3 }), 5)
  let r = await p
  assert.equal(r.status, 'interrupted')
  assert.equal(r.code, 'DAMAGE')

  p = s.runIntent('goto', endless, { timeoutMs: 5000 })
  setTimeout(() => s.bus.emit('low_health', { health: 5 }), 5)
  assert.equal((await p).code, 'LOW_HP')

  p = s.runIntent('goto', endless, { timeoutMs: 5000 })
  setTimeout(() => s.bus.emit('chat', { from: 'player', text: 'стой' }), 5)
  r = await p
  assert.equal(r.code, 'CHAT')
  s.bus.drain()

  r = await s.runIntent('goto', async () => { throw Object.assign(new Error('пути нет'), { code: 'NO_PATH' }) }, { timeoutMs: 5000 })
  assert.equal(r.status, 'failed')
  assert.equal(r.code, 'NO_PATH')
  r = await s.runIntent('goto', async () => { throw new Error('что-то сломалось') }, { timeoutMs: 5000 })
  assert.equal(r.code, 'FAILED')
  r = await s.runIntent('mine', async () => ({ dug: 0, code: 'NOT_FOUND' }), { timeoutMs: 5000 })
  assert.equal(r.status, 'done')
  assert.equal(r.code, 'NOT_FOUND')
  r = await s.runIntent('mine', async () => ({ dug: 3 }), { timeoutMs: 5000 })
  assert.equal(r.code, 'OK')
})

test('урон несёт тип из damage_event своего тела; устаревший тип не приписывается', async () => {
  const { s, bot, events } = fixture()
  const b = bot(); b.entity.id = 7; b._client = new EventEmitter(); b.entities = { 3: { name: 'zombie' } }
  s.bot = b; s.wire()
  b.emit('health')
  b._client.emit('damage_event', { entityId: 7, sourceTypeId: 40, sourceCauseId: 0 })
  b.health = 19; b.emit('health')
  b._client.emit('damage_event', { entityId: 7, sourceTypeId: 28, sourceCauseId: 4 })
  b.health = 16; b.emit('health')
  b._client.emit('damage_event', { entityId: 99, sourceTypeId: 10, sourceCauseId: 0 })
  b.health = 15; b.emit('health')
  b._client.emit('damage_event', { entityId: 7, sourceTypeId: 10, sourceCauseId: 0 })
  await new Promise<any>(resolve => setTimeout(resolve, 300))
  b.health = 14; b.emit('health')
  assert.deepEqual(events, [
    { type: 'damage', health: 19, lost: 1, cause: 'starve' },
    { type: 'damage', health: 16, lost: 3, cause: 'mob_attack', source: 'zombie' },
    { type: 'damage', health: 15, lost: 1 },
    { type: 'damage', health: 14, lost: 1 }
  ])
})

test('нору рвут только человек, смерть и связь — не урон и не низкое здоровье', () => {
  const { s } = fixture()
  s.runIntent = (name, worker, opts) => ({ name, opts })
  const r = s.shelter({ mode: 'enter', depth: 3 })
  assert.equal(r.name, 'shelter')
  assert.deepEqual([...r.opts.interruptOn].sort(), ['chat', 'death', 'disconnected', 'kicked'])
})

test('ожидание (wait) рядом с идущим отходом не занимает его место и, кончившись, не обнуляет его', async () => {
  const { EventBus }: typeof import('../src/events') = require('../src/events')
  const { s } = fixture()
  s.bus = new EventBus()
  const endless = ctl => new Promise<any>(resolve => ctl.onAbort.push(() => resolve({ stopped: 'отменено' })))
  const refuge = s.runIntent('refuge', endless, { timeoutMs: 5000 })
  assert.equal(s.current.name, 'refuge')
  const w = await s.runIntent('wait', ctl => new Promise<any>(resolve => setTimeout(resolve, 10)), { exclusive: false, timeoutMs: 1000 })
  assert.equal(w.status, 'done')
  assert.equal(s.current && s.current.name, 'refuge', '«занят: refuge» не пропадает под wait мозга')
  s.cancel()
  await refuge
  // Тело свободно — wait, как и раньше, записывает себя (автопилот и жесты читают «ждёт», а не «занят»).
  const p = s.runIntent('wait', ctl => new Promise<any>(resolve => setTimeout(resolve, 10)), { exclusive: false, timeoutMs: 1000 })
  assert.equal(s.current.name, 'wait')
  await p
  assert.equal(s.current, null)
})

test('падение в выкопанную клетку перед копкой: не проезжать её к краю столба (регрессия спуска 30.09)', () => {
  const { steerIntoDig }: typeof import('../src/session') = require('../src/session')
  const node = { x: 3049, y: 258, z: 3000, toBreak: [{ x: 3049, y: 258, z: 3000 }] }
  // mlg-reg-dbg1, 8.1 с: x 3049.54, едет на восток 0.11 бл/тик, в воздухе — прогноз 3049.98, вне центра: толкать назад.
  const c = steerIntoDig({ position: new Vec3(3049.54, 259.92, 3000.5), velocity: new Vec3(0.11, -0.16, 0), onGround: false }, node)
  assert.ok(c && c.forward, 'толкаться в центр колонны')
  assert.ok(Math.abs(c.yaw - Math.PI / 2) < 0.2, 'лицом на запад — против сноса (yaw ≈ π/2)')
  // Уже в центре и без сноса — клавиши отпустить.
  assert.equal(steerIntoDig({ position: new Vec3(3049.5, 259.5, 3000.5), velocity: new Vec3(0, -0.2, 0), onGround: false }, node).forward, false)
  // На полу, без копки впереди или далеко от колонны — не вмешиваться.
  assert.equal(steerIntoDig({ position: new Vec3(3049.5, 259, 3000.5), velocity: new Vec3(0, 0, 0), onGround: true }, node), null)
  assert.equal(steerIntoDig({ position: new Vec3(3049.5, 259.5, 3000.5), velocity: new Vec3(0, 0, 0), onGround: false }, { x: 3049, y: 258, z: 3000, toBreak: [] }), null)
  assert.equal(steerIntoDig({ position: new Vec3(3040.5, 259.5, 3000.5), velocity: new Vec3(0, 0, 0), onGround: false }, node), null)
})
