import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, planTransfers, type SwarmMember } from '../daemon/src/swarm'
import { targetCost } from '../daemon/src/swarm/plan-judges'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmTeam } from './swarm/swarm-driver/team'

const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
const at = (x, z = 0, y = 88) => ({ x, y, z })
const zone = { ...at(13, 4), tier: 3 }
function fighter (strong: boolean): SwarmMember {
  return { id: 'A', team: 'blue', position: at(0), health: 20, strength: strong ? 100 : 20, role: 'fighter',
    inventory: strong ? { netherite_sword: 1 } : {}, weapon: strong ? 'netherite_sword' : undefined,
    armor: strong ? armor : [], ench: strong ? { sharpness: 5, protection: 16 } : {} }
}

test('a superior fighter targets the rival at known valuable loot; a weak fighter gets no denial discount', () => {
  const foes: any[] = ['Away', 'Looter'].map((id, i) => ({ id, position: at(12, i ? 4 : -4), sources: ['A'], seenAt: 1000,
    threat: 'melee', equipment: { weapon: 'iron_sword', armor: ['iron_chestplate'] } }))
  for (const strong of [true, false]) {
    const member = fighter(strong)
    const frame: any = { team: [member], enemies: foes, foeCenter: at(12), loads: new Map(), meanStrength: member.strength,
      state: {}, options: { lootZones: [zone] } }
    const costs = foes.map(e => targetCost(frame, member, e))
    if (strong) {
      assert.ok(costs[1] < costs[0], 'equally reachable rival collecting upper gear is the urgent target')
      frame.loads.set('Looter', 3)
      assert.ok(targetCost(frame, member, foes[1]) > costs[0], 'denial must still spread fighters across rival targets')
      frame.loads.clear()
      const upper = { ...foes[1], position: at(12, 4, 112) }
      frame.options.lootZones = [{ ...upper.position, tier: 5 }]
      assert.ok(targetCost(frame, member, upper) > targetCost(frame, member, foes[0]), 'a difficult ascent still costs more than a nearby rival')
    }
    else assert.equal(costs[1], costs[0], 'poor gear does not gain a reason to risk a losing duel')
    frame.options.lootZones = []
    assert.equal(targetCost(frame, member, foes[0]), targetCost(frame, member, foes[1]), 'unseen or unlisted loot confers no priority')
  }
  const members = Array.from({ length: 3 }, (_, i) => ({ ...fighter(true), id: 'B' + i }))
  const board = new SwarmBoard('blue', () => 1000)
  board.setMembers(members)
  for (const e of foes) board.observe('B0', 1000, { ...e, visible: true })
  const task = planPvp(board, members, { foesLeft: 12, lootZones: [zone] }).get('B0')
  assert.equal(task?.data?.target, 'Looter', 'the existing fighter assignment uses the denial price')
})

test('an armed stone-sword ally requests spare diamond gear while the donor keeps its best weapon', () => {
  const bots = ['Donor', 'Ally'].map(name => ({ name, team: 'blue' }))
  const pos = { Donor: { p: at(0), hp: 20, inv: { netherite_sword: 1, diamond_sword: 1 }, armor: {} },
    Ally: { p: at(1), hp: 20, inv: { stone_sword: 1 }, armor: {} } }
  const sw = createDriverState({ bots, pos, alive: () => true, now: () => 1000, log() {},
    arena: { x: 0, y: 64, z: 0, r: 100 } })
  Object.assign(sw, swarmTeam(sw))
  const members = sw.membersOf(bots[0]), donor = members.find(m => m.id === 'Donor'), ally = members.find(m => m.id === 'Ally')
  assert.equal(ally.needs.diamond_sword, 1, 'having a stone sword cannot suppress an available improvement')
  assert.equal(donor.reserve.netherite_sword, 1)
  const tasks = planTransfers(sw.boardOf(bots[0]), members)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].data?.item, 'diamond_sword')
  assert.equal(tasks[0].data?.count, 1)
})
