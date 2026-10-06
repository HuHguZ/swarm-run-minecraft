'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const gamedata = require('../src/gamedata')

test('реестр типов урона — одна копия, сверена с копиями боевых модулей', () => {
  assert.equal(gamedata.DAMAGE_TYPES.length, 50)
  assert.deepEqual(gamedata.DAMAGE_TYPES, require('../src/dragon').DAMAGE_TYPES)
  assert.equal(gamedata.damageTypeName(40), 'starve')
  assert.equal(gamedata.damageTypeName(22), 'in_wall')
  assert.equal(gamedata.damageTypeName(10), 'fall')
  assert.equal(gamedata.damageTypeName(28), 'mob_attack')
  assert.equal(gamedata.damageTypeName(99), null)
})

function fireBot (dimension) {
  const Vec3 = require('vec3')
  const calls = []
  const bot = {
    game: { dimension },
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 },
    inventory: { items: () => [{ name: 'water_bucket' }] },
    equip: async () => { calls.push('equip') },
    look: async () => {},
    lookAt: async () => {},
    activateItem: () => { calls.push('activate') },
    setControlState: (k, v) => { if (v) calls.push(k) },
    clearControlStates: () => {},
    // Пол вокруг: воздух над камнем.
    blockAt: p => ({ name: p.y >= 64 ? 'air' : 'stone', boundingBox: p.y >= 64 ? 'empty' : 'block' })
  }
  return { bot, calls }
}

test('escapeFire: в Аду ведро не льёт (вода испаряется) — сразу прыжок к полу', async () => {
  const { Director } = require('../src/director')
  const { bot, calls } = fireBot('the_nether')
  const d = new Director({ bot, cfg: {} as Record<string, any> })
  const r = await d.escapeFire()
  assert.equal(calls.includes('activate'), false, 'ведро воды в Аду пустеет без толку')
  assert.equal(r.detail.how, 'выпрыгнул к полу')
  const over = fireBot('overworld')
  const r2 = await new Director({ bot: over.bot, cfg: {} as Record<string, any> }).escapeFire()
  assert.equal(over.calls.includes('activate'), true)
  assert.equal(r2.detail.how, 'вода из ведра')
})

test('урон куста, кактуса и падения не рвёт работу, но приезжает с итогом; удар моба рвёт', async () => {
  const { EventBus } = require('../src/events')
  const bus = new EventBus()
  let woke = null
  const p = bus.nextInterrupt()
  p.then(ev => { woke = ev })
  bus.emit('damage', { health: 19, lost: 1, cause: 'sweet_berry_bush' })
  bus.emit('damage', { health: 18, lost: 1, cause: 'fall' })
  await new Promise<any>(resolve => setImmediate(resolve))
  assert.equal(woke, null, 'от куста не спасают ни бой, ни нора — идти дальше')
  bus.emit('damage', { health: 15, lost: 3, cause: 'mob_attack' })
  await new Promise<any>(resolve => setImmediate(resolve))
  assert.equal(woke && woke.cause, 'mob_attack')
  assert.deepEqual(bus.drain().map(e => e.cause), ['sweet_berry_bush', 'fall', 'mob_attack'])
  // Без типа — как раньше: рвёт.
  let woke2 = null
  bus.nextInterrupt().then(ev => { woke2 = ev })
  bus.emit('damage', { health: 14, lost: 1 })
  await new Promise<any>(resolve => setImmediate(resolve))
  assert.ok(woke2)
})

test('директор не запускает шаг, пока идёт аварийный отход (refuge в current или автопилот отпускает руки)', () => {
  const { Director } = require('../src/director')
  const session: Record<string, any> = { bot: {} as Record<string, any>, cfg: {} as Record<string, any>, current: null, autopilot: { refuging: false } }
  const d = new Director(session)
  assert.equal(d.refugeRuns(), false)
  session.current = { name: 'refuge', ctl: {} as Record<string, any>, byDirector: false }
  assert.equal(d.refugeRuns(), true)
  // mc_wait мозга поверх отхода: current — wait, но отход ещё идёт у автопилота.
  session.current = { name: 'wait', ctl: {} as Record<string, any> }
  session.autopilot.refuging = true
  assert.equal(d.brainHolds(), false)
  assert.equal(d.refugeRuns(), true, 'шаг директора оборвал бы отход')
  session.autopilot.refuging = false
  assert.equal(d.refugeRuns(), false)
})

test('аварийный отход будит ожидание (wait), но не рвёт работу со списком прерываний по умолчанию', async () => {
  const { EventBus, WAKES } = require('../src/events')
  const bus = new EventBus()
  let woke = null
  let work = null
  bus.nextInterrupt([...WAKES]).then(ev => { woke = ev })
  bus.nextInterrupt().then(ev => { work = ev })
  bus.emit('emergency', { hp: 7, from: 'zombie' })
  await new Promise<any>(resolve => setImmediate(resolve))
  assert.equal(woke && woke.type, 'emergency')
  assert.equal(work, null, 'работу отпускает сам автопилот (interruptFor), шина — нет')
})
