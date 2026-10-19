import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { cjsContext } from './cjs-context'
const file = path.resolve(__dirname, '../src/perception.ts'), req = createRequire(file)
import * as esbuild from 'esbuild'
const moduleBody = fs.readFileSync(file, 'utf8')
const sandboxModule = { exports: {} as any }
vm.runInNewContext(esbuild.transformSync(moduleBody, { loader: 'ts', format: 'cjs', target: 'node20' }).code,
  cjsContext({ module: sandboxModule, exports: sandboxModule.exports, require: req }))
const { Vec3 } = req('vec3')
const { foodUnits } = req('./play-policy')
function state(off: any, include45 = false) {
  const slots: any[] = Array(46).fill(null); slots[45] = off
  const bag = [{ name: 'cooked_mutton', count: 2, slot: 9 }, { name: 'stone_pickaxe', count: 1, slot: 36 }]
  const foodsByName = { cooked_mutton: { foodPoints: 6 }, cod_bucket: { foodPoints: 2 } }
  const bot = { entity: { position: new Vec3(0, 170, 0) }, health: 15, food: 6,
    game: { dimension: 'overworld' }, players: {}, registry: { foodsByName },
    inventory: { slots, items: () => include45 && off ? [...bag, off] : bag }, blockAt: () => null }
  return sandboxModule.exports.stateSummary(bot)
}
test('actual state counts edible offhand remainder as available food without losing its bag stock', () => {
  const s = state({ name: 'cooked_mutton', count: 5, slot: 45 })
  assert.equal(s.inventory.cooked_mutton, 7); assert.equal(foodUnits(s.inventory), 7)
  assert.equal(s.offHand.item, 'cooked_mutton')
})
test('actual state does not count edible slot45 twice when the provider already includes it', () => {
  const s = state({ name: 'cooked_mutton', count: 5, slot: 45 }, true)
  assert.equal(s.inventory.cooked_mutton, 7)
})
test('actual state keeps offhand gear and fish buckets outside its spendable meal stock', () => {
  for (const name of ['shield', 'totem_of_undying', 'cod_bucket']) {
    const s = state({ name, count: 1, slot: 45 })
    assert.equal(s.inventory[name], undefined); assert.equal(foodUnits(s.inventory), 2)
    assert.equal(s.offHand.item, name)
  }
})
