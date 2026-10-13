import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { transformSync } from 'esbuild'
const Vec3 = require('vec3')

function exploreFixture({ outside = true, rise = true, abort = false } = {}) {
  let now = 0
  const calls: any[] = []
  const bot: any = { _ndEyes: {}, entity: { position: new Vec3(.5, outside ? 64 : 17, .5) },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    pathfinder: { movements: { canDig: true, scafoldingBlocks: [1] } } }
  const session = { bot, cfg: { fairPlay: true }, mcData: { blocks: [{ name: 'gravel' }] },
    underSky: () => outside, surfaceWalk: false }
  const ctl = { aborted: false, onAbort: [] }
  const source = fs.readFileSync(path.join(__dirname, '../src/actions.ts'), 'utf8')
  const body = source.slice(source.indexOf('async function explore (session'), source.indexOf('// ---------------------------------------------------------------- place'))
  const context: any = { module: { exports: {} }, process: { env: {} }, console: { log() {} }, Vec3,
    gameClock: { now: () => now }, xyz: p => ({ x: p.x, y: p.y, z: p.z }),
    resolveBlockIds: () => [0], firstVisible: () => null, underWater: () => false,
    SWEEP: [[1, 0]], COMPASS: {}, sleep: async ms => { now += ms },
    travelXZ: async (_bot, _ctl, x, z, opts) => {
      calls.push({ method: 'travel', x, z, opts, surface: session.surfaceWalk,
        canDig: bot.pathfinder.movements.canDig, scaffolds: [...bot.pathfinder.movements.scafoldingBlocks] })
      now += 5000
      if (abort) ctl.aborted = true
      return { ok: false, error: 'no path' }
    },
    require(name) {
      if (name === './worlds') return { worldOf: () => 'overworld' }
      if (name === './fortify') return { enclosure: () => ({ walls: 0, roof: false, sealed: false }) }
      if (name === './perception/eyes') return { nearest: () => [{ name: 'gravel', x: 20, y: 17, z: 0 }] }
      if (name === './survival') return { surface: async (_session, _ctl, params) => {
        calls.push({ method: 'surface', params }); now += 1000
        if (rise) { outside = true; bot.entity.position.y = 64 }
        return { out: outside }
      } }
      throw new Error(name)
    }
  }
  vm.runInNewContext(transformSync(body + '\nmodule.exports = explore', { loader: 'ts', format: 'cjs' }).code, context)
  return { calls, session, run: () => context.module.exports(session, ctl, { block: 'gravel', dry: true, surface: true, timeoutSeconds: 10 }) }
}

test('a recalled gravel leg preserves its known height and surface movement constraints', async () => {
  const f = exploreFixture()
  await f.run()
  const first = f.calls[0]
  assert.equal(first.method, 'travel')
  assert.equal(first.opts.y, 17, 'an XZ goal cannot confirm a remembered block at another height')
  assert.equal(first.surface, true)
  assert.equal(first.canDig, false, 'a surface memory leg must not reopen a mining shaft')
  assert.deepEqual(first.scaffolds, [])
  assert.equal(f.session.surfaceWalk, false)
  assert.equal(f.session.bot.pathfinder.movements.canDig, true)
  assert.deepEqual(f.session.bot.pathfinder.movements.scafoldingBlocks, [1])
})

test('a failed bounded ascent does not turn surface scouting into another excavation', async () => {
  const f = exploreFixture({ outside: false, rise: false })
  await f.run()
  assert.equal(f.calls[0].method, 'surface')
  assert.ok(f.calls[0].params.timeoutSeconds <= 10)
  for (const call of f.calls.filter(c => c.method === 'travel')) {
    assert.equal(call.surface, true)
    assert.equal(call.canDig, false)
  }
})

test('interruption restores the remembered leg movement settings', async () => {
  const f = exploreFixture({ abort: true })
  await f.run()
  assert.equal(f.calls.length, 1)
  assert.equal(f.session.surfaceWalk, false)
  assert.equal(f.session.bot.pathfinder.movements.canDig, true)
})

test('a height-aware bounded travel rejects an XZ-only arrival and retains legacy column travel', async t => {
  const movement = require('../src/movement')
  const clock = require('../src/game-clock')
  const before = process.env.ND_GOTO_WAIT; process.env.ND_GOTO_WAIT = '0'
  t.after(() => { if (before === undefined) delete process.env.ND_GOTO_WAIT; else process.env.ND_GOTO_WAIT = before })
  t.mock.method(clock, 'sleep', async () => {})
  const run = async (y, landedY) => {
    let goal
    const bot: any = Object.assign(new EventEmitter(), { entity: { position: new Vec3(.5, 64, .5), onGround: true }, blockAt: () => ({ name: 'air' }),
      pathfinder: { setGoal() {}, goto: async g => { goal = g; bot.entity.position = new Vec3(20.5, landedY ?? g.y ?? 17, .5) } } })
    const result = await movement.travelXZ(bot, { aborted: false, onAbort: [] }, 20, 0, { y, range: 4, retries: 0 })
    assert.equal(bot.listenerCount('physicsTick'), 0, 'the bounded leg releases its live water handoff listener')
    return { result, goal }
  }
  assert.equal((await run(64, 17)).result.ok, false, 'same XZ forty-seven blocks below the memory is not arrival')
  const reached = await run(64, undefined)
  assert.equal(reached.goal.y, 64)
  assert.equal(reached.result.ok, true)
  assert.equal((await run(undefined, 17)).result.ok, true, 'existing XZ-only travel stays vertical-neutral')
})
