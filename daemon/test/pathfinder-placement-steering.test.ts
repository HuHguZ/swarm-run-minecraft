'use strict'
import * as tickFixture from './tick-plugins-fixture'
import test = require('node:test')
import assert = require('node:assert/strict')
import { Vec3 } from 'vec3'

// Reuse the installed-library fixture without running its unrelated tests.
// Общий стенд установленных библиотек (tick-plugins-fixture) без его тестов.
const helpers: any = { exports: tickFixture }

function scene() {
  const { install, testClock, block } = helpers.exports
  const bot = install(testClock(750), { pathfinder: true, physicsEnabled: false })
  const mv = new ((require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')).Movements)(bot)
  mv.canDig = false; mv.allow1by1towers = false
  mv.getScaffoldingItem = () => ({ type: bot.registry.itemsByName.cobblestone.id, count: 8 }) as any
  bot.pathfinder.setMovements(mv)
  const node = (toPlace = []) => Object.assign(new Vec3(1.5, 1, .5), { toBreak: [], toPlace })
  let next = node([{ x: 0, y: 0, z: 0, dx: 1, dy: 0, dz: 0 }])
  bot.pathfinder.getPathTo = () => ({ status: 'success', path: [next] })
  bot.pathfinder.setGoal(new ((require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')).goals.GoalBlock)(4, 1, 0))
  const tick = () => bot.emit('physicsTick')
  const finishPlacement = () => {
    // The real placed-block update resets native placement without clearing
    // controls; the following publication is an ordinary walking step.
    next = node()
    bot.emit('blockUpdate', block('air', new Vec3(1, 0, 0)), block('cobblestone', new Vec3(1, 0, 0)))
    tick()
  }
  return { bot, tick, finishPlacement, close: () => bot.emit('end') }
}

test('native walking clears backward steering inherited from a placed-block reset', () => {
  const s = scene()
  try {
    s.tick()
    assert.equal(s.bot.getControlState('back'), true, 'actual moveToEdge approaches its placement face backwards')
    s.finishPlacement()
    assert.equal(s.bot.pathfinder.isBuilding(), false)
    assert.equal(s.bot.getControlState('back'), false)
    assert.equal(s.bot.getControlState('forward'), true)
  } finally { s.close() }
})

test('native active bridge placement retains its required backward edge approach', () => {
  const s = scene()
  try {
    s.tick(); s.tick()
    assert.equal(s.bot.pathfinder.isBuilding(), true)
    assert.equal(s.bot.getControlState('back'), true)
    assert.equal(s.bot.getControlState('sneak'), true)
  } finally { s.close() }
})

test('without a walking path native controls are left with their current owner', () => {
  const s = scene()
  try {
    s.bot.pathfinder.setGoal(null)
    s.bot.setControlState('back', true)
    s.tick()
    assert.equal(s.bot.getControlState('back'), true)
  } finally { s.close() }
})
