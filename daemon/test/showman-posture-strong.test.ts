import test from 'node:test'
import assert from 'node:assert/strict'
import { unsafeWhy } from '../src/showman/posture'

// Пользователь 22.10: стойку «покрасоваться» — не против сильного и не против идущего на меня.
const item = (name: string) => ({ name })
function H (mine: string[], theirs: string[]) {
  const target = { id: 2, position: { x: 8, y: 64, z: 0 }, equipment: theirs.map(item) }
  const bot = { heldItem: item(mine[0]), inventory: { slots: { 6: mine[1] ? item(mine[1]) : null } }, entity: { position: { x: 0, y: 64, z: 0 } } }
  return { bot, target: () => target, observe: e => e, tt: null } as any
}
const calm = { theirR: 8, dy: 0, seesBody: true, hp: 20 }

test('no posture before a foe whose visible gear is not weaker than mine', () => {
  assert.equal(unsafeWhy(H(['wooden_sword'], ['netherite_sword', null, null, null, 'netherite_chestplate'] as any), calm, 0), 'он не слабее')
  assert.equal(unsafeWhy(H(['netherite_sword', 'netherite_chestplate'], ['wooden_sword']), calm, 0), null)
})

test('no posture while he closes in at any speed', () => {
  assert.equal(unsafeWhy(H(['netherite_sword', 'netherite_chestplate'], ['wooden_sword']), calm, 0.1), 'он идёт на меня')
})
