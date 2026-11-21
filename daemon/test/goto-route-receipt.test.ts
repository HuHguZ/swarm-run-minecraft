import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { Session } from '../src/session'
import { EventBus } from '../src/events'

test('ordinary goto exposes an exhausted native NoPath with its own endpoint and preserves competing outcomes', async () => {
  for (const result of ['noPath', 'timeout', 'cancelled', 'arrival']) {
    const session = new Session({}, new EventBus(), { state: {}, append() {} })
    const origin = new Vec3(.5, 120, .5)
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: origin.clone(), onGround: true }, blockAt: () => null, clearControlStates() {},
      pathfinder: { movements: { canDig: true, scafoldingBlocks: [] }, setGoal(goal) {
        if (!goal) return
        setImmediate(() => {
          if (result === 'cancelled') { session.cancel('stop'); return }
          if (result === 'arrival') bot.entity.position = new Vec3(26.5, 120, .5)
          bot.emit('path_update', { status: result === 'arrival' ? 'success' : result, path: [] })
        })
      } }
    })
    session.bot = bot; session.require = () => bot; session.updateMovements = () => {}
    session.state = () => ({ pos: { x: bot.entity.position.x, y: 120, z: .5 } })
    const out = await session.goto({ x: 26, z: 0, surface: false, pathWait: true, timeoutSeconds: 5,
      arena: { x: 0, y: 120, z: 0, r: 60 }, descent: false, pearl: false, unstuck: false })
    if (result === 'noPath') {
      assert.equal(out.code, 'NO_PATH', JSON.stringify(out))
      assert.equal(out.status, 'failed'); assert.match(out.error, /не дошёл/)
      assert.deepEqual(out.state.pos, { x: .5, y: 120, z: .5 })
    } else {
      assert.notEqual(out.code, 'NO_PATH')
      assert.equal(out.status, result === 'cancelled' ? 'interrupted' : result === 'arrival' ? 'done' : 'failed', JSON.stringify(out))
      if (result === 'arrival') assert.equal(out.detail.arrived.x, 26)
    }
  }
})
