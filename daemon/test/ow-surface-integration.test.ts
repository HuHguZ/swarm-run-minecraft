import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { Vec3 } from 'vec3'

for (const enabled of [false, true]) test(`explore memory height: surface flag ${enabled ? 'on' : 'off'}, context cleaned on return`, async t => {
  const previous = process.env.ND_OW_SURFACE_WALK
  process.env.ND_OW_SURFACE_WALK = enabled ? '1' : '0'
  t.after(() => { if (previous === undefined) delete process.env.ND_OW_SURFACE_WALK; else process.env.ND_OW_SURFACE_WALK = previous })
  const bot: any = Object.assign(new EventEmitter(), { _ndEyes: {}, game: { dimension: 'overworld' },
    entity: { position: new Vec3(.5, 64, .5), onGround: true },
    pathfinder: { movements: { canDig: true, scafoldingBlocks: [1] } },
    blockAt: p => ({ position: p.floored(), name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }) })
  const session: any = { bot, cfg: { fairPlay: true }, mcData: { blocks: { 1: { name: 'chest' } } }, underSky: () => true }
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const file = path.join(__dirname, '../src/actions/gather.ts'), realRequire = createRequire(file)
  let walked = false, wantedY, hadContext
  const module = { exports: {} as any }
  const local = name => {
    if (name === '../movement') return { waterBudgetOn: () => false, xyz: p => ({ x: p.x, y: p.y, z: p.z }),
      travelXZ: async (_bot, _ctl, _x, _z, options) => {
        wantedY = options.y; hadContext = !!bot._ndOwSurfaceWalk; walked = true; return { ok: true }
      } }
    if (name === '../items') return { resolveBlockIds: () => [1] }
    if (name === '../sight') return { visibleOf: () => walked ? [{ name: 'chest', position: new Vec3(20, 15, 0) }] : [] }
    if (name === '../perception/eyes') return { nearest: () => [{ name: 'chest', x: 20, y: 15, z: 0 }] }
    if (name === '../fortify') return { leaveSealedCell: async () => {} }
    return realRequire(name)
  }
  const code = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  const wrap = vm.runInThisContext(require('node:module').wrap(code), { filename: file })
  wrap(module.exports, local, module, file, path.dirname(file))
  await module.exports.explore(session, ctl, { block: 'chest' })
  assert.equal(wantedY, enabled ? null : 15)
  assert.equal(hadContext, enabled)
  assert.equal(session.surfaceWalk, false)
  assert.equal(session.scoutFromY, null)
  assert.equal(bot._ndOwSurfaceWalk, undefined)
  assert.equal(bot.listenerCount('physicsTick'), 0)
  assert.equal(ctl.onAbort.length, 0)
  assert.equal(bot.pathfinder.movements.canDig, true)
  assert.deepEqual(bot.pathfinder.movements.scafoldingBlocks, [1])
})

for (const mode of ['surface', 'explicit-descent', 'abort']) test(`strict goto surface scope: ${mode}`, async t => {
  const previous = process.env.ND_OW_SURFACE_WALK
  process.env.ND_OW_SURFACE_WALK = '1'
  t.after(() => { if (previous === undefined) delete process.env.ND_OW_SURFACE_WALK; else process.env.ND_OW_SURFACE_WALK = previous })
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  let sawContext = false
  const bot: any = Object.assign(new EventEmitter(), { game: { dimension: 'overworld' },
    entity: { position: new Vec3(.5, 64, .5), onGround: true }, clearControlStates() {},
    blockAt: p => ({ position: p.floored(), name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }) })
  const session: any = { bot, underSky: () => true, require: () => bot, updateMovements() {},
    runIntent: (_name, work) => work(ctl) }
  bot.pathfinder = { movements: { canDig: true, scafoldingBlocks: [1] }, setGoal() {}, goto: async goal => {
    sawContext = !!bot._ndOwSurfaceWalk
    assert.equal(bot.pathfinder.movements.canDig, false)
    if (mode === 'abort') {
      ctl.aborted = true
      for (const fn of [...ctl.onAbort]) fn()
      assert.equal(bot._ndOwSurfaceWalk, undefined)
      throw new Error('прервано')
    }
    bot.entity.position = new Vec3(goal.x + .5, goal.y ?? 64, goal.z + .5)
  } }
  const file = path.join(__dirname, '../src/session/goto.ts'), realRequire = createRequire(file)
  const module = { exports: {} as any }
  const local = name => {
    if (name === '../movement') return { xyz: p => ({ x: p.x, y: p.y, z: p.z }), standableY: (_b, _x, y) => y,
      inWater: () => false, gotoWaitOn: () => false, stuckGuard: () => ({ promise: new Promise(() => {}), stop() {} }) }
    if (name === '../blockmoves') return { on: () => false }
    if (name === '../fortify') return { leaveSealedCell: async () => {} }
    if (name === '../hopgoto' || name === '../navigation/descent') return { on: () => false }
    return realRequire(name)
  }
  const code = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext(require('node:module').wrap(code), { filename: file })(module.exports, local, module, file, path.dirname(file))
  const run = module.exports.goto.call(session, { x: 20, z: 0, surface: 'strict',
    ...(mode === 'explicit-descent' ? { y: 10 } : {}) })
  if (mode === 'abort') await assert.rejects(run, /прервано/)
  else assert.ok((await run).arrived)
  assert.equal(sawContext, mode !== 'explicit-descent')
  assert.equal(bot._ndOwSurfaceWalk, undefined)
  assert.equal(bot.listenerCount('physicsTick'), 0)
  assert.equal(bot.pathfinder.movements.canDig, true)
  assert.deepEqual(bot.pathfinder.movements.scafoldingBlocks, [1])
})
