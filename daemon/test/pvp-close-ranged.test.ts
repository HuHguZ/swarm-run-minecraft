import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const { Vec3 } = require('vec3')
const clock = require('../src/game-clock')
const combat = require('../src/combat')
const bow = require('../src/bow')
const pick = require('../src/pick')

function scene(t, { distance = 4.3, wallHeight = 1, hand = 'diamond_sword', screen = false, onTick = null }: any = {}) {
  const time = new clock.GameClock({ manual: true, epoch: 10000 }); clock.activate(time)
  t.mock.method(Math, 'random', () => .5)
  t.mock.method(console, 'log', () => {})
  const bot: any = new EventEmitter(); bot.setMaxListeners(100)
  const data = require('minecraft-data')('1.21.11')
  const Item = require('prismarine-item')('1.21.11')
  const Block = require('prismarine-block')('1.21.11')
  bot._client = new EventEmitter(); bot._client.state = 'play'
  const packets: any[] = []
  bot._client.write = (name, packet) => packets.push({ name, ...packet })
  bot.registry = data; bot.version = '1.21.11'; bot.game = { gameMode: 'survival', difficulty: 'normal' }
  bot.username = 'NeuroDown'; bot.health = 20; bot.food = 20; bot.foodSaturation = 5
  bot.entity = { id: 1, type: 'player', username: bot.username, position: new Vec3(.5, 0, .5), velocity: new Vec3(0, 0, 0),
    onGround: true, yaw: -Math.PI / 2, pitch: 0, height: 1.8, width: .6, eyeHeight: 1.62, metadata: [], effects: {} }
  const foe = { id: 2, type: 'player', name: 'player', username: 'Foe', uuid: 'foe', isValid: true,
    position: new Vec3(.5 + distance, 0, .5), velocity: new Vec3(0, 0, 0), onGround: true,
    yaw: Math.PI / 2, pitch: 0, height: 1.8, width: .6, equipment: [], metadata: [], effects: {} }
  bot.entities = { 1: bot.entity, 2: foe }; bot.players = { Foe: { entity: foe } }
  if (hand) foe.equipment[0] = new Item(data.itemsByName[hand].id, 1)
  bot.blockAt = p => {
    p = p.floored()
    const wall = p.x === 1 && p.y < wallHeight && Math.abs(p.z) <= 1
    const lowRoof = p.x === 0 && p.y === 2 && Math.abs(p.z) <= 1
    const name = p.y < 0 ? 'stone' : wall || lowRoof ? 'bedrock' : screen && p.x === 2 && p.y === 1 ? 'glass' : 'air'
    const b = Block.fromStateId(data.blocksByName[name].defaultState, 0); b.position = p; return b
  }
  bot.world = { getBlock: p => bot.blockAt(p), raycast(from, direction, length) {
    const hit = pick.blockOnRay(bot, from, direction, length)
    return hit && { ...hit.block, position: hit.pos, intersect: from.plus(direction.scaled(hit.t)) }
  } }
  const slots = Array(46).fill(null)
  for (const [n, name] of ['diamond_sword', 'bow', 'arrow'].entries()) {
    const it = new Item(data.itemsByName[name].id, name === 'arrow' ? 64 : 1); it.slot = 36 + n; slots[it.slot] = it
  }
  bot.inventory = { slots, items: () => slots.filter(Boolean) }
  bot.quickBarSlot = 0; bot.heldItem = slots[36]
  bot.setQuickBarSlot = n => { bot.quickBarSlot = n; bot.heldItem = slots[36 + n]; bot.emit('heldItemChanged') }
  bot.equip = async item => { bot.setQuickBarSlot(item.slot - 36) }
  bot.controlState = {}
  bot.setControlState = (key, value) => { bot.controlState[key] = value }
  bot.getControlState = key => !!bot.controlState[key]
  bot.clearControlStates = () => { for (const key of Object.keys(bot.controlState)) bot.setControlState(key, false) }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async p => { const d = p.minus(pick.eyeOf(bot)); await bot.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))) }
  const useKey = data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  let drawing = false, draws = 0, releases = 0, paths = 0
  bot.activateItem = () => {
    if (bot.heldItem?.name !== 'bow') return
    drawing = true; draws++
    bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: useKey, value: 1 }] })
  }
  bot.deactivateItem = () => {
    if (!drawing || bot.heldItem?.name !== 'bow') return
    drawing = false; releases++; bot._client.write('block_dig', { status: 5 })
    bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: useKey, value: 0 }] })
  }
  bot.on('heldItemChanged', () => { drawing = false })
  bot.attack = () => {}; bot.swingArm = () => {}; bot.chat = () => {}; bot.findBlock = () => null
  bot.nearestEntity = predicate => Object.values(bot.entities).find(predicate)
  bot.pathfinder = new EventEmitter()
  Object.assign(bot.pathfinder, { movements: { blocksToAvoid: new Set(), exclusionAreasStep: [], exclusionAreasBreak: [], exclusionAreasPlace: [] },
    setGoal(goal) {
      this.goal = goal
      if (goal) { paths++; queueMicrotask(() => bot.emit('path_update', { status: 'noPath', path: [] })) }
    }, isMoving: () => false, isMining: () => false, isBuilding: () => false })
  const ctl = { aborted: false, onAbort: [] as Array<() => void>, abort() { if (this.aborted) return; this.aborted = true; for (const fn of this.onAbort) fn() } }
  const params = { target: 'Foe', allowPlayer: true, arena: { x: 0, y: 0, z: 0, r: 24 }, timeoutSeconds: 12, roundScope: 'close-bow' }
  const session: any = { bot, current: { name: 'fight', ctl, params }, state: () => ({ health: bot.health }),
    bus: { emit() {}, drain: () => [] }, movements: bot.pathfinder.movements, tactics: { snapshot: () => ({ threatLevel: 0 }) } }
  time.attach(bot)
  let age = 1000
  bot._client.emit('update_time', { age: BigInt(age) })
  const tick = async () => {
    time.advanceTicks(1); bot._client.emit('update_time', { age: BigInt(++age) })
    onTick?.({ bot, foe, ctl, paths, draws, releases, drawing, age })
    bot.emit('physicsTick'); bot.emit('physicTick'); bot.emit('ndMovementSent')
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  const run = async () => {
    let done = false, result, error
    combat.fight(session, ctl, params).then(r => { result = r; done = true }, e => { error = e; done = true })
    for (let i = 0; i < 360 && !done; i++) await tick()
    assert.equal(done, true, 'bounded actual PvP loop must finish')
    if (error) throw error
    return { result, draws, releases, paths, packets }
  }
  t.after(() => { ctl.abort(); bot.emit('end'); time.dispose() })
  return { bot, foe, run }
}

test('actual PvP uses a clear close bow shot after a failed route leaves melee unavailable', async t => {
  const f = scene(t)
  const eye = pick.eyeOf(f.bot).offset(0, -.1, 0)
  const aim = bow.aim(eye, () => f.foe.position.offset(0, .99, 0))
  assert.ok(aim)
  assert.equal(bow.blockedAt(f.bot, eye, aim), null, 'the low wall leaves the actual projectile trajectory clear')
  const out = await f.run()
  assert.ok(out.paths >= 1, 'the main loop tried a route before choosing a close shot')
  assert.ok(out.result.arrows > 0, JSON.stringify({ arrows: out.result.arrows, draws: out.draws, paths: out.paths, tricks: out.result.tricks }))
  assert.ok(out.releases > 0, 'the real bow executor releases a natively confirmed charge')
})

test('close bow keeps physical projectile clearance through a visible glass screen', async t => {
  const f = scene(t, { screen: true })
  const eye = pick.eyeOf(f.bot).offset(0, -.1, 0)
  const aim = bow.aim(eye, () => f.foe.position.offset(0, .99, 0))
  assert.equal(bow.blockedAt(f.bot, eye, aim)?.x, 2)
  const out = await f.run()
  assert.ok(out.paths > 0)
  assert.equal(out.releases, 0)
  assert.equal(out.result.arrows || 0, 0)
})

for (const [hand, shoot] of [['diamond_sword', false], [null, true]] as const) {
  test(`close bow prices recent damage against visible ${hand || 'empty hand'}`, async t => {
    const f = scene(t, { hand, onTick: ({ bot, age }) => {
      if (age % 10 === 0) { bot.health -= .1; bot.emit('entityHurt', bot.entity) }
    } })
    const out = await f.run()
    assert.ok(out.paths > 0)
    assert.equal(out.releases > 0, shoot)
  })
}

test('a visible approach during a close draw yields back to melee', async t => {
  let approached = false
  const f = scene(t, { onTick: ({ bot, foe, draws }) => {
    if (!draws) return
    approached = true
    foe.position.x = Math.max(2.4, foe.position.x - .28)
    bot.emit('entityMoved', foe)
  } })
  const out = await f.run()
  assert.equal(approached, true, 'the decision first accepted the stationary target')
  assert.equal(out.releases, 0, 'it cancels when the observed charge becomes expensive')
  assert.ok(out.result.swings > 0, 'the actual main loop resumes with a reachable melee attack')
})

test('abort stops a close draw before a charged shot and frees movement controls', async t => {
  const f = scene(t, { onTick: ({ ctl, draws }) => { if (draws) ctl.abort() } })
  const out = await f.run()
  assert.ok(out.draws > 0)
  assert.equal(out.result.arrows || 0, 0)
  assert.ok(Object.values(f.bot.controlState).every(v => !v))
})

test('the same actual bow fixture can release beyond the ordinary ranged threshold', async t => {
  const f = scene(t, { distance: 8 })
  const out = await f.run()
  assert.ok(out.result.arrows > 0)
  assert.ok(out.releases > 0)
})
