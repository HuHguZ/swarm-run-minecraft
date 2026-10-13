import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const { Vec3 } = require('vec3')

function blockedSearch () {
  const file = path.resolve(__dirname, '../src/fortress.js')
  const bot = { game: { dimension: 'the_nether' }, health: 20, entity: { position: new Vec3(60, 26, -128) } }
  let now = 0
  let cancelNext = false
  const calls: any[] = []
  const realRequire = createRequire(file)
  const context: any = { module: { exports: {} }, console: { log () {} }, process,
    require: name => name === './game-clock' ? { now: () => now } : realRequire(name),
    leg: async (_session, ctl, x, z) => {
      calls.push({ x, z })
      now += 75000 // Existing walkLeg + bore caps can exhaust one call before all side attempts.
      if (cancelNext) { ctl.aborted = true; cancelNext = false }
      return { ok: false, error: 'застрял; штрек: у забоя lava' }
    }
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    keepBlocks = async () => null;
    legTo = (...args) => leg(...args);
    module.exports.sweepForTest = sweep;
  `, context)
  const state: any = { fortressSearch: { world: 'the_nether', origin: { x: 6, z: -11 }, region: [0, -1], done: [],
    wps: [{ x: -16, z: -128 }, { x: 384, z: -128 }, { x: 384, z: -256 },
      { x: -16, z: -256 }, { x: -16, z: -384 }, { x: 384, z: -384 }], i: 2 } }
  const session = { bot, journal: { state, patch: fn => fn(state) } }
  const run = (ctl = { aborted: false }) => context.module.exports.sweepForTest(session, ctl,
    { deadline: now + 300000, glance: () => ({ seen: 0 }), legs: [], v: { seen: 0 } })
  return { session, calls, run, cancel: () => { cancelNext = true } }
}

test('a timed out fortress search resumes actual failed side attempts instead of repeating its first target', async () => {
  const f = blockedSearch()
  await f.run()
  const first = f.calls[0]
  const mark = f.calls.length
  assert.equal(f.session.journal.state.fortressSearch.i, 2, 'unseen area must not be counted as visited')
  await f.run()
  assert.notDeepEqual(f.calls[mark], first, 'the next call must continue the physical detour')
  assert.equal(new Set(f.calls.slice(0, 6).map(p => `${p.x},${p.z}`)).size, 6, 'each failed lateral approach is tried once')
})

test('a tactical cancellation does not count as a failed fortress detour', async () => {
  const f = blockedSearch()
  f.cancel()
  const ctl = { aborted: false }
  await f.run(ctl)
  assert.equal(ctl.aborted, true)
  assert.equal(f.calls.length, 1)
  await f.run()
  assert.deepEqual(f.calls[1], f.calls[0], 'a new owner may retry the interrupted physical approach')
})

test('exhausting all lateral approaches continues to another search axis across calls', async () => {
  const f = blockedSearch()
  for (let i = 0; i < 4; i++) await f.run()
  assert.ok(f.calls.some(p => p.x !== 76), 'closing the east approach must allow a different route')
  assert.ok(f.calls.some(p => p.z === -144), 'the next axis is attempted from the actual body')
})

test('actual arrival on the pending axis starts the other axis from the current body', async () => {
  const f = blockedSearch()
  await f.run()
  f.session.bot.entity.position.x = 384
  const mark = f.calls.length
  await f.run()
  assert.deepEqual(f.calls[mark], { x: 384, z: -144 }, 'the obsolete east line must not override a new north line')
})
