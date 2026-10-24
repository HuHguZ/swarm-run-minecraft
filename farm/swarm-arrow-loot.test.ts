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
  const f: any = { firing: false, calls: [], afterScan: null, afterWalk: null }
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
    now: () => 1000, log: () => {}, chestTops: [at], hideouts: [{ x: 20, y: 64, z: 0 }] })
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
    const pending = f.sw.grab(f.b, [{ id: 'Human', seenAt: 1000, sources: ['A'], position: { x: 6, y: 68, z: 0 } }])
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
