import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { windChargedSpearPhase } from './swarm/swarm-driver/combo-wind-charged-spear'
import { windChargedPhase } from './swarm/swarm-driver/combo-wind-charged'

function fixture() {
  const actor = (username: string, id: number, x: number) => {
    const bot: any = new EventEmitter(), client: any = new EventEmitter(), serializer: any = new EventEmitter()
    const point = (x: number, y = 151, z = 600.5): any => ({ x, y, z, offset(dx, dy, dz) { return point(x + dx, y + dy, z + dz) } })
    Object.assign(bot, { username, health: 100, food: 20, entities: {}, entity: { id, position: point(x), velocity: point(0, 0, 0), onGround: true, yaw: 0, pitch: 0 },
      heldItem: { name: username === 'B' ? 'iron_spear' : 'diamond_sword' }, controls: {}, clearControlStates() { bot.controls = {} },
      setControlState(k, v) { bot.controls[k] = v }, deactivateItem() {}, lookAt: async () => {}, quit() { bot.emit('end') },
      waitForTicks: async (n: number) => { for (let i = 0; i < n; i++) await new Promise<void>(resolve => bot.once('physicsTick', () => resolve())) } })
    client.write = () => {}; serializer.proto = { parsePacketBuffer: (_type, bytes) => ({ data: JSON.parse(bytes.toString()) }) }
    client.serializer = serializer; bot._client = client
    return bot
  }
  const a = actor('A', 1, 600.5), t = actor('T', 2, 600.5), b = actor('B', 3, 603.5), e = actor('E', 4, 608.5), bots = [a, t, b, e]
  for (const bot of bots) bot.entities = Object.fromEntries(bots.filter(other => other !== bot).map(other => [other.entity.id, { ...other.entity, username: other.username, isValid: true }]))
  let ticks = 0
  const timer = setInterval(() => { ticks++; for (const bot of bots) bot.emit('physicsTick') }, 1)
  const calls: any[] = [], roles = { attacker: a, target: t, receiver: b, enemy: e }
  const actions: any = {
    target: (bot, name) => Object.values<any>(bot.entities).find(entity => entity.username === name), visible: () => true,
    safeStep: () => true, readyIn: () => 0, jabReach: () => ({ ok: true }),
    jab: async (bot, target, p) => { if (p.abortIf()) return { ok: false }; calls.push({ kind: 'jab', actor: bot.username, target: target.id, ticks }); return { ok: true } },
    throwPotion: async () => { calls.push({ kind: 'toss', ticks }); return { thrown: true, ticks: 2 } },
    strike: async () => { calls.push({ kind: 'strike', ticks }); t.emit('death'); return { sent: true } },
    landing: async bot => { calls.push({ kind: 'landing', actor: bot.username, ticks }); return { reason: 'landed' } },
    phase: async (roles, _mode, stop, p) => {
      const toss = await p.throwPotion()
      if (stop()) return { why: 'cancelled', joined: true, captureComplete: false }
      const strike = await p.strike(roles.attacker, roles.target, { ctl: { get aborted() { return stop() } } })
      const landing = await Promise.all([roles.attacker, roles.receiver].map(bot => p.landing(bot, stop)))
      return { why: 'complete', joined: true, captureComplete: true, toss, strike, landing }
    }, damageTypeName: (id: number) => id === 37 ? 'spear' : 'other', velocityFromRaw: () => null,
  }
  return { a, b, t, e, bots, roles, actions, calls, ticks: () => ticks, close: () => clearInterval(timer) }
}

test('whole-combo charge survives primary death and is joined before either landing, with an attributed second-target receipt', async () => {
  const f = fixture(); let chargeDone = false, targetDied = false
  f.t.on('death', () => { targetDied = true })
  Object.defineProperty(f.e, 'health', { get() { throw Error('enemy exact HP is not a policy input') } })
  f.actions.chargedSpear = async (bot, target, p) => {
    f.calls.push({ kind: 'charge', target: target.id, maxTicks: p.maxTicks, stand: p.stand })
    while (!p.ctl.aborted) {
      if (targetDied && !chargeDone) {
        bot._client.emit('damage_event', { entityId: 4, sourceTypeId: 37, sourceCauseId: 4, sourceDirectId: 4 })
        chargeDone = true
      }
      await bot.waitForTicks(1)
    }
    f.calls.push({ kind: 'charge_end', ticks: f.ticks(), targetDied }); return { started: true }
  }
  try {
    const result = await windChargedSpearPhase(f.roles, true, () => false, f.actions)
    assert.equal(result.joined, true); assert.equal(result.contacts.length, 1)
    assert.equal(result.contacts[0].targetId, 4); assert.equal(result.contacts[0].stage, 'charged')
    assert.ok(f.calls.find(call => call.kind === 'toss').ticks >= 20)
    assert.equal(f.calls.find(call => call.kind === 'charge').maxTicks, 80)
    assert.equal(f.calls.find(call => call.kind === 'charge_end').targetDied, true)
    const end = f.calls.findIndex(call => call.kind === 'charge_end'), lands = f.calls.flatMap((call, i) => call.kind === 'landing' ? [i] : [])
    assert.equal(lands.length, 2); assert.ok(lands.every(i => i > end))
    assert.equal(f.b.listenerCount('physicsTick'), 0); assert.equal(f.e.listenerCount('respawn'), 0)
    assert.equal(f.b._client.listenerCount('damage_event'), 0)
  } finally { f.close() }
})

test('water control actually uses ordinary ready spear jabs against visible E and never starts held use', async () => {
  const f = fixture(); let charge = 0
  f.actions.chargedSpear = async () => { charge++; return {} }
  try {
    const result = await windChargedSpearPhase(f.roles, false, () => false, f.actions)
    assert.equal(result.joined, true); assert.equal(charge, 0)
    const jabs = f.calls.filter(call => call.kind === 'jab')
    assert.ok(jabs.length > 0); assert.ok(jabs.every(call => call.target === 4))
    assert.equal(f.calls.filter(call => call.kind === 'strike').length, 1)
    assert.equal(result.spear.kind, 'ordinary_sprint_jab_control_no_held_use')
    assert.equal(Object.values(f.b.controls).some(Boolean), false)
  } finally { f.close() }
})

test('STOP during common preparation prevents toss and fatal strike, and closes every owned scope', async () => {
  const f = fixture(); let stopped = false
  const cancel = () => { if (f.ticks() === 7) stopped = true }; f.b.on('physicsTick', cancel)
  f.actions.phase = async (_r, _m, _s, p) => { await p.throwPotion(); return { why: 'cancelled', joined: true } }
  try {
    const result = await windChargedSpearPhase(f.roles, false, () => stopped, f.actions)
    assert.equal(result.joined, true); assert.equal(result.why, 'cancelled')
    assert.equal(f.calls.filter(call => ['toss', 'strike'].includes(call.kind)).length, 0)
    assert.equal(f.b._client.listenerCount('damage_event'), 0); assert.equal(f.e.listenerCount('death'), 0)
  } finally { f.b.removeListener('physicsTick', cancel); f.close() }
})

test('foreign or wrong-target source37 packets cannot be credited and a target life replacement aborts further jabs', async () => {
  const f = fixture(); let sent = false
  f.actions.jab = async () => {
    if (!sent) {
      sent = true
      f.b._client.emit('damage_event', { entityId: 4, sourceTypeId: 37, sourceCauseId: 100, sourceDirectId: 100 })
      f.b._client.emit('damage_event', { entityId: 2, sourceTypeId: 37, sourceCauseId: 4, sourceDirectId: 4 })
      f.e.entity = { ...f.e.entity, id: 40 }; f.e.emit('respawn')
    } else throw Error('jab after old target life ended')
    return { ok: true }
  }
  try {
    const result = await windChargedSpearPhase(f.roles, false, () => false, f.actions)
    assert.equal(sent, true); assert.equal(result.contacts.length, 0); assert.equal(result.joined, true)
    assert.equal(f.e.listenerCount('respawn'), 0)
  } finally { f.close() }
})

test('real reused K03 capture retains the complete B action window before its deactivation and landing', async () => {
  const f = fixture(); let chargeDone = false, earlyDeactivation = false
  f.actions.phase = windChargedPhase
  f.actions.chargedSpear = async (_bot, _target, p) => {
    while (!p.ctl.aborted) await f.b.waitForTicks(1)
    chargeDone = true; return { started: true }
  }
  f.b.deactivateItem = () => { if (!chargeDone) earlyDeactivation = true }
  try {
    const result = await windChargedSpearPhase(f.roles, true, () => false, f.actions)
    assert.equal(result.deathBoost.captureComplete, true); assert.equal(result.deathBoost.outcome.deathObserved, true)
    assert.ok(result.deathBoost.endedAtMs - result.deathBoost.deathAtMs >= 2000)
    assert.equal(earlyDeactivation, false); assert.equal(result.joined, true)
    assert.equal(f.calls.filter(call => call.kind === 'strike').length, 1)
    assert.equal(f.b._client.listenerCount('damage_event'), 0); assert.equal(f.t.listenerCount('death'), 0)
  } finally { f.close() }
})
