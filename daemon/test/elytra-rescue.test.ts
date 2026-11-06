import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { Session } from '../src/session'
import { EventBus } from '../src/events'
import * as clock from '../src/game-clock'
import * as flight from '../src/elytra/flight'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const registry = require('prismarine-registry')('1.21.11')

function fixture(p: any = {}) {
  const bot: any = new EventEmitter(), calls: any[] = [], flights: any[] = [], goals: any[] = []
  bot.version = '1.21.11'; bot.registry = registry; bot._client = new EventEmitter()
  bot.health = p.hp ?? 20
  bot.entity = { position: new Vec3(70, p.y ?? 125, 0), velocity: new Vec3(0, p.vy ?? -1, 0),
    onGround: false, elytraFlying: !!p.flying, yaw: 0, pitch: 0 }
  bot.inventory = { slots: [], items: () => [] }
  bot.waitForTicks = async () => {}
  const pad = p.pad || new Vec3(69, 120, 0)
  const W = p.world || { solid: () => { throw new Error('rescue must not scan ridge') }, boxHit: () => false,
    floorBelow: () => p.noFloor ? null : { top: p.floor ?? 120, water: !!p.water },
    landingSafe: () => !p.water }
  bot.blockAt = pos => {
    const at = pos.floored(), floor = !p.noFloor && at.y === (p.floor ?? 120) - 1
    return { position: at, name: floor ? p.water ? 'water' : 'stone' : 'air', boundingBox: floor && !p.water ? 'block' : 'empty',
      shapes: floor && !p.water ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  const S = { fd: p.fd ?? 0, lastY: bot.entity.position.y, driving: p.driving ?? 0 }
  let probes = 0
  const sky: any = {
    flightControl: (_b, ctl) => ctl, install: () => S, worldOf: () => W, kit: () => ({ elytra: true, rockets: p.rockets ?? 1 }),
    gliding: b => b.elytraFlying, wearingElytra: () => true, plainRocket: () => false,
    startGlide: () => { calls.push('glide'); bot.entity.elytraFlying = true; return true },
    toHotbar: async () => { calls.push('hotbar') },
    rollout: () => ({ kind: p.kind ?? null, fd: p.predFd ?? 0, p: { y: p.endY ?? 124 } }),
    headroom: (w, at, n) => typeof p.headroom === 'function' ? p.headroom(w, at, n) : p.headroom ?? 5,
    landingSpot: (b, w, o) => { probes++; return p.landingSpot ? p.landingSpot(b, w, o) : probes > (p.missingProbes ?? 0) ? pad : null },
    escape: async (_b, ctl, e, o) => {
      calls.push({ escape: e.username, arena: o.arena })
      if (p.escapeDeath) bot.health = 0
      if (p.escapeAbort) ctl.aborted = true
      p.onEscape?.()
      return { ok: !p.escapeFailed, note: p.escapeFailed ? 'нет площадки' : 'уход', hp1: bot.health }
    },
    fly: async (_b, ctl, o) => {
      flights.push(o)
      for (let n = 0; n < 20; n++) goals.push(o.goal())
      assert.equal(ctl.aborted, false)
      bot.entity.position = pad.offset(0, 2, 0); bot.entity.velocity.y = -.1
      if (p.touch) {
        const ground = { x: pad.x, y: p.touchY ?? pad.y, z: pad.z }
        bot.entity.position = new Vec3(ground.x, ground.y, ground.z)
        if (p.abortAfterTouch) ctl.aborted = true
        return { why: 'сел', ground }
      }
      return { why: o.until() }
    },
    land: async (_b, _ctl, o) => {
      calls.push('land'); assert.equal(o.at.x, pad.x)
      bot.entity.position = pad; bot.entity.onGround = true; bot.entity.elytraFlying = false
      return { ok: true }
    },
    chestDown: async () => {
      calls.push('chest')
      if (p.groundFlicker) bot.entity.onGround = false
      if (p.chestDeath) bot.health = 0
      if (p.chestOutside) bot.entity.position.x = 90
      if (p.chestSlip) bot.entity.position.y -= 2
      return { ok: true }
    }
  }
  bot.players = { HuHguZ: { entity: { username: 'HuHguZ', position: new Vec3(69, 120, 0) } } }
  const session: any = { bot, _ndFoes: p.foes || [], require: () => bot, runIntent: async (name, work, options) => {
    calls.push({ name, params: options.params })
    return p.run ? { status: 'done', detail: await work({ aborted: false }) } : { status: 'done' }
  } }
  const file = path.join(__dirname, '../src/rpc/aerial.js'), native = createRequire(file)
  const mod = { exports: {} as any }
  vm.runInNewContext(readFileSync(file, 'utf8'), { module: mod, exports: mod.exports,
    require: name => name === '../elytra' ? sky : name === '../pvp/last-seen' ? { createLastSeen: () => ({
      observe: e => e && p.visible ? { ...e, position: e.position.clone(), _ndVisible: true } : null,
      visible: e => !!e?._ndVisible, close: () => calls.push('sight-close')
    }) } : native(name), console: { log () {} } })
  return { bot, session, calls, flights, goals, methods: mod.exports.aerialMethods({ session }), probes: () => probes }
}

test('rescue above the local scan window descends toward observed field support instead of chasing an ever higher cruise', async () => {
  for (const y of [204, 484]) for (const rockets of [0, 3]) {
    const W = { boxHit: () => false, landingSafe: () => true,
      floorBelow: (_x, atY, _z, depth) => atY >= 120 && atY - depth <= 120 ? { top: 120 } : null }
    const f = fixture({ run: true, y, rockets, world: W, pad: new Vec3(70.5, 120, .5),
      landingSpot: require('../src/elytra/flight').landingSpot })
    const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true, arena: { x: 0, z: 0, r: 80 } })
    assert.equal(f.goals[0].at.y, 124, 'the observed lower pad must replace the upward cruise target')
    assert.equal(f.goals[0].minY, 120)
    assert.equal(f.flights[0].rocketIf({ p: new Vec3(70, y, 0), v: new Vec3(0, 0, 0) }), false,
      'no rocket merely because the current 80-block scan cannot reach the known field')
    assert.equal(r.detail.ok, true)
  }
})

test('rescue: leave a low ceiling through a visible opening before climbing toward the safe field', async () => {
  for (const wall of [false, true]) for (const y of [115.8, 114.8]) {
    const world = {
      solid: (x, y, z) => y === 118 && x >= 68 && z >= -2,
      boxHit: (x, y, z, h = 1.8) =>
        x + .3 > 68 && z + .3 > -2 && y < 119 && y + h > 118 ||
        wall && x - .3 < 69 && x + .3 > 68 && y < 118 && y + h > 114,
      floorBelow: () => null, landingSafe: () => false
    }
    const f = fixture({ run: true, y, noFloor: true, missingProbes: Infinity, world,
      headroom: require('../src/elytra/physics').headroom })
    await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true, arena: { x: 0, z: 0, r: 80 } })
    const opening = f.goals[0].at
    assert(opening.x > 60 && opening.x < 75, 'nearby opening, not the field underneath the ceiling')
    assert.equal(opening.y, y, 'first move laterally below the obstruction')
    assert(!world.boxHit(opening.x, opening.y, opening.z, .6))
    if (wall) assert(opening.z < -2, 'the nearer opening across a wall is unreachable')
    else assert(opening.x < 68)
    f.bot.entity.position = opening.offset(wall ? 0 : -1.1, -.9, wall ? -1.1 : 0)
    const climb = f.flights[0].goal()
    assert.equal(climb.at.x, f.bot.entity.position.x, 'use the clear column actually reached, even after overshooting the point')
    assert.equal(climb.at.z, f.bot.entity.position.z)
    assert.equal(climb.at.y, 124, 'climb at the opening instead of returning underneath the floor')
    f.bot.entity.position.y = 121
    assert.equal(f.flights[0].goal().at.x, 0, 'above the floor resume the supplied destination')
  }
})

test('rescue: accumulated fall, lethal equality, glider impact and slow descent into kill zone', async () => {
  for (const [p, expected] of [
    [{ fd: 24 }, 1], [{ y: 143 }, 1], [{ y: 125 }, 0], [{ fd: 24, water: true }, 0],
    [{ flying: true, kind: 'floor', predFd: 30 }, 1], [{ flying: true }, 0],
    [{ flying: true, y: 114.5, vy: -.08, endY: 113.85 }, 1],
    [{ flying: true, y: 140, vy: -.08, endY: 139.4 }, 0], [{ fd: 24, rockets: 0 }, 1]
  ] as Array<[any, number]>) {
    const f = fixture({ ...p, driving: p.flying ? 1 : 0 })
    await f.methods.rescue_config({ safe: { x: 0, y: 120, z: 0 }, killY: 113, arena: { x: 0, z: 0, r: 80 } })
    f.bot.emit('physicsTick')
    assert.equal(f.calls.filter(c => c.name === 'fly_to').length, expected, JSON.stringify(p))
  }
})

test('rescue: a glide without a task or pilot lands while rising; active flight and reflex keep their hands', async () => {
  for (const [x, vy, driving, current, reflex, expected] of [
    [-82, .45, 0, false, false, 1], [-82, -.3, 0, false, false, 1], [-78, .45, 0, false, false, 1],
    [-82, -.3, 1, false, false, 0], [-78, .45, 0, true, false, 0], [-78, .45, 0, false, true, 0]
  ] as const) {
    const f = fixture({ y: 174, vy, flying: true, kind: 'outside', endY: 173, noFloor: true, driving })
    f.bot.entity.position.x = x
    if (current) f.session.current = { name: 'wing_orbit' }
    if (reflex) f.session.reflex = Promise.resolve()
    await f.methods.rescue_config({ safe: { x: 0, y: 120, z: 0 }, killY: 113, arena: { x: 0, z: 0, r: 80 } })
    f.bot.emit('physicsTick')
    assert.equal(f.calls.filter(c => c.name === 'fly_to').length, expected, JSON.stringify({ x, vy, driving }))
  }
})

test('orbit hands the live intent to combat without unmanaged rescue, while lethal fall still triggers it', async t => {
  const p = { flying: true, y: 150, vy: -.1, endY: 149 }, f = fixture(p)
  const game = clock.activate(new clock.GameClock({ manual: true }))
  const session = f.session, calls: any[] = []
  const original = new Session({}, new EventBus(), { state: {}, append () {} })
  Object.assign(session, original, { bot: f.bot, tactics: { enabled: () => false },
    require: () => f.bot, updateMovements: () => {}, state: () => ({ busy: session.current?.name }) })
  session.cancel = Session.prototype.cancel
  session.runIntent = function (name, work, options) {
    if (name === 'fly_to') { calls.push(options.params); return Promise.resolve({ status: 'done' }) }
    return Session.prototype.runIntent.call(this, name, work, options)
  }
  f.bot.pathfinder = { setGoal () {} }; f.bot.clearControlStates = () => {}
  f.bot.inventory.slots[6] = { name: 'elytra', count: 1 }
  f.bot.inventory.items = () => [{ name: 'firework_rocket', count: 8 }, { name: 'wind_charge', count: 2 }]
  f.bot.players.Foe = { entity: { id: 2, type: 'player', name: 'player', username: 'Foe', isValid: true,
    position: new Vec3(74, 150, 0), velocity: new Vec3(0, 0, 0), onGround: false, metadata: [] } }
  let fought = 0, landed = 0
  t.mock.method(flight, 'fly', async (_bot, ctl, options) => {
    assert.equal(session.current.ctl, ctl)
    f.bot.players.Foe.entity.metadata[0] = 0x80
    game.advanceTicks(2)
    return { why: options.until() }
  })
  t.mock.method(require('../src/combat'), 'fight', async (owner, ctl) => {
    fought++
    assert.equal(owner, session)
    assert.equal(session.current.name, 'wing_orbit')
    assert.equal(session.current.ctl, ctl)
    assert.equal(ctl.aborted, false)
    f.bot.emit('physicsTick')
    assert.equal(calls.length, 0, 'no return-to-center RPC at the combat handoff')
    p.endY = 112; f.bot.entity.position.y = 114.4; f.bot.entity.velocity.y = -1
    f.bot.emit('physicsTick')
    assert.equal(calls.length, 1, 'ownership never suppresses a lethal fall')
    assert.equal(calls[0].rescue, true)
    return { hits: 1 }
  })
  t.mock.method(flight, 'land', async () => {
    landed++; f.bot.entity.onGround = true; f.bot.entity.elytraFlying = false
    return { ok: true }
  })
  t.mock.method(flight, 'chestDown', async () => ({ ok: true }))
  try {
    await f.methods.rescue_config({ safe: { x: 0, y: 120, z: 0 }, killY: 113, arena: { x: 0, z: 0, r: 80 } })
    const result = await f.methods.wing_orbit({ target: 'Foe', seconds: 12, floorY: 120, arena: { x: 0, z: 0, r: 80 } })
    assert.equal(result.status, 'done')
    assert.equal(fought, 1)
    assert.equal(landed, 1)
    assert.equal(session.current, null)
    assert.equal(game.timers.size, 0)
  } finally { session.cancel(); game.dispose() }
})

test('rescue: a disconnected body cannot start a flight using the new connection configuration', async () => {
  const f = fixture({ flying: true, noFloor: true, y: 114, vy: -1 })
  await f.methods.rescue_config({ safe: { x: 0, y: 120, z: 0 }, killY: 113, arena: { x: 0, z: 0, r: 80 } })
  f.session.bot = {}
  f.bot.emit('physicsTick')
  assert.equal(f.calls.filter(c => c.name === 'fly_to').length, 0)
})

test('rescue: hp5, local pad, no ridge scan; glide works with one or zero rockets', async () => {
  for (const rockets of [0, 1]) {
    const f = fixture({ hp: 5, run: true, rockets })
    const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true,
      arena: { x: 0, z: 0, r: 80 } })
    assert.equal(r.detail.ok, true)
    assert.equal(r.detail.hp, 0)
    assert.equal(f.flights[0].goal().at.x, 69)
    assert.equal(f.flights[0].noRocket(), false)
    assert.equal(f.calls.includes('glide'), true)
    assert.equal(f.calls.includes('land'), true)
    assert.equal(f.calls.includes('chest'), true)
  }
})

test('rescue: missing pad keeps a controlled goal and retries the local search', async () => {
  const f = fixture({ hp: 5, run: true, missingProbes: 1 })
  const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true })
  assert.equal(r.detail.ok, true)
  assert.equal(f.probes(), 2)
})

test('rescue: no local support heads toward the supplied safe point instead of hovering over the void', async () => {
  const f = fixture({ run: true, missingProbes: Infinity })
  await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true, arena: { x: 0, z: 0, r: 80 } })
  const goal = f.flights[0].goal()
  assert.equal(goal.at.x, 0)
  assert.equal(goal.at.z, 0)
})

test('rescue: without a visible pad keep climbing through clear air; a found pad keeps its height', async () => {
  for (const missing of [false, true]) for (const room of [3, 6]) {
    const f = fixture({ run: true, missingProbes: missing ? Infinity : 0, headroom: room })
    await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true })
    f.bot.entity.position = new Vec3(70, 155, 0)
    const goal = f.flights[0].goal()
    assert.equal(goal.at.y, missing ? 155 + Math.min(4, room - 1) : 120 + Math.min(4, room - 1))
    assert.equal(goal.minY, missing ? goal.at.y : 120)
  }
})

test('rescue: actual touchdown survives an onGround flicker; unsafe contacts stay failures', async () => {
  for (const [p, ok] of [
    [{ touch: true }, true], [{ groundFlicker: true }, true],
    [{ touch: true, touchY: 113 }, false], [{ touch: true, water: true }, false],
    [{ chestDeath: true }, false], [{ chestOutside: true }, false], [{ chestSlip: true }, false]
  ] as Array<[any, boolean]>) {
    const f = fixture({ run: true, ...p })
    const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true,
      arena: { x: 0, z: 0, r: 80 } })
    assert.equal(r.detail.ok, ok, JSON.stringify(p))
  }
})

test('rescue: unsafe contact, death and supersession keep distinct reasons and failed guards', async () => {
  for (const [p, why, guard] of [
    [{ touch: true, touchY: 72, floor: 72 }, 'unsafe_contact', 'minY'],
    [{ touch: true, water: true }, 'unsafe_contact', 'dry'],
    [{ touch: true, abortAfterTouch: true }, 'flight_superseded', 'active'],
    [{ chestDeath: true }, 'death', 'alive'],
    [{ chestSlip: true }, 'не сел безопасно', 'support']
  ] as Array<[any, string, string]>) {
    const f = fixture({ run: true, ...p })
    const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true,
      arena: { x: 0, z: 0, r: 80 } })
    assert.equal(r.detail.ok, false, JSON.stringify(p))
    assert.equal(r.detail.why, why, JSON.stringify(p))
    const d = r.detail.contact
    const guards: Record<string, unknown> = { minY: d.before.minY, dry: d.before.dry,
      active: d.active, alive: d.alive, support: d.current.support }
    assert.equal(guards[guard], false, JSON.stringify(p))
    if (guard === 'minY') assert.equal(d.before.minFloorY, 114)
    if (guard === 'support') assert.equal(d.touchdown, true)
  }
})

test('rescue: a failed enemy escape tries local support within the remaining budget; death, abort and expiry do not retry', async t => {
  let now = 1000
  t.mock.method(require('../src/game-clock'), 'now', () => now)
  for (const p of [{ elapsed: 2400 }, { elapsed: 15000 }, { elapsed: 2400, escapeDeath: true }, { elapsed: 2400, escapeAbort: true }]) {
    now = 1000
    const f = fixture({ run: true, foes: ['HuHguZ'], visible: true, escapeFailed: true,
      ...p, onEscape: () => { now += p.elapsed } })
    const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, timeoutSeconds: 15, killY: 113, rescue: true,
      arena: { x: 0, z: 0, r: 80 } })
    const retry = p.elapsed < 15000 && !p.escapeDeath && !p.escapeAbort
    assert.equal(f.flights.length, retry ? 1 : 0, JSON.stringify(p))
    assert.equal(r.detail.ok, retry, JSON.stringify(p))
    if (retry) {
      assert.equal(f.flights[0].phase, 'спасение')
      assert.equal(f.flights[0].maxMs, 12600, 'failed escape time is not renewed')
      assert.equal(f.calls.includes('land'), true)
    } else assert.equal(r.detail.why, p.escapeDeath ? 'death' : p.escapeAbort ? 'flight_superseded' : 'нет площадки')
    assert.equal(f.calls.filter(c => c.escape).length, 1)
    assert.equal(f.calls.includes('sight-close'), true)
  }
})

test('rescue: lethal pit and void escape the visible foe; hidden players and blocked ascent keep glide rescue', async () => {
  for (const [p, escaping] of [[{}, true], [{ noFloor: true }, true], [{ escapeDeath: true }, true], [{ escapeAbort: true }, true],
    [{ visible: false }, false], [{ foes: [] }, false], [{ rockets: 0 }, false], [{ headroom: 3 }, false]] as Array<[any, boolean]>) {
    const f = fixture({ run: true, hp: 1.2, rockets: 47, foes: ['HuHguZ'], visible: true, ...p })
    const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true,
      arena: { x: 0, z: 0, r: 80 } })
    const escape = f.calls.find(c => c.escape)
    assert.equal(!!escape, escaping, JSON.stringify(p))
    if (escape) {
      assert.equal(r.detail.ok, !p.escapeDeath && !p.escapeAbort)
      assert.equal(r.detail.why, p.escapeDeath ? 'death' : p.escapeAbort ? 'flight_superseded' : null)
      assert.equal(escape.escape, 'HuHguZ')
      assert.equal(escape.arena.y, 120)
      assert.equal(f.calls.includes('land'), false, 'не садиться в ближайшую яму')
      assert.equal(f.calls.includes('sight-close'), true)
    }
  }
})

for (const foe of [false, true]) {
  test('rescue propagates its separate killY into the flight arena, visible foe=' + foe, async () => {
    const f = fixture({ run: true, foes: foe ? ['HuHguZ'] : [], visible: foe })
    const arena = { x: 0, y: 120, z: 0, r: 80 }
    await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, rescue: true, killY: 113, arena })
    const actual = foe ? f.calls.find(c => c.escape)?.arena : f.flights[0].arena
    assert.equal(actual.killY, 113, 'escape, landing and powered forecasts need the actual arena death line')
    assert.equal('killY' in arena, false, 'normalisation does not mutate the caller arena')
  })
}
