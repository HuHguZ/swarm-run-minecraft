import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import * as edges from '../src/edges'
import * as pick from '../src/pick'
import * as enemy from '../src/combat/enemy-wind'
import { enemyWindExecute, enemyWindReport } from '../src/combat/enemy-wind-execute'
import { wingOrbit } from '../src/combat/wing-orbit'
import { windBlockImpact, windImpulse, windOutside, windOutward, type WindArena, type WindReport } from '../src/combat/team-wind'
import * as flight from '../src/elytra/flight'

const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()

/** Exact Colosseum 77x65 ellipse deck (semi-axes 38.5 x 32.5) above void (killY = 113). */
function colosseumWorld(floorY = 120) {
  const arena: WindArena = { x: .5, z: .5, r: 42, killY: 113, ellipse: { a: 38.5, b: 32.5 } }
  const world = {
    getBlock(p: Vec3) {
      const q = p.floored()
      const dx = (q.x + .5 - arena.x) / arena.ellipse!.a
      const dz = (q.z + .5 - arena.z) / arena.ellipse!.b
      const inside = dx * dx + dz * dz <= 1
      const name = inside && q.y === floorY - 1 ? 'smooth_sandstone' : 'air'
      const block = Block.fromStateId(registry.blocksByName[name].defaultState)
      block.position = q
      return block
    }
  }
  return { arena, world }
}

function makeBot(world: { getBlock(p: Vec3): any }, username = 'Blue0', pos = new Vec3(.5, 120, -4.5), gameTick = 100) {
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, username, health: 20, food: 20,
    game: { minY: -64, height: 384, gameMode: 'survival' },
    entity: { id: 1, username, position: pos.clone(), velocity: new Vec3(0, 0, 0),
      onGround: true, elytraFlying: false, yaw: 0, pitch: 0, width: .6, height: 1.8, effects: {}, attributes: {}, metadata: [] },
    entities: {}, players: {}, quickBarSlot: 0,
    inventory: { slots: Array(46).fill(null), items: () => [{ name: 'wind_charge', count: 64, slot: 36 }] },
    _client: Object.assign(new EventEmitter(), { write() {} }),
    ndClock: Object.assign(new EventEmitter(), { age: BigInt(gameTick), ticks: 0, serverTicks: 0, frozen: false, disposed: false,
      observationNow: () => gameTick * 50, observationRate: () => 20 }),
    blockAt: (p: Vec3) => world.getBlock(p),
    physics: native.Physics(registry, world),
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    getControlState: () => false, setControlState() {}, clearControlStates() {},
    setQuickBarSlot(s: number) { bot.quickBarSlot = s },
    activateItem() {},
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    lookAt: async () => {}
  })
  bot.inventory.slots[36] = { name: 'wind_charge', count: 64, slot: 36 }
  bot.world = { getBlock: (p: Vec3) => world.getBlock(p), raycast: require('prismarine-world/src/worldsync').prototype.raycast }
  return bot
}

function makeReport(id: string, pos: Vec3, gameTick: number, opts: Partial<WindReport> = {}): WindReport {
  return {
    id, position: pos.clone(), velocity: new Vec3(0, 0, 0), onGround: true, gliding: false,
    eyeHeight: 1.62, yaw: 0, pitch: 0, gameTick, attributes: {}, effects: {}, ...opts
  }
}

/** Exact 1.21.11 ProjectileUtil.computeMargin + AABB ray intersection for a live wind charge step. */
function exactBodyHit(origin: Vec3, velocity: Vec3, age: number, feet: Vec3) {
  const length = velocity.norm()
  const dir = velocity.scaled(1 / length)
  const margin = Math.max(0, Math.min(Math.fround(.3), Math.fround((age - 2) / 20)))
  const half = Math.fround(.6) / 2 + margin
  const t = pick.rayBox(origin, dir,
    { x: feet.x - half, y: feet.y - margin, z: feet.z - half },
    { x: feet.x + half, y: feet.y + Math.fround(1.8) + margin, z: feet.z + half }, length)
  return t !== null && t > 0 && t < length ? origin.plus(dir.scaled(t)) : null
}

test('near-rim knockoff on a moving/strafing target certifies void exit with exact 1.21.11 physics', () => {
  const { arena, world } = colosseumWorld(120)
  const bot = makeBot(world, 'Launcher', new Vec3(-.5, 120, 24.5), 100)
  const foePos = new Vec3(.5, 120, 32.2) // 0.8 blocks from +Z rim (z = 33.0), strafing & moving inward
  const foe: any = {
    id: 2, username: 'Runner', type: 'player', isValid: true, _ndVisible: true,
    position: foePos.clone(), velocity: new Vec3(.14, 0, -.04), onGround: true,
    width: .6, height: 1.8, yaw: Math.atan2(-.14, .04), pitch: 0, metadata: [0], equipment: [null, null, null, null, null, null]
  }
  bot.entities[2] = foe
  bot.players.Runner = { entity: foe, gamemode: 0 }
  const throwers = [
    makeReport('Launcher', new Vec3(-.5, 120, 24.5), 100),
    makeReport('Catcher', new Vec3(2.5, 120, 25.5), 100)
  ]
  const plan = enemy.planEnemyWind(bot, foe, throwers, {
    arena, startTick: 100, maxShots: 2, allies: throwers, reactAfterHit: true, waitForHit: false, juggle: true
  })
  assert.ok(plan, 'planner must find a knockoff chain for a strafing target near the rim')
  assert.equal(plan.nominal.out, true, 'nominal outcome must carry the strafing target over the rim')
  assert.equal(plan.shots.length, 2, 'reactive seal must chain follow-up shot when 1 shot is recoverable by inward sprint')

  // Step real 1.21.11 projectile + body physics: target holds observed strafe until first burst, then sprints inward.
  const sim = edges.simOf(bot)
  const state = edges.stateOf({ ...bot, entity: { ...foe, position: foePos.clone(), velocity: foe.velocity.clone(),
    onGround: true, elytraFlying: false, attributes: {}, effects: {} } }, edges.IDLE)
  const projs = plan.shots.map(s => ({ fireDelay: s.fireDelay, from: s.from.clone(), vel: s.velocity.clone(), active: true }))
  let hitCount = 0, exited = false
  for (let t = 1; t <= 80; t++) {
    if (hitCount > 0) {
      state.yaw = Math.atan2(state.pos.x - arena.x, state.pos.z - arena.z) // actively sprint back inward after hit
      state.control = { ...edges.IDLE, forward: true, sprint: true }
    } else {
      state.yaw = Math.atan2(-.14, .04)
      state.control = { ...edges.IDLE, forward: true, sprint: false }
    }
    sim(state, world)
    for (const p of projs) {
      if (!p.active) continue
      const age = t - p.fireDelay
      if (age <= 0) continue
      const origin = p.from.plus(p.vel.scaled(age - 1))
      const blk = windBlockImpact(bot, origin, p.vel.scaled(1 / p.vel.norm()), p.vel.norm(), p.vel.norm())
      const hit = exactBodyHit(origin, p.vel, age, state.pos)
      const burst = hit || (blk ? blk.pos : null)
      if (burst) {
        const imp = windImpulse(bot, state.pos, burst, { resistance: 0, eyeHeight: 1.62, height: 1.8 })
        if (imp.norm() > 0) { state.vel = state.vel.plus(imp); hitCount++ }
        p.active = false
      }
    }
    if (windOutside(arena, state.pos, .6) && state.pos.y < arena.killY!) { exited = true; break }
  }
  assert.ok(hitCount >= 2, `scheduled wind chain must land both hits on the strafing target (got ${hitCount})`)
  assert.equal(exited, true, `real 1.21.11 simulation must knock the sprinting/strafing target into void (final pos ${state.pos})`)
})

test('center-of-Colosseum multi-shot pop-up + mid-air juggle chain carries a walking/strafing target over the 77x65 rim into void', () => {
  const { arena, world } = colosseumWorld(120)
  let gameTick = 100, nowMs = 5000
  const bot = makeBot(world, 'Rear0', new Vec3(.5, 120, -4.5), gameTick)
  bot.ndClock.observationNow = () => nowMs
  const sim = edges.simOf(bot)
  // Start opponent 2 blocks off dead center of the 77x65 Colosseum (30.5 bl from +Z rim), actively walking/strafing toward center.
  const state = edges.stateOf({
    ...bot,
    entity: { id: 2, username: 'CenterFoe', position: new Vec3(.5, 120, 2.5), velocity: new Vec3(0, 0, -.05),
      onGround: true, elytraFlying: false, yaw: 0, pitch: 0, width: .6, height: 1.8, attributes: {}, effects: {} }
  }, edges.IDLE)
  // Fair 2-element visible position receipts (same contract as createLastSeen; never reads private enemy velocity).
  const receipts = [
    { x: .5, y: 120, z: 2.55, t: 4950, kind: 'rel_entity_move', grounded: true },
    { x: .5, y: 120, z: 2.5, t: 5000, kind: 'rel_entity_move', grounded: true }
  ]
  const foe: any = {
    id: 2, username: 'CenterFoe', type: 'player', isValid: true, _ndVisible: true, _ndMotionEpoch: 1,
    _ndObservationNow: () => nowMs, _ndPositionReceipts: receipts,
    position: state.pos.clone(), velocity: new Vec3(0, 0, 0), onGround: true,
    width: .6, height: 1.8, yaw: 0, pitch: 0, metadata: [], equipment: []
  }
  bot.entities[2] = foe
  bot.players.CenterFoe = { entity: foe, gamemode: 0 }

  const projs: Array<{ thrower: string; fireTick: number; from: Vec3; vel: Vec3 }> = []
  const cooldownUntil = new Map<string, number>()
  let totalHits = 0, multiShotChains = 0, airborneHits = 0, postRimHits = 0, voidExit = false, nextPlanTick = 100

  for (let tick = 0; tick < 220; tick++) {
    gameTick = 100 + tick
    nowMs = gameTick * 50
    bot.ndClock.age = BigInt(gameTick)
    foe.position = state.pos.clone()
    foe.onGround = state.onGround
    foe.yaw = state.yaw
    enemy.observeEnemyWindMotion(bot, foe)

    if (gameTick >= nextPlanTick) {
      const out = windOutward(arena, state.pos, .6), side = new Vec3(-out.z, 0, out.x)
      const back = 8 + Math.min(8, Math.max(0, state.pos.y - 120))
      const ready = [
        makeReport('Rear0', state.pos.minus(out.scaled(back)).offset(0, 120 - state.pos.y, 0), gameTick),
        makeReport('FlankL', state.pos.minus(out.scaled(back - 1)).plus(side.scaled(3.5)).offset(0, 120 - state.pos.y, 0), gameTick),
        makeReport('Wing0', state.pos.minus(out.scaled(7)).plus(side.scaled(2)).offset(0, 1.0, 0), gameTick,
          { onGround: false, gliding: true, eyeHeight: .4, velocity: out.scaled(.9), launchMovement: out.scaled(.9) }),
        makeReport('Wing1', state.pos.minus(out.scaled(7.5)).minus(side.scaled(2.5)).offset(0, 1.0, 0), gameTick,
          { onGround: false, gliding: true, eyeHeight: .4, velocity: out.scaled(.9), launchMovement: out.scaled(.9) })
      ].filter(r => (cooldownUntil.get(r.id) ?? -Infinity) <= gameTick)

      if (ready.length) {
        const plan = enemy.planEnemyWind(bot, foe, ready, {
          arena, startTick: gameTick, maxShots: Math.min(3, ready.length), allies: ready,
          reactAfterHit: true, waitForHit: false, juggle: true
        })
        if (plan && plan.shots.length) {
          if (plan.shots.length >= 2) multiShotChains++
          nextPlanTick = Math.max(...plan.shots.map(s => s.arrivalTick)) + 3
          for (const s of plan.shots) {
            projs.push({ thrower: s.thrower, fireTick: s.fireTick, from: s.from.clone(), vel: s.velocity.clone() })
            cooldownUntil.set(s.thrower, s.fireTick + 10)
          }
        }
      }
    }

    // Target continuously walks and strafes back toward Colosseum center on ground and in mid-air.
    const toCenter = Math.atan2(state.pos.x - arena.x, state.pos.z - arena.z)
    state.yaw = toCenter + Math.sin(tick * .2) * .35
    state.control = { ...edges.IDLE, forward: true, sprint: false }
    sim(state, world)

    const nextGt = gameTick + 1
    for (let i = projs.length - 1; i >= 0; i--) {
      const p = projs[i]
      const age = nextGt - p.fireTick
      if (age <= 0) continue
      const origin = p.from.plus(p.vel.scaled(age - 1))
      const blk = windBlockImpact(bot, origin, p.vel.scaled(1 / p.vel.norm()), p.vel.norm(), p.vel.norm())
      const hit = exactBodyHit(origin, p.vel, age, state.pos)
      const burst = hit || (blk ? blk.pos : null)
      if (burst) {
        const imp = windImpulse(bot, state.pos, burst, { resistance: 0, eyeHeight: 1.62, height: 1.8 })
        if (imp.norm() > 0) {
          if (!state.onGround) airborneHits++
          if (windOutside(arena, state.pos, .6)) postRimHits++
          state.vel = state.vel.plus(imp)
          totalHits++
        }
        projs.splice(i, 1)
      } else if (age > 25) {
        projs.splice(i, 1)
      }
    }
    receipts.push({ x: state.pos.x, y: state.pos.y, z: state.pos.z, t: nextGt * 50, kind: 'rel_entity_move', grounded: state.onGround })
    if (receipts.length > 2) receipts.shift()
    if (windOutside(arena, state.pos, .6) && state.pos.y < arena.killY!) { voidExit = true; break }
  }

  assert.ok(multiShotChains >= 3, `center carry must plan multi-shot pop-up + juggle chains (got ${multiShotChains})`)
  assert.ok(airborneHits >= 8, `juggle chain must land mid-air follow-up hits while target is airborne (got ${airborneHits})`)
  assert.ok(postRimHits >= 1, `escort should follow up after crossing the rim while target is airborne above killY (got ${postRimHits})`)
  assert.equal(voidExit, true, `target starting at Colosseum center must be carried all 30.5 bl over the 77x65 rim into void (hits=${totalHits}, final=${state.pos})`)
})

test('ground + elytra wing-bot relay carries a moving target over the rim with inherited elytra velocity and reactive seal', () => {
  const { arena, world } = colosseumWorld(120)
  const bot = makeBot(world, 'GroundLauncher', new Vec3(.5, 120, 24.5), 100)
  const foePos = new Vec3(.5, 120, 32.2) // 0.8 bl from +Z rim, strafing inward
  const foe: any = {
    id: 2, username: 'StrafeRim', type: 'player', isValid: true, _ndVisible: true,
    position: foePos.clone(), velocity: new Vec3(.14, 0, -.04), onGround: true,
    width: .6, height: 1.8, yaw: Math.atan2(-.14, .04), pitch: 0, metadata: [0], equipment: [null, null, null, null, null, null]
  }
  bot.entities[2] = foe
  bot.players.StrafeRim = { entity: foe, gamemode: 0 }

  // Ground launcher + orbiting elytra wing-bot gliding forward at 1.0 bl/tick toward the +Z rim with inherited velocity!
  const groundLauncher = makeReport('GroundLauncher', new Vec3(-.5, 120, 24.5), 100)
  const elytraWing = makeReport('ElytraWing', new Vec3(2.5, 122.0, 19.5), 100, {
    onGround: false, gliding: true, eyeHeight: .4,
    velocity: new Vec3(.05, -.01, 1.0), launchMovement: new Vec3(.05, -.01, 1.0), yaw: Math.PI, pitch: -.01
  })
  const plan = enemy.planEnemyWind(bot, foe, [groundLauncher, elytraWing], {
    arena, startTick: 100, maxShots: 2, allies: [groundLauncher, elytraWing],
    reactAfterHit: true, waitForHit: false, juggle: true
  })
  assert.ok(plan, 'ground + elytra wing-bot relay must produce a certified plan')
  assert.equal(plan.nominal.out, true, 'ground + elytra relay must knock moving target over the rim')
  assert.ok(plan.shots.some(s => s.thrower === 'ElytraWing'), 'elytra wing-bot must participate in the relay chain')
  assert.equal(plan.shots.length, 2, 'both ground launcher and elytra wing-bot must chain shots (reactive seal)')
  assert.notEqual(plan.shots[0].arrivalTick, plan.shots[1].arrivalTick, 'relay shots must arrive on distinct ticks')
  const wingShot = plan.shots.find(s => s.thrower === 'ElytraWing')!
  assert.ok(wingShot.velocity.norm() > 1.8, `elytra wing shot must inherit forward elytra velocity (got speed ${wingShot.velocity.norm().toFixed(2)})`)

  // Step real 1.21.11 physics with active inward sprint after impact to prove the relay finishes into void.
  const sim = edges.simOf(bot)
  const state = edges.stateOf({ ...bot, entity: { ...foe, position: foePos.clone(), velocity: foe.velocity.clone(),
    onGround: true, elytraFlying: false, attributes: {}, effects: {} } }, edges.IDLE)
  const projs = plan.shots.map(s => ({ fireDelay: s.fireDelay, from: s.from.clone(), vel: s.velocity.clone(), active: true }))
  let hitCount = 0, exited = false
  for (let t = 1; t <= 80; t++) {
    if (hitCount > 0) {
      state.yaw = Math.atan2(state.pos.x - arena.x, state.pos.z - arena.z)
      state.control = { ...edges.IDLE, forward: true, sprint: true }
    } else {
      state.yaw = Math.atan2(-.14, .04)
      state.control = { ...edges.IDLE, forward: true, sprint: false }
    }
    sim(state, world)
    for (const p of projs) {
      if (!p.active) continue
      const age = t - p.fireDelay
      if (age <= 0) continue
      const origin = p.from.plus(p.vel.scaled(age - 1))
      const blk = windBlockImpact(bot, origin, p.vel.scaled(1 / p.vel.norm()), p.vel.norm(), p.vel.norm())
      const hit = exactBodyHit(origin, p.vel, age, state.pos)
      const burst = hit || (blk ? blk.pos : null)
      if (burst) {
        const imp = windImpulse(bot, state.pos, burst, { resistance: 0, eyeHeight: 1.62, height: 1.8 })
        if (imp.norm() > 0) { state.vel = state.vel.plus(imp); hitCount++ }
        p.active = false
      }
    }
    if (windOutside(arena, state.pos, .6) && state.pos.y < arena.killY!) { exited = true; break }
  }
  assert.equal(exited, true, `ground + elytra relay must knock reacting target into void (hits=${hitCount}, final=${state.pos})`)
})

test('pendingWindHit matches sprinting/re-aimed scheduled shot #1 and enemyWindExecute keeps preceding on moving-target re-aim', async t => {
  const { arena, world } = colosseumWorld(120)
  let gameTick = 104
  const bot = makeBot(world, 'Catcher', new Vec3(.5, 120, 20.5), gameTick)
  const foe: any = {
    id: 2, username: 'StrafeFoe', type: 'player', isValid: true, _ndVisible: true,
    position: new Vec3(3.6, 120, 28.5), velocity: new Vec3(.2, 0, 0), onGround: true,
    width: .6, height: 1.8, yaw: -Math.PI / 2, pitch: 0, metadata: [], equipment: []
  }
  bot.entities[2] = foe
  bot.players.StrafeFoe = { entity: foe, gamemode: 0 }
  const launcher = { id: 3, username: 'Launcher', type: 'player', position: new Vec3(.5, 120, 18.5) }
  bot.entities[3] = launcher

  // 1) Sprinting/gliding scheduled Shot #1 fired 2.6 bl from planned `from` with modest release re-aim matches `scheduled`.
  const scheduledShot1: any = {
    thrower: 'Launcher', fireTick: 102, arrivalTick: 108, fireDelay: -2, ticks: 6,
    from: new Vec3(.5, 121.62, 18.5), velocity: new Vec3(.1, 0, 1.49),
    feet: new Vec3(.5, 120, 27.5), aim: new Vec3(.5, 121, 27.5), burst: new Vec3(.5, 121, 27.5)
  }
  // Register live wind_charge entity from Launcher shifted 2.6 bl with slight re-aim (~5 deg).
  const projId = 77
  const liveVel = new Vec3(.22, 0, 1.48)
  bot.entities[projId] = {
    id: projId, name: 'wind_charge', position: new Vec3(.5, 121.62, 24.0), velocity: liveVel.clone(),
    _ndVisible: true, _ndObservationNow: () => gameTick * 50,
    _ndPositionReceipts: [
      { x: .5, y: 121.62, z: 22.52, t: (gameTick - 1) * 50, kind: 'rel_entity_move' },
      { x: .5, y: 121.62, z: 24.0, t: gameTick * 50, kind: 'rel_entity_move' }
    ],
    _ndWindMotion: { t: gameTick * 50, position: new Vec3(.5, 121.62, 24.0), velocity: liveVel.clone() }
  }
  bot._ndThrown = new Map([[projId, { name: 'wind_charge', owner: 3, p: new Vec3(.5, 121.62, 21.0), observedAt: (gameTick - 2) * 50 }]])
  const frames = enemy.enemyWindFrames(bot, foe, arena, [scheduledShot1], 0, true)
  const pending = enemy.pendingWindHit(bot, foe, frames, [scheduledShot1])
  assert.equal(pending, null, 'sprinting/re-aimed scheduled shot #1 must match `scheduled` instead of false-aborting shot #2')

  // 2) enemyWindExecute Shot #2 with coordination keeps `preceding` and fires even when target shifted > WIND.reach (3.1 bl) from planned shot.feet.
  let sentUse = 0
  bot.activateItem = () => { sentUse++; bot.inventory.slots[36].count-- }
  const session: any = { bot, current: null }
  const ord = enemyWindReport(session, { target: 'StrafeFoe', coordination: 'chain-1' })
  assert.equal(ord.ok, true)
  const plannedShot2: any = {
    thrower: 'Catcher', fireTick: 104, arrivalTick: 110, fireDelay: 0, ticks: 6, aimHeight: 1.0,
    from: new Vec3(.5, 121.62, 20.5), velocity: new Vec3(0, 0, 1.5),
    feet: new Vec3(.5, 120, 28.5), aim: new Vec3(.5, 121, 28.5), burst: new Vec3(.5, 121, 28.5)
  }
  const ctl: any = { aborted: false, onAbort: [] }
  const exec = enemyWindExecute(session, ctl, {
    arena, coordination: 'chain-1',
    plan: { target: 'StrafeFoe', gameTick: 100, resistance: { lo: 0, hi: 0 }, shots: [scheduledShot1, plannedShot2] }
  })
  // Trigger native movement packet (afterPacket) then advance ticks so launchConfirmed completes.
  await new Promise(r => setImmediate(r))
  bot.emit('ndMovementSent')
  await new Promise(r => setImmediate(r))
  for (let i = 0; i < 12; i++) { gameTick++; bot.ndClock.age = BigInt(gameTick); bot.emit('physicsTick') }
  const res = await exec
  assert.equal(res.fired, true, `shot #2 must re-aim cleanly on moving target shifted > WIND.reach: ${JSON.stringify(res)}`)
  assert.equal(sentUse, 1)
})

test('wingOrbit flies smooth wide arcs without 180-deg overhead spin or rapid sweep flip and leads moving ground targets', async t => {
  const { arena, world } = colosseumWorld(120)
  let nowMs = 10_000
  t.mock.method(clock, 'now', () => nowMs)
  const bot = makeBot(world, 'Wing', new Vec3(0.5, 126, 20.5), 100)
  bot.entity.onGround = false
  bot.entity.elytraFlying = true
  bot.entity.velocity = new Vec3(.9, 0, .2)
  bot.inventory.slots[6] = { name: 'elytra', count: 1 }
  bot.inventory.items = () => [{ name: 'elytra', count: 1 }, { name: 'firework_rocket', count: 8 }, { name: 'wind_charge', count: 4 }]
  const foe: any = Object.assign(new EventEmitter(), {
    id: 2, username: 'Mover', type: 'player', isValid: true, _ndVisible: true,
    position: new Vec3(.5, 120, 20.5), onGround: true, width: .6, height: 1.8, metadata: [],
    _ndObservationNow: () => nowMs,
    _ndPositionReceipts: [
      { x: .5, y: 120, z: 20.25, t: nowMs - 50, grounded: true, kind: 'rel_entity_move' },
      { x: .5, y: 120, z: 20.5, t: nowMs, grounded: true, kind: 'rel_entity_move' }
    ]
  })
  Object.defineProperty(foe, 'velocity', { get() { throw new Error('must not read private enemy velocity') } })
  bot.entities[2] = foe
  bot.players.Mover = { entity: foe, gamemode: 0 }

  let goals: Vec3[] = []
  t.mock.method(flight, 'fly', async (_b: any, _ctl: any, opts: any) => {
    // 1) Directly overhead (d = 0..1.5 < minCleanD): two slightly opposite positions must NOT flip goal by 180°.
    bot.entity.position = new Vec3(.5, 126, 20.0)
    const g1 = opts.goal().at.clone()
    bot.entity.position = new Vec3(.5, 126, 21.0)
    const g2 = opts.goal().at.clone()
    goals.push(g1, g2)
    assert.ok(g1.distanceTo(g2) < 2, `passing overhead must hold smooth exit angle instead of snapping 180° (delta=${g1.distanceTo(g2).toFixed(2)})`)

    // 2) Verify horizontal velocity lead on moving ground target (moving +Z at +0.25 bl/tick via real relative receipts).
    bot.entity.position = new Vec3(.5, 124, 5.0) // far on center side
    nowMs += 50
    foe.position = new Vec3(.5, 120, 20.75)
    foe._ndPositionReceipts = [
      { x: .5, y: 120, z: 20.5, t: nowMs - 50, grounded: true, kind: 'rel_entity_move' },
      { x: .5, y: 120, z: 20.75, t: nowMs, grounded: true, kind: 'rel_entity_move' }
    ]
    foe.emit('ndPositionObserved')
    opts.goal() // prime vision receipt
    nowMs += 50
    foe.position = new Vec3(.5, 120, 21.0)
    foe._ndPositionReceipts = [
      { x: .5, y: 120, z: 20.75, t: nowMs - 50, grounded: true, kind: 'rel_entity_move' },
      { x: .5, y: 120, z: 21.0, t: nowMs, grounded: true, kind: 'rel_entity_move' }
    ]
    foe.emit('ndPositionObserved')
    const gLead = opts.goal().at.clone()
    // Target is now at z=21.0 moving +Z (+0.25/t); with R=8 and center-side ai=-pi/2 (cos=0, sin=-1),
    // unled z would be 21.0 - 8 = 13.0; led z must be > 13.5 (never reading private foe.velocity).
    assert.ok(gLead.z > 13.5, `wingOrbit must lead moving ground target along observed velocity (got z=${gLead.z.toFixed(2)})`)

    // 3) Smooth arc progression at sweep boundary (no 92° snap across the tail, 1500ms flip hysteresis).
    bot.entity.position = new Vec3(7.5, 124, 15.0) // rel ≈ +0.78 on center-side arc
    const beforeFlip = opts.goal().at.clone()
    nowMs += 100 // within 1500ms cooldown
    const rightAfter = opts.goal().at.clone()
    const ang = (p: Vec3) => Math.atan2(p.z - 20.5, p.x - .5)
    const diff = Math.abs(Math.atan2(Math.sin(ang(rightAfter) - ang(beforeFlip)), Math.cos(ang(rightAfter) - ang(beforeFlip))))
    assert.ok(diff < .6, `sweep reversal must glide smoothly without snapping 92° behind the tail (diff=${diff.toFixed(2)} rad)`)
    return { why: 'done' }
  })
  t.mock.method(flight, 'land', async () => ({ ok: true }))
  await wingOrbit({ bot, require: () => bot, current: null }, { aborted: false }, { target: 'Mover', arena, floorY: 120 })
  assert.equal(goals.length, 2)
})
