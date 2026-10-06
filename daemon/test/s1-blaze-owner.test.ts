import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const { observeTactics } = require('../src/tactics/minecraft')
const { Vec3 } = require('vec3')

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
  return { bot, current: current ? { name: current } : null, reflex: null, bus: { emit: () => {} }, tempo: null }
}

test('blaze skill owns the spawner fight: protectedEncounter while blaze runs, not during the fortress approach', () => {
  assert.equal(observeTactics(session('blaze')).protectedEncounter, true)
  assert.equal(observeTactics(session('fortress')).protectedEncounter, false)
  assert.equal(observeTactics(session(null)).protectedEncounter, false)
})

test('a protected blaze skill takes the hands back from a level-2 tactical episode started before it', async () => {
  const { TacticalSystem } = require('../src/tactics/minecraft')
  const lock = require('../src/reflex-lock')
  const s: any = session('fortress')
  const events: any[] = []
  s.bus = { emit: (type: string, detail: any) => events.push({ type, ...detail }) }
  s.bot.pathfinder = { setGoal: () => {}, setMovements: () => {}, stop: () => {} }
  s.bot.clearControlStates = () => {}
  const tactics = s.tactics = new TacticalSystem(s)
  let aborted = false
  tactics.execute = (_action: unknown, ctl: { onAbort: Array<() => void> }) =>
    new Promise(resolve => ctl.onAbort.push(() => { aborted = true; resolve({ cancelled: true }) }))
  try {
    tactics.attach(s.bot)
    tactics.begin({ id: 'Fight', score: 151, reason: 'blaze in reach' }, [], observeTactics(s), 2)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(lock.owner(s)?.source, 'Fight')
    s.current = { name: 'blaze' }
    tactics.update(true)
    await tactics.waitForRelease()
    assert.equal(aborted, true, 'the stale Fight lease is cancelled once blaze owns the encounter')
    assert.equal(tactics.snapshot().action, null)
  } finally { tactics.detach() }
})

test('entering a portal is a protected escape: tactics below level 3 does not interrupt it (s1-LG-10)', () => {
  assert.equal(observeTactics(session('portal')).protectedEncounter, true)
})
