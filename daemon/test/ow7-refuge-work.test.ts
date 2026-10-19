import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { transformSync } from 'esbuild'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const file = process.env.OW7_REFUGE_TEST_SOURCE || path.join(__dirname, '../src/survival/refuge-body.ts')
const source = fs.readFileSync(file, 'utf8')
async function run(how, { env = {}, held = 'healed', open = false, untilDawn = false, alive = true, aborted = false, stayIn = true, closed = true } = {} as any) {
  const calls: string[] = [], look: any = { blocks: 64, pocket: closed ? 4 : 0, hole: true }
  const bot = { health: alive ? 20 : 0, entity: { position: new Vec3(0, 10, 0) }, pathfinder: { setGoal() {} } }
  const session = { bot, playPolicy: { mode: 'speedrun' }, journal: { append() {} } }
  const ctx: any = { process: { env: { ND_REFUGE_SPIDER: '0', ND_REFUGE_PLANKS: '0', ...env } },
    require: name => name.endsWith('flee') ? { hostilesAround: () => [] } : name.endsWith('fortify') ? { landed: async () => {} } : {},
    console: { log() {} }, gameClock: { now: () => 1 }, refugeLook: () => look, lookLine: () => '',
    chooseRefuge: () => ({ how, why: 'closed' }), outrun: () => false, sitOn: () => true,
    takeHole: async () => ({ depth: 3, open }), xyz: p => ({ x: p.x, y: p.y, z: p.z }),
    holdOut: async () => ({ why: held, ate: [], patched: 0, breaches: 0 }),
    sitTight: async () => { calls.push('sitTight'); return { sat: 180000 } },
    waitClear: async () => { calls.push('waitClear'); return true },
    exitShelter: async () => { calls.push('exitShelter'); return { out: true } }
  }
  const start = source.indexOf('async function refugeBody (')
  vm.runInNewContext(transformSync(source.slice(start, source.indexOf('\nasync function takeHole', start)) + '\nthis.run=refugeBody', { loader: 'ts' }).code, cjsContext(ctx))
  const out = { hp0: 20, code: 'OK', stayIn, untilDawn, steps: [] }
  const result = await ctx.run(session, { aborted }, { t0: 0, minHp: 20, deadline: 60000, out, step() {}, hurts: [] })
  return { calls, result }
}
for (const how of ['hole', 'pocket']) {
  test(`${how}: stayIn returns behind intact cover for work, without timed sitting or reopening`, async () => {
    const r = await run(how)
    assert.equal(r.result.stayed, true)
    assert.deepEqual(r.calls, [])
  })
  test(`${how}: explicit untilDawn and OFF retain the legacy sitting path`, async () => {
    for (const options of [{ untilDawn: true }, { env: { ND_NIGHT_WORK: '0' } }, { stayIn: false }]) {
      const r = await run(how, options)
      assert.ok(r.calls.includes('sitTight'))
    }
  })
  test(`${how}: breached or aborted shelter never reports a safe work handoff`, async () => {
    assert.notEqual((await run(how, { held: 'breached' })).result.stayed, true)
    assert.notEqual((await run(how, { aborted: true })).result.stayed, true)
    assert.notEqual((await run(how, { closed: false })).result.stayed, true)
  })
}
test('an open hole cannot be treated as closed cover', async () => {
  const r = await run('hole', { open: true })
  assert.notEqual(r.result.stayed, true)
  assert.ok(r.calls.includes('exitShelter'))
})
