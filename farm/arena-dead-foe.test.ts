import test from 'node:test'
import assert from 'node:assert/strict'
import { installSight } from './arena/watch'
import { watchHumans } from './arena/humans'
import { swarmWind } from './swarm/swarm-driver/wind'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmTeam } from './swarm/swarm-driver/team'

// Capture the real arena callback, then use the real sentry/move path with an in-memory transport.
function fixture(kind: string) {
  const calls: any[] = [], names = ['helper', 'friend', 'dead', 'living']
  const helper: any = { name: 'helper', team: 'red', swarmTask: { kind: 'fight', data: { target: 'living', finishing: true } }, last: { m: 'goto', pending: true },
    c: { call: async (method, params) => { calls.push({ method, params }); return { status: 'done' } } } }
  const bots: any[] = [helper, { name: 'friend', team: 'red' }, { name: 'dead', team: 'blue' }, { name: 'living', team: 'blue' }]
  for (const b of bots) b.c ||= { call: async () => assert.fail('unexpected other-actor transport') }
  const pos = { helper: { p: { x: 620.5, y: 128, z: 600.5 }, hp: 20, inv: { mace: 1, wind_charge: 8 } },
    dead: { p: { x: 600.5, y: 128, z: 600.5 }, hp: kind === 'hpZero' ? 0 : 20 } }
  const ctx: any = { i: 31, arms: false, bots, names, pos, humans: {}, X: 600, Y: 128, Z: 600, R: 80, L: null, teams: true,
    out: new Set(kind === 'out' ? ['dead'] : []), deadNow: new Set(kind === 'deadNow' ? ['dead'] : []),
    rel: { red: { humanFoe: -20, humanFriend: 20, humanGone: -20 } }, humanOut: new Set(['humanGone']),
    teamOf: n => bots.find(b => b.name === n)?.team, rcon: () => assert.fail('no runtime request permitted'), log: () => {}, alive: n => n === 'helper' }
  const interval = global.setInterval
  global.setInterval = (() => ({ unref() {} })) as any
  try { watchHumans(ctx) } finally { global.setInterval = interval }
  const driver: any = require('./swarm/swarm-driver'), create = driver.createSwarmDriver
  let options: any
  driver.createSwarmDriver = o => { options = o; return { enemies: () => [] } }
  try { installSight(ctx) } finally { driver.createSwarmDriver = create }
  const sw: any = { ...options, generation: 1, now: () => 10000, teamOf: b => b.team, panic: () => false,
    boards: new Map(), cooldown: new Map(), plannedAt: new Map(), boxed: new Set(), boxTries: new Map(), blueprints: new Map(), placed: new Map(), boardOf: () => ({ enemies: () => [] }) }
  Object.assign(sw, swarmMoves(sw))
  return { ctx, options, helper, calls, sentries: swarmWind(sw).sentries }
}

const cases: [string, string, boolean][] = [
  ['deadNow', 'dead', false], ['out', 'dead', false], ['living', 'living', true],
  ['hpZero', 'dead', true], ['friend', 'friend', false], ['self', 'helper', false],
  ['humanFoe', 'humanFoe', true], ['humanFriend', 'humanFriend', false], ['humanGone', 'humanGone', false]
]
for (const [kind, target, expected] of cases) test(`arena sentry hostility preserves ${kind}`, async () => {
  const f = fixture(kind), hostile = name => f.options.hostile(f.helper, name)
  if (kind === 'deadNow') {
    // One captured callback reads current public round state, including reset; no HP signal is used.
    f.ctx.deadNow.clear(); assert.equal(hostile('dead'), true)
    f.ctx.deadNow.add('dead'); assert.equal(hostile('dead'), false)
    f.ctx.deadNow.clear(); f.ctx.out.add('dead'); assert.equal(hostile('dead'), false)
    f.ctx.out.clear(); assert.equal(hostile('dead'), true)
    f.ctx.deadNow.add('dead')
  }
  assert.equal(hostile(target), expected)
  f.sentries(f.helper, [{ id: target, visible: true, position: { x: 600.5, y: 128, z: 600.5 } }])
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.calls.length, expected ? 1 : 0)
  if (expected) {
    assert.equal(f.calls[0].method, 'goto')
    assert.equal(f.calls[0].params._hunt, true)
  }
})

function publicRosterPlan(f: ReturnType<typeof fixture>, withRoster = true) {
  f.ctx.deadNow.add('dead'); f.ctx.out.add('living')
  f.ctx.deathAt = {}
  f.options.pos.helper.inv = { iron_sword: 1, cooked_beef: 16 }
  const allies = Array.from({ length: 6 }, (_, i) => ({ name: `ally${i}`, team: 'red', c: f.helper.c }))
  f.options.bots.push(...allies); f.ctx.names.push(...allies.map(a => a.name))
  for (const ally of allies) f.options.pos[ally.name] = { ...f.options.pos.helper, p: { x: 620.5, y: 128, z: 600.5 } }
  f.options.alive = name => name === 'helper' || allies.some(a => a.name === name)
  if (!withRoster) delete f.options.humanNames
  const sw = createDriverState(f.options)
  Object.assign(sw, swarmTeam(sw))
  const board = sw.boardOf(f.helper)
  board.setMembers(sw.membersOf(f.helper))
  assert.equal(board.observe('helper', sw.now(), { id: 'humanFoe', visible: true,
    position: { x: 623.5, y: 128, z: 600.5 }, equipment: { weapon: 'iron_sword' } }), true)
  return sw.refresh(f.helper).task
}

test('armed fighter engages a visible human in reach without enemy health or a fake finishing phase', () => {
  const f = fixture('living')
  f.ctx.humanNames = ['humanFoe', 'humanFoe', 'humanFoe', 'humanFoe', 'humanFriend', 'humanGone', 'helper', 'dead']
  f.ctx.humans.humanFoe = Object.defineProperty({}, 'hp', { get() { assert.fail('enemy health is not public roster data') } })
  const task = publicRosterPlan(f)
  assert.equal(task.kind, 'fight', JSON.stringify(task))
  assert.equal(task.data.target, 'humanFoe')
  assert.notEqual(task.data.finishing, true)
})

test('arena public roster callback follows replaced player lists', () => {
  const f = fixture('living')
  f.ctx.humanNames = ['humanFoe']
  assert.deepEqual(f.options.humanNames(), ['humanFoe'])
  f.ctx.humanNames = ['nextHuman']
  assert.deepEqual(f.options.humanNames(), ['nextHuman'])
})

test('unknown external human roster keeps the existing planner policy', () => {
  const f = fixture('living')
  f.ctx.humanNames = ['humanFoe']
  assert.notEqual(publicRosterPlan(f, false).data.finishing, true)
})

test('friendly or publicly eliminated humans do not create a remaining enemy count', () => {
  const f = fixture('living')
  f.ctx.humanNames = ['humanFriend', 'humanGone', 'helper', 'dead']
  assert.notEqual(publicRosterPlan(f).data.finishing, true)
})
