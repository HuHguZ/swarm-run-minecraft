import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import bow = require('../src/bow')
import * as ranged from '../src/ranged'
import * as clock from '../src/game-clock'

function actor() {
  const c = new clock.GameClock({ manual: true, epoch: 1000 })
  clock.activate(c)
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  const item = { name: 'bow', slot: 36 }
  bot.inventory = { items: () => [item, { name: 'arrow' }] }; bot.heldItem = item
  bot.entity = { id: 1, position: new Vec3(0, 20, 0), velocity: new Vec3(0, 0, 0), onGround: true }
  bot.registry = { entitiesByName: { player: { metadataKeys: ['living_entity_flags'] } } }
  bot.world = { raycast: () => null }; bot.blockAt = () => null
  bot.quickBarSlot = 0; bot.setQuickBarSlot = value => { bot.quickBarSlot = value }
  bot.controls = { forward: true }; bot.setControlState = (key, value) => { bot.controls[key] = value }
  bot.look = () => Promise.resolve()
  bot.lookAt = () => Promise.resolve()
  bot.equip = item => { bot.heldItem = item; return Promise.resolve() }
  let releases = 0
  bot.activateItem = () => bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 1 }] })
  bot.deactivateItem = () => { releases++ }
  c.attach(bot)
  const age = n => bot._client.emit('update_time', { age: BigInt(n) })
  age(1000)
  const target = { id: 2, position: new Vec3(6, 20, 0), height: 1.8, onGround: true }
  const frame = async () => {
    c.advanceTicks(1); bot.emit('physicsTick'); bot.emit('physicTick'); bot.emit('ndMovementSent')
    await new Promise(resolve => setImmediate(resolve))
  }
  return { c, bot, age, target, frame, releases: () => releases, close: () => { bot.emit('end'); c.dispose() } }
}

test('a long bow shot skips terrain probes for off-path teammates and rechecks walls and allies on release', async t => {
  const geometry = require('../src/navigation/geometry') as typeof import('../src/navigation/geometry')
  const clearance = t.mock.method(geometry, 'bodyClear')
  for (const change of ['clear', 'wall', 'ally']) {
    const a = actor(), bot = a.bot
    try {
      bot.username = 'Archer'; bot.entities = {}; bot._ndSwarmAllies = []
      a.target.position.x = 40
      for (let i = 0; i < 19; i++) {
        const id = i + 3, username = 'Ally' + i
        bot._ndSwarmAllies.push(username)
        bot.entities[id] = { id, username, type: 'player', position: new Vec3(4 + i, 20, 6 + i % 3),
          velocity: new Vec3(.1, 0, 0), onGround: true, width: .6, height: 1.8 }
      }
      let wall = false
      bot.blockAt = p => {
        const position = p.floored(), solid = position.y < 20 || (wall && position.x === 9)
        return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position, shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
      }
      bot.world = { getBlock: bot.blockAt, raycast: require('prismarine-world/src/worldsync').prototype.raycast }
      const shot = bow.shoot(bot, a.target, { follow: false })
      await new Promise(resolve => setImmediate(resolve)); a.age(1001); a.age(1021)
      for (let i = 0; i < 23; i++) await a.frame()
      bot.once('ndMovementSent', () => {
        if (change === 'ally') bot.entities[3].position.z = 0
        if (change === 'wall') wall = true
      })
      await a.frame()
      const result = await shot
      assert.equal(result.shot, change === 'clear', change)
      assert.equal(a.releases(), change === 'clear' ? 1 : 0, change)
      if (change === 'clear') assert.equal(clearance.mock.callCount(), 0, 'the arrow misses every possible allied position')
      else assert.equal(result.blocked, true, change)
    } finally { a.close() }
  }
})

function installedActor(weapon) {
  const a = actor(); const bot = a.bot
  const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const Block = (require('prismarine-block') as typeof import('prismarine-block'))('1.21.11')
  bot.registry = data; bot.version = '1.21.11'; bot.supportFeature = data.supportFeature
  bot.game = { gameMode: 'survival', minY: -64 }; bot.isAlive = true
  bot.entity.effects = {}; bot.entity.attributes = {}; bot.entity.eyeHeight = 1.62
  bot.entities = {}; bot.getEquipmentDestSlot = () => 5
  const item = { name: weapon, slot: 36 }; bot.heldItem = item
  bot.inventory.slots = []; bot.inventory.slots[36] = item
  bot.inventory.items = () => [item, { name: 'arrow' }]
  bot.blockAt = p => { const b = Block.fromStateId(data.blocksByName.air.defaultState, 0); b.position = p.floored(); return b }
  bot.packets = []; bot._client.state = 'play'
  bot._client.write = (name, packet) => bot.packets.push({ name, ...packet })
  bot.activateItem = () => weapon === 'bow'
    ? bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags'), value: 1 }] })
    : bot._client.write('use_item', { hand: 0 })
  bot.deactivateItem = () => bot._client.write('block_dig', { status: 5 })
  ;(require('../src/tick-plugins') as typeof import('../src/tick-plugins')).createTickPlugins(a.c).plugins.physics(bot, { physicsEnabled: true })
  bot.emit('login')
  bot._client.emit('position', { x: 4103, y: 180, z: 3110, yaw: 0, pitch: 0, flags: {}, teleportId: 1 })
  bot.entity.onGround = false
  a.target.position = new Vec3(4108.834832328143, 171.41553791583252, 3120.5); a.target.onGround = false
  return { ...a, item, frame: async () => { a.c.advanceTicks(1); await new Promise(resolve => setImmediate(resolve)) } }
}

test('the floor archer can release uphill at a visible higher tier and an intervening wall stops the packet', async () => {
  const combat = require('../src/session/combat'), { blockOnRay } = require('../src/pick')
  for (const obstruct of [false, true]) {
    const a = installedActor('bow'), bot = a.bot, from = new Vec3(.5, 120, .5)
    const Block = require('prismarine-block')(bot.registry)
    let wall = false
    bot.blockAt = p => {
      const at = p.floored(), solid = at.y === 119 || at.x === 17 && at.z === 1 && at.y === 137 || wall && at.x === 8
      const b = Block.fromStateId(bot.registry.blocksByName[solid ? 'stone' : 'air'].defaultState)
      b.position = at; return b
    }
    bot.world.raycast = (from, dir, range) => { const hit = blockOnRay(bot, from, dir, range); return hit && { position: hit.pos } }
    bot.entity.position = from.clone(); bot.entity.onGround = true; bot.entity.velocity = new Vec3(0, 0, 0)
    const foe = Object.assign(a.target, { username: 'Visitor', type: 'player', position: new Vec3(17.5, 138, 1.5), onGround: true })
    bot.entities = { 2: foe }; bot.players = { Visitor: { entity: foe } }
    try {
      await a.frame(); await a.frame()
      const pending = combat.shoot.call({ require: () => bot, runIntent: (_, act) => act({ aborted: false }) },
        { target: 'Visitor', fromPost: from, stablePost: true, arena: { x: 0, y: 120, z: 0, r: 80, killY: 113 } })
      await new Promise(resolve => setImmediate(resolve)); a.age(1001)
      for (let tick = 0; tick < 25; tick++) {
        if (tick === 3) wall = obstruct
        if (tick === 20) a.age(1021)
        await a.frame()
      }
      const result = await pending
      assert.equal(result.shot, !obstruct, JSON.stringify({ result, position: bot.entity.position, velocity: bot.entity.velocity }))
      assert.equal(bot.packets.filter(p => p.name === 'block_dig' && p.status === 5).length, obstruct ? 0 : 1)
    } finally { a.close() }
  }
})

test('a confirmed team1 roof landing can release a bow, or cancel if the exposed stance changes during the draw', async t => {
  const { cacheMethods } = require('../src/rpc/caches'), combat = require('../src/session/combat')
  const { blockOnRay } = require('../src/pick')
  const { generate } = require('../arena/colosseum-arms'), { model } = require('../arena/colosseum')
  const roof = new Vec3(621.5,150.5,546.5), lower = new Vec3(602.5,143,545.5)
  const arena = { x: 600.5, y: 120, z: 600.5, r: 80, killY: 113 }
  const layout = generate('team1'), grid = model({ R: 24, bays: 40, ceilH: 64, masts: 0 }).g
  for (const [x,y,z,name] of [...layout.field,...layout.set]) grid.set(x,y,z,name === 'air' ? '' : name.replace(/\{.*$/, ''))
  // The transport boundary supplies a server-confirmed teleport. Position, footing, sight, aim and release run normally.
  t.mock.method(require('../src/pearl-hop'), 'hopTo', async (bot, to) => {
    bot.entity.position = to.clone()
    await bot.landingFrame(); await bot.landingFrame()
    return { hops: 1, steps: [{ moved: true, err: bot.landingError }], stop: 'у цели' }
  })
  for (const mode of ['release', 'miss', 'missing support', 'outside', 'toe on edge', 'stop', 'lost target', 'wall', 'lost bow', 'floor removed', 'incoming arrow']) {
    const a = installedActor('bow'), bot = a.bot, data = bot.registry
    bot.landingFrame = a.frame
    bot.landingError = mode === 'miss' ? 4.5 : 0
    const Block = require('prismarine-block')(data), states = new Map(), blocks = new Map()
    let broken = mode === 'missing support', wall = false
    bot.blockAt = p => {
      const at = p.floored()
      let name = grid.get(at.x - 600, at.y - 120, at.z - 600) || 'air'
      if (broken && at.x === 621 && at.z === 546) name = 'air'
      if (mode === 'toe on edge' && at.x >= 622 && Math.abs(at.z - 546) < 2) name = 'air'
      if (wall && at.x === 611 && Math.abs(at.z - 546) <= 2 && at.y >= 143 && at.y <= 155) name = 'stone'
      const k = at.toString() + name
      if (!blocks.has(k)) {
        if (!states.has(name)) {
          const [key, props] = name.split('['), base = data.blocksByName[key], original = Block.fromStateId(base.defaultState)
          states.set(name, props ? Block.fromProperties(base.id, { ...original.getProperties(), ...Object.fromEntries(props.slice(0,-1).split(',').map(p => p.split('='))) }).stateId : base.defaultState)
        }
        const block = Block.fromStateId(states.get(name)); block.position = at; blocks.set(k, block)
      }
      return blocks.get(k)
    }
    bot.world.raycast = (from, dir, range) => { const hit = blockOnRay(bot, from, dir, range); return hit && { position: hit.pos } }
    bot.entity.position = roof.offset(0,-10,0); bot.entity.onGround = true; bot.entity.velocity = new Vec3(0,0,0)
    const foe = Object.assign(a.target, { position: lower.clone(), username: 'Base', type: 'player', onGround: true })
    bot.entities = { 2: foe }; bot.players = { Base: { entity: foe } }
    const ctl = { aborted: false }, session = { require: () => bot, runIntent: (_name, act) => act(ctl) }
    try {
      const at = mode === 'outside' ? new Vec3(679.8,150.5,546.5) : mode === 'toe on edge' ? roof.offset(.68,0,0) : roof
      const arrived = await cacheMethods({session}).pearl_up({to:at,arena})
      assert.equal(arrived.ok, true)
      if (mode === 'toe on edge') assert.ok(bot.entity.onGround, 'feet still clip the lip of the slab')
      if (['miss', 'outside', 'missing support', 'toe on edge'].includes(mode)) {
        assert.equal(arrived.landing, undefined, mode)
        continue
      }
      assert.deepEqual(arrived.landing, {x:roof.x,y:roof.y,z:roof.z}, mode)
      const action = combat.shoot.call(session,{target:'Base',fromPost:arrived.landing,pearlPost:true,arena})
      await new Promise(resolve => setImmediate(resolve))
      a.age(1001)
      for (let i = 0; i < 25; i++) {
        if (i === 3) {
          if (mode === 'stop') ctl.aborted = true
          if (mode === 'lost target') delete bot.players.Base
          if (mode === 'wall') wall = true
          if (mode === 'lost bow') bot.heldItem = null
          if (mode === 'floor removed') broken = true
          if (mode === 'incoming arrow') bot.entities[11] = { id:11,name:'arrow',position:roof.offset(0,1,6) }
        }
        if (mode === 'incoming arrow' && i === 4) bot.entities[11].position.z -= 1.5
        if (i === 20) a.age(1021)
        await a.frame()
      }
      const result = await action
      const releases = bot.packets.filter(packet => packet.name === 'block_dig' && packet.status === 5)
      assert.equal(result.shot, mode === 'release', JSON.stringify({mode,result}))
      assert.equal(releases.length, mode === 'release' ? 1 : 0, mode)
    } finally { a.close() }
  }
})

test('moving airborne bow checks its compensated arc before drawing; raw arc remains blocked', async () => {
  for (const mode of ['compensate', 'raw']) for (const ceiling of [22, 21.6]) {
    const a = actor()
    let draws = 0
    a.bot.entity.onGround = false
    a.bot.entity.velocity.x = 1.5
    a.target.position.x = 40
    a.bot.activateItem = () => { draws++ }
    // A low ceiling catches the slower stationary arc, above the moving shot.
    a.bot.world.raycast = (from, dir, reach) => {
      const t = (ceiling - from.y) / dir.y
      const x = from.x + dir.x * t
      return t >= 0 && t <= reach && x >= 0 && x <= 40 ? { position: new Vec3(x, ceiling, 0) } : null
    }
    try {
      const shot = await bow.shoot(a.bot, a.target, {
        mode, point: () => a.target.position.offset(0, .9, 0), shouldStop: () => true
      })
      const clear = mode === 'compensate' && ceiling === 22
      assert.equal(draws, clear ? 1 : 0)
      assert.equal(shot.shot, false)
      assert.equal(a.releases(), 0)
      assert.match(shot.why, clear ? /отменил натяжение/ : /на линии стрельбы блок/)
    } finally { a.close() }
  }
})

for (const weapon of ['bow', 'crossbow', 'iron_spear']) test(`${weapon} credits its own hit on the observed target`, async t => {
  const a = actor()
  const raw = Object.assign(a.target, { type: 'player', username: 'Foe' })
  a.bot.registry = require('minecraft-data')('1.21.11')
  if (weapon === 'bow') a.bot.activateItem = () => a.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: a.bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags'), value: 1 }] })
  a.bot.blockAt = p => ({ name: 'air', position: p, boundingBox: 'empty', shapes: [] })
  a.bot.look = (yaw, pitch) => { Object.assign(a.bot.entity, { yaw, pitch }); return Promise.resolve() }
  const vision = (require('../src/pvp/last-seen') as typeof import('../src/pvp/last-seen')).createLastSeen(a.bot)
  const target = vision.observe(raw)
  assert.notStrictEqual(target, raw)
  const item = { name: weapon, slot: 36 }; a.bot.heldItem = item
  a.bot.inventory.slots = []; a.bot.inventory.slots[36] = item
  const oldDebug = process.env.ND_DEBUG_XBOW
  if (weapon === 'crossbow') process.env.ND_DEBUG_XBOW = '1'
  const logs: any[] = []
  t.mock.method(console, 'log', (...args) => { if (args[0] === '[xshot]') logs.push(JSON.parse(args[1])) })
  t.mock.method((require('../src/read') as typeof import('../src/read')), 'crossbowInfo', () => ({ loaded: true, ammo: 'arrow', multishot: false, piercing: 0 }))
  let hits = 0
  const onHit = () => { hits++ }
  const ctl = { aborted: false }
  try {
    const point = () => target.position.offset(0, .9, 0)
    const shooting = weapon === 'bow' ? bow.shoot(a.bot, target, { point, follow: false, onHit })
      : weapon === 'crossbow' ? ranged.fire(a.bot, target, item, { point, onHit })
        : (require('../src/spear') as typeof import('../src/spear')).charge(a.bot, ctl, target, { onHit })
    await new Promise(resolve => setImmediate(resolve))
    if (weapon === 'bow') {
      a.age(1001); a.age(1021)
      for (let i = 0; i < 24; i++) await a.frame()
    } else if (weapon === 'crossbow') await a.frame()
    if (weapon !== 'iron_spear') { const result = await shooting; assert.equal(result.shot ?? result.fired, true) }
    a.bot.emit('entityHurt', { ...raw, id: 3 }, a.bot.entity)
    a.bot.emit('entityHurt', raw, { id: 3 })
    assert.equal(hits, 0, 'a teammate damaging the right target does not confirm our own shot')
    if (weapon === 'iron_spear') a.bot.emit('entityHurt', raw, a.bot.entity)
    else {
      const client = a.bot._client
      const arrow = { type: a.bot.registry.entitiesByName.arrow.id, entityId: 101, objectData: a.bot.entity.id }
      const damage = { entityId: raw.id, sourceCauseId: a.bot.entity.id + 1, sourceDirectId: arrow.entityId + 1, sourceTypeId: 0 }
      const spawn = packet => { client.emit('packet', packet, { name: 'spawn_entity' }); client.emit('spawn_entity', packet) }
      spawn({ ...arrow, objectData: 3, entityId: 102 })
      spawn(arrow)
      client.emit('damage_event', { ...damage, entityId: 3 })
      client.emit('damage_event', { ...damage, sourceDirectId: 103 })
      client.emit('damage_event', { ...damage, sourceCauseId: 4 })
      client.emit('damage_event', { ...damage, sourceTypeId: require('../src/gamedata').DAMAGE_TYPES.indexOf('player_attack') })
      a.bot.emit('entityHurt', raw, a.bot.entity)
      assert.equal(hits, 0, 'melee, another arrow or a different victim cannot confirm this release')
      client.emit('damage_event', damage)
      client.emit('damage_event', damage)
    }
    assert.equal(hits, 1, 'the packet entity and its observed view name the same target')
    if (weapon === 'iron_spear') {
      ctl.aborted = true; await a.frame()
      assert.equal((await shooting).hit, true)
      assert.equal(a.bot.listenerCount('entityHurt'), 0)
    } else {
      assert.equal(hits, 1, 'a projectile hit is counted once')
      if (weapon === 'crossbow') { assert.equal(logs.length, 1); assert.equal(typeof logs[0].hit, 'number') }
    }
  } finally {
    ctl.aborted = true; vision.close(); a.close()
    if (oldDebug == null) delete process.env.ND_DEBUG_XBOW
    else process.env.ND_DEBUG_XBOW = oldDebug
  }
})

for (const [weapon, reason] of [['bow', 'lost'], ['crossbow', 'lost'], ['crossbow', 'cancel']]) test(`${weapon} holds fire when ${reason} arrives between aim and movement receipt`, async t => {
  const a = actor(), { bot } = a
  const item = { name: weapon, slot: 36 }, target = Object.assign(a.target, { username: 'Foe', _ndVisible: true })
  const info = { loaded: true, ammo: 'arrow', multishot: false, piercing: 0 }
  t.mock.method(require('../src/read'), 'crossbowInfo', () => info)
  const ctl = { aborted: false }
  let crossbowUses = 0
  bot.inventory.slots = []; bot.inventory.slots[36] = item
  const point = () => target.position.offset(0, .9, 0)
  try {
    if (weapon === 'crossbow') bot.activateItem = () => { crossbowUses++ }
    const run = weapon === 'bow' ? bow.shoot(bot, target, { point, follow: false })
      : ranged.step(bot, ctl, { entity: target }, { planned: { act: 'fire', item, info, point } })
    await new Promise(resolve => setImmediate(resolve))
    if (weapon === 'bow') {
      a.age(1001); a.age(1021)
      for (let i = 0; i < 23; i++) await a.frame()
    }
    bot.once('ndMovementSent', () => {
      if (reason === 'cancel') ctl.aborted = true
      else target._ndVisible = false
    })
    await a.frame()
    const result = await run
    assert.equal(result.shot ?? result.ok, false)
    assert.equal(crossbowUses + a.releases(), 0)
  } finally { a.close() }
})

test('bow follow tracks the shooter’s spectral arrow when a neighbour releases first', async () => {
  const a = actor(), { bot } = a
  const data = require('minecraft-data')('1.21.11')
  bot.registry.entitiesByName.spectral_arrow = data.entitiesByName.spectral_arrow
  bot.entities = {}
  try {
    const run = bow.shoot(bot, a.target, { point: () => a.target.position.offset(0, .9, 0), follow: true })
    await new Promise(resolve => setImmediate(resolve))
    a.age(1001); a.age(1021)
    for (let i = 0; i < 24; i++) await a.frame()
    assert.equal(a.releases(), 1)
    for (const owner of [9, bot.entity.id]) {
      const packet = { type: data.entitiesByName.spectral_arrow.id, entityId: owner + 50, objectData: owner,
        velocity: new Vec3(owner, 0, 0) }
      bot._client.emit('packet', packet, { name: 'spawn_entity' })
      bot.entities[packet.entityId] = { position: bot.entity.position, name: 'spectral_arrow' }
      bot.emit('entitySpawn', bot.entities[packet.entityId])
      bot._client.emit('spawn_entity', packet)
    }
    bot._client.emit('damage_event', { entityId: a.target.id, sourceCauseId: bot.entity.id + 1, sourceDirectId: bot.entity.id + 51, sourceTypeId: 0 })
    await a.frame()
    const out = await run
    assert.equal(out.hit, true)
    assert.equal(out.diag.speed, 1)
    assert.equal(out.note, undefined)
    assert.equal(bot._client.listenerCount('damage_event'), 0)
    assert.equal(bot._client.listenerCount('packet'), 0)
  } finally { a.close() }
})

test('a missing crossbow or rejected use spends no shot and leaves no hit listener', async t => {
  const a = actor(), { bot } = a, crossbow = { name: 'crossbow', slot: 38 }
  t.mock.method(require('../src/read'), 'crossbowInfo', () => ({ loaded: true, ammo: 'arrow', piercing: 0 }))
  let uses = 0
  bot.activateItem = () => { uses++; throw Error('disconnected') }
  try {
    for (const remove of [true, false]) {
      bot.inventory.slots = []; bot.inventory.slots[38] = crossbow
      const run = ranged.fire(bot, a.target, crossbow, { point: () => a.target.position, onHit: () => assert.fail() })
      if (remove) bot.once('ndMovementSent', () => { bot.inventory.slots[38] = null })
      await a.frame()
      assert.equal((await run).fired, false)
      assert.equal(uses, remove ? 0 : 1)
      assert.equal(bot.quickBarSlot, 0)
      assert.equal(bot._client.listenerCount('damage_event'), 0)
      assert.equal(bot._client.listenerCount('spawn_entity'), 0)
    }
  } finally { a.close() }
})

test('two crossbow volleys in flight credit only the matching spectral arrow or side rocket', async t => {
  const a = actor(), { bot } = a
  bot.registry = require('minecraft-data')('1.21.11')
  const types = require('../src/gamedata').DAMAGE_TYPES
  let rocket = false
  const item = { name: 'crossbow', slot: 36 }
  bot.inventory.slots = []; bot.inventory.slots[36] = item
  t.mock.method(require('../src/read'), 'crossbowInfo', () => ({ loaded: true, ammo: rocket ? 'firework' : 'arrow', multishot: rocket, piercing: 0 }))
  a.target.position.x = 12
  const hits: string[] = []
  const shot = async (label: string) => {
    const run = ranged.fire(bot, a.target, item, { point: () => a.target.position.offset(0, .9, 0), onHit: () => hits.push(label) })
    await a.frame()
    assert.equal((await run).fired, true)
  }
  const spawn = (name, id) => bot._client.emit('spawn_entity', { type: bot.registry.entitiesByName[name].id, entityId: id, objectData: bot.entity.id })
  const hurt = (kind, id) => bot._client.emit('damage_event', { entityId: a.target.id, sourceCauseId: bot.entity.id + 1, sourceDirectId: id + 1, sourceTypeId: types.indexOf(kind) })
  try {
    await shot('first')
    await shot('second')
    spawn('spectral_arrow', 100); spawn('arrow', 101)
    rocket = true
    await shot('rocket')
    for (const id of [102, 103, 104]) spawn('firework_rocket', id)
    hurt('fireworks', 104); hurt('fireworks', 103); hurt('arrow', 101)
    assert.deepEqual(hits, ['rocket', 'second'])
    hurt('arrow', 100)
    assert.deepEqual(hits, ['rocket', 'second', 'first'])
    assert.equal(bot._client.listenerCount('damage_event'), 0)
    assert.equal(bot._client.listenerCount('spawn_entity'), 0)
    await shot('expired')
    a.c.advanceTicks(70)
    assert.equal(bot._client.listenerCount('spawn_entity'), 0)
    assert.equal(bot._client.listenerCount('damage_event'), 0)
  } finally { a.close() }
})

for (const weapon of ['bow', 'crossbow']) test(`installed ${weapon} final aim observes Air44 age after slow planning, before movement and use`, async t => {
  const a = installedActor(weapon)
  const read: typeof import('../src/read') = require('../src/read')
  t.mock.method(read, 'crossbowInfo', () => ({ loaded: true, ammo: 'arrow', multishot: false, piercing: 0 }))
  const warnings: string[] = []
  t.mock.method(console, 'warn', message => { warnings.push(String(message)) })
  const target = { id: 2, position: new Vec3(4108.834832328143, 171.41553791583252, 3120.5), height: 1.8, onGround: false }
  const ageAtSolve = 2.37357421875; const ageAtRelease = 3.1597607421875
  let ageTicks = ageAtSolve
  const velFn = () => ({ x: .2486572265625, y: -1.0828051011809083, z: 0, ageTicks })
  try {
    const shooting = weapon === 'bow' ? bow.shoot(a.bot, target, { velFn, follow: false, traceAim: true })
      : ranged.fire(a.bot, target, a.item, { velFn, traceAim: true })
    await new Promise(resolve => setImmediate(resolve))
    if (weapon === 'bow') {
      a.age(1001); a.age(1021)
      for (let i = 0; i < 23; i++) await a.frame()
    }
    // Replay the elapsed observation time from Air44 without another physical
    // frame. This callback registers after the shot's final planning listener.
    a.bot.on('physicsTick', () => { ageTicks = ageAtRelease })
    a.bot.packets.length = 0
    await a.frame()
    const result = await shooting
    assert.equal(result.shot ?? result.fired, true)
    assert.equal(result.aimObservation.velocity.ageTicks, ageAtRelease, 'early physicsTick must not commit the stale Air44 snapshot')
    const expected = bow.leadTarget(target, velFn)(result.flightTicks ?? result.ticks)
    assert.ok(expected.distanceTo(new Vec3(result.aimAt.x, result.aimAt.y, result.aimAt.z)) < 1e-9)
    const names = a.bot.packets.map(p => p.name)
    const movement = names.findIndex(name => /^position(_look)?$/.test(name))
    const end = names.indexOf('tick_end'); const use = names.indexOf(weapon === 'bow' ? 'block_dig' : 'use_item')
    assert.ok(movement >= 0 && end > movement && use > end, names.join(','))
    const conv = require('mineflayer/lib/conversions')
    assert.equal(a.bot.packets[movement].yaw, Math.fround(conv.toNotchianYaw(a.bot.entity.yaw)))
    assert.equal(a.bot.packets[movement].pitch, Math.fround(conv.toNotchianPitch(a.bot.entity.pitch)))
    assert.equal(warnings.filter(message => message.includes('deprecated event (physicTick)')).length, 0, 'only our marked final aim listener skips the upstream warning')
    assert.equal(a.bot.listenerCount('physicTick'), 0)
  } finally { a.close() }
})

for (const weapon of ['bow', 'crossbow']) test(`installed ${weapon} late final aim cancels after planning without a use packet or listener`, async t => {
  const a = installedActor(weapon)
  const read: typeof import('../src/read') = require('../src/read')
  t.mock.method(read, 'crossbowInfo', () => ({ loaded: true, ammo: 'arrow', multishot: false, piercing: 0 }))
  t.mock.method(console, 'warn', () => {}) // test-local capture; production warning remains intact
  let stopped = false
  try {
    const shooting = weapon === 'bow' ? bow.shoot(a.bot, a.target, { follow: false, shouldStop: () => stopped })
      : ranged.fire(a.bot, a.target, a.item, { shouldStop: () => stopped })
    await new Promise(resolve => setImmediate(resolve))
    if (weapon === 'bow') {
      a.age(1001); a.age(1021)
      for (let i = 0; i < 23; i++) await a.frame()
    }
    assert.equal(a.bot.listenerCount('physicTick'), 1)
    a.bot.on('physicsTick', () => {
      assert.equal(a.bot.packets.filter(p => p.name === 'block_dig' || p.name === 'use_item').length, 0, 'no early release before planning completes')
      stopped = true
    })
    a.bot.packets.length = 0
    await a.frame()
    const result = await shooting
    assert.equal(result.shot ?? result.fired, false)
    assert.equal(a.bot.packets.filter(p => p.name === 'block_dig' || p.name === 'use_item').length, 0)
    assert.equal(a.bot.listenerCount('physicTick'), 0)
  } finally { a.close() }
})

test('native cancellation clears the late bow listener without another physical frame', async () => {
  const a = actor()
  try {
    const shooting = bow.shoot(a.bot, a.target, { follow: false })
    await new Promise(resolve => setImmediate(resolve)); a.age(1001); a.age(1021)
    for (let i = 0; i < 23; i++) await a.frame()
    assert.equal(a.bot.listenerCount('physicTick'), 1)
    a.c.setState({ tick_rate: 20, is_frozen: true }); a.bot.emit('respawn')
    const result = await shooting
    assert.equal(result.shot, false)
    assert.equal(a.releases(), 0)
    assert.equal(a.bot.listenerCount('physicTick'), 0)
    assert.equal(a.bot.listenerCount('physicsTick'), 0)
  } finally { a.close() }
})

test('Air41 twenty-seven client ticks and eight native ticks cannot release a full bow', async () => {
  const a = actor()
  let drawCalls = 0
  try {
    const shooting = bow.shoot(a.bot, a.target, { follow: false, onDraw: () => { drawCalls++ } })
    await new Promise(resolve => setImmediate(resolve))
    a.age(1001) // first actual age after the native main-hand use receipt
    for (let i = 0; i < 27; i++) await a.frame()
    a.age(1008)
    assert.equal(a.releases(), 0, 'Air41 native charge8 must not be represented by the full-speed aim')
    assert.ok(drawCalls > 0)
    assert.equal(a.bot.controls.forward, true)
    a.age(1021)
    await a.frame(); await a.frame()
    const result = await shooting
    assert.equal(result.shot, true)
    assert.equal(result.fullChargeConfirmed, true)
    assert.equal(a.releases(), 1)
  } finally { a.close() }
})

test('native charge ignores pre-ACK ages, off-hand use, and client prediction', () => {
  const a = actor()
  try {
    a.bot.activateItem = () => {}
    const charge = bow.observeCharge(a.bot)
    charge.start()
    a.age(1020)
    a.bot._client.emit('entity_metadata', { entityId: 2, metadata: [{ key: 0, value: 1 }] })
    a.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 3 }] })
    assert.equal(charge.ready(0), false)
    a.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 1 }] })
    a.c.advanceTicks(100)
    assert.equal(charge.ready(), false)
    a.age(1040)
    assert.equal(charge.snapshot().confirmedTicks, 0, 'the pre-ACK twenty ticks do not count')
    a.age(1059); assert.equal(charge.ready(), false)
    a.age(1060); assert.equal(charge.ready(), true)
    charge.close()
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
    assert.equal(a.bot._client.listenerCount('update_time'), 1, 'only the original GameClock anchor listener remains')
  } finally { a.close() }
})

for (const reason of ['using-ended', 'respawn', 'slot', 'end', 'rewind']) test(`native bow charge cancels on ${reason}`, () => {
  const a = actor()
  try {
    const charge = bow.observeCharge(a.bot)
    charge.start(); a.age(1001); a.age(1021)
    assert.equal(charge.ready(), true)
    if (reason === 'using-ended') a.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 0 }] })
    if (reason === 'respawn') a.bot.emit('respawn')
    if (reason === 'slot') { a.bot.quickBarSlot = 1; a.bot.emit('heldItemChanged') }
    if (reason === 'end') a.bot.emit('end')
    if (reason === 'rewind') a.age(999)
    assert.equal(charge.ready(), false)
    assert.ok(charge.why())
    charge.cancel()
    assert.equal(a.releases(), 0)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
  } finally { a.close() }
})

test('short TNT draw acknowledges use but is never prolonged to twenty ticks', async () => {
  const a = actor()
  try {
    const shooting = bow.shoot(a.bot, a.target, { drawMs: 450, follow: false })
    for (let i = 0; i < 12; i++) await a.frame()
    const result = await shooting
    assert.equal(a.releases(), 1)
    assert.equal(result.fullChargeConfirmed, false)
    assert.equal(result.speedEstimated, true)
    assert.equal(result.nativeCharge.useConfirmed, true)
    assert.equal(result.nativeCharge.confirmedTicks, null)
  } finally { a.close() }
})

test('a short draw without native ACK cancels without extending its strength', async () => {
  const a = actor()
  a.bot.activateItem = () => {}
  try {
    const shooting = bow.shoot(a.bot, a.target, { drawMs: 450, follow: false })
    for (let i = 0; i < 12; i++) await a.frame()
    const result = await shooting
    assert.equal(result.shot, false)
    assert.equal(a.releases(), 0)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
  } finally { a.close() }
})

test('native waiting and shield holding share one existing hold budget', async () => {
  const a = actor()
  let drawCalls = 0
  try {
    const shooting = bow.shoot(a.bot, a.target, { follow: false, holdWhile: () => true, onDraw: () => { drawCalls++ } })
    await new Promise(resolve => setImmediate(resolve)); a.age(1001)
    for (let i = 0; i < 60; i++) await a.frame()
    assert.equal(a.releases(), 0)
    a.age(1021)
    for (let i = 0; i < 16; i++) await a.frame()
    const result = await shooting
    assert.equal(result.shot, true)
    assert.equal(a.releases(), 1, 'charging does not give the shield another 2500 ms budget')
    assert.ok(drawCalls > 60)
    assert.equal(a.bot.controls.forward, true)
  } finally { a.close() }
})

test('full draw timeout and disconnect cancel without arrows or observation listeners', async () => {
  for (const disconnect of [false, true]) {
    const a = actor()
    try {
      const shooting = bow.shoot(a.bot, a.target, { follow: false })
      await new Promise(resolve => setImmediate(resolve)); a.age(1001)
      if (disconnect) a.bot.emit('end')
      else for (let i = 0; i < 80; i++) await a.frame()
      const result = await shooting
      assert.equal(result.shot, false)
      assert.equal(a.releases(), 0)
      assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
      assert.equal(a.bot.listenerCount('physicsTick'), 0)
    } finally { a.close() }
  }
})

for (const phase of ['draw', 'native', 'shield', 'settle', 'snap2']) test(`paused ${phase} wait cancels without another game tick`, async () => {
  const a = actor()
  let result
  try {
    if (phase === 'settle') a.bot.entity.velocity.x = .04
    const shooting = bow.shoot(a.bot, a.target, { follow: false,
      mode: phase === 'settle' || phase === 'snap2' ? phase : 'compensate',
      ...(phase === 'shield' ? { holdWhile: () => true } : {}) })
    shooting.then(value => { result = value })
    await new Promise(resolve => setImmediate(resolve)); a.age(1001)
    if (phase !== 'draw') {
      if (phase !== 'native') a.age(1021)
      for (let i = 0; i < 24; i++) await a.frame()
    }
    assert.equal(result, undefined, 'the charge is awaiting its next game timer')
    a.c.setState({ tick_rate: 20, is_frozen: true })
    if (phase === 'native') a.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 0 }] })
    else if (phase === 'shield') { a.bot.quickBarSlot = 1; a.bot.emit('heldItemChanged') }
    else a.bot.emit('respawn')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(result?.shot, false, 'native cancellation must wake a paused charge wait')
    assert.equal(a.releases(), 0)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
    assert.equal(a.bot.listenerCount('physicsTick'), 0)
    assert.equal(a.bot.controls.forward, phase === 'settle' || phase === 'snap2' ? false : true)
  } finally { a.close() }
})

test('legacy clients without native authority cannot claim a full charge', async () => {
  const a = actor()
  try {
    delete a.bot.ndClock
    const result = await bow.shoot(a.bot, a.target, { follow: false })
    assert.equal(result.shot, false)
    assert.equal(result.fullChargeConfirmed, false)
    assert.equal(result.why, 'bow_native_authority_unavailable')
    assert.equal(a.releases(), 0)
  } finally { a.close() }
})

function shootDragon(name, a) {
  // Evaluate the actual TS function, keeping forecasts and network external.
  // No daemon JS rebuild or dragon/module setup runs during a native campaign.
  const fs: typeof import('node:fs') = require('node:fs'); const path: typeof import('node:path') = require('node:path')
  const esbuild: typeof import('esbuild') = require('esbuild')
  const file = name === 'pointBlank' ? 'crystal-shot-spot.ts' : 'station-plan.ts'
  const source = fs.readFileSync(path.join(__dirname, '../src/dragon', file), 'utf8')
  const body = source.match(new RegExp(`async function ${name}\\b[\\s\\S]*?^}`, 'm'))?.[0]
  assert.ok(body)
  const dragon = { id: 3 }
  const deps = {
    bow, gameClock: clock, sleep: (ms: number) => clock.sleep(ms), EYE: 1.62,
    findItem: (bot: any, re: RegExp) => bot.inventory.items().find(item => re.test(item.name)), countOf: () => 1,
    clearControls: () => {}, dragonOf: () => dragon, PHASE: { LANDING: 7 }, PHASE_RU: {},
    phaseOf: () => 7, hpOf: () => 20, r1: (n: number) => Math.round(n * 10) / 10,
    landingForecast: () => ({ t: clock.now(), path: Array.from({ length: 30 }, () => ({ head: new Vec3(3, 20, 0) })) }),
    pick: { blockOnRay: () => null }, runnerAim: () => {}, lookAtSafe: () => Promise.resolve(), partsOf: () => null, makeTrack: () => {}
  }
  const code = esbuild.transformSync(body, { loader: 'ts', format: 'cjs', target: 'node24' }).code
  const run = new Function('require', ...Object.keys(deps), code + `\nreturn ${name}`)(id => id === '../bow' ? bow : require(id), ...Object.values(deps))
  const ctl = { aborted: false }
  return name === 'pointBlank' ? run(a.bot, ctl, a.target.position)
    : name === 'runnerGapArrow' ? run({ bot: a.bot }, ctl, {}, {}, { minHit: 0, maxHit: Infinity, deadline: 10000 })
      : run({ bot: a.bot }, ctl, {}, {}, 0)
}

for (const name of ['pointBlank', 'runnerGapArrow', 'runnerArrow']) test(`direct dragon ${name} uses the shared native full-charge gate`, async () => {
  const a = actor()
  try {
    const shooting = shootDragon(name, a)
    await new Promise(resolve => setImmediate(resolve)); a.age(1001)
    for (let i = 0; i < 27; i++) await a.frame()
    a.age(1008)
    assert.equal(a.releases(), 0, 'direct dragon paths cannot bypass native charge using local elapsed')
    a.age(1021)
    for (let i = 0; i < 12; i++) await a.frame()
    const result = await shooting
    assert.equal(a.releases(), 1)
    assert.equal(name === 'pointBlank' ? result.fullChargeConfirmed : result.shot.fullChargeConfirmed, true)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
  } finally { a.close() }
})

for (const name of ['pointBlank', 'runnerGapArrow', 'runnerArrow']) test(`direct dragon ${name} cancels a paused draw on respawn`, async () => {
  const a = actor()
  let result
  try {
    shootDragon(name, a).then(value => { result = value })
    await new Promise(resolve => setImmediate(resolve))
    a.c.setState({ tick_rate: 20, is_frozen: true })
    a.bot.emit('respawn')
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(result, 'native cancellation must settle without a new game tick')
    assert.equal(result.shot ?? false, false)
    assert.equal(a.releases(), 0)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
    assert.equal(a.bot.listenerCount('physicsTick'), 0)
  } finally { a.close() }
})
