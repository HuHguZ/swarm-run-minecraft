import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { activeShockwavePhase, fullSpearLanding, activeOutcome } from './swarm/swarm-driver/combo-shockwave-active'

const pause = () => new Promise(resolve => setTimeout(resolve, 1))
function fixture() {
  const actor = (username: string, id: number) => {
    const bot: any = new EventEmitter(), serializer: any = new EventEmitter()
    serializer.proto = { parsePacketBuffer: (_: string, bytes: Buffer) => ({ data: JSON.parse(bytes.toString()) }) }
    bot.username = username; bot.health = 100; bot.ticks = 0; bot.controls = {}; bot._client = new EventEmitter(); bot._client.serializer = serializer
    bot._client.write = (name, params) => serializer.emit('data', Buffer.from(JSON.stringify({ name, params })))
    bot.entity = { id, position: { x: id === 1 ? 600.5 : id === 2 ? 602.5 : id === 3 ? 600.5 : 608.5, y: id === 1 ? 163 : 151, z: 600.5 },
      velocity: { x: 0, y: 0, z: 0 }, onGround: id !== 1, yaw: -Math.PI / 2, pitch: 0 }
    bot.heldItem = id === 1 ? { name: 'mace' } : id === 2 ? { name: 'iron_spear' } : null
    bot.setControlState = (name, value) => { bot.controls[name] = value }
    bot.clearControlStates = () => { bot.controls = {} }; bot.deactivateItem = () => { bot.released = true }
    bot.quit = () => bot.emit('end')
    bot.attack = target => bot._client.write('use_entity', { target: target.id, mouse: 1 })
    return bot
  }
  const b = actor('B', 1), a = actor('A', 2), t = actor('T', 3), e = actor('E', 4), bots = [b, a, t, e], events: any[] = []
  const remote = bot => ({ ...bot.entity, username: bot.username, position: bot.entity.position })
  for (const bot of bots) bot.entities = Object.fromEntries(bots.filter(x => x !== bot).map(x => [x.entity.id, remote(x)]))
  for (const bot of bots) for (const entity of Object.values<any>(bot.entities)) Object.defineProperty(entity, 'health', { get() { throw Error('enemy health must not decide') } })
  let stopped = false
  const timer = setInterval(() => { for (const bot of bots) { bot.ticks++; bot.emit('physicsTick') } }, 1)
  const actions: any = {
    target: (bot, name) => Object.values<any>(bot.entities).find(x => x.username === name), visible: () => true,
    strike: async (bot, target, p) => { if (!p.ctl.aborted) { bot.attack(target); return { sent: true, why: 'packet_sent' } } return { sent: false, why: 'cancelled' } },
    chargedSpear: async (_a, _e, p) => {
      a._client.write('use_item', { hand: 0 }); const tick = a.ticks
      events.push({ kind: 'use', tick, stand: p.stand, forward: a.controls.forward, sprint: a.controls.sprint })
      while (!p.ctl.aborted && a.ticks - tick < 40) await pause()
      return { started: true, ticks: a.ticks - tick }
    },
    removeFloor: async () => { events.push({ kind: 'drop', tick: a.ticks }); b.entity.onGround = false; b.entity.velocity.y = -.08 },
    maceDive: async (_b, target) => { b.attack(target); b.entity.onGround = true; return { sent: true } },
  }
  return { roles: { body: b, spear: a, primary: t, enemy: e }, bots, events, actions, stop: () => stopped,
    setStop: () => { stopped = true }, close: () => clearInterval(timer) }
}

test('active causal arms retain the real-versus-sham B difference and start the same eighty-tick enemy policy only after A use', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(), original = f.roles.body.attack
    try {
      const row = await activeShockwavePhase(f.roles, 'ca', enabled, f.stop, f.actions)
      assert.equal(row.dive.sent, enabled)
      assert.equal(row.enemyWindow.physicsTicks, 80)
      assert.ok(row.enemyWindow.startedAtMs >= row.actualUse.ms, 'enemy control starts after the actual serialized use')
      assert.ok(row.enemyWindow.frames.every(frame => frame.ms >= row.actualUse.ms))
      assert.ok(row.enemyWindow.retaliation.sent > 0)
      assert.equal(f.events[0].stand, false, 'waiting never enables the helper auto-hop')
      assert.equal(f.events[0].forward === true, false); assert.equal(f.events[0].sprint === true, false)
      assert.equal(row.waitPolicy, 'grounded_no_auto_hop')
      assert.ok(f.events.find(x => x.kind === 'drop').tick - f.events[0].tick >= 20)
      assert.equal(f.roles.body.attack, original)
      assert.equal(row.fullLanding.reason, 'landed')
      assert.ok(row.fullLanding.groundTicks >= 2)
    } finally { f.close() }
  }
})

test('useful control keeps real B in both arms even when early E death ends the spear helper before twenty ticks', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(), action = f.actions.chargedSpear
    f.actions.chargedSpear = async (a, e, p) => {
      const job = action(a, e, p)
      while (!f.events.length || f.roles.spear.ticks - f.events[0].tick < 5) await pause()
      f.roles.enemy.emit('death')
      return job
    }
    try {
      const row = await activeShockwavePhase(f.roles, 'useful', enabled, f.stop, f.actions)
      assert.equal(row.dive.sent, true)
      assert.equal(f.events[0].stand, false, 'useful run and waiting arms both disable auto-hop')
      assert.equal(f.events[0].forward === true, !enabled)
      assert.equal(f.events[0].sprint === true, !enabled)
      assert.ok(f.events.find(x => x.kind === 'drop').tick - f.events[0].tick >= 20)
      assert.equal(f.roles.spear.controls.forward, false); assert.equal(f.roles.spear.controls.sprint, false)
      assert.equal(row.enemyWindow.endReason, 'first_life_ended')
    } finally { f.close() }
  }
})

test('full landing waits for two new consecutive grounded physics ticks after use and jump have ended', async () => {
  const bot: any = new EventEmitter(); bot.health = 20; bot.entity = { position: { x: 0, y: 151, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: false }
  let done = false
  const job = fullSpearLanding(bot, () => false).then(result => { done = true; return result })
  bot.entity.onGround = true; bot.emit('physicsTick'); await pause(); assert.equal(done, false)
  bot.entity.onGround = false; bot.emit('physicsTick'); bot.entity.onGround = true; bot.emit('physicsTick'); await pause(); assert.equal(done, false)
  bot.emit('physicsTick'); const result = await job
  assert.equal(result.reason, 'landed'); assert.equal(result.groundTicks, 2)
  assert.equal(bot.listenerCount('physicsTick'), 0)
})

test('STOP joins active retaliation and clears sprint, strafe and owned listeners before the next fixture', async () => {
  const f = fixture(); let joined = false
  f.actions.strike = async (_bot, _target, p) => { f.setStop(); while (!p.ctl.aborted) await pause(); joined = true; return { sent: false, why: 'cancelled' } }
  try {
    const row = await activeShockwavePhase(f.roles, 'useful', false, f.stop, f.actions)
    assert.equal(joined, true); assert.equal(row.fullLanding.reason, 'AUTO-STOP')
    for (const bot of f.bots) { assert.ok(!Object.values(bot.controls).some(Boolean)); assert.equal(bot.listenerCount('death'), 0); assert.equal(bot._client.serializer.listenerCount('data'), 0) }
  } finally { f.close() }
})

test('an own first-life death followed by respawn never becomes a successful full landing', async () => {
  const f = fixture()
  f.actions.strike = async () => {
    f.roles.spear.emit('death'); f.roles.spear.entity = { ...f.roles.spear.entity }; f.roles.spear.emit('respawn')
    return { sent: true }
  }
  try { assert.equal((await activeShockwavePhase(f.roles, 'ca', true, f.stop, f.actions)).fullLanding.reason, 'first_life_ended') }
  finally { f.close() }
})

test('active opportunity counts late packet contacts separately and never treats a foreign cause or respawn as an in-window kill', () => {
  const packet = ms => ({ ms, name: 'damage_event', receiverId: 4, data: { entityId: 4, sourceCauseId: 3, sourceDirectId: 3 } })
  const row: any = { ids: { spear: 2, enemy: 4 }, actors: { enemy: 'E', spear: 'A' },
    receipts: { enemy: { deaths: 1 } }, probe: [], phase: { enemyWindow: { startedAtMs: 100, endedAtMs: 200 },
      firstLifeEvents: [{ ms: 201, actor: 'E', event: 'death' }], packets: [packet(150), packet(210), { ...packet(150), receiverId: 1 }],
      fullLanding: { reason: 'landed', groundTicks: 2 }, heldEndMs: 190 } }
  const outcome = activeOutcome(row)
  assert.equal(outcome.packetContactsWithinWindow, 1); assert.equal(outcome.packetContactsAfterWindow, 1)
  assert.equal(outcome.killWithinWindow, false); assert.equal(outcome.killAfterWindow, true)
  row.traces = { enemy: { damage: [{ ms: 220, entityId: 4, sourceCauseId: 3, sourceDirectId: 3 }] } }
  assert.equal(activeOutcome(row).packetContactsWithinWindow, 0)
  assert.equal(activeOutcome(row).packetContactsAfterWindow, 1, 'own E trace remains open through the full A landing tail')
  row.phase = undefined; row.probe = [{ event: 'fall_damage', player: 'A', cancelled: false, finalDamage: 4 }]
  assert.equal(activeOutcome(row).nativeAFallDamage, 4)
  assert.equal(activeOutcome(row).nativeALateFallDamage, null, 'partial failure retains known damage with unknown release timing')
})

test('active CLI dispatches causal and useful modes with pair and HP values without invoking the static CLI', async () => {
  const source = readFileSync(require.resolve('./swarm/swarm-driver/combo-shockwave-active'), 'utf8'), main = source.lastIndexOf('if (require.main === module)')
  assert.ok(main > 0)
  for (const mode of ['ca', 'useful']) {
    const module = { exports: {} }, calls: any[] = [], exits: number[] = []
    const localRequire: any = (name: string) => name === './combo-shockwave' || name === './combo-anvil' ? {} : require(name)
    localRequire.main = module
    runInNewContext(source.slice(0, main) + '\nactiveShockwaveTrials = capture;\n' + source.slice(main), { require: localRequire, module, exports: module.exports,
      process: { argv: ['node', 'combo-shockwave-active.js', mode, '3', '20'], exit: code => exits.push(code) }, console,
      capture: (...args) => { calls.push(args); return Promise.resolve() } })
    await Promise.resolve(); assert.deepEqual(calls, [[mode, 3, 20]]); assert.deepEqual(exits, [0])
  }
})
