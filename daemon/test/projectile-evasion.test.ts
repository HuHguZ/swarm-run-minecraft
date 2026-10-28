// Уворот подмешивает клавиши к делу, не забирая цель и руки у его владельца.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

function scene(t, shield = false) {
  const threats = require('../src/threats'), locks = require('../src/reflex-lock')
  let now = 1000
  t.mock.method(require('../src/game-clock'), 'now', () => now)
  let danger: any = { arrows: [], aims: [], potions: [] }
  t.mock.method(threats, 'projectileDangers', () => danger)
  const keys: any = {}, goals: any[] = [], uses: any[] = [], goal = { x: 0, y: 64, z: -20 }, path = [{ x: 0, y: 64, z: -1 }]
  const bot: any = new EventEmitter()
  Object.assign(bot, { entity: { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, -.2), yaw: 0, pitch: 0, onGround: true, metadata: {} },
    registry: require('minecraft-data')('1.21.11'), ndClock: { age: 1000n, serverTicks: 20 },
    health: 20, food: 20, entities: {}, inventory: { slots: { 45: shield ? { name: 'shield' } : null }, items: () => [] },
    _client: Object.assign(new EventEmitter(), { write() {} }),
    pathfinder: { goal, path, setGoal: p => goals.push(p) },
    getControlState: k => !!keys[k], setControlState: (k, v) => { keys[k] = !!v }, clearControlStates() { for (const k of Object.keys(keys)) bot.setControlState(k, false) },
    activateItem(hand) { uses.push(['up', hand]); bot._ndUse = { cur: { hand: hand ? 1 : 0, name: hand ? 'shield' : 'bow' } }; bot.usingHeldItem = true },
    deactivateItem() { uses.push(['down']); bot._ndUse.cur = null; bot.usingHeldItem = false },
    blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] }) })
  const current = { name: 'goto', params: goal, ctl: { aborted: false } }, session: any = { bot, current }
  locks.install(session)
  bot.setControlState('forward', true)
  const arrow = { id: 4, name: 'arrow', ticks: 8, at: { x: 0, y: 65, z: 0 }, from: { x: 0, y: 65, z: -8 }, vel: { x: 0, y: 0, z: 1 }, side: { x: 1, z: 0 }, blockable: true }
  return { bot, keys, goals, uses, current, session, locks, arrow, goal, path,
    set: d => { danger = { arrows: [], aims: [], potions: [], ...d } }, tick: () => { now += 50; bot.emit('physicTick') } }
}

function glider(f, z = -20) {
  const flags = f.bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  const metadata = Array(9).fill(0); metadata[flags >= 0 ? flags : 8] = 1
  const enemy: any = Object.assign(new EventEmitter(), { id: 2, type: 'player', name: 'player', username: 'Flyer',
    position: new Vec3(0, 64.5, z), velocity: new Vec3(0, 0, 0), height: .6, width: .6,
    yaw: Math.PI, pitch: 0, elytraFlying: true, isValid: true, metadata, equipment: [{ name: 'iron_spear' }] })
  f.bot.entities[enemy.id] = enemy
  f.session._ndFoes = ['Flyer']
  f.tick()
  enemy.position.z += 1.5
  f.tick()
  return enemy
}

test('входящий летун при настоящем gotoGoal добавляет шаг без отмены пути', async t => {
  const f = scene(t)
  t.after(() => f.bot.emit('end'))
  const { gotoGoal } = require('../src/movement/goto')
  Object.assign(f.goal, { isEnd: () => false })
  const moving = gotoGoal(f.bot, f.goal)
  let done = false
  moving.then(() => { done = true })
  glider(f)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(f.keys.left || f.keys.right, 'телесный ответ на настоящий наблюдаемый таран')
  assert.equal(done, false)
  assert.equal(f.session.current, f.current); assert.equal(f.current.ctl.aborted, false)
  assert.equal(f.bot.pathfinder.goal, f.goal); assert.equal(f.bot.pathfinder.path, f.path)
  assert.deepEqual(f.goals, [f.goal])
  f.bot.setControlState('forward', false)
  delete f.bot.entities[2]; f.tick()
  assert.equal(f.keys.forward, false); assert.equal(f.keys.left, false); assert.equal(f.keys.right, false)
  f.bot.emit('goal_reached'); await moving
})

test('таран во время flee и heal не отбирает руки и приказ', t => {
  const f = scene(t)
  t.after(() => f.bot.emit('end'))
  const ownUse = { hand: 0, name: 'golden_apple', since: 1000 }
  f.bot._ndUse = { cur: ownUse }; f.bot.usingHeldItem = true
  for (const name of ['flee', 'heal']) {
    f.current.name = name
    glider(f)
    assert.ok(f.keys.left || f.keys.right)
    assert.equal(f.bot._ndUse.cur, ownUse); assert.deepEqual(f.uses, [])
    assert.equal(f.session.current, f.current); assert.equal(f.current.ctl.aborted, false); assert.deepEqual(f.goals, [])
    delete f.bot.entities[2]; f.tick()
  }
})

test('щит поднимается заранее к фронтальному тарану вне боя', t => {
  const f = scene(t, true)
  t.after(() => f.bot.emit('end'))
  glider(f)
  assert.deepEqual(f.uses, [['up', true]])
  f.tick(); f.tick()
  assert.deepEqual(f.uses, [['up', true]], 'не перезапускаем нативные пять тиков щита')
  f.bot.activateItem(false)
  delete f.bot.entities[2]
  for (let i = 0; i < 16; i++) f.tick()
  assert.equal(f.uses.some(([what]) => what === 'down'), false, 'чужое использование остаётся у дела')
})

test('входящий летун не меняет сторону каждый 300-мс период и уступает более ранней стреле', t => {
  const f = scene(t)
  t.after(() => f.bot.emit('end'))
  const enemy = glider(f)
  const left = f.keys.left
  for (let i = 0; i < 4; i++) { enemy.position.z += 1.5; f.tick(); assert.equal(f.keys.left, left); assert.ok(f.keys.left || f.keys.right) }
  f.set({ arrows: [{ ...f.arrow, ticks: 1 }] }); f.tick()
  assert.notEqual(f.keys.left, left, 'более ранний фактический снаряд выбирает другой безопасный шаг')
})

test('поздний или задний таран не начинает бесполезный подъём щита', t => {
  for (const z of [-8, 20]) {
    const f = scene(t, true)
    t.after(() => f.bot.emit('end'))
    glider(f, z)
    assert.deepEqual(f.uses, [])
  }
})

test('таран не подмешивает шаг в полёт, прыжок, клатч или опасную опору', t => {
  for (const mode of ['flight', 'takeoff', 'jump', 'hand', 'edge', 'web']) {
    const f = scene(t, true)
    t.after(() => f.bot.emit('end'))
    if (mode === 'flight') { f.bot.entity.elytraFlying = true; f.bot.entity.onGround = false }
    if (mode === 'takeoff') f.bot._ndElytra = { driving: 1 }
    if (mode === 'jump') f.bot.setControlState('jump', true)
    if (mode === 'hand') f.bot._ndHandLock = { on: () => true }
    if (mode === 'edge' || mode === 'web') {
      const block = f.bot.blockAt
      f.bot.blockAt = p => Math.abs(p.x) >= .5 ? { name: mode === 'web' && p.y >= 64 ? 'cobweb' : 'air',
        position: p.floored(), boundingBox: 'empty', shapes: [] } : block(p)
    }
    glider(f)
    assert.equal(!!f.keys.left || !!f.keys.right, false, mode)
    if (!['edge', 'web'].includes(mode)) assert.deepEqual(f.uses, [], mode)
    assert.equal(f.current.ctl.aborted, false); assert.deepEqual(f.goals, [])
  }
})

test('аварийный владелец прерывает только примесь от летуна и не возвращает старый ввод', async t => {
  const f = scene(t)
  t.after(() => f.bot.emit('end'))
  glider(f)
  assert.ok(f.keys.left || f.keys.right)
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  const pending = f.locks.start(f.session, () => { f.bot.setControlState('back', true); return gate }, { owner: 'Emergency', immediate: true })
  f.tick()
  assert.equal(f.keys.left, false); assert.equal(f.keys.right, false); assert.equal(f.keys.back, true)
  delete f.bot.entities[2]
  finish({}); await pending; f.tick()
  assert.equal(f.keys.forward, false); assert.equal(f.keys.left, false); assert.equal(f.keys.right, false)
})

test('реальный шаг от летуна сообщает один внутренний эпизод после применения клавиш', t => {
  const f = scene(t), reports = []
  t.after(() => f.bot.emit('end'))
  f.current.name = 'flee'
  f.bot.on('nd_guard_reflex', event => { assert.ok(f.keys.left || f.keys.right); reports.push(event) })
  const enemy = glider(f)
  assert.equal(reports.length, 1)
  assert.deepEqual(Object.fromEntries(['source', 'id', 'during', 'how'].map(k => [k, reports[0][k]])),
    { source: 'incoming_glider', id: 2, during: 'flee', how: 'step' })
  assert.ok(reports[0].eta >= 0 && reports[0].eta <= 12)
  for (let i = 0; i < 4; i++) { enemy.position.z += 1.5; f.tick() }
  assert.equal(reports.length, 1, 'одна продолжающаяся атака не пишет событие каждый тик')
  delete f.bot.entities[2]; f.tick()
  glider(f)
  assert.equal(reports.length, 2, 'следующий наблюдаемый заход — новый эпизод')
})

test('внутреннее событие щита требует реального собственного use, а не одной угрозы', t => {
  const f = scene(t, true), reports = [], block = f.bot.blockAt
  t.after(() => f.bot.emit('end'))
  f.bot.blockAt = p => Math.abs(p.x) >= .5 ? { name: 'air', position: p.floored(), boundingBox: 'empty', shapes: [] } : block(p)
  f.bot.on('nd_guard_reflex', event => { assert.deepEqual(f.uses, [['up', true]]); reports.push(event) })
  glider(f)
  assert.equal(!!f.keys.left || !!f.keys.right, false)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].how, 'shield')
  f.tick(); assert.equal(reports.length, 1)
})

test('снаряд при goto добавляет боковой шаг и сохраняет путь, цель и новые клавиши дела', t => {
  const f = scene(t)
  f.set({ arrows: [f.arrow] }); f.tick()
  assert.ok(f.keys.left || f.keys.right)
  assert.equal(f.keys.forward, true)
  assert.equal(f.bot.pathfinder.goal, f.goal); assert.equal(f.bot.pathfinder.path, f.path)
  assert.deepEqual(f.goals, []); assert.equal(f.session.current, f.current); assert.equal(f.current.ctl.aborted, false)
  f.bot.setControlState('left', false); f.bot.setControlState('right', false)
  assert.ok(f.keys.left || f.keys.right, 'поздний callback pathfinder не гасит примесь')
  f.bot.setControlState('forward', false)
  f.set({}); f.tick()
  assert.equal(f.keys.left, false); assert.equal(f.keys.right, false); assert.equal(f.keys.forward, false, 'не восстанавливаем старое намерение')
})

test('натянутый лук не отменяет лестницу, бой или подбор', t => {
  const f = scene(t)
  for (const name of ['ladder_up', 'fight', 'assist']) {
    f.current.name = name
    f.set({ aims: [{ id: 2, name: 'Foe', weapon: 'bow', at: { x: 0, y: 68, z: -9 }, side: { x: 1, z: 0 } }] }); f.tick()
    assert.ok(f.keys.left || f.keys.right)
    assert.equal(f.current.ctl.aborted, false); assert.deepEqual(f.goals, [])
  }
})

test('боковой шаг и его диагональ не ведут в лаву или с края, путь продолжает идти', t => {
  const f = scene(t)
  f.bot.blockAt = p => ({ name: p.y < 64 ? (Math.abs(p.x) >= .5 ? 'lava' : 'stone') : 'air', boundingBox: p.y < 64 && Math.abs(p.x) < .5 ? 'block' : 'empty', position: p.floored() })
  f.set({ arrows: [f.arrow] }); f.tick()
  assert.equal(!!f.keys.left || !!f.keys.right, false)
  assert.equal(f.keys.forward, true); assert.deepEqual(f.goals, [])
})

test('готовый щит поднимается один раз к фронтальному снаряду и уступает чужому use', t => {
  const f = scene(t, true)
  f.set({ arrows: [f.arrow] }); f.tick(); f.tick(); f.tick()
  assert.deepEqual(f.uses, [['up', true]], 'нативный подъём не начинается заново каждый тик')
  assert.equal(f.keys.forward, true); assert.deepEqual(f.goals, [])
  f.bot.activateItem(false)
  f.set({}); f.tick()
  assert.equal(f.uses.some(([what]) => what === 'down'), false, 'окончание пассивного щита не опускает новый лук')
})

test('более раннее зелье не скрывает следующую фронтальную стрелу от щита', t => {
  const f = scene(t, true)
  f.set({ arrows: [f.arrow], potions: [{ ...f.arrow, id: 5, name: 'splash_potion', blockable: false, ticks: 7 }] }); f.tick()
  assert.deepEqual(f.uses, [['up', true]])
})

test('после пролёта отпускается только свой щит; конец соединения очищает примесь', t => {
  const f = scene(t, true)
  f.set({ arrows: [f.arrow] }); f.tick()
  f.set({}); for (let i = 0; i < 12; i++) f.tick()
  assert.deepEqual(f.uses, [['up', true], ['down']])
  f.bot.emit('end')
  assert.equal(f.bot.listenerCount('physicTick'), 0)
  assert.ok(Object.values(f.keys).every(v => !v))
  assert.deepEqual(f.uses, [['up', true], ['down']])
  assert.equal(f.bot._client.listenerCount('set_cooldown'), 0)
})

test('нативный откат щита не удерживает ложный блок и не запускает подъём каждый тик', t => {
  const f = scene(t, true)
  f.set({ arrows: [f.arrow] }); f.tick()
  f.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:shield', cooldownTicks: 100 })
  for (let i = 0; i < 10; i++) f.tick()
  assert.deepEqual(f.uses, [['up', true], ['down']])
  assert.equal(f.keys.forward, true); assert.deepEqual(f.goals, [])
  f.bot.emit('end')
})

test('настоящий gotoGoal остаётся ожидающим на том же пути до его достижения', async t => {
  const f = scene(t)
  const { gotoGoal } = require('../src/movement/goto')
  Object.assign(f.goal, { isEnd: () => false })
  const moving = gotoGoal(f.bot, f.goal)
  let done = false
  moving.then(() => { done = true })
  f.set({ arrows: [f.arrow] }); f.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(f.keys.left || f.keys.right)
  assert.equal(done, false); assert.deepEqual(f.goals, [f.goal])
  assert.equal(f.bot.pathfinder.goal, f.goal); assert.equal(f.bot.pathfinder.path, f.path)
  f.bot.emit('goal_reached')
  await moving
  assert.equal(done, true)
})

test('спринт-прыжок проверяет стену до полной дистанции, сохраняя обычный шаг', t => {
  const f = scene(t), block = f.bot.blockAt
  f.bot.blockAt = p => p.z <= -1.2 && p.y >= 64 && p.y <= 65
    ? { name: 'stone', boundingBox: 'block', position: p.floored() } : block(p)
  f.set({ arrows: [{ ...f.arrow, side: { x: 0, z: 1 }, vel: { x: 1, y: 0, z: 0 } }] }); f.tick()
  assert.ok(f.keys.left || f.keys.right)
  assert.equal(!!f.keys.sprint, false); assert.equal(!!f.keys.jump, false)
})

test('боковой рывок не запускает прыжок без доказанного места посадки на пути', t => {
  const f = scene(t), block = f.bot.blockAt
  f.bot.blockAt = p => p.z < -2 && p.y < 64
    ? { name: 'air', boundingBox: 'empty', position: p.floored() } : block(p)
  f.set({ arrows: [{ ...f.arrow, side: { x: 0, z: 1 }, vel: { x: 1, y: 0, z: 0 } }] }); f.tick()
  assert.ok(f.keys.left || f.keys.right)
  assert.equal(f.keys.sprint, true)
  assert.equal(!!f.keys.jump, false)
})

test('аварийный владелец сразу снимает примесь, завершение не возвращает старые клавиши', async t => {
  const f = scene(t)
  f.set({ arrows: [f.arrow] }); f.tick()
  assert.ok(f.keys.left || f.keys.right)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const pending = f.locks.start(f.session, () => { f.bot.setControlState('back', true); return gate }, { owner: 'Emergency', immediate: true })
  f.tick()
  assert.equal(f.keys.left, false); assert.equal(f.keys.right, false); assert.equal(f.keys.forward, false)
  assert.equal(f.keys.back, true)
  release({}); await pending
  f.set({}); f.tick()
  assert.equal(f.keys.forward, false); assert.equal(f.keys.left, false); assert.equal(f.keys.right, false)
})


test('ошибка подъёма щита закрывает наблюдателя и сохраняет ход дела', t => {
  const f = scene(t, true)
  let closed = 0
  t.mock.method(require('../src/bow/charge'), 'observeCharge', () => ({ start() { throw new Error('сеть закрыта') }, close() { closed++ } }))
  f.set({ arrows: [f.arrow] }); f.tick()
  assert.equal(closed, 1)
  assert.equal(f.keys.forward, true); assert.deepEqual(f.goals, [])
})
