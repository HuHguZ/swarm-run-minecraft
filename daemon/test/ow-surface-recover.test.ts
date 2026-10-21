import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { cjsContext } from './cjs-context'
import { bodySource } from './source-fixture'

async function climb({ enabled = true, recover = true, dimension = 'overworld', sky = false,
  stairs = false, hidden = false, wet = false, lowCeiling = false, fixablePick = false,
  stock = [['cobblestone', 20]] as Array<[string, number]>, targetY = 18 } = {}) {
  const file = path.join(__dirname, '../src/survival/surface-body.ts'), realRequire = createRequire(file)
  const inventory = stock.map(([name, count]) => ({ name, count, type: name, slot: 9 }))
  const moves = { pillar: 0, stairs: 0, natural: 0, recovering: [] as boolean[], need: [] as number[] }
  const bot: any = {
    entity: { position: new Vec3(.5, 17, .5) }, health: 20, food: 20,
    game: { minY: -64, height: 384, dimension }, inventory: { items: () => inventory.filter(i => i.count > 0) },
    nearestEntity: () => null, clearControlStates() {}, stopDigging() {},
    blockAt(p) {
      const position = p.floored(), { x, y, z } = position
      const floor = stairs && z === 0 && x >= 2 ? 17 : 16
      let name = y <= floor ? 'stone' : 'air'
      if (stairs && x >= 2 && z === 0 && wet && y === 18) name = 'water'
      if (stairs && x >= 2 && z === 0 && lowCeiling && y === 19) name = 'stone'
      return { position, name, boundingBox: name === 'stone' ? 'block' : 'empty',
        shapes: name === 'stone' ? [[0, 0, 0, 1, 1, 1]] : [] }
    },
    // Use the real visibleLanding ray, with only the native ray result stubbed.
    world: { raycast: () => hidden ? { position: new Vec3(1, 18, 0) } : null }
  }
  const pickFiller = (require('../src/build') as typeof import('../src/build')).pickFiller
  const countItems = () => Object.fromEntries(bot.inventory.items().map(i => [i.name, i.count]))
  const context: any = { module: { exports: {} }, process: { env: { ND_OW_SURFACE_RECOVER: enabled ? '1' : '0' } }, bot, moves,
    require(name) {
      if (name === './enter-shelter') return {
        Vec3, SIDES: [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)],
        gameClock: { now: () => 0 }, xyz: p => ({ x: p.x, y: p.y, z: p.z }), countItems,
        diffItems: (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, (b[k] || 0) - a[k]])),
        pickFiller, toolBudget: () => Infinity, SWINGS_PER_LEVEL: 4,
        toolShortfall: (_bot, _data, p) => { moves.need.push(p.need); return fixablePick ? 'нужна новая кирка' : null },
        inWater: () => false, nearestHostile: () => null,
        digUp: async () => {
          const item = pickFiller(bot)
          if (!item) return { dug: 0, stopped: 'нечем строить' }
          item.count--; moves.pillar++; moves.recovering.push(bot._ndOwSurfaceRecovering); bot.entity.position.y++
          return { dug: 0 }
        }
      }
      if (name === './recover-loot') return {
        worldTop: () => 319, pitCheck: () => ({ out: false, free: false, sky }), openSky: () => sky,
        seenBy: () => null, wet: () => null, looseOver: () => null, FALLS: new Set(), legLevels: () => 4,
        levelWord: n => String(n), flat: (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
      }
      if (name === './out-of-water') return {
        stepUpInto: async (_bot, _ctl, cell) => {
          moves.natural++; moves.recovering.push(bot._ndOwSurfaceRecovering); bot.entity.position = cell.offset(.5, 0, .5); return true
        }, AGAIN_WONT_HELP: /нечем/
      }
      return realRequire(name)
    }
  }
  vm.runInNewContext(bodySource(file) + `
    stairStep = async () => { moves.stairs++; return { dug: 0, reason: 'ступень заблокирована' }; };
    stepAside = async () => undefined;
  `, cjsContext(context))
  const result = await context.module.exports.surface({ bot, mcData: {}, journal: { append() {} } },
    { aborted: false, onAbort: [] }, { targetY, preferPillar: true, recover, timeoutSeconds: 10 })
  return { result, moves, inventory: countItems(), recovering: bot._ndOwSurfaceRecovering }
}

test('OW recovery walks a visible natural stair across a flat landing before spending blocks', async () => {
  const { result, moves, inventory } = await climb({ stairs: true })
  assert.equal(result.climbed, 1)
  assert.equal(moves.natural, 2)
  assert.equal(moves.pillar, 0)
  assert.equal(inventory.cobblestone, 20)
})

test('OW recovery can use visible stairs without a pickaxe even if a replacement can be crafted', async () => {
  const { result, moves } = await climb({ stairs: true, fixablePick: true, stock: [] })
  assert.equal(result.climbed, 1)
  assert.equal(moves.natural, 2)
  assert.equal(moves.need.length, 0)
})

for (const option of [{ hidden: true }, { wet: true }, { lowCeiling: true }]) {
  test(`OW recovery keeps unsafe or unseen stairs out of the walking route ${JSON.stringify(option)}`, async () => {
    const { result, moves } = await climb({ stairs: true, ...option })
    assert.equal(moves.natural, 0)
    assert.equal(moves.pillar, 1)
    assert.equal(result.climbed, 1)
  })
}

test('OW recovery with open sky below the observed rim still climbs to the requested height', async () => {
  const { result, moves } = await climb({ sky: true })
  assert.equal(result.climbed, 1)
  assert.equal(moves.pillar, 1)
})

test('OW recovery needs no tool budget when the pillar column is already open', async () => {
  const { result, moves } = await climb({ fixablePick: true })
  assert.equal(result.climbed, 1)
  assert.equal(moves.need.length, 0)
})

test('an explicit recovery surface call suppresses reentrant drop handoff and restores its marker', async () => {
  const { moves, recovering } = await climb()
  assert.deepEqual(moves.recovering, [true])
  assert.equal(recovering, undefined)
})

for (const option of [{ enabled: false }, { recover: false }, { dimension: 'the_nether' }]) {
  test(`OW recovery leaves the existing open-sky arrival unchanged ${JSON.stringify(option)}`, async () => {
    const { result, moves } = await climb({ sky: true, ...option })
    assert.equal(result.climbed, 0)
    assert.equal(moves.pillar, 0)
    assert.equal(moves.natural, 0)
  })
}

for (const [name, count] of [['cobblestone', 20], ['diorite', 5]] as const) {
  test(`surface uses actual ${name} inventory before reporting no building blocks`, async () => {
    const { result, moves, inventory } = await climb({ stock: [[name, count]], targetY: 17 + count + 1 })
    assert.equal(moves.pillar, count)
    assert.equal(inventory[name], undefined)
    assert.match(result.stopped, /столб строить нечем/)
    assert.equal(result.climbed, count)
  })
}
