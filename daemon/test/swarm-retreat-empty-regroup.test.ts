import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, pvpState } from '../src/swarm/board'
import { pvpFrame, type PvpPlan } from '../src/swarm/plan-frame'
import { pvpFlee } from '../src/swarm/plan-flee'
import { assessSwarmFight } from '../src/swarm/fight'
import type { SwarmMember } from '../src/swarm/types'
import type { RetreatWhy } from '../src/swarm/retreat'

const point = (x: number, y = 64) => ({ x, y, z: 0 })
function scene({ why = 'пустой размен' as RetreatWhy, health = 20, shelter = true, held = true, endgame = false, lethal = false } = {}) {
  const member = (id: string, x: number): SwarmMember => ({ id, team: 'blue', position: point(x), health: 20, strength: 40, role: 'fighter', weapon: 'stone_sword', armor: ['leather_chestplate'], inventory: { stone_sword: 1, elytra: 1, firework_rocket: 12 } })
  const own = member('a', 0); own.health = health
  const team = [own, ...(shelter ? [member('b', -32), member('c', -34)] : [])]
  const board = new SwarmBoard('blue', () => 1000, 8000); board.setMembers(team)
  const foe = { id: 'foe', position: point(14), seenAt: 1000, source: 'a', sources: ['a'], threat: 'melee' as const,
    equipment: { weapon: lethal ? 'netherite_axe' : 'wooden_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: true } }
  const state = pvpState(board)
  if (held) state.retreats.set('a', { why, group: 1, foes: ['foe'] })
  const perch = point(0, 96), plan = new Map()
  const S = pvpFrame({ board, team, state, enemies: [foe], aggressive: false, doctrine: 'wave', plan,
    options: { perches: [perch], ...(endgame ? { foesLeft: 4 } : {}) } } as PvpPlan)
  const risk = assessSwarmFight(own, [foe], team)
  pvpFlee(S)
  return { own, state, task: plan.get('a'), perch, risk, S }
}

test('a healthy held empty exchange regroups with its available allies instead of taking a perch', () => {
  const { task, risk } = scene()
  assert.equal(risk.lethal, false)
  assert.equal(task?.kind, 'flee')
  assert.match(task.data.reason, /^держу пустой размен/)
  assert.equal(task.data.regroup, true)
  assert.ok(!task.data.perch)
  assert.deepEqual(task.position, point(-33))
})

test('a held alone retreat keeps its existing regroup destination', () => {
  const { task } = scene({ why: 'один' })
  assert.equal(task?.data.regroup, true)
  assert.deepEqual(task.position, point(-33))
})

test('a held empty exchange without a shelter keeps the perch option', () => {
  const { task, perch } = scene({ shelter: false })
  assert.equal(task?.data.perch, true)
  assert.deepEqual(task.position, perch)
})

test('a wounded held empty exchange keeps the aerial escape', () => {
  const { task, perch } = scene({ health: 6 })
  assert.equal(task?.data.perch, true)
  assert.deepEqual(task.position, perch)
})

test('a held wound retreat keeps its perch even with available allies', () => {
  const { task, perch } = scene({ why: 'рана', health: 10 })
  assert.equal(task?.data.perch, true)
  assert.match(task.data.reason, /^держу рана/)
  assert.deepEqual(task.position, perch)
})

test('a lethal held empty exchange keeps the aerial escape above the wound threshold', () => {
  const { task, perch, risk } = scene({ health: 10, lethal: true })
  assert.equal(risk.lethal, true)
  assert.equal(task?.data.perch, true)
  assert.deepEqual(task.position, perch)
})

test('the first empty-exchange retreat still has its perch choice', () => {
  const { task, perch } = scene({ held: false })
  assert.equal(task?.data.perch, true)
  assert.ok(!task.data.reason.startsWith('держу'))
  assert.deepEqual(task.position, perch)
})

test('the last own fighter clears its retreat under the existing endgame policy', () => {
  const { state, task, S } = scene({ shelter: false, endgame: true })
  assert.equal(S.endgame, true)
  assert.equal(state.retreats.has('a'), false)
  assert.equal(task, undefined)
})
