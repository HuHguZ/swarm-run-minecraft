import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import threats = require('../src/threats')
import locks = require('../src/reflex-lock')

function scene(t, { foes = ['Enemy'] as string[] | null, boost = true, friend = false, enemy = false,
  behind = false, unknown = false, projectile = 'arrow', aim = null as string | null } = {}) {
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const keys: Record<string, boolean> = {}
  const bot: any = Object.assign(new EventEmitter(), { health: 20, food: 20, version: '1.21.11',
    registry: require('minecraft-data')('1.21.11'), ndClock: timer, game: { dimension: 'the_end' },
    entity: { id: 1, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), height: 1.8, width: .6,
      yaw: 0, pitch: 0, onGround: true, metadata: [] },
    entities: {}, inventory: { slots: [], items: () => [] }, _client: Object.assign(new EventEmitter(), { write() {} }),
    getControlState: k => !!keys[k], setControlState: (k, v) => { keys[k] = !!v },
    clearControlStates() { for (const k of Object.keys(keys)) bot.setControlState(k, false) },
    blockAt: p => {
      const cell = p.floored(), solid = cell.y < 64 || behind && cell.x === 8 && cell.y <= 67
      return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: cell,
        shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
    } })
  const player = (id, username, x) => Object.assign(new EventEmitter(), { id, type: 'player', name: 'player', username,
    position: new Vec3(x, 64, .5), height: 1.8, width: .6, yaw: Math.PI / 2, metadata: [], equipment: [] })
  const ally: any = bot.entities[2] = player(2, 'BoostAlly', behind ? 10.5 : 6.5)
  bot.entities[99] = player(99, 'Enemy', 6.5)
  if (aim) {
    ally.metadata[bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')] = 1
    ally.equipment[0] = { name: aim }
  }
  if (boost) bot._ndBoostFrom = new Set(['BoostAlly'])
  // Packet fixture supplies its parsed launch vector; the forecast/install are real.
  t.mock.method(require('../src/drops'), 'velocityFromRaw', () => ({ x: -3, y: 0, z: 0 }))
  const session: any = { bot, current: { name: 'boost_lance', ctl: { aborted: false } }, _ndFoes: foes }
  locks.install(session)
  t.after(() => { bot.emit('end'); timer.dispose(); clock.activate(null) })
  const forecast = () => threats.projectileDangers(bot, { foes })
  forecast() // installs the actual launch tracker before packets arrive
  const spawn = (id, owner) => {
    bot.entities[id] = { id, name: projectile, position: new Vec3(6.5, 65, .5), height: .25, width: .25 }
    bot._client.emit('packet', { entityId: id, type: bot.registry.entitiesByName[projectile].id,
      x: 6.5, y: 65, z: .5, objectData: owner }, { name: 'spawn_entity' }, Buffer.alloc(0))
  }
  if (friend) spawn(10, 2)
  if (enemy) spawn(11, 99)
  if (unknown) spawn(12, 123)
  timer.advanceTicks(1) // leave the physical-tick memo from before the spawn
  const incoming = forecast()
  assert.equal(locks.owner(session), null)
  if (behind && friend) {
    assert.equal(bot._ndThrown.get(10).owner, 0, 'the physical wall hides the shooter')
    assert.equal(bot._ndThrown.get(10).rawOwner, 2, 'the observed shot still identifies the expected peer')
  }
  const tick = () => bot.emit('physicTick')
  tick()
  return { bot, keys, session, forecast, incoming, tick, dodging: () => Object.values(keys).some(Boolean) }
}

test('a known enemy arrow is evaded without an expected boost', t => {
  const f = scene(t, { boost: false, enemy: true })
  assert.deepEqual(f.incoming.arrows.map(a => a.id), [11]); assert.ok(f.dodging())
})
for (const foes of [null, ['Enemy'], []]) {
  const scope = JSON.stringify(foes)
  for (const behind of [false, true]) test(`expected boost arrow stays on line: foes=${scope}, hiddenOwner=${behind}`, t => {
    const f = scene(t, { foes, friend: true, behind })
    assert.deepEqual(f.incoming.arrows, []); assert.equal(f.bot._ndProjectileEvasion.pressure, false); assert.equal(f.dodging(), false)
  })
  for (const friend of [false, true]) test(`other enemy arrow keeps scoped evasion: foes=${scope}, mixed=${friend}`, t => {
    const f = scene(t, { foes, friend, enemy: true }), dangerous = foes === null || foes.includes('Enemy')
    assert.deepEqual(f.incoming.arrows.map(a => a.id), dangerous ? [11] : [])
    assert.equal(f.bot._ndProjectileEvasion.pressure, dangerous); assert.equal(f.dodging(), dangerous)
  })
  test(`unknown shooter remains a threat during boost: foes=${scope}`, t => {
    const f = scene(t, { foes, unknown: true })
    assert.deepEqual(f.incoming.arrows.map(a => a.id), [12]); assert.ok(f.dodging())
  })
}
test('the expected spectral arrow is also exempt without a foe scope', t => {
  const f = scene(t, { foes: null, friend: true, projectile: 'spectral_arrow' })
  assert.deepEqual(f.incoming.arrows, []); assert.equal(f.dodging(), false)
})
test('the expected peer drawing a bow does not spoil its boost without a foe scope', t => {
  const f = scene(t, { foes: null, aim: 'bow' })
  assert.deepEqual(f.incoming.aims, []); assert.equal(f.bot._ndProjectileEvasion.pressure, false); assert.equal(f.dodging(), false)
})
for (const projectile of ['trident', 'wind_charge', 'splash_potion']) test(`an expected archer is not exempt for another projectile (${projectile})`, t => {
  const f = scene(t, { foes: null, friend: true, projectile })
  assert.ok(f.incoming.arrows.length || f.incoming.potions.length); assert.ok(f.dodging())
})
test('a peer charging a trident is not an expected bow boost', t => {
  const f = scene(t, { foes: null, aim: 'trident' })
  assert.equal(f.incoming.aims.length, 1); assert.ok(f.dodging())
})
test('same-tick boost set and unset invalidate the forecast and installed observation', t => {
  const f = scene(t, { foes: null, boost: false, friend: true, aim: 'bow' })
  assert.ok(f.incoming.arrows.length); assert.ok(f.incoming.aims.length); assert.ok(f.dodging())
  f.bot._ndBoostFrom = new Set(['BoostAlly'])
  assert.equal(f.bot._ndProjectileEvasion.pressure, false); f.tick(); assert.equal(f.dodging(), false)
  assert.deepEqual(f.forecast().arrows, []); assert.deepEqual(f.forecast().aims, [])
  f.bot._ndBoostFrom = null
  assert.equal(f.bot._ndProjectileEvasion.pressure, true); f.tick(); assert.ok(f.dodging())
  assert.ok(f.forecast().arrows.length); assert.ok(f.forecast().aims.length)
})
test('Emergency free callback retains movement ownership while an enemy arrow approaches', async t => {
  const f = scene(t, { enemy: true }); assert.ok(f.dodging())
  let finish
  const lease = locks.start(f.session, () => { f.bot.setControlState('back', true); return new Promise(resolve => { finish = resolve }) },
    { owner: 'Emergency', source: 'test', immediate: true, priority: 10 })
  assert.ok(locks.owner(f.session)); f.tick()
  assert.equal(f.keys.back, true); assert.equal(f.keys.forward, false); assert.equal(!!f.keys.left || !!f.keys.right, false)
  finish({}); await lease; assert.equal(locks.owner(f.session), null)
})
