import { bodySource } from './source-fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import { cjsContext } from './cjs-context'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import AStar = require('mineflayer-pathfinder/lib/astar')
import Move = require('mineflayer-pathfinder/lib/move')
const file = path.join(__dirname, '../src/actions.ts')
const realRequire = createRequire(file)
// facade src/actions.ts + части src/actions/** одной областью видимости
const code = bodySource(file)

function fixture({ wall = false, height = 69 }: any = {}) {
  const target = { name: 'oak_log', type: 1, diggable: true, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: new Vec3(99, height, 2) }
  const bag: Record<string, number> = {}, paths: any[] = [], dug: any[] = []
  const bot: any = { entity: { position: new Vec3(106.5, 64, 9.5) }, entities: {},
    blockAt(p) {
      p = p.floored()
      const log = p.x === 99 && p.z === 2 && p.y >= 64 && p.y <= height
      const solid = log || p.y < 64 || wall && p.y >= 65
      return { name: log ? 'oak_log' : solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
    },
    canDigBlock(b) { return b.position.offset(.5, .5, .5).distanceTo(this.entity.position.offset(0, 1.65, 0)) <= 5.1 },
    async dig(b) { dug.push(b.position); bag.oak_log = 1 }
  }
  bot.world = { raycast: (o, d, range) => realRequire('./pick').blockOnRay(bot, o, d, range)?.block }
  bot.pathfinder = { async goto(goal) {
    const moves = { getNeighbors(n) { return [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dz]) => new Move(n.x + dx, 64, n.z + dz, 0, 1))
      .filter(n => n.x >= 98 && n.x <= 108 && n.z >= 0 && n.z <= 10 && !(n.x === 99 && n.z === 2)) } }
    const p = bot.entity.position.floored()
    const result = new AStar(new Move(p.x, p.y, p.z, 0, 0), moves, goal, 5000, Infinity).compute()
    paths.push(result)
    if (result.status !== 'success') throw new Error('No path')
    const end = result.path.at(-1)
    bot.entity.position = end.offset(.5, 0, .5)
  } }
  const context: any = { module: { exports: {} }, console, process, setTimeout, clearTimeout,
    require: name => name === './items' ? { ...realRequire(name), resolveBlockIds: () => [1], countItems: () => ({ ...bag }),
      diffItems: (_before, after) => after, missingHarvestTool: () => null, equipBestTool: async () => {} }
      : name === './sight' ? { visibleOf: (_bot, _ids, _radius, { skip }) => !skip(target.position) ? [target] : [] } : realRequire(name) }
  vm.runInNewContext(code, cjsContext(context), { filename: file })
  return { bot, paths, dug, mine: () => context.module.exports.mine({ bot, mcData: {}, cfg: { fairPlay: true } },
    { aborted: false, onAbort: [] }, { block: 'any_log', count: 1, collect: false }) }
}

test('mine reaches an upper trunk from the ground using the actual visible face and native AStar', async () => {
  const f = fixture()
  const result = await f.mine()
  assert.equal(result.dug, 1)
  assert.equal(f.paths[0].status, 'success')
  assert.equal(f.bot.entity.position.y, 64)
  assert.equal(f.dug[0].y, 69)
})

for (const options of [{ wall: true }, { height: 72 }]) test('mine does not finish a ground approach through a wall or beyond block reach ' + JSON.stringify(options), async () => {
  const f = fixture(options)
  await assert.rejects(f.mine(), /не вижу|не могу подойти/)
  assert.equal(f.dug.length, 0)
  assert.ok(f.paths.every(p => p.status === 'noPath'))
})
