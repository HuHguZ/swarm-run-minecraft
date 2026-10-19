import { campaignScript } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { cjsContext } from './cjs-context'
import { withClockFixture } from './clock-fixture'

function campaign(refused = false, safe = false) {
  const file = path.join(__dirname, '../campaign.js'), baseRequire = createRequire(file), calls: any[] = []
  const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 16, z: 0 },
    inventory: { stone_pickaxe: 1, water_bucket: 1, flint_and_steel: 1, cobblestone: 64 }, playPolicy: { mode: 'speedrun' } }
  const situation = { surface: false, night: true, foes: 0, free: 24, pickLeft: 100,
    work: { sealed: true, floor: true, roof: true, walls: 4, block: 0, sky: 0 } }
  class Socket {
    listeners = new Map()
    on(name, fn) { this.listeners.set(name, fn) }
    send(raw) {
      const { id, method, params } = JSON.parse(raw); calls.push({ method, params })
      let detail: any = {}, status = 'done'
      if (method === 'situation') detail = situation
      if (method === 'recall') detail = { places: {} }
      if (method === 'mine_seen') detail = { spots: [] }
      if (method === 'dig_down' || method === 'tunnel') {
        if (refused) { detail = { stopped: 'нет пути в этой геометрии' }; status = 'failed' }
        else { state.pos.y -= params.depth || 0; detail = { dug: params.depth * 3, descended: params.depth } }
      }
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({ id, ok: true, result: { status, state, detail, events: [] } })))
    }
  }
  const context: any = { require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync() {} } :
      name === './src/telemetry' ? { on: () => false, record() {} } : baseRequire(name),
    __dirname: path.dirname(file), module: { exports: {} }, process: { argv: ['node', file], env: { ND_MAP: '0', ND_NIGHT_WORK_SAFE: safe ? '1' : '0' } },
    console: { log() {}, error() {} }, queueMicrotask, setTimeout, testState: state, testSituation: situation }
  vm.runInNewContext(campaignScript() + '\nstate=testState;sit=testSituation;module.exports={step:nightWorkStep,hold:nightHold}', cjsContext(withClockFixture(context)))
  return { calls, state, c: context.module.exports }
}
test('real campaign/RPC flow makes consecutive useful night legs with no stage iron or idle wait', async () => {
  const f = campaign()
  await f.c.step(); await f.c.step()
  assert.equal(f.state.pos.y, -8)
  assert.equal(f.calls.filter(c => c.method === 'dig_down').length, 2)
  assert.equal(f.calls.some(c => c.method === 'refuge' || c.method === 'wait'), false)
})
test('real act does not recursively repeat a refused night step and failure memory survives polling', async () => {
  const f = campaign(true)
  await f.c.step(); await f.c.step()
  assert.equal(f.calls.filter(c => c.method === 'dig_down').length, 4)
  assert.equal(f.calls.filter(c => c.method === 'tunnel').length, 4)
  assert.ok(f.calls.some(c => c.method === 'refuge' && c.params.why.includes('нет доступной работы')))
})
test('C8: the real RPC path marks physical night steps for per-cell protection', async () => {
  const f = campaign(false, true)
  await f.c.step(); await f.c.step()
  const legs = f.calls.filter(c => c.method === 'dig_down')
  assert.equal(legs.length, 2)
  assert.ok(legs.every(c => c.params.nightWork === true))
  assert.equal(f.calls.some(c => c.method === 'refuge'), false)
})
test('C8: low hp without food returns to the night scheduler instead of moving refuge or crashing', async () => {
  const f = campaign(false, true)
  f.state.health = 5; f.state.food = 10
  await assert.doesNotReject(() => f.c.step())
  assert.equal(f.calls.some(c => c.method === 'refuge'), false)
})
