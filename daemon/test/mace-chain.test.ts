import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)

function fixture(height) {
  const world = { getBlock(p) { const block = Block.fromStateId(registry.blocksByName[p.y < 1 ? 'stone' : 'air'].defaultState); block.position = p.floored(); return block } }
  const bot: any = {
    version: '1.21.11', registry, health: 20, food: 20, game: { minY: -64, height: 384 },
    inventory: { slots: [], items: () => [{ name: 'mace', enchants: [] }] },
    entity: { id: 1, position: new Vec3(.5, height, .5), velocity: new Vec3(0, -.1, 0), onGround: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    blockAt: p => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    physics: require('../src/tick-plugins').getPhysics().Physics(registry, world),
    getControlState: () => false
  }
  const weak: any = { id: 2, username: 'Weak', type: 'player', name: 'player', isValid: true, position: new Vec3(1.5, 1, .5), equipment: [{ name: 'wooden_sword' }], metadata: [] }
  const strong: any = { ...weak, metadata: [], id: 3, username: 'Strong', position: new Vec3(.5, 1, 1.5), equipment: [{ name: 'netherite_sword' }, null, ...['boots', 'leggings', 'chestplate', 'helmet'].map(n => ({ name: 'netherite_' + n }))] }
  for (const e of [weak, strong]) Object.defineProperty(e.metadata, 9, { get() { throw new Error('exact enemy HP') } })
  return { bot, weak, strong }
}

test('native reachable smash selects weak prey low, dangerous armored prey high without enemy HP', () => {
  const { chainChoice } = require('../src/combat/mace-chain')
  const low = fixture(8), high = fixture(32)
  const a = chainChoice(low.bot, [low.weak, low.strong], { peak: 8 })
  const b = chainChoice(high.bot, [high.weak, high.strong], { peak: 32 })
  assert.equal(a?.entity.username, 'Weak')
  assert.equal(a?.lethal, true)
  assert.equal(b?.entity.username, 'Strong')
  assert.equal(b?.lethal, true)
  assert.ok(b.damage.min > a.damage.min)
})

test('a reachable thirteenth enemy in a twenty-player squad remains eligible regardless of entity ordering', t => {
  const { chainChoice } = require('../src/combat/mace-chain')
  const { bot, weak } = fixture(8)
  const distant = Array.from({ length: 19 }, (_, i) => ({ ...weak, metadata: weak.metadata, id: 10 + i, username: 'Far' + i, position: new Vec3(45 + i * .2, 1, .5) }))
  const mixed = [...distant.slice(0, 12), weak, ...distant.slice(12)]
  const first = chainChoice(bot, [weak, ...distant], { peak: 8 })
  const late = chainChoice(bot, mixed, { peak: 8 })
  assert.equal(first?.entity.id, weak.id)
  assert.equal(late?.entity.id, weak.id, 'entity ID order cannot eliminate a physically reachable target')
  const nearby = Array.from({ length: 20 }, (_, i) => ({ ...weak, metadata: weak.metadata, id: 40 + i, username: 'Near' + i, position: new Vec3(.5 + i % 5 * .35, 1, .5 + Math.floor(i / 5) * .35) }))
  const start = performance.now()
  for (let i = 0; i < 5; i++) assert.ok(chainChoice(bot, nearby, { peak: 8 }))
  t.diagnostic(JSON.stringify({ nativeSolverCandidates: 20, repetitions: 5, meanMs: (performance.now() - start) / 5 }))
})

test('chain rejects hidden, unreachable and protected targets, including glint with unknown levels', () => {
  const { chainChoice } = require('../src/combat/mace-chain')
  const { bot, weak, strong } = fixture(5)
  strong.position.x = 90
  assert.equal(chainChoice(bot, [strong], { peak: 5 }), null)
  weak.equipment = [{ name: 'shield' }]
  weak.metadata[8] = 1
  const normal = bot.blockAt
  bot.blockAt = p => p.y >= 1 && p.x === 1 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p.floored() } : normal(p)
  assert.equal(chainChoice(bot, [weak], { peak: 5 }), null)
  bot.blockAt = () => null
  assert.equal(chainChoice(bot, [weak], { peak: 5 }), null)
})

test('visible glint widens armor protection and every predicted tick respects the arena death boundary', () => {
  const { chainChoice } = require('../src/combat/mace-chain')
  const { bot, weak, strong } = fixture(50)
  for (const item of strong.equipment.slice(2)) item.componentMap = new Map([['enchantments', { get data() { throw new Error('hidden enchantment levels') } }]])
  assert.equal(chainChoice(bot, [weak, strong], { peak: 50 })?.entity.id, strong.id)
  const result = chainChoice(bot, [strong], { peak: 50 })
  assert.ok(result.damage.min < result.damage.max)
  assert.equal(chainChoice(bot, [weak], { peak: 50, arena: { x: .5, z: .5, r: .5, killY: 0 } }), null)
  assert.equal(chainChoice(bot, [weak], { peak: 50, arena: { x: .5, z: .5, r: 10, killY: 4 } }), null)
})

test('the actual PvP retarget adapter retains the native observation source and follows later movement', () => {
  const f = fixture(32), bot = Object.assign(new EventEmitter(), f.bot)
  const weak = Object.assign(new EventEmitter(), f.weak), strong = Object.assign(new EventEmitter(), f.strong)
  bot.entities = { 2: weak, 3: strong }
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  const file = resolve(__dirname, '../src/pvp.js'), source = readFileSync(file, 'utf8')
  const block = source.match(/  const maceChain = (\{[\s\S]*?\n  \});?\n  const combatContext/)
  assert.ok(block, 'the regression runs the actual production adapter')
  let selected
  try {
    const chain = runInNewContext('(' + block[1] + ')', { bot, vision, entity: vision.observe(weak),
      opts: { targets: ['Weak', 'Strong'] }, dead: new Set(), attackers: new Map(), deadline: 1e9, arena: null,
      track: { vel: () => ({ x: 0, y: 0, z: 0 }) }, foeEst: () => ({ lo: 0, hi: 20 }),
      kills: [], label: 'Weak', killed: false, used: () => {}, retarget: e => { selected = vision.observe(e) },
      gameClock: { now: () => 1000 }, require: createRequire(file) })
    const choice = chain.choose(32)
    assert.equal(choice.entity.id, 3)
    chain.onTarget(choice)
    assert.equal(vision.source(selected), strong)
    strong.position.x = 2.5; bot.emit('physicsTick')
    assert.equal(selected.position.x, 2.5)
    assert.ok(strong.listenerCount('ndPositionObserved') > 0)
  } finally { vision.close() }
})

test('combo relocation prices its own Feather Falling and the actual landing surface', () => {
  const f = fixture(32), mace = require('../src/mace')
  const feet = new Vec3(.5, 1, .5)
  assert.equal(mace.fallCost(f.bot, feet, 32), 28)
  f.bot.inventory.slots[8] = { name: 'netherite_boots', componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'feather_falling', level: 4 }] } }]]) }
  assert.equal(mace.fallCost(f.bot, feet, 32), 28 * .52)
  f.bot.inventory.slots[5] = { name: 'netherite_helmet', componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'protection', level: 4 }] } }]]) }
  assert.ok(Math.abs(mace.fallCost(f.bot, feet, 32) - 28 * .36) < 1e-9)
})
