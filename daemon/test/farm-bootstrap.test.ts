import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import fs = require('fs')
import path = require('path')
import * as vm from 'vm'
import { transformSync } from 'esbuild'

function fixture (options: any = {}) {
  const root = path.resolve(__dirname, '..', '..')
  const env = { FARM_SLOT: '22', MC_PORT: '25622', ND_WS: 'ws://127.0.0.1:8822', MC_USERNAME: 'NeuroFarm22', TICK_RATE: '750', ...options.env }
  const rows: any[] = []
  let at = 0, target = 750, connected = !!options.alreadyReady, polls = 0, ready = !!options.alreadyReady, madeAdapter = 0, settled = false
  let complete: any, rejectConnect: any
  const call = async (method, params) => {
    rows.push({ method, params, target, ready })
    if (method === 'peek') {
      if (options.hungInitialPeek || connected && options.hungPeek) return new Promise(() => {})
      if (connected) {
        if (options.failPeek) throw new Error('readiness transport failed')
        if (++polls >= 3 && !options.neverReady) ready = true
      }
      return { state: { connected }, detail: { server: options.server ?? '127.0.0.1:25622', physics: { worldLoaded: ready } } }
    }
    if (method === 'connect') {
      connected = true
      if (options.rejectConnect) { settled = true; throw new Error('connect failed') }
      if (options.pending) return new Promise((resolve, reject) => {
        complete = value => { settled = true; resolve(value) }; rejectConnect = error => { settled = true; reject(error) }
      })
      settled = true
      return { ok: true, state: { connected: true } } // Can resolve while own column remains unknown.
    }
    if (method === 'disconnect') {
      if (options.hungDisconnect) return new Promise(() => {})
      connected = false
      if (!options.lostPending) rejectConnect?.(new Error('connection cancelled by disconnect'))
      return { ok: true }
    }
    return { status: 'done' }
  }
  const send = async command => {
    rows.push({ command, target, ready })
    if (options.rconError && target === 20 && command === 'tick query') return 'ERR rcon unavailable'
    const match = /^tick rate (\d+)$/.exec(command)
    if (match) {
      target = Number(match[1])
      if (target === Number(env.TICK_RATE) && ready && options.pending && !options.lostPending) complete?.({ ok: true })
    }
    return command === 'tick query' ? `The game is running normallyTarget tick rate: ${target.toFixed(1)} per second.` : 'confirmed'
  }
  const clock = { wall: { now: () => at, sleep: async ms => { at += ms },
    setTimeout: (fn, ms) => setTimeout(() => { at += ms; fn() }, 5), clearTimeout }, now: () => at }
  const cache = new Map()
  const load = (file, supplied?: string) => {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const requireStub = name => {
      if (/game-clock$/.test(name)) return clock
      if (name === '../../src/build') return { withTimeout: (require('../src/build') as typeof import('../src/build')).withTimeout }
      if (name === 'fs') return { ...fs, readFileSync: (file, encoding) => /server\.properties$/.test(file)
        ? `server-port=${options.mcPort ?? 25622}\nrcon.port=${options.rconPort ?? 25722}\n` : fs.readFileSync(file, encoding) }
      if (/tick-control$/.test(name)) return load(path.join(root, 'farm/tick-control.ts'))
      if (/try-lab-ne-map$/.test(name)) return { rconOf: slot => { assert.equal(slot, 22); madeAdapter++; return send }, netherMap: () => assert.fail('map must never be called') }
      if (name === '../lib/farm-bootstrap') return load(path.join(root, 'daemon/scenes/lib/farm-bootstrap.ts'))
      if (name === '../lib/scene-kit') return { connect: () => ({ ready: Promise.resolve(), call, heard: [] }), createKit: () => ({}), sleep: clock.wall.sleep }
      if (name.startsWith('.')) return require(path.resolve(path.dirname(file), name))
      return require(name)
    }
    const code = transformSync(supplied ?? fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code
    vm.runInNewContext(code, cjsContext({ require: requireStub, module, exports: module.exports, __dirname: path.dirname(file), process: { env }, console }), { filename: file })
    return module.exports
  }
  const bootstrap = load(path.join(root, 'daemon/scenes/lib/farm-bootstrap.ts')).farmBootstrap
  return { call, rows, load, root, bootstrap: () => bootstrap(call, options.ws ?? 'ws://127.0.0.1:8822', options.player ?? 'NeuroFarm22'), state: () => ({ at, target, connected, ready, madeAdapter, settled }), complete: value => complete?.(value), reject: error => rejectConnect?.(error) }
}

for (const file of ['scenes/ow/try-lab-fresh.ts', 'scenes/nether/try-lab-ne-run.ts']) test(`actual ${path.basename(file)} first bootstrap protects unknown column before scene preparation`, async () => {
  const f = fixture(), full = path.join(f.root, 'daemon', file), text = fs.readFileSync(full, 'utf8')
  const start = text.indexOf('async function main ()'), end = text.indexOf('  const t0 = gameClock.now()', start)
  assert.ok(start > 0 && end > start)
  await f.load(full, text.slice(0, end) + '\n}\nmodule.exports = main\n')()
  const entry = f.rows.find(row => row.method === 'connect')
  assert.equal(entry.target, 20)
  assert.equal(entry.params.bootstrapPaused, true)
  assert.equal(f.state().target, 750)
  assert.ok(f.rows.find(row => row.command === 'tick rate 750')?.ready)
  assert.ok(f.rows.find(row => row.method === 'stop')?.ready)
  assert.ok(!f.rows.some(row => row.method === 'status' || row.method === 'situation'), 'readiness does not drain events')
})

for (const [name, options] of [
  ['main WS', { ws: 'ws://127.0.0.1:8769' }],
  ['arena WS', { ws: 'ws://127.0.0.1:8765' }],
  ['slot range', { env: { FARM_SLOT: '33' } }],
  ['MC env', { env: { MC_PORT: '25569' } }],
  ['player', { player: 'NeuroDown' }],
  ['configured MC port', { mcPort: 25569 }],
  ['configured RCON port', { rconPort: 25579 }],
  ['daemon targets main', { server: '127.0.0.1:25569' }]
] as const) test(`farm boundary refuses ${name} before any RCON or game connection`, async () => {
  const f = fixture(options)
  await assert.rejects(f.bootstrap(), /farm bootstrap/)
  assert.equal(f.state().madeAdapter, 0)
  assert.ok(!f.rows.some(row => row.command || row.method === 'connect'))
})

test('resolved connect with unknown columns remains warm until physical readiness', async () => {
  const f = fixture()
  await f.bootstrap()
  const peeks = f.rows.filter(row => row.method === 'peek')
  assert.ok(peeks.length >= 4)
  assert.ok(peeks.slice(1, 3).every(row => row.target === 20 && !row.ready))
  assert.ok(f.rows.find(row => row.command === 'tick rate 750').ready)
})

test('ready column restores target while handshake is still pending, then awaits handshake', async () => {
  const f = fixture({ pending: true, env: { TICK_RATE: '500' } })
  await f.bootstrap()
  assert.equal(f.state().target, 500)
  assert.equal(f.state().settled, true)
  assert.equal(f.state().connected, true)
})

for (const options of [{ rejectConnect: true }, { failPeek: true, pending: true }, { neverReady: true, pending: true }]) test(`failed bootstrap disconnects and settles pending handshake before returning: ${JSON.stringify(options)}`, async () => {
  const f = fixture(options)
  await assert.rejects(f.bootstrap(), /connect failed|readiness transport failed|own collision columns/)
  assert.equal(f.state().target, 750)
  assert.equal(f.state().connected, false)
  assert.equal(f.state().settled, true)
  const end = f.rows.findIndex(row => row.method === 'disconnect')
  assert.ok(end >= 0)
  assert.ok(!f.rows.slice(end + 1).some(row => row.method === 'peek' || row.method === 'connect'), 'no delayed readiness callback starts another actor')
  f.complete({ ok: true })
  assert.equal(f.state().connected, false)
})

test('RCON ERR is a transport failure; partial rate change is restored without connecting', async () => {
  const f = fixture({ rconError: true })
  await assert.rejects(f.bootstrap(), /ERR rcon unavailable/)
  assert.equal(f.state().target, 750)
  assert.ok(!f.rows.some(row => row.method === 'connect'))
})

test('already readable connected actor is not slowed or disconnected', async () => {
  const f = fixture({ alreadyReady: true })
  await f.bootstrap()
  assert.equal(f.state().madeAdapter, 0)
  assert.ok(!f.rows.some(row => row.command || row.method === 'disconnect'))
})

test('initial readiness RPC has a wall bound before any server mutation', async () => {
  const f = fixture({ hungInitialPeek: true })
  await assert.rejects(f.bootstrap(), /readiness RPC timed out/)
  assert.equal(f.state().at, 12000)
  assert.equal(f.state().madeAdapter, 0)
  assert.ok(!f.rows.some(row => row.command || row.method === 'connect'))
})

for (const options of [{ hungPeek: true, pending: true }, { lostPending: true, pending: true }]) test(`missing readiness/connect reply is bounded and restores target: ${JSON.stringify(options)}`, async () => {
  const f = fixture(options)
  await assert.rejects(f.bootstrap(), /RPC timed out|connect teardown unconfirmed/)
  assert.equal(f.state().target, 750)
  assert.equal(f.state().connected, false)
  assert.ok(f.state().at <= 24100) // two 12s RPC bounds plus the two successful 50ms readiness polls
  const end = f.rows.length
  f.reject(new Error('delayed handshake rejection'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.rows.length, end, 'a late rejected handshake cannot reconnect or poll after teardown')
})

test('missing disconnect ACK reports unconfirmed teardown within a wall bound', async () => {
  const f = fixture({ failPeek: true, pending: true, hungDisconnect: true })
  await assert.rejects(f.bootstrap(), /connect teardown unconfirmed/)
  assert.equal(f.state().target, 750)
  assert.equal(f.state().connected, true, 'no disconnect ACK is not proof of a disconnected native actor')
  assert.equal(f.state().at, 24000)
  const end = f.rows.length
  f.complete({ ok: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.rows.length, end, 'late settlement cannot restart readiness work')
})
