import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { generate } from '../arena/colosseum-arms'
import { drive, native, worldOf } from './parkour-fixture'
import { swarmPositions } from '../src/swarm-position'
import { WIND, windBoost, windImpulse, windLanding, windReceive, type WindPairPlan } from '../src/combat/team-wind'
import { createDriverState } from '../../farm/swarm/swarm-driver/state'
import { createSwarmDriver } from '../../farm/swarm/swarm-driver'
import { swarmPosition } from '../../farm/swarm/swarm-driver/position'
import { swarmRetry } from '../../farm/swarm/swarm-driver/retry'
import { SwarmBoard } from '../src/swarm'

const layout = generate('team1'), arena = { x: 600.5, z: 600.5, r: 80, killY: 113, ellipse: layout.ellipse }
function field() {
  // The arena installer fills the field with sand at Y-1, then applies the seeded terrain.
  const cells: Array<[number, number, number, string]> = []
  for (let x = -23; x < -7; x++) for (let z = -9; z < 15; z++) cells.push([600 + x, 119, 600 + z, 'sand'])
  for (const [x, y, z, name] of layout.field) if (x >= -23 && x < -7 && z >= -9 && z < 15)
    cells.push([600 + x, 120 + y, 600 + z, name.split('[')[0].split('{')[0]])
  return cells
}

type Flight = { name: string; target: Vec3; shot: WindPairPlan['shot']; startTick: number; fired: boolean }

function group(bounds = arena, twoHelpers = false) {
  const cells = field(), pos = {}, bodies = new Map<string, any>()
  const landings = new Map<string, Vec3>(), fires: string[] = []
  const charge = { name: 'wind_charge', count: twoHelpers ? 1 : 3, slot: 36 }
  const charges = new Map([['Helper', charge], ['EastHelper', { ...charge }]])
  const flights = new Map<string, Flight>()
  let releaseFirst, firstStop, holdFirst = true
  const firstStopped = new Promise(resolve => { firstStop = resolve })
  const open = new Promise(resolve => { releaseFirst = resolve })
  const names = ['West', 'Center', 'East', 'Helper', ...(twoHelpers ? ['EastHelper'] : [])]
  const bots = names.map((name, i) => {
    const { bot, world } = worldOf(cells)
    const ammo = charges.get(name)
    Object.assign(bot.entity, { id: i + 1, username: name, type: 'player', width: .6, height: 1.8 })
    bot.entity.position.set(ammo ? (i === 4 ? 586.5 : 583.5) : 580.5 + i * 3, 120, ammo ? 607.9 : 604.5)
    Object.assign(bot, { username: name, _client: new EventEmitter(), ndClock: { age: 100n, ticks: 0, serverTicks: 0 } })
    drive(bot, world)
    bot.equip = async it => { bot.heldItem = it }
    bot.waitForTicks = async n => { bot.ndClock.ticks += n }
    bot.look = async (yaw, pitch) => { Object.assign(bot.entity, { yaw, pitch }) }
    bot.inventory.items = () => ammo ? (ammo.count ? [ammo] : []) : [{ name: 'arrow', count: 8 }, { name: 'bow', count: 1 }]
    if (ammo) bot.inventory.slots[36] = ammo
    bot.activateItem = () => {
      const currentFlight = flights.get(name)
      assert.ok(currentFlight && ammo?.count > 0)
      for (const other of bodies.values()) if (other.username !== currentFlight.name)
        assert.equal(windImpulse(other, other.entity.position, currentFlight.shot.burst).norm(), 0, other.username)
      currentFlight.fired = true
      fires.push(currentFlight.name); ammo.count--
      bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 10 })
    }
    bodies.set(name, bot)
    pos[name] = { p: { ...bot.entity.position }, hp: 20, inv: ammo ? { wind_charge: ammo.count } : { bow: 1, arrow: 8 } }
    return {
      name, team: 'blue', c: {
        async call(method) {
          if (method === 'stop' && holdFirst) { holdFirst = false; firstStop(); await open }
          return { detail: { physics: { pos: { ...bot.entity.position }, velocity: { ...bot.entity.velocity }, onGround: bot.entity.onGround } } }
        }
      }
    }
  })
  for (const bot of bodies.values()) {
    bot.entities = Object.fromEntries([...bodies.values()].filter(o => o !== bot).map(o => [o.entity.id, o.entity]))
    bot._ndSwarmAllies = bots.filter(b => b.name !== bot.username).map(b => b.name)
  }
  const advance = (flight: Flight, elapsed: number) => {
    const bot = bodies.get(flight.name), shot = flight.shot
    if (elapsed === shot.ticks && flight.fired) {
      const impulse = windImpulse(bot, bot.entity.position, shot.burst)
      bot.entity.velocity = bot.entity.velocity.plus(impulse)
      bot._client.emit('explosion', { center: shot.burst, radius: 1.2, explosionParticle: { type: 'gust_emitter_small' }, playerKnockback: impulse })
    }
    const state = new native.PlayerState(bot, bot.controlState)
    bot.physics.simulatePlayer(state, { getBlock: bot.blockAt }); state.apply(bot)
    bot.ndClock.ticks++; bot.emit('physicsTick')
  }
  const sw = createDriverState({ bots, pos, arena: bounds, alive: () => true, now: () => 1000, log() { } })
  const board = new SwarmBoard('blue', () => 1000), threatened = new Set<string>()
  board.setMembers(bots.map(b => ({ id: b.name, team: b.team, position: pos[b.name].p, health: 20, strength: 5, role: 'ranged', inventory: pos[b.name].inv })))
  const queries = new Map<string, number>()
  Object.assign(sw, swarmRetry(sw), {
    teamOf: b => b.team, detail: r => r.detail, panic: () => false,
    fighting: b => threatened.has(b.name), renew: (board, b, claim) => board.renew(claim.id, b.name, claim.claim.token),
    async execute(b, method, p) {
      const bot = bodies.get(b.name)
      if (method === 'swarm_position') {
        queries.set(b.name, (queries.get(b.name) || 0) + 1)
        return swarmPositions(bot, p)
      }
      if (method === 'wind_boost') return windBoost({ bot }, { aborted: false }, p)
      assert.equal(method, 'wind_receive')
      if (p.dryRun) return windReceive({ bot }, { aborted: false }, p)
      const owner = p.thrower.id, flight = { name: b.name, target: new Vec3(p.to.x, p.to.y, p.to.z), shot: p.plan.shot, startTick: p.startTick, fired: false }
      flights.set(owner, flight)
      const pending = windReceive({ bot }, { aborted: false }, p)
      // Both clients share the same start tick. Only a real activateItem issues the modeled server burst.
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      if (!twoHelpers) for (let i = 0; i < 98 && bot.listenerCount('physicsTick'); i++) advance(flight, i)
      const receipt = await pending
      if (receipt.ok) landings.set(b.name, new Vec3(receipt.at.x, receipt.at.y, receipt.at.z))
      const helper = bodies.get(owner); helper.ndClock.ticks = bot.ndClock.ticks
      pos[owner].inv.wind_charge = charges.get(owner).count; flights.delete(owner)
      return receipt
    }
  })
  const step = swarmPosition(sw).positionStep
  const context = { board, member: { reserve: {} }, members: bots.map(b => ({ id: b.name, position: pos[b.name].p })) }
  const roster = [bots[3], bots[0], { name: 'Absent1', team: 'blue' }, bots[1], { name: 'Absent2', team: 'blue' }, bots[2], ...bots.slice(4)]
  for (const b of bots) {
    const bodyCall = b.c.call
    b.c.call = async (method, params?) => {
      if (['swarm_position', 'wind_boost', 'wind_receive'].includes(method)) return { status: 'done', detail: await sw.execute(b, method, params) } as any
      return bodyCall(method)
    }
  }
  const driver = createSwarmDriver({
    bots: roster, pos, arena: bounds, alive: name => bodies.has(name), now: () => 1000,
    home: () => ({ x: 600.5, y: 120, z: 600.5 }), hostile: () => false, log() { }
  })
  const turn = i => { driver.observe(bots[i], []); return driver.turn(bots[i]) }
  return { step: i => step(bots[i], context, 'ranged'), turn, queries, firstStopped, releaseFirst, landings, fires, charge, bodies, threatened, charges, flights, advance }
}

test('two throwers launch distinct archers onto the team1 tier during the same flight window', async t => {
  const f = group(arena, true)
  f.releaseFirst()
  const turns = Promise.all([f.turn(0), f.turn(2)])
  const deadline = performance.now() + 2500
  while (f.fires.length < 2 && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.fires.length, 2)
  const flights = [...f.flights.values()]
  assert.equal(new Set(flights.map(r => r.startTick)).size, 1)
  let together = 0
  for (let i = 0; i < 98; i++) {
    for (const flight of flights) f.advance(flight, i)
    if (flights.every(r => !f.bodies.get(r.name).entity.onGround)) together++
    await new Promise(resolve => setImmediate(resolve))
  }
  await turns
  assert.ok(together > 0)
  const landed = [...f.landings.values()]
  assert.deepEqual([...f.charges.values()].map(c => c.count), [0, 0])
  assert.equal(new Set(landed.map(p => p.floored().toString())).size, 2)
  for (const flight of flights) {
    const body = f.bodies.get(flight.name), entity = body.entity
    assert.equal(entity.position.y, 123)
    assert.ok(windLanding(body, { pos: entity.position, vel: entity.velocity, onGround: entity.onGround }, flight.target))
  }
  t.diagnostic(JSON.stringify({ together, landings: landed }))
})

test('three archers board the team1 raised tier on separate charges after competing for one helper', async () => {
  const f = group()
  assert.ok(f.bodies.get('West').entity.position.distanceTo(f.bodies.get('East').entity.position) > WIND.reach * 2)
  const first = f.turn(0), second = f.turn(1)
  await f.firstStopped
  try { await Promise.race([first, second]) } finally { f.releaseFirst() }
  await Promise.all([first, second])
  for (let i = 0; i < 3; i++) await f.turn(i)
  assert.equal(f.landings.size, 3, JSON.stringify({ landings: [...f.landings], fires: f.fires, queries: [...f.queries] }))
  assert.equal(new Set([...f.landings.values()].map(p => p.floored().toString())).size, 3)
  assert.ok([...f.landings.values()].every(p => p.y === 123))
  assert.equal(f.charge.count, 0)
  assert.equal(new Set(f.fires).size, 3)
})

test('three archers keep the charges when their tier is outside the hard arena boundary', async () => {
  const f = group({ ...arena, x: 583.5, z: 605.8, r: 3.6 })
  f.releaseFirst()
  for (let i = 0; i < 3; i++) await f.turn(i)
  assert.equal(f.landings.size, 0)
  assert.equal(f.charge.count, 3)
  assert.equal(f.fires.length, 0)
})

test('a threatened thrower abandons the lift before spending any charge', async () => {
  const f = group(), pending = f.step(0)
  await f.firstStopped
  f.threatened.add('Helper'); f.releaseFirst()
  assert.equal(await pending, false)
  assert.equal(f.fires.length, 0)
  assert.equal(f.charge.count, 3)
})

test('reserved and newly occupied landings leave the native survey budget for other stands on the same tier', async () => {
  const f = group(), receiver = f.bodies.get('Center'), helper = f.bodies.get('Helper')
  const query = {
    purpose: 'ranged' as const, arena, radius: 12, limit: 6, windPartner: {
      id: helper.username,
      position: helper.entity.position, velocity: helper.entity.velocity, onGround: true
    }
  }
  const survey = async (windLandings = []) => (await swarmPositions(receiver, { ...query, windLandings })).candidates.filter(c => c.methods.some(m => m.skill === 'wind_receive'))
  const first = await survey()
  assert.equal(first.length, 2)
  const reserved = first.map(c => c.at)
  const elsewhere = await survey(reserved)
  assert.ok(elsewhere.length > 0 && elsewhere.every(c => c.at.y === 123 && !reserved.some(p => p.x === c.at.x && p.z === c.at.z)))
  const option = first[0], plan = option.methods[0].plan
  const prepare = () => windBoost({ bot: helper }, { aborted: false }, { ally: receiver.username, plan, dryRun: true, startTick: 140 })
  assert.equal((await prepare()).ok, true)
  const blocker = f.bodies.get('West').entity
  blocker.position.set(option.at.x, option.at.y, option.at.z)
  assert.equal((await prepare()).why, 'landing_changed')
  assert.ok((await survey()).every(c => c.at.x !== option.at.x || c.at.z !== option.at.z))
  blocker._ndVisible = false
  assert.equal((await prepare()).ok, true, 'a packet-only occupant cannot reveal a hidden player')
  assert.equal(f.charge.count, 3)
})
