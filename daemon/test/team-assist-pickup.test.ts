import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { Vec3 } from 'vec3'
import { inPickup } from '../src/drops'
import { assist } from '../src/pvp/team-assist'
import { drive, worldOf } from './parkour-fixture'

function handoff(item: string, ownedTarget: number) {
  const slots: any[] = Array(46).fill(null), ctl = { aborted: false }
  let ticks = 0
  const bot: any = {
    entity: { position: new Vec3(.5, 64, .5), onGround: true }, entities: {}, players: {},
    registry: { itemsByName: { [item]: { stackSize: 64 } } },
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean), emptySlotCount: () => slots.slice(9, 45).filter(i => !i).length },
    blockAt(p) {
      const position = p.floored(), solid = position.x === 1 && position.y >= 64 && position.y <= 66
      return { position, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0,0,0,1,1,1]] : [] }
    },
    async waitForTicks() { ticks++; f.onTick(ticks) }
  }
  const f = { bot, slots, ctl, ticks: () => ticks, onTick: (_n: number) => {},
    run: () => assist({ require: () => bot }, { mode: 'pickup', item, ownedTarget }, ctl),
    drop(id: number, x: number, read: () => any) {
      bot.entities[id] = { id, name: 'item', height: .25, width: .25, position: new Vec3(x, 64.2, .5), getDroppedItem: read }
    } }
  return f
}

test('a courier receipt in armor or offhand releases the recipient without searching the floor', async () => {
  for (const [item, slot, n] of [['iron_boots', 8, 1], ['arrow', 45, 20]] as const) {
    const f = handoff(item, n)
    f.slots[slot] = { name: item, count: n }
    assert.equal((await f.run()).ok, true)
    assert.equal(f.ticks(), 0)
  }
})

test('handoff waits for the full requested quantity across visible stacks and delayed slot updates', async () => {
  const f = handoff('arrow', 20)
  f.slots[9] = { name: 'arrow', count: 4 }
  f.drop(1, .7, () => ({ name: 'arrow', count: 6 }))
  f.onTick = n => {
    if (n === 1) { f.slots[9].count += 6; delete f.bot.entities[1] }
    if (n === 3) f.drop(2, .8, () => ({ name: 'arrow', count: 10 }))
    if (n === 5) { f.slots[9].count += 10; delete f.bot.entities[2] }
  }
  assert.equal((await f.run()).ok, true)
  assert.equal(f.ticks(), 5)
})

test('a named handoff ignores an unknown decoy and a closer stack behind a wall', async () => {
  const f = handoff('arrow', 4)
  let hiddenReads = 0
  f.drop(1, 1.6, () => { hiddenReads++; return { name: 'arrow', count: 4 } })
  f.drop(2, .5, () => null)
  f.drop(3, -.6, () => ({ name: 'arrow', count: 4 }))
  f.onTick = n => { if (n === 2) { f.slots[9] = { name: 'arrow', count: 4 }; delete f.bot.entities[3] } }
  assert.equal((await f.run()).ok, true)
  assert.equal(hiddenReads, 0)
  assert.equal(f.ticks(), 2)
})

for (const outcome of ['thief', 'own late slot', 'named delivery', 'both taken', 'hidden alternative', 'other pile']) test('corpse pickup on a contested first drop: ' + outcome, async () => {
  const floor: [number, number, number, string][] = [[0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone'], [3, 0, 0, 'stone']]
  if (outcome === 'hidden alternative') floor.push([2, 1, 0, 'stone'], [2, 2, 0, 'stone'])
  const { bot, world } = worldOf(floor)
  drive(bot, world)
  const f = handoff('netherite_helmet', 1)
  bot.inventory = f.bot.inventory
  const drop = (id, x, name) => ({ id, name: 'item', height: .25, width: .25, position: new Vec3(x, 1.05, .5),
    getDroppedItem: () => ({ name, count: 1 }) })
  const first = drop(11, .6, 'netherite_helmet'), next = drop(12, 3.1, 'diamond_sword')
  if (outcome === 'other pile') next.position.x = 4.15
  let hiddenReads = 0
  if (outcome === 'hidden alternative') next.getDroppedItem = () => { hiddenReads++; return { name: 'diamond_sword', count: 1 } }
  const rival = { id: 13, name: 'player', type: 'player', username: 'Rival', position: new Vec3(.5, 1, 1.6), height: 1.8, width: .6 }
  bot.entities = { 11: first, 12: next, 13: rival }
  let ticks = 0
  bot.on('physicsTick', () => {
    ticks++
    if (ticks === 1) {
      bot.emit('playerCollect', outcome === 'own late slot' ? bot.entity : rival, first)
      delete bot.entities[first.id]
    }
    if (ticks === 3 && outcome === 'own late slot') f.slots[5] = { name: 'netherite_helmet', count: 1 }
    if (bot.entities[next.id] && inPickup(bot.entity.position, next.position)) {
      if (outcome === 'thief') f.slots[36] = { name: 'diamond_sword', count: 1 }
      else bot.emit('playerCollect', rival, next)
      delete bot.entities[next.id]
    }
  })
  const result = await assist({ require: () => bot }, { mode: 'pickup', maxD: 6, surveySite: { x: outcome === 'other pile' ? -2.2 : 1, y: 1, z: 0 },
    ...(outcome === 'named delivery' && { item: 'netherite_helmet', ownedTarget: 1 }),
    arena: { x: .5, z: .5, r: 8, killY: 0 } }, f.ctl)
  assert.equal(result.ok, outcome === 'thief' || outcome === 'own late slot', result.why)
  if (outcome === 'thief') {
    assert.equal(f.slots[36]?.name, 'diamond_sword')
    assert.match(result.why, /diamond_sword/)
  }
  if (outcome === 'own late slot') {
    assert.match(result.why, /netherite_helmet/)
    assert.ok(!inPickup(bot.entity.position, next.position), 'the helmet slot releases the grounded approach')
  }
  if (outcome === 'named delivery') assert.equal(bot.entity.position.x, .5)
  if (outcome === 'both taken') assert.equal(bot.entities[next.id], undefined, 'the second visible stack was also contested')
  if (outcome === 'hidden alternative') { assert.equal(bot.entity.position.x, .5); assert.equal(hiddenReads, 0) }
  if (outcome === 'other pile') assert.equal(bot.entity.position.x, .5)
})

test('free looting with a full pack can merge part of a visible pile past unusable rubble', async () => {
  const f = handoff('sandstone', 1)
  for (let slot = 9; slot < 45; slot++) f.slots[slot] = { slot, name: 'diamond_boots', count: 1 }
  f.slots[9] = { slot: 9, name: 'arrow', count: 63 }
  f.drop(1, .5, () => ({ name: 'sandstone', count: 1 }))
  let hiddenReads = 0
  f.drop(2, 1.3, () => { hiddenReads++; return { name: 'arrow', count: 12 } })
  f.drop(3, -.6, () => ({ name: 'arrow', count: 12 }))
  let turns = 0
  f.bot.lookAt = async () => { turns++ }
  f.onTick = () => { f.slots[9].count = 64 }
  assert.equal((await f.run()).ok, false)
  const result = await assist({ require: () => f.bot }, { mode: 'pickup' }, f.ctl)
  assert.equal(result.ok, true, result.why)
  assert.match(result.why, /arrow/)
  assert.equal(f.ticks(), 1)
  assert.equal(hiddenReads, 0)
  assert.equal(turns, 0)
})

test('free looting can also make a worthwhile swap for the next visible item', async () => {
  const f = handoff('diamond_boots', 1)
  for (let slot = 9; slot < 45; slot++) f.slots[slot] = { slot, name: 'diamond_helmet', count: 1 }
  f.slots[9] = { slot: 9, name: 'redstone', count: 1 }
  f.drop(1, .5, () => ({ name: 'sandstone', count: 1 }))
  f.drop(2, -.6, () => ({ name: 'diamond_boots', count: 1 }))
  f.bot.tossStack = async it => { assert.equal(it.name, 'redstone'); f.slots[it.slot] = null }
  f.onTick = () => { if (!f.slots[9]) f.slots[9] = { slot: 9, name: 'diamond_boots', count: 1 } }
  const result = await assist({ require: () => f.bot }, { mode: 'pickup' }, f.ctl)
  assert.equal(result.ok, true, result.why)
  assert.equal(f.slots[9].name, 'diamond_boots')
})

test('loot denial acts only on a still visible pile after aiming at its support', async () => {
  for (const mode of ['hidden', 'covered', 'taken', 'cancelled', 'open']) {
    const f = handoff('arrow', 1), { bot } = f
    let wall = mode === 'hidden', ignitions = 0
    const open = worldOf([[3, 63, 0, 'stone']])
    const closed = worldOf([[3, 63, 0, 'stone'], [1, 64, 0, 'stone'], [1, 65, 0, 'stone']])
    bot.blockAt = p => (wall ? closed : open).world.getBlock(p)
    f.drop(1, 3.5, () => ({ name: 'arrow', count: 1 }))
    const tool = { slot: 9, name: 'flint_and_steel', count: 1 }
    f.slots[9] = bot.heldItem = tool
    bot.lookAt = async () => {
      if (mode === 'covered') wall = true
      if (mode === 'taken') delete bot.entities[1]
      if (mode === 'cancelled') f.ctl.aborted = true
    }
    bot._genericPlace = async () => { ignitions++; delete bot.entities[1] }
    const result = await assist({ require: () => bot }, { mode: 'deny' }, f.ctl)
    assert.equal(ignitions, mode === 'open' ? 1 : 0, mode)
    assert.equal(result.ok, mode === 'open', mode)
  }
})

test('a partial handoff and another player collecting the rest never complete the order', async () => {
  const f = handoff('arrow', 20)
  f.slots[9] = { name: 'arrow', count: 4 }
  f.drop(1, .7, () => ({ name: 'arrow', count: 6 }))
  f.onTick = n => { if (n === 1) { f.slots[9].count += 6; delete f.bot.entities[1] } }
  assert.equal((await f.run()).ok, false)
  assert.equal(f.ticks(), 11)
})

test('a handoff reaches the pickup box from a legal ledge, waiting out knockback before approaching', async () => {
  for (const mode of ['ledge', 'knockback', 'outside']) {
    const { bot, world } = worldOf([[0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone']])
    drive(bot, world)
    let airborneResets = 0
    if (mode === 'knockback') {
      bot.entity.onGround = false
      bot.entity.velocity.y = .6
      const clear = bot.clearControlStates
      bot.clearControlStates = () => { if (!bot.entity.onGround) airborneResets++; clear() }
    }
    const f = handoff('iron_boots', 1)
    bot.inventory = f.bot.inventory
    const item = { id: 1, name: 'item', height: .25, width: .25, position: new Vec3(3.05, 1, .5),
      getDroppedItem: () => ({ name: 'iron_boots', count: 1 }) }
    bot.entities = { 1: item }
    bot.on('physicsTick', () => {
      if (inPickup(bot.entity.position, item.position)) {
        f.slots[9] = { name: 'iron_boots', count: 1 }
        delete bot.entities[1]
      }
    })
    const result = await assist({ require: () => bot }, { mode: 'pickup', item: 'iron_boots', ownedTarget: 1,
      arena: { x: .5, z: .5, r: mode === 'outside' ? 2 : 6, killY: 0 } }, f.ctl)
    assert.equal(result.ok, mode !== 'outside', result.why)
    assert.equal(airborneResets, 0)
    assert.equal(bot.entity.onGround, true)
    if (mode === 'outside') assert.equal(bot.entity.position.x, .5)
  }
})

test('assist pickup frees capacity, reaches the native box and waits for its own slot receipt', async () => {
  for (const mode of ['full', 'full-generic', 'full-auto', 'below', 'delayed', 'foreign', 'cancelled']) {
    const item: any = { id: 10, name: 'item', position: new Vec3(.5, mode === 'below' ? 62.8 : 64.1, .5),
      getDroppedItem: () => ({ name: 'diamond_boots', count: 1 }) }
    const slots: any[] = Array(46).fill(null)
    if (mode.startsWith('full')) {
      for (let i = 9; i < 45; i++) slots[i] = { slot: i, name: 'stone_sword', count: 1 }
      slots[9] = { slot: 9, name: 'rotten_flesh', count: 64 }
    }
    const inventory = { slots, items: () => slots.slice(9, 45).filter(Boolean),
      emptySlotCount: () => slots.slice(9, 45).filter(i => !i).length }
    const ctl = { aborted: false }, bot: any = { inventory, entities: { 10: item },
      entity: { position: new Vec3(.5, 64, .5), onGround: true }, registry: { itemsByName: { diamond_boots: { stackSize: 1 } } },
      blockAt: worldOf([[0, 62, 0, 'stone']]).bot.blockAt,
      lookAt: async () => {}, tossStack: async i => {
        slots[i.slot] = mode === 'full-auto' ? { name: 'diamond_boots', count: 1 } : null
        if (mode === 'full-auto') delete bot.entities[10]
      } }
    let ticks = 0, moves = 0
    bot.waitForTicks = async () => {
      ticks++
      if (mode === 'cancelled' && ticks === 2) ctl.aborted = true
      const delayed = ['delayed', 'foreign', 'cancelled'].includes(mode)
      if (delayed && ticks === 1) delete bot.entities[10]
      if (mode !== 'foreign' && mode !== 'cancelled' && ticks >= (delayed ? 3 : 40) &&
          inventory.emptySlotCount() && inPickup(bot.entity.position, item.position)) {
        slots[slots.findIndex((i, k) => k >= 9 && k < 45 && !i)] = { name: 'diamond_boots', count: 1 }
        delete bot.entities[10]
      }
    }
    const file = path.resolve(__dirname, '../src/pvp/team-assist.ts'), local = createRequire(file)
    const overrides = { './vec3': { Vec3 }, './last-seen': { seesPlayer: () => true },
      '../navigation/parkour': { ...local('../navigation/parkour'), executeJump: async (_bot, _ctl, at) => {
        moves++; bot.entity.position = at; return { ok: true }
      } } }
    const module = { exports: {} as any }
    const code = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
    vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap(code), { filename: file })(
      module.exports, id => id in overrides ? overrides[id] : local(id), module, file, path.dirname(file))
    const result = await module.exports.pickup(bot, mode === 'full-generic' ? null : 'diamond_boots', 6, undefined, ctl)
    assert.equal(result.ok, !['foreign', 'cancelled'].includes(mode), mode)
    if (mode.startsWith('full')) assert.equal(slots.some(i => i?.name === 'rotten_flesh'), false)
    if (mode === 'below') assert.equal(moves, 1, '1.2 blocks below the feet is outside native pickup reach')
    if (mode === 'delayed') assert.equal(ticks, 3, 'wait for the slot after entity_destroy')
    if (mode === 'foreign') assert.ok(ticks <= 11, 'a disappearance without our inventory gain is bounded failure')
    if (mode === 'cancelled') assert.equal(ticks, 2, 'cancellation stops the receipt wait')
  }
})
