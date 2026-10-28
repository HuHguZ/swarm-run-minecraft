import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { worldOf } from '../src/elytra/physics'
import { Block, block, data, testBot } from './tick-plugins-fixture'

// cl28g (15×15, 28.10): 68% времени остановок цикла событий (медиана 1.7 с) — прогноз полёта (control.choose → rollout) спрашивает
// честный мир клетку за клеткой, и девять лучей каждой клетки заново читали те же блоки (bot.blockAt → fromStateId).
// Один синхронный проход — одни сырые чтения; следующий проход читает мир заново.
test('видимый мир полёта читает каждый сырой блок один раз за проход и заново — в следующем', async t => {
  const time = new clock.GameClock({ manual: true, epoch: 1000 }); clock.activate(time)
  t.after(() => time.dispose())
  const bot: any = testBot(); bot.entity.position.set(.5, 0, .5)
  const states = new Map<string, number>(), reads = new Map<string, number>()
  bot.blockAt = (p: Vec3) => {
    const cell = p.floored(), key = cell.toString()
    reads.set(key, (reads.get(key) || 0) + 1)
    const b = Block.fromStateId(states.get(key) ?? data.blocksByName.air.defaultState, 0); b.position = cell; return b
  }
  bot.on = () => bot
  const W = worldOf(bot, { observed: true })
  for (let x = 3; x <= 8; x++) for (let y = 0; y <= 2; y++) for (let z = -2; z <= 2; z++) assert.equal(W.at(x, y, z), 0)
  const twice = [...reads].filter(([, n]) => n > 1)
  assert.deepEqual(twice, [], 'лучи соседних клеток делят сырые чтения')
  await Promise.resolve()
  const wall = new Vec3(2, 1, 0)
  states.set(wall.toString(), block('stone', wall).stateId)
  assert.equal(W.at(9, 1, 0), 1, 'новый проход видит поставленную стену: клетка за ней не видна')
})
