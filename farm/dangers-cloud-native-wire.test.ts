import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmMethods } from '../daemon/src/rpc/swarm'
import { Block, data, testBot } from '../daemon/test/tick-plugins-fixture'
import { drive, native } from '../daemon/test/parkour-fixture'
import { hazardMethods } from '../daemon/src/rpc/hazards'
import { dangers } from '../daemon/src/threats'
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
  const ctx: any = { round: 1, X: 0, Y: 64, Z: 0, R: 20, arms: true, L: { y0: -4 }, bots: [b], pos: { A: { p, inv: {} } }, busy: new Set(), out: new Set(), deadNow: new Set(), enemiesOf: () => [], log() {} }
  installDangers(ctx)
  let observedAt = 1000
  const report = () => b.c.onDanger({ pos: p, observedAt: ++observedAt, dangers: { clouds: [{ at: { x: .1, y: 64, z: .1 }, r: 3 }] } })
  report(); await settle(); await settle()
  assert.deepEqual(actions.map(a => a.m), ['evade', 'dig_to'])
  assert.deepEqual(actions[1].p.arena, { x: .5, y: 64, z: .5, r: 20, killY: 57, ellipse: undefined })
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

test('a visible side doorway reopens a failed floor escape while the same support is still cracking', async t => {
  const { bot, cells, rpc } = room()
  cells.set('0,63,0', 'stone')
  cells.set('0,63,2', 'stone')
  const world = { getBlock: p => bot.blockAt(p) }
  bot.world = world; bot.physics = native.Physics(bot.registry, world)
  bot.version = '1.21.11'; bot.entity.width = .6; bot.entity.onGround = true; bot.health = bot.food = 20
  drive(bot, world)
  let frames = 0, now = 13000, random = 0
  t.mock.method(Date, 'now', () => now)
  t.mock.method(Math, 'random', () => random)
  const body = hazardMethods({ session: { require: () => bot,
    runIntent: async (_name, worker) => ({ status: 'done', detail: await worker({ aborted: false }) }) },
  gameClock: { sleep: async () => {
    const state = new native.PlayerState(bot, bot.controlState)
    bot.physics.simulatePlayer(state, world); state.apply(bot); frames++
  } } } as any)
  const escapes: any[] = [], inspections: number[] = []
  const b: any = { name: 'A', team: 'blue', last: { m: 'idle', pending: false }, dodgeStyle: { jumpy: 0 },
    c: { call: async (method, params) => {
      if (method === 'swarm_pose') { inspections.push(params.cells.length); return rpc.swarm_pose(params) }
      assert.equal(method, 'evade')
      const result = await body.evade(params)
      escapes.push(result.detail); return result
    } } }
  const ctx: any = { round: 1, X: 0, Y: 64, Z: 0, R: 20, arms: true, L: { y0: -4 }, bots: [b],
    pos: { A: { p: bot.entity.position, inv: {} } }, busy: new Set(), out: new Set(), deadNow: new Set(), enemiesOf: () => [], log() {} }
  installDangers(ctx)
  assert.deepEqual(dangers(bot, { foes: [] }).floor, [])
  const report = async (cracking = true) => {
    now += 1600
    if (cracking) bot.emit('blockBreakProgressObserved', bot.blockAt(bot.entity.position.offset(0, -1, 0)), 2, { id: 77 })
    const floor = cracking ? dangers(bot, { foes: [] }).floor : []
    if (cracking) assert.equal(floor[0]?.signal, 'sight')
    const p = ctx.pos.A.p = bot.entity.position.clone()
    b.c.onDanger({ pos: p, observedAt: now, dangers: { floor } }); await settle()
  }
  await report()
  assert.match(escapes[0].why, /стены, обрыв/)
  assert.equal(frames, 0)
  await report(false)
  random = .5 // A new crack receipt has no preferred compass heading while the bot stands over its centre.
  await report()
  cells.set('0,64,2', 'diamond_block')
  await report()
  assert.equal(escapes.length, 1, 'a hidden change behind the side wall or a new random angle cannot restart the same blocked run')
  cells.delete('0,64,2')
  for (const y of [64, 65]) cells.set(`0,${y},1`, 'air')
  await report()
  assert.equal(escapes.length, 2, 'opening the side door during the continuing visible crack must reach the native escape again')
  assert.deepEqual(escapes[1], { ok: true, dir: { x: 0, z: 1 } })
  assert.equal(bot.entity.position.y, 64); assert.ok(bot.entity.position.z > 2); assert.equal(frames, 9)
  assert.equal(inspections.length, 4, 'one body sight query per relevant receipt, including the initial failure')
  assert.ok(inspections.every(n => n > 0 && n <= 64))
  await report()
  assert.equal(escapes.length, 3, 'the fresh crack on the new support starts its own escape')
  assert.equal(escapes[2].ok, true)
})
