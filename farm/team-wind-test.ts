// Owned farm only, already-running actors, initial calibration at 20 TPS:
// node farm/team-wind-test.js <slot> <helper-ws-port> <NeuroFarmNhelper> [repetitions=3]
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { SwarmBoard } from '../daemon/src/swarm'
const WebSocket = require('../daemon/node_modules/ws')
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const root = path.resolve(__dirname, '..')
const detail = (r: any) => r?.detail || r
const parsePoint = (text: string) => {
  const body = /\[\s*([-+\d.eEfFdD,\s]+)\]/.exec(text)?.[1]
  const values = body?.split(',').map(n => Number.parseFloat(n.trim()))
  if (!values || values.length !== 3 || values.some(n => !Number.isFinite(n))) throw new Error('Unconfirmed farm entity position')
  return { x: values[0], y: values[1], z: values[2] }
}
function peer(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); let sequence = 0
  const pending = new Map<number, any>()
  ws.on('message', (bytes: any) => {
    const reply = JSON.parse(String(bytes)), task = pending.get(reply.id)
    if (!task) return
    pending.delete(reply.id); clearTimeout(task.timeout)
    if (reply.ok) task.resolve(reply.result); else task.reject(new Error(reply.error))
  })
  const ready = new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = async (method: string, params: any = {}) => {
    await ready
    const id = ++sequence
    return await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: RPC timeout`)) }, 20000)
      pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params }))
    })
  }
  const execute = async (method: string, params: any) => {
    let r = await call(method, params)
    while (r?.status === 'pending' && r.token !== undefined) { await pause(50); r = await call('status', { token: r.token }) }
    return detail(r)
  }
  return { call, execute, close: () => ws.close() }
}
function rconFor(slot: number) {
  const props = fs.readFileSync(path.join(root, 'farm', `server-${slot}`, 'server.properties'), 'utf8')
  const prop = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(props)?.[1].trim()
  if (Number(prop('server-port')) !== 25600 + slot || Number(prop('rcon.port')) !== 25700 + slot) throw new Error('Not an owned farm server')
  const port = Number(prop('rcon.port')), password = prop('rcon.password')
  return async (command: string) => new Promise<string>((resolve, reject) => {
    const packet = (id: number, type: number, body: string) => {
      const encoded = Buffer.from(body), out = Buffer.alloc(14 + encoded.length)
      out.writeInt32LE(10 + encoded.length, 0); out.writeInt32LE(id, 4); out.writeInt32LE(type, 8); encoded.copy(out, 12); return out
    }
    let buffered = Buffer.alloc(0), authenticated = false
    const socket = net.connect(port, '127.0.0.1', () => socket.write(packet(1, 3, password)))
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Farm RCON timeout')) }, 5000)
    const finish = (error?: Error, value = '') => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value) }
    socket.on('error', finish)
    socket.on('data', (bytes: Buffer) => {
      buffered = Buffer.concat([buffered, bytes])
      while (buffered.length >= 4) {
        const length = buffered.readInt32LE(0); if (buffered.length < length + 4) break
        const id = buffered.readInt32LE(4), body = buffered.subarray(12, length + 2).toString(); buffered = buffered.subarray(length + 4)
        if (id === -1) return finish(new Error('Farm RCON authentication failed'))
        if (id === 1 && !authenticated) { authenticated = true; socket.write(packet(2, 2, command)) }
        else if (id === 2) finish(undefined, body)
      }
    })
  })
}

export async function runTeamWind(slot: number, helperPort: number, helperName: string, repetitions = 3, { position = false } = {}) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 32 || !Number.isInteger(helperPort) || helperPort < 8801 || helperPort > 9100 || !new RegExp(`^NeuroFarm${slot}[a-z]+$`).test(helperName) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('Explicit farm slot/helper required')
  const command = rconFor(slot), primaryName = `NeuroFarm${slot}`, first = peer(8800 + slot), second = peer(helperPort)
  const actors = [{ name: primaryName, rpc: first }, { name: helperName, rpc: second }]
  const X = 3000, Y = 150, Z = 3000, arena = { x: X, z: Z, r: 12, killY: Y - 8 }
  const board = new SwarmBoard('wind-test')
  const rows: any[] = []
  try {
    for (const actor of actors) {
      await actor.rpc.call('connect'); await actor.rpc.call('stop')
      const status = await actor.rpc.call('status')
      if (status?.detail?.server !== `127.0.0.1:${25600 + slot}`) throw new Error('RPC actor is not on the requested farm server')
    }
    if (position) {
      for (const narrow of [false, true]) for (const rise of [3, 11]) for (const actor of narrow ? [actors[0]] : actors) {
        await actor.rpc.call('stop')
        await command(`fill ${X - 6} ${Y - 8} ${Z - 4} ${X + 8} ${Y + 16} ${Z + 4} air`)
        await command(`fill ${X - 6} ${Y - 1} ${Z - 3} ${X + 8} ${Y - 1} ${Z + 3} stone`)
        const to = { x: X + 3.5, y: Y + rise, z: Z + .5 }
        if (narrow) await command(`setblock ${X + 3} ${Y + rise - 1} ${Z} stone`)
        else await command(`fill ${X + 2} ${Y + rise - 1} ${Z - 1} ${X + 4} ${Y + rise - 1} ${Z + 1} stone`)
        await command(`clear ${actor.name}`); await command(`gamemode survival ${actor.name}`)
        await command(`effect give ${actor.name} instant_health 1 10 true`)
        await command(`give ${actor.name} ender_pearl 16`)
        // Fixture setup before the action: this same body first observes the roof, then returns to the start.
        await command(`tp ${actor.name} ${to.x} ${to.y} ${to.z} -90 0`)
        for (const other of actors.filter(a => a !== actor)) await command(`tp ${other.name} ${X - 4.5} ${Y} ${Z - 2.5}`)
        await pause(1200)
        await actor.rpc.execute('swarm_position', { purpose: 'build', arena, radius: 3, methods: ['walk'], limit: 6 })
        await command(`tp ${actor.name} ${X + .5} ${Y} ${Z + .5} -90 0`)
        await pause(1200)
        const before = parsePoint(await command(`data get entity ${actor.name} Pos`))
        const count = async () => Number.parseFloat((await command(`data get entity ${actor.name} Inventory[{id:"minecraft:ender_pearl"}].count`)).split(':').at(-1)!)
        const beforeCount = await count()
        const candidates = await actor.rpc.execute('swarm_position', { purpose: 'ranged', arena, radius: 6, methods: ['pearl'], limit: 6 })
        const proposed = candidates.candidates?.find(c => Math.abs(c.at.x - to.x) < .01 && Math.abs(c.at.y - to.y) < .01 && Math.abs(c.at.z - to.z) < .01)
        if (!narrow && !proposed) { rows.push({ rise, narrow, actor: actor.name, ok: false, phase: 'observed_plan', candidates }); console.log(JSON.stringify(rows.at(-1))); continue }
        const receive = await actor.rpc.execute('pearl_to', { to, arena, observed: true })
        const actual = parsePoint(await command(`data get entity ${actor.name} Pos`))
        const health = Number.parseFloat((await command(`data get entity ${actor.name} Health`)).split(':').at(-1)!)
        const ground = /:\s*1b/.test(await command(`data get entity ${actor.name} OnGround`))
        const afterCount = await count()
        const ok = narrow ? !receive.ok && !receive.teleported && !proposed && beforeCount === 16 && afterCount === beforeCount && Math.hypot(actual.x - before.x, actual.y - before.y, actual.z - before.z) < .01 :
          !!receive.ok && !!receive.teleported && ground && health > 0 && Math.hypot(actual.x - to.x, actual.z - to.z) <= .22 && Math.abs(actual.y - to.y) <= .03
        rows.push({ rise, narrow, actor: actor.name, ok, target: to, before, actual, beforeCount, afterCount, health, ground, receive })
        console.log(JSON.stringify(rows.at(-1)))
      }
      console.log(JSON.stringify({ summary: 'observed-position-pearl', passed: rows.filter(row => row.ok).length, total: rows.length }))
      return rows
    }
    await command(`fill ${X - 6} ${Y - 8} ${Z - 4} ${X + 8} ${Y + 16} ${Z + 4} air`)
    await command(`fill ${X - 6} ${Y - 1} ${Z - 3} ${X + 2} ${Y - 1} ${Z + 3} stone`)
    await command(`fill ${X + 4} ${Y - 1} ${Z} ${X + 4} ${Y + 2} ${Z} stone`)
    const to = { x: X + 4.5, y: Y + 3, z: Z + .5 }
    for (let n = 0; n < repetitions; n++) for (const reverse of [false, true]) {
      const receiver = actors[reverse ? 1 : 0], thrower = actors[reverse ? 0 : 1]
      for (const actor of actors) {
        await actor.rpc.call('stop'); await command(`clear ${actor.name}`); await command(`gamemode survival ${actor.name}`)
        await command(`effect give ${actor.name} instant_health 1 10 true`)
      }
      await command(`give ${thrower.name} wind_charge 16`)
      await command(`tp ${receiver.name} ${X + .5} ${Y} ${Z + .5} -90 0`)
      await command(`tp ${thrower.name} ${X - 2.5} ${Y} ${Z + .5} -90 0`)
      await pause(1200)
      const report = { id: thrower.name, position: parsePoint(await command(`data get entity ${thrower.name} Pos`)), velocity: { x: 0, y: 0, z: 0 }, onGround: true }
      const receiverStart = parsePoint(await command(`data get entity ${receiver.name} Pos`))
      const dry = await receiver.rpc.execute('wind_receive', { thrower: report, to, arena, dryRun: true })
      if (!dry.ok || !dry.plan) { rows.push({ n, reverse, ok: false, phase: 'plan', why: dry.why }); console.log(JSON.stringify(rows.at(-1))); continue }
      const throwReady = await thrower.rpc.execute('wind_boost', { ally: receiver.name, plan: dry.plan, arena, dryRun: true })
      if (!throwReady.ok) { rows.push({ n, reverse, ok: false, phase: 'thrower', why: throwReady.why }); console.log(JSON.stringify(rows.at(-1))); continue }
      board.setMembers([{ id: receiver.name, team: 'wind-test', position: receiverStart, health: 20, strength: 20, role: 'fighter' }, { id: thrower.name, team: 'wind-test', position: report.position, health: 20, strength: 20, role: 'fighter' }])
      const id = `wind:${n}:${reverse}`
      board.upsert({ id, kind: 'goto', assignedTo: thrower.name, participants: [thrower.name, receiver.name], position: to, data: { skill: 'team-wind' } })
      const claim = board.claim(id, thrower.name, 15000)
      if (!claim || board.claim(id, receiver.name)) throw new Error('Pair claim was not exclusive')
      const worldAge = Number(/(\d+)\D*$/.exec(await command('time query gametime'))?.[1])
      const startTick = Math.max(dry.gameTick || 0, throwReady.gameTick || 0, worldAge) + 40
      const [receive, launch] = await Promise.all([
        receiver.rpc.execute('wind_receive', { thrower: report, to, plan: dry.plan, arena, startTick }),
        thrower.rpc.execute('wind_boost', { ally: receiver.name, plan: dry.plan, arena, startTick })
      ])
      const actual = parsePoint(await command(`data get entity ${receiver.name} Pos`))
      const health = Number.parseFloat((await command(`data get entity ${receiver.name} Health`)).split(':').at(-1)!)
      const ground = /:\s*1b/.test(await command(`data get entity ${receiver.name} OnGround`))
      const ok = !!receive.ok && !!receive.received && !!launch.fired && ground && health > 0 && Math.hypot(actual.x - to.x, actual.z - to.z) <= .22 && Math.abs(actual.y - to.y) <= .03
      const ack = board.ack(id, thrower.name, { token: claim.claim.token, confirmed: ok })
      board.releaseOwner(thrower.name)
      rows.push({ n, reverse, ok: ok && ack, startTick, target: to, actual, health, ground, receive, launch })
      console.log(JSON.stringify(rows.at(-1)))
    }
    console.log(JSON.stringify({ summary: 'team-wind', passed: rows.filter(row => row.ok).length, total: rows.length }))
    return rows
  } finally {
    for (const actor of actors) await actor.rpc.call('stop').catch(() => {})
    first.close(); second.close()
  }
}
if (require.main === module) {
  if (!process.argv[2] || process.argv.includes('--help')) console.log('node farm/team-wind-test.js <slot> <helper-ws-port> <NeuroFarmNhelper> [repetitions=3] [--position]; already-running owned farm, initial 20 TPS')
  else runTeamWind(Number(process.argv[2]), Number(process.argv[3]), process.argv[4], Number(process.argv[5] || 3), { position: process.argv.includes('--position') })
    .then(rows => { if (rows.some(row => !row.ok)) process.exitCode = 1 })
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
