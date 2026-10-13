import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
const Vec3 = require('vec3')

// Run the complete mine module against the real one-bucket geometry. Only
// visible candidates, digging and inventory pickup are the environment boundary.
const code = Object.fromEntries(['actions', 'cast1'].map(name => [name,
  transformSync(fs.readFileSync(path.join(__dirname, `../src/${name}.ts`), 'utf8'), { loader: 'ts', format: 'cjs' }).code]))

function fixture(options: any = {}) {
  const dug: any[] = [], reads: any[] = [], blocks: any[] = [], inventory: Record<string, number> = {}
  let hazardReads = 0
  const key = p => `${p.x},${p.y},${p.z}`
  const items = () => ({ ...inventory })
  const imports: Record<string, any> = {
    './game-clock': { now: () => 0 },
    './movement': { xyz: p => ({ x: p.x, y: p.y, z: p.z }) },
    './items': {
      GROUPS: {}, resolveBlockIds: () => [1, 2], equipBestTool: async () => {}, missingHarvestTool: () => null,
      countItems: items, diffItems: (before, after) => Object.fromEntries(Object.keys(after).map(n => [n, after[n] - (before[n] || 0)]))
    },
    './build': {}, 'vec3': Vec3, 'mineflayer-pathfinder': { goals: {} },
    './cast': { _in: { countOf: (_bot, name) => inventory[name] || 0 } },
    './fauna': { castHazard: () => ++hazardReads === 1 ? null : { name: 'zombie' } },
    './sight': { visibleOf: (_bot, ids, radius, { skip, max }) => blocks.filter(b => b.name !== 'air' && ids.includes(b.type) &&
      b.position.distanceTo(bot.entity.position) <= radius && !skip(b.position)).slice(0, max) }
  }
  const modules: Record<string, any> = {}
  const load = name => {
    if (modules[name]) return modules[name].exports
    const module = modules[name] = { exports: {} }
    vm.runInNewContext(code[name], { module, exports: module.exports, process: { env: {} }, console: { log() {} },
      require(request) {
        if (request === './cast1') return load('cast1')
        if (request in imports) return imports[request]
        throw new Error(`unexpected dependency ${request}`)
      }
    }, { filename: path.join(__dirname, `../src/${name}.ts`) })
    return module.exports
  }
  const plan = { axis: options.axis || 'x', side: options.side || 1, origin: { x: 10, y: 64, z: 20 }, dig: [], place: [], dimension: 'overworld' }
  const g = load('cast1').geom1(new Vec3(10, 64, 20), plan.axis, plan.side)
  const bot: any = {
    game: { dimension: options.dimension || 'overworld' }, entity: { position: new Vec3(15.5, 64, 25.5) },
    canDigBlock: () => true,
    blockAt(p) { reads.push(key(p)); return blocks.find(b => key(b.position) === key(p)) || { name: 'air', position: p } },
    async dig(b) {
      dug.push(key(b.position)); const name = b.name === 'grass_block' ? 'dirt' : b.name
      inventory[name] = (inventory[name] || 0) + 1; b.name = 'air'
    }
  }
  const session: any = { bot, cfg: { fairPlay: true }, mcData: {}, castPlan1: options.noPlan ? null : plan }
  const add = (p, name = 'dirt') => { const b = { name, type: name === 'dirt' ? 1 : 2, position: p }; blocks.push(b); return b }
  return { session, g, add, dug, reads, key, blocks, inventory, cast: load('cast1'),
    run: (params: any = {}) => load('actions').mine(session, { aborted: false, onAbort: [] }, { block: ['dirt', 'grass_block'], collect: false, ...params }) }
}

for (const axis of ['x', 'z']) for (const side of [-1, 1]) {
  test(`filler acquisition preserves a resumed portal's supports (${axis},${side})`, async () => {
    const f = fixture({ axis, side })
    // Native 8/10 resume: channel walls, top crossbar, shore props and the
    // previous climbing pillar are visible, but are already committed to casting.
    const supports = [f.g.F(-2, 1), f.g.F(3, 3), f.g.at(0, 2), f.g.B(1, -1), f.g.G(2, -4), f.g.G(-1, 0)]
    const placed = supports.map(p => f.add(p, 'dirt'))
    const outside = f.add(f.g.H(-3, 0), 'grass_block')
    const result = await f.run()
    assert.deepEqual(f.dug, [f.key(outside.position)])
    assert.ok(placed.every(b => b.name === 'dirt'))
    assert.equal(result.dug, 1)
    assert.equal(result.gained.dirt, 1)
    // Footprint protection uses own geometry; it does not inspect the terrain
    // around the protected candidates to find hidden resources.
    assert.ok(supports.every(p => !f.reads.includes(f.key(p.offset(0, 1, 0)))))
  })
}

test('a site without spare visible material refuses instead of recycling its portal walls', async () => {
  const f = fixture(); const support = f.add(f.g.F(-2, 1))
  await assert.rejects(f.run(), /не вижу/)
  assert.equal(support.name, 'dirt'); assert.deepEqual(f.dug, [])
})

test('a deliberate exact-cell repair can still remove an own support', async () => {
  const f = fixture(); const support = f.add(f.g.F(-2, 1))
  const result = await f.run({ at: support.position })
  assert.equal(result.dug, 1); assert.deepEqual(f.dug, [f.key(support.position)])
})

test('abandoning the active plan releases its material for ordinary mining', async () => {
  const f = fixture(); const support = f.add(f.g.F(-2, 1)); f.session.castPlan1 = null
  assert.equal((await f.run()).dug, 1); assert.equal(support.name, 'air')
})

test('an Overworld plan does not reserve the same coordinates in the Nether', async () => {
  const f = fixture({ dimension: 'the_nether' }); const support = f.add(f.g.F(-2, 1))
  assert.equal((await f.run()).dug, 1); assert.equal(support.name, 'air')
})

test('resuming a journal plan attaches its footprint before subsequent resource gathering', async () => {
  const f = fixture({ noPlan: true })
  f.inventory.water_bucket = 1; f.inventory.dirt = 3
  f.session.journal = { state: { places: { [f.cast.PLACE1]: { x: 10, y: 64, z: 20, axis: 'x', side: 1, dig: [], place: [] } } } }
  const support = f.add(f.g.F(-2, 1)), outside = f.add(f.g.H(-3, 0))
  // A site interruption returns before casting, retaining the frame to resume.
  assert.equal((await f.cast.castOne(f.session, { aborted: false, onAbort: [] })).code, 'CAST_UNSAFE')
  assert.ok(f.session.castPlan1, 'the restored active plan must belong to this Session')
  assert.equal((await f.run()).dug, 1)
  assert.deepEqual(f.dug, [f.key(outside.position)]); assert.equal(support.name, 'dirt')
})
