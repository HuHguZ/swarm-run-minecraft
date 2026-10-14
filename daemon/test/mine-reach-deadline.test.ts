import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
const Vec3 = require('vec3')

// A log the pathfinder cannot settle on (partial paths around a crown, farm 14.10 taiga: 240 s on one log) costs its own
// deadline, then the next visible log is taken.
const code = transformSync(fs.readFileSync(path.join(__dirname, '../src/actions.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code

test('mine gives up on a block it cannot reach in time and takes the next visible one', async () => {
  let now = 0
  const clock = { now: () => now }
  const stuck = { name: 'spruce_log', type: 1, position: new Vec3(3, 70, 0) }
  const near = { name: 'spruce_log', type: 1, position: new Vec3(0, 64, 4) }
  const blocks = [stuck, near]
  const dug: string[] = []
  const goals: string[] = []
  const bot: any = {
    entity: { position: new Vec3(.5, 64, .5) },
    canDigBlock: b => b === near,
    blockAt: p => blocks.find(b => b.position.equals(p)) || { name: 'air', position: p },
    pathfinder: {
      // The stuck log: a goto that never ends; the clock runs on while it hangs.
      goto: () => { goals.push('goto'); now += 60000; return new Promise(() => {}) },
      setGoal: g => { goals.push(g === null ? 'stop' : 'goal') }
    },
    async dig (b) { dug.push(b.name); blocks.splice(blocks.indexOf(b), 1) }
  }
  const imports: Record<string, any> = {
    './game-clock': clock,
    './movement': { xyz: p => ({ x: p.x, y: p.y, z: p.z }) },
    './items': { GROUPS: {}, resolveBlockIds: () => [1], equipBestTool: async () => {}, missingHarvestTool: () => null, countItems: () => ({}), diffItems: () => ({}) },
    './build': { withTimeout: (p, _ms, message) => Promise.race([p, new Promise((_resolve, reject) => setTimeout(() => reject(new Error(message)), 1))]) },
    'vec3': Vec3,
    'mineflayer-pathfinder': { goals: { GoalLookAtBlock: class { constructor () {} }, GoalNear: class { constructor () {} } } },
    './pick': { eyeHeight: () => 1.62, faceAim: () => true },
    './sight': { visibleOf: (_bot, _ids, _radius, { skip }) => blocks.filter(b => !skip(b.position)).sort((a, b) => b.position.y - a.position.y) }
  }
  const module = { exports: {} as any }
  vm.runInNewContext(code, { module, exports: module.exports, process: { env: {} }, console: { log () {} }, setTimeout,
    require (request) { if (request in imports) return imports[request]; throw new Error(`unexpected dependency ${request}`) } })
  const result = await module.exports.mine({ bot, cfg: { fairPlay: true }, mcData: {} }, { aborted: false, onAbort: [] }, { block: 'spruce_log', count: 2, collect: false })
  assert.deepEqual(dug, ['spruce_log'], 'the reachable log is dug')
  assert.ok(goals.includes('stop'), 'the hung goto is cancelled')
  assert.match(String(result.problems), /не подошёл за \d+ с/)
  assert.equal(result.skipped, 1)
})
