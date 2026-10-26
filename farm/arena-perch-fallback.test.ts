import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'
import { terrainCoverMethods } from '../daemon/src/rpc/terrain-cover'
import { installSight } from './arena/watch'
import { installDangers } from './arena/dangers'
import { swarmLifecycle } from './swarm/swarm-driver/lifecycle'
const { Vec3 } = require('../daemon/node_modules/vec3')

function fixture(options: any = {}) {
  const calls: any[] = [], replies: any[] = [], p = { x: 527.01, y: 159, z: 609.65 }
  const m: any = { p: { ...p }, hp: 11, inv: { bow: 1, arrow: 64, golden_apple: 3 }, attackArrows: 64 }
  const bot = { entity: { position: new Vec3(p.x, p.y, p.z) },
    inventory: { items: () => Object.entries(m.inv).map(([name, count]) => ({ name, count })) },
    players: options.visible ? { Foe: { entity: { position: new Vec3(p.x + 80, p.y, p.z) } } } : {}, pathfinder: { setGoal() {} } }
  const handler = terrainCoverMethods({ session: { require: () => bot,
    runIntent: async (_name, run) => ({ status: 'done', detail: await run({ aborted: false }) }) }, gameClock: {} } as any)
  const task: any = { kind: 'flee', position: p, data: { perch: true, target: 'Foe' } }
  const b: any = { name: 'A', swarmTask: task, c: { async call(method, params) {
    calls.push({ method, params }); if (!options.trackedBySight) b.last = { method, params }
    const r = await (method === 'peek_shot' ? options.reply || handler.peek_shot(params) : method === 'eat' && options.eatReply || { status: 'done', detail: { ok: true } })
    if (method === 'peek_shot') options.afterPeek?.({ b, m, sw, reply: r })
    if (method === 'eat') options.afterEat?.({ b, m, sw, reply: r })
    replies.push(r); return r
  } } }
  const sw: any = { now: () => 1000, generation: 1, alive: () => !sw.dead, log() {}, pos: { A: m }, arena: { y: 120 },
    cooldown: new Map(), detail: r => r?.detail || r || {}, blocked: () => false, rangedAdvantage: () => false }
  const tc: any = { b, m, task, round: 1, context: { members: [] }, board: {},
    enemies: [{ id: 'Foe', seenAt: 1000, position: { ...p, x: p.x + 80 }, threat: 'sword' }] }
  return { b, m, sw, tc, calls, replies, run: () => swarmTurnTasks(sw).turnFlee(tc) }
}

test('perch heals and holds after actual handler refuses an absent or out-of-range foe', async () => {
  for (const visible of [false, true]) {
    const f = fixture({ visible }); await f.run()
    assert.deepEqual(f.calls.map(c => c.method), ['peek_shot', 'eat', 'swarm_hold'])
    assert.equal(f.replies[0].detail.ok, false)
    assert.equal(f.replies[0].detail.fired || 0, 0)
    assert.equal(f.calls.at(-1).params.sneak, true, 'the safe perch remains occupied')
  }
})

test('perch preserves a shot, hit, cover, successful wait or unknown/pending outcome', async () => {
  for (const reply of [
    { status: 'done', detail: { ok: true, fired: 0 } },
    ...[{ fired: 1 }, { hits: 1 }, { wall: 2 }].map(effect => ({ status: 'done', detail: { ok: false, ...effect } })),
    { status: 'pending', detail: { ok: false }, token: 7 }, { status: 'done', detail: {} }
  ]) {
    const f = fixture({ reply }); await f.run(); assert.deepEqual(f.calls.map(c => c.method), ['peek_shot'])
  }
})

test('perch does not replace real movement after a zero-shot refusal', async () => {
  const f = fixture({ afterPeek: ({ m }) => { m.p = { ...m.p, x: m.p.x + 1 } } }); await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['peek_shot'])
})

test('late perch reply cannot eat after interruption, rescue, emergency or changed owner/round', async () => {
  for (const options of [
    { reply: { status: 'interrupted', detail: { ok: false } } },
    { reply: { status: 'done', code: 'RESCUE_BUSY', detail: { ok: false } } },
    ...[{ owner: 'Emergency' }, { owner: 'Tactical' }, { action: 'clear_web' }].map(tactics => ({ reply: { status: 'done', detail: { ok: false }, state: { tactics } } })),
    { afterPeek: ({ sw }) => { sw.generation++ } }, { afterPeek: ({ sw }) => { sw.dead = true } },
    { afterPeek: ({ b }) => { b.last = { method: 'clear_web' } } },
    { afterPeek: ({ b }) => { b.swarmTask = { kind: 'fight' } } }
  ]) {
    const f = fixture(options); await f.run(); assert.deepEqual(f.calls.map(c => c.method), ['peek_shot'])
  }
})

test('new owner during the fallback meal prevents a late hold', async () => {
  for (const afterEat of [({ sw }) => { sw.generation++ }, ({ b }) => { b.last = { method: 'clear_web' } },
    ({ reply }) => { reply.status = 'interrupted' }, ({ reply }) => { reply.state = { tactics: { owner: 'Emergency' } } }]) {
    const f = fixture({ afterEat }); await f.run(); assert.deepEqual(f.calls.map(c => c.method), ['peek_shot', 'eat'])
  }
})

test('unchanged existing rescue owner can use its fallback; replacing or releasing it cannot', async () => {
  const rescue = { target: 'Victim', round: 1 }, kept = fixture()
  kept.b.webRescue = rescue; await kept.run()
  assert.deepEqual(kept.calls.map(c => c.method), ['peek_shot', 'eat', 'swarm_hold'])
  for (const replacement of [null, { ...rescue }]) {
    const changed = fixture({ afterPeek: ({ b }) => { b.webRescue = replacement } })
    changed.b.webRescue = rescue; await changed.run()
    assert.deepEqual(changed.calls.map(c => c.method), ['peek_shot'])
  }
})

for (const stage of ['peek_shot', 'eat']) test(`actual web rescue reservation before old ${stage} settles prevents late fallback`, async () => {
  let resolveReply: any
  const pending = new Promise(resolve => { resolveReply = resolve })
  const f = fixture({ trackedBySight: true, ...(stage === 'peek_shot' ? { reply: pending } : { eatReply: pending }) })
  f.b.team = 'blue'; f.m.inv.iron_sword = 1
  const victim: any = { name: 'Victim', team: 'blue', c: { async call() { return { status: 'done', detail: { ok: false, why: 'no tool' } } } } }
  const p = f.m.p, ctx: any = { i: 31, arms: false, teams: true, bots: [f.b, victim], names: ['A', 'Victim'],
    pos: { A: f.m, Victim: { p: { ...p, x: p.x + 6 }, hp: 20, inv: {} } }, humans: {},
    X: 0, Y: 120, Z: 0, R: 80, L: { map: 'flat' }, home: () => '0 0', hostile: () => true,
    log() {}, rcon() { throw new Error('No live actions') }, round: 1, between: false,
    alive: () => true, busy: new Set(), out: new Set(), deadNow: new Set() }
  installSight(ctx); installDangers(ctx)
  f.sw.turn = f.run
  const done = swarmLifecycle(f.sw).guardedTurn(f.b)
  for (let i = 0; i < 20 && !f.calls.some(c => c.method === stage); i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.b.swarmExecuting, true)
  const oldAction = f.b.last
  assert.equal(oldAction.m, stage)
  victim.c.onDanger({ pos: ctx.pos.Victim.p, observedAt: Date.now(), dangers: { web: [{ at: ctx.pos.Victim.p, cells: 1 }] } })
  assert.equal(f.b.webRescue?.target, 'Victim', 'actual beginReaction and webRescue reserved the helper')
  assert.equal(ctx.busy.has('A'), true)
  assert.ok(f.calls.some(c => c.method === 'stop'))
  assert.equal(f.b.last, oldAction, 'actual watch wrapper excludes stop from b.last')
  resolveReply({ status: 'done', detail: { ok: stage === 'eat', fired: 0 } })
  await done
  const ordinary = f.calls.filter(c => /^(eat|swarm_hold)$/.test(c.method)).map(c => c.method)
  for (let i = 0; i < 20 && f.b.webRescue; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(ordinary, stage === 'eat' ? ['eat'] : [], 'the queued normal reply must yield to the already-reserved rescue')
})
