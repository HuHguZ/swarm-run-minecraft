import test from 'node:test'
import assert from 'node:assert/strict'
const mace = require('../src/mace')

function botWith (hotbar: string[], foe: any) {
  const slots: any[] = []
  hotbar.forEach((n, i) => { if (n) slots[36 + i] = { name: n } })
  const log: string[] = []
  const bot: any = {
    quickBarSlot: 0,
    inventory: { slots, items: () => slots.filter(Boolean) },
    entity: { position: { x: 0, y: 103, z: 0 } },
    registry: { entitiesByName: { player: { metadataKeys: ['shared_flags', 'air', 'custom_name', 'name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags'] } } },
    setQuickBarSlot (i: number) { this.quickBarSlot = i; log.push('slot ' + slots[36 + i].name) },
    attack () { log.push('attack ' + slots[36 + this.quickBarSlot].name) }
  }
  return { bot, log, foe }
}
const foeWith = (raised: boolean, yaw = 0) => ({ position: { x: 0, y: 100, z: 0 }, yaw, equipment: [{ name: 'diamond_sword' }, { name: 'shield' }], metadata: { 8: raised ? 0x03 : 0 } })

test('булава: щит прямо сверху держит (угол 90°), сзади — нет', () => {
  const { bot } = botWith(['mace'], null)
  assert.equal(mace.shieldAtUs(bot, foeWith(true)), true, 'над макушкой')
  bot.entity.position = { x: 0, y: 103, z: 3 } // yaw 0 смотрит на −z, мы на +z — за спиной
  assert.equal(mace.shieldAtUs(bot, foeWith(true)), false)
  bot.entity.position = { x: 0, y: 103, z: -3 }
  assert.equal(mace.shieldAtUs(bot, foeWith(true)), true)
  assert.equal(mace.shieldAtUs(bot, foeWith(false)), false)
})

test('булава: по поднятому щиту — топор и булава в одном вызове (stun slam), без щита — только булава', () => {
  const st: any = {}
  const a = botWith(['mace', 'diamond_axe'], null)
  const r = mace.slamHit(a.bot, foeWith(true), st)
  assert.equal(r.stun, true)
  assert.deepEqual(a.log, ['slot diamond_axe', 'attack diamond_axe', 'slot mace', 'attack mace'])
  assert.equal(st.stunSlams, 1)
  const b = botWith(['mace', 'diamond_axe'], null)
  mace.slamHit(b.bot, foeWith(false), st)
  assert.deepEqual(b.log, ['attack mace'])
  const c = botWith(['mace'], null)
  mace.slamHit(c.bot, foeWith(true), st)
  assert.deepEqual(c.log, ['attack mace'], 'топора нет — как раньше')
})
