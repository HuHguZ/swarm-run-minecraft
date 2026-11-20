// Лестницу не рвёт небольшой пересчёт цены боя; новая опасность прерывает сразу.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessSwarmFight } from '../daemon/src/swarm'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'
import { createSwarmDriver } from './swarm/swarm-driver'
import { ladderUp } from '../daemon/src/ladder'

test('ladder phase hysteresis prices the accepted fight and yields to danger without a timer', async () => {
  let now = 1000, entered: () => void, finish: (r: any) => void
  const begun = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise(resolve => { finish = resolve })
  const calls: string[] = [], at = { x: .5, y: 64, z: 2.5 }
  const ladder = { id: 'ladder', kind: 'goto', data: { ladder: 'wall' }, position: at }
  const member: any = { id: 'A', team: 'blue', position: at, health: 40, maxHealth: 40, strength: 40,
    role: 'miner-builder', inventory: { iron_sword: 1, ladder: 32 }, armor: {} }
  const foe: any = { id: 'Foe', seenAt: now, sources: ['A'], position: { x: 14, y: 64, z: 2.5 }, equipment: { weapon: 'iron_sword' } }
  const enemies = [foe], initial = assessSwarmFight(member, enemies, [member])
  let retreat: any, task: any = { id: 'flee', kind: 'flee', data: { panic: true, risk: initial } }
  const board = { enemies: () => enemies, tasks: () => [], facts: () => [] }
  const context = { board, member, members: [member], get task() { return task } }
  const b: any = { name: 'A', swarmTask: ladder, swarmExecuting: true, c: { async call(method: string) {
    calls.push(method)
    if (method === 'status') return { state: { pos: at, health: member.health, inventory: member.inventory } }
    if (method === 'ladder_up') { entered(); return pending }
    return { detail: {} }
  } } }
  const sw: any = { now: () => now, pos: { A: { p: at, hp: member.health } }, alive: () => true, log: () => {},
    refresh: () => context, walls: new Map([['wall', { key: 'wall', x: 0, y: 64, z: 0, top: 70, face: { x: 0, z: 1 } }]]),
    siteOpen: () => true, siteFailed: () => {}, ladderRoutes: [], detail: r => r.detail || r,
    say: () => {}, onslaught: () => false, turnFlee: async () => { calls.push('flee-turn') } }
  const { preempt, turn } = swarmTurn(sw)
  const work = swarmTurnWork(sw).turnLadder({ b, task: ladder, member, context, enemies } as any)
  await begun
  try {
    const accepted = b.swarmLadder
    assert.equal(preempt(b), false, 'тот же мир не отменяет уже принятую стройку')
    const price = initial.duelKillSeconds ?? initial.killSeconds
    task.data.risk = { ...initial, duelKillSeconds: price * 1.2 }
    now += 60000; foe.seenAt = now
    assert.equal(preempt(b), false, 'запас цены держится по состоянию, а не первую секунду')
    task.data.risk = { ...initial, duelKillSeconds: price * 1.5 }
    assert.equal(preempt(b), true, 'ухудшившаяся цена боя перевешивает продолжение')
    retreat = b.swarmTask
    b.swarmTask = ladder; task.data.risk = initial
    member.health = 39
    assert.equal(preempt(b), true, 'потеря HP прерывает даже при здоровье выше стандартных 20')
    b.swarmTask = ladder; member.health = 40
    task.data.risk = { ...initial, lethal: true }
    assert.equal(preempt(b), true, 'смертельный размен не удерживается')
    b.swarmTask = ladder; task.data.risk = { ...initial, burst: true }
    assert.equal(preempt(b), true, 'первый смертельный залп не удерживается')
    b.swarmTask = ladder; task.data.risk = initial; foe.position.x = 7; foe.sources = []
    assert.equal(preempt(b), true, 'дошедший до стройки враг прерывает сразу')
    b.swarmTask = ladder; foe.position.x = 20; foe.sources = ['A']; foe.equipment.weapon = 'bow'
    assert.equal(preempt(b), true, 'свежий видимый лучник прерывает при прежней цене')
    b.swarmTask = ladder; foe.equipment.weapon = 'iron_sword'; foe.threat = 'bow'
    assert.equal(preempt(b), true, 'свежее наблюдение bow не теряется за старым equipment')
    b.swarmTask = ladder; foe.threat = 'blast'; foe.position.x = 7; foe.sources = []
    assert.equal(preempt(b), true, 'близкий взрыв прерывает и без личной видимости')
    foe.position.x = 20; foe.sources = ['A']; delete foe.threat
    b.swarmTask = ladder; foe.equipment.weapon = 'iron_sword'; member.maxHealth = 80
    assert.equal(preempt(b), true, 'ухудшение доли здоровья тоже прерывает стройку')
    member.maxHealth = 40
    for (const memory of [undefined, { hp: 40 }, { ...accepted, risk: { ...initial, duelKillSeconds: Infinity } },
      { ...accepted, risk: { ...initial, duelKillSeconds: NaN } }]) {
      b.swarmTask = ladder; b.swarmLadder = memory
      assert.equal(preempt(b), true, 'нет достоверной исходной цены — выполняю новый отход')
    }
    assert.equal(calls.filter(m => m === 'stop').length, 13)
  } finally {
    finish({ detail: { complete: false, why: 'конец теста' } })
    await work
  }
  assert.equal(b.swarmLadder, undefined, 'завершение работы убирает принятую цену')
  b.swarmTask = retreat; foe.position.x = 14
  const price = initial.duelKillSeconds ?? initial.killSeconds
  task = { ...ladder, data: { ...ladder.data, risk: { ...initial, duelKillSeconds: price * 1.5 } } }
  assert.equal(preempt(b), false, 'новый goto к той же лестнице не отменяет нужный отход')
  await turn(b)
  await turn(b)
  assert.deepEqual(calls.slice(-2), ['flee-turn', 'flee-turn'], 'после конца короткого flee следующий ход продолжает отход')
  task.data.risk = { ...initial, duelKillSeconds: price * 1.3 }
  assert.equal(preempt(b), false, 'небольшого улучшения цены для возврата недостаточно')
  member.health = 41; task.data.risk = { ...initial, lethal: true }
  assert.equal(preempt(b), false, 'лечение не возвращает на лестницу под ещё смертельный размен')
  task.data.risk = { ...initial, burst: true }
  assert.equal(preempt(b), false, 'лечение не возвращает под ещё смертельный залп')
  member.health = 40; task.data.risk = { ...initial, duelKillSeconds: price * 1.1 }
  assert.equal(preempt(b), true, 'заметное улучшение цены возвращает к работе без ожидания таймера')
  b.swarmTask = retreat; task.data.risk = { ...initial, duelKillSeconds: price * 1.5 }; foe.position.x = 40
  assert.equal(preempt(b), true, 'оторвались от прежнего врага — можно вернуться к работе')
  b.swarmTask = retreat; foe.position.x = 14; foe.sources = []
  assert.equal(preempt(b), true, 'прежний враг скрылся из личного вида — отход закончен')
  b.swarmTask = retreat; foe.sources = ['A']; member.health = 41
  assert.equal(preempt(b), true, 'здоровее при том же несмертельном риске — можно строить')
  b.swarmTask = retreat; member.health = 40; task.data.ladder = 'other-wall'
  assert.equal(preempt(b), true, 'другая лестница не наследует цену отказа старой')
  const driver = createSwarmDriver({ bots: [b], pos: { A: { p: at, hp: 40, inv: {} } }, alive: () => true,
    arena: { x: 0, y: 64, z: 0, r: 32 }, home: () => at, hostile: () => false, log: () => {} })
  b.swarmLadder = { hp: 40 }; b.swarmTask = { kind: 'flee', data: { ladderRetreat: {} } }
  driver.reset()
  assert.equal(b.swarmLadder, undefined, 'новый раунд убирает принятую цену незавершённой работы')
  assert.equal(b.swarmTask, undefined, 'новый раунд убирает цену обратной смены вместе с flee')
})

test('a worker halfway up its column uses only its remaining ladders and publishes once after native completion', async () => {
  const site = { key: 'resume', x: 0, y: 64, z: 0, top: 72, face: { x: 1, z: 0 } }
  const frame = { p: { x: 1.5, y: 68, z: .5 }, hp: 20, inv: { ladder: 4 } }, calls: string[] = []
  const member: any = { id: 'A', health: 20, position: frame.p, inventory: frame.inv }, task = { data: { ladder: site.key } }
  let complete = false, failures = 0
  const b: any = { name: 'A', c: { async call(method) {
    calls.push(method)
    if (method === 'status') return { state: { pos: frame.p, health: 20, inventory: frame.inv } }
    if (method === 'ladder_up') {
      frame.p = { x: complete ? .5 : 1.5, y: complete ? 73 : 70, z: .5 }; frame.inv.ladder = complete ? 0 : 2
      return { detail: { complete, placed: 2, at: frame.p, why: complete ? null : 'timeout' } }
    }
    return { detail: {} }
  } } }
  const sw: any = { now: () => 1000, alive: () => true, pos: { A: frame }, log() {}, walls: new Map([[site.key, site]]),
    ladderRoutes: [], siteOpen: () => true, siteFailed() { failures++ }, detail: r => r.detail || r, say2() {}, generation: 1 }
  const work = swarmTurnWork(sw), turn = () => work.turnLadder({ b, task, round: 1, member, enemies: [], context: { members: [member] } } as any)
  await turn()
  assert.deepEqual(calls, ['status', 'ladder_up'], 'the mid-column worker must not descend or craft the original nine ladders')
  assert.equal(sw.ladderRoutes.length, 0, 'a native partial column is not a team route')
  assert.equal(failures, 0, 'confirmed native construction continues through the ordinary next turn')
  complete = true
  await turn(); await turn()
  assert.equal(sw.ladderRoutes.length, 1)
  assert.equal(calls.filter(m => m === 'ladder_up').length, 2, 'the completed wall is not built or published twice')
})

test('a centered ladder worker reads precise physics instead of repeatedly centering its F3 cell', async () => {
  for (const initialStock of [9, 0]) {
    const site = { key: 'precise', x: 18000, y: 261, z: 18000, top: 269, face: { x: -1, z: 0 } }
    const floor = { x: 17998, y: 261, z: 18000 }, calls: any[] = []
    let precise = { x: 17998.5072, y: 261, z: 18000.5 }, stock = initialStock
    const member: any = { id: 'A', health: 20, position: floor, inventory: { ladder: stock } }
    const b: any = { name: 'A', c: { async call(method, params) {
      calls.push({ method, params })
      if (method === 'status') return { state: { pos: floor, health: 20, inventory: { ladder: stock } },
        detail: params?.physics ? { physics: { pos: precise } } : {} }
      if (method === 'craft') { stock = 9; precise = { ...precise, x: 17998.53 }; return { detail: { crafted: 9 } } }
      if (method === 'ladder_up') {
        const expected = Math.hypot(18000.5 - precise.x, 270 - precise.y, 18000.5 - precise.z)
        assert.ok(Math.abs(b.swarmAscent.left - expected) < 1e-9, 'ascent accounting uses the precise reply after any crafting refresh')
        return { detail: { complete: false, why: 'fixture finished' } }
      }
      return { detail: { arrived: params, ok: true, at: precise } }
    } } }
    const sw: any = { now: () => 1000, alive: () => true, pos: { A: { p: floor } }, log() {}, walls: new Map([[site.key, site]]),
      ladderRoutes: [], siteOpen: () => true, siteFailed() {}, detail: r => r.detail || r, say2() {}, generation: 1 }
    await swarmTurnWork(sw).turnLadder({ b, task: { data: { ladder: site.key } }, round: 1, member, enemies: [], context: { members: [member] } } as any)
    assert.deepEqual(calls.map(c => c.method), initialStock ? ['status', 'ladder_up'] : ['status', 'craft', 'status', 'ladder_up'])
    assert.ok(calls.filter(c => c.method === 'status').every(c => c.params.physics === true))
    assert.equal(sw.ladderRoutes.length, 0, 'reaching the placement RPC alone does not publish a route')
  }
})

test('native ladder resume skips the base entry only when the whole lower column exists', async () => {
  const { Vec3 } = require('../daemon/node_modules/vec3'), registry = require('../daemon/node_modules/prismarine-registry')('1.21.11')
  const Block = require('../daemon/node_modules/prismarine-block')(registry)
  for (const mode of ['partial', 'hole', 'ready']) {
    const built = new Set(Array.from({ length: mode === 'ready' ? 9 : 5 }, (_, k) => 64 + k).filter(y => mode !== 'hole' || y !== 67)), controls: any = {}
    let inventory = mode === 'ready' ? 0 : 4, earlyBaseSteps = 0
    const bot: any = { entity: { position: new Vec3(1.5, mode === 'ready' ? 64 : 68, .5), width: .6, height: 1.8 }, entities: {}, heldItem: { name: 'ladder' },
      inventory: { items: () => inventory ? [{ name: 'ladder', count: inventory }] : [] }, lookAt: async () => {},
      setControlState: (name, value) => { controls[name] = value },
      blockAt: p => {
        p = p.floored()
        const name = p.x === 0 && p.z === 0 && p.y >= 64 && p.y <= 72 ? 'stone' : p.x === 1 && p.z === 0 && built.has(p.y) ? 'ladder' : 'air'
        const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = p; return b
      },
      placeBlock: async b => { inventory--; built.add(b.position.y) },
      waitForTicks: async () => {
        const p = bot.entity.position
        if (controls.forward && controls.jump) p.y++
        else if (controls.forward && p.y >= 73) p.x = .5
        else if (controls.forward) earlyBaseSteps++
      }
    }
    const r = await ladderUp({ require: () => bot }, { onAbort: [] }, { wall: { x: 0, y: 64, z: 0 }, face: { x: 1, z: 0 }, top: 72 })
    assert.equal(earlyBaseSteps, mode === 'hole' ? 30 : 0, 'only an actual intact lower column permits skipping the initial base entry')
    assert.ok('complete' in r, 'native traversal must reach its full-column completion check')
    assert.equal(r.complete, mode !== 'hole', 'an unseen gap below the worker cannot become a complete route')
    if (mode !== 'hole') { assert.equal(r.placed, mode === 'ready' ? 0 : 4); assert.equal(r.ok, true) }
  }
})

test('native ladder travel keeps the arena across the whole column and its exit', async () => {
  const { Vec3 } = require('../daemon/node_modules/vec3'), registry = require('../daemon/node_modules/prismarine-registry')('1.21.11')
  const Block = require('../daemon/node_modules/prismarine-block')(registry)
  for (const mode of ['column', 'exit', 'body', 'late-exit', 'safe']) {
    const arena: any = mode === 'exit' ? { x: 4.5, z: .5, r: 5 } : mode === 'body' ? { x: -3.5, z: .5, r: 5.5 } : { x: 0, z: 0, r: 20 }
    if (mode === 'column') arena.avoid = [{ x: 1.5, y: 68, z: .5, r: 2 }]
    const controls: any = {}; let moved = 0
    const bot: any = { entity: { position: new Vec3(1.5, 64, .5), width: .6, height: 1.8 }, entities: {},
      inventory: { items: () => [] }, lookAt: async () => {},
      setControlState: (name, value) => { controls[name] = value },
      blockAt: p => {
        p = p.floored()
        const name = p.x === 0 && p.z === 0 && p.y >= 64 && p.y <= 72 ? 'stone' : p.x === 1 && p.z === 0 && p.y >= 64 && p.y <= 72 ? 'ladder' : 'air'
        const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = p; return b
      },
      waitForTicks: async () => {
        const p = bot.entity.position
        if (controls.forward && controls.jump) { p.y++; moved++ }
        else if (controls.forward) { p.x = .5; moved++ }
        if (mode === 'late-exit' && p.y >= 73) arena.avoid = [{ x: 1, y: 73, z: .5, r: .3 }]
      }
    }
    const r = await ladderUp({ require: () => bot }, { onAbort: [] }, { wall: { x: 0, y: 64, z: 0 }, face: { x: 1, z: 0 }, top: 72, arena })
    if (mode === 'safe') { assert.equal(r.ok, true); assert.ok('complete' in r); assert.equal(r.complete, true) }
    else {
      assert.equal(r.ok, false, mode + ' must not bypass the supplied arena')
      assert.match(r.why, /arena/, mode)
      assert.equal(moved, mode === 'late-exit' ? 9 : 0, 'reject the swept forbidden leg before moving: ' + mode)
    }
  }
})
