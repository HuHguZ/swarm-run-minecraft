import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
import { transpiledSource } from './source-fixture'
import { stubRequire } from './stub-require'

function fixture() {
  let tick = 100, visible = true, safe = true, blocked = false, defence = false, framesInput: any
  const from = new Vec3(0, 65.62, 0), feet = new Vec3(4, 65, 0), burst = new Vec3(3.7, 66, 0)
  const shot = { thrower: 'Blue', fireTick: 103, arrivalTick: 106, fireDelay: 3, ticks: 3, from, aim: feet.offset(0, 1, 0), feet, burst, velocity: new Vec3(1.5, 0, 0), yaw: 0, pitch: 0 }
  const plan = { target: 'Red', targetAt: feet, gameTick: 100, resistance: { lo: 0, hi: 0 }, shots: [shot], nominal: { progress: 3 }, baseline: { progress: 0 } }
  const foe: any = { id: 2, username: 'Red', position: feet, velocity: new Vec3(0, .2, 0), onGround: false, equipment: [], width: .6, height: 1.8 }
  const bot: any = Object.assign(new EventEmitter(), {
    username: 'Blue', health: 20, entity: { id: 1, username: 'Blue', position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, attributes: {}, effects: {} },
    players: { Red: { entity: foe } }, entities: { 2: foe }, _client: new EventEmitter(), quickBarSlot: 1,
    inventory: { slots: [], items: () => [{ name: 'wind_charge', count: 4 }] },
    getControlState: () => false, look: async () => {}, setQuickBarSlot: n => { bot.quickBarSlot = n },
    activateItem: () => { calls.push({ tick, slot: bot.quickBarSlot }); bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 10 }) }
  })
  const calls: any[] = [], session: any = { bot, current: { name: 'fight', ctl: { aborted: false } }, require: () => bot, state: () => ({}) }
  const ctl = { aborted: false, onAbort: [] as (() => void)[], waitReflex: async () => {}, abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
  const file = path.resolve(__dirname, '../src/combat/enemy-wind-execute.js'), module = { exports: {} as any }
  const req = stubRequire(file, {
    './team-wind': { worldTick: () => tick, WIND: { reach: 2.4, speed: 1.5, dispersion: .0172275 }, windInside: () => true },
    './enemy-wind': { planEnemyWind: (_b, e, reports, options) => ({ ...plan, gameTick: tick, received: { e, reports, options } }),
      enemyWindFrames: (_b, _e, _a, shots) => { framesInput = shots; return [{}] },
      enemyWindShot: () => blocked ? null : { ...shot, fireDelay: 0 }, windTeamSafe: proxy => { assert.notEqual(proxy, bot); assert.deepEqual(proxy.blockAt(new Vec3(0, 0, 0)), { observed: true }); return safe }, windReportAt: (_b, r) => r },
    '../pvp/last-seen': { createLastSeen: () => ({ observe: e => e, visible: () => visible, close: () => {} }) },
    '../mace/hands': { install: () => {}, windCount: () => 4, windReady: () => true, hotbarIndex: () => 0, offWind: () => false, ensureHotbar: async () => true },
    '../reflex-lock': { owner: () => defence ? { owner: 'Emergency' } : null },
    '../edges': { afterPacket: (_b, f) => setImmediate(f), worldOf: world => ({ getBlock: p => world.blockAt(p) }) },
    '../pvp/search': { observedCollision: () => ({ blockAt: () => ({ observed: true }) }) },
    '../pick': { eyeHeight: () => 1.62 }, '../game-clock': { now: () => tick * 50 }
  })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  const params = { plan, arena: { x: 0, z: 0, r: 8, killY: 40 }, allies: [] }
  return { api: module.exports, bot, session, ctl, calls, plan, shot, params, set: (p: any) => { if ('visible' in p) visible = p.visible; if ('safe' in p) safe = p.safe; if ('blocked' in p) blocked = p.blocked; if ('defence' in p) defence = p.defence; if ('tick' in p) tick = p.tick },
    get framesInput() { return framesInput }, async run(hook = (_t: number) => {}) {
      let done = false, result: any
      const pending = module.exports.enemyWindExecute(session, ctl, params).then(r => { done = true; result = r })
      for (let n = 0; n < 20 && !done; n++) { await new Promise<void>(r => setImmediate(r)); await new Promise<void>(r => setImmediate(r)); if (done) break; tick++; hook(tick); bot.emit('physicsTick') }
      await new Promise<void>(r => setImmediate(r)); assert.equal(done, true); await pending
      assert.equal(ctl.onAbort.length, 0); assert.equal(bot.listenerCount('physicsTick'), 0)
      assert.equal(bot._client.listenerCount('explosion'), 0); assert.equal(bot._client.listenerCount('set_cooldown'), 0)
      return result
    }
  }
}

test('wind out keeps the current fight and releases once on the absolute shared tick with a launch receipt', async () => {
  const f = fixture(), current = f.session.current, r = await f.run()
  assert.equal(r.fired, true); assert.equal(r.launchConfirmed, true); assert.equal(r.burstSeen, false)
  assert.deepEqual(f.calls, [{ tick: 103, slot: 0 }]); assert.equal(f.bot.quickBarSlot, 1)
  assert.equal(f.session.current, current); assert.equal(r.killed, undefined)
})

test('missed shared tick and an invalid schedule never send a late charge', async () => {
  for (const options of [{ tick: 104 }, { tick: 100, bad: true }]) {
    const f = fixture(); f.set(options); if (options.bad) f.shot.arrivalTick = 102
    const r = await f.run(); assert.equal(r.fired, false); assert.equal(f.calls.length, 0)
  }
})

test('fresh target visibility, native ray and friendly blast are checked again at release', async () => {
  for (const change of [{ visible: false }, { blocked: true }, { safe: false }, { defence: true }]) {
    const f = fixture(), r = await f.run(t => { if (t === 103) f.set(change) })
    assert.equal(r.fired, false); assert.equal(f.calls.length, 0)
  }
})

test('cancellation unhooks a scheduled shot without waiting for another physical frame', async () => {
  const f = fixture(), pending = f.api.enemyWindExecute(f.session, f.ctl, f.params)
  await new Promise<void>(r => setImmediate(r)); f.ctl.abort()
  const r = await pending
  assert.equal(r.fired, false); assert.equal(f.calls.length, 0); assert.equal(f.ctl.onAbort.length, 0)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('plan is made from a fresh fair local view and shared ticks, not driver floor positions', async () => {
  const f = fixture(), own = f.api.enemyWindReport(f.session)
  assert.equal(own.gameTick, 100); assert.equal(own.report.position.y, 64)
  const r = await f.api.enemyWindPlan(f.session, { target: 'Red', throwers: [own.report], allies: [own.report], arena: f.params.arena, leadTicks: 4 })
  assert.equal(r.plan.received.options.startTick, 104); assert.equal(r.plan.target, 'Red')
  f.set({ visible: false }); assert.equal((await f.api.enemyWindPlan(f.session, { target: 'Red', throwers: [own.report], arena: f.params.arena })).ok, false)
})

test('a matching distant gust is observed even without knockback to the thrower', async () => {
  const f = fixture(), r = await f.run(t => { if (t === 106) f.bot._client.emit('explosion', { center: f.shot.burst, radius: 1.2, explosionParticle: { type: 'gust_emitter_small' }, playerKnockback: new Vec3(0, 0, 0) }) })
  assert.equal(r.burstSeen, true); assert.equal(r.launchConfirmed, true)
})

test('RPC radio does not drain observations and wind_out uses the beside intent contract', async () => {
  const file = path.resolve(__dirname, '../src/rpc/aerial.js'), module = { exports: {} as any }, calls: any[] = []
  const session: any = { state: () => ({ own: true }), immediate: () => { throw new Error('radio must not drain events') },
    runIntent: async (name, fn, options) => { calls.push({ name, options }); return fn({ aborted: false }) } }
  const req = stubRequire(file, { '../combat/enemy-wind-execute': {
    enemyWindReport: () => ({ gameTick: 100 }), enemyWindPlan: async (_s, p) => { await Promise.resolve(); return { target: p.target } }, enemyWindExecute: (_s, _ctl, p) => ({ fired: p.test })
  } })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  const methods = module.exports.aerialMethods({ session })
  assert.deepEqual((await methods.wind_report()).events, []); assert.equal((await methods.enemy_wind_plan({ target: 'Red' })).detail.target, 'Red')
  assert.equal((await methods.wind_out({ test: true })).fired, true)
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'wind_out'); assert.equal(calls[0].options.exclusive, false)
  assert.equal(calls[0].options.timeoutMs, 5000); assert.deepEqual(calls[0].options.interruptOn, ['death', 'kicked', 'disconnected'])
})

test('JSON radio plan and the real native kernel reach a timed launch beside a fight', async () => {
  const clock = require('../src/game-clock'), game = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const native = require('../src/tick-plugins').getPhysics(), core = require('../src/combat/enemy-wind'), api = require('../src/combat/enemy-wind-execute')
  const world = { getBlock(p) { const q = p.floored(), name = q.y === 0 && q.x >= -8 && q.x <= 4 && Math.abs(q.z) <= 5 ? 'stone' : 'air'; const block = Block.fromStateId(registry.blocksByName[name].defaultState); block.position = q; return block } }
  const charge = { ...registry.itemsByName.wind_charge, type: registry.itemsByName.wind_charge.id, count: 4, slot: 36 }, slots = Array(46).fill(null); slots[36] = charge
  const foe: any = { id: 2, username: 'Enemy', name: 'player', type: 'player', isValid: true, position: new Vec3(3.5, 2.5, .5), velocity: new Vec3(.08, .2, 0), onGround: false, height: 1.8, width: .6, equipment: [], metadata: [] }
  const calls: number[] = [], bot: any = Object.assign(new EventEmitter(), {
    username: 'A', version: '1.21.11', registry, health: 20, food: 20, game: { minY: -64, height: 384 }, entities: { 2: foe }, players: { Enemy: { entity: foe } },
    entity: { id: 1, username: 'A', position: new Vec3(-2, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    inventory: { slots, items: () => [charge] }, blockAt: p => world.getBlock(p), physics: native.Physics(registry, world), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    ndClock: { age: 500n, serverTicks: 20, ticks: 20 }, _client: new EventEmitter(), getControlState: () => false,
    quickBarSlot: 1, setQuickBarSlot(n) { this.quickBarSlot = n }, look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    activateItem: () => { calls.push(500 + bot.ndClock.ticks - 20); bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 10 }) }
  })
  const session: any = { bot, current: { name: 'fight', ctl: { aborted: false } } }, ctl = { aborted: false, onAbort: [], waitReflex: async () => {} }, arena = { x: -1.5, z: .5, r: 6.5, killY: -10 }
  try {
    api.enemyWindReport(session, { target: 'Enemy' })
    const first = core.enemyWindFrames(bot, foe, arena)[1]
    foe.position = first.pos; foe.velocity = first.vel; foe.onGround = first.onGround
    game.advanceTicks(1); bot.ndClock.ticks++; bot.emit('physicsTick')
    const report = api.enemyWindReport(session).report, proposal = await api.enemyWindPlan(session, { target: 'Enemy', throwers: [report], allies: [report], arena, leadTicks: 4, maxShots: 1 })
    assert.ok(proposal.plan, 'fresh, measured airborne view must produce a native plan')
    const plan = JSON.parse(JSON.stringify(proposal.plan)), frames = core.enemyWindFrames(bot, foe, arena)
    let done = false, result: any
    const pending = api.enemyWindExecute(session, ctl, { plan, arena, allies: [report] }).then(r => { done = true; result = r })
    for (let tick = 0; tick < 45 && !done; tick++) {
      await new Promise<void>(r => setImmediate(r)); await new Promise<void>(r => setImmediate(r)); if (done) break
      const frame = frames[tick + 1]; foe.position = frame.pos.clone(); foe.velocity = frame.vel.clone(); foe.onGround = frame.onGround
      game.advanceTicks(1); bot.ndClock.ticks++; bot.emit('physicsTick')
    }
    await pending
    assert.equal(result.fired, true, JSON.stringify(result)); assert.equal(result.launchConfirmed, true)
    assert.deepEqual(calls, [plan.shots[0].fireTick]); assert.equal(session.current.name, 'fight')
    bot.emit('end'); assert.equal(bot.listenerCount('physicsTick'), 0); assert.equal(ctl.onAbort.length, 0)
  } finally { bot.emit('end'); game.dispose() }
})
