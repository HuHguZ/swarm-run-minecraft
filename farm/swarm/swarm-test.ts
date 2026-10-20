// Native proof only: three idle farm daemons on slot 31, no FFA driver or human player.
// Run with farm/swarm-arena-run.ps1; every success needs an RPC receipt and a server block check.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { REPO_ROOT } from '../../daemon/src/paths'
const ROOT = REPO_ROOT
const WebSocket = require(path.join(ROOT, 'daemon/node_modules/ws'))
import { SwarmBoard, addBlueprint, nextBuild, type SwarmMember } from '../../daemon/src/swarm'
import { swarmBlueprint } from '../../daemon/src/swarm-work'
import { createSwarmDriver } from './swarm-driver'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const workers = [{ name: 'NeuroFarm31', port: 8831 }, { name: 'NeuroFarm31c', port: 8961 }, { name: 'NeuroFarm31d', port: 8962 }]
const X = 3000, Y = 220, Z = 3000
const evidence: any = { startedAt: new Date().toISOString(), nativeRun: true, slot: 31, workers, targetTPS: 100, checks: {}, passed: false }
const out = path.join(REPO_ROOT, 'farm/results', `swarm-native-${Date.now()}.json`)
const rcon = command => execFileSync(process.execPath, [path.join(__dirname, '..', 'farm.js'), 'rcon', '31', command],
  { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true }).trim()
const at = p => `${p.x} ${p.y} ${p.z}`
const blockIs = (p, block) => /passed/i.test(rcon(`execute if block ${at(p)} minecraft:${block}`))
const detail = r => r.detail ?? r
const packetRows = () => (fs.existsSync(process.env.ND_SWARM_PACKET_LOG || '') ? fs.readFileSync(process.env.ND_SWARM_PACKET_LOG, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [])
const maceOnly = process.env.SWARM_NATIVE_CASES === 'mace'

function client (port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map<number, any>(); let id = 0
  const ready = new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error) } pending.clear() }
  ws.on('error', fail); ws.on('close', () => fail(new Error(`RPC ${port} closed`)))
  ws.on('message', data => {
    let m; try { m = JSON.parse(String(data)) } catch { return fail(new Error(`RPC ${port} invalid JSON`)) }
    const p = pending.get(m.id); if (!p) return
    pending.delete(m.id); clearTimeout(p.timer)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || `RPC ${port} rejected`))
  })
  return { ready, call: async (method, params: any = {}) => {
    await ready
    return new Promise<any>((resolve, reject) => {
      const rid = ++id
      const timer = setTimeout(() => { pending.delete(rid); reject(new Error(`RPC ${port} ${method} timeout`)) }, 45000)
      pending.set(rid, { resolve, reject, timer }); ws.send(JSON.stringify({ id: rid, method, params }))
    })
  }, close: () => ws.terminate() }
}

async function maceScene(clients) {
  rcon(`fill ${X - 18} ${Y} ${Z - 18} ${X + 24} ${Y + 18} ${Z + 18} air`)
  rcon(`fill ${X + 7} ${Y} ${Z - 1} ${X + 7} ${Y + 1} ${Z + 2} stone`)
  const starts = [{ x: X + .5, y: Y, z: Z + .5 }, { x: X + 4.5, y: Y, z: Z + .5 }, { x: X + 6.5, y: Y, z: Z + .5 }]
  for (const [k, w] of workers.entries()) {
    rcon(`team leave ${w.name}`)
    rcon(`clear ${w.name}`); rcon(`tp ${w.name} ${at(starts[k])}`)
    rcon(`effect give ${w.name} instant_health 1 5 true`)
  }
  for (const k of [0, 2]) for (const [slot, item] of [['armor.head', 'netherite_helmet'], ['armor.chest', 'netherite_chestplate'], ['armor.legs', 'netherite_leggings'], ['armor.feet', 'netherite_boots']])
    rcon(`item replace entity ${workers[k].name} ${slot} with ${item}[enchantments={protection:4}]`)
  rcon(`give ${workers[0].name} mace[enchantments={density:3,wind_burst:3}] 1`)
  rcon(`give ${workers[0].name} wind_charge 32`)
  await Promise.all(clients.map(c => c.call('stop'))); await sleep(300)
  const hand = await clients[0].call('equip', { item: 'mace', destination: 'hand' })
  const offhand = await clients[0].call('equip', { item: 'wind_charge', destination: 'off-hand' })
  const before = await Promise.all(clients.map(c => c.call('status', { items: true, swarm: true, physics: true })))
  assert.ok(before.every(s => s.state.health === 20), 'measured fight starts at actual full own HUD health')
  assert.ok(before[0].detail.items.some(i => i.name === 'mace' && i.ench?.wind_burst === 3 && i.ench?.density === 3))
  assert.equal(before[0].state.held, 'mace'); assert.equal(before[0].state.offHand?.item, 'wind_charge')
  assert.ok(before[0].detail.sightings.some(e => e.id === workers[1].name && e.visible && e.equipment?.armor?.length === 0))
  assert.ok(before[0].detail.sightings.some(e => e.id === workers[2].name && e.visible && e.equipment?.armor?.length === 4))
  const started = Date.now(), packetStart = packetRows().length, samples = []
  let settled = false
  const resultPromise = clients[0].call('fight', { target: workers[1].name, targets: [workers[1].name, workers[2].name],
    allowPlayer: true, allowRanged: false, retreatAtHealth: 0, timeoutSeconds: 20, arena: { x: X + 3, y: Y - 1, z: Z, r: 18 } })
    .then(result => { settled = true; return result })
  while (!settled && Date.now() - started < 7000) {
    await sleep(100)
    const states = await Promise.all(clients.map(c => c.call('status', { physics: true })))
    samples.push({ at: Date.now(), states: states.map(s => ({ health: s.state.health, position: s.detail.physics?.pos, velocity: s.detail.physics?.velocity, onGround: s.detail.physics?.onGround })) })
  }
  if (!settled) await clients[0].call('stop')
  const result = await resultPromise, rows = packetRows().slice(packetStart).filter(r => r.name === workers[0].name)
  const ownAfter = await clients[0].call('status', { items: true, physics: true })
  const charges = s => s.detail.items.filter(i => i.name === 'wind_charge').reduce((n, i) => n + i.count, 0)
  const windCharges = { before: charges(before[0]), after: charges(ownAfter), used: charges(before[0]) - charges(ownAfter) }
  const attacks = rows.filter(r => r.kind === 'use_entity' && r.packet.mouse === 1)
  const weak = attacks.find(r => r.target?.name === workers[1].name)
  const rebound = weak && rows.find(r => r.kind === 'lift' && r.at > weak.at && r.velocity.y > .15)
  const second = rebound && attacks.find(r => r.target?.name === workers[2].name && r.at > rebound.at)
  const fallingSmash = r => !!r && r.onGround === false && r.velocity?.y < 0 && r.fallDistance > 1.5
  evidence.mace = { scope: 'native fight RPC; stationary weak and armored fixture actors; victim HUD health is telemetry only',
    fixture: { independentScoreboardActors: true, physicalBackstop: { x: X + 7, y0: Y, y1: Y + 1, z0: Z - 1, z1: Z + 2 }, hand, offhand },
    before: before.map(s => ({ health: s.state.health, armor: s.state.armor, ownEnchants: s.detail.ownEnchants, position: s.detail.physics.pos })),
    started, wallMs: Date.now() - started, result, attacks, rebound, packets: rows, samples, windCharges,
    firstWeak: attacks[0]?.target?.name === workers[1].name, firstFallingSmash: fallingSmash(weak), secondFallingSmash: fallingSmash(second), chainAfterActualBounce: !!second }
  evidence.checks.nativeMaceChain = evidence.mace.firstWeak && fallingSmash(weak) && !!rebound && fallingSmash(second) && windCharges.used === 1
}

async function main () {
  const nt: NativeTest = { clients: [], fixture: false }
  const { clients } = nt
  try {
    await nativeSetup(nt)
    if (!maceOnly) {
      await nativeBuild(nt)
      await nativeHidden(nt)
      await nativeStop(nt)
      await nativeShelter(nt)
      await nativePanic(nt)
      const { confirmed, shelterCells } = nt
    assert.equal(evidence.checks.fullShelter, true, `native shelter incomplete: ${confirmed}/${shelterCells.length}`)
    }
    await maceScene(clients)
    assert.equal(evidence.checks.nativeMaceChain, true, 'native mace did not demonstrate a weak-first attack and a second authorized target after real rebound')
    evidence.passed = true
  } catch (error) { evidence.error = error.stack; process.exitCode = 1 } finally {
    const cleanup = await Promise.allSettled(clients.map(async (c, k) => {
      await c.call('stop')
      // Saved test actors must not reconnect over a platform removed below them.
      if (nt.fixture) rcon(`spreadplayers 600 600 1 8 false ${workers[k].name}`)
      await c.call('disconnect', { reason: 'swarm native proof complete' })
    }))
    evidence.cleanup = cleanup.map(r => r.status === 'fulfilled' ? { ok: true } : { ok: false, error: String(r.reason) })
    for (const c of clients) c.close()
    if (nt.fixture) try {
      rcon(`fill ${X - 18} ${Y - 1} ${Z - 18} ${X + 24} ${Y + 18} ${Z + 18} air`)
      rcon(`forceload remove ${X - 20} ${Z - 20} ${X + 26} ${Z + 20}`)
    } catch (error) { evidence.fixtureCleanupError = error.message; evidence.passed = false; process.exitCode = 1 }
    if (cleanup.some(r => r.status === 'rejected')) { evidence.passed = false; process.exitCode = 1 }
    evidence.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ passed: evidence.passed, checks: evidence.checks, out, error: evidence.error }))
  }
}

// One native proof run (former consts and lets of main): the worker clients, whether the platform fixture was made,
// and what one check hands to the next.
interface NativeTest {
  clients: any[]; fixture: boolean; members?: SwarmMember[]; cells?: any[]; digCell?: any; confirmed?: number; shelterCells?: any[]
}

// Empty slot, a fresh platform, three survival bodies on it, a measured accelerated lockstep clock.
async function nativeSetup (nt: NativeTest) {
  const { clients } = nt
  assert.ok(!/passed/i.test(rcon('execute if entity @a')), 'scene requires an empty slot; stop its FFA driver first')
  rcon('tick rate 20')
  rcon(`forceload add ${X - 20} ${Z - 20} ${X + 26} ${Z + 20}`)
  nt.fixture = true
  rcon(`fill ${X - 18} ${Y} ${Z - 18} ${X + 24} ${Y + 5} ${Z + 18} air`)
  rcon(`fill ${X - 18} ${Y - 1} ${Z - 18} ${X + 24} ${Y - 1} ${Z + 18} stone`)
  for (const w of workers) clients.push(client(w.port))
  await Promise.all(clients.map(c => c.ready))
  await Promise.all(clients.map(c => c.call('connect', { bootstrapPaused: true })))
  await Promise.all(clients.map(c => c.call('temper', { enabled: false })))
  const members: SwarmMember[] = workers.map((w, k) => ({ id: w.name, team: 'blue', role: 'miner-builder', health: 20, strength: 20,
    position: { x: X + k * 4 + .5, y: Y, z: Z + .5 } }))
  for (const m of members) {
    rcon(`gamemode survival ${m.id}`); rcon(`tp ${m.id} ${at(m.position)}`)
    rcon(`clear ${m.id}`); rcon(`give ${m.id} cobblestone 16`); rcon(`give ${m.id} diamond_pickaxe 1`)
    rcon(`effect give ${m.id} saturation 60 5 true`)
  }
  await Promise.all(clients.map(c => c.call('stop')))
  await sleep(1500)
  const initial = await Promise.all(clients.map(c => c.call('status', { physics: true, items: true })))
  evidence.initial = initial.map(s => ({ state: s.state, physics: s.detail.physics }))
  for (const [k, s] of initial.entries()) {
    assert.equal(s.detail.server, '127.0.0.1:25631')
    assert.equal(s.state.clock?.lockstep, true, 'accelerated native lockstep must be enabled')
    assert.ok(s.detail.items.some(i => i.name === 'cobblestone'))
    assert.ok(Math.hypot(s.detail.physics.pos.x - members[k].position.x, s.detail.physics.pos.z - members[k].position.z) < .5)
  }
  rcon('tick rate 100')
  const gameTime = () => Number(/The time is (\d+)/i.exec(rcon('time query gametime'))?.[1])
  const wall0 = Date.now(), game0 = gameTime(); await sleep(1000)
  const game1 = gameTime(), wall1 = Date.now()
  evidence.clock = { query: rcon('tick query'), wallMs: wall1 - wall0, ticks: game1 - game0, measuredTPS: (game1 - game0) * 1000 / (wall1 - wall0) }
  assert.ok(Number.isFinite(evidence.clock.measuredTPS) && evidence.clock.ticks > 0)
  nt.members = members
}

// Three bodies place three unique wall cells at once; repeated and remote cells; a protected support is not dug.
async function nativeBuild (nt: NativeTest) {
  const { clients, members } = nt
  const board = new SwarmBoard('blue', () => Date.now())
  board.setMembers(members)
  const cells = members.map((m, k) => ({ id: String(k), position: { x: Math.floor(m.position.x), y: Y, z: Z - 2 }, block: 'cobblestone' }))
  addBlueprint(board, { id: 'native-wall', cells })
  const tasks = members.map(m => nextBuild(board, m, 10000))
  assert.ok(tasks.every(Boolean)); assert.equal(new Set(tasks.map(t => t.id)).size, 3)
  const protectedCells = members.map(m => ({ x: Math.floor(m.position.x), y: Y - 1, z: Z }))
  const rows = await Promise.all(tasks.map(async (task, k) => {
    const started = Date.now()
    const receipt = detail(await clients[k].call('swarm_work', { kind: 'place', at: task.position, item: 'cobblestone',
      protected: protectedCells, allies: workers.map(w => w.name), timeoutSeconds: 5 }))
    const finished = Date.now()
    assert.equal(receipt.done, true, JSON.stringify(receipt))
    const serverConfirmed = blockIs(task.position, 'cobblestone')
    assert.ok(serverConfirmed)
    assert.ok(board.ack(task.id, members[k].id, { token: task.claim.token, confirmed: true, position: task.position, block: 'cobblestone' }))
    return { name: workers[k].name, task: task.id, claim: task.claim, started, finished, receipt, serverConfirmed }
  }))
  evidence.build = { rows, overlap: Math.max(...rows.map(r => r.started)) < Math.min(...rows.map(r => r.finished)), tasks: board.tasks() }
  assert.equal(evidence.build.overlap, true)
  assert.equal(evidence.build.tasks.filter(t => t.status === 'done').length, 3)
  evidence.checks.parallelUniqueBuild = true
  const repeated = detail(await clients[0].call('swarm_work', { kind: 'place', at: cells[0].position, item: 'cobblestone', allies: workers.map(w => w.name), timeoutSeconds: 5 }))
  assert.equal(repeated.done, true, JSON.stringify(repeated)); assert.ok(blockIs(cells[0].position, 'cobblestone'))
  const remote = detail(await clients[0].call('swarm_work', { kind: 'place', at: cells[2].position, item: 'cobblestone', allies: workers.map(w => w.name), timeoutSeconds: 5 }))
  assert.equal(remote.done, false, 'remote occupied cells cannot be claimed as our local hand work')
  evidence.alreadyPlaced = { repeated, remote }; evidence.checks.localExistingCellOnly = true

  const floor = protectedCells[0]
  const protectedResult = detail(await clients[0].call('swarm_work', { kind: 'dig', at: floor, protected: [floor], timeoutSeconds: 5 }))
  assert.equal(protectedResult.why, 'protected_cell'); assert.ok(blockIs(floor, 'stone'))
  evidence.protection = protectedResult; evidence.checks.protectedSupport = true
  nt.cells = cells
}

// A hidden enemy is not seen and does not stop a dig; the visible one does; the reacquired one has no hidden speed.
async function nativeHidden (nt: NativeTest) {
  const { clients, cells } = nt
  const wall = `fill ${X + 1} ${Y} ${Z - 3} ${X + 1} ${Y + 3} ${Z + 3}`
  rcon(`${wall} stone`); rcon(`tp ${workers[2].name} ${X + 2.5} ${Y} ${Z + .5}`)
  rcon(`give ${workers[2].name} diamond_sword 1`)
  await sleep(300)
  const hidden = detail(await clients[0].call('status', { swarm: true }))
  assert.ok(Array.isArray(hidden.sightings))
  assert.ok(!hidden.sightings.some(e => e.id === workers[2].name || e.name === workers[2].name || e.username === workers[2].name))
  evidence.hidden = hidden.sightings; evidence.checks.hiddenEnemyDenied = true
  rcon(`tp ${workers[2].name} ${X + 2.8} ${Y} ${Z + .5}`); await sleep(100)
  const hiddenMoved = detail(await clients[0].call('status', { swarm: true }))
  assert.ok(!hiddenMoved.sightings.some(e => e.id === workers[2].name))
  evidence.hiddenAfterPacket = hiddenMoved.sightings
  const digCell = cells[0].position
  rcon(`setblock ${at(digCell)} obsidian`); await sleep(200)
  let settled = false
  const threatened = clients[0].call('swarm_work', { kind: 'dig', at: digCell, allies: [workers[1].name], timeoutSeconds: 15 })
    .then(r => { settled = true; return detail(r) })
  await sleep(100)
  const digging = detail(await clients[0].call('status', { physics: true }))
  assert.equal(settled, false, 'hidden player must not stop the ongoing dig')
  assert.deepEqual(digging.physics.targetDig, digCell, 'native mining must actually start')
  rcon(`${wall} air`)
  const aborted = await threatened
  assert.equal(aborted.aborted, true, JSON.stringify(aborted)); assert.equal(aborted.why, 'direct_threat')
  assert.ok(blockIs(digCell, 'obsidian'))
  evidence.threat = { digging: digging.physics.targetDig, receipt: aborted, retained: true }; evidence.checks.threatAbort = true
  const reacquired = detail(await clients[0].call('status', { swarm: true })).sightings.find(e => e.id === workers[2].name)
  assert.ok(reacquired?.visible); assert.ok(Math.abs(reacquired.position.x - X - 2.8) < .1)
  assert.deepEqual(reacquired.velocity, { x: 0, y: 0, z: 0 }, 'hidden displacement is not observed running speed')
  assert.ok(!('health' in reacquired) && !('inventory' in reacquired))
  evidence.reacquired = reacquired; evidence.checks.visibleEnemyReacquired = true
  nt.digCell = digCell
}

// An external stop aborts an ongoing dig and keeps the block.
async function nativeStop (nt: NativeTest) {
  const { clients, members, digCell } = nt
  rcon(`tp ${workers[2].name} ${X + 10.5} ${Y} ${Z + .5}`)
  rcon(`tp ${workers[0].name} ${at(members[0].position)}`); await sleep(300)
  const cancellable = clients[0].call('swarm_work', { kind: 'dig', at: digCell, allies: workers.map(w => w.name), timeoutSeconds: 15 })
  await sleep(100)
  const beforeStop = detail(await clients[0].call('status', { physics: true }))
  assert.deepEqual(beforeStop.physics.targetDig, digCell)
  await clients[0].call('stop')
  const cancelled = detail(await cancellable)
  assert.equal(cancelled.aborted, true); assert.ok(blockIs(digCell, 'obsidian'))
  evidence.stop = { before: beforeStop.physics.targetDig, receipt: cancelled, retained: true }; evidence.checks.externalAbort = true
}

async function nativeShelter (nt: NativeTest) {
  const { clients, members } = nt
  // Same support dependency graph as the production adapter, with three explicit builder roles.
  rcon(`fill ${X - 6} ${Y} ${Z - 6} ${X + 12} ${Y + 5} ${Z + 6} air`)
  const origin = { x: X + 4, y: Y, z: Z }
  const stances = [{ x: X + 3.5, y: Y, z: Z + .5 }, { x: X + 4.5, y: Y, z: Z + 1.5 }, { x: X + 5.5, y: Y, z: Z + .5 }]
  for (const [k, w] of workers.entries()) {
    rcon(`tp ${w.name} ${at(stances[k])}`); rcon(`clear ${w.name}`)
    rcon(`give ${w.name} cobblestone 64`); rcon(`give ${w.name} iron_pickaxe 1`)
  }
  await Promise.all(clients.map(c => c.call('stop'))); await sleep(300)
  const shelter = swarmBlueprint('shelter', origin)
  const shelterCells: any[] = shelter.cells.map(c => ({ id: at(c.at), position: c.at, block: 'cobblestone' }))
  const supported = new Set(shelterCells.filter(c => c.position.y === Y).map(c => c.id))
  while (supported.size < shelterCells.length) {
    const cell = shelterCells.find(c => !supported.has(c.id) && shelterCells.some(o => supported.has(o.id) && Math.hypot(o.position.x - c.position.x, o.position.y - c.position.y, o.position.z - c.position.z) === 1))
    assert.ok(cell, 'blueprint has unsupported cells')
    const support = shelterCells.find(o => supported.has(o.id) && Math.hypot(o.position.x - cell.position.x, o.position.y - cell.position.y, o.position.z - cell.position.z) === 1)
    cell.dependsOn = [support.id]; supported.add(cell.id)
  }
  const walls = shelterCells.filter(c => c.position.y < Y + 2).map(c => c.id)
  for (const c of shelterCells.filter(c => c.position.y === Y + 2)) c.dependsOn = [...new Set([...(c.dependsOn || []), ...walls])]
  const full = new SwarmBoard('blue', () => Date.now())
  const builders = members.map((m, k) => ({ ...m, position: stances[k] }))
  full.setMembers(builders); addBlueprint(full, { id: 'full-native-shelter', cells: shelterCells })
  const fullStarted = Date.now(), buildDeadline = fullStarted + 60000, attempts = []
  let stalled = 0, maxConcurrent = 0
  while (Date.now() < buildDeadline && full.tasks().some(t => t.status !== 'done') && stalled < 20) {
    const jobs = builders.map((m, k) => ({ k, m, task: nextBuild(full, m, 25000) })).filter(j => j.task)
    assert.equal(new Set(jobs.map(j => j.task.id)).size, jobs.length)
    maxConcurrent = Math.max(maxConcurrent, jobs.length)
    if (!jobs.length) break
    const progress = await Promise.all(jobs.map(async ({ k, m, task }) => {
      const params = { kind: 'place', at: task.position, item: 'cobblestone', protected: shelter.protected, allies: workers.map(w => w.name), timeoutSeconds: 3 }
      let receipt = detail(await clients[k].call('swarm_work', params))
      const moves = []; let poses = []
      if (!receipt.done && !receipt.aborted && Date.now() < buildDeadline) {
        poses = detail(await clients[k].call('swarm_pose', { at: task.position })).poses || []
        if (!poses.length) {
          const doorway = { x: origin.x + .5, y: origin.y, z: origin.z - 2.5 }
          const moved = await clients[k].call('goto', { ...doorway, range: .25, timeoutSeconds: 4, surface: 'strict', _hunt: true })
          moves.push({ pose: doorway, doorway: true, status: moved.status, detail: detail(moved) })
          poses = detail(await clients[k].call('swarm_pose', { at: task.position })).poses || []
        }
        const tried = new Set<string>()
        for (let attempt = 0; attempt < 4; attempt++) {
          if (Date.now() >= buildDeadline) break
          const pose = poses.find(p => !tried.has(at(p)))
          if (!pose) break
          tried.add(at(pose))
          const moved = await clients[k].call('goto', { ...pose, range: .25, timeoutSeconds: 4, surface: 'strict', _hunt: true })
          moves.push({ pose, status: moved.status, detail: detail(moved) })
          poses = detail(await clients[k].call('swarm_pose', { at: task.position })).poses || []
          if (moved.status === 'failed') continue
          receipt = detail(await clients[k].call('swarm_work', params))
          if (receipt.done || receipt.aborted) break
        }
      }
      const accepted = receipt.done && receipt.after === 'cobblestone' && blockIs(task.position, 'cobblestone') &&
        full.ack(task.id, m.id, { token: task.claim.token, confirmed: true, position: receipt.at, block: receipt.after })
      full.release(task.id, m.id, task.claim.token)
      if (!accepted) full.upsert({ ...task, priority: (task.priority || 60) - 1 })
      if (attempts.length < 250) attempts.push({ worker: m.id, workerPose: { ...m.position }, task: task.id, claim: task.claim, receipt, poses, moves, accepted: !!accepted })
      return accepted ? 1 : 0
    }))
    const made = progress.reduce((a, b) => a + b, 0)
    const positions = await Promise.all(clients.map(c => c.call('status', { physics: true })))
    for (const [k, s] of positions.entries()) builders[k].position = s.detail.physics.pos
    full.setMembers(builders)
    stalled = made ? 0 : stalled + 1
    console.log(JSON.stringify({ shelter: full.tasks().filter(t => t.status === 'done').length, total: shelterCells.length, stalled }))
    if (!made) await sleep(100)
  }
  const finalTasks = full.tasks(), blockChecks = shelterCells.map(c => ({ id: c.id, at: c.position, confirmed: blockIs(c.position, 'cobblestone') }))
  const confirmed = blockChecks.filter(c => c.confirmed).length
  evidence.fullShelter = { scope: 'real board and worker RPC, production support dependencies, three explicit builder roles', started: fullStarted, packets: packetRows().filter(r => r.at >= fullStarted && r.kind === 'block_dig'), total: shelterCells.length,
    done: finalTasks.filter(t => t.status === 'done').length, serverConfirmed: confirmed, maxConcurrent, wallMs: Date.now() - fullStarted, attempts, tasks: finalTasks, blockChecks }
  evidence.checks.fullShelter = confirmed === shelterCells.length && evidence.fullShelter.done === shelterCells.length
  Object.assign(nt, { confirmed, shelterCells })
}

async function nativePanic (nt: NativeTest) {
  const { clients } = nt
  // Production coordinator receives only each ally's own state and the shared sight provider.
  rcon(`fill ${X - 18} ${Y} ${Z - 18} ${X + 24} ${Y + 5} ${Z + 18} air`)
  const panicStarts = [{ x: X + .5, y: Y, z: Z - .5 }, { x: X + .5, y: Y, z: Z + 1.5 }]
  const actor = workers[2].name, actorAt = { x: X + 6.5, y: Y, z: Z + .5 }
  for (const [k, w] of workers.entries()) {
    rcon(`clear ${w.name}`); rcon(`tp ${w.name} ${at(k < 2 ? panicStarts[k] : actorAt)}`)
  }
  for (const [slot, item] of [['armor.head', 'netherite_helmet'], ['armor.chest', 'netherite_chestplate'], ['armor.legs', 'netherite_leggings'], ['armor.feet', 'netherite_boots']])
    rcon(`item replace entity ${actor} ${slot} with ${item}[enchantments={protection:4}]`)
  rcon(`item replace entity ${actor} weapon.mainhand with netherite_sword[enchantments={sharpness:5}]`)
  await Promise.all(clients.map(c => c.call('stop'))); await sleep(300)
  const calls = [], messages = [], pos: any = {}
  const blue = workers.slice(0, 2).map((w, k) => ({ name: w.name, team: 'blue', c: { call: async (method, params = {}) => {
    const row: any = { name: w.name, method, params, started: Date.now() }; calls.push(row)
    row.result = await clients[k].call(method, params); row.finished = Date.now(); return row.result
  } } }))
  const driver = createSwarmDriver({ bots: blue, pos, alive: name => pos[name]?.hp > 0, arena: { x: X + 3, z: Z, r: 18 },
    home: () => ({ x: X - 5, y: Y, z: Z }), hostile: (_b, id) => id === actor, log: line => messages.push(line), arms: false })
  const before = await Promise.all(blue.map((b, k) => clients[k].call('status', { swarm: true, enchants: true, physics: true })))
  const panicBefore = before.map(s => ({ position: { ...s.detail.physics.pos }, health: s.state.health }))
  for (const [k, s] of before.entries()) pos[blue[k].name] = { p: s.detail.physics.pos, hp: s.state.health, inv: s.state.inventory || {}, armor: s.state.armor || {}, potions: s.state.potions || {}, enchants: s.detail.ownEnchants || [] }
  for (const [k, s] of before.entries()) {
    assert.ok(s.detail.sightings.some(e => e.id === actor && e.visible && e.equipment?.weapon === 'netherite_sword' && e.equipment?.armor?.length === 4 && e.equipment.enchanted), 'fixture must really show an armored opponent')
    driver.observe(blue[k], s.detail.sightings)
  }
  const observerRows = packetRows()
  assert.ok(blue.every(b => observerRows.some(r => r.kind === 'attached' && r.name === b.name)), 'outgoing packet observer must be attached to both own clients')
  const packetStart = observerRows.length, panic = blue.map(b => driver.panic(b))
  assert.ok(panic.every(Boolean), 'both poor allies must assess the visible fight as unsafe')
  await Promise.all(blue.map(b => driver.turn(b)))
  const after = await Promise.all(blue.map((_b, k) => clients[k].call('status', { physics: true })))
  const away = after.map((s, k) => ({ name: blue[k].name, before: panicBefore[k].position, beforeHealth: panicBefore[k].health, after: s.detail.physics.pos, afterHealth: s.state.health,
    beforeDist: Math.hypot(panicBefore[k].position.x - actorAt.x, panicBefore[k].position.z - actorAt.z),
    afterDist: Math.hypot(s.detail.physics.pos.x - actorAt.x, s.detail.physics.pos.z - actorAt.z) }))
  const attacks = packetRows().slice(packetStart).filter(r => blue.some(b => b.name === r.name) && r.kind === 'use_entity' && r.packet.mouse === 1)
  evidence.panic = { scope: 'actual production driver, two unarmored allies, stationary scripted armored opponent', panic, sightings: before.map(s => s.detail.sightings), calls, messages, away, attacks, packetLog: process.env.ND_SWARM_PACKET_LOG, board: driver.snapshot() }
  assert.ok(calls.filter(r => r.method === 'flee').length === 2 && !calls.some(r => r.method === 'fight'))
  assert.ok(away.every(r => r.afterDist > r.beforeDist + 2), 'both actors must physically move away')
  assert.equal(attacks.length, 0, 'no outgoing attack packets during the retreat')
  evidence.checks.nativePanicRetreat = true
}
main().catch(error => { console.error(error); process.exitCode = 1 })
