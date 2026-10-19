'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry as any)
import edges = require('../src/edges')
import build = require('../src/build')

// Same geometry as native c-shaft: 3x3 pit, feet117 -> field120, liquid only117.
// Use real Block collision/dig data; changing the lower layer is the causal stimulus.
function scene (bottom = 'air', { wet = false, change = null }: any = {}) {
  const bot: any = new EventEmitter()
  bot.registry = registry; bot.version = '1.21.11'; bot.health = 20
  bot.entity = { position: new Vec3(-.5, 117, .5), onGround: true, isInWater: wet, effects: {} }
  bot.inventory = { items: () => ['iron_sword', 'cobblestone'].map(name => ({ name, type: registry.itemsByName[name].id, count: name === 'cobblestone' ? 32 : 1 })) }
  bot.blockAt = p => {
    p = p.floored()
    const pit = Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1
    let name = p.y < 119 ? 'stone' : p.y === 119 ? 'smooth_stone' : 'air'
    if (pit && p.y >= 117 && p.y <= 119) name = p.y === 117 ? bottom : 'air'
    if (change) name = change(p, name, pit)
    if (name == null) return null
    const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
    block.position = p
    return block
  }
  const target = { position: new Vec3(3.5, 120, .5), equipment: [] }
  const find = () => edges.findShaft(bot, target, { floorY: 120, radius: 4 })
  return { bot, target, find }
}

test('shaft: water at feet117 retains the dry exit and its solid support', () => {
  const dry = scene().find()
  assert.ok(dry)
  assert.deepEqual({ gy: dry.gy, n: dry.n, bridge: dry.bridge, digMs: dry.digMs }, { gy: 117, n: 3, bridge: false, digMs: 0 })
  assert.deepEqual(scene('water').find(), dry, 'water geometry alone must not turn the shaft into a wall')
  assert.deepEqual(scene('water', { wet: true }).find(), dry, 'native wet flag must not hide the open exit behind slow digging alternatives')
})

test('shaft: lava, fire and cobweb in the body column remain unsafe', () => {
  for (const bottom of ['lava', 'fire', 'soul_fire', 'cobweb']) assert.equal(scene(bottom).find(), null, bottom)
})

test('shaft: solid headroom cannot be treated as water clearance', () => {
  const { find } = scene('water', { change: (p, name, pit) => pit && p.y === 118 ? 'bedrock' : name })
  assert.equal(find(), null)
})

test('shaft: exit needs room for the complete standing body', () => {
  for (const y of [120, 121]) {
    const { find } = scene('water', { change: (p, name, pit) => pit && p.y === y ? 'bedrock' : name })
    assert.equal(find(), null, 'blocked Y' + y)
  }
})

test('shaft: unknown body and exit cells do not become air', () => {
  for (const y of [117, 118, 120, 121]) {
    const { find } = scene('water', { change: (p, name, pit) => pit && p.y === y ? null : name })
    assert.equal(find(), null, 'unknown Y' + y)
  }
})

test('shaft: a waterlogged collision block is not an empty water cell', () => {
  const { bot, find } = scene('water')
  const original = bot.blockAt
  bot.blockAt = p => {
    const block = original(p)
    if (Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1 && p.y === 118) {
      const fence = Block.fromProperties(registry.blocksByName.oak_fence.id, { east: false, north: false, south: false, west: false, waterlogged: true }, 0)
      assert.equal(fence.getProperties().waterlogged, true)
      fence.position = p.floored()
      return fence
    }
    return block
  }
  assert.equal(find(), null)
})

test('climbBack: a water shaft reaches the existing tower executor without a bucket', async t => {
  const { bot, target } = scene('water', { wet: true })
  const ctl = { aborted: false }
  const goals = []
  bot.pathfinder = { setGoal: goal => goals.push(goal) }
  bot.setControlState = () => {}
  const calls = []
  // Stop at the executor boundary; only the native paired fixture proves ascent/placements.
  t.mock.method(build, 'towerUp', async (_bot, _ctl, n, options) => {
    calls.push({ n, options }); ctl.aborted = true
    return { ok: false, placed: 0, reason: 'test stopped at real tower dispatch' }
  })
  const result = await edges.climbBack(bot, ctl, target, { floorY: 120 })
  assert.ok(calls.length > 0, JSON.stringify(result))
  assert.equal(calls[0].n, 3)
  assert.equal(calls[0].options.fast, true)
  assert.ok(goals.some(goal => goal && goal.y === 117))
  assert.equal(result.ok, false, 'a dispatch is not a completed ascent')
})

test('climbBack: failure reports no found exit without inventing an obsidian ceiling', async () => {
  const { bot, target } = scene('air', { change: (p, name, pit) => pit && p.y === 121 ? null : name })
  const result = await edges.climbBack(bot, { aborted: false }, target, { floorY: 120 })
  assert.equal(result.ok, false)
  assert.equal(result.placed, 0)
  assert.match(result.why, /выход/)
  assert.doesNotMatch(result.why, /обсидиан/)
})
