import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
import { bodySource } from './source-fixture'
import { stubRequire } from './stub-require'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry as any)

// Свой экземпляр модуля из исходника (bodySource) с подменами по spec (stubRequire); неиспользованная подмена — ошибка.
function source(overrides = {}) {
  const file = path.resolve(__dirname, '../src/swarm-position-work.js'), req = stubRequire(file, overrides), module = { exports: {} as any }
  vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${bodySource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  assert.deepEqual(req.unmatched(), [], 'unused stubs')
  return module.exports
}
function fixture() {
  const bot: any = new EventEmitter(), cells = new Map(), controls: Record<string, boolean> = {}, calls = []
  bot._client = new EventEmitter(); bot.registry = registry; bot.version = '1.21.11'; bot.health = 20
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, effects: {}, metadata: [] }
  bot.physics = { playerHalfWidth: .3, playerHeight: 1.8 }; bot.entities = {}; bot.game = { minY: -64, height: 384 }
  const block = (p, name = 'air') => { const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = p.floored(); return b }
  bot.blockAt = p => cells.has(p.floored().toString()) ? cells.get(p.floored().toString()) : block(p, p.y < 64 ? 'stone' : 'air')
  bot.inventory = { items: () => [{ name: 'dirt', count: 8 }] }
  bot.setControlState = (name, value) => { controls[name] = value; calls.push([name, value]) }
  bot.getControlState = name => !!controls[name]
  bot.clearControlStates = () => { for (const name of Object.keys(controls)) controls[name] = false; calls.push(['clear']) }
  bot.pathfinder = { setGoal() {} }; bot.look = async () => {}; bot.lookAt = async () => {}
  bot.equip = async item => { bot.heldItem = item }
  let time = 0, step = () => {}
  const clock = { now: () => time, sleep: async ms => { time += ms; step(); }, setTimeout: () => null, clearTimeout() {} }
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
  const world = { ...bot, blockAt: bot.blockAt }
  return { bot, block, cells, controls, calls, ctl, world, clock, step: fn => { step = fn },
    load: (overrides = {}) => source({ './game-clock': clock, './pvp/search': { observedCollision: () => world }, ...overrides }) }
}

test('pillar feasibility counts own reserve and requires observed support, full jump/head clearance and arena footprint', () => {
  const f = fixture(), work = f.load()
  assert.equal(work.pillarCheck(f.bot, { height: 7, reserve: 1 }, f.world).ok, true)
  assert.equal(work.pillarCheck(f.bot, { height: 8, reserve: 1 }, f.world).why, 'reserved_blocks')
  assert.equal(work.pillarCheck(f.bot, { height: 17 }, f.world).why, 'invalid_pillar')
  assert.equal(work.pillarCheck(f.bot, { height: 1, arena: { x: 0, z: 0, r: 1.7 } }, f.world).why, 'outside_arena')
  assert.equal(work.pillarCheck(f.bot, { height: 1, arena: { x: .5, z: .5, r: 5, killY: 64 } }, f.world).why, 'outside_arena')
  f.cells.set(new Vec3(0, 67, 0).toString(), f.block(new Vec3(0, 67, 0), 'stone'))
  assert.equal(work.pillarCheck(f.bot, { height: 1 }, f.world).why, 'blocked_column')
  f.cells.set(new Vec3(0, 67, 0).toString(), null)
  assert.equal(work.pillarCheck(f.bot, { height: 1 }, f.world).why, 'unobserved_column')
})

test('pillar rejects unsupported partial support and unsuitable owned falling material', () => {
  const f = fixture(), work = f.load()
  f.cells.set(new Vec3(0, 63, 0).toString(), f.block(new Vec3(0, 63, 0), 'stone_slab'))
  assert.equal(work.pillarCheck(f.bot, {}, f.world).why, 'unobserved_support')
  f.cells.clear(); f.bot.inventory.items = () => [{ name: 'sand', count: 64 }]
  assert.equal(work.pillarCheck(f.bot, { item: 'sand' }, f.world).why, 'no_solid_item')
})

test('hold supports timeoutSeconds, finishes bounded watch and clears sneak and listeners', async () => {
  const f = fixture(), work = f.load()
  const r = await work.swarmHold({ bot: f.bot }, f.ctl, { timeoutSeconds: .2, sneak: true })
  assert.equal(r.ok, true); assert.equal(r.heldSeconds, .2)
  assert.equal(f.controls.sneak, false); assert.equal(f.bot.listenerCount('health'), 0); assert.equal(f.ctl.onAbort.length, 0)
})

test('hold never reads hidden player velocity or health through a nearby opaque wall', async () => {
  const f = fixture(), work = f.load()
  for (let y = 64; y < 68; y++) f.cells.set(new Vec3(1, y, 0).toString(), f.block(new Vec3(1, y, 0), 'stone'))
  f.bot.entities[2] = { id: 2, username: 'enemy', type: 'player', position: new Vec3(2.5, 64, .5), metadata: [],
    get velocity() { throw new Error('hidden motion') }, get health() { throw new Error('exact player health') } }
  const r = await work.swarmHold({ bot: f.bot }, f.ctl, { seconds: .2, enemies: ['enemy'] })
  assert.equal(r.ok, true); assert.equal(r.seen, 0)
})

test('hold aborts live direct threat, damage, death and cancellation, also during an unresolved look', async () => {
  for (const reason of ['direct_threat', 'taking_damage', 'disconnected_or_dead', 'cancelled']) {
    const f = fixture(); let threat = false
    const work = f.load({ './swarm-work': { directThreat: () => threat ? {} : null } })
    f.bot.look = () => new Promise(() => {})
    const pending = work.swarmHold({ bot: f.bot }, f.ctl, { seconds: 1 })
    if (reason === 'direct_threat') { threat = true; f.bot.emit('physicsTick') }
    if (reason === 'taking_damage') { f.bot.health = 19; f.bot.emit('health') }
    if (reason === 'disconnected_or_dead') f.bot.emit('death')
    if (reason === 'cancelled') f.ctl.abort()
    const r = await pending
    assert.equal(r.why, reason); assert.equal(r.aborted, true); assert.equal(f.controls.sneak, false)
  }
})

test('a shield hold against a falling mace is not broken by that mace as a direct threat', async () => {
  // Игра пользователя 23.10: стойка снималась «прямой угрозой» за тики до удара, и щит не держал — 5 «smashed» за 20 с.
  const f = fixture()
  const shield = { wear: async () => true, raise: async () => {}, blocking: () => true, close() {}, report: () => null, nativeUse: () => ({}) }
  // './combat' и './threats' берутся внутри стойки — проверка неиспользованных подмен после неё, не при загрузке.
  const file = path.resolve(__dirname, '../src/swarm-position-work.js'), module = { exports: {} as any }
  const req = stubRequire(file, { './game-clock': f.clock, './pvp/search': { observedCollision: () => f.world }, './swarm-work': { directThreat: () => ({}) },
    './combat': { makeShield: () => shield }, './threats': { smashes: () => [{}] } })
  vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${bodySource(file)}
})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  const pending = module.exports.swarmHold({ bot: f.bot }, f.ctl, { seconds: .3, shield: true, whileSmash: 'Foe' })
  f.bot.emit('physicsTick')
  const r = await pending
  assert.notEqual(r.why, 'direct_threat'); assert.equal(r.shield.blockingSeconds > 0, true)
  assert.deepEqual(req.unmatched(), [])
})

test('landing web is tried before raising the shield; without a shield it returns to the driver at once', async () => {
  for (const shieldMode of [true, false]) {
    const f = fixture(), calls = []
    const shield = { wear: async () => { calls.push('wear'); return true }, raise: async () => { calls.push('raise') }, blocking: () => true, close() {}, nativeUse: () => ({}) }
    const file = path.resolve(__dirname, '../src/swarm-position-work.js'), module = { exports: {} as any }
    const req = stubRequire(file, { './game-clock': f.clock, './pvp/search': { observedCollision: () => f.world }, './swarm-work': { directThreat: () => ({}) },
      './mace/web': { webSmash: async (bot, name, opts) => {
        assert.equal(bot, f.bot); assert.equal(name, 'OtherSwarmBot'); assert.equal(opts.shieldTicks, shieldMode ? 11 : Infinity)
        calls.push('web'); f.bot.emit('physicsTick'); return { placed: true }
      } }, ...(shieldMode ? { './combat': { makeShield: () => shield }, './threats': { smashes: () => [{}] } } : {}) })
    vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${bodySource(file)}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
    const r = await module.exports.swarmHold({ bot: f.bot }, f.ctl, { seconds: .3, shield: shieldMode, whileSmash: 'OtherSwarmBot', webSmash: 'OtherSwarmBot' })
    assert.equal(r.web.placed, true); assert.equal(r.ok, true)
    if (shieldMode) assert.deepEqual(calls.slice(0, 3), ['web', 'wear', 'raise'])
    else { assert.deepEqual(calls, ['web']); assert.equal(f.clock.now(), 0) }
    assert.deepEqual(req.unmatched(), [])
  }
})

test('pillar success requires native block packet, actual desired material and supported physical rise', async () => {
  for (const confirmed of [false, true]) {
    const f = fixture()
    f.bot._genericPlace = async (ref, face) => {
      const cell = ref.position.plus(face), b = f.block(cell, 'dirt'); f.cells.set(cell.toString(), b)
      if (confirmed) f.bot._client.emit('block_change', { location: cell, type: b.stateId })
    }
    const work = f.load({ './build': { towerUp: async (body, ctl, height, opts) => {
      assert.equal(opts.item, 'dirt'); assert.equal(opts.maxDigMs, 0); assert.equal(height, 1)
      assert.equal(opts.abortIf(), null); assert.notEqual(opts.beforeStep(), 'abort')
      await body.equip({ name: 'dirt' }); body.entity.position.y = 65.2
      await body._genericPlace(f.block(new Vec3(0, 63, 0), 'stone'), new Vec3(0, 1, 0))
      body.entity.position.y = 65; return { ok: true, placed: 1 }
    } } })
    const r = await work.swarmPillar({ bot: f.bot }, f.ctl, { height: 1, item: 'dirt', reserve: 1 })
    assert.equal(r.ok, confirmed); assert.equal(r.placed, confirmed ? 1 : 0)
    if (!confirmed) assert.equal(r.why, 'server_unconfirmed')
    assert.equal(f.bot._client.listenerCount('block_change'), 0)
  }
})

test('late tower continuation cannot emit controls or placement after cancellation', async () => {
  const f = fixture(); let resume, late
  f.bot._genericPlace = () => { throw new Error('late placement') }
  const work = f.load({ './build': { towerUp: async body => {
    await new Promise(resolve => { resume = resolve })
    body.setControlState('jump', true); await body._genericPlace({}, {}); late = true
    return { ok: false }
  } } })
  const pending = work.swarmPillar({ bot: f.bot }, f.ctl, { height: 1 })
  f.ctl.abort(); const r = await pending
  assert.equal(r.why, 'cancelled'); const count = f.calls.length
  resume(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(late, true); assert.equal(f.calls.length, count)
})

test('outpost includes a protected physical floor, two-high doorway and roof; beacon is two vertical real cells', () => {
  const { swarmBlueprint }: typeof import('../src/swarm-work') = require('../src/swarm-work')
  const at = { x: 0, y: 64, z: 0 }, outpost = swarmBlueprint('outpost', at, 'north')
  assert.equal(outpost.cells.filter(c => c.at.y === 63).length, 9)
  assert.equal(outpost.cells.filter(c => c.at.y === 66).length, 9)
  assert.equal(outpost.cells.filter(c => c.at.y === 64 || c.at.y === 65).length, 14)
  for (const cell of outpost.cells.filter(c => c.at.y === 63)) assert(outpost.protected.some(p => p.x === cell.at.x && p.y === cell.at.y && p.z === cell.at.z))
  for (const y of [64, 65]) assert(!outpost.cells.some(c => c.at.x === 0 && c.at.z === -1 && c.at.y === y))
  const beacon = swarmBlueprint('beacon', at)
  assert.deepEqual(beacon.cells.map(c => c.at), [at, { ...at, y: 65 }])
  assert.throws(() => swarmBlueprint('beacon', { ...at, y: 319 }), /invalid_blueprint/)
})

test('observed position query prices an optional own-stock pillar and never proposes it through a ceiling or for recovery', async () => {
  const f = fixture(), { swarmPositions }: typeof import('../src/swarm-position') = require('../src/swarm-position')
  f.bot.inventory.items = () => [{ name: 'dirt', count: 8 }, { name: 'bow', count: 1 }, { name: 'arrow', count: 32 }]
  const query: import('../src/swarm-position').SwarmPositionQuery = { purpose: 'ranged', methods: ['build'], radius: 1, limit: 3, reserve: { dirt: 2 } }
  const result = await swarmPositions(f.bot, query)
  assert(result.candidates.length > 0)
  for (const c of result.candidates) {
    const m = c.methods[0]
    assert.equal(m.kind, 'build'); assert.equal(m.skill, 'swarm_pillar'); assert.equal(m.plan.kind, 'pillar')
    assert.equal(m.params.item, 'dirt'); assert.equal(m.params.reserve, 2); assert(m.params.height <= 6)
    assert(m.cost > 0); assert.equal(c.at.y, 64 + m.params.height)
  }
  assert.equal((await swarmPositions(f.bot, { ...query, purpose: 'recover' })).candidates.length, 0)
  f.cells.set(new Vec3(0, 66, 0).toString(), f.block(new Vec3(0, 66, 0), 'stone'))
  f.bot.emit('blockUpdate', null, f.bot.blockAt(new Vec3(0, 66, 0)))
  assert.equal((await swarmPositions(f.bot, query)).candidates.length, 0)
  assert.equal(f.calls.length, 0)
})
