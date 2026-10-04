'use strict'
// Поток nether-end (research/dev-F-nether-end.md): чистые части правок Ада, крепости и дороги к Энду.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { sameCell } = require('../src/nether')

test('порог на грязи/песке душ: ноги на y−0.125 — тело в клетке порога', () => {
  const door = new Vec3(21, 71, 4)
  assert.equal(sameCell(new Vec3(21.5, 70.875, 4.5), door), true) // грязь 0.875 (слот 23, 02.10)
  assert.equal(sameCell(new Vec3(21.5, 70.9375, 4.5), door), true) // тропа/грядка
  assert.equal(sameCell(new Vec3(21.5, 71, 4.5), door), true) // полный блок
  assert.equal(sameCell(new Vec3(21.5, 71.4, 4.5), door), true)
})
test('не та клетка: соседняя колонка, полблока ниже (кровать), ниже на целый блок', () => {
  const door = new Vec3(21, 71, 4)
  assert.equal(sameCell(new Vec3(22.5, 71, 4.5), door), false)
  assert.equal(sameCell(new Vec3(21.5, 70.5625, 4.5), door), false) // на кровати — это клетка кровати
  assert.equal(sameCell(new Vec3(21.5, 70, 4.5), door), false)
  assert.equal(sameCell(new Vec3(21.5, 72, 4.5), door), false)
})

// --- бастион: раскладка от старта (правда слота 23, 02.10: конюшни, air_base 80,32,−192 CCW90)
const bp = require('../src/bastion-pieces')
test('конюшни: от старта — обе стены side_wall_1 на местах правды мира, и обратно — старт из стены', () => {
  const S = { type: 'hoglin_stable', r: 3, t: { x: 80, y: 32, z: -192 } }
  const g = bp.goldPiecesFromStart(S)
  const walls = g.filter(p => p.piece === 'hoglin_stable/walls/side_wall_1').map(p => `${p.t.x},${p.t.y},${p.t.z} r${p.r}`)
  assert.deepEqual(walls.sort(), ['127,31,-174 r2', '95,31,-174 r2'])
  const back = bp.startsFrom({ piece: 'hoglin_stable/walls/side_wall_1', r: 2, t: { x: 95, y: 31, z: -174 } })
  assert.ok(back.some(h => h.type === 'hoglin_stable' && h.r === 3 && h.t.x === 80 && h.t.y === 32 && h.t.z === -192))
  // 24 предсказанных золотых обеих стен — те же клетки, что проверены в мире (execute if block → 24/24).
  const gold = g.filter(p => p.piece === 'hoglin_stable/walls/side_wall_1').flatMap(c => bp.goldOf(c))
  assert.equal(gold.length, 24)
  assert.ok(gold.some(v => v.x === 119 && v.y === 35 && v.z === -184))
})
test('мост: якорь bridge задаёт старт, золото моста — 16 клеток в его рамке', () => {
  const hs = bp.startsFrom({ piece: 'bridge/bridge_pieces/bridge', r: 0, t: { x: 17, y: 53, z: -361 } })
  assert.equal(hs.length, 1)
  assert.deepEqual(hs[0].t, { x: 48, y: 32, z: -368 })
  const br = bp.goldPiecesFromStart(hs[0]).find(p => p.piece === 'bridge/bridge_pieces/bridge')
  assert.deepEqual(br.t, { x: 17, y: 53, z: -361 })
  assert.equal(bp.goldOf(br).length, 16)
})

// --- кампания: этап nether (стержни) — только на недостающие очи
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
function campaignNeeds (inventory, places) {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory }
  class Socket {
    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method } = JSON.parse(raw)
      const detail = method === 'recall' ? { state: { places } } : {}
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({ id, ok: true, result: { status: 'done', detail, state, events: [] } })))
    }
    close () {}
  }
  const context = {
    require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync () {} } : require(name),
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
    process: { argv: ['node', 'campaign.js'], env: {} },
    console: { log () {}, error () {} }, setTimeout, Date, queueMicrotask
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../campaign.js'), 'utf8') + `
    module.exports = { readMemory, needs: name => STAGES.find(s => s.name === name).needed(), init: () => { state = testState; sit = {} } }
  `, Object.assign(context, { testState: state }))
  context.module.exports.init()
  return context.module.exports
}
const PLACES = { 'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' }, 'крепость': { x: 1500, y: 30, z: 200 } }
test('этап nether: 11 очей без жемчуга (одно разбито) — в Ад за стержнями не идти', async () => {
  const c = campaignNeeds({ ender_eye: 11 }, PLACES)
  await c.readMemory()
  assert.equal(c.needs('nether'), false)
})
test('этап nether: ничего нет — нужен; 11 очей и 3 жемчуга без порошка — нужен', async () => {
  const a = campaignNeeds({}, PLACES)
  await a.readMemory()
  assert.equal(a.needs('nether'), true)
  const b = campaignNeeds({ ender_eye: 9, ender_pearl: 3 }, PLACES)
  await b.readMemory()
  assert.equal(b.needs('nether'), true)
})

// --- блейзы: нейтральный на линии стрельбы (neF-fort25-3 02.10 — зомби-пиглины от промаха стрелы)
const { bystanderOnLine } = require('../src/blaze')
test('лук: зомби-пиглин на линии или сразу за блейзом — не стрелять; сбоку — можно', () => {
  const bot = { entity: { position: new Vec3(0, 64, 0) }, entities: {} }
  const blaze = { id: 1, name: 'blaze', position: new Vec3(10, 64, 0), height: 1.8 }
  bot.entities[1] = blaze
  bot.entities[2] = { id: 2, name: 'zombified_piglin', position: new Vec3(5, 64, 0.5), height: 1.95 }
  assert.equal(bystanderOnLine(bot, blaze).id, 2)
  bot.entities[2].position = new Vec3(12.5, 64, 0)
  assert.equal(bystanderOnLine(bot, blaze).id, 2)
  bot.entities[2].position = new Vec3(5, 64, 4)
  assert.equal(bystanderOnLine(bot, blaze), null)
  bot.entities[2].position = new Vec3(-4, 64, 0)
  assert.equal(bystanderOnLine(bot, blaze), null)
})

// --- закопаться (bastion.burrowColumn): колонна в толще под ногами — три клетки камня, твёрдый пол, глухие стенки
function fakeWorld (solid) {
  const at = v => solid(v.x, v.y, v.z)
  return { blockAt: v => { const k = at(v); return k === 'air' ? { name: 'air', boundingBox: 'empty' } : k === 'lava' ? { name: 'lava', boundingBox: 'empty' } : { name: k, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } } }
}
const { burrowColumn, goldExposes } = require('../src/bastion')
test('закопаться: ровная толща незерака под ногами — колонна годится', () => {
  const bot = fakeWorld((x, y, z) => y < 64 ? 'netherrack' : 'air')
  assert.equal(burrowColumn(bot, new Vec3(0, 64, 0)), true)
})
test('закопаться: пещера под тонким полом, лава под колонной, пустота сбоку — не годится', () => {
  const thin = fakeWorld((x, y, z) => y === 63 ? 'netherrack' : y < 63 && y > 55 ? 'air' : y <= 55 ? 'netherrack' : 'air')
  assert.equal(burrowColumn(thin, new Vec3(0, 64, 0)), false)
  const lava = fakeWorld((x, y, z) => y === 59 && x === 0 && z === 0 ? 'lava' : y < 64 ? 'netherrack' : 'air')
  assert.equal(burrowColumn(lava, new Vec3(0, 64, 0)), false)
  const side = fakeWorld((x, y, z) => x === 1 && y === 62 && z === 0 ? 'air' : y < 64 ? 'netherrack' : 'air')
  assert.equal(burrowColumn(side, new Vec3(0, 64, 0)), false)
})
test('золото у двора: соседняя клетка — чужой воздух, ломка вскроет штрек; в толще — нет', () => {
  const S = { own: new Set(['0,40,1']) }
  const open = fakeWorld((x, y, z) => x === 1 && y === 40 && z === 0 ? 'air' : x === 0 && y === 40 && z === 1 ? 'air' : 'blackstone')
  assert.equal(goldExposes(open, S, new Vec3(0, 40, 0)), true)
  const closed = fakeWorld((x, y, z) => x === 0 && y === 40 && z === 1 ? 'air' : 'blackstone')
  assert.equal(goldExposes(closed, S, new Vec3(0, 40, 0)), false)
})
