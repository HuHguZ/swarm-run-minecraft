import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { trackFoe, foeHitProof } from '../src/pvp/combat-observe'
import { swarmSightings } from '../src/swarm-senses'
import { SwarmBoard } from '../src/swarm/board'

test('real combat observations preserve wounds and recover focus after a missed visible totem', () => {
  let time = 1000
  const body = (id: number) => {
    const bot: any = new EventEmitter(), metadata = []
    Object.defineProperty(metadata, 9, { get() { throw new Error('enemy health metadata read') } })
    const foe = { id: 7, uuid: 'foe', username: 'Foe', type: 'player', position: new Vec3(3, 64, 0), metadata, equipment: [], onGround: true }
    bot.entity = { id, position: new Vec3(0, 64, 0), metadata: [], effects: {}, onGround: true }
    bot.entities = { 7: foe }; bot._client = new EventEmitter()
    bot.blockAt = p => ({ name: 'air', position: p, boundingBox: 'empty', shapes: [] })
    const tracker = trackFoe(bot, foe, { roundScope: 'round', now: () => time, visible: () => true })
    return { bot, foe, tracker }
  }
  const a = body(1), b = body(2), board = new SwarmBoard('blue', () => time, 8000)
  board.setMembers(['a', 'b'].map(id => ({ id, team: 'blue', position: { x: 0, y: 64, z: 0 }, health: 20, strength: 1, role: 'fighter' as const })))
  const see = (id: string, actor: ReturnType<typeof body>) => {
    const [seen] = swarmSightings(actor.bot)
    assert.ok(seen)
    assert.ok(board.observe(id, time, seen))
    return seen
  }
  const hit = (damage: number) => {
    a.tracker.noteAttack({ min: damage, max: damage, mean: damage, raw: damage })
    a.bot._client.emit('damage_event', { entityId: 7, sourceCauseId: 2 })
  }
  try {
    for (const damage of [6, 6, 5]) hit(damage)
    assert.equal(see('a', a).hpEstimate, 3)
    time += 100
    assert.equal(see('b', b).hpEstimate, 20, 'Engage creates a default model before this observer has hit')
    assert.ok(board.enemies()[0].hpEstimate! < 6, 'a default model cannot erase confirmed wounds')
    b.bot._client.emit('entity_status', { entityId: 7, entityStatus: 35 })
    const firstHeal = see('b', b).hitProof!.healing!.event
    b.bot._client.emit('entity_status', { entityId: 7, entityStatus: 35 })
    assert.notEqual(see('b', b).hitProof!.healing!.event, firstHeal, 'different healing receipts remain distinct while this body clock is frozen')
    assert.ok(board.enemies()[0].hpEstimate! >= 9)
    time += 100
    assert.equal(see('a', a).hpEstimate, 3, 'this observer missed the totem and still has its old model')
    assert.ok(board.enemies()[0].hpEstimate! >= 9, 'the stale model stays invalid after a refreshed sight')
    for (const damage of [6, 6, 5, 6]) hit(damage)
    see('a', a)
    const upper = board.enemies()[0].hpEstimate!
    assert.ok(upper > 0 && upper < 10, 'new confirmed hits after healing restore wounded focus')
    assert.equal(board.enemies()[0].pressure!.hits, 7)
  } finally { a.tracker.stop(); b.tracker.stop() }
})

test('shared damage minimum respects unknown protection while glint never reveals enchantment data', () => {
  const secret: any = {}
  Object.defineProperty(secret, 'data', { get() { throw new Error('hidden enchantment data read') } })
  const armor: any = { name: 'diamond_boots', componentMap: new Map([['enchantments', secret]]) }
  Object.defineProperty(armor, 'ench', { get() { throw new Error('hidden enchantment levels read') } })
  const foe = { id: 7, uuid: 'foe', type: 'player', username: 'Foe', position: new Vec3(3, 64, 0), equipment: [null, null, armor] }
  const bot: any = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(0, 64, 0) }; bot._client = new EventEmitter()
  const tracker = trackFoe(bot, foe, { roundScope: 'round', now: () => 1000, visible: () => true })
  try {
    tracker.noteAttack({ min: 5, max: 5, mean: 5, raw: 5 })
    bot._client.emit('damage_event', { entityId: 7, sourceCauseId: 2 })
    const [hit] = foeHitProof(bot, foe)!.hits
    assert.ok(Math.abs(hit.minDamage - 1) < 1e-10, 'native EPF cap20 permits damage as low as one fifth')
    assert.equal(hit.damage, 5, 'pressure mean keeps its existing meaning')
    assert.ok(Math.abs(tracker.hp.snapshot().hi - 19) < 1e-10, 'the own estimator must use the same conservative minimum before any team healing')
  } finally { tracker.stop() }
})
