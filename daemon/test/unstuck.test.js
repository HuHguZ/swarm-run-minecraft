'use strict'
// Лестница выхода из застреваний (unstuck.js): детектор, диагноз, лестница, наблюдатель в gotoGoal.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const unstuck = require('../src/unstuck')
const { gotoGoal } = require('../src/movement')
const { goals } = require('mineflayer-pathfinder')

// Мир из словаря «x,y,z» → имя блока; всё прочее — воздух. Твёрдое — полный куб.
const LIQ = /water|lava/
const EMPTY = /^(air|cave_air|water|lava|short_grass|kelp|seagrass|vine|powder_snow)$/
function world (map = {}, { floorY = 63, floor = 'stone' } = {}) {
  return p => {
    const k = `${p.x},${p.y},${p.z}`
    const name = map[k] || (p.y === floorY ? floor : 'air')
    const empty = EMPTY.test(name)
    return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]], liquid: LIQ.test(name), diggable: name !== 'bedrock', hardness: name === 'bedrock' ? -1 : 0.4, digTime: () => 600 }
  }
}
function botAt (pos, map, opts) {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(pos.x, pos.y, pos.z), onGround: true, yaw: 0, isInWater: false }
  bot.blockAt = world(map, opts)
  bot.controls = {}
  bot.setControlState = (k, v) => { bot.controls[k] = v }
  bot.getControlState = k => !!bot.controls[k]
  bot.clearControlStates = () => { bot.controls = {} }
  bot.look = async () => {}
  bot.lookAt = async () => {}
  bot.entities = {}
  bot.inventory = { items: () => [] }
  bot.pathfinder = { isMining: () => false, isBuilding: () => false, goals: [], setGoal (g) { this.goals.push(g); bot.emit('goal_updated', g) } }
  return bot
}

test('детектор: стоит при живой цели 3 с — still; пока идёт поиск — нет', () => {
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 })
  let t = 0
  const det = unstuck.createDetector(bot, { goal: new goals.GoalNearXZ(20, 0, 1), now: () => t })
  det.feed({ status: 'partial', path: [] })
  t = 2000; det.feed({ status: 'partial', path: [] }); assert.equal(det.check(), null)
  t = 3400; det.feed({ status: 'partial', path: [] }); assert.equal(det.check(), null, 'свежий partial с пустым путём — поиск ещё идёт')
  t = 5200; assert.equal(det.check(), null, 'поиск кончился 1.8 с назад — отсчёт заново с конца поиска')
  det.feed({ status: 'success', path: [{ x: 1, y: 64, z: 0 }] })
  t = 3500; assert.equal(det.check(), null)
  t = 6600; const v = det.check()
  assert.equal(v && v.kind, 'still')
})

test('детектор: тело идёт — не застряло; топчется на месте без приближения 20 с — noprogress', () => {
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 })
  let t = 0
  const det = unstuck.createDetector(bot, { goal: new goals.GoalNearXZ(40, 0, 1), now: () => t })
  det.feed({ status: 'success', path: [{ x: 1, y: 64, z: 0 }] })
  for (let i = 1; i <= 10; i++) { t = i * 1000; bot.entity.position = new Vec3(0.5 + i, 64, 0.5); assert.equal(det.check(), null) }
  // Качается в воде туда-сюда на 0.6, не приближаясь.
  let v = null
  for (let i = 1; i <= 25 && !v; i++) { t = 10000 + i * 1000; bot.entity.position = new Vec3(10.5 + (i % 2 ? 0.6 : -0.6), 64, 0.5); v = det.check() }
  assert.equal(v && v.kind, 'noprogress')
})

test('детектор: копка одного блока дольше 10 с — dig; стройка pathfinder\'а — не застревание до 6 с', () => {
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 })
  let t = 0
  const det = unstuck.createDetector(bot, { goal: new goals.GoalNearXZ(20, 0, 1), now: () => t })
  det.feed({ status: 'success', path: [{ x: 1, y: 64, z: 0 }] })
  bot.pathfinder.isMining = () => true
  bot.targetDigBlock = { position: new Vec3(1, 64, 0) }
  t = 5000; assert.equal(det.check(), null)
  t = 15500; assert.equal(det.check().kind, 'dig')
  bot.pathfinder.isMining = () => false; bot.targetDigBlock = null
  bot.pathfinder.isBuilding = () => true
  det.reset()
  t = 16000; assert.equal(det.check(), null)
  t = 22500; assert.equal(det.check().kind, 'still')
})

test('диагноз: вода, завалило, яма, стена, мягкий пол, открыто, флаг копки', () => {
  const to = new Vec3(10.5, 64, 0.5)
  let bot = botAt({ x: 0.5, y: 64, z: 0.5 }, { '0,64,0': 'water', '0,65,0': 'water' })
  assert.equal(unstuck.diagnose(bot, to).cls, 'water')
  bot = botAt({ x: 0.5, y: 64, z: 0.5 }, { '0,65,0': 'gravel' })
  assert.equal(unstuck.diagnose(bot, to).cls, 'buried')
  const pit = {}; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { pit[`${dx},64,${dz}`] = 'netherrack'; pit[`${dx},65,${dz}`] = 'netherrack' }
  bot = botAt({ x: 0.5, y: 64, z: 0.5 }, pit)
  const d = unstuck.diagnose(bot, to)
  assert.equal(d.cls, 'enclosed'); assert.equal(d.wallAhead, true)
  bot = botAt({ x: 0.5, y: 64, z: 0.5 }, { '1,64,0': 'stone', '1,65,0': 'stone' })
  assert.equal(unstuck.diagnose(bot, to).cls, 'wall')
  bot = botAt({ x: 0.5, y: 64, z: 0.5 }, { '0,63,0': 'oak_leaves' })
  assert.equal(unstuck.diagnose(bot, to).cls, 'soft')
  bot = botAt({ x: 0.5, y: 64, z: 0.5 })
  assert.equal(unstuck.diagnose(bot, to).cls, 'open')
  bot.pathfinder.isMining = () => true; bot.targetDigBlock = null
  assert.equal(unstuck.diagnose(bot, to).cls, 'dig-flag')
})

test('лестница: по классу, отказ поиска — свой порядок; ступени есть у всех', () => {
  assert.deepEqual(unstuck.ladder('water').slice(0, 3), ['swimOut', 'notch', 'stepUp'])
  assert.equal(unstuck.ladder('buried')[0], 'digOut')
  assert.equal(unstuck.ladder('enclosed', 'refused')[0], 'bypass')
  assert.equal(unstuck.ladder('нечто')[0], 'replan')
  assert.equal(unstuck.ladder('wall', 'refused', 'timeout')[0], 'waypoint', 'A* не уложился — промежуточная цель первой')
  for (const t of [unstuck.LADDERS, unstuck.REFUSED]) for (const k of Object.keys(t)) for (const r of t[k]) assert.equal(typeof unstuck.RUNGS[r], 'function', `${k}: ${r}`)
})

test('ломать можно только безопасное: жидкость за блоком, пол под ногами, бедрок — нет', () => {
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 }, { '1,64,0': 'netherrack', '2,64,0': 'lava', '1,65,0': 'netherrack', '0,63,0': 'netherrack', '-1,64,0': 'bedrock' })
  assert.equal(unstuck.safeToBreak(bot, new Vec3(1, 64, 0)).ok, false, 'лава за блоком')
  assert.match(unstuck.safeToBreak(bot, new Vec3(1, 64, 0)).why, /lava/)
  assert.equal(unstuck.safeToBreak(bot, new Vec3(0, 63, 0)).ok, false, 'пол под ногами')
  assert.equal(unstuck.safeToBreak(bot, new Vec3(-1, 64, 0)).ok, false)
  assert.equal(unstuck.safeToBreak(bot, new Vec3(1, 65, 0)).ok, true)
})

test('видимая точка: блок за другим блоком не видно — не ломаем сквозь стену', () => {
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 }, { '1,65,0': 'stone', '2,65,0': 'stone' })
  assert.ok(unstuck.visiblePoint(bot, new Vec3(1, 65, 0)), 'ближний виден')
  assert.equal(unstuck.visiblePoint(bot, new Vec3(2, 65, 0)), null, 'дальний за ближним — нет')
})

// gotoGoal + наблюдатель: тело стоит → ступень → та же цель снова → дошёл.
function gotoFixture ({ map = {}, moveOnGoal = 2 } = {}) {
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 }, map)
  let setGoals = 0
  bot.pathfinder.setGoal = (g) => {
    bot.emit('goal_updated', g)
    if (!g) return
    setGoals++
    setImmediate(() => bot.emit('path_update', { status: 'success', path: [{ x: 1, y: 64, z: 0 }] }))
    if (setGoals >= moveOnGoal) setTimeout(() => { bot.entity.position = new Vec3(20.5, 64, 0.5); bot.emit('goal_reached', g) }, 30)
  }
  let updates = 0
  const session = { bot, updateMovements: () => { updates++ }, pathNodes: null, movements: { bridge: true } }
  return { bot, session, get setGoals () { return setGoals }, get updates () { return updates } }
}

test('gotoGoal + unstuck: стоит на месте — ступень, та же цель ещё раз, дошёл', async () => {
  const f = gotoFixture({ moveOnGoal: 2 })
  const ctl = { aborted: false, onAbort: [] }
  let t = 0
  const lines = []
  const un = unstuck.watch(f.session, ctl, { now: () => t, tickMs: 5, sleep: async () => {}, log: (...a) => lines.push(a.join(' ')) })
  const goal = new goals.GoalNearXZ(20, 0, 1)
  const clock = setInterval(() => { t += 500 }, 5)
  try {
    await gotoGoal(f.bot, goal, { unstuck: un })
  } finally { clearInterval(clock) }
  assert.equal(f.setGoals, 2, 'после ступени — та же цель')
  assert.equal(un.stats.detected, 1)
  assert.ok(un.stats.rungs.length >= 1)
  assert.ok(lines.some(l => /\[unstuck\]/.test(l)))
})

test('gotoGoal + unstuck: ступени кончились — отказ STUCK с классом и местом', async () => {
  const f = gotoFixture({ moveOnGoal: 1000 })
  const ctl = { aborted: false, onAbort: [] }
  let t = 0
  const un = unstuck.watch(f.session, ctl, { now: () => t, tickMs: 5, sleep: async () => {}, log: () => {}, maxRungs: 3 })
  const clock = setInterval(() => { t += 700 }, 5)
  try {
    await assert.rejects(gotoGoal(f.bot, new goals.GoalNearXZ(20, 0, 1), { unstuck: un }), err => err.code === 'STUCK' && /застрял \(open\) у 0,64,0/.test(err.message))
  } finally { clearInterval(clock) }
  assert.equal(un.stats.gaveUp.cls, 'open')
  assert.ok(un.stats.gaveUp.tried.length >= 1)
})

test('gotoGoal + unstuck: отказ поиска в открытом месте впервые — как раньше; в яме — лестница', async () => {
  // Открыто, первый отказ: goto отвечает пустым путём (resolve), как без флага.
  let f = gotoFixture()
  f.bot.pathfinder.setGoal = g => { f.bot.emit('goal_updated', g); if (g) setImmediate(() => f.bot.emit('path_update', { status: 'noPath', path: [] })) }
  const ctl = { aborted: false, onAbort: [] }
  let un = unstuck.watch(f.session, ctl, { tickMs: 1000, sleep: async () => {}, log: () => {} })
  await gotoGoal(f.bot, new goals.GoalNearXZ(30, 30, 1), { unstuck: un })
  assert.equal(un.stats.refusals, 0)
  // В яме из незерака: отказ берёт лестница (первая ступень — обход блоками), потом цель снова.
  const pit = {}; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { pit[`${dx},64,${dz}`] = 'netherrack'; pit[`${dx},65,${dz}`] = 'netherrack' }
  f = gotoFixture({ map: pit })
  f.session.movements = { bridge: false }
  let n = 0
  f.bot.pathfinder.setGoal = g => {
    f.bot.emit('goal_updated', g)
    if (!g) return
    n++
    setImmediate(() => {
      if (n === 1) f.bot.emit('path_update', { status: 'noPath', path: [] })
      else { f.bot.entity.position = new Vec3(30.5, 64, 30.5); f.bot.emit('goal_reached', g) }
    })
  }
  un = unstuck.watch(f.session, ctl, { tickMs: 1000, sleep: async () => {}, log: () => {} })
  await gotoGoal(f.bot, new goals.GoalNearXZ(30, 30, 1), { unstuck: un })
  assert.equal(un.stats.refusals, 1)
  assert.equal(un.stats.rungs[0].rung, 'bypass')
  assert.equal(f.session.bridgeWanted, true)
})

test('без флага gotoGoal как раньше: noPath — отказ NoPath', async () => {
  const f = gotoFixture()
  f.bot.pathfinder.setGoal = g => { f.bot.emit('goal_updated', g); if (g) setImmediate(() => f.bot.emit('path_update', { status: 'noPath', path: [{ x: 1, y: 64, z: 0 }] })) }
  await assert.rejects(gotoGoal(f.bot, new goals.GoalNearXZ(30, 30, 1)), /No path/)
})

test('флаг: ND_UNSTUCK и параметр goto поверх', () => {
  const was = process.env.ND_UNSTUCK
  try {
    delete process.env.ND_UNSTUCK
    assert.equal(unstuck.on(), unstuck.DEFAULT_ON)
    process.env.ND_UNSTUCK = '1'; assert.equal(unstuck.on(), true)
    process.env.ND_UNSTUCK = '0'; assert.equal(unstuck.on(), false)
    assert.equal(unstuck.on(true), true)
  } finally { if (was === undefined) delete process.env.ND_UNSTUCK; else process.env.ND_UNSTUCK = was }
})

test('снести к цели выше: лесенка — над головой и впереди +2/+1, клетка ног впереди остаётся ступенькой', async () => {
  const map = {}
  for (let y = 64; y <= 67; y++) map[`1,${y},0`] = 'stone'
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 }, map)
  const dug = []
  bot.dig = async (b) => { dug.push(`${b.position.x},${b.position.y},${b.position.z}`); map[`${b.position.x},${b.position.y},${b.position.z}`] = 'air' }
  const r = await unstuck.RUNGS.breakAhead({ bot, toward: new Vec3(5.5, 67, 0.5), sleep: async () => {} })
  assert.equal(r.applied, true)
  assert.deepEqual(dug, ['1,66,0', '1,65,0'])
  assert.equal(map['1,64,0'], 'stone', 'ступенька')
})

test('снести к цели на том же уровне: проход 1×2; лава за блоком — не трогаем', async () => {
  const map = { '1,64,0': 'netherrack', '1,65,0': 'netherrack', '2,65,0': 'lava' }
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 }, map)
  const dug = []
  bot.dig = async (b) => { dug.push(`${b.position.x},${b.position.y},${b.position.z}`); map[`${b.position.x},${b.position.y},${b.position.z}`] = 'air' }
  const r = await unstuck.RUNGS.breakAhead({ bot, toward: new Vec3(9.5, 64, 0.5), sleep: async () => {} })
  assert.deepEqual(dug, ['1,64,0'], 'голова — лава за блоком, ноги — можно')
  assert.match(r.why, /снёс netherrack/)
})

test('лава: класс lava, первая ступень — выплыть к сухой опоре', () => {
  const map = {}
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 62; y <= 64; y++) map[`${x},${y},${z}`] = 'lava'
  map['3,63,0'] = 'netherrack'
  const bot = botAt({ x: 0.5, y: 63, z: 0.5 }, map, { floorY: 61, floor: 'netherrack' })
  const d = unstuck.diagnose(bot, new Vec3(10.5, 64, 0.5))
  assert.equal(d.cls, 'lava')
  assert.equal(unstuck.ladder('lava')[0], 'swimOutLava')
})

test('память отказов: тот же отказ в той же точке второй раз (другой вызов goto) — лестница берёт, не поможет — прежний ответ', async () => {
  const f = gotoFixture()
  f.session.movements = { bridge: false }
  f.bot.pathfinder.setGoal = g => { f.bot.emit('goal_updated', g); if (g) setImmediate(() => f.bot.emit('path_update', { status: 'noPath', path: [] })) }
  const ctl = { aborted: false, onAbort: [] }
  const goal = new goals.GoalNearXZ(30, 30, 1)
  let un = unstuck.watch(f.session, ctl, { tickMs: 1000, sleep: async () => {}, log: () => {} })
  await gotoGoal(f.bot, goal, { unstuck: un })
  assert.equal(un.stats.refusals, 0, 'первый раз в открытом месте — как раньше')
  un = unstuck.watch(f.session, ctl, { tickMs: 1000, sleep: async () => {}, log: () => {}, maxRungs: 2 })
  // Лестница берёт повторный отказ; в открытом месте помочь нечем — отдаёт прежний ответ goto (пустой путь), не STUCK.
  await gotoGoal(f.bot, goal, { unstuck: un })
  assert.ok(un.stats.refusals >= 1)
  assert.equal(un.exhausted(), true)
  assert.equal(un.stats.rungs[0].rung, 'waypoint', 'открыто, цель далеко — сначала промежуточная цель')
})

test('прерывание посреди ступени отпускает gotoGoal (без висящих слушателей)', async () => {
  const f = gotoFixture({ moveOnGoal: 1000 })
  const ctl = { aborted: false, onAbort: [] }
  ctl.abort = () => { ctl.aborted = true; for (const fn of ctl.onAbort) fn() }
  let t = 0
  let release = null
  const slow = () => new Promise(resolve => { release = resolve })
  const un = unstuck.watch(f.session, ctl, { now: () => t, tickMs: 5, sleep: slow, log: () => {} })
  const clock = setInterval(() => { t += 700 }, 5)
  const p = gotoGoal(f.bot, new goals.GoalNearXZ(20, 0, 1), { unstuck: un })
  try {
    while (!release) await new Promise(resolve => setTimeout(resolve, 5))
    ctl.abort()
    await assert.rejects(p, /прервано/)
    release()
  } finally { clearInterval(clock) }
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(f.bot.listenerCount('path_update'), 0)
})

test('рыхлый снег: тело в нём — «завалило», выкопаться (контур — куб, глаза внутри — видно)', async () => {
  const map = { '0,64,0': 'powder_snow', '0,65,0': 'powder_snow', '1,64,0': 'powder_snow', '1,65,0': 'powder_snow' }
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 }, map)
  const d = unstuck.diagnose(bot, new Vec3(9.5, 64, 0.5))
  assert.equal(d.cls, 'buried')
  assert.ok(unstuck.visiblePoint(bot, new Vec3(1, 65, 0)), 'соседний рыхлый снег под прицелом')
  const dug = []
  bot.dig = async (b) => { dug.push(`${b.position.x},${b.position.y},${b.position.z}`); map[`${b.position.x},${b.position.y},${b.position.z}`] = 'air' }
  const r = await unstuck.RUNGS.digOut({ bot, sleep: async () => {} })
  assert.equal(r.applied, true)
  assert.deepEqual(dug, ['0,65,0', '0,64,0'])
})

test('промежуточная цель: A* к дальней цели не уложился — шаг к точке по пути, потом та же цель', async () => {
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 })
  const far = new goals.GoalNearXZ(80, 0, 1)
  let calls = 0
  bot.pathfinder.setGoal = (g) => {
    bot.emit('goal_updated', g)
    if (!g) return
    calls++
    setImmediate(() => {
      if (g === far && bot.entity.position.x < 40) return bot.emit('path_update', { status: 'timeout', path: [] })
      // Промежуточная (или дальняя, когда уже близко): дошёл.
      bot.entity.position = new Vec3(g.x + 0.5, 64, (g.z || 0) + 0.5)
      bot.emit('path_update', { status: 'success', path: [{ x: g.x, y: 64, z: g.z || 0 }] })
      bot.emit('goal_reached', g)
    })
  }
  const session = { bot, updateMovements () {}, pathNodes: null, movements: { bridge: true } }
  const ctl = { aborted: false, onAbort: [] }
  const un = unstuck.watch(session, ctl, { tickMs: 1000, sleep: async () => {}, log: () => {} })
  await gotoGoal(bot, far, { unstuck: un })
  assert.ok(bot.entity.position.x >= 79, `дошёл до дальней цели (x ${bot.entity.position.x})`)
  assert.ok(un.stats.rungs.filter(r => r.rung === 'waypoint' && r.applied).length >= 2, JSON.stringify(un.stats.rungs))
})

test('из воды на берег на 1 выше воды — путь есть (лезть у стенки с прыжком)', () => {
  const map = {}
  // Яма-озеро: стены из камня до 64 (верх 65), вода 60..63 (поверхность 64): берег на 1 выше воды.
  for (let x = -4; x <= 6; x++) for (let z = -3; z <= 3; z++) for (let y = 60; y <= 64; y++) map[`${x},${y},${z}`] = 'stone'
  for (let x = -3; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 60; y <= 63; y++) map[`${x},${y},${z}`] = 'water'
  for (let x = -3; x <= 2; x++) for (let z = -2; z <= 2; z++) map[`${x},64,${z}`] = 'air'
  const bot = botAt({ x: 0.5, y: 60, z: 0.5 }, map, { floorY: 59, floor: 'stone' })
  bot.entity.isInWater = true
  assert.equal(unstuck.diagnose(bot, new Vec3(5.5, 65, 0.5)).cls, 'water')
  const r = unstuck.fluidRoute(bot, b => b.name === 'water', { radius: 16 })
  assert.ok(r, 'путь к берегу есть')
  assert.equal(r.target.y, 65)
})

test('выемка в берегу: в воде у берега на 1 выше воды — снести блок берега над водой', async () => {
  const map = {}
  for (let x = -4; x <= 6; x++) for (let z = -3; z <= 3; z++) for (let y = 60; y <= 64; y++) map[`${x},${y},${z}`] = 'stone'
  for (let x = -3; x <= 2; x++) for (let z = -2; z <= 2; z++) { for (let y = 60; y <= 63; y++) map[`${x},${y},${z}`] = 'water'; map[`${x},64,${z}`] = 'air' }
  const bot = botAt({ x: 2.5, y: 63.2, z: 0.5 }, map, { floorY: 59, floor: 'stone' })
  bot.entity.isInWater = true
  const dug = []
  bot.dig = async (b) => { dug.push(`${b.position.x},${b.position.y},${b.position.z}`); map[`${b.position.x},${b.position.y},${b.position.z}`] = 'air' }
  const r = await unstuck.RUNGS.notch({ bot, toward: new Vec3(5.5, 65, 0.5), sleep: async () => {} })
  assert.deepEqual(dug, ['3,64,0'], 'блок берега над водой (верх воды — 63)')
  assert.equal(r.applied, true)
})

test('детектор: идёт поиск с частичными путями (тело ходит у старта) — не «нет продвижения»', () => {
  const bot = botAt({ x: 0.5, y: 64, z: 0.5 })
  let t = 0
  const det = unstuck.createDetector(bot, { goal: new goals.GoalNearXZ(60, 0, 1), now: () => t })
  let v = null
  for (let i = 1; i <= 40 && !v; i++) {
    t = i * 1000
    bot.entity.position = new Vec3(0.5 + (i % 4), 64, 0.5)
    det.feed({ status: 'partial', path: [{ x: 3, y: 64, z: 0 }] })
    v = det.check()
  }
  assert.equal(v, null, 'поиск обхода — не застревание')
  // Поиск кончился (только success), а тело всё так же топчется — через 20 с «нет продвижения».
  for (let i = 41; i <= 70 && !v; i++) { t = i * 1000; bot.entity.position = new Vec3(0.5 + (i % 4), 64, 0.5); det.feed({ status: 'success', path: [{ x: 3, y: 64, z: 0 }] }); v = det.check() }
  assert.equal(v && v.kind, 'noprogress')
})
