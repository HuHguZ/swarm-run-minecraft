import assert from 'node:assert/strict'
import test from 'node:test'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'

function scene() {
  const self = { x: 0, y: 64, z: 0 }, foe = { id: 'Foe', position: { x: 15, y: 64, z: 0 }, seenAt: 1000 }
  const walk = { kind: 'goto', position: { x: 17.5, y: 64, z: 0 }, data: { target: foe.id } }
  const push = { kind: 'fight', data: { target: foe.id, shove: true, shoveAt: { x: 10, y: 64, z: 0 } } }
  const owner = { cancelled: false }, me = { p: self, inv: { iron_sword: 1 }, watchRound: 8 }
  const b: any = { name: 'A', swarmExecuting: true, swarmTurnOwner: owner, last: null }
  let task: any = walk, finish: (r: any) => void
  const calls: any[] = []
  b.c = { call(method, p) {
    calls.push({ method, p })
    if (method !== 'goto') return Promise.resolve({})
    b.last = { m: method, p, pending: true, walkOwner: owner, round: me.watchRound }
    return new Promise(resolve => { finish = resolve })
  } }
  const foes = [foe], board = { enemies: () => foes }, context = { board, members: [] }
  const sw: any = { generation: 1, now: () => 1000, alive: () => true, pos: { A: me }, detail: r => r?.detail ?? {},
    arena: { x: 0, z: 0, r: 80 }, boardOf: () => board, log() {}, refresh: () => ({ ...context, task }) }
  Object.assign(sw, swarmMoves(sw))
  const work = swarmTurnWork(sw), { preempt } = swarmTurn(sw)
  const start = (shove: boolean) => {
    task = b.swarmTask = shove ? push : walk
    const tc: any = { b, context, board, round: 1, task, m: me, foes, foe, enemies: foes }
    return shove ? work.turnFight(tc) : work.turnGoto(tc)
  }
  const propose = next => { task = next; return preempt(b) }
  return { b, walk, push, calls, start, propose, foes, self, foe, me, finish: () => finish({ status: 'done', detail: {} }) }
}

for (const shove of [false, true]) test(`the same pending approach survives six goto/shove changes starting with ${shove ? 'fight' : 'goto'}`, async () => {
  const f = scene(), pending = f.start(shove)
  for (let i = 0; i < 6; i++) assert.equal(f.propose((i % 2 === 0) !== shove ? f.push : f.walk), false)
  assert.deepEqual(f.calls.map(c => c.method), ['goto'])
  assert.deepEqual([f.calls[0].p.x, f.calls[0].p.y, f.calls[0].p.z], [17.5, 64, 0])
  f.finish(); await pending
})

for (const reason of ['contact', 'other attacker', 'different target', 'moved target', 'changed edge', 'new pit', 'round', 'other owner', 'other walk', 'search']) {
  test('an identical-looking shove approach still yields for ' + reason, async () => {
    const f = scene(), pending = f.start(false), next: any = structuredClone(f.push)
    if (reason === 'contact') f.self.x = 14
    if (reason === 'other attacker') f.foes.push({ ...f.foe, id: 'Second', position: { x: 2, y: 64, z: 0 } })
    if (reason === 'different target') next.data.target = 'Second'
    if (reason === 'moved target') f.foe.position.z += 1
    if (reason === 'changed edge') next.data.shoveAt.z += 1
    if (reason === 'new pit') next.data.digAvoid = [{ x: 5, y: 63, z: 0 }]
    if (reason === 'round') f.me.watchRound++
    if (reason === 'other owner') f.b.swarmTurnOwner = { cancelled: false }
    if (reason === 'other walk') f.b.last = { ...f.b.last, approachRound: undefined }
    if (reason === 'search') f.walk.data['search'] = true
    assert.equal(f.propose(next), true)
    assert.deepEqual(f.calls.map(c => c.method), ['goto', 'stop'])
    f.finish(); await pending
  })
}
