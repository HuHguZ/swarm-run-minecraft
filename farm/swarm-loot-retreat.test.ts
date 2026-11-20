import test from 'node:test'
import assert from 'node:assert/strict'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmPosition } from './swarm/swarm-driver/position'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { withinArena } from '../daemon/src/navigation/parkour/model'

const start = { x: 628.8202165818514, y: 120, z: 576.5580213039 }
const arena = { x: 600.5, y: 120, z: 600.5, r: 80, killY: 113, ellipse: { a: 77, b: 65 } }
const threats = [
  { id: 'nearest', position: { x: 638.9499999880791, y: 124, z: 580.5025345473271 }, seenAt: 1000 },
  { id: 'second', position: { x: 623.9029638553159, y: 128, z: 561.0337502663021 }, seenAt: 1000 }
]
const overlaps = [
  { ...threats[0].position, r: 11.5832506916089 },
  { x: 578.0674592381164, y: 123.17676838458252, z: 593.5001928179314, r: 22 },
  { ...threats[1].position, r: 18.143383521973494 },
  { x: 619.0174231801, y: 121.39828125, z: 592.9645960313259, r: 19.163132395778412 },
  { x: 555.6980562232637, y: 126, z: 579.8978395262575, r: 22 },
  { x: 600.6883936575088, y: 121.25227537751198, z: 594.3114893176062, r: 22 },
  { x: 592.5315406854589, y: 120, z: 568.5325758217946, r: 22 },
  { x: 557.4173516850576, y: 150, z: 556.5540799133014, r: 22 },
  { x: 591.7021801127669, y: 120, z: 618.0028803707551, r: 22 },
  { x: 553.4999614058771, y: 150, z: 643.3892972638461, r: 22 },
  { x: 577.3473559344118, y: 120, z: 576.4936606246508, r: 22 }
]

function fixture(at = start, enemies = threats) {
  const calls: any[] = [], task = { id: 'pvp:A', kind: 'loot', data: { race: true }, position: at }
  const member = { id: 'A', role: 'fighter', position: at, inventory: {}, health: 18 }
  const board = { enemies: () => enemies, facts: () => [], tasks: () => [] }
  const context: any = { task, member, members: [member], board }
  const pos = { A: { p: { ...at }, hp: 18, inv: {}, armor: { torso: 'chainmail_chestplate' } } }
  const b: any = { name: 'A', team: 'blue', swarmTask: task, c: { async call(method, params) {
    calls.push({ method, params })
    if (method === 'goto') {
      assert.ok(withinArena(b, params, params.arena), 'native endpoint guard must accept the chosen retreat')
      assert.ok(withinArena(b, { ...params, x: Math.floor(params.x) + .5, z: Math.floor(params.z) + .5 }, params.arena), 'native snapped-cell guard must accept it too')
      pos.A.p = { x: params.x, y: params.y, z: params.z }
      return { status: 'done', detail: { arrived: pos.A.p } }
    }
    return { status: 'done', detail: {} }
  } } }
  const sw: any = createDriverState({ bots: [b], pos, arena, arms: true, now: () => 1000, alive: () => true, log() {} })
  Object.assign(sw, { teamOf: () => 'blue', boardOf: () => board, refresh: () => context, say() {}, onslaught: () => false,
    blocked: () => false, chestAtHand: () => false, loot: async () => false, tour: async () => false, cacheTurn: async () => false,
    transfer: async () => false, positionStep: async () => false })
  Object.assign(sw, swarmMoves(sw))
  Object.assign(sw, swarmPosition(sw))
  return { b, sw, calls, pos, context, turn: swarmTurn(sw) }
}

test('captured loot retreat avoids both threats instead of repeating the same rejected away point', async () => {
  const f = fixture(), oldTarget = { x: 621.3654609622405, y: 120, z: 573.6551574331888 }
  assert.equal(withinArena(f.b, oldTarget, f.sw.lootArena(f.b)), false, 'match G: away from nearest enters the second exclusion')
  await f.turn.turn(f.b)
  const move = f.calls.find(c => c.method === 'goto')
  assert.ok(move, 'the existing search has a valid alternative with these two threats')
  assert.notDeepEqual(f.pos.A.p, start)
  assert.equal(f.b.swarmTask.kind, 'loot')
  assert.equal(f.calls.some(c => c.method === 'fight' || c.method === 'flee'), false, 'a naked looter keeps its avoidance and never borrows a combat owner')
  f.b.last = { m: 'goto', pending: true }; f.b.swarmExecuting = true
  assert.equal(f.turn.preempt(f.b), false, 'an ordinary loot refresh leaves its pending escape intact')
})

test('search checks both the exact endpoint and its snapped cell against native arena constraints', async () => {
  for (const constraints of [
    { avoid: [{ x: 9.5, y: 120, z: .5, r: 1.3 }] },
    { r: 8 },
    { minY: 121 }
  ]) {
    const f = fixture({ x: .1, y: 120, z: .1 }, [])
    const bounds = { x: 0, y: 120, z: 0, r: 20, ...constraints }
    f.sw.arena = bounds
    const search = swarmPosition({ ...f.sw, arena: bounds, lootArena: () => bounds,
      go: async (_b, at) => {
        assert.ok(withinArena(f.b, at, bounds))
        assert.ok(withinArena(f.b, { ...at, x: Math.floor(at.x) + .5, z: Math.floor(at.z) + .5 }, bounds))
        f.calls.push({ method: 'goto', params: at })
        return { status: 'done', detail: { arrived: at } }
      } }).search
    await search(f.b, f.context)
    if ('minY' in constraints) assert.equal(f.calls.length, 0, 'no valid point means no repeated native rejection')
    else assert.ok(f.calls.length)
  }
})

test('a rejected search route uses existing badSpots until the actor moves', async () => {
  const f = fixture(start, []), targets = new Set<string>()
  const search = swarmPosition({ ...f.sw, go: async (_b, at) => {
    const key = JSON.stringify(at)
    assert.equal(targets.has(key), false, 'the same failed endpoint must not be retried without progress')
    targets.add(key)
    return { status: 'failed', detail: { why: 'no path' } }
  } }).search
  for (let i = 0; i < 12; i++) await search(f.b, f.context)
  assert.ok(targets.size > 1 && targets.size <= 8)
})

test('all captured exclusions hand off to the existing risk-based body escape without losing loot ownership', async () => {
  const f = fixture()
  f.sw.lootArena = () => ({ ...arena, avoid: overlaps })
  Object.assign(f.sw, swarmPosition(f.sw))
  let finish: any
  f.b.c.call = (method, params) => {
    f.calls.push({ method, params })
    if (method === 'flee') return new Promise(resolve => { finish = resolve })
    return Promise.resolve({ status: 'done', detail: {} })
  }
  const pending = swarmTurn(f.sw).turn(f.b)
  await new Promise(resolve => setImmediate(resolve))
  try {
    const escape = f.calls.find(c => c.method === 'flee')
    assert.ok(escape, 'no strictly safe endpoint must not leave a naked looter motionless')
    assert.deepEqual(escape.params.arena.avoid, overlaps, 'remembered danger reaches body scoring unchanged')
    assert.equal(f.calls.some(c => c.method === 'goto' || c.method === 'fight'), false)
    assert.equal(f.b.swarmTask.kind, 'loot')
    f.b.last = { m: 'flee', pending: true }; f.b.swarmExecuting = true
    f.context.task = { ...f.context.task, kind: 'flee', data: { kite: true } }
    assert.equal(f.turn.preempt(f.b), false, 'ordinary loot to flee reassignment must not cancel the borrowed escape')
    f.context.task = { ...f.context.task, data: { commanded: true } }
    assert.equal(f.turn.preempt(f.b), true, 'explicit commands retain preemption')
    f.b.swarmTask = { ...f.context.task, kind: 'loot', data: { race: true } }
    f.context.task = { ...f.context.task, kind: 'recover', data: {} }
    assert.equal(f.turn.preempt(f.b), true, 'urgent recovery also retains preemption')
  } finally { finish?.({ status: 'done', detail: { ran: 3 } }); await pending }
})

test('a failed loot approach borrows escape only under remembered pressure and while it still owns the action', async () => {
  for (const condition of ['near', 'far', 'rescue', 'commanded', 'round', 'new action', 'interrupted']) {
    const f = fixture(), bounds = condition === 'far' ? { ...arena, avoid: [{ x: 566.5, y: 120, z: 593.5, r: 22 }] } : f.sw.lootArena(f.b)
    const failed = { status: condition === 'interrupted' ? 'interrupted' : 'failed', code: 'AVOID_NO_PATH', state: { pos: start } }
    f.b.c.call = async (method, params) => {
      f.calls.push({ method, params })
      if (method !== 'goto') return { status: 'done', detail: { at: { ...start, z: start.z + 3 } } }
      if (condition === 'rescue') f.b.webRescue = {}
      if (condition === 'commanded') f.context.task.data.commanded = true
      if (condition === 'round') f.sw.generation++
      if (condition === 'new action') await Promise.resolve().then(() => { f.b.last = { m: 'lava_escape', pending: true } })
      return failed
    }
    const reply = await f.sw.go(f.b, { ...start, z: start.z + 8 }, 2, 4, bounds)
    assert.equal(reply, failed, 'an escape is never a successful receipt for the failed route')
    const escape = f.calls.find(c => c.method === 'flee')
    assert.equal(!!escape, condition === 'near', condition)
    if (escape) assert.equal(escape.params.arena, bounds, 'the same remembered exclusions reach body scoring')
  }
})

test('PvP walking disables the outdoor roof preference while retaining an explicit strict/walkOnly route', async () => {
  const f = fixture(start, []), at = { ...start, z: start.z + 3 }
  await f.sw.go(f.b, at)
  assert.equal(f.calls[0].params.surface, false)
  assert.equal(f.calls[0].params.climb, undefined)
  await f.sw.go(f.b, { ...at, surface: 'strict', walkOnly: true })
  assert.equal(f.calls[1].params.surface, 'strict')
  assert.equal(f.calls[1].params.walkOnly, true)
  assert.equal(f.calls[1].params.climb, undefined)
  assert.equal(f.calls[1].params.arena, f.calls[0].params.arena)
})

test('captured tier3 upper loot retries a failed strict walk once with its own resources and remaining budget', async () => {
  const f = fixture({ x: 567, y: 126, z: 632 }, []), target = { x: 553.5, y: 144, z: 643.5, tier: 3 }
  const inv = { stone_pickaxe: 1, sandstone: 64 }, bounds = { ...arena, avoid: [{ x: 590, y: 126, z: 640, r: 3 }] }
  let time = 1000
  f.pos.A.hp = 20; f.pos.A.inv = inv
  f.sw.now = () => time
  Object.assign(f.sw, swarmMoves(f.sw))
  f.b.c.call = async (method, params) => {
    f.b.last = { m: method, p: params }; f.calls.push({ method, params })
    if (!params.climb) { time += 22000; return { status: 'failed', code: 'FAILED', error: 'не дошёл (6 попытки). Последняя: No path to the goal!', state: { pos: f.pos.A.p, inventory: inv, health: 20 } } }
    assert.equal(f.b.climbing, true)
    assert.equal(f.b.swarmAscent.pending, true)
    return { status: 'done', detail: { arrived: target } }
  }
  const reply = await f.sw.go(f.b, target, 2, 31, bounds)
  assert.deepEqual(f.calls.map(c => c.method), ['goto', 'goto'])
  assert.equal(f.calls[0].params.climb, undefined)
  assert.equal(f.calls[1].params.climb, true)
  assert.equal(f.calls[1].params.exactY, true)
  assert.equal(f.calls[1].params._climb, true)
  assert.equal(f.calls[1].params.timeoutSeconds, 9)
  assert.ok(f.calls.every(c => c.params.arena === bounds))
  assert.equal(reply.detail.arrived, target)
  assert.equal(f.b.climbing, false)
  assert.equal(f.b.swarmAscent, undefined)
})

test('upper walk escalation preserves cancellations, explicit routes, resource limits and action ownership', async () => {
  for (const condition of ['interrupted', 'skipped', 'done', 'pending', 'timeout', 'DAMAGE', 'ARENA_BOUNDARY', 'AVOID_NO_PATH', 'commanded', 'walkOnly', 'strict', 'empty', 'zero tool', 'round', 'new action', 'rescue', 'Tactical', 'Emergency', 'flat', 'already climb', 'budget']) {
    const f = fixture({ x: 567, y: 126, z: 632 }, []), at: any = { x: 553.5, y: condition === 'flat' ? 126 : 144, z: 643.5, tier: 3 }
    const inv = condition === 'empty' ? {} : condition === 'zero tool' ? { stone_pickaxe: 0 } : { stone_pickaxe: 1, sandstone: 64 }
    let time = 1000
    f.pos.A.inv = inv; f.sw.now = () => time
    Object.assign(f.sw, swarmMoves(f.sw))
    if (condition === 'commanded') f.context.task.data.commanded = true
    if (condition === 'walkOnly') at.walkOnly = true
    if (condition === 'strict') at.surface = 'strict'
    if (condition === 'already climb') at.climb = true
    f.b.c.call = async (method, params) => {
      f.b.last = { m: method, p: params }; f.calls.push({ method, params })
      await Promise.resolve()
      if (condition === 'round') f.sw.generation++
      if (condition === 'new action') f.b.last = { m: 'lava_escape' }
      if (condition === 'rescue') f.b.webRescue = {}
      if (condition === 'budget') time += 28000
      return { status: ['interrupted', 'skipped', 'done', 'pending', 'timeout'].includes(condition) ? condition : 'failed', code: condition,
        state: { pos: f.pos.A.p, inventory: inv, tactics: { owner: condition } } }
    }
    await f.sw.go(f.b, at, 2, 31, arena)
    assert.equal(f.calls.length, 1, condition)
  }
})
