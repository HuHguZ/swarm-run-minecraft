'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { digUp } from '../src/build'

for (const [label, lavaAt, ceiling] of [
  ['жидкость вместо потолка', [0, 2, 0], false],
  ['лава за потолком', [0, 3, 0], true],
  ['лава сбоку потолка', [1, 2, 0], true]
]) test(`подъём не вскрывает ${label}`, async () => {
  let dug = 0
  const bot = {
    entity: { position: new Vec3(0.5, 0, 0.5) },
    inventory: { items: () => [] },
    blockAt (p) {
      const name = p.x === lavaAt[0] && p.y === lavaAt[1] && p.z === lavaAt[2] ? 'lava'
        : ceiling && p.x === 0 && p.y === 2 && p.z === 0 ? 'stone' : 'air'
      return { name, position: p, boundingBox: name === 'stone' ? 'block' : 'empty' }
    },
    async dig () { dug++ }
  }
  const result = await digUp(bot, { aborted: false }, { blocks: 1, tower: false })
  assert.match(result.stopped || '', /lava|лава/)
  assert.equal(dug, 0, 'защитный блок должен остаться целым')
})
