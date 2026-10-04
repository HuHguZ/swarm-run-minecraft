'use strict'
// Природная лава для портала (агент G, 02.10.2026): тело озера, небо, руины, оценка и порядок поиска.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { lavaBody, skyAbove, rpNear, estimate, searchOrder, legTarget, hintFor, edgeSpot, refreshCastLava, softCells, poolInfo, skyOfScan, NEED } = require('../src/portal-natural')

// Озеро лавы 4×4 на y 62 (x 0..3, z 0..3), под ним ещё слой на y 61; над озером воздух, кроме клетки (3,63,3) —
// там камень (закрытый верх). Вокруг и ниже — камень, выше 62 — воздух.
function world (extra = {}) {
  const at = p => {
    const k = `${p.x},${p.y},${p.z}`
    if (extra[k]) return extra[k]
    if (p.x === 3 && p.y === 63 && p.z === 3) return 'stone'
    if ((p.y === 62 || p.y === 61) && p.x >= 0 && p.x <= 3 && p.z >= 0 && p.z <= 3) return 'lava'
    return p.y >= 63 ? 'air' : 'stone'
  }
  return p => {
    const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const name = at(q)
    return { name, position: q, boundingBox: /air|lava|water/.test(name) ? 'empty' : 'block', getProperties: () => ({ level: 0 }), metadata: 0 }
  }
}
const bot = read => ({ blockAt: read })

test('тело лавы: все источники связаны, открытый верх — только где сверху воздух', () => {
  const b = bot(world())
  const body = lavaBody(b, new Vec3(0, 62, 0), new Set())
  assert.equal(body.all, 32)
  assert.equal(body.open, 15) // 16 верхних, одна под камнем
  assert.deepEqual([body.minY, body.maxY], [61, 62])
})

test('небо над клеткой: камень над головой — нет неба', () => {
  const b = bot(world())
  assert.equal(skyAbove(b, new Vec3(0, 62, 0), 20), true)
  assert.equal(skyAbove(b, new Vec3(3, 62, 3), 20), false)
})

test('руины: плачущий обсидиан и незерак рядом — руины, голый обсидиан — нет', () => {
  const ruins = bot(world({ '5,63,0': 'crying_obsidian', '5,64,0': 'obsidian', '6,63,0': 'netherrack', '6,62,0': 'netherrack' }))
  assert.equal(rpNear(ruins, new Vec3(0, 62, 0), 7).rp, true)
  const bare = bot(world({ '5,63,0': 'obsidian' }))
  assert.equal(rpNear(bare, new Vec3(0, 62, 0), 7).rp, false)
})

test('оценка: ближе и больше — быстрее; малое озеро дороже', () => {
  const me = { x: 0, y: 70, z: 0 }
  const near = estimate(me, { at: { x: 40, y: 62, z: 0 }, kind: 'surface', open: 30 })
  const far = estimate(me, { at: { x: 200, y: 62, z: 0 }, kind: 'surface', open: 30 })
  const small = estimate(me, { at: { x: 40, y: 62, z: 0 }, kind: 'surface', open: NEED })
  const cave = estimate(me, { at: { x: 40, y: 10, z: 0 }, kind: 'cave', open: 30 })
  assert.ok(near < far)
  assert.ok(near < small)
  assert.ok(near < cave)
})

test('порядок поиска: сперва видимое, запасной — вниз; ровный биом назван', () => {
  const o = searchOrder('savanna')
  assert.equal(o.length, 5)
  assert.match(o[0], /руины/)
  assert.match(o[4], /−55/)
  assert.match(o[2], /ровный биом/)
  assert.doesNotMatch(searchOrder('forest')[2], /ровный биом:/)
})

// Суша при x < 40, дальше море (вода y 62, дно 55); пол суши — трава y 64.
function coast () {
  return p => {
    const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const name = q.x >= 40 ? (q.y <= 55 ? 'sand' : q.y <= 62 ? 'water' : 'air') : (q.y <= 64 ? 'grass_block' : 'air')
    return { name, position: q, boundingBox: /air|water/.test(name) ? 'empty' : 'block' }
  }
}

test('луч мимо воды: на восток в море — короче или мимо, на запад — целиком', () => {
  const b = bot(coast())
  const start = new Vec3(0, 65, 0)
  assert.deepEqual(legTarget(b, start, [1, 0], 64), { x: 32, y: 65, z: 0 }) // 64 и 48 — конец в воде, 32 — суша
  assert.deepEqual(legTarget(b, start, [-1, 0], 64), { x: -64, y: 65, z: 0 })
  assert.deepEqual(legTarget(b, new Vec3(-20, 65, 0), [1, 0], 64), { x: 28, y: 65, z: 0 }) // 44 — вода, 28 — суша
  assert.equal(legTarget(b, new Vec3(30, 65, 0), [1, 0], 64), null) // 94, 78, 62 — море
  // Конец на суше, но путь от текущего места через море больше трети — короче или мимо.
  assert.equal(legTarget(b, new Vec3(0, 65, 0), [0, 1], 64, new Vec3(100, 65, 64)), null)
})

test('подсказка из пула: поле sky по сиду, нет сида — null', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path')
  const f = path.join(os.tmpdir(), `nd-pool-${process.pid}.json`)
  fs.writeFileSync(f, JSON.stringify({ seeds: [{ seed: '-5', sky: { d: 91, cls: 'surface', at: [-8, 63, -91], src: 86 } }, { seed: '7', sky: null }] }))
  try {
    assert.deepEqual(hintFor('-5', f), { x: -8, y: 63, z: -91, kind: 'surface', src: 86, dist: 91 })
    assert.equal(hintFor('7', f), null)
    assert.equal(hintFor('8', f), null)
    assert.equal(hintFor(null, f), null)
  } finally { fs.unlinkSync(f) }
})

test('берег у лавы: клетка места вычерпана — тело от соседнего источника, встать на край чаши', () => {
  // Озеро y 62 (x 0..3, z 0..3), вокруг камень до y 62, выше воздух. Клетка (0,62,0) вычерпана — воздух.
  const b = bot(world({ '0,62,0': 'air' }))
  b.entity = { position: new Vec3(-6, 63, 0) }
  const e = edgeSpot(b, { x: 0, y: 62, z: 0 })
  assert.ok(e, 'место на берегу найдено')
  assert.equal(e.y, 63) // на краю чаши, над камнем
  assert.ok(e.x === -1 || e.z === -1 || e.x === 4 || e.z === 4)
})

test('добор cast.js: вычерпанные источники плана заменить живыми у берега, ближними к раме', () => {
  // Озеро 4×4 y 62; источники x 0 вычерпаны (воздух). Рама — у x −4.
  const b = bot(world({ '0,62,0': 'air', '0,62,1': 'air', '0,62,2': 'air', '0,62,3': 'air' }))
  b.entity = { position: new Vec3(-4, 63, 1) }
  const patched = []
  const session = { bot: b, castPlan: { lavaAt: [{ x: 0, y: 62, z: 0 }] }, journal: { patch: f => patched.push(f) } }
  const n = refreshCastLava(session, { x: 0, y: 62, z: 0 }, new Vec3(-4, 63, 1))
  assert.ok(n > 0)
  assert.equal(session.castPlan.lavaAt.length, n)
  assert.ok(session.castPlan.lavaAt.every(p => p.x >= 1 && p.y === 62), 'только живые')
  assert.equal(session.castPlan.lavaAt[0].x, 1, 'ближние к раме первыми')
  assert.equal(refreshCastLava({ bot: b, castPlan: null, journal: { patch () {} } }, { x: 0, y: 62, z: 0 }), 0)
})

test('клетки травы и снега из отчёта литья: «не выкопано» и «упирается в»', () => {
  const cells = softCells({
    trace: ['видно 0', 'не выкопано 2: 237,68,345 short_grass; -5,64,-87 snow'],
    stopped: 'клетка 237,68,345: лава: луч к грани 237,67,345 упирается в 237,68,344'
  }).map(p => `${p.x},${p.y},${p.z}`)
  assert.deepEqual(cells, ['237,68,345', '-5,64,-87', '237,68,345', '237,67,345', '237,68,344'])
  assert.deepEqual(softCells({ stopped: 'лава кончилась' }), [])
})

test('скан копии мира: видимая сверху лава — озеро или руины на поверхности; малое тело — штраф; сида нет в пуле — файл скана', () => {
  const r = { byClass: {
    surface: { nearest10: { near: 100, at: [1, 64, 2], src: 12, depth: 0 }, fastest10: { near: 120, at: [3, 64, 4], src: 80, depth: 0 } },
    rp: { nearest10: { near: 50, at: [5, 30, 6], src: 15, depth: 40 }, fastest10: null },
    'open-cave': { nearest10: { near: 10, at: [7, 0, 8], src: 500, depth: 70 } }
  } }
  assert.deepEqual(skyOfScan(r), { d: 120, cls: 'surface', at: [3, 64, 4], src: 80 }) // 100+40 > 120; руины в 40 вглубь — нет
  assert.equal(skyOfScan({ byClass: { 'open-cave': r.byClass['open-cave'] } }), null)
  const fs = require('fs'); const os = require('os'); const path = require('path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-scan-'))
  const pool = path.join(dir, 'pool.json')
  fs.writeFileSync(pool, JSON.stringify({ seeds: [{ seed: '1', lava: 50, sky: null }, { seed: '2', lava: null }] }))
  fs.writeFileSync(path.join(dir, '3.json'), JSON.stringify(r))
  try {
    assert.deepEqual(poolInfo('1', { file: pool, dir }), { scanned: true, hint: null })
    assert.deepEqual(poolInfo('2', { file: pool, dir }), { scanned: false, hint: null })
    assert.deepEqual(poolInfo('3', { file: pool, dir }), { scanned: true, hint: { x: 3, y: 64, z: 4, kind: 'surface', src: 80, dist: 120 } })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
