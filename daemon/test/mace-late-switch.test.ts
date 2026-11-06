import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { createLastSeen } from '../src/pvp/last-seen'
import { track } from '../src/mace/track'
import { smashes } from '../src/threats'
import { deflectDecide, installWindOut } from '../src/combat/wind-out'
import * as enemyWind from '../src/combat/enemy-wind'
import { trackTarget } from '../src/bow/track'
import { installFallAndAim } from '../src/pvp/duel-events'

function scene(t) {
  const time = clock.activate(new clock.GameClock({ manual: true, epoch: 10000 }))
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8 }
  bot.health = 20
  let hidden = false
  bot.blockAt = p => {
    const solid = p.y < 64 || hidden && p.x === 1
    return { name: solid ? 'stone' : 'air', position: p.floored(), boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  const foe: any = Object.assign(new EventEmitter(), { id: 2, type: 'player', name: 'player', username: 'Foe',
    position: new Vec3(9.3, 76.6, .5), height: 1.8, width: .6, isValid: true, equipment: [{ name: 'wind_charge' }], metadata: [] })
  for (const key of ['inventory', 'velocity']) Object.defineProperty(foe, key, { get() { throw Error(`private ${key}`) } })
  Object.defineProperty(foe.metadata, bot.registry.entitiesByName.player.metadataKeys.indexOf('health'), { get() { throw Error('private HP') } })
  Object.defineProperty(foe.equipment[0], 'componentMap', { get() { throw Error('private item components') } })
  bot.entities = { 1: bot.entity, 2: foe }
  const sight = createLastSeen(bot), tracker = track(bot, { enemy: () => sight.observe(foe), telemetryHp: () => null })
  const poll = () => ({ body: smashes(bot, ['Foe']), duel: tracker.threat() })
  const step = (x, y, ticks = 1) => { time.advanceTicks(ticks); foe.position.set(x, y, .5); bot.emit('physicsTick'); return poll() }
  t.after(() => { tracker.close(); sight.close(); bot.emit('end'); time.dispose(); clock.activate(null) })
  return { bot, foe, sight, time, tracker, poll, step, hide: (value = true) => { hidden = value } }
}

test('a high directed descent is detected before the late wind-charge to mace switch', t => {
  const f = scene(t)
  f.bot.emit('physicsTick'); f.poll()
  const threat = f.step(8.5, 76)
  assert.deepEqual({ body: threat.body.length, duel: !!threat.duel }, { body: 1, duel: true }, 'anticipate the first unseen mace instead of waiting for its equip packet')
  assert.ok(threat.body[0].ticks >= 6, 'leave five native shield ticks and one delivery tick')
  assert.ok(threat.duel?.eta >= 6, 'the duel must anticipate the same directed descent')
  assert.equal(f.foe.equipment[0].name, 'wind_charge', 'no held mace was supplied to either detector')
  t.diagnostic(JSON.stringify({ bodyTicks: threat.body[0].ticks, duelTicks: threat.duel.eta, hand: f.foe.equipment[0].name }))
  let vx = -.8, vy = -.6
  while (f.foe.position.y > 67) {
    vx *= .91; vy = (vy - .08) * .98
    const falling = f.step(f.foe.position.x + vx, f.foe.position.y + vy)
    assert.equal(falling.body.length, 1, 'keep the shield response through the final approach while the mace is still hidden')
    assert.ok(falling.duel)
  }
})

for (const trial of [
  { name: 'CM E cross-over', defender: [604.9, 120, 600.5], source: [.105253704, -.104812792],
    positions: [[604.386282485, 128.507548664, 600.455266982], [604.507011889, 127.851701699, 600.455266982],
      [604.616875648, 127.130571659, 600.455266982]], projected: true },
  { name: 'CH frontal control', defender: [606.502488726, 120.495195299, 600.433940077], source: [-1.305764078, .12493887],
    positions: [[604.018320446, 128.883142639, 600.553796191], [604.266340411, 128.376941531, 600.552529291],
      [604.517483659, 127.802464434, 600.551195770]], projected: false },
  { name: 'CT front-to-side', defender: [604.9, 120, 600.5], source: [-.049956169, -.073279468],
    positions: [[604.647142692, 125.685814860, 600.459730100], [604.737632837, 124.851703090, 600.459730100],
      [604.819978868, 123.955873537, 600.459730100]], projected: false, duelCurrent: true },
  { name: 'CM E immediate contact', defender: [604.938330078, 120, 600.533447266], source: [.105253704, -.104812792],
    positions: [[604.890619988, 124.588409649, 600.455266982], [604.965959017, 123.618945381, 600.455266982],
      [605.034517534, 122.590470379, 600.455266982]], projected: false }
]) test(`the shield faces the earliest reachable mace source: ${trial.name}`, t => {
  const f = scene(t)
  f.bot.entity.position.set(trial.defender[0], trial.defender[1], trial.defender[2])
  f.bot.blockAt = p => {
    const solid = p.y < 120
    return { name: solid ? 'stone' : 'air', position: p.floored(), boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  f.foe.onGround = false
  let previous = null, threat
  if (trial.duelCurrent) f.foe._ndObservationNow = () => previous?.t ?? clock.observationNow()
  for (const [x, y, z] of trial.positions) {
    f.time.advanceTicks(1)
    const q = (a: number) => Math.round(a * 4096) / 4096
    f.foe.position.set(q(x), q(y), q(z))
    const receipt = { x: q(x), y: q(y), z: q(z), t: clock.observationNow(), kind: 'rel_entity_move', grounded: false }
    f.foe._ndPositionReceipts = [previous, receipt]
    previous = receipt
    f.bot.emit('physicsTick')
    threat = smashes(f.bot, ['Foe'], null, true)[0]
  }
  assert.ok(threat, 'a real fair threat still applies while wind is the held item')
  const aim = threat.shieldFrom ?? threat.from, me = f.bot.entity.position
  assert.ok((aim.x - me.x) * trial.source[0] + (aim.z - me.z) * trial.source[1] > 0,
    'the commanded shield direction must cover the actual native source')
  if (trial.projected) {
    assert.ok(Math.abs(aim.x - 605.034517534) < 1 / 4096, 'only the first reachable source is selected')
    const blockAt = f.bot.blockAt
    f.bot.blockAt = p => p.x === 605 && p.y === 126 && p.z === 600 ? null : blockAt(p)
    assert.equal(smashes(f.bot, ['Foe'], null, true)[0]?.shieldFrom, undefined, 'unknown air along the flight cannot turn the shield away')
    f.bot.blockAt = blockAt

  } else assert.deepEqual([aim.x, aim.z], [threat.from.x, threat.from.z],
    'leave current direction at immediate reach or when it already covers the strike')

  if (trial.projected || trial.duelCurrent) {
    const looks: Vec3[] = [], ctl = { aborted: false }
    const fight = { name: 'fight', ctl }
    const session = { bot: f.bot, current: fight, _ndFoes: ['Foe'],
      _rescue: { arena: { x: 600.5, y: 120, z: 600.5, r: 77 } } }
    const slots = []; slots[45] = { name: 'shield' }
    Object.assign(f.bot, { inventory: { slots, items: () => [] }, activateItem() {}, setControlState() {},
      lookAt: async p => { looks.push(p.clone()) } })
    Object.assign(f.bot.entity, { onGround: true, velocity: new Vec3(0, 0, 0) })
    installWindOut(session)
    f.bot.emit('physicsTick')
    assert.equal(looks.length, 1)
    assert.deepEqual([looks[0].x, looks[0].z], [aim.x, aim.z], 'body uses the visible contact bearing')

    f.bot._ndMaceDefense = { ctl, current: fight, target: 'Foe', until: f.time.now() + 1000 }
    f.bot.emit('physicsTick')
    assert.equal(looks.length, 1, 'body must not overwrite the active duel owner')
    const vision = createLastSeen(f.bot), entity = vision.observe(f.foe)
    t.after(() => vision.close())
    installFallAndAim({ bot: f.bot, session, vision, ctl, entity, prof: { player: true }, aim: 'target',
      track: trackTarget(entity), guard: { blocking: () => true }, ovl: {} } as any)
    f.time.advanceTicks(1)
    assert.equal(looks.length, 2)
    assert.deepEqual([looks[1].x, looks[1].z], [aim.x, aim.z],
      'the duel timer must not lead across the native strike bearing')
    if (trial.duelCurrent) {
      const blockAt = f.bot.blockAt
      f.bot.blockAt = p => p.x === 605 && p.y === 122 && p.z === 600 ? null : blockAt(p)
      f.time.advanceTicks(1)
      const legacy = trackTarget(entity).at(2)
      assert.deepEqual([looks[2].x, looks[2].z], [legacy.x, legacy.z], 'unknown contact geometry keeps the original fallback')
    }
  }
})

for (const knownMace of [false, true]) test(`a visible wind ascent reaches the raised N defender before the apex (${knownMace ? 'proven' : 'unseen'} mace)`, t => {
  const f = scene(t)
  // N late2: native-late-ground-2026-11-04T13-06-54-105Z.json.
  // Replay public positions as timely fair receipts, not the unrecorded BASE packet arrival times.
  // Native impact was at15288325; the late swap was atNPC tick323, with BASE standing at123.
  const frames = [
    [299, 120.7531999805212, 120.1212968405392, 352],
    [300, 121.96551022968191, 120, 404],
    [301, 123.0751742954565, 120.71954353459468, 455],
    [302, 124.08424509955489, 121.34629621069578, 508],
    [303, 124.99473450529193, 121.88211384370335, 559],
    [304, 125.80861413875456, 122.3288151327448, 608],
    [305, 126.52781619354558, 122.68818240299969, 662],
    [306, 127.15423421943258, 122.961962333178, 711],
    [307, 127.68972389522395, 123.15186666844879, 770],
    [308, 128.13610378618728, 123.25957291911043, 819],
    [309, 128.49515608631947, 123.28672504528728, 869],
    [310, 128.7686273457715, 123.23493412793262, 919],
    [311, 128.95822918372468, 123.10577902641133, 972],
    [312, 129.0656389870093, 123, 1021],
    [313, 129.09250059475102, 123, 1071]
  ] as const
  f.foe.position.set(600.5, frames[0][1], 602.5)
  f.bot.entity.position.set(599.3, frames[0][2], 602.688)
  f.bot.blockAt = p => {
    const solid = p.y < 120
    return { name: solid ? 'stone' : 'air', position: p.floored(), boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  if (knownMace) { f.foe.equipment = [{ name: 'mace' }]; f.bot.emit('physicsTick'); f.poll() }
  f.foe.equipment = [{ name: 'wind_charge' }]
  let first = null, firstProfileMs = null, tick: number = frames[0][0], atApex
  for (const [next, y, ownY, profileMs] of frames) {
    f.time.advanceTicks(next - tick); tick = next
    f.foe.position.y = y; f.bot.entity.position.y = ownY
    f.bot.emit('physicsTick'); atApex = f.poll()
    if (atApex.body.some(s => s.ticks <= 25)) { first ??= next; firstProfileMs ??= profileMs }
  }
  assert.ok(atApex.body.length, 'the observed high wind ascent remains threatening at its visible apex')
  const nativeHitMs = 1540
  assert.ok(firstProfileMs !== null && nativeHitMs - firstProfileMs >= 6 * 50,
    'timely public receipts leave five 50ms shield ticks and a delivery tick before the recorded impact')
  assert.equal(f.foe.equipment[0].name, 'wind_charge')
  t.diagnostic(JSON.stringify({ firstModelTick: first, firstProfileMs, idealWallLeadMs: nativeHitMs - firstProfileMs,
    apexTicksToHead: atApex.body[0].ticks, nativeImpactTick: 325, modelTicksDiagnosticOnly: true, timelyPublicReplay: true }))
})

test('an unknown wind ascent away or past us does not reserve late-switch defence', t => {
  const f = scene(t)
  f.foe.position.set(5, 68, .5); f.bot.emit('physicsTick'); f.poll()
  for (let i = 1; i <= 5; i++) {
    const threat = f.step(5 + 1.5 * i, 68 + i * .8)
    assert.deepEqual(threat.body, [], 'the native horizontal approach must reach us, even when wind and lift are visible')
    assert.equal(threat.duel, null)
  }
})

test('a fair fast wind rise prepares the real body shield before a retreating defender can be hit', async t => {
  // DQ A2 public attacker and defender positions, relative to the arena origin.
  const frames = [
    [.5,.41999999,.5,4.9,0,.5], [.5,.75319998,.5,4.9,0,.5],
    [.5,1.00133598,.5,4.9,0,.5], [.52548,1.16610926,.5,4.9,0,.5],
    [.57934974,2.08716699,.5,4.9,0,.5], [.65385121,2.91140358,.5,5.22739987,.41999999,.49965908],
    [.74712754,3.64075545,.5,5.40635495,.75325194,.49965908], [.857489,4.2771203,.5,5.40635495,.75325194,.49965908],
    [.98339793,4.82235786,.5,5.56895261,1.00129882,.49965908], [1.12345506,5.27829068,.5,5.56895261,1.00129882,.49965908],
    [1.27638705,5.64670485,.5,5.56895261,1.00129882,.49965908], [1.44103515,5.92935075,.5,5.74253659,1.16609374,.49941494],
    [1.61634493,6.12794372,.5,5.74253659,1.16609374,.49941494], [1.80135683,6.24416485,.5,6.11826902,1.25227538,.49941494],
    [1.99519766,6.27966154,.5,6.50108152,1.02449217,.49941494], [2.19707281,6.23604831,.5,6.50108152,1.02449217,.49941494],
    [2.4062592,6.11490734,.5,6.88267331,.4951953,.53652432], [2.62209802,5.91778918,.50020012,6.88267331,.4951953,.53652432]
  ]
  const q = (n: number) => Math.round(n * 4096) / 4096
  const ordinaryHop: number[][] = []
  let y = 0, vy = .42
  for (let i = 0; i < 12; i++) {
    y = Math.max(0, y + vy); vy = (vy - .08) * .98
    ordinaryHop.push([.5, y, .5, 2.5, 0, .5])
  }
  for (const [mode, cadence, phase, first] of [
    ['one tick',1,0,8], ['two ticks A',2,0,10], ['two ticks B',2,1,9], ['coalesced',3,0,9], ['coalesced without rise',3,2,null],
    ['occluded',1,0,null], ['support',1,0,null], ['absolute',1,0,null], ['gliding',1,0,null],
    ['ordinary hop',1,0,null], ['no wind',1,0,null], ['away',1,0,null],
    ['other observer',1,0,8], ['omitted landing',1,0,null]
  ] as const) await t.test(mode, child => {
    const f = scene(child), slots = []
    slots[45] = { name: 'shield' }
    let i = 0, previous, other, otherSight
    const raised: number[] = []
    Object.assign(f.bot, { inventory: { slots, items: () => [] }, setControlState() {}, deactivateItem() {},
      activateItem(off: boolean) { assert.equal(off, true); raised.push(i) }, lookAt: async () => {} })
    f.bot.blockAt = at => {
      const p = at.floored()
      const solid = p.y < 120 || i === 7 && (mode === 'occluded' && p.x === 603 ||
        mode === 'support' && p.x === 600 && p.y === 123 && p.z === 600) ||
        mode === 'omitted landing' && i > frames.length && p.x === 603 && p.y === 123 && p.z === 600
      return { name: solid ? 'stone' : 'air', position: p.floored(), boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0,0,0,1,1,1]] : [] }
    }
    const source = mode === 'ordinary hop' ? ordinaryHop : frames
    f.foe.onGround = false
    if (mode === 'no wind') f.foe.equipment[0].name = 'iron_sword'
    const session = { bot: f.bot, _ndFoes: ['Foe'], current: { name: 'flee', ctl: { aborted: false } },
      _rescue: { arena: { x: 600.5, y: 120, z: 600.5, r: 77 } } }
    installWindOut(session)
    const publish = (x: number, y: number, z: number, kind = 'entity_move_look') => {
      f.foe.position.set(q(x), q(y), q(z))
      const next = { kind, t: 10000 + (i + 1) * 50 }
      f.foe._ndPositionReceipts = [previous, next]; previous = next
      f.foe.emit('ndPositionObserved')
    }
    for (i = 0; i < source.length; i++) {
      const [x, y, z, bx, by, bz] = source[i]
      f.time.advanceTicks(1)
      f.bot.entity.position.set(600 + bx + (mode === 'away' ? 3 : 0), 120 + by, 600 + bz)
      f.foe.metadata[0] = mode === 'gliding' && i === 7 ? 0x80 : 0
      if (mode === 'omitted landing' && i === 8) session._ndFoes = ['Other']
      if (mode === 'other observer' && i === 6) {
        other = Object.assign(new EventEmitter(), { registry: f.bot.registry, blockAt: f.bot.blockAt, entities: f.bot.entities,
          entity: { ...f.bot.entity, position: f.bot.entity.position.clone() } })
        otherSight = createLastSeen(other)
        child.after(() => { otherSight.close(); other.emit('end') })
      }
      other?.entity.position.update(f.bot.entity.position)
      if (i === 0 || i % cadence === phase) {
        publish(600 + x, 120 + y, 600 + z, mode === 'absolute' && i === 7 ? 'sync_entity_position' : 'entity_move_look')
      }
      if (other) {
        other.emit('physicsTick')
        const view = otherSight.observe(f.foe)
        if (i === 8) {
          assert.notEqual(view, f.sight.observe(f.foe))
          assert.equal(view._ndMotionEpoch, f.sight.observe(f.foe)._ndMotionEpoch)
          assert.ok(view.velocity.y < .55)
          assert.deepEqual(smashes(other, ['Foe'], 'other observer'), [])
        }
      }
      f.bot.emit('physicsTick')
    }
    if (mode === 'omitted landing') {
      const epoch = f.sight.observe(f.foe)._ndMotionEpoch
      f.bot.entity.position.set(606, 120, 600.5)
      for (const [x, height, ground] of [
        [602.844,125.646,false], [603.071,125.302,false], [603.304,124.886,false], [603.541,124.399,false],
        [603.6,124,true], [603.6,124,true], [603.6,124.42,false], [603.6,124.7532,false], [603.6,125.001336,false]
      ] as const) {
        f.time.advanceTicks(1); i++
        f.foe.onGround = ground
        if (height > 124 && x === 603.6) f.foe.equipment[0].name = 'iron_sword'
        publish(x, height, 600.5)
        assert.equal(f.sight.observe(f.foe)._ndMotionEpoch, epoch, 'the entire landing was continuously visible')
        f.bot.emit('physicsTick')
      }
      session._ndFoes = ['Foe']
      assert.deepEqual(smashes(f.bot, session._ndFoes), [], 'a later ordinary hop does not inherit the skipped launch')
    }
    assert.deepEqual(raised, first === null ? [] : [first])
  })
})

test('a remembered wind ascent stops defending when the visible approach turns away or loses sight', t => {
  const f = scene(t)
  f.foe.position.set(2.5, 68, .5); f.bot.emit('physicsTick'); f.poll()
  assert.equal(f.step(2.5, 68.8).body.length, 1)
  assert.deepEqual(f.step(4, 69.5).body, [], 'an armed launch still needs a reachable projected contact')
  f.hide()
  assert.deepEqual(f.step(2.5, 69.5).body, [])
  f.hide(false)
  assert.deepEqual(f.step(2.5, 69.5).body, [], 'a new view cannot borrow the old launch evidence')
})

test('a visible directed self-launch can trigger a wind interception before the mace switch', t => {
  const f = scene(t)
  f.bot.username = 'Blue'; f.bot.entity.username = 'Blue'
  f.bot.players = { Foe: { entity: f.foe, gamemode: 0 } }
  f.bot.ndClock = { age: 500n, ticks: 0, serverTicks: 0 }
  f.foe.position.set(2.5, 68, .5); f.bot.emit('physicsTick'); f.poll()
  assert.equal(f.step(2.5, 68.8).body.length, 1)
  const calls: string[] = []
  t.mock.method(enemyWind, 'planEnemyWind', (_b, foe, _reports, options) => {
    calls.push(foe.username); assert.ok(options.protect?.length)
    return { baseline: { clear: 2, reach: 10 }, nominal: { clear: 4 }, worst: { clear: 4 }, shots: [{ fireDelay: 0 }] } as any
  })
  const own = { id: 'Blue', position: f.bot.entity.position, velocity: new Vec3(0, 0, 0), onGround: true, gameTick: 500 }
  const arena = { x: .5, z: .5, r: 80 }
  assert.equal(deflectDecide(f.bot, own, arena)?.kind, 'deflect')
  assert.equal(f.foe.equipment[0].name, 'wind_charge')
  f.hide()
  assert.equal(deflectDecide(f.bot, own, arena), null)
  assert.deepEqual(calls, ['Foe'])
})

for (const gap of [false, true]) test(`a visible wind launch cannot survive a raised landing${gap ? ' across a LOS gap' : ''}`, t => {
  const f = scene(t), floor = f.bot.blockAt
  f.bot.blockAt = p => p.floored().equals(new Vec3(2, 65, 0))
    ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : floor(p)
  f.foe.position.set(2.5, 68, .5); f.bot.emit('physicsTick'); f.poll()
  assert.equal(f.step(2.5, 68.8).body.length, 1)
  f.hide(gap); f.step(2.5, 66, 20); f.hide(false)
  for (let i = 0; i < 4; i++) f.step(2.5, 66)
  for (const y of [66.42, 66.75, 67.1, 67.25, 67, 66.7, 66.3, 66]) {
    const hop = f.step(2.5, y)
    assert.deepEqual(hop.body, [], 'a new ordinary hop cannot inherit the previous launch')
    assert.equal(hop.duel, null)
  }
})

test('a proven mace remains a threat after a long visible weapon switch', t => {
  const f = scene(t)
  f.foe.position.set(3.5, 64, .5); f.foe.equipment = [{ name: 'mace' }]
  f.bot.emit('physicsTick'); f.poll()
  f.foe.equipment = [{ name: 'wind_charge' }]
  f.step(8.3, 71.6, 100)
  const threat = f.step(7.5, 72)
  assert.deepEqual({ body: threat.body.length, duel: !!threat.duel }, { body: 1, duel: true }, 'remember visually proven gear while the hand holds the launch item')
  assert.ok(threat.duel, 'the duel must not forget the arsenal after four seconds')
})

test('ordinary jumps and high flights away do not trigger late-switch defense', t => {
  const f = scene(t)
  f.foe.position.set(3.5, 64, .5); f.foe.equipment = [{ name: 'mace' }]
  f.bot.emit('physicsTick'); f.poll()
  f.foe.equipment = [{ name: 'wind_charge' }]
  for (const [x, y] of [[3.5, 64.42], [3.5, 64.75], [3.5, 65.25], [3.5, 65], [3.5, 64]]) {
    const threat = f.step(x, y)
    assert.deepEqual(threat.body, [])
    assert.equal(threat.duel, null)
  }
  f.step(12.5, 77, 20)
  const away = f.step(13.3, 76.4)
  assert.deepEqual(away.body, [])
  assert.equal(away.duel, null)
})

test('remembered gear does not reveal movement behind a wall', t => {
  const f = scene(t)
  f.foe.position.set(2.5, 76.6, .5)
  f.foe.equipment = [{ name: 'mace' }]
  f.bot.emit('physicsTick'); f.poll()
  f.hide()
  f.foe.equipment = [{ name: 'wind_charge' }]
  const hidden = f.step(8.5, 76)
  assert.deepEqual(hidden.body, [])
  assert.equal(hidden.duel, null, 'the duel cannot defend using unseen live movement')
})

test('an unknown high descent moving away nearby is not an incoming mace', t => {
  const f = scene(t)
  f.foe.position.set(3.5, 76.6, .5)
  f.bot.emit('physicsTick'); f.poll()
  const away = f.step(4.3, 76)
  assert.deepEqual(away.body, [])
  assert.equal(away.duel, null, 'high descent alone does not replace the projected approach')
})

for (const gap of [false, true]) test(`a raised-platform hop cannot inherit a previous high descent${gap ? ' across lost sight' : ''}`, t => {
  const f = scene(t), floor = f.bot.blockAt
  f.bot.blockAt = p => p.floored().equals(new Vec3(2, 65, 0))
    ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : floor(p)
  f.bot.emit('physicsTick'); f.poll()
  assert.equal(f.step(8.5, 76).body.length, 1)
  f.hide(gap)
  f.step(2.5, 66, 20)
  f.hide(false)
  // Stand still on a raised support, then perform an ordinary native jump (apex 67.25, <3.5 above us).
  for (let i = 0; i < 4; i++) f.step(2.5, 66)
  let y = 66, vy = .42
  for (let tick = 0; tick < 11; tick++) {
    y += vy; vy = (vy - .08) * .98
    const hop = f.step(2.5, y)
    assert.deepEqual(hop.body, [], 'a landing, rise or lost sight ends the old uninterrupted descent')
    assert.equal(hop.duel, null)
  }
})

test('the owned flight evades the recorded late smash before the hidden mace switch', async t => {
  const f = scene(t), bot = f.bot
  // Native G: RedPw1y6tig -> NeuroFarm31q, mace_smash gameTick15099836.
  // Public positions from native-late-switch-2026-11-04T10-02-16-574Z.json;
  // attack/swap occurs at34, mace stays unseen throughout this replay.
  const frames = [
    [23, [601.5796491882209, 129.09020323489617, 600.5570257426699], [601.9902759898645, 121.00129881501198, 600.5833713105576]],
    [24, [601.6392532251016, 129.03798705088454, 600.5570257426699], [601.6611744273645, 121.24934569001198, 600.5562717011826]],
    [26, [601.6934928986631, 128.9084151880313, 600.5570257426699], [601.1660572398645, 121.92415037751198, 600.4959689668076]],
    [26, [601.742851001604, 128.7030347584379, 600.5570257426699], [601.1660572398645, 121.92415037751198, 600.4959689668076]],
    [27, [601.7877668752802, 128.42336193199316, 600.5570257426699], [601.1660572398645, 121.92415037751198, 600.4959689668076]],
    [28, [601.8286403203256, 128.07088255521708, 600.5570257426699], [601.1660572398645, 121.92415037751198, 600.4959689668076]],
    [29, [601.8658351553169, 127.64705275772765, 600.5570257426699], [600.7024341929895, 123.04207029938698, 600.4302951386826]],
    [31, [601.8996824551589, 127.15329954657821, 600.5570257426699], [600.7024341929895, 123.04207029938698, 600.4302951386826]]
  ] as const
  const route = new Vec3(620, 130, 620), goals: Vec3[] = [], turns: number[] = []
  Object.assign(bot, { health: 20, _ndFoes: ['Foe'], inventory: { slots: [], items: () => [] },
    look: async yaw => { turns.push(yaw) }, lookAt: async () => {} })
  Object.assign(bot.entity, { velocity: new Vec3(-.4, .5, 0), elytraFlying: true, onGround: false, yaw: 1.45, pitch: 0 })
  let hidden = false
  bot.blockAt = p => {
    const solid = p.y < 120 || hidden
    return { name: solid ? 'stone' : 'air', position: p.floored(), boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({ at: () => 0 }))
  t.mock.method(require('../src/elytra/rocket-forecast'), 'rocketForecast', () => ({ boost: 0 }))
  t.mock.method(require('../src/elytra/control'), 'choose', (_world, _state, goal) => {
    goals.push((typeof goal.at === 'function' ? goal.at(0) : goal.at).clone())
    return { c: 0, yaw: 1, pitch: .2, r: {} }
  })
  t.mock.method(require('../src/elytra/control'), 'returnInside', () => ({ c: 0, yaw: 2, pitch: .2, r: {}, goal: { kind: 'point', at: route } }))
  const file = require.resolve('../src/elytra/flight'), saved = require.cache[file]
  delete require.cache[file]
  t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved })
  const { fly } = require('../src/elytra/flight'), ctl: any = { aborted: false }
  const flying = fly(bot, ctl, { goal: { kind: 'point', at: route }, arena: { x: 600.5, y: 120, z: 600.5, r: 32 }, noRocket: () => true })
  const owner = ctl._ndFlightOwner
  let firstEvasion = null, tick = 23
  try {
    for (const [next, foe, self] of frames) {
      f.time.advanceTicks(next - tick); tick = next
      f.foe.position.set(...foe); bot.entity.position.set(...self)
      bot.emit('physicsTick'); await new Promise(setImmediate)
      const goal = goals.at(-1)
      if (!goal.equals(route)) {
        firstEvasion ??= next
        const threat = smashes(bot, ['Foe'])[0]
        assert.ok(threat, 'the real fair detector supplies the flight manoeuvre')
        const away = goal.minus(bot.entity.position)
        assert.ok(away.x * (bot.entity.position.x - threat.at.x) + away.z * (bot.entity.position.z - threat.at.z) > 0,
          'the near waypoint leaves the predicted strike point')
      }
    }
    assert.ok(firstEvasion !== null && 36 - firstEvasion >= 5, 'the recorded descent must reach the active pilot at least five native ticks before impact')
    assert.equal(f.foe.equipment[0].name, 'wind_charge')
    assert.equal(bot._ndElytra.flightOwner, owner, 'defence keeps the current flight lease')
    hidden = true; f.time.advanceTicks(1); bot.emit('physicsTick'); await new Promise(setImmediate)
    assert.ok(goals.at(-1).equals(route), 'a wall removes the live smash and resumes the same route')
    hidden = false; bot._ndFoes = []; f.time.advanceTicks(1); bot.emit('physicsTick'); await new Promise(setImmediate)
    assert.ok(goals.at(-1).equals(route), 'an explicit empty foe scope cannot retain the manoeuvre')
    const beforeReturn = goals.length
    bot.entity.position.x = 634; bot.emit('physicsTick'); await new Promise(setImmediate)
    assert.equal(goals.length, beforeReturn, 'outside the arena no evasion can bypass returnInside')
    assert.equal(turns.at(-1), 2)
  } finally { ctl.aborted = true; bot.emit('physicsTick'); await flying }
  assert.equal(bot._ndElytra.driving, 0)
})
