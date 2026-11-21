import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { FastBlocks } from '../src/fastblocks'
import { dangers } from '../src/threats'

const registry = require('prismarine-registry')('1.21.11')
const World = require('prismarine-world')('1.21.11'), Chunk = require('prismarine-chunk')('1.21.11')
function scene() {
  const world = new World().sync
  world.setColumn(0, 0, new Chunk(), false)
  let reads = 0
  const bot: any = Object.assign(new EventEmitter(), { _client: new EventEmitter(), registry, world, entities: {}, players: {},
    entity: { id: 1, position: new Vec3(5.5, 120, 5.5), height: 1.8 }, ndClock: { ticks: 1 },
    blockAt(p) { reads++; return bot.world.getBlock(p) } })
  bot._ndFastBlocks = new FastBlocks(bot)
  bot._ndFastBlocks.attach(world)
  const scan = () => dangers(bot, { foes: [] })
  const put = (x, y, z, name) => bot.world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState)
  return { bot, world, scan, put, get reads() { return reads } }
}

test('forty stationary bodies on a dry floor avoid repeating the 75-cell lava survey on each danger tick', () => {
  const bodies = Array.from({ length: 40 }, scene)
  let first = 0
  for (let tick = 0; tick < 12; tick++) {
    for (const f of bodies) { f.bot.ndClock.ticks++; assert.deepEqual(f.scan().lava, []) }
    if (!tick) first = bodies.reduce((sum, f) => sum + f.reads, 0)
  }
  assert.ok(first >= 40 * 75)
  const after = bodies.reduce((sum, f) => sum + f.reads, 0)
  assert.equal(after, first * 12 - 40 * 11 * 75, 'web and other live observations still run on every tick')
})

test('a same-tick block or column change invalidates a dry survey; sight still decides whether lava is visible', () => {
  const f = scene()
  for (let y = 120; y <= 121; y++) f.put(6, y, 5, 'stone')
  assert.deepEqual(f.scan().lava, [])
  f.put(7, 120, 5, 'lava')
  assert.deepEqual(f.scan().lava, [], 'lava behind the opaque wall stays hidden')
  f.put(6, 121, 5, 'air'); f.put(6, 120, 5, 'air')
  assert.deepEqual(f.scan().lava.map(l => l.at), [{ x: 7, y: 120, z: 5 }])
  f.world.unloadColumn(0, 0)
  assert.deepEqual(f.scan().lava, [])
  const replacement = new Chunk()
  replacement.setBlockStateId(new Vec3(4, 120, 5), registry.blocksByName.lava.defaultState)
  f.world.setColumn(0, 0, replacement, false)
  assert.deepEqual(f.scan().lava.map(l => l.at), [{ x: 4, y: 120, z: 5 }])
})

test('walking into another cell or loading another world rechecks terrain; a new entity stays visible in a dry cell', () => {
  const f = scene()
  f.put(8, 120, 5, 'lava')
  assert.deepEqual(f.scan().lava, [])
  f.bot.entities[2] = { id: 2, name: 'tnt', position: f.bot.entity.position.offset(3, 0, 0), metadata: [] }
  f.bot.ndClock.ticks++
  assert.equal(f.scan().blasts[0]?.id, 2)
  f.bot.entity.position.x++
  assert.deepEqual(f.scan().lava.map(l => l.at), [{ x: 8, y: 120, z: 5 }])
  f.bot.world = new World().sync
  f.bot.world.setColumn(0, 0, new Chunk(), false)
  assert.deepEqual(f.scan().lava, [])
})

test('a client without world change notifications surveys its current blocks on the next tick', () => {
  const f = scene()
  delete f.bot._ndFastBlocks
  assert.deepEqual(f.scan().lava, [])
  f.put(6, 120, 5, 'lava')
  f.bot.ndClock.ticks++
  assert.deepEqual(f.scan().lava.map(l => l.at), [{ x: 6, y: 120, z: 5 }])
})
