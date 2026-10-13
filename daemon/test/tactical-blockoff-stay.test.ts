import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
const { transformSync } = require('esbuild')
const Vec3 = require('vec3')

function load(file: string, overrides: Record<string, any>) {
  const native = createRequire(file), context: any = { module: { exports: {} }, exports: {},
    require: name => Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : native(name),
    process, console: { log() {}, error() {} }, setTimeout, clearTimeout }
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, context, { filename: file })
  return context.module.exports
}

function fixture({ sealed = true, why = 'no_food', aborted = false, hp = 10 }: any = {}) {
  let now = 0
  const calls: string[] = [], cell = new Vec3(4, 64, 7)
  const bot: any = { health: hp, food: 13, time: { isDay: false }, game: { dimension: 'overworld' },
    entity: { position: cell, onGround: true }, entities: {}, inventory: { items: () => [] },
    pathfinder: { setGoal() {} }, clearControlStates() {}, _client: new EventEmitter() }
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true } }
  const session: any = { bot, journal: { append() {} } }
  const refuge = load(path.resolve(__dirname, '../src/survival/refuge-body.ts'), {
    './hold-out': { refugeLook: () => ({ blocks: 64, cell: {}, canBreakOut: true }), lookLine: () => 'night; no food',
      chooseRefuge: () => ({ how: 'box', why: 'covered work' }), outrun: () => false,
      takeBox: async () => { calls.push('build'); now += 1500; session.shelterBox = cell; return { cell, placed: 9 } },
      holdOut: async () => { calls.push('hold'); ctl.aborted = aborted; return { why, ate: [] } },
      sitTight: async () => { calls.push('sit'); now += 399500; return { sat: 399500 } },
      waitClear: async () => { calls.push('clear'); return true },
      leaveBox: async () => { calls.push('open'); return { ok: true } } },
    './surface-body': {},
    './enter-shelter': { gameClock: { now: () => now }, xyz: v => [v.x, v.y, v.z], sitOn: () => true, Vec3 },
    '.././fortify': { landed: async () => {}, enclosure: () => ({ sealed }) },
    '.././flee': { hostilesAround: () => [] }, '.././items': { bestWeapon: () => null }
  })
  const { TacticalSystem } = load(path.resolve(__dirname, '../src/tactics/minecraft.ts'), { '../survival': refuge })
  return { calls, session, run: (id = 'BlockOff') => TacticalSystem.prototype.execute.call({ session }, { id }, ctl, { enemies: [] }) }
}

test('night BlockOff returns NO_FOOD from a confirmed sealed box without opening walls or waiting for dawn', async () => {
  const f = fixture(), result = await f.run()
  assert.equal(result.code, 'NO_FOOD')
  assert.equal(result.failed, true)
  assert.equal(result.healed, false)
  assert.equal(result.stayed, true)
  assert.ok(result.seconds < 30)
  assert.deepEqual(f.calls, ['build', 'hold'])
  assert.ok(f.session.shelterBox)
})

for (const options of [{ sealed: false }, { why: 'breached' }, { why: 'died', hp: 0 }, { aborted: true }]) {
  test(`BlockOff does not claim a preserved safe box ${JSON.stringify(options)}`, async () => {
    const f = fixture(options), result = await f.run()
    assert.notEqual(result.stayed, true)
    assert.equal(result.healed, false)
    if (options.why === 'breached') assert.equal(result.code, 'CORNERED')
    if (options.hp === 0) assert.equal(result.code, 'DIED')
  })
}

test('other refuge actions retain their existing exit policy', async () => {
  const f = fixture(), result = await f.run('Heal')
  assert.notEqual(result.stayed, true)
  assert.deepEqual(f.calls, ['build', 'hold', 'sit', 'clear', 'open'])
})
