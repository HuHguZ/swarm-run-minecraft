'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { Physics, PlayerState } = require('prismarine-physics')
const data = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')('1.21.11')
const pick = require('../src/pick')
const clutch = require('../src/clutch')
const IDLE = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
function block (name, p) {
  const b = Block.fromStateId(data.blocksByName[name].defaultState, 0)
  b.position = p.floored()
  return b
}
function model (terrain) {
  const cells = new Map()
  const world = { getBlock: p => cells.get(key(p)) || block(terrain(p.floored()), p), set: (p, name) => cells.set(key(p), block(name, p)) }
  const physics = Physics(data, world)
  const api = clutch.create({ Vec3, faceAim: pick.faceAim, simulate: (s, w) => physics.simulatePlayer(s, w), makeBlock: p => block('cobblestone', p) })
  return { world, physics, api }
}
function state (p, v = new Vec3(0, 0, 0)) {
  return { pos: p, vel: v, onGround: false, isInWater: false, isInLava: false, isInWeb: false,
    isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, jumpTicks: 0, jumpQueued: false,
    fireworkRocketDuration: 0, attributes: {} as Record<string, any>, yaw: 0, pitch: 0, control: { ...IDLE }, jumpBoost: 0, speed: 0,
    slowness: 0, dolphinsGrace: 0, slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false }
}
function flight (m, s, ticks = 60) {
  let peak = s.pos.y; let low = s.pos.y; const plans = []
  for (let t = 0; t < ticks; t++) {
    peak = Math.max(peak, s.pos.y)
    const p = m.api.plan({ state: s, world: m.world, peak, blockCount: 3 - plans.length })
    if (p) {
      assert.ok(p.cell.y + 1 <= s.pos.y + 1e-9, 'блок ниже ног на сервере')
      assert.ok(pick.faceAim({ entity: { position: s.pos }, entities: {} as Record<string, any>, blockAt: q => m.world.getBlock(q) }, p.ref, p.face, { eye: s.pos.offset(0, 1.62, 0) }))
      m.world.set(p.cell, 'cobblestone'); plans.push(p)
      s.control = { ...p.control }; s.yaw = p.yaw
    }
    m.physics.simulatePlayer(s, m.world)
    low = Math.min(low, s.pos.y); peak = Math.max(peak, s.pos.y)
    if (s.onGround) return { y: s.pos.y, fall: peak - s.pos.y, plans, low, t: t + 1 }
  }
  return { y: s.pos.y, fall: peak - s.pos.y, plans, low, t: ticks }
}
for (const h of [8, 20, 30]) test(`стена, падение ${h}: ранняя боковая грань, посадка <=3`, () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const s = state(new Vec3(0.5, h, 0.5))
  const r = flight(m, s)
  assert.ok(r.plans.length >= 1)
  assert.equal(r.plans[0].face.x, 1)
  assert.ok(r.fall <= 3, JSON.stringify(r))
})
test('край, скорость (0.4,0.4,0): видимая цепочка <=3 блоков держит высоту', () => {
  const m = model(p => p.x <= 0 && p.y === 19 || p.y < 0 ? 'stone' : 'air')
  const s = state(new Vec3(0.85, 20, 0.5), new Vec3(0.4, 0.4, 0))
  const r = flight(m, s)
  assert.ok(r.plans.length >= 1 && r.plans.length <= 3)
  assert.ok(r.low >= 17 && r.fall <= 3, JSON.stringify(r))
})
test('стена за стеклом: луч не позволяет кликнуть сквозь контур', () => {
  const m = model(p => p.x === -1 ? 'stone' : p.x === 0 ? 'glass' : 'air')
  const s = state(new Vec3(1.5, 20, 0.5))
  // Изолируем невидимую каменную грань: стекло не разрешаем как опору.
  const p = m.api.plan({ state: s, world: m.world, peak: 20, canReference: b => b.name === 'stone' })
  assert.equal(p, null)
})
test('клетка пересекает тело по последней позиции сервера: отказ', () => {
  const m = model(p => p.x === -1 ? 'stone' : 'air')
  const s = state(new Vec3(0.5, 10.8, 0.5))
  const p = m.api.plan({ state: s, world: m.world, serverPos: new Vec3(0.5, 9.8, 0.5), peak: 11 })
  assert.ok(!p || !clutch.intersects(p.cell, new Vec3(0.5, 9.8, 0.5)))
  assert.equal(clutch.intersects(new Vec3(0, 9, 0), new Vec3(0.5, 10, 0.5)), false, 'касание верха допустимо')
  assert.equal(clutch.intersects(new Vec3(0, 10, 0), new Vec3(0.5, 10.8, 0.5)), true)
})
test('выбор воды/клатча/ничего и намеренный спуск', () => {
  const a = { peak: 20, feet: 20, landing: { top: 0 }, blocks: 8, hasBucketBar: true, dimension: 'minecraft:overworld' }
  assert.equal(clutch.decide(a).action, 'water')
  assert.equal(clutch.decide({ ...a, dimension: 'minecraft:the_nether' }).action, 'clutch')
  assert.equal(clutch.decide({ ...a, hasBucketBar: false, blocks: 0 }).action, 'none')
  assert.equal(clutch.decide({ ...a, intentional: true }).action, 'none')
  assert.equal(clutch.decide({ ...a, guardAllow: true }).action, 'none')
  for (const landing of [{ top: 0, bad: true }, { top: 0, lava: true }, { top: -Infinity }, { top: 0, water: true, deep: true }]) {
    assert.equal(clutch.decide({ ...a, landing }).action, 'clutch')
  }
  assert.equal(clutch.decide({ ...a, landing: { top: 0, water: true } }).action, 'none')
  assert.equal(clutch.decide({ ...a, waterTooLate: true }).action, 'clutch')
  assert.equal(clutch.decide({ ...a, hasBucketBar: false, bucketReadyIn: 2, ticksToWater: 10 }).action, 'water')
  assert.equal(clutch.decide({ ...a, hasBucketBar: false, bucketReadyIn: 12, ticksToWater: 10 }).action, 'clutch')
  assert.equal(clutch.decide({ ...a, landing: { top: 15 } }).action, 'clutch', 'minFall=6: вода не спасает обычный спуск5')
  assert.equal(clutch.decide({ ...a, landing: { top: 15 }, hp: 2 }).action, 'water', 'штатный guard спасает и раньше при угрозе смерти')
  assert.equal(clutch.decide({ ...a, waterEligible: false }).action, 'clutch')
})
test('только полные негравитационные блоки, запас по умолчанию 0', () => {
  const slots = []
  slots[36] = { name: 'sand', count: 64, slot: 36 }
  slots[37] = { name: 'gravel', count: 64, slot: 37 }
  slots[38] = { name: 'cobblestone', count: 3, slot: 38 }
  assert.equal(clutch.selectBlock(slots).slot, 38)
  assert.equal(clutch.selectBlock(slots, 3), null)
  assert.equal(clutch.selectBlock(slots.slice(0, 38)), null)
})
test('поздний клатч уменьшает падение, не объявляет его безвредным', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const s = state(new Vec3(0.5, 15.1, 0.5), new Vec3(0, -1.2, 0))
  const p = m.api.plan({ state: s, world: m.world, peak: 20 })
  assert.ok(p && p.fall >= 5 && p.fall < 7)
})
test('снег 2 слоя не заменяется обычным кубом, 1 слой заменяется', () => {
  const m = model(p => p.x === -1 ? 'stone' : 'air')
  const p = new Vec3(0, 19, 0)
  let snow = Block.fromProperties(data.blocksByName.snow.id, { layers: 2 }, 0); snow.position = p
  m.world.getBlock = q => key(q) === key(p) ? snow : block(q.x < 0 ? 'stone' : 'air', q)
  const s = state(new Vec3(0.5, 20, 0.5))
  assert.equal(m.api.candidates(s, m.world).some(c => c.cell.equals(p)), false)
  snow = Block.fromProperties(data.blocksByName.snow.id, { layers: 1 }, 0); snow.position = p
  assert.equal(m.api.candidates(s, m.world).some(c => c.cell.equals(p)), true)
})
test('своя рамка в entities не закрывает прицел; чужая рамка в цели запрещает клетку', () => {
  const m = model(p => p.x === -1 ? 'stone' : 'air')
  const s = state(new Vec3(0.5, 20, 0.5))
  const me = { id: 7, name: 'player', position: s.pos, height: 1.8, width: 0.6 }
  assert.ok(m.api.plan({ state: s, world: m.world, peak: 20, entities: { 7: me }, selfId: 7 }))
  const cow = { id: 8, name: 'cow', position: new Vec3(0.5, 19, 0.5), height: 1.4, width: 0.9 }
  assert.equal(m.api.candidates(s, m.world, { entities: { 7: me, 8: cow }, selfId: 7 }).some(p => p.cell.equals(new Vec3(0, 19, 0))), false)
})
function fakeBot (m, s, inventory = [{ name: 'cobblestone', count: 8, slot: 38 }]) {
  const bot = new EventEmitter(); bot._client = new EventEmitter(); bot.inventory = new EventEmitter()
  bot.inventory.slots = []; for (const i of inventory) bot.inventory.slots[i.slot] = i
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  bot.entity = { position: s.pos.clone(), velocity: s.vel.clone(), onGround: s.onGround, yaw: 0, pitch: 0, effects: {} as Record<string, any>, attributes: {} as Record<string, any> }
  bot.version = '1.21.11'; bot.health = 20; bot.game = { dimension: 'minecraft:the_nether', gameMode: 'survival' }
  bot.quickBarSlot = 0; bot.physics = m.physics; bot.registry = data
  bot.blockAt = p => m.world.getBlock(p); bot.entities = {} as Record<string, any>
  bot.world = { setBlockStateId: (p, id) => { const b = Block.fromStateId(id, 0); b.position = p.floored(); m.world.set(p, b.name) } }
  bot.packets = []
  // Клавиши — как в mineflayer (lib/plugins/physics.js): геттеры без enumerable, так что
  // { ...bot.controlState } — пустой объект (ферма 30.09, clutch-dbg3: x/z прогноза — NaN).
  const cs = { ...IDLE }
  bot.controlState = {} as Record<string, any>
  for (const k of Object.keys(cs)) Object.defineProperty(bot.controlState, k, { get: () => cs[k], set: v => { cs[k] = v } })
  bot.getControlState = k => cs[k]
  bot.setControlState = (k, v) => { cs[k] = v }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.setQuickBarSlot = slot => { bot.quickBarSlot = slot; bot.packets.push('slot') }
  bot._genericPlace = async (ref, face, opts) => { bot.packets.push('place'); bot.lastPlace = { ref, face, opts } }
  bot._client.on('block_change', p => bot.world.setBlockStateId(new Vec3(p.location.x, p.location.y, p.location.z), p.type))
  bot._client.write = (name, packet) => { bot.packets.push(name) }
  return bot
}
function installFake (m, s, extra: any = {} as Record<string, any>) {
  const bot = fakeBot(m, s, extra.inventory)
  const hand = { hold () {}, on: () => false, as: fn => fn() }
  const guard = clutch.install({ bot }, { Vec3, PlayerState, faceAim: pick.faceAim, makeBlock: p => block('cobblestone', p), hand, ...extra })
  return { bot, guard }
}

test('shared fall steering rescues into observed existing water without a bucket or block', () => {
  const m = model(p => p.y < 0 ? 'stone' : p.x === 0 && p.y === 0 && p.z === 0 ? 'water' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(.9, 45, .4), new Vec3(.09, -.3, -.035)), { inventory: [], prepare: false })
  bot.game.dimension = 'minecraft:overworld'
  bot.world.raycast = (from, direction, max, match) => {
    for (let distance = 0; distance <= max; distance += .05) {
      const block = m.world.getBlock(from.plus(direction.scaled(distance)))
      if (match(block, { intersect: shapes => shapes.length > 0 })) return block
    }
    return null
  }
  try {
    for (let tick = 0; tick < 150 && !guard.stats.water_saved; tick++) {
      bot.emit('physicsTick')
      const next = new PlayerState(bot, bot.controlState); m.physics.simulatePlayer(next, m.world); next.apply(bot)
    }
    assert.equal(guard.stats.water_plans, 1, 'one forecast owns the whole falling trajectory')
    assert.equal(guard.stats.water_saved, 1, 'actual tick samples confirm free-body water entry')
    assert.equal(guard.stats.water_failed, 0)
    assert.equal(bot.packets.includes('place'), false, 'rescue consumes neither blocks nor a bucket')
    assert.equal(bot.health, 20)
    assert.ok(bot.entity.isInWater)
    assert.ok(bot.entity.position.x < .7 && bot.entity.position.x > .3)
    assert.equal(guard.steering, null, 'the existing owner releases its keys after actual completion')
  } finally { guard.stop() }
})

test('existing clutch forecast exposes a fresh lava top without a second simulation owner and clears on spawn', () => {
  const m = model(p => p.y === 0 ? 'lava' : p.y < 0 ? 'stone' : 'air')
  let now = 250
  const { bot, guard } = installFake(m, state(new Vec3(.5, 20, .5), new Vec3(0, -.3, 0)), { inventory: [], existingWater: false, prepare: false, now: () => now })
  try {
    bot.emit('physicsTick')
    assert.equal(guard.forecast.landing.lava, true)
    assert.equal(guard.forecast.landing.top, 1)
    assert.deepEqual(guard.forecast.from, bot.entity.position)
    assert.equal(guard.forecast.at, 250); assert.equal(guard.forecast.ground, false); assert.equal(guard.forecast.vy, -.3)
    bot.entity.position.x = 1
    assert.equal(guard.forecast.from.x, .5, 'the receipt is a snapshot, not a mutable entity reference')
    now = 300; bot._ndClutchAllowUntil = 1000; bot.emit('physicsTick')
    assert.equal(guard.forecast.guardAllow, true); assert.equal(guard.forecast.excluded, true)
    bot.emit('spawn'); assert.equal(guard.forecast, null)
  } finally { guard.stop() }
})

test('clutch does not reforecast supported or already validated motion, but resumes immediately after drift', () => {
  const m = model(p => p.y < 0 ? 'stone' : 'air')
  let frames = 0
  const initial = state(new Vec3(.5, 1, .5)); initial.onGround = true
  const { bot, guard } = installFake(m, initial, { inventory: [], prepare: false, existingWater: false, now: () => 100,
    simulate: (s, w) => { frames++; return m.physics.simulatePlayer(s, w) } })
  try {
    bot.emit('physicsTick'); assert.equal(frames, 0, 'grounded motion cannot need an airborne rescue forecast')
    bot.entity.onGround = false; bot.entity.position.y = 20
    bot._ndParkourForecast = { from: bot.entity.position.clone(), next: bot.entity.position.clone(), hp: 20, until: 200 }
    bot.emit('physicsTick'); assert.equal(frames, 0, 'a confirmed native movement plan already owns its forecast')
    assert.equal(guard.forecast.guardAllow, true)
    bot._ndParkourForecast.next.x += 1
    bot.emit('physicsTick'); assert.equal(frames, 0, 'later listeners may observe the current endpoint after the controller prepared its next native tick')
    bot.entity.position.x += .2; bot.emit('physicsTick')
    assert.ok(frames > 0); assert.equal(guard.forecast.guardAllow, false)
  } finally { guard.stop() }
})

test('existing-water rescue hands a divergent flight back to the original fall guard once', () => {
  const m = model(p => p.y < 0 ? 'stone' : p.x === 0 && p.y === 0 && p.z === 0 ? 'water' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(.5, 20, .5), new Vec3(0, -.3, 0)), { inventory: [], prepare: false })
  bot.game.dimension = 'minecraft:overworld'
  bot.world.raycast = () => m.world.getBlock(new Vec3(0, 0, 0))
  try {
    bot.emit('physicsTick'); assert.equal(guard.lastDecision.why, 'existing_water')
    bot.entity.position.x += 2
    bot.emit('physicsTick')
    assert.equal(guard.stats.water_failed, 1)
    assert.equal(guard.waterPlan, null)
    assert.equal(guard.steering, null)
    bot.emit('physicsTick'); assert.equal(guard.stats.water_plans, 1, 'an invalid airborne forecast is not repeatedly rebuilt')
  } finally { guard.stop() }
})

test('ordinary launch hands off idle previous keys and does not walk out of a waterlogged crystal after rescue', async () => {
  const m = model(p => p.y < 0 || p.x === -2 && p.y === 44 && p.z === 0 ? 'stone' : 'air')
  const crystal = Block.fromProperties(data.blocksByName.amethyst_cluster.id, { facing: 'up', waterlogged: true }, 0)
  crystal.position = new Vec3(0, 0, 0)
  const read = m.world.getBlock
  m.world.getBlock = p => key(p) === '0,0,0' ? crystal : read(p)
  const initial = state(new Vec3(-.8, 45, .5), new Vec3(0, -.0784000015258789, 0)); initial.onGround = true
  const { bot, guard } = installFake(m, initial, { inventory: [], prepare: false })
  bot.game.dimension = 'minecraft:overworld'; bot.world.raycast = () => crystal
  bot.clearControlStates = () => { for (const key of Object.keys(IDLE)) bot.setControlState(key, false) }
  bot.waitForTicks = async (ticks) => {
    for (let tick = 0; tick < ticks; tick++) {
      const next = new PlayerState(bot, bot.controlState); m.physics.simulatePlayer(next, m.world); next.apply(bot)
      bot.emit('physicsTick')
    }
  }
  try {
    const result = await require('../src/navigation/parkour').enterWater(bot, { aborted: false }, crystal.position, 160, undefined, true)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(guard.stats.water_saved, 1)
    assert.equal(bot.getControlState('forward'), false, 'the launch input must not become post-rescue motion')
    await bot.waitForTicks(20)
    assert.equal(bot.entity.isInWater, true)
    assert.equal(bot.entity.position.y, .4375)
    assert.equal(guard.stats.water_failed, 0)
  } finally { guard.stop() }
})

test('ускоренные часы: готовое ведро проверяется по игровому barAt', () => {
  const gameClock = require('../src/game-clock')
  const clock = new gameClock.GameClock({ manual: true })
  gameClock.activate(clock)
  clock.advanceTicks(2000)
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), {
    inventory: [{ name: 'water_bucket', count: 1, slot: 36 }, { name: 'cobblestone', count: 8, slot: 38 }]
  })
  try {
    bot.game.dimension = 'minecraft:overworld'
    bot._ndFallGuard = { peak: null, barAt: gameClock.now() }
    clock.advanceTicks(6)
    bot.emit('physicsTick'); bot.emit('move')
    assert.equal(guard.lastDecision.action, 'water')
    assert.equal(bot.packets.includes('place'), false)
  } finally {
    guard.stop()
    clock.dispose()
    gameClock.activate(null)
  }
})
test('сторож: position -> look -> slot -> place, prediction до следующей физики', async () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)))
  bot.emit('physicsTick')
  assert.equal(bot.packets.includes('place'), false)
  bot.packets.push('position'); bot.emit('move')
  assert.deepEqual(bot.packets, ['position', 'look', 'slot', 'place'])
  assert.equal(m.world.getBlock(new Vec3(0, 19, 0)).name, 'cobblestone')
  const s = new PlayerState(bot, bot.controlState); m.physics.simulatePlayer(s, m.world); m.physics.simulatePlayer(s, m.world)
  assert.equal(s.onGround, true)
  assert.equal(s.pos.y, 20)
  guard.stop()
})
test('отказ block_change восстанавливает воздух; timeout не оставляет фантом', () => {
  let now = 0
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), { now: () => now })
  bot.emit('physicsTick'); bot.emit('move')
  bot._client.emit('block_change', { location: new Vec3(0, 19, 0), type: data.blocksByName.air.defaultState })
  assert.equal(guard.stats.denied, 1)
  assert.equal(m.world.getBlock(new Vec3(0, 19, 0)).name, 'air')
  now += 2000; bot.emit('physicsTick') // same denied cell is backed off briefly; timer tick expires predictions
  bot.emit('move'); now += 2000; guard.expire()
  assert.equal(guard.pending.size, 0)
  assert.equal(m.world.getBlock(new Vec3(0, 19, 0)).name, 'air')
  guard.stop()
})
test('сдвиг тела между physicsTick и callback отменяет устаревший клик', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)))
  bot.emit('physicsTick'); bot.entity.position.y = 19.8; bot.emit('move')
  assert.equal(bot.packets.includes('place'), false)
  guard.stop()
})
test('верхний мир + хорошая посадка + ведро: сторож не забирает руку', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), { inventory: [
    { name: 'water_bucket', count: 1, slot: 36 }, { name: 'cobblestone', count: 8, slot: 38 }
  ] })
  bot.game.dimension = 'minecraft:overworld'
  bot._ndFallGuard = { peak: null }
  bot.emit('physicsTick'); bot.emit('move')
  assert.equal(bot.packets.includes('place'), false)
  assert.equal(guard.lastDecision.action, 'water')
  guard.stop()
})
test('ни sand ни отсутствие filler не вызывают установку', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), { inventory: [{ name: 'sand', count: 64, slot: 38 }] })
  bot.emit('physicsTick'); bot.emit('move')
  assert.equal(bot.packets.includes('place'), false)
  assert.equal(guard.lastDecision.action, 'none')
  guard.stop()
})
test('полный установщик: simulate -> physicsTick -> position -> move, край .4+.4', () => {
  const m = model(p => p.x <= 0 && p.y === 19 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.85, 20, 0.5), new Vec3(0.4, 0.4, 0)), { inventory: [
    { name: 'cobblestone', count: 1, slot: 36 }, { name: 'dirt', count: 1, slot: 37 }, { name: 'netherrack', count: 1, slot: 38 }
  ] })
  let low = 20; let landed = false
  for (let t = 0; t < 40; t++) {
    new PlayerState(bot, bot.controlState).apply(bot) // real PlayerState compatibility
    const s = new PlayerState(bot, bot.controlState); m.physics.simulatePlayer(s, m.world); s.apply(bot)
    low = Math.min(low, s.pos.y)
    bot.emit('physicsTick'); bot.packets.push('position'); bot.emit('move')
    for (const p of [...guard.pending.values()]) {
      bot._client.emit('block_change', { location: p.cell, type: p.stateId })
      const old = bot.inventory.slots[p.slot]
      bot.inventory.slots[p.slot] = null; bot.inventory.emit('updateSlot', p.slot, old, null)
    }
    if (s.onGround) { landed = true; break }
  }
  assert.equal(landed, true)
  assert.ok(low >= 17)
  assert.ok(guard.stats.placed >= 1 && guard.stats.placed <= 3)
  assert.equal(guard.pending.size, 0)
  guard.stop()
})
test('посадка снимает принадлежащее сторожу управление', () => {
  let now = 0
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), { now: () => now })
  bot.controlState.forward = true
  bot.emit('physicsTick'); bot.emit('move')
  bot.entity.onGround = true; bot.emit('physicsTick')
  assert.equal(bot.controlState.forward, true)
  guard.stop()
})
test('ошибка отправки не считается спасением даже при неизменном hp', async () => {
  let now = 0
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), { now: () => now })
  bot._genericPlace = async () => { throw new Error('send failed') }
  bot.emit('physicsTick'); bot.emit('move'); await Promise.resolve(); await Promise.resolve()
  bot.entity.onGround = true; bot.emit('physicsTick'); now = 350; bot.emit('physicsTick')
  assert.equal(guard.stats.saved, 0)
  guard.stop()
})
test('подтверждение блока не является спасением, если тело село на другую землю', () => {
  let now = 0
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), { now: () => now })
  bot.emit('physicsTick'); bot.emit('move')
  for (const p of [...guard.pending.values()]) bot._client.emit('block_change', { location: p.cell, type: p.stateId })
  bot.entity.onGround = true; bot.entity.position = new Vec3(4.5, 0, 0.5)
  bot.emit('physicsTick'); now = 350; bot.emit('physicsTick')
  assert.equal(guard.stats.saved, 0)
  guard.stop()
})
test('мелкие стеки: второй hotbar-блок доступен, если первый уже потрачен', () => {
  const slots = []
  slots[36] = { name: 'cobblestone', count: 1, slot: 36 }
  slots[37] = { name: 'dirt', count: 1, slot: 37 }
  assert.equal(clutch.selectBlock(slots, 0, new Map([[36, 1]])).slot, 37)
})
test('цепочка не учитывает запас в рюкзаке, пока он не переложен в хотбар', () => {
  const m = model(p => p.x <= 0 && p.y === 19 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(1.25, 20.4, 0.5), new Vec3(0.364, 0.3136, 0)), { inventory: [
    { name: 'cobblestone', count: 1, slot: 38 }, { name: 'dirt', count: 64, slot: 12 }
  ] })
  bot.emit('physicsTick'); bot.emit('move')
  assert.equal(bot.packets.includes('place'), false)
  guard.stop()
})
test('вход в воду завершает полёт и сбрасывает лимит блоков', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)))
  bot.emit('physicsTick'); bot.emit('move')
  assert.equal(guard.blocks, 1)
  bot.entity.isInWater = true; bot.emit('physicsTick')
  assert.equal(guard.blocks, 0); assert.equal(guard.flight, null); assert.equal(guard.peak, null)
  guard.stop()
})
test('кролик между глазом и гранью: в пакете именно незакрытая точка', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)))
  bot.entities = { 2: { id: 2, name: 'rabbit', position: new Vec3(0.1, 20.7, 0.5), width: 0.4, height: 0.5 } }
  bot.emit('physicsTick'); bot.emit('move')
  const p = bot.lastPlace.ref.position.plus(bot.lastPlace.opts.delta)
  assert.ok(p.distanceTo(new Vec3(0, 19.2, 0.2)) < 1e-7)
  guard.stop()
})
test('настоящий generic_place пишет синхронно точный cursor, sequence=0', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const bot = fakeBot(m, state(new Vec3(0.5, 20, 0.5)))
  Object.defineProperty(bot, 'heldItem', { get: () => bot.inventory.slots[bot.quickBarSlot + 36] })
  bot.supportFeature = n => data.supportFeature(n)
  bot.swingArm = () => {}
  let sent = null
  bot._client.write = (name, p) => { bot.packets.push(name); if (name === 'block_place') sent = p }
  require('mineflayer/lib/plugins/generic_place')(bot)
  const guard = clutch.install({ bot }, { Vec3, PlayerState, faceAim: pick.faceAim, makeBlock: p => block('cobblestone', p), hand: { as: fn => fn(), hold () {} } })
  bot.emit('physicsTick'); bot.packets.push('position'); bot.emit('move')
  assert.deepEqual(bot.packets, ['position', 'look', 'slot', 'block_place'])
  assert.deepEqual([sent.direction, sent.cursorX, sent.cursorY, sent.cursorZ, sent.sequence], [5, 1, 0.5, 0.5, 0])
  guard.stop()
})
test('глубокая вода под стеной: как column, клатч сохраняет уровень края', () => {
  const m = model(p => p.x === -1 ? 'stone' : p.y < 0 ? 'water' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)))
  bot.game.dimension = 'minecraft:overworld'
  bot.emit('physicsTick'); bot.emit('move')
  assert.equal(guard.lastDecision.action, 'clutch')
  assert.equal(bot.packets.includes('place'), true)
  guard.stop()
})
test('намеренный MLG path и guard.allow оставляют клатч молчать', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), { mlgDrop: () => ({ ok: true }) })
  bot.pathfinder = { isMoving: () => true }
  bot.emit('path_update', { path: [{ x: 0, y: 20, z: 0 }, { x: 0, y: 0, z: 0 }] })
  bot.emit('physicsTick'); bot.emit('move')
  assert.equal(guard.lastDecision.action, 'none'); assert.equal(bot.packets.includes('place'), false)
  bot.emit('path_reset'); bot._ndClutchAllowUntil = Date.now() + 2000
  bot.emit('physicsTick'); bot.emit('move')
  assert.equal(guard.lastDecision.action, 'none'); assert.equal(bot.packets.includes('place'), false)
  guard.stop()
})
test('отказ родителя откатывает зависимые предсказанные кубы', () => {
  const m = model(p => p.x <= 0 && p.y === 19 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.85, 20, 0.5), new Vec3(0.4, 0.4, 0)))
  for (let t = 0; t < 8 && guard.pending.size < 2; t++) {
    const s = new PlayerState(bot, bot.controlState); m.physics.simulatePlayer(s, m.world); s.apply(bot)
    bot.emit('physicsTick'); bot.emit('move')
  }
  const records = [...guard.pending.values()]
  assert.ok(records.length >= 2)
  const parent = records.find(p => records.some(child => child.refKey === key(p.cell)))
  assert.ok(parent)
  const child = records.find(p => p.refKey === key(parent.cell))
  bot._client.emit('block_change', { location: parent.cell, type: data.blocksByName.air.defaultState })
  assert.equal(guard.pending.has(key(child.cell)), false)
  assert.equal(m.world.getBlock(child.cell).name, 'air')
  guard.stop()
})
test('клатч не трогает движение дракона, булавы, ветра и creative', () => {
  for (const c of [{ dragon: true }, { mace: true }, { wind: true }, { mode: 'creative' }, { mode: 'spectator' }]) {
    const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
    const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), { context: () => c })
    bot.emit('physicsTick'); bot.emit('move')
    assert.equal(bot.packets.includes('place'), false); assert.equal(guard.lastDecision.action, 'none')
    guard.stop()
  }
})
test('inventory раньше отказа: старый отказ не освобождает резерв новой установки', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), { inventory: [{ name: 'cobblestone', count: 2, slot: 38 }] })
  bot.emit('physicsTick'); bot.emit('move')
  const first = [...guard.pending.values()][0]
  const old = bot.inventory.slots[38]; bot.inventory.slots[38] = { ...old, count: 1 }
  bot.inventory.emit('updateSlot', 38, old, bot.inventory.slots[38])
  bot.entity.position.z = 4.5; bot.emit('physicsTick'); bot.emit('move')
  assert.equal(guard.stats.placed, 2)
  bot._client.emit('block_change', { location: first.cell, type: data.blocksByName.air.defaultState })
  bot.entity.position.z = 8.5; bot.emit('physicsTick'); bot.emit('move')
  assert.equal(guard.stats.placed, 2)
  guard.stop()
})
test('присевший клиент проверяет грань от глаз1.27, включая отправку', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const eyes = []
  const { bot, guard } = installFake(m, state(new Vec3(0.5, 20, 0.5)), { faceAim: (b, r, f, o) => { eyes.push(o.eye.y); return pick.faceAim(b, r, f, o) } })
  bot.controlState.sneak = true
  bot.emit('physicsTick'); bot.emit('move')
  assert.ok(bot.lastPlace)
  assert.ok(eyes.length >= 2)
  assert.ok(eyes.every(y => Math.abs(y - 21.27) < 1e-8))
  guard.stop()
})
// Ревью координатора (30.09): на земле клатч молчит — pathfinder ведёт тело вдоль обрыва с зажатым
// «вперёд», прогноз 24 тиков уводит его за край, и без этого запрета клатч строил бы мост на каждом повороте.
test('на земле у обрыва с «вперёд+спринт» — не клатч; элитры, медленное падение, седло — тоже', () => {
  const m = model(p => p.x <= 0 && p.y === 19 || p.y < 0 ? 'stone' : 'air')
  const s = state(new Vec3(0.5, 20, 0.5)); s.onGround = true
  const { bot, guard } = installFake(m, s)
  bot.entity.yaw = -Math.PI / 2; bot.controlState.forward = true; bot.controlState.sprint = true
  bot.emit('physicsTick'); bot.emit('move')
  assert.equal(bot.packets.includes('place'), false)
  assert.equal(guard.lastDecision.why, 'on_ground')
  guard.stop()
  for (const c of [{ elytra: true }, { slowFalling: true }, { riding: true }, { levitation: true }]) {
    const m2 = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
    const f = installFake(m2, state(new Vec3(0.5, 20, 0.5)), { context: () => c })
    f.bot.emit('physicsTick'); f.bot.emit('move')
    assert.equal(f.bot.packets.includes('place'), false); assert.equal(f.guard.lastDecision.action, 'none')
    f.guard.stop()
  }
})

// Ферма 30.09 (clutch-dbg3): с клавишами mineflayer прогноз уходил в NaN, мир отвечал null
// («не загружено»), и клатч молчал «unknown_world» на каждом падении. Здесь мир, как у
// mineflayer, на NaN отвечает null — решение должно быть «клатч», и блок уходит.
test('клавиши mineflayer (неперечислимые геттеры): прогноз конечен, у стены — клатч', () => {
  const m = model(p => p.x === -1 || p.y < 0 ? 'stone' : 'air')
  const raw = m.world.getBlock
  m.world.getBlock = p => [p.x, p.y, p.z].every(Number.isFinite) ? raw(p) : null
  const s = state(new Vec3(0.5, 20, 0.5), new Vec3(0, -0.0784, 0)); s.pos.y = 19.92
  const { bot, guard } = installFake(m, s)
  bot.emit('physicsTick'); bot.emit('move')
  assert.equal(guard.lastDecision.action, 'clutch', JSON.stringify(guard.lastDecision))
  assert.ok(bot.packets.includes('place'))
  guard.stop()
})

// Спуск по лестнице: падение каждый тик сбрасывается (onClimbable) — пик от верха шахты
// не должен звать клатч, а внизу шахты у лестницы пустые клетки не трогаем.
test('лестница: спуск по шахте не клатч', () => {
  const m = model(p => p.y < 0 || p.x === -1 ? 'stone' : p.x === 0 && p.z === 0 && p.y < 30 ? 'ladder' : 'air')
  const s = state(new Vec3(0.5, 20, 0.5), new Vec3(0, -0.15, 0))
  const { bot, guard } = installFake(m, s)
  guard.peak = 30
  bot.emit('physicsTick'); bot.emit('move')
  assert.equal(guard.lastDecision.action, 'none')
  assert.equal(bot.packets.includes('place'), false)
  assert.equal(guard.peak, 20)
  guard.stop()
})

module.exports = { model, state, flight, block, data, Block, Vec3, Physics, PlayerState, EventEmitter, IDLE }
