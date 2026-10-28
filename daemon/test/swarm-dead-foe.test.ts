import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTeam } from '../../farm/swarm/swarm-driver/team'
import { createDriverState } from '../../farm/swarm/swarm-driver/state'

// cl28b (15×15, 28.10): 29ae убил 29z копьём в 12:10:35, а план держал бой с ним до 12:10:41 — доска помнила зрение 8 с.
// Лента смертей в чате — открытое знание: убитого соперника забываем сразу, а не по сроку зрения.
test('убитый соперник уходит с доски по ленте смертей, живой остаётся', () => {
  let now = 10000
  const dead = new Set<string>()
  const bots = [{ name: 'a', team: 'blue' }, { name: 'b', team: 'blue' }, { name: 'x', team: 'red' }, { name: 'y', team: 'red' }]
  const at = (x: number) => ({ p: { x, y: 64, z: 0 }, hp: 20, inv: { iron_sword: 1 }, armor: {} })
  const pos: any = { a: at(0), b: at(1), x: at(6), y: at(8) }
  const sw: any = createDriverState({ bots, pos, alive: (n: string) => !dead.has(n), hostile: (o: any, n: string) => bots.find(q => q.name === n)?.team !== o.team, now: () => now, log() {} })
  Object.assign(sw, swarmTeam(sw))
  const board = sw.boardOf(bots[0])
  sw.refresh(bots[0])
  for (const id of ['x', 'y']) board.observe('a', now, { id, position: pos[id].p, visible: true })
  assert.deepEqual(board.enemies().map((e: any) => e.id).sort(), ['x', 'y'])
  dead.add('x'); now += 600
  sw.refresh(bots[0])
  assert.deepEqual(board.enemies().map((e: any) => e.id), ['y'], 'убитого нет в плане сразу после ленты смертей')
})
