import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { antidoteRoundPhase, guardedRoundHeal, antidoteRoundPoses, prepareAntidoteParking } from './swarm/swarm-driver/combo-antidotes-rounds'
import { aim, KINDS, launch, flight, jumpChoice, jumpLaunch } from '../daemon/src/throw'
import { functionSource } from '../daemon/test/source-fixture'

function fixture() {
  const bots: any[] = Array.from({ length: 6 }, (_, i) => {
    const bot: any = new EventEmitter(), client: any = new EventEmitter()
    Object.assign(bot, { username: `actor${i}`, health: 20, food: 20, entities: {}, heldItem: { name: 'iron_sword' },
      entity: { id: i + 1, position: { x: i % 3, y: 151, z: i < 3 ? 606 : 600, offset(x, y, z) { return { x: this.x + x, y: this.y + y, z: this.z + z } } }, velocity: { x: 0, y: 0, z: 0 }, onGround: true },
      inventory: { items: () => [], slots: [] }, clearControlStates() {}, deactivateItem() {}, setControlState() {}, lookAt: async () => {},
      quit() { bot.emit('end') }, waitForTicks: async () => {}, _client: client })
    return bot
  })
  for (const bot of bots) bot.entities = Object.fromEntries(bots.filter(other => other !== bot).map(other => [other.entity.id, { ...other.entity, username: other.username, isValid: true }]))
  let ticks = 0
  const timer = setInterval(() => { ticks++; bots.forEach(bot => bot.emit('physicsTick')) }, 1), calls: any[] = []
  const actions: any = { visible: () => true, safeStep: () => true, cooldown: () => 1,
    opening: async (bot, target, kind) => { calls.push({ kind, actor: bot.username, target: target.id }); return { attempted: true } },
    strike: async (bot, target) => { calls.push({ kind: 'strike', actor: bot.username, target: target.id }); return { sent: true } },
    plan: () => new Map(), landing: async () => ({ reason: 'landed' }), report: () => ({ state: {}, using: false }),
    heal: async () => false, drain: async () => {},
  }
  return { bots, calls, actions, ticks: () => ticks, close: () => clearInterval(timer) }
}

test('scripted 3x3 sends one real opener per enemy kind and joins every actor before landing', async () => {
  const f = fixture(); let stop = false
  f.bots[0].on('physicsTick', () => { if (f.ticks() === 12) stop = true })
  try {
    const result = await antidoteRoundPhase(f.bots, 3, false, () => stop, f.actions)
    const openings = f.calls.filter(call => call.kind !== 'strike')
    assert.deepEqual(openings.map(call => call.kind), ['splash', 'lingering', 'arrow'])
    assert.equal(new Set(openings.map(call => call.actor)).size, 3)
    assert.equal(result.joined, true); assert.equal(result.consumes.length, 0); assert.ok(f.calls.some(call => call.kind === 'strike'))
    assert.ok(f.bots.every(bot => bot.listenerCount('death') === 0 && bot._client.listenerCount('damage_event') === 0))
  } finally { f.close() }
})

test('only a positive house planner recovery assignment runs the actual antidote boundary and returns to ordinary combat', async () => {
  const f = fixture(); let stop = false, assigned = false, drinking = 0
  f.bots[0].inventory.items = () => [{ name: 'honey_bottle', count: 1 }]
  f.actions.plan = () => {
    if (assigned) return new Map(); assigned = true
    return new Map([[f.bots[0].username, { kind: 'recover', data: { antidote: { item: 'honey_bottle' } } }]])
  }
  f.actions.consume = async () => { drinking++; stop = true; return { consumed: true, item: 'honey_bottle', before: [{ name: 'poison' }, { name: 'strength' }], after: [{ name: 'strength' }] } }
  try {
    const result = await antidoteRoundPhase(f.bots, 3, true, () => stop, f.actions)
    assert.equal(drinking, 1); assert.equal(result.consumes.length, 1); assert.equal(result.joined, true)
    assert.equal(result.consumes[0].cleared, true); assert.deepEqual(result.consumes[0].removed, ['poison'])
  } finally { f.close() }
})

test('an assigned milk recovery whose donors reserve their only milk records rejected candidates without consuming or tossing', async () => {
  const f = fixture(); let assigned = false, stop = false, activated = 0, tossed = 0
  const originalNow = Date.now; let now = originalNow()
  Date.now = () => now
  f.bots[1].entity.position.x = 4.29; f.bots[2].entity.position.x = 8.24
  for (const bot of f.bots) { bot.activateItem = () => { activated++ }; bot.toss = async () => { tossed++ } }
  for (const bot of f.bots.slice(1, 3)) bot.inventory.items = () => [{ name: 'milk_bucket', count: 1 }, { name: 'honey_bottle', count: 2 }]
  f.actions.report = bot => { now++; const state = { health: 20, alive: true, damagePerTick: .04,
    inventory: Object.fromEntries(bot.inventory.items().map(item => [item.name, item.count])), effects: [{ name: 'wither', amplifier: 1, remainingTicks: 400 }] }
    return { using: false, state, choice: require('../daemon/src/pvp/antidotes').chooseAntidote(state) } }
  f.actions.plan = () => { if (assigned) return new Map(); assigned = true; return new Map([[f.bots[0].username, { kind: 'recover', data: { antidote: { item: 'milk_bucket' } } }]]) }
  f.bots[0].on('physicsTick', () => { if (f.ticks() === 12) stop = true })
  try {
    const result = await antidoteRoundPhase(f.bots, 3, true, () => stop, f.actions)
    assert.equal(result.error, null, JSON.stringify(result.taskDiagnostics))
    const refusal = result.taskDiagnostics.find(x => x.why === 'no_eligible_donor')
    assert.ok(refusal); assert.equal(refusal.actor, f.bots[0].username); assert.equal(refusal.item, 'milk_bucket')
    assert.deepEqual(refusal.candidates.map(x => x.range), [4.29, 8.24])
    assert.ok(refusal.candidates.every(x => x.currentLife && x.publicLOS && !x.busy && !x.assigned && x.stock === 1 && x.pricedReserve === 1 && x.quote === 0 && x.quoteKind === 'policy'))
    assert.equal(activated, 0); assert.equal(tossed, 0); assert.equal(result.consumes.length, 0); assert.equal(result.transfers.length, 0); assert.equal(result.joined, true)
  } finally { Date.now = originalNow; f.close() }
})

test('a worthwhile far donor really approaches before an in-range toss, then pickup precedes consumption', async () => {
  const f = fixture(); let assigned = false, stop = false, milk = 0, donorMilk = 1
  const order: string[] = []
  f.bots[1].entity.position.x = 4.29
  f.bots[0].inventory.items = () => milk ? [{ name: 'milk_bucket', count: milk }] : []
  f.bots[1].inventory.items = () => [{ name: 'milk_bucket', count: donorMilk }]
  f.actions.report = bot => ({ using: false, state: { health: 20, alive: true, damagePerTick: .04, inventory: {}, effects: bot === f.bots[0] ? [{ name: 'poison', amplifier: 1, remainingTicks: 400 }] : [] } })
  f.actions.plan = () => { if (assigned) return new Map(); assigned = true; return new Map([[f.bots[0].username, { kind: 'recover', data: { antidote: { item: 'milk_bucket' } } }]]) }
  f.actions.approach = async (bot, ctl, spot) => { order.push('approach'); assert.equal(ctl.aborted, false); await Promise.resolve(); bot.entity.position.x = spot.x; bot.entity.position.z = spot.z; return { ok: true } }
  f.actions.toss = async (bot, recipient) => { assert.ok(Math.hypot(bot.entity.position.x - recipient.position.x, bot.entity.position.z - recipient.position.z) <= 3); order.push('toss'); donorMilk--; return { ok: true } }
  f.actions.pickup = async () => { assert.equal(donorMilk, 0); order.push('pickup'); milk++; return { ok: true } }
  f.actions.consume = async () => { assert.equal(milk, 1); order.push('consume'); stop = true; return { consumed: true, before: [{ name: 'poison' }], after: [] } }
  f.bots[0].on('physicsTick', () => { if (f.ticks() === 50) stop = true })
  try {
    const result = await antidoteRoundPhase(f.bots, 3, true, () => stop, f.actions)
    assert.deepEqual(order, ['approach', 'toss', 'pickup', 'consume']); assert.equal(result.joined, true); assert.equal(result.consumes.length, 1)
  } finally { f.close() }
})

test('STOP during a real donor approach prevents the later toss and joins the pending delivery', async () => {
  const f = fixture(); let assigned = false, stop = false, approached = 0, tossed = 0, consumed = 0
  f.bots[1].entity.position.x = 4.29; f.bots[1].inventory.items = () => [{ name: 'milk_bucket', count: 1 }]
  f.actions.report = bot => ({ using: false, state: { health: 20, alive: true, damagePerTick: .04, inventory: {}, effects: bot === f.bots[0] ? [{ name: 'poison', amplifier: 1, remainingTicks: 400 }] : [] } })
  f.actions.plan = () => { if (assigned) return new Map(); assigned = true; return new Map([[f.bots[0].username, { kind: 'recover', data: { antidote: { item: 'milk_bucket' } } }]]) }
  f.actions.approach = async (_bot, ctl) => { approached++; await Promise.resolve(); stop = true; assert.equal(ctl.aborted, true); return { ok: true } }
  f.actions.toss = async () => { tossed++; return { ok: true } }; f.actions.consume = async () => { consumed++; return { consumed: true } }
  f.bots[0].on('physicsTick', () => { if (f.ticks() === 50) stop = true })
  try {
    const result = await antidoteRoundPhase(f.bots, 3, true, () => stop, f.actions)
    assert.equal(approached, 1); assert.equal(tossed, 0); assert.equal(consumed, 0); assert.equal(result.joined, true)
  } finally { f.close() }
})

test('an automatic pickup before the donor retreat returns counts from the pre-delivery baseline and can request the antidote', async () => {
  const f = fixture(); let assigned = false, stop = false, milk = 0, pickupCalls = 0, consumeCalls = 0
  f.bots[1].entity.position.x = 4.29
  f.bots[0].inventory.items = () => milk ? [{ name: 'milk_bucket', count: milk }] : []
  f.bots[1].inventory.items = () => [{ name: 'milk_bucket', count: 1 }]
  f.actions.report = bot => ({ using: false, state: { health: 20, alive: true, damagePerTick: .04, inventory: {}, effects: bot === f.bots[0] ? [{ name: 'poison', amplifier: 1, remainingTicks: 400 }] : [] } })
  f.actions.plan = () => { if (assigned) return new Map(); assigned = true; return new Map([[f.bots[0].username, { kind: 'recover', data: { antidote: { item: 'milk_bucket' } } }]]) }
  f.actions.approach = async (bot, _ctl, spot) => { bot.entity.position.x = spot.x; bot.entity.position.z = spot.z; return { ok: true } }
  f.actions.toss = async () => { milk = 1; await Promise.resolve(); return { ok: true } }
  f.actions.pickup = async () => { pickupCalls++; return { ok: false } }
  f.actions.consume = async () => { consumeCalls++; stop = true; return { consumed: true, before: [{ name: 'poison' }], after: [] } }
  f.bots[0].on('physicsTick', () => { if (f.ticks() === 50) stop = true })
  try {
    const result = await antidoteRoundPhase(f.bots, 3, true, () => stop, f.actions)
    assert.equal(consumeCalls, 1); assert.equal(pickupCalls, 0); assert.equal(result.transfers.find(x => x.stage === 'pickup').received, 1); assert.equal(result.joined, true)
  } finally { f.close() }
})

test('unexpected enemy disconnect is censored, and death plus respawn cannot issue a new first-life attack', async () => {
  const f = fixture(); let changed = false
  f.actions.strike = async bot => {
    if (!changed) { changed = true; f.bots[3].emit('end'); f.bots[4].emit('death'); f.bots[4].emit('respawn') }
    return { sent: true }
  }
  try {
    const result = await antidoteRoundPhase(f.bots, 3, false, () => false, f.actions)
    assert.equal(result.censored, true); assert.equal(result.winner, null); assert.equal(result.joined, true)
    assert.ok(result.error.includes('unexpected_lifecycle'))
  } finally { f.close() }
})

test('a landing observer failure preserves the failed attempt and detaches round listeners after joining actions', async () => {
  const f = fixture(); let stop = false
  f.actions.strike = async () => { stop = true; return { sent: true } }
  f.actions.landing = async () => { throw new Error('landing receipt unavailable') }
  try {
    const result = await antidoteRoundPhase(f.bots, 3, false, () => stop, f.actions)
    assert.equal(result.joined, true); assert.equal(result.winner, null)
    assert.match(result.error, /landing receipt unavailable/)
    assert.ok(f.bots.every(bot => bot.listenerCount('death') === 0 && bot.listenerCount('physicsTick') === 0 && bot._client.listenerCount('damage_event') === 0))
  } finally { f.close() }
})

test('a hostile projectile preparation loses its target life before release without firing at the stale body', async () => {
  const f = fixture(); let stop = false, guarded = false
  f.actions.opening = async (_bot, target, kind, ctl) => {
    if (kind === 'splash') {
      f.bots.find(bot => bot.entity.id === target.id).emit('death')
      await Promise.resolve(); guarded = ctl.aborted; stop = true
    }
    return { fired: !ctl.aborted }
  }
  try {
    const result = await antidoteRoundPhase(f.bots, 3, false, () => stop, f.actions)
    assert.equal(guarded, true); assert.equal(result.joined, true)
  } finally { f.close() }
})

test('ordinary house healing delayed in equip cannot activate after STOP or own death, and restores its exact method', async () => {
  for (const cause of ['stop', 'death']) {
    const f = fixture(), bot = f.bots[0], original = () => { uses++ }; let aborted = false, uses = 0
    bot.activateItem = original
    try {
      const result = await guardedRoundHeal(bot, { get aborted() { return aborted } }, async () => {
        await Promise.resolve(); if (cause === 'stop') aborted = true; else bot.health = 0
        bot.activateItem(); return { ok: true }
      })
      assert.equal(uses, 0); assert.equal(result.ok, false); assert.equal(bot.activateItem, original)
    } finally { f.close() }
  }
})

test('centered gap-six toxin fixture selects a real house liftoff trajectory for both potions instead of forcing an unreachable standing throw', () => {
  const { Vec3 } = require('../daemon/src/pvp/vec3')
  for (const size of [3, 4, 5]) {
    const poses = antidoteRoundPoses(size)
    assert.ok(poses.flat().every(n => n - Math.floor(n) === .5))
    for (let lane = 0; lane < size; lane++) {
      const [x, ownZ] = poses[lane], [enemyX, enemyZ] = poses[size + lane]
      assert.equal(enemyX, x); assert.equal(ownZ - enemyZ, 6)
      const feet = new Vec3(enemyX, 151, enemyZ), target = new Vec3(x, 151 + .3, ownZ)
      const bot: any = { entity: { position: feet, onGround: true }, blockAt: p => ({ name: p.y < 151 ? 'stone' : 'air', boundingBox: p.y < 151 ? 'block' : 'empty' }) }
      for (const kind of ['splash_potion', 'lingering_potion']) {
        assert.equal(aim(feet.offset(0, 1.62 - .1, 0), target, KINDS[kind], { x: 0, y: 0, z: 0 }, false), null)
        const choice = jumpChoice(bot, target, KINDS[kind], { jump: 'auto', sprint: false })
        assert.equal(choice?.kind, 'stand')
        const { from, moved } = jumpLaunch(feet, choice.kind)
        const sol = aim(from, target, KINDS[kind], moved, true)
        assert.ok(sol && Number.isFinite(sol.pitch) && sol.ticks > 0)
        const speed = launch(sol.pitch, KINDS[kind]), arrival = flight(speed.vh, speed.vy + moved.y, 6, KINDS[kind])
        assert.ok(Math.abs(from.y + arrival.y - target.y) < 1e-7)
      }
    }
  }
})

test('all six actors receive the same far spawn after clearing old clouds and preparing its floor, with command replies retained', async () => {
  const f = fixture(), calls: string[] = []
  try {
    const receipt = await prepareAntidoteParking(f.bots, async command => { calls.push(command); return `accepted:${command}` }, () => false)
    assert.equal(calls[0], 'kill @e[type=minecraft:area_effect_cloud]')
    assert.equal(calls[1], 'fill 648 150 648 652 150 652 minecraft:stone')
    assert.equal(calls[2], 'fill 648 151 648 652 154 652 minecraft:air')
    assert.deepEqual(calls.slice(3), f.bots.map(bot => `spawnpoint ${bot.username} 650 151 650`))
    assert.ok(receipt.every((r, i) => r.command === calls[i] && r.reply === `accepted:${calls[i]}`))
  } finally { f.close() }
})

test('round preparation clears clouds before reset/heal and rejects native Poison even while HP is still full', async () => {
  for (const [initiallyPresent, poisoned, emptyList] of [[true, false, false], [false, false, true], [false, true, false]]) {
    const f = fixture(), calls: string[] = []; let cloud = initiallyPresent, connected = 0
    for (const [i, bot] of f.bots.entries()) {
      const [x, z] = antidoteRoundPoses(3)[i]
      Object.assign(bot.entity.position, { x, z }); bot.game = { gameMode: 'survival' }
    }
    const cmd = async (command: string) => {
      calls.push(command)
      if (command === 'kill @e[type=minecraft:area_effect_cloud]') { cloud = false; return initiallyPresent ? 'Killed 1 entities' : 'No entity was found' }
      const query = /^data get entity (\w+) (\w+)$/.exec(command)
      if (query) {
        const bot = f.bots.find(b => b.username === query[1]), p = bot.entity.position
        const value = query[2] === 'Pos' ? `[${p.x}d, 151.0d, ${p.z}d]` : query[2] === 'Health' ? '20.0f' : query[2] === 'active_effects' ?
          poisoned ? '[{id:"minecraft:poison",duration:78,amplifier:1b}]' : emptyList ? '[]' : null : '20'
        return value === null ? 'Found no elements matching active_effects' : `${bot.username} has the following entity data: ${value}`
      }
      return 'accepted'
    }
    const modules = {
      '../../../daemon/src/paths': { REPO_ROOT: '/fixture' }, '../../../daemon/src/game-clock': { GameClock: class {} },
      './combo-ideas': { clients: [], stopped: () => false, connect: async () => f.bots[connected++], sleep: async () => {}, measure: () => { throw new Error('fixture checked') } },
      './combo-air': { cmd, setup: async () => { calls.push('reset/heal'); assert.equal(cloud, false, 'a surviving cloud can poison the just-healed fixture') },
        give: async () => {}, hold: async () => {}, position: bot => bot.entity.position },
      './combo-ab': { settleFixtureTeleport: async () => {} }, '../../../daemon/src/pvp/antidotes': { ownAntidoteState: () => ({ effects: [] }) }, './combo-anvil': {},
    }
    const run = new Function('require', 'fs', 'path', 'randomUUID', 'prepareAntidoteParking', 'antidoteRoundPoses', 'console',
      `${functionSource(require.resolve('./swarm/swarm-driver/combo-antidotes-rounds'), 'antidoteRounds').replace(/^export\s+/, '')}; return antidoteRounds`)(
      name => { assert.ok(name in modules, name); return modules[name] },
      { mkdirSync() {}, closeSync() {}, openSync() {}, writeFileSync() {} }, require('node:path'), () => 'fixture', prepareAntidoteParking, antidoteRoundPoses, { log() {} })
    try {
      await assert.rejects(run(3, 1), poisoned ? /unsettled antidote rounds/ : /fixture checked/)
      assert.equal(calls[0], 'kill @e[type=minecraft:area_effect_cloud]')
      assert.ok(calls.indexOf('reset/heal') > 0)
    } finally { f.close() }
  }
})

test('STOP prevents even the first cloud cleanup or parking mutation', async () => {
  const calls: string[] = []
  await assert.rejects(prepareAntidoteParking([], async command => { calls.push(command) }, () => true), /AUTO-STOP/)
  assert.deepEqual(calls, [])
})

test('a rejected real opening retains the existing unsafe result and records which onAim guard refused', async () => {
  const f = fixture(); let stop = false, launchOptions: any
  delete f.actions.opening
  f.bots[4].health = 0; f.bots[5].health = 0
  f.bots[3].inventory.items = () => [{ name: 'splash_potion', count: 1, componentMap: new Map([['potion_contents', { data: { potion: 'minecraft:strong_poison' } }]]) }]
  f.actions.unsafeSplash = () => true
  f.actions.throwAt = async (_bot, _target, options) => {
    launchOptions = options
    const allowed = options.onAim({ from: { x: 0, y: 152.52, z: 600 }, sol: { at: { x: 0, y: 151.3, z: 606 }, yaw: 0, pitch: .2, ticks: 12 } })
    stop = true; return { thrown: allowed, why: allowed ? '' : 'отменил' }
  }
  try {
    const result = await antidoteRoundPhase(f.bots, 3, false, () => stop, f.actions)
    const opening = result.actions.find(x => x.kind === 'opening_splash').result
    assert.equal(launchOptions.jump, 'auto'); assert.equal(launchOptions.sprint, false)
    assert.equal(opening.thrown, false); assert.equal(opening.onAimRejected[0].ctlAborted, false)
    assert.equal(opening.onAimRejected[0].visible, true); assert.equal(opening.onAimRejected[0].unsafeSplash, true)
    assert.equal(opening.onAimRejected[0].target.position.z, 606)
  } finally { f.close() }
})
