import test from 'node:test'
import assert from 'node:assert/strict'

test('riptide → mace arc: a steep native riptide impulse goes high over the foe and falls onto him', () => {
  const { riptideArc, riptideImpulse } = require('../src/navigation/riptide')
  const arc = riptideArc(3, { x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 })
  assert.ok(arc, 'Riptide III reaches 8 blocks with a fall onto him')
  assert.ok(arc.apex >= 5.8 && arc.miss <= 2.5, JSON.stringify(arc))
  assert.ok(riptideImpulse(3, arc.yaw, arc.pitch).y > 0, 'launch goes up')
  // Yaw points at him (mineflayer: −sin(yaw), −cos(yaw)).
  assert.ok(-Math.sin(arc.yaw) > .99)
  assert.equal(riptideArc(1, { x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }), null, 'too far for Riptide I')
  // Вершина — не выше допустимого падения: Тягун I садится с 6–12 бл., Тягун III на 8 бл. — только с 30+ (промах смертелен).
  const low = riptideArc(1, { x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }, 15)
  assert.ok(low && low.apex <= 15, JSON.stringify(low))
  assert.equal(riptideArc(3, { x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }, 15), null)
})
