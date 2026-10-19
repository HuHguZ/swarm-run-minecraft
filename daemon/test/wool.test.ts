'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as gamedata from '../src/gamedata'

test('шерсть из коричневой и светло-серой красится по настоящим рецептам 1.21.11', () => {
  const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const registry = structuredClone({ itemsByName: data.itemsByName, recipes: data.recipes })
  gamedata.fixWhiteWool?.(registry)
  const white = registry.itemsByName.white_wool.id
  const dye = registry.itemsByName.white_dye.id
  for (const name of ['brown_wool', 'light_gray_wool']) {
    const wool = registry.itemsByName[name].id
    assert.ok(registry.recipes[white].some((r: any) => r.ingredients?.length === 2 &&
      r.ingredients.includes(dye) && r.ingredients.includes(wool) && r.result.id === white && r.result.count === 1), name)
  }
  const count = registry.recipes[white].length
  gamedata.fixWhiteWool?.(registry)
  assert.equal(registry.recipes[white].length, count, 'повтор подключения не дублирует рецепты')
})
