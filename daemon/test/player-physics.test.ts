'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import 'node:path'
import path = require('node:path')
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import native = require('prismarine-physics')
import nativeData = require('minecraft-data')
const IDLE = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

// Count only the adapter's lexical dependencies; do not patch global loading,
// require.cache, installed sources or native physics exports.
function isolatedAdapter ({ corrupt, version }: any = {} as Record<string, any>) {
  const filename = require.resolve('../src/tick-plugins')
  const localRequire = createRequire(filename)
  const loads = new Map()
  const dataCalls = []
  const trackedRequire = request => {
    if (request === 'node:fs') return { readFileSync: (file, encoding) => fs.readFileSync(file, encoding) + (file === corrupt ? '\n// changed dependency' : '') }
    if (request === 'prismarine-physics/package.json' && version) return { version }
    if (request === 'node:module') return { createRequire: file => {
      const base = createRequire(file)
      return request => {
        const key = `${file}:${request}`
        loads.set(key, (loads.get(key) || 0) + 1)
        const value = base(request)
        return request === 'minecraft-data' ? v => {
          const data = value(v); dataCalls.push({ version: v, data }); return data
        } : value
      }
    } }
    return localRequire(request)
  }
  trackedRequire.resolve = localRequire.resolve
  const mod = { exports: {} as Record<string, any> }
  new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(trackedRequire, mod, mod.exports)
  return { adapter: mod.exports, loads, dataCalls }
}
function botFor (version = '1.21.11') {
  return {
    version, registry: nativeData(version), inventory: { slots: [], items: () => [] },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { position: new Vec3(.5, 64, .5), velocity: new Vec3(.2, .4, .1), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {} as Record<string, any>, attributes: {} as Record<string, any> }
  }
}

test('fall flying uses the jar .6 body through a one-block-high tunnel, then restores standing height', () => {
  const scoped = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
  const bot = botFor(), data = bot.registry
  const Block = require('prismarine-block')(data)
  const world = { getBlock(p) {
    const q = p.floored(), solid = q.y < 64 || q.y === 65 && q.z < 0
    const b = Block.fromStateId((solid ? data.blocksByName.stone : data.blocksByName.air).defaultState, 0)
    b.position = q; return b
  } }
  bot.entity.position.set(.5, 64.3, .5)
  bot.entity.velocity.set(0, 0, -1)
  bot.entity.onGround = false; bot.entity.elytraFlying = true
  bot.inventory.slots[6] = { name: 'elytra' }
  bot.fireworkRocketDuration = 20
  const physics = scoped.Physics(data, world), state = new scoped.PlayerState(bot, { ...IDLE })
  for (let tick = 0; tick < 8; tick++) {
    physics.simulatePlayer(state, world)
    assert.equal(state.ndPoseHeight, .6)
    assert.equal(state.isCollidedHorizontally, false)
  }
  assert(state.pos.z < -5, 'flying body advances below the roof')
  state.pos.set(.5, 64.3, 2.5); state.vel.set(0, 0, 0)
  state.elytraFlying = false; state.fireworkRocketDuration = 0
  physics.simulatePlayer(state, world)
  assert.equal(state.ndPoseHeight, 1.8)
  assert.equal(physics.playerHeight, 1.8, 'flight height belongs to the state, not the shared Physics instance')
})

test('elytra rollout uses the flying body while landing clearance still requires a standing body', () => {
  const { worldOf, rollout }: typeof import('../src/elytra/physics') = require('../src/elytra/physics')
  const bot: any = botFor(), data = bot.registry, Block = require('prismarine-block')(data)
  bot.on = () => {}
  bot.blockAt = p => {
    const q = p.floored(), solid = q.y < 64 || q.y === 65 && q.z < 0
    const b = Block.fromStateId((solid ? data.blocksByName.stone : data.blocksByName.air).defaultState, 0)
    b.position = q; return b
  }
  const W = worldOf(bot)
  const r = rollout(W, new Vec3(.5, 64.3, .5), new Vec3(0, 0, -1), 0, 0, 20, 8)
  assert.equal(r.kind, null)
  assert(r.p.z < -5)
  assert.equal(rollout(W, new Vec3(.5, 64.3, -5), new Vec3(0, .1, -1), 0, 1, 20, 8).kind, 'ceil', 'an actual ceiling still clips the flying body')
  assert.equal(W.boxHit(.5, 64, -5), true, 'landing clearance still uses the standing body')
})
// Scoped pose/swimming inputs are asserted explicitly; compare every native output below.
const plain = ({ ndInPowderSnow, ndLeatherBoots, ndSwimming, ...state }) => ({ ...state, pos: { ...state.pos }, vel: { ...state.vel }, control: { ...state.control } })
const boots = level => ({ nbt: { type: 'compound', value: { Enchantments: { type: 'list', value: { type: 'compound', value: [{ id: { type: 'string', value: 'minecraft:depth_strider' }, lvl: { type: 'short', value: level } }] } } } } })

test('scoped physics caches native metadata per version without retaining effects or equipment', () => {
  const { adapter, loads, dataCalls } = isolatedAdapter()
  const scoped = adapter.getPhysics()
  assert.equal(adapter.getPhysics(), scoped)
  for (const version of ['1.21.11', '1.20.4']) {
    const bot = botFor(version)
    for (const level of [0, 3, 1, 0]) {
      bot.entity.effects = level ? { [bot.registry.effectsByName.Speed.id]: { amplifier: level - 1 } } : {} as Record<string, any>
      bot.inventory.slots[8] = level ? boots(level) : null
      bot.inventory.slots[6] = level ? { name: 'elytra' } : null
      const state = new scoped.PlayerState(bot, { ...IDLE })
      assert.equal(state.ndPoseHeight, 1.8, 'each standing state owns the real height independently of cached metadata')
      assert.equal(state.ndSwimming, false)
      assert.equal(state.pitch, bot.entity.pitch)
      assert.deepEqual(plain(state), { ...plain(new native.PlayerState(bot, { ...IDLE })), ndPoseHeight: 1.8 })
      assert.equal(state.speed, level)
      assert.equal(state.depthStrider, level)
      assert.equal(state.elytraEquipped, level !== 0)
    }
  }
  assert.deepEqual(dataCalls.map(call => call.version), ['1.21.11', '1.20.4'])
  for (const call of dataCalls) assert.equal(call.data, nativeData(call.version), 'the native cached data object is retained')
  assert.ok([...loads.values()].every(n => n === 1), 'each lexical dependency is resolved once')
})

test('scoped installed physics retains exact trajectories for full blocks, slabs and waterlogged stairs', () => {
  const scoped = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
  const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
  const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
  for (const [name, properties] of [['stone', {} as Record<string, any>], ['oak_slab', { type: 'bottom', waterlogged: false }], ['oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: true }]]) {
    const stateId = Block.fromProperties(name, properties).stateId
    const world = { getBlock: p => {
      const b = Block.fromStateId(p.y < 63 ? registry.blocksByName.stone.minStateId : p.y < 64 ? stateId : 0)
      b.position = p.floored(); return b
    } }
    const bot = botFor()
    bot.inventory.slots[8] = boots(3)
    bot.entity.effects = { [registry.effectsByName.JumpBoost.id]: { amplifier: 1 } }
    const control = { ...IDLE, forward: true, sprint: true }
    const expected = new native.PlayerState(bot, { ...control })
    const actual = new scoped.PlayerState(bot, { ...control })
    const nativePhysics = native.Physics(registry, world)
    const scopedPhysics = scoped.Physics(registry, world)
    for (let tick = 0; tick < 28; tick++) {
      nativePhysics.simulatePlayer(expected, world)
      scopedPhysics.simulatePlayer(actual, world)
      assert.equal(actual.ndPoseHeight, 1.8, `${name}: standing height remains on this state at tick ${tick + 1}`)
      assert.equal(scopedPhysics.playerHeight, 1.8, 'per-state stance never changes the shared Physics height')
      assert.deepEqual(plain(actual), { ...plain(expected), ndPoseHeight: 1.8 }, `${name}: tick ${tick + 1}`)
    }
  }
})

test('scoped physics leaves native exports, module cache and process globals unchanged', () => {
  const exports = { ...native }
  const globals = [Date, setTimeout, setInterval, clearTimeout, clearInterval, performance, (require('node:module') as any)._load]
  const scoped = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
  assert.notEqual(scoped, native)
  assert.notEqual(scoped.PlayerState, native.PlayerState)
  assert.deepEqual(native, exports)
  assert.equal(require.cache[require.resolve('prismarine-physics')].exports, native)
  assert.deepEqual([Date, setTimeout, setInterval, clearTimeout, clearInterval, performance, (require('node:module') as any)._load], globals)
})

test('physics and pathfinder both construct the shared scoped PlayerState', () => {
  const { adapter } = isolatedAdapter()
  const scoped = adapter.getPhysics()
  const State = scoped.PlayerState
  let constructions = 0
  scoped.PlayerState = class extends State { constructor (...args) { super(...args); constructions++ } }
  const callbacks = []
  const clock = { now: () => 1000000, setInterval: fn => { callbacks.push(fn); return fn }, clearInterval () {}, setTimeout: () => null, clearTimeout () {} }
  const bot: any = Object.assign(new EventEmitter(), botFor())
  bot._client = Object.assign(new EventEmitter(), { state: 'play', write () {} })
  bot.supportFeature = bot.registry.supportFeature
  bot.game = { gameMode: 'survival', minY: -64 }
  bot.isAlive = true
  bot.health = 20
  const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))('1.21.11')
  bot.blockAt = p => { const b = Block.fromStateId(bot.registry.blocksByName[p.y < 64 ? 'stone' : 'air'].defaultState); b.position = p.floored(); return b }
  const plugins = adapter.createTickPlugins(clock)
  plugins.plugins.physics(bot, { physicsEnabled: true })
  bot.emit('login')
  bot._client.emit('position', { x: .5, y: 64, z: .5, yaw: 0, pitch: 0, flags: {} as Record<string, any>, teleportId: 1 })
  callbacks[0]()
  assert.equal(constructions, 1, 'Mineflayer uses the scoped constructor')
  bot.lookAt = () => Promise.resolve()
  plugins.pathfinder(bot)
  bot.pathfinder.movements.allowFreeMotion = true
  const { GoalFollow } = (require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')).goals
  bot.pathfinder.setGoal(new GoalFollow({ position: new Vec3(.5, 64, -2.5) } as any, 1), true)
  bot.emit('physicsTick')
  assert.ok(constructions > 1, 'pathfinder/lib/physics uses the same constructor')
  bot.emit('end')
})

test('unreviewed physics versions and either dependency source fail closed', () => {
  assert.throws(() => isolatedAdapter({ version: '1.11.2' }).adapter.getPhysics(), /Unsupported prismarine-physics/)
  assert.throws(() => isolatedAdapter({ corrupt: require.resolve('prismarine-physics') }).adapter.getPhysics(), /Unsupported.*source/)
  assert.throws(() => isolatedAdapter({ corrupt: require.resolve('mineflayer-pathfinder/lib/physics') }).adapter.createTickPlugins({} as Record<string, any>), /Unsupported.*source/)
})
