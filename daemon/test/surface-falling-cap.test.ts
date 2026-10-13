import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const Vec3 = require('vec3')
const { transformSync } = require('esbuild')

async function climb(cap: string, count = 2) {
  const file = path.join(__dirname, '../src/survival/surface-body.ts')
  const realRequire = createRequire(file)
  const moves = { pillar: 0, stairs: 0 }
  const bot = {
    entity: { position: new Vec3(.5, 59, .5) }, health: 20, food: 20,
    game: { minY: -64, height: 384 }, inventory: { items: () => [] },
    nearestEntity: () => null, clearControlStates() {}, stopDigging() {},
    blockAt(pos) {
      const at = pos.floored(), name = at.x === 0 && at.z === 0 && at.y >= 63 && at.y < 63 + count ? cap : 'sandstone'
      return { position: at, name, boundingBox: 'block' }
    }
  }
  const context: any = {
    module: { exports: {} }, require(name) {
      const actual = realRequire(name)
      if (name === './enter-shelter') return { ...actual,
        pickFiller: () => ({ name: 'cobblestone' }), toolBudget: () => 1000,
        toolShortfall: () => null, inWater: () => false, nearestHostile: () => null,
        digUp: async () => { moves.pillar++; bot.entity.position.y++; return { dug: 2 } }
      }
      if (name === './recover-loot') return { ...actual, pitCheck: () => ({ out: false, free: false }), openSky: () => false, seenBy: () => null }
      return actual
    }, moves, bot
  }
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8') + `
    stairStep = async (_bot, _data, _ctl, feet, dir) => {
      moves.stairs++; bot.entity.position = feet.plus(dir).offset(.5, 1, .5);
      return { ok: true, dug: 3 };
    };
  `, { loader: 'ts' }).code, context)
  const result = await context.module.exports.surface({ bot, mcData: {}, journal: { append() {} } }, { aborted: false, onAbort: [] }, { preferPillar: true, targetY: 60, timeoutSeconds: 10 })
  return { moves, result }
}

for (const cap of ['sand', 'gravel']) {
  test(`surface does not remove its third ceiling support beneath two ${cap} blocks`, async () => {
    const { moves, result } = await climb(cap)
    assert.equal(moves.pillar, 0, 'the future stair is cleared while the body stays outside the falling column')
    assert.equal(moves.stairs, 1)
    assert.equal(result.climbed, 1)
  })
}

test('one falling block also changes only the ascent variant, without refusing the climb', async () => {
  const { moves, result } = await climb('sand', 1)
  assert.equal(moves.pillar, 0)
  assert.equal(moves.stairs, 1)
  assert.equal(result.climbed, 1)
})

test('a solid nonfalling cap keeps the existing fast pillar ascent', async () => {
  const { moves, result } = await climb('stone')
  assert.equal(moves.pillar, 1)
  assert.equal(moves.stairs, 0)
  assert.equal(result.climbed, 1)
})
