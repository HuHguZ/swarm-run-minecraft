import test from 'node:test'
import assert from 'node:assert/strict'
import fs = require('node:fs')
import path = require('node:path')
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { spawnSync } from 'node:child_process'

function fixture() {
  const records = new Map<string, string>(), processes = new Map<number, any>(), listeners: [number, number][] = []
  const peers = new Map<number, string>(), mutations: any[] = [], calls: any[] = [], spawned: any[] = [], killed: number[] = [], logs: string[] = []
  const root = 'C:/arena-fixture', exe = process.execPath, base = Number(process.env.FFA_WS_BASE) || 8961
  const title = (slot, name, ws) => `nd-fleet-${slot}-${name}-${ws}-${'a'.repeat(32)}`
  const ownerPath = name => path.join(root, 'farm', `memory-${name.replace('NeuroFarm', '')}`, 'fleet-owner.json')
  let rconReply = 'There are 0 of a max of 20 players online:', psFail = false, writeFail = false, probeTimeout = false, tcpFail = false, steal = false
  const own = (slot = 31, k = 0, pid = 31001) => {
    const suffix = k < 24 ? 'cdefghijklmnopqrstuvwxyz'[k] : ['a', 'b', 'c'][Math.floor((k - 24) / 26)] + 'abcdefghijklmnopqrstuvwxyz'[(k - 24) % 26]
    const name = `NeuroFarm${slot}${suffix}`, ws = base + k, marker = title(slot, name, ws)
    const p = { pid, born: '638972000000000000', exe, cmd: `"${exe}" --title=${marker} C:/arena-fixture/code/src/index.js` }
    const record = { ...p, slot, name, ws, title: marker }
    records.set(ownerPath(name), JSON.stringify(record)); processes.set(pid, p); listeners.push([ws, pid])
    return { record, p, name, ws }
  }
  class Socket extends EventEmitter {
    destroy() {}
    setTimeout(_ms, fn) { if (probeTimeout) queueMicrotask(fn); return this }
    constructor(port: number) { super(); if (!probeTimeout) queueMicrotask(() => this.emit(peers.has(port) || listeners.some(l => l[0] === port) ? 'connect' : 'error', new Error('closed'))) }
  }
  class WebSocket extends EventEmitter {
    port: number
    constructor(url: string) { super(); this.port = Number(url.split(':').at(-1)); queueMicrotask(() => this.emit('open')) }
    send(raw: string) { const m = JSON.parse(raw); calls.push({ port: this.port, method: m.method }); queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ id: m.id, ok: true, result: { detail: { server: peers.get(this.port) } } })))) }
    terminate() { this.emit('close') }
  }
  const tcp = () => tcpFail ? '' : 'Active Connections\n' + listeners.map(([port, pid]) => ` TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING ${pid}`).join('\n')
  const child = {
    execFileSync(cmd) { if (cmd === 'netstat') return tcp(); throw new Error('unexpected synchronous OS operation') },
    execFile(cmd, args, _options, done) {
      let result = ''
      if (cmd === 'netstat') result = tcp()
      else if (args.at(-1).startsWith('$done=0;')) {
        const script = args.at(-1), rows = JSON.parse(/ConvertFrom-Json '([^']*)'/.exec(script)![1])
        mutations.push({ script, rows }); result = String(rows.length)
      } else result = psFail ? '' : JSON.stringify([...processes.values()])
      queueMicrotask(() => done(null, result)); return {} as any
    },
    spawn(_file, args, options) {
      const p: any = new EventEmitter(); p.pid = 31999; p.unref = () => {}; p.kill = () => { killed.push(p.pid); return true }
      const row = { pid: p.pid, born: '638972000000000001', exe, cmd: `"${exe}" ${args.join(' ')}` }
      processes.set(p.pid, row); listeners.push([Number(options.env.ND_WS_PORT), steal ? 29001 : p.pid]); spawned.push({ args, options })
      queueMicrotask(() => p.emit('spawn')); return p
    }
  }
  const module = { exports: {} as any }
  const source = fs.readFileSync(path.join(__dirname, 'arena', 'fleet.js'), 'utf8')
  const realRequire = require
  runInNewContext(source, { module, exports: module.exports, process: { env: { ...process.env }, execPath: exe, kill(pid) { killed.push(pid); return true } }, Buffer, console,
    setTimeout, clearTimeout, require(spec) {
      if (spec === './context') return { ROOT: root, sleep: async () => {}, log: message => logs.push(message) }
      if (spec === '../code-dir') return { codeDir: () => path.join(root, 'code') }
      if (spec === './server') return { LAN: 0, rcon: async (i, cmd) => { calls.push({ rcon: i, cmd }); return rconReply } }
      if (spec === 'child_process') return child
      if (spec === 'net') return { connect: port => new Socket(port) }
      if (spec === 'fs') return { readFileSync(file) { const value = records.get(String(file)); if (value === undefined) throw new Error('unregistered'); return value },
        writeFileSync(file, value) { if (writeFail) throw new Error('record write denied'); records.set(String(file), String(value)) }, mkdirSync() {}, openSync() { return 10 } }
      if (path.basename(spec) === 'ws' && spec.includes('node_modules')) return WebSocket
      return realRequire(spec)
    }
  })
  return { fleet: module.exports, records, processes, listeners, peers, mutations, calls, spawned, killed, logs, own, base, exe,
    rcon: value => { rconReply = value }, psFail: () => { psFail = true }, writeFail: () => { writeFail = true },
    timeout: () => { probeTimeout = true }, tcpFail: () => { tcpFail = true }, steal: () => { steal = true } }
}
const plain = value => JSON.parse(JSON.stringify(value))

test('fleet down never kills an unregistered neighbour inside the overlapping extra range', async () => {
  const f = fixture(); f.listeners.push([f.base + 100, 29001])
  f.processes.set(29001, { pid: 29001, born: '638972000000000000', exe: f.exe, cmd: 'node src/index.js' })
  await f.fleet.down(31); assert.deepEqual(f.killed, []); assert.deepEqual(f.mutations, [])
  assert.equal(f.logs.length, 1); assert.match(f.logs[0], /0; неподтверждённые процессы не трогал/)
})

test('discovery includes only registered extras and base bodies reporting the requested MC server', async () => {
  const f = fixture(), a = f.own(); f.listeners.push([f.base + 100, 29001])
  f.peers.set(8831, '127.0.0.1:25631'); f.peers.set(8931, '127.0.0.1:25629')
  assert.deepEqual(plain(await f.fleet.discover(31)), [{ name: 'NeuroFarm31', ws: 8831 }, { name: a.name, ws: a.ws }])
  assert.deepEqual(f.calls.map(c => c.method), ['peek', 'peek'], 'identification never connects or changes the foreign body')
})

for (const fault of ['pid reused', 'command changed', 'exe changed', 'listener changed', 'duplicate listener', 'wrong slot', 'wrong marker', 'missing process table']) {
  test(`down and discovery refuse an owner record with ${fault}`, async () => {
    const f = fixture(), a = f.own()
    if (fault === 'pid reused') f.processes.set(a.p.pid, { ...a.p, born: '638972000000000002' })
    if (fault === 'command changed') f.processes.set(a.p.pid, { ...a.p, cmd: a.p.cmd + ' foreign' })
    if (fault === 'exe changed') f.processes.set(a.p.pid, { ...a.p, exe: 'C:/Windows/javaw.exe' })
    if (fault === 'listener changed') f.listeners[0][1] = 29001
    if (fault === 'duplicate listener') f.listeners.push([a.ws, 29001])
    if (fault === 'wrong slot') for (const key of f.records.keys()) f.records.set(key, JSON.stringify({ ...a.record, slot: 29 }))
    if (fault === 'wrong marker') for (const key of f.records.keys()) f.records.set(key, JSON.stringify({ ...a.record, title: 'nd-fleet-29-foreign' }))
    if (fault === 'missing process table') f.psFail()
    assert.equal(await f.fleet.down(31), 0); assert.deepEqual(plain(await f.fleet.discover(31)), []); assert.deepEqual(f.mutations, [])
  })
}

test('valid owned extra is stopped using its birth, command hash and current listener checks', async () => {
  const f = fixture(), a = f.own()
  assert.equal(await f.fleet.down(31), 1)
  assert.equal(f.mutations.length, 1); assert.equal(f.mutations[0].rows[0].pid, a.p.pid)
  assert.equal(f.mutations[0].rows[0].born, a.p.born); assert.deepEqual(f.mutations[0].rows[0].ports, [a.ws])
  assert.ok(f.mutations[0].script.includes('Stop-Process -InputObject $p'))
})

test('up refuses an occupied unknown port and never spawns over it', async () => {
  const f = fixture(); f.listeners.push([f.base, 29001])
  await assert.rejects(f.fleet.up(31, 1), /29001|порт/); assert.equal(f.spawned.length, 0)
})

for (const kind of ['WS', 'viewer']) test(`a TCP timeout never treats an existing ${kind} listener as a free launch port`, async () => {
  const f = fixture(); f.timeout(); f.listeners.push([kind === 'WS' ? f.base : Number(process.env.FFA_VIEWER_BASE) || 3261, 29001])
  await assert.rejects(f.fleet.up(31, 1)); assert.equal(f.spawned.length, 0)
})

test('a valid existing owned listener is reused even when its TCP backlog times out', async () => {
  const f = fixture(); f.own(); f.timeout(); await f.fleet.up(31, 1)
  assert.equal(f.spawned.length, 0)
})

test('failed listener inspection cannot authorize a launch', async () => {
  const f = fixture(); f.tcpFail(); await assert.rejects(f.fleet.up(31, 1))
  assert.equal(f.spawned.length, 0)
})

test('a listener taken between preflight and spawn never becomes an owned body', async () => {
  const f = fixture(); f.steal(); await assert.rejects(f.fleet.up(31, 1))
  assert.equal(f.records.size, 0); assert.deepEqual(f.killed, [31999])
})

test('up records the actual spawned birth and a random title before the entry point', async () => {
  const f = fixture(); await f.fleet.up(31, 1)
  assert.equal(f.spawned.length, 1)
  assert.match(f.spawned[0].args[0], /^--title=nd-fleet-31-NeuroFarm31c-\d+-[a-f0-9]{32}$/)
  assert.ok(f.spawned[0].args[1].endsWith(path.join('src', 'index.js')))
  assert.equal(f.spawned[0].options.env.MC_PORT, '25631')
  // Падение от нехватки памяти оставляет отчёт и снимок кучи в farm/diag (29.10: демон упал за 155 с без следа).
  assert.match(f.spawned[0].options.env.NODE_OPTIONS, /--report-on-fatalerror .*--heapsnapshot-near-heap-limit=1 .*--max-old-space-size=2048/)
  const record: any = JSON.parse([...f.records.values()][0]); assert.equal(record.pid, 31999); assert.equal(record.born, '638972000000000001')
  assert.equal(await f.fleet.down(31), 1); assert.deepEqual(f.killed, [])
})

test('a failed owner record write closes only the exact child just spawned', async () => {
  const f = fixture(); f.writeFail()
  await assert.rejects(f.fleet.up(31, 1), /record write denied/)
  assert.deepEqual(f.killed, [31999]); assert.equal(f.records.size, 0)
})

test('up refuses a busy viewer port and invalid fighter counts before spawning', async () => {
  const f = fixture(); f.listeners.push([Number(process.env.FFA_VIEWER_BASE) || 3261, 29001])
  await assert.rejects(f.fleet.up(31, 1), /viewer/)
  for (const n of [-1, .5, 103, NaN]) await assert.rejects(f.fleet.up(31, n))
  assert.equal(f.spawned.length, 0)
})

test('boost accepts a base body only after read-only server identity and preserves its process birth', async () => {
  const f = fixture(); f.listeners.push([8831, 31000]); f.peers.set(8831, '127.0.0.1:25631')
  f.processes.set(31000, { pid: 31000, born: '638972000000000003', exe: f.exe, cmd: 'node src/index.js' })
  assert.equal(await f.fleet.boost(31, false), 1)
  assert.deepEqual(f.calls.map(c => c.method), ['peek'])
  assert.equal(f.mutations[0].rows[0].born, '638972000000000003')
})

for (const fault of ['none', 'wrong rcon PID', 'javaw', 'failed authentication']) {
  test(`boost binds server to authenticated same-PID MC/RCON listeners (${fault})`, async () => {
    const f = fixture(), own = f.own(); f.listeners.push([25631, 31002], [25731, fault === 'wrong rcon PID' ? 29002 : 31002])
    f.processes.set(31002, { pid: 31002, born: '638972000000000002', exe: `C:/Java/${fault === 'javaw' ? 'javaw' : 'java'}.exe`, cmd: 'java -jar paper.jar' })
    f.listeners.push([f.base + 100, 29001]); f.peers.set(8831, '127.0.0.1:25629')
    if (fault === 'failed authentication') f.rcon('Authentication failed')
    const expected = fault === 'none' ? [own.p.pid, 31002] : [own.p.pid]
    assert.equal(await f.fleet.boost(31, true), expected.length)
    assert.deepEqual(f.mutations[0].rows.map(r => r.pid), expected)
    assert.ok(f.mutations[0].script.includes("$p.PriorityClass = 'Normal'"))
  })
}

test('mutation PowerShell rechecks a changed birth and listener before touching the body', () => {
  const f = fixture(); f.own()
  return f.fleet.down(31).then(() => {
    const { script, rows } = f.mutations[0], row = rows[0]
    const psQuote = value => "'" + String(value).replaceAll("'", "''") + "'"
    const date = '2026-10-28T00:00:00Z', born = '639287424000000000'
    // Run the real generated mutation, with every OS process/listener operation replaced by a local function.
    const patched = script.replaceAll(row.born, born)
    const cmd = f.processes.get(row.pid).cmd
    for (const changed of ['none', 'birth', 'listener', 'command', 'late birth']) {
      const prefix = `$script:touched=0; $script:reads=0; function Get-Process { param($Id) $script:reads++; [PSCustomObject]@{ StartTime=[DateTime]::Parse(${psQuote(date)}).AddTicks(${changed === 'birth' ? 1 : changed === 'late birth' ? '(($script:reads -gt 1) -as [int])' : 0}) } }; function Get-CimInstance { [PSCustomObject]@{CommandLine=${psQuote(cmd + (changed === 'command' ? ' foreign' : ''))}} }; function Get-NetTCPConnection { [PSCustomObject]@{OwningProcess=${changed === 'listener' ? 29001 : row.pid}} }; function Stop-Process { $script:touched++ }; `
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', prefix + patched + '; Write-Output $script:touched'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
      assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.stdout.trim().split(/\r?\n/).map(Number), changed === 'none' ? [1, 1] : [0, 0])
    }
  })
})
