import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { setupArmsMap } from './arena/map'

test('Colosseum perches stand on real collision supports, not decorative banners', async t => {
  const oldReset = process.env.ARMS_RESET
  process.env.ARMS_RESET = '0'
  t.after(() => { if (oldReset === undefined) delete process.env.ARMS_RESET; else process.env.ARMS_RESET = oldReset })
  t.mock.method(require('./arena/loot'), 'makeStockChests', () => async () => {})
  const perches: any[] = [], commands: string[] = []
  await setupArmsMap({
    i: 31, COLOS_MAP: true, X: 600, Y: 120, Z: 600, bots: [], perches,
    AL: { commands: () => [] }, L: { half: 80, y0: -3, y1: 42, seed: 'test', chests: [], spawnRooms: [] },
    rcon: async (_slot, command) => { commands.push(command); return command.startsWith('execute if block') ? 'Test passed' : '' },
    log: () => {}, sleep: async () => {}
  } as any)
  assert(perches.length > 0, 'valid high positions remain available')
  assert(commands.length > 0, 'the real map setup ran against the offline command fixture')
  const data = require('../daemon/node_modules/minecraft-data')('1.21.11')
  const Block = require('../daemon/node_modules/prismarine-block')(data)
  const g = require('../daemon/arena/build-colosseum').plan({ X: 600, Y: 120, Z: 600, R: 24, ceilH: 16 }).m.g
  const invalid = perches.filter(p => {
    const token = g.pal[g.data[g.i(p.x - 600 - .5, p.y - 120 - 1, p.z - 600 - .5)]]
    const definition = data.blocksByName[token.split('[')[0]]
    return !Block.fromStateId(definition.minStateId, 0).shapes.some(s => s.every((v, i) => v === (i < 3 ? 0 : 1)))
  })
  assert.deepEqual(invalid, [], 'a non-colliding decoration cannot advertise a landing support')
})

test('arms controller restart parks online fighters, restores the map, and brings them back before playing', async t => {
  const entry = path.join(__dirname, 'arena/ffa.js'), load = createRequire(entry)
  const source = fs.readFileSync(entry, 'utf8').split('const [cmd, slot, arg] = process.argv.slice(2)')[0]
  const b = { name: 'NeuroFarm31', ws: 8831 }, phases: string[] = []
  const stop = new Error('startup complete'), oldReset = process.env.ARMS_RESET
  delete process.env.ARMS_RESET
  t.after(() => { if (oldReset === undefined) delete process.env.ARMS_RESET; else process.env.ARMS_RESET = oldReset })
  const read = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (file, ...args) => String(file).endsWith('colos-stash-31.json')
    ? '{"at":"600 120 600 h1 y0..0"}' : read(file, ...args))
  t.mock.method(load('./fleet'), 'restoreRoundRoster', async (slot, bots, _rcon, rebuild, _report, home) => {
    assert.equal(slot, 31); assert.deepEqual(bots.map(bot => bot.name), [b.name])
    assert.deepEqual(home, { x: 600.5, y: 124, z: 600.5 })
    phases.push('nether'); await rebuild(); phases.push('overworld'); return new Set([b.name])
  })
  t.mock.method(load('./loot'), 'makeStockChests', () => async () => {})
  const rcon = async (_i, command) => {
    if (command === `gamemode spectator ${b.name}`) phases.push('spectator')
    if (command.startsWith('clone ')) { phases.push('restore'); return 'Successfully cloned' }
    if (command.startsWith('execute if block')) return 'Test passed'
    if (command === 'list') return 'There are 0 of a max of 40 players online:'
    return ''
  }
  const run = runInNewContext(source + '\nrun', { exports: {}, console, process: { env: { ARMS_MAP: 'colosseum' } },
    require: spec => spec === './fleet' ? { discover: async () => [b], client: () => ({ ready: Promise.resolve(), call: async method => { phases.push(method) } }) }
      : spec === './server' ? { LAN: 0, rcon } : spec === 'fs' ? { statSync() { throw stop } }
      : spec.endsWith('colosseum-arms') ? { generate: () => ({ half: 1, y0: 0, y1: 0, seed: 'test', chests: [] }), commands: () => [] } : load(spec)
  })
  await assert.rejects(run(31, 'arms', { arms: true }), error => error === stop)
  assert.deepEqual(phases, ['nether', 'restore', 'overworld', 'connect', 'spectator', 'temper', 'play_mode'])
})
