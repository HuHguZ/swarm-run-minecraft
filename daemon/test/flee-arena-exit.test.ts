import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { worldOf, native } from './parkour-fixture'
import { pickDirection, smartFlee } from '../src/flee'
import * as clock from '../src/game-clock'

test('уход с яруса сравнивается с пробегом под ударом, а не с бесплатной конечной клеткой', () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -15; x <= 15; x++) for (let z = -15; z <= 15; z++) cells.push([x, 119, z, 'stone'])
  for (let x = -6; x <= 0; x++) for (let z = -12; z <= 12; z++) cells.push([x, 127, z, 'stone'])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.8, 128, .5)
  bot.entity.height = 1.8; bot.entity.eyeHeight = 1.62
  const foe = { e: { username: 'Foe', position: new Vec3(-1.5, 128, .5) }, d: 2.3,
    doc: { radius: 10, weight: 8, fast: true } }
  const arena = { x: 0, y: 120, z: 0, r: 20, killY: 110 }
  const choice = pickDirection(bot, [foe], null, [], arena, null, true)
  assert.ok(choice?.drop, `безопасный спуск дешевле пробега по краю рядом с преследователем: ${JSON.stringify(choice)}`)
  assert.equal(choice.end.y, 120)
  bot.health = 4
  assert.ok(!pickDirection(bot, [foe], null, [], arena, null, true)?.drop, 'смертельный спуск не становится выходом')
  assert.ok(!pickDirection(bot, [foe], null, [], null, null, true)?.drop, 'без арены глубокий спуск не включается')
})

test('настоящий flee сохраняет выбранный спуск против escapeRoute и выдаёт квитанцию фактического падения', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -15; x <= 15; x++) for (let z = -15; z <= 15; z++) cells.push([x, 119, z, 'stone'])
  for (let x = -6; x <= 0; x++) for (let z = -12; z <= 12; z++) cells.push([x, 127, z, 'stone'])
  const { bot, world } = worldOf(cells)
  Object.assign(bot.entity, { id: 1, name: 'player', type: 'player', height: 1.8, eyeHeight: 1.62, metadata: [], position: new Vec3(.8, 128, .5) })
  bot.entities = { 2: { id: 2, name: 'player', type: 'player', username: 'Foe', position: new Vec3(-1.5, 128, .5) } }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.setControlState = (key, value) => { controls[key] = value }
  bot.clearControlStates = () => { for (const key of Object.keys(controls)) controls[key] = false }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  const receipts = []
  bot.on('nd_flee_drop', receipt => receipts.push(receipt))
  const ctl = { aborted: false, onAbort: [] }
  const game = clock.activate(new clock.GameClock({ manual: true }))
  let result
  const done = smartFlee({ bot }, ctl, { arena: { x: 0, y: 120, z: 0, r: 20, killY: 110 }, foes: [2], timeoutMs: 6000 })
    .then(out => { result = out })
  try {
    for (let t = 0; t < 160 && !result; t++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const state = new native.PlayerState(bot, controls)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      game.advanceTicks(1); bot.emit('physicsTick')
    }
    assert.equal(result?.mode, 'спрыгнул на нижний ярус')
    assert.equal(bot.entity.position.y, 120)
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].height, 8)
    assert.equal(receipts[0].technique, 'без')
  } finally {
    ctl.aborted = true
    for (const abort of [...ctl.onAbort]) abort()
    game.advanceTicks(200)
    await done
    game.dispose(); clock.activate(null)
  }
})
