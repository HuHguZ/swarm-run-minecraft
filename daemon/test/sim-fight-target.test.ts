import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, stepWorld, stepAction, type ActionRun } from '../src/tactics/sim-world'
import { runSystem } from '../src/tactics/sim-run'

test('sim Fight keeps the native target id when a nearer mob joins the exchange', () => {
  const w = createWorld({ name: 'native-target-id', body: { armor: 20 }, events: [
    { at: 1, type: 'enemy', kind: 'zombie', distance: 2 },
    { at: 2, type: 'enemy', kind: 'spider', distance: .7, angle: 2 }] })
  const run: ActionRun = { id: 'Fight', started: 1, data: {} }
  let ended: Record<string, unknown> | null = null
  for (let i = 0; i < 100 && !ended; i++) { stepWorld(w); ended = stepAction(w, run) }
  assert.ok(ended?.killed)
  assert.ok(w.enemies.find(e => e.kind === 'zombie')!.hp <= 0)
  assert.equal(w.enemies.find(e => e.kind === 'spider')!.hp, 16)
})

test('rough/45: completing each native target survives the previously retargeted exchange', async () => {
  const result = await runSystem({ name: 'native-target-rough45', seed: 45, ticks: 600,
    body: { armor: 0, hp: 14 }, world: { physics: .5 }, events: [
      { at: 10, type: 'enemy', kind: 'zombie', distance: 4.7, angle: 4.8 },
      { at: 35, type: 'enemy', kind: 'spider', distance: 4.2, angle: 2.8 }] })
  assert.equal(result.died, null)
  assert.deepEqual(result.violations, [])
})
