import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

const registry = require('minecraft-data')('1.21.11')
const Item = require('prismarine-item')(registry)
const locks = require('../src/reflex-lock')
const { createEquipment } = require('../src/pvp/equipment')
const { potionOf } = require('../src/pvp')

function item(name: string, slot: number, components: any[] = []) {
  const out = new Item(registry.itemsByName[name].id, 1)
  out.slot = slot
  out.components = components
  out.componentMap = new Map(components.map(c => [c.type, c]))
  return out
}
const potion = (slot: number, name: string) => item('splash_potion', slot, [{ type: 'potion_contents', data: { potionId: name } }])

test('off-hand returns to shield on current HP and burst margin, without a five-second lock', async () => {
  const source = readFileSync(join(__dirname, '../src/pvp.ts'), 'utf8')
  const a = source.indexOf('    if (now >= totemAt) {'); const b = source.indexOf('    const archer = ', a)
  assert.ok(a >= 0 && b > a)
  const shield = item('shield', 36); const totem = item('totem_of_undying', 45)
  const ctx: any = { now: 1000, totemAt: 0, prof: { player: true }, mc: { threat: () => null }, entity: {}, theirR: 8,
    tot: { lastSwitch: 999, lastPop: 999, shieldBack: 0 },
    guard: { stats: { have: true } }, wt: { yes: false, hp: 20, burst: 1 },
    totemMod: { wantTotem: () => ctx.wt }, used() {}, findItem: (_bot, predicate) => [shield, totem].find(predicate),
    bot: { inventory: { slots: Object.assign([], { 45: totem }) },
      async equip(chosen, hand) { assert.equal(hand, 'off-hand'); ctx.bot.inventory.slots[45] = chosen } } }
  await runInNewContext(`(async () => { ${source.slice(a, b)} })()`, ctx)
  assert.equal(ctx.bot.inventory.slots[45], shield)
  ctx.bot.inventory.slots[45] = totem; ctx.totemAt = 0; ctx.wt.hp = 9
  await runInNewContext(`(async () => { ${source.slice(a, b)} })()`, ctx)
  assert.equal(ctx.bot.inventory.slots[45], totem, 'the existing HP hysteresis retains the totem near lethal burst')
})

function fixture(items: any[], wrapped = false) {
  const bot: any = new EventEmitter()
  const equipped: any[] = []; const used: string[] = []
  bot.registry = registry
  bot.inventory = require('prismarine-windows')('1.21.11').createWindow(0, 'minecraft:inventory', 'Inventory')
  for (const it of items) bot.inventory.updateSlot(it.slot, it)
  bot.heldItem = items[0]
  bot.equip = async (chosen, hand) => { equipped.push({ item: chosen, hand }); bot.heldItem = chosen }
  bot.look = async () => {}
  bot.activateItem = () => used.push(potionOf(bot.heldItem) || bot.heldItem.name)
  bot.deactivateItem = () => {}
  const ctx: any = { bot, heldName: () => bot.heldItem?.name, switched: () => {}, sleep: async () => {} }
  if (wrapped) locks.install({ bot, current: null, reflex: null })
  return { bot, ctx, eq: createEquipment(ctx), equipped, used }
}

test('equip under reflex lock keeps the requested healing potion when harming of the same type is first', async () => {
  const harm = potion(36, 'strong_harming'); const heal = potion(37, 'strong_healing')
  const f = fixture([harm, heal], true)
  assert.equal(await f.eq.holdItem(heal), true)
  assert.equal(f.bot.heldItem, heal)
  assert.equal(f.equipped[0].item, heal)
})

test('equip refresh finds the same potion in its new slot and refuses a vanished selection', async () => {
  const stale = potion(37, 'strong_healing'); const moved = potion(40, 'strong_healing')
  const harm = potion(37, 'strong_harming')
  const f = fixture([harm, moved], true)
  await f.bot.equip(stale, 'hand')
  assert.equal(f.bot.heldItem, moved)
  const missing = fixture([harm], true)
  await assert.rejects(missing.bot.equip(stale, 'hand'), { code: 'REFLEX_ITEM_GONE' })
  assert.equal(missing.equipped.length, 0, 'do not use the old slot after the requested stack vanished')
})

test('equip preserves the chosen enchanted weapon and the chosen totem slot and hand', async () => {
  const plain = item('diamond_sword', 36)
  const sharp = item('diamond_sword', 38, [{ type: 'enchantments', data: { enchantments: [{ id: 16, level: 5 }] } }])
  const firstTotem = item('totem_of_undying', 39); const chosenTotem = item('totem_of_undying', 40)
  const f = fixture([plain, sharp, firstTotem, chosenTotem], true)
  await f.bot.equip(sharp, 'hand')
  await f.bot.equip(chosenTotem, 'off-hand')
  assert.deepEqual(f.equipped, [{ item: sharp, hand: 'hand' }, { item: chosenTotem, hand: 'off-hand' }])
})

test('equip accepts the actual selected offhand or armor slot outside inventory.items()', async () => {
  const shield = item('shield', 45); const chestplate = item('diamond_chestplate', 6)
  const f = fixture([shield, chestplate], true)
  assert.deepEqual(f.bot.inventory.items(), [], 'Prismarine inventory.items() lists only slots 9..44')
  await f.bot.equip(shield, 'hand')
  await f.bot.equip(chestplate, 'hand')
  assert.deepEqual(f.equipped, [{ item: shield, hand: 'hand' }, { item: chestplate, hand: 'hand' }])
})

test('self splash refuses a harmful potion that replaced healing while the aim was awaiting', async () => {
  const harm = potion(36, 'strong_harming'); const heal = potion(37, 'strong_healing')
  const f = fixture([harm, heal])
  assert.equal(await f.eq.holdItem(heal), true)
  f.ctx.sleep = async () => { f.bot.heldItem = harm }
  const ok = await f.eq.useAt(0, -Math.PI / 2, { item: heal })
  assert.deepEqual(f.used, [], 'no use_item for harmful contents under our feet')
  assert.equal(ok, false)
  assert.equal(f.ctx.aim, 'target')
})

test('self splash snapshots contents before awaiting, even when the selected Item object changes', async () => {
  const heal = potion(37, 'strong_healing')
  const f = fixture([heal])
  f.bot.look = async () => { heal.components[0].data.potionId = 'strong_harming' }
  const ok = await f.eq.useAt(0, -Math.PI / 2, { item: heal })
  assert.deepEqual(f.used, [])
  assert.equal(ok, false)
})

test('self splash uses an unchanged healing stack and reports that the use was sent', async () => {
  const heal = potion(37, 'strong_healing')
  const f = fixture([heal], true)
  assert.equal(await f.eq.holdItem(heal), true)
  assert.equal(await f.eq.useAt(0, -Math.PI / 2, { item: heal }), true)
  assert.deepEqual(f.used, ['strong_healing'])
  assert.equal(f.ctx.aim, 'target')
})


test('a rejected equip is not retried by clock age; the requested slot receipt permits retry', async () => {
  const sword = item('diamond_sword', 36); const water = item('water_bucket', 37)
  const f = fixture([sword, water]); let attempts = 0
  f.bot.equip = async () => { attempts++; throw Error('server rejected selection') }
  assert.equal(await f.eq.holdItem(water), false)
  assert.equal(await f.eq.holdItem(water), false)
  assert.equal(attempts, 1)
  f.bot.heldItem = water
  f.bot.equip = async chosen => { attempts++; f.bot.heldItem = chosen }
  assert.equal(await f.eq.holdItem(water), true, 'the requested hand actually arrived')
})

test('successful equip without the requested ordinary item in hand is a failed selection', async () => {
  const sword = item('diamond_sword', 36); const water = item('water_bucket', 37)
  const f = fixture([sword, water]); f.bot.equip = async () => {}
  assert.equal(await f.eq.holdItem(water), false)
})

test('self splash cannot duplicate a pending use before a matching item receipt', async () => {
  const heal = potion(37, 'strong_healing'); heal.count = 3
  const f = fixture([heal])
  assert.equal(await f.eq.useAt(0, -Math.PI / 2, { item: heal }), true)
  assert.equal(await f.eq.useAt(0, -Math.PI / 2, { item: heal }), false)
  assert.equal(f.used.length, 1)
  heal.count--
  assert.equal(await f.eq.useAt(0, -Math.PI / 2, { item: heal }), true)
  assert.equal(f.used.length, 2)
})

test('throw rejection belongs to its trajectory, not the next frame or another target', async () => {
  const { Vec3 } = require('vec3')
  const harm = potion(37, 'strong_harming'); const f = fixture([harm])
  let attempts = 0
  Object.assign(f.ctx, { entity: { id: 2, position: new Vec3(8, 0, 0) }, EYE: 1.62,
    reachable: () => true, holdItem: async () => true, holdWeapon: async () => {}, leadFn: () => () => f.ctx.entity.position,
    used() {}, pick: require('../src/pick'), Vec3,
    throwMod: { kindOf: () => ({}), aim: () => ({}), throwAt: async () => { attempts++; return { thrown: false, why: 'blocked trajectory' } } } })
  f.bot.entity = { id: 1, position: new Vec3(0, 0, 0), width: .6, height: 1.8 }
  f.bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
  assert.equal(await f.eq.throwAt(harm, 'throw'), false)
  assert.equal(await f.eq.throwAt(harm, 'throw'), false)
  assert.equal(attempts, 1)
  f.ctx.entity.position.x += 1
  await f.eq.throwAt(harm, 'throw'); assert.equal(attempts, 2)
  f.ctx.entity.id = 3
  await f.eq.throwAt(harm, 'throw'); assert.equal(attempts, 3)
})

test('a failed web placement retries when its visible face opens, without a rest period', async () => {
  const { Vec3 } = require('vec3'); const web = item('cobweb', 37); const f = fixture([web])
  let face = false, placements = 0, block = 'air'
  const cell = new Vec3(4, 0, 0)
  f.bot.entity = { position: new Vec3(0, 0, 0) }
  f.bot.blockAt = p => ({ name: p.y < 0 ? 'stone' : block, boundingBox: p.y < 0 ? 'block' : 'empty', position: p })
  f.bot.lookAt = async () => {}
  f.bot.placeBlock = async () => { placements++; block = 'cobweb' }
  Object.assign(f.ctx, { ctl: { aborted: false }, Vec3, holdItem: async () => true, used() {},
    pick: { faceAim: () => face ? new Vec3(4.5, 0, .5) : null },
    blockName: (_b, p) => f.bot.blockAt(p).name, withTimeout: async p => p })
  assert.equal(await f.eq.placeAt(web, cell, 'web'), false)
  assert.equal(placements, 0)
  face = true
  assert.equal(await f.eq.placeAt(web, cell, 'web'), true)
  assert.equal(placements, 1)
})


test('own splash danger follows its projectile destruction receipt instead of seven hundred milliseconds', async () => {
  const { Vec3 } = require('vec3'); const harm = potion(37, 'strong_harming'); const f = fixture([harm])
  let now = 1000
  f.bot._client = new EventEmitter(); f.bot.entity = { id: 1, position: new Vec3(0, 0, 0) }; f.bot.entities = {}
  f.bot.blockAt = () => null
  Object.assign(f.ctx, { entity: { id: 2, position: new Vec3(8, 0, 0) }, EYE: 1.62, Vec3,
    gameClock: { now: () => now }, reachable: () => true, holdItem: async () => true, holdWeapon: async () => {},
    leadFn: () => () => new Vec3(8, 0, 0), used() {}, pick: require('../src/pick'),
    throwMod: { throwAt: async () => {
      f.bot._client.emit('spawn_entity', { entityId: 77, objectData: 1, type: registry.entitiesByName.splash_potion.id })
      return { thrown: true, land: { x: 8, y: 0, z: 0 }, ticks: 20 }
    } } })
  const eq = createEquipment(f.ctx)
  assert.equal(await eq.throwAt(harm, 'throw'), true)
  now += 60000
  const danger = eq.splashDanger?.()
  assert.ok(danger, 'known live own bottle still has a blast area')
  assert.equal(danger.id, 77)
  f.bot.emit('entityGone', { id: 77 })
  assert.equal(eq.splashDanger(), null)
  eq.closeEquipment?.()
})

test('server item cooldown gates the native item and its zero packet permits immediate use', async () => {
  const heal = potion(37, 'strong_healing'); const f = fixture([heal])
  let now = 1000; f.bot._client = new EventEmitter(); f.ctx.gameClock = { now: () => now }
  const eq = createEquipment(f.ctx)
  f.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:splash_potion', cooldownTicks: 20 })
  assert.equal(await eq.useAt(0, 0, { item: heal }), false)
  f.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:splash_potion', cooldownTicks: 0 })
  assert.equal(await eq.useAt(0, 0, { item: heal }), true)
  eq.closeEquipment?.()
})


test('a second harmful splash waits for the first projectile even after its item count changed', async () => {
  const { Vec3 } = require('vec3'); const harm = potion(37, 'strong_harming'); harm.count = 3
  const f = fixture([harm]); let shots = 0
  f.bot._client = new EventEmitter(); f.bot.entity = { id: 1, position: new Vec3(0, 0, 0) }; f.bot.entities = {}
  f.bot.blockAt = () => null
  Object.assign(f.ctx, { entity: { id: 2, position: new Vec3(8, 0, 0) }, EYE: 1.62, Vec3,
    gameClock: { now: () => 1000 }, reachable: () => true, holdItem: async () => true, holdWeapon: async () => {},
    leadFn: () => () => new Vec3(8, 0, 0), used() {}, pick: require('../src/pick'),
    throwMod: { throwAt: async () => {
      shots++; harm.count--
      f.bot._client.emit('spawn_entity', { entityId: 70 + shots, objectData: 1, type: registry.entitiesByName.splash_potion.id })
      return { thrown: true, land: { x: 8, y: 0, z: 0 }, ticks: 20 }
    } } })
  const eq = createEquipment(f.ctx)
  assert.equal(await eq.throwAt(harm, 'throw'), true)
  assert.equal(await eq.throwAt(harm, 'throw'), false)
  assert.equal(shots, 1)
  f.bot.emit('entityGone', { id: 71 })
  assert.equal(await eq.throwAt(harm, 'throw'), true)
  assert.equal(shots, 2)
  eq.closeEquipment?.()
})
