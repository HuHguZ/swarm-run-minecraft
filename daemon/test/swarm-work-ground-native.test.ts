import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { fixMaterials } from '../src/gamedata'
import { getPhysics } from '../src/tick-plugins'
import { swarmWork } from '../src/swarm-work'
import { bestFor } from '../src/tools'

const registry = require('prismarine-registry')('1.21.11')
fixMaterials(registry)
const Block = require('prismarine-block')(registry), native = getPhysics()
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

function fixture({ floor = true, rising = false, timeoutSeconds = 12, still = false, afterStep = false } = {}) {
  const game = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const at = new Vec3(-1, 63, 0), air = registry.blocksByName.air.minStateId
  const changes = new Map<string, number>(), controls: any = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }, digs: any[] = []
  const pickaxe = { ...registry.itemsByName.diamond_pickaxe, type: registry.itemsByName.diamond_pickaxe.id, enchants: [] }
  let hasFloor = floor
  const world = { getBlock(p) {
    const pos = p.floored(), state = changes.get(pos.toString()) ??
      (pos.equals(at) ? registry.blocksByName.obsidian.minStateId : hasFloor && pos.y === 63 ? registry.blocksByName.stone.minStateId : air)
    const b = Block.fromStateId(state, 0); b.position = pos; return b
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, health: 20, food: 20,
    game: { dimension: 'overworld', minY: -64, height: 384 },
    inventory: { slots: [], items: () => [pickaxe] }, entities: {}, _client: new EventEmitter(),
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { id: 1, position: new Vec3(.5, afterStep ? 65 : 64.4315238, .5), velocity: new Vec3(0, afterStep ? 0 : rising ? .16477328 : -.376630498, 0),
      yaw: 0, pitch: 0, onGround: false, isInWater: false, isInLava: false, isInWeb: false,
      attributes: {}, effects: {}, metadata: [], width: .6, height: 1.8 },
    physics: native.Physics(registry, world),
    blockAt: p => world.getBlock(p), getControlState: key => !!controls[key],
    setControlState: (key, value) => { controls[key] = value }, clearControlStates: () => { for (const key in controls) controls[key] = false },
    canDigBlock: () => true, equip: async item => { bot.heldItem = item }, lookAt: async () => {}, stopDigging: () => {},
    _updateBlockState: (p, state) => changes.set(p.toString(), state)
  })
  bot.dig = async block => {
    const ms = bestFor(bot, block).ms
    digs.push({ ms, start: clock.now() - 1000, onGround: bot.entity.onGround })
    await clock.sleep(ms)
    changes.set(at.toString(), air)
    bot._client.emit('block_change', { location: at, type: air })
  }
  const ctl = { aborted: false, onAbort: [] as (() => void)[], abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
  return { bot, ctl, digs, game, removeFloor: () => { hasFloor = false },
    async run(onTick = (_tick: number) => {}) {
      let done = false, result: any
      const pending = swarmWork({ bot }, ctl, { kind: 'dig', at, timeoutSeconds, undermine: true })
        .then(value => { done = true; result = value })
      try {
        for (let tick = 1; tick <= 301; tick++) {
          await flush(); if (done) break
          if (!still) { const state = new native.PlayerState(bot, controls); bot.physics.simulatePlayer(state, world); state.apply(bot) }
          game.advanceTicks(1); bot.emit('physicsTick'); bot.emit('physicTick'); onTick(tick)
        }
        await flush(); assert.equal(done, true, 'worker must finish within its original budget')
        await pending
        assert.equal(ctl.onAbort.length, 0); assert.equal(bot.listenerCount('physicsTick'), 0)
        assert.equal(bot._client.listenerCount('block_change'), 0)
        return { ...result, elapsed: clock.now() - 1000 }
      } finally { ctl.abort(); game.dispose() }
    }
  }
}

test('native falling worker lands in two physical frames and mines obsidian within the same 12 s budget', async () => {
  const f = fixture(), result = await f.run()
  assert.equal(result.why, 'dug', JSON.stringify({ result, position: f.bot.entity.position })); assert.equal(result.done, true)
  assert.deepEqual(f.digs, [{ ms: 9400, start: 100, onGround: true }])
  assert.equal(result.elapsed, 9500)
})

test('landing time is charged to the original work budget', async () => {
  const f = fixture({ timeoutSeconds: 9.45 }), result = await f.run()
  assert.equal(result.why, 'work_exceeds_budget'); assert.equal(result.ms, 9400)
  assert.equal(result.elapsed, 100); assert.equal(f.digs.length, 0)
})

test('a just removed one-block step settles from zero vertical speed before pricing the lower layer', async () => {
  const f = fixture({ afterStep: true }), result = await f.run()
  assert.equal(result.why, 'dug')
  assert.equal(f.digs.length, 1); assert.equal(f.digs[0].onGround, true)
  assert.equal(f.digs[0].ms, 9400); assert.ok(result.elapsed < 12000)
})

test('void and rising workers reject an expensive dig without waiting', async () => {
  for (const options of [{ floor: false }, { rising: true }]) {
    const f = fixture(options), result = await f.run()
    assert.equal(result.why, 'work_exceeds_budget'); assert.equal(result.elapsed, 0)
    assert.equal(f.digs.length, 0)
  }
})

test('cancel and lost support stop a pending landing before any dig', async () => {
  for (const cancelled of [true, false]) {
    const f = fixture(), result = await f.run(tick => { if (tick === 1) { if (cancelled) f.ctl.abort(); else f.removeFloor() } })
    assert.equal(result.why, cancelled ? 'cancelled' : 'work_exceeds_budget')
    assert.equal(result.elapsed, 50); assert.equal(f.digs.length, 0)
  }
})

test('a landing that never completes retains the original timeout', async () => {
  const f = fixture({ timeoutSeconds: .2, still: true }), result = await f.run()
  assert.equal(result.why, 'timeout'); assert.equal(result.elapsed, 200)
  assert.equal(f.digs.length, 0)
})
