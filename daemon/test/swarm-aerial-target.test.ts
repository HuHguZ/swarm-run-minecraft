import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'

// cl28 (15×15, 28.10): 23 из 47 наземных боёв «0/0» — цель кружит на элитрах («жду посадки», «бегу под него»), а бить её нечем:
// ни лука со стрелами, ни ракет сверх запаса на спасение. Достижимая цель на земле — раньше летящей; летят все — как прежде.
test('цель в воздухе, которую нечем достать, уступает цели на земле', () => {
  const p = (x: number, y = 120) => ({ x, y, z: 600 })
  const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
  const gear = (extra: Record<string, number>) => ({ netherite_sword: 1, elytra: 1, firework_rocket: 3, ...extra })
  const members = (inv: Record<string, number>): SwarmMember[] => Array.from({ length: 3 }, (_, i) => ({ id: 'b' + i, team: 'blue', position: p(600 + i), health: 20, strength: 80, role: 'fighter', weapon: 'netherite_sword', armor, ench: { sharpness: 5, protection: 16 }, inventory: inv }))
  const plan = (inv: Record<string, number>, both = true) => {
    const ms = members(inv), board = new SwarmBoard('blue', () => 1000, 8000)
    board.setMembers(ms)
    board.observe('b0', 1000, { id: 'Flyer', position: p(606, 130), visible: true, threat: 'aerial', equipment: { weapon: 'wooden_spear', armor: [] } } as any)
    if (both) board.observe('b0', 1000, { id: 'Walker', position: p(620), visible: true, threat: 'melee', equipment: { weapon: 'wooden_sword', armor: [] } } as any)
    return planPvp(board, ms, { aggressive: true, quorum: 1 }).get('b0')?.data?.target
  }
  assert.equal(plan(gear({})), 'Walker', 'без лука и ракет — к тому, кто на земле')
  assert.equal(plan(gear({ bow: 1, arrow: 32 })), 'Flyer', 'с луком ближний летун — цель')
  assert.equal(plan(gear({ firework_rocket: 16 })), 'Flyer', 'ракеты сверх запаса — свой таран/полёт достанет')
  assert.equal(plan(gear({}), false), 'Flyer', 'летят все — цель та же')
})

// cl28u (28.10): летун q садился и взлетал — цель боя прыгала q ↔ i, 48 смен цели в бою за раунд. Ушёл от летуна, которого
// нечем достать, — к нему возвращаемся, только когда он рядом (в досягаемости удара) или других целей нет.
test('ушёл от летуна — его посадка вдали не перетягивает цель обратно', () => {
  const p = (x: number, y = 120) => ({ x, y, z: 600 })
  const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
  const inv = { netherite_sword: 1, elytra: 1, firework_rocket: 3 }
  const ms: SwarmMember[] = Array.from({ length: 3 }, (_, i) => ({ id: 'b' + i, team: 'blue', position: p(600 + i), health: 20, strength: 80, role: 'fighter', weapon: 'netherite_sword', armor, ench: { sharpness: 5, protection: 16 }, inventory: inv }))
  let now = 1000
  const board = new SwarmBoard('blue', () => now, 8000)
  board.setMembers(ms)
  const see = (flyer: { x: number, y: number, aerial: boolean }) => {
    board.observe('b0', now, { id: 'Flyer', position: p(flyer.x, flyer.y), visible: true, threat: flyer.aerial ? 'aerial' : 'melee', equipment: { weapon: 'wooden_spear', armor: [] } } as any)
    board.observe('b0', now, { id: 'Walker', position: p(620), visible: true, threat: 'melee', equipment: { weapon: 'wooden_sword', armor: [] } } as any)
  }
  const step = (flyer: { x: number, y: number, aerial: boolean }) => {
    now += 500; see(flyer)
    const plan = planPvp(board, ms, { aggressive: true, quorum: 1 })
    for (const t of plan.values()) board.upsert(t)
    return plan.get('b0')?.data?.target
  }
  assert.equal(step({ x: 608, y: 120, aerial: false }), 'Flyer', 'на земле и ближе — цель')
  assert.equal(step({ x: 608, y: 130, aerial: true }), 'Walker', 'взлетел — к тому, кто на земле')
  assert.equal(step({ x: 609, y: 120, aerial: false }), 'Walker', 'сел в 9 бл. — цель не прыгает обратно')
  assert.equal(step({ x: 603, y: 120, aerial: false }), 'Flyer', 'сел рядом (в досягаемости) — снова цель')
})
