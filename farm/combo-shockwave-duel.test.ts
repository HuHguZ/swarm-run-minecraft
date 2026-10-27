import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { duelShockwavePhase } from './swarm/swarm-driver/combo-shockwave-duel'

const pause = () => new Promise(resolve => setTimeout(resolve, 1))
const pos = (x: number, y: number, z: number): any => ({ x, y, z, offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz) } })
function fixture() {
  const events: any[] = []
  const actor = (username, id, x, y) => {
    const bot: any = new EventEmitter(), serializer: any = new EventEmitter()
    serializer.proto = { parsePacketBuffer: (_, bytes) => ({ data: JSON.parse(bytes.toString()) }) }
    bot.username = username; bot.health = 20; bot.ticks = 0; bot.controls = {}; bot.entity = { id, position: pos(x, y, 0), velocity: pos(0, 0, 0), yaw: 0, pitch: 0, onGround: true }
    bot._client = new EventEmitter(); bot._client.serializer = serializer
    bot._client.write = (name, params) => serializer.emit('data', Buffer.from(JSON.stringify({ name, params })))
    bot.setControlState = (name, value) => { bot.controls[name] = value }
    bot.clearControlStates = () => { bot.controls = {} }; bot.deactivateItem = () => { bot.usingHeldItem = false }
    bot.lookAt = async target => { events.push({ kind: 'look', who: username, target }); bot.entity.yaw = -Math.PI / 2 }
    bot.attack = target => { events.push({ kind: 'attack', who: username, target: target.username, tick: bot.ticks }); bot._client.write('use_entity', { target: target.id, mouse: 1 }) }
    bot.quit = () => { events.push({ kind: 'quit', who: username }); bot.emit('end') }
    return bot
  }
  const b = actor('B', 1, 0, 12), a = actor('A', 2, 2, 0), t = actor('T', 3, 0, 0), e = actor('E', 4, 8, 0), bots = [b, a, t, e]
  b.heldItem = { name: 'mace' }; a.heldItem = { name: 'iron_spear' }
  for (const bot of bots) bot.entities = Object.fromEntries(bots.filter(other => bot !== other).map(other => {
    const remote: any = { ...other.entity, username: other.username }
    Object.defineProperty(remote, 'health', { get() { throw Error('enemy HP must not decide') } })
    return [remote.id, remote]
  }))
  let stopped = false, onTick = () => {}, pending = 0, landActive = 0, maxLandActive = 0
  const actions: any = {
    visible: (_bot, target) => target.isValid !== false,
    safeStep: () => true,
    readyIn: bot => Math.max(0, (bot.nextJab ?? 0) - bot.ticks),
    jabReach: () => ({ ok: true }),
    jab: async (bot, target, opts) => {
      if (opts.abortIf()) return { ok: false }
      bot.nextJab = bot.ticks + 21; events.push({ kind: 'jab', who: bot.username, target: target.username, tick: bot.ticks })
      bot._client.write('block_dig', { status: 7 }); return { ok: true }
    },
    strike: async (bot, target, p) => { if (p.ctl.aborted) return { sent: false, why: 'cancelled' }; bot.attack(target); return { sent: true } },
    chargedSpear: async (bot, target, p) => {
      events.push({ kind: 'charge', target: target?.username, stand: p.stand, maxTicks: p.maxTicks, tick: bot.ticks }); bot.usingHeldItem = true
      bot._client.write('use_item', { hand: 0 }); const started = bot.ticks; pending++
      try { while (!p.ctl.aborted && bot.ticks - started < 25) await pause(); return { started: true, ticks: bot.ticks - started } }
      finally { pending--; bot.usingHeldItem = false }
    },
    removeFloor: async () => { events.push({ kind: 'drop', tick: b.ticks }); b.entity.onGround = false; b.entity.velocity.y = -.08 },
    maceDive: async (bot, target) => { bot.attack(target); bot.entity.onGround = true; return { sent: true } },
    fullSpearLanding: async (bot, stop) => {
      assert.equal(pending, 0); assert.ok(!Object.values(bot.controls).some(Boolean)); assert.equal(bot.usingHeldItem, false)
      landActive++; maxLandActive = Math.max(maxLandActive, landActive); const start = bot.ticks
      try { while (!stop() && bot.ticks - start < 2) await pause(); return { reason: stop() ? 'cancelled' : 'landed', groundTicks: 2, frames: [] } }
      finally { landActive-- }
    },
  }
  const timer = setInterval(() => { onTick(); for (const bot of bots) { bot.ticks++; bot.emit('physicsTick') } }, 2)
  return { roles: { body: b, spear: a, primary: t, enemy: e }, bots, actions, events, stop: () => stopped,
    setStop: () => { stopped = true }, atTick: fn => { onTick = fn }, kill: bot => { bot.emit('death') },
    get maxLandActive() { return maxLandActive }, close: () => clearInterval(timer) }
}

test('ordinary control emits real jabs without use-item; both enemies act from t0 and B drops after twenty own ticks', async () => {
  const f = fixture()
  try {
    const row = await duelShockwavePhase(f.roles, false, f.stop, f.actions)
    assert.ok(f.events.some(x => x.kind === 'jab'))
    assert.ok(!row.packets.some(x => x.direction === 'serialized' && x.actor === 'A' && x.name === 'use_item'))
    const drop = f.events.find(x => x.kind === 'drop'); assert.ok(drop.tick >= 20)
    const bodyAttacks = f.events.filter(x => x.kind === 'attack' && x.who === 'B')
    assert.ok(bodyAttacks.length > 1)
    assert.ok(bodyAttacks.slice(1).every((x, i) => x.tick - bodyAttacks[i].tick >= 33))
    for (const who of ['T', 'E']) assert.ok(f.events.some(x => x.kind === 'look' && x.who === who && x.target.x === 2))
    assert.equal(row.endReason, 'physics_cap'); assert.equal(row.winner, null)
    assert.equal(row.fullLanding.reason, 'landed'); assert.equal(row.bodyLanding.reason, 'landed'); assert.equal(f.maxLandActive, 2)
  } finally { f.close() }
})

test('A ordinary jabs prefer visible E over closer T, then fall back after E first-life death in both arms', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(), jab = f.actions.jab, enemy = f.roles.enemy
    enemy.entity.position = pos(5.5, 0, 0)
    for (const bot of f.bots) if (bot !== enemy) bot.entities[enemy.entity.id].position = enemy.entity.position
    let jabs = 0
    f.actions.jab = async (bot, target, opts) => {
      const result = await jab(bot, target, opts)
      if (bot === f.roles.spear && result.ok) {
        if (++jabs === 1) f.kill(enemy)
        else f.setStop()
      }
      return result
    }
    try {
      await duelShockwavePhase(f.roles, enabled, f.stop, f.actions)
      assert.deepEqual(f.events.filter(x => x.kind === 'jab' && x.who === 'A').map(x => x.target), ['E', 'T'])
    } finally { f.close() }
  }
})

test('A death before charge does not cancel B drop or surviving enemies, and T death does not cancel A follow-through', async () => {
  for (const deathRole of ['spear', 'primary']) {
    const f = fixture(); let killed = false
    f.atTick(() => { if (!killed && f.roles.body.ticks >= 5) { killed = true; f.kill(f.roles[deathRole]) } })
    try {
      const row = await duelShockwavePhase(f.roles, false, f.stop, f.actions)
      assert.ok(f.events.find(x => x.kind === 'drop').tick >= 20)
      if (deathRole === 'spear') { assert.equal(row.fullLanding.reason, 'first_life_ended'); assert.ok(f.events.some(x => x.who === 'B' && x.kind === 'attack')) }
      else assert.ok(f.events.some(x => x.kind === 'jab' && x.target === 'E' && x.tick > 5))
    } finally { f.close() }
  }
})

test('On uses grounded charge against initial E then joins the same jab policy after public first-life E death', async () => {
  const f = fixture(); let killed = false
  f.atTick(() => { if (!killed && f.roles.spear.ticks >= 8) { killed = true; f.kill(f.roles.enemy); f.roles.enemy.entity = { ...f.roles.enemy.entity }; f.roles.enemy.emit('respawn') } })
  try {
    const row = await duelShockwavePhase(f.roles, true, f.stop, f.actions), charge = f.events.find(x => x.kind === 'charge')
    assert.equal(charge.target, 'E'); assert.equal(charge.stand, false); assert.equal(charge.maxTicks, 80)
    assert.ok(f.events.some(x => x.kind === 'jab' && x.target === 'T' && x.tick > 8))
    assert.ok(!f.events.some(x => x.kind === 'jab' && x.target === 'E' && x.tick > 8))
    assert.ok(row.packets.some(x => x.name === 'block_dig' && x.data.status === 7)); assert.equal(row.dive.sent, true)
  } finally { f.close() }
})

test('nearest foe selection excludes invisible bodies before movement or attack, and revalidates jab cancellation', async () => {
  const f = fixture(); f.actions.visible = (_bot, target) => target.username !== 'T'
  f.actions.jab = async (_bot, target, opts) => { f.setStop(); assert.equal(opts.abortIf(), true); assert.equal(target.username, 'E'); return { ok: false } }
  try { const row = await duelShockwavePhase(f.roles, false, f.stop, f.actions); assert.equal(row.endReason, 'AUTO-STOP'); assert.ok(!f.events.some(x => x.kind === 'attack' && x.target === 'T')) }
  finally { f.close() }
})

test('team wipes include a draw and never resume respawned actors', async () => {
  for (const expected of ['allies', 'enemies', 'draw']) {
    const f = fixture(); let killed = false
    f.atTick(() => { if (!killed && f.roles.body.ticks >= 8) { killed = true; for (const bot of expected === 'allies' ? [f.roles.primary, f.roles.enemy] : expected === 'enemies' ? [f.roles.spear, f.roles.body] : f.bots) { f.kill(bot); bot.entity = { ...bot.entity }; bot.emit('respawn') } } })
    try { const row = await duelShockwavePhase(f.roles, false, f.stop, f.actions); assert.equal(row.winner, expected); assert.equal(row.timeout, false); assert.equal(row.error, null) }
    finally { f.close() }
  }
})

test('round winner is fixed before landing tails while final winner retains later physical deaths', async () => {
  for (const lateOwnDeath of [false, true]) {
    const f = fixture(), normalLanding = f.actions.fullSpearLanding
    if (lateOwnDeath) {
      let killed = false
      f.atTick(() => { if (!killed && f.roles.body.ticks >= 8) { killed = true; f.kill(f.roles.spear); f.kill(f.roles.primary); f.kill(f.roles.enemy) } })
    }
    f.actions.fullSpearLanding = async (bot, stop) => {
      if (bot === f.roles.body) {
        if (lateOwnDeath) f.kill(bot)
        else { f.kill(f.roles.primary); f.kill(f.roles.enemy) }
      }
      return normalLanding(bot, stop)
    }
    try {
      const row = await duelShockwavePhase(f.roles, false, f.stop, f.actions)
      assert.equal(row.winner, lateOwnDeath ? 'allies' : null)
      assert.equal(row.winnerAtRoundEnd, lateOwnDeath ? 'allies' : null)
      assert.equal(row.finalWinner, lateOwnDeath ? 'draw' : 'allies')
    } finally { f.close() }
  }
})

test('enemy disconnect, unsolicited respawn and entity replacement censor the round rather than proving a wipe', async () => {
  for (const event of ['end', 'respawn', 'entity_identity']) {
    const f = fixture(); let changed = false
    f.atTick(() => {
      if (!changed && f.roles.body.ticks >= 8) {
        changed = true
        for (const bot of [f.roles.primary, f.roles.enemy]) {
          if (event !== 'end') bot.entity = { ...bot.entity }
          if (event !== 'entity_identity') bot.emit(event)
        }
      }
    })
    try {
      const row = await duelShockwavePhase(f.roles, false, f.stop, f.actions)
      assert.ok(row.error); assert.equal(row.censored, true)
      assert.equal(row.winner, null); assert.equal(row.finalWinner, null)
      assert.equal(row.firstLifeEvents.filter(x => x.event === 'death').length, 0)
    } finally { f.close() }
  }
})

test('ordinary mace cooldown starts at its delayed serialized attack, not at the earlier await entry', async () => {
  const f = fixture(), strike = f.actions.strike; let delayed = false
  f.actions.strike = async (bot, target, p) => {
    if (bot === f.roles.body && !delayed) {
      delayed = true; const started = bot.ticks
      while (!p.ctl.aborted && bot.ticks - started < 4) await pause()
    }
    return strike(bot, target, p)
  }
  try {
    await duelShockwavePhase(f.roles, false, f.stop, f.actions)
    const attacks = f.events.filter(x => x.kind === 'attack' && x.who === 'B')
    assert.ok(attacks.length >= 3)
    assert.ok(attacks.slice(1).every((x, i) => x.tick - attacks[i].tick >= 33), JSON.stringify(attacks.map(x => x.tick)))
  } finally { f.close() }
})

test('wall cap joins a broken charge wait by closing owned clients and removes every owned listener', async () => {
  const f = fixture(), realNow = Date.now; let shifted = false, joined = false
  f.actions.chargedSpear = async (bot) => { bot._client.write('use_item', { hand: 0 }); await new Promise(resolve => bot.once('end', resolve)); joined = true; return { started: true } }
  f.atTick(() => { if (!shifted && f.roles.body.ticks >= 5) { shifted = true; Date.now = () => realNow() + 8100 } })
  try {
    const row = await duelShockwavePhase(f.roles, true, f.stop, f.actions)
    assert.equal(row.endReason, 'wall_cap'); assert.equal(row.timeout, true); assert.equal(joined, true)
    assert.equal(row.winner, null, 'forced cleanup disconnects do not create a combat draw')
    assert.equal(f.events.filter(x => x.kind === 'quit').length, 4)
    for (const bot of f.bots) { assert.equal(bot.listenerCount('physicsTick'), 0); assert.equal(bot.listenerCount('death'), 0); assert.equal(bot._client.listenerCount('packet'), 0); assert.equal(bot._client.serializer.listenerCount('data'), 0); assert.ok(!Object.values(bot.controls).some(Boolean)) }
  } finally { Date.now = realNow; f.close() }
})

test('stand-only CLI validates pair/HP bounds and forwards duel without loading a static import cycle', async () => {
  const raw = readFileSync(require.resolve('./swarm/swarm-driver/combo-shockwave-duel'), 'utf8')
  const source = require('@typescript/typescript6').transpileModule(raw, { compilerOptions: { module: 1, target: 9 } }).outputText
  for (const args of [[], ['3', '20'], ['0'], ['21'], ['1', '50'], ['1', '20', 'extra']]) {
    const calls: any[] = [], exits: number[] = [], module = { exports: {} }
    const localRequire: any = name => { assert.equal(name, './combo-shockwave'); return { shockwaveTrials: (...call) => { calls.push(call); return Promise.resolve() } } }
    localRequire.main = module
    const run = () => runInNewContext(source, { require: localRequire, module, exports: module.exports, process: { argv: ['node', 'duel.js', ...args], exit: value => exits.push(value) }, console })
    if (args.length && !['3'].includes(args[0])) assert.throws(run, /combo-shockwave-duel/)
    else { run(); await Promise.resolve(); assert.deepEqual(calls, [[args.length ? 3 : 1, 'duel', args.length ? 20 : 100]]); assert.deepEqual(exits, [0]) }
  }
})
