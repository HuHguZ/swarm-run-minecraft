'use strict'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { withClockFixture } from './clock-fixture'
import { Vec3 } from 'vec3'
import { bodySource } from './source-fixture'
function fixture ({ gap = null, shape = null, unknown = null, occupied = false, move = false, place = false }: any = {} as Record<string, any>) {
  const full = p => ({ name: 'blackstone', boundingBox: 'block', position: p, shapes: [[0,0,0,1,1,1]] })
  const air = p => ({ name: 'air', boundingBox: 'empty', position: p, shapes: [] })
  const walls = new Map()
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = 0; y <= 2; y++) if (x || z || y === 2) {
    const p = new Vec3(x,64+y,z); walls.set(p.toString(),full(p))
  }
  const key = v => v.toString(); const gapV = gap && new Vec3(...(gap as [number, number, number]))
  if (gapV) walls.set(key(gapV), air(gapV))
  if (shape) { const p = new Vec3(...(shape as [number, number, number])); walls.set(key(p),{ ...full(p), name: 'blackstone_slab', shapes: [[0,0,0,1,.5,1]] }) }
  if (unknown) walls.set(key(new Vec3(...(unknown as [number, number, number]))),null)
  const b = { entity: { position: new Vec3(.5,64,.5), width: .6, height: 1.8 }, inventory: { items: () => [{ name: 'netherrack', count: 64 }] }, entities: {} as Record<string, any>, blockAt: p => walls.has(key(p)) ? walls.get(key(p)) : air(p) }
  if (occupied) b.entities[2] = { name: 'piglin_brute', position: new Vec3(1.5,65,1.5), width: .6, height: 1.95 }
  const SL = { AIR: 0, PARTIAL: 1, FLUID: 2, classOf: b => !b ? 99 : b.name === 'air' ? 0 : /slab/.test(b.name) ? 1 : 3, fillerCount: () => 64, fillerName: () => 'netherrack', keyV: p => `${p.x},${p.y},${p.z}` }
  const ctx = { module: { exports: {} as Record<string, any> }, process, console: { log () {} }, setTimeout,
    require: n => n === 'vec3' ? { Vec3 } : n === './movement' ? { sleep: async () => {} } : n === './sealed' ? SL : n === './build' ? { placeBlockAt: async (_,v) => { if (!place) return { ok: false }; walls.set(key(v),full(v)); if (move) b.entity.position = new Vec3(3.5,64,.5); return { ok: true } } } : {} as Record<string, any> }
  vm.runInNewContext(bodySource(path.join(__dirname,'../src/ne-guard.js')),cjsContext(withClockFixture(ctx)))
  return { b, G: ctx.module.exports }
}
test('diagonal one block above the bot is not a sealed box (N1a1/N1a31)', async () => {
  const { b,G } = fixture({ gap: [1,65,1], occupied: true })
  assert.equal((await G.boxIn(b)).ok,false)
})
test('unknown cell and half slab cannot certify a protective wall', async () => {
  for (const opts of [{ unknown: [1,65,0] }, { shape: [1,65,0] }]) {
    const { b,G } = fixture(opts); assert.equal((await G.boxIn(b)).ok,false)
  }
})
test('a missing upper diagonal roof must be closed before waiting', async () => {
  const { b,G } = fixture({ gap: [1,66,1] }); assert.equal((await G.boxIn(b)).ok,false)
})
test('successful visible placement closes the gap; all live cells are checked', async () => {
  const { b,G } = fixture({ gap: [1,65,1], place: true }); assert.equal((await G.boxIn(b)).ok,true)
})
test('knockback during construction invalidates the old enclosure', async () => {
  const { b,G } = fixture({ gap: [1,65,1], place: true, move: true }); assert.equal((await G.boxIn(b)).ok,false)
})
test('a body crossing the centre cell boundary is not certified sealed', async () => {
  const { b,G } = fixture(); b.entity.position.x = .1; assert.equal((await G.boxIn(b)).ok,false)
})
test('ND_GUARD_SEAL=0 preserves the original cardinal-cell check', async () => {
  const old = process.env.ND_GUARD_SEAL; process.env.ND_GUARD_SEAL = '0'
  try { const { b,G } = fixture({ gap: [1,65,1] }); assert.equal((await G.boxIn(b)).ok,true) } finally { if (old === undefined) delete process.env.ND_GUARD_SEAL; else process.env.ND_GUARD_SEAL = old }
})
