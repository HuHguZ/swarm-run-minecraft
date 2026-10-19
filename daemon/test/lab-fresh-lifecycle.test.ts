import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { createRequire } from 'node:module'
import { GameClock, wall } from '../src/game-clock'

test('fresh campaign observer records a stopped campaign even after its game clock freezes', async () => {
  const file = require.resolve('../scenes/ow/try-lab-fresh')
  const local = createRequire(file)
  const clock = new GameClock({ manual: true, epoch: 0 })
  const rows: any[] = []
  const connects: boolean[] = []
  const child = { on: (_name, fn) => setImmediate(() => fn(0)), kill() {} }
  const kit = { randomReset: async () => {}, cmd: async () => {}, setDifficulty: async () => {}, gamerule: async () => {} }
  const mocks: any = {
    '../../src/game-clock': { now: () => clock.now(), wall: { ...wall, sleep: ms => wall.sleep(ms === 10000 ? 1 : ms) } },
    '../lib/farm-bootstrap': { farmBootstrap: async rpc => rpc('connect', { bootstrapPaused: true }) },
    '../lib/scene-kit': { connect: () => ({ ready: Promise.resolve(), heard: [], call: async (method, params: any = {}) => {
      if (method === 'connect') connects.push(params.bootstrapPaused)
      return { state: {} }
    } }),
      createKit: () => kit, sleep: ms => ms === 1000 ? Promise.resolve() : clock.sleep(ms),
      classify: () => 'blocked', campaignFacts: () => ({ miles: {}, codes: [] }) },
    child_process: { spawn: () => child },
    fs: { statSync: () => ({ size: 0 }), writeFileSync() {}, readFileSync: () => '',
      appendFileSync: (_file, row) => rows.push(JSON.parse(row)) }
  }
  const context: any = { require: name => mocks[name] || local(name), __dirname: path.dirname(file),
    process: { env: { UNTIL: 'dragon', KEEP_INV: 'false', ND_MAP: '0' }, exit: () => {} },
    console: { log() {}, error: error => { throw error } }, setImmediate }
  vm.runInNewContext(fs.readFileSync(file, 'utf8').replace(/main\(\)\.catch\([\s\S]*$/, ''), cjsContext(context), { filename: file })
  let timer
  try {
    await Promise.race([context.main(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('observer hung on a stopped game clock')), 1000) })])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].ok, false)
    assert.equal(rows[0].stoppedBy, 'кампания вышла (0)')
    assert.equal(rows[0].deathCount, 0)
    assert.deepEqual(connects, [true, false], 'farm readiness stays paused until the scene hands off to the campaign')
    assert.equal(clock.now(), 0, 'lifecycle handling does not invent game ticks')
  } finally { clearTimeout(timer); clock.dispose() }
})
