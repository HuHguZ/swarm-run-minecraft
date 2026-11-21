import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { worldOf, drive, native } from './parkour-fixture'
import { smartFlee } from '../src/flee'
import { seesPlayer, gearPartVisible } from '../src/pvp/last-seen'
import * as clock from '../src/game-clock'

for (const scenario of ['main', 'offhand', 'cover', 'hidden hands', 'behind wall', 'melee'] as const) {
  test(`a weak defender prices only a visible ranged hand during retreat: ${scenario}`, async () => {
    const cells: Parameters<typeof worldOf>[0] = []
    for (let x = -15; x <= 23; x++) for (let z = -13; z <= 13; z++) cells.push([x, 0, z, 'stone'])
    if (scenario === 'cover') for (let y = 1; y <= 4; y++) for (let z = 1; z <= 5; z++) cells.push([3, y, z, 'stone'])
    const concealed = scenario === 'hidden hands' || scenario === 'behind wall'
    if (concealed) for (let z = -2; z <= 2; z++) {
      cells.push([17, 1, z, 'stone'], [17, 2, z, 'stone_slab', { type: 'bottom' }])
      if (scenario === 'behind wall') cells.push([16, 2, z, 'stone'], [16, 1, z, 'stone'])
    }
    const { bot, world } = worldOf(cells)
    drive(bot, world)
    bot.world = { getBlock: world.getBlock, raycast: require('prismarine-world/src/worldsync').prototype.raycast }
    const start = bot.entity.position.clone(), pos = new Vec3(18.5, 1, .5)
    bot.username = 'Unarmed'; bot.health = 8
    const sword = { name: 'netherite_sword' }, bow = { name: 'bow' }
    const slots = [scenario === 'main' ? bow : sword, scenario === 'melee' || scenario === 'main' ? null : bow,
      null, null, { name: 'netherite_chestplate' }, null]
    const archer = { username: 'Champion', type: 'player', name: 'player', id: 14, isValid: true,
      position: pos, yaw: Math.PI / 2, pitch: 0, height: 1.8, width: .6, velocity: new Vec3(0, 0, 0), onGround: true, metadata: [],
      get heldItem() { if (concealed) throw Error('read a hidden main hand'); return slots[0] },
      get equipment() { if (concealed) throw Error('read equipment through cover'); return slots } }
    archer.metadata[bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')] = scenario === 'main' ? 1 : 3
    bot.entities = { 14: archer }; bot.players = { Champion: { entity: archer } }
    const game = clock.activate(new clock.GameClock({ manual: true })), ctl = { aborted: false, onAbort: [] }
    let result: any, failed: unknown
    try {
      assert.equal(seesPlayer(bot, archer), scenario !== 'behind wall')
      assert.equal(gearPartVisible(bot, archer, 0), !concealed)
      const pending = smartFlee({ bot }, ctl, { foes: [archer.id], timeoutMs: 1200, safeDist: 14 })
        .then(r => { result = r }, error => { failed = error })
      for (let tick = 0; tick < 32 && !result && !failed; tick++) {
        await new Promise<void>(resolve => setImmediate(resolve))
        if (result) break
        const state = new native.PlayerState(bot, bot.controlState)
        bot.physics.simulatePlayer(state, world); state.apply(bot); game.advanceTicks(1); bot.emit('physicsTick')
      }
      await pending
      if (failed) throw failed
      const armed = scenario === 'main' || scenario === 'offhand'
      assert.equal(result.mode === 'оторвался', !armed)
      if (scenario === 'cover') {
        assert.ok(bot.entity.position.distanceTo(start) > .5)
        const eye = bot.entity.position.offset(0, 1.62, 0), ray = pos.offset(0, 1.62, 0).minus(eye)
        assert.equal(bot.world.raycast(eye, ray.scaled(1 / ray.norm()), ray.norm())?.name, 'stone')
      } else if (armed) assert.ok(bot.entity.position.distanceTo(pos) > start.distanceTo(pos) + 2)
      else assert.ok(bot.entity.position.equals(start))
    } finally {
      ctl.aborted = true; for (const end of [...ctl.onAbort]) end()
      game.advanceTicks(80); game.dispose(); clock.activate(null); bot.emit('end')
    }
  })
}
