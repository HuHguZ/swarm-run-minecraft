import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmMethods } from '../daemon/src/rpc/swarm'
import { Block, data, testBot } from '../daemon/test/tick-plugins-fixture'
import { installDangers } from './arena/dangers'

const settle = () => new Promise(resolve => setImmediate(resolve))
function room() {
  const bot = testBot(); bot.entity.position.set(.5, 64, .5)
  const cells = new Map<string, string | null>(), reads: string[] = []
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) cells.set(`${x},63,${z}`, 'bedrock')
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    if (x || z) for (const y of [64, 65]) cells.set(`${x},${y},${z}`, 'bedrock')
    cells.set(`${x},66,${z}`, 'bedrock')
  }
  bot.blockAt = p => {
    const at = p.floored(), key = [at.x, at.y, at.z].join(','); reads.push(key)
    const name = cells.has(key) ? cells.get(key) : 'air'
    if (name === null) return null
    const block = Block.fromStateId(data.blocksByName[name!].defaultState, 0); block.position = at; return block
  }
  const session: any = { require: () => bot, immediate: async worker => ({ status: 'done', detail: await worker() }) }
  const rpc = swarmMethods({ session } as any)
  const open = () => {
    for (const y of [64, 65]) {
      for (let z = -1; z <= 1; z++) cells.set(`1,${y},${z}`, 'air')
      cells.set(`0,${y},1`, 'air')
    }
  }
  return { bot, cells, reads, rpc, open }
}

test('native swarm_pose inspection reports ray-observed air, not an absent block outline', async () => {
  const f = room(), at = { x: 0, y: 64, z: 0 }
  assert.deepEqual((await f.rpc.swarm_pose({ at, inspectOnly: true })).detail.existing, { name: 'air', solid: false })
  const hidden = await f.rpc.swarm_pose({ at: { x: 3, y: 64, z: 3 }, inspectOnly: true })
  assert.equal(hidden.detail.existing, undefined, 'packet air behind the closed room is unknown')
  f.cells.set('0,64,0', null)
  assert.equal((await f.rpc.swarm_pose({ at, inspectOnly: true })).detail.existing, undefined, 'unloaded air is unknown')
})

test('native swarm_pose batches observed cells without exposing hidden or out-of-range packet data', async () => {
  const f = room(), cells = [{ x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 3 }, { x: 100, y: 64, z: 0 }]
  const result = await f.rpc.swarm_pose({ cells, inspectOnly: true })
  assert.deepEqual(result.detail.cells, [
    { at: cells[0], existing: { name: 'air', solid: false } }, { at: cells[1] }, { at: cells[2] }
  ])
  assert.ok(!f.reads.includes('3,64,3') && !f.reads.includes('100,64,0'), 'hidden and distant raw target cells must remain unread')
  const reads = f.reads.length
  for (const params of [{ cells: Array(65).fill(cells[0]), inspectOnly: true },
    { cells: [{ x: NaN, y: 64, z: 0 }], inspectOnly: true }, { cells, inspectOnly: false }]) {
    assert.deepEqual((await f.rpc.swarm_pose(params)).detail, { poses: [], cells: [] })
  }
  assert.equal(f.reads.length, reads, 'invalid batches do not inspect the world')
})

test('native single placement query retains placement poses and the visible existing block', async t => {
  const f = room(), poses = [{ existing: 'placement-result' }]
  const senses = require('../daemon/src/swarm-senses')
  t.mock.method(senses, 'placementPoses', () => poses)
  const result = await f.rpc.swarm_pose({ at: { x: 0, y: 63, z: 0 } })
  assert.deepEqual(result.detail, { poses, existing: { name: 'bedrock', solid: true } })
})

test('the cloud driver retries a genuinely observed opening through the real RPC/LOS wire in one batch', async t => {
  t.mock.method(Math, 'random', () => .6)
  const f = room(), inspections: any[] = [], actions: any[] = []
  const p = { x: .5, y: 64, z: .5 }, b: any = { name: 'A', team: 'blue', last: { m: 'idle', pending: false } }
  b.c = { call: async (method, params) => {
    if (method === 'swarm_pose') { inspections.push(params); return f.rpc.swarm_pose(params) }
    const action = { m: method, p: params, pending: false }; b.last = action; actions.push(action)
    if (method === 'dig_to') return { status: 'done', detail: { ok: false, dug: 0, why: 'не пробить' } }
    assert.equal(method, 'evade')
    return { status: 'done', detail: actions.filter(a => a.m === 'evade').length === 1
      ? { ok: false, why: 'некуда: стены, обрыв или лава со всех сторон' } : { ok: true } }
  } }
  const ctx: any = { round: 1, bots: [b], pos: { A: { p, inv: {} } }, busy: new Set(), out: new Set(), deadNow: new Set(), enemiesOf: () => [], log() {} }
  installDangers(ctx)
  let observedAt = 1000
  const report = () => b.c.onDanger({ pos: p, observedAt: ++observedAt, dangers: { clouds: [{ at: { x: .1, y: 64, z: .1 }, r: 3 }] } })
  report(); await settle(); await settle()
  assert.deepEqual(actions.map(a => a.m), ['evade', 'dig_to'])
  for (let i = 0; i < 8; i++) { report(); await settle() }
  assert.equal(actions.length, 2, 'fresh identical cloud receipts cannot spam a physically blocked exit')
  f.cells.set('3,64,3', 'diamond_block'); report(); await settle()
  assert.equal(actions.length, 2, 'an invisible packet-only change cannot reopen a failed route')
  f.open(); report(); await settle(); await settle()
  assert.deepEqual(actions.map(a => a.m), ['evade', 'dig_to', 'evade'], 'newly ray-observed air/floor must reopen the same cloud')
  assert.equal(inspections.length, 11, 'one bounded RPC per failure inspection/receipt, not nineteen')
  assert.ok(inspections.every(p => p.inspectOnly && p.cells.length <= 64 && !p.at))
  report(); await settle(); assert.equal(actions.length, 3, 'confirmed success consumes the unchanged cloud')
})
