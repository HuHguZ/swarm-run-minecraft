import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { createLastSeen } from '../src/pvp/last-seen'
import { installEvents } from '../src/pvp/duel-events'
import { meleeIntentTurn, strikeTurn } from '../src/pvp/turn-melee'
import { strikeWait } from '../src/pvp/strike-order'
import { meleeRaw, throughIframes, ticksToCharge } from '../src/pvp/damage-model'
import { trackFoe } from '../src/pvp/combat-observe'

function scene(t) {
  const time = clock.activate(new clock.GameClock({ manual: true, epoch: 10000 }))
  const bot: any = new EventEmitter(), packets: any[] = []
  Object.assign(bot, { username: 'Z', version: '1.21.11', registry: require('minecraft-data')('1.21.11'),
    health: 20, _client: new EventEmitter(), inventory: { items: () => [], slots: [] },
    entity: { id: 1, username: 'Z', type: 'player', name: 'player', position: new Vec3(-2.5, 64, .5), height: 1.8, width: .6, metadata: [], onGround: true },
    blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', position: p.floored(), boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] }),
    getControlState: () => false, supportFeature: n => bot.registry.supportFeature(n) })
  bot._client.write = (name, packet) => packets.push({ name, packet })
  require('mineflayer/lib/plugins/entities')(bot)
  const player = (id, username, x, z = .5, weapon = 'iron_sword', active = false) => {
    const metadata: any[] = []
    metadata[bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')] = active ? 1 : 0
    Object.defineProperty(metadata, bot.registry.entitiesByName.player.metadataKeys.indexOf('health'), { get() { throw Error('private player HP') } })
    const e: any = Object.assign(new EventEmitter(), { id, username, type: 'player', name: 'player', isValid: true,
      position: new Vec3(x, 64, z), height: 1.8, width: .6, metadata, equipment: [{ name: weapon }] })
    bot.entities[id] = e; bot.players[username] = { entity: e }
    return e
  }
  bot.entities[1] = bot.entity
  const enemy = player(2, 'Enemy', 0), ally = player(3, 'Y', 2.5)
  bot._ndSwarmAllies = ['A', 'B', 'C', 'D', 'X', 'Y']
  const vision = createLastSeen(bot)
  let exchanges = 0
  const ctx: any = { bot, entity: vision.observe(enemy), prof: { player: true, theirReach: 3.3 }, opts: {},
    attackers: new Map(), dead: new Set(), mobHits: new Map(), bowWatch: {}, swatted: new Map(),
    ctl: { onAbort: [], aborted: false }, session: { bus: new EventEmitter() }, st: { landed: 0, swings: 0 }, tt: { foes: new Map(), state: () => ({}) },
    used() {}, noteExchange() { exchanges++ }, holdWeapon: async () => {}, vision,
    targetHurtAt: 0, targetHurtBy: null, strikeSlotAt: 0, ready: () => false, rest() {},
    after: () => false, roll: () => false, strafeStep() {}, style: { aggression: .8 }, foe: { shieldOff: () => 0 },
    mf: { clock: { leftMs: () => 0 } } }
  installEvents(ctx)
  ctx.foeEst = trackFoe(bot, ctx.entity, { visible: () => vision.visible(ctx.entity) })
  const hit = (victim, source) => bot._client.emit('damage_event', { entityId: victim.id, sourceCauseId: source.id + 1, sourceDirectId: source.id + 1, sourceTypeId: 0 })
  const turn = (cooldownLeft = 0) => {
    const frame: any = { now: time.now(), me: bot.entity.position, r: 2.2, d: 2.5, theirR: 4, cooldownLeft, inSight: true, seesBody: true }
    meleeIntentTurn(ctx, frame)
    return frame
  }
  t.after(() => { ctx.foeEst.stop(); for (const close of ctx.ctl.onAbort) close(); vision.close(); bot.removeAllListeners(); bot._client.removeAllListeners(); time.dispose(); clock.activate(null) })
  return { bot, enemy, ally, vision, ctx, time, player, hit, turn, exchanges: () => exchanges }
}

for (const hand of ['cobblestone', 'water_bucket', null]) test(`a changed ${hand || 'empty'} hand restores the sword without sending a weak melee packet`, async t => {
  const f = scene(t), sword = { name: 'iron_sword' }, hits: string[] = []
  let readyAt = 0, restored = 0
  f.bot.heldItem = sword
  Object.assign(f.ctx, {
    weapon: sword, combo: { note() {} },
    guard: { stats: { worn: false }, async raise(up) { if (!up) f.bot.heldItem = hand ? { name: hand } : null } },
    async holdWeapon() { restored++; f.bot.heldItem = sword; readyAt = f.time.now() + ticksToCharge(sword.name) * 50 }
  })
  Object.assign(f.ctx.mf.clock, { critNow: () => false, srvSprint: false, charge: () => 1 })
  f.ctx.mf.hit = () => hits.push(f.bot.heldItem?.name)
  await strikeTurn(f.ctx, f.turn())
  assert.deepEqual(hits, [], 'a shield/reflex hand change between decision and strike cannot punch with a block or bucket')
  assert.equal(restored, 1)
  assert.equal(f.bot.heldItem.name, 'iron_sword')
  f.ctx.guard = null
  assert.equal(f.turn(readyAt - f.time.now()).canHit, false, 'restoring the sword keeps its native charge delay')
  f.time.advanceTicks(ticksToCharge(sword.name))
  await strikeTurn(f.ctx, f.turn(Math.max(0, readyAt - f.time.now())))
  assert.deepEqual(hits, ['iron_sword'])
})

test('a same-name sword charge reset during shield await invalidates the old ready frame', async t => {
  const f = scene(t), sword = { name: 'iron_sword' }, hits: number[] = []
  let charge = 1, reset = true
  f.bot.heldItem = sword
  Object.assign(f.ctx, { weapon: sword, combo: { note() {} },
    guard: { stats: { worn: false }, async raise(up) { if (!up && reset) { await Promise.resolve(); charge = .04; reset = false } } } })
  Object.assign(f.ctx.mf.clock, { critNow: () => false, srvSprint: false, charge: () => charge, leftMs: () => charge < 1 ? 625 : 0 })
  f.ctx.mf.hit = () => hits.push(charge)
  const frame = f.turn()
  assert.equal(frame.canHit, true, 'the decision was ready before lowering the shield restored the same sword')
  await strikeTurn(f.ctx, frame)
  assert.deepEqual(hits, [], 'same item name does not preserve the charge measured before the await')
  charge = 1
  await strikeTurn(f.ctx, f.turn())
  assert.deepEqual(hits, [1], 'the sword may strike after its actual charge is full again')
})

for (const opportunity of ['race', 'axe tap', 'edge knockback']) test(`fresh strike charge check preserves the explicit ${opportunity} opportunity`, async t => {
  const f = scene(t), weapon = { name: opportunity === 'axe tap' ? 'iron_axe' : 'iron_sword' }, hits: number[] = []
  const charge = opportunity === 'race' ? .92 : .2
  f.bot.heldItem = weapon
  Object.assign(f.ctx, { weapon, combo: { note() {} } })
  Object.assign(f.ctx.mf.clock, { critNow: () => false, srvSprint: false, charge: () => charge })
  f.ctx.mf.hit = () => hits.push(charge)
  const frame: any = { ...f.turn(500), canHit: true }
  if (opportunity === 'race') Object.assign(frame, { race: true, theirR: 2.5, cdHit: 0 })
  else if (opportunity === 'axe tap') Object.assign(frame, { axeTap: true, axe: weapon, blocking: true })
  else Object.assign(frame, { edgeHit: 'hit', canHit: false })
  await strikeTurn(f.ctx, frame)
  assert.deepEqual(hits, [charge])
})

test('native allied damage receipts advance the shared strike window without own hits or retaliation', t => {
  const f = scene(t)
  f.ctx.strikeSlotAt = 99999
  f.hit(f.enemy, f.ally)
  assert.deepEqual([f.ctx.targetHurtAt, f.ctx.targetHurtBy, f.ctx.strikeSlotAt], [10000, 'Y', 0])
  assert.equal(strikeWait(f.time.now(), f.ctx.targetHurtAt, 0), 500, 'the actual shared damage receipt closes ten native ticks')
  assert.equal(f.ctx.st.landed, 0)
  assert.equal(f.exchanges(), 0)
  f.hit(f.bot.entity, f.ally)
  f.hit(f.ally, f.enemy)
  assert.equal(f.ctx.attackers.size, 0, 'friendly damage still cannot turn a teammate into an attacker')
  assert.equal(f.ctx.targetHurtBy, 'Y', 'an allied victim is not our hostile target receipt')
  f.time.advanceTicks(10)
  assert.equal(strikeWait(f.time.now(), f.ctx.targetHurtAt, 0), 0)
  f.hit(f.enemy, f.bot.entity)
  assert.equal(f.ctx.st.landed, 1, 'only our own native receipt increments our hit count')
  assert.equal(f.exchanges(), 1)
  f.time.advanceTicks(10)
  assert.equal(f.turn(125).canHit, false, 'an open victim window never bypasses our sword cooldown')
  f.time.advanceTicks(3)
  assert.equal(f.turn().canHit, true)
})

test('only visibly ready melee allies reserve slots, not archers, eaters, cooling or distant fighters', t => {
  const f = scene(t)
  const bow = f.player(4, 'A', -1, 2, 'bow', true)
  const food = f.player(5, 'B', 1, 2, 'golden_apple', true)
  const far = f.player(6, 'C', 5)
  const cooling = f.player(7, 'D', -1, -2)
  const shield = f.player(8, 'X', 1, -2)
  shield.equipment[1] = { name: 'shield' }
  shield.metadata[f.bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')] = 3
  for (const e of [bow, food, far, cooling, shield, f.ally]) f.vision.observe(e)
  f.ctx.opts.strikeOrder = ['A', 'B', 'C', 'D', 'X', 'Y', 'Z']
  f.bot._client.emit('animation', { entityId: cooling.id, animation: 0 })
  f.ctx.targetHurtAt = f.time.now()
  assert.equal(f.turn().iframes, 700, 'two capable melee allies precede us; five idle actors must not add delay')
  f.hit(f.enemy, f.ally)
  assert.equal(f.turn().iframes, 500, 'the next ready fighter after the actual hitter owns the next native window')
  f.time.advanceTicks(9)
  assert.equal(f.turn().canHit, false, 'coordination never bypasses native victim invulnerability')
  f.time.advanceTicks(1)
  assert.equal(f.turn().canHit, true, 'the next ready sword applies pressure as soon as the victim window opens')
})

test('seeing both players does not reserve a melee slot through the wall between them', t => {
  const f = scene(t), floor = f.bot.blockAt
  f.ally.position.set(0, 64, 3)
  f.bot.blockAt = p => p.z === 1 && (p.x === -1 || p.x === 0) && (p.y === 64 || p.y === 65)
    ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : floor(p)
  assert.equal(f.vision.visible(f.ally), true)
  assert.equal(f.vision.visible(f.enemy), true)
  f.ctx.opts.strikeOrder = ['Y', 'Z']; f.ctx.targetHurtAt = f.time.now()
  assert.equal(f.turn().iframes, 500, 'an armed actor behind observed cover cannot delay the fighter with a clear strike')
})

test('asymmetric sight preserves an unknown roster slot instead of making every fighter first', t => {
  const f = scene(t), floor = f.bot.blockAt
  f.bot.blockAt = p => p.x === 1 && p.y >= 64 && p.y <= 66
    ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : floor(p)
  assert.equal(f.vision.visible(f.ally), false)
  assert.equal(f.vision.visible(f.enemy), true)
  f.ctx.opts.strikeOrder = ['Y', 'Z']; f.ctx.targetHurtAt = f.time.now()
  assert.equal(f.turn().iframes, 600, 'remove only observed unavailable actors; lost sight is not proof of a free slot')
})

test('a visible lava tick cannot forbid a charged sword whose raw damage exceeds that native hurt window', t => {
  const f = scene(t), floor = f.bot.blockAt
  f.bot.heldItem = f.ctx.weapon = { name: 'iron_sword' }
  f.bot.entity.effects = {}
  f.ctx.mf.clock.charge = () => 1
  f.bot.blockAt = p => p.x === 0 && p.y === 64 && p.z === 0
    ? { name: 'lava', position: p.floored(), boundingBox: 'empty', shapes: [] } : floor(p)
  f.bot._client.emit('damage_event', { entityId: f.enemy.id, sourceCauseId: 0, sourceDirectId: 0, sourceTypeId: 24 })
  f.time.advanceTicks(1)
  assert.equal(throughIframes(meleeRaw({ weapon: 'iron_sword' }), { raw: 4, ago: 2 }).raw, 2,
    'the existing jar-derived hurtServer model accepts the excess within ten native ticks')
  assert.equal(f.turn().canHit, true, 'a confirmed visible lava receipt must leave that stronger charged sword available')
  assert.equal(f.ctx.st.landed, 0, 'environmental damage never counts as our own hit')
  assert.equal(f.turn(50).canHit, false, 'known weak incoming damage does not shorten our own cooldown')
  f.ctx.opts.strikeOrder = ['Y', 'Z']; f.ctx.strikeSlotAt = 0
  assert.equal(f.turn().canHit, false, 'the eligible ally still owns the first excess-damage slot')
  f.time.advanceTicks(1)
  assert.equal(f.turn().canHit, true)
  f.bot.entity.effects[f.bot.registry.effectsByName.Weakness.id] = { amplifier: 0 }
  assert.equal(f.turn().canHit, false, 'Weakness makes this sword weaker than the last lava tick')
  delete f.bot.entity.effects[f.bot.registry.effectsByName.Weakness.id]
  f.ctx.mf.clock.charge = () => .5
  assert.equal(f.turn().canHit, false, 'a partial sword charge does not exceed the confirmed lava damage')
  f.ctx.mf.clock.charge = () => 1
  f.hit(f.enemy, f.ally)
  assert.equal(f.turn().canHit, false, 'an actual allied hit immediately replaces the environmental exception')
})

test('packet-only lava and unknown damage never open the victim window', t => {
  const f = scene(t), floor = f.bot.blockAt
  f.bot.heldItem = f.ctx.weapon = { name: 'iron_sword' }; f.ctx.mf.clock.charge = () => 1
  const receipt = type => f.bot._client.emit('damage_event', { entityId: f.enemy.id, sourceCauseId: 0, sourceDirectId: 0, sourceTypeId: type })
  receipt(24)
  assert.equal(f.turn().canHit, false, 'lava type without an observed lava block is insufficient')
  f.bot.blockAt = p => p.x === 0 && p.y === 64 && p.z === 0
    ? { name: 'lava', position: p.floored(), boundingBox: 'empty', shapes: [] }
    : p.x === -1 && p.z === 0 && (p.y === 64 || p.y === 65)
      ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, p.y === 65 ? .5 : 1, 1]] } : floor(p)
  f.time.advanceTicks(1)
  assert.equal(f.vision.visible(f.ctx.entity), true, 'the foe head remains visible above the low cover')
  receipt(24)
  assert.equal(f.turn().canHit, false, 'seeing the foe head does not expose lava behind the low cover')
  f.bot.blockAt = p => p.x === 0 && p.y === 64 && p.z === 0
    ? { name: 'lava', position: p.floored(), boundingBox: 'empty', shapes: [] }
    : p.x === -1 && p.z === 0 && (p.y === 64 || p.y === 65)
      ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : floor(p)
  receipt(24)
  assert.equal(f.turn().canHit, false, 'an enemy and lava behind cover cannot expose a known raw damage value')
  f.bot.blockAt = p => p.x === 0 && p.y === 64 && p.z === 0
    ? { name: 'lava', position: p.floored(), boundingBox: 'empty', shapes: [] } : floor(p)
  receipt(24); assert.equal(f.turn().canHit, true)
  receipt(18); assert.equal(f.turn().canHit, false, 'unknown damage clears the previous known lava value')
})

test('losing sight invalidates the known environmental window before contact resumes', t => {
  const f = scene(t), floor = f.bot.blockAt
  f.bot.heldItem = f.ctx.weapon = { name: 'iron_sword' }; f.ctx.mf.clock.charge = () => 1
  const lava = p => p.x === 0 && p.y === 64 && p.z === 0
    ? { name: 'lava', position: p.floored(), boundingBox: 'empty', shapes: [] } : floor(p)
  f.bot.blockAt = lava
  f.bot._client.emit('damage_event', { entityId: f.enemy.id, sourceCauseId: 0, sourceDirectId: 0, sourceTypeId: 24 })
  assert.equal(f.turn().canHit, true)
  f.bot.blockAt = p => p.x === -1 && p.z === 0 && (p.y === 64 || p.y === 65)
    ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : lava(p)
  f.time.advanceTicks(1); f.bot.emit('physicsTick')
  assert.equal(f.vision.visible(f.ctx.entity), false)
  f.bot.blockAt = lava
  f.time.advanceTicks(1); f.bot.emit('physicsTick')
  assert.equal(f.vision.visible(f.ctx.entity), true)
  assert.equal(f.turn().canHit, false, 'a sight gap cannot preserve certainty about the victim lastHurt value')
})

test('native hurt model and fresh-only receipts permit sustained charged melee during repeated lava ticks', t => {
  const f = scene(t), floor = f.bot.blockAt
  f.bot.heldItem = f.ctx.weapon = { name: 'iron_sword' }; f.ctx.mf.clock.charge = () => 1
  f.bot.blockAt = p => p.x === 0 && p.y === 64 && p.z === 0
    ? { name: 'lava', position: p.floored(), boundingBox: 'empty', shapes: [] } : floor(p)
  let last = null, readyAt = 0, accepted = 0, meleeReceipts = 0
  const damage = (raw, source, type) => {
    const hit = throughIframes(raw, last && { raw: last.raw, ago: (f.time.now() - last.at) / 50 })
    if (!(hit.raw > 0)) return false
    last = { raw: hit.last.raw, at: hit.fresh ? f.time.now() : last.at }
    // LivingEntity.hurtServer broadcasts damage_event only in the fresh branch, not on accepted excess.
    if (hit.fresh) {
      if (source) meleeReceipts++
      f.bot._client.emit('damage_event', { entityId: f.enemy.id, sourceCauseId: source ? source.id + 1 : 0, sourceDirectId: source ? source.id + 1 : 0, sourceTypeId: type })
    }
    return true
  }
  for (let tick = 0; tick < 400; tick++) {
    if (tick % 10 === 0) damage(4, null, 24)
    if (f.turn(Math.max(0, readyAt - f.time.now())).canHit) {
      assert.equal(damage(meleeRaw({ weapon: 'iron_sword' }), f.bot.entity, 34), true, 'every proposed strike is accepted by the native hurt model')
      accepted++; readyAt = f.time.now() + ticksToCharge('iron_sword') * 50
    }
    f.time.advanceTicks(1); f.bot.emit('physicsTick')
  }
  assert.ok(accepted >= 30, `expected sustained pressure over 20 seconds, received ${accepted} accepted strikes`)
  assert.equal(f.ctx.st.landed, meleeReceipts, 'accepted excess without a receipt cannot become a confirmed own hit')
  assert.equal(meleeReceipts, 0, 'these accepted excess hits are deliberately absent from the native packet stream')
  t.diagnostic(`${accepted} model-accepted charged melee hits, ${meleeReceipts} melee damage_event receipts in 400 ticks`)
})
