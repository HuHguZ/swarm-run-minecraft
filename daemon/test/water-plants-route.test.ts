import test from 'node:test'
import assert from 'node:assert/strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import movement = require('../src/movement')
import { shoreRoute } from '../src/survival/hold-out'
import { waterLevel, standingInSource } from '../src/survival/out-of-water'
import * as geometry from '../src/navigation/geometry'
const geometryRegistry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const NativeBlock = (require('prismarine-block') as typeof import('prismarine-block'))(geometryRegistry as any)

function geometryPool(name: string | null, head = 'air') {
  return { blockAt(at: any) {
    const p = at.floored()
    if (name === null && p.x === 0 && p.y === 64 && p.z === 0) return null
    const blockName = p.y === 63 ? 'stone' : p.x === 0 && p.z === 0 && p.y === 64 ? name : p.x === 0 && p.z === 0 && p.y === 65 ? head : 'air'
    const block = NativeBlock.fromStateId(geometryRegistry.blocksByName[blockName!].defaultState, 0)
    block.position = p
    return block
  } }
}

for (const name of ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']) {
  test(`${name} is a wet landing rather than a dry stand in shared body geometry`, () => {
    const world = geometryPool(name)
    const position = new Vec3(.5, 64, .5)
    assert.equal(geometry.bodyClear(world, position), false)
    assert.equal(geometry.bodyClear(world, position, { water: true }), true)
    assert.equal(geometry.containsWater(world.blockAt(position)), true)
    assert.deepEqual(geometry.standPositions(world, position, { rise: 0, drop: 0 }), [])
    assert.ok(geometry.waterEntries(world, position.floored()).length > 0)
  })
}

test('shared geometry keeps dry grass and air dry', () => {
  for (const name of ['short_grass', 'air']) {
    const world = geometryPool(name)
    const position = new Vec3(.5, 64, .5)
    assert.equal(geometry.bodyClear(world, position), true)
    assert.equal(geometry.containsWater(world.blockAt(position)), false)
    assert.deepEqual(geometry.waterEntries(world, position.floored()), [])
  }
})

test('water permission still rejects unknown cells and lava', () => {
  for (const name of [null, 'lava']) {
    const world = geometryPool(name)
    const position = new Vec3(.5, 64, .5)
    assert.equal(geometry.bodyClear(world, position), false)
    assert.equal(geometry.bodyClear(world, position, { water: true }), false)
    assert.deepEqual(geometry.waterEntries(world, position.floored()), [])
  }
})

test('plant water entries still require head clearance', () => {
  for (const name of ['water', 'seagrass']) {
    const world = geometryPool(name, 'stone')
    const position = new Vec3(.5, 64, .5)
    assert.equal(geometry.bodyClear(world, position, { water: true }), false)
    assert.deepEqual(geometry.waterEntries(world, position.floored()), [])
  }
})

test('shared water geometry preserves native waterlogging and the flowing-water alias', () => {
  const slab = geometryRegistry.blocksByName.oak_slab
  const blocks = Array.from({ length: slab.maxStateId - slab.minStateId + 1 }, (_v, i) => NativeBlock.fromStateId(slab.minStateId + i, 0))
  const waterlogged = blocks.find(block => block.getProperties().waterlogged === true)
  assert.ok(waterlogged)
  assert.equal(geometry.containsWater(waterlogged), true)
  assert.equal(geometry.containsWater({ name: 'flowing_water' } as any), true)
})

function plantedPool(name: string) {
  return {
    oxygenLevel: 20,
    entity: { position: new Vec3(.5, 0, .5), isInWater: false, onGround: true },
    blockAt(at: any) {
      const p = at.floored()
      let block = 'stone'
      if (p.z === 0 && p.x >= 0 && p.x <= 3) {
        if (p.y === -1) block = 'dirt'
        if (p.y === 0) block = p.x < 3 ? name : 'air'
        if (p.y === 1 || p.y === 2) block = 'air'
      }
      return { name: block, position: p, boundingBox: /^(air|water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant|short_grass)$/.test(block) ? 'empty' : 'block' }
    }
  }
}

for (const name of ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']) {
  test(`${name} contains water and cannot become a zero-step dry bank`, () => {
    const bot = plantedPool(name)
    bot.entity.isInWater = true
    const route = movement.findSwimRoute(bot)
    assert.equal(route.kind, 'land')
    assert.deepEqual(route.target, new Vec3(3, 0, 0))
    assert.ok(route.path.length > 0)
    assert.deepEqual(movement.findNearestLand(bot, 4), new Vec3(3, 0, 0))
    assert.deepEqual(shoreRoute(bot).target, new Vec3(3, 0, 0))
  })
  test(`${name} block receipt suffices when the native fluid flag fluctuates`, () => {
    const bot = plantedPool(name)
    assert.equal(movement.inWater(bot), true)
    const block = bot.blockAt(bot.entity.position)
    Object.assign(block, { metadata: 1, getProperties: () => ({ half: 'upper', age: 14 }) })
    assert.equal(waterLevel(block), 0, 'plant half/age metadata is not a flowing water level')
    assert.equal(standingInSource(bot, bot.entity.position.floored()), true)
  })
}

test('ordinary dry grass remains dry ground', () => {
  const bot = plantedPool('short_grass')
  assert.equal(movement.inWater(bot), false)
  assert.equal(movement.findSwimRoute(bot).path.length, 0)
})

test('native pathfinder uses the existing water cost and swim moves for aquatic plants', () => {
  const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry as any)
  const { Movements }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const { tuneMovements }: typeof import('../src/worlds') = require('../src/worlds')
  let name = 'seagrass'
  const bot: any = { registry, entity: { position: new Vec3(.5, 64, .5) }, game: { dimension: 'overworld' },
    blockAt(p: any) { const b = Block.fromStateId(registry.blocksByName[name].defaultState, 0); b.position = p.floored(); return b } }
  const movements: any = new Movements(bot)
  tuneMovements(bot, movements)
  for (name of ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']) {
    assert.equal(movements.getBlock(bot.entity.position, 0, 0, 0).liquid, true, `${name} must reach the native fluid branch`)
    assert.equal(movements.blocksToAvoid.has(registry.blocksByName[name].id), false, 'water remains an available route')
  }
  assert.equal(movements.liquidCost, 3, 'retain the established water price')
  name = 'short_grass'
  assert.equal(movements.getBlock(bot.entity.position, 0, 0, 0).liquid, false)
})
