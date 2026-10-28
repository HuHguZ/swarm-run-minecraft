'use strict'
// ND_GRAPH2_KEEP_STONE (поток graph2 sr27): булыжник/чернокамень в Аду — головы кирок; под гастом сперва базальт (держит шар так же),
// последние 6 — не в кладку, пока есть чем ещё.
import test = require('node:test')
import assert = require('node:assert/strict')
import * as gameClock from '../src/game-clock'
import { pickFiller } from '../src/build'

const bot = (ghast: boolean, items: Array<{ name: string; count: number }>) => ({
  game: { dimension: 'the_nether' }, inventory: { items: () => items }, _ndGhastFiller: { at: gameClock.now(), v: ghast } })
const withFlag = <T>(fn: () => T): T => { process.env.ND_GRAPH2_KEEP_STONE = '1'; try { return fn() } finally { delete process.env.ND_GRAPH2_KEEP_STONE } }

test('graph2 keep stone: под гастом базальт раньше булыжника; без флага — булыжник', () => {
  const items = [{ name: 'netherrack', count: 40 }, { name: 'cobblestone', count: 20 }, { name: 'basalt', count: 10 }]
  assert.equal(pickFiller(bot(true, items)).name, 'cobblestone')
  assert.equal(withFlag(() => pickFiller(bot(true, items)).name), 'basalt')
})

test('graph2 keep stone: последние 6 булыжника — после незерака; другого нет — всё же булыжник', () => {
  assert.equal(withFlag(() => pickFiller(bot(true, [{ name: 'netherrack', count: 40 }, { name: 'cobblestone', count: 6 }])).name), 'netherrack')
  assert.equal(withFlag(() => pickFiller(bot(true, [{ name: 'netherrack', count: 40 }, { name: 'cobblestone', count: 9 }])).name), 'cobblestone')
  assert.equal(withFlag(() => pickFiller(bot(false, [{ name: 'cobblestone', count: 4 }])).name), 'cobblestone')
})
