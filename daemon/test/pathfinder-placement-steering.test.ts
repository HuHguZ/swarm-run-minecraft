'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { transformSync } = require('esbuild')
const { Vec3 } = require('vec3')

// Reuse the installed-library fixture without running its unrelated tests.
const fixtureFile = path.join(__dirname, 'tick-plugins.test.ts')
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split('\ntest(')[0]
const fixture = new Function('require', 'module', 'exports', transformSync(fixtureSource + '\nmodule.exports = { install, testClock, block }', {
  loader: 'ts', format: 'cjs', target: 'node22'
}).code)
const helpers: any = { exports: {} }
fixture(createRequire(fixtureFile), helpers, helpers.exports)

function scene() {
  const { install, testClock, block } = helpers.exports
  const bot = install(testClock(750), { pathfinder: true, physicsEnabled: false })
  const mv = new (require('mineflayer-pathfinder').Movements)(bot)
  mv.canDig = false; mv.allow1by1towers = false
  mv.getScaffoldingItem = () => ({ type: bot.registry.itemsByName.cobblestone.id, count: 8 })
  bot.pathfinder.setMovements(mv)
  const node = (toPlace = []) => Object.assign(new Vec3(1.5, 1, .5), { toBreak: [], toPlace })
  let next = node([{ x: 0, y: 0, z: 0, dx: 1, dy: 0, dz: 0 }])
  bot.pathfinder.getPathTo = () => ({ status: 'success', path: [next] })
  bot.pathfinder.setGoal(new (require('mineflayer-pathfinder').goals.GoalBlock)(4, 1, 0))
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
