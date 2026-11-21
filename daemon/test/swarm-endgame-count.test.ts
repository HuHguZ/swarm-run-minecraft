import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, pvpState } from '../src/swarm/board'
import { pvpFrame, type PvpPlan } from '../src/swarm/plan-frame'
import type { SwarmMember } from '../src/swarm/types'
import { planPvp } from '../src/swarm/plan-pvp'

function frame(own: number, foesLeft?: number, aggressive = false): PvpPlan {
  const board = new SwarmBoard('blue', () => 1000)
  const team: SwarmMember[] = Array.from({ length: own }, (_, i) => ({
    id: `a${i}`, team: 'blue', position: { x: i, y: 64, z: 0 },
    health: 20, strength: 20, role: 'fighter'
  }))
  board.setMembers(team)
  return pvpFrame({ board, options: { foesLeft }, team, state: pvpState(board), enemies: [], aggressive,
    doctrine: 'hunt', plan: new Map() } as PvpPlan)
}

test('last three known enemies trigger finishing without a threefold own advantage', () => {
  assert.equal(frame(7, 3).endgame, true, 'Q late-round 7 versus 3 still needs a finishing plan')
})

test('last one to three own survivors enter the final fight against a known live enemy team', () => {
  for (const own of [1, 2, 3]) assert.equal(frame(own, 7).endgame, true, `${own} own survivors`)
})

test('aggressive combat does not suppress finishing from known remaining counts', () => {
  assert.equal(frame(7, 3, true).endgame, true)
  assert.equal(frame(3, 7, true).endgame, true)
})

test('existing threefold advantage still finishes larger remaining teams', () => {
  assert.equal(frame(12, 4).endgame, true)
  assert.equal(frame(12, 4, true).endgame, true)
})

test('a larger unresolved battle does not enter count based endgame', () => {
  assert.equal(frame(7, 4).endgame, false)
  assert.equal(frame(7, 4, true).endgame, false)
})

test('unknown or zero enemy count cannot invent a known living opponent', () => {
  for (const aggressive of [false, true]) {
    assert.equal(frame(3, undefined, aggressive).endgame, false)
    assert.equal(frame(3, 0, aggressive).endgame, false)
  }
})

const kit = { iron_sword: 1, cooked_beef: 16 }
const armor = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
function battle(own: number, foesLeft: number | undefined, aggressive: boolean, health = 20, visible = true) {
  let time = 1000
  const board = new SwarmBoard('blue', () => time)
  const team: SwarmMember[] = Array.from({ length: own }, (_, i) => ({
    id: `a${i}`, team: 'blue', position: { x: i * .5, y: 64, z: 0 }, health,
    strength: 40, role: 'fighter', weapon: 'iron_sword', inventory: kit, armor
  }))
  board.setMembers(team)
  if (visible) for (const m of team) board.observe(m.id, 1000, { id: 'enemy', visible: true, position: { x: 20, y: 64, z: 0 }, equipment: { weapon: 'iron_sword', armor } })
  const options = { foesLeft, aggressive, doctrine: 'hunt' as const, hideouts: [{ x: -20, y: 64, z: 0 }], perches: [] }
  return { board, team, options, advance: (ms: number) => { time += ms }, plan: () => [...planPvp(board, team, options).values()] }
}

test('actual planner sends healthy last survivors to a known target instead of hide or reserve', () => {
  for (const aggressive of [false, true]) for (const own of [1, 2, 3]) {
    const f = battle(own, 7, aggressive)
    assert.ok(f.plan().every(t => t.kind === 'fight' && t.data.target === 'enemy' && t.data.finishing), `${own}, aggressive=${aggressive}`)
  }
})

test('actual planner finishes three known enemies without shelving healthy actors for loot or regroup', () => {
  for (const aggressive of [false, true]) {
    const f = battle(7, 3, aggressive)
    assert.ok(f.plan().every(t => t.kind === 'fight' && t.data.finishing), `aggressive=${aggressive}`)
  }
})

test('known survivors without sightings search instead of inventing enemy position or hiding', () => {
  const f = battle(3, 7, true, 20, false)
  assert.ok(f.plan().every(t => t.kind === 'goto' && t.data.search && t.data.finishing && !t.data.hunt))
})

test('twenty scouts can replan their search without copying the whole board for each previous order', t => {
  const f = battle(20, 2, true, 20, false)
  f.plan()
  const snapshot = t.mock.method(f.board, 'tasks')
  const plan = f.plan()
  assert.equal(plan.filter(task => task.data.search).length, 20)
  assert.ok(snapshot.mock.callCount() < plan.length, `the whole planner read the board ${snapshot.mock.callCount()} times`)
})

test('endgame retains wound recovery and returns to the target at seventy percent own health', () => {
  const f = battle(3, 7, true, 4)
  assert.ok(f.plan().every(t => t.kind === 'recover'))
  for (const m of f.team) m.health = 14
  assert.ok(f.plan().every(t => t.kind === 'fight' && t.data.finishing))
})

test('unknown remaining count keeps the existing middle battle retreat policy', () => {
  const f = battle(3, undefined, true)
  assert.ok(f.plan().some(t => t.kind === 'flee' && t.data.hide))
})

test('endgame keeps the attack covering a recovering ally and its priority', () => {
  const f = battle(3, 7, false)
  f.team[0].health = 4
  f.board.observe('a0', 1000, { id: 'enemy', visible: true, position: { x: 9, y: 64, z: 0 }, equipment: { weapon: 'iron_sword', armor } })
  const plan = f.plan()
  const covering = plan.find(t => t.data.cover === 'a0')
  assert.ok(covering, 'the attack still covers the wounded ally')
  assert.equal(covering.kind, 'fight')
  assert.equal(covering.priority, 80)
  assert.equal(covering.data.finishing, true)
})

test('sight loss keeps hunting only the last observed place, with no invented live position', () => {
  const f = battle(3, 7, true)
  f.plan()
  f.advance(4000)
  assert.equal(f.board.enemies().length, 0)
  const plan = f.plan()
  assert.ok(plan.every(t => t.kind === 'goto' && t.data.search && t.data.hunt && t.data.finishing))
  assert.ok(plan.every(t => t.data.enemyPosition.x === 20 && t.data.enemyPosition.y === 64 && t.data.enemyPosition.z === 0))
})

test('a hunter remembers an observation made between plans and abandons confirmed deaths', () => {
  const f = battle(2, 7, false)
  const lastPlace = { x: -12, y: 68, z: 1 }
  f.advance(500)
  f.board.observe('a1', 1500, { id: 'second', visible: true, position: lastPlace })
  f.board.observe('a0', 1200, { id: 'second', visible: true, position: { x: -6, y: 68, z: 1 } })
  f.advance(4000)
  assert.deepEqual(f.board.enemies(), [])
  const search = () => f.plan()[0].data
  assert.deepEqual(search().enemyPosition, lastPlace, 'both short-lived sightings expired before the first plan')
  assert.equal(search().searchSeenAt, 1500)
  f.board.forget('second')
  assert.equal(search().enemyPosition.x, 20, 'the other missing opponent is still worth looking for')
  f.board.forget('enemy')
  assert.ok(!search().hunt)
})

test('scouts in separate wings investigate both missing opponents using only the last sighting in each wing', () => {
  const f = battle(3, 2, true, 20, false)
  const west = { x: -40, y: 64, z: 0 }, east = { x: 40, y: 64, z: 0 }
  for (const [i, x] of [-32, 31, -28].entries()) f.team[i].position.x = x
  f.board.observe('a0', 1000, { id: 'west', visible: true, position: west })
  f.advance(500)
  f.board.observe('a1', 1500, { id: 'east', visible: true, position: east })
  f.advance(4000)
  assert.equal(f.board.observe('a0', 5500, { id: 'west', visible: false, position: east }), false)
  assert.deepEqual(f.board.enemies(), [])
  const [nearWest, nearEast, sweep] = f.plan()
  assert.deepEqual([nearWest.position, nearEast.position], [west, east])
  assert.deepEqual([nearWest, nearEast, sweep].map(t => t.data.searchEnemy), ['west', 'east', 'west'])
  assert.equal(nearWest.data.searchSeenAt, 1000)
  assert.notDeepEqual(sweep.position, west, 'the second western scout covers the surrounding ring')
  f.board.forget('west')
  assert.ok(f.plan().every(t => t.data.searchEnemy === 'east'))
})

test('a much older trail or another name last seen at the same doorway does not divert the team', () => {
  for (const nearby of [false, true]) {
    const f = battle(3, 2, true, 20, false)
    const fresh = { x: 20, y: 64, z: 0 }
    f.board.observe('a0', f.board.now(), { id: 'first', visible: true, position: { x: nearby ? 22 : -20, y: 64, z: 0 } })
    f.advance(nearby ? 500 : 100000)
    f.board.observe('a1', f.board.now(), { id: 'second', visible: true, position: fresh })
    f.advance(4000)
    const plan = f.plan()
    assert.ok(plan.every(t => t.data.searchEnemy === 'second'))
    assert.equal(new Set(plan.map(t => JSON.stringify(t.position))).size, 3)
  }
})

test('two opponents last seen directly above one another keep separate search parties on their floors', () => {
  const f = battle(2, 2, true, 20, false)
  f.team[1].position.y = 80
  for (const m of f.team) f.board.observe(m.id, f.board.now(), {
    id: 'floor' + m.position.y, visible: true, position: { x: 6, y: m.position.y, z: 0 }
  })
  f.advance(4000)
  assert.deepEqual(f.plan().map(t => [t.data.searchEnemy, t.position.y]), [['floor64', 64], ['floor80', 80]])
})

test('a newer report from the far wing cannot make a recently pursued bot leave its hiding place', () => {
  const f = battle(7, 7, false, 20, false)
  const hide = { x: -5, y: 64, z: -5 }
  f.board.observe('a0', 1000, { id: 'pursuer', visible: true, position: { x: 3, y: 64, z: 0 } })
  f.advance(500)
  f.board.observe('a1', 1500, { id: 'other', visible: true, position: { x: 80, y: 64, z: 0 } })
  f.board.upsert({ id: 'pvp:a0', kind: 'flee', data: { hide: true }, position: hide })
  f.advance(3500)
  assert.deepEqual(f.board.enemies(), [])
  const hiding = f.plan().find(t => t.id === 'pvp:a0')
  assert.equal(hiding.kind, 'flee')
  assert.deepEqual(hiding.position, hide)
  f.advance(3000)
  assert.notEqual(f.plan().find(t => t.id === 'pvp:a0').kind, 'flee')
})

test('replanning never renews a search clue or carries it into a new round', () => {
  const f = battle(2, 7, false)
  f.advance(2900)
  f.plan()
  f.advance(200)
  assert.equal(f.plan()[0].data.searchSeenAt, 1000)
  f.advance(177000)
  assert.ok(!f.plan()[0].data.hunt, 'three minutes from the observation')
  f.board.observe('a0', f.board.now(), { id: 'enemy', visible: true, position: { x: 20, y: 64, z: 0 } })
  f.board.resetRound()
  f.advance(4000)
  assert.ok(!f.plan()[0].data.hunt)
})

test('a claimed search follows a newer public sighting even if both plans missed the target', () => {
  for (const age of [750, 3500]) {
    const f = battle(2, 7, false)
    f.advance(age)
    const old = f.plan()[0]
    assert.equal(old.data!.search, true)
    const claim = f.board.claim(old.id, old.assignedTo!, 20000)
    assert.ok(claim)
    assert.equal(f.plan()[0].claim!.token, claim.claim!.token)
    const next = { x: -14, y: 68, z: 2 }, seenAt = f.board.now()
    f.board.observe('a1', seenAt, { id: 'enemy', position: next, visible: true })
    f.advance(age)
    const order = f.plan()[0]
    assert.deepEqual(order.data!.enemyPosition, next)
    assert.equal(order.data!.searchSeenAt, seenAt)
    assert.equal(order.data!.searchEnemy, 'enemy')
  }
})

// Цикл 23 (cl86): в хвосте еды в запасе нет ни у кого, голод 7–17 — регенерации нет, «recover» не лечил минутами.
test('wound recovery needs a way to heal: no food, hunger below 18 and no potion keeps the fight', () => {
  const f = battle(3, 7, true, 4)
  for (const m of f.team) { m.inventory = { iron_sword: 1 }; m.food = 10 }
  assert.ok(f.plan().every(t => t.kind === 'fight' && t.data.finishing), 'nothing to heal with — fight on')
  for (const m of f.team) m.food = 19
  assert.ok(f.plan().every(t => t.kind === 'recover'), 'hunger 18+ regenerates — recover')
  for (const m of f.team) { m.food = 10; m.inventory = { iron_sword: 1, bread: 3 } }
  assert.ok(f.plan().every(t => t.kind === 'recover'), 'food in the bag — recover and eat')
})
