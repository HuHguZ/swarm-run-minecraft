'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { Vec3 } from 'vec3'
import { axisOf, bridgeStep, waterAhead, bridgeWorth } from '../src/water-bridge'

// Берег: камень на y 63 при x ≤ 0 и x ≥ 9; между — озеро (вода y 61..63, дно камень y 60); стена на z = 3.
function lake (wall = false) {
  return {
    blockAt (p: Vec3) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      let name = 'air'
      if (wall && z === 3 && y >= 64) name = 'stone'
      else if (x <= 0 || x >= 9) name = y <= 63 ? 'stone' : 'air'
      else name = y <= 60 ? 'stone' : y <= 63 ? 'water' : 'air'
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'stone' ? 'block' : 'empty' }
    }
  }
}

test('мост: ось взгляда; с берега над водой — ставить к грани опоры; на берегу — идти', () => {
  assert.deepEqual(axisOf(-Math.PI / 2), { x: 1, z: 0 }, 'взгляд на +x')
  assert.deepEqual(axisOf(Math.PI), { x: 0, z: 1 }, 'взгляд на +z')
  const w = lake()
  const s = bridgeStep(w, new Vec3(0, 63, 0), { x: 1, z: 0 })
  assert.equal(s.kind, 'place')
  assert.deepEqual([s.cell.x, s.cell.y, s.cell.z], [1, 63, 0], 'блок — в клетку воды на уровне пола')
  assert.deepEqual([s.face.x, s.face.y, s.face.z], [1, 0, 0], 'к передней грани опоры')
  assert.equal(bridgeStep(w, new Vec3(8, 63, 0), { x: 1, z: 0 }).kind, 'land')
  assert.equal(bridgeStep(w, new Vec3(-3, 63, 0), { x: 1, z: 0 }).kind, 'land')
  assert.equal(bridgeStep(lake(true), new Vec3(0, 63, 2), { x: 0, z: 1 }).kind, 'blocked', 'стена по ходу')
})

test('мост: 8 клеток воды до берега; цена — блоков хватает и берег есть', () => {
  const a = waterAhead(lake(), new Vec3(0, 63, 0), { x: 1, z: 0 })
  assert.deepEqual(a, { water: 8, shore: true })
  assert.equal(bridgeWorth({ ...a, blocks: 64 }), true)
  assert.equal(bridgeWorth({ ...a, blocks: 5 }), false, 'блоков на всю воду не хватит — плыть')
  assert.equal(bridgeWorth({ water: 8, shore: false, blocks: 64 }), false, 'берега не видно — не строить в никуда')
})
