import test from 'node:test'
import assert from 'node:assert/strict'
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
