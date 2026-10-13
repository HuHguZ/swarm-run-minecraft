import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { watchHumans } from './arena/humans'

test('arena danger observers include enemy bots and humans while excluding their own team', async t => {
  const teamsByName = { A: 'blue', B: 'blue', C: 'red' }
  const ticks = []
  t.mock.method(globalThis, 'setInterval', fn => { ticks.push(fn); return ticks.length })
  // Настоящий отбор врагов для watch_dangers (слежка за людьми, watchHumans); люди онлайн — из ответа list.
  const select = async (o, names, humanNames, extra = {}) => {
    let foes
    const bot = { ...o, c: { call: async (method, params) => { if (method === 'watch_dangers') foes = params.foes } } }
    const context: any = { i: 31, arms: true, bots: [bot], names, teams: true, teamOf: name => teamsByName[name], HUMAN_TEAM: 'red', rel: {},
      humans: {}, humanNames: [], LOGF: path.join(os.tmpdir(), `swarm-danger-no-log-${process.pid}`), log() {},
      rcon: async () => `There are ${humanNames.length} of a max of 20 players online: ${humanNames.join(', ')}`,
      kitHuman: async () => {}, humanStart: async () => {}, ...extra }
    watchHumans(context)
    await ticks.pop()()
    return Array.from(foes)
  }
  assert.deepEqual(await select({ name: 'A', team: 'blue' }, ['A', 'B', 'C'], ['H']), ['C', 'H'])
  assert.deepEqual(await select({ name: 'C', team: 'red' }, ['A', 'B', 'C'], ['H']), ['A', 'B'])
  assert.deepEqual(await select({ name: 'A', team: 'blue' }, ['A', 'B'], []), [])
  assert.deepEqual(await select({ name: 'A', team: 'blue' }, ['A', 'B'], ['H']), ['H'])
  assert.deepEqual(await select({ name: 'A', team: 'blue' }, ['A', 'B'], ['H'], { teams: false, HUMAN_TEAM: null }), ['B', 'H'])
  assert.deepEqual(await select({ name: 'A', team: 'blue' }, ['A', 'B', 'C'], ['H'], { HUMAN_TEAM: null, rel: { blue: { H: 3 } } }), ['C'])
})
