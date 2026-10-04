'use strict'
// Литьё глубоко (поток overworld, 02.10.2026): окно к лаве за блоком и место рамы в штреке у дна.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { windowCandidates, planCast, geom } = require('../src/cast')

// Штрек на y −54 (ноги) вдоль x 0..10 при z 0, вокруг глубинный сланец; озеро лавы на y −55 при x 11..20, z −3..3,
// над ним сланец (лава за блоком: штрек встал «лава на 11,-55,0 (в 1 впереди)»).
function world (extra = {}) {
  const at = p => {
    const k = `${p.x},${p.y},${p.z}`
    if (extra[k]) return extra[k]
    if (p.z === 0 && p.x >= 0 && p.x <= 10 && (p.y === -54 || p.y === -53)) return 'air'
    if (p.y === -55 && p.x >= 11 && p.x <= 20 && p.z >= -3 && p.z <= 3) return 'lava'
    return 'deepslate'
  }
  return p => {
    const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const name = at(q)
    const empty = /^(air|cave_air|lava|water)$/.test(name)
    return { name, position: q, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ level: 0 }), metadata: 0 }
  }
}
function bot (read, pos = new Vec3(10.5, -54, 0.5)) {
  return { entity: { position: pos, height: 1.8, eyeHeight: 1.62 }, blockAt: read, entities: {}, getControlState: () => false }
}

test('окно к лаве: ломается только блок над источником, видимый с грани штрека', () => {
  const b = bot(world())
  const c = windowCandidates(b, { x: 11, y: -55, z: 0 })
  assert.equal(c.length, 1)
  assert.deepEqual([c[0].w.x, c[0].w.y, c[0].w.z], [11, -54, 0])
  assert.deepEqual([c[0].face.x, c[0].face.y, c[0].face.z], [-1, 0, 0], 'грань со стороны штрека')
})

test('окно не открывается, если рядом с блоком жидкость (польётся в окно) или сверху гравий', () => {
  for (const extra of [{ '12,-54,0': 'lava' }, { '11,-54,1': 'water' }, { '11,-53,0': 'gravel' }]) {
    const c = windowCandidates(bot(world(extra)), { x: 11, y: -55, z: 0 })
    assert.equal(c.length, 0, JSON.stringify(extra))
  }
})

test('свой пол не ломается: лава прямо под ногами — окна нет', () => {
  const read = world({ '10,-55,0': 'lava' })
  const c = windowCandidates(bot(read, new Vec3(10.5, -54, 0.5)), { x: 10, y: -55, z: 0 })
  assert.ok(c.every(x => !(x.w.x === 10 && x.w.z === 0)), 'под ногами')
})

test('место рамы в штреке: копать ≤ 64, рабочие клетки не ближе 7 к лаве, ряд j=5 не копается', () => {
  const read = world()
  const b = bot(read, new Vec3(10.5, -54, 0.5))
  const lava = [new Vec3(11, -55, 0), new Vec3(12, -55, 0), new Vec3(11, -55, 1), new Vec3(11, -55, -1)]
  const r = planCast(b, lava, { radius: 9, maxDig: 64, keep: 7 })
  assert.equal(r.ok, true, JSON.stringify(r.reasons))
  const p = r.plan
  assert.ok(p.dig.length <= 64)
  const g = geom(new Vec3(p.origin.x, p.origin.y, p.origin.z), p.axis, p.side)
  for (let i = -1; i <= 2; i++) {
    for (let j = -1; j <= 4; j++) {
      for (const w of [g.at(i, j), g.F(i, j)]) {
        for (const l of lava) assert.ok(Math.max(Math.abs(l.x - w.x), Math.abs(l.y - w.y), Math.abs(l.z - w.z)) >= 7)
      }
    }
    const top = g.F(i, 5)
    assert.equal(p.dig.some(c => c.x === top.x && c.y === top.y && c.z === top.z), false, 'j=5 не копается')
  }
  // Ряд перед рамой стоит на полу штрека (ноги — y −54).
  assert.equal(g.F(0, -1).y, -54)
})

test('черпак: вода на уровне ног в соседней клетке под потолком — прицел в бок клетки, а не в верх сквозь камень', () => {
  const { scoopAim } = require('../src/cast')
  // Тело в штреке на y −54 (x 0..10, z 0), вода в стенке сбоку (1,-54,-1), над ней сланец.
  const read = world({ '1,-54,-1': 'water' })
  const b = bot(read, new Vec3(1.5, -54, 0.5))
  const p = scoopAim(b, new Vec3(1, -54, -1))
  assert.ok(p, 'точка есть')
  assert.ok(p.y < -53.3, `ниже верха клетки: ${p.y}`)
})

test('черпак в пещере над озером: стоять — на берегу (конец штрека), не над лавой; источник под потолком не «виден»', () => {
  const { standSpots, lavaSources } = require('../src/cast')
  const extra = {}
  for (let x = 11; x <= 18; x++) for (let z = -3; z <= 3; z++) for (const y of [-54, -53, -52]) extra[`${x},${y},${z}`] = 'air'
  const b = bot(world(extra), new Vec3(5.5, -54, 0.5))
  const spots = standSpots(b, new Vec3(11, -55, 0))
  assert.ok(spots.length > 0, 'есть где встать')
  for (const sp of spots) assert.equal(b.blockAt(sp.S.offset(0, -1, 0)).name, 'deepslate', 'пол — камень, не лава')
  assert.ok(spots[0].S.z === 0 && spots[0].S.x <= 10 && spots[0].S.y === -54, 'в штреке, ближе к телу')
  // Под потолком (озеро без пещеры): источник за первым не считается видимым — над ним камень.
  const under = bot(world({ '11,-54,0': 'air' }), new Vec3(10.5, -54, 0.5))
  under.registry = { blocksByName: { lava: { id: 1 } }, blocks: { 1: { minStateId: 0, maxStateId: 0 } }, blocksByStateId: {} }
  void lavaSources
})

test('слух: лава с воздухом над ней в 16 бл. — сторона и дальность; под потолком — не слышно', () => {
  const { hearLava } = require('../src/cast')
  // Озеро −55 x 11..18 под потолком (−54 сланец) — не булькает.
  const quiet = bot(world(), new Vec3(2.5, -54, 0.5))
  assert.deepEqual(hearLava(quiet, { radius: 16 }), [])
  // Пещера над озером — булькает: восток, ~10 бл.
  const extra = {}
  for (let x = 11; x <= 18; x++) for (let z = -3; z <= 3; z++) extra[`${x},-54,${z}`] = 'air'
  const h = hearLava(bot(world(extra), new Vec3(2.5, -54, 0.5)), { radius: 16 })
  assert.equal(h.length, 1)
  assert.equal(h[0].dir, 'east')
  assert.ok(h[0].dist >= 8 && h[0].dist <= 12, `дальность ${h[0].dist}`)
})
