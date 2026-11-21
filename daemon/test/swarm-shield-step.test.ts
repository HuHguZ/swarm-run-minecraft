import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { block, data, testBot } from './tick-plugins-fixture'
import * as clock from '../src/game-clock'
import * as shield from '../src/combat/shield'
import * as edges from '../src/edges'
import { swarmHold } from '../src/swarm-position-work'
import { screensBow } from '../src/swarm/common'
import { getPhysics } from '../src/tick-plugins'

for (const scenario of ['open', 'gap', 'wall', 'boundary', 'hidden', 'aimed away', 'released', 'ward moved', 'cancelled', 'cancelled look'] as const) {
  test(`one shield step at a drawn bow under native movement: ${scenario}`, async t => {
    const bot = testBot(), from = new Vec3(2.5, 64, 1.65), controls = { ...edges.IDLE }
    t.after(() => bot.emit('end'))
    Object.assign(bot, { username: 'Guard', health: 20, getControlState: k => controls[k],
      clearControlStates: () => Object.assign(controls, edges.IDLE) })
    bot.entity.position = from.clone(); bot.entity.metadata = []; bot.entity.username = bot.username
    bot.inventory.slots[45] = { name: 'shield' }
    bot.blockAt = p => {
      const q = p.floored()
      const gap = scenario === 'gap' && q.z === 0
      const wall = scenario === 'wall' && q.x === 2 && q.z === 0 && q.y === 64 || scenario === 'hidden' && q.x === 6
      return block(wall || !gap && p.y < 64 ? 'stone' : 'air', p)
    }
    bot.physics = getPhysics().Physics(data, { getBlock: bot.blockAt })
    bot.entity.velocity.y = -bot.physics.gravity * bot.physics.airdrag
    const player = (id, username, x) => ({ id, username, type: 'player', name: 'player', isValid: true, yaw: Math.PI / 2, pitch: 0,
      width: .6, height: 1.8, position: new Vec3(x, 64, .5), velocity: new Vec3(0, 0, 0), onGround: true, metadata: [], equipment: [] })
    const ward = player(2, 'Ward', .5), archer = player(3, 'Bow', 12.5)
    const flags = data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
    archer.equipment[0] = { name: 'bow' }; archer.metadata[flags] = 1
    if (scenario === 'aimed away') archer.yaw = 0
    bot.players = { Ward: { entity: ward }, Bow: { entity: archer } }; bot.entities = { 2: ward, 3: archer }
    const ctl = { aborted: false, onAbort: [] }, current: any = { name: 'swarm_hold', ctl }
    const session = { bot, current }, moves: string[] = []
    let raised = false, covered = false, now = 0
    const cancel = () => { ctl.aborted = true; for (const abort of [...ctl.onAbort]) abort() }
    bot.lookAt = async p => {
      bot.entity.yaw = Math.atan2(bot.entity.position.x - p.x, bot.entity.position.z - p.z)
      if (scenario === 'cancelled look') cancel()
    }
    bot.setControlState = (k, v) => {
      controls[k] = v
      if (v) { assert.ok(raised); assert.ok(['left', 'right'].includes(k)); moves.push(k) }
    }
    t.mock.method(shield, 'makeShield', () => ({ wear: async () => true, raise: async () => {
      raised = true
      if (scenario === 'released') archer.metadata[flags] = 0
      if (scenario === 'cancelled') cancel()
      return true
    }, failure: () => null, blocking: () => raised, report: () => null, nativeUse: () => ({}), close() {} }))
    t.mock.method(clock, 'now', () => now)
    t.mock.method(clock, 'sleep', async (ms: number) => {
      for (let i = 0; i < ms; i += 50) await new Promise(resolve => bot.once('physicsTick', resolve))
    })
    const arena = { x: 5, z: scenario === 'boundary' ? 2.25 : .5, r: 20, killY: 61,
      ...(scenario === 'boundary' && { ellipse: { a: 20, b: 1 } }) }
    let done = false
    const pending = swarmHold(session, ctl, { seconds: 2, shield: true, requireShield: true, stepIntoLane: true,
      whileDraw: 'Bow', coverAlly: 'Ward', allies: ['Ward'], enemies: ['Bow'], arena }).finally(() => { done = true })
    for (let tick = 0; tick < 48 && !done; tick++) {
      await new Promise(resolve => setImmediate(resolve))
      if (done) break
      const state = edges.stateOf(bot, controls)
      edges.simOf(bot)(state, { getBlock: bot.blockAt }); state.apply(bot)
      now += 50
      if (scenario === 'ward moved' && moves.length) ward.position.z += 2
      if (current.coveredBow) { assert.ok(screensBow(bot.entity.position, ward.position, archer.position)); covered = true }
      bot.emit('physicsTick')
    }
    assert.ok(done)
    const result = await pending
    if (scenario === 'open') {
      assert.ok(result.ok, result.why); assert.ok(covered); assert.ok(moves.length > 0)
      assert.ok(screensBow(bot.entity.position, ward.position, archer.position))
    } else {
      assert.equal(result.why, scenario.startsWith('cancelled') ? 'cancelled' : ['gap', 'wall', 'boundary'].includes(scenario) ? 'cover_step_blocked' : 'cover_lane_lost')
      assert.equal(covered, false)
      if (scenario === 'cancelled look') assert.equal(raised, false)
      if (scenario === 'ward moved') assert.ok(moves.length > 0 && bot.entity.position.distanceTo(from) < .3)
      else assert.equal(moves.length, 0)
    }
    assert.equal(current.coveredBow, undefined)
    assert.ok(!Object.values(controls).some(Boolean))
  })
}
