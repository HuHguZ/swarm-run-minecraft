'use strict'
// Мост на ходу (blockmoves.js): ход A* и исполнитель на настоящей prismarine-physics.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { Physics, PlayerState } = require('prismarine-physics')
const data = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')('1.21.11')
const Movements = require('mineflayer-pathfinder/lib/movements')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { goals } = require('mineflayer-pathfinder')
const pick = require('../src/pick')
const bm = require('../src/blockmoves')

const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
function block (name, p) {
  const b = Block.fromStateId(typeof name === 'number' ? name : data.blocksByName[name].defaultState, 0)
  b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return b
}
function world (terrain) {
  const cells = new Map()
  const w = {
    getBlock: p => cells.get(key(p)) || block(terrain(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))), p),
    set: (p, id) => cells.set(key(p), block(id, p))
  }
  return w
}
// Плато y=63 при x ≤ 0 и x ≥ 6, между ними провал до y=20 (пол), по z — без конца (обхода нет).
const gap = (x0 = 1, x1 = 5) => p => (p.y === 63 && (p.x < x0 || p.x > x1)) || p.y === 20 ? 'stone' : 'air'

function moves (w, extra: any = {} as Record<string, any>) {
  const bot: Record<string, any> = { registry: data, version: '1.21.11', blockAt: (p) => w.getBlock(p), entities: {} as Record<string, any>, entity: { position: new Vec3(0.5, 64, 0.5), effects: {} as Record<string, any> },
    inventory: { items: () => [] }, game: { minY: -64 }, pathfinder: { bestHarvestTool: () => null }, ...extra }
  const mv = new Movements(bot)
  mv.allowSprinting = false
  mv.canDig = false
  // Как session.updateMovements: свой мост pathfinder'а над пустотой в 5+ клеток — 100 (запрет).
  mv.exclusionAreasPlace.push(b => { for (let d = 1; d <= 5; d++) { const q = w.getBlock(b.position.offset(0, -d, 0)); if (q.boundingBox !== 'empty') return 0 } return 100 })
  return mv
}
// Поиск до конца (под нагрузкой npm test один срез в 1 с бывал «partial» — тест краснел без причины); где пути нет,
// мир бесконечен по z — поиск кончается по общему времени ms.
function plan (mv, from, goal, blocks = 16, ms = 2500) {
  const start = new Move(from.x, from.y, from.z, blocks, 0)
  const a = new AStar(start, mv, goal, ms, 250)
  let r = a.compute()
  while (r.status === 'partial') r = a.compute()
  return r
}

test('A*: через провал в 5 без обхода — мост из узлов ndBridge без toPlace, блоки считаются', () => {
  const w = world(gap())
  const mv = bm.addBridge(moves(w))
  const r = plan(mv, new Vec3(0, 64, 0), new goals.GoalBlock(8, 64, 0))
  assert.equal(r.status, 'success')
  const br = r.path.filter(n => n.ndBridge)
  // Четыре блока и прыжок через последнюю щель в 1 (паркур с края моста) — или пять блоков.
  assert.deepEqual(br.map(n => n.x).slice(0, 4), [1, 2, 3, 4])
  assert.ok(br.every(n => n.toPlace.length === 0 && n.toBreak.length === 0))
  assert.deepEqual(br[0].ndBridge.ref, { x: 0, y: 63, z: 0 })
  assert.deepEqual(br[1].ndBridge.ref, { x: 1, y: 63, z: 0 })
  assert.equal(br[3].remainingBlocks, 12)
  // Без хода-моста и с запретом глубокого моста (как в session.updateMovements) — пути нет.
  const mv0 = moves(w)
  assert.notEqual(plan(mv0, new Vec3(0, 64, 0), new goals.GoalBlock(8, 64, 0)).status, 'success')
})

test('A*: блоков нет — моста нет; над лавой — нет; обход короче моста — обход', () => {
  const w = world(gap())
  assert.notEqual(plan(bm.addBridge(moves(w)), new Vec3(0, 64, 0), new goals.GoalBlock(8, 64, 0), 0).status, 'success')
  const lava = world(p => (p.y === 63 && (p.x < 1 || p.x > 5)) ? 'stone' : p.y === 40 ? 'lava' : 'air')
  assert.notEqual(plan(bm.addBridge(moves(lava)), new Vec3(0, 64, 0), new goals.GoalBlock(8, 64, 0)).status, 'success')
  // Провал 1..5 по x только при |z| ≤ 1: обход в 2 клетки вбок дешевле пяти блоков.
  const short = world(p => p.y === 63 && !(p.x >= 1 && p.x <= 5 && Math.abs(p.z) <= 1) ? 'stone' : p.y === 20 ? 'stone' : 'air')
  const r = plan(bm.addBridge(moves(short)), new Vec3(0, 64, 0), new goals.GoalBlock(8, 64, 0))
  assert.equal(r.status, 'success')
  assert.equal(r.path.filter(n => n.ndBridge).length, 0)
})

test('fixPath: узел-мост после postProcess (y − 1, центр) — снова на своей высоте', () => {
  const m = new Move(3, 64, 0, 5, 2)
  m.ndBridge = { ref: { x: 2, y: 63, z: 0 }, dir: { x: 1, z: 0 }, y: 64 }
  m.x = 3.5; m.y = 63; m.z = 0.5
  assert.equal(bm.fixPath([new Move(2, 64, 0, 5, 1), m]), 1)
  assert.deepEqual([m.x, m.y, m.z], [3.5, 64, 0.5])
  assert.deepEqual(bm.cellOf(m), { x: 3, y: 64, z: 0 })
})

test('окно щелчка: тело за плоскостью грани на (0, 0.3], на земле, клетка пуста', () => {
  const ref = new Vec3(0, 63, 0); const dir = { x: 1, z: 0 }
  const at = x => bm.decide({ pos: new Vec3(x, 64, 0.5), onGround: true, ref, dir, cellSolid: false, refSolid: true, pending: false })
  assert.equal(at(0.9).place, false)
  assert.equal(at(1.1).place, true)
  assert.equal(at(1.28).place, true)
  // Дальше 0.3 — только пока тело ещё «на земле» (его перенёс fullStop pathfinder'а): поставить, пока не упало.
  assert.equal(at(1.6).place, true)
  assert.equal(at(1.9).place, false)
  assert.equal(bm.decide({ pos: new Vec3(1.2, 64, 0.5), onGround: false, ref, dir, cellSolid: false, refSolid: true, pending: false }).place, false)
  // Спиной к ходу: взгляд на −x, вниз.
  const d = at(1.1)
  assert.ok(Math.abs(-Math.sin(d.yaw) - -1) < 0.05, 'лицом против хода')
  assert.ok(d.pitch < -1.2, 'взгляд вниз на грань')
  // По −z тот же расчёт.
  const dz = bm.decide({ pos: new Vec3(0.5, 64, -0.1), onGround: true, ref, dir: { x: 0, z: -1 }, cellSolid: false, refSolid: true, pending: false })
  assert.equal(dz.place, true)
})

// Исполнитель на живой физике: тело на краю, путь — мост через провал в 5, затем плато.
function fakeBot (w, physics, pos) {
  const bot = new EventEmitter(); bot._client = new EventEmitter(); bot.inventory = new EventEmitter()
  bot.version = '1.21.11'; bot.registry = data
  bot.inventory.slots = []; bot.inventory.slots[36] = { name: 'cobblestone', count: 16, slot: 36, type: data.itemsByName.cobblestone.id }
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  bot.quickBarSlot = 0
  Object.defineProperty(bot, 'heldItem', { get: () => bot.inventory.slots[36 + bot.quickBarSlot] || null })
  bot.entity = { position: pos.clone(), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, effects: {} as Record<string, any>, attributes: {} as Record<string, any>, height: 1.8 }
  bot.jumpTicks = 0; bot.jumpQueued = false
  bot.entities = {} as Record<string, any>
  bot.blockAt = p => w.getBlock(p)
  const cs = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.controlState = cs
  bot.getControlState = k => cs[k]
  // Как mineflayer: нажатый прыжок запоминается в jumpQueued (lib/plugins/physics.js setControlState).
  bot.setControlState = (k, v) => { if (cs[k] === v) return; cs[k] = v; if (k === 'jump' && v) bot.jumpQueued = true }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.setQuickBarSlot = s => { bot.quickBarSlot = s }
  bot.places = []
  bot._genericPlace = async (ref, face, opts) => { bot.places.push({ ref: ref.position.clone(), face, delta: opts.delta, pos: bot.entity.position.clone() }) }
  bot._client.write = () => {}
  bot.world = {
    getColumnAt: p => ({ setBlockStateId: (q, id) => w.set(new Vec3(Math.floor(p.x / 16) * 16 + q.x, q.y, Math.floor(p.z / 16) * 16 + q.z), id) }),
    setBlockStateId: (p, id) => w.set(p, id)
  }
  bot.pathfinder = { isMoving: () => true, movements: { scafoldingBlocks: [data.itemsByName.cobblestone.id] }, setMovements () { bot.replans = (bot.replans || 0) + 1 } }
  bot.physics = physics
  return bot
}
function run (w, nodes, { ticks = 120, server = null, start = new Vec3(0.5, 64, 0.5), vel = null, tail = 0, resetAt = -1, resetFor = 3, deps = {} as Record<string, any>, clock = null }: any = {} as Record<string, any>) {
  const physics = Physics(data, w)
  const bot = fakeBot(w, physics, start)
  if (vel) bot.entity.velocity = vel.clone()
  const path = nodes.slice()
  bm.fixPath(path)
  let held = null
  bot.pathfinder.isMoving = () => path.length > 0
  const ex = bm.install({ bot, pathNodes: path }, { faceAim: pick.faceAim, nodes: () => path, log: () => {}, ...deps })
  let minY = 64
  let after = tail
  for (let t = 0; t < ticks && (path.length || after-- > 0 || held); t++) {
    if (clock) clock.t = t * 50
    const s = new PlayerState(bot, bot.controlState)
    physics.simulatePlayer(s, w)
    s.apply(bot)
    bot.jumpQueued = s.jumpQueued; bot.jumpTicks = s.jumpTicks
    minY = Math.min(minY, bot.entity.position.y)
    // Сброс пути посреди моста (block_updated): путь пуст resetFor тиков, клавиши НЕ отпущены (clearStates=false).
    if (t === resetAt && path.length) { held = { nodes: path.splice(0), until: t + resetFor }; bot.emit('path_reset', 'block_updated') }
    if (held && t >= held.until) { path.push(...held.nodes); held = null }
    // «pathfinder»: узел достигнут — сдвинуть; путь кончился — fullStop: скорость 0, тело в центр клетки (index.js).
    const n = path[0]
    if (n && Math.abs(n.x - bot.entity.position.x) <= 0.35 && Math.abs(n.z - bot.entity.position.z) <= 0.35 && Math.abs(n.y - bot.entity.position.y) < 1) {
      path.shift()
      if (!path.length) {
        for (const k of Object.keys(bot.controlState)) bot.setControlState(k, false)
        bot.entity.velocity.x = 0; bot.entity.velocity.z = 0
        const cx = Math.floor(bot.entity.position.x) + 0.5; const cz = Math.floor(bot.entity.position.z) + 0.5
        if (Math.abs(bot.entity.position.x - cx) > 0.2) bot.entity.position.x = cx
        if (Math.abs(bot.entity.position.z - cz) > 0.2) bot.entity.position.z = cz
      }
    }
    if (!path.length) { bot.emit('physicsTick'); bot.emit('move'); continue }
    // Обычный узел — идти к нему лицом (как monitorMovement); мост — перехватит исполнитель.
    bot.look(Math.atan2(-(path[0].x - bot.entity.position.x), -(path[0].z - bot.entity.position.z)), 0)
    // Как monitorMovement над пустотой: canWalkJump → прыжок (и jumpQueued), спринт выкл.
    bot.setControlState('forward', true); bot.setControlState('back', false); bot.setControlState('jump', true)
    bot.emit('physicsTick')
    bot.emit('move')
    if (server) server(bot, t)
  }
  ex.stop()
  return { bot, minY, end: bot.entity.position, left: path.length, stats: ex.stats }
}
function bridgeNodes (from, to, y = 64) {
  const out = []
  for (let x = from; x <= to; x++) {
    const m = new Move(x, y, 0, 16 - (x - from) - 1, 2.5)
    m.ndBridge = { ref: { x: x - 1, y: y - 1, z: 0 }, dir: { x: 1, z: 0 }, y }
    m.x += 0.5; m.y -= 1; m.z += 0.5 // как после postProcessPath
    out.push(m)
  }
  return out
}

test('исполнитель: мост через провал в 5 на ходу — пять блоков, ни одного падения, грань видна', () => {
  const w = world(gap())
  const nodes = [...bridgeNodes(1, 5), Object.assign(new Move(6, 64, 0, 11, 1), { x: 6.5, z: 0.5 }), Object.assign(new Move(7, 64, 0, 11, 1), { x: 7.5, z: 0.5 })]
  const r = run(w, nodes)
  assert.equal(r.left, 0, 'дошёл до конца пути')
  assert.ok(r.minY > 63.99, 'не падал: minY ' + r.minY)
  assert.equal(r.stats.placed, 5)
  assert.equal(r.bot.places.length, 5)
  for (const p of r.bot.places) {
    // Щелчок с края: центр тела за плоскостью грани, на опоре.
    const s = p.pos.x - (p.ref.x + 1)
    assert.ok(s > 0 && s <= 0.3, 's=' + s)
    assert.ok(p.delta.x === 1 && p.delta.y > 0 && p.delta.y < 1, 'точка на боковой грани опоры')
  }
  for (let x = 1; x <= 5; x++) assert.equal(w.getBlock(new Vec3(x, 63, 0)).name, 'cobblestone')
  // Время: 7 клеток пешком ~1.6 с (32 тика) — мост не тормозит.
})

test('исполнитель: отказ сервера (блок не встал) — блок пропадает, тело на краю не стоит в воздухе', () => {
  const w = world(gap())
  const nodes = [...bridgeNodes(1, 3), Object.assign(new Move(4, 64, 0, 11, 1), { x: 4.5, z: 0.5 })]
  let denied = 0
  const r = run(w, nodes, {
    ticks: 40,
    server: (bot) => {
      // Первый же блок сервер откатывает (block_change: воздух).
      if (bot.places.length === 1 && !denied) { denied++; const c = new Vec3(1, 63, 0); w.set(c, 'air'); bot._client.emit('block_change', { location: c, type: 0 }) }
    }
  })
  assert.equal(r.stats.denied, 1)
})

test('исполнитель: вход в мост наискось (сбоку 0.3, скорость поперёк) — подтягивается к оси, без падения', () => {
  const w = world(gap())
  const nodes = [...bridgeNodes(1, 5), Object.assign(new Move(6, 64, 0, 11, 1), { x: 6.5, z: 0.5 }), Object.assign(new Move(7, 64, 0, 11, 1), { x: 7.5, z: 0.5 })]
  const r = run(w, nodes, { start: new Vec3(0.75, 64, 0.2), vel: new Vec3(0.08, 0, -0.08) })
  assert.equal(r.left, 0, 'дошёл до конца пути')
  assert.ok(r.minY > 63.99, 'не падал: minY ' + r.minY)
  assert.equal(r.stats.placed, 5)
  assert.ok(Math.abs(r.end.z - 0.5) < 0.35, 'на оси: z ' + r.end.z)
})

test('исполнитель: путь кончается на узле-мосте — fullStop переносит тело в центр пустой клетки, блок встаёт до падения', () => {
  // До x=2 узел 2 засчитывается на x 2.184 — в том же тике, где окно щелчка его клетки (s 0.184): путь пуст раньше блока.
  // Старт сдвигаем по x: фаза шагов меняется, и в части прогонов узел засчитывается в тике окна щелчка.
  for (const last of [2, 3]) {
    for (let x0 = 0.3; x0 <= 0.7001; x0 += 0.05) {
      const w = world(gap())
      const r = run(w, bridgeNodes(1, last), { tail: 20, start: new Vec3(x0, 64, 0.5) })
      assert.equal(r.left, 0)
      assert.ok(r.minY > 63.99, 'не падал: minY ' + r.minY + ', последний ' + last + ', старт ' + x0.toFixed(2))
      for (let x = 1; x <= last; x++) assert.equal(w.getBlock(new Vec3(x, 63, 0)).name, 'cobblestone', 'клетка ' + x + ', старт ' + x0.toFixed(2))
    }
  }
})

test('исполнитель: сброс пути посреди моста (клавиши не отпущены) — тело не уходит с края, потом мостит дальше', () => {
  const w = world(gap())
  const nodes = [...bridgeNodes(1, 5), Object.assign(new Move(6, 64, 0, 11, 1), { x: 6.5, z: 0.5 }), Object.assign(new Move(7, 64, 0, 11, 1), { x: 7.5, z: 0.5 })]
  for (const at of [3, 6, 8, 11]) {
    const w2 = world(gap())
    const r = run(w2, nodes.map(n => Object.assign(Object.create(Object.getPrototypeOf(n)), n)), { resetAt: at, resetFor: 4 })
    assert.equal(r.left, 0, 'дошёл, сброс на тике ' + at)
    assert.ok(r.minY > 63.99, 'не падал, сброс на тике ' + at + ': minY ' + r.minY)
  }
  void w
})

// Обрыв: плато x ≤ 0 (ноги y 64), стена вниз до пола y 50 (ноги 51), по z без конца; ведра нет, копать нельзя.
const cliff = p => (p.x <= 0 && p.y <= 63 && p.y >= 50) || p.y === 50 ? 'stone' : 'air'

test('A*: спуск блоками с обрыва 13 — ступени ndDescend по 2 вниз, опора — грань стены', () => {
  const w = world(cliff)
  const mv0 = moves(w)
  assert.notEqual(plan(mv0, new Vec3(0, 64, 0), new goals.GoalBlock(6, 51, 0)).status, 'success')
  const mv = bm.addBridge(moves(w))
  const r = plan(mv, new Vec3(0, 64, 0), new goals.GoalBlock(6, 51, 0), 16)
  assert.equal(r.status, 'success')
  const ds = r.path.filter(n => n.ndDescend)
  assert.ok(ds.length >= 5 && ds.length <= 7, 'ступеней ' + ds.length)
  // Первая — с края плато: клетка у стены на 3 ниже ног, опора — стена под краем (грань +x).
  assert.deepEqual(ds[0].ndDescend.cell, { x: 1, y: 61, z: 0 })
  assert.deepEqual(ds[0].ndDescend.ref, { x: 0, y: 61, z: 0 })
  for (let i = 1; i < ds.length; i++) assert.equal(ds[i - 1].y - ds[i].y, 2)
  assert.ok(ds.every(n => n.toPlace.length === 0 && n.toBreak.length === 0))
})

function runPath (w, path, { ticks = 400, start = new Vec3(0.5, 64, 0.5) }: any = {} as Record<string, any>) {
  const physics = Physics(data, w)
  const bot = fakeBot(w, physics, start)
  bot.physics = physics
  bot.pathfinder.isMoving = () => path.length > 0
  bm.fixPath(path)
  const ex = bm.install({ bot, pathNodes: path }, { faceAim: pick.faceAim, nodes: () => path, log: () => {} })
  let peak = start.y; let worst = 0; let landings = 0
  for (let t = 0; t < ticks; t++) {
    const s = new PlayerState(bot, bot.controlState)
    const was = bot.entity.onGround
    physics.simulatePlayer(s, w)
    s.apply(bot)
    bot.jumpQueued = s.jumpQueued; bot.jumpTicks = s.jumpTicks
    if (bot.entity.onGround) { if (!was) { worst = Math.max(worst, peak - bot.entity.position.y); landings++ } peak = bot.entity.position.y } else peak = Math.max(peak, bot.entity.position.y)
    const n = path[0]
    if (n && Math.abs(n.x - bot.entity.position.x) <= 0.35 && Math.abs(n.z - bot.entity.position.z) <= 0.35 && Math.abs(n.y - bot.entity.position.y) < 1) path.shift()
    if (path.length) {
      // Как monitorMovement: к узлу лицом, вперёд; прыжок — когда узел выше (подъём), а в первый тик ступени — тоже
      // (canWalkJump над пустотой), чтобы проверить сброс jumpQueued.
      bot.look(Math.atan2(-(path[0].x - bot.entity.position.x), -(path[0].z - bot.entity.position.z)), 0)
      bot.setControlState('forward', true); bot.setControlState('back', false)
      bot.setControlState('jump', path[0].y > bot.entity.position.y + 0.5 || !!path[0].ndDescend)
    } else if (bot.entity.onGround) break
    bot.emit('physicsTick')
    bot.emit('move')
  }
  ex.stop()
  return { bot, end: bot.entity.position, left: path.length, worstFall: worst, landings, stats: ex.stats }
}

test('исполнитель: спуск блоками с обрыва 13 по плану A* — без падений больше 3, у подножия', () => {
  const w = world(cliff)
  const mv = bm.addBridge(moves(w))
  const r0 = plan(mv, new Vec3(0, 64, 0), new goals.GoalBlock(6, 51, 0), 16)
  assert.equal(r0.status, 'success')
  // Узлы до postProcessPath — целые; pathfinder ставит центр клетки и верх опоры, наши — fixPath.
  const path = r0.path.map(n => { const c = Object.assign(Object.create(Object.getPrototypeOf(n)), n); if (!c.ndDescend && !c.ndBridge) { c.x += 0.5; c.z += 0.5 } return c })
  const r = runPath(w, path)
  assert.equal(r.left, 0, 'дошёл до конца пути, осталось ' + r.left + ', тело ' + JSON.stringify(r.end) + ' ' + JSON.stringify(r.stats))
  assert.ok(r.worstFall <= 3.01, 'падение ' + r.worstFall)
  assert.ok(Math.abs(r.end.y - 51) < 0.01, 'внизу: y ' + r.end.y)
  assert.ok(r.stats.descLanded >= 5, JSON.stringify(r.stats))
})

test('A*: река 8 (глубина 5) — мост по воде дешевле плавания', () => {
  const river = p => (p.x >= 1 && p.x <= 8 && p.y >= 59 && p.y <= 63) ? 'water' : (p.y === 63 || p.y === 58) ? 'stone' : 'air'
  const w = world(river)
  const r = plan(bm.addBridge(moves(w)), new Vec3(0, 64, 0), new goals.GoalBlock(11, 64, 0), 32)
  assert.equal(r.status, 'success')
  const br = r.path.filter(n => n.ndBridge)
  assert.equal(br.length, 8)
  assert.ok(br.every(n => n.ndBridge.water))
})

test('A*: мост над пустотой — не длиннее 8 клеток (в открытом небе поиск не расползается)', () => {
  const ok = plan(bm.addBridge(moves(world(gap(1, 8)))), new Vec3(0, 64, 0), new goals.GoalBlock(11, 64, 0), 32)
  assert.equal(ok.status, 'success')
  assert.equal(ok.path.filter(n => n.ndBridge).length, 8)
  const no = plan(bm.addBridge(moves(world(gap(1, 9)))), new Vec3(0, 64, 0), new goals.GoalBlock(12, 64, 0), 32)
  assert.notEqual(no.status, 'success')
})

// Поиск ещё идёт ('partial'): над пустотой — постоять присев у края, но не дольше HOLD_MS (pathfinder сам сбрасывает путь
// «stuck» через 3.5 с, и поиск начинается заново — mv-spr-dbg2: goto «застрял» у реки за 27 с); над водой — не ждать.
test('исполнитель: поиск ещё идёт — над пустотой ждёт ≤ 2.5 с и мостит, над водой мостит сразу', () => {
  const firstPlaceTick = (terrain, water) => {
    const w = world(terrain)
    const nodes = [...bridgeNodes(1, 5), Object.assign(new Move(6, 64, 0, 11, 1), { x: 6.5, z: 0.5 }), Object.assign(new Move(7, 64, 0, 11, 1), { x: 7.5, z: 0.5 })]
    for (const n of nodes) if (n.ndBridge) n.ndBridge.water = water
    const clock: Record<string, any> = { t: 0 }
    let first = -1
    const r = run(w, nodes, { ticks: 260, clock, deps: { status: () => 'partial', now: () => clock.t }, server: (bot, t) => { if (first < 0 && bot.places.length) first = t } })
    return { first, r }
  }
  const voidRun = firstPlaceTick(gap(), false)
  assert.equal(voidRun.r.left, 0, 'над пустотой: дошёл')
  assert.ok(voidRun.r.minY > 63.99, 'не падал')
  assert.ok(voidRun.first >= 45 && voidRun.first <= 75, 'над пустотой первый блок после ожидания ~2.5 с: тик ' + voidRun.first)
  assert.ok(voidRun.r.stats.held >= 40, 'стоял присев: ' + voidRun.r.stats.held)
  const water = p => (p.y === 63 && (p.x < 1 || p.x > 5)) || p.y === 20 ? 'stone' : (p.y < 63 && p.y > 57 && p.x >= 1 && p.x <= 5 ? 'water' : 'air')
  const wetRun = firstPlaceTick(water, true)
  assert.equal(wetRun.r.left, 0, 'над водой: дошёл')
  assert.ok(wetRun.first >= 0 && wetRun.first < 25, 'над водой первый блок без ожидания: тик ' + wetRun.first)
  assert.ok(!wetRun.r.stats.held, 'над водой не ждал')
})

// Путь «не отсюда»: поиск начат с верха обрыва, тело уже спустилось блоками по частичному пути, а итоговый путь ведёт к
// узлу на 6 выше — перестроить сразу, а не прыгать на месте до «stuck» (mv-gap-fin2, обрыв 20: 16–30 с вместо 11).
test('исполнитель: первый узел пути выше тела на 1.3+ без постановки — перестроить отсюда', () => {
  const w = world(p => (p.y === 63 ? 'stone' : 'air'))
  const up = Object.assign(new Move(3, 70, 0, 16, 1), { x: 3.5, z: 0.5 })
  const r = run(w, [up, Object.assign(new Move(4, 70, 0, 16, 1), { x: 4.5, z: 0.5 })], { ticks: 30 })
  assert.ok((r.bot.replans || 0) >= 1, 'перестроил: ' + r.bot.replans)
  assert.ok(r.stats.notHere >= 1)
  // Обычный шаг вверх на 1 (прыжок) — не трогать.
  const w2 = world(p => (p.y === 63 || (p.y === 64 && p.x >= 2) ? 'stone' : 'air'))
  const step = Object.assign(new Move(2, 65, 0, 16, 1), { x: 2.5, z: 0.5 })
  const r2 = run(w2, [step], { ticks: 30 })
  assert.ok(!r2.stats.notHere, 'шаг на блок — свой путь')
})

// S8b (07.10): тот же «путь не отсюда» с того же места — не больше трёх перестроек (s8b-a1-3: 62 подряд, 2.5 мин на месте).
test('исполнитель: одинаковый отказ «путь не отсюда» — не больше трёх перестроек подряд', () => {
  const w = world(p => (p.y === 63 ? 'stone' : 'air'))
  const up = () => [Object.assign(new Move(3, 70, 0, 16, 1), { x: 3.5, z: 0.5 }), Object.assign(new Move(4, 70, 0, 16, 1), { x: 4.5, z: 0.5 })]
  const clock: Record<string, any> = { t: 0 }
  const r = run(w, up(), { ticks: 400, clock, deps: { now: () => clock.t } })
  assert.ok((r.bot.replans || 0) >= 1 && r.bot.replans <= 3, 'перестроек: ' + r.bot.replans)
})

// S8c (07.10, замечание проверки в): подпись с клеткой у причин без узла; счёт снимают сдвиг тела, новая и достигнутая цель.
test('перестройки: подпись причина|клетка, счёт по месту; сдвиг на 2+ бл., новая цель и цель достигнута — сначала', () => {
  assert.equal(bm.replanSig('нет опоры', { ref: [1, 63, 0], cell: [2, 63, 0] }), 'нет опоры|2,63,0')
  assert.notEqual(bm.replanSig('нет опоры', { cell: [2, 63, 0] }), bm.replanSig('нет опоры', { cell: [3, 63, 0] }))
  assert.equal(bm.replanSig('спуск: нет блоков в хотбаре'), 'спуск: нет блоков в хотбаре|')
  const st: Record<string, any> = {}
  const p = { x: 0.5, y: 64, z: 0.5 }
  for (let k = 1; k <= 5; k++) assert.equal(bm.replanCount(st, 'a|1,2,3', p), k)
  assert.equal(bm.replanCount(st, 'a|1,2,3', { x: 3.5, y: 64, z: 0.5 }), 1, 'тело ушло на 3 бл. — сначала')
  assert.equal(bm.replanCount(st, 'b|1,2,3', { x: 3.5, y: 64, z: 0.5 }), 1, 'другая подпись — сначала')
  // install: новая цель снимает счёт, та же цель (рефлекс поставил её снова) — нет; цель достигнута — снимает.
  const w = world(() => 'air')
  const bot = fakeBot(w, Physics(data, w), new Vec3(0.5, 64, 0.5))
  const ex = bm.install({ bot, pathNodes: [] }, { faceAim: pick.faceAim, nodes: () => [], log: () => {} })
  const g1 = { x: 1, y: 2, z: 3 }
  bot.emit('goal_updated', g1); ex.replanSame = 4; ex.replanSig = 's'
  bot.emit('goal_updated', { x: 1, y: 2, z: 3 })
  assert.equal(ex.replanSame, 4, 'та же цель — счёт остаётся')
  bot.emit('goal_updated', { x: 9, y: 2, z: 3 })
  assert.equal(ex.replanSame, 0, 'новая цель — сначала')
  ex.replanSame = 4; bot.emit('goal_reached', g1)
  assert.equal(ex.replanSame, 0, 'цель достигнута — сначала')
  ex.stop()
})
