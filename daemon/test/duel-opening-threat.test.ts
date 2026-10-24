import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { track } from '../src/mace/track'
import { openDuel } from '../src/pvp/duel-opening'
import { maceDefenseTurn } from '../src/pvp/turn-mace'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

function fixture(t, delay = 1000) {
  const time = new clock.GameClock({ manual: true, epoch: 10000 })
  clock.activate(time)
  t.after(() => time.dispose())
  const bot: any = new EventEmitter(), controls = {}, actions: string[] = []
  const ctl = { aborted: false, onAbort: [] }, intent = { name: 'fight', ctl }
  Object.assign(bot, { username: 'Own', food: 20, health: 20, registry: require('minecraft-data')('1.21.11'),
    entity: { id: 1, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, height: 1.8, metadata: [] },
    inventory: { slots: Array(46).fill(null) }, _client: new EventEmitter(), _ndSwarmAllies: [],
    heldItem: { name: 'stone_sword' },
    blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', position: p.floored(), boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] }),
    look: async yaw => { bot.entity.yaw = yaw }, getControlState: k => !!controls[k] })
  bot.inventory.slots[45] = { name: 'shield' }
  bot.inventory.items = () => [bot.heldItem, bot.inventory.slots[45]]
  const foe = { id: 2, type: 'player', name: 'player', username: 'Champ', position: new Vec3(1.75, 64, .5),
    velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: .6, isValid: true, equipment: [{ name: 'mace' }], metadata: [] }
  // Combat may observe the visible held mace, never a player's private HP metadata.
  Object.defineProperty(foe.metadata, 9, { get() { throw Error('private player HP') } })
  bot.entities = { 1: bot.entity, 2: foe }; bot.players = { Champ: { entity: foe } }
  let raisedAt: number | null = null, wanted = false
  const guard = { stats: { worn: true }, wear: async () => { actions.push('wear'); return true },
    failure: () => null, traceState: () => ({ want: wanted }),
    raise(up) { wanted = up; if (up && raisedAt === null) raisedAt = time.now() - 10000; return Promise.resolve(true) } }
  const mc = track(bot, { enemy: () => foe, telemetryHp: () => null })
  t.after(() => mc.close())
  const ctx: any = { bot, entity: foe, session: { current: intent }, ctl, opts: { targets: [], maceIntent: intent }, prof: { player: true },
    guard, mc, track: { vel: () => foe.velocity }, maceTotem: true, pathing: false, pathTo() {},
    style: { openDelayMs: delay, aggression: .86 }, st: { style: {}, swings: 0 }, tt: { state: () => ({}) },
    holdWeapon: async () => { actions.push('weapon') }, heldName: () => 'stone_sword',
    pvpSkills: { buffUp: async () => { actions.push('buff') } }, rangedAllowed: () => false,
    fortPossible: () => false, healItem: () => null, buildHot: () => false, ready: () => false, rest() {}, used: () => { actions.push('opening') },
    set: (k, v) => { controls[k] = v }, sleep: ms => clock.sleep(ms) }
  return { time, bot, foe, ctx, actions, raisedAt: () => raisedAt }
}

test('actual opening yields to the real mace defense before the native shield window closes', async t => {
  const f = fixture(t)
  f.foe.position.y = 72; f.foe.onGround = false
  let opened = false, error: unknown, defending = false, firstThreat = null
  const opening = openDuel(f.ctx).then(() => { opened = true }, e => { error = e })
  await flush()
  for (let tick = 1; tick <= 30; tick++) {
    f.time.advanceTicks(1)
    // LivingEntity's ordinary gravity and vertical drag, not a supplied threat or damage receipt.
    if (!f.foe.onGround) {
      f.foe.velocity.y = (f.foe.velocity.y - .08) * .98
      f.foe.position.y += f.foe.velocity.y
      if (f.foe.position.y <= 64) { f.foe.position.y = 64; f.foe.onGround = true }
    }
    f.bot.emit('physicsTick'); await flush()
    const threat = f.ctx.mc.threat()
    if (threat && firstThreat === null) firstThreat = { at: f.time.now() - 10000, eta: threat.eta }
    // Mirrors duelBody: the opener completes, then the ordinary defense turn runs.
    if (opened && !f.ctx.ctl.aborted && threat && !defending) {
      defending = true
      maceDefenseTurn(f.ctx, { hp: 20, now: f.time.now(), r: 99 } as any)
        .then(() => { defending = false }, e => { error = e; defending = false })
      await flush()
    }
    if (error) throw error
  }
  await opening
  t.diagnostic(JSON.stringify({ firstThreat, firstRaiseMs: f.raisedAt(), shieldReadyByMs: 325 }))
  assert.ok(firstThreat?.eta >= 6, 'the actual tracker sees the fall early enough for a shield')
  assert.ok(f.raisedAt() !== null && f.raisedAt()! <= 325,
    'before the live fixture attack at625ms, allow five native shield ticks and one delivery tick')
  assert.equal(f.ctx.tt.opening, undefined, 'no offensive opening is inserted ahead of the observed threat')
})

test('a harmless opening retains its original rounded game-time delay', async t => {
  const f = fixture(t, 925)
  let doneAt = null
  const opening = openDuel(f.ctx).then(() => { doneAt = f.time.now() - 10000 })
  await flush()
  for (let tick = 1; tick <= 19; tick++) {
    f.time.advanceTicks(1); await flush()
    if (tick < 19) assert.equal(doneAt, null)
  }
  await opening
  assert.equal(doneAt, 950, '925ms is still rounded once to nineteen game ticks, never extended by polling')
  assert.equal(f.ctx.tt.opening, 'rush')
})

test('a newly observed threat ends an already pending opening without spending the remainder', async t => {
  const f = fixture(t)
  let threat = null, doneAt = null
  f.ctx.mc = { threat: () => threat }
  const opening = openDuel(f.ctx).then(() => { doneAt = f.time.now() - 10000 })
  await flush()
  for (let tick = 1; tick <= 3; tick++) { f.time.advanceTicks(1); await flush() }
  assert.equal(doneAt, null)
  threat = { eta: 10 }
  f.time.advanceTicks(1); await flush()
  assert.equal(doneAt, 200, 'new observations transfer control on the next combat tick')
  assert.equal(f.ctx.tt.opening, undefined)
  await opening
})

test('cancellation during the optional wait starts no opening actions', async t => {
  const f = fixture(t)
  let done = false
  const opening = openDuel(f.ctx).then(() => { done = true })
  await flush()
  f.time.advanceTicks(1); await flush()
  f.ctx.ctl.aborted = true
  f.time.advanceTicks(1); await flush()
  assert.equal(done, true)
  assert.deepEqual(f.actions, ['weapon', 'wear'])
  assert.equal(f.ctx.tt.opening, undefined)
  await opening
})

test('opening wait errors still reach the caller without an offensive continuation', async t => {
  const f = fixture(t), error = Error('clock closed')
  f.ctx.sleep = async () => { throw error }
  await assert.rejects(openDuel(f.ctx), e => e === error)
  assert.deepEqual(f.actions, ['weapon', 'wear'])
})
