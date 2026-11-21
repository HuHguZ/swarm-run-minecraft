import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { Session } from '../daemon/src/session'
import { block, data, install, testClock } from '../daemon/test/tick-plugins-fixture'

function scene() {
  const p = (x, z = .5) => ({ x, y: 120, z }), start = p(.5), goal = p(68.5), ally = p(63.5, 5.5)
  const near = p(16.5), task = { kind: 'flee', position: goal, data: { regroup: true, target: 'Champion' } }
  const actor: any = { name: 'Runner' }, member = { id: actor.name, health: 20, position: start }
  const members = [member, { id: 'Anchor', health: 20, position: ally }, { id: 'FarWing', health: 20, position: near }]
  const enemies: any[] = [], board = { tasks: () => [], facts: () => [], enemies: () => enemies }
  const f: any = { calls: [], status: 'timeout', end: start }
  const sw: any = { now: () => 10000, generation: 1, alive: () => true, log() {}, pos: Object.fromEntries(members.map(a => [a.id, { hp: 20, p: a.position, inv: {} }])),
    arena: { x: 35, y: 120, z: .5, r: 80, killY: 116 }, refresh: () => ({ task, board, member, members }),
    rangedAdvantage: () => false, say() {}, onslaught: () => false, teamOf: () => 'red', boardOf: () => board,
    positionStep: async () => { f.calls.push({ method: 'position' }); return true }, cooldown: new Map() }
  Object.assign(sw, swarmRetry(sw), swarmMoves(sw))
  actor.c = { async call(method, params) {
    const owner = actor.last = { m: method, pending: true }; f.calls.push({ method, params })
    await Promise.resolve(); owner.pending = false
    if (method === 'flee') return { status: 'done', detail: { mode: 'оторвался', ran: 2 } }
    f.onReply?.()
    return { status: f.status, detail: f.stopped ? { stopped: 'время вышло' } : {}, state: { pos: { x: Math.floor(f.end.x), y: f.end.y, z: Math.floor(f.end.z) } } }
  } }
  Object.assign(sw, swarmTurnTasks(sw))
  const controller = swarmTurn(sw)
  return Object.assign(f, { actor, sw, enemies, members, goal, ally, start, p, go: () => controller.turn(actor), walks: () => f.calls.filter(c => c.method === 'goto').map(c => c.params) })
}

test('an isolated runner diverts a stationary 68-block rally walk to a teammate in the destination group', async () => {
  const f = scene()
  await f.go(); await f.go(); await f.go()
  assert.deepEqual(f.walks().map(w => [w.x, w.z]), [[68.5, .5], [63.5, 5.5]])
  assert.equal(f.calls.at(-1).method, 'position', 'when both endpoints fail the body seeks a local escape position')
  assert.ok(f.walks()[0].timeoutSeconds >= (68 - 2) / 5.6, 'the quiet route can physically reach the group')
  f.sw.pos.Runner.p = f.p(4.5)
  await f.go()
  assert.equal(f.walks().at(-1).x, 68.5, 'a new approach can reach the original rally point')
})

for (const mode of ['detour', 'interrupted', 'replaced', 'chased']) test('rally walk control: ' + mode, async () => {
  const f = scene()
  if (mode === 'detour') f.end = f.p(-3.5)
  if (mode === 'interrupted') f.status = 'interrupted'
  if (mode === 'replaced') f.onReply = () => { f.actor.last = { m: 'flee', pending: true } }
  if (mode === 'chased') f.enemies.push({ id: 'Champion', position: f.p(18), seenAt: 10000 })
  await f.go(); await f.go()
  const walks = f.walks()
  if (mode === 'chased') {
    assert.ok(walks.every(w => w.arena.avoid?.some(a => a.x === 18)), 'a regroup route cannot head into the observed champion')
    assert.ok(walks.every(w => w.timeoutSeconds <= 5))
  } else assert.deepEqual(walks.map(w => w.x), [68.5, 68.5])
})

test('after the failed centre a native rally walk follows the occupied ledge around the open drop', async () => {
  const f = scene(), clock = testClock(), body = install(clock, { pathfinder: true, digging: true })
  f.goal.x = 12.5; f.sw.pos.Anchor.p = f.p(8.5, 4.5)
  const walkable = p => Math.floor(p.x) === 0 && p.z >= 0 && p.z < 5 || p.x >= 0 && p.x < 10 && Math.floor(p.z) === 4
  body.blockAt = at => { const q = at.floored(); return block(q.y === 119 && walkable(q) ? 'bedrock' : 'air', q) }
  body.entity.position.set(.5, 120, .5); body.entity.onGround = true
  body.entity.metadata = []; body.health = body.food = 20; body.game.dimension = 'overworld'
  const session: any = Object.assign(Object.create(Session.prototype), {
    bot: body, mcData: data, stuckCells: new Map(), surfaceStrict: false, surfaceWalk: false, pathGoalY: null,
    runIntent: async (_, worker) => {
      const ctl = session.ctl = { aborted: false, onAbort: [], abort() {
        if (!this.aborted) { this.aborted = true; for (const fn of this.onAbort) fn() }
      } }
      try { return await worker(ctl) } finally { ctl.abort() }
    }
  })
  session.updateMovements(true)
  try {
    await f.go() // the previous approach timed out without changing its foot cell
    let done = false, arrived, minY = 120
    f.actor.c.call = async (method, params) => {
      assert.equal(method, 'goto'); assert.equal(params.x, 8.5)
      const r = await session.goto(params)
      arrived = r.arrived
      return { status: 'done', detail: r }
    }
    const walking = f.go().finally(() => { done = true })
    for (let i = 0; i < 220 && !done; i++) {
      await clock.advanceGame(50)
      minY = Math.min(minY, body.entity.position.y)
    }
    assert.ok(done && arrived, 'the body actually reached the alternate post')
    await walking
    assert.ok(minY >= 120)
    assert.equal(walkable(body.entity.position), true)
  } finally { session.ctl?.abort(); body.emit('end') }
})
