import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { installSight } from './arena/watch'
import { runIntent } from '../daemon/src/session/intent-runner'
import { swarmMethods } from '../daemon/src/rpc/swarm'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function pipeline(at = { x: .5, y: 64, z: .5 }) {
  const foe = { id: 'Champ', seenAt: 1000, position: { x: 3.5, y: 64, z: .5 } }
  const fight = (extra = {}): any => ({ kind: 'fight', position: foe.position,
    data: { target: foe.id, committed: true, ...extra } })
  let task = fight(), finish: (v: any) => void
  const calls: any[] = []
  const session: any = { current: null, state: () => ({ busy: session.current?.name }), bus: { drain: () => [] } }
  const rpc: any = swarmMethods({ session } as any)
  const b: any = { name: 'A', swarmExecuting: true, swarmTask: task, c: { call(method, params) {
    calls.push({ method, params })
    if (method === 'fight_guard') return rpc.fight_guard(params)
    if (method === 'stop') { session.current?.ctl.abort(); return Promise.resolve({ status: 'done' }) }
    if (!/^(fight|goto)$/.test(method)) throw new Error(`unexpected ${method}`)
    const worker = new Promise(r => { finish = r })
    return runIntent.call(session, method, () => worker,
      { params, exclusive: false, interruptible: false, timeoutMs: 0 })
  } } }
  const sw: any = { generation: 1, now: () => 1000, bots: [b], alive: () => true,
    pos: { A: { p: at, inv: {} } }, log() {}, arena: { x: 0, z: 0, r: 32 },
    teamOf: () => 'blue', home: () => at, rangedAdvantage: () => false, onslaught: () => false,
    cooldown: new Map(), refresh: () => ({ task, board: { enemies: () => [foe] } }) }
  Object.assign(sw, swarmMoves(sw))
  const work = swarmTurnWork(sw), turn = swarmTurn(sw)
  installSight({ i: 31, arms: false, bots: [b], names: ['A'], pos: sw.pos,
    humans: {}, X: 0, Y: 64, Z: 0, R: 24, arena: sw.arena, rcon() {}, log() {}, alive: () => true,
    deathAt: {}, home: () => '0 0', hostile: () => true } as any)
  const start = async (initial = task) => {
    task = initial; b.swarmTask = task
    const running = work.turnFight({ b, board: {}, task, round: 1, m: sw.pos.A, enemies: [foe],
      context: { members: [] }, foe, contact: true } as any)
    await flush()
    return { running }
  }
  const done = async running => { finish?.({ landed: 1, arrived: at }); await running }
  return { b, sw, session, calls, foe, fight, start, done, set: value => { task = value }, preempt: () => turn.preempt(b) }
}

test('actual turnFight -> arena wrapper -> real intent -> fight_guard keeps the native controller', async () => {
  const f = pipeline(), { running } = await f.start()
  try {
    const current = f.session.current, intent = f.b.last, owner = f.b.swarmFight
    assert.equal(current.name, 'fight'); assert.equal(owner.intent, intent)
    const next = f.fight({ shove: true, shoveAt: { x: -2, y: 64, z: .5 } })
    f.set(next); assert.equal(f.preempt(), false); await flush()
    assert.deepEqual(f.calls.map(c => c.method), ['fight', 'fight_guard'])
    assert.equal(current.ctl.aborted, false); assert.equal(f.session.current, current)
    assert.equal(f.b.last, intent); assert.equal(f.b.swarmTask, next)
    assert.deepEqual(current.params.shoveAt, next.data.shoveAt)
  } finally { await f.done(running) }
})

for (const worn of [false, true]) test(`a fresh distant glider reaches body combat with ${worn ? 'worn' : 'carried'} elytra and flight fuel`, async () => {
  const f = pipeline()
  Object.assign(f.foe, { threat: 'aerial', position: { x: 60.5, y: 84, z: .5 } })
  f.sw.pos.A.inv = { diamond_spear: 1, firework_rocket: 5, ...(worn ? {} : { elytra: 1 }) }
  f.sw.pos.A.armor = { torso: worn ? 'elytra' : 'iron_chestplate' }
  const { running } = await f.start(f.fight({ finishing: true }))
  try {
    assert.equal(f.session.current.name, 'fight', 'the body must price an airborne intercept instead of walking below the target')
    assert.equal(f.calls[0].params.target, 'Champ')
  } finally { await f.done(running) }
})

test('distant glider ground pursuit remains for stale sightings, rescue-only fuel and missing elytra', async () => {
  for (const variant of ['stale', 'reserve', 'no_elytra', 'uncommitted']) {
    const f = pipeline()
    Object.assign(f.foe, { threat: 'aerial', seenAt: variant === 'stale' ? -1 : 1000, position: { x: 60.5, y: 84, z: .5 } })
    f.sw.pos.A.inv = { diamond_spear: 1, firework_rocket: variant === 'reserve' ? 3 : 5, ...(variant === 'no_elytra' ? {} : { elytra: 1 }) }
    const { running } = await f.start(f.fight({ committed: variant !== 'uncommitted' }))
    try { assert.equal(f.session.current.name, 'goto', variant) }
    finally { await f.done(running) }
  }
})

test('k onDig evacuation keeps the same real goto across ordinary/shove guard changes', async () => {
  const f = pipeline(), stand = { x: 2.5, y: 64, z: .5 }
  const guard = { digAvoid: [{ x: 0, y: 63, z: 0 }], swarmStand: stand }
  const { running } = await f.start(f.fight(guard))
  try {
    const current = f.session.current, intent = f.b.last
    assert.equal(current.name, 'goto'); assert.equal(f.b.swarmFight, undefined)
    assert.equal(current.params.x, stand.x); assert.equal(current.params.range, .15)
    f.set(f.fight({ ...guard, shove: true, shoveAt: { x: -2, y: 64, z: .5 } }))
    assert.equal(f.preempt(), false, 'same physical evacuation must complete before switching the subsequent fight directive')
    assert.equal(current.ctl.aborted, false); assert.equal(f.b.last, intent)
    assert.deepEqual(f.calls.map(c => c.method), ['goto'])
  } finally { await f.done(running) }
})

test('k same shove-align destination keeps real goto when only guard membership changes', async () => {
  const f = pipeline(), shove = { shove: true, shoveAt: { x: -2, y: 64, z: .5 } }
  const { running } = await f.start(f.fight(shove))
  try {
    const current = f.session.current
    assert.equal(current.name, 'goto'); assert.equal(current.params.range, .8)
    f.set(f.fight({ ...shove, digAvoid: [{ x: 12, y: 63, z: 0 }], swarmStand: { x: 7.5, y: 64, z: .5 } }))
    assert.equal(f.preempt(), false, 'a still-identical alignment goal does not consume digAvoid')
    assert.equal(current.ctl.aborted, false)
    assert.deepEqual(f.calls.map(c => c.method), ['goto'])
  } finally { await f.done(running) }
})

test('an evacuation correction exactly half the remaining path keeps the real goto', async () => {
  const f = pipeline(), stand = { x: 2.5, y: 64, z: .5 }
  const guard = { digAvoid: [{ x: 0, y: 63, z: 0 }], swarmStand: stand }
  const { running } = await f.start(f.fight(guard))
  try {
    const current = f.session.current, intent = f.b.last
    const next = f.fight({ ...guard, swarmStand: { ...stand, x: 3.5 } })
    f.set(next)
    assert.equal(f.preempt(), false, 'correction 1 equals half the remaining 2-block approach')
    assert.equal(current.ctl.aborted, false)
    assert.equal(f.session.current, current); assert.equal(f.b.last, intent)
    assert.equal(f.b.swarmTask, next)
    assert.deepEqual(f.calls.map(c => c.method), ['goto'])
  } finally { await f.done(running) }
})

test('changed evacuation goal, enemy, retreat or actual offensive phase still stop', async () => {
  const stand = { x: 2.5, y: 64, z: .5 }, guard = { digAvoid: [{ x: 0, y: 63, z: 0 }], swarmStand: stand }
  for (const change of [
    f => f.fight({ ...guard, swarmStand: { ...stand, x: 4.5 } }),
    f => f.fight({ target: 'Other', ...guard }),
    f => ({ kind: 'flee', data: { target: 'Champ' } }),
    f => f.fight({ ...guard, fountain: 'close' })
  ]) {
    const f = pipeline(), { running } = await f.start(f.fight(guard))
    try { f.set(change(f)); assert.equal(f.preempt(), true); assert.equal(f.session.current.ctl.aborted, true) }
    finally { await f.done(running) }
  }
})

test('a changed shove direction or cleared shove stops the old alignment rather than completing its stale goal', async () => {
  for (const extra of [{ shove: true, shoveAt: { x: 3.5, y: 64, z: -3 } }, { shove: false }]) {
    const f = pipeline(), { running } = await f.start(f.fight({ shove: true, shoveAt: { x: -2, y: 64, z: .5 } }))
    try {
      assert.equal(f.session.current.name, 'goto')
      f.set(f.fight(extra)); assert.equal(f.preempt(), true)
      assert.equal(f.session.current.ctl.aborted, true)
      assert.deepEqual(f.calls.map(c => c.method), ['goto', 'stop'])
    } finally { await f.done(running) }
  }
})

test('old round, replaced intent and completed movement cannot retain the old reposition owner', async () => {
  const guard = { digAvoid: [{ x: 0, y: 63, z: 0 }], swarmStand: { x: 2.5, y: 64, z: .5 } }
  for (const change of ['round', 'intent', 'done']) {
    const f = pipeline(), { running } = await f.start(f.fight(guard))
    try {
      if (change === 'round') f.sw.generation++
      if (change === 'intent') f.b.last = { m: 'goto', pending: true }
      if (change === 'done') await f.done(running)
      f.set(f.fight({ ...guard, shove: true, shoveAt: { x: -2, y: 64, z: .5 } }))
      assert.equal(f.preempt(), true, change)
      assert.deepEqual(f.calls.map(c => c.method), ['goto', 'stop'])
    } finally { await f.done(running) }
    assert.equal(f.b.swarmReposition, undefined)
  }
})
