import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { fightGraphTurn } from '../src/pvp/turn-graph'
import { createAerialCombat } from '../src/combat/aerial-executor'
import * as fg from '../src/pvp/fight-graph'
import sky = require('../src/elytra')
import pick = require('../src/pick')
import clock = require('../src/game-clock')

test('выбранный воздушный залп не заменяется новым разгоном копья; уход и готовое пике сохраняются', t => {
  const executor: typeof import('../src/combat/aerial-executor') = require('../src/combat/aerial-executor')
  const lance: typeof import('../src/combat/aerial-lance') = require('../src/combat/aerial-lance')
  let node = 'RangedVolley'
  t.mock.method(executor, 'createAerialCombat', () => ({ decide: () => ({ node, selected: { id: node } }) }) as any)
  t.mock.method(lance, 'lancePlan', () => ({}) as any)
  const bot: any = new EventEmitter()
  bot.health = 20; bot._ndElytra = {}; bot._ndSkyWorld = {}
  bot.entity = { position: new Vec3(0, 90, 0), velocity: new Vec3(1, 0, 0), elytraFlying: true }
  bot.inventory = { slots: [], items: () => [{ name: 'elytra', count: 1 }, { name: 'firework_rocket', count: 8 }] }
  const flight = sky.create(bot, { enemy: () => ({ id: 2, position: new Vec3(20, 90, 0), elytraFlying: true }) })
  try {
    const volley = flight.decide({ hp: 20, healAt: 8 })
    assert.equal(volley.kind, 'aerial')
    assert.ok('decision' in volley)
    assert.equal(volley.decision.node, 'RangedVolley')
    node = 'DiveStrike'
    const dive = flight.decide({ hp: 20, healAt: 8 })
    assert.ok('decision' in dive)
    assert.equal(dive.decision.node, 'DiveStrike')
    node = 'AerialIntercept'
    assert.equal(flight.decide({ hp: 20, healAt: 8 }).kind, 'lance')
    assert.equal(flight.decide({ hp: 2, healAt: 8 }).kind, 'escape')
  } finally { flight.close() }
})

test('граф не предлагает пике, которое исполнитель отверг по щиту, потолку или паузе', async () => {
  const items = [{ name: 'mace', count: 1 }, { name: 'elytra', count: 1 }]
  const obs = { dist: 8, los: true, me: { items, armor: [], ehp: 20, since: 40 },
    foe: { player: true, armor: [], hp: { lo: 20, hi: 20, mean: 20 }, blocking: false, off: { name: 'shield' } } }
  let allowed = false
  const ctx: any = { GRAPH: true, bot: { inventory: { items: () => items } }, entity: {},
    co: { observe: () => obs }, fg, foe: { shieldOff: () => 0 }, foeGrounded: () => true,
    sky: { planDive: (s) => !s.hisShield && allowed ? { kind: 'dive' } : null },
    ready: () => true, rest() {}, skyOver: () => false, st: {}, prof: { player: true }, lastSwing: 0 }
  const turn: any = { d: 8, dy: 0, hp: 20, now: 0 }
  for (const [shield, feasible, want] of [[true, true, false], [false, false, false], [false, true, true]]) {
    obs.foe.off = shield ? { name: 'shield' } : null
    allowed = feasible
    await fightGraphTurn(ctx, turn)
    assert.equal(ctx.gp.scores.some(s => s.kind === 'dive'), want)
  }
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0, 64, 0), onGround: true, velocity: new Vec3(0, 0, 0) }
  bot._ndElytra = {}; bot._ndSkyWorld = { boxHit: () => false }
  bot.inventory = { slots: [], items: () => [...items, { name: 'iron_spear' },
    { name: 'iron_chestplate' }, { name: 'firework_rocket', count: 8 }] }
  const flight = sky.create(bot, { enemy: () => ({ position: new Vec3(8, 64, 0) }) })
  try {
    assert.equal(flight.decide({ hp: 20, d: 8, dy: 0, foeGrounded: true, prefer: 'dive' }).kind, 'dive')
  } finally { flight.close() }
})

test('медленный glide над целью: нагрудник до досягаемости, затем падение и удар; поднятый щит запрещает сброс', async t => {
  t.mock.method(clock, 'now', () => 5000)
  const mace = { name: 'mace' }
  const target: any = { id: 2, position: new Vec3(1, 64, 0), velocity: new Vec3(0, 0, 0), isValid: true,
    metadata: [3], equipment: [null, { name: 'shield' }] }
  const bot: any = { health: 20, heldItem: mace, _ndMaceHeldAt: 1000, _ndElytra: { fd: 1 },
    entity: { id: 1, position: new Vec3(0, 72, 0), velocity: new Vec3(.05, -.1, 0), elytraFlying: true },
    inventory: { items: () => [mace], slots: [] }, world: { raycast: () => null },
    registry: { entitiesByName: { player: { metadataKeys: ['living_entity_flags'] } } }, lookAt: async () => {} }
  const swaps: string[] = []
  let attacks = 0
  let glideAck = 0, wall = false
  bot.attack = () => { assert.equal(bot.entity.elytraFlying, false); assert.ok(bot._ndElytra.fd > 1.5); attacks++ }
  t.mock.method(pick, 'canHit', () => bot.entity.position.y <= 67 && bot.entity.position.y > 64)
  t.mock.method(pick, 'aim', () => ({ point: target.position }))
  t.mock.method(clock, 'sleep', async () => {
    if (glideAck && --glideAck === 0) bot.entity.elytraFlying = false
    if (bot.entity.elytraFlying) return
    const oldY = bot.entity.position.y
    sky.fallStep(bot.entity.position, bot.entity.velocity)
    bot._ndElytra.fd += oldY - bot.entity.position.y
  })
  const operations: any = { enemy: () => target, stats: {}, allow() {}, used() {},
    kit: () => ({ elytra: true, chest: true, mace: true, rockets: 8 }),
    worldOf: () => ({ floorBelow: () => ({ top: 64 }), boxHit: (x, y) => y < 64 || wall && x > 1 && x < 2 && y > 70 }),
    landingSpot: () => new Vec3(1, 64, 0), gliding: e => !!e.elytraFlying,
    swapChest: async (_b, name, options) => {
      assert.equal(options.hand, 'off'); assert.ok(options.ctl)
      if (name === 'chest') assert.ok(bot.entity.position.y > 67, 'снять элитры до окна удара')
      swaps.push(name)
      if (name === 'chest') glideAck = 2
      else bot.entity.elytraFlying = true
      return { ok: true }
    }, startGlide() {}, fly: async () => { throw new Error('планирование вместо сброса') } }
  const combat = createAerialCombat(bot, operations)
  assert.notEqual(combat.decide().node, 'DiveStrike')
  target.metadata[0] = 0
  assert.equal(combat.decide().node, 'DiveStrike')
  wall = true; target.position.x = 21.5; bot.entity.velocity.x = 3
  assert.notEqual(combat.decide().node, 'DiveStrike', 'стена между тиками — сброс запрещён')
  wall = false; target.position.x = 1; bot.entity.velocity.x = .05
  const result = await combat.run({ aborted: false })
  assert.equal(result.hit, true); assert.equal(attacks, 1)
  assert.deepEqual(swaps, ['chest', 'elytra'])
})
