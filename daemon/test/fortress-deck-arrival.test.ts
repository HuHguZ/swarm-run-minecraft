import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
const { Vec3 } = require('vec3')

function scene({ visible = true, floor = true, boreY = 62, abort = false, landed = false } = {}) {
  const top = new Vec3(0, 63, 0)
  const bot: any = { entity: { position: landed ? new Vec3(.5, 64, .5) : new Vec3(-1.5, 62, .5) },
    pathfinder: { thinkTimeout: 5000, setGoal() {} },
    blockAt: p => ({ name: floor ? 'nether_bricks' : 'air', position: p.floored(), boundingBox: floor ? 'block' : 'empty', shapes: floor ? [[0, 0, 0, 1, 1, 1]] : [] }) }
  const ctl = { aborted: abort }, goals: any[] = [], bores: any[] = []
  const file = path.resolve(__dirname, '../src/fortress.ts'), native = createRequire(file)
  const context: any = { module: { exports: {} }, console, process, require: name =>
    name === './game-clock' ? { now: () => 0, setTimeout: () => 0, clearTimeout() {} } :
    name === './pick' ? { blockSeen: () => visible } :
    name === './movement' ? {
      ...native(name), stuckGuard: () => ({ promise: new Promise(() => {}), stop() {} }),
      gotoPath: (_bot, goal) => {
        goals.push(goal)
        // Only path completion is doubled. Both goals and their arrival
        // predicates are the installed native library, at the actual low pose.
        return goal.isEnd(bot.entity.position.floored()) ? Promise.resolve() : Promise.reject(new Error('deck not reached'))
      }
    } : name === './nether' ? {
      guarded: (_session, child, run) => run(child),
      bore: async (_session, _ctl, _target, options) => {
        bores.push(options)
        if (boreY === 64) bot.entity.position = new Vec3(.5, 64, .5)
        return { dug: 0, why: 'no physical ascent' }
      }
    } : native(name) }
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, context)
  return { bot, ctl, top, goals, bores, run: () => context.module.exports.climbTo({ bot }, ctl, top, 100000) }
}

test('a seen deck cannot be reached by stopping two blocks below its walking floor', async () => {
  const s = scene()
  const r = await s.run()
  assert.equal(r.ok, false)
  assert.equal(s.goals[0].constructor.name, 'GoalBlock')
  assert.equal(s.goals[0].isEnd({ x: -2, y: 62, z: 0 }), false)
})

test('an actual landing on the seen deck is accepted', async () => {
  const s = scene({ landed: true })
  assert.equal((await s.run()).ok, true)
  assert.equal(s.bores.length, 0)
})

for (const options of [{ visible: false }, { floor: false }]) test(`an inferred or occluded target retains its existing near approach ${JSON.stringify(options)}`, async () => {
  const s = scene(options)
  assert.equal((await s.run()).ok, true)
  assert.equal(s.goals[0].constructor.name, 'GoalNear')
})

test('a partial upward bore still below a confirmed deck cannot claim arrival', async () => {
  const s = scene()
  assert.equal((await s.run()).ok, false)
  assert.equal(s.bores.length, 1, 'the remaining physical two-block ascent can use the existing bore')
})

test('the existing bore can complete the exact remaining deck ascent', async () => {
  const s = scene({ boreY: 64 })
  assert.equal((await s.run()).ok, true)
  assert.equal(s.bores[0].maxY, 64)
})

test('a cancelled deck approach never begins another excavation', async () => {
  const s = scene({ abort: true })
  assert.equal((await s.run()).ok, false)
  assert.equal(s.bores.length, 0)
})
