import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, pvpState } from '../src/swarm/board'
import { ineffectiveDamage } from '../src/swarm/race'
import type { SharedEnemy, SwarmMember } from '../src/swarm/types'

test('q9c: урон после лечения меняет режим по запасу доказанного прогресса, без мигания на границе окна', () => {
  const board = new SwarmBoard('blue')
  const team: SwarmMember[] = [{ id: 'a', team: 'blue', position: { x: 3, y: 64, z: 0 }, health: 20, strength: 40, role: 'fighter' }]
  const enemy: SharedEnemy = { id: 'HuHguZ', position: { x: 0, y: 64, z: 0 }, source: 'a', sources: ['a'], seenAt: 1000 }
  Object.defineProperty(enemy, 'health', { get() { throw new Error('точное HP игрока запрещено') } })
  const sample = (hits: number, damageLow: number, damage: number, healing: number) => {
    enemy.pressure = { hits, damageLow, damage, healing }
    ineffectiveDamage(pvpState(board), team, [enemy])
    return pvpState(board).dislodge
  }

  // arena22.out 01:30:47, 01:31:11, 01:31:14: три реальные выборки перед быстрыми сменами режима.
  for (const [hits, low, high, healed, boundary] of [[2, 11, 12, 12.3, 8], [2, 15.3, 15.3, 12.1, 10.2], [4, 16.6, 18.8, 12.4, 11.3]]) {
    board.resetRound()
    assert.equal(sample(hits, low, high, healed), true)
    // Соседние значения у старой границы 8-секундного окна — не новый успешный размен.
    for (let i = 0; i < 20; i++) {
      assert.equal(sample(hits, low, high, boundary - .1), true, 'малая смена healing не отменяет прежнее свидетельство')
      assert.equal(sample(hits, low, high, boundary + .1), true)
    }
    assert.equal(sample(3, 18, 18, 1), false, 'подтверждённый чистый урон перекрывает прежнее лечение')
  }
  // arena21.out 01:26:40: 0.6..1.6 при лечении 1.6 — тоже слабое свидетельство, не таймер.
  assert.equal(sample(1, .6, 1.6, 1.6), true)
  assert.equal(sample(3, 15, 15, 0), false, 'обычный бой возобновляется сразу при достаточном прогрессе')
  assert.equal(sample(1, .1, .2, 0), true, 'слабое попадание не обгоняет регенерацию за окно неуязвимости')
  assert.equal(sample(1, .34, .34, 0), true, 'пересечение границы регенерации одним попаданием тоже не обнуляет свидетельство')
  assert.equal(sample(3, 15, 15, 0), false)
  assert.equal(sample(2, 11, 12, 12.3), true)
  assert.equal(sample(0, 0, 0, 0), false, 'пустое окно не является новым доказательством бесполезности')
  assert.equal(sample(1, 5, 5, 0), false)
  assert.equal(sample(2, 11, 12, 12.3), true)
  ineffectiveDamage(pvpState(board), team, [])
  assert.equal(pvpState(board).dislodge, false, 'без видимого врага режим не навязывается')
  assert.equal(sample(2, 11, 12, 12.3), true)
  board.resetRound()
  assert.equal(sample(1, 5, 5, 0), false, 'новый раунд очищает накопленное свидетельство')
})
