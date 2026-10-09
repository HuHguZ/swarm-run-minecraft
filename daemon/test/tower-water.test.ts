import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const Item = require('prismarine-item')(registry)
const native = require('../src/tick-plugins').getPhysics()
const clockMod = require('../src/game-clock')
const build = require('../src/build')
const pick = require('../src/pick')
const IDLE = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

function scene({ water = true, arriving = false, receive = true, change = null }: any = {}) {
  const clock = clockMod.activate(new clockMod.GameClock({ manual: true, epoch: 0 }))
  const cells = new Map<string, any>()
  const set = (p: Vec3, name: string) => {
    const b = Block.fromStateId(registry.blocksByName[name].defaultState)
    b.position = p.floored(); cells.set(b.position.toString(), b); return b
  }
  const world = { getBlock(p: Vec3) {
    const q = p.floored()
    if (!cells.has(q.toString())) {
      const pit = q.x >= 0 && q.x <= 2 && q.z >= 0 && q.z <= 2
      let name = q.y <= 0 || (!pit && q.y < 4) ? 'stone' : water && pit && q.y === 1 ? 'water' : 'air'
      if (change) name = change(q, name)
      if (name === null) { cells.set(q.toString(), null); return null }
      set(q, name)
    }
    return cells.get(q.toString())
  } }
  const stack = new Item(registry.itemsByName.cobblestone.id, 32)
  stack.slot = 36
  const sword = new Item(registry.itemsByName.diamond_sword.id, 1)
  sword.slot = 37
  const slots = Array(46).fill(null); slots[36] = stack; slots[37] = sword
  let controls = { ...IDLE }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { dimension: 'overworld', minY: -64, height: 384 },
    inventory: { slots, items: () => [stack, sword].filter(i => i.count > 0) }, heldItem: sword,
    health: 20, food: 20, entities: {},
    entity: { position: arriving ? new Vec3(.9308520172491, 1.61769215885033, .9308520172494) : new Vec3(.5, 1, .5),
      velocity: arriving ? new Vec3(-.0844401242464, -.20687796551256, -.08444012424635) : new Vec3(0, 0, 0),
      onGround: !arriving, isInWater: water && !arriving, isInLava: false, isInWeb: false,
      yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: .6 },
    blockAt: (p: Vec3) => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    physics: native.Physics(registry, world),
    equip: async (item: any) => { bot.heldItem = item },
    setControlState: (key: keyof typeof IDLE, value: boolean) => { controls[key] = value },
    getControlState: (key: keyof typeof IDLE) => controls[key],
    clearControlStates: () => { controls = { ...IDLE } },
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    lookAt: async (point: Vec3) => {
      const d = point.minus(pick.eyeOf(bot))
      bot.entity.yaw = Math.atan2(-d.x, -d.z); bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    }
  })
  require('../src/swimming').install(bot)
  const confirmed: Vec3[] = []
  const sent: Vec3[] = []
  let serverPos = bot.entity.position.clone()
  // The server stub only accepts a legal, visible face and a cell outside the
  // previous transmitted body. Physics, controls and Y are never substituted.
  bot._genericPlace = async (ref: any, face: Vec3) => {
    const target = ref.position.plus(face)
    sent.push(target)
    assert.ok(pick.faceAim(bot, ref.position, face), 'placement must be possible through pick')
    const intersects = serverPos.x + .3 > target.x && serverPos.x - .3 < target.x + 1 &&
      serverPos.z + .3 > target.z && serverPos.z - .3 < target.z + 1 &&
      serverPos.y + 1.8 > target.y && serverPos.y < target.y + 1
    assert.equal(intersects, false, `placement intersects last server body at ${serverPos}: ${target}`)
    if (!receive) return
    clock.setTimeout(() => {
      const old = bot.blockAt(target); const block = set(target, 'cobblestone')
      stack.count--; confirmed.push(target); bot.emit('blockUpdate', old, block)
    }, 50)
  }
  bot.placeBlock = async (ref: any, face: Vec3) => { await bot._genericPlace(ref, face); await clock.sleep(50) }
  bot._placeBlockWithOptions = async (ref: any, face: Vec3, opts: any) => {
    assert.equal(opts.forceLook, 'ignore', 'no second async look between the cancel check and packet')
    await bot._genericPlace(ref, face); await clock.sleep(50)
  }
  const ctl: any = { aborted: false, onAbort: [] }
  const run = async (fn: () => Promise<any>, afterTick?: (tick: number) => void) => {
    let settled = false; let result: any; let error: any
    fn().then(v => { result = v; settled = true }, e => { error = e; settled = true })
    for (let tick = 0; tick < 500 && !settled; tick++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (settled) break
      const state = new native.PlayerState(bot, controls)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      serverPos = bot.entity.position.clone(); bot.emit('physicsTick')
      clock.advanceTicks(1); afterTick?.(tick)
    }
    assert.ok(settled, 'bounded skill completed in 25s of actual simulated ticks')
    if (error) throw error
    return result
  }
  return { bot, ctl, clock, run, confirmed, sent, stack, controls: () => controls, set }
}

for (const water of [false, true]) test(`tower: ${water ? 'water' : 'dry'} 3-block pit climbs in the original column with real physics`, async () => {
  const s = scene({ water })
  try {
    const result = await s.run(() => build.towerUp(s.bot, s.ctl, 3, { fast: true }))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.placed, 3, 'three blocks under the original feet, not an auxiliary step')
    assert.ok(s.bot.entity.onGround && s.bot.entity.position.y === 4, JSON.stringify(s.bot.entity))
    assert.equal(Math.floor(s.bot.entity.position.x), 0); assert.equal(Math.floor(s.bot.entity.position.z), 0)
    assert.equal(s.confirmed.filter(p => p.x === 0 && p.z === 0).length, 3)
    assert.equal(s.confirmed.length, result.placed + (result.supportPlaced || 0))
    assert.equal(32 - s.stack.count, s.confirmed.length)
    assert.deepEqual(s.controls(), IDLE)
  } finally { s.clock.dispose() }
})

test('tower: water arrival during a pathfinder bob uses the filled cell as the clearance origin', async () => {
  const s = scene({ arriving: true })
  try {
    const result = await s.run(() => build.towerUp(s.bot, s.ctl, 3, { fast: true }))
    assert.equal(result.ok, true, JSON.stringify({ result, pos: s.bot.entity.position, sent: s.sent, confirmed: s.confirmed }))
    assert.equal(result.placed, 3)
    assert.ok(s.bot.entity.onGround && s.bot.entity.position.y === 4)
    assert.equal(Math.floor(s.bot.entity.position.x), 0); assert.equal(Math.floor(s.bot.entity.position.z), 0)
    assert.equal(s.confirmed.length, result.placed + (result.supportPlaced || 0))
  } finally { s.clock.dispose() }
})

test('tower: abort during the side placement aim sends no placement or movement afterwards', async () => {
  const s = scene()
  const lookAt = s.bot.lookAt
  s.bot.lookAt = async (p: Vec3) => { await lookAt(p); if (p.y === 1 && p.x > 1) s.ctl.aborted = true }
  try {
    const result = await s.run(() => build.towerUp(s.bot, s.ctl, 3, { fast: true }))
    assert.equal(result.ok, false)
    assert.equal(s.sent.length, 0)
    assert.equal(result.placed + (result.supportPlaced || 0), 0)
    assert.deepEqual(s.controls(), IDLE)
  } finally { s.clock.dispose() }
})

test('tower: abort while centering a water arrival never starts a new control afterwards', async () => {
  const s = scene({ arriving: true })
  const lookAt = s.bot.lookAt; const setControlState = s.bot.setControlState
  const lateControls: string[] = []
  s.bot.lookAt = async (p: Vec3) => { await lookAt(p); s.ctl.aborted = true }
  s.bot.setControlState = (key, value) => { if (s.ctl.aborted && value) lateControls.push(key); setControlState(key, value) }
  try {
    const result = await s.run(() => build.towerUp(s.bot, s.ctl, 3, { fast: true }))
    assert.equal(result.ok, false)
    assert.deepEqual(lateControls, [])
    assert.equal(s.sent.length, 0)
    assert.deepEqual(s.controls(), IDLE)
  } finally { s.clock.dispose() }
})

test('tower: a missing block receipt never becomes ascent or an auxiliary placement', async () => {
  const s = scene({ receive: false })
  try {
    const result = await s.run(() => build.towerUp(s.bot, s.ctl, 3, { fast: true }))
    assert.equal(result.ok, false)
    assert.equal(result.placed + (result.supportPlaced || 0), 0)
    assert.equal(s.confirmed.length, 0); assert.equal(s.stack.count, 32)
    assert.equal(s.bot.entity.position.y, 1)
    assert.deepEqual(s.controls(), IDLE)
  } finally { s.clock.dispose() }
})

for (const obstacle of ['stone', 'lava', 'cobweb', null]) test(`tower: ${obstacle ?? 'unknown'} over every side face prevents a water boost`, async () => {
  const s = scene({ change: (p, name) => p.y === 2 && (p.x === 1 && p.z === 0 || p.x === 0 && p.z === 1) ? obstacle : name })
  try {
    const result = await s.run(() => build.towerUp(s.bot, s.ctl, 3, { fast: true }))
    assert.equal(result.ok, false)
    assert.equal(s.sent.length, 0)
    assert.equal(result.placed + (result.supportPlaced || 0), 0)
    assert.equal(s.bot.entity.position.y, 1)
    assert.deepEqual(s.controls(), IDLE)
  } finally { s.clock.dispose() }
})

test('tower: an existing low face is used before paying for an auxiliary block', async () => {
  const s = scene()
  s.set(new Vec3(0, 1, 1), 'stone')
  try {
    const result = await s.run(() => build.towerUp(s.bot, s.ctl, 3, { fast: true }))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.supportPlaced || 0, 0)
    assert.equal(s.confirmed.length, 3); assert.equal(s.stack.count, 29)
    assert.equal(s.bot.entity.position.y, 4)
  } finally { s.clock.dispose() }
})

test('climbBack: its report includes confirmed auxiliary support without counting it as climbed height', async () => {
  const s = scene()
  s.bot.pathfinder = { setGoal() {} }
  const target = { id: 2, type: 'player', _ndVisible: true, position: new Vec3(10, 4, .5), equipment: [] }
  try {
    const result = await s.run(() => require('../src/edges').climbBack(s.bot, s.ctl, target, { floorY: 4, maxMs: 15000 }))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(s.bot.entity.position.y, 4)
    assert.equal(result.placed, s.confirmed.length)
    assert.equal(32 - s.stack.count, result.placed)
  } finally { s.clock.dispose() }
})
