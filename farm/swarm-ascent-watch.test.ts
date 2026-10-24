// Сторожа арены не отменяют успешный подъём и один раз снимают зависший под стрелами.
import test from 'node:test'
import assert from 'node:assert/strict'
import { installSight, watchAlarm, watchStatus } from './arena/watch'
import { runAscent } from './swarm/swarm-driver/ascent'

function fixture(t) {
  let now = 1000, finish: () => void
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setInterval', fn => fn as any)
  const calls: any[] = [], frame: any = { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: { stone: 64 }, frame: 20, frameAt: now, observedAt: now }
  const foe = { id: 'Foe', seenAt: now, position: { x: 0, y: 68, z: 0 }, equipment: { weapon: 'bow' } }
  const b: any = { name: 'A', team: 'blue', arrowThreat: { active: true, at: now }, last: {
    m: 'goto', at: now, p: { x: 0, y: 68, z: 0, climb: true, _climb: true }, pending: true
  }, c: { async call(method, params) {
    calls.push({ method, params })
    if (method === 'status') return { status: 'done', state: { pos: frame.p, health: frame.hp,
      inventory: frame.inv, physicsTicks: frame.frame, clock: { ticks: frame.frame } }, detail: { sightings: [], ...(frame.precise ? { at: frame.precise } : {}) } }
    return { status: 'done', detail: {} }
  } } }
  const ctx: any = { i: 31, bots: [b], names: ['A'], pos: { A: frame }, busy: new Set(), out: new Set(), deadNow: new Set(),
    labNeed: {}, deathAt: {}, rel: {}, humans: {}, round: 1, between: false, teams: false, arms: false,
    X: 0, Y: 64, Z: 0, R: 50, STOPF: 'q10b-ascent-test-no-stop-file', teamOf: id => id === 'A' ? 'blue' : 'red',
    alive: () => true, log() {}, rcon: async () => {}, home: () => '0 0', hostile: () => true, readDeaths() {} }
  installSight(ctx)
  ctx.swarmDriver.enemies = () => [foe]
  ctx.swarmDriver.panic = () => true
  ctx.swarmDriver.observe = () => {}
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
