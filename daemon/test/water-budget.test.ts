import { bodySource } from './source-fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { cjsContext } from './cjs-context'

const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11'), Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
import movement = require('../src/movement')
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
const IDLE = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
function pool() {
  const blocks = new Map(), read = p => {
    const q = p.floored(), name = q.x >= 1 && q.x <= 3 && q.z === 0 && q.y <= 6 && q.y >= 0 ? 'water' : 'air'
    const b = blocks.get(q.toString()) || Block.fromStateId(registry.blocksByName[name].defaultState); b.position = q; return b
  }
  const world: any = { getBlock: read, getColumn: (x, z) => ({ getBlockStateId: p => read(new Vec3(x * 16 + p.x, p.y, z * 16 + p.z)).stateId }) }
  const bot: any = { registry, world, version: '1.21.11', health: 20, food: 20, oxygenLevel: 20, entity: { position: new Vec3(.5, 3, .5), yaw: 0, pitch: 0, metadata: [], velocity: new Vec3(0, 0, 0), effects: {}, attributes: {}, isInWater: true, onGround: false },
    inventory: { slots: [], items: () => [] }, blockAt: read, game: { minY: -64, height: 384, dimension: 'overworld' }, getControlState: () => false }
  bot.entity.metadata[registry.entitiesByName.player.metadataKeys.indexOf('air_supply')] = 300
  return { bot, read, blocks }
}

test('A6 water price: deep crossing costs more than surface; low air increases price without forbidding water', () => {
  const { bot, read } = pool(), key = registry.entitiesByName.player.metadataKeys.indexOf('air_supply')
  const high = movement.waterStepCost(bot, read(new Vec3(2, 3, 0)))
  assert.ok(high > movement.waterStepCost(bot, read(new Vec3(2, 6, 0))))
  bot.entity.metadata[key] = 0
  const low = movement.waterStepCost(bot, read(new Vec3(2, 3, 0)))
  assert.ok(low > high && low < 100); assert.equal(movement.waterStepCost(bot, read(new Vec3(0, 3, 0))), 0)
  const old = process.env.ND_WATER_ESCAPE_BUDGET
  try { process.env.ND_WATER_ESCAPE_BUDGET = '0'; assert.equal(movement.waterStepCost(bot, read(new Vec3(2, 3, 0))), 0) }
  finally { if (old === undefined) delete process.env.ND_WATER_ESCAPE_BUDGET; else process.env.ND_WATER_ESCAPE_BUDGET = old }
})

test('A6 waterlogged lichen has source-water flow, not a metadata-induced falling current', () => {
  const vy = (lichen: boolean) => {
    const { bot, blocks } = pool(); bot.entity.position = new Vec3(2.5, 3, .5); bot.entity.metadata[6] = 0
    if (lichen) for (let y = 2; y <= 5; y++) {
      const d = registry.blocksByName.glow_lichen
      let b
      for (let sid = d.minStateId; sid <= d.maxStateId; sid++) { const c = Block.fromStateId(sid); if (c.getProperties().waterlogged && c.getProperties().west && c.metadata >= 8) { b = c; break } }
      assert.ok(b && b.metadata >= 8); blocks.set(new Vec3(2, y, 0).toString(), b)
    }
    for (let y = 1; y <= 7; y++) blocks.set(new Vec3(1, y, 0).toString(), Block.fromStateId(registry.blocksByName.stone.defaultState))
    bot.physics = native.Physics(registry, bot.world)
    const state = new native.PlayerState(bot, { ...IDLE, jump: true })
    bot.physics.simulatePlayer(state, bot.world); assert.equal(state.isInWater, true)
    return state.vel.y
  }
  assert.ok(Math.abs(vy(true) - vy(false)) < 1e-9)
})

test('A6 native swimming: compact body and pitch steering follow Player.travel, including vertical-only input', () => {
  const { bot } = pool(); bot.entity.position = new Vec3(2.5, 3, .5); bot.entity.metadata[6] = 3; bot.entity.pitch = Math.PI / 2; bot.entity.yaw = 0
  bot.physics = native.Physics(registry, bot.world)
  const state = new native.PlayerState(bot, { ...IDLE, jump: true, sprint: true })
  bot.physics.simulatePlayer(state, bot.world)
  assert.equal(state.ndPoseHeight, .6); assert.equal(state.ndSwimming, true)
  assert.ok(Math.abs(state.vel.y - ((.04 + (1 - .04) * .06) * .8 - bot.physics.waterGravity)) < 1e-6, JSON.stringify({ vy: state.vel.y, gravity: bot.physics.waterGravity, pitch: state.pitch }))
  bot.entity.position.y = 3.36; bot.entity.metadata[6] = 0
  const fullColumn = new native.PlayerState(bot, { ...IDLE, sprint: true, forward: true })
  bot.physics.simulatePlayer(fullColumn, bot.world)
  assert.equal(fullColumn.ndSwimming, true, 'water below water fills the entire cell, including eyes above 8/9')
  bot.entity.position.y = 3; bot.entity.metadata[6] = 3; bot.entity.elytraFlying = true; bot.inventory.slots[6] = { name: 'elytra' }
  const glide = new native.PlayerState(bot, { ...IDLE, sprint: true, jump: true })
  bot.physics.simulatePlayer(glide, bot.world)
  assert.ok(Math.abs(glide.vel.y - (.04 * .8 - bot.physics.waterGravity)) < 1e-6, 'stale swimming metadata does not add pitch steering to a glide')
})

test('A6 mine and explore price a wet approach to dry coal; the sole wet candidate stays available', async () => {
  const { bot } = pool(), file = path.join(__dirname, '../src/actions.js'), req = createRequire(file), dug: any[] = []
  const wet = { name: 'coal_ore', type: registry.blocksByName.coal_ore.id, position: new Vec3(4, 3, 0) }
  const dry = { ...wet, position: new Vec3(0, 3, 6) }
  let choices = [wet, dry]
  Object.assign(bot, { canDigBlock: () => true, dig: async b => { dug.push(b.position) }, pathfinder: { setGoal() {} } })
  const ctx: any = { module: { exports: {} }, console, process, setTimeout, clearTimeout, require: name => {
    const actual = req(name)
    if (name === './items') return { ...actual, resolveBlockIds: () => [wet.type], equipBestTool: async () => {}, missingHarvestTool: () => null }
    if (name === './sight') return { visibleOf: (_b, _ids, _r, opts) => choices.filter(c => !opts.skip?.(c.position)).slice(0, opts.max) }
    return actual
  } }
  vm.runInNewContext(bodySource(file), cjsContext(ctx))
  const s = { bot, cfg: { fairPlay: true }, mcData: registry }, ctl = { aborted: false, onAbort: [] }
  const found = await ctx.module.exports.explore(s, ctl, { block: 'coal_ore', dry: true })
  assert.equal(found.at.z, 6)
  await ctx.module.exports.mine(s, ctl, { block: 'coal_ore', collect: false, dry: true })
  assert.equal(dug[0].z, 6)
  choices = [wet]
  await ctx.module.exports.mine(s, ctl, { block: 'coal_ore', collect: false, dry: true })
  assert.equal(dug[1].x, 4)
})

test('A6 failed roof dig is retried after a block change, not on each Surface call', async () => {
  const { bot } = pool(), clocks: typeof import('../src/game-clock') = require('../src/game-clock'), clock = clocks.activate(new clocks.GameClock({ manual: true, epoch: 0 }))
  let roof = 'stone', digs = 0
  const read = p => {
    const q = p.floored(), name = q.x === 0 && q.z === 0 && q.y >= 0 && q.y <= 1 ? 'water' : q.x === 0 && q.z === 0 && q.y === 2 ? roof : 'stone'
    const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = q; return b
  }
  bot.entity.position = new Vec3(.5, 0, .5); bot.entity.onGround = true
  const airKey = registry.entitiesByName.player.metadataKeys.indexOf('air_supply'); bot.entity.metadata[airKey] = 30
  Object.assign(bot, { blockAt: read, heldItem: null, canDigBlock: () => true, dig: async () => { digs++; throw Error('server refused') }, stopDigging() {}, pathfinder: { setGoal() {} }, clearControlStates() {}, setControlState() {}, lookAt: async () => {} })
  bot.world.getBlock = read; bot.world.getColumn = (x, z) => ({ getBlockStateId: p => read(new Vec3(x * 16 + p.x, p.y, z * 16 + p.z)).stateId })
  const ctl = { aborted: false, onAbort: [] }
  const attempt = async () => {
    let done = false
    const p = movement.escapeWater(bot, ctl, { visibleOnly: true, timeoutMs: 1500 }).finally(() => { done = true })
    for (let i = 0; i < 60 && !done; i++) { await new Promise<void>(r => setImmediate(r)); clock.advanceTicks(1) }
    assert.equal(done, true); return p
  }
  try { await attempt(); assert.equal(digs, 1); await attempt(); assert.equal(digs, 1); bot.entity.metadata[airKey] = 300; await attempt(); assert.equal(digs, 2); roof = 'dirt'; await attempt(); assert.equal(digs, 3) }
  finally { ctl.aborted = true; clock.dispose() }
})
