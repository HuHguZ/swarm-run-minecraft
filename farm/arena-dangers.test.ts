import test from 'node:test'
import assert from 'node:assert/strict'
import { installDangers } from './arena/dangers'

const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture(t) {
  const calls: any[] = [], queued: any[] = [], p = { x: 0, y: 64, z: 0 }
  let now = 10000, geometry = 'stone'
  t.mock.method(Date, 'now', () => now)
  t.mock.method(Math, 'random', () => .6)
  t.mock.method(globalThis, 'setTimeout', fn => { queued.push(fn); return 0 as any })
  const b: any = { name: 'A', team: 'blue', last: { m: 'goto' },
    dodgeStyle: { delay: 0, len: 2, cd: 500, skip: 0, jumpy: 0 }, c: { call(method, params) {
      if (method === 'swarm_pose') return Promise.resolve({ detail: { existing: { name: geometry, solid: geometry !== 'air' } } })
      b.last = { m: method, p: params }
      return new Promise((resolve, reject) => calls.push({ method, params,
        reply: detail => resolve({ status: 'done', detail }), reject }))
    } } }
  const ctx: any = { round: 1, bots: [b], pos: { A: { p, inv: { bow: 1, arrow: 1, ender_pearl: 1 } } },
    busy: new Set(), out: new Set(), deadNow: new Set(),
    enemiesOf: () => [{ d: 20, mob: false }],
    swarmDriver: { panic: () => false, canEngage: () => true }, log () {} }
  installDangers(ctx)
  const aim = () => {
    b.c.onDanger({ pos: p, dangers: { aims: [{ name: 'Foe', weapon: 'trident',
      at: { x: 20, y: 64, z: 0 }, side: { x: 1, z: 0 } }] } })
    queued.shift()?.()
  }
  const dodge = (after = () => {}) => ctx.dodgeAway(b, p, { x: 2, y: 64, z: 0 }, 3, after, null, true, true)
  const report = dangers => b.c.onDanger({ pos: ctx.pos.A.p, dangers })
  const flush = () => { while (queued.length) queued.shift()() }
  return { b, ctx, calls, aim, dodge, p, report, flush,
    advance: ms => { now += ms }, geometry: value => { geometry = value } }
}

for (const kind of ['act-ok', 'act-fail', 'act-error', 'dodge', 'dig', 'juke', 'fight', 'flee', 'lava', 'shield']) {
  test(`stale ${kind} cannot release or resume over a newer dodge`, async t => {
    const f = fixture(t)
    let oldAfter = 0, newAfter = 0
    if (kind === 'dodge' || kind === 'dig') {
      f.dodge(() => oldAfter++)
      if (kind === 'dig') { f.calls[0].reply({ ok: false, why: 'некуда' }); await turn() }
    } else if (kind === 'lava') {
      f.ctx.pos.A.inv.water_bucket = 1
      f.b.c.onDanger({ pos: f.p, dangers: { lava: [{ d: 1.4, at: { x: 1, y: 64, z: 0 } }] } })
    } else if (kind === 'shield') {
      f.ctx.pos.A.inv.shield = 1
      f.b.c.onDanger({ pos: f.p, dangers: { smashes: [{ name: 'Foe', ticks: 10, at: f.p }] } })
    } else {
      if (kind === 'juke') f.b.swarmTask = { kind: 'flee' }
      if (kind === 'flee') f.ctx.swarmDriver.panic = () => true
      f.aim()
      if (kind === 'fight') { f.calls[0].reply({ ok: true }); await turn() }
    }
    const old = f.calls.at(-1)
    const expected = kind.startsWith('act-') ? 'pearl_to' : kind === 'dodge' ? 'evade'
      : kind === 'dig' ? 'dig_to' : kind === 'lava' ? 'douse_lava' : kind === 'shield' ? 'swarm_hold' : kind
    assert.equal(old.method, expected)
    f.dodge(() => newAfter++)
    const fresh = f.calls.at(-1), count = f.calls.length
    if (kind === 'act-error') old.reject(new Error('cancelled by newer dodge'))
    else old.reply(kind === 'act-ok' ? { ok: true } : kind === 'dig' ? { dug: 1 }
      : { ok: false, why: 'некуда', segments: 0 })
    await turn()
    assert.equal(f.ctx.busy.has('A'), true, 'new dodge still owns busy')
    assert.equal(f.calls.length, count, 'no stale after, juke, dig or repeated evade')
    assert.equal(oldAfter, 0)
    fresh.reply({ ok: true })
    await turn()
    assert.equal(f.ctx.busy.has('A'), false)
    assert.equal(newAfter, 1)
    assert.equal(!!f.b.juking, false)
    assert.equal(!!f.b.lavaBusy, false)
    f.dodge()
    assert.equal(f.calls.at(-1).method, 'evade', 'the stale failure did not close the same exit')
    f.calls.at(-1).reply({ ok: true }); await turn()
  })
}

test('a stale act stays stale after the newer dodge has already finished', async t => {
  const f = fixture(t)
  f.aim()
  const old = f.calls[0]
  f.dodge()
  f.calls[1].reply({ ok: true })
  await turn()
  old.reply({ ok: false })
  await turn()
  assert.deepEqual(f.calls.map(c => c.method), ['pearl_to', 'evade'])
  assert.equal(f.ctx.busy.has('A'), false)
})

test('new projectile bypasses the previous projectile of the same kind, repeated reports do not', t => {
  const f = fixture(t)
  const arrow = x => ({ name: 'arrow', from: { x, y: 65, z: 10 }, at: f.p, ticks: 8, side: { x: 1, z: 0 } })
  f.report({ arrows: [arrow(10)] }); f.report({ arrows: [arrow(10)] })
  assert.equal(f.calls.length, 1)
  f.report({ arrows: [arrow(11)] })
  assert.equal(f.calls.length, 2, 'a new trajectory must not wait for a kind cooldown')
})

test('a continuous aim is one episode even after arbitrary wall time', async t => {
  const f = fixture(t)
  delete f.ctx.pos.A.inv.ender_pearl; delete f.ctx.pos.A.inv.bow; delete f.ctx.pos.A.inv.arrow
  f.b.swarmTask = { kind: 'flee' }
  f.aim(); f.calls[0].reply({ ok: true, segments: 3 }); await turn()
  f.advance(3600000)
  f.report({ aims: [{ name: 'Foe', weapon: 'trident', at: { x: 20, y: 64, z: 0 }, side: { x: 1, z: 0 } }] }); f.flush()
  assert.equal(f.calls.length, 1, 'a fresh timestamp is not a new aim')
  f.report({})
  f.report({ aims: [{ name: 'Foe', weapon: 'trident', at: { x: 20, y: 64, z: 0 }, side: { x: 1, z: 0 } }] }); f.flush()
  assert.equal(f.calls.length, 2, 'confirmed end and re-entry starts a new episode')
})

test('queued aim is cancelled by a clear observation or a new round', t => {
  const f = fixture(t)
  const aim = { name: 'Foe', weapon: 'trident', at: { x: 20, y: 64, z: 0 }, side: { x: 1, z: 0 } }
  f.report({ aims: [aim] }); f.report({}); f.flush()
  assert.equal(f.calls.length, 0)
  f.report({ aims: [aim] }); f.ctx.round++; f.flush()
  assert.equal(f.calls.length, 0)
})

test('unanswerable aim retreats from current risk without counting three timed polls', t => {
  const f = fixture(t)
  t.mock.method(Math, 'random', () => 0)
  f.ctx.pos.A.inv = {}; f.ctx.swarmDriver.canEngage = () => false
  f.aim()
  assert.equal(f.calls[0].method, 'juke')
  assert.equal(f.calls[0].params.retreat, true)
})

test('a failed dodge blocks only the same direction and stance; geometry or stance releases it', async t => {
  const f = fixture(t)
  const dodge = () => f.ctx.dodgeAway(f.b, f.p, { x: 2, y: 64, z: 0 }, 3, null, null, false, false)
  dodge(); f.calls[0].reply({ ok: false, why: 'некуда' }); await turn()
  f.advance(3600000); dodge(); await turn()
  assert.equal(f.calls.length, 1, 'elapsed time does not reopen the failed exit')
  f.ctx.dodgeAway(f.b, f.p, { x: 0, y: 64, z: 2 }, 3); await turn()
  assert.equal(f.calls.length, 2, 'another direction remains available')
  f.calls[1].reply({ ok: true }); await turn()
  f.geometry('air'); dodge(); await turn()
  assert.equal(f.calls.length, 3, 'a changed observed obstacle reopens the old exit')
  f.calls[2].reply({ ok: false, why: 'некуда' }); await turn()
  f.ctx.pos.A.p = { x: 3, y: 64, z: 0 }
  f.ctx.dodgeAway(f.b, f.ctx.pos.A.p, { x: 5, y: 64, z: 0 }, 3); await turn()
  assert.equal(f.calls.length, 4, 'a new approach can try immediately')
})

test('a second lingering area remains urgent while another area is being escaped', t => {
  const f = fixture(t)
  f.report({ clouds: [{ at: { x: 0, y: 64, z: 0 }, r: 3 }] })
  f.report({ clouds: [{ at: { x: 0, y: 64, z: 0 }, r: 3 }, { at: { x: 1, y: 64, z: 1 }, r: 3 }] })
  assert.equal(f.calls.length, 2)
})

test('a failed pearl is not retried from an unchanged approach, but an opened route retries immediately', async t => {
  const f = fixture(t)
  f.aim(); assert.equal(f.calls[0].method, 'pearl_to')
  f.calls[0].reply({ ok: false, why: 'нет броска' }); await turn()
  f.calls.at(-1).reply({ ok: true, segments: 2 }); await turn()
  f.advance(3600000); f.report({}); f.aim(); await turn()
  assert.equal(f.calls.filter(c => c.method === 'pearl_to').length, 1)
  f.calls.at(-1).reply({ ok: true, segments: 2 }); await turn()
  f.geometry('air'); f.report({}); f.aim(); await turn()
  assert.equal(f.calls.filter(c => c.method === 'pearl_to').length, 2)
})

test('in-flight pearl owns busy without an eight-second deadline and a late old-round reply cannot fight', async t => {
  const f = fixture(t)
  f.aim(); f.advance(3600000); f.report({}); f.aim()
  assert.equal(f.calls.filter(c => c.method === 'pearl_to').length, 1)
  f.ctx.round++; f.calls[0].reply({ ok: true }); await turn()
  assert.equal(f.calls.filter(c => c.method === 'fight').length, 0)
})

for (const [method, inv, random] of [
  ['fly_to', { elytra: 1, firework_rocket: 4 }, .55],
  ['wind_jump', { wind_charge: 2 }, .55],
  ['peek_shot', { bow: 1, arrow: 8 }, .8]
] as const) test(`${method}: an unchanged failed approach waits for world change, not its old cooldown`, async t => {
  const f = fixture(t)
  f.ctx.pos.A.inv = { ...inv }
  t.mock.method(Math, 'random', () => random)
  f.aim(); assert.equal(f.calls[0].method, method)
  if (method === 'fly_to') assert.ok(f.calls[0].params.arena, 'the flight keeps to the colosseum: out of it the driver kills as fallen')
  f.calls[0].reply({ ok: false, used: 0, why: 'потолок в 3 бл.' }); await turn()
  f.calls.at(-1).reply({ ok: true, segments: 2 }); await turn()
  f.advance(3600000); f.ctx.pos.A.inv.bread = 4; f.report({}); f.aim(); await turn()
  assert.equal(f.calls.filter(c => c.method === method).length, 1, 'unrelated stock and elapsed time do not open a ceiling')
  f.calls.at(-1).reply({ ok: true, segments: 2 }); await turn()
  f.geometry('air'); f.report({}); f.aim(); await turn()
  assert.equal(f.calls.filter(c => c.method === method).length, 2)
})

test('native item readiness remains a body check and never becomes a strategic delay', async t => {
  const f = fixture(t)
  f.aim(); f.calls[0].reply({ ok: false, why: 'cooldown' }); await turn()
  f.calls.at(-1).reply({ ok: true, segments: 1 }); await turn()
  f.report({}); f.aim(); await turn()
  assert.equal(f.calls.filter(c => c.method === 'pearl_to').length, 2)
})

test('failed juke chooses another exit instead of repeating the same impossible direction', async t => {
  const f = fixture(t)
  f.b.swarmTask = { kind: 'flee' }
  f.aim(); f.calls[0].reply({ ok: false, segments: 0, why: 'некуда' }); await turn()
  f.advance(3600000); f.report({}); f.aim(); await turn()
  assert.equal(f.calls.filter(c => c.method === 'juke').length, 1)
  assert.equal(f.calls.at(-1).method, 'take_cover')
})

// Выход из лавы (lava_escape, pvp/lava-exit) сам пересчитывает клетку выхода раз в 300 мс: другая клетка лавы его не
// перезапускает (перезапуск — отмена намерения и стоп клавиш; a39 — 🌋 ×5 за 3 с и смерть в яме). После выхода —
// реакции как прежде.
test('a lava escape is not restarted by another lava cell; after it, aim and cloud react as before', async t => {
  const f = fixture(t)
  f.ctx.pos.A.inv.water_bucket = 1
  const lava = x => ({ d: 1, at: { x, y: 64, z: 0 } })
  f.report({ lava: [lava(1)] }); f.report({ lava: [lava(2)] })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'lava_escape')
  f.calls[0].reply({ ok: true }); await turn()
  f.b.swarmTask = { kind: 'flee' }; f.aim()
  assert.equal(f.calls.at(-1).method, 'juke')
  f.report({ clouds: [{ at: f.p, r: 3 }] })
  assert.equal(f.calls.at(-1).method, 'evade')
})

test('a low-priority arrow does not restart a native pearl transaction', t => {
  const f = fixture(t)
  f.aim()
  f.report({ arrows: [{ name: 'arrow', from: { x: 10, y: 64, z: 1 }, at: f.p, ticks: 10, side: { x: 1, z: 0 } }] })
  assert.deepEqual(f.calls.map(c => c.method), ['pearl_to'])
})

test('an older status cannot clear a newer danger before its delayed reaction runs', t => {
  const f = fixture(t)
  f.advance(10)
  f.report({ aims: [{ name: 'Foe', weapon: 'trident', at: { x: 20, y: 64, z: 0 }, side: { x: 1, z: 0 } }] })
  f.b.c.onDanger({ pos: f.p, dangers: {}, observedAt: 10000, status: true })
  f.flush()
  assert.equal(f.calls[0].method, 'pearl_to')
})

test('checking a blocked pearl during one continuous aim does not keep restarting successful alternatives', async t => {
  const f = fixture(t)
  f.aim(); f.calls[0].reply({ ok: false, why: 'нет броска' }); await turn()
  f.calls.at(-1).reply({ ok: true, segments: 3 }); await turn()
  const check = async () => {
    f.b.c.onDanger({ pos: f.p, status: true, dangers: { aims: [{ name: 'Foe', weapon: 'trident', at: { x: 20, y: 64, z: 0 }, side: { x: 1, z: 0 } }] } })
    f.flush(); await turn()
  }
  await check()
  assert.deepEqual(f.calls.map(c => c.method), ['pearl_to', 'juke'])
  f.geometry('air'); await check()
  assert.equal(f.calls.at(-1).method, 'pearl_to', 'the changed corridor can retry during the same aim')
})

test('an aim observed during another owned operation reacts as soon as that owner releases', t => {
  const f = fixture(t)
  const aim = { name: 'Foe', weapon: 'trident', at: { x: 20, y: 64, z: 0 }, side: { x: 1, z: 0 } }
  f.ctx.busy.add('A'); f.report({ aims: [aim] }); f.flush()
  assert.equal(f.calls.length, 0)
  f.ctx.busy.delete('A'); f.report({ aims: [aim] }); f.flush()
  assert.equal(f.calls[0]?.method, 'pearl_to')
})

// Ноги в лаве — выход раньше уворота от зелья и стрейфа от прицела (a39: «🌋 0.0 → 🧪↯ рывок → ☠ в лаве»).
test('feet in lava: lava_escape goes before a potion dodge or an aim strafe', t => {
  const f = fixture(t)
  f.report({ potions: [{ name: 'splash_potion', at: f.p, ticks: 8 }], aims: [{ name: 'Foe', weapon: 'bow', at: { x: 20, y: 64, z: 0 }, side: { x: 1, z: 0 } }],
    lava: [{ d: 0, at: { x: f.p.x, y: 63, z: f.p.z } }] })
  f.flush()
  assert.deepEqual(f.calls.map(c => c.method), ['lava_escape'])
})

// Датчик даёт d = 0 и стоящему на краю ямы (рамка над лавой, ноги на полу): выход отвечает «не горит» — повтор только после
// сдвига, а не каждый опрос (a41 21.10: 1981 «🌋 0.0» у одного бота за минуту, бои срывались). Не вышел — снова сразу.
test('feet over lava but not burning: no instant re-run; a failed escape re-runs at once', async t => {
  const f = fixture(t)
  const over = { lava: [{ d: 0, at: { x: f.p.x, y: 63, z: f.p.z } }] }
  f.report(over); f.flush()
  assert.equal(f.calls.length, 1)
  f.calls[0].reply({ ok: true, why: 'не горит' }); await turn()
  f.report(over); f.flush(); f.report(over); f.flush()
  assert.equal(f.calls.length, 1, 'standing on the rim, not burning: the same episode waits for a move')
  const g = fixture(t)
  g.report(over); g.flush()
  g.calls[0].reply({ ok: false, why: 'не вышел' }); await turn()
  g.report(over); g.flush()
  assert.equal(g.calls.length, 2, 'still burning after the escape: again at once, wherever it stands')
})

test('a shield faces the drawn bow: an arrow without Piercing does not pass it (strafing caught 80 %)', t => {
  const f = fixture(t)
  f.ctx.pos.A.inv = { shield: 1 }
  f.aim()
  assert.equal(f.calls[0].method, 'swarm_hold')
  assert.ok(f.calls[0].params.shield && f.calls[0].params.requireShield, 'shield up, not a sneak hold')
  assert.deepEqual(f.calls[0].params.enemies, ['Foe'])
})

test('mace from above: the shield in the off hand is a shield — hold it on any lead, never a late dash, never re-raise', t => {
  // Пользователь 21.10: «в последний момент вместо щита убегать начинают — достаю и ваншот». Вторая рука в состоянии тела —
  // { item }, а не { name }: надетый щит читался как «нет щита», и вторая реакция была рывком.
  const f = fixture(t)
  f.ctx.pos.A.inv = {}
  f.ctx.pos.A.offHand = { item: 'shield', durability: 100 }
  f.report({ smashes: [{ name: 'Foe', ticks: 3, at: f.p }] })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'swarm_hold', 'late, but a dash would not take it out of his reach either')
  assert.ok(f.calls[0].params.shield && f.calls[0].params.requireShield)
  // «Порыв ветра» подкинул его снова — новая оценка посадки, а щит уже поднят: не перезапускать (5 т без блока).
  f.report({ smashes: [{ name: 'Foe', ticks: 30, at: f.p }] })
  f.report({ smashes: [{ name: 'Foe', ticks: 8, at: f.p }] })
  assert.equal(f.calls.length, 1, 'the running hold is kept')
})

test('a shield raised against a mace stays up when an arrow comes: no dodge out from under the smash', t => {
  const f = fixture(t)
  f.ctx.pos.A.offHand = { item: 'shield', durability: 100 }
  f.report({ smashes: [{ name: 'Foe', ticks: 16, at: f.p }] })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'swarm_hold')
  f.report({ arrows: [{ name: 'arrow', from: { x: 10, y: 64, z: 1 }, at: f.p, ticks: 10, side: { x: 1, z: 0 } }] })
  assert.equal(f.calls.length, 1, 'the arrow hits the shield; a step aside would take the smash')
})

test('floor taken from under the feet while a foe is near: step off at once, no drop, before a mace reaction', t => {
  // Пользователь 22.10: «ломаю блоки под ними — они в дырки улетают, ничего не делают».
  const f = fixture(t)
  f.ctx.pos.A.inv = { shield: 1 }
  f.report({ floor: [{ name: 'Foe', at: { x: 0.5, y: 63, z: 0.5 }, from: { x: 3, y: 64, z: 0 }, ticks: 0, holes: 2 }],
    smashes: [{ name: 'Foe', ticks: 10, at: f.p }] })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'evade', 'off the cracked floor first')
})
