import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const esbuild = require('../../node_modules/esbuild')
const Vec3 = require('vec3')

function source(name: string, overrides: Record<string, unknown>) {
  const file = path.resolve(__dirname, '../src', name + '.ts'), local = createRequire(file)
  const module = { exports: {} as Record<string, any> }
  const code = esbuild.transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext(require('node:module').wrap(code), { filename: file })(module.exports,
    (id: string) => id in overrides ? overrides[id] : local(id), module, file, path.dirname(file))
  return module.exports
}

test('actual takeBox and refugeBody preserve rejected wall diagnostics while declining to heal inside an open shell', async () => {
  const cell = new Vec3(0, 64, 0)
  const receipt = { cell, placed: 2, plan: [], failed: ['wall 1,1,0: server rejected placement'], walls: 3, roof: true, sealed: false }
  let builds = 0, patches = 0, holds = 0
  const fortify = { feetCell: () => cell, landed: async () => true, refugeNeed: () => ({ walls: 3, roofSolid: true, blocks: 2 }), enclosure: () => ({ walls: 3, roof: true, sealed: false }),
    refugeBox: async () => { builds++; return receipt }, refugePatch: async () => { patches++; return 0 } }
  const flee = { hostilesAround: () => [], smartFlee: async () => ({ cornered: true, ran: 0, mode: 'cornered' }) }
  const enter = { gameClock: { now: () => 1000 }, sleep: async () => {}, worlds: { worldOf: () => 'the_nether' },
    xyz: (v: any) => ({ x: v.x, y: v.y, z: v.z }) }
  const hold = source('survival/hold-out', { '.././fortify': fortify, '.././flee': flee, './enter-shelter': enter })
  const assessment = { nether: true, cell: { cell, dist: 0 }, canBreakOut: true, blocks: 64 }
  const body = source('survival/refuge-body', { '.././fortify': fortify, '.././flee': flee, './enter-shelter': enter,
    './hold-out': { ...hold, refugeLook: () => assessment, lookLine: () => 'fixture: rejected wall',
      chooseRefuge: () => ({ how: 'box', why: 'available box' }), outrun: () => false,
      holdOut: async () => { holds++; throw new Error('open shell is not cover') } } })
  const session = { bot: { health: 10, entity: { position: cell }, inventory: { items: () => [] }, pathfinder: { setGoal: () => {} } } }
  const out: any = { how: 'none', code: 'OK', hp0: 10 }
  const result = await body.refugeBody(session, { aborted: false }, { t0: 1000, minHp: 16, deadline: 30000,
    out, step: () => {}, hurts: [] })
  assert.equal(builds, 1)
  assert.equal(patches, 2, 'the existing two patch attempts still run')
  assert.equal(holds, 0, 'no healing wait may start in an unsealed shell')
  assert.equal(result.code, 'CORNERED')
  assert.equal(result.healed, false)
  assert.equal(result.box.placed, 2, 'real partial placements survive the null fallback')
  assert.deepEqual(result.box.failed, receipt.failed)
  assert.equal(result.box.sealed, false)
})
