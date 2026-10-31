import test from 'node:test'
import assert from 'node:assert/strict'
import { blockOnRay } from '../src/pick'
import { Vec3 } from 'vec3'

test('ordinary sight shapes do not decode unrelated block properties', () => {
  const full = [[0, 0, 0, 1, 1, 1]]
  for (const name of ['air', 'water', 'stone', 'glass', 'oak_stairs']) {
    const solid = !['air', 'water'].includes(name)
    const block = { name, shapes: full, boundingBox: solid ? 'block' : 'empty',
      getProperties () { throw new Error('unrelated state decode') } }
    const hit = blockOnRay({ blockAt: () => block }, new Vec3(.5, .5, .5), new Vec3(0, 0, 1), 2)
    assert.equal(hit?.block ?? null, solid ? block : null, name)
  }
})

test('special picking outlines retain their powered, attached and facing states', () => {
  const cases: Array<[string, any, number[]]> = [
    ['stone_pressure_plate', { powered: false }, [1/16, 0, 1/16, 15/16, 1/16, 15/16]],
    ['stone_pressure_plate', { powered: true }, [1/16, 0, 1/16, 15/16, 1/32, 15/16]],
    ['tripwire', { attached: false }, [0, 0, 0, 1, 8/16, 1]],
    ['tripwire', { attached: true }, [0, 1/16, 0, 1, 2.5/16, 1]],
    ['tripwire_hook', { facing: 'north' }, [5/16, 0, 10/16, 11/16, 10/16, 1]],
    ['tripwire_hook', { facing: 'south' }, [5/16, 0, 0, 11/16, 10/16, 6/16]],
    ['tripwire_hook', { facing: 'east' }, [0, 0, 5/16, 6/16, 10/16, 11/16]],
    ['tripwire_hook', { facing: 'west' }, [10/16, 0, 5/16, 1, 10/16, 11/16]]
  ]
  for (const [name, properties, shape] of cases) {
    let reads = 0
    const block = { name, getProperties: () => { reads++; return properties } }
    const bot = { blockAt: p => p.x === 0 && p.y === 0 && p.z === 0 ? block : { name: 'air', boundingBox: 'empty' } }
    const eye = new Vec3((shape[0] + shape[3]) / 2, (shape[1] + shape[4]) / 2, -1)
    const hit = blockOnRay(bot, eye, new Vec3(0, 0, 1), 3)
    assert.equal(hit?.block, block)
    assert.equal(hit?.t, 1 + shape[2])
    assert.equal(reads, 1, name)
    assert.equal(blockOnRay(bot, eye.offset(0, shape[4] - eye.y + .01, 0), new Vec3(0, 0, 1), 3), null, 'ray above the actual contour stays clear')
  }
})
