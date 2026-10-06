'use strict'
// Звёзды фейерверков для арбалета (TODO п.8, 2026-10-06): пустая ракета для
// элитр (0 звёзд) не ранит (FireworkRocketEntity.dealExplosionDamage:
// f = 5 + 2·звёзд, только если звёзды есть) — её не заряжать и не стрелять ею.
const test = require('node:test')
const assert = require('node:assert/strict')
const ranged = require('../src/ranged')
const read = require('../src/read')

const registry = require('minecraft-data')('1.21.11')
const rocket = (stars, slot = 9, count = 16) => ({
  name: 'firework_rocket', count, slot,
  componentMap: stars ? new Map([['fireworks', { type: 'fireworks', data: { flightDuration: 1, explosions: Array.from({ length: stars }, () => ({ shape: 'small_ball' })) } }]]) : new Map()
})
// Заряженный арбалет: сырые слоты снарядов, как их шлёт сервер.
const crossbow = (loaded, slot = 36) => {
  const cm = new Map()
  if (loaded) {
    const id = registry.itemsByName[loaded.name].id
    const comps = loaded.stars ? [{ type: 'fireworks', data: { flightDuration: 1, explosions: Array.from({ length: loaded.stars }, () => ({ shape: 'small_ball' })) } }] : []
    cm.set('charged_projectiles', { type: 'charged_projectiles', data: { projectiles: [{ itemCount: 1, itemId: id, addedComponentCount: comps.length, removedComponentCount: 0, components: comps, removeComponents: [] }] } })
  }
  return { name: 'crossbow', count: 1, slot, componentMap: cm }
}
function bot (items, off = null) {
  const slots = []
  for (const it of items) slots[it.slot] = it
  slots[45] = off
  return { registry, inventory: { items: () => items, slots }, entity: { position: { x: 0, y: 0, z: 0 } } }
}
const foe = { equipment: [], position: { x: 15, y: 0, z: 0 } }

test('rocketsOf: ракета со звёздами, пустая — не годится', () => {
  const plain = rocket(0, 10)
  const three = rocket(3, 11)
  assert.equal(ranged.rocketsOf(bot([plain, three])), three)
  assert.equal(ranged.rocketsOf(bot([plain])), null)
  // Пустая в левой руке не мешает найти со звёздами в рюкзаке.
  const off = rocket(0, 45)
  assert.equal(ranged.rocketsOf(bot([rocket(2, 12)], off)).slot, 12)
})

test('crossbowInfo: звёзды заряженной ракеты из сырого слота', () => {
  const b = bot([])
  assert.equal(read.crossbowInfo(b, crossbow({ name: 'firework_rocket', stars: 3 })).stars, 3)
  assert.equal(read.crossbowInfo(b, crossbow({ name: 'firework_rocket', stars: 0 })).stars, 0)
  assert.equal(read.crossbowInfo(b, crossbow({ name: 'arrow' })).stars, null)
})

test('expectedDamage: 0 звёзд — 0; больше звёзд — больнее', () => {
  const b = bot([])
  assert.equal(ranged.expectedDamage(b, foe, 'firework', 0), 0)
  const d1 = ranged.expectedDamage(b, foe, 'firework', 1)
  const d3 = ranged.expectedDamage(b, foe, 'firework', 3)
  assert.ok(d1 > 0 && d3 > d1, `${d1} < ${d3}`)
})

test('plan: пустой ракетой не стреляет и пустую не заряжает; со звёздами — стреляет', () => {
  const ctx = { entity: foe, d: 15, sees: true, fs: {}, safe: () => true }
  const dud = bot([crossbow({ name: 'firework_rocket', stars: 0 })])
  assert.equal(ranged.plan(dud, ctx), null, 'заряжен пустой — не выстрел фейерверком')
  const live = bot([crossbow({ name: 'firework_rocket', stars: 3 })])
  const p = ranged.plan(live, ctx)
  assert.ok(p && p.act === 'fire' && /фейерверк/.test(p.why), JSON.stringify(p && p.why))
  const onlyPlain = bot([crossbow(null), rocket(0, 10)])
  assert.equal(ranged.plan(onlyPlain, ctx), null, 'только пустые ракеты и нет стрел — не заряжать')
  const withStars = bot([crossbow(null), rocket(0, 10), rocket(2, 11)])
  const l = ranged.plan(withStars, ctx)
  assert.ok(l && l.act === 'load' && l.ammo === 'firework')
})

// s7b 06.10: взрыв ракеты сбоку-сзади от него щит не держит (BlocksAttacks 90° от его взгляда до точки взрыва).
test('shieldBypassPoint: точка в полу сбоку-сзади, луч мимо его рамки, угол > 95°; стена перед ним — нет точки', () => {
  const { Vec3 } = require('vec3')
  const walls = new Set<string>()
  const world = (p: any) => {
    const solid = p.y < 100 || walls.has(`${p.x},${p.y},${p.z}`)
    return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  const b: any = { blockAt: world, entity: { position: new Vec3(0.5, 100, 0.5) } }
  // Он в 10 бл. на север, смотрит на нас (yaw π — на юг, +z).
  const him = { position: new Vec3(0.5, 100, -9.5), yaw: Math.PI, equipment: [] }
  const from = new Vec3(0.5, 101.47, 0.5)
  const bp = ranged.shieldBypassPoint(b, him, from, 3)
  assert.ok(bp, 'точка есть')
  assert.ok(bp.point.z < him.position.z, 'за ним (дальше от нас)')
  assert.ok(Math.abs(bp.point.x - him.position.x) >= 1.2, 'сбоку')
  assert.ok(bp.raw >= 6 && bp.raw <= 11, `урон до брони ${bp.raw}`)
  // Стена высотой 3 прямо перед ним — пол за ним не виден.
  for (let x = -3; x <= 3; x++) for (let y = 100; y <= 103; y++) walls.add(`${x},${y},-8`)
  assert.equal(ranged.shieldBypassPoint(b, him, from, 3), null)
})

// s7b 06.10: зарядка второго арбалета — именно его слотом; bot.equip по имени брал заряженный, и «использовать»
// стреляло им (s7e «арбалет»: «зарядил (0 мс)» ×301).
test('load: пустой арбалет берётся своим слотом хотбара, заряженным не «используем»', async () => {
  const loadedXb = { ...crossbow({ name: 'arrow' }, 36) }
  const emptyXb = { ...crossbow(null, 37) }
  const arrow = { name: 'arrow', count: 32, slot: 38 }
  const items = [loadedXb, emptyXb, arrow]
  const b: any = bot(items)
  b.inventory.slots[36] = loadedXb; b.inventory.slots[37] = emptyXb; b.inventory.slots[38] = arrow
  b.quickBarSlot = 0
  Object.defineProperty(b, 'heldItem', { get () { return b.inventory.slots[36 + b.quickBarSlot] } })
  const log: string[] = []
  b.setQuickBarSlot = (i: number) => { b.quickBarSlot = i; log.push('slot ' + i) }
  b.equip = async () => { log.push('equip') }
  b.activateItem = () => {
    log.push('use ' + b.quickBarSlot)
    // Сервер: через тик пустой в руке заряжается стрелой.
    const id = registry.itemsByName.arrow.id
    b.inventory.slots[36 + b.quickBarSlot].componentMap.set('charged_projectiles', { type: 'charged_projectiles', data: { projectiles: [{ itemCount: 1, itemId: id, components: [] }] } })
  }
  b.deactivateItem = () => log.push('release')
  b.setControlState = () => {}
  const r = await ranged.load(b, { aborted: false }, emptyXb, { ammo: 'arrow' })
  assert.equal(r.ok, true)
  assert.deepEqual(log.slice(0, 2), ['slot 1', 'use 1'], 'сначала слот пустого, потом «использовать»')
  assert.equal(log.includes('use 0'), false, 'заряженный не трогали')
})
