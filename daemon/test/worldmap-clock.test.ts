'use strict'
import { test } from 'node:test'
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import * as os from 'node:os'
import path = require('node:path')
import * as gameClock from '../src/game-clock'
import { WorldMap } from '../src/worldmap'

const dim = 'overworld'
const target = { x: 16, z: 0 }
const origin = { x: 0, z: 0 }
const options = { want: 'animals', maxSteps: 1, avoid: (x, z) => x !== 1 || z !== 0 }

function fixture (t) {
  let wallNow = 1000000
  t.mock.method(gameClock.wall, 'now', () => wallNow)
  const clock = new gameClock.GameClock({ manual: true, epoch: wallNow })
  gameClock.activate(clock)
  t.after(() => { clock.dispose(); gameClock.activate(null) })
  return { clock, wall: ms => { wallNow += ms }, now: () => wallNow }
}

test('live animal hints expire by game ticks while wall time stays still', t => {
  const { clock } = fixture(t)
  const map = new WorldMap()
  map.visit(dim, target)
  map.hint(dim, target, 'animals')
  assert.equal(map.frontier(dim, origin, options).why, 'там видел animals')
  clock.advanceTicks(6001)
  assert.equal(map.frontier(dim, origin, options), null)
})

test('frozen hints stay fresh and later game visits invalidate old sightings', t => {
  const { clock, wall } = fixture(t)
  const map = new WorldMap()
  map.visit(dim, target)
  map.hint(dim, target, 'animals')
  wall(3600000)
  assert.equal(map.frontier(dim, origin, options).why, 'там видел animals')
  clock.advanceTicks(301)
  map.visit(dim, target)
  assert.equal(map.frontier(dim, origin, options), null)
})

test('persisted records retain wall epochs and reload with wall freshness', t => {
  const { clock, wall, now } = fixture(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-worldmap-clock-'))
  const file = path.join(dir, 'worldmap.json')
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir) })
  const map = new WorldMap(dir)
  map.visit(dim, target)
  clock.advanceTicks(6001)
  map.hint(dim, target, 'animals')
  map.save()
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.seen[dim]['1,0'], now())
  assert.equal(saved.hints[dim]['1,0'].animals, now())
  const reloaded = new WorldMap(dir)
  assert.equal(reloaded.frontier(dim, origin, options).why, 'там видел animals')
  wall(300001)
  assert.equal(reloaded.frontier(dim, origin, options), null)
})

test('worldmap save throttling uses wall time instead of accelerated game time', t => {
  const { clock, wall } = fixture(t)
  const map = new WorldMap()
  const save = t.mock.method(map, 'save', () => { map.saveAt = gameClock.wall.now() })
  map.visit(dim, target)
  assert.equal(save.mock.callCount(), 1)
  clock.advanceTicks(601)
  map.visit(dim, target)
  assert.equal(save.mock.callCount(), 1)
  wall(30001)
  map.visit(dim, target)
  assert.equal(save.mock.callCount(), 2)
})
