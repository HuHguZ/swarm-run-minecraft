import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { worldOf, native, drive } from './parkour-fixture'
import { flee } from '../src/session/combat'
import { runLength } from '../src/flee'
import * as clock from '../src/game-clock'

function corridor(low: boolean, gap = false) {
  const cells: Parameters<typeof worldOf>[0] = []
  for (let x = -2; x <= 19; x++) {
    if (!gap || x !== 3) cells.push([x, 0, 0, 'bedrock'], [x, 1, 0, 'stone_slab', { type: 'bottom', waterlogged: false }])
    cells.push([x, 3, 0, 'stone_slab', { type: low && x >= 1 ? 'bottom' : 'top', waterlogged: false }])
    for (let y = 1; y <= 4; y++) {
      cells.push([x, y, -1, 'bedrock'], [x, y, 1, 'bedrock'])
      if (x === -2) cells.push([x, y, 0, 'bedrock'])
    }
  }
  const { bot, world } = worldOf(cells)
  Object.assign(bot.entity, { id: 1, type: 'player', name: 'player', height: 1.8, metadata: [], position: new Vec3(.5, 1.5, .5) })
  const sword = { name: 'netherite_sword' }
  const champion = { id: 2, type: 'player', name: 'player', username: 'Champion', height: 1.8, width: .6, metadata: [],
    position: new Vec3(-.5, 1.5, .5), velocity: new Vec3(0, 0, 0), heldItem: sword,
    equipment: [sword, null, null, null, { name: 'netherite_chestplate' }] }
  bot.entities = { 2: champion }
  bot.players = { Champion: { entity: champion } }
  drive(bot, world)
  const tick = () => {
    const state = new native.PlayerState(bot, bot.controlState)
    bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
  }
  return { bot, tick }
}

test('a gap interrupts the half-height sprint before the unsupported cell', () => {
  const { bot } = corridor(false, true)
  const run = runLength(bot, { x: 1, z: 0 })
  assert.equal(run.len, 2)
  assert.deepEqual(run.end, new Vec3(2.5, 1.5, .5))
})

for (const low of [false, true]) {
  test(low ? 'flee reports a physical corner when the ceiling closes the slab passage'
    : 'flee sprints under the visible upper slabs on continuous half-height footing', async () => {
    const control = corridor(low)
    control.bot.setControlState('forward', true)
    control.bot.setControlState('sprint', true)
    for (let i = 0; i < 32; i++) control.tick()
    assert.equal(control.bot.entity.position.x > 6, !low, 'native forward sprint establishes physical clearance')

    const { bot, tick } = corridor(low)
    const game = clock.activate(new clock.GameClock({ manual: true }))
    const ctl = { aborted: false, onAbort: [] }
    let result: any
    const done = flee.call({ bot, require() {}, runIntent(name, work) { return work(ctl) } }, {
      from: ['Champion'], safeDist: 6, timeoutSeconds: 2, arena: { x: 5, z: .5, r: 18, killY: -1 }
    }).then(r => { result = r })
    try {
      for (let i = 0; i < 42 && !result; i++) {
        await new Promise<void>(resolve => setImmediate(resolve))
        if (result) break
        tick(); game.advanceTicks(1)
      }
      assert.deepEqual(result?.from, ['Champion'])
      assert.equal(!!result.cornered, low, JSON.stringify(result))
      if (!low) {
        assert.equal(result.mode, 'оторвался')
        assert.ok(bot.entity.position.x > 5.4, 'the defender actually ran away from the sword')
      }
    } finally {
      ctl.aborted = true
      for (const stop of ctl.onAbort) stop()
      game.advanceTicks(200); await done
      game.dispose(); clock.activate(null)
    }
  })
}
