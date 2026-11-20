import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../daemon/src/swarm/board'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmLoot } from './swarm/swarm-driver/loot'
import { swarmMoves } from './swarm/swarm-driver/moves'

function scene() {
  let clock = 1000
  const chest = { x: 12, y: 64, z: 0 }
  const places = [12.5, 18.5].map(x => ({ x, y: 64, z: .5, tier: 3 }))
  const world = { contents: { iron_sword: 1 } as Record<string, number> }
  const calls: any[] = []
  const pos: any = {}
  const bots = ['Scout', 'Courier', 'Reserve', 'Rival'].map(name => {
    const p = name === 'Scout' ? { ...places[0] } : { x: .5, y: 64, z: .5 }
    pos[name] = { p, hp: 20, inv: {}, armor: {} }
    return { name, team: name === 'Rival' ? 'red' : 'blue', c: { async call(method, params) {
      calls.push({ name, method, params })
      if (method === 'blocks_around') return { detail: { found: [chest] } }
      if (method === 'chest_take') {
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
    arena: { x: 0, y: 64, z: 0, r: 100 }, chestTops: places, log() {} })
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
