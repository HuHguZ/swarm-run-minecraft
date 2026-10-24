import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { hazardMethods } from '../src/rpc/hazards'

test('evade keeps the usual descent, avoids a pit with maxDrop=0 and stops when the next support breaks', async () => {
  for (const c of [{ maxDrop: undefined, broken: false }, { maxDrop: 0, broken: false }, { maxDrop: 0, broken: true }]) {
    let sleeps = 0, stopped = false
    const bot: any = { entity: { position: new Vec3(.5, 64, .5), onGround: true, yaw: 0 },
      inventory: { items: () => [] }, pathfinder: { setGoal () {} }, blockAt(p) {
        const q = p.floored(), floor = c.broken && sleeps ? 60 : q.x < 0 ? 60 : 63
        const solid = q.y <= floor
        return { position: q, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty',
          shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
      }, setControlState () {}, clearControlStates () { stopped = true },
      async look(yaw) { bot.entity.yaw = yaw } }
    const session = { require: () => bot, runIntent: async (_name, work) => work({ aborted: false }) }
    const rpc = hazardMethods({ session, gameClock: { sleep: async () => { sleeps++ } } })
    const result = await rpc.evade({ dir: { x: -1, z: 0 }, ticks: 3, jump: false, dropOk: false, maxDrop: c.maxDrop })
    if (c.broken) {
      assert.equal(result.ok, false)
      assert.match(result.why, /пол по ходу исчез/)
      assert.equal(sleeps, 1, 'the route is checked again after the first tick')
    } else {
      assert.equal(result.ok, true)
      assert.equal(result.dir.x < -.1, c.maxDrop !== 0, 'floor reaction must not choose the three-block pit')
      assert.equal(sleeps, 3)
    }
    assert.equal(stopped, true)
  }
})
