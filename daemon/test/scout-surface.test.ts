import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
const Vec3 = require('vec3')

function fixture({ dimension = 'overworld', visible = false } = {}) {
  let now = 0
  let outside = false
  const calls: Array<{ method: string, params?: any }> = []
  const bot: any = { game: { dimension }, entity: { position: new Vec3(.5, 54, .5) }, pathfinder: { movements: { canDig: true, scafoldingBlocks: [] } } }
  const session = { bot, cfg: { fairPlay: true }, mcData: {}, underSky: () => outside, surfaceWalk: false }
  const source = fs.readFileSync(path.join(__dirname, '../src/actions.ts'), 'utf8')
  const body = source.slice(source.indexOf('async function explore (session'), source.indexOf('// ---------------------------------------------------------------- place'))
  const context: any = { module: { exports: {} }, process: { env: {} }, console, Vec3,
    gameClock: { now: () => now }, xyz: p => ({ x: p.x, y: p.y, z: p.z }),
    resolveBlockIds: () => [], firstVisible: () => visible || outside ? { name: 'chest', position: new Vec3(3, 66, 0) } : null,
    SWEEP: [[1, 0]], COMPASS: {}, sleep: async ms => { now += ms },
    travelXZ: async () => { calls.push({ method: 'travel' }); now += 31000; return { ok: true } },
    require(name) {
      if (name === './worlds') return { worldOf: () => dimension }
      if (name === './survival') return { surface: async (_session, _ctl, params) => {
        calls.push({ method: 'surface', params }); now += 8000; outside = true; bot.entity.position.y = 66; return { note: 'вылез под открытое небо' }
      } }
      throw new Error(name)
    }
  }
  vm.runInNewContext(transformSync(body + '\nmodule.exports = explore', { loader: 'ts', format: 'cjs' }).code, context)
  return { calls, run: params => context.module.exports(session, { aborted: false, onAbort: [] }, { block: 'chest', timeoutSeconds: 30, ...params }) }
}

test('surface scouting leaves a cave within its existing time budget and looks again before walking', async () => {
  const f = fixture()
  const result = await f.run({ surface: true })
  assert.equal(result.found, 'chest')
  assert.deepEqual(f.calls.map(c => c.method), ['surface'])
  assert.ok(f.calls[0].params.timeoutSeconds <= 30)
})

test('an already visible underground chest is kept before surface scouting', async () => {
  const f = fixture({ visible: true })
  assert.equal((await f.run({ surface: true })).found, 'chest')
  assert.equal(f.calls.length, 0)
})

test('a last scouting leg shorter than the surface skill minimum keeps its deadline', async () => {
  const f = fixture()
  await f.run({ surface: true, timeoutSeconds: 5 })
  assert.deepEqual(f.calls.map(c => c.method), ['travel'])
})

for (const dimension of ['overworld', 'the_nether']) test(`ordinary ${dimension} exploration keeps its current vertical intent`, async () => {
  const f = fixture({ dimension })
  await f.run(dimension === 'the_nether' ? { surface: true } : {})
  assert.deepEqual(f.calls.map(c => c.method), ['travel'])
})
