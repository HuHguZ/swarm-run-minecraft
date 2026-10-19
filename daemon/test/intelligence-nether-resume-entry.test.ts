import test from 'node:test'
import assert from 'node:assert/strict'
import { requireInheritedResumeBody } from '../scenes/lib/scene-nether-resume'

test('living inherited Overworld kit resumes only with the actual recalled portal', () => {
  const inherited = { dimension: 'overworld', health: 20 }
  assert.doesNotThrow(() => requireInheritedResumeBody(inherited, { x: -6, y: 67, z: 6, dimension: 'overworld' }))
  assert.doesNotThrow(() => requireInheritedResumeBody({ dimension: 'the_nether', health: 18 }, undefined))
  for (const portal of [undefined, {}, { x: -6, y: 67, z: NaN }, { x: -6, y: 67, z: 6, dimension: 'the_nether' }]) {
    assert.throws(() => requireInheritedResumeBody(inherited, portal), /actual known Overworld portal/)
  }
})

test('death and unsupported dimensions never become an inherited resume', () => {
  const portal = { x: -6, y: 67, z: 6 }
  for (const body of [{ dimension: 'overworld', health: 0 }, { dimension: 'the_nether', health: 0 }, { dimension: 'the_end', health: 20 }]) {
    assert.throws(() => requireInheritedResumeBody(body, portal), /living inherited/)
  }
})
