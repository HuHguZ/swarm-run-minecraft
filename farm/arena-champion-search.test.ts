import test from 'node:test'
import assert from 'node:assert/strict'
import { champTurn } from './arena/champion'
import { arenaBounds } from './arena/context'
import { createSwarmDriver } from './swarm/swarm-driver'
import { swarmPosition } from './swarm/swarm-driver/position'

function fixture() {
  const calls: any[] = [], start = { x: .5, y: 65, z: .5 }
  let gotoReply: ((p) => Promise<any>) | undefined
  const b = { name: 'Champion', team: 'red', c: { async call(method, params) {
    calls.push({ method, params })
    if (method === 'goto' && gotoReply) return gotoReply(params)
    return { status: 'done', detail: method === 'goto' ? { arrived: { x: params.x, y: params.y, z: params.z } } : {} }
  } } }
  const frame: any = { p: { ...start }, hp: 20, inv: { diamond_sword: 1 } }
  const ctx: any = { pos: { Champion: frame }, X: 0, Y: 65, Z: 0, R: 48, L: { y0: 0, ellipse: { a: 43, b: 35 } }, arms: true,
    round: 1, between: false, deadNow: new Set(), out: new Set(), humanOut: new Set(), log() {},
    armsHome: () => start, hostile: (_b, id) => id !== 'Friend', alive: n => n === b.name }
  ctx.swarmDriver = createSwarmDriver({ bots: [b], pos: ctx.pos, alive: ctx.alive, log: ctx.log, hostile: ctx.hostile,
    arena: arenaBounds(ctx), home: () => start, teams: true })
  const sight = (id, dx, cue?: string) => ({ id, position: { ...start, x: start.x + dx }, visible: !cue, ...(cue && { [cue]: true }) })
  const observe = (reports, at = Date.now()) => ctx.swarmDriver.observe(b, reports, at)
  return { b, ctx, frame, calls, start, sight, observe, turn: () => champTurn(ctx, b),
    onGoto: (reply: (p) => Promise<any>) => { gotoReply = reply } }
}

test('champion fights personally visible players without reading their controller bodies', async () => {
  const f = fixture()
  f.observe([f.sight('Human', 6), f.sight('Bot', 9), f.sight('Tagged', 2, 'nametag'), f.sight('Outline', 1, 'glowing'),
    f.sight('Dead', 2), f.sight('Out', 3), f.sight('Spectator', 1), f.sight('Friend', 2)])
  f.ctx.out.add('Out'); f.ctx.deadNow.add('Dead'); f.ctx.humanOut.add('Spectator')
  f.ctx.alive = () => assert.fail('enemy health is not public')
  await f.turn()
  const fight = f.calls.find(c => c.method === 'fight')
  assert.equal(fight?.params.target, 'Human')
  assert.deepEqual(fight.params.targets, ['Human', 'Bot'])
  assert.deepEqual(fight.params.arena, arenaBounds(f.ctx))
})

test('after an empty sight poll the champion searches a remembered position then explores new ground', async () => {
  const f = fixture()
  const at = Date.now()
  f.observe([f.sight('Human', 16)], at - 100)
  f.observe([], at)
  await f.turn()
  const clue = f.calls.at(-1)
  assert.equal(clue.method, 'goto', 'a missing body is no longer a direct target')
  assert.equal(clue.params.x, f.start.x + 16)
  f.frame.p = { x: clue.params.x, y: clue.params.y, z: clue.params.z }
  await f.turn()
  const sector = f.calls.at(-1)
  assert.equal(sector.method, 'goto')
  assert.ok(Math.hypot(sector.params.x - f.frame.p.x, sector.params.z - f.frame.p.z) >= 5)
  f.frame.p = { x: sector.params.x, y: sector.params.y, z: sector.params.z }
  await f.turn()
  assert.notDeepEqual(f.calls.at(-1).params, clue.params)
  f.observe([f.sight('Human', 16)])
  await f.turn()
  assert.equal(f.calls.at(-1).method, 'fight')
})

test('champion at the empty enemy spawn uses the normal scout path immediately', async () => {
  const f = fixture()
  await f.turn()
  const next = f.calls.at(-1)
  assert.equal(next.method, 'goto')
  assert.ok(Math.hypot(next.params.x - f.start.x, next.params.z - f.start.z) >= 5)
  assert.deepEqual(next.params.arena.ellipse, f.ctx.L.ellipse)
})

test('a scout on the rim searches inward unless its team has confirmed the outer platform', async () => {
  const f = fixture()
  f.frame.p = { ...f.start, x: 41 }
  await f.turn()
  assert.ok(f.calls.at(-1).params.x < 43.5, 'a blind sector outside the rim is over the void')
  const arena = arenaBounds(f.ctx), platform = { x: 45, y: 64, z: 0 }
  let selected
  const sw: any = { now: Date.now, generation: 0, alive: () => true, teamOf: b => b.team, pos: f.ctx.pos, arena,
    visited: new Map(), placed: new Map([['red', new Map([['45,64,0', platform]])]]), telemetry: { searches: 0 },
    go: async (_b, at) => { selected = at; return { status: 'done', detail: { arrived: at } } }, detail: r => r.detail }
  await swarmPosition(sw).search(f.b, { members: [{ id: f.b.name }] })
  assert.equal(selected.x, 45.5, 'the confirmed team-built floor beyond the rim remains a search option')
})

test('a blocked trail gets a different approach, while an unstarted walk and a late old-round receipt leave the clue open', async () => {
  const f = fixture()
  f.observe([f.sight('Tagged', 16, 'nametag')])
  f.onGoto(async () => ({ status: 'failed', code: 'DEFENSE_BUSY', notStarted: true }))
  await f.turn()
  let finish: (reply) => void
  f.onGoto(() => new Promise(resolve => { finish = resolve }))
  const walk = f.turn()
  assert.equal(f.calls.at(-1).params.x, 16.5)
  f.ctx.round++
  f.ctx.swarmDriver.reset()
  finish({ status: 'done', detail: { arrived: { ...f.start, x: 16.5 } } })
  await walk
  f.observe([f.sight('Tagged', 16, 'nametag')])
  f.onGoto(async () => ({ status: 'failed', code: 'NO_PATH' }))
  await f.turn()
  assert.equal(f.calls.at(-1).params.x, 16.5)
  await f.turn()
  assert.notEqual(f.calls.at(-1).params.x, 16.5, 'an unchanged physical failure sends the scout to another sector')
  f.frame.p = { ...f.start, z: 6.5 }
  await f.turn()
  assert.equal(f.calls.at(-1).params.x, 16.5, 'the target can be approached again from the new footing')
})
