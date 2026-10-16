import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
const Vec3 = require('vec3')

function fixture({ remembered = false, looted = true, name = 'chest' } = {}) {
  let now = 0
  const calls: any[] = []
  const old = { name, position: new Vec3(remembered ? 30 : 3, 64, 0) }
  const fresh = { name: 'chest', position: new Vec3(60, 64, 0) }
  const bot: any = { _ndEyes: {}, entity: { position: new Vec3(0, 64, 0) },
    blockAt: p => [old, fresh].find(b => b.position.equals(p)) || { name: 'air' },
    pathfinder: { movements: { canDig: true, scafoldingBlocks: [] } } }
  const session = { bot, cfg: { fairPlay: true }, mcData: { blocks: [{ name: 'chest' }] },
    journal: { state: { looted: looted ? [`${old.position.x},64,0`] : [] } }, underSky: () => true, surfaceWalk: false }
  const source = fs.readFileSync(path.join(__dirname, '../src/actions.ts'), 'utf8')
  const body = source.slice(source.indexOf('function firstVisible ('), source.indexOf('// ---------------------------------------------------------------- place'))
  const context: any = { module: { exports: {} }, process: { env: {} }, console: { log() {} }, Vec3,
    gameClock: { now: () => now }, xyz: p => ({ x: p.x, y: p.y, z: p.z }),
    resolveBlockIds: () => [0], underWater: () => false, SWEEP: [[1, 0]], COMPASS: { east: [1, 0] },
    visibleOf: (_bot, _ids, radius, { max, skip }) => [old, fresh]
      .filter(b => (!remembered || calls.length) && b.position.distanceTo(bot.entity.position) <= radius && !skip?.(b.position)).slice(0, max),
    sleep: async ms => { now += ms },
    travelXZ: async (_bot, _ctl, x, z) => { calls.push({ x, z }); now += 1000; bot.entity.position = new Vec3(x, 64, z); return { ok: true } },
    require(name) {
      if (name === './worlds') return { worldOf: () => 'overworld' }
      if (name === './perception/eyes') return { nearest: () => [{ name: old.name, x: old.position.x, y: 64, z: 0 }] }
      if (name === './fortify') return { leaveSealedCell: async () => null }
      if (name === './movement') return {} // A6: без waterBudgetOn — прежний выбор ближайшего
      throw new Error(name)
    }
  }
  vm.runInNewContext(transformSync(body + '\nmodule.exports = explore', { loader: 'ts', format: 'cjs' }).code, context)
  return { calls, old, fresh, run: (options = {}) => context.module.exports(session, { aborted: false, onAbort: [] },
    { block: 'bell,chest,barrel', radius: 48, stepDistance: 60, direction: 'east', timeoutSeconds: 3, ...options }) }
}

for (const remembered of [false, true]) test(`resource search walks past a ${remembered ? 'remembered' : 'visible'} container already collected`, async () => {
  const f = fixture({ remembered })
  const result = await f.run({ unlootedContainers: true })
  assert.equal(result.at.x, f.fresh.position.x)
  assert.deepEqual(f.calls, [{ x: 60, z: 0 }], 'the next scout must spend its leg on a new view, not return to emptied loot')
})

test('ordinary explicit container exploration can revisit collected storage', async () => {
  const f = fixture()
  assert.equal((await f.run()).at.x, f.old.position.x)
  assert.equal(f.calls.length, 0)
})

test('an uncollected visible chest remains a resource target', async () => {
  const f = fixture({ looted: false })
  assert.equal((await f.run({ unlootedContainers: true })).at.x, f.old.position.x)
  assert.equal(f.calls.length, 0)
})

test('collected-container memory does not hide a replacement bell', async () => {
  const f = fixture({ name: 'bell' })
  assert.equal((await f.run({ unlootedContainers: true })).found, 'bell')
  assert.equal(f.calls.length, 0)
})
