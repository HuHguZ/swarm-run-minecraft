import test from 'node:test'
import assert from 'node:assert/strict'
import { installDangers } from './arena/dangers'
import { installSight } from './arena/watch'
import { swarmWind } from './swarm/swarm-driver/wind'

const settle = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  const calls: any[] = [], gates = new Map<string, () => void>()
  const bots = ['Victim', 'Helper'].map(name => {
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
