import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { create } from '../src/duo'
import { installEvents } from '../src/pvp/duel-events'
import { targetTurn } from '../src/pvp/turn-target'
import { openDuel } from '../src/pvp/duel-opening'
import * as clock from '../src/game-clock'

function fixture() {
  const player = (id, username, x) => {
    const metadata: any[] = []
    Object.defineProperty(metadata, 9, { get() { throw Error('private player HP') } })
    return { id, username, name: 'player', type: 'player', isValid: true, position: new Vec3(x, 64, 0), metadata }
  }
  const bot: any = new EventEmitter(), enemy = player(2, 'Enemy', 4), friend = player(3, 'Friend', 1), second = player(4, 'Second', 6)
  Object.assign(bot, { username: 'Body', version: '1.21.11', health: 20, food: 20,
    registry: require('minecraft-data')('1.21.11'), _client: new EventEmitter(), inventory: { items: () => [], slots: [] },
    entity: { id: 1, username: 'Body', position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true },
    players: { Enemy: { entity: enemy }, Friend: { entity: friend }, Second: { entity: second } },
    entities: { 2: enemy, 3: friend, 4: second }, teamMap: { Body: { team: 'blue' }, Friend: { team: 'blue' }, Enemy: { team: 'red' }, Second: { team: 'red' } } })
  return { bot, enemy, friend, second }
}

test('active duo ignores friendly hurt and old friendly attacker memory while retaining real enemies', () => {
  const { bot, enemy, friend, second } = fixture(), attackers = new Map(), dead = new Set()
  const duel = create(bot, { target: () => enemy, attackers, dead })
  try {
    bot.emit('entityHurt', bot.entity, friend)
    assert.equal(bot._ndDuo.seen.has(friend.username), false)
    bot._ndDuo.seen.set(friend.username, clock.now())
    attackers.set(friend.id, { e: friend, at: clock.now(), n: 8 })
    assert.deepEqual(duel.foes().map(e => e.username), ['Enemy'])
    assert.equal(duel.active(), false)
    bot.emit('entityHurt', bot.entity, second)
    assert.deepEqual(duel.foes().map(e => e.username), ['Enemy', 'Second'])
    assert.equal(duel.active(), true)
    dead.add(enemy.id)
    assert.deepEqual(duel.foes().map(e => e.username), ['Second'])
    bot.teamMap.Second.team = 'blue'
    assert.deepEqual(duel.foes(), [], 'public membership changes recheck old memory')
  } finally { duel.close() }
})

test('friendly hit during a duel never becomes the next target after a native enemy death event', async t => {
  const { bot, enemy, friend, second } = fixture()
  t.mock.method(require('../src/utility/fight'), 'create', () => ({ close() {} }))
  t.mock.method(require('../src/arrows'), 'track', () => ({ shots: new Map() }))
  const ctx: any = { bot, entity: enemy, label: enemy.username, prof: { player: true }, opts: {},
    attackers: new Map(), dead: new Set(), mobHits: new Map(), bowWatch: {}, swatted: new Map(),
    ctl: { onAbort: [], aborted: false }, session: { bus: new EventEmitter() }, st: { landed: 0, swings: 0 }, tt: {},
    used() {}, noteExchange() {}, holdWeapon: async () => {}, kills: [], clearArea: 0, burningFood: new Set(),
    vision: { observe: e => e, visible: () => true, source: e => e }, edgeTally() {}, finish: result => result }
  ctx.retarget = e => { ctx.entity = e; ctx.label = e.username; ctx.killed = false }
  installEvents(ctx)
  try {
    bot.emit('entityHurt', bot.entity, friend)
    assert.equal(ctx.attackers.has(friend.id), false)
    bot.emit('entityHurt', bot.entity, second)
    ctx.attackers.set(friend.id, { e: friend, at: clock.now(), n: 100 })
    assert.equal(ctx.otherAttacker()?.e, second, 'old friendly entries cannot outscore an enemy')
    bot.emit('entityDead', enemy)
    assert.equal(ctx.killed, true)
    assert.equal(ctx.dead.has(enemy.id), true)
    await targetTurn(ctx, {} as any)
    assert.equal(ctx.entity, second)
    bot.emit('entityDead', second)
    const end: any = await targetTurn(ctx, {} as any)
    assert.equal(end.end.killed, 'Enemy, Second', 'real death receipts still finish both enemy kills')
    assert.ok(!ctx.kills.includes('Friend'))
  } finally {
    for (const close of ctx.ctl.onAbort) close()
    bot.removeAllListeners()
  }
})

test('a now-allied target ends an active duel without waiting for timeout or reporting a kill', async () => {
  const { bot, friend } = fixture()
  const ctx: any = { bot, entity: friend, label: friend.username, prof: { player: true }, opts: {},
    deadline: -1, selfDied: false, killed: true, dead: new Set(), kills: [], clearArea: 0, burningFood: new Set(),
    vision: { observe: e => e }, edgeTally() {}, finish: result => result, otherAttacker: () => null }
  const result: any = await targetTurn(ctx, {} as any)
  assert.equal(result.end.stopped, 'цель — союзник')
  assert.equal(result.end.killed, undefined)
  assert.deepEqual(ctx.kills, [])
})

test('an explicitly stale friendly target does not spend the duel opening', async () => {
  const { bot, friend } = fixture(), actions = []
  const ctx: any = { bot, entity: friend, prof: { player: true }, opts: {}, lastStand: true,
    holdWeapon: async () => { actions.push('weapon') }, guard: { wear: async () => { actions.push('shield') } },
    pvpSkills: { buffUp: async () => { actions.push('buff') } }, heldName: () => 'stone_sword' }
  await openDuel(ctx)
  assert.deepEqual(actions, [])
})
