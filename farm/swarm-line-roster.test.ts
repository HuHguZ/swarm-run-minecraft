import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'
import type { SwarmTask } from '../daemon/src/swarm/types'

function arenaScene(reverse = false) {
  let now = 10000
  const calls: Array<{ name: string; method: string; params: any }> = []
  const fallen = new Set<string>()
  const pos: Record<string, any> = {}
  const team = (side: string) => Array.from({ length: 20 }, (_, i) => {
    const name = side + String(i).padStart(2, '0'), x = i < 7 ? 3 : i < 14 ? 0 : -3
    pos[name] = { p: { x: side === 'red' ? 8 : reverse ? -x : x, y: 64, z: i % 7 - 3 },
      hp: 20, inv: { iron_sword: 1, ...(i % 2 && { bow: 1, arrow: 16 }) }, armor: { torso: 'iron_chestplate' } }
    return { name, team: side, c: { async call(method, params = {}) {
      calls.push({ name, method, params })
      return { status: 'done', detail: {} }
    } } }
  })
  const blue = team('blue'), red = team('red')
  const driver = createSwarmDriver({ bots: [...blue, ...red], pos, alive: id => !fallen.has(id), now: () => now,
    arena: { x: 0, y: 64, z: 0, r: 64 }, home: () => ({ x: 0, y: 64, z: 0 }),
    hostile: (b, id) => b.team === 'blue' && id.startsWith('red'), log: () => {} })
  const observe = () => {
    now += 550
    for (const b of [blue[2], blue[9]]) driver.observe(b, [{ id: red[0].name, visible: true,
      position: { x: reverse ? -8 : 8, y: 64, z: 0 }, equipment: { weapon: 'iron_sword', armor: [] } }], now)
  }
  const tasks = () => new Map<string, SwarmTask>(driver.snapshot().blue.tasks.map(t => [t.assignedTo, t]))
  return { blue, pos, calls, fallen, driver, observe, tasks }
}

test('twenty allies relieve the observed front irrespective of name order and preserve ranks after a casualty', async () => {
  const f = arenaScene()
  f.observe()
  await f.driver.turn(f.blue[3])
  assert.equal(f.tasks().get('blue03')?.data?.doctrine, 'buffalo', 'a healthy front needs no relief')
  for (const b of f.blue.slice(0, 7)) f.pos[b.name].hp = 11
  f.observe()
  f.calls.length = 0
  await f.driver.turn(f.blue[3])
  await f.driver.turn(f.blue[8])
  await f.driver.turn(f.blue[10])
  const tasks = f.tasks()
  assert.equal(tasks.get('blue03')?.data?.doctrine, 'line')
  for (const b of f.blue.slice(0, 7)) {
    const t = tasks.get(b.name)
    assert.equal(t?.kind, 'goto', b.name)
    assert.equal(t?.data?.line, 0)
    assert.equal(t?.data?.rotation, 1)
  }
  assert.ok(f.calls.some(c => c.name === 'blue03' && c.method === 'goto' && c.params.x < f.pos.blue03.p.x))
  assert.equal(tasks.get('blue08')?.kind, 'fight')
  assert.ok(f.calls.some(c => c.name === 'blue08' && c.method === 'goto' && c.params.x > f.pos.blue08.p.x))
  assert.ok(f.calls.some(c => c.name === 'blue10' && c.method === 'goto' && c.params.x > f.pos.blue10.p.x))
  // The next body position report puts the replacement in reach.
  f.pos.blue08.p = { x: 6, y: 64, z: 0 }
  f.fallen.add('blue00')
  f.observe()
  await f.driver.turn(f.blue[8])
  await f.driver.turn(f.blue[3])
  assert.ok(f.calls.some(c => c.name === 'blue08' && c.method === 'fight' && c.params.target === 'red00'))
  assert.equal(f.tasks().get('blue03')?.data?.line, 0, 'surviving old front retains its assignment')
  const fresh = f.tasks().get('blue10')
  assert.equal(fresh?.data?.line, 1)
  assert.equal(fresh?.data?.rotation, 1)
  assert.ok(fresh?.kind === 'fight' || fresh?.kind === 'goto' && fresh.position!.x > f.pos.blue10.p.x,
    'if other allies already engage the target, the fresh fighter holds its front slot')
})

test('injuries behind a healthy front do not rotate it and the next round deploys from its new positions', async () => {
  const f = arenaScene(true)
  for (const b of f.blue.slice(13)) f.pos[b.name].hp = 11
  f.observe()
  await f.driver.turn(f.blue[16])
  assert.notEqual(f.tasks().get('blue16')?.data?.doctrine, 'line')
  for (const [i, b] of f.blue.entries()) f.pos[b.name].hp = i < 7 ? 11 : 20
  f.observe()
  await f.driver.turn(f.blue[3])
  assert.equal(f.tasks().get('blue03')?.data?.line, 0)
  f.driver.reset()
  for (const [i, b] of f.blue.entries()) {
    f.pos[b.name].p.x = i >= 13 ? -3 : i >= 6 ? 0 : 3
    f.pos[b.name].hp = i >= 13 ? 11 : 20
  }
  f.observe()
  await f.driver.turn(f.blue[16])
  assert.equal(f.tasks().get('blue16')?.data?.doctrine, 'line')
  assert.equal(f.tasks().get('blue16')?.data?.line, 0)
  assert.notEqual(f.tasks().get('blue03')?.data?.line, 0)
})
