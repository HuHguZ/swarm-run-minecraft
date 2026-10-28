import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTurn } from './swarm/swarm-driver/turn'

// cl28i (15×15, 28.10): на сближении в начале раунда цель команды менялась z → d → … — 17 походов разом оборваны за секунду
// («goto → goto (цель z→d)» 26 за раунд), хотя новая цель рядом с прежней и путь лежит туда же.
function walk(next: { x: number, z: number }) {
  const calls: string[] = []
  const b: any = { name: 'A', swarmExecuting: true, swarmTask: { kind: 'goto', data: { target: 'Old' } }, last: { m: 'goto', pending: true },
    c: { call(method) { calls.push(method); return Promise.resolve({}) } } }
  const enemies = [{ id: 'Old', position: { x: 40, y: 64, z: 0 }, seenAt: 0 }, { id: 'New', position: { ...next, y: 64 }, seenAt: 10000 }]
  const sw: any = { generation: 1, now: () => 10000, alive: () => true, pos: { A: { p: { x: 0, y: 64, z: 0 } } }, log() {}, detail: r => r?.detail || r,
    refresh: () => ({ task: { kind: 'goto', data: { target: 'New' } }, board: { enemies: () => enemies } }) }
  return { stopped: swarmTurn(sw).preempt(b), calls }
}

test('смена цели в ту же сторону не рвёт поход; в другую — рвёт', () => {
  assert.equal(walk({ x: 42, z: 4 }).stopped, false, 'новая цель в 4.5 бл. от прежней на 42 бл. пути — тот же путь')
  const away = walk({ x: -40, z: 0 })
  assert.equal(away.stopped, true, 'цель за спиной — новый путь')
  assert.ok(away.calls.includes('stop'))
})
