import test from 'node:test'
import assert from 'node:assert/strict'
import { installDangers } from './arena/dangers'
import { installSight } from './arena/watch'
import { swarmWind } from './swarm/swarm-driver/wind'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { currentTurn } from './swarm/swarm-driver/lifecycle'

const settle = () => new Promise(resolve => setImmediate(resolve))

function fixture(names = ['Victim', 'Helper']) {
  const calls: any[] = [], gates = new Map<string, () => void>()
  const bots = names.map(name => {
    const b: any = { name, team: 'blue', last: { m: 'goto', pending: false } }
    b.c = { call(method, params) {
      calls.push({ name, method, params })
      if (method === 'swarm_pose') return Promise.resolve({ detail: { existing: { name: 'air', solid: false } } })
      if (method === 'wind_report') return new Promise(resolve => gates.set(name + ':report', () => resolve({ detail: {
        ok: true, ready: true, gameTick: 100, report: { id: name, position: pos[name].p, gameTick: 100 }
      } })))
      if (method === 'enemy_wind_plan') return new Promise(resolve => gates.set('plan', () => resolve({ detail: { ok: true, plan: {
        shots: [{ thrower: 'Helper', fireTick: 110 }]
      } } })))
      return new Promise(resolve => calls[calls.length - 1].reply = detail => resolve({ status: 'done', detail }))
    } }
    return b
  })
  const [victim, helper] = bots
  const pos: any = { Victim: { p: { x: 60, y: 120, z: 0 }, inv: { wind_charge: 2 } },
    Helper: { p: { x: 66, y: 120, z: 0 }, inv: { iron_sword: 1, wind_charge: 2, mace: 1, elytra: 1, firework_rocket: 8 } } }
  const ctx: any = { i: 31, arms: false, teams: true, bots, names: bots.map(b => b.name), pos, humans: {},
    X: 0, Y: 120, Z: 0, R: 80, L: { map: 'flat' }, home: () => '0 0', hostile: () => true,
    rcon() { throw new Error('No live actions') }, round: 1, between: false, busy: new Set(), out: new Set(), deadNow: new Set(),
    alive: name => !ctx.out.has(name) && !ctx.deadNow.has(name), log() {} }
  installSight(ctx)
  installDangers(ctx)
  const sw: any = { bots, pos, generation: 1, now: () => 100000, alive: ctx.alive, log() {},
    teamOf: b => b.team, hostile: (_b, name) => name === 'Foe', panic: () => false,
    arena: { x: 0, y: 120, z: 0, r: 80 }, boardOf: () => ({ enemies: () => [] }),
    go: (b, at, range, timeoutSeconds) => b.c.call('goto', { ...at, range, timeoutSeconds }) }
  let observedAt = Date.now()
  const report = web => victim.c.onDanger({ pos: pos.Victim.p, observedAt: ++observedAt,
    dangers: { web: web ? [{ at: pos.Victim.p, cells: 1 }] : [] } })
  const seen = [{ id: 'Foe', visible: true, position: { x: 78, y: 150, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }]
  return { bots, victim, helper, pos, ctx, sw, api: swarmWind(sw), calls, gates, report, seen }
}

for (const action of ['pending fight', 'finished fight', 'free']) test(`airborne wind flank preserves ${action} ownership and uses free helpers`, async () => {
  const f = fixture(['Victim', 'Helper', 'Free'])
  f.pos.Victim.p = { x: 68, y: 120, z: 0 }
  f.pos.Free = { p: { x: 67, y: 120, z: 0 }, inv: { wind_charge: 2 } }
  let fight: Promise<any> | undefined
  if (action !== 'free') {
    fight = f.helper.c.call('fight', { target: 'Foe' })
    assert.equal(f.helper.last.m, 'fight'); assert.equal(f.helper.last.pending, true)
    if (action === 'finished fight') { f.calls.find(c => c.method === 'fight').reply({ landed: 1 }); await fight }
  }
  const running = f.helper.last
  f.api.windFlank(f.victim, [{ id: 'Foe', visible: true, airborne: true,
    position: { x: 70, y: 124, z: 0 }, velocity: { x: 0, y: 1, z: 0 } }])
  const moved = f.calls.filter(c => c.method === 'goto')
  assert.deepEqual(moved.map(c => c.name).sort(), action === 'pending fight' ? ['Free', 'Victim'] : ['Free', 'Helper', 'Victim'])
  if (action === 'pending fight') {
    assert.equal(f.helper.last, running, 'a flank cannot replace the actual pending fight intent')
    assert.equal(f.helper.swarmReserved, undefined, 'the fighting ally is not claimed for repositioning')
    f.calls.find(c => c.method === 'fight').reply({ landed: 1 }); await fight
  }
  for (const move of moved) move.reply({ ok: true })
  await settle()
  assert.ok(f.bots.every(b => !b.swarmReserved), 'free helpers release their flank reservations')
})

test('wind flank preserves the actual web helper during approach and resumes after rescue', async () => {
  const f = fixture(); f.report(true)
  const rescue = f.helper.webRescue
  assert.equal(rescue.target, 'Victim'); assert.equal(f.ctx.busy.has('Helper'), true)
  f.api.windFlank(f.victim, f.seen)
  assert.equal(f.calls.some(c => c.name === 'Helper' && c.method === 'fly_to'), false)
  assert.equal(f.helper.webRescue, rescue)
  f.calls.find(c => c.name === 'Helper' && c.method === 'goto').reply({ ok: true }); await settle()
  f.api.windFlank(f.victim, f.seen)
  assert.equal(f.calls.some(c => c.name === 'Helper' && c.method === 'fly_to'), false, 'cutting retains the same rescue')
  f.calls.find(c => c.name === 'Helper' && c.method === 'cut_ally_web').reply({ ok: true, cut: 1 }); await settle()
  assert.equal(f.helper.webRescue, null); assert.equal(f.ctx.busy.has('Helper'), false)
  f.api.windFlank(f.victim, f.seen)
  assert.equal(f.calls.filter(c => c.name === 'Helper' && c.method === 'fly_to').length, 1)
})

for (const stage of ['report', 'plan']) test(`wind chain preserves a helper claimed during awaited ${stage}`, async () => {
  const f = fixture(), done = f.api.windObserve(f.victim, f.seen)
  if (stage === 'plan') { for (const name of ['Victim', 'Helper']) f.gates.get(name + ':report')!(); await settle() }
  f.report(true)
  const rescue = f.helper.webRescue
  assert.equal(rescue.target, 'Victim')
  if (stage === 'report') { for (const name of ['Victim', 'Helper']) f.gates.get(name + ':report')!(); await settle() }
  f.gates.get('plan')?.()
  assert.equal(await done, false)
  assert.equal(f.calls.some(c => c.method === 'wind_out'), false)
  assert.equal(f.helper.webRescue, rescue); assert.equal(f.ctx.busy.has('Helper'), true)
})

test('pearl ambush preserves the actual web helper and resumes after rescue', async () => {
  const f = fixture(); f.report(true)
  const rescue = f.helper.webRescue
  assert.equal(rescue.target, 'Victim')
  f.api.pearlObserve(f.victim, [{ id: 7, owner: 'Foe', at: { x: 69, y: 120, z: 0 }, eta: 60 }])
  assert.equal(f.calls.some(c => c.name === 'Helper' && /^pearl_|^boost_/.test(c.method)), false)
  assert.equal(f.helper.webRescue, rescue); assert.equal(f.ctx.busy.has('Helper'), true)
  f.calls.find(c => c.name === 'Helper' && c.method === 'goto').reply({ ok: true }); await settle()
  f.calls.find(c => c.name === 'Helper' && c.method === 'cut_ally_web').reply({ ok: true, cut: 1 }); await settle()
  f.api.pearlObserve(f.victim, [{ id: 8, owner: 'Foe', at: { x: 69, y: 120, z: 0 }, eta: 60 }])
  assert.equal(f.calls.filter(c => c.name === 'Helper' && c.method === 'pearl_ambush').length, 1)
})

for (const phase of ['approach', 'draw']) test(`arrow boost yields to actual helper lava reaction during ${phase}`, async t => {
  const f = fixture(), timers: (() => void)[] = []
  t.mock.method(globalThis, 'setTimeout', (work: () => void, ms: number) => {
    assert.equal(ms, 900); timers.push(work); return 0 as any
  })
  f.pos.Victim = { p: { x: 7, y: 120, z: 0 }, inv: { iron_spear: 1 } }
  f.pos.Helper = { p: { x: 10, y: 120, z: 0 }, inv: { bow: 1, arrow: 16 } }
  f.api.arrowBoost(f.victim, [{ id: 'Foe', visible: true, position: { x: 0, y: 120, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }])
  const approaches = f.calls.filter(c => c.method === 'goto')
  assert.equal(approaches.length, 2)
  const danger = () => {
    f.helper.c.onDanger({ pos: f.pos.Helper.p, dangers: { lava: [{ at: f.pos.Helper.p, d: 0 }] } })
    assert.equal(f.ctx.busy.has('Helper'), true)
    assert.equal(f.helper.last.m, 'lava_escape')
  }
  if (phase === 'approach') danger()
  for (const c of approaches) { f.pos[c.name].p = { x: c.params.x, y: c.params.y, z: c.params.z }; c.reply({ ok: true }) }
  await settle()
  if (phase === 'draw') { assert.equal(timers.length, 1); danger() }
  for (const resume of timers) resume()
  await settle()
  const shots = f.calls.filter(c => c.method === 'boost_shot')
  for (const c of f.calls.filter(c => /^boost_/.test(c.method))) c.reply({ ok: true })
  await settle()
  assert.equal(shots.length, 0, 'late ordinary boost cannot interrupt the active lava escape')
  if (phase === 'approach') assert.equal(f.calls.some(c => c.method === 'boost_lance'), false)
})

test('an unchanged arrow boost starts both native actions and releases its reservations', async t => {
  const f = fixture(), timers: (() => void)[] = []
  t.mock.method(globalThis, 'setTimeout', (work: () => void, ms: number) => {
    assert.equal(ms, 900); timers.push(work); return 0 as any
  })
  f.pos.Victim = { p: { x: 7, y: 120, z: 0 }, inv: { iron_spear: 1 } }
  f.pos.Helper = { p: { x: 10, y: 120, z: 0 }, inv: { bow: 1, arrow: 16 } }
  f.api.arrowBoost(f.victim, [{ id: 'Foe', visible: true, position: { x: 0, y: 120, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }])
  for (const c of f.calls.filter(c => c.method === 'goto')) {
    f.pos[c.name].p = { x: c.params.x, y: c.params.y, z: c.params.z }; c.reply({ ok: true })
  }
  await settle(); assert.equal(timers.length, 1); timers[0](); await settle()
  const actions = f.calls.filter(c => /^boost_/.test(c.method))
  assert.deepEqual(actions.map(c => c.method), ['boost_lance', 'boost_shot'])
  assert.equal(f.victim.last.m, 'boost_lance'); assert.equal(f.victim.last.pending, true)
  assert.equal(f.helper.last.m, 'boost_shot'); assert.equal(f.helper.last.pending, true)
  for (const c of actions) c.reply({ ok: true })
  await settle()
  assert.ok(f.bots.every(b => b.last.pending === false))
  assert.ok(f.bots.every(b => !b.swarmReserved))
})

test('a real wind orbit reservation protects nongliding launch from task preemption until its reply', async () => {
  const f = fixture(), running = { kind: 'goto', data: { target: 'Old' } }
  const next = { kind: 'fight', data: { target: 'Foe' } }
  Object.assign(f.helper, { swarmExecuting: true, swarmTask: running, swarmTurnOwner: { cancelled: false } })
  f.sw.refresh = () => ({ task: next, board: { enemies: () => [] } })
  const { preempt } = swarmTurn(f.sw)
  f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true }])
  const flight = f.calls.find(c => c.method === 'wing_orbit'), intent = f.helper.last
  assert.equal(flight?.name, 'Helper')
  assert.ok(f.helper.swarmReserved, 'the real producer holds its reservation before the RPC reply')
  assert.notEqual(f.pos.Helper.gliding, true, 'launch has not yet reported gliding')
  try {
    assert.equal(preempt(f.helper), false, 'a new task cannot cancel the reserved launch')
    assert.equal(f.helper.last, intent)
    assert.equal(f.helper.swarmTask, running)
    assert.equal(f.calls.some(c => c.method === 'stop'), false)
    flight.reply({ ok: true, ms: 1000, nearTicks: 1, closest: 8, why: 'долго', landed: true })
    await settle()
    assert.equal(f.helper.swarmReserved, undefined, 'the actual producer finally releases ownership')
    assert.equal(preempt(f.helper), true, 'ordinary task changes resume immediately after release')
    assert.equal(f.helper.swarmTask, next)
    assert.deepEqual(f.calls.map(c => c.method), ['wing_orbit', 'stop'])
  } finally {
    for (const c of f.calls) c.reply?.({ ok: true })
    await settle()
  }
})

test('a visible glider stays available to ordinary combat instead of reserving a wind-only orbit', async () => {
  const f = fixture(), before = f.helper.last
  f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true, gliding: true }])
  assert.equal(f.calls.some(c => c.method === 'wing_orbit'), false)
  assert.equal(f.helper.swarmReserved, undefined)
  assert.equal(f.helper.last, before)
  f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true, gliding: false, threat: 'aerial' }])
  const flight = f.calls.find(c => c.method === 'wing_orbit')
  assert.equal(flight?.name, 'Helper', 'a thrown or falling mace user still permits a wind orbit')
  flight.reply({ ok: true }); await settle()
})

test('wind orbit reservations preserve emergency reactions, death invalidation and actual round reset', async () => {
  const f = fixture()
  f.api.windWing(f.victim, [{ ...f.seen[0], airborne: true }])
  assert.ok(f.helper.swarmReserved)
  f.helper.c.onDanger({ pos: f.pos.Helper.p, dangers: { lava: [{ at: f.pos.Helper.p, d: 0 }] } })
  assert.equal(f.helper.last.m, 'lava_escape', 'the actual danger adapter still starts the emergency RPC')
  assert.equal(f.ctx.busy.has('Helper'), true)
  f.ctx.deadNow.add('Helper')
  assert.equal(currentTurn(f.sw, f.helper, f.sw.generation), false, 'death invalidates the old turn despite its reservation')
  f.ctx.deathAt = {}
  f.ctx.swarmDriver.reset()
  assert.equal(f.helper.swarmReserved, undefined, 'the actual round reset clears the reservation')
  assert.equal(f.helper.swarmTask, undefined)
  assert.equal(f.calls.filter(c => c.method === 'swarm_keep').length, f.bots.length)
  for (const c of f.calls) c.reply?.({ ok: true })
  await settle()
})

test('wind orbit retries require target movement after completion, not movement during the reserved flight', async () => {
  const f = fixture()
  let seen = { ...f.seen[0], airborne: true }
  f.sw.boardOf = () => ({ enemies: () => [seen] })
  f.api.windWing(f.victim, [seen])
  const first = f.calls.find(c => c.method === 'wing_orbit')
  assert.ok(first)
  seen = { ...seen, position: { ...seen.position, x: seen.position.x - 10 } }
  first.reply({ ok: true, ms: 18000, windShots: 0, nearTicks: 0, closest: 17, landed: true })
  await settle()
  f.api.windWing(f.victim, [seen])
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 1, 'the completed flight already covered this movement')
  assert.equal(f.helper.swarmReserved, undefined, 'ordinary combat can resume')
  seen = { ...seen, position: { ...seen.position, x: seen.position.x - 6 } }
  f.api.windWing(f.victim, [seen])
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 2, 'new movement permits another useful approach')
  f.calls.at(-1).reply({ ok: true, windShots: 1 }); await settle()
  f.sw.generation++
  f.api.windWing(f.victim, [seen])
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 3, 'the next round does not inherit the last flight position')
  f.calls.at(-1).reply({ ok: true }); await settle()
})

test('an old round orbit reply cannot poison the current round launch memory', async () => {
  const f = fixture()
  let seen = { ...f.seen[0], airborne: true }
  f.sw.boardOf = () => ({ enemies: () => [seen] })
  f.api.windWing(f.victim, [seen])
  const old = f.calls.at(-1)
  f.sw.generation++
  delete f.helper.swarmReserved
  f.helper.last.pending = false
  f.api.windWing(f.victim, [seen])
  const current = f.calls.at(-1), owner = f.helper.swarmReserved
  assert.notEqual(current, old)
  old.reply({ ok: false, why: 'взлёт: blocked' }); await settle()
  assert.equal(f.helper.swarmReserved, owner, 'late cleanup leaves the new flight owner intact')
  current.reply({ ok: true, windShots: 1 }); await settle()
  seen = { ...seen, position: { ...seen.position, x: seen.position.x - 6 } }
  f.api.windWing(f.victim, [seen])
  assert.equal(f.calls.filter(c => c.method === 'wing_orbit').length, 3, 'the old failure did not block the same launch point')
  f.calls.at(-1).reply({ ok: true }); await settle()
})
