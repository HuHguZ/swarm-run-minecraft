import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { body } from './ow-golden-source'

const campaign = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')

test('lava survey cache admits a new elevated view at the same horizontal position', async () => {
  let scans = 0
  const globals: any = { dim: () => 'overworld', known: {}, process: { env: {} }, sense: async () => {},
    sit: { surface: true }, state: { pos: { x: 0, y: 64, z: 0 } }, skyLookAt: null, log: () => {},
    act: async () => { scans++; return { detail: {} } } }
  const look = body(campaign, 'async function skyLavaLook (', 'let lavaSourceKnown', globals, 'skyLavaLook')
  await look()
  await look()
  assert.equal(scans, 1)
  globals.state.pos.y += 10
  await look()
  assert.equal(scans, 2)
})

test('a new lava lookout remains available after two old attempts; poor health raises its price', async () => {
  let height = 64
  const calls: string[] = []
  const globals: any = { dim: () => 'overworld', known: {}, sense: async () => {}, sit: { surface: true, inWater: false },
    state: { pos: { x: 0, y: 64, z: 0 }, health: 2 }, died: false, strategyInterrupted: false, lavaSourceKnown: false,
    lavaLookoutCells: new Set(), y: () => height, skyLookAt: null,
    have: (re: any) => typeof re === 'string' ? re === 'dirt' ? 16 : 0 : 1, COBBLE: /^cobblestone$/, log: () => {},
    skyLavaLook: async () => { calls.push('survey') },
    act: async (_method: string, p: any) => { calls.push(p.direction); height += p.direction === 'up' ? 10 : -10; return { status: 'done', detail: {} } }
  }
  const lookout = body(campaign, 'async function lavaLookout (', 'async function skyLavaLook (', globals, 'lavaLookout')
  await lookout()
  assert.deepEqual(calls, [])
  globals.state.health = 20
  await lookout()
  assert.deepEqual(calls, ['up', 'survey', 'down'])
  await lookout()
  assert.equal(calls.length, 3, 'the same view is not new information')
  globals.state.pos.x = 60
  await lookout()
  assert.equal(calls.length, 6)
})
