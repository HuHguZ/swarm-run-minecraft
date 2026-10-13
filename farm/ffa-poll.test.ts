import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { watchStatus, installSight } from './arena/watch'
import { installRounds } from './arena/rounds'
const turn = () => new Promise(resolve => setImmediate(resolve))
// Ручки окружения, меняющие опрос и конец раунда: тест — на умолчаниях.
delete process.env.FFA_POLL_MS; delete process.env.ARMS_MOBS; delete process.env.ARMS_PHASES

function fixture(t) {
  let now = 50000, fastFrame = 20, fastX = 5
  const intervals = [], slowWaiters = [], calls = [], observations = []
  const reply = (name, x, frame = 20) => ({ state: { pos: { x, y: 64, z: 0 }, health: 20, inventory: {},
    physicsTicks: frame, clock: { id: name, ticks: frame } }, detail: {} })
  const peer = name => ({ name, c: { call(method) {
    calls.push({ name, method })
    if (method !== 'status') return Promise.resolve({})
    return name === 'fast' ? Promise.resolve(reply(name, fastX, fastFrame)) : new Promise(resolve => slowWaiters.push(resolve))
  } } })
  const bots: any[] = [peer('fast'), peer('slow')]
  const context: any = { bots, pos: {
    fast: { p: { x: 0, y: 64, z: 0 }, hp: 20, tick: 10, inv: {}, clockId: 'fast', frame: 10, observedAt: 10000, frameAt: 10000 },
    slow: { p: { x: 0, y: 64, z: 0 }, hp: 20, tick: 10, inv: {}, clockId: 'slow', frame: 10, observedAt: 10000, frameAt: 10000 }
  }, between: false, round: 1, stop: false,
    busy: new Set(), alive: () => true, enemiesOf: () => [],
    Y: 64, humans: {}, readDeaths() {}, STOPF: path.join(os.tmpdir(), `ffa-poll-no-stop-${process.pid}`),
    arms: false, teams: false, names: ['fast', 'slow'], labNeed: {}, deathAt: {}, log() {},
    swarmDriver: { observe: (b, data) => observations.push({ name: b.name, data }), panic: () => false }
  }
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { intervals.push({ fn, ms }); return intervals.length })
  watchStatus(context)
  const poll = () => intervals.find(i => i.ms === 250).fn()
  const watchdog = () => intervals.find(i => i.ms === 2000).fn()
  const release = () => { for (const resolve of slowWaiters.splice(0)) resolve(reply('slow', 77)) }
  t.after(async () => { context.between = true; release(); await turn(); await turn() })
  return { bots, context, calls, observations, reply, poll, watchdog, release,
    advance: ms => { now += ms }, fast: (x, frame) => { fastX = x; fastFrame = frame } }
}

test('one slow status never blocks another body update or its next independent status cycle', async t => {
  const f = fixture(t)
  f.poll(); await turn()
  assert.equal(f.context.pos.fast.p.x, 5, 'apply the completed own snapshot before the slow body responds')
  f.fast(12, 21); f.poll(); await turn()
  assert.equal(f.context.pos.fast.p.x, 12)
  assert.equal(f.calls.filter(c => c.name === 'fast' && c.method === 'status').length, 2)
  assert.equal(f.calls.filter(c => c.name === 'slow' && c.method === 'status').length, 1, 'only the slow peer keeps one request in flight')
})

test('a late status from the previous round cannot overwrite the reset pose or share old sightings', async t => {
  const f = fixture(t)
  f.poll(); await turn()
  f.context.between = true; f.context.round++
  f.context.pos.slow = { ...f.context.pos.slow, p: { x: 200, y: 64, z: 0 } }
  f.context.between = false; f.release(); await turn(); await turn()
  assert.equal(f.context.pos.slow.p.x, 200)
  assert.equal(f.observations.filter(o => o.name === 'slow').length, 0)
})

test('the watchdog never resets an old observation or fresh replies whose own physics frame has stopped', t => {
  const f = fixture(t), b = f.bots[0]
  b.last = { m: 'goto', at: 0, p: { x: 8, y: 64, z: 0, timeoutSeconds: 4 } }
  b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.name === 'fast' && c.method === 'stop').length, 0)
  f.context.pos.fast.observedAt = 50000
  b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.name === 'fast' && c.method === 'stop').length, 0, 'network replies alone do not prove simulation progress')
})

test('the watchdog still resets a stationary route observed on fresh, advancing own frames', t => {
  const f = fixture(t), b = f.bots[0]
  f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = 50000
  b.last = { m: 'goto', at: 0, p: { x: 8, y: 64, z: 0, timeoutSeconds: 4 } }
  b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.name === 'fast' && c.method === 'stop').length, 1)
})

for (const [method, params] of [
  ['flee', { from: ['Foe'], timeoutSeconds: 3 }],
  ['evade', { dir: { x: 1, z: 0 }, ticks: 26 }],
  ['juke', { from: 'Foe', maxTicks: 80 }]
] as const) test(`a fresh ${method} does not inherit an old frozen anchor, and its expired stationary escape still resets`, t => {
  const f = fixture(t), b = f.bots[0]
  f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = 50000
  b.last = { m: method, at: 50000, p: params }
  b.anchor = { p: { ...f.context.pos.fast.p }, at: 43000 }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.name === 'fast' && c.method === 'stop').length, 0, 'give the newly issued escape time for its first displacement')
  b.last.at = 45000
  f.watchdog()
  assert.equal(f.calls.filter(c => c.name === 'fast' && c.method === 'stop').length, 1, 'the startup grace cannot hide an escape that stays stuck')
})

test('escape startup grace respects timeoutSeconds plus two and never lasts beyond five seconds', t => {
  const f = fixture(t), b = f.bots[0]
  f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = 50000
  b.anchor = { p: { ...f.context.pos.fast.p }, at: 43000 }
  b.last = { m: 'flee', at: 47000, p: { timeoutSeconds: 1 } }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.name === 'fast' && c.method === 'stop').length, 1, 'a one-second RPC gets only its existing two-second startup margin')
  b.anchor = { p: { ...f.context.pos.fast.p }, at: 43000 }
  b.last = { m: 'flee', at: 45000, p: { timeoutSeconds: 60 } }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.name === 'fast' && c.method === 'stop').length, 2, 'even a long RPC gets no more than five seconds of startup protection')
})

test('owned round reset parks bodies before the clone and teleports before restoring survival without changing humans', async () => {
  const events: string[] = [], state = { ownRed: { mode: 'survival', safe: false }, ownBlue: { mode: 'survival', safe: false } }
  const bots = Object.keys(state).map((name, k) => ({ name, team: k ? 'blue' : 'red', c: { call: async method => events.push(`${method} ${name}`) } }))
  const context: any = { arms: true, between: false, round: 1, roundWins: { red: 0, blue: 0 }, bots,
    names: Object.keys(state), kills: {}, out: new Set(), deadNow: new Set(), HUMAN_TEAM: null, humanDown: false,
    log() {}, sleep: async () => {}, i: 31, BOX: 'fixture',
    rcon: async (_slot, command) => {
      events.push(command)
      for (const name of Object.keys(state)) {
        if (command === `gamemode spectator ${name}`) state[name].mode = 'spectator'
        if (command.startsWith(`tp ${name} `)) state[name].safe = false
        if (command === `gamemode survival ${name}`) {
          assert.equal(state[name].safe, true, 'the guessed armsHome teleport remains obstructed until actual safe placement')
          assert(events.includes('death barrier'), 'old deaths are drained before collidable bodies return')
          state[name].mode = 'survival'
        }
      }
      return 'Showing'
    },
    restoreArena: async () => {
      events.push('clone')
      for (const own of Object.values(state)) assert.equal(own.mode, 'spectator', 'a clone must not suffocate an owned body left at its last combat position')
    },
    stockChests: async () => {},
    swarmDriver: { reset() {} }, armsHome: () => ({ x: 1, y: 64, z: 1 }),
    deathAt: {}, radio: {}, opened: new Set(), chestBy: new Map(), chestFail: new Map(), refills: new Map(), labNeed: {}, brewed: {}, alchemist: {},
    roundT0: 0, lastKillAt: 0, killGaps: [] }
  installRounds(context)
  // Свои члены контекста ставит installRounds — подмены после него.
  Object.assign(context, {
    readDeaths() { assert.equal(context.between, true); events.push('death barrier') }, board: () => '',
    roundKit: async () => {}, giveBlue: async () => {},
    spreadBots: async () => {
      events.push('safe placement')
      for (const own of Object.values(state)) { assert.equal(own.mode, 'spectator', 'stay uncollidable until spreadplayers completes'); own.safe = true }
    }
  })
  await context.endRound(false, 'fixture')
  assert.equal(context.between, false)
  for (const [name, own] of Object.entries(state)) {
    assert.equal(own.mode, 'survival'); assert.equal(own.safe, true)
    assert(events.indexOf(`gamemode spectator ${name}`) < events.indexOf('clone'))
    assert(events.indexOf('clone') < events.findIndex(e => e.startsWith(`tp ${name} `)))
    assert(events.indexOf('safe placement') < events.indexOf(`gamemode survival ${name}`))
  }
  assert(!events.some(e => /^(gamemode|tp)\b/.test(e) && !Object.keys(state).some(name => e.includes(name))), 'no human pose or game mode is changed')
})

test('a chest taken through the arena wrapper is marked opened, so the ARMS_LOOT_X refill can find it', async () => {
  const L = { y0: 0, chests: [{ x: 10, y: 5, z: 10 }, { x: -4, y: 5, z: 2, pair: { x: 97, y: 105, z: 102 } }] }
  const bot: any = { name: 'A', c: { call: async (method, p) => method === 'chest_take' ? { status: 'done', detail: { at: { x: p.x, y: p.y, z: p.z } } } : {} } }
  const ctx: any = { arms: true, bots: [bot], names: ['A'], pos: {}, humans: {}, X: 100, Y: 100, Z: 100, R: 20, L, log: () => {}, opened: new Set(),
    alive: () => true, armsHome: () => ({ x: 100, y: 100, z: 100 }), hostile: () => false }
  installSight(ctx)
  await bot.c.call('chest_take', { item: 'all', x: 110, y: 105, z: 110 })
  await bot.c.call('chest_take', { item: 'all', x: 97, y: 105, z: 102 })
  await bot.c.call('chest_take', { item: 'all', x: 1, y: 1, z: 1 })
  await turn()
  assert.deepEqual([...ctx.opened].sort(), ['-4,5,2', '10,5,10'], 'single chest by its cell, double chest by its second half, a foreign chest ignored')
})
