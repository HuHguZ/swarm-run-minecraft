import test from 'node:test'
import assert from 'node:assert/strict'
const fs = require('node:fs'), path = require('node:path'), { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3'), data = require('minecraft-data')('1.21.11'), Block = require('prismarine-block')(data)
const clear = fs.existsSync(path.join(__dirname, '../src/blaze-clear.js')) ? require('../src/blaze-clear') : {}
const sp = new Vec3(0, 0, 0)
function block(name, p) { const b = Block.fromStateId(data.blocksByName[name].defaultState, 0); b.position = p; return b }
function fixture() {
  const cells = new Map(), bot: any = new EventEmitter()
  const put = (x, y, z, name) => cells.set(`${x},${y},${z}`, name)
  bot.game = { minY: -64, height: 384, dimension: 'the_nether' }; bot.registry = data
  bot.entity = { position: new Vec3(4.5, 0, 2.5), onGround: true, id: 1 }; bot.entities = {}
  bot.health = bot.food = 20
  bot.inventory = { items: () => [{ name: 'iron_pickaxe', type: data.itemsByName.iron_pickaxe.id, count: 1 }] }
  bot.blockAt = (p) => block(cells.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || (p.y < -1 ? 'bedrock' : 'air'), p.floored())
  bot.world = { getColumn: (cx, cz) => ({ getBlockStateId: p => bot.blockAt(new Vec3(cx * 16 + p.x, p.y, cz * 16 + p.z)).stateId }) }
  bot.canDigBlock = () => true; bot.equip = async () => {}; bot.lookAt = async () => {}
  bot.dig = async b => { put(b.position.x, b.position.y, b.position.z, 'air') }; bot.stopDigging = () => {}
  put(0, 0, 0, 'spawner'); put(2, 1, 0, 'nether_brick_fence'); put(2, 0, 0, 'nether_bricks')
  return { bot, put, cells }
}
test('blaze clearing integrates the triangular X/Z distribution and the real 0.6 x 1.8 box', () => {
  assert.equal(typeof clear.chance, 'function')
  assert.equal(clear.chance(sp, []), 1)
  const one = block('spawner', sp)
  assert.ok(Math.abs(clear.chance(sp, [one]) - .9136) < 1e-8)
  assert.equal(clear.chance(sp, [one, one]), clear.chance(sp, [one]), 'overlaps must be unioned')
  assert.equal(clear.chance(sp, [one], new Set(['0,0,0'])), 1)
})
test('blaze rate retries a completely failed cycle on the following tick', () => {
  assert.equal(typeof clear.rate, 'function')
  assert.equal(clear.rate(0), 0)
  assert.ok(Math.abs(clear.rate(1) - 4800 / 500.5) < 1e-12)
  assert.ok(clear.rate(.5) > 4.8, 'the four failed attempts do not start another 200..799 tick wait')
})
test('clearing price uses remaining rods and an ETA horizon, never an elapsed-time mode switch', () => {
  assert.equal(typeof clear.price, 'function')
  assert.ok(clear.price(.15, 7, .5, Infinity).netSeconds > 0)
  assert.equal(clear.price(.02, 1, 10, Infinity), null)
  assert.equal(clear.price(.15, 0, .5, Infinity), null)
  assert.equal(clear.price(.15, 7, .5, .1), null)
  for (const bad of [NaN, Infinity, -.01, 1.1]) assert.equal(clear.price(bad, 7, .5, 500), null)
})
test('a visible profitable isolated fence can be selected, then actually mined', async () => {
  assert.equal(typeof clear.plan, 'function')
  const { bot } = fixture(), ctl = { aborted: false }
  const p = clear.plan(bot, sp, { rods: 7 })
  assert.ok(p, 'at least one safe observable obstacle is useful')
  assert.equal(p.mode, 'pick'); assert.ok(p.gain > 0); assert.ok(p.netSeconds > 0)
  const dig = bot.dig; let digLook = null
  bot.dig = async (b, forceLook) => { digLook = forceLook; await dig(b) }
  const result = await clear.execute({ bot }, ctl, p, () => true)
  assert.equal(result.ok, true); assert.equal(bot.blockAt(p.pos).name, 'air')
  assert.equal(digLook, 'ignore', 'mineflayer must preserve the certified face aim instead of looking at the centre')
  assert.ok(bot._ndBlazeClearOverheadMs >= require('../src/game-clock').TICK_MS)
  assert.equal(bot.listenerCount('physicsTick'), 0)
})
test('no rods missing, no tool, protected cover, or an unreachable target means no pick action', () => {
  assert.equal(typeof clear.plan, 'function')
  const { bot } = fixture()
  assert.equal(clear.plan(bot, sp, { rods: 0 }), null)
  assert.equal(clear.plan(bot, sp, { rods: 7, windowMs: 100 }), null, 'the physical attack window must fit the tool ETA')
  bot.canDigBlock = () => false; assert.equal(clear.plan(bot, sp, { rods: 7 }), null)
  bot.canDigBlock = () => true
  const p = clear.plan(bot, sp, { rods: 7 }); assert.ok(p)
  assert.equal(clear.plan(bot, sp, { rods: 7, protectedCells: [new Vec3(2, 1, 0), new Vec3(2, 0, 0)] }), null)
  bot.inventory.items = () => []; assert.equal(clear.plan(bot, sp, { rods: 7 }), null)
})
test('a hidden neighbour is not read as proof against lava; exposed lava also prevents excavation', () => {
  assert.equal(typeof clear.safeCell, 'function')
  const { bot, put } = fixture(), pos = new Vec3(2, 1, 0)
  put(1, 1, 0, 'lava'); assert.equal(clear.safeCell(bot, pos, []), false)
  put(1, 1, 0, 'air'); put(2, 2, 0, 'gravel'); assert.equal(clear.safeCell(bot, pos, []), false)
  assert.equal(clear.safeCell(bot, new Vec3(0, 0, 0), []), false, 'never break the spawner')
})
test('execution rechecks aim and world state after the plan; abort never starts digging', async () => {
  assert.equal(typeof clear.execute, 'function')
  const { bot, put } = fixture(), p = clear.plan(bot, sp, { rods: 7 }); assert.ok(p)
  let digs = 0; bot.dig = async () => { digs++ }
  assert.equal((await clear.execute({ bot }, { aborted: true }, p, () => true)).ok, false)
  put(p.pos.x, p.pos.y, p.pos.z, 'lava')
  assert.equal((await clear.execute({ bot }, { aborted: false }, p, () => true)).ok, false)
  assert.equal(digs, 0)
})
test('a threat or lost HP interrupts the dig and removes its watcher', async () => {
  assert.equal(typeof clear.execute, 'function')
  const { bot } = fixture(), p = clear.plan(bot, sp, { rods: 7 }); assert.ok(p)
  let danger = false, stopped = 0
  bot.dig = async () => { danger = true; bot.emit('physicsTick'); throw new Error('Digging aborted') }
  bot.stopDigging = () => { stopped++ }
  assert.equal((await clear.execute({ bot }, { aborted: false }, p, () => !danger)).ok, false)
  assert.ok(stopped > 0); assert.equal(bot.listenerCount('physicsTick'), 0)
})
test('TNT pricing never destroys the spawner, its cover, or an unseen lava boundary', () => {
  assert.equal(typeof clear.tntPrice, 'function')
  const { bot } = fixture()
  assert.equal(clear.tntPrice(bot, sp, { rods: 7 }), null, 'do not acquire or craft explosives for this')
  bot.inventory.items = () => ['tnt', 'flint_and_steel'].map(name => ({ name, count: 1, type: data.itemsByName[name].id }))
  assert.equal(clear.tntPrice(bot, sp, { rods: 7 }), null, 'the unknown blast envelope and spawner loss cannot be approved')
})

test('a full above-platform column is priced as a set, and a threat after its first block prevents the next dig', async () => {
  let found = false
  for (let x = -2; x <= 3 && !found; x++) for (let z = -2; z <= 3 && !found; z++) {
    if (x === 0 && z === 0) continue
    const { bot, put, cells } = fixture(); cells.clear(); put(0, 0, 0, 'spawner')
    for (let y = -1; y <= 2; y++) put(x, y, z, 'nether_bricks')
    const remembered = new Map()
    for (let a = -5; a <= 5; a++) for (let b = -5; b <= 5; b++) for (let y = -3; y <= 4; y++) {
      const p = new Vec3(a, y, b); remembered.set(`${a},${y},${b}`, bot.blockAt(p))
    }
    // Legitimate prior views from walking around the column; the current aim still has to reach both faces.
    bot._ndBlazeClearObserved = { world: bot.world, dimension: bot.game.dimension, cells: remembered }
    const blocks = [...cells].map(([k, n]) => block(n, new Vec3(...k.split(',').map(Number))))
    const before = clear.chance(sp, blocks)
    if ([1, 2].some(y => clear.chance(sp, blocks, new Set([`${x},${y},${z}`])) > before + 1e-12)) continue
    const p = clear.plan(bot, sp, { rods: 7 })
    if (p?.targets?.length === 3) {
      assert.ok(p.gain > 0 && p.netSeconds > 0); found = true
      const ctl = { aborted: false }, dig = bot.dig
      bot.dig = async b => { await dig(b); ctl.aborted = true }
      const r = await clear.execute({ bot }, ctl, p, () => true)
      assert.equal(r.ok, false); assert.equal(r.partial, true); assert.equal(r.completed.length, 1)
      assert.notEqual(bot.blockAt(p.targets[1].pos).name, 'air')
    }
  }
  assert.equal(found, true, 'the three spawn levels can make the entire above-platform column more valuable than its pairs')
})

test('the conservative unknown-volume price never promises more than a known-geometry saving', () => {
  for (const gain of [.01, .05, .2]) for (const rods of [1, 7]) {
    const p = clear.price(gain, rods, 0, Infinity)
    for (let before = .05; before + gain < 1; before += .05) {
      const actual = rods * 120 * (1 / clear.rate(before) - 1 / clear.rate(before + gain))
      assert.ok(actual + 1e-9 >= p.savedSeconds)
    }
  }
})

test('observed obstacles tighten the price bound without assuming the hidden volume is empty', () => {
  assert.equal(clear.price(.01, 7, 1.5, Infinity), null)
  assert.ok(clear.price(.01, 7, 1.5, Infinity, .5)?.netSeconds > 0)
  assert.equal(clear.price(.1, 7, .5, 60, .95), null, 'a probability bound cannot exceed one after clearing')
  assert.ok(clear.price(.1, 1, .5, 60, 0)?.netSeconds > 0, 'a completely blocked source can be made useful')
})

test('air seen through fence gaps is observed, while an opaque lava sheet stops those same rays', () => {
  assert.equal(typeof clear.observe, 'function')
  const a = fixture(); a.bot.entity.position = new Vec3(4.5, 0, .5)
  clear.observe(a.bot, sp)
  assert.ok(a.bot._ndBlazeClearObserved.cells.has('1,1,0'), 'a fence is not an opaque full cube')
  const b = fixture(); b.bot.entity.position = new Vec3(4.5, 0, .5)
  for (let y = -1; y <= 3; y++) for (let z = -4; z <= 4; z++) b.put(2, y, z, 'lava')
  clear.observe(b.bot, sp)
  assert.equal(b.bot._ndBlazeClearObserved.cells.has('1,1,0'), false)
})

test('TNT uses minimum guaranteed masonry yield and maximum damage with a bounded moving centre', () => {
  const { bot } = fixture(), cell = new Vec3(2, 1, 0), cells = new Map()
  const add = (p, name) => cells.set(`${p.x},${p.y},${p.z}`, block(name, p))
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [0, 1]) add(cell.offset(dx, y, dz), 'nether_bricks')
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) add(cell.offset(x, -1, z), 'nether_bricks')
  add(sp, 'spawner')
  const seen = p => cells.get(`${p.x},${p.y},${p.z}`) || block('air', p)
  const envelope = clear.tntEnvelope(bot, cell, [sp], seen)
  assert.ok(envelope); assert.equal(envelope.guaranteed.size, 5)
  assert.equal(envelope.possible.has('0,0,0'), false, 'a protected spawner must survive maximum energy')
  assert.equal(clear.tntEnvelope(bot, cell, [cell.offset(1, 0, 0)], seen), null, 'protect the actual cover')
  const hidden = p => p.equals(cell.offset(0, -2, 0)) ? null : seen(p)
  assert.equal(clear.tntEnvelope(bot, cell, [], hidden), null, 'unknown lava under the floor is not cleared by a certificate')
})

test('TNT exact placement and the final ignition guard preserve the previous arena API', async () => {
  const tnt = require('../src/tnt'), build = require('../src/build'), original = build.placeBlockAt
  try {
    for (const approved of [false, true]) {
      const { bot, put } = fixture(), placements = [], cell = new Vec3(2, 1, 0)
      put(cell.x, cell.y, cell.z, 'air')
      let ignited = 0
      bot.inventory.items = () => ['tnt', 'flint_and_steel'].map(name => ({ name, count: 1, type: data.itemsByName[name].id }))
      build.placeBlockAt = async (_bot, p) => { placements.push(p); put(p.x, p.y, p.z, 'tnt'); return { ok: true } }
      bot.activateBlock = async b => { ignited++; put(b.position.x, b.position.y, b.position.z, 'air') }
      bot.waitForTicks = async () => {}
      const r = await tnt.tntAt({ require: () => bot }, { aborted: false }, { at: cell.offset(.5, 0, .5), maxOff: 0, exact: true, beforeIgnite: () => approved })
      assert.equal(placements.length, 1); assert.ok(placements[0].equals(cell))
      assert.equal(ignited, Number(approved)); assert.equal(r.lit, approved)
    }
  } finally { build.placeBlockAt = original }
})
