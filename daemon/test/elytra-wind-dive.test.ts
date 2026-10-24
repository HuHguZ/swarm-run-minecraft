import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import { bodySource } from './source-fixture'
import { divePlan } from '../src/elytra/dive'
import { rollout } from '../src/elytra/physics'
import { Vec3 } from 'vec3'

function load(name, mocks, overrides = {}) {
  const file = resolve(__dirname, '../src', name + '.js'), real = createRequire(file), mod = { exports: {} as any }
  const inject = Object.keys(overrides).map(key => `${key} = __overrides[${JSON.stringify(key)}]`).join('\n')
  runInThisContext(`(function(require,module,exports,__filename,__dirname,__overrides){${bodySource(file)}\n${inject}\n})`, { filename: file })
    (id => id in mocks ? mocks[id] : real(id), mod, mod.exports, file, dirname(file), overrides)
  return mod.exports
}

function fixture({ windVy = 1.22, windReceipt = true } = {}) {
  const bot: any = new EventEmitter(); bot._client = new EventEmitter()
  bot.registry = require('prismarine-registry')('1.21.11'); bot.version = '1.21.11'; bot.health = 20; bot.food = 20
  bot.entity = { id: 1, name: 'player', type: 'player', position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true, metadata: [], yaw: 0, pitch: 0, height: 1.8, width: .6, effects: {}, attributes: {} }
  const foe: any = { id: 2, username: 'Foe', name: 'player', type: 'player', position: new Vec3(4.5, 1, .5), isValid: true, metadata: [], equipment: [], width: .6, height: 1.8 }
  Object.defineProperty(foe.metadata, 9, { get() { throw new Error('exact player HP is not a decision input') } })
  bot.entities = { 1: bot.entity, 2: foe }; bot.game = { dimension: 'overworld', minY: -64, height: 384 }
  const mace = { name: 'mace', count: 1, slot: 36, componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'minecraft:wind_burst', level: 2 }] } }]]) }
  const wind = { name: 'wind_charge', count: 4, slot: 37 }, elytra = { name: 'elytra', count: 1, slot: 38 }, chest = { name: 'diamond_chestplate', count: 1, slot: 39 }
  const items = [mace, wind, elytra, chest]
  bot.inventory = { items: () => items, slots: [] }; items.forEach(i => { bot.inventory.slots[i.slot] = i })
  bot.heldItem = mace; bot.quickBarSlot = 0; bot._ndMaceHeldAt = 1
  const Block = require('prismarine-block')(bot.registry)
  const world = { getBlock: p => { const block = Block.fromStateId(bot.registry.blocksByName[p.y < 1 ? 'stone' : 'air'].defaultState); block.position = p.floored(); return block } }
  bot.blockAt = p => world.getBlock(p); bot.world = { raycast: () => null }
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(bot.registry, world)
  bot.jumpTicks = 0; bot.jumpQueued = false; bot.fireworkRocketDuration = 0
  bot.controlState = {}; bot.setControlState = (k, v) => { bot.controlState[k] = v }; bot.getControlState = k => !!bot.controlState[k]
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async () => {}; bot.setQuickBarSlot = () => {}; bot.attack = () => {}
  bot.equip = async (it, hand) => { if (hand === 'off-hand') bot.inventory.slots[45] = it; else if (hand === 'hand') bot.heldItem = it }
  let now = 10000, windFired = 0, glides = 0
  const timers = new Set<any>()
  const clock = { now: () => now, setTimeout(fn, ms) { const t = { fn, at: now + ms }; timers.add(t); return t }, clearTimeout: t => timers.delete(t) }
  bot.activateItem = off => { if (off && bot.inventory.slots[45]?.name === 'wind_charge') {
    windFired++; bot.entity.onGround = false; bot.entity.velocity.y = windVy
    bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 10 })
    if (windReceipt) bot._client.emit('explosion', { playerKnockback: { x: 0, y: 1.22, z: 0 } })
  } }
  const step = async () => { now += 50; bot.emit('physicsTick'); for (const t of [...timers]) if (t.at <= now) { timers.delete(t); t.fn() }; await new Promise<void>(done => setImmediate(done)) }
  const finish = async promise => { let done = false, value, error; promise.then(v => { done = true; value = v }, e => { done = true; error = e }); for (let i = 0; !done && i < 240; i++) await step(); assert.ok(done, 'bounded operation completes'); if (error) throw error; return value }
  const W: any = { boxHit: () => false, floorBelow: () => ({ top: 1 }) }
  return { bot, foe, mace, wind, items, clock, W, step, finish, count: () => ({ windFired, glides }), startGlide: () => { assert.ok(bot.entity.velocity.y > .55, 'open after observed wind lift'); bot.entity.elytraFlying = true; glides++; return true } }
}

test('a real wind-charge kit can plan the existing dive without any rockets', () => {
  const f = fixture(), ctx = { d: 4, dy: 0, hp: 20, foeGrounded: true, W: f.W }
  assert.equal(divePlan(f.bot, f.foe, ctx)?.kind, 'dive')
  f.items.splice(f.items.indexOf(f.wind), 1)
  assert.equal(divePlan(f.bot, f.foe, ctx), null, 'without a launch impulse there is no rocketless takeoff')
})

test('the public elytra decision does not discard the wind kit before divePlan', () => {
  const f = fixture()
  const sky = load('elytra', { './game-clock': f.clock }, { install: () => ({}), worldOf: () => f.W,
    track: () => ({ flying: () => false, threat: () => null, report: () => ({}) }) }).create(f.bot, { enemy: () => f.foe })
  assert.equal(sky.decide({ d: 4, dy: 0, hp: 20, foeGrounded: true, prefer: 'dive' })?.kind, 'dive')
})

test('rocketless dive uses native wind fire and observed lift before entering the existing flight controller', async () => {
  const f = fixture(), ctl = { aborted: false }, state = { fd: 0, driving: 0 }
  let entered = false
  const sky = load('elytra', { './game-clock': f.clock }, {
    install: () => state, worldOf: () => f.W, swapChest: async () => ({ ok: true }), chestDown: async () => ({ ok: true }),
    startGlide: f.startGlide, takeoff: async () => { throw new Error('rocket takeoff cannot launch this kit') },
    fly: async () => { entered = true; ctl.aborted = true; return { why: 'прервали' } }
  })
  await f.finish(sky.diveSmash(f.bot, ctl, f.foe, { stats: {}, telemetryHp: () => null }))
  assert.equal(f.count().windFired, 1)
  assert.equal(f.count().glides, 1)
  assert.equal(entered, true)
})

test('native glider rollout rewards steep accumulated fall, not high horizontal speed', () => {
  const W: any = { boxHit: () => false, floorBelow: () => null }
  const shallow = rollout(W, new Vec3(0, 40, 0), new Vec3(3, -.1, 0), -Math.PI / 2, -.2, 0, 24, { fd: 1 })
  const steep = rollout(W, new Vec3(0, 40, 0), new Vec3(.1, -.7, 0), -Math.PI / 2, -1.52, 0, 24, { fd: 1 })
  assert.ok(steep.fd > shallow.fd && steep.fd > 1.5)
})

test('Jump Boost without an explosion packet or a refused shot cannot be mistaken for a wind impulse', async () => {
  for (const floorVisible of [true, false]) {
    const f = fixture({ windVy: .82, windReceipt: false }), ctl = { aborted: false }
    if (!floorVisible) f.bot.blockAt = () => null
    const sky = load('elytra', { './game-clock': f.clock }, {
      install: () => ({ fd: 0, driving: 0 }), worldOf: () => f.W,
      swapChest: async () => ({ ok: true }), chestDown: async () => ({ ok: true }), startGlide: f.startGlide,
      takeoff: async () => { throw new Error('no rockets') }, fly: async () => { throw new Error('no observed wind launch') }
    })
    const result: any = await f.finish(sky.diveSmash(f.bot, ctl, f.foe, { stats: {}, telemetryHp: () => null }))
    assert.equal(result.ok, false)
    assert.equal(f.count().glides, 0)
    assert.equal(f.count().windFired, floorVisible ? 1 : 0)
    assert.equal(f.bot.getControlState('jump'), false)
    assert.equal(f.bot._client.listenerCount('explosion'), 0)
    assert.equal(f.bot._client.listenerCount('set_cooldown'), 0)
  }
})

test('a confirmed dive hit enters the existing Wind Burst chain before touching the ground', async () => {
  const f = fixture(); f.bot.entity.position.y = 3; f.bot.entity.onGround = false; f.bot.entity.velocity.y = 1.75
  f.foe.isValid = false
  const next = { ...f.foe, metadata: [], id: 3, username: 'Next', isValid: true, position: new Vec3(1.5, 1, .5) }
  let choices = 0, selected = 0
  const chain = { deadline: 10600, choose: () => { choices++; return { entity: next, vel: () => ({ x: 0, y: 0, z: 0 }) } }, onTarget: () => { selected++ } }
  const mace = load('mace', { './game-clock': f.clock })
  const result: any = await f.finish(mace.descend(f.bot, { aborted: false }, f.foe, { chain, stats: {}, telemetryHp: () => null,
    initialHit: { at: 10000, fall: 8, target: 'Foe', charged: true }, maxMs: 600 }))
  assert.ok(choices > 0 && selected > 0, 'the same chain selects again from the actual rebound')
  assert.equal(result.hits[0]?.target, 'Foe', 'the confirmed first hit is retained')
})

test('native fallDistance is checked again at the strike packet, then a confirmed strike enters the bounded chain before landing', async () => {
  for (const packetFall of [8, 1]) {
  const f = fixture(), ctl = { aborted: false }, state = { fd: 8, driving: 0 }
  const nativeMace = load('mace', { './game-clock': f.clock })
  let handed, choices = 0
  const chain = { deadline: 1e9, choose: () => { choices++; return { entity: f.foe } } }
  const activate = f.bot.activateItem
  f.bot.activateItem = off => {
    if (off && /_chestplate$/.test(f.bot.inventory.slots[45]?.name || '')) f.bot.entity.elytraFlying = false
    else activate(off)
  }
  f.bot.attack = () => {
    f.bot._client.emit('damage_event', { entityId: f.foe.id, sourceCauseId: f.bot.entity.id + 1 })
    f.bot.entity.velocity.y = 1.75; f.bot.entity.onGround = true // delayed landing flag must not discard the rebound
  }
  const sky = load('elytra', { './game-clock': f.clock, './mace': {
    slamHit: nativeMace.slamHit,
    descend: (...args) => { handed = args[3]; return nativeMace.descend(...args) }
  } }, {
    install: () => state, worldOf: () => f.W, swapChest: async () => ({ ok: true }), chestDown: async () => ({ ok: true }),
    startGlide: f.startGlide, choose: () => ({ yaw: 0, pitch: -1.52 }),
    afterPacket: (_bot, fn) => { state.fd = packetFall; setImmediate(fn) },
    fly: () => new Promise(resolve => f.clock.setTimeout(() => {
      f.bot.entity.position.set(4.5, 3.3, .5); f.bot.entity.velocity.y = -.8
      resolve({ why: 'над ним' })
    }, 1750))
  })
  const result: any = await f.finish(sky.diveSmash(f.bot, ctl, f.foe, { chain, stats: {}, telemetryHp: () => null, maxMs: 3000 }))
  assert.equal(result.hit, packetFall > 1.5)
  if (packetFall <= 1.5) { assert.equal(handed, undefined); assert.equal(choices, 0); continue }
  assert.ok(handed && choices > 0, 'actual dive adapter continues through existing target choice')
  assert.equal(handed.initialHit.target, 'Foe')
  assert.equal(handed.initialHit.fall, 8)
  assert.equal(handed.chain.deadline, 13000, 'rebound cannot extend the original dive deadline')
  assert.equal(result.chain.hits[0].target, 'Foe')
  assert.equal(f.bot._client.listenerCount('damage_event'), 0)
  }
})
