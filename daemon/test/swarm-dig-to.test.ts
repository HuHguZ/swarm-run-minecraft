import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { terrainMethods } from '../src/rpc/terrain'
import { cacheMethods } from '../src/rpc/caches'
import { faceAim } from '../src/pick'
import { FACES } from '../src/build'
import { testBot, testClock } from './tick-plugins-fixture'
import { createTickPlugins } from '../src/tick-plugins'

const data = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')('1.21.11')
const WorldSync = require('prismarine-world/src/worldsync')

function scene() {
  const blocks = new Map<string, string>()
  const dug: { name: string; pos: Vec3; aim: Vec3; mode: string; clickable: boolean }[] = []
  const controls = new Set<string>()
  const readsBeforeSwing = new Set<string>()
  const ctl = { aborted: false, onAbort: [] }
  let aim: Vec3, walked = 0
  const bot: any = Object.assign(testBot(), {
    version: '1.21.11', _client: new EventEmitter(), entities: {}, pathfinder: { setGoal() {} },
    game: { minY: -64, height: 384 }, registry: data, inventory: { items: () => [], slots: [] },
    entity: { position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true },
    blockAt(v) {
      const p = v.floored(), name = blocks.get(p.toString()) ?? (p.y === 63 ? 'stone' : 'air')
      if (!dug.length) readsBeforeSwing.add(p.toString())
      if (name === 'unloaded') return null
      const b = Block.fromStateId(data.blocksByName[name].defaultState, 0); b.position = p; return b
    },
    async lookAt(at) { aim = at },
    async dig(b, mode) {
      const clickable = FACES.some(f => faceAim(bot, b.position, f)?.equals?.(aim))
      dug.push({ name: b.name, pos: b.position, aim, mode, clickable })
      blocks.set(b.position.toString(), 'air')
      bot._client.emit('block_change', { location: b.position, type: data.blocksByName.air.defaultState })
    },
    async waitForTicks() {
      if (controls.has('forward')) { walked++; bot.entity.position = new Vec3(aim.x, 64, aim.z) }
    },
    setControlState(name, on) { if (on) controls.add(name); else controls.delete(name) },
    clearControlStates() { controls.clear() }
  })
  bot.world = { getBlock: p => bot.blockAt(p), raycast: WorldSync.prototype.raycast }
  const session: any = { require: () => bot, runIntent: (_name, run) => run(ctl) }
  const digTo = (p = {}) => terrainMethods({ session } as any).dig_to({ at: { x: 8.5, y: 64, z: .5 }, maxSteps: 1, ...p })
  const set = (x, y, z, name) => blocks.set(new Vec3(x, y, z).toString(), name)
  const wall = () => { for (const z of [-1, 0, 1]) for (const y of [64, 65, 66]) set(1, y, z, 'stone') }
  return { bot, digTo, set, wall, dug, ctl, readsBeforeSwing, walked: () => walked }
}

test('dig_to breaches a visible wall with the same first swing with or without concealed water', async () => {
  for (const back of ['air', 'water', 'lava']) {
    const s = scene(); s.wall(); s.set(2, 64, 0, back)
    const r: any = await s.digTo()
    assert.ok(s.dug.length, back)
    assert.deepEqual(s.dug[0].pos, new Vec3(1, 64, 0))
    assert.ok(!s.readsBeforeSwing.has(new Vec3(2, 64, 0).toString()), 'a packet behind the sealed wall is not an observation')
    assert.ok(s.dug.every(d => d.clickable && d.mode === 'ignore'), back)
    if (back === 'air') { assert.equal(r.dug, 2); assert.equal(s.walked(), 1) }
    else { assert.equal(s.walked(), 0); assert.match(r.why, /water|lava/) }
  }
})

test('dig_to replans after a knockback during aiming and never swings on a stale sightline', async () => {
  const s = scene(); s.wall()
  const look = s.bot.lookAt
  s.bot.lookAt = async at => { await look(at); s.bot.entity.position.set(-12, 64, .5) }
  await s.digTo()
  assert.equal(s.dug.length, 0)
})

test('an assigned cache tunnel stops at the first genuinely visible chest instead of mining its contents', async () => {
  const s = scene(); s.wall(); s.set(2, 64, 0, 'chest')
  const result: any = await s.digTo({ maxSteps: 5, seekChest: true })
  assert.deepEqual(s.dug.map(d => d.name), ['stone', 'stone'])
  assert.deepEqual(result.exposedChest, { x: 2, y: 64, z: 0 })
  assert.equal(s.walked(), 1)
})

test('a miner names the observed missing step after opening a passage without advancing', async () => {
  const f = scene()
  f.wall(); f.set(1, 63, 0, 'air')
  const r: any = await f.digTo()
  assert.equal(r.dug, 2); assert.equal(r.steps, 0)
  assert.deepEqual(r.missingFooting, { x: 1, y: 63, z: 0 })
  assert.equal(f.walked(), 0)
})

test('an ordinary cache scan distinguishes standable repair of the known gap from a hidden or hazardous voxel', async () => {
  const floor = { x: 1, y: 63, z: 0 }
  for (const mode of ['stone', 'slab', 'torch', 'magma_block', 'sand', 'hidden', 'air']) {
    const f = scene()
    f.set(1, 63, 0, mode === 'slab' ? 'stone_slab' : mode === 'hidden' ? 'stone' : mode)
    if (mode === 'hidden') for (const x of [0, 1]) f.set(x, 64, 0, 'stone')
    const session: any = { require: () => f.bot, immediate: fn => fn() }
    const r = await cacheMethods({ session } as any).cache_scan({ rays: 32, range: 2, pie: false, chestRange: 1, checkFootings: [floor] })
    assert.deepEqual(r.standableFootings, mode === 'stone' || mode === 'slab' ? [floor] : [], mode)
  }
})

test('dig_to sends the selected west face on both native digging packets and receives server air', async () => {
  const s = scene(), clock = testClock(), { bot } = s
  s.wall()
  bot.game.gameMode = 'survival'; bot.entity.effects = {}
  const hits = []; bot._client.write = (name, packet) => {
    if (name !== 'block_dig') return
    hits.push(packet)
    if (packet.status === 2) {
      const p = packet.location
      s.set(p.x, p.y, p.z, 'air')
      bot._client.emit('block_change', { location: p, type: data.blocksByName.air.defaultState })
    }
  }
  createTickPlugins(clock).plugins.digging(bot)
  bot.digTime = () => 50
  try {
    const run = s.digTo()
    await new Promise(resolve => setImmediate(resolve))
    await clock.advanceGame(500)
    const r: any = await run
    assert.equal(r.dug, 2)
    const west = require('prismarine-world').iterators.BlockFace.WEST
    assert.deepEqual(hits.map(h => [h.status, h.face]), [[0, west], [2, west], [0, west], [2, west]])
  } finally { bot.emit('end') }
})

test('dig_to refuses the first step across a remembered danger radius or onto the kill plane', async () => {
  for (const limits of [{ avoid: [{ x: 1, y: 64, z: .5, r: .2 }] }, { killY: 64 }]) {
    const s = scene(); s.wall()
    await s.digTo({ arena: { x: .5, z: .5, r: 20, ...limits } })
    assert.equal(s.dug.length, 0); assert.equal(s.walked(), 0)
  }
})

test('dig_to cannot reach stone through a glass block containing the eye', async () => {
  const s = scene(); s.wall(); s.set(0, 65, 0, 'glass')
  await s.digTo()
  assert.equal(s.dug.length, 0); assert.equal(s.walked(), 0)
})

test('dig_to keeps the block under its feet above both an unseen floor and void', async () => {
  for (const below of ['air', 'stone']) {
    const s = scene(); s.set(0, 62, 0, below)
    await s.digTo({ at: { x: .5, y: 56, z: .5 } })
    assert.equal(s.dug.length, 0, below)
  }
})

test('dig_to can descend when glass reveals a safe floor, and can walk on a visible lower slab', async () => {
  const s = scene()
  s.set(0, 63, 0, 'glass'); s.set(0, 62, 0, 'stone')
  s.bot.waitForTicks = async () => { s.bot.entity.position.y = 63 }
  const down: any = await s.digTo({ at: { x: .5, y: 56, z: .5 } })
  assert.equal(down.steps, 1); assert.deepEqual(s.dug.map(d => d.name), ['glass'])
  const h = scene(); h.set(1, 63, 0, 'stone_slab')
  await h.digTo()
  assert.equal(h.walked(), 1)
})

test('dig_to cancels the native swing when the visible landing disappears during a vertical cut', async () => {
  const s = scene(), { bot } = s, clock = testClock(), packets = []
  s.set(0, 63, 0, 'glass'); s.set(0, 62, 0, 'stone')
  bot.game.gameMode = 'survival'; bot.entity.effects = {}
  bot._client.write = (name, p) => { if (name === 'block_dig') packets.push(p.status) }
  createTickPlugins(clock).plugins.digging(bot)
  bot.digTime = () => 1000
  try {
    const running = s.digTo({ at: { x: .5, y: 55, z: .5 } })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(packets, [0])
    s.set(0, 62, 0, 'air'); bot.emit('physicsTick')
    await clock.advanceGame(1100)
    const r: any = await running
    assert.equal(r.dug, 0); assert.equal(r.steps, 0); assert.deepEqual(packets, [0, 1])
  } finally { bot.emit('end') }
})

test('dig_to checks arena before the first swing and refuses unsafe or unloaded footing', async () => {
  const s = scene(); s.wall()
  await s.digTo({ arena: { x: .5, z: .5, r: 2 } })
  assert.equal(s.dug.length, 0); assert.equal(s.walked(), 0)
  for (const floor of ['unloaded', 'magma_block', 'lava']) {
    const h = scene(); h.set(1, 63, 0, floor)
    await h.digTo()
    assert.equal(h.walked(), 0, floor)
  }
})

test('a miner in ordinary solo pursuit opens a visible passage to a weak camper reported by teammates', async () => {
  const { createSwarmDriver } = require('../../farm/swarm/swarm-driver')
  const { swarmMethods } = require('../src/rpc/swarm')
  for (const mode of ['missed twice', 'lost behind wall', 'interrupted cut', 'open', 'old clue', 'moved during inspection', 'armored opponent', 'bedrock']) {
    const s = scene(), rpc = swarmMethods({ session: { require: () => s.bot, immediate: fn => fn() } })
    let now = 1000, digs = 0, checks = 0
    const enemy = { id: 'Camper', visible: true, position: { x: 3.3, y: 64, z: .5 }, equipment: { weapon: 'wooden_sword', armor: [] } }
    const bots = Array.from({ length: 40 }, (_, i) => ({ name: 'Bot' + i, team: 'blue', c: { async call(method, params) {
      if (method === 'fight') return { status: 'done', detail: { landed: 0, swings: 0 } }
      if (method === 'swarm_pose' && params.inspectOnly) {
        checks++
        if (mode === 'moved during inspection') {
          now += 50
          for (const scout of bots.slice(1, 3)) driver.observe(scout, [{ ...enemy, position: { ...enemy.position, z: 8.5 } }])
        }
        return { status: 'done', detail: await rpc.swarm_pose(params) }
      }
      if (method === 'dig_to') {
        digs++
        if (mode === 'interrupted cut' && digs === 1) return { status: 'interrupted', by: { type: 'cancelled' } }
        return { status: 'done', detail: await s.digTo(params) }
      }
      return { status: 'done', detail: {} }
    } } }))
    const pos = Object.fromEntries(bots.map((b, i) => [b.name, { hp: 20,
      p: i === 1 || i === 2 ? { x: 3.5, y: 64, z: 4 + i } : { x: i ? -1 - i : .5, y: 64, z: i ? i % 2 : .5 },
      inv: { iron_sword: 1, iron_pickaxe: 1 }, armor: { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' } }]))
    const driver = createSwarmDriver({ bots, pos, alive: () => true, arms: true, aggressive: false,
      arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => pos.Bot0.p, hostile: (_, name) => name === enemy.id,
      humanNames: () => [enemy.id], log() {}, now: () => now })
    if (mode !== 'open') s.wall()
    if (mode === 'bedrock') for (const y of [64,65,66]) s.set(1, y, 0, 'bedrock')
    if (mode === 'armored opponent') {
      enemy.equipment = { weapon: 'netherite_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'] }
      pos.Bot0.hp = 4
    }
    const report = () => { for (const scout of bots.slice(1, 3)) driver.observe(scout, [enemy]) }
    report()
    if (mode === 'lost behind wall' || mode === 'old clue') {
      now += mode === 'old clue' ? 4000 : 750
    } else for (let i = 0; i < 2; i++) { await driver.turn(bots[0]); now += 600; report() }
    await driver.turn(bots[0])
    if (mode === 'interrupted cut') { now += 2200; report(); await driver.turn(bots[0]) }
    if (mode === 'missed twice' || mode === 'lost behind wall' || mode === 'interrupted cut') {
      assert.equal(digs, mode === 'interrupted cut' ? 2 : 1, mode)
      assert.deepEqual(s.dug.map(h => h.pos.y), [64, 65], mode)
      assert.ok(s.dug.every(h => h.clickable && h.pos.x === 1), mode)
      assert.equal(s.walked(), 1)
    } else {
      assert.equal(digs, 0, mode); assert.equal(s.dug.length, 0, mode)
      if (mode === 'moved during inspection') assert.equal(checks, 1)
    }
  }
})
