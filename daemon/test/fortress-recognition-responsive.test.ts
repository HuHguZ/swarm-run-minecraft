import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Module from 'node:module'
import { transformSync } from 'esbuild'
import { bodySource } from './source-fixture'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

function fixture(cancel = false) {
  const file = path.resolve(__dirname, '../src/fortress.ts'), mod: any = new Module(file, module)
  mod.filename = file; mod.paths = module.paths
  const raw = mod.require.bind(mod), calls: any[] = [], ctl = { aborted: false }
  mod.require = (name: string) => name === './bastion/predict-gold' ? {
    predictGold() { throw new Error('synchronous recognition is forbidden in live search') },
    async predictGoldAsync(bot: any, radius: number, sameCtl: any) {
      assert.equal(sameCtl, ctl); assert.equal(radius, 112)
      calls.push('recognize')
      await new Promise<void>(resolve => setImmediate(resolve))
      if (cancel) { ctl.aborted = true; throw new Error('обзор бастиона прерван') }
      return { start: { all: [{ type: 'bridge', r: 1 }] }, basalt: 20, chests: 1 }
    }
  } : raw(name)
  mod._compile(transformSync(bodySource(file) + `
    look = () => ({ seen: 24, rayChecked: 24, nearest: { x: 10, y: 64, z: 20 }, dist: 22,
      bastion: { nearest: { x: 10, y: 64, z: 20 }, dist: 22, seen: 24 } });
    keepBlocks = async () => null; legTo = async () => ({ ok: true });
    module.exports.rememberBastionForTest = rememberBastion;
    module.exports.scoutForTest = scoutBody; module.exports.walkLineForTest = walkLine;
  `, { loader: 'ts', format: 'cjs' }).code, file)
  const state: any = { places: {} }
  const session: any = { bot: { game: { dimension: 'the_nether' }, entity: { position: new Vec3(0, 64, 0) } }, journal: { state, patch: (fn: any) => fn(state), append: () => calls.push('remember') } }
  return { ctl, calls, state, session, mod,
    scout: (mode: string) => mod.exports.scoutForTest(session, ctl, { mode }),
    run: () => mod.exports.rememberBastionForTest(session, { nearest: { x: 10, y: 64, z: 20 }, seen: 24 }, ctl) }
}

test('live fortress discovery awaits cooperative recognition and stores actual starts', async () => {
  const f = fixture()
  await f.run()
  assert.deepEqual(f.calls, ['recognize', 'remember'])
  assert.deepEqual(f.state.places['бастион (ад)'].starts, [{ type: 'bridge', r: 1 }])
})

test('cancellation in live fortress recognition propagates rather than starting the next leg', async () => {
  const f = fixture(true)
  await assert.rejects(f.run(), /прерван/)
  assert.equal(f.ctl.aborted, true)
  assert.equal(f.state.places['бастион (ад)'], undefined)
})

for (const mode of ['look', 'bastion']) test(`${mode} search awaits recognition before returning a discovered structure`, async () => {
  const f = fixture()
  const result = await f.scout(mode)
  assert.equal(result.found, true)
  assert.deepEqual(f.calls, ['recognize', 'remember', 'remember'])
  assert.ok(f.state.places['бастион (ад)'].starts)
})

test('walking a search leg awaits an asynchronous glance before deciding to continue', async () => {
  const f = fixture()
  let looked = 0
  const result = await f.mod.exports.walkLineForTest(f.session, f.ctl, {
    start: { x: 0, z: 0 }, dirName: 'east', maxWalk: 64,
    deadline: (require('../src/game-clock') as typeof import('../src/game-clock')).now() + 10000, legs: [],
    glance: async () => { await new Promise<void>(resolve => setImmediate(resolve)); looked++; return { seen: 1 } }
  })
  assert.equal(result.v.seen, 1)
  assert.equal(looked, 1)
  assert.equal(result.along, 16)
})
