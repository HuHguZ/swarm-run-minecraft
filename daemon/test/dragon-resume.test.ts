'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const dragon = require(process.env.ND_DRAGON_TEST_IMPL || '../src/dragon')

const kit = { bow: 1, arrows: 11, blocks: 26, weapon: 'iron_sword', pickaxe: 'iron_pickaxe', food: 13, beds: 5 }
function body () {
  return { game: { dimension: 'the_end' }, entity: { id: 7, position: new Vec3(5, 63, -47) },
    entities: { 42: { id: 42, name: 'ender_dragon', position: new Vec3(0, 64, 0), isValid: true } } }
}
function need (bot, seenAt = null) {
  return dragon.missing(kit, 'full', dragon.crystalKitState(bot, seenAt, true))
}

test('повтор full у клетки не требует arrow32 после подтверждённого уничтожения кристаллов', () => {
  const bot: any = body()
  assert.equal(typeof dragon.noteCrystalClear, 'function', 'состояние окончания фазы должно сохраняться между RPC')
  assert.deepEqual(need(bot).find(x => x.what === 'arrow'), { what: 'arrow', count: 32, have: 11 })
  dragon.noteCrystalClear(bot, { seen: 10, left: 0 })
  assert.equal(need(bot).some(x => x.what === 'arrow'), false)
  // Дракон временно вне прорисовки — тот же бой не требует повторный набор.
  bot.entities = {} as Record<string, any>
  assert.equal(need(bot).some(x => x.what === 'arrow'), false)
})

test('непустой или ещё не просмотренный список не доказывает конец фазы', () => {
  for (const report of [{ seen: 10, left: 1 }, { seen: 0, left: 0 }, { seen: 10, left: null }]) {
    const bot = body()
    dragon.noteCrystalClear(bot, report)
    assert.equal(need(bot).some(x => x.what === 'arrow'), true)
  }
})

test('после смерти у нового тела набор кристаллов проверяется заново', () => {
  const bot = body()
  dragon.noteCrystalClear(bot, { seen: 10, left: 0 })
  bot.entity.id = 8
  assert.equal(need(bot).some(x => x.what === 'arrow'), true)
})

test('новый дракон отменяет знание предыдущего боя', () => {
  const bot: any = body()
  dragon.noteCrystalClear(bot, { seen: 10, left: 0 })
  bot.entities = { 43: { id: 43, name: 'ender_dragon', position: new Vec3(0, 64, 0), isValid: true } }
  assert.equal(need(bot).some(x => x.what === 'arrow'), true)
})

test('видимые кристаллы отменяют прежнее знание даже до появления дракона', () => {
  const bot: any = body()
  dragon.noteCrystalClear(bot, { seen: 10, left: 0 })
  bot.entities = {} as Record<string, any>
  assert.equal(need(bot, { crystals: 10, caged: 2 }).some(x => x.what === 'arrow'), true)
  assert.equal(need(bot).some(x => x.what === 'arrow'), true)
})

test('смена измерения и явное воскрешение отменяют знание кристаллов', () => {
  const bot = body()
  dragon.noteCrystalClear(bot, { seen: 10, left: 0 })
  bot.game.dimension = 'overworld'
  assert.equal(need(bot).some(x => x.what === 'arrow'), true)
  bot.game.dimension = 'the_end'
  assert.equal(need(bot).some(x => x.what === 'arrow'), true)
  dragon.noteCrystalClear(bot, { seen: 10, left: 0 })
  dragon.clearCrystalKnowledge(bot)
  assert.equal(need(bot).some(x => x.what === 'arrow'), true)
})

test('знание кристаллов не переносится между ботами и соединениями', () => {
  const bot = body()
  dragon.noteCrystalClear(bot, { seen: 10, left: 0 })
  assert.equal(need(body()).some(x => x.what === 'arrow'), true)
})

test('настоящий вход dragon full пропускает повторную проверку arrow32 для того же боя', async () => {
  const bot = Object.assign(new EventEmitter(), body())
  bot.health = 20
  bot.registry = { entitiesByName: { ender_dragon: { metadataKeys: ['health', 'phase'] } }, blocksByName: {} as Record<string, any> }
  bot.entities[42].metadata = [68, 0]
  bot.entity.yaw = 0; bot.entity.pitch = 0
  const bag = [
    { name: 'iron_sword', count: 1 }, { name: 'iron_pickaxe', count: 1 }, { name: 'bow', count: 1 },
    { name: 'arrow', count: 11 }, { name: 'cobblestone', count: 26 }, { name: 'cooked_beef', count: 13 }, { name: 'red_bed', count: 5 }
  ]
  bot.inventory = { items: () => bag, slots: new Array(46).fill(null) }
  bot.blockAt = p => ({ name: p.y < 63 ? 'end_stone' : 'air', boundingBox: p.y < 63 ? 'block' : 'empty', position: p })
  bot._client = new EventEmitter(); bot._client.write = () => {}
  bot.look = async () => {}; bot.clearControlStates = () => {}; bot.setControlState = () => {}
  bot.pathfinder = { setGoal: () => {}, stop: () => {} }
  const session = { bot, armorBusy: true, updateMovements: () => {} }
  const ctl = () => ({ aborted: true, onAbort: [] })
  const fresh = await dragon.dragon(session, ctl(), { mode: 'full' })
  assert.deepEqual(fresh.need, { what: 'arrow', count: 32, have: 11 })
  dragon.noteCrystalClear(bot, { seen: 10, left: 0 })
  const resumed = await dragon.dragon(session, ctl(), { mode: 'full' })
  assert.equal(resumed.error, undefined)
  assert.equal(resumed.need, undefined, 'настоящий вход RPC не должен снова отказать arrow32')
})
