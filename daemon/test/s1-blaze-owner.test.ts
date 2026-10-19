import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { observeTactics } from '../src/tactics/minecraft'
import { Vec3 } from 'vec3'

// Бой у спавнера ведёт навык blaze (лук, отдых, коробка, огнестойкость): тактика уровня <3 его не перебивает (s1 06.10).
function session(current: string | null) {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'
  bot.health = 20; bot.food = 20
  bot.inventory = { slots: [], items: () => [{ name: 'iron_sword', count: 1 }] }
  bot.registry = { foodsByName: {}, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [], yaw: 0, pitch: 0 }
  bot.entities = {}
  bot.game = { dimension: 'the_nether', gameMode: 'survival' }
  bot.blockAt = (p: any) => ({ name: p.y < 64 ? 'netherrack' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  const ctl = { aborted: false, onAbort: [] }
  return { bot, current: current ? { name: current, ctl } : null, _blazeCombatCtl: current === 'blaze' ? ctl : null,
    reflex: null, bus: { emit: () => {} }, tempo: null }
}

test('the blaze RPC approach has no combat owner: incoming fire may take the hands', () => {
  const s: any = session('blaze')
  delete s._blazeCombatCtl
  assert.equal(observeTactics(s).protectedEncounter, false)
  s._blazeCombatCtl = { aborted: false }
  assert.equal(observeTactics(s).protectedEncounter, false, 'a stale child control is no owner')
})

test('blaze skill owns the spawner fight: protectedEncounter while blaze runs, not during the fortress approach', () => {
  assert.equal(observeTactics(session('blaze')).protectedEncounter, true)
  assert.equal(observeTactics(session('fortress')).protectedEncounter, false)
  assert.equal(observeTactics(session(null)).protectedEncounter, false)
})

test('a protected blaze skill takes the hands back from a level-2 tactical episode started before it', async () => {
  const { TacticalSystem }: typeof import('../src/tactics/minecraft') = require('../src/tactics/minecraft')
  const lock: typeof import('../src/reflex-lock') = require('../src/reflex-lock')
  const s: any = session('fortress')
  const events: any[] = []
  s.bus = { emit: (type: string, detail: any) => events.push({ type, ...detail }) }
  s.bot.pathfinder = { setGoal: () => {}, setMovements: () => {}, stop: () => {} }
  s.bot.clearControlStates = () => {}
  const tactics: any = s.tactics = new TacticalSystem(s)
  let aborted = false
  tactics.execute = (_action: unknown, ctl: { onAbort: Array<() => void> }) =>
    new Promise(resolve => ctl.onAbort.push(() => { aborted = true; resolve({ cancelled: true }) }))
  try {
    tactics.attach(s.bot)
    tactics.begin({ id: 'Fight', score: 151, reason: 'blaze in reach' }, [], observeTactics(s), 2)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(lock.owner(s)?.source, 'Fight')
    s.current = { name: 'blaze', ctl: { aborted: false, onAbort: [] } }
    s._blazeCombatCtl = s.current.ctl
    tactics.update(true)
    await tactics.waitForRelease()
    assert.equal(aborted, true, 'the stale Fight lease is cancelled once blaze owns the encounter')
    assert.equal(tactics.snapshot().action, null)
  } finally { tactics.detach() }
})

test('entering a portal is a protected escape: tactics below level 3 does not interrupt it (s1-LG-10)', () => {
  const enter: any = session('portal'); enter.current.params = { mode: 'enter' }
  assert.equal(observeTactics(enter).protectedEncounter, true)
  // Casting/building a portal at lava with mobs around stays ordinary work the tactics may interrupt.
  const cast: any = session('portal'); cast.current.params = { mode: 'cast' }
  assert.equal(observeTactics(cast).protectedEncounter, false)
  assert.equal(observeTactics(session('portal')).protectedEncounter, false)
})

test('the bastion skill owns its encounters below level 3 (s1c: 96 tactical interrupts in 27 std runs)', () => {
  assert.equal(observeTactics(session('bastion')).protectedEncounter, true)
})

function bastionUnderGhastShot() {
  const s: any = session('bastion')
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  s.bot.entities[2] = { id: 2, name: 'ghast', position: new Vec3(45.5, 64, .5), height: 4, width: 4, isValid: true, metadata: [] }
  s.autopilot = { lastHurt: { at: clock.now(), type: 'fireball', byMob: true, sourceId: 2, dimension: 'the_nether' } }
  return s
}

test('a visible ghast shooting at a bastion survey is handled by tactics before health becomes critical', () => {
  const s = bastionUnderGhastShot()
  const state = observeTactics(s)
  assert.equal(state.health, 20)
  assert.ok(state.enemies.some((e: any) => e.kind === 'ghast'))
  assert.equal(state.protectedEncounter, false)
  const read = s.bot.blockAt
  s.bot.blockAt = (p: any) => p.x >= 1 && p.x < 2 && p.y >= 64
    ? { name: 'stone', boundingBox: 'block', position: p.floored(), shapes: [[0, 0, 0, 1, 1, 1]] } : read(p)
  assert.equal(observeTactics(s).protectedEncounter, true, 'a ghast hidden by the completed cover does not interrupt the skill')
})

test('a skeleton shooting at a bastion approach is handled by tactics, not owned by the skill (b2-5-1 14.10)', () => {
  const s: any = session('bastion')
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  s.bot.entities[3] = { id: 3, name: 'skeleton', position: new Vec3(10.5, 64, .5), height: 1.99, width: 0.6, isValid: true, metadata: [] }
  s.autopilot = { lastHurt: { at: clock.now(), type: 'arrow', byMob: true, sourceId: 3, dimension: 'the_nether' } }
  const state = observeTactics(s)
  assert.ok(state.enemies.some((e: any) => e.kind === 'skeleton'))
  assert.equal(state.protectedEncounter, false)
})

test('a bastion survey yields its hands to a level-2 incoming ghast shot', async () => {
  const { TacticalSystem }: typeof import('../src/tactics/minecraft') = require('../src/tactics/minecraft')
  const s = bastionUnderGhastShot()
  const state = { ...observeTactics(s), incomingProjectiles: 1, shield: true }
  s.bot.pathfinder = { setGoal: () => {}, setMovements: () => {}, stop: () => {} }
  s.bot.clearControlStates = () => {}
  let aborted = false
  s.current.ctl = { aborted: false, onAbort: [], abort() { this.aborted = true; aborted = true } }
  const chosen: string[] = []
  const tactics: any = s.tactics = new TacticalSystem(s, { observe: () => state, record: () => {} })
  tactics.execute = (action: any) => { chosen.push(action.id); return Promise.resolve({ blocked: true }) }
  try {
    tactics.attach(s.bot)
    tactics.update(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(tactics.snapshot().threatLevel, 2)
    assert.equal(aborted, true)
    assert.deepEqual(chosen, ['Shield'])
  } finally { tactics.detach() }
})
