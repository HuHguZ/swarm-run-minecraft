import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { REPO_ROOT } from '../src/paths'

const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry), Item = (require('prismarine-item') as typeof import('prismarine-item').default)(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
import * as clockMod from '../src/game-clock'
import movement = require('../src/movement')
import pick = require('../src/pick')
const data = JSON.parse(readFileSync(path.join(REPO_ROOT, 'daemon/test/fixtures/geo-j1-water.json'), 'utf8'))
data.cases.push(...JSON.parse(readFileSync(path.join(REPO_ROOT, 'daemon/test/fixtures/geo-a6-water.json'), 'utf8')).cases)
const IDLE = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

async function replay(tag: string) {
  const c = data.cases.find(c => c.tag === tag), f = c.geometry, cells = new Int32Array(f.total)
  let at = 0
  for (let i = 0; i < f.runs.length; i += 2) {
    const n = f.runs[i], index = f.runs[i + 1]
    assert.ok(n > 0 && at + n <= cells.length && index >= 0 && index < f.palette.length)
    cells.fill(f.palette[index].sid, at, at + n); at += n
  }
  assert.equal(at, cells.length)
  const indexOf = p => {
    const q = p.floored(), [x, y, z] = [q.x, q.y, q.z].map((v, i) => v - f.min[i])
    return x < 0 || y < 0 || z < 0 || x >= f.size[0] || y >= f.size[1] || z >= f.size[2] ? -1 : (y * f.size[2] + z) * f.size[0] + x
  }
  for (const e of c.edits) {
    const i = indexOf(new Vec3(e.at[0], e.at[1], e.at[2])); assert.ok(i >= 0)
    assert.equal(Block.fromStateId(cells[i]).name, 'water', e.reason)
    cells[i] = registry.blocksByName[e.name].defaultState
  }
  let inPhysics = false
  const cache = new Map(), world: any = { getBlock(p) {
    const q = p.floored(), i = indexOf(q)
    if (i < 0) { assert.ok(!inPhysics, 'native body left saved geometry'); return null }
    const sid = cells[i]
    if (cache.get(i)?.stateId !== sid) { const b = Block.fromStateId(sid); b.position = q; cache.set(i, b) }
    return cache.get(i)
  } }
  world.getColumn = (cx, cz) => ({ getBlockStateId: p => world.getBlock(new Vec3(cx * 16 + p.x, p.y, cz * 16 + p.z))?.stateId ?? -1 })
  const wet = p => movement.waterCell(world.getBlock(p))
  const clock = clockMod.activate(new clockMod.GameClock({ manual: true, epoch: 0 }))
  let controls = { ...IDLE }, air = c.body.air, settled = false, result: any, error: any, digToken = 0
  const ctl = { aborted: false, onAbort: [] }, slots = Array(46).fill(null), stacks: any[] = [], digs: string[] = []
  for (const [name, count] of [[c.res.pick + '_pickaxe', 1], [c.res.sword + '_sword', 1], ['cobblestone', c.res.blocks]]) {
    const i = new Item(registry.itemsByName[name].id, count); i.slot = 36 + stacks.length; slots[i.slot] = i; stacks.push(i)
  }
  const b = c.body
  // This rounded legacy record touched Z291; start the native-width body on that same legal face.
  const startZ = c.tag === 'j1k1-s2-2' ? 291 + Math.fround(.6) / 2 : b.p[2]
  const airKey = registry.entitiesByName.player.metadataKeys.indexOf('air_supply'), poseKey = registry.entitiesByName.player.metadataKeys.indexOf('pose')
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, world, game: { dimension: 'overworld', minY: -64, height: 384 },
    entity: { position: new Vec3(b.p[0], b.p[1], startZ), velocity: new Vec3(b.v[0], b.v[1], b.v[2]), yaw: b.yaw, pitch: b.pitch, onGround: !!b.onGround,
      isInWater: true, isInLava: false, isInWeb: false, height: 1.8, width: .6, effects: {}, attributes: {}, metadata: [] },
    health: c.hp, food: c.food, oxygenLevel: Math.max(0, Math.round(air / 15)), physics: native.Physics(registry, world),
    inventory: { slots, items: () => stacks }, heldItem: stacks[0], entities: {}, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    supportFeature: key => registry.supportFeature(key), blockAt: p => world.getBlock(p), pathfinder: { setGoal() {} },
    equip: async item => { bot.heldItem = item }, canDigBlock: block => block.diggable && block.position.distanceTo(bot.entity.position) < 5,
    stopDigging: () => { digToken++ }, setControlState: (k, v) => { controls[k] = v }, getControlState: k => controls[k], clearControlStates: () => { controls = { ...IDLE } },
    lookAt: async p => { const d = p.minus(pick.eyeOf(bot)); bot.entity.yaw = Math.atan2(-d.x, -d.z); bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z)) },
    async dig(block) {
      const mine = ++digToken
      digs.push(block.name)
      const ms = block.digTime(bot.heldItem?.type ?? null, false, wet(pick.eyeOf(bot)), !bot.entity.onGround, [], {})
      await clockMod.sleep(ms)
      if (mine !== digToken || ctl.aborted) throw new Error('dig cancelled')
      // shortcut: only water directly above the broken cell; no general fluid simulation.
      cells[indexOf(block.position)] = registry.blocksByName[wet(block.position.offset(0, 1, 0)) ? 'water' : 'air'].defaultState
    }
  })
  bot.entity.metadata[airKey] = air; bot.entity.metadata[poseKey] = b.pose ?? 0
  ;(require('../src/gamedata') as typeof import('../src/gamedata')).fixMaterials(registry)
  ;(require('../src/swimming') as typeof import('../src/swimming')).install(bot)
  assert.equal(bot.oxygenLevel, b.oxygen, 'same breath value as the recorded Surface start')
  movement.escapeWater(bot, ctl, { timeoutMs: 15000, visibleOnly: true }).then(r => { result = r; settled = true }, e => { error = e; settled = true })
  let tick = 0
  try {
    for (; tick < 400 && bot.health > 0 && !settled; tick++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (settled) break
      inPhysics = true
      try { const state = new native.PlayerState(bot, controls); bot.physics.simulatePlayer(state, world); state.apply(bot); bot.entity.height = state.ndPoseHeight ?? 1.8 } finally { inPhysics = false }
      if (wet(pick.eyeOf(bot))) { if (--air <= -20) { air = 0; bot.health = Math.max(0, bot.health - 2) } } else air = Math.min(300, air + 4)
      bot.oxygenLevel = Math.max(0, Math.round(air / 15)); bot.entity.metadata[airKey] = air
      bot.emit('physicsTick'); clock.advanceTicks(1)
    }
    return { hp: bot.health, air, tick, result, error, digs, position: bot.entity.position.clone() }
  } finally {
    ctl.aborted = true; digToken++
    for (let i = 0; i < 20 && !settled; i++) { clock.advanceTicks(1); await new Promise<void>(resolve => setImmediate(resolve)) }
    bot.emit('end'); clock.dispose()
  }
}

test('j1 s2-4: visible water under an overhang leads to a bank before drowning', async () => {
  const r = await replay('j1k1-s2-4')
  assert.equal(r.error, undefined)
  assert.equal(r.hp, 20, JSON.stringify(r)); assert.equal(r.result?.ok, true, JSON.stringify(r))
  assert.ok(r.position.y >= 63); assert.deepEqual(r.digs, [])
})

test('j1 s2-2: inferred pre-dig stone roof is bypassed while the body recovers its air', async () => {
  const r = await replay('j1k1-s2-2')
  assert.equal(r.error, undefined)
  assert.equal(r.hp, 20, JSON.stringify(r)); assert.equal(r.result?.breathing, true, JSON.stringify(r))
  assert.ok(r.air >= 255); assert.deepEqual(r.digs, [])
})

test('j1 s2-3: restored recorded air pocket is reached by descending, then the connected route leads to shore', async () => {
  const r = await replay('j1k1-s2-3')
  assert.equal(r.error, undefined)
  assert.ok(r.hp > 0, JSON.stringify(r)); assert.equal(r.result?.ok, true, JSON.stringify(r))
  assert.ok(r.position.y >= 63); assert.deepEqual(r.digs, [])
})

// Recorded positions/pose and raw block states; the bank is found through line of sight.
test('A6: submerged glow lichen is water, not a breathable land target', async () => {
  const r = await replay('ia8-fp1-s13-1-iron-401')
  assert.equal(r.error, undefined); assert.equal(r.hp, 19, JSON.stringify(r))
  assert.equal(r.result?.ok, true, JSON.stringify(r)); assert.ok(r.air > 125)
  assert.deepEqual(r.digs, [])
})

test('A6: captured SWIMMING pose fits under the lake roof and reaches air', async () => {
  const r = await replay('fp3-s14-1')
  assert.equal(r.error, undefined); assert.ok(r.hp >= 16, JSON.stringify(r))
  assert.equal(r.result?.breathing, true, JSON.stringify(r)); assert.ok(r.air >= 255)
  assert.deepEqual(r.digs, [])
})
