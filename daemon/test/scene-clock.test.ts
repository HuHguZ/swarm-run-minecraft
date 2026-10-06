'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { WebSocketServer } = require('ws')
const gameClock = require('../src/game-clock')
const { connect, createKit, createGameBot, sleep } = require('../scene-kit')

function portalFallback() {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
  const file = path.join(__dirname, '../try-lab-ne-util.ts'), mod = { exports: {} }
  vm.runInNewContext(require('esbuild').transformSync(fs.readFileSync(file, 'utf8'),
    { loader: 'ts', format: 'cjs', target: 'node24' }).code,
  { module: mod, require: require('node:module').createRequire(file), process, console })
  return mod.exports as { portalTp(kit: unknown, status: () => Promise<unknown>, inner: unknown, call: (method: string, params: unknown) => Promise<unknown>): Promise<boolean> }
}

async function waitFor (predicate) {
  const until = gameClock.wall.now() + 2000
  while (!predicate()) {
    if (gameClock.wall.now() >= until) throw new Error('clock update did not arrive')
    await gameClock.wall.sleep(5)
  }
}

test('scene follows unsolicited primary snapshots, freezes waits, and ignores a second bot clock', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const peers = []
  const clocks = []
  const rememberClock = clock => { if (clock) clocks.push(clock) }
  gameClock.changes.on('bound', rememberClock)
  server.on('connection', peer => peers.push(peer))
  const url = `ws://127.0.0.1:${server.address().port}`
  const primary = connect(url)
  const secondary = connect(url)
  const snapshot = ticks => ({ id: 'primary', ticks, gameMs: 1000000 + ticks * 50,
    tickRate: 200, effectiveRate: 200, frozen: true, running: true })
  try {
    await Promise.all([primary.ready, secondary.ready])
    peers[0].send(JSON.stringify({ type: 'clock', clock: snapshot(10) }))
    await waitFor(() => gameClock.now() === 1000500)
    const id = gameClock.snapshot().id
    let finished = false
    const waiting = sleep(200).then(() => { finished = true })
    peers[1].send(JSON.stringify({ type: 'clock', clock: { ...snapshot(4000), id: 'secondary' } }))
    await gameClock.wall.sleep(30)
    assert.equal(gameClock.snapshot().id, id)
    assert.equal(finished, false)
    peers[0].send(JSON.stringify({ type: 'clock', clock: snapshot(14) }))
    await waitFor(() => finished)
    await waiting
    assert.equal(gameClock.now(), 1000700)
    peers[0].on('message', raw => {
      const m = JSON.parse(raw)
      peers[0].send(JSON.stringify({ id: m.id, ok: true, result: { state: { clock: snapshot(15) } } }))
    })
    await primary.call('status')
    await waitFor(() => gameClock.now() === 1000750)
  } finally {
    primary.close()
    secondary.close()
    for (const peer of peers) peer.terminate()
    await new Promise<any>(resolve => server.close(resolve))
    // The follower owns wall pump timers; do not carry it into another test.
    gameClock.changes.removeListener('bound', rememberClock)
    for (const clock of clocks) clock.dispose()
    gameClock.activate(null)
  }
})

test('scene event windows default to game timestamps with explicit wall windows and legacy fallback', () => {
  const heard = [
    { type: 'death', at: 10, gameAt: 100 },
    { type: 'death', at: 20 },
    { type: 'hurt', at: 30, gameAt: 110 }
  ]
  const kit = createKit({ call: async () => ({} as Record<string, any>), heard })
  assert.deepEqual(kit.between(90, 120, 'death'), [heard[0]])
  assert.deepEqual(kit.between(15, 25, 'death'), [heard[1]])
  assert.deepEqual(kit.between(0, 15, 'death', 'wall'), [heard[0]])
})

test('fixture portal fallback observes the real arrival portal before starting a Nether run', async t => {
  t.mock.method(gameClock, 'sleep', async () => {})
  const { portalTp } = portalFallback()
  const commands = [], observations = []
  const kit = { cmd: async text => { commands.push(text) } }
  const status = async () => ({ dimension: 'the_nether', health: 20 })
  const observe = async (method, params) => {
    observations.push({ method, params: JSON.parse(JSON.stringify(params)) })
    if (method === 'status') return { state: { dimension: 'the_nether', health: 20 }, detail: { physics: { worldLoaded: true } } }
    return { detail: { lit: true, place: { dimension: 'the_nether', x: 3, y: 69, z: 3 } } }
  }
  assert.equal(await portalTp(kit, status, { x: 7, y: 66, z: -7 }, observe), true)
  assert.deepEqual(commands, ['/tp @s 7.5 66 -6.5'])
  assert.deepEqual(observations, [
    { method: 'status', params: { physics: true } },
    { method: 'portal', params: { mode: 'build', scan: 16, timeoutSeconds: 30 } }
  ])
  await assert.rejects(portalTp(kit, status, { x: 7, y: 66, z: -7 }, async method => method === 'status'
    ? { state: { dimension: 'the_nether', health: 20 }, detail: { physics: { worldLoaded: true } } }
    : { detail: { lit: false } }), /портал прибытия/)
})

test('fixture portal fallback waits for actual loaded arrival geometry before adopting the portal', async t => {
  t.mock.method(gameClock, 'sleep', async () => {})
  t.mock.method(gameClock.wall, 'sleep', async () => {})
  const { portalTp } = portalFallback()
  const calls: string[] = [], commands: string[] = []
  let samples = 0
  const call = async (method: string) => {
    calls.push(method)
    if (method === 'status') return { state: { dimension: 'the_nether', health: 20 },
      detail: { physics: { worldLoaded: ++samples >= 3 } } }
    assert.equal(samples, 3, 'dimension alone must not initiate a portal search in unloaded chunks')
    return { detail: { lit: true, place: { dimension: 'the_nether' } } }
  }
  assert.equal(await portalTp({ cmd: async (command: string) => { commands.push(command) } },
    async () => ({ dimension: 'the_nether', health: 20 }), { x: 5, y: 68, z: -3 }, call), true)
  assert.deepEqual(calls, ['status', 'status', 'status', 'portal'])
  assert.deepEqual(commands, ['/tp @s 5.5 68 -2.5'], 'loading readiness must not teleport again')
})

test('fixture arrival readiness refuses timeout, death and a changed dimension before portal search', async t => {
  t.mock.method(gameClock, 'sleep', async () => {})
  let wall = 0
  t.mock.method(gameClock.wall, 'now', () => wall)
  t.mock.method(gameClock.wall, 'sleep', async (ms: number) => { wall += ms })
  const { portalTp } = portalFallback()
  for (const state of [{ dimension: 'the_nether', health: 20 }, { dimension: 'the_nether', health: 0 },
    { dimension: 'overworld', health: 20 }]) {
    let searched = 0
    const call = async (method: string) => {
      if (method === 'portal') searched++
      return { state, detail: { physics: { worldLoaded: false } } }
    }
    await assert.rejects(portalTp({ cmd: async () => {} }, async () => ({ dimension: 'the_nether', health: 20 }),
      { x: 5, y: 68, z: -3 }, call), /подготовка:.*(загруз|здоров|мир)/)
    assert.equal(searched, 0)
  }
  assert.ok(wall <= 15000, 'arrival chunk readiness is bounded by wall time, including a stopped game clock')
})

test('fixture arrival readiness bounds a missing RPC acknowledgement in wall time', async t => {
  t.mock.method(gameClock, 'sleep', async () => {})
  let wall = 0
  t.mock.method(gameClock.wall, 'now', () => wall)
  t.mock.method(gameClock.wall, 'setTimeout', (fn: () => void, ms: number) => setImmediate(() => { wall += ms; fn() }))
  t.mock.method(gameClock.wall, 'clearTimeout', (timer: ReturnType<typeof setImmediate>) => clearImmediate(timer))
  const { portalTp } = portalFallback()
  let searches = 0
  await assert.rejects(portalTp({ cmd: async () => {} }, async () => ({ dimension: 'the_nether', health: 20 }),
    { x: 5, y: 68, z: -3 }, async method => {
      if (method === 'portal') { searches++; return { detail: { lit: true, place: { dimension: 'the_nether' } } } }
      return new Promise(() => {})
    }), /подготовка:.*загруз/)
  assert.equal(searches, 0)
  assert.equal(wall, 15000)
})

test('native scene bots have separate tick plugin scopes and only primary supplies process time', t => {
  const mineflayer = require('mineflayer')
  const options = []
  t.mock.method(mineflayer, 'createBot', supplied => {
    options.push(supplied)
    const bot = new EventEmitter()
    bot._client = new EventEmitter()
    return bot
  })
  const a = createGameBot({ username: 'A' }, { primary: true })
  const b = createGameBot({ username: 'B' }, { primary: true })
  const observer = createGameBot({ username: 'Eye' })
  try {
    assert.notEqual(a.ndClock, b.ndClock)
    assert.notEqual(a.ndClock, observer.ndClock)
    assert.equal(gameClock.snapshot().id, a.ndClock.id)
    for (const supplied of options) {
      assert.equal(typeof supplied.plugins.physics, 'function')
      assert.equal(typeof supplied.plugins.digging, 'function')
      assert.equal(typeof supplied.plugins.inventory, 'function')
    }
    a.ndClock.advanceTicks(3)
    assert.equal(gameClock.now(), a.ndClock.now())
    assert.equal(b.ndClock.ticks, 0)
  } finally {
    for (const bot of [a, b, observer]) bot.emit('end')
    gameClock.activate(null)
  }
})
