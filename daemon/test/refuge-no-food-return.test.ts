import { campaignTs, withSetters } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { transformSync } from 'esbuild'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const source = fs.readFileSync(path.join(__dirname, '../src/survival/refuge-body.ts'), 'utf8')

function fixture({ kind = 'box', mode = 'speedrun', held = 'no_food', sealed = true, pocket = 2, untilDawn = false } = {}) {
  let now = 1000
  const calls: string[] = []
  const cell = new Vec3(8, 53, 8)
  const bot = { health: 12, food: 10, entity: { position: cell.offset(.5, 0, .5) } }
  const session = { bot, playPolicy: { mode }, journal: { append() {} } }
  const look = () => ({ blocks: 64, cell: { cell, blocks: 2 }, canBreakOut: true, pocket, foes: 1 })
  const hold = { ate: [], why: held }
  const exported: any = { exports: {} }
  const context: any = { module: exported, console: { log() {} }, process: { env: {} }, require: (name: string) => {
    if (name === './hold-out') return { refugeLook: look, lookLine: () => 'sealed with shooter outside', chooseRefuge: () => ({ how: kind }),
      outrun: () => false, takeBox: async () => ({ cell, placed: 2 }), holdOut: async () => hold,
      sitTight: async () => { calls.push('sit'); now += 180000; return { sat: 180000 } },
      waitClear: async () => { calls.push('wait-clear'); return false },
      leaveBox: async () => { calls.push('leave'); return { ok: true } } }
    if (name === './surface-body') return {}
    if (name === './enter-shelter') return { xyz: (p: any) => ({ x: p.x, y: p.y, z: p.z }), sitOn: () => true, gameClock: { now: () => now } }
    if (name === '.././items') return { bestWeapon: () => null }
    if (name === '.././flee') return { hostilesAround: () => [] }
    if (name === '.././fortify') return { landed: async () => {}, enclosure: () => ({ sealed }) }
    throw new Error('Unexpected dependency ' + name)
  } }
  vm.runInNewContext(transformSync(source, { loader: 'ts' }).code, cjsContext(context))
  return { calls, run: () => exported.exports.refugeBody(session, { aborted: false }, { t0: 1000, minHp: 16, deadline: 121000,
    out: { how: 'none', code: 'OK', hp0: 12, steps: [], untilDawn }, step: () => {}, hurts: [] }) }
}

for (const kind of ['box', 'pocket']) test(`speedrun ${kind} returns its actual no-food receipt while preserving cover`, async () => {
  const f = fixture({ kind })
  const r = await f.run()
  assert.equal(r.code, 'NO_FOOD')
  assert.equal(r.stayed, true)
  assert.equal(r.healed, false)
  assert.equal(r.seconds, 0)
  assert.deepEqual(f.calls, [], 'no passive 180-second wait or unsafe exit')
})

for (const kind of ['box', 'pocket']) test(`casual ${kind} retains the existing wait`, async () => {
  const f = fixture({ kind, mode: 'casual' })
  await f.run()
  assert.equal(f.calls.includes('sit'), true)
})

test('a breached box cannot claim that it stayed behind sealed cover', async () => {
  const f = fixture({ sealed: false, held: 'breached' })
  const r = await f.run()
  assert.equal(r.stayed, undefined)
  assert.deepEqual(f.calls, ['leave'])
})

test('a pocket no longer proven empty/closed cannot claim cover', async () => {
  const f = fixture({ kind: 'pocket', pocket: 0 })
  const r = await f.run()
  assert.equal(r.stayed, undefined)
  assert.equal(f.calls.includes('sit'), true)
})

test('an explicit untilDawn request keeps its wait', async () => {
  const f = fixture({ untilDawn: true })
  await f.run()
  assert.equal(f.calls.includes('sit'), true)
})

test('a healed refuge keeps the existing clearance decision', async () => {
  const f = fixture({ held: 'healed' })
  const r = await f.run()
  assert.equal(r.stayed, true)
  assert.deepEqual(f.calls, ['sit', 'wait-clear'])
})

function callerFixture({ code = 'NO_FOOD', surface = false, inWater = false, foes = 1 } = {}) {
  const campaign = campaignTs()
  const names = ['refugeRun', 'tunnelAway', 'tunnelAwayBody']
  const functions = names.map(name => {
    const start = campaign.indexOf(`async function ${name} (`)
    assert.ok(start >= 0, name)
    return campaign.slice(start, campaign.indexOf('\n}', start) + 2)
  }).join('\n')
  const calls: string[] = []
  const detail = { code, stayed: true, healed: false, how: 'pocket', hp: 12 }
  const context: any = { state: { health: 12, food: 10 }, sit: { surface, inWater, foes }, died: false, fighting: false,
    tunnelingAway: false, process: { env: {} }, log() {}, sense: async () => {}, dim: () => 'overworld',
    nearWalkers: async () => 0, afterRefuge: async () => { calls.push('after-refuge') },
    act: async (method: string) => { calls.push(method); return method === 'refuge' ? { detail } : { detail: { walked: 5 } } } }
  vm.runInNewContext(transformSync(functions + '\nthis.run = refugeRun', { loader: 'ts' }).code, cjsContext(withSetters(context)))
  return { calls, detail, run: () => context.run('actual no-food receipt') }
}

test('the actual refuge caller hands a no-food underground receipt to the existing tunnel route', async () => {
  const f = callerFixture()
  const r = await f.run()
  assert.equal(r.detail, f.detail)
  assert.deepEqual(f.calls, ['refuge', 'tunnel'])
})

for (const options of [{ surface: true }, { inWater: true }, { foes: 0 }, { code: 'OK' }]) {
  test(`the refuge caller preserves its other response for ${JSON.stringify(options)}`, async () => {
    const f = callerFixture(options)
    await f.run()
    assert.deepEqual(f.calls, ['refuge', 'after-refuge'])
  })
}
