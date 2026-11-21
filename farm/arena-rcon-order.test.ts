import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { guardFalls } from './arena/map'
import { rcon } from './arena/server'

const settle = () => new Promise(resolve => setImmediate(resolve))
const plane = 'kill @a[gamemode=survival,x=400,z=400,dx=400,dz=400,y=-64,dy=176]'

// A normal RCON peer with manually advanced acknowledgements. No sockets reach a server.
function referee(t, slot: number, strictReads = false) {
  const fs = require('node:fs'), net = require('node:net'), read = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (file, ...args) => String(file).endsWith('server.properties') ? 'rcon.port=1\nrcon.password=offline-test' : read(file, ...args))
  const timers = new Map<number, () => void>()
  t.mock.method(globalThis, 'setInterval', (run, ms) => { timers.set(ms, run); return 0 as any })
  const peers: { auth: () => void; reset: () => void; commands: string[]; replies: ((body?: string) => void)[] }[] = []
  t.mock.method(net, 'connect', (_port, _host, connected) => {
    const socket: any = new EventEmitter()
    const peer = { auth: null, reset: () => socket.emit('error', new Error('read ECONNRESET')), commands: [], replies: [] }
    peers.push(peer)
    const deliver = frame => {
      const ack = (text = 'OK') => {
        const body = Buffer.from(text), reply = Buffer.alloc(14 + body.length)
        reply.writeInt32LE(reply.length - 4); reply.writeInt32LE(frame.readInt32LE(4), 4); body.copy(reply, 12)
        socket.emit('data', reply)
      }
      if (frame.readInt32LE(8) === 3) {
        peer.auth = ack
        if (strictReads) queueMicrotask(ack)
      } else {
        const cmd = frame.subarray(12, -2).toString()
        peer.commands.push(cmd)
        if (strictReads) ack(cmd.startsWith('title ') ? 'Showing title' : 'Modified block data')
        else peer.replies.push(ack)
      }
    }
    const wire: Buffer[] = []
    socket.write = frame => {
      if (!strictReads || frame.readInt32LE(8) === 3) return deliver(frame)
      wire.push(frame)
      if (wire.length === 1) setImmediate(() => {
        // Installed Paper 1.21.11 RconClient.run compares the first length with the entire TCP read minus four.
        const batch = Buffer.concat(wire.splice(0))
        if (batch.readInt32LE() === batch.length - 4) deliver(batch)
        else socket.emit('error', new Error('read ECONNRESET'))
      })
    }
    queueMicrotask(connected)
    return socket
  })
  const logs = [], b = { name: 'NeuroFarm31ad', c: { call: async () => ({}) } }
  const ctx: any = { i: slot, arms: true, round: 1, X: 600, Y: 120, Z: 600, L: { y0: -4, half: 80 },
    pos: { [b.name]: { p: { x: 547, y: 63, z: 663 }, hp: 20 } }, bots: [b], alive: () => true, log: line => logs.push(line), rcon }
  guardFalls(ctx)
  return { peers, tick: timers.get(1000)!, ctx, logs }
}

test('the death plane operates while ordinary commands are pending; its own slow poll issues only one command', async t => {
  const f = referee(t, 31)
  const list = rcon(31, 'list')
  f.tick(); f.tick()
  await settle()
  assert.equal(f.peers.length, 2)
  const [ordinary, judge] = f.peers
  ordinary.auth(); judge.auth(); await settle()
  assert.deepEqual(ordinary.commands, ['list']); assert.deepEqual(judge.commands, [plane])
  f.tick(); f.tick(); await settle()
  assert.deepEqual(judge.commands, [plane])
  judge.replies.shift()!('Killed NeuroFarm31ad'); await settle()
  assert.ok(f.logs.some(line => line.includes('NeuroFarm31ad — Killed NeuroFarm31ad')))
  f.ctx.pos.NeuroFarm31ad.p.y = 120
  f.tick(); await settle(); assert.deepEqual(judge.commands, [plane, plane])
  judge.replies.shift()!('No entity was found'); ordinary.replies.shift()!()
  await list; await settle()
})

test('victory title and chest refill get separate Paper acknowledgements when their writes overlap', async t => {
  referee(t, 9301, true)
  const cleanup = 'data merge block 6 120 5 {Items:[]}', title = 'title @a title {"text":"Blue"}'
  const results = await Promise.allSettled([
    rcon(9301, cleanup),
    rcon(9301, title, 15000, { current: () => true, channel: 'round-announcement' })
  ])
  assert.deepEqual(results, [{ status: 'fulfilled', value: 'Modified block data' }, { status: 'fulfilled', value: 'Showing title' }])
})

test('an end-of-round announcement authenticated after that round cannot be written', async t => {
  const f = referee(t, 9302)
  let current = true
  const result = rcon(9302, 'title @a title {"text":"Red"}', 15000, { current: () => current, channel: 'round-announcement' })
  await settle(); current = false; f.peers[0].auth()
  await result
  assert.deepEqual(f.peers[0].commands, [])
})

test('a lost victory acknowledgement never repeats its message in the next round', async t => {
  const f = referee(t, 9303), title = 'title @a title {"text":"Blue"}'
  let current = true
  const result = rcon(9303, title, 15000, { current: () => current, channel: 'round-announcement' })
  await settle(); f.peers[0].auth(); await settle()
  assert.deepEqual(f.peers[0].commands, [title])
  f.peers[0].reset(); await settle()
  current = false; f.peers[1].auth()
  assert.equal(await result, '')
  assert.deepEqual(f.peers[1].commands, [])
})

test('a referee connection becoming ready after the round changes cannot send the old kill', async t => {
  const f = referee(t, 32)
  f.tick(); await settle()
  f.ctx.between = true; f.ctx.round++; f.ctx.between = false
  f.peers[0].auth(); await settle()
  assert.deepEqual(f.peers[0].commands, [])
  f.tick(); await settle()
  assert.deepEqual(f.peers[0].commands, [plane])
  f.peers[0].replies.shift()!(); await settle()
})

test('31y below the floor at the edge is handled exclusively by the death plane', async t => {
  const f = referee(t, 9304, true), name = f.ctx.bots[0].name
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  f.ctx.pos[name].p = { x: 511, y: 63, z: 544 }
  for (let tick = 0; tick < 12; tick++) {
    f.tick(); await settle(); await settle()
    now += 1000
  }
  assert.deepEqual(f.peers.flatMap(p => p.commands).filter(c => c !== plane), [])
})

const edgeVerdict = name => `execute as @a[name=${name},gamemode=survival,distance=0..] at @s unless entity @s[x=400,z=400,dx=400,dz=400,y=-64,dy=176] unless entity @s[x=512,z=512,dx=176,dz=176] run kill @s`

test('edge rulings wait four seconds, spare a flier who returns overhead and serialize simultaneous departures', async t => {
  const slot = 9305, f = referee(t, slot), first = f.ctx.bots[0].name, second = 'Second', returning = 'Returning'
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  for (const name of [second, returning]) f.ctx.bots.push({ ...f.ctx.bots[0], name })
  for (const name of [first, second, returning]) f.ctx.pos[name] = { p: { x: 310, y: 420, z: 600 }, hp: 20 }
  const list = rcon(slot, 'list')
  f.tick(); await settle()
  const [ordinary, floor] = f.peers
  ordinary.auth(); floor.auth(); await settle()
  now += 3999; f.tick(); await settle()
  assert.equal(f.peers.length, 2)
  now++; f.tick(); await settle()
  const edge = f.peers[2]; edge.auth(); await settle()
  assert.deepEqual(ordinary.commands, ['list'])
  assert.deepEqual(edge.commands, [edgeVerdict(first)], 'only the first arrival is on the wire until Paper acknowledges it')
  f.ctx.pos[returning].p.x = 688.8 // Within the selector's upper X face at 689.
  floor.replies.shift()!(); await settle(); f.tick(); await settle()
  assert.deepEqual(floor.commands, [plane, plane], 'the floor still runs while the first edge acknowledgement is pending')
  edge.replies.shift()!('Killed ' + first); await settle()
  assert.deepEqual(edge.commands, [edgeVerdict(first), edgeVerdict(second)])
  edge.replies.shift()!('Killed ' + second); await settle()
  assert.equal(edge.commands.length, 2, 'the queued flier returned over the field at Y420')
  ordinary.replies.shift()!(); floor.replies.shift()!(); await list; await settle()
})

test('an edge verdict awaiting authentication expires with the round and its four-second grace restarts', async t => {
  const f = referee(t, 9306), name = f.ctx.bots[0].name
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  f.ctx.pos[name].p = { x: 310, y: 63, z: 600 } // Below the floor but beyond its 400-block catchment.
  f.tick(); await settle()
  const floor = f.peers[0]; floor.auth(); await settle()
  now += 4000; f.tick(); await settle()
  const edge = f.peers[1]
  f.ctx.round++; edge.auth(); await settle()
  f.tick(); await settle(); now += 3999; f.tick(); await settle()
  assert.deepEqual(edge.commands, [])
  now++; f.tick(); await settle()
  assert.deepEqual(edge.commands, [edgeVerdict(name)])
  edge.replies.shift()!(); floor.replies.shift()!(); await settle()
})
