import test from 'node:test'
import assert from 'node:assert/strict'

test('a named human joins red and appears only on the blue watch list without a default human team', async t => {
  const previous = process.env.ARMS_HUMAN_TEAMS
  process.env.ARMS_HUMAN_TEAMS = 'Friend:red'
  t.after(() => {
    if (previous === undefined) delete process.env.ARMS_HUMAN_TEAMS
    else process.env.ARMS_HUMAN_TEAMS = previous
  })
  const { watchHumans } = require('./arena/humans')
  const timers = [], starts = [], foes = {}
  t.mock.method(global, 'setInterval', fn => { timers.push(fn); return {} })
  const bots = ['red', 'blue'].map(team => ({ name: team, team, c: { call: async (_m, p) => { foes[team] = p.foes } } }))
  const ctx: any = { teams: true, arms: true, bots, names: ['red', 'blue'], teamOf: n => n,
    humans: {}, rel: { red: {}, blue: {} }, rcon: async () => 'Players online: Friend, Guest',
    kitHuman: async () => {}, humanStart: async n => { starts.push(n) } }
  watchHumans(ctx)
  await timers[0]()
  assert.deepEqual(starts, ['Friend'])
  assert.deepEqual(foes, { red: ['blue'], blue: ['red', 'Friend'] })
})
