import test from 'node:test'
import assert from 'node:assert/strict'
import { installSight } from './arena/watch'
import * as driver from './swarm/swarm-driver'
const { Vec3 } = require('../daemon/node_modules/vec3')
import { faceAim } from '../daemon/src/pick'

test('lower dig stands come from the actual catalogue floor shape and carry their required top clearance', t => {
  let options: any
  t.mock.method(driver, 'createSwarmDriver', o => { options = o; return {} as any })
  const set: any[] = []
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    set.push([x, -2, z, 'obsidian'], [x, -1, z, 'sandstone'], [x, 0, z, 'air'], [x, 1, z, 'air'])
    for (let y = -64; y < -2; y++) set.push([x, y, z, 'air'])
  }
  set.push([1, -2, 0, 'air'], [0, -2, 1, 'stone_slab[type=bottom]'])
  installSight({ i: 31, arms: true, bots: [], names: [], pos: {}, humans: {}, X: 0, Y: 120, Z: 0, R: 24,
    L: { map: 'colosseum', half: 2, R: 2, y0: -32, areas: [], spawnRooms: [], chests: [], field: [], set },
    log() {}, rcon() {}, alive: () => true, hostile: () => true, armsHome: () => '0 120 0' } as any)
  const site: any = options.digSites({ x: .5, y: 119, z: .5 }).find(s => s.x === 0 && s.y === 119 && s.z === 0)
  assert.ok(site)
  const low = site.stands.filter(s => s.requiresClear?.length)
  assert.ok(low.length > 0)
  assert.equal(low.some(s => s.x === 1.5 && s.z === .5), false, 'no native lower support means no stand')
  const slab = low.find(s => s.x === .5 && s.z === 1.5)
  assert.equal(slab.y, 118.5, 'use the actual native bottom-slab top, not feetY minus one')
  assert.deepEqual(slab.requiresClear, [{ x: 0, y: 119, z: 1 }])
  assert.deepEqual(slab.support, { x: 0, y: 118, z: 1 })
})

test('far lower work stands require the real native support and every removed upper cell on their visible dig ray', t => {
  let options: any
  t.mock.method(driver, 'createSwarmDriver', o => { options = o; return {} as any })
  const set: any[] = []
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) {
    set.push([x, -2, z, 'obsidian'], [x, -1, z, 'sandstone'], [x, 0, z, 'air'], [x, 1, z, 'air'])
    for (let y = -64; y < -2; y++) set.push([x, y, z, 'air'])
  }
  set.push([-3, -2, -2, 'air'])
  installSight({ i: 31, arms: true, bots: [], names: [], pos: {}, humans: {}, X: 0, Y: 120, Z: 0, R: 24,
    L: { map: 'colosseum', half: 4, R: 4, y0: -32, areas: [], spawnRooms: [], chests: [], field: [], set },
    log() {}, rcon() {}, alive: () => true, hostile: () => true, armsHome: () => '0 120 0' } as any)
  const site = options.digSites({ x: .5, y: 119, z: .5 }).find(s => s.x === 0 && s.y === 119 && s.z === 0)
  const stand = site.stands.find(s => s.x === 3.5 && s.y === 119 && s.z === 2.5)
  assert.ok(stand, 'native reach permits a real stand beyond enemy melee reach')
  assert.deepEqual(stand.support, { x: 3, y: 118, z: 2 })
  assert.ok(stand.requiresClear.some(q => q.x === 3 && q.y === 119 && q.z === 2), 'the standing upper cell must really be removed')
  assert.ok(stand.requiresClear.some(q => q.x === 0 && q.y === 119 && q.z === 0), 'the target top must really be removed')
  assert.ok(stand.requiresClear.length > 2, 'the intermediate upper floor blocks may not be treated as air')
  assert.equal(site.stands.some(s => s.x === -2.5 && s.y === 119 && s.z === -1.5), false, 'missing lower support is not invented')
  const registry = require('../daemon/node_modules/prismarine-registry')('1.21.11'), Block = require('../daemon/node_modules/prismarine-block')(registry)
  const clear = new Set(stand.requiresClear.map(q => `${q.x},${q.y},${q.z}`))
  const bot: any = { registry, entity: { position: new Vec3(stand.x, stand.y, stand.z), width: .6, height: 1.8 }, entities: {}, blockAt(q) {
    const p = q.floored(), name = clear.has(`${p.x},${p.y},${p.z}`) ? 'air' : p.y === 119 ? 'sandstone' : p.y === 118 ? 'obsidian' : 'air'
    const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = p; return b
  } }
  assert.ok(faceAim(bot, new Vec3(0, 118, 0), new Vec3(0, 1, 0)), 'all and only confirmed corridor removals expose the actual native lower face')
})
