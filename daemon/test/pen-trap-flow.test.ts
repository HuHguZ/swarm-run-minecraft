'use strict'
// Весь ход penTrade на макете мира (без Minecraft): стройка → вручение → поимка люком → торг с загоном → пополнение.
// Физика пиглинов — правила javap: вручённый стоит и держит золото 119 тиков; сломан пол под ним — падает на 2.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const clock = require('../src/game-clock')

const k = (x, y, z) => `${x},${y},${z}`

for (const capture of ['freeze', 'lure', 'gather', 'gather-none', 'gather-patience', 'gather-stuck']) test(`pen trade flow (${capture}): capture, trade with the pen, refill by a trench lure`, async () => {
  const c = new clock.GameClock({})
  clock.activate(c)
  c.setState({ tick_rate: 2000 })
  c.start()
  const SL = require('../src/sealed'); const PG = require('../src/bastion/predict-gold'); const pick = require('../src/pick'); const BT = require('../src/bastion/booth-trade')
  const PT = require('../src/bastion/pen-trap')
  const saved = { dig: SL.digCell, fill: SL.fillCell, face: pick.faceAim, hand: PG.handNoWalk, unhold: PG.unholdGold, toss: PG.tossOut, step: BT.stepCell, booth: BT.boothTrade }
  const air = new Set([k(0, 98, 0), k(0, 99, 0), k(0, 100, 0)])
  for (let x = 1; x <= 5; x++) for (let z = -3; z <= 3; z++) for (let y = 100; y <= 102; y++) air.add(k(x, y, z))
  const block = v => air.has(k(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)))
    ? { name: 'air', boundingBox: 'empty', shapes: [] }
    : { name: 'polished_blackstone_bricks', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], hardness: 1.5 }
  const inv = { gold_ingot: 40, cobblestone: 64 }
  const bot: any = new EventEmitter()
  Object.assign(bot, {
    health: 20, entity: { position: new Vec3(0.5, 98, 0.5) }, _client: new EventEmitter(), blockAt: block, setControlState: () => {}, look: async () => {},
    registry: { entitiesByName: { item: { id: 999 }, piglin: { metadataKeys: ['mob_flags', 'baby'] } } },
    inventory: { items: () => Object.entries(inv).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })) }
  })
  const admireUntil = new Map()
  const piglin = (id, x, y, z) => ({ id, name: 'piglin', width: 0.6, height: 1.95, isValid: true, position: new Vec3(x, y, z), metadata: [0, false],
    get equipment () { return [null, clock.now() < (admireUntil.get(id) || 0) ? { name: 'gold_ingot' } : null] } })
  const inside = piglin(1, 1.3, 100, 0.5) // прижат к стене рта, над средней полосой
  const outside = piglin(2, 3.5, 100, 2.5) // в 9 бл. от траншеи, не над полосой
  bot.entities = { 1: inside, 2: outside }
  const log: any = { dug: [], filled: [], handed: 0, lures: 0 }
  SL.digCell = async (_b, v) => {
    air.add(k(v.x, v.y, v.z)); log.dug.push(k(v.x, v.y, v.z))
    for (const e of Object.values<any>(bot.entities)) if (Math.floor(e.position.x) === v.x && Math.floor(e.position.z) === v.z && Math.abs(e.position.y - (v.y + 1)) < 0.01) e.position = new Vec3(e.position.x, v.y - 1, e.position.z)
    return 'ok'
  }
  SL.fillCell = async (_b, v) => { air.delete(k(v.x, v.y, v.z)); log.filled.push(k(v.x, v.y, v.z)); return true }
  pick.faceAim = (_b, v, f) => v.offset(0.5 + f.x * 0.5, 0.5 + f.y * 0.5, 0.5 + f.z * 0.5) // центр грани виден
  PG.handNoWalk = async (_b, pg) => {
    if (clock.now() < (admireUntil.get(pg.id) || 0) || inv.gold_ingot < 1) return false
    inv.gold_ingot--; log.handed++; admireUntil.set(pg.id, clock.now() + 119 * 50); return true
  }
  PG.unholdGold = async () => false
  PG.tossOut = async () => {
    // Слиток в траншею: снаружи взрослый идёт за ним, падает в загон и поднимает (стоит 119 тиков).
    inv.gold_ingot--; log.lures++
    outside.position = new Vec3(1.5, 98, 1.5); admireUntil.set(2, clock.now() + 119 * 50); return true
  }
  BT.stepCell = async (_b, v) => { if (capture === 'gather-stuck') return false; bot.entity.position = new Vec3(v.x + 0.5, v.y, v.z + 0.5); return true }
  // Фаза ямы в gather — настоящий boothTrade (здесь макет): торгует, пока done() не скажет «у люка собрались».
  log.booth = 0
  BT.boothTrade = async (_s, _c, _st, _bo, until, o) => {
    log.booth++
    if (capture === 'gather-patience') return { handed: 0, tossed: 0, stopped: 'пиглины не подходят 30 с' }
    while (!o.done() && clock.now() < until - 3000) await new Promise(res => clock.setTimeout(res, 300))
    return { handed: 0, tossed: 0, stopped: o.done() ? 'цель' : 'время' }
  }
  try {
    const bo = PT.pitHere(bot)
    assert.ok(bo, 'бот в яме со ртом')
    if (capture === 'lure') delete bot.entities[1]
    if (capture === 'gather-none') { delete bot.entities[1]; delete bot.entities[2] }
    const r = await PT.penTrade({ bot }, { aborted: false }, bo, { seconds: 70, catchSeconds: 30, capture: /^gather/.test(capture) ? 'gather' : capture })
    if (capture === 'gather-stuck') {
      // В B не шагнуть (рот уже заложен) — яма возвращается: рот снова открыт, бот в P.
      assert.deepEqual([r.ok, r.stopped, r.reopened], [false, 'в B не шагнул', 'ok'])
      assert.ok(log.filled.includes(k(0, 100, 0)) && log.dug.includes(k(0, 100, 0)), 'рот заложен и открыт снова')
      assert.ok(!log.filled.includes(k(0, 98, 0)), 'P не закладывали')
      return
    }
    if (capture === 'gather-patience') {
      // Яма сдалась сразу, а у люка двое — своя петля с терпением ловит их загоном.
      assert.deepEqual([r.ok, r.penned, r.patience && r.patience.after], [true, true, 'пиглины не подходят 30 с'])
      assert.equal(r.nearAtCapture, 2)
      assert.ok(r.handed3 >= 4, `торг с загоном: ${r.handed3}`)
      return
    }
    if (capture === 'gather-none') {
      // Никто не подошёл к люку — вызов был торгом ямы: рот открыт, бот в яме, загона нет.
      assert.equal(log.booth, 1)
      assert.deepEqual([r.ok, r.penned, r.stopped], [true, false, 'время'])
      assert.ok(!log.filled.length, 'рот не закладывали')
      return
    }
    if (capture === 'lure') {
      assert.equal(r.ok, true, r.stopped)
      assert.deepEqual(r.opened.sort(), [-1, 0, 1], 'люки всех полос открыты сразу')
      assert.equal(r.captured, 0)
      assert.equal(r.penMax, 1, 'торговец упал за слитком')
      assert.ok(r.handed3 >= 4, `торг с загоном: ${r.handed3}`)
      return
    }
    if (capture === 'gather') {
      // Возврат к загону: бот в B, загон стоит — penHere узнаёт его, торг сразу (без стройки и поимки).
      const ready = PT.penHere(bot)
      assert.ok(ready && ready.ready, 'готовый загон узнан')
      assert.deepEqual(ready.lanes.map(l => l.k), [-1, 0, 1])
      inv.gold_ingot = 20
      const r2 = await PT.penTrade({ bot }, { aborted: false }, ready, { plan: ready, seconds: 30 })
      assert.equal(r2.resumed, true)
      assert.equal(r2.captured, 2, 'оба торговца на месте')
      assert.ok(r2.handed3 >= 4 && !r2.phases.build, `торг сразу: ${r2.handed3}`)
      assert.equal(r.ok, true, r.stopped)
      assert.equal(r.nearAtCapture, 2, 'двое у люка — пора')
      assert.equal(log.booth, 1, 'до поимки — яма boothTrade'); assert.equal(r.penned, true)
      assert.deepEqual(r.opened.sort(), [-1, 0, 1])
      assert.equal(r.captured, 1, 'стоявший над полосой упал при открытии')
      assert.equal(r.penMax, 2, 'второй — за слитком в траншее')
      assert.ok(r.handed3 >= 4, `торг с загоном: ${r.handed3}`)
      return
    }
    assert.equal(r.ok, true, r.stopped)
    assert.equal(r.captured, 1)
    assert.deepEqual(r.opened, [0], 'люк — только под пойманным (средняя полоса)')
    assert.ok(log.filled.includes(k(0, 100, 0)) && log.filled.includes(k(0, 98, 0)), 'рот и старая клетка ног заложены')
    assert.ok(log.dug.includes(k(1, 99, 0)), 'пол под пиглином сломан')
    assert.deepEqual([bot.entity.position.x, bot.entity.position.y], [-0.5, 98], 'бот в B за окном')
    assert.equal(inside.position.y, 98, 'пиглин в траншее')
    assert.ok(r.lures >= 1 && r.penMax === 2, `пополнение: lures ${r.lures}, penMax ${r.penMax}`)
    assert.ok(r.handed3 >= 4, `торг с загоном: ${r.handed3}`)
    assert.equal(r.spent, log.handed + log.lures)
  } finally {
    Object.assign(SL, { digCell: saved.dig, fillCell: saved.fill }); pick.faceAim = saved.face
    Object.assign(PG, { handNoWalk: saved.hand, unholdGold: saved.unhold, tossOut: saved.toss }); BT.stepCell = saved.step; BT.boothTrade = saved.booth
    c.dispose()
  }
})

test('pen away: from B a closed tunnel back and sideways, a pause, the same way back into B; foreign air stops a leg', async () => {
  const c = new clock.GameClock({})
  clock.activate(c)
  c.setState({ tick_rate: 2000 })
  c.start()
  const SL = require('../src/sealed'); const BT = require('../src/bastion/booth-trade'); const PT = require('../src/bastion/pen-trap')
  const saved = { dig: SL.digCell, step: BT.stepCell }
  // Готовый загон (как после поимки): рот (0,100,0) и P (0,98,0) заложены; B, окно H, люки и траншеи — воздух.
  const air = new Set([k(-1, 98, 0), k(-1, 99, 0), k(0, 99, 0), k(-3, 99, 1)]) // (-3,99,1) — чужой карман
  for (let x = 1; x <= 5; x++) for (let z = -3; z <= 3; z++) for (let y = 100; y <= 102; y++) air.add(k(x, y, z))
  for (const z of [-1, 0, 1]) { air.add(k(1, 99, z)); air.add(k(1, 98, z)) }
  air.add(k(0, 99, 1)); air.add(k(0, 99, -1))
  const block = v => air.has(k(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)))
    ? { name: 'air', boundingBox: 'empty', shapes: [] }
    : { name: 'polished_blackstone_bricks', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], hardness: 1.5 }
  const bot: any = new EventEmitter()
  Object.assign(bot, { health: 20, entity: { position: new Vec3(-0.5, 98, 0.5) }, entities: {}, blockAt: block, setControlState: () => {}, look: async () => {},
    registry: { entitiesByName: { piglin: { metadataKeys: ['mob_flags', 'baby'] } } } })
  const dug = []
  SL.digCell = async (_b, v, o: any = {}) => { assert.ok(o.face && o.aim); air.add(k(v.x, v.y, v.z)); dug.push(k(v.x, v.y, v.z)); return 'ok' }
  const steps = []
  BT.stepCell = async (_b, v) => { bot.entity.position = new Vec3(v.x + 0.5, v.y, v.z + 0.5); steps.push(k(v.x, v.y, v.z)); return true }
  try {
    assert.ok(PT.penHere(bot), 'бот в B готового загона')
    const r = await PT.penAway({ bot }, { aborted: false }, { back: 2, side: 3, seconds: 5 })
    assert.equal(r.ok, true, r.stopped)
    assert.equal(r.from, 'pen')
    // Назад: (-2) копается, (-3) — у чужого кармана (-3,99,1): стоп. Вбок +z от (-2): у кармана тоже (голова (-2,99,1)
    // соседствует с (-3,99,1)) — тогда −z.
    assert.equal(r.back, 1); assert.deepEqual(r.walls, [k(-3, 98, 0), k(-2, 98, 1)])
    assert.equal(r.side, -3)
    assert.ok(!air.has(k(-3, 98, 0)) && !dug.includes(k(-2, 99, 1)), 'к чужому воздуху не вскрыто')
    assert.deepEqual([bot.entity.position.x, bot.entity.position.y, bot.entity.position.z], [-0.5, 98, 0.5], 'вернулся в B')
    assert.ok(r.awaySecs >= 5)
    assert.ok(PT.penHere(bot), 'загон узнаётся после возврата')
  } finally {
    Object.assign(SL, { digCell: saved.dig }); BT.stepCell = saved.step
    c.dispose()
  }
})

test('pen trade(): no pen geometry at this pit — the same call trades as the pit (boothTrade), own cells of a build go to st.sealedState.own', async () => {
  const BT = require('../src/bastion/booth-trade'); const PT = require('../src/bastion/pen-trap')
  const saved = BT.boothTrade
  // Яма у края: над ртом не твёрдое — penPlan отказывает.
  const air = new Set([k(0, 98, 0), k(0, 99, 0), k(0, 100, 0), k(0, 101, 0), k(1, 100, 0), k(1, 101, 0)])
  const block = v => air.has(k(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z))) ? { name: 'air', boundingBox: 'empty', shapes: [] } : { name: 'blackstone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
  const bot: any = new EventEmitter()
  Object.assign(bot, { health: 20, entity: { position: new Vec3(0.5, 98, 0.5) }, entities: {}, blockAt: block, inventory: { items: () => [{ name: 'gold_ingot', count: 10 }] } })
  let called = 0
  BT.boothTrade = async () => { called++; return { handed: 3, tossed: 1, spent: 4, stopped: 'слитки кончились' } }
  try {
    const bo = { kind: 'pit', P: { x: 0, y: 98, z: 0 }, H: { x: 0, y: 99, z: 0 }, M: { x: 0, y: 100, z: 0 }, O: { x: 1, y: 100, z: 0 }, d: [1, 0] }
    const st = { sealedState: { own: new Set() } }
    const r = await PT.trade({ bot }, { aborted: false }, st, bo, clock.now() + 60000, { keep: 0 })
    assert.equal(called, 1)
    assert.deepEqual([r.mode, r.penned, r.spent, r.handed], ['pit', false, 4, 3])
    assert.match(r.pen, /загон не строится: над ртом/)
  } finally { BT.boothTrade = saved }
})
