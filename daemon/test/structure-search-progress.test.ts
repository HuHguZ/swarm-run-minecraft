import test from 'node:test'
import assert from 'node:assert/strict'
import { scoutStructures, type SearchPosition, type StructureSearchPort } from '../src/campaign/structure-search'

function fixture() {
  const state = { now: 0, position: { x: 37, y: 68, z: 119 }, explores: 0, moves: [] as Array<{ point: SearchPosition; seconds: number }>, interrupted: false }
  const facts: Record<string, unknown> = {}
  const port: StructureSearchPort = {
    now: () => state.now, position: () => state.position, interrupted: () => state.interrupted,
    scan: async () => {}, list: async () => [],
    explore: async () => { state.explores++; state.now += 2700 },
    move: async (point, seconds) => { state.moves.push({ point, seconds }); state.now += 2700 },
    fact: (name, value) => { facts[name] = value }, log() {}
  }
  return { state, facts, port }
}

test('a delayed no-path scout attempts physical recovery before another stationary scan', async () => {
  const f = fixture()
  const move = f.port.move
  f.port.move = async (point, seconds) => { await move(point, seconds); f.state.position.x++ }
  f.port.list = async () => f.state.moves.length ? [{ kind: 'village', at: { x: 90, y: 68, z: 119 } }] : []
  assert.equal((await scoutStructures(f.port, 0)).found, true)
  assert.equal(f.state.explores, 1)
  assert.deepEqual(f.state.moves, [{ point: { x: 37, z: 59 }, seconds: 30 }])
})

test('slow explore and slow recovery without movement stop after the existing three attempts', async () => {
  const f = fixture()
  const result = await scoutStructures(f.port, 0)
  assert.equal(f.state.explores, 3)
  assert.equal(f.state.moves.length, 3)
  assert.deepEqual(result, { spentMs: 16200, found: false, blocked: true })
  assert.equal(f.facts.structure_search_blocked, true)
})

for (const elapsed of [0, 2700]) test(`physical exploration progress needs no recovery even after ${elapsed} ms`, async () => {
  const f = fixture()
  f.port.explore = async () => { f.state.explores++; f.state.now += elapsed; f.state.position.x++ }
  f.port.list = async () => f.state.explores >= 2 ? [{ kind: 'shipwreck', at: { x: 45, z: 119 } }] : []
  assert.equal((await scoutStructures(f.port, 0)).found, true)
  assert.equal(f.state.explores, 2)
  assert.equal(f.state.moves.length, 0)
})

test('a physical climb also counts as exploration progress', async () => {
  const f = fixture()
  f.port.explore = async () => { f.state.explores++; f.state.now += 2700; f.state.position.y++ }
  f.port.list = async () => f.state.explores >= 2 ? [{ kind: 'village', at: { x: 37, y: 70, z: 121 } }] : []
  assert.equal((await scoutStructures(f.port, 0)).found, true)
  assert.equal(f.state.moves.length, 0)
})

test('interruption after a stationary scout cannot start recovery', async () => {
  const f = fixture()
  f.port.explore = async () => { f.state.explores++; f.state.now += 2700; f.state.interrupted = true }
  assert.deepEqual(await scoutStructures(f.port, 0), { spentMs: 2700, found: false, blocked: false })
  assert.equal(f.state.moves.length, 0)
})

test('a stationary scout at its deadline cannot start recovery', async () => {
  const f = fixture()
  f.port.explore = async (_direction, seconds) => { f.state.explores++; f.state.now += seconds * 1000 }
  assert.deepEqual(await scoutStructures(f.port, 0, 2000), { spentMs: 2000, found: false, blocked: false })
  assert.equal(f.state.moves.length, 0)
})

test('recovery receives only the remaining search budget', async () => {
  const f = fixture()
  f.port.move = async (point, seconds) => { f.state.moves.push({ point, seconds }); f.state.now += seconds * 1000 }
  assert.deepEqual(await scoutStructures(f.port, 175000), { spentMs: 180000, found: false, blocked: false })
  assert.deepEqual(f.state.moves, [{ point: { x: 37, z: 59 }, seconds: 2.3 }])
})
