import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const { Vec3 } = require('vec3')

test('real fortress tour credits new physical stops once, not successful path promises without movement', async () => {
  const file = path.resolve(__dirname, '../src/fortress.js')
  const bot: any = { game: { dimension: 'the_nether' }, health: 20,
    entity: { position: new Vec3(0, 64, 0) } }
  let moving = true
  const context: any = { require: createRequire(file), module: { exports: {} }, console: { log () {} }, process,
    testBot: bot, move: () => { if (moving) bot.entity.position.x += 20 } }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    look = () => ({ seen: 1, seenList: [testBot.entity.position.offset(2, -1, 0)] });
    keepBlocks = async () => null;
    spawnerHint = () => ({ x: testBot.entity.position.x + 20, z: 0, by: 'пирог', yaw: 90 });
    climbTo = legTo = async () => { move(); return { ok: true }; };
  `, context)
  const session: any = { bot, mcData: {} }
  const first = await context.module.exports.tour(session, { aborted: false }, { deadline: Infinity, hops: 3, pie: true })
  assert.equal(first.explored, 3, 'three new actual observation stops are useful without any rods yet')
  moving = false
  const stuck = await context.module.exports.tour(session, { aborted: false }, { deadline: Infinity, hops: 5, pie: true })
  assert.equal(stuck.explored, 4, 'only the final new stop counts when movement stops')
  const again = await context.module.exports.tour(session, { aborted: false }, { deadline: Infinity, hops: 5, pie: true })
  assert.equal(again.explored, 4, 'repeated promises and looks from the same spot do not postpone failure handling')
  assert.equal(session._ndTourVisited.points.length, 4, 'stuck retries do not grow the route history')
})
