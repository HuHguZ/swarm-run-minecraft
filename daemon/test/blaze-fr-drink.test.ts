import test from 'node:test'
import assert from 'node:assert/strict'
import { drinkFireResistance } from '../src/blaze/potions'

// Зелье огнестойкости засчитано выпитым только по расходу; слот после глотка может прийти позже конца consume (cm12-s19-1 21.10),
// а рука — смениться посреди глотка («Food is full» на кирке). Признак выпитого — пустой флакон.
function fakeBot ({ lateSlotMs = 0, handStolen = false } = {}) {
  const potion = () => ({ name: 'potion', count: 1, componentMap: new Map([['potion_contents', { data: { potion: 'minecraft:fire_resistance' } }]]) })
  let items: any[] = [potion(), potion()]
  const bot: any = {
    heldItem: null,
    inventory: { items: () => items, get slots () { return items } },
    pathfinder: { setGoal () {} },
    deactivateItem () {},
    async equip (it) { bot.heldItem = handStolen ? { name: 'iron_pickaxe' } : it },
    async consume () {
      if (bot.heldItem?.name !== 'potion') throw new Error('Food is full')
      setTimeout(() => { items = [...items.slice(1), { name: 'glass_bottle', count: 1 }] }, lateSlotMs)
    }
  }
  return bot
}

test('fire resistance drink: late slot update still counts once; stolen hand is not a drink', async () => {
  const late = fakeBot({ lateSlotMs: 120 })
  assert.equal(await drinkFireResistance(late), 'выпил fire_resistance')
  assert.ok(late._ndFrUntil, 'FR clock set')
  assert.equal(late.inventory.items().filter(i => i.name === 'potion').length, 1, 'one potion spent, not two')
  const stolen = fakeBot({ handStolen: true })
  assert.match(String(await drinkFireResistance(stolen)), /не выпил/)
  assert.equal(stolen._ndFrUntil, undefined)
})

// ND_BLZ_DRINK_HOLD: вложенные глотки (клатч посреди глотка боя) — обёртки рук ставятся раз и снимаются, когда кончился последний;
// чужой equip на время глотка не проходит, свой — проходит, отложенная цель пути встаёт после.
test('drink hold: nested holds restore the original hands once; foreign equip is held, own passes, a deferred goal lands after', async () => {
  const { drinkHold } = require('../src/blaze/potions')
  const calls: string[] = []
  const equip = async (it: any) => { calls.push('equip ' + it.name) }
  const setGoal = (g: any) => { calls.push('goal ' + (g ? g.name : 'null')) }
  const bot: any = { equip, setQuickBarSlot: () => calls.push('slot'), moveSlotItem: async () => {}, deactivateItem: () => calls.push('deact'), activateItem: () => calls.push('act'), pathfinder: { setGoal } }
  const a = drinkHold(bot), b = drinkHold(bot)
  const potion = { name: 'potion' }
  a.mine.add(potion)
  await bot.equip({ name: 'netherrack' }, 'hand')
  await bot.equip(potion, 'hand')
  bot.pathfinder.setGoal({ name: 'far' })
  bot.deactivateItem()
  b.release()
  assert.notEqual(bot.equip, equip, 'still held while the outer drink lasts')
  a.release()
  assert.equal(bot.equip, equip)
  assert.equal(bot.pathfinder.setGoal, setGoal)
  assert.equal(bot.deactivateItem.name, 'deactivateItem')
  assert.deepEqual(calls, ['equip potion', 'goal far'])
  a.release()
  assert.equal(bot.equip, equip, 'double release is harmless')
})

// ND_BLZ_FR_BUDGET: последнее зелье — только у трона (спавнер в 14 бл. или 3+ ифрита в 16), в лаве или при хп ≤ 6; два зелья — всегда.
test('fr budget: the last potion waits for the throne; two potions or an emergency drink at once', () => {
  const { frSpendOk } = require('../src/blaze/potions')
  const Vec3 = require('vec3').Vec3
  const potion = () => ({ name: 'potion', count: 1, componentMap: new Map([['potion_contents', { data: { potion: 'minecraft:fire_resistance' } }]]) })
  const mk = ({ n = 1, hp = 20, lava = false, blazes = 0, spawnerAt = null as any } = {}) => {
    const me = new Vec3(0, 64, 0)
    const ents: any = {}
    for (let i = 0; i < blazes; i++) ents[i + 1] = { id: i + 1, name: 'blaze', position: me.offset(3 + i, 0, 0), isValid: true }
    return {
      health: hp, game: { dimension: 'minecraft:the_nether' }, entity: { position: me, isInLava: lava }, entities: ents,
      inventory: { items: () => Array.from({ length: n }, potion) },
      registry: { blocksByName: { spawner: { id: 1 } } }, findBlocks: () => [], blockAt: () => null,
      _ndReflexSession: spawnerAt ? { journal: { state: { places: { 'спавнер блейзов': { ...spawnerAt, dimension: 'the_nether' } } } } } : undefined
    }
  }
  const was = process.env.ND_BLZ_FR_BUDGET
  process.env.ND_BLZ_FR_BUDGET = '1'
  try {
    assert.equal(frSpendOk(mk()), false, 'one potion, nothing near: keep it')
    assert.equal(frSpendOk(mk({ n: 2 })), true, 'two potions: no budget')
    assert.equal(frSpendOk(mk({ lava: true })), true, 'lava')
    assert.equal(frSpendOk(mk({ hp: 6 })), true, 'hp 6')
    assert.equal(frSpendOk(mk({ blazes: 2 })), false, 'two blazes are strays')
    assert.equal(frSpendOk(mk({ blazes: 3 })), true, 'three blazes: the throne')
    assert.equal(frSpendOk(mk({ spawnerAt: { x: 8, y: 66, z: 0 } })), true, 'remembered spawner in 14')
    assert.equal(frSpendOk(mk({ spawnerAt: { x: 30, y: 66, z: 0 } })), false, 'spawner far')
    process.env.ND_BLZ_FR_BUDGET = '0'
    assert.equal(frSpendOk(mk()), true, 'flag off')
  } finally { if (was === undefined) delete process.env.ND_BLZ_FR_BUDGET; else process.env.ND_BLZ_FR_BUDGET = was }
})
