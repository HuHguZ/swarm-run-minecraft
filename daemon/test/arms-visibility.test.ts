import test from 'node:test'
import assert from 'node:assert/strict'
const { Vec3 } = require('vec3')
const AL = require('../arms-layout')
const pick = require('../src/pick')

// Эмуляция зрения на раскладке гонки (замечание проверки раунда 1: blocks_around seen по raySees с допуском 1.2 бл.
// «видел» 27/40 тайников из достижимых клеток, запад/восток 75–85 против 8–9 клеток). Мир — модель раскладки,
// контуры как у prismarine-block: сундук 1/16…15/16 × 0…14/16, твёрдое — куб, воздух/вода/трава/факел — без контура.
const CHEST = [[1 / 16, 0, 1 / 16, 15 / 16, 14 / 16, 15 / 16]]
const FULL = [[0, 0, 0, 1, 1, 1]]
function fakeBot (g) {
  return {
    entity: { position: new Vec3(0, 0, 0), height: 1.8 },
    blockAt (p) {
      const s = g.get(p.x, p.y, p.z)
      const name = (s || 'air').replace(/\[.*$/, '')
      const solid = AL.solidAt(g, p.x, p.y, p.z)
      return { name, position: p, boundingBox: solid ? 'block' : 'empty', shapes: solid ? (name === 'chest' ? CHEST : FULL) : [] }
    }
  }
}

function seenFrom (L, bot, cells, c, r = 24) {
  let n = 0
  for (const k of cells) {
    const [x, y, z] = k.split(',').map(Number)
    const eye = new Vec3(x + 0.5, y + 1.62, z + 0.5)
    if (eye.distanceTo(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5)) > r) continue
    if (pick.blockSeen(bot, new Vec3(c.x, c.y, c.z), { eye, range: r })) n++
  }
  return n
}

test('зрение гонки: тайник за облицовкой не виден ни из одной достижимой клетки, открытый сундук виден, стороны симметричны', () => {
  for (const seed of ['3', '6', '11']) {
    const L = AL.generate(seed)
    const bot = fakeBot(L.g)
    const cells = new Set([...AL.reach(L.g, L.spawns[0]), ...AL.reach(L.g, L.spawns[1])])
    const counts = new Map()
    for (const c of L.chests) {
      const n = seenFrom(L, bot, cells, c)
      counts.set(c.id, n)
      if (c.cover) assert.equal(n, 0, `seed ${seed}: тайник ${c.id} (${c.kind}) виден из ${n} клеток`)
      else assert.ok(n > 0, `seed ${seed}: открытый ${c.id} (${c.kind}, ${c.room}) не виден ниоткуда`)
    }
    for (const c of L.chests.filter((q: any) => q.x < 0)) {
      const m = L.chests.find((q: any) => q.x === -c.x && q.y === c.y && q.z === c.z)
      assert.equal(counts.get(c.id), counts.get(m.id), `seed ${seed}: ${c.id} ${counts.get(c.id)} против зеркального ${m.id} ${counts.get(m.id)}`)
    }
    // Вскрыли облицовку тайника — сундук виден (тот же луч, клетки облицовки — воздух).
    const hid = L.chests.find((c: any) => c.kind === 'niche') || L.chests.find((c: any) => c.cover)
    for (const v of hid.cover) L.g.set(v.x, v.y, v.z, 'air')
    const after = AL.reach(L.g, L.spawns[0])
    assert.ok(seenFrom(L, bot, after, hid) > 0, `seed ${seed}: вскрытый ${hid.id} не виден`)
  }
})

test('зрение: блок за одним слоем облицовки не виден, сквозь стекло виден, грань сзади не считается', () => {
  const g = new Map()
  const bot = {
    entity: { position: new Vec3(0, 0, 0), height: 1.8 },
    blockAt (p) {
      const name = g.get(`${p.x},${p.y},${p.z}`) || 'air'
      const solid = name !== 'air'
      return { name, position: p, boundingBox: solid ? 'block' : 'empty', shapes: solid ? (name === 'chest' ? CHEST : FULL) : [] }
    }
  }
  const eye = new Vec3(0.5, 1.62, 0.5)
  g.set('5,1,0', 'chest')
  assert.equal(pick.blockSeen(bot, new Vec3(5, 1, 0), { eye }), true)
  g.set('4,1,0', 'oak_planks')
  assert.equal(pick.blockSeen(bot, new Vec3(5, 1, 0), { eye }), false, 'облицовка вплотную закрывает')
  g.set('4,1,0', 'glass')
  assert.equal(pick.blockSeen(bot, new Vec3(5, 1, 0), { eye }), true, 'сквозь стекло видно')
  // Колонна целиком закрыта по высоте глаз: стена в 2 блока по 3 клетки шириной.
  for (const y of [0, 1, 2]) for (const z of [-1, 0, 1]) g.set(`4,${y},${z}`, 'stone_bricks')
  assert.equal(pick.blockSeen(bot, new Vec3(5, 1, 0), { eye }), false)
})
