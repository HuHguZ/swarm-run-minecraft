import test from 'node:test'
import assert from 'node:assert/strict'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmTeam } from './swarm/swarm-driver/team'

test('a 20-player roster prices an ascent from one current team sighting summary', t => {
  let time = 10000
  const bots = ['red', 'blue'].flatMap(team => Array.from({ length: 20 }, (_, i) =>
    ({ name: team + i, team, swarmTask: { data: { finishing: false } } })))
  const pos = Object.fromEntries(bots.map((b, i) => [b.name, {
    p: { x: i, y: 64 + i % 2, z: 0 }, hp: 20, food: 20, inv: { iron_sword: 1 } }]))
  const sw = createDriverState({ bots, pos, now: () => time, alive: () => true, aggressive: true,
    hostile: (b, id) => !id.startsWith(b.team), log() {} })
  const team = swarmTeam(sw), board = team.boardOf(bots[0])
  board.setMembers(team.membersOf(bots[0]))
  const enemy = (id, y, visible = true) => ({ id, visible, position: { x: 20, y, z: 0 } })
  assert.ok(board.observe('red1', time, enemy('blue2', 72)))
  const scans = t.mock.method(board, 'enemies')
  const needs = () => team.membersOf(bots[0]).map(m => m.needs.sand)
  assert.deepEqual(needs(), Array.from({ length: 20 }, (_, i) => 14 - i % 2))
  assert.equal(scans.mock.callCount(), 1)
  assert.equal(board.observe('red1', time, enemy('blue2', 95, false)), false)
  assert.ok(board.observe('red0', time, enemy('blue3', 80)))
  assert.equal(needs()[0], 22)
  board.forget('blue3')
  assert.equal(needs()[0], 14)
  time += board.enemyTtlMs - 1
  assert.equal(needs()[0], 14)
  time++
  assert.ok(needs().every(n => n === undefined))
  assert.ok(board.observe('red1', time, enemy('blue2', 88)))
  assert.equal(needs()[0], 30)
  assert.ok(team.membersOf(bots[20]).every(m => m.needs.sand === undefined))
  sw.aggressive = false
  const cautious = swarmTeam(sw)
  bots[1].swarmTask.data.finishing = true
  assert.deepEqual(cautious.membersOf(bots[0]).filter(m => m.needs.sand).map(m => m.id), ['red1'])
})
