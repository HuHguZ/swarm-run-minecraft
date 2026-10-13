import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
const Vec3 = require('vec3')
const file = path.join(__dirname, '../src/actions.ts')
const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
const realRequire = createRequire(file)
const data = require('minecraft-data')('1.21.11')

function fixture(options: any = {}) {
  const bag: Record<string, number> = {}, digs: any[] = []
  const piglin = { id: 9, name: 'piglin', isValid: true, width: 0.6, height: 1.95,
    position: new Vec3(...(options.position || [8, 64, 0.5])),
    metadata: { [data.entitiesByName.piglin.metadataKeys.indexOf('baby')]: !!options.baby } }
  const blocks = [2, 3].map(x => ({ name: options.block || 'nether_gold_ore', type: 1, position: new Vec3(x, 64, 0) }))
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8 },
    registry: data, entities: options.initial ? { 9: piglin } : {},
    world: { raycast: () => options.hidden ? { position: new Vec3(...(options.wall || [1, 65, 0])) } : null },
    blockAt: p => { const wall = options.wall || [1, 65, 0]; const hidden = options.hidden && p.x === wall[0] && p.y === wall[1] && p.z === wall[2]; return { name: hidden ? 'stone' : 'air', position: p, shapes: hidden ? [[0, 0, 0, 1, 1, 1]] : [] } }, canDigBlock: () => true,
    async dig(b) { digs.push(b.position.x); b.name = 'air'; bag.gold_nugget = (bag.gold_nugget || 0) + 3 }
  }
  const reveal = () => { bot.entities[9] = piglin }
  const imports: any = {
    './drops': { blockGetter: b => (x, y, z) => b.blockAt(new Vec3(x, y, z)) },
    './items': { GROUPS: {}, resolveBlockIds: () => [1], countItems: () => ({ ...bag }),
      diffItems: (before, after) => Object.fromEntries(Object.keys(after).map(n => [n, after[n] - (before[n] || 0)])),
      missingHarvestTool: () => null, equipBestTool: async () => { if (options.reveal === 'equip') reveal() } },
    './sight': { visibleOf: (_bot, _ids, _radius, { skip, max }) => blocks.filter(b => b.name !== 'air' && !skip(b.position)).slice(0, max) }
  }
  const context: any = { module: { exports: {} }, console, Date, setTimeout, clearTimeout,
    process: { env: {} }, reveal, options,
    require: name => imports[name] || realRequire(name) }
  vm.runInNewContext(code + '\nreachBlock = async () => { if (options.reveal === "reach") reveal() };' +
    '\ncollectNearbyDrops = async () => { if (options.reveal === "pickup") reveal() };', context, { filename: file })
  const ctl = { aborted: false, onAbort: [] }
  return { digs, bag, run: (params: any = {}) => context.module.exports.mine({ bot, mcData: data, cfg: { fairPlay: true } }, ctl,
    { block: options.block || 'nether_gold_ore', count: 2, avoidPiglinAggro: true, ...params }) }
}

for (const reveal of ['reach', 'equip']) test('cautious gold variant reobserves a piglin after ' + reveal, async () => {
  const f = fixture({ reveal }); const result = await f.run()
  assert.equal(result.dug, 0); assert.match(result.stopped, /пиглин/i); assert.deepEqual(f.digs, [])
})

test('new piglin between ore swings preserves confirmed partial digging and nuggets', async () => {
  const f = fixture({ reveal: 'pickup' }); const result = await f.run()
  assert.equal(result.dug, 1); assert.equal(result.gained.gold_nugget, 3); assert.equal(f.bag.gold_nugget, 3)
  assert.deepEqual(f.digs, [2]); assert.match(result.stopped, /пиглин/i)
})

test('native anger volume is a box: visible diagonal piglin still stops cautious digging', async () => {
  const f = fixture({ initial: true, position: [16.4, 64, 16.4] }); const result = await f.run()
  assert.equal(result.dug, 0); assert.match(result.stopped, /пиглин/i)
})

for (const options of [{ hidden: true }, { hidden: true, position: [2.25, 64, 0.5], wall: [2, 65, 0] }, { baby: true }, { position: [18, 64, 0.5] }, { position: [0.5, 85, 0.5] }])
  test('cautious gold does not use hidden, baby or outside-volume piglins ' + JSON.stringify(options), async () => {
    const f = fixture({ initial: true, ...options }); const result = await f.run()
    assert.equal(result.dug, 2); assert.equal(result.gained.gold_nugget, 6); assert.equal(result.stopped, undefined)
  })

test('ordinary explicit mining preserves its deliberate variant beside a visible piglin', async () => {
  const f = fixture({ initial: true }); assert.equal((await f.run({ avoidPiglinAggro: false })).dug, 2)
})

test('the cautious gold option leaves unguarded netherrack acquisition available', async () => {
  const f = fixture({ initial: true, block: 'netherrack' }); assert.equal((await f.run()).dug, 2)
})
