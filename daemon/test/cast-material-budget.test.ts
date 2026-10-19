import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { cjsContext } from './cjs-context'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/cast1.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code
function fixture(carried = 0) {
  const blocks = new Map<string, string>(), reads: string[] = []
  const key = p => `${p.x},${p.y},${p.z}`
  const read = p => { reads.push(key(p)); const name = blocks.get(key(p)) || 'air'; return { name, boundingBox: name === 'air' ? 'empty' : 'block' } }
  const module = { exports: {} as any }
  vm.runInNewContext(source, cjsContext({ module, exports: module.exports, process: { env: {} },
    require(name) {
      if (name === 'vec3') return Vec3
      if (name === 'mineflayer-pathfinder') return { goals: {} }
      if (name === './game-clock') return { now: () => 0 }
      if (name === './movement') return { xyz: p => ({ x: p.x, y: p.y, z: p.z }) }
      if (name === './items' || name === './build') return {}
      if (name === './fauna') return { castHazard: () => null }
      if (name === './cast') return { _in: { isSolid: b => !!b && b.boundingBox === 'block', countOf: (_bot, n) => n === 'water_bucket' ? 1 : n === 'dirt' ? carried : 0 } }
      throw new Error(`unexpected import ${name}`)
    }
  }))
  const cast = module.exports, g = cast.geom1(new Vec3(10, 64, 20), 'x', 1)
  const plan = { origin: { x: 10, y: 64, z: 20 }, axis: 'x', side: 1, dig: [] as any[], place: [] as any[] }
  for (const q of [g.F(-2, -1), g.F(3, -1), g.B(0, -1), g.B(1, -1), g.at(-1, -1), g.at(2, -1), g.G(-1, -1), g.G(1, -1), g.G(2, -1)]) blocks.set(key(q), 'stone')
  for (const i of [-2, 3]) for (let j = 0; j <= 3; j++) plan.place.push(g.F(i, j))
  const bot = { entity: { position: g.G(0, 0).offset(0.5, 0, 0.5) }, blockAt: read, pathfinder: { setGoal() {} } }
  const session = { bot, castPlan1: plan, journal: { state: {}, patch() {} } }
  return { cast, g, plan, bot, session, read, reads, blocks, key }
}

test('a bare casting site asks once for its actual channel, upper supports and pillar', async () => {
  const f = fixture()
  const result = await f.cast.castOne(f.session, { aborted: false, onAbort: [] })
  assert.equal(result.need.count, 14)
  assert.equal(result.need.have, 0)
  assert.equal(result.placed, 0)
  assert.equal(f.session.castPlan1, f.plan)
})

test('material receipt counts carried blocks and does not credit future clearing drops', async () => {
  const f = fixture(8)
  f.plan.dig.push(f.g.F(0, 0)); f.blocks.set(f.key(f.g.F(0, 0)), 'stone')
  const result = await f.cast.castOne(f.session, { aborted: false, onAbort: [] })
  assert.equal(result.need.count, 14)
  assert.equal(result.need.have, 8)
  assert.equal(result.dug, 0)
})

test('resume subtracts actual standing supports, but counts material its own clearing will remove', () => {
  const f = fixture()
  for (const q of f.plan.place) f.blocks.set(f.key(q), 'dirt')
  for (const q of [f.g.at(0, 2), f.g.at(1, 2), f.g.F(-1, 3), f.g.F(2, 3), f.g.G(0, 0), f.g.G(0, 1)]) f.blocks.set(f.key(q), 'dirt')
  assert.equal(f.cast.materialNeed1(f.read, f.plan), 0)
  f.plan.dig.push(f.g.G(0, 0), f.g.G(0, 1))
  assert.equal(f.cast.materialNeed1(f.read, f.plan), 2)
})

test('completed upper frame needs neither a new pillar, upper walls nor temporary interior supports', () => {
  const f = fixture()
  for (const t of f.cast.cells(f.g)) if (t.h > 0) f.blocks.set(f.key(t.c), 'obsidian')
  assert.equal(f.cast.materialNeed1(f.read, f.plan), 4)
})

test('a stale placement list cannot hide an executor-required support that has disappeared', () => {
  const f = fixture(); f.blocks.delete(f.key(f.g.B(0, -1)))
  assert.equal(f.cast.materialNeed1(f.read, f.plan), 15)
})

test('the executor footprint is budgeted even when the placement list is empty', () => {
  const f = fixture(); f.plan.place = []
  assert.equal(f.cast.materialNeed1(f.read, f.plan), 14)
  const site = f.cast.siteCells1(f.plan)
  assert.ok(f.reads.every(k => site.has(k)))
})
