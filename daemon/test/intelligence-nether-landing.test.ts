import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { bodySource } from './source-fixture'

function dropping(distance: number, { isolated = false, hazard = false, unknown = false, withClutch = false } = {}) {
  const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry as any)
  const { Physics, PlayerState } = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
  const controls = { forward: false, back: false, left: false, right: false, sprint: false, sneak: false, jump: false }
  const updates = new Map()
  const target = isolated ? new Vec3(0, 4 - distance, 1) : new Vec3(1, 64 - distance, 0)
  const block = (name, position) => { const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = position; return b }
  const inventory = Object.assign(new EventEmitter(), { items () { return this.slots.filter(Boolean) }, slots: [] as Array<object | null> })
  if (withClutch) inventory.slots[36] = { name: 'netherrack', count: 8, slot: 36 }
  const bot: any = Object.assign(new EventEmitter(), {
    registry, version: '1.21.11', health: 20, jumpTicks: 0, jumpQueued: false,
    inventory, fireworkRocketDuration: 0, entities: {}, game: { dimension: 'minecraft:the_nether', gameMode: 'survival' },
    entity: { id: 1, position: isolated ? new Vec3(.8648808855, 4, .4998970508) : new Vec3(.5, 64, .5),
      velocity: new Vec3(isolated ? .00285565 : 0, -.0784000015258789, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: true, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    blockAt(point) {
      const cell = point.floored()
      if (updates.has(cell.toString())) return updates.get(cell.toString())
      if (cell.equals(target.offset(0, -1, 0))) {
        if (unknown) return null
        if (hazard) return block('lava', cell)
      }
      const solid = isolated ? cell.y < -8 || cell.x === 0 && cell.z === 0 && cell.y === 3 ||
        cell.x === target.x && cell.z === target.z && cell.y === target.y - 1 : cell.y <= (cell.x < 1 ? 63 : 63 - distance)
      return block(solid ? 'stone' : 'air', cell)
    },
    async look (yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch },
    async lookAt(target) { this.entity.yaw = Math.atan2(-(target.x - this.entity.position.x), -(target.z - this.entity.position.z)) },
    setControlState(key, value) { controls[key] = value },
    getControlState(key) { return controls[key] },
    clearControlStates() { for (const key of Object.keys(controls)) controls[key] = false },
    async waitForTicks () {},
    setQuickBarSlot () {}, async _genericPlace () {},
    _client: Object.assign(new EventEmitter(), { write () {} })
  })
  const world = { getBlock: point => bot.blockAt(point) }
  const physics = Physics(registry, world)
  bot.physics = physics
  bot.world = { setBlockStateId (point, stateId) { updates.set(point.floored().toString(), Block.fromStateId(stateId)) } }
  const guard = withClutch ? (require('../src/clutch') as typeof import('../src/clutch')).install({ bot }, {
    Vec3, PlayerState, faceAim: (require('../src/pick') as typeof import('../src/pick')).faceAim, makeBlock: p => block('netherrack', p),
    hand: { hold () {}, on: () => false, as: f => f() }, prepare: false, existingWater: false
  }) : null
  const clutchDecisions: string[] = []
  let gameMs = 0; let frames = 0
  // Confirmed clock catchup can wake many timers before the next real player frame.
  const clock = { now: () => gameMs, setTimeout(fn, milliseconds) {
    queueMicrotask(() => { gameMs += milliseconds; fn() })
  }, wall: { now: Date.now, setTimeout, clearTimeout } }
  const filename = require.resolve('../src/nether-route')
  const nativeRequire = createRequire(filename)
  let motion = null
  const localModule = { exports: {} as Record<string, any> }
  // nether-route — фасад + части (src/nether-route/**) одной областью видимости: dropInto — имя верхнего уровня.
  new Function('require', 'module', 'exports', bodySource(filename) + '\nmodule.exports.dropInto = dropInto')(
    name => name === './game-clock' ? clock : name === './reflex-lock' ? { clock: () => gameMs }
      : name === './navigation/parkour' ? { async executeJump (...args) {
        motion = await nativeRequire(name).executeJump(...args); return motion
      } } : nativeRequire(name),
    localModule, localModule.exports)
  const pump = () => {
    physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot); frames++; bot.emit('physicsTick')
    if (guard?.lastDecision?.action === 'clutch') clutchDecisions.push('clutch')
    bot.emit('move')
  }
  return { bot, controls, pump, target, guard, clutchDecisions, frames: () => frames, motion: () => motion,
    close: () => guard?.stop(),
    run: (ctl = { aborted: false, onAbort: [] }) => localModule.exports.dropInto(bot, ctl, target) }
}

test('Nether drop waits for actual landing frames while the game clock catches up', async () => {
  for (const distance of [2, 3]) {
    const scene = dropping(distance)
    const timer = setInterval(scene.pump, 1)
    try { assert.equal(await scene.run(), true, JSON.stringify(scene.motion())) } finally { clearInterval(timer); scene.close() }
    assert.equal(scene.bot.entity.position.floored().equals(new Vec3(1, 64 - distance, 0)), true,
      JSON.stringify({ distance, at: scene.bot.entity.position, velocity: scene.bot.entity.velocity, frames: scene.frames() }))
    assert.equal(scene.bot.entity.onGround, true)
    assert.ok(scene.frames() >= 8)
    assert.equal(scene.controls.forward, false)
    assert.equal(scene.bot.listenerCount('physicsTick'), 0)
  }
})

test('cancelled or disconnected Nether drop releases its frame observer and forward control', async () => {
  for (const event of ['abort', 'end']) {
    const scene = dropping(3)
    const ctl = { aborted: false, onAbort: [] as Array<() => void> }
    let completed = false
    const pending = scene.run(ctl).then(() => { completed = true })
    const deadline = Date.now() + 1000
    while (scene.bot.listenerCount('end') === 0 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    assert.ok(scene.bot.listenerCount('end') > 0, 'the real controller must observe cancellation before the event')
    assert.equal(completed, false, 'a game-clock catchup must not finish an unobserved movement')
    if (event === 'abort') { ctl.aborted = true; for (const callback of [...ctl.onAbort]) callback() }
    else scene.bot.emit('end')
    await pending
    assert.equal(scene.controls.forward, false)
    assert.equal(scene.bot.listenerCount('physicsTick'), 0)
    assert.equal(scene.bot.listenerCount('end'), 0)
    assert.equal(ctl.onAbort.length, 0)
    assert.equal(scene.bot._ndParkourForecast, undefined)
  }
})

test('planned two- and three-block drops use the shared trajectory without a false native clutch', async () => {
  for (const distance of [2, 3]) {
    const scene = dropping(distance, { isolated: true, withClutch: true })
    const timer = setInterval(scene.pump, 1)
    try {
      assert.equal(await scene.run(), true)
      assert.equal(scene.bot.entity.position.floored().equals(scene.target), true)
      assert.equal(scene.bot.entity.onGround, true)
      assert.equal(scene.guard.stats.placed, 0)
      assert.deepEqual(scene.clutchDecisions, [])
      assert.equal(scene.bot._ndParkourForecast, undefined)
      assert.equal(scene.controls.forward, false)
    } finally { clearInterval(timer); scene.close() }
  }
})

test('an unsafe lava or unloaded drop has no movement or invented landing marker', async () => {
  for (const options of [{ hazard: true }, { unknown: true }]) {
    const scene = dropping(2, { isolated: true, ...options })
    assert.equal(await scene.run(), false)
    assert.equal(scene.frames(), 0)
    assert.equal(scene.controls.forward, false)
    assert.equal(scene.bot._ndParkourForecast, undefined)
    assert.equal(scene.bot.entity.position.y, 4)
  }
})
