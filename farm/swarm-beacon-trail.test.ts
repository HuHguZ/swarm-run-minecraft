import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../daemon/src/swarm'
import { createSwarmDriver } from './swarm/swarm-driver'

function fixture(t, work) {
  let now = 100000, board: SwarmBoard
  const observe = SwarmBoard.prototype.observe
  t.mock.method(SwarmBoard.prototype, 'observe', function (this: SwarmBoard, ...args: Parameters<typeof observe>) {
    board = this
    return observe.apply(this, args)
  })
  const pos = {}, sight = { x: 15.4, y: 120, z: .3 }, calls = []
  const bots = ['Miner', 'Scout', 'Wing', 'Helper'].map((name, i) => {
    pos[name] = { p: { x: i + .5, y: 120, z: .5 }, hp: 20, inv: { iron_pickaxe: 1, iron_sword: 1, cobblestone: 64 }, armor: {} }
    return { name, team: 'blue', c: { async call(method, p) {
      if (method !== 'swarm_work') return { detail: {} }
      calls.push({ name, at: p.at })
      return { detail: await work(p, name) }
    } } }
  })
  const driver = createSwarmDriver({ bots, pos, now: () => now, alive: () => true, home: () => pos['Miner'].p,
    arena: { x: 0, z: 0, r: 70 }, hostile: (_, id) => id === 'Foe', log() {} })
  const report = () => driver.observe(bots[1], [{ id: 'Foe', visible: true, position: sight, equipment: { weapon: 'iron_sword', armor: [] } }])
  report()
  return { driver, bots, calls, sight, report, advance(ms) { now += ms }, facts: () => board.facts().filter(f => f.id.startsWith('trail:')),
    tasks: () => board.tasks().filter(t => t.data?.blueprint?.startsWith('beacon:')) }
}

for (const reason of ['occupied', 'unsupported', 'wrong-coordinate', 'wrong-block']) {
  test(`a beacon work turn creates no trail on ${reason}`, async t => {
    const f = fixture(t, p => {
      if (reason === 'occupied') return { done: false, occupiedByEntity: true }
      if (reason === 'unsupported') return { done: false, noVisibleSupport: true, viewpoint: p.at }
      return { done: true, at: reason === 'wrong-coordinate' ? { ...p.at, x: p.at.x + 1 } : p.at, after: reason === 'wrong-block' ? 'sand' : p.item }
    })
    await f.driver.turn(f.bots[0])
    assert.ok(f.calls.length)
    assert.equal(f.tasks().filter(t => t.status === 'done').length, 0)
    assert.deepEqual(f.facts(), [])
  })
}

test('two builders share one marked sighting and publish it only when the beacon cap is confirmed', async t => {
  let release!: () => void, enter!: () => void
  const first = new Promise<void>(r => { enter = r }), gate = new Promise<void>(r => { release = r })
  const f = fixture(t, async (p, name) => {
    if (p.at.x === 1 && p.at.y === 120 && name === 'Miner') { enter(); await gate }
    return { done: true, at: p.at, after: p.item }
  })
  const building = f.driver.turn(f.bots[0])
  try {
    await first
    f.sight.x = 15.8; f.advance(250); f.report()
    await f.driver.turn(f.bots[3])
    assert.equal(f.tasks().length, 2, 'another report inside the same cell shares the original pillar')
    assert.deepEqual(f.facts(), [])
  } finally { release(); await building }
  assert.equal(f.tasks().filter(t => t.status === 'done').length, 1)
  assert.deepEqual(f.facts(), [], 'a confirmed foundation is not a complete marker')
  f.advance(400)
  await f.driver.turn(f.bots[3])
  assert.equal(f.tasks().filter(t => t.status === 'done').length, 2)
  const [fact] = f.facts()
  assert.equal(fact.id, 'trail:15,120,0')
  assert.deepEqual(fact.position, f.sight)
  assert.equal(fact.source, 'Helper')
  assert.equal(fact.expiresAt, 130250, 'finishing the pillar does not refresh the sighting')
  f.driver.reset()
  assert.deepEqual(f.facts(), [])
})

for (const placeCap of [false, true]) {
  test(`a witnessed cobblestone base counts as a marker only with a deliberate change (new cap: ${placeCap})`, async t => {
    const f = fixture(t, p => p.at.y === 121 && placeCap ? { done: true, at: p.at, after: p.item }
      : { done: true, at: p.at, after: p.item, before: p.item, already: true, confirmation: 'visible_existing' })
    await f.driver.turn(f.bots[0])
    await f.driver.turn(f.bots[3])
    assert.equal(f.tasks().filter(t => t.status === 'done').length, 2)
    assert.equal(f.facts().length, placeCap ? 1 : 0)
  })
}

test('a cap acknowledgement after reset cannot publish the previous round sighting', async t => {
  let enter!: () => void, release!: () => void
  const cap = new Promise<void>(r => { enter = r }), gate = new Promise<void>(r => { release = r })
  const f = fixture(t, async p => {
    if (p.at.y === 121) { enter(); await gate }
    return { done: true, at: p.at, after: p.item }
  })
  await f.driver.turn(f.bots[0])
  const pending = f.driver.turn(f.bots[3])
  try { await cap; f.driver.reset(); f.advance(100); f.report() } finally { release(); await pending }
  assert.deepEqual(f.facts(), [])
  assert.deepEqual(f.tasks(), [])
})
