'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as gaze from '../src/gaze'
import { starer } from '../src/dragon/dig-down-to'

// Тело на ровном месте смотрит на север (yaw 0 → −z) прямо в глаза эндермену в 20 бл. (глаза на 2.55 над его ногами).
function scene ({ intent = null, digging = false }: any = {}) {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: Math.atan2(2.55 - 1.62, 20), height: 1.8 },
    entities: { 7: { id: 7, name: 'enderman', position: new Vec3(0.5, 64, -19.5) } },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    targetDigBlock: digging ? {} : null,
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  })
  gaze.install({ bot, current: intent ? { name: intent } : null }, bot)
  return bot
}

const tick = async bot => { bot.emit('physicTick'); await new Promise(resolve => setImmediate(resolve)) }

test('between deeds the body looks off an enderman\'s eyes (cl-al 14.10: provoked at night, 20 hp to 0)', async () => {
  const bot = scene()
  assert.ok(starer(bot, bot.entity.yaw, bot.entity.pitch), 'stares before the tick')
  await tick(bot)
  assert.equal(starer(bot, bot.entity.yaw, bot.entity.pitch), null)
  assert.equal(bot.entity.yaw, 0, 'only the head tilts')
})

test('the gaze guard leaves digging and the deliberate pearl hunt alone', async () => {
  for (const bot of [scene({ digging: true }), scene({ intent: 'pearls' })]) {
    const pitch = bot.entity.pitch
    await tick(bot)
    assert.equal(bot.entity.pitch, pitch)
  }
})
