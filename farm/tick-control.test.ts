'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { tickRate, tickAction, configureTick, runEnv, disablePacketLimiter } = require('./tick-control')

test('tick rate defaults to 20 and CLI takes priority over scene and parent env', () => {
  assert.equal(tickRate({} as Record<string, any>, {} as Record<string, any>), 20)
  assert.equal(tickRate({} as Record<string, any>, { TICK_RATE: '60' }), 60)
  assert.equal(tickRate({ env: ['TICK_RATE=80'] }, { TICK_RATE: '60' }), 80)
  assert.equal(tickRate({ 'tick-rate': '100', env: ['TICK_RATE=80'] }, { TICK_RATE: '60' }), 100)
  assert.equal(tickRate({ 'tick-rate': '20' }, { TICK_RATE: '100' }), 20)
  assert.equal(tickRate({ 'tick-rate': '1.5' }, {} as Record<string, any>), 1.5)
  assert.equal(tickRate({ 'tick-rate': '10000' }, {} as Record<string, any>), 10000)
})

test('invalid rates fail before any server work', () => {
  for (const value of [true, '', '0', '-1', '10001', 'NaN', 'Infinity', 'oops']) {
    assert.throws(() => tickRate({ 'tick-rate': value }, {} as Record<string, any>), /tick-rate/)
  }
  assert.throws(() => tickRate({} as Record<string, any>, { TICK_RATE: 'oops' }), /tick-rate/)
  const cli = path.join(__dirname, 'farm.js')
  for (const args of [['up', '--tick-rate', 'oops'], ['up', '--tick-rate=oops'], ['run', 'missing.js', '--tick-rate'], ['tick', '--all', 'rate', '10001']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /tick-rate/)
  }
})

test('tick control validates actions without accepting arbitrary RCON commands', () => {
  assert.deepEqual(tickAction([]), { command: 'tick query' })
  assert.deepEqual(tickAction(['rate', '80']), { command: 'tick rate 80', rate: 80 })
  assert.deepEqual(tickAction(['freeze']), { command: 'tick freeze' })
  assert.deepEqual(tickAction(['unfreeze']), { command: 'tick unfreeze' })
  assert.deepEqual(tickAction(['step']), { command: 'tick step 1' })
  assert.deepEqual(tickAction(['step', '40']), { command: 'tick step 40' })
  assert.deepEqual(tickAction(['step', 'stop']), { command: 'tick step stop' })
  for (const args of [['rate'], ['rate', '80', 'extra'], ['step', '0'], ['step', '1.5'], ['freeze', 'extra'], ['sprint', '100']]) {
    assert.throws(() => tickAction(args))
  }
})

test('startup unfreezes and explicitly resets a saved fast world to 20 before verification', async () => {
  const commands = []
  const result = await configureTick(async command => { commands.push(command); return command === 'tick query' ? 'Target tick rate: 20.0 per second.\nAverage time per tick: 0.5ms (Target: 50.0ms)' : 'ok' }, 20)
  assert.deepEqual(commands, ['tick unfreeze', 'tick rate 20', 'tick query'])
  assert.match(result, /20/)
})

test('a rejected tick command fails startup instead of running a misleading fast batch', async () => {
  const commands = []
  await assert.rejects(configureTick(async command => { commands.push(command); return command === 'tick rate 100' ? 'Unknown or incomplete command, see below for error' : 'ok' }, 100), /tick rate 100/)
  assert.deepEqual(commands, ['tick unfreeze', 'tick rate 100'])
})

test('startup checks the reported target and rejects an ignored sprint reference rate', async () => {
  for (const query of ['Target tick rate: 20.0 per second.', 'Target tick rate: 100.0 per second (ignored, reference only).', 'The game is frozen\nTarget tick rate: 100.0 per second.']) {
    await assert.rejects(configureTick(async command => command === 'tick query' ? query : 'ok', 100), /не подтверждён/)
  }
  await configureTick(async command => command === 'tick query' ? "The game is running, but can't keep up with the target tick rate\nTarget tick rate: 100.0 per second." : 'ok', 100)
})

test('scene env carries one selected tick rate after per-scene overrides', () => {
  const env = runEnv({ TICK_RATE: '20', ND_TICK_RATE: '20', FLAG: 'old' }, { TICK_RATE: '60', ND_TICK_RATE: '60', FLAG: 'new' }, 100)
  assert.equal(env.TICK_RATE, '100')
  assert.equal(env.ND_TICK_RATE, '100')
  assert.equal(env.ND_CLOCK, 'game')
  assert.equal(env.FLAG, 'new')
})

// Exercise the actual farm wiring with process/filesystem/RCON boundaries mocked.
// No Java process, world or network socket is created by these integration tests.
function farmHarness ({ running = [], prepareChanged = false, failReload = 0, limits = { maxUp: 4, cores: 'ccd1' } }: any = {} as Record<string, any>) {
  const events = []; const files = new Map(); const cli = path.join(__dirname, 'farm.js')
  const load = createRequire(cli)
  const fakeFs = {
    existsSync: filename => files.has(String(filename)),
    readFileSync: filename => {
      if (String(filename).endsWith('limits.json')) return JSON.stringify(limits)
      if (files.has(String(filename))) return files.get(String(filename))
      throw new Error('missing mocked file')
    },
    writeFileSync: (filename, text) => files.set(String(filename), String(text)),
    mkdirSync: () => {}, rmSync: () => {}, openSync: () => 123,
    readdirSync: () => []
  }
  const context = vm.createContext({
    require: name => name === 'fs' ? fakeFs : name === 'child_process' ? {
      execFileSync: () => { throw new Error('unexpected shell operation') },
      spawn: (exe, args, options) => {
        const child = { pid: 1234 + events.length, unref () {}, on (event, listener) { if (event === 'exit') queueMicrotask(() => listener(0)) } }
        events.push({ kind: 'spawn', args, env: options.env, cwd: options.cwd }); return child
      }
    } : load(name),
    __dirname, __filename: cli, process: { env: {} as Record<string, any>, execPath: process.execPath },
    console: { log () {}, error () {} }, Buffer, setTimeout: fn => { fn(); return 1 }, clearTimeout () {}, queueMicrotask,
    events, running, prepareChanged, failReload
  })
  const source = fs.readFileSync(cli, 'utf8').split(/\n;?\s*\(async \(\) => \{/)[0]
  assert.ok(!source.includes('process.argv.slice(2)'), 'fixture excludes farm CLI entry point')
  vm.runInContext(source + '\nthis.api = { cmdUp, cmdRun, cmdTick, parseArgs, tickSelection, prepareSlot, slot };\n' +
    'listeners = () => new Map(running.map(i => [25600+i, 123]));\n' +
    'prepareSlot = (s, options) => { events.push({kind:"prepare",slot:s.i,options}); return prepareChanged };\n' +
    'startServer = async s => events.push({kind:"server",slot:s.i});\n' +
    'waitPort = async () => true; portOpen = async () => false;\n' +
    'let mockRate = 20; slotRcon = async (s,command) => { events.push({kind:"rcon",slot:s.i,command}); if(command === "paper reload" && failReload-- > 0) return "Unknown command"; if(command.startsWith("tick rate ")) mockRate=Number(command.slice(10)); return command === "tick query" ? `Target tick rate: ${mockRate.toFixed(1)} per second.` : "ok" };', context)
  return { api: context.api, events, files }
}

test('up configures each ready server before spawning its daemon and records selected TPS', async () => {
  const { api, events, files } = farmHarness()
  await api.cmdUp({ _: ['2'], 'tick-rate': '80' })
  for (const slot of [1, 2]) {
    const commands = events.filter(event => event.kind === 'rcon' && event.slot === slot)
    assert.deepEqual(commands.map(event => event.command), ['tick unfreeze', 'tick rate 80', 'tick query'])
    const spawn = events.find(event => event.kind === 'spawn' && event.env.MC_PORT === String(25600 + slot))
    assert.equal(spawn.env.ND_TICK_RATE, '80')
    assert.ok(events.indexOf(commands[2]) < events.indexOf(spawn))
  }
  const state = JSON.parse(files.get(path.join(__dirname, 'slots.json')))
  assert.equal(state.slots[1].tickRate, 80)
  assert.equal(state.slots[2].tickRate, 80)
})

test('up --code runs the slot daemon and later scenes from the frozen snapshot, not the live tree', async () => {
  const { api, events, files } = farmHarness()
  const snap = path.join(__dirname, '..', '.daemon-t1')
  files.set(path.join(snap, 'src', 'index.js'), '')
  await api.cmdUp({ _: ['1'], code: 't1' })
  assert.equal(JSON.parse(files.get(path.join(__dirname, 'slots.json'))).slots[1].code, 't1')
  assert.equal(events.find(event => event.kind === 'spawn').cwd, snap)
  await api.cmdRun({ _: ['probe.js'], slots: '1', tag: 'snap', env: [] }, [])
  assert.equal(events.filter(event => event.kind === 'spawn').pop().cwd, snap)
  await assert.rejects(api.cmdUp({ _: ['1'], from: '2', code: 'missing' }), /снимка нет/)
})

test('run resets every selected world before parallel scenes and records game-clock metadata', async () => {
  const { api, events, files } = farmHarness()
  await api.cmdRun({ _: ['probe.js'], slots: '1-2', tag: 'test', env: ['FLAG=1'] }, ['once'])
  const firstSpawn = events.findIndex(event => event.kind === 'spawn')
  assert.equal(events.slice(0, firstSpawn).filter(event => event.kind === 'rcon' && event.command.startsWith('tick ')).length, 6)
  assert.equal(events.slice(0, firstSpawn).filter(event => event.command === 'paper reload').length, 2)
  for (const event of events.filter(event => event.kind === 'spawn')) {
    assert.equal(event.env.TICK_RATE, '20')
    assert.equal(event.env.ND_CLOCK, 'game')
    assert.deepEqual(Array.from(event.args), ['probe.js', 'once'])
  }
  const batch = JSON.parse(files.get(path.join(__dirname, 'results', 'test', 'batch.json')))
  assert.equal(batch.tickRate, 20)
  assert.equal(batch.clock, 'game')
  assert.equal(batch.env.FLAG, '1')
})

test('tick CLI never selects all worlds without an explicit slot choice', () => {
  const { api } = farmHarness()
  assert.equal(tickRate(api.parseArgs(['4', '--tick-rate=80']).a, {} as Record<string, any>), 80)
  assert.throws(() => api.tickSelection(api.parseArgs(['rate', '80']).a))
  const all = api.tickSelection(api.parseArgs(['--all', 'rate', '80']).a)
  assert.equal(all.action.command, 'tick rate 80')
  const chosen = api.tickSelection(api.parseArgs(['--slots', '2-3', 'freeze']).a)
  assert.equal(chosen.spec, '2-3')
  assert.equal(chosen.action.command, 'tick freeze')
})

test('farm packet config disables all and recipe limits while preserving other YAML bytes', () => {
  const prefix = '_version: 31\r\nchunk-loading:\r\n  max-concurrent-sends: 8\r\n'
  const suffix = '# Keep proxy settings unchanged\r\nproxies:\r\n  velocity:\r\n    secret: placeholder\r\n'
  const input = prefix + 'packet-limiter:\r\n  all-packets:\r\n    action: KICK\r\n    interval: 7.0\r\n    max-packet-rate: 500.0\r\n  overrides:\r\n    minecraft:place_recipe:\r\n      action: DROP\r\n      interval: 4.0\r\n      max-packet-rate: 5.0\r\n' + suffix
  const output = disablePacketLimiter(input)
  assert.ok(output.startsWith(prefix))
  assert.ok(output.endsWith(suffix))
  assert.match(output, /interval: 0\.0\r\n    max-packet-rate: 0\.0\r\n  overrides: \{\}/)
  assert.doesNotMatch(output, /place_recipe|DROP/)
  assert.equal(disablePacketLimiter(output), output)
  assert.equal((disablePacketLimiter(prefix).match(/^packet-limiter:/gm) || []).length, 1)
})

test('farm packet config disables the wall-time use-item spam limiter once', () => {
  const input = 'packet-limiter:\n  all-packets:\n    interval: 0.0\n    max-packet-rate: 0.0\n  overrides: {}\nspam-limiter:\n  incoming-packet-threshold: 300\n  recipe-spam-increment: 1\nspark:\n  enabled: true\n'
  const output = disablePacketLimiter(input)
  assert.match(output, /^spam-limiter:\n  incoming-packet-threshold: disabled\n  recipe-spam-increment: 1\nspark:/m)
  assert.equal(disablePacketLimiter(output), output)
})

test('changed live farm config reloads once before tick or scene commands', async () => {
  const { api, events } = farmHarness()
  await api.cmdTick({ _: ['1', 'rate', '250'], env: [] })
  await api.cmdTick({ _: ['1', 'query'], env: [] })
  await api.cmdRun({ _: ['probe.js'], slots: '1', tag: 'test-packets', env: [], 'tick-rate': '250' }, [])
  const reloads = events.filter(event => event.command === 'paper reload')
  assert.equal(reloads.length, 1)
  assert.ok(events.indexOf(reloads[0]) < events.findIndex(event => event.command === 'tick rate 250'))
})

test('tick query reads status without writing or reloading a legacy config', async () => {
  const { api, events, files } = farmHarness({ failReload: 1 })
  const file = path.join(__dirname, 'server-1', 'config', 'paper-global.yml')
  const original = '_version: 31\npacket-limiter:\n  all-packets:\n    interval: 7.0\n    max-packet-rate: 500.0\n'
  files.set(file, original)
  const writes = []
  const save = files.set.bind(files)
  files.set = (filename, text) => { writes.push(filename); return save(filename, text) }
  await api.cmdTick({ _: ['1', 'query'], env: [] })
  assert.deepEqual(events.map(event => event.command), ['tick query'])
  assert.deepEqual(writes, [])
  assert.equal(files.get(file), original)
})

test('Paper normalization of an already disabled block does not trigger another reload', () => {
  const normalized = 'packet-limiter:\n  all-packets:\n    max-packet-rate: 0.0\n    interval: 0.0\n    action: KICK\n  kick-message: <red><lang:disconnect.exceeded_packet_rate>\n  overrides: {}\nplayer-auto-save:\n  rate: -1\n'
  assert.equal(disablePacketLimiter(normalized), normalized)
})

test('failed Paper reload restores prior bytes so the next command retries it', async () => {
  const { api, events, files } = farmHarness({ failReload: 1 })
  const file = path.join(__dirname, 'server-1', 'config', 'paper-global.yml')
  const original = '_version: 31\npacket-limiter:\n  all-packets:\n    interval: 7.0\n    max-packet-rate: 500.0\n'
  files.set(file, original)
  await assert.rejects(api.cmdTick({ _: ['1', 'rate', '250'], env: [] }), /paper reload/)
  assert.equal(files.get(file), original)
  await api.cmdTick({ _: ['1', 'rate', '250'], env: [] })
  assert.equal(events.filter(event => event.command === 'paper reload').length, 2)
  assert.match(files.get(file), /overrides: \{\}/)
})

test('up applies changed config to a cached running server without reloading new worlds', async () => {
  const { api, events } = farmHarness({ running: [1], prepareChanged: true })
  await api.cmdUp({ _: ['2'], 'tick-rate': '250' })
  assert.deepEqual(events.filter(event => event.command === 'paper reload').map(event => event.slot), [1])
})

test('farm startup permits accelerated survival movement without the vanilla floating kick', () => {
  const { api, files } = farmHarness()
  const selected = api.slot(1)
  const file = path.join(selected.dir, 'server.properties')
  files.set(file, 'allow-flight=false\ngamemode=survival\n')
  api.prepareSlot(selected, { seed: '1', fresh: false, world: null })
  assert.match(files.get(file), /^allow-flight=true$/m)
  assert.match(files.get(file), /^gamemode=survival$/m)
})

test('farm profile supplies the default TPS for startup and scenes while explicit flags win', async () => {
  const { api, events } = farmHarness({ limits: { maxUp: 4, cores: 'all', tickRate: 750 } })
  await api.cmdUp({ _: ['1'] })
  assert.equal(events.find(event => event.command?.startsWith('tick rate ')).command, 'tick rate 750')
  events.length = 0
  await api.cmdRun({ _: ['try-tick-clock.js'], slots: '1', tag: 'profile', env: [] }, [])
  assert.equal(events.find(event => event.command?.startsWith('tick rate ')).command, 'tick rate 750')
  events.length = 0
  await api.cmdUp({ _: ['1'], 'tick-rate': '20' })
  assert.equal(events.find(event => event.command?.startsWith('tick rate ')).command, 'tick rate 20')
})
