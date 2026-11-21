import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { worldOf, native } from './parkour-fixture'
import { smartFlee, insideArena } from '../src/flee'
import * as clock from '../src/game-clock'

// Run the same unarmed defender and visible sword carrier over a lower tier, or inside a sealed cell.
async function knockedDefender (airborne: boolean) {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -14; x <= 14; x++) for (let z = -14; z <= 14; z++) cells.push([x, 0, z, 'bedrock'])
  if (airborne) cells.push([-2, 3, 0, 'stone'])
  else {
    for (let x = -2; x <= 1; x++) for (let z = -1; z <= 1; z++) {
      if (z === 0 && (x === -1 || x === 0)) continue
      for (let y = 1; y <= 4; y++) cells.push([x, y, z, 'bedrock'])
    }
  }
  const { bot, world } = worldOf(cells)
  const start = new Vec3(.5, airborne ? 6 : 1, .5)
  Object.assign(bot.entity, { id: 1, name: 'player', type: 'player', height: 1.8, metadata: [],
    position: start.clone(), onGround: !airborne, velocity: new Vec3(airborne ? .12 : 0, airborne ? .12 : 0, 0) })
  const sword = { name: 'netherite_sword' }
  const foe = { id: 2, name: 'player', type: 'player', username: 'Champion', height: 1.8, width: .6, metadata: [],
    position: airborne ? new Vec3(-1.5, 4, .5) : new Vec3(-.5, 1, .5), velocity: new Vec3(0, 0, 0),
    heldItem: sword, equipment: [sword, null, null, null, { name: 'netherite_chestplate' }] }
  bot.entities = { 2: foe }
  bot.players = { Champion: { entity: foe } }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.setControlState = (key, value) => { controls[key] = value }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  const ctl = { aborted: false, onAbort: [] }, game = clock.activate(new clock.GameClock({ manual: true }))
  const arena = { x: .5, y: 1, z: .5, r: 20, killY: -1 }
  let result, landing: Vec3 | undefined
  const done = smartFlee({ bot }, ctl, { arena, foes: [foe.id], timeoutMs: 2000 }).then(value => { result = value })
  try {
    for (let tick = 0; tick < 45 && !result; tick++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (result) break
      const state = new native.PlayerState(bot, controls)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      if (bot.entity.onGround && !landing) landing = bot.entity.position.clone()
      game.advanceTicks(1); bot.emit('physicsTick')
    }
    return { result, landing, position: bot.entity.position.clone() }
  } finally {
    ctl.aborted = true
    for (const abort of ctl.onAbort) abort()
    game.advanceTicks(200); await done
    game.dispose(); clock.activate(null)
  }
}

test('a knockback above an open lower tier does not turn retreat into a last stand in midair', async () => {
  const { result, landing, position } = await knockedDefender(true)
  assert.deepEqual(result?.from, ['Champion'])
  assert.ok(!result.cornered, 'an airborne miss in the walking planner does not establish a physical corner')
  assert.equal(landing?.y, 1)
  assert.ok(position.distanceTo(landing) > 2, 'the defender lands and continues to run from the sword carrier')
})

test('a grounded defender with no exit can still report a real physical corner', async () => {
  const { result } = await knockedDefender(false)
  assert.deepEqual(result?.from, ['Champion'])
  assert.equal(result.cornered, true)
})

test('an invisible remembered enclosure gets a bounded physical escape instead of immediately declaring safety', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = 608; x <= 649; x++) for (let z = 556; z <= 597; z++) cells.push([x, 119, z, 'stone'])
  const { bot, world } = worldOf(cells)
  const start = new Vec3(628.8202165818514, 120, 576.5580213039)
  Object.assign(bot.entity, { id: 1, name: 'player', type: 'player', position: start.clone(), height: 1.8, metadata: [] })
  bot.entities = {}
  const avoid = [
    { x: 638.9499999880791, y: 124, z: 580.5025345473271, r: 11.5832506916089 },
    { x: 578.0674592381164, y: 123.17676838458252, z: 593.5001928179314, r: 22 },
    { x: 623.9029638553159, y: 128, z: 561.0337502663021, r: 18.143383521973494 },
    { x: 619.0174231801, y: 121.39828125, z: 592.9645960313259, r: 19.163132395778412 },
    { x: 555.6980562232637, y: 126, z: 579.8978395262575, r: 22 },
    { x: 600.6883936575088, y: 121.25227537751198, z: 594.3114893176062, r: 22 },
    { x: 592.5315406854589, y: 120, z: 568.5325758217946, r: 22 },
    { x: 557.4173516850576, y: 150, z: 556.5540799133014, r: 22 },
    { x: 591.7021801127669, y: 120, z: 618.0028803707551, r: 22 },
    { x: 553.4999614058771, y: 150, z: 643.3892972638461, r: 22 },
    { x: 577.3473559344118, y: 120, z: 576.4936606246508, r: 22 }
  ]
  const arena = { x: 600.5, y: 120, z: 600.5, r: 80, killY: 113, avoid }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.setControlState = (key, value) => { controls[key] = value }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  const ctl = { aborted: false, onAbort: [] }, game = clock.activate(new clock.GameClock({ manual: true }))
  let result: any
  const done = smartFlee({ bot }, ctl, { arena, safeDist: 22, timeoutMs: 1200 }).then(value => { result = value })
  try {
    for (let tick = 0; tick < 40 && !result; tick++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const state = new native.PlayerState(bot, controls)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      game.advanceTicks(1); bot.emit('physicsTick')
      assert.equal(insideArena(bot.entity.position, arena), true)
      assert.equal(bot.entity.position.y, 120, 'known solid support is retained')
    }
    assert.ok(bot.entity.position.distanceTo(start) > 1, 'remembered pressure must produce physical progress')
    assert.deepEqual(bot.entities, {}, 'remembered positions never create hidden native entities')
  } finally {
    ctl.aborted = true
    for (const abort of [...ctl.onAbort]) abort()
    game.advanceTicks(200); await done
    game.dispose(); clock.activate(null)
  }
})
