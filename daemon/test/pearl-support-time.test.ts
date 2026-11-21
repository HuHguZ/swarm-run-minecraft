import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import * as projectiles from '../src/throw'
import build = require('../src/build')
import * as tools from '../src/tools'
import { aerialMethods } from '../src/rpc/aerial'

function support(t, item: any, received: number) {
  const start = new Vec3(.5, 120, .5), at = new Vec3(2.5, 120, .5)
  const bot: any = { entity: { position: start }, ndClock: { age: 100n, serverTicks: 0, ticks: received - 100 },
    inventory: { items: () => [item] }, blockAt: q => ({ name: q.y < 120 ? 'stone' : 'air', boundingBox: q.y < 120 ? 'block' : 'empty', position: q }),
    look: async () => {}, setControlState() {}, clearControlStates() {} }
  let elapsed = 0
  t.mock.method(clock, 'now', () => elapsed)
  t.mock.method(clock, 'setTimeout', (fn, ms) => queueMicrotask(() => {
    elapsed += ms; bot.ndClock.ticks = received - 100 + Math.floor(elapsed / 50); fn()
  }))
  const ctl = { aborted: false }
  const rpc = aerialMethods({ session: { bot, require: () => bot, runIntent: (_name, worker) => worker(ctl) } } as any)
  return { bot, rpc, msg: { owner: 'Foe', at, block: at.floored().offset(0, -1, 0), eta: 20, gameTick: 100 },
    worldTick: () => 100 + bot.ndClock.ticks }
}

for (const mode of ['anchored', 'legacy', 'late lingering', 'packet lag', 'new clock', 'future epoch'] as const) test('pearl potion firing tick: ' + mode, async t => {
  const item = { name: mode === 'late lingering' ? 'lingering_potion' : 'splash_potion',
    componentMap: new Map([['potion_contents', { data: { potion: 'minecraft:harming' } }]]) }
  const f = support(t, item, mode === 'late lingering' ? 125 : 110)
  const fired: number[] = []
  t.mock.method(projectiles, 'aim', () => ({ ticks: 8 }))
  t.mock.method(projectiles, 'throwAt', async (_bot, _at, opts) => {
    if (mode === 'packet lag') f.bot.ndClock.ticks += 8
    if (mode === 'new clock') f.bot.ndClock = { ...f.bot.ndClock }
    if (opts.onAim?.({ sol: { ticks: 8 } }) === false) return { thrown: false }
    fired.push(f.worldTick()); return { thrown: true, ticks: 8 }
  })
  await f.rpc.pearl_potion({ ...f.msg, gameTick: mode === 'legacy' ? undefined : mode === 'future epoch' ? 500 : 100 })
  assert.deepEqual(fired, mode === 'anchored' ? [112] : mode === 'legacy' ? [121] : [])
})

for (const kind of ['lava', 'dig'] as const) test('a late hand swap cannot commit the physical pearl trap: ' + kind, async t => {
  const it = { name: kind === 'dig' ? 'iron_pickaxe' : 'lava_bucket', type: 42, count: 1 }
  const { bot, msg, rpc } = support(t, it, 100), block = msg.block
  let equipped = 0, used = 0
  bot.inventory.slots = []
  bot.entity.onGround = true
  bot.world = { raycast: () => ({ face: 1, position: block }) }
  bot.blockAt = p => p.y < 120 ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]],
    hardness: 1.5, digTime: tool => tool === it.type ? 100 : 2000 } : { name: 'air', boundingBox: 'empty', position: p.floored() }
  bot.equip = async () => { equipped++; bot.heldItem = it; bot.ndClock.ticks = 21 }
  bot.lookAt = async () => {}
  bot.dig = async () => { used++ }
  bot.activateItem = () => { used++ }
  const r = await rpc.pearl_trap(msg)
  assert.equal(equipped, 1, JSON.stringify(r))
  assert.equal(r.ok, false)
  assert.equal(used, 0, 'no lava or dig packet after the inventory wait')
})

for (const mode of ['in time', 'late before dispatch', 'late on approach'] as const) test('pearl trap accepts work that still fits: ' + mode, async t => {
  const f = support(t, { name: 'cobweb' }, mode === 'late before dispatch' ? 115 : 100)
  let placed = 0
  t.mock.method(tools, 'bestFor', () => ({ ms: Infinity }))
  t.mock.method(build, 'placeBlockAt', async () => { placed++; return { ok: true } })
  if (mode === 'late on approach') {
    f.bot.entity.position = new Vec3(-2.5, 120, .5)
    f.bot.look = async () => { f.bot.ndClock.ticks = 21; f.bot.entity.position = f.msg.at }
    t.mock.method(clock, 'setTimeout', fn => queueMicrotask(fn))
  }
  await f.rpc.pearl_trap(f.msg)
  assert.equal(placed, Number(mode === 'in time'))
})
