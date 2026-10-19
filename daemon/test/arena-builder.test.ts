import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { arenaPlan } from '../arena/arena-builder'
import { terrainHeightAt, pitAt } from '../arena/arena-terrain'

test('farm colosseum rests on measured ground and has an open sky and a deep lava moat', () => {
  const plan = arenaPlan({ min: 65, max: 82 })
  assert.equal(plan.arena.y, 86)
  assert.equal(plan.box[0][1], 65)
  assert.ok(!plan.commands.some(command => command.includes('minecraft:barrier')))
  const observed = new Map(plan.samples.map((point, i) => [i, 'unknown']))
  for (const command of plan.commands) {
    const parts = command.split(' ')
    if (parts[0] !== '/fill' && parts[0] !== '/setblock') continue
    const from = parts.slice(1, 4).map(Number)
    const to = parts[0] === '/fill' ? parts.slice(4, 7).map(Number) : from
    const block = parts[parts[0] === '/fill' ? 7 : 4].replace('minecraft:', '')
    if (parts[0] === '/fill') assert.ok((to[0] - from[0] + 1) * (to[1] - from[1] + 1) * (to[2] - from[2] + 1) <= 32768)
    for (const [i, p] of plan.samples.entries()) {
      if (p.x >= from[0] && p.x <= to[0] && p.y >= from[1] && p.y <= to[1] && p.z >= from[2] && p.z <= to[2]) observed.set(i, block)
    }
  }
  for (const [i, p] of plan.samples.entries()) assert.equal(observed.get(i), p.block, JSON.stringify(p))
})

test('terrain is fair under rotation, has reachable hills, cliffs and visible internal lava pits', () => {
  const plan = arenaPlan({ min: 39, max: 102 })
  const profile = plan.terrain
  assert.equal(plan.arena.y, 106, 'rebuild uses the saved ground rather than scanning its own colosseum')
  assert.equal(profile.maxHeight, 9)
  for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) {
    assert.equal(terrainHeightAt(profile, x, z), terrainHeightAt(profile, -x, -z), `unfair ${x},${z}`)
    assert.equal(!!pitAt(profile, x, z), !!pitAt(profile, -x, -z))
  }
  for (const spawn of profile.safeStarts) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      assert.equal(terrainHeightAt(profile, spawn.x + dx, spawn.z + dz), 0)
      assert.equal(pitAt(profile, spawn.x + dx, spawn.z + dz), undefined)
    }
  }
  const reachable = new Set(['0,0'])
  const pending: Array<[number, number]> = [[0, 0]]
  for (let i = 0; i < pending.length; i++) {
    const [x, z] = pending[i]
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const nz = z + dz; const key = `${nx},${nz}`
      if (Math.abs(nx) > 24 || Math.abs(nz) > 24 || reachable.has(key) || pitAt(profile, nx, nz) ||
        Math.abs(terrainHeightAt(profile, nx, nz) - terrainHeightAt(profile, x, z)) > 1) continue
      reachable.add(key); pending.push([nx, nz])
    }
  }
  for (const hill of profile.hills) assert.ok(reachable.has(`${hill.x},${hill.z}`), `hill requires cheating to ascend ${hill.x},${hill.z}`)
  assert.ok(terrainHeightAt(profile, 17, 10) - terrainHeightAt(profile, 18, 10) >= 4, 'cliff is an actual geometric height drop')
  assert.ok(profile.pits.every(pit => Math.abs(pit.x) + pit.radius < 24 && Math.abs(pit.z) + pit.radius < 24))
  assert.ok(plan.samples.filter(probe => probe.block === 'lava').length >= 3, 'both interior pits and the perimeter have actual block witnesses')
})
