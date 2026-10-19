import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { bodySource } from './source-fixture'
import { stubRequire } from './stub-require'

// Свой экземпляр модуля из исходника (bodySource — модуль с папкой тела одним скриптом) с подменами по spec (stubRequire);
// подмена, которую модуль ни разу не запросил, — ошибка фикстуры.
function source(name: string, overrides: Record<string, any> = {}) {
  const file = path.resolve(__dirname, '../src', name + '.js'), req = stubRequire(file, overrides)
  const module = { exports: {} as any }
  vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${bodySource(file)}\n})`, { filename: file })(req,
    module, module.exports, file, path.dirname(file))
  assert.deepEqual(req.unmatched(), [], name + ': unused stubs')
  return module.exports
}

function fixture() {
  const bot: any = new EventEmitter(), cells = new Map(), calls: string[] = []
  bot._client = new EventEmitter(); bot.version = '1.21.11'; bot.health = 20; bot.food = 20
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), width: .6, height: 1.8, onGround: true, effects: {}, metadata: [] }
  bot.entities = {}; bot.inventory = { slots: [], items: () => [{ name: 'dirt', type: bot.registry.itemsByName.dirt.id, count: 64 }] }
  bot.pathfinder = { setGoal: () => calls.push('goal') }; bot.clearControlStates = () => calls.push('clear')
  const block = (p: any, name = 'air') => {
    const data = bot.registry.blocksByName[name]
    return { ...data, position: p.floored(), stateId: data.minStateId, boundingBox: name === 'air' ? 'empty' : 'block',
      shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], digTime: () => 20, canHarvest: () => true }
  }
  bot.blockAt = (p: any) => cells.get(p.floored().toString()) || block(p, p.y < 64 ? 'stone' : 'air')
  bot.equip = async (item: any) => { bot.heldItem = item; calls.push('equip') }
  bot.lookAt = async () => { calls.push('look') }; bot.canDigBlock = () => true
  bot.stopDigging = () => calls.push('stopDigging')
  bot._updateBlockState = (p: any, state: number) => {
    const data = bot.registry.blocksByStateId[state]
    cells.set(p.toString(), { ...block(p, data.name), stateId: state })
  }
  const packet = (p: any, name: string) => {
    const b = block(p, name); cells.set(p.toString(), b)
    bot._client.emit('block_change', { location: p, type: b.stateId })
    bot.emit('blockUpdate', null, b)
  }
  bot._placeBlockWithOptions = async (ref: any, face: any) => { calls.push('place'); packet(ref.position.plus(face), bot.heldItem.name) }
  bot.dig = async (b: any) => { calls.push('dig'); packet(b.position, 'air') }
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
  const session = { bot }, at = new Vec3(1, 64, 0)
  const build = source('build'), pick = source('pick'), receipt = source('environments/dig-receipt')
  const work = source('swarm-work', { './build': build, './pick': pick, './environments/dig-receipt': receipt })
  return { bot, cells, calls, ctl, session, at, packet, block, work }
}

test('a roof cell can use an actual jump to expose the supporting wall top', async () => {
  const f = fixture()
  const target = new Vec3(1, 66, 0)
  f.cells.set(new Vec3(1, 64, 0).toString(), f.block(new Vec3(1, 64, 0), 'dirt'))
  f.cells.set(new Vec3(1, 65, 0).toString(), f.block(new Vec3(1, 65, 0), 'dirt'))
  f.bot.setControlState = (name, value) => { if (name === 'jump' && value) { f.calls.push('jump'); f.bot.entity.position.y = 64.8 } }
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: target, item: 'dirt', timeoutSeconds: 1 })
  assert.equal(result.done, true)
  assert.ok(f.calls.includes('jump'))
  assert.equal(result.after, 'dirt')
})

test('blueprints have a roof, a two block exit and explicit allied floor protection', () => {
  const { swarmBlueprint } = source('swarm-work')
  const plan = swarmBlueprint('shelter', { x: 10, y: 64, z: 10 }, 'north')
  const keys = new Set(plan.cells.map((c: any) => `${c.at.x},${c.at.y},${c.at.z}`))
  assert.equal(keys.size, plan.cells.length)
  assert.equal(keys.has('10,64,8'), false); assert.equal(keys.has('10,65,8'), false)
  assert.equal(keys.has('10,66,10'), true)
  assert.equal(plan.protected.some((c: any) => c.x === 10 && c.y === 63 && c.z === 10), true)
  assert.equal(plan.cells.every((c: any) => c.kind === 'place'), true)
  const cocoon = swarmBlueprint('cocoon', { x: 10, y: 64, z: 10 }, 'north')
  assert.equal(cocoon.cells.some((c: any) => c.at.x === 10 && c.at.y === 66 && c.at.z === 10), true)
  assert.equal(cocoon.cells.some((c: any) => c.at.x === 10 && c.at.y === 65 && c.at.z === 9), false)
  assert.equal(swarmBlueprint('cutoff', { x: 10, y: 64, z: 10 }, 'east').cells.length, 10)
})

test('worker rejects bad coordinates and protected or allied supporting cells before any hand action', async () => {
  const f = fixture()
  for (const at of [{ x: NaN, y: 64, z: 0 }, { x: 30_000_000, y: 64, z: 0 }, { x: 1.5, y: 64, z: 0 }, { x: 1, y: -65, z: 0 }]) {
    const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at })
    assert.equal(result.ok, false); assert.equal(result.why, 'invalid_cell')
  }
  assert.equal((await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at, protected: [f.at] })).why, 'protected_cell')
  assert.equal((await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: { x: 0, y: 63, z: 0 } })).why, 'allied_support')
  assert.equal(f.calls.includes('dig') || f.calls.includes('place'), false)
})

test('actual native placement commits one exact cell and honest placement cannot reach behind a wall', async () => {
  const f = fixture(), result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'dirt' })
  assert.equal(result.ok, true); assert.equal(result.done, true); assert.equal(result.after, 'dirt')
  assert.equal(f.calls.filter(x => x === 'place').length, 1)
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
  const hidden = fixture(), target = new Vec3(3, 64, 0)
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++) hidden.cells.set(new Vec3(1, y, z).toString(), hidden.block(new Vec3(1, y, z), 'stone'))
  const refused = await hidden.work.swarmWork(hidden.session, hidden.ctl, { kind: 'place', at: target, item: 'dirt', timeoutSeconds: .1 })
  assert.equal(refused.ok, false); assert.equal(hidden.calls.includes('place'), false)
})

test('client prediction cannot commit a placement without an authoritative packet', async () => {
  const f = fixture()
  f.bot._placeBlockWithOptions = async (ref: any, face: any) => { f.cells.set(ref.position.plus(face).toString(), f.block(ref.position.plus(face), 'dirt')) }
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'dirt', timeoutSeconds: .1 })
  assert.equal(result.ok, false); assert.equal(result.done, false)
})

test('visible digging commits only a native server air receipt', async () => {
  const f = fixture(); f.cells.set(f.at.toString(), f.block(f.at, 'dirt'))
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at })
  assert.equal(result.ok, true); assert.equal(result.done, true); assert.equal(result.after, 'air')
  assert.equal(f.calls.filter(x => x === 'dig').length, 1)
  const blocked = fixture(), target = new Vec3(2, 64, 0)
  blocked.cells.set(target.toString(), blocked.block(target, 'stone'))
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++) blocked.cells.set(new Vec3(1, y, z).toString(), blocked.block(new Vec3(1, y, z), 'stone'))
  const refused = await blocked.work.swarmWork(blocked.session, blocked.ctl, { kind: 'dig', at: target })
  assert.equal(refused.ok, false); assert.equal(refused.why, 'occluded_or_out_of_reach'); assert.equal(blocked.calls.includes('dig'), false)
})

test('an idle distant visible enemy permits work but a visible charging enemy interrupts it', async () => {
  const f = fixture(), e = { id: 2, name: 'player', type: 'player', username: 'Enemy', position: new Vec3(10.5, 64, .5), height: 1.8, width: .6, velocity: new Vec3(0, 0, 0) }
  f.bot.entities[2] = e
  assert.equal(f.work.directThreat(f.bot, [], 3000), null)
  e.velocity.x = -.4
  assert.equal(f.work.directThreat(f.bot, [], 3000)?.username, 'Enemy')
  assert.equal(f.work.directThreat(f.bot, ['Enemy'], 3000), null)
})

test('external cancellation immediately stops in-flight digging and releases callbacks', async () => {
  const f = fixture(); f.cells.set(f.at.toString(), f.block(f.at, 'dirt'))
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  f.bot.dig = async () => { f.calls.push('dig'); started(); await new Promise(() => {}) }
  const task = f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at })
  await ready; f.ctl.abort()
  const result = await task
  assert.equal(result.aborted, true); assert.equal(result.done, false)
  assert.ok(f.calls.includes('stopDigging')); assert.ok(f.calls.includes('clear'))
  assert.equal(f.ctl.onAbort.length, 0); assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
})

test('contact during a dig yields to existing combat safety and does not continue work', async () => {
  const f = fixture(); f.cells.set(f.at.toString(), f.block(f.at, 'dirt'))
  let started!: () => void, safetyChecks = 0, retreats = 0
  const ready = new Promise<void>(resolve => { started = resolve })
  f.bot.dig = async () => { started(); await new Promise(() => {}) }
  const worker = source('swarm-work', { './combat-safety': {
    inspect: () => { safetyChecks++; return { action: 'leave' } },
    disengage: async () => { retreats++; return { clear: true } }
  } })
  const pending = worker.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at })
  await ready
  f.bot.entities[2] = { id: 2, type: 'player', name: 'player', username: 'Enemy', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6 }
  f.bot.emit('physicsTick')
  const result = await pending
  assert.equal(result.aborted, true); assert.equal(result.done, false); assert.equal(result.why, 'direct_threat')
  assert.equal(safetyChecks, 1); assert.equal(retreats, 1); assert.ok(f.calls.includes('stopDigging'))
})

test('a close enemy behind a wall is unseen and a cancelled placement never sends its packet', async () => {
  const f = fixture(), enemy = { id: 2, type: 'player', name: 'player', username: 'Enemy', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6 }
  f.bot.entities[2] = enemy
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++) f.cells.set(new Vec3(1, y, z).toString(), f.block(new Vec3(1, y, z), 'stone'))
  assert.equal(f.work.directThreat(f.bot, [], 3000), null)
  const cancelled = fixture()
  cancelled.bot.lookAt = async () => { cancelled.ctl.abort() }
  const result = await cancelled.work.swarmWork(cancelled.session, cancelled.ctl, { kind: 'place', at: cancelled.at, item: 'dirt' })
  assert.equal(result.aborted, true); assert.equal(cancelled.calls.includes('place'), false)
})

test('digging sends the visible face without a second recentering look', async () => {
  const f = fixture(), upper = new Vec3(1, 66, 0)
  f.cells.set(upper.toString(), f.block(upper, 'dirt'))
  f.bot.dig = async (_b: any, forceLook: any) => {
    assert.equal(forceLook, 'ignore')
    assert.equal(f.bot.targetDigFace, (require('../node_modules/prismarine-world') as typeof import('../node_modules/prismarine-world')).iterators.BlockFace.BOTTOM)
    f.packet(upper, 'air')
  }
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: upper })
  assert.equal(result.ok, true)
})

test('timed-out client air is restored before the next worker sees the cell', async () => {
  const f = fixture(); f.cells.set(f.at.toString(), f.block(f.at, 'dirt'))
  f.bot.dig = async () => { f.bot._updateBlockState(f.at, f.bot.registry.blocksByName.air.minStateId) }
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at, timeoutSeconds: .1 })
  assert.equal(result.done, false); assert.equal(f.bot.blockAt(f.at).name, 'dirt')
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
})

test('cancellation between predicted dig completion and receipt settlement restores collision', async () => {
  const f = fixture(); f.cells.set(f.at.toString(), f.block(f.at, 'dirt'))
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  f.bot.dig = async () => { f.bot._updateBlockState(f.at, f.bot.registry.blocksByName.air.minStateId); started() }
  const pending = f.work.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at })
  await ready; f.ctl.abort()
  const result = await pending
  assert.equal(result.aborted, true); assert.equal(f.bot.blockAt(f.at).name, 'dirt')
})

test('a visible existing exact block acknowledges resumed work without another placement', async () => {
  const f = fixture(); f.packet(f.at, 'dirt')
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'dirt' })
  assert.equal(result.ok, true); assert.equal(result.done, true); assert.equal(result.already, true)
  assert.equal(result.confirmation, 'visible_existing'); assert.equal(f.calls.includes('place'), false)
  const wrong = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'stone' })
  assert.equal(wrong.done, false); assert.equal(wrong.why, 'occupied_cell')
})

test('resumed build cannot acknowledge an occluded exact block or pending body predictions', async () => {
  const f = fixture(), hidden = new Vec3(2, 64, 0)
  f.packet(hidden, 'dirt')
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++) f.cells.set(new Vec3(1, y, z).toString(), f.block(new Vec3(1, y, z), 'stone'))
  const result = await f.work.swarmWork(f.session, f.ctl, { kind: 'place', at: hidden, item: 'dirt' })
  assert.equal(result.done, false); assert.equal(result.why, 'occluded_or_out_of_reach')
  const predicted = fixture(); predicted.cells.set(predicted.at.toString(), predicted.block(predicted.at, 'dirt'))
  for (const property of ['_ndClutch', '_ndBridgeExec']) {
    predicted.bot[property] = { pending: new Map([[`${predicted.at.x},${predicted.at.y},${predicted.at.z}`, {}]]) }
    const refused = await predicted.work.swarmWork(predicted.session, predicted.ctl, { kind: 'place', at: predicted.at, item: 'dirt' })
    assert.equal(refused.done, false); assert.equal(refused.why, 'server_unconfirmed')
    delete predicted.bot[property]
  }
})

test('an enemy four blocks overhead cannot prevent an otherwise safe visible undercut just because I can reach its feet', () => {
  const f = fixture()
  f.bot.entities[2] = { id: 2, type: 'player', name: 'player', username: 'Enemy', position: new Vec3(.5, 68, .5), height: 1.8, width: .6, velocity: new Vec3(0, 0, 0) }
  assert.equal(f.work.directThreat(f.bot, [], 1000), null)
})

test('a weak contained enemy within reach does not stop work, an uncontained or a strong one still does', () => {
  const f = fixture(), e: any = { id: 2, name: 'player', type: 'player', username: 'Caged', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6, velocity: new Vec3(0, 0, 0), equipment: [] }
  f.bot.entities[2] = e
  assert.equal(f.work.directThreat(f.bot, [], 1000)?.username, 'Caged', 'an ordinary close enemy is a threat')
  assert.equal(f.work.directThreat(f.bot, [], 1000, x => x, { contained: ['Caged'] }), null, 'a caged bare-handed foe poking through a slit is a price, not a stop')
  f.bot.health = 6
  assert.equal(f.work.directThreat(f.bot, [], 1000, x => x, { contained: ['Caged'] })?.username, 'Caged', 'at low health even a weak hit is too costly')
})

test('combat never punches through a block the swarm keeps as its own structure', async () => {
  const Vec3: typeof import('vec3').Vec3 = require('vec3'), { keepBlocks }: typeof import('../src/swarm-work') = require('../src/swarm-work'), { createTerrain }: typeof import('../src/pvp/terrain') = require('../src/pvp/terrain')
  const wall = new Vec3(1, 65, 0), broke: any[] = []
  const bot = { entity: { position: new Vec3(.5, 64, .5) }, world: { raycast: () => ({ position: wall, boundingBox: 'block' }) } }
  const ctx: any = { bot, EYE: 1.62, entity: { position: new Vec3(3.5, 64, .5), height: 1.8 }, rest() {}, pathTo() {}, clear() {}, async holdWeapon() {}, used() {},
    tools: { bestFor: () => ({ ms: 300 }), breakFast: async (_b, p) => { broke.push(p); return { ok: true, tool: 'iron_pickaxe' } } } }
  const { punchThrough } = createTerrain(ctx)
  keepBlocks(bot, [{ x: 1, y: 65, z: 0 }])
  assert.equal(await punchThrough(), false, 'an own cocoon wall is not the enemy wall')
  assert.equal(broke.length, 0)
  keepBlocks(bot, [], { clear: true })
  assert.equal(await punchThrough(), true)
  assert.equal(broke.length, 1)
})
