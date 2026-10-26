import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../src/swarm/board'
import { planPvp } from '../src/swarm/plan-pvp'
import type { SwarmMember } from '../src/swarm/types'

const armor = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
function fixture({ own = 1, foesLeft = 3, healer = false }: { own?: number; foesLeft?: number; healer?: boolean } = {}) {
  let now = 1000, enemyX = 20
  const board = new SwarmBoard('blue', () => now)
  const team: SwarmMember[] = Array.from({ length: own }, (_, i) => ({ id: `a${i}`, team: 'blue', position: { x: i * .5, y: 64, z: 0 },
    health: i ? 20 : 10, maxHealth: 20, strength: 40, role: healer && i === own - 1 ? 'healer' : 'fighter', canHeal: healer && i === own - 1,
    weapon: 'iron_sword', inventory: { iron_sword: 1, cooked_beef: 16 }, armor }))
  if (healer) { team[own - 1].inventory!.splash_potion = 1; team[own - 1].potions = { splash_healing: 1 } }
  const plan = () => {
    board.setMembers(team)
    board.observe('a0', now, { id: 'enemy', visible: true, position: { x: enemyX, y: 64, z: 0 }, equipment: { weapon: 'iron_sword', armor } })
    return planPvp(board, team, { foesLeft, aggressive: false, doctrine: 'ring', perches: [], hideouts: [], quorum: 2 })
  }
  return { board, team, plan, next: (hp: number, x: number) => { now += 1000; team[0].health = hp; enemyX = x } }
}

test('last survivor leaves prior recovery and fights when a visible opponent closes to four blocks', () => {
  const f = fixture()
  assert.equal(f.plan().get('a0')!.kind, 'recover', 'HP10 at twenty blocks starts genuine recovery')
  f.next(13, 4)
  const task = f.plan().get('a0')!
  assert.equal(task.kind, 'fight', 'contact in the final stand must override the old recovery hysteresis')
  assert.equal(task.data.target, 'enemy'); assert.equal(task.data.finishing, true)
})

test('endgame contact also fights when recovery has not started yet', () => {
  const f = fixture(); f.next(8, 4)
  assert.equal(f.plan().get('a0')!.kind, 'fight')
})

test('a separated last survivor keeps real recovery until seventy percent own health', () => {
  const f = fixture()
  assert.equal(f.plan().get('a0')!.kind, 'recover')
  f.next(13, 20); assert.equal(f.plan().get('a0')!.kind, 'recover')
  f.next(14, 20); assert.notEqual(f.plan().get('a0')!.kind, 'recover')
})

test('a larger unresolved middle battle keeps its existing contact recovery hysteresis', () => {
  const f = fixture({ own: 4, foesLeft: 4 })
  assert.equal(f.plan().get('a0')!.kind, 'recover')
  f.next(13, 4); assert.equal(f.plan().get('a0')!.kind, 'recover')
})

test('a real allied healer still heals the wounded fighter in endgame contact', () => {
  const f = fixture({ own: 3, healer: true })
  assert.equal(f.plan().get('a0')!.kind, 'recover')
  f.next(13, 4)
  const plan = f.plan()
  assert.equal(plan.get('a0')!.kind, 'fight')
  assert.equal(plan.get('a2')!.kind, 'heal'); assert.equal(plan.get('a2')!.data.ally, 'a0')
})
