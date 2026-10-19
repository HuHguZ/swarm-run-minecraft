'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as PT from '../src/bastion/pen-trap'
import PG = require('../src/bastion/predict-gold')
import SL = require('../src/sealed')
import pick = require('../src/pick')

// Мир-чернокамень с вырезанными клетками. Рот M=(0,100,0), d=+x: яма P=(0,98,0), H=(0,99,0); пол пиглинов y=100,
// x 1..5, z −3..3 (пол под ним y=99 — твёрдый).
const k = (x, y, z) => `${x},${y},${z}`
function world (air) {
  const open = new Set(air)
  return (x, y, z) => open.has(k(x, y, z))
    ? { name: 'air', shapes: [], boundingBox: 'empty' }
    : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block' }
}
function arena () {
  const air = [k(0, 98, 0), k(0, 99, 0), k(0, 100, 0)]
  for (let x = 1; x <= 5; x++) for (let z = -3; z <= 3; z++) for (let y = 100; y <= 102; y++) air.push(k(x, y, z))
  return air
}
const bo = { P: { x: 0, y: 98, z: 0 }, H: { x: 0, y: 99, z: 0 }, M: { x: 0, y: 100, z: 0 }, O: { x: 1, y: 100, z: 0 }, d: [1, 0] }
const clsOf = gb => (x, y, z) => SL.classOf(gb(x, y, z))

test('pen plan: three lanes under the floor at the mouth, the bot cell B behind the mouth', () => {
  const plan = PT.penPlan(bo, clsOf(world(arena())))
  assert.ok(plan.lanes, plan.why)
  assert.deepEqual(plan.Bf, { x: -1, y: 98, z: 0 })
  assert.deepEqual(plan.Bh, { x: -1, y: 99, z: 0 })
  assert.deepEqual(plan.lanes.map(l => [l.k, l.T.z, l.Y.y, l.Z.y]), [[-1, -1, 99, 98], [0, 0, 99, 98], [1, 1, 99, 98]])
  assert.deepEqual(plan.lanes.find(l => l.k === 1).W, { x: 0, y: 99, z: 1 })
  // Без крыши над ртом загон не строится (пиглин стоял бы над открытым местом бота).
  const open = arena().concat(k(0, 101, 0))
  assert.match(PT.penPlan(bo, clsOf(world(open))).why, /над ртом/)
  // Узкий пол (одна клетка у рта): только средняя полоса, траншея закрыта с боков.
  const narrow = [k(0, 98, 0), k(0, 99, 0), k(0, 100, 0), k(1, 100, 0), k(1, 101, 0), k(2, 100, 0), k(2, 101, 0)]
  const p1 = PT.penPlan(bo, clsOf(world(narrow)))
  assert.deepEqual(p1.lanes.map(l => l.k), [0])
  // Сбоку от люка Y0 пусто (под соседней клеткой пола нет блока) — со дна траншеи туда выйти: загона нет (s2b-alt05 k=9).
  assert.match(PT.penPlan(bo, clsOf(world(narrow.concat(k(1, 99, 1))))).why, /открыта вбок/)
})

test('pen after capture: every trench position sees the bot in B and its throw lands at the bot feet', () => {
  const plan = PT.penPlan(bo, clsOf(world(arena())))
  // После поимки: рот и P заложены, B, окна W±p, люки Y и траншеи Z — воздух.
  const air = arena().filter(c => c !== k(0, 100, 0) && c !== k(0, 98, 0))
  air.push(k(-1, 98, 0), k(-1, 99, 0))
  for (const l of plan.lanes) { air.push(k(l.Y.x, l.Y.y, l.Y.z), k(l.Z.x, l.Z.y, l.Z.z)); if (l.k) air.push(k(l.W.x, l.W.y, l.W.z)) }
  const gb = world(air)
  const feet = new Vec3(-0.5, 98, 0.5)
  const eye = feet.offset(0, 1.62, 0)
  let lands = 0; let sees = 0; let n = 0
  for (const l of plan.lanes) {
    for (const ox of [0.3, 0.5, 0.7]) {
      for (const oz of [0.3, 0.5, 0.7]) {
        const from = new Vec3(l.Z.x + ox, l.Z.y, l.Z.z + oz)
        n++
        if (PG.rayClear(gb, from.offset(0, PG.PIGLIN_EYE, 0), eye)) sees++
        if (PG.throwLands({ blockAt: () => null }, from, feet, gb).ok) lands++
      }
    }
  }
  assert.equal(n, 27)
  assert.equal(sees, 27, 'NEAREST_VISIBLE_PLAYER: каждый в траншее видит глаза бота')
  assert.equal(lands, 27, 'бросок к ногам+1 долетает в рамку подбора')
  // Выбраться нельзя: над траншеей пол y=100 на 2 выше её дна, рот заложен.
  for (const l of plan.lanes) assert.equal(gb(l.Z.x, l.Z.y - 1, l.Z.z).boundingBox, 'block')
})

test('pen refill: an ingot tossed from B lands on the trench floor, out of the bot pickup box', () => {
  const plan = PT.penPlan(bo, clsOf(world(arena())))
  const air = arena().filter(c => c !== k(0, 100, 0) && c !== k(0, 98, 0))
  air.push(k(-1, 98, 0), k(-1, 99, 0))
  for (const l of plan.lanes) { air.push(k(l.Y.x, l.Y.y, l.Y.z), k(l.Z.x, l.Z.y, l.Z.z)); if (l.k) air.push(k(l.W.x, l.W.y, l.W.z)) }
  const gb = world(air)
  const bot = { entity: { position: new Vec3(-0.5, 98, 0.5) }, blockAt: () => null }
  const ta = PT.trenchAim(bot, plan, [0, 1, -1], gb)
  assert.ok(ta, 'прицел в траншею есть')
  const q = PG.tossLands(bot, ta.aim, gb)
  const Z = plan.lanes.find(l => l.k === ta.k).Z
  assert.deepEqual([Math.floor(q.x), Math.floor(q.y), Math.floor(q.z)], [Z.x, Z.y, Z.z])
  assert.ok(Math.abs(q.x - -0.5) > 1.3, 'вне рамки подбора бота по d')
  // Полоса не вскрыта (под ней пол) — прицела нет.
  assert.equal(PT.trenchAim(bot, plan, [], gb), null)
})

test('pen membership: strip over the lanes, pen below the floor', () => {
  const plan = PT.penPlan(bo, clsOf(world(arena())))
  const pig = (x, y, z) => ({ position: new Vec3(x, y, z), width: 0.6 })
  assert.equal(PT.inStrip(plan, pig(1.5, 100, 0.5)), true)
  assert.equal(PT.inStrip(plan, pig(1.5, 100, -0.5)), true)
  assert.equal(PT.inStrip(plan, pig(2.2, 100, 0.5)), false, 'рамка заходит за полосу')
  assert.equal(PT.inStrip(plan, pig(1.5, 101, 0.5)), false, 'не на полу')
  assert.deepEqual(PT.lanesUnder(plan, pig(1.5, 100, 1.0)).map(l => l.k), [0, 1])
  assert.equal(PT.inPen(plan, pig(1.5, 98, 0.5)), true)
  assert.equal(PT.inPen(plan, pig(1.5, 100, 0.5)), false)
})

test('pen strip: a piglin pressed against the mouth wall is over the strip', () => {
  const plan = PT.penPlan(bo, clsOf(world(arena())))
  assert.equal(PT.inStrip(plan, { position: new Vec3(1.3, 100, 0.5), width: 0.6 }), true)
  assert.equal(PT.inStrip(plan, { position: new Vec3(1.71, 100, 0.5), width: 0.6 }), false, 'край рамки над клеткой за полосой')
})

test('pen check: lanes and adults near the hatch decide whether the pen is worth it', () => {
  const ent = (id, x, z, baby = false) => ({ id, name: 'piglin', position: new Vec3(x, 100, z), metadata: [0, baby], isValid: true })
  const gb = world(arena())
  const bot = { entity: { position: new Vec3(0.5, 98, 0.5) }, blockAt: v => gb(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    registry: { entitiesByName: { piglin: { metadataKeys: ['mob_flags', 'baby'] } } }, entities: {} }
  bot.entities = { 1: ent(1, 2.5, 0.5), 2: ent(2, 3.5, 1.5), 3: ent(3, 4.5, -1.5), 4: ent(4, 2.5, 2.5, true) }
  const c = PT.penCheck(bot, bo)
  assert.deepEqual([c.ok, c.lanes, c.near, c.worth], [true, 3, 3, true], 'малыш не в счёт')
  delete bot.entities[3]
  assert.equal(PT.penCheck(bot, bo).worth, false)
})

test('digSeen: the pen is dug only through a face the crosshair sees, looking at a visible point of it', async () => {
  // Замечание проверки раунда 1: прежний digSeen довольствовался любой видимой точкой, а копал гранью 'auto'
  // (mineflayer смотрит в центр блока и шлёт «верх»). Теперь грань выбирает прицел, и копка идёт через неё.
  const air = new Set(arena())
  const gb = (x, y, z) => air.has(k(x, y, z)) ? { name: 'air', shapes: [], boundingBox: 'empty' } : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block' }
  const bot = { entity: { position: new Vec3(0.5, 98, 0.5) }, entities: {}, blockAt: v => gb(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) }
  const plan = PT.penPlan(bo, clsOf(gb))
  const dug = []
  const saved = SL.digCell
  SL.digCell = async (_b, v, o: any = {}) => {
    assert.ok(o.face && o.aim, `грань и точка прицела для ${v}`)
    // Сосед по этой грани — воздух; точка прицела лежит на грани, и луч из глаз до неё чист (честный прицел).
    assert.equal(gb(v.x + o.face.x, v.y + o.face.y, v.z + o.face.z).boundingBox, 'empty')
    const ax = o.face.x ? 'x' : o.face.y ? 'y' : 'z'
    assert.equal(o.aim[ax], v[ax] + (o.face[ax] > 0 ? 1 : 0))
    const eye = bot.entity.position.offset(0, 1.62, 0); const dir = o.aim.minus(eye); const len = dir.norm()
    const hit = pick.blockOnRay(bot, eye, dir.scaled(1 / len), len + 0.01)
    assert.ok(hit && hit.pos.equals(v), `первый блок на луче — сам ${v}`)
    dug.push([k(v.x, v.y, v.z), [o.face.x, o.face.y, o.face.z].join(','), o.aim]); air.add(k(v.x, v.y, v.z)); return 'ok'
  }
  try {
    // Под полом пиглинов дальше рта: открыт только верх, а он выше глаз — прицелом не взять.
    assert.equal(await PT.digSeen(bot, { x: 2, y: 99, z: 0 }), 'unseen')
    assert.equal(dug.length, 0)
    // Стройка из ямы (бот в P), как в penTrade: B, траншея Z0, окна W±p, траншеи Z±p.
    for (const q of [plan.Bh, plan.Bf, plan.lanes.find(l => l.k === 0).Z, ...plan.lanes.filter(l => l.k).map(l => l.W), ...plan.lanes.filter(l => l.k).map(l => l.Z)]) {
      assert.equal(await PT.digSeen(bot, q), 'ok', `стройка ${q.x},${q.y},${q.z}`)
    }
    assert.deepEqual(dug[0].slice(0, 2), [k(-1, 99, 0), '1,0,0'], 'голова B — через грань к H')
    // Боковая траншея Z−1 видна из ямы только низом грани к Z0: центр закрыт полом Y0 (прежняя копка 'auto' шла сквозь него).
    const zSide = dug.find(d => d[0] === k(1, 98, -1))
    assert.equal(zSide[1], '0,0,1'); assert.ok(zSide[2].y < 98.5, `прицел ниже центра: ${zSide[2]}`)
    // Поимка: рот и P заложены, бот в B; люки всех полос — из-за окна.
    air.delete(k(0, 100, 0)); air.delete(k(0, 98, 0))
    bot.entity.position = new Vec3(-0.5, 98, 0.5)
    for (const l of plan.lanes) assert.equal(await PT.digSeen(bot, l.Y), 'ok', `люк ${l.k}`)
    assert.deepEqual(dug.slice(-3).map(d => d[1]), ['-1,0,0', '-1,0,0', '-1,0,0'], 'люки — через ближнюю к окну грань')
  } finally { SL.digCell = saved }
})

test('sealed.digCell face+aim: the one look inside bot.dig goes to the aim point, the packet face is the given face', async () => {
  const v = new Vec3(1, 98, -1)
  let solid = true
  const looked = []
  const bot: any = {
    version: 'test', entity: { position: new Vec3(0.5, 98, 0.5), onGround: true }, inventory: { items: () => [] }, heldItem: null,
    blockAt: () => solid ? { name: 'blackstone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], hardness: 1.5, position: v } : { name: 'air', boundingBox: 'empty', shapes: [] },
    digTime: () => 100, equip: async () => {},
    lookAt: async p => { looked.push(p) },
    // Как mineflayer digging.js: face — вектор → lookAt(центр грани) → block_dig с этой гранью.
    dig: async (b, _force, face) => { await bot.lookAt(b.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true); bot.sentFace = face; solid = false }
  }
  const raw = bot.lookAt
  const aim = new Vec3(1.2, 98.2, 0)
  assert.equal(await SL.digCell(bot, v, { face: new Vec3(0, 0, 1), aim }), 'ok')
  assert.deepEqual(looked, [aim], 'взгляд — в видимую точку, не в центр грани')
  assert.deepEqual([bot.sentFace.x, bot.sentFace.y, bot.sentFace.z], [0, 0, 1])
  assert.equal(bot.lookAt, raw, 'lookAt возвращён')
})

test('digSeenAll: a step down is dug head-cell first, the cell under it then through its top; nothing through the floor', async () => {
  const air = new Set([k(0, 100, 0), k(0, 101, 0)])
  const gb = (x, y, z) => air.has(k(x, y, z)) ? { name: 'air', shapes: [], boundingBox: 'empty' } : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block' }
  const bot = { entity: { position: new Vec3(0.5, 100, 0.5) }, entities: {}, blockAt: v => gb(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) }
  const order = []
  const dig = async (_b, c) => { const sf = PT.seenFace(bot, c); if (!sf) return 'unseen'; order.push([k(c.x, c.y, c.z), [sf.face.x, sf.face.y, sf.face.z].join(',')]); air.add(k(c.x, c.y, c.z)); return 'ok' }
  // Ступень вниз (+x): ноги (1,99,0), голова (1,100,0). Снизу-первой нижняя закрыта: пол (0,99,0) и (1,100,0).
  assert.equal(PT.seenFace(bot, new Vec3(1, 99, 0)), null)
  assert.equal(await PT.digSeenAll(bot, [new Vec3(1, 99, 0), new Vec3(1, 100, 0)], dig), 'ok')
  assert.deepEqual(order, [[k(1, 100, 0), '-1,0,0'], [k(1, 99, 0), '0,1,0']])
  // Ступень вверх: клетка над головой, ноги и голова следующей — все видны по очереди.
  order.length = 0
  assert.equal(await PT.digSeenAll(bot, [new Vec3(-1, 101, 0), new Vec3(-1, 102, 0), new Vec3(0, 102, 0)], dig), 'ok')
  assert.equal(order.length, 3)
  // Клетка за стеной (между ней и глазами — блок): не копается.
  assert.match(await PT.digSeenAll(bot, [new Vec3(0, 101, 2)], dig), /0,101,2 unseen/)
})
