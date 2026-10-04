'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')

function fixture (hp, current = null) {
  const file = path.join(__dirname, '../src/autopilot.js')
  const req = createRequire(file)
  const enemy = { id: 2, name: 'zombie', isValid: true, position: new Vec3(0, 64, 2) }
  const events = []; const calls = []
  const bot = { version: '1.21.11', health: hp, food: 20, entity: { position: new Vec3(0, 64, 0) },
    entities: { 2: enemy }, inventory: { items: () => [{ name: 'stone_sword', count: 1 }, { name: 'melon_slice', count: 9 }], slots: Array(46).fill(null) },
    nearestEntity: () => enemy }
  const context = { module: { exports: {} }, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === './combat' ? { ...req(name), retreat: async () => { calls.push('cover'); return {} } }
      : name === './combat-safety' ? { ...req(name), disengage: async () => { calls.push('run'); return { clear: true } } } : req(name) }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  const session = { bot, current, bus: { emit: (type, data) => events.push({ type, ...data }) } }
  return { auto: new context.module.exports.Autopilot(session, { lowHealth: 8 }), bot, events, calls }
}
test('фоновый рефлекс использует общий отход на 12 HP раньше старого порога 8', async () => {
  const { auto, bot, calls, events } = fixture(12)
  await auto.fleeIfDying(bot)
  assert.deepEqual(calls, ['run', 'cover'])
  assert.equal(events[0].threshold, 12)
})
test('здоровое тело продолжает работу, активному боевому намерению рефлекс не мешает', async () => {
  for (const f of [fixture(20), fixture(6, { name: 'blaze' })]) {
    await f.auto.fleeIfDying(f.bot)
    assert.deepEqual(f.calls, [])
  }
})

// Бой с драконом (30.09, агент «дракон»): у головы там бывает свой же блок (столб у
// клетки, вода ведра, подставка), а хп падает от облаков и крыльев — пара «голова в
// блоке + хп падает» обрывала бой на 4 хп (v2-26), следующий вызов — в облаке, смерть.
// Во время намерения dragon управление берётся только при настоящем удушье (in_wall).
function buriedFixture (current) {
  const file = path.join(__dirname, '../src/autopilot.js')
  const req = createRequire(file)
  const events = []
  let took = false
  const listeners = {}
  const bot = { version: '1.21.11', health: 10, food: 20, entity: { id: 7, position: new Vec3(0.5, 64, 0.5), effects: [] },
    entities: {}, inventory: { items: () => [], slots: Array(46).fill(null) },
    blockAt: p => (!took && Math.floor(p.y) === 65) ? { name: 'cobblestone', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p },
    _client: { on: (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f) } } }
  const context = { module: { exports: {} }, console, setTimeout, clearTimeout, setInterval, clearInterval, require: req }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  const session = { bot, current, bus: { emit: (type, data) => events.push({ type, ...data }) } }
  const auto = new context.module.exports.Autopilot(session, { lowHealth: 8 })
  auto.takeTheMouth = async () => { took = true }
  auto.lastHp = 14 // хп падает
  return { auto, bot, events, IN_WALL: context.module.exports.IN_WALL_DAMAGE, took: () => took, emit: (ev, pk) => (listeners[ev] || []).forEach(f => f(pk)) }
}
test('бой с драконом: блок у головы и падающее хп — не повод обрывать бой без удушья', async () => {
  const f = buriedFixture({ name: 'dragon', ctl: { abort () {} } })
  f.auto.hookDamage(f.bot)
  await f.auto.freeIfBuried(f.bot)
  assert.equal(f.took(), false, 'облако/крылья при блоке у головы — бой продолжается')
  // Настоящее удушье (in_wall) — выкапываться, как всегда.
  f.emit('damage_event', { entityId: 7, sourceTypeId: f.IN_WALL })
  f.auto.lastHp = 14
  await f.auto.freeIfBuried(f.bot)
  assert.equal(f.took(), true, 'in_wall — берём управление')
})
test('вне боя с драконом правило прежнее: блок у головы и падающее хп — выкапываться', async () => {
  const f = buriedFixture({ name: 'mine', ctl: { abort () {} } })
  await f.auto.freeIfBuried(f.bot)
  assert.equal(f.took(), true)
})
test('номер in_wall в автопилоте — тот же, что в реестре урона боя (1.21.11)', () => {
  const file = path.join(__dirname, '../src/autopilot.js')
  const context = { module: { exports: {} }, console, setTimeout, clearTimeout, setInterval, clearInterval, require: createRequire(file) }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  assert.equal(context.module.exports.IN_WALL_DAMAGE, require('../src/dragon').DAMAGE_TYPES.indexOf('in_wall'))
})

// EMERGENCY (H6, research/05-synthesis.md F.2/F.5): хп ≤ порога combat-safety и враг,
// который видит и дойдёт, — бросить дело и уйти в укрытие (survival.runRefuge).
// Самоохраняемые намерения (бастион, штрек Ада, бой…) не рвутся.
function emergencyFixture ({ hp = 6, current = null, zombieAt = 2, lastHurt = 'mob_attack', food = 20 } = {}) {
  const file = path.join(__dirname, '../src/autopilot.js')
  const req = createRequire(file)
  const enemy = { id: 2, name: 'zombie', isValid: true, position: new Vec3(0, 64, zombieAt), height: 1.95 }
  const events = []; const refuges = []; let aborted = 0
  const bot = { version: '1.21.11', health: hp, food, entity: { id: 1, position: new Vec3(0, 64, 0), metadata: [] },
    entities: { 2: enemy }, inventory: { items: () => [{ name: 'stone_sword', count: 1 }, { name: 'melon_slice', count: 9 }], slots: Array(46).fill(null) },
    nearestEntity: () => enemy, pathfinder: { setGoal () {} }, clearControlStates () {}, stopDigging () {} }
  const context = { module: { exports: {} }, console, setTimeout, clearTimeout, setInterval, clearInterval, process,
    require: name => name === './survival'
      ? { runRefuge: (s, p) => { refuges.push(p); return Promise.resolve({ status: 'done', detail: { how: 'box', code: 'OK', hp0: hp, hp: 17, healed: true }, events: [] }) } }
      : req(name) }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  const waiter = { got: null }
  const bus = { buffer: [], waiters: new Set([{ accepts: () => false, resolve: ev => { waiter.got = ev } }]),
    emit: (type, data) => { const ev = { seq: events.length + 1, type, ...data }; events.push(ev); return ev } }
  const cur = current ? { name: current, ctl: { abort () { aborted++ } } } : null
  const session = { bot, current: cur, bus }
  const auto = new context.module.exports.Autopilot(session, { lowHealth: 8 })
  auto.takeTheMouth = async () => { if (session.current && session.current.ctl) session.current.ctl.abort() }
  if (lastHurt) auto.lastHurt = { at: Date.now(), type: lastHurt, byMob: context.module.exports.MOB_DAMAGE.test(lastHurt) }
  return { auto, bot, events, refuges, waiter, aborted: () => aborted, session }
}

test('EMERGENCY не прерывает самоохраняемые: bastion, nether_tunnel, fight', async () => {
  for (const name of ['bastion', 'nether_tunnel', 'fight']) {
    const f = emergencyFixture({ current: name })
    await f.auto.emergency(f.bot)
    assert.equal(f.aborted(), 0, `${name} не рвётся`)
    assert.equal(f.refuges.length, 0, `${name}: отход не зовётся`)
  }
})

test('EMERGENCY прерывает mine, goto и копку норы (shelter): причина emergency, отход, событие', async () => {
  // shelter — не самоохраняемое (разбор смертей fresh-A1..A4: 17 из 98 — нора копалась у бьющего моба).
  for (const name of ['mine', 'goto', 'shelter']) {
    const f = emergencyFixture({ current: name })
    await f.auto.emergency(f.bot)
    assert.equal(f.aborted(), 1, `${name} прерван`)
    assert.equal(f.refuges.length, 1, 'отход запущен')
    assert.equal(f.waiter.got && f.waiter.got.type, 'emergency', 'прерванному — by: emergency')
    assert.equal(f.events[0].type, 'emergency')
    assert.equal(f.events[0].during, name)
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(f.events.some(e => e.type === 'refuge' && e.how === 'box' && e.healed), 'итог отхода — событием')
  }
})

test('EMERGENCY в простое тоже уходит в укрытие, ничего не прерывая', async () => {
  const f = emergencyFixture({ current: null })
  await f.auto.emergency(f.bot)
  assert.equal(f.refuges.length, 1)
  assert.equal(f.waiter.got, null)
})

test('EMERGENCY не по пустякам: хп выше порога, враг далеко после падения, дребезг', async () => {
  const healthy = emergencyFixture({ hp: 13, current: 'mine' })
  await healthy.auto.emergency(healthy.bot)
  assert.equal(healthy.refuges.length, 0, 'хп выше порога (не ниже 12: EMERGENCY.minHp)')
  // Порог размена одного зомби без брони — 8, но отход — с 12 (запас на стройку: fresh-A5, 6 хп — «прижали»).
  const twelve = emergencyFixture({ hp: 12, current: 'mine' })
  await twelve.auto.emergency(twelve.bot)
  assert.equal(twelve.refuges.length, 1, 'на 12 хп с зомби вплотную — отход')
  // Упал (не моб), зомби в 10 бл. — не повод; он же в 3 бл. — повод.
  const fall = emergencyFixture({ current: 'mine', lastHurt: 'fall', zombieAt: 10 })
  await fall.auto.emergency(fall.bot)
  assert.equal(fall.refuges.length, 0, 'урон от падения — не моб')
  const contact = emergencyFixture({ current: 'mine', lastHurt: 'fall', zombieAt: 3 })
  await contact.auto.emergency(contact.bot)
  assert.equal(contact.refuges.length, 1, 'моб вплотную — отход при любом прошлом уроне')
  // Гистерезис: после отхода — снова только когда хп поднялось до 16.
  const f = emergencyFixture({ current: 'mine' })
  await f.auto.emergency(f.bot)
  await new Promise(resolve => setImmediate(resolve))
  f.auto.emergencyAt = 0
  f.session.current = { name: 'mine', ctl: { abort () {} } }
  await f.auto.emergency(f.bot)
  assert.equal(f.refuges.length, 1, 'на тех же 6 хп второй раз не срабатывает')
  f.bot.health = 17
  await f.auto.emergency(f.bot)
  f.bot.health = 6
  await f.auto.emergency(f.bot)
  assert.equal(f.refuges.length, 2, 'после 16+ хп снова взведён')
})
