import test from 'node:test'
import assert from 'node:assert/strict'
import { foodIgnitionAllowed, type FoodIgnitionWindow } from '../src/pvp/food-fire'
import { createTerrain } from '../src/pvp/terrain'

const window: FoodIgnitionWindow = { purpose: 'food', animal: 'cow', remainingUses: 64,
  grounded: true, visible: true, burning: false, selfSafe: true, terrainSafe: true }
test('food ignition requires an edible target, safe visible dry ground and a reserved portal lighter', () => {
  assert.equal(foodIgnitionAllowed(window), true)
  assert.equal(foodIgnitionAllowed({ ...window, animal: 'enderman' }), false)
  assert.equal(foodIgnitionAllowed({ ...window, purpose: 'defense' }), false)
  assert.equal(foodIgnitionAllowed({ ...window, remainingUses: 4 }), false)
  assert.equal(foodIgnitionAllowed({ ...window, terrainSafe: false }), false)
  assert.equal(foodIgnitionAllowed({ ...window, selfSafe: false }), false)
  assert.equal(foodIgnitionAllowed({ ...window, visible: false }), false)
})

test('existing ground-use ignition emits only with an honest face and requires server fire receipt', async () => {
  const Vec3 = require('vec3')
  let now = 0; let clicks = 0; let sees = true; let fire = false
  const item = { name: 'flint_and_steel' }
  const base = { name: 'stone', boundingBox: 'block', position: new Vec3(0, 0, 0) }
  const ctx: Record<string, any> = {
    ctl: { aborted: false }, Vec3, gameClock: { now: () => now }, pick: { faceAim: () => sees ? new Vec3(.5, 1, .5) : null },
    bot: { heldItem: item, blockAt: () => base, async lookAt() {}, async _genericPlace(_block, _face, options) {
      assert.deepEqual(options.delta, new Vec3(.5, 1, .5)); assert.equal(options.forceLook, 'ignore'); clicks++
    } },
    async holdItem() { return true }, sleep: async (ms: number) => { now += ms },
    withTimeout: async (work: Promise<unknown>) => work, blockName: () => fire ? 'fire' : 'air', used() {}
  }
  const terrain = createTerrain(ctx)
  assert.equal(await terrain.useOnGroundAt(item, new Vec3(0, 1, 0), 'ignite'), false)
  assert.equal(clicks, 1, 'sending click alone is not success')
  fire = true
  assert.equal(await terrain.useOnGroundAt(item, new Vec3(0, 1, 0), 'ignite'), true)
  sees = false
  assert.equal(await terrain.useOnGroundAt(item, new Vec3(0, 1, 0), 'ignite'), false)
  assert.equal(clicks, 2, 'occluded face produces no click')
  sees = true; ctx.ctl.aborted = true
  assert.equal(await terrain.useOnGroundAt(item, new Vec3(0, 1, 0), 'ignite'), false)
  assert.equal(clicks, 2, 'cancelled maneuver produces no click')
})
