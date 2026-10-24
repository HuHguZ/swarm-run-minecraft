import test from 'node:test'
import assert from 'node:assert/strict'
import { installDangers } from './arena/dangers'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmLifecycle } from './swarm/swarm-driver/lifecycle'

const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, extra = {}) {
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
    swarmDriver: { panic: () => false, canEngage: () => true }, log () {}, ...extra }
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

test('сообщение о спуске печатается без запуска новой реакции', t => {
  const lines: string[] = [], f = fixture(t, { log: line => lines.push(line), between: true })
  f.b.c.onDanger({ descent: { height: 7, technique: 'вода' } })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /7/)
  assert.match(lines[0], /вода/)
  assert.equal(f.calls.length, 0)
})

for (const kind of ['dodge', 'dig', 'lava', 'shield']) {
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
    }
    const old = f.calls.at(-1)
    const expected = kind === 'dodge' ? 'evade'
      : kind === 'dig' ? 'dig_to' : kind === 'lava' ? 'douse_lava' : kind === 'shield' ? 'swarm_hold' : kind
    assert.equal(old.method, expected)
    f.dodge(() => newAfter++)
    const fresh = f.calls.at(-1), count = f.calls.length
    old.reply(kind === 'dig' ? { dug: 1 } : { ok: false, why: 'некуда', segments: 0 })
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

for (const method of ['goto', 'fight', 'grab', 'ladder_up', 'fly_to']) test(`${method}: aim and flying projectiles leave the active action and its busy owner alone`, async t => {
  const f = fixture(t)
  const action = { m: method, p: { target: 'Foe', to: { x: 20, y: 68, z: 0 } }, pending: true }
  f.b.last = action
  if (method === 'goto' || method === 'ladder_up') f.b.climbing = true
  if (method === 'grab') f.b.grabbing = true
  const aim = { name: 'Foe', weapon: 'bow', at: { x: 20, y: 68, z: 0 }, side: { x: 1, z: 0 } }
  const arrow = { name: 'arrow', from: aim.at, at: f.p, ticks: 2, side: { x: 1, z: 0 } }
  const potion = { name: 'splash_potion', at: f.p, ticks: 3 }
  for (const owned of [false, true]) {
    if (owned) f.ctx.busy.add('A')
    for (let frame = 0; frame < 5; frame++) {
      f.report({ aims: [aim], arrows: [{ ...arrow, from: { ...aim.at, x: 20 + frame } }], potions: [potion] })
      f.flush(); f.advance(300)
    }
    await turn()
    assert.deepEqual(f.calls, [], 'уворот и щит принадлежат слою тела')
    assert.equal(f.b.last, action, 'цель и владелец дела сохранены')
    assert.equal(f.ctx.busy.has('A'), owned)
  }
})

test('pressure observations remain available to the planner, ignoring an older quiet status', t => {
  const f = fixture(t)
  f.advance(10)
  f.aim()
  assert.equal(f.b.arrowThreat.active, true)
  f.b.c.onDanger({ pos: f.p, dangers: {}, observedAt: 10000, status: true })
  assert.equal(f.b.arrowThreat.active, true)
  f.report({})
  assert.equal(f.b.arrowThreat.active, false)
  f.report({ potions: [{ name: 'splash_potion', at: f.p, ticks: 8 }] })
  assert.equal(f.b.arrowThreat.active, true, 'лут уступает и летящему зелью')
  f.ctx.between = true; f.report({})
  assert.equal(f.b.arrowThreat, undefined)
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

// Выход из лавы (lava_escape, pvp/lava-exit) сам пересчитывает клетку выхода раз в 300 мс: другая клетка лавы его не
// перезапускает (перезапуск — отмена намерения и стоп клавиш; a39 — 🌋 ×5 за 3 с и смерть в яме). После выхода —
// реакции как прежде.
test('a lava escape is not restarted by another lava cell; after it, aim stays passive and cloud is escaped', async t => {
  const f = fixture(t)
  f.ctx.pos.A.inv.water_bucket = 1
  const lava = x => ({ d: 1, at: { x, y: 64, z: 0 } })
  f.report({ lava: [lava(1)] }); f.report({ lava: [lava(2)] })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'lava_escape')
  f.calls[0].reply({ ok: true }); await turn()
  f.b.swarmTask = { kind: 'flee' }; f.aim()
  assert.equal(f.calls.length, 1, 'прицел не начинает отдельный RPC')
  f.report({ clouds: [{ at: f.p, r: 3 }] })
  assert.equal(f.calls.at(-1).method, 'evade')
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

test('landing web shares the mace hold, leaves fights and raised shields alone, then hands fresh defense to fight', async t => {
  const smash = { name: 'OtherSwarmBot', ticks: 30, at: { x: 1, y: 64, z: 0 } }
  const f = fixture(t)
  f.ctx.pos.A.inv = { shield: 1, cobweb: 1 }
  f.report({ smashes: [smash] })
  assert.equal(f.calls[0].method, 'swarm_hold')
  assert.equal(f.calls[0].params.webSmash, smash.name)
  assert.equal(f.calls[0].params.shield, true)
  f.report({ smashes: [{ ...smash, ticks: 32 }] })
  assert.equal(f.calls.length, 1, 'a new jump does not release the existing shield')
  f.calls[0].reply({ ok: true }); await turn()

  const fight = fixture(t)
  fight.ctx.pos.A.inv = { shield: 1, cobweb: 1 }
  fight.b.last = { m: 'fight', p: { target: smash.name }, pending: true }
  fight.report({ smashes: [smash] })
  assert.equal(fight.calls.length, 0, 'the fight owns its web and shield')
  fight.b.last.p.target = 'AnotherFoe'
  fight.report({ smashes: [{ ...smash, ticks: 31 }] })
  assert.equal(fight.calls[0].params.whileSmash, smash.name, 'a third enemy can smash during the duel')
  fight.calls[0].reply({ ok: true }); await turn()

  for (const elapsed of [100, 1000]) {
    const g = fixture(t)
    g.ctx.pos.A.inv = { cobweb: 1 }
    g.report({ smashes: [smash] })
    assert.equal(g.calls[0].method, 'swarm_hold')
    assert.equal(g.calls[0].params.webSmash, smash.name)
    assert.equal(g.calls[0].params.shield, false)
    g.advance(elapsed)
    g.calls[0].reply({ ok: true, web: { placed: true } }); await turn()
    assert.deepEqual(g.calls.map(c => c.method), ['swarm_hold', 'fight'], 'the body reads current threat after placement, without stale ETA')
    g.report({ smashes: [{ ...smash, ticks: 2 }] })
    g.report({ smashes: [{ ...smash, ticks: 36 }] })
    assert.equal(g.calls.length, 2, 'the follow-up fight survives both imminent landing and another wind jump')
    g.calls[1].reply({ ok: true }); await turn()
  }
})

for (const reject of [false, true]) test(`a ${reject ? 'rejected' : 'failed'} mace shield hands fresh defense to fight, without the original ETA`, async t => {
  const f = fixture(t)
  f.ctx.pos.A.inv = { shield: 1 }
  f.report({ smashes: [{ name: 'Foe', ticks: 2, at: f.p }] })
  f.advance(1000)
  if (reject) f.calls[0].reject(new Error('shield transaction failed'))
  else f.calls[0].reply({ ok: false, why: 'no_shield' })
  await turn()
  assert.deepEqual(f.calls.map(c => c.method), ['swarm_hold', 'fight'])
  assert.equal(f.ctx.busy.has('A'), true, 'the follow-up owns busy after the old hold finishes')
  f.calls[1].reply({}); await turn()
  assert.equal(f.ctx.busy.has('A'), false)
})

test('floor taken from under the feet while a foe is near: step off at once, no drop, before a mace reaction', t => {
  // Пользователь 22.10: «ломаю блоки под ними — они в дырки улетают, ничего не делают».
  const f = fixture(t)
  f.ctx.pos.A.inv = { shield: 1 }
  f.report({ floor: [{ name: 'Foe', at: { x: 0.5, y: 63, z: 0.5 }, from: { x: 3, y: 64, z: 0 }, ticks: 0, holes: 2 }],
    smashes: [{ name: 'Foe', ticks: 10, at: f.p }] })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'evade', 'off the cracked floor first')
  assert.equal(f.calls[0].params.maxDrop, 0)
})

test('a shield raised against a mace stays up when the floor cracks: a step off drops the shield under a one-shot', t => {
  // Игра пользователя 22.10: «пол уходит — схожу» 12 раз за секунду, щит опускался, убит булавой.
  const f = fixture(t)
  f.ctx.pos.A.offHand = { item: 'shield', durability: 100 }
  f.report({ smashes: [{ name: 'Foe', ticks: 16, at: f.p }] })
  assert.equal(f.calls[0].method, 'swarm_hold')
  f.report({ floor: [{ name: 'Foe', at: { x: 0.5, y: 63, z: 0.5 }, from: { x: 3, y: 64, z: 0 }, ticks: 0, holes: 1 }], smashes: [{ name: 'Foe', ticks: 10, at: f.p }] })
  assert.equal(f.calls.length, 1, 'the hold is kept')
})

function defenseDriver(f) {
  const task = { kind: 'heal', position: f.p, data: { ally: 'Ally', panic: true } }
  f.b.swarmExecuting = true
  f.b.swarmTask = { kind: 'fight', data: { target: 'Foe' } }
  return swarmTurn({ now: () => Date.now(), alive: () => true, log () {}, pos: f.ctx.pos,
    refresh: () => ({ member: {}, members: [], task, board: { enemies: () => [], tasks: () => [], facts: () => [] } }),
    say () {}, chestAtHand: () => false, onslaught: () => false })
}

test('mace defense inside fight survives phase changes, floor, nearby lava and the wind-bounce gap; landing releases it', async t => {
  const f = fixture(t), driver = defenseDriver(f)
  f.ctx.pos.A.inv = { shield: 1 }
  f.b.last = { m: 'fight', p: { target: 'Foe' }, pending: true }
  const smash = { name: 'Foe', ticks: 18, at: f.p }
  f.report({ smashes: [smash] })
  assert.equal(driver.preempt(f.b), false, 'fight already owns the shield: no stop')
  f.report({ smashes: [{ ...smash, ticks: 35 }],
    floor: [{ at: f.p, holes: 1 }], lava: [{ at: f.p, d: 1.4 }],
    aims: [{ name: 'Foe', weapon: 'bow', at: f.p }],
    arrows: [{ name: 'arrow', ticks: 3, at: f.p, side: { x: 1, z: 0 } }] })
  assert.equal(f.calls.length, 0, 'ETA growth and lower-priority hazards keep the same defense')
  f.report({})
  f.advance(900)
  await driver.turn(f.b)
  assert.equal(f.calls.length, 0, 'healing cannot enter a brief wind-bounce gap')
  assert.equal(driver.preempt(f.b), false)
  f.advance(101)
  assert.equal(driver.preempt(f.b), true, 'after calm, ordinary phase changes resume')
  assert.equal(f.calls[0].method, 'stop')
  f.calls[0].reply({}); await turn()
})

test('a pending evade is one mace response across ETA growth; completion hands continuous defense to fight before healing', async t => {
  const f = fixture(t), driver = defenseDriver(f)
  f.ctx.pos.A.inv = {}
  f.dodge()
  const evade = f.calls[0]
  const smash = { name: 'Foe', ticks: 30, at: f.p }
  f.report({ smashes: [smash] })
  f.report({ smashes: [{ ...smash, ticks: 40 }] })
  assert.deepEqual(f.calls.map(c => c.method), ['evade'], 'new ETA never cancels the running escape')
  assert.equal(driver.preempt(f.b), false)
  f.b.last.pending = false
  evade.reply({ ok: true }); await turn()
  await driver.turn(f.b)
  assert.deepEqual(f.calls.map(c => c.method), ['evade'], 'no heal between escape and continued defense')
  f.report({ smashes: [{ ...smash, ticks: 8 }] })
  assert.equal(f.calls[1]?.method, 'fight', 'handled episode still gets a continuous body response')
  assert.equal(f.calls[1].params.target, 'Foe')
  f.report({ smashes: [{ ...smash, ticks: 32 }] })
  assert.equal(f.calls.length, 2, 'the fight is kept through another wind jump')
  f.calls[1].reply({}); await turn()
})

test('a shieldless mace response starts continuous fight even when a one-shot dash is too late', t => {
  const f = fixture(t)
  f.ctx.pos.A.inv = {}
  f.report({ smashes: [{ name: 'Foe', ticks: 2, at: f.p }] })
  assert.equal(f.calls[0]?.method, 'fight')
  assert.equal(f.calls[0].params.target, 'Foe')
})

for (const danger of ['lava', 'blast']) test(`${danger} remains an emergency during a fight's mace defense`, t => {
  const f = fixture(t)
  f.b.last = { m: 'fight', p: { target: 'Foe' }, pending: true }
  const smashes = [{ name: 'Foe', ticks: 18, at: f.p }]
  f.report({ smashes })
  f.report({ smashes, ...(danger === 'lava' ? { lava: [{ d: 0, at: f.p }] } : { blasts: [{ at: f.p, fuse: 20, primed: true }] }) })
  assert.equal(f.calls[0]?.method, danger === 'lava' ? 'lava_escape' : 'dodge_blast')
})

test('a new arena round clears the old fight mace defense', t => {
  const f = fixture(t), driver = defenseDriver(f)
  f.b.last = { m: 'fight', p: { target: 'Foe' }, pending: true }
  f.report({ smashes: [{ name: 'Foe', ticks: 18, at: f.p }] })
  assert.equal(driver.preempt(f.b), false)
  f.ctx.round++
  f.report({})
  assert.equal(driver.preempt(f.b), true)
})

test('driver reset clears a mace response before the next round can take a turn', t => {
  const f = fixture(t)
  f.b.last = { m: 'fight', p: { target: 'Foe' }, pending: true }
  f.report({ smashes: [{ name: 'Foe', ticks: 18, at: f.p }] })
  assert.ok(f.b.maceDefense)
  const sw = createDriverState({ bots: [f.b], pos: f.ctx.pos, log () {}, alive: () => true })
  sw.retries = new Map(); sw.sites = new Map()
  swarmLifecycle(sw).reset()
  assert.equal(f.b.maceDefense, undefined)
})
