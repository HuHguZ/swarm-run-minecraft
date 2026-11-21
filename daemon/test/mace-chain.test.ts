import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pvpParts } from './pvp-parts'
import { Vec3 } from 'vec3'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)

function fixture(height) {
  const world = { getBlock(p) { const block = Block.fromStateId(registry.blocksByName[p.y < 1 ? 'stone' : 'air'].defaultState); block.position = p.floored(); return block } }
  const bot: any = {
    version: '1.21.11', registry, health: 20, food: 20, game: { minY: -64, height: 384 },
    inventory: { slots: [], items: () => [{ name: 'mace', enchants: [] }] },
    entity: { id: 1, position: new Vec3(.5, height, .5), velocity: new Vec3(0, -.1, 0), onGround: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    blockAt: p => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    physics: (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics().Physics(registry, world),
    getControlState: () => false
  }
  const weak: any = { id: 2, username: 'Weak', type: 'player', name: 'player', isValid: true, position: new Vec3(1.5, 1, .5), equipment: [{ name: 'wooden_sword' }], metadata: [] }
  const strong: any = { ...weak, metadata: [], id: 3, username: 'Strong', position: new Vec3(.5, 1, 1.5), equipment: [{ name: 'netherite_sword' }, null, ...['boots', 'leggings', 'chestplate', 'helmet'].map(n => ({ name: 'netherite_' + n }))] }
  for (const e of [weak, strong]) Object.defineProperty(e.metadata, 9, { get() { throw new Error('exact enemy HP') } })
  return { bot, weak, strong }
}

test('native reachable smash selects weak prey low, dangerous armored prey high without enemy HP', () => {
  const { chainChoice }: typeof import('../src/combat/mace-chain') = require('../src/combat/mace-chain')
  const low = fixture(8), high = fixture(32)
  const a = chainChoice(low.bot, [low.weak, low.strong], { peak: 8 })
  const b = chainChoice(high.bot, [high.weak, high.strong], { peak: 32 })
  assert.equal(a?.entity.username, 'Weak')
  assert.equal(a?.lethal, true)
  assert.equal(b?.entity.username, 'Strong')
  assert.equal(b?.lethal, true)
  assert.ok(b.damage.min > a.damage.min)
})

test('a rebound recognizes a newly exposed roster opponent without enrolling distant, friendly or anonymous bodies', () => {
  for (const height of [8, 32]) {
    const f = fixture(height), bot = Object.assign(new EventEmitter(), f.bot)
    bot.username = 'Self'
    bot.teamMap = { Self: { team: 'blue' }, Ally: { team: 'blue' } }
    const actor = (id, username, x) => ({ ...f.strong, id, username, position: new Vec3(x, 1, 1.5) })
    const distant = Array.from({ length: 17 }, (_, i) => actor(10 + i, 'Far' + i, 75 + i))
    const neutral = actor(4, 'Neutral', .5), ally = actor(5, 'Ally', .5), spectator = actor(6, 'Spectator', .5)
    bot.players = { Spectator: { gamemode: 3 } }
    bot.entities = { 2: f.weak }
    const vision = require('../src/pvp/last-seen').createLastSeen(bot), enrolled = []
    const opts: any = { targets: ['Weak'] }
    const ctx: any = { bot, vision: { ...vision, observe: e => { enrolled.push(e.username); return vision.observe(e) } },
      entity: vision.observe(f.weak), opts, dead: new Set(), attackers: new Map(),
      track: { vel: () => new Vec3(0, 0, 0) }, foeEst: () => ({ lo: 0, hi: 20 }) }
    try {
      const { installMaceChain } = require('../src/pvp/duel-target')
      installMaceChain(ctx)
      for (const e of [f.strong, ally, neutral, spectator, ...distant]) bot.entities[e.id] = e
      assert.equal(ctx.maceChain.choose(height).entity.id, f.weak.id, 'an ordinary one-target duel stays on its target')
      opts.maceOpponents = ['Strong', 'Ally', 'Spectator', ...distant.map(e => e.username)]
      installMaceChain(ctx)
      assert.equal(ctx.maceChain.choose(height).entity.id, height === 32 ? f.strong.id : f.weak.id)
      assert.ok(enrolled.includes('Strong'))
      assert.ok(!enrolled.some(n => ['Ally', 'Neutral', 'Spectator'].includes(n) || n.startsWith('Far')))
      const floor = bot.blockAt
      bot.blockAt = p => {
        if (p.y < 1 || Math.floor(p.z) !== 1) return floor(p)
        const block = Block.fromStateId(registry.blocksByName.stone.defaultState)
        block.position = p.floored()
        return block
      }
      f.strong.position.z = 2.5
      enrolled.length = 0
      assert.equal(ctx.maceChain.choose(height)?.entity.id, f.weak.id, 'the public name through a wall cannot be struck')
      bot.blockAt = floor
      f.strong.metadata[0] = 0x20
      assert.equal(ctx.maceChain.choose(height)?.entity.id, f.weak.id, 'floating armor does not announce a new name')
      assert.ok(!enrolled.includes('Strong'), 'occluded and anonymous entrants do not start equipment tracking')
    } finally { vision.close() }
  }
})

test('a rebound spends its smash on the opponent in reach before touchdown', () => {
  const f = fixture(24), bot = Object.assign(new EventEmitter(), f.bot)
  f.strong.position = new Vec3(7.1, 1, .5)
  bot.entities = { 2: f.weak, 3: f.strong }
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  const ctx: any = { bot, vision, entity: vision.observe(f.weak), opts: { targets: ['Weak', 'Strong'] },
    dead: new Set(), attackers: new Map(), track: { vel: () => new Vec3(0, 0, 0) }, foeEst: () => ({ lo: 0, hi: 20 }) }
  const contacts: Array<{ grounded: boolean, falling: boolean }> = []
  const { reachFrom }: typeof import('../src/mace/world') = require('../src/mace/world')
  const simulate = bot.physics.simulatePlayer.bind(bot.physics)
  bot._ndSimOrig = (state, world) => {
    const next = simulate(state, world)
    const reach = reachFrom(state.pos.offset(0, 1.62, 0), f.strong, bot)
    if (reach < 2.9) contacts.push({ grounded: state.onGround, falling: state.vel.y < 0 })
    return next
  }
  try {
    require('../src/pvp/duel-target').installMaceChain(ctx)
    ctx.dead.add(f.weak.id)
    const across = ctx.maceChain.choose(24)
    assert.deepEqual(contacts, [{ grounded: true, falling: true }], 'native collision leaves a negative vertical speed on the landing tick')
    assert.equal(across, null, 'ground contact cannot power a smash')
    ctx.dead.clear()
    assert.equal(ctx.maceChain.choose(24)?.entity.id, f.weak.id, 'spend the rebound on the reachable alternative')
    f.weak.metadata[0] = 0x20
    f.weak.equipment = []
    assert.equal(ctx.maceChain.choose(24), null, 'losing visual contact with the alternative leaves the landing controller in charge')
  } finally { vision.close() }
})

test('the rebound selects an exposed opponent over visible armor behind a glass divider', () => {
  const f = fixture(32), bot = Object.assign(new EventEmitter(), f.bot)
  f.strong.position = new Vec3(2.5, 1, .5)
  f.weak.position = new Vec3(.5, 1, 1.5)
  let dividerTop = 40
  const floor = bot.blockAt
  bot.blockAt = p => {
    if (Math.floor(p.x) !== 1 || p.y < 1 || p.y >= dividerTop) return floor(p)
    const block = Block.fromStateId(registry.blocksByName.glass.defaultState)
    block.position = p.floored()
    return block
  }
  bot.entities = { 2: f.weak, 3: f.strong }
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  const ctx: any = { bot, vision, entity: vision.observe(f.weak), opts: { targets: ['Weak', 'Strong'] },
    dead: new Set(), attackers: new Map(), track: { vel: () => new Vec3(0, 0, 0) }, foeEst: () => ({ lo: 0, hi: 20 }) }
  try {
    require('../src/pvp/duel-target').installMaceChain(ctx)
    assert.ok(vision.observe(f.strong)?._ndVisible, 'the shooter can see the armored opponent through glass')
    const pick: typeof import('../src/pick') = require('../src/pick')
    assert.equal(pick.aim(bot, f.strong, { eye: new Vec3(.6, 2.9, .5) })?.blocked?.block.name, 'glass')
    assert.equal(ctx.maceChain.choose(32)?.entity.id, f.weak.id)
    ctx.dead.add(f.weak.id)
    assert.equal(ctx.maceChain.choose(32), null, 'when only the protected target remains, the pilot can choose a landing')
    dividerTop = 2
    ctx.dead.clear()
    assert.equal(ctx.maceChain.choose(32)?.entity.id, f.strong.id, 'the mace can still strike the exposed body over a low parapet')
  } finally { vision.close() }
})

test('the duel spends its low rebound on armored prey only with a personal wound in the same round and life', () => {
  const co: typeof import('../src/pvp/combat-observe') = require('../src/pvp/combat-observe')
  const { installMaceChain }: typeof import('../src/pvp/duel-target') = require('../src/pvp/duel-target')
  const makeBody = () => {
    const f = fixture(8), bot: any = Object.assign(new EventEmitter(), f.bot)
    bot._client = new EventEmitter()
    const weak = f.weak, strong = { ...f.strong, uuid: 'armored-player' }
    Object.defineProperty(strong.metadata, 17, { get() { throw new Error('private absorption') } })
    bot.entities = { [weak.id]: weak, [strong.id]: strong }
    const vision = require('../src/pvp/last-seen').createLastSeen(bot)
    const ctx: any = { bot, co, vision, entity: vision.observe(weak), opts: { targets: ['Weak', 'Strong'], roundScope: 'round-1' },
      dead: new Set(), attackers: new Map(), track: { vel: () => ({ x: 0, y: 0, z: 0 }) }, foeEst: () => ({ lo: 20, hi: 20 }) }
    installMaceChain(ctx)
    let now = 1000
    const wound = () => {
      const tracker = co.trackFoe(bot, vision.observe(strong), { roundScope: 'round-1', now: () => now, visible: vision.visible })
      try {
        tracker.noteAttack({ min: 14, max: 14, mean: 14, raw: 14 })
        bot._client.emit('damage_event', { entityId: strong.id, sourceCauseId: bot.entity.id + 1 })
        assert.equal(tracker.hp.snapshot().hi, 6)
      } finally { tracker.stop() }
    }
    return { bot, ctx, weak, strong, wound, elapse: ms => { now += ms }, choose: () => ctx.maceChain.choose(8), close: () => { vision.close(); bot.emit('end') } }
  }
  const own = makeBody(), ally = makeBody()
  try {
    ally.wound()
    assert.equal(own.choose().entity.id, own.weak.id, 'a different body cannot supply personal damage evidence')
    own.wound()
    const slam = own.choose()
    assert.equal(slam.entity.id, own.strong.id)
    assert.equal(slam.health.hi, 6)
    assert.ok(slam.damage.min >= 6 && slam.damage.min < 20)
    own.ctx.opts.roundScope = 'round-2'
    assert.equal(own.choose().entity.id, own.weak.id, 'previous round')
    own.ctx.opts.roundScope = 'round-1'
    const replacement = { ...own.strong, id: 42 }
    own.bot.entities = { [own.weak.id]: own.weak, 42: replacement }
    assert.equal(co.foeHpUpper(own.bot, replacement), null)
    assert.equal(co.foeHitProof(own.bot, replacement), null)
    assert.equal(co.foeHpUpper(own.bot, { id: own.strong.id, username: own.strong.username }), 6, 'name and matching life suffice without a UUID')
    assert.equal(co.foeHpUpper(own.bot, { ...own.strong, uuid: 'someone-else' }), null, 'different known UUID')
    assert.equal(co.foeHpUpper(own.bot, { username: own.strong.username }), null, 'entity sighting with no life id')
    assert.equal(own.choose().entity.id, own.weak.id, 'same player, new life without a death receipt')
    own.bot.entities = { [own.weak.id]: own.weak, [own.strong.id]: own.strong }
    own.elapse(5000)
    assert.equal(own.choose().entity.id, own.weak.id, 'unobserved regeneration can take the armored foe out of lethal range')
    own.bot.emit('death')
    assert.equal(co.foeHpUpper(own.bot, own.strong), null)
    assert.equal(own.choose().entity.id, own.weak.id, 'observer died')
  } finally { own.close(); ally.close() }
})

test('a reachable thirteenth enemy in a twenty-player squad remains eligible regardless of entity ordering', t => {
  const { chainChoice }: typeof import('../src/combat/mace-chain') = require('../src/combat/mace-chain')
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
  const { chainChoice }: typeof import('../src/combat/mace-chain') = require('../src/combat/mace-chain')
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
  const { chainChoice }: typeof import('../src/combat/mace-chain') = require('../src/combat/mace-chain')
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
  const vision = (require('../src/pvp/last-seen') as typeof import('../src/pvp/last-seen')).createLastSeen(bot)
  const file = resolve(__dirname, '../src/pvp.js')
  let selected
  try {
    const ctx: any = { bot, vision, entity: vision.observe(weak),
      opts: { targets: ['Weak', 'Strong'] }, dead: new Set(), attackers: new Map(), deadline: 1e9, arena: null,
      track: { vel: () => ({ x: 0, y: 0, z: 0 }) }, foeEst: () => ({ lo: 0, hi: 20 }),
      kills: [], label: 'Weak', killed: false, used: () => {}, retarget: e => { selected = vision.observe(e) },
      gameClock: { now: () => 1000 }, require: createRequire(file) }
    const { installMaceChain } = pvpParts(ctx, ['duel-target'], ['installMaceChain'])
    assert.equal(typeof installMaceChain, 'function', 'the regression runs the actual production adapter')
    installMaceChain(ctx)
    const chain = ctx.maceChain
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
  const f = fixture(32), mace: typeof import('../src/mace') = require('../src/mace')
  const feet = new Vec3(.5, 1, .5)
  assert.equal(mace.fallCost(f.bot, feet, 32), 28)
  f.bot.inventory.slots[8] = { name: 'netherite_boots', componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'feather_falling', level: 4 }] } }]]) }
  assert.equal(mace.fallCost(f.bot, feet, 32), 28 * .52)
  f.bot.inventory.slots[5] = { name: 'netherite_helmet', componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'protection', level: 4 }] } }]]) }
  assert.ok(Math.abs(mace.fallCost(f.bot, feet, 32) - 28 * .36) < 1e-9)
})

test('a fast visible second opponent can leave the rebound before its predicted impact', () => {
  const f = fixture(32), bot = Object.assign(new EventEmitter(), f.bot)
  const weak = Object.assign(new EventEmitter(), f.weak), strong = Object.assign(new EventEmitter(), f.strong)
  let observedAt = 1000
  strong._ndObservationNow = () => observedAt
  strong.onGround = true
  bot.entities = { 2: weak, 3: strong }
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  try {
    const ctx: any = { bot, vision, entity: vision.observe(weak), opts: { targets: ['Weak', 'Strong'] },
      dead: new Set(), attackers: new Map(), track: { vel: () => ({ x: 0, y: 0, z: 0 }) },
      foeEst: () => ({ lo: 0, hi: 20 }), require: createRequire(resolve(__dirname, '../src/pvp.js')) }
    const { installMaceChain } = pvpParts(ctx, ['duel-target'], ['installMaceChain'])
    installMaceChain(ctx)
    assert.equal(ctx.maceChain.choose(32).entity.id, strong.id, 'the stationary armored opponent is a lethal high-value smash')
    const observed = vision.observe(strong)
    assert.equal(observed.velocity.x, 0)
    observedAt += 100
    strong.position.x += 1.4
    strong._ndPositionReceipts = [null, { kind: 'rel_entity_move', t: observedAt }]
    strong.emit('ndPositionObserved')
    assert.ok(observed.velocity.x > .6, 'the client saw the opponent move away')
    assert.equal(ctx.maceChain.choose(32).entity.id, weak.id, 'the reachable target wins over an armored target leaving the arc')
  } finally { vision.close() }
})
