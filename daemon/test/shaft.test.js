'use strict'
// Колодец вниз со своим чутьём (mining.shaftDown, поток overworld 02.10.2026).
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { shaftDown } = require('../src/mining')

function rig (extra = {}) {
  const dug = new Set()
  const name = p => {
    const k = `${p.x},${p.y},${p.z}`
    if (dug.has(k)) return 'air'
    if (extra[k]) return extra[k]
    return p.y >= 70 ? 'air' : 'stone'
  }
  const block = p => {
    const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const n = name(q)
    const empty = /^(air|cave_air|lava|water)$/.test(n)
    return { name: n, type: 1, position: q, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]], hardness: 1.5, diggable: true, digTime: () => 600 }
  }
  const bot = {
    entity: { position: new Vec3(0.5, 70, 0.5), onGround: true, height: 1.8 },
    health: 20,
    entities: {},
    inventory: { items: () => [{ name: 'stone_pickaxe', type: 2, count: 1 }], slots: [] },
    heldItem: { name: 'stone_pickaxe', type: 2 },
    blockAt: block,
    equip: async () => {},
    dig: async b => {
      dug.add(`${b.position.x},${b.position.y},${b.position.z}`)
      // Тело падает до опоры.
      let y = b.position.y
      while (name(new Vec3(0, y - 1, 0)) === 'air' || name(new Vec3(0, y - 1, 0)) === 'cave_air') y--
      bot.entity.position = new Vec3(0.5, y, 0.5)
    }
  }
  const session = { bot, mcData: { blocks: { 1: { harvestTools: { 2: true } } }, items: {} } }
  const ctl = { aborted: false, onAbort: [] }
  return { session, ctl, bot }
}

test('колодец: чистый камень — вниз на нужное число уровней', async () => {
  const { session, ctl, bot } = rig()
  const r = await shaftDown(session, ctl, { length: 10, timeoutSeconds: 30 })
  assert.equal(r.stopped, undefined)
  assert.equal(r.descended, 10)
  assert.equal(bot.entity.position.y, 60)
})

test('колодец: лава сбоку от клетки двумя ниже — стоп до удара, место названо', async () => {
  const { session, ctl } = rig({ '1,65,0': 'lava' })
  const r = await shaftDown(session, ctl, { length: 10, timeoutSeconds: 30 })
  assert.match(r.stopped, /лава на 1,65,0/)
  assert.ok(r.descended <= 4, `спустился на ${r.descended}`)
})

test('колодец: пещера под ногами глубже 3 — стоп', async () => {
  const extra = {}
  for (let y = 55; y <= 63; y++) extra[`0,${y},0`] = 'cave_air'
  const { session, ctl } = rig(extra)
  const r = await shaftDown(session, ctl, { length: 20, timeoutSeconds: 30 })
  assert.match(r.stopped, /пустота/)
})
