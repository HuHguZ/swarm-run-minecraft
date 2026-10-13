import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

function fixture({ lower = false, ledge = false, unsupported = false, wet = false, occluded = false, abortOnAim = false, gravel = 3 } = {}) {
  const Vec3 = require('vec3')
  const inventory: Record<string, number> = { gravel, flint: 0 }
  const placed: any[] = [], dug: any[] = [], aimed: any[] = []
  const cells = new Map<string, string>()
  const ctl = { aborted: false }
  let now = 0
  const items = () => Object.entries(inventory).filter(([, n]) => n).map(([name, count]) => ({ name, count, type: name }))
  const bot: any = { entity: { position: new Vec3(.5, 62, .5) }, entities: {}, inventory: { items },
    pathfinder: { setGoal() {} },
    blockAt(p) {
      p = p.floored()
      const name = cells.get(p.toString()) ?? (p.y < 62 ? (unsupported ? 'water' : 'stone')
        : p.y === 62 ? (lower ? 'air' : ledge && p.x === 1 && p.z === 0 ? 'stone' : 'water')
          : wet && p.y === 63 ? 'water' : 'air')
      return { name, position: p, boundingBox: /stone|gravel/.test(name) ? 'block' : 'empty' }
    },
    async equip(item) { bot.heldItem = item },
    async lookAt() { if (abortOnAim) ctl.aborted = true },
    async placeBlock(ref, face) {
      assert.equal(ref.boundingBox, 'block')
      const at = ref.position.plus(face)
      assert.equal(bot.blockAt(at).boundingBox, 'empty')
      assert.ok(inventory.gravel > 0)
      placed.push(at); cells.set(at.toString(), 'gravel'); inventory.gravel--
    } }
  const clock = { now: () => now, sleep: async ms => { now += ms }, setTimeout, clearTimeout }
  const itemTools = { itemNamed: (_bot, name) => items().find(i => i.name === name),
    itemMatching: (_bot, re) => items().find(i => re.test(i.name)), equipBestTool: async () => {} }
  let build: any
  const dependencies = name => {
    if (name === 'vec3') return Vec3
    if (name === './game-clock') return clock
    if (name === './movement') return { sleep: clock.sleep, xyz: p => ({ x: p.x, y: p.y, z: p.z }) }
    if (name === './items') return itemTools
    if (name === './build') return build
    if (name === './pick') return { faceAim: (_bot, at, face) => { aimed.push({ at, face }); return occluded ? null : at.offset(.5, 1, .5) } }
    if (name === './cast') return { _in: { digVisible: async (_bot, block) => {
      assert.equal(block.name, 'gravel'); assert.ok(!occluded)
      dug.push(block.position); cells.set(block.position.toString(), 'air'); inventory.flint++
    } } }
    if (name === './actions') return { collectNearbyDrops: async () => {} }
    throw Error(name)
  }
  const load = file => {
    const context: any = { module: { exports: {} }, process: { env: { ND_GRIND_NICHE: '0' } }, require: dependencies }
    vm.runInNewContext(transformSync(fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8'), { loader: 'ts', format: 'cjs' }).code, context)
    return context.module.exports
  }
  build = load('build.ts')
  return { bot, ctl, inventory, placed, dug, aimed, ...load('flint-grind.ts') }
}

test('gravel at a shallow shore gets one visible supported prop before grinding above the water', async () => {
  const f = fixture()
  const r = await f.flintGrind({ bot: f.bot }, f.ctl, { max: 1 })
  assert.equal(r.ok, true)
  assert.deepEqual(f.placed.map(p => p.y), [62, 63])
  assert.deepEqual(f.dug.map(p => p.y), [63])
  assert.equal(f.inventory.gravel, 1)
  assert.equal(f.inventory.flint, 1)
  assert.equal(f.bot.blockAt(f.placed[0]).name, 'gravel')
  assert.equal(f.aimed.length, 2)
})

test('an existing dry ledge needs no prop and an existing foot-height spot is preferred', async () => {
  for (const [options, height] of [[{ ledge: true }, 63], [{ lower: true }, 62]] as Array<[any, number]>) {
    const f = fixture(options)
    assert.equal(f.grindSpot(f.bot)?.y, height)
    assert.equal((await f.flintGrind({ bot: f.bot }, f.ctl, { max: 1 })).ok, true)
    assert.deepEqual(f.placed.map(p => p.y), [height])
    assert.equal(f.inventory.gravel, 2)
  }
})

test('a deep pool or wet grinding cell cannot be used as a gravel platform', () => {
  for (const options of [{ unsupported: true }, { wet: true }]) {
    const f = fixture(options)
    assert.equal(f.grindSpot(f.bot), null)
  }
})

test('an occluded support cannot cause placement, digging, or invented flint', async () => {
  const f = fixture({ occluded: true })
  assert.equal((await f.flintGrind({ bot: f.bot }, f.ctl, { max: 1 })).ok, false)
  assert.equal(f.placed.length, 0)
  assert.equal(f.dug.length, 0)
  assert.equal(f.inventory.gravel, 3)
  assert.equal(f.inventory.flint, 0)
})

test('cancellation while aiming at the support prevents both placements', async () => {
  const f = fixture({ abortOnAim: true })
  assert.equal((await f.flintGrind({ bot: f.bot }, f.ctl, { max: 1 })).ok, false)
  assert.equal(f.placed.length, 0)
  assert.equal(f.dug.length, 0)
  assert.equal(f.inventory.gravel, 3)
})

test('a single gravel block spent on the prop is reported without inventing a grind or flint', async () => {
  const f = fixture({ gravel: 1 })
  assert.equal((await f.flintGrind({ bot: f.bot }, f.ctl, { max: 1 })).ok, false)
  assert.equal(f.placed.length, 1)
  assert.equal(f.dug.length, 0)
  assert.equal(f.inventory.gravel, 0)
  assert.equal(f.inventory.flint, 0)
})

test('a raised grinding cell cannot use a column of gravel falling into air or unknown terrain', () => {
  const Vec3 = require('vec3')
  for (const base of ['air', null]) {
    const f = fixture()
    f.bot.blockAt = p => {
      const name = p.y === 63 || p.y === 64 && Math.abs(p.x) + Math.abs(p.z) === 1 ? 'gravel'
        : p.y <= 62 ? base : 'air'
      return name === null ? null : { name, position: p, boundingBox: name === 'gravel' ? 'block' : 'empty' }
    }
    f.bot.entity.position = new Vec3(.5, 64, .5)
    assert.equal(f.grindSpot(f.bot), null)
  }
})

test('a gravel column resting on stone remains a physical support for grinding', () => {
  const Vec3 = require('vec3')
  const f = fixture()
  f.bot.blockAt = p => {
    const name = p.y === 62 || p.y === 63 || p.y === 64 && Math.abs(p.x) + Math.abs(p.z) === 1 ? 'gravel'
      : p.y <= 61 ? 'stone' : 'air'
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  f.bot.entity.position = new Vec3(.5, 64, .5)
  const spot = f.grindSpot(f.bot)
  assert.ok(spot && spot.y === 64 && Math.abs(spot.x) === 1 && Math.abs(spot.z) === 1)
})
