import { moduleSourceTs } from './source-fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { body } from './ow-golden-source'

function explorer(direction: string | null) {
  const source = moduleSourceTs(path.join(__dirname, '../src/actions.ts')) /* фасад + части src/actions/** */
  let time = 0
  const targets: number[][] = []
  const bot: any = { entity: { position: { x: 0, y: 64, z: 0 } }, pathfinder: { movements: {} } }
  const explore = body(source, 'async function explore (', '// ---------------------------------------------------------------- place', {
    gameClock: { now: () => time }, resolveBlockIds: () => [], xyz: (p: any) => ({ ...p }), firstVisible: () => null,
    require: () => ({ worldOf: () => 'overworld', leaveSealedCell: async () => {} }),
    SWEEP: [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]], COMPASS: { east: [1, 0] },
    process: { env: {} }, console: { log: () => {} },
    travelXZ: async (_b: any, _ctl: any, x: number, z: number) => {
      targets.push([x, z]); bot.entity.position = { x, y: 64, z }; time += 1000; return { ok: true }
    }
  }, 'explore')
  return { targets, run: () => explore({ bot, mcData: {}, cfg: { fairPlay: true } }, { aborted: false }, { radius: 1, stepDistance: 60, timeoutSeconds: 8, direction }) }
}

test('blind exploration rays stay anchored: a successful east/south/west/north sweep does not return to spawn', async () => {
  const f = explorer(null)
  await f.run()
  assert.deepEqual(f.targets.slice(0, 4), [[60, 0], [0, 60], [-60, 0], [0, -60]])
  assert(f.targets.every(([x, z]) => Math.hypot(x, z) >= 60))
})

test('directed exploration advances by one segment instead of accumulating triangular distances', async () => {
  const f = explorer('east')
  await f.run()
  assert.deepEqual(f.targets.slice(0, 3), [[60, 0], [120, 0], [180, 0]])
})
