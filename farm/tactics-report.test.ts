import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import childProcess from 'node:child_process'

test('tactics report keeps farm rows (mcPort), orders episode chains and lists deaths with the chosen-state snapshot', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-tactics-')), 'skills.jsonl')
  const at = new Date().toISOString()
  const rows = [
    { level: 'tactical', at, mcPort: 25630, skill: 'BlockOff', threat: 2, result: 'preempted', detail: { by: 'Flee' }, sec: 1, hp0: 20, hp: 12 },
    { level: 'tactical', at, mcPort: 25630, skill: 'Flee', threat: 3, result: 'died', outcome: 'died', sec: 1, hp0: 12, hp: 0 },
    { level: 'tactical_episode', at, mcPort: 25630, threat: 3, actions: ['BlockOff', 'Flee'], chain: ['BlockOff', 'Flee', 'BlockOff'], result: 'died',
      sec: 2, hp0: 20, hp: 0, state: { hp: 20, enemies: [{ kind: 'piglin_brute', d: 4.4, hit: 8.6 }] } },
    { level: 'tactical', at, skill: 'Shield', threat: 1, result: 'completed', sec: 1, hp0: 20, hp: 20 }
  ]
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const out = JSON.parse(childProcess.execFileSync(process.execPath, [path.join(__dirname, 'tactics-report.js'), '--file', file, '--json'], { encoding: 'utf8' }))
  assert.equal(out.rows, 3, 'a row without mcPort (unit test) is left out')
  assert.deepEqual(out.episodes.chains, [['BlockOff>Flee>BlockOff ✝', 1]])
  assert.deepEqual(out.actions.find((action: any) => action.skill === 'BlockOff').preemptedBy, [['Flee', 1]])
  assert.equal(out.deaths[0].state.enemies[0].kind, 'piglin_brute')
  assert.deepEqual(out.actions.find((action: any) => action.skill === 'Flee').outcomes, [['died', 1]])
  const everything = JSON.parse(childProcess.execFileSync(process.execPath, [path.join(__dirname, 'tactics-report.js'), '--file', file, '--json', '--all'], { encoding: 'utf8' }))
  assert.equal(everything.rows, 4)
})
