import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../daemon/src/swarm'
import type { SharedEnemy } from '../daemon/src/swarm/types'
import { nearbyOutpost, repeatedTrail } from './swarm/swarm-driver/trail'

test('a builder defers only a repeated, freshly corroborated trail in the same cell and round', () => {
  const bot = { name: 'Miner' }, pos = { x: .3, y: 143, z: 1.2 }
  for (const [change, expected] of [['same cell',true],['new cell',false],['own eyes',false],['new foe',false],
    ['old report',false],['expired previous',false],['new round',false],['lost sight',false],['nametag',false]] as const) {
    const reports = new WeakMap(), first: SharedEnemy = { id: 'R0', position: pos, seenAt: 200, source: 'Scout', sources: ['Scout'] }
    assert.equal(repeatedTrail(reports, bot, first, 1, 200, 3000), false)
    if (change === 'lost sight') repeatedTrail(reports, bot, undefined, 1, 280, 3000)
    const seen = { ...first, id: change === 'new foe' ? 'R1' : first.id, position: { ...pos, x: change === 'new cell' ? 1.1 : .8 },
      seenAt: change === 'old report' ? 200 : change === 'expired previous' ? 3300 : 400,
      source: change === 'own eyes' ? bot.name : first.source, nametag: change === 'nametag' }
    assert.equal(repeatedTrail(reports, bot, seen, change === 'new round' ? 2 : 1, seen.seenAt, 3000), expected, change)
  }
})

test('a marker can proceed when nearby outpost work is unavailable, already finished, or expires', () => {
  let now = 1000
  const board = new SwarmBoard('blue', () => now), p = { x: 5, y: 120, z: 3 }, room = { kind: 'outpost', origin: p }, id = 'room'
  const projects = new Map([['blue:room', room]]), marker = 'beacon:15,120,0'
  const nearby = () => nearbyOutpost(board,projects,p,marker)
  board.setMembers([{ id: 'Miner', team: 'blue', role: 'miner-builder', position: p, health: 20, strength: 1 }])
  const task = { kind: 'build' as const, id: 'wall', position: p, data: { blueprint: id, block: 'stone' } }
  board.upsert({ ...task, position: { ...p, x: 40 } }); assert.equal(nearby(), undefined)
  board.upsert({ ...task, data: { ...task.data, obstruction: { self: true } } }); assert.equal(nearby(), undefined)
  board.upsert({ ...task, dependsOn: ['floor'] }); assert.equal(nearby(), undefined)
  board.upsert({ ...task, dependsOn: [], expiresAt: now + 100 })
  assert.deepEqual(nearby(), { ...room, id })
  const claim = board.claim(task.id,'Miner')
  assert.equal(nearby(), undefined)
  board.release(task.id,'Miner',claim.claim.token)
  const base = { ...task, id: 'base', data: { ...task.data, blueprint: marker } }
  board.upsert(base)
  const signal = board.claim(base.id,'Miner')
  assert.equal(nearby(), undefined, 'preserve a signal while its builder is working')
  board.ack(base.id,'Miner',{ token: signal.claim.token, confirmed: true, block: 'stone', position: p })
  assert.equal(nearby(), undefined, 'finish the marker cap once the base exists')
  board.cancel(base.id)
  now += 101
  assert.equal(nearby(), undefined)
  board.upsert(task)
  projects.clear()
  assert.equal(nearby(), undefined, 'a disposed project is not a useful alternative')
  projects.set('blue:room', room)
  const complete = board.claim(task.id,'Miner')
  board.ack(task.id,'Miner',{ token: complete.claim.token, confirmed: true, block: 'stone', position: p })
  assert.equal(nearby(), undefined)
})
