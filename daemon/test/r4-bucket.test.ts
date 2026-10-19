'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { useAt } from '../src/cast1'
test('bucket re-aims after click spacing, before sending use_item', async () => {
  const aim = new Vec3(2, 0.8, 0); let gaze; let empty = 1; let sent
  const bot = { _ndCast1Last: Date.now(), heldItem: { name: 'bucket' },
    inventory: { items: () => empty ? [{ name: 'bucket', count: 1 }] : [{ name: 'water_bucket', count: 1 }] },
    lookAt: async p => { gaze = p }, activateItem: () => { sent = gaze; empty = 0 } }
  const timer = setTimeout(() => { gaze = new Vec3(99, 99, 99) }, 15)
  try { assert.equal(await useAt(bot, aim, 'bucket', { tries: 1, wait: 20 }), true); assert.equal(sent, aim) }
  finally { clearTimeout(timer) }
})
