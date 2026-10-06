import test from 'node:test'
import assert from 'node:assert/strict'
const { drink } = require('../src/pvp/xp-bottles')

// Бутылки опыта: взгляд вниз, бутылка в руке, бросков не больше, чем бутылок и max; без бутылок — ничего.
test('xp_bottles: бросает по одной, перекладывая стопку в руку; без бутылок — 0', async () => {
  let bottles = 5
  const looks: number[] = []
  const bot: any = {
    entity: { yaw: 1, position: { distanceTo: () => 99 } }, entities: {}, experience: { level: 0 }, heldItem: null,
    inventory: { items: () => (bottles > 0 ? [{ name: 'experience_bottle', count: bottles }] : []) },
    look: async (_y: number, p: number) => { looks.push(p) },
    equip: async (it: any) => { bot.heldItem = it },
    activateItem: () => { bottles--; bot.experience.level++; if (!bottles) bot.heldItem = null },
    deactivateItem: () => {}
  }
  const ctl = { aborted: false, onAbort: [] }
  const r = await drink({ bot }, ctl, { max: 3 })
  assert.equal(r.thrown, 3)
  assert.equal(r.gained, 3)
  assert.ok(Math.abs(looks[0] + Math.PI / 2) < 1e-9, 'под ноги')
  const r2 = await drink({ bot }, ctl, {})
  assert.equal(r2.thrown, 2, 'кончились — стоп')
  assert.equal((await drink({ bot }, ctl, {})).thrown, 0)
})
