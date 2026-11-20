import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import * as locks from '../src/reflex-lock'
import { TacticalSystem } from '../src/tactics/minecraft'
import { type TacticalState } from '../src/tactics/state'
import { scoopWater } from '../src/obsidian'
import { worldOf, Block } from './parkour-fixture'

function waterFixture(foreign = false, inventoryDelay = 0) {
  const { bot, world } = worldOf([[0, 0, 0, 'stone']])
  const cell = new Vec3(0, 1, 0), base = world.getBlock.bind(world)
  let source = foreign, blocked = false
  world.getBlock = p => {
    const q = p.floored()
    const name = q.equals(cell) && source ? 'water' : blocked && q.equals(cell.offset(0, 1, 0)) ? 'lava' : null
    if (!name) return base(q)
    const b = Block.fromProperties(name, { level: 0 }); b.position = q; return b
  }
  const WorldSync = require('../node_modules/prismarine-world/src/worldsync')
  bot.world = { raycast: WorldSync.prototype.raycast.bind(world) }
  bot.game.dimension = 'overworld'; bot.entity.metadata = [1]; bot.entity.height = 1.8
  bot._client = Object.assign(new EventEmitter(), { write() {} })
  bot.entities = {}; bot.pathfinder = { setGoal() {}, stop() {} }
  bot.clearControlStates = () => {}; bot.setControlState = () => {}
  const item = { name: 'water_bucket', type: 1, count: 1, slot: 36 }
  bot.inventory.items = () => [item]; bot.heldItem = item
  bot.equip = async i => { bot.heldItem = i }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async () => {}
  const session: any = { bot, bus: { emit() {} } }, clicks: Array<{ item: string; allowed: boolean }> = []
  bot._ndReflexSession = session
  bot.activateItem = () => {
    clicks.push({ item: item.name, allowed: locks.allowed(session) })
    if (item.name === 'water_bucket' && !source) {
      source = true
      if (inventoryDelay) clock.setTimeout(() => { item.name = 'bucket' }, inventoryDelay)
      else item.name = 'bucket'
    }
    else if (item.name === 'bucket' && source) { source = false; item.name = 'water_bucket' }
  }
  return { bot, session, item, cell, clicks, source: () => source, blocked: () => { blocked = true } }
}

async function waterAction({ foreign = false, preempt = false, inventoryDelay = 0 } = {}) {
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 0 })), f = waterFixture(foreign, inventoryDelay)
  let urgent = false
  const observe = (): TacticalState => ({ at: clock.now(), health: 20, food: 20, armor: 0, weapon: false, shield: false,
    enemies: [], incomingProjectiles: 0, burning: !!(f.bot.entity.metadata[0] & 1), lava: false, fireResistance: false,
    explosion: urgent, blast: urgent ? 'tnt' : null, dangerousFall: false, emergencyController: false, inWater: !!f.bot.entity.isInWater,
    cover: false, portal: false, escapeRoute: true, blocks: 0, water: f.item.name === 'water_bucket', edible: false,
    canFight: false, contact: false, shelter: null, protectedEncounter: false })
  const system = new TacticalSystem(f.session, { observe, record() {}, execute: (action, ctl, state) =>
    action.id === 'UseWater' ? (system as any).execute(action, ctl, state) : Promise.resolve({ acted: true }) })
  try {
    system.attach(f.bot); system.update(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    for (let tick = 1; tick <= 35; tick++) {
      timer.advanceTicks(1)
      if (tick === 3) {
        f.bot.entity.metadata[0] = 0; f.bot.entity.isInWater = f.source()
        urgent = preempt
      }
      system.update(true)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    return { ...f, snapshot: system.snapshot() }
  } finally { system.detach(); timer.dispose(); clock.activate(null) }
}

test('UseWater retains its hand through the captured early all-clear and recovers its own source', async () => {
  const f = await waterAction()
  assert.equal(f.source(), false, 'the source must be picked up before releasing the bounded water action')
  assert.deepEqual(f.clicks.map(c => c.item), ['water_bucket', 'bucket'])
  assert.ok(f.clicks.every(c => c.allowed), 'cleanup must still own the actual hand lease')
})

test('source and extinguish ACKs arriving before inventory consumption still wait for the own-source receipt', async () => {
  const f = await waterAction({ inventoryDelay: 350 })
  assert.equal(f.source(), false, 'the later bucket ACK must still lead to pickup within the existing extinguish budget')
  assert.deepEqual(f.clicks.map(c => c.item), ['water_bucket', 'bucket'])
  assert.ok(f.clicks.every(c => c.allowed))
})

test('a more urgent defence preempts water recovery without an aborted worker clicking its hand', async () => {
  const f = await waterAction({ preempt: true })
  assert.deepEqual(f.clicks.map(c => c.item), ['water_bucket'])
  assert.equal(f.source(), true, 'preemption may leave water, but never steals the replacement defence hand')
})

test('a pre-existing foreign source is never claimed as the extinguisher source', async () => {
  const f = await waterAction({ foreign: true })
  assert.equal(f.source(), true)
  assert.equal(f.clicks.filter(c => c.item === 'bucket').length, 0)
})

test('shared water pickup refuses an intervening lava source and an abort during aim', async () => {
  for (const mode of ['lava', 'abort']) {
    const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 0 })), f = waterFixture(true)
    f.item.name = 'bucket'
    const ctl = { aborted: false, onAbort: [] as Array<() => void> }
    if (mode === 'lava') f.blocked()
    const work = scoopWater(f.bot, f.cell, ctl)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (mode === 'abort') { ctl.aborted = true; for (const stop of ctl.onAbort) stop() }
      for (let i = 0; i < 30; i++) { timer.advanceTicks(1); await new Promise<void>(resolve => setImmediate(resolve)) }
      assert.equal(await work, false)
      assert.equal(f.clicks.length, 0)
    } finally { timer.dispose(); clock.activate(null) }
  }
})
