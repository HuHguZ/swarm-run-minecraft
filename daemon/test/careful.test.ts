'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as careful from '../src/careful'

// Пол: магма под клеткой x = 0 (y 63), дальше камень.
function scene (x = 0.5) {
  const controls: Record<string, boolean> = {}
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(x, 64, 0.5) },
    blockAt: p => ({ name: Math.floor(p.y) === 63 && Math.floor(p.x) === 0 && Math.floor(p.z) === 0 ? 'magma_block' : Math.floor(p.y) <= 63 ? 'stone' : 'air' }),
    getControlState: k => !!controls[k],
    setControlState: (k, v) => { controls[k] = v }
  })
  careful.install({ bot }, bot)
  return { bot, controls }
}

test('on magma and a step from it the body sneaks, off it stands up (MagmaBlock.stepOn spares a careful step)', () => {
  const { bot, controls } = scene(0.5)
  bot.emit('physicTick')
  assert.equal(controls.sneak, true)
  bot.entity.position = new Vec3(1.4, 64, 0.5) // в шаге от магмы
  bot.emit('physicTick')
  assert.equal(controls.sneak, true)
  bot.entity.position = new Vec3(4.5, 64, 0.5)
  bot.emit('physicTick')
  assert.equal(controls.sneak, false)
})

test('a sneak set by a skill is not released by the magma guard', () => {
  const { bot, controls } = scene(4.5)
  controls.sneak = true
  bot.emit('physicTick')
  assert.equal(controls.sneak, true)
})
