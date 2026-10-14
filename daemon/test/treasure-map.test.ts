'use strict'
// Карта сокровищ по пакету карты (MapItemSavedData 1.21.11): центр — из своей точки и своей метки, крестик — в клетке 9 чанка.
const test = require('node:test')
const assert = require('node:assert/strict')
const tm = require('../src/treasure-map')
const { structureWorth, describeWorth } = require('../src/campaign/structure-value')

// Как сервер: центр карты масштаба s у точки клада, байт метки = (int)(f·2 + 0.5), f = (мир − центр) / 2^s, край ±63.
function packet (target, me, s = 1) {
  const size = 128 * (1 << s)
  const c = v => Math.floor((v + 64) / size) * size + size / 2 - 64
  const cx = c(target.x); const cz = c(target.z)
  const b = (w, cc) => { const f = (w - cc) / (1 << s); return f <= -63 ? -128 : f >= 63 ? 127 : Math.trunc(f * 2 + 0.5) }
  const inside = Math.abs((me.x - cx) / (1 << s)) < 63 && Math.abs((me.z - cz) / (1 << s)) < 63
  return { scale: s, icons: [{ type: inside ? 0 : 6, x: b(me.x, cx), z: b(me.z, cz) }, { type: 26, x: b(target.x, cx), z: b(target.z, cz) }] }
}

test('крестик → клетка клада (9, 9 чанка), центр карты — из своей метки', () => {
  for (const [tx, tz] of [[89, -39], [-311, 457], [9, 9], [-7, -55], [1033, -1015]]) {
    for (const [dx, dz] of [[0.3, 0.7], [-60.2, 40.5], [100.9, -110.1], [-120.5, -3.2]]) {
      const me = { x: tx + dx, z: tz + dz }
      const pk = packet({ x: tx, z: tz }, me)
      const r = tm.decode(pk, me)
      if (pk.icons[0].type === 0) assert.deepEqual([r.x, r.z], [tx, tz], `клад ${tx},${tz} из ${me.x},${me.z}: ${JSON.stringify(r)}`)
      else assert.ok(r.toward, `вне карты: ${JSON.stringify(r)}`)
    }
  }
})

test('вне карты — направление к ней (примерное место), не клад', () => {
  const target = { x: 89, z: -39 }
  const me = { x: 400.5, z: -30.5 }
  const r = tm.decode(packet(target, me), me)
  assert.equal(r.x, undefined)
  assert.ok(r.toward && r.toward.x < me.x, JSON.stringify(r))
  assert.equal(r.toward.z, -39, 'по оси без края — точно')
  assert.match(tm.decode({ scale: 1, icons: [{ type: 0, x: 3, z: 4 }] }, me).why, /крестика/)
})

test('цена корабля: карта — цепочкой до клада, если железо нужно', () => {
  const needs = { iron: 8, lighter: true, food: 8, portal: false, diamondPick: true, beds: 5 }
  const full = [{ table: 'shipwreck_supply', p: 1 }, { table: 'shipwreck_map', p: 1 }, { table: 'shipwreck_treasure', p: 1 }]
  const w = structureWorth('shipwreck', 40, needs, full)
  assert.ok(w.net > 0, describeWorth(w))
  assert.ok(w.known && w.chests === 3)
  // Железо сундука сокровищ закрывает нужду — клад после него стоит меньше, но алмаз и еда ещё в цене.
  const half = structureWorth('shipwreck', 40, needs, [{ table: 'shipwreck_supply', p: 1 }])
  assert.ok(half.value < w.value)
  const noMap = structureWorth('shipwreck', 40, needs, [{ table: 'shipwreck_treasure', p: 1 }])
  assert.equal(noMap.chain, 0)
  const mapOnly = structureWorth('shipwreck', 40, needs, [{ table: 'shipwreck_map', p: 1 }])
  assert.ok(mapOnly.chain > 0, describeWorth(mapOnly))
  assert.match(describeWorth(mapOnly), /treasure_map/)
  // Под водой сундук дороже: нырять.
  assert.ok(structureWorth('shipwreck', 40, needs, [{ table: 'shipwreck_treasure', p: 1, wet: true }]).cost > noMap.cost)
})
