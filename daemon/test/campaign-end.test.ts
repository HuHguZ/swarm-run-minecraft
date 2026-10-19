'use strict'
// Кампания: выход к Краю (r4 exit) и крепость Края (s5d).
import test = require('node:test')
import assert = require('node:assert/strict')
import { campaign } from './campaign-fixture'

test('r4 exit: diamond pick and nine obsidian cannot skip bastion reserve', () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 50, z: 0 }, inventory: { blaze_rod: 7, obsidian: 9, diamond_pickaxe: 1, ender_pearl: 12, flint_and_steel: 1 } }
  const c = campaign(state, {} as Record<string, any>, () => ({} as Record<string, any>), { env: { ND_SH_NETHER: '1' } })
  c.known.portal = { x: 0, z: 0 }; c.known.stronghold = { x: 1000, z: 1000 }
  c.known.bastions = [{ key: '??????? (??)', x: 20, z: 20 }]
  assert.equal(c.needs('bastion'), true)
})
test('r4 exit: refuse the trip before movement or spending a link attempt', async () => {
  const calls = []
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 50, z: 0 }, inventory: { obsidian: 9, diamond_pickaxe: 1, flint_and_steel: 1 } }
  const c = campaign(state, {} as Record<string, any>, method => { calls.push(method); return {} as Record<string, any> }, { env: { ND_SH_NETHER: '1' } })
  assert.equal(await c.viaNetherTo({ x: 1000, z: 1000 }, 'test'), false)
  assert.equal(calls.some(m => ['goto','nether_tunnel','ne_route','portal','stronghold'].includes(m)), false)
})
test('r4 exit: missing igniter keeps bastion needed even at ten obsidian', () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', inventory: { blaze_rod: 7, obsidian: 10, ender_pearl: 12 } }
  const c = campaign(state, {} as Record<string, any>, () => ({} as Record<string, any>), { env: { ND_SH_NETHER: '1' } })
  c.known.portal = {} as Record<string, any>; c.known.stronghold = {} as Record<string, any>; c.known.bastions = [{ key: '??????? (??)', x: 0, z: 0 }]
  assert.equal(c.needs('bastion'), true)
})
test('r4 exit: explicit disable restores the former diamond-pick policy', () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', inventory: { blaze_rod: 7, obsidian: 9, diamond_pickaxe: 1, ender_pearl: 12 } }
  const c = campaign(state, {} as Record<string, any>, () => ({} as Record<string, any>), { env: { ND_SH_NETHER: '1', ND_EXIT_KIT: '0' } })
  c.known.portal = {} as Record<string, any>; c.known.stronghold = {} as Record<string, any>; c.known.bastions = [{ key: '??????? (??)', x: 0, z: 0 }]
  assert.equal(c.needs('bastion'), false)
})

test('r4 exit: finding the room fills and enters in the same campaign stage', async () => {
  const calls = []
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: -883, y: -3, z: -1405 }, inventory: { ender_eye: 12 } }
  const c = campaign(state, { surface: false, foes: 0 }, (method, params) => {
    calls.push({ method, params })
    if (method === 'stronghold' && params.mode === 'room') return { room: { centre: { ...state.pos, y: -4 } } }
    if (method === 'stronghold' && params.mode === 'fill') { state.dimension = 'the_end'; return { entered: true } }
    return {} as Record<string, any>
  }, { env: { ND_ENDKIT: '0', ND_END_ENTRY: '1' } })
  c.known.stronghold = { x: -883, z: -1405, room: { x: -883, y: -4, z: -1405 } }
  c.hooks({ recoverGuard: async () => {} })
  await c.runStage('stronghold')
  const portal = calls.filter(c => c.method === 'stronghold')
  assert.deepEqual(portal.map(c => c.params.mode), ['room', 'fill'])
  assert.equal(portal[1].params.enter, true)
  assert.equal(state.dimension, 'the_end')
  assert.equal(c.needs('stronghold'), false)
})

test('r4 exit: a stopped mapped-room approach is not retried six times in one stage', async () => {
  let rooms = 0
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: -883, y: -3, z: -1405 }, inventory: { ender_eye: 12 } }
  const c = campaign(state, { surface: false, foes: 0 }, (method, params) => {
    if (method === 'stronghold' && params.mode === 'room') { rooms++; return { stopped: 'lava near the tunnel face' } }
    return {} as Record<string, any>
  }, { env: { ND_ENDKIT: '0' } })
  c.known.stronghold = { x: -883, z: -1405, room: { x: -883, y: -4, z: -1405 } }
  c.hooks({ recoverGuard: async () => {} })
  await c.runStage('stronghold')
  assert.equal(rooms, 1)
})

// S5d (07.10): к крепости Края через Ад — по умолчанию; рама (10 обсидиана) и огниво есть, крепость дальше 500 — сперва в Ад.
test('s5d: stronghold far away with a frame kit goes through the Nether by default, ND_SH_NETHER=0 walks', async () => {
  for (const [env, viaNether] of [[{}, true], [{ ND_SH_NETHER: '0' }, false]] as const) {
    const calls = []
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 70, z: 0 }, inventory: { ender_eye: 12, obsidian: 10, flint_and_steel: 1, cooked_beef: 8 } }
    const c = campaign(state, { surface: true, foes: 0 }, (method, params) => { calls.push({ method, params }); return {} as Record<string, any> }, { env: { ND_ENDKIT: '0', ...env } })
    c.known.portal = { x: 1, y: 70, z: 1 }; c.known.stronghold = { x: 1500, z: 0 }
    await c.runStage('stronghold').catch(() => {})
    const first = calls.findIndex(x => x.method === 'portal' && x.params && x.params.mode === 'enter')
    const walk = calls.findIndex(x => x.method === 'goto')
    assert.equal(first >= 0 && (walk < 0 || first < walk), viaNether, JSON.stringify(calls.slice(0, 6).map(x => x.method)))
  }
})
