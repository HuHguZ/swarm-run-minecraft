import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { watchStatus, installSight, watchAlarm } from './arena/watch'
import { installRounds } from './arena/rounds'
import { installSupply, startTactics } from './arena/supply'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmPosition } from './swarm/swarm-driver/position'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'
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
    busy: new Set(), out: new Set(), deadNow: new Set(), alive: () => true, enemiesOf: () => [], teamOf: name => bots.find(b => b.name === name)?.team,
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
    names: Object.keys(state), kills: {}, out: new Set(), deadNow: new Set(), HUMAN_TEAM: null, humanOut: new Set(),
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

for (const [method, params, grace] of [
  ['chest_take', { timeoutSeconds: 8 }, 12000],
  ['chest_take', {}, 49000],
  ['assist', { mode: 'pickup' }, 10000]
] as const) test('the watchdog respects and expires the loot budget: ' + method + ' ' + grace, t => {
  const f = fixture(t), b = f.bots[0]
  f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = 50000
  b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
  b.last = { m: method, p: params, at: 50000 - grace + 1 }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.name === 'fast' && c.method === 'stop').length, 0)
  b.last.at--
  f.watchdog()
  assert.equal(f.calls.filter(c => c.name === 'fast' && c.method === 'stop').length, 1)
})

test('fresh fight does not inherit a stationary goto anchor', t => {
  const f = fixture(t), b = f.bots[0]
  f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = 50000
  f.context.enemiesOf = () => [{ d: 3.3, mob: false }]
  b.last = { m: 'fight', at: 50000, p: { target: 'Foe', timeoutSeconds: 12 } }
  b.anchor = { p: { ...f.context.pos.fast.p }, at: 30000 }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 0)
  b.last.at = 42000
  f.watchdog()
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 1)
})

test('aim stays in the body layer without queuing a cancellation of goto or a new melee fight', t => {
  const { installDangers }: typeof import('./arena/dangers') = require('./arena/dangers')
  const calls: string[] = [], p = { x: 0, y: 64, z: 0 }
  const queued: any[] = []
  t.mock.method(globalThis, 'setTimeout', fn => { queued.push(fn); return 0 })
  t.mock.method(Math, 'random', () => 0)
  const b: any = {
    name: 'A', team: 'blue', last: { m: 'goto' },
    c: { call: async method => { calls.push(method); return {} } },
    dodgeStyle: { delay: 0, len: 2, cd: 500, skip: 0, jumpy: 0 }
  }
  const ctx: any = {
    bots: [b], pos: { A: { p, inv: {} } },
    busy: new Set(), out: new Set(), deadNow: new Set(),
    enemiesOf: () => [{ d: 3.2, mob: false }],
    swarmDriver: { panic: () => false, canEngage: () => true }, log () {}
  }
  installDangers(ctx)
  const aim = { pos: p, dangers: { aims: [{
    name: 'Foe', weapon: 'trident',
    at: { x: 5, y: 64, z: 0 }, side: { x: 1, z: 0 }
  }] } }
  const goto = b.last
  b.c.onDanger(aim)
  assert.equal(b.last, goto)
  assert.equal(ctx.busy.has('A'), false)
  const fight = { m: 'fight', p: { target: 'Foe' }, pending: true }
  b.last = fight; ctx.busy.add('A')
  b.c.onDanger(aim)
  assert.deepEqual(queued, [], 'прицел не ставит отложенную RPC-реакцию')
  assert.equal(b.last, fight)
  assert.equal(ctx.busy.has('A'), true, 'владелец нового боя сохранён')
  assert.deepEqual(calls, [])
})

test('тревога прерывает копателя с _hunt в контакте', t => {
  const f = fixture(t), b = f.bots[0]
  b.climbing = true
  b.last = { m: 'goto', at: Date.now(), p: { _hunt: true } }
  b.swarmTask = { data: { dig: '0,63,0' } }
  f.context.teamOf = () => b.team
  f.context.enemiesOf = () => [{ n: 'RedTest1', d: 3, spd: 6, human: true }]
  let tick: any
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return 1 as any })
  watchAlarm(f.context); tick()
  assert.ok(f.calls.some(c => c.name === b.name && c.method === 'stop'))
})

test('тревога рвёт поход к старому месту человека и поход, когда он уже рядом, но не погоню, подъём и отход', t => {
  const f = fixture(t), b = f.bots[0]
  f.context.teamOf = () => b.team
  f.context.enemiesOf = () => [{ n: 'Tester', d: 4, spd: 6, human: true }]
  let seen = { x: 4, y: 64, z: 0 }
  f.context.swarmDriver.enemies = () => [{ id: 'Tester', position: seen, seenAt: Date.now() }]
  let tick: any
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return 1 as any })
  watchAlarm(f.context)
  const stops = () => f.calls.filter(c => c.name === b.name && c.method === 'stop').length
  b.last = { m: 'goto', at: Date.now(), p: { x: 0, y: 70, z: 20, _hunt: true } }
  tick()
  assert.equal(stops(), 1, 'лез к месту, где его уже нет, — стоп')
  seen = { x: 1, y: 70, z: 19 }
  b.last = { m: 'goto', at: Date.now(), p: { x: 0, y: 70, z: 20, _hunt: true } }
  tick()
  assert.equal(stops(), 1, 'он там, куда иду, — погоня, не рвать')
  seen = { x: 4, y: 64, z: 0 }
  b.swarmTask = { kind: 'flee' }
  b.last = { m: 'goto', at: Date.now(), p: { x: 0, y: 64, z: -12, _hunt: true } }
  tick()
  assert.equal(stops(), 1, 'отход — не погоня')
  b.swarmTask = { kind: 'goto' }
  seen = { x: 2, y: 62, z: 0 }
  b.last = { m: 'goto', at: Date.now(), p: { x: 2, y: 62, z: 0, _hunt: true } }
  tick()
  assert.equal(stops(), 2, 'он рядом, в яме ниже, — бой, а не поход')
  seen = { x: 2, y: 68, z: 0 }
  b.last = { m: 'goto', at: Date.now(), p: { x: 2, y: 68, z: 0, _hunt: true } }
  tick()
  assert.equal(stops(), 2, 'он рядом, но наверху — подъём к нему не рвать')
})

test('alarm cancels each current action once, including old actions and immediate new danger work', t => {
  const f = fixture(t), b = f.bots[0]
  f.context.teamOf = () => b.team
  f.context.enemiesOf = () => [{ n: 'Foe', d: 3, spd: 6, human: true }]
  let tick: any
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return 1 as any })
  b.last = { m: 'goto', at: 0, p: {} }
  watchAlarm(f.context); tick(); tick()
  assert.equal(f.calls.filter(c => c.name === b.name && c.method === 'stop').length, 1)
  b.last = { m: 'craft', at: Date.now(), p: {} }
  tick()
  assert.equal(f.calls.filter(c => c.name === b.name && c.method === 'stop').length, 2)
  f.advance(3600000); tick()
  assert.equal(f.calls.filter(c => c.name === b.name && c.method === 'stop').length, 2)
})

test('watchdog protects a pending craft until its receipt, then diagnoses an abandoned action', t => {
  const f = fixture(t), b = f.bots[0]
  f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = 50000
  b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
  b.last = { m: 'craft', at: 0, p: {}, pending: true }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 0)
  b.last.pending = false; b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 1)
})

// cl28s (15×15, 28.10): бот на крыше Колизея (y 153), все пути боя noPath (1749 раз), сторож ставил needDrop — читателя не было с
// разделения ffa.ts (14.10). Застрявший наверху — спуск к полю с разрешённым падением; ход его не перебивает до ответа.
test('watchdog drops a fighter stuck high above the field instead of only stopping it', async t => {
  const f = fixture(t), b = f.bots[0]
  f.context.pos.fast.p = { x: 0, y: 89, z: 0 }
  f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = 50000
  b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
  b.last = { m: 'fight', at: 40000, p: { target: 'Foe' }, pending: true }
  const sent: any[] = [], raw = b.c.call
  b.c.call = (m, p) => { sent.push({ m, p, reserved: !!b.swarmReserved }); return raw(m, p) }
  f.watchdog(); await turn(); await turn()
  const drop = sent.find(c => c.m === 'goto')
  assert.ok(drop, 'спуск к полю')
  assert.ok(drop.p.descent && drop.p.descent.maxFallDamage > 0, 'с разрешённым падением')
  assert.equal(drop.reserved, true, 'ход не перебивает спуск')
  await turn(); await turn()
  assert.equal(b.swarmReserved, undefined, 'после ответа бот снова в ходе')
})

// cl27r/cl28a: false-retreat bait eats at its rally on purpose — «стоит 6 с — eat (0 с)» ×3–6 at every round start.
for (const where of ['at its post', 'far from its post']) test(`watchdog ${where === 'at its post' ? 'keeps' : 'resets'} a bait eating ${where}`, t => {
  const f = fixture(t), b = f.bots[0], p = f.context.pos.fast.p
  f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = 50000
  b.swarmTask = { kind: 'goto', position: where === 'at its post' ? { x: p.x + 1, y: p.y, z: p.z } : { x: p.x + 9, y: p.y, z: p.z }, data: { bait: true, target: 'Foe' } }
  b.anchor = { p: { ...p }, at: 0 }
  b.last = { m: 'eat', at: 49000, p: { timeoutSeconds: 2 }, pending: true }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.method === 'stop').length, where === 'at its post' ? 0 : 1)
})

function frozenGoto(t, target = { x: 8, y: 64, z: 0 }) {
  const f = fixture(t), b = f.bots[0], calls: any[] = []
  const task: any = { kind: 'goto', position: target, data: { target: 'Foe' } }
  b.swarmTask = task
  b.c.call = async (method, params = {}) => {
    calls.push({ method, params })
    if (method === 'goto') b.last = { m: method, p: params, at: Date.now() }
    return { status: 'done', detail: {} }
  }
  const sw = createDriverState({ bots: [b], pos: f.context.pos, alive: () => true, now: () => Date.now(),
    arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => f.context.pos.fast.p, log() {} })
  Object.assign(sw, swarmMoves(sw))
  Object.assign(sw, { teamOf: () => 'blue', onslaught: () => true,
    breach: async (_b, at) => { calls.push({ method: 'breach', params: at }); return false } })
  Object.assign(sw, swarmPosition(sw))
  Object.assign(sw, swarmTurnWork(sw))
  const run = () => sw.turnGoto({ b, task, m: sw.pos.fast, round: sw.generation, contact: false, enemies: [],
    context: { members: [{ id: b.name }] }, foe: task.data.slot === undefined ? undefined : { position: { x: -2, y: 64, z: 0 } } })
  const freeze = async () => {
    f.advance(14000)
    sw.pos.fast.observedAt = sw.pos.fast.frameAt = Date.now()
    b.anchor = { p: { ...sw.pos.fast.p }, at: Date.now() - 14000 }
    f.watchdog(); await turn()
    assert.equal(b.badSpots.length, 1, 'the real watchdog records the physical approach failure')
  }
  return { ...f, b, sw, calls, task, run, freeze }
}

for (const route of ['task', 'bounded', 'search', 'stand', 'slot']) test(`watchdog failure selects another physical approach on the next ${route} goto`, async t => {
  const f = frozenGoto(t, { x: route === 'bounded' ? 140 : 8, y: 64, z: 0 })
  if (route === 'search') f.task.data.search = true, f.task.data.searchAt = { ...f.task.position }
  if (route === 'stand') f.task.data.swarmStand = { ...f.task.position }, f.task.position = { x: 20, y: 64, z: 0 }
  if (route === 'slot') f.task.data.slot = 0, f.task.position = { x: 20, y: 64, z: 0 }
  await f.run(); await f.freeze(); await f.run()
  const moves = f.calls.filter(c => c.method === 'goto').map(c => ({ x: c.params.x, y: c.params.y, z: c.params.z }))
  assert.equal(moves.length, 2, 'the retry performs an alternative move instead of returning idle')
  assert.notDeepEqual(moves[1], moves[0], 'do not send the same locally failed destination again')
  assert.equal(f.sw.telemetry.searches, 1)
  assert.equal(f.task.data.target, 'Foe', 'the detour retains the pursued enemy')
})

for (const change of ['moved', 'round', 'target']) test(`a failed goto remains available after ${change} changes`, async t => {
  const f = frozenGoto(t)
  await f.run(); await f.freeze()
  if (change === 'moved') { f.sw.pos.fast.p.x = 2.1; f.watchdog() }
  if (change === 'round') { f.context.round++; f.sw.generation++; f.b.waiting = true; f.watchdog(); f.b.waiting = false }
  if (change === 'target') f.task.position = { x: 0, y: 64, z: 8 }
  await f.run()
  const last = f.calls.filter(c => c.method === 'goto').at(-1).params
  assert.deepEqual({ x: last.x, y: last.y, z: last.z }, f.task.position)
  assert.equal(f.sw.telemetry.searches, 0)
})

for (const opened of [false, true]) test(`a failed finishing hunt ${opened ? 'breaches' : 'detours after a refused breach'} without losing the last seen target`, async t => {
  const f = frozenGoto(t)
  await f.run(); await f.freeze()
  f.task.data.hunt = f.task.data.finishing = true
  f.task.data.enemyPosition = { ...f.task.position }
  // turnGoto captures its existing breach helper at construction.
  f.sw.breach = async (_b, at) => { f.calls.push({ method: 'breach', params: at }); return opened }
  Object.assign(f.sw, swarmTurnWork(f.sw))
  await f.run()
  assert.deepEqual(f.calls.filter(c => c.method === 'breach').map(c => c.params), [f.task.data.enemyPosition])
  assert.equal(f.calls.filter(c => c.method === 'goto').length, opened ? 1 : 2)
  assert.equal(f.sw.telemetry.searches, opened ? 0 : 1)
  assert.equal(f.task.data.target, 'Foe')
})

test('watchdog records the failed approach and escalates a second freeze without a forty-second window', async t => {
  const f = fixture(t), b = f.bots[0]
  const stuck = () => {
    f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = Date.now()
    b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
    b.last = { m: 'goto', at: 0, p: { x: 8, y: 64, z: 0, timeoutSeconds: 4 } }
    f.watchdog()
  }
  b.following = 'Leader'; stuck(); await turn()
  assert.equal(b.badSpots[0].until, undefined)
  assert.deepEqual(b.badSpots[0].from, f.context.pos.fast.p)
  assert.equal(b.followCd, undefined, 'one failed route does not ban following every leader')
  f.advance(41000); stuck(); await turn()
  assert(f.calls.some(c => c.method === 'dig_to'))
  f.context.pos.fast.p.x = 4; stuck(); await turn()
  assert.equal(b.frozen.n, 1, 'a different stuck cell starts its own evidence')
})

test('panic cancels once per operation token and can cancel the next unsafe operation immediately', async t => {
  const f = fixture(t), b = f.bots[0]
  f.context.swarmDriver.panic = () => true
  let releases = 0; f.context.swarmDriver.release = () => releases++
  b.last = { m: 'chest_take', at: 0 }
  f.poll(); await turn(); f.poll(); await turn()
  assert.equal(releases, 1)
  b.last = { m: 'goto', at: Date.now() }
  f.poll(); await turn()
  assert.equal(releases, 2)
})

test('potion holders split a pair once per action and a new nearby pair is urgent', async t => {
  const f = fixture(t), b = f.bots[0], dodges: any[] = []
  for (const bot of f.bots) bot.team = 'blue'
  f.context.names = ['fast', 'slow']; f.context.teamOf = () => 'blue'
  f.context.dodgeAway = (...args) => dodges.push(args)
  const reply = () => ({ state: { pos: { x: 0, y: 64, z: 0 }, health: 20, inventory: {}, clock: { ticks: 10 } },
    detail: { dangers: { holders: [{ name: 'Foe', at: { x: 5, y: 64, z: 0 } }] } } })
  b.c.call = async m => m === 'status' ? reply() : {}
  b.last = { m: 'chest_take' }
  f.poll(); await turn(); f.poll(); await turn()
  assert.equal(dodges.length, 1)
  f.context.pos.slow.p.x = 10; f.poll(); await turn()
  f.context.pos.slow.p.x = 1; f.poll(); await turn()
  assert.equal(dodges.length, 2, 'separation and re-entry, without waiting for potAt')
})

test('start loot completes all finite zones even if server and wall clocks cross the old phase budget', async t => {
  let now = 0, visits = 0
  t.mock.method(Date, 'now', () => now)
  const b: any = { name: 'A', team: 'blue', c: { call: async (method, p) => {
    if (method === 'goto' && p.range === 3) { visits++; now += 1000000; ctx.pos.A.tick += 100000 }
    return { status: 'done', detail: {} }
  } } }
  const ctx: any = { bots: [b], pos: { A: { p: { x: 0, y: 64, z: 0 }, tick: 0, inv: {}, armor: {} } }, busy: new Set(),
    L: { areas: [{ id: 'one', x: 0, z: 0 }, { id: 'two', x: 4, z: 0 }], chests: [], half: 10, lab: { brewing: { x: 0, y: 0, z: 0 }, crafting: { x: 0, y: 0, z: 0 } } },
    AL: {}, X: 0, Y: 64, Z: 0, kit: 'fixture', alchemist: {}, brewed: {}, labNeed: {}, armsHome: () => ({ x: 0, y: 64, z: 0 }), log() {}, sleep: async () => {} }
  installSupply(ctx); await ctx.armsPrep()
  assert.equal(visits, 2, 'phase ends on completed search work, not on elapsed time')
})

test('roles react to equipment and membership; identical frames and inventory key order do not reshuffle', async t => {
  const intervals: any[] = [], lines: string[] = []
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { intervals.push({ fn, ms }); return intervals.length })
  const ctx: any = { i: 31, teams: true, arms: false, bots: [{ name: 'A', team: 'blue' }, { name: 'B', team: 'blue' }],
    pos: { A: { inv: { bow: 1, arrow: 4 }, armor: {} }, B: { inv: {}, armor: {} } }, busy: new Set(),
    alive: () => true, labNeed: {}, brewed: {}, alchemist: {}, log: line => lines.push(line), sleep: async () => {} }
  await startTactics(ctx)
  const check = () => intervals.filter(i => i.ms <= 2000).forEach(i => i.fn())
  check(); assert.equal(lines.length, 1)
  ctx.pos.B.inv = { splash_potion: 3 }; check()
  assert.equal(lines.length, 2); assert(lines.at(-1).includes('B=лекарь'))
  ctx.pos.A.inv = { arrow: 4, bow: 1 }; check()
  assert.equal(lines.length, 2)
  ctx.bots.pop(); check()
  assert.equal(lines.length, 3); assert(!lines.at(-1).includes('B='))
})

test('arena wrapper keeps operation ownership until its own receipt; reads and old replies do not steal it', async () => {
  const waiters: any[] = []
  const bot: any = { name: 'A', c: { call: method => method === 'craft' ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve({}) } }
  const ctx: any = { bots: [bot], names: ['A'], pos: {}, humans: {}, X: 0, Y: 64, Z: 0, R: 20, log() {}, alive: () => true }
  installSight(ctx)
  const one = bot.c.call('craft', { item: 'ladder' }), first = bot.last
  await bot.c.call('swarm_pose', { at: { x: 1, y: 64, z: 0 }, inspectOnly: true })
  assert.equal(bot.last, first)
  assert.equal(first.pending, true)
  const two = bot.c.call('craft', { item: 'iron_sword' }), second = bot.last
  waiters[0]({ status: 'done' }); await one; await turn()
  assert.equal(bot.last, second); assert.equal(second.pending, true)
  waiters[1]({ status: 'done' }); await two; await turn()
  assert.equal(second.pending, false)
})

test('watchdog follows operation ownership rather than the former swarm busy/hold deadlines', t => {
  const f = fixture(t), b = f.bots[0]
  f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = 50000
  b.swarmExecuting = true; b.swarmBusyUntil = 1; b.swarmHoldUntil = 1
  b.last = { m: 'goto', at: 0, p: { timeoutSeconds: 4 } }; b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 0)
  b.swarmExecuting = false; b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
  f.watchdog()
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 1, 'an abandoned field cannot hide a missing owner')
})

test('an unsuccessful watchdog dig does not become a timed retry; a new tool can reopen recovery', async t => {
  const f = fixture(t), b = f.bots[0]
  const stuck = async () => {
    f.context.pos.fast.observedAt = f.context.pos.fast.frameAt = Date.now()
    b.anchor = { p: { ...f.context.pos.fast.p }, at: 0 }
    b.last = { m: 'goto', at: 0, p: { x: 8, y: 64, z: 0, timeoutSeconds: 4 } }
    f.watchdog(); await turn()
  }
  await stuck(); f.advance(10000); await stuck()
  assert.equal(f.calls.filter(c => c.method === 'dig_to').length, 1)
  f.advance(3600000); await stuck()
  assert.equal(f.calls.filter(c => c.method === 'dig_to').length, 1, 'the same failed recovery stays failed')
  f.context.pos.fast.inv = { iron_pickaxe: 1 }; await stuck()
  assert.equal(f.calls.filter(c => c.method === 'dig_to').length, 2)
})
