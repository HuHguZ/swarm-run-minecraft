import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../daemon/src/swarm/board'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmLoot } from './swarm/swarm-driver/loot'
import { swarmMoves } from './swarm/swarm-driver/moves'

function scene(chest = { x: 12, y: 64, z: 0 }) {
  let clock = 1000
  const places = [.5, 6.5].map(dx => ({ x: chest.x + dx, y: chest.y, z: chest.z + .5, tier: 3 }))
  const world: { contents: Record<string, number>; found?: (name: string) => any[]; take?: (name: string) => any } = { contents: { iron_sword: 1 } }
  const calls: any[] = []
  const pos: any = {}
  const bots = ['Scout', 'Courier', 'Reserve', 'Rival'].map(name => {
    const p = name === 'Scout' ? { ...places[0] } : { x: .5, y: 64, z: .5 }
    pos[name] = { p, hp: 20, inv: {}, armor: {} }
    return { name, team: name === 'Rival' ? 'red' : 'blue', c: { async call(method, params) {
      calls.push({ name, method, params })
      if (method === 'blocks_around') return { detail: { found: world.found?.(name) || [chest] } }
      if (method === 'chest_take') {
        if (world.take) return world.take(name)
        const took = name === 'Courier' ? { ...world.contents } : {}
        for (const [item, count] of Object.entries(took)) {
          pos[name].inv[item] = (pos[name].inv[item] || 0) + count
          delete world.contents[item]
        }
        return { status: 'done', detail: { at: chest, contents: { ...world.contents }, took } }
      }
      if (method === 'goto') {
        pos[name].p = { x: params.x, y: params.y, z: params.z }
        return { status: 'done', detail: { arrived: pos[name].p } }
      }
      return { status: 'done', detail: {} }
    } } }
  })
  const sw = createDriverState({ bots, pos, alive: () => true, arms: true, now: () => clock,
    arena: { x: chest.x - 12, y: chest.y, z: chest.z, r: 100 }, chestTops: places, log() {} })
  const boards = new Map(['red', 'blue'].map(t => {
    const board = new SwarmBoard(t, sw.now)
    board.setMembers(bots.filter(b => b.team === t).map(b => ({ id: b.name, team: t,
      position: pos[b.name].p, role: 'fighter', health: 20, strength: 20 })))
    return [t, board] as const
  }))
  Object.assign(sw, { boardOf: b => boards.get(b.team), teamOf: b => b.team, blocked: () => false })
  Object.assign(sw, swarmMoves(sw))
  Object.assign(sw, swarmLoot(sw))
  const [scout, courier, reserve, rival] = bots
  const offer = b => sw.lootOffer(b, sw.boardOf(b))?.position
  const seen = async () => {
    await sw.tour(scout, sw.boardOf(scout)) // already at the first site, publishes a completed visit
    await sw.loot(scout, sw.boardOf(scout), true)
    assert.ok(calls.some(c => c.method === 'chest_take' && c.params.visibleOnly && c.params.stay))
  }
  return { sw, pos, places, chest, calls, world, scout, courier, reserve, rival, offer, seen, advance: n => { clock += n } }
}

test('a scout relays a leftover weapon at a visited chest to one unequipped ally', async () => {
  const f = scene()
  f.pos.Scout.inv = { diamond_sword: 1 }
  await f.seen()
  assert.deepEqual(f.offer(f.courier), f.places[0], 'the confirmed weapon reopens the visited destination')
  f.pos.Reserve.inv = { diamond_sword: 1 }
  assert.deepEqual(f.offer(f.reserve), f.places[1], 'an equipped ally keeps its own tour')
  f.pos.Reserve.inv = {}
  await f.sw.tour(f.courier, f.sw.boardOf(f.courier))
  assert.equal(f.calls.find(c => c.method === 'goto' && c.name === 'Courier')?.params.x, f.places[0].x)
  assert.deepEqual(f.offer(f.reserve), f.places[1], 'arrival alone must not send the next ally after the same sword')
  assert.equal(await f.sw.loot(f.courier, f.sw.boardOf(f.courier), true), true)
  assert.equal(f.pos.Courier.inv.iron_sword, 1)
  assert.deepEqual(f.offer(f.reserve), f.places[1], 'the receiver now reports the chest empty')
})

test('a confirmed empty chest is shared only between allies until refill', async () => {
  const f = scene()
  f.world.contents = {}
  await f.seen()
  f.advance(60000)
  assert.deepEqual(f.offer(f.courier), f.places[1])
  assert.deepEqual(f.offer(f.rival), f.places[0], 'the rival never opened the chest')
  f.sw.refill(f.chest)
  assert.deepEqual(f.offer(f.courier), f.places[0])
})

// Fields from NeuroFarm31y's own chest_take reply at 1794575448485 in match Q.
const upper = { x: 664, y: 150, z: 578 }
const upperItems = { bow: 1, arrow: 32, trident: 1, netherite_sword: 1, netherite_boots: 1, netherite_helmet: 1,
  diamond_chestplate: 1, netherite_leggings: 1, tipped_arrow: 8, milk_bucket: 1, honey_bottle: 2, golden_apple: 4,
  ender_pearl: 2, tnt: 3, fire_charge: 4, flint_and_steel: 1, water_bucket: 1, cobweb: 4, splash_potion: 2 }
const partial = (at, contents) => ({ status: 'interrupted', by: { type: 'cancelled', by: 'stop' }, partial: true,
  detail: { at, kind: 'chest', contents, full: true, took: {}, free: 6 } })
const report = f => f.sw.knownChests.get('blue')?.get(`chest:${f.chest.x},${f.chest.y},${f.chest.z}`)?.report

test('the guard remembers the actual Q window after a cancelled transfer without continuing the action', async () => {
  for (const cancelOwner of [true, false]) {
    const f = scene(upper), b: any = f.scout
    b.swarmTurnOwner = { cancelled: false }
    f.world.take = () => {
      b.swarmTurnOwner.cancelled = cancelOwner
      return partial(upper, upperItems)
    }
    assert.equal(await f.sw.loot(b, f.sw.boardOf(b), true), false)
    assert.deepEqual(report(f)?.items, Object.keys(upperItems))
    assert.equal(report(f)?.by, b.name)
    assert.deepEqual(f.calls.map(c => c.method), ['blocks_around', 'chest_take'])
    assert.equal(f.sw.fullFor.size, 0, 'an interrupted visit must not suppress another visit on the same bag')
  }
})

test('partial windows distinguish an empty chest from an unknown, different or obsolete window', async () => {
  for (const mode of ['empty', 'missing', 'different', 'fractional', 'malformed', 'round', 'refill']) {
    const f = scene(upper)
    f.world.take = () => {
      if (mode === 'round') f.sw.generation++
      if (mode === 'refill') f.sw.refill(upper)
      const at = { ...upper, x: upper.x + (mode === 'different' ? 1 : mode === 'fractional' ? .5 : 0) }
      return partial(at, mode === 'empty' ? {} : mode === 'missing' ? undefined : mode === 'malformed' ? [] : upperItems)
    }
    await f.sw.loot(f.scout, f.sw.boardOf(f.scout), true)
    assert.deepEqual(report(f)?.items, mode === 'empty' ? [] : undefined, mode)
  }
})

async function delayedUpperVisit(status: string) {
  const f = scene(upper), board = f.sw.boardOf(f.scout)
  let reached: () => void, close: () => void
  const opened = new Promise<void>(r => { reached = r })
  const old = new Promise<void>(r => { close = r })
  f.pos.Courier.p = { ...f.places[0] }
  f.world.take = async name => {
    if (name === f.courier.name) return { status: 'done', detail: { at: upper, contents: {}, took: {} } }
    reached()
    await old
    return { ...partial(upper, upperItems), status }
  }
  const earlier = f.sw.loot(f.scout, board, true)
  await opened
  f.advance(60000)
  await f.sw.loot(f.courier, board, true)
  assert.deepEqual(report(f)?.items, [])
  close()
  await earlier
  assert.equal(report(f)?.by, f.courier.name)
  assert.deepEqual(report(f)?.items, [])
}

test('a slower Q window cannot replace a newer observation after the first claim expires', async () => {
  await delayedUpperVisit('interrupted')
  await delayedUpperVisit('done')
})

test('refill while dressing prevents a second withdrawal based on the previous window', async () => {
  const f = scene(upper)
  f.places[0].tier = 4
  f.world.take = () => ({ status: 'done', detail: { at: upper, full: true, contents: upperItems, took: {} } })
  const call = f.scout.c.call
  f.scout.c.call = async (method, params) => {
    if (method === 'armor') f.sw.refill(upper)
    return call(method, params)
  }
  await f.sw.loot(f.scout, f.sw.boardOf(f.scout), true)
  assert.deepEqual(f.calls.map(c => c.method), ['blocks_around', 'chest_take', 'armor'])
  assert.equal(report(f), undefined)
})

test('a teammate report never overrides an active reservation, arrow fire or a nearby seen enemy', async () => {
  const f = scene()
  await f.seen()
  const board = f.sw.boardOf(f.courier)
  f.sw.toured.get('blue').set(0, { by: f.reserve.name, at: 1000 })
  assert.deepEqual(f.offer(f.courier), f.places[1])
  f.sw.toured.clear()
  ;(f.courier as any).arrowThreat = { active: true, at: 1000 }
  assert.equal(f.offer(f.courier), undefined)
  delete (f.courier as any).arrowThreat
  board.observe(f.scout.name, 1000, { id: 'Enemy', visible: true, position: f.places[0] })
  assert.equal(f.offer(f.courier), undefined)
})

test('forty loot offers reuse one public threat snapshot per bot across 32 possible chests', () => {
  const f = scene(), board = f.sw.boardOf(f.courier)
  f.sw.chestTops.push(...Array.from({ length: 30 }, (_, i) => ({ x: 30 + i, y: 64, z: 3, tier: 3 })))
  let observations = 0, prices = 0
  const enemies = board.enemies.bind(board), travelCost = f.sw.travelCost
  board.enemies = () => { observations++; return enemies() }
  f.sw.travelCost = (...args) => { prices++; return travelCost(...args) }
  for (let i = 0; i < 40; i++) {
    const b = { ...f.courier, name: 'Looter' + i }
    f.pos[b.name] = { ...f.pos.Courier, inv: i % 2 ? { elytra: 1, firework_rocket: 8 } : {} }
    assert.deepEqual(f.offer(b), f.places[0])
  }
  assert.deepEqual({ observations, prices }, { observations: 40, prices: 40 * 32 })
})

test('an older report through a former half cannot restore the old double stock after a new pair or a refill', async () => {
  for (const mode of ['repaired', 'refilled while first opening']) {
    const f = scene(upper), a = upper, b = { ...a, x: a.x + 1 }, c = { ...a, z: a.z + 1 }
    const cells = { Scout: a, Courier: c, Reserve: b }
    const at = (p) => 'chest:' + [p.x, p.y, p.z].join(',')
    const receipt = (point, partner, item) => ({ status: 'interrupted', detail: { at: point, chestPartner: partner, chestSlots: 54, contents: { [item]: 1 }, took: {} } })
    f.world.found = name => [cells[name]]
    for (const name of ['Scout', 'Reserve', 'Courier']) f.pos[name].p = { ...cells[name], x: cells[name].x + .5 }
    const scan = bot => f.sw.loot(bot, f.sw.boardOf(bot), true)
    let resume, entered
    const pending = new Promise<void>(r => { entered = r })
    f.world.take = async name => {
      if (name === 'Reserve') { entered(); await new Promise(r => { resume = r }); return receipt(b, a, 'mace') }
      return name === 'Scout' ? receipt(a, b, 'trident') : receipt(c, a, 'diamond_sword')
    }
    if (mode === 'repaired') await scan(f.scout)
    const late = scan(f.reserve); await pending
    if (mode === 'repaired') await scan(f.courier)
    else f.sw.refill(a)
    resume(); await late
    const memory = f.sw.knownChests.get('blue')
    assert.equal(memory.get(at(b))?.report, undefined, mode)
    assert.equal(memory.get(at(b))?.partner, undefined, mode)
    if (mode === 'repaired') {
      assert.deepEqual(memory.get(at(a))?.partner, c)
      assert.deepEqual(memory.get(at(c))?.partner, a)
      assert.deepEqual(memory.get(at(a))?.report?.items, ['diamond_sword'])
    }
  }
})
