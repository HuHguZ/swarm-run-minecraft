'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')

function fixture (move?: any, overrides: Record<string, any> = {}) {
  const file = path.join(__dirname, '../src/session.js')
  const realRequire = createRequire(file)
  const counts = { walks: 0, shakes: 0, pits: 0 }
  const context = { module: { exports: {} as Record<string, any> }, console, setTimeout, clearTimeout, Date,
    require: name => {
      const actual = realRequire(name)
      if (overrides[name]) return { ...actual, ...overrides[name] }
      if (name === './build') return { ...actual, escapePit: async () => { counts.pits++; return { wasInPit: false } } }
      if (name === './movement') return { ...actual, inWater: () => false,
        stuckGuard: () => ({ promise: new Promise<void>(() => {}), stop () {} }),
        unstick: async () => { counts.shakes++ } }
      return actual
    } }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.roofCost = underRoofCost;', context)
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(70.5, 63, -70.5), onGround: true }
  // goto ждёт события pathfinder'а (movement.gotoGoal, по умолчанию с 02.10): setGoal → шаг → path_update с пустым
  // путём (как pathfinder, когда идти некуда или уже пришёл); старый bot.pathfinder.goto — то же самое.
  const walk = goal => { counts.walks++; if (move) move(bot, goal) }
  bot.pathfinder = { movements: { canDig: true, scafoldingBlocks: [1] },
    setGoal (goal) { if (!goal) return; walk(goal); setImmediate(() => bot.emit('path_update', { status: 'success', path: [] })) },
    goto: async goal => walk(goal) }
  const session = { bot, require: () => bot, updateMovements () {}, underSky: () => true,
    runIntent: (_name, work) => work({ aborted: false, onAbort: [] }) }
  return { goto: p => context.module.exports.Session.prototype.goto.call(session, p),
    roofCost: context.module.exports.roofCost, bot, counts, session }
}

test('пустой путь goto не считается прибытием и не повторяется с рывками', async () => {
  const f = fixture()
  await assert.rejects(f.goto({ x: 95, z: -12, range: 4, surface: 'strict' }), /не дошёл|не достиг/)
  assert.equal(f.counts.walks, 1)
  assert.equal(f.counts.shakes, 0, 'отсутствие маршрута не является физическим застреванием')
  assert.equal(f.bot.pathfinder.movements.canDig, true)
  assert.deepEqual(f.bot.pathfinder.movements.scafoldingBlocks, [1])
})

test('goto подтверждает реальное прибытие в заданный радиус', async () => {
  const f = fixture(bot => { bot.entity.position = new Vec3(94.5, 67, -14.5) })
  const result = await f.goto({ x: 95, z: -12, range: 4, surface: 'strict' })
  assert.equal(result.arrived.x, 94)
  assert.equal(result.arrived.y, 67)
  assert.equal(f.counts.walks, 1)
})

test('goto не принимает подход по горизонтали за достижение заданной высоты', async () => {
  const f = fixture(bot => { bot.entity.position = new Vec3(95.5, 20, -11.5) })
  f.bot.blockAt = p => ({ position: p, boundingBox: p.y === 64 ? 'block' : 'empty' })
  // После неверной 3D попытки допустим отдельный, явно обозначенный план XZ.
  const result = await f.goto({ x: 95, y: 65, z: -12, range: 2 })
  assert.equal(result.target.mode, 'xz')
  assert.equal(f.counts.walks, 2)
  assert.equal(f.counts.shakes, 0)
})

test('strict keeps the requested height after an unsuccessful 3D route', async () => {
  const f = fixture(bot => { bot.entity.position = new Vec3(95.5, 20, -11.5) })
  f.bot.blockAt = p => ({ position: p, boundingBox: p.y === 64 ? 'block' : 'empty' })
  await assert.rejects(f.goto({ x: 95, y: 65, z: -12, range: 2, surface: 'strict' }), /не дошёл|не достиг/)
  assert.equal(f.counts.walks, 1)
})

test('strict keeps an explicit height when the exact target column has no floor', async () => {
  const f = fixture(bot => { bot.entity.position = new Vec3(95.5, -53, -11.5) })
  f.bot.blockAt = p => ({ position: p, boundingBox: 'empty' })
  await assert.rejects(f.goto({ x: 95, y: -10, z: -12, range: 4, surface: 'strict' }), /не дошёл|не достиг/)
  assert.equal(f.counts.walks, 1)
})

test('strict disables excavation inside a cave and restores movement settings afterwards', async () => {
  let during
  const f = fixture(bot => {
    during = { canDig: bot.pathfinder.movements.canDig, scaffold: [...bot.pathfinder.movements.scafoldingBlocks] }
    bot.entity.position = new Vec3(94.5, 63, -14.5)
  })
  f.session.underSky = () => false
  await f.goto({ x: 95, z: -12, range: 4, surface: 'strict' })
  assert.deepEqual(during, { canDig: false, scaffold: [] })
  assert.equal(f.counts.pits, 0, 'strict approach must not excavate a roof in its pre-route escapePit helper')
  assert.equal(f.bot.pathfinder.movements.canDig, true)
  assert.deepEqual(f.bot.pathfinder.movements.scafoldingBlocks, [1])
})

test('strict запрещает шаг в тёмную пещеру, сохраняя обычный штраф и путь под листвой', () => {
  const f = fixture()
  const pos = new Vec3(1, 62, 1)
  const bot: Record<string, any> = { world: { getColumnAt: () => ({ minY: -64, skyLightSections: Array(24).fill({} as Record<string, any>) }) },
    blockAt: () => ({ skyLight: 0 }) }
  assert.equal(f.roofCost(bot, { position: pos, skyLight: 0 }, true), 100)
  assert.equal(f.roofCost(bot, { position: pos, skyLight: 0 }), 1.5)
  bot.blockAt = () => ({ skyLight: 13 })
  assert.equal(f.roofCost(bot, { position: pos, skyLight: 13 }, true), 0)
})

// Рельеф пула (mv-spr-1): A* не уложился в 5 с или путь кончился раньше цели, а тело уже прошло часть дороги — это
// не провал попытки: тот же план ещё раз, без встряски, пока тело приближается (ограничено числом повторов и сроком).
test('goto: попытка, приблизившая тело к цели на 8+ блоков, не в счёт — идёт дальше до цели', { skip: process.env.ND_GOTO_WAIT === '0' && 'старый goto (ND_GOTO_WAIT=0)' }, async () => {
  const f = fixture(bot => { bot.entity.position = bot.entity.position.offset(10, 0, 0) })
  f.bot.entity.position = new Vec3(0.5, 63, 0.5)
  const result = await f.goto({ x: 50, z: 0, range: 2 })
  assert.equal(result.arrived.x, 50)
  assert.equal(f.counts.walks, 5)
  assert.equal(f.counts.shakes, 0, 'продвижение — не застревание')
})

test('strict goto first leaves a sealed own box toward the target (cl-a 14.10: 43 min boxed in)', async () => {
  const broke: any[] = []
  const f = fixture(bot => { bot.entity.position = new Vec3(94.5, 63, -12.5) }, {
    './fortify': { leaveSealedCell: async (_session, _ctl, toward) => { broke.push({ toward }); return true } }
  })
  const feet = new Vec3(70, 63, -71)
  const solid = p => (p.y === 63 || p.y === 64) && Math.abs(p.x - feet.x) + Math.abs(p.z - feet.z) === 1 || (p.y === 65 && p.x === feet.x && p.z === feet.z)
  f.bot.blockAt = p => ({ position: p, name: solid(p) ? 'cobblestone' : 'air', boundingBox: solid(p) ? 'block' : 'empty' })
  const result = await f.goto({ x: 95, z: -12, range: 4, surface: 'strict' })
  assert.deepEqual(JSON.parse(JSON.stringify(broke)), [{ toward: { x: 95.5, z: -11.5 } }])
  assert.equal(result.arrived.x, 94)
})
