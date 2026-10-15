import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { body } from './ow-golden-source'

const campaign = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')

function surfaceFixture(pit = true, pick = pit) {
  let time = 0
  const calls: Array<{ method: string; params: any }> = []
  const state = { pos: { x: 1, y: 87, z: 2 } }
  const globals: any = { sense: async () => {}, sit: { surface: false, inWater: false }, state, stairEntrance: null,
    gameClock: { now: () => time }, died: false, dim: () => 'overworld', y: () => state.pos.y,
    spares: async () => {}, ensurePick: async () => pick, log: () => {},
    act: async (method: string, params: any) => {
      calls.push({ method, params })
      if (method === 'goto') { globals.sit.surface = true; state.pos.x += 12; return { status: 'done', detail: {} } }
      time += pit ? (params.timeoutSeconds ?? 0) * 1000 : 1000
      return { status: 'done', detail: { out: false, pit, stopped: 'колонка sand сыплется в забой' } }
    }
  }
  return { calls, run: body(campaign, 'async function toSurface (', 'const portalBuckets', globals, 'toSurface'), time: () => time }
}

test('food ascent uses its remaining budget, including a bare-hand climb', async () => {
  for (const pick of [true, false]) {
    const f = surfaceFixture(true, pick)
    await f.run(4, 30000)
    assert(f.time() <= 30000, 'a food attempt must not start a 120/600-second ascent with 30 seconds left')
    assert.equal(f.calls.length, 1)
  }
})

test('an open space under a sand overhang tries a lateral exit instead of repeating the same ascent', async () => {
  const f = surfaceFixture(false)
  assert.equal(await f.run(4, 30000), true)
  assert.equal(f.calls[0].method, 'surface')
  assert.equal(f.calls[1].method, 'goto')
})
