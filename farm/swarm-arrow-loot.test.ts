import test from 'node:test'
import assert from 'node:assert/strict'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmTeam } from './swarm/swarm-driver/team'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmLoot } from './swarm/swarm-driver/loot'
import { swarmClimb } from './swarm/swarm-driver/climb'
import { underArrowFire } from './swarm/swarm-driver/common'

function fixture () {
  const f: any = { now: 1000, firing: false, calls: [], afterScan: null, afterWalk: null }
  const at = { x: 3, y: 64, z: 0 }
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: { iron_sword: 1 }, armor: {} } }
  f.b = { name: 'A', team: 'blue', c: { async call (method, params: any = {}) {
    f.calls.push({ method, params })
    if (method === 'blocks_around') { f.afterScan?.(); return { detail: { found: [at] } } }
    if (method === 'chest_take') return { detail: { took: { diamond_chestplate: 1 } } }
    if (method === 'goto') { f.afterWalk?.(); return { status: 'done', detail: { arrived: at } } }
    return { detail: {} }
  } } }
  f.sw = createDriverState({ bots: [f.b], pos, alive: () => true, arms: true,
    arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => pos.A.p, hostile: () => false,
    now: () => f.now, log: () => {}, chestTops: [at], hideouts: [{ x: 20, y: 64, z: 0 }] })
  Object.assign(f.sw, swarmRetry(f.sw), swarmTeam(f.sw))
  Object.assign(f.sw, swarmMoves(f.sw))
  Object.defineProperty(f.b, 'arrowThreat', { get: () => ({ active: f.firing, at: 1000 }) })
  Object.assign(f.sw, swarmLoot(f.sw))
  f.board = f.sw.boardOf(f.b)
  f.board.setMembers(f.sw.membersOf(f.b))
  return f
}

test('под обстрелом лут под рукой, обход и копка ждут; в укрытии снова доступны', async () => {
  const f = fixture()
  f.firing = true
  assert.equal(f.sw.chestAtHand(f.b), false)
  assert.equal(await f.sw.loot(f.b, f.board, true), false)
  assert.equal(await f.sw.tour(f.b, f.board), false)
  assert.equal(await f.sw.cacheTurn(f.b, f.board), false)
  assert.equal(f.sw.cacheStats.calls, 0, 'копатель не начинает работу под стрелами')
  assert.deepEqual(f.calls, [], 'лут не сменяет действующую защиту своим RPC')
  f.firing = false
  assert.equal(f.sw.chestAtHand(f.b), true)
  assert.equal(await f.sw.loot(f.b, f.board, true), true)
  assert.ok(f.calls.some(c => c.method === 'chest_take'), 'без прицела предмет снова полезнее паузы')
})

test('прицел, появившийся во время обзора, не пропускает лут по старому решению', async () => {
  const f = fixture()
  f.afterScan = () => { f.firing = true }
  assert.equal(await f.sw.loot(f.b, f.board, true), false)
  assert.equal(f.calls.some(c => c.method === 'chest_take' || c.method === 'goto'), false)
})

test('cache miners choose a reachable entrance before starting the approach', async () => {
  // match5: repeated rejected entrance 587,128,557 with an enemy reported 13 blocks away.
  for (const visible of [true, false]) {
    const f = fixture(), p = { x: 598.5, y: 128, z: 557.5 }
    Object.assign(f.sw.arena, { x: 600.5, y: 120, z: 600.5, r: 80 })
    Object.assign(f.sw.pos.A, { p, inv: { iron_pickaxe: 1 } })
    f.b.swarmTask = { kind: 'loot', data: { weak: true } }
    if (visible) f.board.observe('A', 1000, { id: 'Foe', visible: true, position: { ...p, x: 585.5 } })
    const entrances = [{ x: 587, y: 128, z: 557 }, { x: 603, y: 128, z: 557 }]
    f.sw.cacheModelOf(f.b).planDig = (_me, { skip }) => {
      for (const from of entrances) {
        const to = { ...from, z: from.z + 3 }
        if (!skip(to, from)) return { from, to, rate: 100, exposed: [] }
      }
      return null
    }
    await f.sw.cacheTurn(f.b, f.board)
    assert.equal(f.calls.find(c => c.method === 'goto')?.params.x, visible ? 603.5 : 587.5)
  }
})

test('a cache allocation for twenty fighters reads one team observation snapshot', async () => {
  const f = fixture(), sw = f.sw
  f.b.swarmTask = { kind: 'fight' }
  sw.pos.A.inv = { iron_pickaxe: 1 }
  for (let i = 1; i < 20; i++) {
    const name = 'Miner' + i
    sw.bots.push({ ...f.b, name })
    sw.pos[name] = { ...sw.pos.A, p: { x: i, y: 64, z: 0 } }
  }
  let reads = 0
  const enemies = f.board.enemies.bind(f.board)
  f.board.enemies = () => { reads++; return enemies() }
  f.sw.cacheModelOf(f.b).planDig = () => null
  await f.sw.cacheTurn(f.b, f.board)
  assert.equal(reads, 1, 'sorting/eligibility and job scoring share a synchronous board snapshot')
})

test('31p retires a completed tunnel from the team snapshot before a second decision and can dig the next target', async t => {
  const f = fixture(), sw = f.sw
  const from = { x: 565, y: 123, z: 634 }, first = { ...from, z: 635 }, next = { ...from, x: 562 }
  Object.assign(sw.arena, { x: 600, y: 120, z: 600, r: 85 })
  sw.pos.A.p = { x: 565.5, y: 123, z: 634.5 }; sw.pos.A.inv = { iron_pickaxe: 1 }
  const m = sw.cacheModelOf(f.b)
  m.addScan({ n: 0, spin: 0, range: 8, hits: [], eye: sw.pos.A.p, chests: [[565, 126, 635], [562, 126, 634]] })
  m.refresh(true)
  const gain = to => m.dig(from, to).gain
  const initial = gain(first)
  assert.ok(initial > 0)
  // Two offered bearings in priority order. The real model prices each tunnel, the team allocates it and the body reports its feet.
  m.planDig = () => {
    for (const to of [first, next]) {
      const cut = m.dig(from, to)
      const cost = 1 + cut.solid * .65 + cut.dug.length / 4
      if (cut.gain > 0) return { from, to, exposed: cut.exposed, rate: cut.gain / cost }
    }
    return null
  }
  const destinations: number[][] = []
  f.b.c.call = async (method, params) => {
    if (method === 'dig_to') {
      const at = { x: Math.floor(params.at.x), y: Math.floor(params.at.y), z: Math.floor(params.at.z) }
      destinations.push([at.x, at.y, at.z])
      return { detail: { ok: true, at, steps: 1, dug: 2 } }
    }
    return { detail: {} }
  }
  assert.equal(await sw.cacheTurn(f.b, f.board), true)
  assert.equal(await sw.cacheTurn(f.b, f.board), true)
  assert.deepEqual(destinations, [[565, 123, 635], [562, 123, 634]])
  assert.equal(gain(first), 0)
  t.diagnostic('expected new discoveries in completed step: ' + initial.toFixed(4) + ' -> ' + gain(first))
})

test('31r releases a failed mine during the team scan and retries after the missing step changes', async () => {
  const from = { x: 628, y: 128, z: 646 }, to = { x: 628, y: 136, z: 648 }, foot = { ...from, z: 647 }
  for (const mode of ['restocked', 'ally built', 'lost stock', 'old floor removed', 'saw floor', 'no progress']) {
    const f = fixture(), sw = f.sw
    Object.assign(sw.arena, { x: 600, y: 120, z: 600, r: 85 })
    sw.pos.A.p = { x: 628.5, y: 128, z: 646.5 }; sw.pos.A.inv = { iron_pickaxe: 1 }
    if (mode === 'lost stock') sw.pos.A.inv.cobblestone = 1
    if (mode === 'old floor removed') sw.placed.set('blue', new Map([['628,128,647', { ...foot }]]))
    const ally = { ...f.b, name: 'Other' }
    sw.bots.push(ally); sw.pos.Other = { p: { ...sw.pos.A.p }, hp: 20, inv: {} }
    f.board.setMembers(sw.membersOf(f.b))
    sw.cacheModelOf(f.b).planDig = (_, { skip }) => skip(to, from) ? null : { from, to, rate: 100, exposed: [] }
    let attempts = 0, peerChecked = false, repaired = false
    f.b.c.call = async (method, params) => {
      if (method === 'dig_to') {
        attempts++
        return { detail: { at: from, steps: 0, dug: mode === 'no progress' ? 0 : 2,
          ...(mode === 'no progress' ? {} : { missingFooting: foot }), why: 'под ногами пусто, блоков нет' } }
      }
      if (method === 'cache_scan' && !peerChecked) {
        peerChecked = true; f.now += 2200
        await sw.cacheTurn(ally, f.board)
      }
      if (method === 'cache_scan' && repaired) {
        assert.deepEqual(params.checkFootings, [foot])
        return { detail: { hits: [], eye: sw.pos.A.p, standableFootings: [foot] } }
      }
      return { detail: {} }
    }
    await sw.cacheTurn(f.b, f.board)
    await sw.cacheTurn(f.b, f.board)
    assert.equal(attempts, 1, mode + ': an allied replan during the final scan must not revive the rejected job')
    if (mode === 'no progress') continue
    sw.placed.set('blue', new Map([['628,128,648', to]]))
    if (mode === 'lost stock') delete sw.pos.A.inv.cobblestone
    sw.pos.A.inv.sand = 4; f.now += 2200
    await sw.cacheTurn(f.b, f.board); assert.equal(attempts, 1, 'a different placement and falling sand do not fix the gap')
    if (mode === 'saw floor') {
      repaired = true; f.now += 21000
      sw.cacheModelOf(f.b).addScan = () => {}
      sw.cacheObserve(f.b); await new Promise(resolve => setImmediate(resolve))
    } else if (mode === 'restocked') sw.pos.A.inv.cobblestone = 1
    else sw.placed.get('blue').set('628,128,647', { ...foot })
    f.now += 2200; await sw.cacheTurn(f.b, f.board)
    assert.equal(attempts, 2, mode)
  }
})

for (const blocked of [false, true]) test(`31t uses the priced walk to a remote cache entrance: ${blocked ? 'no path' : 'walkable detour'}`, async () => {
  const f = fixture(), sw = f.sw, from = { x: 590, y: 135, z: 648 }, to = { x: 588, y: 131, z: 650 }
  const start = { x: 644.27, y: 127, z: 624.7 }, entry = { x: from.x + .5, y: from.y, z: from.z + .5 }
  const seconds = Math.ceil(Math.hypot(entry.x - start.x, entry.y - start.y, entry.z - start.z) * 1.5 / 4)
  Object.assign(sw.arena, { x: 600, y: 120, z: 600, r: 85 })
  sw.pos.A.p = start; sw.pos.A.inv = { iron_pickaxe: 1 }
  sw.cacheModelOf(f.b).planDig = (_, { skip }) => skip(to, from) ? null : { from, to, rate: 3, exposed: [] }
  let walks = 0, digs = 0, budget = 0
  f.b.c.call = async (method, params) => {
    if (method === 'goto') {
      walks++; budget = params.timeoutSeconds
      if (blocked) return { status: 'failed', code: 'NO_PATH', state: { pos: start } }
      if (budget < seconds) return { status: 'timeout', state: { pos: start } }
      sw.pos.A.p = entry
      return { status: 'done', detail: { arrived: entry } }
    }
    if (method === 'dig_to') { digs++; return { detail: { ok: true, at: to, dug: 2, steps: 1 } } }
    return { detail: {} }
  }
  await sw.cacheTurn(f.b, f.board)
  await sw.cacheTurn(f.b, f.board)
  assert.equal(walks, 1)
  assert.equal(digs, blocked ? 0 : 1, `selected a ${seconds}s detour but issued only ${budget}s`)
  if (!blocked) assert.equal(budget, seconds)
})

test('after a cache walk timeout the next status at the reported endpoint does not reopen neighbouring entrances', async () => {
  const f = fixture(), sw = f.sw, from = { x: 589, y: 134, z: 647 }, to = { x: 588, y: 131, z: 650 }
  const start = { x: 644.27, y: 127, z: 624.7 }, stop = { x: 615.09, y: 127, z: 640.57 }
  Object.assign(sw.arena, { x: 600, y: 120, z: 600, r: 85 })
  Object.assign(sw.pos.A, { p: start, frame: 100, clockId: 'miner', inv: { iron_pickaxe: 1 } })
  const entrance = [{ from, to }, { from: { x: 590, y: 135, z: 648 }, to: { ...to, y: 132 } }]
  sw.cacheModelOf(f.b).planDig = (_, { skip }) => {
    const entry = entrance.find(p => !skip(p.to, p.from))
    return entry && { ...entry, rate: 3, exposed: [] }
  }
  let walks = 0
  f.b.c.call = async method => {
    if (method !== 'goto') return { detail: {} }
    walks++
    return { status: 'timeout', state: { pos: stop, physicsTicks: 150, clock: { id: 'miner' } } }
  }
  await sw.cacheTurn(f.b, f.board)
  // The ordinary status poll catches up without the miner actually taking a further step.
  Object.assign(sw.pos.A, { p: { ...stop }, frame: 151 })
  f.now += 2200
  await sw.cacheTurn(f.b, f.board)
  assert.equal(walks, 1)
  sw.pos.A.p = { ...stop, x: stop.x + 3 }; f.now += 2200
  await sw.cacheTurn(f.b, f.board)
  assert.equal(walks, 2, 'a genuinely different approach can be tried')
})
for (const mode of ['older frame', 'other body', 'refused before start']) test(`a cache approach discards a stale endpoint: ${mode}`, async () => {
  const f = fixture(), sw = f.sw, start = { x: 0, y: 64, z: 0 }, from = { x: 20, y: 64, z: 0 }, to = { x: 24, y: 64, z: 0 }
  Object.assign(sw.pos.A, { p: start, clockId: 'current', frame: 100, inv: { iron_pickaxe: 1 } })
  sw.cacheModelOf(f.b).planDig = (_, { skip }) => !skip(to, from) && { from, to, rate: 3, exposed: [] }
  let walks = 0
  f.b.c.call = async method => {
    if (method !== 'goto') return { detail: {} }
    walks++
    return { status: 'failed', notStarted: mode === 'refused before start',
      state: { pos: from, physicsTicks: mode === 'older frame' ? 99 : 101, clock: { id: mode === 'other body' ? 'previous' : 'current' } } }
  }
  await sw.cacheTurn(f.b, f.board); await sw.cacheTurn(f.b, f.board)
  assert.deepEqual(sw.pos.A.p, start)
  assert.equal(walks, 2, 'a stale or refused walk does not rule out the route from the current body')
})

test('an obsolete miner approach cannot blacklist the same entrance in a new round', async () => {
  const f = fixture()
  f.sw.pos.A.inv = { iron_pickaxe: 1 }
  f.sw.cacheModelOf(f.b).planDig = () => ({ from: { x: 6, y: 64, z: 0 }, to: { x: 8, y: 64, z: 0 }, rate: 100, exposed: [] })
  f.b.c.call = async method => {
    assert.equal(method, 'goto')
    f.sw.generation++
    return { status: 'failed', detail: { why: 'old arena was reset' } }
  }
  await f.sw.cacheTurn(f.b, f.board)
  assert.equal(f.sw.retries.size, 0)
})

test('round changes while opening a cache or inspecting its loot cancel further physical actions', async () => {
  for (const resetOn of ['chest_take', 'armor', 'status']) {
    const f = fixture(), me = f.sw.pos.A.p
    f.sw.pos.A.inv = { iron_pickaxe: 1 }
    f.b.swarmTask = { kind: 'loot', data: { weak: true } }
    f.board.observe('A', f.now, { id: 'Foe', visible: true, position: { x: 25, y: 64, z: 0 } })
    const model = f.sw.cacheModelOf(f.b)
    model.planDig = () => ({ from: me, to: { ...me, z: 6 }, rate: 100, exposed: [] })
    model.addScan = () => {}
    const actions = []
    f.b.c.call = async (method, params) => {
      actions.push(method)
      if (method === resetOn) f.sw.generation++
      if (method === 'dig_to') {
        assert.deepEqual(params.arena, f.sw.lootArena(f.b))
        assert.equal(params.arena.avoid[0].x, 25)
        return { detail: { steps: 1, dug: 1 } }
      }
      if (method === 'cache_scan') return { detail: { hits: [], eye: me, chests: [[1, 64, 0]] } }
      if (method === 'chest_take' && resetOn !== 'chest_take') return { detail: { contents: {}, took: { mace: 1 } } }
      if (method === 'status') return { state: { inventory: { mace: 1 } } }
      return { detail: {} }
    }
    await f.sw.cacheTurn(f.b, f.board)
    assert.equal(actions.at(-1), resetOn)
    assert.deepEqual(f.sw.pos.A.inv, { iron_pickaxe: 1 }, 'old loot cannot replace the new inventory')
    assert.equal(f.sw.retries.size, 0)
  }
})

test('the four-plan budget eventually reaches a miner in the last part of the roster', async () => {
  const f = fixture(), sw = f.sw, attempts: number[] = []
  sw.pos.A.inv = { iron_pickaxe: 1 }
  for (let i = 1; i < 20; i++) {
    const name = 'Miner' + String(i).padStart(2, '0')
    sw.bots.push({ ...f.b, name })
    sw.pos[name] = { ...sw.pos.A, p: { x: i, y: 64, z: 0 } }
  }
  const miner = sw.bots.at(-1)
  sw.cacheModelOf(miner).planDig = me => {
    attempts.push(me.x)
    return me.x === 19 ? { from: { ...me, x: 24 }, to: { ...me, x: 25 }, rate: 10, exposed: [] } : null
  }
  for (let poll = 0; poll < 5; poll++) {
    f.now += 2000
    const start = attempts.length
    await sw.cacheTurn(miner, f.board)
    assert.equal(attempts.length - start, 4)
  }
  assert.deepEqual([...new Set(attempts)].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i))
  assert.ok(f.calls.some(c => c.method === 'goto' && c.params.x === 24.5))
})

test('прицел, появившийся на подходе, не пропускает открытие сундука', async () => {
  const f = fixture()
  f.sw.pos.A.p.x = -3
  f.afterWalk = () => { f.firing = true }
  assert.equal(await f.sw.loot(f.b, f.board, true), false)
  assert.equal(f.calls.some(c => c.method === 'chest_take'), false)
  assert.ok(f.board.tasks().every(t => !t.claim), 'бронь освобождена')
})

test('опасность стрел нужна свежая; тихое наблюдение снимает её сразу', () => {
  const b = { arrowThreat: { at: 1000, active: true } }
  assert.equal(underArrowFire(b, 1200), true)
  assert.equal(underArrowFire(b, 3000), false)
  assert.equal(underArrowFire(b, 500), false)
  b.arrowThreat.active = false
  assert.equal(underArrowFire(b, 1001), false)
  assert.equal(underArrowFire({}, 1001), false)
})

test('подбор нагрудника в 1.3 бл. не обрывает выход из линии лучника в 6 бл.', async t => {
  for (const phase of ['active', 'scan', 'walk', 'quiet']) await t.test(phase, async () => {
    const f = fixture(), item = { id: 7, name: 'netherite_chestplate', at: { x: 1.3, y: 64, z: 0 }, d: 1.3 }
    let release: any, failures = 0
    const gate = new Promise(resolve => { release = resolve })
    f.firing = phase === 'active'
    f.sw.failed = () => { failures++ }
    f.b.c.call = async (method, params = {}) => {
      f.calls.push({ method, params })
      if (method === 'items_near') { if (phase === 'scan') await gate; return { detail: { items: [item] } } }
      if (method === 'goto') { if (phase === 'walk') await gate; return { status: 'done', detail: { arrived: item.at } } }
      if (method === 'assist') { f.sw.pos.A.inv.netherite_chestplate = 1; return { detail: { ok: true } } }
      if (method === 'status') return { state: { inventory: f.sw.pos.A.inv, armor: {} } }
      return { detail: {} }
    }
    Object.assign(f.sw, swarmClimb(f.sw))
    f.board.observe('A', 1000, { id: 'Human', visible: true, position: { x: 6, y: 68, z: 0 } })
    const pending = f.sw.grab(f.b, f.board)
    if (phase === 'scan' || phase === 'walk') {
      await new Promise(resolve => setImmediate(resolve))
      f.firing = true
      release()
    }
    assert.equal(await pending, phase === 'quiet')
    assert.equal(f.calls.some(c => c.method === 'items_near'), phase !== 'active')
    assert.equal(f.calls.some(c => c.method === 'goto'), phase === 'walk' || phase === 'quiet')
    assert.equal(f.calls.some(c => c.method === 'assist'), phase === 'quiet')
    assert.equal(!!f.b.climbing, false, 'подбор отпускает владение движением')
    assert.equal(failures, 0, 'новый обстрел не портит запись о доступной вещи')
  })
})

test('a missing body position cannot start a ground-item scan or be restored by a late pickup receipt', async () => {
  for (const phase of ['before', 'status']) {
    const f = fixture(), calls = []
    Object.assign(f.sw, swarmClimb(f.sw))
    const item = { id: 7, name: 'iron_helmet', d: 1, at: { x: 1, y: 64, z: 0 } }
    if (phase === 'before') delete f.sw.pos.A
    f.b.c.call = async m => {
      calls.push(m)
      if (m === 'items_near') return { detail: { items: [item] } }
      if (m === 'goto') return { status: 'done', detail: { arrived: item.at } }
      if (m === 'status') { delete f.sw.pos.A; return { state: { inventory: { iron_helmet: 1 } } } }
      return { detail: { ok: true } }
    }
    assert.equal(await f.sw.grab(f.b, f.board), false)
    assert.deepEqual(calls, phase === 'before' ? [] : ['items_near', 'goto', 'assist', 'status'])
    assert.equal(f.sw.pos.A, undefined)
  }
})

test('ground loot yields to a newly observed swordsman and late receipts cannot equip the next life', async t => {
  for (const phase of ['scan', 'walk', 'round', 'status']) await t.test(phase, async () => {
    const f = fixture(), item = { id: 7, name: 'diamond_chestplate', at: { x: 1, y: 64, z: 0 }, d: 1 }
    const calls = [], old = f.b.swarmTurnOwner = {}
    const sight = () => f.board.observe(f.b.name, f.now, { id: 'Sword', visible: true,
      position: { x: 2, y: 64, z: 0 }, equipment: { weapon: 'netherite_sword', armor: [] } })
    const replace = () => {
      f.sw.generation++; f.b.swarmTurnOwner = {}
      f.b.climbing = true; f.b.grabbing = 'new action'
      f.sw.pos.A.inv = { bread: 1 }
    }
    Object.assign(f.sw, swarmClimb(f.sw))
    f.b.c.call = async m => {
      calls.push(m)
      if (m === 'items_near') { if (phase === 'scan') sight(); return { detail: { items: [item] } } }
      if (m === 'goto') {
        if (phase === 'walk') sight()
        if (phase === 'round') replace()
        return { status: 'done', detail: { arrived: item.at } }
      }
      if (m === 'status') { if (phase === 'status') replace(); return { state: { inventory: { diamond_chestplate: 1 } } } }
      return { detail: { ok: true } }
    }
    await f.sw.grab(f.b, f.board)
    assert.deepEqual(calls, phase === 'scan' ? ['items_near'] : phase === 'status' ? ['items_near', 'goto', 'assist', 'status'] : ['items_near', 'goto'])
    if (f.b.swarmTurnOwner !== old) {
      assert.deepEqual(f.sw.pos.A.inv, { bread: 1 })
      assert.equal(f.b.climbing, true)
      assert.equal(f.b.grabbing, 'new action')
    }
  })
})

test('подъём за лутом можно прервать стрелами без запоминания неудачи маршрута', async t => {
  for (const method of ['pearl', 'goto']) await t.test(method, async () => {
    const f = fixture(), high = { x: 20, y: 74, z: 0, climbFrom: 64 }
    f.sw.chestTops.splice(0)
    f.sw.hideouts.splice(0, f.sw.hideouts.length, high)
    f.sw.pos.A.inv.cobblestone = 32
    let release: any, failures = 0
    const gate = new Promise(resolve => { release = resolve })
    f.sw.failed = () => { failures++ }
    f.sw.pearlUp = async () => {
      if (method !== 'pearl') return null
      f.b.climbing = true
      try { await gate; return null } finally { f.b.climbing = false }
    }
    f.b.c.call = async action => {
      f.calls.push({ method: action })
      if (action === 'goto') { await gate; return { detail: { why: 'cancelled' } } }
      return { detail: {} }
    }
    const pending = f.sw.tour(f.b, f.board)
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(f.b.grabbing, true, 'это подъём ради лута: щит и укрытие имеют право его отменить')
    } finally { f.firing = true; release() }
    assert.equal(await pending, true)
    assert.equal(!!f.b.grabbing, false)
    assert.equal(!!f.b.climbing, false)
    assert.equal(failures, 0, 'прицел не делает хороший маршрут недоступным')
    if (method === 'pearl') assert.equal(f.calls.some(c => c.method === 'goto'), false, 'после отмены жемчуга защиту не рвёт новый поход')
  })
})

test('свежий прицел между расчётом и броском жемчуга не отменяет защиту новым действием', async t => {
  for (const method of ['pearl_plan', 'pearl_up']) await t.test(method, async () => {
    const f = fixture()
    f.sw.pos.A.inv.ender_pearl = 1
    f.sw.surfaceY = () => 64
    let release: any, failures = 0
    const gate = new Promise(resolve => { release = resolve })
    f.sw.failed = () => { failures++ }
    f.b.c.call = async action => {
      f.calls.push({ method: action })
      if (action === method) await gate
      if (action === 'pearl_plan') return { detail: { ok: true } }
      if (action === 'pearl_up') return { detail: { ok: false, stop: 'нет броска' } }
      if (action === 'goto') return { status: 'done', detail: { arrived: { x: 14.5, y: 64, z: .5 } } }
      return { detail: {} }
    }
    Object.assign(f.sw, swarmClimb(f.sw))
    const pending = f.sw.pearlUp(f.b, { x: 40, y: 80, z: 0 })
    await new Promise(resolve => setImmediate(resolve))
    f.firing = true
    release()
    assert.deepEqual(await pending, { moved: true })
    if (method === 'pearl_plan') assert.equal(f.calls.some(c => c.method === 'pearl_up'), false)
    assert.equal(f.calls.some(c => c.method === 'goto'), false)
    assert.equal(!!f.b.climbing, false)
    assert.equal(failures, 0)
  })
})
