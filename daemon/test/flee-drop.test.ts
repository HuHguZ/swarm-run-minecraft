import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { worldOf, Block, registry, native } from './parkour-fixture'
import { pickDirection } from '../src/flee'

test('flee prices a native walk-off, but rejects a lethal fall, lava, unknown floor and killY', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) cells.push([x, 119, z, 'stone'])
  for (let x = -2; x <= 0; x++) for (let z = -1; z <= 1; z++) cells.push([x, 159, z, 'stone'])
  const { bot, world } = worldOf(cells)
  bot.entity.position = new Vec3(.98, 160, .5)
  bot.entity.name = 'player'; bot.entity.height = 1.8; bot.entity.eyeHeight = 1.62
  bot.entity.type = 'player'; bot.entity.metadata = []
  // Три Prot IV и FF IV с элитрой: 37 сырого -> 7.4 хп; броня сама падение не уменьшает.
  const enchanted = (name, prot = 4, ff = 0) => ({ name, componentMap: new Map([['enchantments', {
    data: { enchantments: [{ id: 'minecraft:protection', level: prot }, { id: 'minecraft:feather_falling', level: ff }] }
  }]]) })
  bot.inventory.slots[5] = enchanted('diamond_helmet')
  bot.inventory.slots[6] = { name: 'elytra' }
  bot.inventory.slots[7] = enchanted('diamond_leggings')
  bot.inventory.slots[8] = enchanted('diamond_boots', 4, 4)
  const hs = [{ e: { username: 'Foe', position: new Vec3(-1.5, 160, .5) }, d: 2, doc: { radius: 8, weight: 6, fast: true } }]
  const arena = { x: 0, y: 120, z: 0, r: 10, killY: 110 }
  const choose = () => pickDirection(bot, hs, null, [{ x: 5, y: 120, z: .5 }], arena, null, true)
  const good = choose()
  assert.ok(good?.drop, 'при погоне должен рассматриваться уход с яруса вниз')
  assert.equal(good.end.y, 120)
  assert.ok(Math.abs(good.drop.hurt - 7.4) < 1e-6)
  assert.ok(good.drop.plan.steps.some(step => step.control.sprint))
  assert.ok(good.drop.plan.steps.every(step => !step.control.jump), 'с края сходим ногами')
  const blockAt = bot.blockAt
  bot.health = 7
  assert.ok(!choose()?.drop, 'цена не разрешает смерть')
  bot.health = 20
  for (const bad of ['lava', 'unknown']) {
    bot.blockAt = p => {
      if (p.y < 130) {
        if (bad === 'unknown') return null
        const b = Block.fromStateId(registry.blocksByName.lava.defaultState); b.position = p.floored(); return b
      }
      return blockAt(p)
    }
    assert.ok(!choose()?.drop, bad)
  }
  bot.blockAt = blockAt
  assert.ok(!pickDirection(bot, hs, null, [], { ...arena, killY: 120 }, null, true)?.drop, 'посадка на killY запрещена')
  // Мир изменился между выбором и шагом: разрушенная опора не должна отправить нас за край.
  const { runDrop } = require('../src/flee-drop')
  const inputs = []
  bot.setControlState = (key, value) => inputs.push([key, value])
  bot.clearControlStates = () => {}
  bot.blockAt = p => p.y < 130 ? null : blockAt(p)
  assert.equal(await runDrop(bot, { aborted: false }, good, { allow() {} }, arena), false)
  assert.equal(inputs.length, 0)
  bot.blockAt = blockAt
  const clock = require('../src/game-clock')
  const game = new clock.GameClock({ manual: true, epoch: 0 }); clock.activate(game)
  const { IDLE } = require('../src/navigation/parkour')
  const control = { ...IDLE }
  bot.setControlState = (key, value) => { control[key] = value }
  bot.clearControlStates = () => Object.assign(control, IDLE)
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  let paid = false
  bot.waitForTicks = async () => {
    game.advanceTicks(1)
    const state = new native.PlayerState(bot, control)
    bot.physics.simulatePlayer(state, world); state.apply(bot)
    if (!paid && state.onGround && state.pos.y === 120) { bot.health -= good.drop.hurt; paid = true }
    bot.emit('physicsTick')
  }
  const guard = require('../src/edges').guard(bot)
  const previous = { from: { ...bot.entity.position }, hp: 20, until: -1 }
  bot._ndParkourForecast = previous
  try {
    // Настоящий guard узнаёт общий объект клавиш после трёх тиков.
    for (let k = 0; k < 4; k++) await bot.waitForTicks(1)
    const fresh = choose()
    assert.ok(fresh?.drop)
    const result = runDrop(bot, { aborted: false, onAbort: [] }, fresh, guard, arena)
    // Четыре тика одним синхронным пакетом: исполнитель меняет клавиши на каждом physicsTick.
    for (let k = 0; k < fresh.drop.plan.steps.length && bot.listenerCount('physicsTick'); k += 4) {
      for (let j = 0; j < 4 && bot.listenerCount('physicsTick'); j++) void bot.waitForTicks(1)
    }
    const ran = await result
    assert.equal(ran, true, JSON.stringify({ at: bot.entity.position, hp: bot.health, guard: guard.stats }))
    assert.equal(bot.entity.position.y, 120)
    assert.equal(guard.stats.saves, 0, 'guard не должен тормозить подтверждённый глубокий спуск')
    assert.equal(bot._ndParkourForecast, previous)
  } finally { guard.stop(); game.dispose(); clock.activate(null) }
})
