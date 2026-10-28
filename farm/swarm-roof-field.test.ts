import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'

const noLanding = { status: 'done', detail: { ok: false, why: 'негде сесть у цели (под навесом или занято)' } }
const landed = { status: 'done', detail: { ok: true } }

function fixture(first: any = noLanding, second: any = landed, afterFly?: (n: number, sw: any, b: any) => void) {
  const calls: any[] = [], failed: string[] = []
  const arena = { x: 600.5, y: 120, z: 600.5, r: 64 }
  const m = { p: { x: 551.5, y: 153, z: 554.5 }, inv: { elytra: 1, firework_rocket: 10 } }
  const enemy = { id: 'Foe', seenAt: 1000, position: { x: 551.5, y: 153, z: 558.5 } }
  const sw: any = { generation: 1, living: true, now: () => 1000, alive: () => sw.living,
    arena, pos: { A: m }, cooldown: new Map(), bounded: at => at, blocked: () => false,
    failed: (_b, key) => failed.push(key), log() {}, detail: r => r?.detail || r || {}, rangedAdvantage: () => false }
  let flights = 0
  const b: any = { name: 'A', c: { async call(method, params) {
    calls.push({ method, params })
    if (method === 'jump_down') return { status: 'done', detail: { ok: false, why: 'no_safe_drop' } }
    if (method === 'fly_to') { flights++; afterFly?.(flights, sw, b); return flights === 1 ? first : second }
    return { status: 'done', detail: { ok: true } }
  } } }
  const run = () => swarmTurnTasks(sw).turnFlee({ b, round: 1, m, enemies: [enemy], context: { members: [] },
    member: {}, board: {}, task: { position: { ...arena }, data: {} } })
  return { calls, failed, arena, m, enemy, sw, b, run }
}

test('a roof escape with no landing away from the pursuer tries the open field once', async () => {
  const f = fixture()
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['jump_down', 'fly_to', 'fly_to'])
  assert.notDeepEqual(f.calls[1].params.at, { x: f.arena.x, y: f.arena.y, z: f.arena.z })
  assert.deepEqual(f.calls[2].params, { at: { x: f.arena.x, y: f.arena.y, z: f.arena.z }, timeoutSeconds: 10, arena: f.arena })
  assert.deepEqual(f.failed, [])
})

test('a successful flight away from a roof pursuer needs no field fallback', async () => {
  const f = fixture(landed)
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['jump_down', 'fly_to'])
})

test('the field fallback is only for the completed no-landing preflight refusal', async () => {
  for (const reply of [
    { status: 'done', detail: { ok: false, why: 'landing_missed', at: { x: 580, y: 120, z: 580 } } },
    { ...noLanding, status: 'failed' },
    { status: 'done', detail: { ok: false, why: 'над головой блоки у неба' } }
  ]) {
    const f = fixture(reply)
    await f.run()
    assert.equal(f.calls.some(c => c.method === 'fly_to' && c.params.at.x === f.arena.x && c.params.at.z === f.arena.z), false)
  }
})

test('an interrupted flight or an autonomous rescue owns the body before any fallback', async () => {
  for (const reply of [{ status: 'interrupted', by: { owner: 'Tactical' } }, { status: 'failed', code: 'RESCUE_BUSY' }]) {
    const f = fixture(reply)
    await f.run()
    assert.deepEqual(f.calls.map(c => c.method), ['jump_down', 'fly_to'])
    assert.deepEqual(f.failed, [])
    if (reply.status === 'interrupted') {
      assert.equal(f.b.swarmFightReply, reply)
      assert.equal(f.sw.cooldown.get('fight:A'), 1500)
    }
  }
})

test('a new round, death or cancelled turn cannot start the field fallback', async () => {
  for (const change of [sw => { sw.generation++ }, sw => { sw.living = false }, (_sw, b) => { b.swarmTurnOwner = { cancelled: true } }]) {
    const f = fixture(noLanding, landed, (n, sw, b) => { if (n === 1) change(sw, b) })
    await f.run()
    assert.deepEqual(f.calls.map(c => c.method), ['jump_down', 'fly_to'])
    assert.deepEqual(f.failed, [])
  }
})

test('ownership and round guards still apply after the field fallback', async () => {
  for (const reply of [{ status: 'interrupted' }, { status: 'failed', code: 'RESCUE_BUSY' }]) {
    const f = fixture(noLanding, reply)
    await f.run()
    assert.deepEqual(f.calls.map(c => c.method), ['jump_down', 'fly_to', 'fly_to'])
    assert.deepEqual(f.failed, [])
    if (reply.status === 'interrupted') assert.equal(f.b.swarmFightReply, reply)
  }
  const stale = fixture(noLanding, landed, (n, sw) => { if (n === 2) sw.generation++ })
  await stale.run()
  assert.deepEqual(stale.failed, [])
})

test('a no-landing refusal already at the field target does not repeat that request', async () => {
  const f = fixture()
  f.m.p = { x: 614.5, y: 153, z: 600.5 }
  f.enemy.position = { x: 620.5, y: 153, z: 600.5 }
  await f.run()
  assert.equal(f.calls.filter(c => c.method === 'fly_to' && c.params.at.x === f.arena.x && c.params.at.z === f.arena.z).length, 1)
})
