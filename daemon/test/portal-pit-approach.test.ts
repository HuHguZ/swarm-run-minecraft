'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')
const { transformSync } = require('esbuild')
const sourceFile = process.env.PORTAL_APPROACH_SOURCE || path.join(__dirname, '../src/nether.js')
const realRequire = createRequire(sourceFile)
const sourceCode = text => transformSync(text, { loader: 'ts' }).code

test('проход без кирки использует видимую расчистку, не требование выпадения ресурса', async () => {
  const ctl = { aborted: false, onAbort: [] }
  const cell = new Vec3(0, 66, 0)
  let remaining = true
  const block = p => ({ name: p.equals(cell) && remaining ? 'netherrack' : p.y < 65 ? 'stone' : 'air', type: 1,
    position: p, hardness: .4, boundingBox: p.equals(cell) && remaining || p.y < 65 ? 'block' : 'empty', shapes: [[0, 0, 0, 1, 1, 1]] })
  const bot = { entity: { position: new Vec3(.5, 64, .5) }, inventory: { items: () => [] }, entities: {},
    pathfinder: { setGoal () {} }, blockAt: block, world: { raycast: () => block(cell) },
    dig: async () => { remaining = false; ctl.aborted = true } }
  const context: any = { module: { exports: {} }, console, process, setTimeout, clearTimeout,
    require: name => name === './movement' ? { ...realRequire(name), sleep: async () => {} } : realRequire(name) }
  vm.runInNewContext(sourceCode(fs.readFileSync(sourceFile, 'utf8')), context)
  const result = await context.module.exports.bore({ bot, mcData: { blocks: { 1: { harvestTools: { 2: true } } }, items: { 2: { name: 'stone_pickaxe' } } } }, ctl,
    { x: 5, z: 0 }, { maxSteps: 2, maxY: 66 })
  assert.equal(result.dug, 1)
  assert.equal(remaining, false)
  assert.equal(result.why, 'прервано')
})

async function fallingBore ({ name = 'gravel', falls = 2, afterDig = null }: any = {}) {
  const mcData = realRequire('minecraft-data')('1.21.11')
  const cell = new Vec3(1, 65, 0)
  const ctl = { aborted: false, onAbort: [] }
  let digs = 0, now = 0, lava = false, hidden = false
  const block = p => {
    const material = p.equals(cell) && digs < falls ? name : lava && p.equals(cell.offset(1, 0, 0)) ? 'lava' : p.y < 64 ? 'stone' : 'air'
    const data = mcData.blocksByName[material]
    return { name: material, type: data.id, position: p, hardness: data.hardness, diggable: data.diggable,
      boundingBox: material === 'air' || material === 'lava' ? 'empty' : 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
  }
  const bot = { entity: { position: new Vec3(.5, 64, .5) }, inventory: { items: () => [] }, entities: {}, blockAt: block,
    pathfinder: { setGoal () {} }, world: { raycast: () => hidden ? block(cell.offset(-1, 0, 0)) : block(cell) },
    lookAt: async () => {}, setControlState (key, value) { if (key === 'forward' && value) this.entity.position = new Vec3(1.5, 64, .5) },
    dig: async () => { digs++; if (afterDig === 'abort') ctl.aborted = true; if (afterDig === 'deadline') now = 1000; if (afterDig === 'lava') lava = true; if (afterDig === 'hidden') hidden = true } }
  const context: any = { module: { exports: {} }, console, process, setTimeout, clearTimeout,
    require: dependency => dependency === './movement' ? { ...realRequire(dependency), sleep: async () => {} }
      : dependency === './game-clock' ? { ...realRequire(dependency), now: () => now } : realRequire(dependency) }
  vm.runInNewContext(sourceCode(fs.readFileSync(sourceFile, 'utf8')), context)
  const result = await context.module.exports.bore({ bot, mcData }, ctl, { x: 3, z: 0 }, { maxSteps: 1, deadline: 1000 })
  return { digs, result }
}

for (const name of ['gravel', 'sand', 'red_sand']) {
  test(`штрек убирает ${name}, физически упавший в ту же клетку, даже без кирки`, async () => {
    const { digs, result } = await fallingBore({ name })
    assert.equal(digs, 2)
    assert.equal(result.moved, 1)
  })
}

test('четыре попытки расчистки не разрешают шаг в оставшийся гравий', async () => {
  const { digs, result } = await fallingBore({ falls: 10 })
  assert.equal(digs, 4)
  assert.equal(result.moved, 0)
  assert.match(result.why, /остался.*после копки/)
})

test('повтор разрешён только для падающего блока, не для неподтверждённой копки камня', async () => {
  const { digs, result } = await fallingBore({ name: 'stone' })
  assert.equal(digs, 1)
  assert.equal(result.moved, 0)
  assert.match(result.why, /остался.*после копки/)
})

test('расчистка сохраняет физическое требование кирки для обсидиана', async () => {
  const { digs, result } = await fallingBore({ name: 'obsidian' })
  assert.equal(digs, 0)
  assert.equal(result.moved, 0)
  assert.match(result.why, /кирк/)
})

for (const [afterDig, why] of [['abort', /прервано/], ['deadline', /время вышло/], ['lava', /лава|lava/], ['hidden', /не виден/]] as Array<[string, RegExp]>) {
  test(`повтор расчистки уважает ${afterDig}`, async () => {
    const { digs, result } = await fallingBore({ afterDig })
    assert.equal(digs, 1)
    assert.equal(result.moved, 0)
    assert.match(result.why, why)
    if (afterDig === 'lava') assert.equal(result.lava, 1)
  })
}

async function gravityWindowBore ({ mode = 'landed' } = {}) {
  const mcData = realRequire('minecraft-data')('1.21.11'), head = new Vec3(1, 65, 0), feet = head.offset(0, -1, 0)
  const ctl = { aborted: false, onAbort: [] }
  let now = 0, digs = 0, headPresent = true, feetPresent = true, falling = false, landed = false
  if (mode.startsWith('initial')) { headPresent = false; feetPresent = false; falling = true }
  const movedAt = []
  const localFall = !['hidden', 'adjacent', 'cow'].includes(mode)
  const update = () => {
    if (mode === 'abort' && now >= 250) ctl.aborted = true
    if (mode === 'initial-abort' && now >= 450) ctl.aborted = true
    if (falling && !landed && mode !== 'never' && now >= 450) { landed = true; falling = false; if (localFall) headPresent = true }
  }
  const block = p => {
    update()
    const material = p.equals(head) && headPresent ? 'gravel' : p.equals(feet) && feetPresent ? 'netherrack' :
      (mode === 'lava' && now >= 250 || mode === 'initial-lava' && now >= 450) && p.equals(head.offset(1, 0, 0)) ? 'lava' : p.y < 64 ? 'stone' : 'air'
    const data = mcData.blocksByName[material]
    return { name: material, type: data.id, position: p, hardness: data.hardness, diggable: data.diggable,
      boundingBox: /air|lava/.test(material) ? 'empty' : 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
  }
  const bot = { entity: { position: new Vec3(.5, 64, .5) }, inventory: { items: () => [] }, entities: {}, blockAt: block,
    pathfinder: { setGoal () {} }, world: { raycast: () => block(headPresent ? head : feet) }, lookAt: async () => {},
    setControlState (key, value) { if (key === 'forward' && value) { movedAt.push(now); this.entity.position = new Vec3(1.5, 64, .5) } },
    dig: async b => { digs++; if (b.position.equals(head)) { headPresent = false; if (!landed) falling = true } else feetPresent = false } }
  const context: any = { module: { exports: {} }, console, process, setTimeout, clearTimeout,
    require: name => name === './game-clock' ? { ...realRequire(name), now: () => now,
      setTimeout: (fn, ms) => setImmediate(() => { now += ms; update(); fn() }), clearTimeout: clearImmediate } :
      name === './perception/eyes' ? { ...realRequire(name), entities: () => falling && (now >= 150 || mode.startsWith('initial')) ? [{ id: 1,
        name: mode === 'cow' ? 'cow' : 'falling_block', seen: mode !== 'hidden',
        pos: { x: mode === 'adjacent' ? 2.5 : 1.5, y: 66, z: .5 }, lastPos: { x: 1.5, y: 66, z: .5 } }] : [] } : realRequire(name) }
  vm.runInNewContext(sourceCode(fs.readFileSync(sourceFile, 'utf8')), context)
  const result = await context.module.exports.bore({ bot, mcData }, ctl, { x: 3, z: 0 }, { maxSteps: 1, deadline: mode === 'deadline' ? 250 : mode === 'initial-deadline' ? 450 : 1000 })
  return { result, digs, movedAt, now }
}

test('видимый падающий блок переживает local dig air: дождаться оседания и расчистить снова', async () => {
  const { result, digs, movedAt } = await gravityWindowBore()
  assert.equal(digs, 3, 'два gravel + netherrack, включая поздний серверный refill')
  assert.equal(result.moved, 1)
  assert.ok(movedAt.every(t => t >= 450), 'нельзя входить в local air под видимым falling_block')
})

for (const [mode, why] of [['abort', /прервано/], ['deadline', /время вышло/], ['lava', /lava|лава/], ['never', /время вышло/]] as Array<[string, RegExp]>) {
  test(`ожидание falling_block уважает ${mode}`, async () => {
    const { result, digs, movedAt, now } = await gravityWindowBore({ mode })
    assert.equal(digs, 1)
    assert.equal(result.moved, 0)
    assert.deepEqual(movedAt, [])
    assert.match(result.why, why)
    assert.ok(now <= 1050, 'ожидание ограничено существующим deadline')
  })
}

for (const mode of ['hidden', 'adjacent', 'cow']) {
  test(`падение не задерживает вход по ${mode} сущности`, async () => {
    const { result, digs, movedAt } = await gravityWindowBore({ mode })
    assert.equal(digs, 2)
    assert.equal(result.moved, 1)
    assert.ok(movedAt[0] < 450)
  })
}

test('уже воздушная клетка с видимым falling_block ждёт и повторно очищается', async () => {
  const { result, digs, movedAt } = await gravityWindowBore({ mode: 'initial' })
  assert.equal(digs, 1)
  assert.equal(result.moved, 1)
  assert.ok(movedAt.every(t => t >= 450))
})

for (const [mode, why] of [['initial-deadline', /время вышло/], ['initial-abort', /прервано/], ['initial-lava', /lava|лава/]] as Array<[string, RegExp]>) {
  test(`оседание точно на границе ${mode} не разрешает новую копку`, async () => {
    const { result, digs, movedAt } = await gravityWindowBore({ mode })
    assert.equal(digs, 0)
    assert.equal(result.moved, 0)
    assert.deepEqual(movedAt, [])
    assert.match(result.why, why)
  })
}

for (const [height, aborted, climbs] of [[5, false, 1], [0, false, 0], [5, true, 0]] as Array<[number, boolean, number]>) {
  test(`подход к порогу: высота ${height}, отмена ${aborted}, подъёмов ${climbs}`, async () => {
    const { functionSource } = require('./source-fixture')
    const ctl = { aborted, onAbort: [] }
    const target = new Vec3(0, 64 + height, 0)
    const bot = { entity: { position: new Vec3(.5, 64, .5) }, health: 20 }
    const moves = []
    const door = { origin: target, axis: 'x', cells: [target], bottom: [target] }
    const context: any = { Vec3, console, MIN_ENTER_HP: 8, IGNITERS: [], HOLD_LIMIT_MS: 15000, gameClock: { now: () => 0 },
      worlds: { worldOf: () => 'the_nether', portalKey: () => 'portal' }, reader: () => () => null,
      findLitPortal: () => door, doorways: () => [{ pos: target, cell: target }], clearStand: () => true,
      walkNear: async () => ({ ok: false }), walkToward: async (_s, _c, to, _d, options) => { moves.push(options); bot.entity.position = to; return { ok: true } },
      sameCell: () => bot.entity.position === target, portalChanged: () => false, insidePortal: () => false,
      xyz: p => ({ x: p.x, y: p.y, z: p.z }), sleep: async () => {}, stepTo: async () => { ctl.aborted = true } }
    vm.runInNewContext(sourceCode(functionSource(sourceFile, 'enter') + ';this.run = enter'), context)
    const result = await context.run({ bot, mcData: {}, journal: { state: {} } }, ctl, { timeoutSeconds: 30 })
    assert.equal(moves.length, climbs)
    if (climbs) assert.equal(moves[0].range, 0)
    assert.equal(result.went, false, 'подход не является свидетельством смены мира')
  })
}
