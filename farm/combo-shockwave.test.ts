import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { shockwavePhase, shockwaveContacts, nativeEndReceipt } from './swarm/swarm-driver/combo-shockwave'

const pause = () => new Promise(resolve => setTimeout(resolve, 1))
function fixture() {
  const actor = (name: string, id: number) => {
    const bot: any = new EventEmitter(), client: any = new EventEmitter(), serializer: any = new EventEmitter()
    serializer.proto = { parsePacketBuffer: (_type: string, bytes: Buffer) => ({ data: JSON.parse(bytes.toString()) }) }
    client.serializer = serializer; client.write = (name: string, params: any) => serializer.emit('data', Buffer.from(JSON.stringify({ name, params })))
    bot.username = name; bot._client = client; bot.health = 100; bot.ticks = 0; bot.controls = {}; bot.ends = 0
    bot.entity = { id, position: { x: id, y: id === 1 ? 163 : 151, z: 600.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: id !== 1 }
    bot.ndClock = { get age() { return BigInt(bot.ticks) } }
    bot.heldItem = { name: id === 1 ? 'mace' : 'iron_spear' }
    bot.setControlState = (name: string, state: boolean) => { bot.controls[name] = state }
    bot.clearControlStates = () => { bot.controls = {} }
    bot.deactivateItem = () => { bot.released = true }
    bot.quit = () => { bot.ends++; bot.emit('end') }
    bot.attack = (target: any) => { bot._client.write('use_entity', { target: target.id, mouse: 1 }); return 'real-attack' }
    return bot
  }
  const body = actor('B', 1), spear = actor('A', 2), primary = actor('T', 3), enemy = actor('E', 4)
  for (const target of [primary, enemy]) Object.defineProperty(target, 'health', { get() { throw Error('enemy HP cannot choose actions') } })
  const bots = [body, spear, primary, enemy], events: any[] = []
  let stopped = false
  const timer = setInterval(() => { for (const b of bots) { b.ticks++; b.emit('physicsTick') } }, 1)
  const actions: any = {
    removeFloor: async () => { events.push({ kind: 'drop', tick: spear.ticks }); body.entity.onGround = false; body.entity.velocity.y = -.08 },
    chargedSpear: async (_bot: any, _target: any, p: any) => {
      events.push({ kind: 'charge_call', stand: p.stand, maxTicks: p.maxTicks })
      await pause(); spear._client.write('use_item', { hand: 0 }); const start = spear.ticks
      events.push({ kind: 'charge_packet', tick: start })
      while (!p.ctl.aborted && spear.ticks - start < 45) await pause()
      events.push({ kind: 'charge_end', primaryDead: events.some(e => e.kind === 'primary_death') })
      return { started: true, ticks: spear.ticks - start }
    },
    maceDive: async (_bot: any, target: any, p: any) => {
      events.push({ kind: 'dive', aborted: p.ctl.aborted }); const result = body.attack(target)
      events.push({ kind: 'attack_return', result }); body.entity.onGround = true
      return { sent: true, why: 'packet_sent' }
    },
    target: (_bot: any, username: string) => bots.find(b => b.username === username)?.entity
  }
  return { roles: { body, spear, primary, enemy }, bots, events, actions, stop: () => stopped,
    setStop: () => { stopped = true }, close: () => clearInterval(timer) }
}

test('both arms wait twenty body physics ticks after serialized spear use, then share the same drop and dive; Off sends no attack', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(), original = f.roles.body.attack
    try {
      const row = await shockwavePhase(f.roles, enabled, f.stop, f.actions)
      const charge = f.events.find(e => e.kind === 'charge_packet'), drop = f.events.find(e => e.kind === 'drop')
      assert.ok(drop.tick - charge.tick >= 20)
      assert.equal(f.events.find(e => e.kind === 'charge_call').stand, true)
      assert.equal(f.events.find(e => e.kind === 'charge_call').maxTicks, 80)
      assert.equal(row.packets.filter(p => p.actor === 'B' && p.name === 'use_entity').length, enabled ? 1 : 0)
      assert.equal(row.dive.sent, enabled)
      assert.equal(row.dive.sham, !enabled)
      assert.equal(row.attacks.length, 1)
      assert.equal(f.roles.body.attack, original)
      assert.ok(f.bots.every(bot => bot.released && !Object.values(bot.controls).some(Boolean)))
      assert.ok(f.bots.every(bot => bot._client.listenerCount('packet') === 0 && bot.listenerCount('death') === 0))
    } finally { f.close() }
  }
})

test('primary target death ends only B while A continues its charged attack toward the second enemy', async () => {
  const f = fixture()
  let spearContinued = false
  f.actions.maceDive = async (_bot: any, target: any, p: any) => {
    f.roles.body.attack(target); f.roles.primary.emit('death'); f.events.push({ kind: 'primary_death' })
    assert.equal(p.ctl.aborted, true); f.roles.body.entity.onGround = true
    return { sent: true }
  }
  const charge = f.actions.chargedSpear
  f.actions.chargedSpear = async (bot: any, target: any, p: any) => {
    const promise = charge(bot, target, p)
    while (!f.events.some(e => e.kind === 'primary_death')) await pause()
    spearContinued = !p.ctl.aborted
    f.roles.enemy._client.emit('packet', { entityId: 4, sourceCauseId: 3, sourceDirectId: 3, sourceTypeId: 19 }, { name: 'damage_event' }, Buffer.from([1]))
    f.roles.enemy.emit('death')
    return promise
  }
  try {
    const row = await shockwavePhase(f.roles, true, f.stop, f.actions)
    assert.equal(spearContinued, true)
    assert.deepEqual(row.deaths.map(e => e.actor), ['T', 'E'])
    assert.ok(row.packets.some(p => p.name === 'damage_event' && p.data.entityId === 4))
  } finally { f.close() }
})

test('own death or STOP cancels both actions and joins their finalizers before restoring the attack wrapper', async () => {
  for (const kind of ['death', 'STOP']) {
    const f = fixture(), original = f.roles.body.attack; let joined = false
    f.actions.chargedSpear = async (_bot: any, _target: any, p: any) => {
      f.roles.spear._client.write('use_item', { hand: 0 })
      try { while (!p.ctl.aborted) await pause() } finally { await pause(); joined = true }
      return { started: true }
    }
    f.actions.removeFloor = async () => { if (kind === 'death') f.roles.body.emit('death'); else f.setStop() }
    try {
      await shockwavePhase(f.roles, true, f.stop, f.actions)
      assert.equal(joined, true); assert.equal(f.roles.body.attack, original)
      assert.equal(f.events.some(e => e.kind === 'dive'), false)
    } finally { f.close() }
  }
})

test('an unstarted spear use cannot fake readiness and a wall budget expiry retains a failed opportunity', async () => {
  const unstarted = fixture()
  unstarted.actions.chargedSpear = async () => ({ started: false, why: 'lost_sight' })
  try {
    const row = await shockwavePhase(unstarted.roles, true, unstarted.stop, unstarted.actions)
    assert.equal(row.why, 'charge_not_started'); assert.equal(row.dropAtMs, null)
  } finally { unstarted.close() }
  const expired = fixture(), now = Date.now
  expired.actions.removeFloor = async () => { const later = now() + 6001; Date.now = () => later }
  try {
    const row = await shockwavePhase(expired.roles, true, expired.stop, expired.actions)
    assert.equal(row.why, 'wall_cap'); assert.equal(row.dive, null)
  } finally { Date.now = now; expired.close() }
})

test('native B smash and attributed A to E damage stay distinct; foreign hits and sham attempts give no contact credit', () => {
  const ids = { body: 1, spear: 2, primary: 3, enemy: 4 }
  const probe = [{ event: 'mace_damage', attackerId: 1, targetId: 3, damageTypeKey: 'minecraft:mace_smash', cancelled: false },
    { event: 'mace_damage', attackerId: 1, targetId: 4, damageTypeKey: 'minecraft:mace_smash', cancelled: true }]
  const packets = [{ name: 'damage_event', receiverId: 4, data: { entityId: 4, sourceCauseId: 3, sourceDirectId: 3 } },
    { name: 'damage_event', receiverId: 1, data: { entityId: 4, sourceCauseId: 3, sourceDirectId: 3 } },
    { name: 'damage_event', receiverId: 4, data: { entityId: 4, sourceCauseId: 99, sourceDirectId: 99 } }]
  assert.deepEqual(shockwaveContacts(probe, packets, ids), { mace: 1, spear: 1 })
  assert.deepEqual(shockwaveContacts([], packets.slice(1), ids), { mace: 0, spear: 0 })
})

test('an action error retains packet evidence and joins the spear job before fixture cleanup', async () => {
  const f = fixture(), original = f.roles.body.attack
  f.actions.maceDive = async () => { throw new Error('native action interrupted') }
  try {
    const row = await shockwavePhase(f.roles, true, f.stop, f.actions)
    assert.equal(row.why, 'action_error'); assert.match(row.error, /native action interrupted/)
    assert.ok(row.charge); assert.equal(f.roles.body.attack, original)
    assert.ok(f.events.some(e => e.kind === 'charge_end'))
    assert.ok(f.bots.every(bot => bot._client.listenerCount('packet') === 0))
  } finally { f.close() }
})

test('a disconnected actor produces an explicit nativeEnd error receipt, preserving first-life telemetry after the wall cap', async () => {
  const { nativeHpAgreement } = require('./swarm/swarm-driver/combo-anvil')
  const firstLife = { hp: 91, deaths: 0, damage: 9 }
  const end = await nativeEndReceipt('B', async () => { throw new Error('No entity was found') })
  const row = { phase: { why: 'wall_cap' }, nativeEnd: [end], firstLife,
    hpAgreement: nativeHpAgreement(end.health, firstLife) }
  assert.match(row.nativeEnd[0].error, /No entity was found/)
  assert.equal(row.nativeEnd[0].actor, 'B')
  assert.equal(row.firstLife.damage, 9)
  assert.equal(row.hpAgreement.matches, null)
  assert.equal(row.hpAgreement.nativeHp, null)
  const raw = { health: 'B has the following entity data: 91.0f' }
  assert.equal(await nativeEndReceipt('B', async () => raw), raw)
})
