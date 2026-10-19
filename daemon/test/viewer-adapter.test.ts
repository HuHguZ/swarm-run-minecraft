import test from 'node:test'
import assert from 'node:assert/strict'
import { viewerMapping } from '../src/viewer-adapter'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import Block = require('prismarine-block')
const Chunk: any = require('prismarine-chunk')

test('viewer translates current state IDs by block name and properties without mutating the real world', () => {
  const mapping = viewerMapping('1.21.11')
  const source = Block('1.21.11')
  const target: any = Block(mapping.version)
  const column = new (Chunk('1.21.11'))()
  const at = new Vec3(1, 106, 1)
  const stone = source.fromProperties('polished_andesite', {}, 1)
  column.setBlockStateId(at, stone.stateId)
  const logAt = at.offset(1, 0, 0)
  column.setBlockStateId(logAt, source.fromProperties('spruce_log', { axis: 'x' }, 1).stateId)
  const mapped = mapping.column(column)
  assert.equal(target.fromStateId(mapped.getBlockStateId(at)).name, 'polished_andesite')
  assert.equal(target.fromStateId(mapped.getBlockStateId(logAt)).getProperties().axis, 'x')
  assert.equal(column.getBlockStateId(at), stone.stateId)
  assert.equal(column.getBlock(logAt).getProperties().axis, 'x')
})
