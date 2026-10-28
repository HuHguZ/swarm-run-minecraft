// Встречное копьё против тарана с элитр вне боя: копьё на изготовку заранее, путь и приказ — у дела.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

function scene(t, { spear = true, shield = false } = {}) {
  const threats = require('../src/threats'), locks = require('../src/reflex-lock')
  let now = 1000
  t.mock.method(require('../src/game-clock'), 'now', () => now)
  t.mock.method(threats, 'projectileDangers', () => ({ arrows: [], aims: [], potions: [] }))
  const keys: any = {}, goals: any[] = [], uses: any[] = [], looks: any[] = [], goal = { x: 0, y: 64, z: -20 }
  const item = { name: 'diamond_spear', type: 1, count: 1 }
  const bot: any = new EventEmitter()
  const clockState = { age: 1000n, serverTicks: 20 }
  Object.assign(bot, { entity: { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, metadata: {}, height: 1.8, width: .6 },
    registry: require('minecraft-data')('1.21.11'), ndClock: clockState, quickBarSlot: 0, heldItem: { name: 'diamond_sword' },
    health: 20, food: 20, entities: {}, inventory: { slots: { 45: shield ? { name: 'shield' } : null }, items: () => spear ? [item] : [] },
    _client: Object.assign(new EventEmitter(), { write() {} }),
    pathfinder: { goal, path: [], setGoal: p => goals.push(p) },
    equip: async it => { bot.heldItem = { name: it.name }; bot.emit('heldItemChanged') },
    look: async (yaw, pitch) => { looks.push([yaw, pitch]); bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    getControlState: k => !!keys[k], setControlState: (k, v) => { keys[k] = !!v }, clearControlStates() { for (const k of Object.keys(keys)) bot.setControlState(k, false) },
    activateItem(hand) { uses.push(['up', hand]); bot._ndUse = { cur: { hand: hand ? 1 : 0, name: hand ? 'shield' : bot.heldItem?.name } }; bot.usingHeldItem = true },
    deactivateItem() { uses.push(['down']); if (bot._ndUse) bot._ndUse.cur = null; bot.usingHeldItem = false },
    blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] }) })
  const current = { name: 'goto', params: goal, ctl: { aborted: false } }, session: any = { bot, current }
  locks.install(session)
  bot.setControlState('forward', true)
  const flags = bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  // Сервер подтверждает use копья и идут тики мира — часы заряда (bow/charge) видят задержку.
  const serverTick = () => {
    clockState.serverTicks++; clockState.age++
    if (bot._ndUse?.cur && bot._ndUse.cur.hand === 0) bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: flags, value: 1 }] })
    // update_time — раз в секунду, как у сервера: готовность копья (10 т.) по нему не увидеть.
    if (clockState.serverTicks % 20 === 0) bot._client.emit('update_time', {})
  }
  const tick = async () => { now += 50; serverTick(); bot.emit('physicTick'); await new Promise(r => setImmediate(r)) }
  const spawn = (z = -40) => {
    const metadata = Array(9).fill(0); metadata[flags >= 0 ? flags : 8] = 1
    const enemy: any = Object.assign(new EventEmitter(), { id: 2, type: 'player', name: 'player', username: 'Flyer',
      position: new Vec3(0, 64.5, z), velocity: new Vec3(0, 0, 0), height: .6, width: .6,
      yaw: Math.PI, pitch: 0, elytraFlying: true, isValid: true, metadata, equipment: [{ name: 'iron_spear' }] })
    bot.entities[enemy.id] = enemy
    session._ndFoes = ['Flyer']
    return enemy
  }
  return { bot, keys, goals, uses, looks, current, session, tick, spawn, goal }
}

test('летун с копьём идёт на меня — копьё на изготовку заранее, приказ и путь у дела', async t => {
  const f = scene(t)
  t.after(() => f.bot.emit('end'))
  const e = f.spawn()
  for (let i = 0; i < 3; i++) { e.position.z += 1.5; await f.tick() }
  assert.equal(f.bot.heldItem.name, 'diamond_spear', 'копьё в руку')
  assert.ok(f.uses.some(([w, h]) => w === 'up' && !h), 'копьё поднято (use главной руки)')
  assert.equal(f.session.current, f.current); assert.equal(f.current.ctl.aborted, false); assert.deepEqual(f.goals, [])
  // Готово (задержка алмазного 10 т.) и он близко — взгляд на него вместо бокового шага.
  for (let i = 0; i < 12; i++) { e.position.z += 1.5; await f.tick() }
  assert.ok(f.looks.length > 0, 'взгляд на летуна')
  const [yaw] = f.looks.at(-1)
  assert.ok(Math.abs(yaw) < .2, `смотрю на него (yaw 0 — на −z): ${yaw}`)
  assert.equal(!!(f.keys.left || f.keys.right), false, 'вместо шага — копьё к нему')
  // Улетел — копьё опущено.
  delete f.bot.entities[2]
  for (let i = 0; i < 25; i++) await f.tick()
  assert.ok(f.uses.some(([w]) => w === 'down'), 'копьё опущено')
})

test('в бою, без копья и со щитом — встречного копья нет', async t => {
  for (const mode of ['fight', 'nospear', 'shield']) {
    const f = scene(t, { spear: mode !== 'nospear', shield: mode === 'shield' })
    t.after(() => f.bot.emit('end'))
    if (mode === 'fight') f.current.name = 'fight'
    const e = f.spawn()
    for (let i = 0; i < 4; i++) { e.position.z += 1.5; await f.tick() }
    assert.equal(f.uses.some(([w, h]) => w === 'up' && !h), false, mode)
  }
})

test('уходящий поперёк летун копья не поднимает', async t => {
  const f = scene(t)
  t.after(() => f.bot.emit('end'))
  const e = f.spawn(-20)
  for (let i = 0; i < 4; i++) { e.position.x += 1.5; await f.tick() }
  assert.equal(f.bot.heldItem.name, 'diamond_sword')
  assert.deepEqual(f.uses, [])
})

test('готовое копьё ведёт взгляд на летуна и в прыжке пути', async t => {
  const f = scene(t)
  t.after(() => f.bot.emit('end'))
  const e = f.spawn(-60)
  for (let i = 0; i < 40; i++) { e.position.z += .75; await f.tick() }
  assert.ok(f.looks.every(([yaw]) => yaw === 0), 'далеко — курс остаётся у пути (только наклон)')
  f.bot.setControlState('jump', true); f.bot.entity.onGround = false
  const braced: any[] = []; f.bot.on('nd_guard_reflex', o => { if (o.how === 'spear') braced.push(o) })
  for (let i = 0; i < 16; i++) { e.position.z += 1.5; await f.tick() }
  assert.ok(braced.length > 0, 'в прыжке копьё к нему (встречный удар)')
})

test('в паутине (clear_web) копьё на изготовку — уйти с линии тарана нельзя', async t => {
  const f = scene(t)
  t.after(() => f.bot.emit('end'))
  f.current.name = 'clear_web'
  const e = f.spawn()
  for (let i = 0; i < 4; i++) { e.position.z += 1.5; await f.tick() }
  assert.ok(f.uses.some(([w, h]) => w === 'up' && !h), 'копьё поднято')
})

// cl28w–z: «убит с готовым копьём» — копьё опускалось до подлёта (ab: R → «-» за 12 бл.): луч копья смотрел вдоль пути, где свои,
// и сторож союзника (spear.teamSafe) снимал use. Пока летун далеко — наконечник вверх, к нему (только наклон: курс пути тот же).
test('поднятое копьё до подлёта смотрит наклоном на летуна, курс пути не трогает', async t => {
  const f = scene(t)
  t.after(() => f.bot.emit('end'))
  const e = f.spawn(-30); e.position.y = 80
  for (let i = 0; i < 6; i++) { e.position.z += .75; e.position.y -= .2; await f.tick() }
  assert.ok(f.uses.some(([w, h]) => w === 'up' && !h), 'копьё поднято')
  const look = f.looks.at(-1)
  assert.ok(look, 'наклон к нему задан')
  assert.equal(look[0], f.bot.entity.yaw, 'курс тот же')
  assert.ok(look[1] > .3, `наконечник вверх, к летуну: ${look[1]}`)
})
