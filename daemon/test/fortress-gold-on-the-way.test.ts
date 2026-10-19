import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Module from 'node:module'
import { transformSync } from 'esbuild'
import { bodySource } from './source-fixture'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// Золото Ада по пути (пользователь 14.10): руда на виду и рядом, не при пиглинах; без брони — крюк шире и броня из добытого.
// Ход к руде поверху; вслепую без золота руду копает закрытый штрек в своих стенах (nether-cover) — здесь прежний путь.
process.env.ND_NE_COVER = '0'
function fixture({ worn = false, piglin = false, heard = false, nuggets = 0 }: any = {}) {
  const file = path.resolve(__dirname, '../src/fortress.ts'), mod: any = new Module(file, module)
  mod.filename = file; mod.paths = module.paths
  const raw = mod.require.bind(mod), calls: any[] = []
  const inv = [{ name: 'gold_nugget', count: nuggets }]
  const stubs: Record<string, any> = {
    './sight': { visibleOf: (_bot: any, _ids: any, radius: number) => { calls.push(['see', radius]); return [{ position: new Vec3(3, 64, 0) }] } },
    './perception/eyes': { entities: () => piglin ? [{ name: 'piglin', seen: true, dist: 12 }] : [] },
    './perception/senses': { heard: () => heard ? [{ who: 'piglin', band: 'средне' }] : [] },
    './actions': {
      mine: async (_s: any, _c: any, p: any) => { calls.push(['mine', p]); inv[0].count += 8; return { dug: 2 } },
      craft: async (_s: any, _c: any, p: any) => { calls.push(['craft', p]); return {} }
    },
    './bastion/take-gold-block': { goldWorn: () => worn, armGold: async () => { calls.push(['armGold']); return true } }
  }
  mod.require = (name: string) => stubs[name] || raw(name)
  mod._compile(transformSync(bodySource(file) + '\nmodule.exports.goldOnTheWayForTest = goldOnTheWay;', { loader: 'ts', format: 'cjs' }).code, file)
  const bot: any = { game: { dimension: 'the_nether' }, entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => inv },
    registry: { blocksByName: { nether_gold_ore: { id: 1 }, gilded_blackstone: { id: 2 } } } }
  return { calls, run: () => mod.exports.goldOnTheWayForTest({ bot }, { aborted: false }) }
}

test('без брони: руда на виду в 10 бл. копается осторожно, из добытого — броня; второй вызов в 15 с — нет', async () => {
  const f = fixture()
  await f.run()
  const mine = f.calls.find(c => c[0] === 'mine')
  assert.ok(mine, JSON.stringify(f.calls))
  assert.equal(mine[1].radius, 10)
  assert.equal(mine[1].avoidPiglinAggro, true)
  assert.match(mine[1].block, /nether_gold_ore/)
  assert.ok(f.calls.some(c => c[0] === 'armGold'))
  const n = f.calls.length
  await f.run()
  assert.equal(f.calls.length, n, 'пауза 15 с между заходами')
})

test('с бронёй крюк короче, самородки — в слитки', async () => {
  const f = fixture({ worn: true, nuggets: 5 })
  await f.run()
  assert.equal(f.calls.find(c => c[0] === 'mine')[1].radius, 5)
  assert.ok(!f.calls.some(c => c[0] === 'armGold'))
  assert.deepEqual(f.calls.find(c => c[0] === 'craft')[1], { item: 'gold_ingot', count: 1 })
})

for (const near of [{ piglin: true }, { heard: true }]) test(`пиглин ${near.piglin ? 'на виду' : 'слышен'} — руду не трогать`, async () => {
  const f = fixture(near)
  await f.run()
  assert.ok(!f.calls.some(c => c[0] === 'mine'))
})
