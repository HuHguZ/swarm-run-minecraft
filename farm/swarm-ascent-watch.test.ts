// Сторожа арены не отменяют успешный подъём и один раз снимают зависший под стрелами.
import test from 'node:test'
import assert from 'node:assert/strict'
import { installSight, watchAlarm, watchStatus } from './arena/watch'
import { SOLO } from './arena/context'
import { runAscent } from './swarm/swarm-driver/ascent'
import { swarmWind } from './swarm/swarm-driver/wind'
import { aerialMethods } from '../daemon/src/rpc/aerial'
import { Session } from '../daemon/src/session'
import { EventBus } from '../daemon/src/events'

function fixture(t, realSight = false) {
  let now = 1000, finish: () => void
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setInterval', fn => fn as any)
  const calls: any[] = [], frame: any = { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: { stone: 64 }, frame: 20, frameAt: now, observedAt: now }
  const foe = { id: 'Foe', seenAt: now, position: { x: 0, y: 68, z: 0 }, equipment: { weapon: 'bow' } }
  const b: any = { name: 'A', team: 'blue', arrowThreat: { active: true, at: now }, last: {
    m: 'goto', at: now, p: { x: 0, y: 68, z: 0, climb: true, _climb: true }, pending: true
  }, c: { async call(method, params) {
    calls.push({ method, params })
    if (frame.transport) return frame.transport(method, params)
    if (method === 'status') return { status: 'done', state: { pos: frame.p, health: frame.hp,
      inventory: frame.inv, physicsTicks: frame.frame, clock: { ticks: frame.frame } }, detail: { sightings: [],
        ...(params.physics ? { physics: frame.physics } : {}), ...(frame.precise ? { at: frame.precise } : {}) } }
    return frame.reply || { status: 'done', detail: {} }
  } } }
  const ctx: any = { i: 31, bots: [b], names: ['A'], pos: { A: frame }, busy: new Set(), out: new Set(), deadNow: new Set(),
    labNeed: {}, deathAt: {}, rel: {}, humans: {}, round: 1, between: false, teams: false, arms: false,
    X: 0, Y: 64, Z: 0, R: 50, STOPF: 'q10b-ascent-test-no-stop-file', teamOf: id => id === 'A' ? 'blue' : 'red',
    alive: () => true, log() {}, rcon: async () => {}, home: () => '0 0', hostile: () => true, readDeaths() {} }
  installSight(ctx)
  if (!realSight) ctx.swarmDriver.enemies = () => [foe]
  ctx.swarmDriver.panic = () => true
  if (!realSight) ctx.swarmDriver.observe = () => {}
  ctx.swarmDriver.release = () => { calls.push({ method: 'release' }) }
  const gate = new Promise<void>(resolve => { finish = resolve })
  const climbing = runAscent(b, frame, foe.position, () => gate, () => now)
  return { b, frame, ctx, calls, foe, close: async () => { finish(); await climbing },
    advance: (ms, y = frame.p.y) => { now += ms; frame.p = { ...frame.p, y }; frame.frame += ms / 50;
      frame.frameAt = frame.observedAt = now; b.arrowThreat.at = now; foe.seenAt = now } }
}

test('тревога и обычные реакции прицела уступают подъёму; аварийный уворот проходит', async t => {
  const f = fixture(t)
  try {
    const alarm = watchAlarm(f.ctx) as unknown as () => void
    alarm()
    assert.deepEqual(f.calls, [], 'другой этаж не отменяет уже начатый подъём тревогой')
    for (const [method, params] of [['juke', {}], ['take_cover', {}], ['swarm_hold', { whileDraw: 'Foe' }]] as any) {
      assert.equal((await f.b.c.call(method, params)).status, 'skipped')
    }
    assert.deepEqual(f.calls, [])
    for (const method of ['evade', 'lava_escape', 'dodge_blast']) await f.b.c.call(method, {})
    await f.b.c.call('swarm_hold', { whileSmash: 'Mace' })
    assert.deepEqual(f.calls.map(c => c.method), ['evade', 'lava_escape', 'dodge_blast', 'swarm_hold'])
  } finally { await f.close() }
})

test('человек на +4 не выключает legacy climbguard; подбор под луком можно отменить', async t => {
  const f = fixture(t)
  await f.close()
  f.b.climbing = true
  assert.equal((await f.b.c.call('fight', {})).status, 'skipped')
  f.foe.position.y = 64
  assert.equal((await f.b.c.call('fight', {})).status, 'done', 'ворвавшийся на тот же этаж человек снимает старую защиту')
  f.foe.position.y = 68; f.b.grabbing = true
  assert.equal((await f.b.c.call('swarm_hold', { whileDraw: 'Foe' })).status, 'done', 'щит может отменить начатый подбор')
})

for (const [cue, expected] of [['rush', true], ['across', false], ['miss', false], ['retreat', false], ['still', false], ['upper', false], ['nametag', false], ['glow', false], ['expired', false]] as const)
  test(`an armored arena opponent approaching the unarmed builder: ${cue}`, async t => {
    const f = fixture(t, true)
    await f.close()
    f.frame.inv = {}
    f.ctx.names.push('Armored')
    f.b.last = { m: 'goto', pending: true, p: { x: -16, y: 64, z: 0, _hunt: true } }
    const indirect = cue === 'nametag' || cue === 'glow'
    f.ctx.swarmDriver.observe(f.b, [{ id: 'Armored', visible: !indirect, nametag: cue === 'nametag', glowing: cue === 'glow',
      position: { x: 11, y: cue === 'upper' ? 68 : 64, z: 0 }, equipment: { weapon: 'netherite_sword', armor: ['diamond_chestplate'] },
      velocity: { x: cue === 'retreat' ? .28 : cue === 'across' || cue === 'still' ? 0 : -.28, y: 0, z: cue === 'across' ? .28 : cue === 'miss' ? .23 : 0 } }], Date.now())
    if (cue === 'expired') f.advance(2000)
    const alarm = watchAlarm(f.ctx) as unknown as () => void
    alarm(); alarm()
    assert.equal(f.calls.filter(c => c.method === 'stop').length, Number(expected))
    if (expected) {
      await f.ctx.swarmDriver.turn(f.b)
      assert.equal(f.b.swarmTask?.kind, 'flee', JSON.stringify(f.b.swarmTask))
      assert.ok(f.calls.some(c => c.method === 'flee' || c.method === 'goto' && c.params.x < f.frame.p.x), JSON.stringify(f.calls))
      assert.ok(!f.calls.some(c => c.method === 'fight'))
    }
  })

test('fresh hostile bot at the ladder can release a melee response, a nametag cannot', async t => {
  const f = fixture(t, true)
  await f.close()
  f.ctx.names.push('Armored')
  f.b.climbing = true
  const sight = (visible: boolean) => f.ctx.swarmDriver.observe(f.b, [{ id: 'Armored', visible,
    nametag: !visible, position: { x: 2, y: 64, z: 0 }, equipment: { weapon: 'netherite_sword' } }], Date.now())
  sight(false)
  assert.equal((await f.b.c.call('fight', { target: 'Armored' })).status, 'skipped')
  f.advance(50); sight(true)
  assert.equal((await f.b.c.call('flee', { from: ['Armored'] })).status, 'done')
})

test('twenty status and wind-report pairs during an ambush need no team-board scan', async t => {
  const f = fixture(t)
  await f.close()
  let reads = 0
  f.ctx.swarmDriver.enemies = () => { reads++; return [] }
  f.b.last = { m: 'pearl_ambush', pending: true }
  for (let i = 0; i < 20; i++) for (const method of ['status', 'wind_report']) await f.b.c.call(method, {})
  assert.equal(f.calls.length, 40)
  assert.equal(reads, 0)
  assert.equal((await f.b.c.call('craft', {})).status, 'skipped')
  assert.equal(reads, 1)
})

test('зависший под стрелами подъём получает один stop, а старый кадр и новая авария не получают', async t => {
  const f = fixture(t)
  try {
    const timers = watchStatus(f.ctx) as any
    f.advance(2000)
    timers.frozenT(); timers.frozenT()
    assert.deepEqual(f.calls.map(c => c.method), ['stop'])
    assert.equal(f.calls[0].params._climb, true)
    assert.equal(f.b.swarmAscent.stopping, true)
    f.calls.length = 0; f.b.swarmAscent.stopping = false
    f.b.last = { m: 'evade', pending: true, p: {} }
    timers.frozenT()
    assert.deepEqual(f.calls, [], 'отложенный сторож не отменяет новый аварийный уворот')
    f.b.last = { m: 'goto', pending: true, p: { _climb: true } }
    f.frame.tactics = { owner: 'Emergency', action: 'ClimbOut' }
    timers.frozenT()
    assert.deepEqual(f.calls, [], 'старый goto в журнале не даёт отменять аварийного владельца тела')
    delete f.frame.tactics
    f.frame.frameAt -= 6000
    timers.frozenT()
    assert.deepEqual(f.calls, [], 'запаздывание физики не доказательство стояния')
  } finally { await f.close() }
})

test('паника не обрывает подъём, который продолжает подниматься после попадания', async t => {
  const f = fixture(t)
  try {
    const timers = watchStatus(f.ctx) as any
    f.advance(700, 65); f.frame.hp = 17
    timers.poll()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.calls.map(c => c.method), ['status'])
  } finally { await f.close() }
})

test('team planning keeps the precise self position for support reservations, with old-daemon fallback', async t => {
  const f = fixture(t)
  await f.close()
  const timers = watchStatus(f.ctx) as any
  f.frame.precise = { x: .75, y: 64, z: .75 }
  timers.poll()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.ctx.pos.A.p, f.frame.precise, 'floored F3 cell cannot describe the body footprint')
  assert.ok(f.ctx.pos.A.p.x + .3 > 1, 'the real body overlaps the neighbouring support block')
  delete f.frame.precise
  f.frame.p = { x: 2, y: 64, z: 2 }
  timers.poll()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.ctx.pos.A.p, f.frame.p)
})

test('frozen watcher lets a stationary goto finish successive slow digs but bounds a stuck target', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.swarmDriver.panic = () => false
  f.ctx.enemiesOf = () => []
  f.b.last.p.timeoutSeconds = 12
  f.frame.p.y = 136
  f.frame.physics = { pathfinder: { mining: true }, targetDig: { x: 643, y: 138, z: 561 } }
  const timers = watchStatus(f.ctx) as any
  const sample = async (ms, target = f.frame.physics.targetDig) => {
    f.advance(ms)
    f.frame.physics.targetDig = target
    timers.poll()
    await new Promise(resolve => setImmediate(resolve))
    timers.frozenT()
    await new Promise(resolve => setImmediate(resolve))
  }
  await sample(0)
  await sample(4000, { x: 643, y: 137, z: 561 })
  await sample(4500, { x: 643, y: 137, z: 560 })
  for (let n = 0; n < 5; n++) await sample(2000)
  assert.deepEqual(f.calls.filter(c => c.method !== 'status'), [],
    '18.5 s at one position includes distinct completed digs and a 10 s sandstone dig')
  assert.equal(f.b.frozen, undefined, 'real block work must not blacklist the upper route or request a descent')
  await sample(4000)
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 1,
    'the same target with mining=true cannot renew the existing 14 s budget forever')
})

test('revisiting dig targets and old-daemon status cannot renew the goto freeze budget', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.swarmDriver.panic = () => false
  f.ctx.enemiesOf = () => []
  f.b.last.p.timeoutSeconds = 12
  const first = { x: 1, y: 65, z: 0 }, second = { x: 1, y: 64, z: 0 }
  f.frame.physics = { pathfinder: { mining: true }, targetDig: first }
  const timers = watchStatus(f.ctx) as any
  for (let n = 0; n <= 8; n++) {
    f.advance(n ? 2000 : 0)
    f.frame.physics.targetDig = n % 2 ? second : first
    timers.poll()
    await new Promise(resolve => setImmediate(resolve))
    timers.frozenT()
  }
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 1, 'cycling the same cells is not new progress')
  f.b.last = { m: 'goto', at: Date.now(), pending: true, p: { timeoutSeconds: 12 } }
  f.b.anchor = null
  delete f.frame.physics
  for (let n = 0; n <= 7; n++) {
    f.advance(n ? 2000 : 0)
    timers.poll()
    await new Promise(resolve => setImmediate(resolve))
    timers.frozenT()
  }
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 2, 'missing physics preserves the existing freeze recovery')
})

test('a stalled route to upper loot replans on its tier and keeps the upper goal for recovery', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.Y = 120
  f.ctx.enemiesOf = () => []
  f.frame.p = { x: 624, y: 142, z: 550 }
  const upper = { x: 630, y: 150, z: 550 }
  f.b.swarmTask = { kind: 'loot' }
  f.b.last = { m: 'goto', at: Date.now(), status: 'timeout', pending: false, p: { ...upper, climb: true, timeoutSeconds: 23 } }
  const { frozenT } = watchStatus(f.ctx) as any
  frozenT()
  f.advance(40000)
  frozenT()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls.map(c => c.method), ['stop'], 'a failed ascent requests a new route, without sending the bot down to Y=120')
  f.advance(8000)
  frozenT()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls.filter(c => c.method === 'dig_to').map(c => c.params.at), [upper])
  assert.equal(f.b.swarmReserved, undefined)
})

for (const change of ['new turn', 'cancelled turn', 'same turn'] as const) test('31k loot watchdog follows the owner of a returned goto: ' + change, async t => {
  const f = fixture(t); await f.close()
  f.ctx.enemiesOf = () => []; f.ctx.Y = 120
  f.frame.p = { x: 600, y: 120, z: 600 }
  const { frozenT } = watchStatus(f.ctx) as any
  const target = { x: 600, y: 128, z: 600 }
  const owner = f.b.swarmTurnOwner = { cancelled: false }
  f.b.swarmTask = { kind: 'goto' }
  f.frame.reply = { status: 'timeout', afterSeconds: 4, state: { busy: null } }
  await f.b.c.call('goto', { ...target, timeoutSeconds: 4 })
  frozenT()
  if (change === 'cancelled turn') owner.cancelled = true
  if (change === 'new turn') { f.b.swarmTurnOwner = { cancelled: false }; f.b.swarmTask = { kind: 'loot' } }
  for (const dt of [27000, 6000]) {
    f.advance(dt); frozenT(); await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 0, 'the native timeout already cleared the movement owner')
  assert.deepEqual(f.calls.filter(c => c.method === 'dig_to').map(c => c.params.at), change === 'same turn' ? [target] : [])
  assert.equal(f.b.badSpots?.length || 0, change === 'same turn' ? 1 : 0)
})

test('a stationary pending goto is stopped and cannot start its old recovery when a new swarm turn takes over during stop', async t => {
  const f = fixture(t); await f.close()
  f.ctx.enemiesOf = () => []
  let endWalk, endStop, stops = 0
  f.frame.transport = method => {
    if (method === 'goto') return new Promise(resolve => { endWalk = resolve })
    if (method === 'stop' && ++stops === 2) return new Promise(resolve => { endStop = resolve })
    return { status: 'done' }
  }
  f.b.swarmTurnOwner = { cancelled: false }
  const walk = f.b.c.call('goto', { x: 8, y: 64, z: 0, timeoutSeconds: 4 })
  const { frozenT } = watchStatus(f.ctx) as any
  frozenT(); f.advance(10000); frozenT(); f.advance(6000); frozenT()
  assert.equal(stops, 2, 'the native goto is actually pending and fails to respond to the first stop')
  f.b.swarmTurnOwner = { cancelled: false }
  f.b.swarmTask = { kind: 'loot' }
  endWalk({ status: 'timeout', state: { busy: null } }); await walk
  endStop({ status: 'done' }); await new Promise(resolve => setImmediate(resolve))
  assert.ok(!f.calls.some(c => c.method === 'dig_to'), 'a new owner can plan before it sends its first exclusive RPC')
})

for (const change of ['round', 'respawn', 'cancelled approach'] as const) test(`an old 31 goto never becomes a new loot recovery after ${change}`, async t => {
  const f = fixture(t); await f.close()
  f.ctx.enemiesOf = () => []; f.ctx.deathAt = {}
  f.b.swarmTask = { kind: 'loot' }
  const previous = { x: 52, y: 64, z: 0, timeoutSeconds: 4 }
  f.frame.transport = method => ({ status: method === 'goto' && change === 'cancelled approach' ? 'interrupted' : 'timeout' })
  await f.b.c.call('goto', previous)
  const { frozenT } = watchStatus(f.ctx) as any
  frozenT()
  f.advance(35000)
  if (change === 'round') { f.ctx.round++; f.ctx.roundT0 = Date.now() }
  if (change === 'respawn') f.ctx.deathAt[f.b.name] = { at: Date.now() }
  for (const dt of [10000, 10000]) { f.advance(dt); frozenT(); await new Promise(resolve => setImmediate(resolve)) }
  assert.deepEqual(f.calls.map(c => c.method), ['goto'], 'an expired route causes neither an unsolicited stop nor digging towards its old target')
  assert.equal(f.b.badSpots?.length || 0, 0)
  const current = { x: 8, y: 64, z: 0, timeoutSeconds: 4 }
  f.frame.transport = () => ({ status: 'timeout' })
  await f.b.c.call('goto', current); frozenT()
  f.advance(8000); frozenT(); f.advance(8000); frozenT(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.b.badSpots?.[0]?.x, current.x)
  assert.deepEqual(f.calls.filter(c => c.method === 'dig_to').map(c => c.params.at), [{ x: current.x, y: current.y, z: current.z }])
})

for (const change of ['new action', 'respawn'] as const) test(`delayed watchdog recovery abandons the old dig after ${change}`, async t => {
  const f = fixture(t); await f.close()
  f.ctx.enemiesOf = () => []; f.ctx.deathAt = {}
  let release, stops = 0
  f.frame.transport = method => method === 'stop' && ++stops === 2 ? new Promise(resolve => { release = resolve }) : { status: 'timeout' }
  await f.b.c.call('goto', { x: 52, y: 64, z: 0, timeoutSeconds: 4 })
  const { frozenT } = watchStatus(f.ctx) as any
  frozenT(); f.advance(10000); frozenT(); f.advance(10000); frozenT()
  assert.equal(stops, 2)
  f.advance(100)
  if (change === 'respawn') f.ctx.deathAt[f.b.name] = { at: Date.now() }
  else await f.b.c.call('flee', { from: ['Opponent'] })
  release({ status: 'done' }); await new Promise(resolve => setImmediate(resolve))
  assert.ok(!f.calls.some(c => c.method === 'dig_to'))
})

test('a stalled gallery descent asks for field contact and releases its reservation away from centre', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.enemiesOf = () => []
  const y = f.ctx.Y
  f.frame.p = { x: 35.5, y: y + 8, z: .5 }
  f.b.last = { m: 'goto', at: Date.now(), status: 'timeout', pending: false, p: { x: 35, y, z: 0, timeoutSeconds: 4 } }
  let finish
  f.frame.transport = method => method === 'goto' ? new Promise(resolve => { finish = resolve }) : { status: 'done' }
  const { frozenT } = watchStatus(f.ctx) as any
  frozenT(); f.advance(18000); frozenT()
  await new Promise(resolve => setImmediate(resolve))
  const request = f.calls.find(c => c.method === 'goto')
  assert.equal(request?.params.arenaFloor, true)
  assert.equal(request.params.arena.y, y)
  assert.ok(f.b.swarmReserved)
  f.advance(1000, y)
  finish({ status: 'done', detail: { arrived: f.frame.p, target: { mode: 'arenaFloor' } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.b.last.reached, true)
  assert.equal(f.b.swarmReserved, undefined)
  f.advance(14000); frozenT()
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 1)
})

test('solo gallery recovery uses a fresh enemy sighting for a player above the field', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.enemiesOf = () => []
  const trial = async (seen, registryY) => {
    f.ctx.humans.Foe = { p: { x: 4, y: registryY, z: 0 } }
    f.frame.p = { x: 20, y: f.ctx.Y + 8, z: 0 }
    f.b.last = { m: 'goto', at: Date.now(), status: 'timeout', pending: false, p: { x: 20, y: f.ctx.Y, z: 0, timeoutSeconds: 4 } }
    f.b.anchor = null; delete f.b.frozen; f.calls.length = 0
    f.ctx.swarmDriver.enemies = () => seen ? [{ id: 'Foe', seenAt: Date.now() - seen.age, position: { x: 4, y: f.ctx.Y + 8, z: 0 }, nametag: seen.tag }] : []
    const { frozenT } = watchStatus(f.ctx) as any
    frozenT(); f.advance(18000); frozenT(); await new Promise(resolve => setImmediate(resolve))
    return f.calls.some(c => c.params?.arenaFloor)
  }
  assert.equal(await trial(null, 96), true)
  assert.equal(await trial({ age: 2000 }, 96), true)
  assert.equal(await trial({ age: 10, tag: true }, 96), true)
  assert.equal(await trial({ age: 10 }, 64), !SOLO)
})

test('the freeze watcher leaves completed routes in range usable and still stops a failed approach', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.enemiesOf = () => []
  f.ctx.Y = 120
  const { frozenT } = watchStatus(f.ctx) as any
  // Match 5 logged three zero-distance resets for fighter u; the coordinates are synthetic.
  for (const x of [624, 604, 588]) {
    f.frame.p = { x: x + 0.5, y: 120, z: 601.5 }
    f.b.last = { m: 'goto', at: Date.now(), p: { x, y: 120, z: 601, range: 0, timeoutSeconds: 4 }, status: 'done', pending: false }
    frozenT()
    f.advance(14000)
    frozenT()
  }
  assert.deepEqual(f.calls, [], 'three reached targets need no emergency movement')
  assert.equal(f.b.badSpots?.length || 0, 0, 'each reached approach remains eligible for future routes')
  f.b.last = { m: 'goto', at: Date.now(), p: { x: 592, y: 120, z: 601, range: 2, timeoutSeconds: 4 }, status: 'failed', pending: false }
  frozenT()
  f.advance(14000)
  frozenT()
  assert.deepEqual(f.calls.map(c => c.method), ['stop'])
  assert.equal(f.b.badSpots.length, 1)
})

test('a returned goto still needs recovery outside its radius or below its exact-height goal', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.enemiesOf = () => []
  f.ctx.Y = 120
  const { frozenT } = watchStatus(f.ctx) as any
  for (const [x, goal, exactY] of [[620.5, 621, false], [610.5, 614, false], [605.5, 605, true]] as const) {
    f.frame.p = { x, y: exactY ? 119.5 : 120, z: 601.5 }
    f.b.last = { m: 'goto', at: Date.now(), p: { x: goal, y: 120, z: 601, range: 2, timeoutSeconds: 4, exactY }, status: 'done', pending: false }
    frozenT()
    f.advance(14000)
    frozenT()
  }
  assert.deepEqual(f.calls.map(c => c.method), ['stop', 'stop'])
})

test('after a builder returns to loot, the watchdog never treats its completed work cell as a route', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.Y = 120
  f.ctx.enemiesOf = () => []
  f.frame.p = { x: 559.5, y: 120, z: 593.5 }
  const { frozenT } = watchStatus(f.ctx) as any
  for (const [method, params, detail] of [
    ['swarm_work', { kind: 'place', at: { x: 562, y: 120, z: 595 }, item: 'sandstone', timeoutSeconds: 3 }, { ok: true, done: true, why: 'placed' }],
    ['swarm_hold', { timeoutSeconds: 1 }, { ok: true, heldSeconds: 1 }]
  ] as const) {
    f.frame.reply = { status: 'done', detail }
    await f.b.c.call(method, params)
    f.b.swarmTask = { kind: 'loot' }
    frozenT(); f.advance(20000); frozenT(); f.advance(6000); frozenT()
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.deepEqual(f.calls.map(c => c.method), ['swarm_work', 'swarm_hold'])
  assert.deepEqual(f.b.badSpots, [])
})

test('a hung work command on a gallery can be cancelled without digging its work cell or descending', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.enemiesOf = () => []
  f.ctx.Y = 120
  f.frame.p = { x: 559.5, y: 128, z: 593.5 }
  f.b.last = { m: 'swarm_work', at: Date.now(), pending: true, p: { kind: 'place', at: { x: 562, y: 128, z: 595 }, timeoutSeconds: 3 } }
  const { frozenT } = watchStatus(f.ctx) as any
  for (let i = 0; i < 3; i++) { f.advance(14000); frozenT(); await new Promise(resolve => setImmediate(resolve)) }
  assert.ok(f.calls.some(c => c.method === 'stop'))
  assert.ok(f.calls.every(c => c.method === 'stop'), JSON.stringify(f.calls))
  assert.deepEqual(f.b.badSpots, [])
})

for (const [label, params, elapsed, deadline] of [
  ['one-second hold', { timeoutSeconds: 1 }, 4000, 5000],
  ['camp inspection and repair', { camp: true, timeoutSeconds: 1 }, 9000, 12000],
  ['shield against a smash', { whileSmash: 'Mace', shield: true, seconds: 20 }, 16000, 21000]
] as const) test(`an awaiting ${label} can finish within the body deadline but a genuinely hung one is stopped`, async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.enemiesOf = () => []; f.ctx.Y = 120
  f.frame.p = { x: 559.5, y: 128, z: 593.5 }
  f.b.swarmTask = { kind: 'loot' }
  let finish
  f.frame.transport = method => method === 'swarm_hold' ? new Promise(resolve => { finish = resolve }) : { status: 'done' }
  const { frozenT } = watchStatus(f.ctx) as any
  frozenT(); f.advance(6000)
  const live = f.b.c.call('swarm_hold', params)
  f.advance(elapsed); frozenT()
  assert.deepEqual(f.calls.map(c => c.method), ['swarm_hold'])
  finish({ status: 'done' }); await live
  f.advance(7000); frozenT()
  const hung = f.b.c.call('swarm_hold', params)
  frozenT(); f.advance(deadline + 2000); frozenT()
  assert.deepEqual(f.calls.map(c => c.method), ['swarm_hold', 'swarm_hold', 'stop'])
  assert.deepEqual(f.b.badSpots, [])
  finish({ status: 'timeout' }); await hung
})

for (const ok of [true, false]) test(`a completed lava escape (ok=${ok}) leaves no route for the freeze watchdog to recover`, async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.enemiesOf = () => []; f.ctx.Y = 120
  f.frame.p = { x: 566.5, y: 122, z: 635.5 }
  f.frame.reply = { status: 'done', detail: { ok, why: ok ? 'вышел' : 'не вышел' } }
  await f.b.c.call('lava_escape', { limitMs: 2500 })
  f.b.swarmTask = { kind: 'loot' }
  const { frozenT } = watchStatus(f.ctx) as any
  frozenT(); f.advance(16000); frozenT(); f.advance(9000); frozenT()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls.map(c => c.method), ['lava_escape'])
  assert.equal(f.b.frozen, undefined)
})

for (const owner of ['swarm_hold', 'flee']) test(`a delayed hold receipt respects the body's clock and current owner ${owner}`, async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.enemiesOf = () => []; f.ctx.swarmDriver.panic = () => false
  f.b.swarmTask = { kind: 'loot' }
  let finish, ticks = 100, busy = 'swarm_hold'
  f.frame.transport = method => {
    if (method === 'swarm_hold') return new Promise(resolve => { finish = resolve })
    if (method === 'status') return { status: 'done', state: { pos: f.frame.p, health: 20, busy,
      physicsTicks: ticks, clock: { id: 7, ticks } }, detail: { sightings: [] } }
    return { status: 'done' }
  }
  const { poll, frozenT } = watchStatus(f.ctx) as any
  const hold = f.b.c.call('swarm_hold', { timeoutSeconds: 1 })
  const sample = async (controllerMs, bodyTicks) => {
    f.advance(controllerMs); ticks += bodyTicks; poll()
    await new Promise(resolve => setImmediate(resolve))
    frozenT()
  }
  await sample(0, 0); await sample(9000, 40)
  assert.ok(!f.calls.some(c => c.method === 'stop'), 'the body has processed just two seconds')
  busy = owner; await sample(7000, 140)
  assert.equal(f.calls.filter(c => c.method === 'stop').length, owner === 'swarm_hold' ? 1 : 0)
  finish({ status: 'timeout' }); await hold
})

for (const kind of ['loot', 'fight', 'goto']) test(`a bot that finished escaping and switched to ${kind} does not dig back toward the centre`, async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.Y = 120; f.ctx.enemiesOf = () => []
  f.frame.p = { x: 559.5, y: 124, z: 593.5 }
  const { frozenT } = watchStatus(f.ctx) as any
  f.frame.reply = { status: 'done', detail: { mode: 'бежал до конца срока', at: f.frame.p } }
  await f.b.c.call('flee', { from: ['Foe'], timeoutSeconds: 3 })
  f.b.swarmTask = { kind }
  frozenT()
  for (let i = 0; i < 3; i++) { f.advance(13000); frozenT(); await new Promise(resolve => setImmediate(resolve)) }
  assert.deepEqual(f.calls.map(c => c.method), ['flee'])
  f.b.last = { m: 'flee', at: Date.now(), p: { timeoutSeconds: 3 }, pending: true }
  frozenT(); f.advance(13000); frozenT()
  assert.ok(f.calls.some(c => c.method === 'stop'), 'an ongoing, motionless escape can still be interrupted')
})

test('verified route arrival survives later displacement, but a partial arrival still triggers recovery', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.enemiesOf = () => []
  f.ctx.Y = 120
  const { frozenT } = watchStatus(f.ctx) as any
  const goal = { x: 624, y: 128, z: 550, range: 1, timeoutSeconds: 4 }
  f.frame.p = { x: 617.5, y: 120, z: 550.5 }
  for (const [params, detail] of [
    [goal, { arrived: { x: 624, y: 128, z: 550 } }],
    [{ ...goal, y: 128.5, exactY: true }, { arrived: { x: 624, y: 128, z: 550 }, arrivedY: 128.5 }],
    [{ x: 624, z: 550 }, { arrived: { x: 624, y: 120, z: 550 } }],
    [{ ...goal, exactY: true }, { arrived: { x: 624, y: 128, z: 550 }, arrivedY: 128.5 }],
    [goal, { arrived: { x: 617, y: 120, z: 550 } }]
  ] as const) {
    f.frame.reply = { status: 'done', detail }
    await f.b.c.call('goto', params)
    frozenT(); f.advance(43000); frozenT()
  }
  assert.deepEqual(f.calls.map(c => c.method), ['goto', 'goto', 'goto', 'goto', 'stop', 'goto', 'stop'])
})

test('observing parkour options keeps the actual body command visible to the freeze watcher', async t => {
  const f = fixture(t)
  await f.close()
  const moving = f.b.last
  await f.b.c.call('parkour', { mode: 'options' })
  assert.equal(f.b.last, moving)
  await f.b.c.call('parkour', { mode: 'jump', target: { x: 2.5, y: 64, z: .5 } })
  assert.equal(f.b.last.m, 'parkour')
})

test('the arena and body keep the same route through expired pearl calls, reordered replies and round rollover', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.swarmDriver.enemies = () => [{ id: 'Foe', seenAt: Date.now(), position: f.frame.p }]
  const session = new Session({}, new EventBus(), { state: {}, append() {} })
  session.state = () => ({ connected: true })
  const native = { age: 100n, ticks: 0, serverTicks: 0 }
  session.bot = { entity: {}, ndClock: native, clearControlStates() {} } as any
  const rpc = aerialMethods({ session } as any)
  const gates: (() => void)[] = []
  let hold = false, finishWalk, enterWalk
  const started = new Promise<void>(resolve => { enterWalk = resolve })
  session.tactics = { enabled: () => hold, waitForRelease: () => new Promise<void>(r => gates.push(r)) } as any
  f.frame.transport = (method, params) => method === 'goto'
    ? session.runIntent('goto', () => new Promise(resolve => { finishWalk = resolve; enterWalk() }), { interruptible: false, timeoutMs: 0 })
    : rpc[method](params)
  const walk = f.b.c.call('goto', { x: 3, y: 64, z: 1 })
  await started
  const route = f.b.last, nativeRoute = session.current
  assert.equal(nativeRoute.name, 'goto')
  hold = true
  const queue = method => {
    const index = gates.length
    const promise = f.b.c.call(method, { gameTick: 100 + native.ticks, eta: 30, at: f.frame.p })
    assert.equal(gates.length, index + 1)
    return async () => { gates[index](); assert.equal((await promise).code, 'ACTION_EXPIRED') }
  }
  try {
    for (const newestFirst of [false, true]) {
      const a = queue('boost_lance'), b = queue('boost_shot'), c = queue('pearl_trap')
      native.ticks += 32
      for (const reply of newestFirst ? [c, b, a] : [b, a, c]) await reply()
      assert.equal(f.b.last, route)
      assert.equal(route.pending, true)
      assert.equal(session.current, nativeRoute)
      assert.equal(nativeRoute.ctl.aborted, false)
    }
    const late = queue('pearl_trap')
    f.ctx.round++; native.ticks += 32
    await late()
    assert.equal(f.b.last, null, 'a previous-round route is never restored')
    const old = queue('boost_shot')
    f.ctx.round++; native.ticks += 32
    f.frame.transport = () => Promise.resolve({ status: 'done', detail: { ok: true } })
    await f.b.c.call('evade', {})
    const next = f.b.last
    await old()
    assert.equal(f.b.last, next, 'a later action keeps its actual receipt')
  } finally {
    gates.forEach(resume => resume())
    finishWalk?.({ arrived: f.frame.p }); await walk
  }
})

test('a floor dodge refused before admission leaves the recorded flank walk pending', async t => {
  const f = fixture(t)
  await f.close()
  require('./arena/dangers').installDangers(f.ctx)
  let finishWalk
  f.frame.transport = (method, params) => {
    if (method === 'goto') return new Promise(resolve => { finishWalk = resolve })
    if (method === 'swarm_pose') return { detail: { cells: params.cells.map(at => ({ at, existing: { name: 'stone', solid: true } })) } }
    assert.equal(method, 'evade')
    return { status: 'failed', notStarted: true, code: 'NO_SAFE_EVADE', detail: { ok: false, why: 'некуда сойти и остановиться на опоре' } }
  }
  const pending = f.b.c.call('goto', { x: 0, y: 64, z: 11, _hunt: true })
  const route = f.b.last
  try {
    const result = await f.ctx.dodgeAway(f.b, f.frame.p, { x: 0, y: 64, z: -1 }, 3, null, null, false, false, 0, 0, () => true)
    assert.equal(result, false); assert.equal(f.b.last, route); assert.equal(route.pending, true)
    assert.deepEqual(f.calls.map(c => c.method), ['goto', 'evade', 'swarm_pose'])
    assert.equal(f.ctx.busy.has(f.b.name), false)
  } finally { finishWalk({ status: 'done' }); await pending }
})

test('a flank refused before movement preserves the shield and cannot register its target as physically blocked', async t => {
  const f = fixture(t)
  await f.close()
  f.ctx.enemiesOf = () => []
  const { frozenT } = watchStatus(f.ctx) as any
  const walk = { x: 20, y: 74, z: 3, timeoutSeconds: 4, climb: true, _hunt: true }
  const denied = { status: 'failed', code: 'DEFENSE_BUSY', notStarted: true }
  const delayed = (m, p) => {
    let reply
    f.frame.reply = new Promise(resolve => { reply = resolve })
    const result = f.b.c.call(m, p)
    return { result, reply, action: f.b.last }
  }
  const hold = delayed('swarm_hold', { shield: true, whileSmash: 'Mace', seconds: 20 })
  f.b.shieldHold = { round: f.ctx.round }
  assert.equal((await f.b.c.call('goto', walk)).code, 'DEFENSE_BUSY')
  assert.equal(f.b.last, hold.action)
  assert.equal(f.calls.filter(c => c.method === 'goto').length, 0, 'the known arena guard stays visible even before any transport receipt')
  // A body-only defense still needs to reject in-flight requests through its real response path.
  f.b.shieldHold = null
  f.ctx.busy.add(f.b.name)
  for (const firstArrivesFirst of [false, true]) {
    const one = delayed('goto', walk), two = delayed('goto', walk)
    for (const request of firstArrivesFirst ? [one, two] : [two, one]) {
      request.reply(denied); await request.result
    }
    assert.equal(f.b.last, hold.action)
    assert.equal(f.b.last.pending, true)
    frozenT(); f.advance(5500); frozenT()
    assert.equal(f.b.badSpots?.length || 0, 0)
  }
  f.ctx.busy.delete(f.b.name)
  hold.reply({ status: 'done' }); await hold.result
  frozenT(); f.advance(30000); frozenT()
  assert.deepEqual(f.b.badSpots || [], [])
  assert.equal(f.calls.some(c => c.method === 'stop'), false)
  const old = delayed('goto', walk), newer = delayed('dodge_blast', {})
  old.reply(denied); await old.result
  assert.equal(f.b.last, newer.action, 'old refusal must not replace a newer escape')
  newer.reply({ status: 'done' }); await newer.result
  const last = delayed('goto', walk)
  f.ctx.round++
  last.reply(denied); await last.result
  assert.equal(f.b.last, null, 'another round must never inherit the old guard or the refused goal')
})

test('mace alert between selecting the tier flanker and issuing its walk preserves both shield ownership and the next approach', async t => {
  const f = fixture(t)
  await f.close(); f.advance(50000)
  f.frame.inv.wind_charge = 1
  const sight = [{ id: 'Mace', visible: true, position: { x: 12, y: 69, z: 0 } }]
  let hold, release, failures = 0
  const wind = swarmWind({ bots: [f.b], pos: f.ctx.pos, generation: f.ctx.round, now: Date.now, alive: () => true,
    arena: { x: 0, y: 64, z: 0, r: 50 }, teamOf: b => b.team, hostile: () => true, panic: () => false,
    failed: () => { failures++ }, log: line => {
      if (hold || !line.includes('на фланг')) return
      f.frame.reply = new Promise(resolve => { release = resolve })
      f.b.shieldHold = { round: f.ctx.round }
      hold = f.b.c.call('swarm_hold', { shield: true, whileSmash: 'Mace' })
    } } as any)
  wind.windFlank(f.b, sight)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls.map(c => c.method), ['swarm_hold'])
  assert.equal(f.b.last.pending, true)
  assert.equal(f.b.swarmReserved, undefined)
  release({ status: 'done' }); await hold; f.b.shieldHold = null
  f.advance(50000); f.frame.reply = { status: 'done' }
  wind.windFlank(f.b, sight)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls.map(c => c.method), ['swarm_hold', 'goto'])
  assert.equal(failures, 0)
})
