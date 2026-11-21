import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
import { bodySource } from './source-fixture'
import { stubRequire } from './stub-require'
import { swarmMethods } from '../src/rpc/swarm'
import { terrainMethods } from '../src/rpc/terrain'
import { terrainCoverMethods } from '../src/rpc/terrain-cover'
import { testBot } from './tick-plugins-fixture'
import { faceAim } from '../src/pick'
import { FACES } from '../src/build'

const data = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')('1.21.11')
const WorldSync = require('prismarine-world/src/worldsync')

function source(name: string, overrides: Record<string, any> = {}) {
  const file = path.resolve(__dirname, '../src', name + '.js')
  const req = stubRequire(file, overrides)
  const mod = { exports: {} as any }
  vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${bodySource(file)}\n})`, { filename: file })(
    req, mod, mod.exports, file, path.dirname(file)
  )
  assert.deepEqual(req.unmatched(), [], name + ': unused stubs')
  return mod.exports
}

function workFixture() {
  const bot: any = new EventEmitter(), cells = new Map(), calls: string[] = []
  bot._client = new EventEmitter()
  bot.version = '1.21.11'; bot.health = 20; bot.food = 20
  bot.registry = data
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), width: .6, height: 1.8, onGround: true, effects: {}, metadata: [] }
  bot.entities = {}
  const dirt = { name: 'dirt', type: data.itemsByName.dirt.id, count: 64 }
  const pick = { name: 'iron_pickaxe', type: data.itemsByName.iron_pickaxe.id, count: 1, maxDurability: 250, durabilityUsed: 0 }
  const sword = { name: 'iron_sword', type: data.itemsByName.iron_sword.id, count: 1, maxDurability: 250, durabilityUsed: 0 }
  bot.heldItem = pick
  bot.inventory = { slots: [], items: () => [dirt, pick, sword] }
  bot.pathfinder = { setGoal: () => calls.push('goal') }
  bot.clearControlStates = () => calls.push('clear')
  bot.setControlState = (k: string, v: boolean) => calls.push(`ctl:${k}:${v}`)
  const block = (p: any, name = 'air') => {
    const info = data.blocksByName[name]
    return { ...info, position: p.floored(), stateId: info.minStateId, boundingBox: name === 'air' ? 'empty' : 'block',
      shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]],
      digTime: (type?: number) => type === pick.type ? 50 : 500, canHarvest: () => true }
  }
  bot.blockAt = (p: any) => cells.get(p.floored().toString()) || block(p, p.y < 64 ? 'stone' : 'air')
  bot.equip = async (item: any) => { bot.heldItem = item; calls.push(`equip:${item.name}`) }
  bot.lookAt = async () => { calls.push('look') }
  bot.canDigBlock = () => true
  bot.stopDigging = () => calls.push('stopDigging')
  bot._updateBlockState = (p: any, state: number) => {
    const info = data.blocksByStateId[state]
    cells.set(p.toString(), { ...block(p, info.name), stateId: state })
  }
  const packet = (p: any, name: string) => {
    const b = block(p, name); cells.set(p.toString(), b)
    bot._client.emit('block_change', { location: p, type: b.stateId })
    bot.emit('blockUpdate', null, b)
  }
  bot._placeBlockWithOptions = async (ref: any, face: any) => { calls.push('place'); packet(ref.position.plus(face), bot.heldItem.name) }
  bot.dig = async (b: any) => { calls.push('dig'); packet(b.position, 'air') }
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
  const session = { bot }
  return { bot, cells, calls, ctl, session, packet, block, at: new Vec3(1, 64, 0), pick, sword, dirt }
}

test('swarmWork stop() fires local.onAbort callbacks on direct_threat', async () => {
  const f = workFixture()
  let abortHookCalls = 0, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const realBuild = source('build')
  const buildStub = {
    ...realBuild,
    placeBlockAt: async (_bot: any, _pos: any, opts: any) => {
      opts.ctl.onAbort.push(() => { abortHookCalls++ })
      started()
      await new Promise(() => {})
      return { ok: false }
    }
  }
  const worker = source('swarm-work', {
    './build': buildStub,
    './combat-safety': { inspect: () => ({ action: 'fight' }), disengage: async () => ({ clear: true }) }
  })
  const pending = worker.swarmWork(f.session, f.ctl, { kind: 'place', at: f.at, item: 'dirt' })
  await ready
  f.bot.entities[2] = { id: 2, type: 'player', name: 'player', username: 'Enemy', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6 }
  f.bot.emit('physicsTick')
  const res = await pending
  assert.equal(res.why, 'direct_threat')
  assert.equal(abortHookCalls, 1, 'stop() must invoke local.onAbort hooks')
})

test('swarmWork isolates detached work() from safety.disengage() and equips weapon on direct_threat', async () => {
  const f = workFixture()
  f.cells.set(f.at.toString(), f.block(f.at, 'stone'))
  let releaseEquip!: () => void, equipStarted!: () => void
  const equipReady = new Promise<void>(resolve => { equipStarted = resolve })
  const origEquip = f.bot.equip
  let firstEquip = true
  f.bot.equip = async (item: any, dest: any) => {
    if (firstEquip) {
      firstEquip = false
      equipStarted()
      await new Promise<void>(resolve => { releaseEquip = resolve })
      // Even if the in-flight equip settles mid-disengage and overwrites heldItem, work() must not proceed to look/dig.
      f.bot.heldItem = item
      return
    }
    return origEquip(item, dest)
  }
  let callsDuringDisengage: string[] = []
  const worker = source('swarm-work', {
    './combat-safety': {
      inspect: () => ({ action: 'leave' }),
      disengage: async () => {
        const before = f.calls.length
        // Resume the detached work() coroutine while disengage is active.
        releaseEquip()
        await new Promise(resolve => setTimeout(resolve, 20))
        callsDuringDisengage = f.calls.slice(before)
        return { clear: true }
      }
    }
  })
  const pending = worker.swarmWork(f.session, f.ctl, { kind: 'dig', at: f.at })
  await equipReady
  f.bot.entities[2] = { id: 2, type: 'player', name: 'player', username: 'Enemy', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6 }
  f.bot.emit('physicsTick')
  const res = await pending
  assert.equal(res.why, 'direct_threat')
  assert.equal(f.bot.heldItem?.name, 'iron_sword', 'must equip best weapon instead of leaving pickaxe in hand')
  assert.deepEqual(callsDuringDisengage, [], 'detached work() must not mutate bot controls/look/dig during safety.disengage()')
})

test('swarmWork onClick retry preserves already-matching confirmedState', async () => {
  const f = workFixture()
  const target = new Vec3(1, 66, 0)
  f.cells.set(new Vec3(1, 64, 0).toString(), f.block(new Vec3(1, 64, 0), 'dirt'))
  f.cells.set(new Vec3(1, 65, 0).toString(), f.block(new Vec3(1, 65, 0), 'dirt'))
  let attempts = 0
  const realBuild = source('build')
  const buildStub = {
    ...realBuild,
    placeBlockAt: async (_bot: any, pos: any, opts: any) => {
      attempts++
      opts.onClick()
      if (attempts === 1) {
        // Server confirms the block on attempt 1, even though placeBlockAt returns a late timeout.
        f.packet(pos, 'dirt')
        return { ok: false, reason: 'timeout' }
      }
      // Second click without a fresh packet must not wipe confirmedState.
      return { ok: true }
    }
  }
  const worker = source('swarm-work', { './build': buildStub })
  const res = await worker.swarmWork(f.session, f.ctl, { kind: 'place', at: target, item: 'dirt', timeoutSeconds: 1 })
  assert.equal(res.ok, true)
  assert.equal(res.done, true)
  assert.equal(res.why, 'placed')
  assert.equal(attempts, 1, 'already-confirmed block skips redundant jump-retry placement')
})

test('dig_to recomputes faceAim after tiny residual walking slide during lookAt', async () => {
  const blocks = new Map<string, string>()
  const dug: { pos: Vec3; clickable: boolean }[] = []
  const controls = new Set<string>()
  const ctl = { aborted: false, onAbort: [] }
  let aim: Vec3, slid = false, walked = 0
  const bot: any = Object.assign(testBot(), {
    version: '1.21.11', _client: new EventEmitter(), entities: {}, pathfinder: { setGoal() {} },
    game: { minY: -64, height: 384 }, registry: data, inventory: { items: () => [], slots: [] },
    entity: { position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true, yaw: 0, pitch: 0 },
    blockAt(v) {
      const p = v.floored(), name = blocks.get(p.toString()) ?? (p.y === 63 ? 'stone' : 'air')
      const b = Block.fromStateId(data.blocksByName[name].defaultState, 0); b.position = p; return b
    },
    async lookAt(at) {
      aim = at
      if (!slid) {
        slid = true
        // Simulate 0.08 bl residual walking momentum settling during lookAt.
        bot.entity.position = bot.entity.position.offset(0, 0, 0.08)
      }
    },
    async dig(b) {
      const clickable = FACES.some(f => faceAim(bot, b.position, f)?.equals?.(aim))
      dug.push({ pos: b.position, clickable })
      blocks.set(b.position.toString(), 'air')
      bot._client.emit('block_change', { location: b.position, type: data.blocksByName.air.defaultState })
    },
    async waitForTicks() {
      if (controls.has('forward')) { walked++; bot.entity.position = new Vec3(aim.x, 64, aim.z) }
    },
    setControlState(name, on) { if (on) controls.add(name); else controls.delete(name) },
    clearControlStates() { controls.clear() }
  })
  bot.world = { getBlock: p => bot.blockAt(p), raycast: WorldSync.prototype.raycast }
  for (const z of [-1, 0, 1]) for (const y of [64, 65, 66]) blocks.set(new Vec3(1, y, z).toString(), 'stone')
  const session: any = { require: () => bot, runIntent: (_name, run) => run(ctl) }
  const r: any = await terrainMethods({ session } as any).dig_to({ at: { x: 8.5, y: 64, z: .5 }, maxSteps: 1 })
  assert.equal(r.dug, 2, 'residual walking slide during lookAt must not abort dig_to')
  assert.equal(walked, 1)
  assert.ok(dug.every(d => d.clickable))
})

test('drink_buffs runs via session.runIntent and halts cleanly when ctl aborts mid-drink', async () => {
  const intents: string[] = []
  let consumed = 0, deactivated = 0
  const potion = {
    name: 'potion',
    type: data.itemsByName.potion.id,
    count: 1,
    componentMap: new Map([['potion_contents', { data: { potionId: 13 } }]])
  }
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
  const bot: any = {
    entity: { effects: {} },
    registry: data,
    inventory: { items: () => [potion] },
    deactivateItem: () => { deactivated++ },
    equip: async () => { ctl.abort() },
    consume: async () => { consumed++ }
  }
  const session: any = {
    bot,
    require: () => bot,
    immediate: () => assert.fail('drink_buffs must use runIntent, not immediate'),
    runIntent: async (name: string, fn: any) => { intents.push(name); return fn(ctl) }
  }
  const res: any = await swarmMethods({ session } as any).drink_buffs({ kinds: ['swiftness', 'strength'] })
  assert.deepEqual(intents, ['drink_buffs'])
  assert.equal(consumed, 0, 'aborted drink_buffs must not consume after equip')
  assert.equal(deactivated, 1, 'ctl.onAbort must deactivate active drink')
  assert.equal(res.aborted, true)
  assert.equal(ctl.onAbort.length, 0)
})

test('box_out wires ctl abort into breakOut and stops follow-up foot dig', async () => {
  const blocks = new Map<string, string>()
  const dug: Vec3[] = []
  let stopDiggingCalls = 0, headStarted!: () => void, releaseHead!: () => void
  const headReady = new Promise<void>(resolve => { headStarted = resolve })
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
  // Seal a 1x2x1 box around (0, 64, 0) with cobblestone walls and solid floor outside.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    blocks.set(new Vec3(dx, 64, dz).toString(), 'cobblestone')
    blocks.set(new Vec3(dx, 65, dz).toString(), 'cobblestone')
  }
  blocks.set(new Vec3(0, 66, 0).toString(), 'cobblestone')
  const bot: any = Object.assign(testBot(), {
    version: '1.21.11', _client: new EventEmitter(), entities: {},
    game: { minY: -64, height: 384 }, registry: data,
    inventory: { items: () => [{ name: 'iron_pickaxe', type: data.itemsByName.iron_pickaxe.id, count: 1 }], slots: [] },
    entity: { position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true },
    blockAt(v) {
      const p = v.floored(), name = blocks.get(p.toString()) ?? (p.y === 63 ? 'stone' : 'air')
      const b = Block.fromStateId(data.blocksByName[name].defaultState, 0); b.position = p; return b
    },
    equip: async () => {},
    stopDigging: () => { stopDiggingCalls++ },
    clearControlStates: () => {},
    setControlState: () => {},
    dig: async (b: any) => {
      dug.push(b.position.clone())
      if (dug.length === 1) {
        headStarted()
        await new Promise<void>(resolve => { releaseHead = resolve })
        blocks.set(b.position.toString(), 'air')
      }
    }
  })
  const session: any = { bot, require: () => bot, runIntent: async (_name: string, fn: any) => fn(ctl) }
  const pending = swarmMethods({ session } as any).box_out({})
  await headReady
  ctl.abort()
  const res: any = await pending
  releaseHead()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(res.left, false)
  assert.equal(res.why, 'прервано')
  assert.equal(stopDiggingCalls, 1)
  assert.equal(dug.length, 1, 'aborted box_out must not start digging the second (feet) block')
  assert.equal(ctl.onAbort.length, 0)
})

test('block_behind runs via session.runIntent and passes ctl to blockBehind', async () => {
  const intents: string[] = []
  const ctl = { aborted: true, onAbort: [] }
  const bot = testBot()
  bot.username = 'Runner'; bot.health = 20; bot.food = 20
  Object.assign(bot.entity, { name: 'player', width: .6, metadata: [], position: new Vec3(.5, 64, .5) })
  bot.blockAt = p => {
    const c = p.floored(), solid = c.y === 63 || Math.abs(c.z) === 1 && c.y >= 64 && c.y <= 65
    const b = Block.fromStateId(data.blocksByName[solid ? 'stone' : 'air'].defaultState, 0); b.position = c; return b
  }
  bot.world = { getBlock: bot.blockAt, raycast: WorldSync.prototype.raycast }
  const foe = { id: 2, username: 'Pursuer', name: 'player', type: 'player', width: .6, height: 1.8,
    position: new Vec3(6.5, 64, .5), velocity: new Vec3(-.25, 0, 0), yaw: Math.PI / 2, onGround: true, metadata: [], equipment: [] }
  bot.players = { Pursuer: { entity: foe } }; bot.entities = { 2: foe }
  bot.inventory.slots[36] = { name: 'cobblestone', count: 16, type: data.itemsByName.cobblestone.id }
  const session: any = {
    bot,
    require: () => bot,
    immediate: () => assert.fail('block_behind must use runIntent, not immediate'),
    runIntent: async (name: string, fn: any) => { intents.push(name); return fn(ctl) }
  }
  const res: any = await terrainCoverMethods({ session } as any).block_behind({ from: 'Pursuer' })
  assert.deepEqual(intents, ['block_behind'])
  assert.equal(res.ok, false)
  assert.equal(res.why, 'нет времени на блок')
})
