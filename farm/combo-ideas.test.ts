import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { summarize, measure } from './swarm/swarm-driver/combo-ideas'

test('combo receipts keep failed kills out of TTK and preserve own deaths', () => {
  assert.deepEqual(summarize([{ damage: 8, kills: 0, ownDeaths: 0, success: true, ttkMs: null },
    { damage: 20, kills: 1, ownDeaths: 1, success: false, ttkMs: 1000 }]),
  { n: 2, damage: 14, kills: 1, ownDeaths: 1, successRate: .5, meanKillMs: 1000 })
  assert.deepEqual(summarize([]), { n: 0, damage: 0, kills: 0, ownDeaths: 0, successRate: 0, meanKillMs: null })
})

test('combo telemetry ends a life at death and never credits respawn healing or later hits', () => {
  const bot: any = new EventEmitter()
  bot.health = 20; bot.entity = { id: 1 }; bot._client = new EventEmitter()
  const finish = measure(bot)
  bot.health = 7; bot.emit('health'); bot.emit('death')
  bot.health = 0; bot.emit('health')
  bot.health = 20; bot.emit('health')
  bot.health = 19; bot.emit('health'); bot.emit('death')
  const result = finish()
  assert.equal(result.damage, 20)
  assert.equal(result.healing, 0)
  assert.equal(result.deaths, 1)
  assert.equal(result.hp, 0)
})
