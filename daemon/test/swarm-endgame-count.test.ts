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
  if (visible) board.observe('a0', 1000, { id: 'enemy', visible: true, position: { x: 20, y: 64, z: 0 }, equipment: { weapon: 'iron_sword', armor } })
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
