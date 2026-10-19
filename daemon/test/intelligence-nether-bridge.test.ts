import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

function bridgeFixture ({ aborted = false, grounded = true, z = 137.0596148, rejectProp = false, abortAfterProp = false } = {}) {
  const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry as any)
  const { Physics, PlayerState } = require('prismarine-physics')
  const pick: typeof import('../src/pick') = require('../src/pick')
  const key = p => `${p.x},${p.y},${p.z}`
  const blocks = new Map([['69,42,136', 'netherrack']])
  const controls = { forward: false, back: false, left: false, right: false, sprint: false, sneak: false, jump: false }
  const stack = { name: 'netherrack', type: registry.itemsByName.netherrack.id, count: 64 }
  const ctl = { aborted, onAbort: [] as Array<() => void> }
  const packets: Array<{ at: string; visible: boolean }> = []
  const marks: string[] = []
  let elapsed = 0
  let frames = 0
  let lowest = 43
  const bot = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, health: 20, food: 20, game: { dimension: 'the_nether' },
    inventory: { items: () => [stack], slots: [] }, heldItem: stack,
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { position: new Vec3(69.30000001, 43, z), velocity: new Vec3(0, -.0784, 0), onGround: grounded,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: grounded, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    entities: {},
    blockAt (p) {
      const cell = p.floored()
      const block = Block.fromStateId(registry.blocksByName[blocks.get(key(cell)) || 'air'].defaultState)
      block.position = cell
      return block
    },
    async equip (item) { this.heldItem = item },
    async lookAt (target) {
      const delta = target.minus(this.entity.position)
      this.entity.yaw = Math.atan2(-delta.x, -delta.z)
      this.entity.pitch = Math.atan2(delta.y - 1.62, Math.hypot(delta.x, delta.z))
    },
    getControlState: key => controls[key],
    setControlState: (key, value) => { controls[key] = value },
    async placeBlock (ref, face) {
      const at = key(ref.position.plus(face))
      const visible = !!pick.faceAim(bot, ref.position, face)
      packets.push({ at, visible })
      assert.equal(visible, true, `placement ${at} must use a visible native face`)
      if (rejectProp && at === '69,42,137') return
      blocks.set(at, 'netherrack'); stack.count--
      if (abortAfterProp && at === '69,42,137') ctl.aborted = true
    }
  })
  const world = { getBlock: p => bot.blockAt(p) }
  const physics = Physics(registry, world)
  const frame = () => {
    physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot)
    elapsed += 50; frames++; lowest = Math.min(lowest, bot.entity.position.y)
    bot.emit('physicsTick')
  }
  const originalOn = bot.on.bind(bot)
  bot.on = (name, listener) => {
    originalOn(name, listener)
    if (name === 'physicsTick') queueMicrotask(frame)
    return bot
  }
  const clock = {
    now: () => elapsed,
    setTimeout (fn, ms) {
      if (ms <= 60) { queueMicrotask(() => { frame(); fn() }); return null }
      return setTimeout(fn, ms)
    },
    clearTimeout,
    wall: { now: Date.now, setTimeout, clearTimeout }
  }
  const load = (file, overrides = {}, suffix = '') => {
    const filename = require.resolve(file)
    const actualRequire = createRequire(filename)
    const module = { exports: {} as Record<string, any> }
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8') + suffix)(
      name => overrides[name] || actualRequire(name), module, module.exports)
    return module.exports
  }
  const build = load('../src/build', { './game-clock': { ...clock, setTimeout } })
  const bridge = load('../src/bridge', { './game-clock': clock, './build': build })
  const route = load('../src/nether-route', { './game-clock': clock, './build': build, './bridge': bridge }, '\nmodule.exports.stepOne = stepOne')
  const stats = { mismatch: 0, digFails: 0, stepFails: 0, placed: 0 }
  const floor = new Vec3(70, 42, 137)
  return { bot, ctl, controls, blocks, packets, marks, stats, build, floor,
    run: () => route.stepOne({ bot }, ctl, { mark: (x, y, z) => marks.push(`${x},${y},${z}`) },
      { kind: 'bridge', from: { x: 69, y: 43, z: 137 }, to: { x: 70, y: 43, z: 137 } }, stats),
    measured: () => ({ frames, elapsed, lowest }) }
}

test('native edge landing bridges via its actual visible prop, edge approach and confirmed destination', async () => {
  const f = bridgeFixture()
  assert.equal(await f.run(), 'ok')
  assert.deepEqual(f.packets, [{ at: '69,42,137', visible: true }, { at: '70,42,137', visible: true }])
  assert.equal(f.stats.placed, 2)
  assert.deepEqual(f.marks, ['69,42,137', '70,42,137'])
  assert.equal(f.bot.entity.position.floored().equals(new Vec3(70, 43, 137)), true)
  assert.equal(f.measured().lowest, 43)
  assert.ok(f.measured().frames > 0 && f.measured().frames <= 48)
  assert.equal(f.controls.forward, false)
  assert.equal(f.controls.sneak, false)
})

test('the prop helper preserves honest selection for both recursive and final native faces', async () => {
  const hiddenProp = bridgeFixture({ z: 136.5 })
  const hiddenResult = await hiddenProp.build.placeBlockAt(hiddenProp.bot, hiddenProp.floor,
    { honest: true, steady: true, prop: new Vec3(69, 42, 137) })
  assert.equal(hiddenResult.ok, false)
  assert.deepEqual(hiddenProp.packets, [])
  const hiddenFinal = bridgeFixture()
  const finalResult = await hiddenFinal.build.placeBlockAt(hiddenFinal.bot, hiddenFinal.floor,
    { honest: true, steady: true, prop: new Vec3(69, 42, 137) })
  assert.equal(finalResult.ok, false)
  assert.deepEqual(hiddenFinal.packets, [{ at: '69,42,137', visible: true }])
})

test('an unconfirmed prop or an abort after its receipt never advances over air', async () => {
  for (const options of [{ rejectProp: true }, { abortAfterProp: true }]) {
    const f = bridgeFixture(options)
    assert.notEqual(await f.run(), 'ok')
    assert.equal(f.blocks.has('70,42,137'), false)
    assert.equal(f.measured().frames, 0)
    assert.equal(f.controls.forward, false)
    assert.equal(f.stats.placed, options.abortAfterProp ? 1 : 0)
  }
})

test('a bridge does not attempt a support placement from an airborne or aborted landing', async () => {
  for (const options of [{ grounded: false }, { aborted: true }]) {
    const f = bridgeFixture(options)
    assert.notEqual(await f.run(), 'ok')
    assert.deepEqual(f.packets, [])
    assert.equal(f.measured().frames, 0)
    assert.equal(f.controls.forward, false)
  }
})
