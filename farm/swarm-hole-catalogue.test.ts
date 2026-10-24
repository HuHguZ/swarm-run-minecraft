import test from 'node:test'
import assert from 'node:assert/strict'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmTeam } from './swarm/swarm-driver/team'
import { pvpState } from '../daemon/src/swarm/board'

// Actual coordinator -> callback -> planPvp -> pvpDiggers. No planner or plan result is stubbed.
function scene(holes: any[] = [], y = 119) {
  const at = (x, z) => ({ x, y, z })
  const bots = ['A', 'B', 'C'].map(name => ({ name, team: 'blue', c: { call: async () => ({}) } }))
  const pos = Object.fromEntries(bots.map((b, k) => [b.name, { p: [at(543.5, 596), at(541.5, 594.5), at(547.5, 594.5)][k], hp: 20,
    inv: { diamond_pickaxe: 1, stone_sword: 1 }, armor: { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' } }]))
  const stand = { ...at(547.5, 594.5), requiresClear: [{ x: 547, y, z: 594 }], support: { x: 547, y: y - 1, z: 594 } }
  const site: any = { x: 543, y, z: 594, feetY: y + 1, blocks: ['cut_sandstone', 'obsidian'], drop: Infinity, tier: 2, stands: [stand] }
  const sw: any = createDriverState({ bots, pos, alive: () => true, aggressive: true, log() {}, now: () => 10000,
    arena: { x: 600, y: 120, z: 600, r: 96 }, home: () => pos.A.p, hostile: (_, id) => id === 'Champ', digSites: () => [site] })
  Object.assign(sw, swarmRetry(sw), { preempt() {} })
  Object.assign(sw, swarmTeam(sw)); sw.holes.push(...holes)
  const board = sw.boardOf(bots[0]), work = pvpState(board).dislodgeWork = new Map()
  for (const x of [543, 547]) work.set(`Champ:dig:${x},${y},594`, { at: 10000, active: false, failed: false, work: 10, alternative: 100, deadline: 20000, penalty: 0, penaltyAt: 10000, dug: 1 })
  board.setMembers(sw.membersOf(bots[0]))
  board.observe('A', 10000, { id: 'Champ', visible: true, position: at(543.49, 594.57), hpEstimate: 20,
    equipment: { weapon: 'netherite_sword', enchanted: true, armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'] } })
  const run = () => { sw.planned.clear(); sw.refresh(bots[0]); return [...sw.planned.get('blue').values()] }
  return { sw, run, site, board }
}

test('k completed neighbouring void shaft does not hide the remaining obsidian under the enemy', () => {
  const clear = scene(), original = clear.run().find(t => t.data?.dig)
  assert.ok(original, 'the physical/price fixture supports lower obsidian work before a neighbouring hole exists')
  assert.equal(original.data.dig, '543,119,594')
  const f = scene([{ x: 545, y: 119, z: 593, bottomY: 118, feetY: 120, drop: Infinity }])
  const task = f.run().find(t => t.data?.dig)
  assert.ok(task, 'a completed hole sqrt(5) away must not erase this still-solid column from the planner catalogue')
  assert.equal(task.data.dig, original.data.dig)
  assert.equal(task.data.undermine, true)
  assert.deepEqual(task.data.stands, [{ x: 547.5, y: 119, z: 594.5 }])
  assert.equal(f.board.tasks().some(t => t.data?.dig === task.data.dig), true, 'the real plan is published to the board')
})

test('only completed overlapping layers in the exact same column leave the catalogue', () => {
  for (const hole of [
    { x: 543, y: 119, z: 594, bottomY: 118 },
    { x: 543, y: 120, z: 594, bottomY: 117 }
  ]) assert.equal(scene([hole]).run().some(t => t.data?.dig), false)
  assert.ok(scene([{ x: 544, y: 119, z: 594, bottomY: 118 }]).run().some(t => t.data?.dig), 'an adjacent new column remains work')
  assert.ok(scene([{ x: 543, y: 119, z: 594, bottomY: 118 }], 127).run().some(t => t.data?.dig), 'the same x/z on an independent upper floor remains work')
})
