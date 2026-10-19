'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { install } from '../src/swimming'
function simulate ({ sprint = true, water = true, food = 20, throws = false }: any = {} as Record<string, any>) {
  const bot = { food, physics: { waterInertia: 0.8, waterGravity: 0.005, outOfLiquidImpulse: 0.3,
    simulatePlayer (state, _world?: unknown) {
      if (throws) throw new Error('physics error')
      state.vel.x *= this.waterInertia
      state.vel.y = state.vel.y * this.waterInertia - this.waterGravity
      return state
    } } }
  install(bot)
  const state = { pos: new Vec3(0, 0, 0), vel: new Vec3(0.2, 0.1, 0), control: { sprint, forward: true }, isInWater: water }
  const run = () => bot.physics.simulatePlayer(state, { getBlock: () => ({ name: water ? 'water' : 'air' }) })
  return { bot, state, run }
}
test('спринт в воде сохраняет больше горизонтальной скорости, не меняя всплытие', () => {
  const f = simulate(); f.run()
  assert.ok(Math.abs(f.state.vel.x - 0.18) < 1e-7)
  assert.ok(Math.abs(f.state.vel.y - 0.075) < 1e-7)
  assert.equal(f.bot.physics.waterInertia, 0.8)
})
test('обычное плавание и голод не включают ускорение', () => {
  for (const p of [{ sprint: false }, { food: 6 }, { water: false }]) {
    const f = simulate(p); f.run()
    assert.ok(Math.abs(f.state.vel.x - 0.16) < 1e-7)
  }
})
test('ошибка физики не оставляет изменённые параметры следующему действию', () => {
  const f = simulate({ throws: true })
  assert.throws(f.run, /physics error/)
  assert.equal(f.bot.physics.waterInertia, 0.8)
})
