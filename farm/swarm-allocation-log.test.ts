import test from 'node:test'
import assert from 'node:assert/strict'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmTeam } from './swarm/swarm-driver/team'

test('allocation log reports changed roles and targets without delaying plans or repeating unchanged allocation', () => {
  let now = 1000
  const logs: string[] = [], bots = Array.from({ length: 8 }, (_, k) => ({ name: 'B' + k, team: 'blue' }))
  const pos = Object.fromEntries(bots.map(b => [b.name, { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} }]))
  const sw = createDriverState({ bots, pos, alive: () => true, now: () => now, log: text => logs.push(text) })
  Object.assign(sw, swarmTeam(sw))
  const tasks = new Map<string, any>([
    ['B0', { kind: 'fight', data: { target: 'E', role: 'fighter' } }],
    ['B1', { kind: 'fight', data: { target: 'E', shove: true } }],
    ['B2', { kind: 'goto', data: { target: 'E', dig: '1,63,1', undermine: true } }],
    ['B3', { kind: 'loot', data: {} }],
    ['B4', { kind: 'flee', data: { target: 'E', hide: true, rearm: true } }],
    ['B5', { kind: 'flee', data: { target: 'E', perch: true, rearm: true } }],
    ['B6', { kind: 'goto', data: { camp: '2,64,2' } }],
    ['B7', { kind: 'goto', data: { target: 'E', rearm: true } }]
  ])
  sw.planned.set('blue', tasks)
  const refresh = () => { sw.plannedAt.set('blue', now); return sw.refresh(bots[0]) }
  const trace = process.env.ND_SWARM_TRACE
  delete process.env.ND_SWARM_TRACE
  try {
    refresh()
    assert.equal(logs.length, 1, 'ordinary arena log requires no trace flag')
    assert.match(logs[0], /бой 1, сброс\/подкоп 2, лут\/укрытие 5/)
    assert.match(logs[0], /E/)
    tasks.set('B0', { kind: 'fight', data: { target: 'F', role: 'fighter' } })
    now += 500
    assert.equal(refresh().task.data.target, 'F', 'new plan remains available during log throttle')
    assert.equal(logs.length, 1)
    now = 4000
    refresh()
    assert.equal(logs.length, 2, 'deferred target change is not lost')
    assert.match(logs[1], /F/)
    now += 3000
    refresh()
    assert.equal(logs.length, 2, 'unchanged allocation is not repeated')
    tasks.get('B0').data.role = 'ranged'
    refresh()
    assert.equal(logs.length, 3, 'role-only redistribution is logged')
    tasks.delete('B0')
    now += 3000
    refresh()
    assert.equal(logs.length, 4, 'changed count is logged')
    assert.match(logs[3], /бой 0, сброс\/подкоп 2, лут\/укрытие 5/)
  } finally {
    if (trace === undefined) delete process.env.ND_SWARM_TRACE
    else process.env.ND_SWARM_TRACE = trace
  }
})
