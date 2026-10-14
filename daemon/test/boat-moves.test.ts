'use strict'
// Лодка как ход goto (14.10): уступ под подъём (стена ровно в 2, по проступи до неё ровно) и цена спуска с риском промаха.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')

function world () {
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const cells = new Map()
  const set = (x, y, z, n) => cells.set(`${x},${y},${z}`, n)
  for (let x = -4; x <= 8; x++) for (let z = -3; z <= 3; z++) set(x, 63, z, 'stone')
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: p => { const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; const b = Block.fromStateId(registry.blocksByName[cells.get(k) || 'air'].defaultState, 0); b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b } }
  return { bot, set }
}

test('уступ под лодку: стена в 2 через клетку проступи — прыжок у стены; стена в 3 и ступень в 1 — не уступ', () => {
  const { climbLedge } = require('../src/navigation/boat-moves')
  const W = world()
  for (let z = -3; z <= 3; z++) for (let x = 2; x <= 8; x++) { W.set(x, 64, z, 'stone'); W.set(x, 65, z, 'stone') }
  const l = climbLedge(W.bot, new Vec3(1, 0, 0))
  assert.deepEqual([l.base.x, l.base.y, l.stand.x, l.stand.y], [2, 65, 1, 64])
  for (let z = -3; z <= 3; z++) W.set(2, 66, z, 'stone')
  assert.equal(climbLedge(W.bot, new Vec3(1, 0, 0)), null, 'стена в 3 — грань выше глаз даже в прыжке')
  const V = world()
  for (let z = -3; z <= 3; z++) V.set(1, 64, z, 'stone')
  assert.equal(climbLedge(V.bot, new Vec3(1, 0, 0)), null, 'ступень в 1 — шагом, не лодкой')
})

test('цена спуска лодкой: смертельный промах дороже несмертельного, ведро воды страхует', () => {
  const { boatSeconds } = require('../src/navigation/descent')
  assert.ok(boatSeconds(14, 20, false) < 10, 'невысоко — почти без риска')
  assert.ok(boatSeconds(30, 20, false) > 100, '30 бл. при 20 хп — промах смертелен')
  assert.ok(boatSeconds(30, 20, true) < boatSeconds(30, 20, false))
})
