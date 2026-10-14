'use strict'
// Под гастом — стройка из булыжника, а не незерака (шар силы 1 рвёт незерак, булыжник держит: Codex q8, jar 1.21.11).
const test = require('node:test')
const assert = require('node:assert/strict')
const gameClock = require('../src/game-clock')
const { pickFiller } = require('../src/build')

const bot = (ghast, dimension = 'the_nether') => ({
  game: { dimension },
  inventory: { items: () => [{ name: 'netherrack', count: 40 }, { name: 'cobblestone', count: 20 }] },
  // Кэш оценки угрозы (ghastThreat): видимый или слышный гаст — без живого восприятия.
  _ndGhastFiller: { at: gameClock.now(), v: ghast }
})

test('гаст рядом — булыжник первым', () => {
  assert.equal(pickFiller(bot(true)).name, 'cobblestone')
})

test('гаста нет — незерак первым, булыжник в запасе', () => {
  assert.equal(pickFiller(bot(false)).name, 'netherrack')
})

test('в верхнем мире порядок прежний', () => {
  assert.equal(pickFiller(bot(true, 'overworld')).name, pickFiller(bot(false, 'overworld')).name)
})
