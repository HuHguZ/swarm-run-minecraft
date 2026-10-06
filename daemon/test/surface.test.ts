'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')

// Minecraft-физика на границе заменена шагами по одному блоку. Выбор способа,
// проверка опасных блоков и подсчёт инструмента — настоящие из survival.js.
async function climb ({ preferPillar, hazard = null, filler = true, pillarMoves = true }: any = {} as Record<string, any>) {
  const file = path.join(__dirname, '../src/survival.js')
  const realRequire = createRequire(file)
  const moves = { pillar: 0, stairs: 0, needs: [] }
  const bot = {
    entity: { position: new Vec3(0.5, 0, 0.5) }, health: 20, food: 20,
    game: { minY: -64, height: 384 }, inventory: { items: () => [] },
    nearestEntity: () => null,
    blockAt: pos => ({ name: hazard && pos.x === 0 && pos.z === 0 && pos.y >= 2 && pos.y <= 4 ? hazard : 'stone',
      position: pos, boundingBox: 'block' }),
    clearControlStates () {}, stopDigging () {}
  }
  const context = {
    module: { exports: {} as Record<string, any> }, console, setTimeout, setInterval, clearInterval, clearTimeout, Date,
    require: name => {
      const actual = realRequire(name)
      if (name === './build') return { ...actual, pickFiller: () => filler ? { name: 'cobblestone' } : null,
        digUp: async () => { moves.pillar++; if (pillarMoves) bot.entity.position.y++; return { dug: 1 } } }
      if (name === './items') return { ...actual, toolBudget: () => 1000,
        toolShortfall: (_bot, _data, p) => { moves.needs.push(p.need); return null } }
      if (name === './movement') return { ...actual, inWater: () => false }
      return actual
    }, bot, moves
  }
  vm.runInNewContext(require('./source-fixture').bodySource(process.env.SURVIVAL_TEST_SOURCE || file) + `
    pitCheck = () => ({ out: false, free: false }); openSky = () => false;
    seenBy = () => null; legLevels = () => 4;
    stairStep = async (_bot, _data, _ctl, feet, dir) => {
      moves.stairs++; bot.entity.position = feet.plus(dir).offset(0.5, 1, 0.5);
      return { ok: true, dug: 3 };
    };
    module.exports.testSurface = surface;
  `, context)
  const result = await context.module.exports.testSurface({ bot, mcData: {} as Record<string, any>, journal: { append () {} } }, { aborted: false, onAbort: [] },
    { targetY: 1, preferPillar, timeoutSeconds: 10 })
  return { moves, result }
}

test('быстрый подъём в сухой породе выбирает столб и считает один удар на уровень', async () => {
  const { moves, result } = await climb({ preferPillar: true })
  assert.equal(moves.pillar, 1)
  assert.equal(moves.stairs, 0)
  assert.equal(moves.needs[0], 5, 'четыре уровня плюс второй блок начального просвета')
  assert.equal(result.climbed, 1)
})

for (const hazard of ['lava', 'water', 'gravel']) {
  test(`быстрый подъём не вскрывает ${hazard} над головой`, async () => {
    const { moves } = await climb({ preferPillar: true, hazard })
    assert.equal(moves.pillar, 0)
    assert.equal(moves.stairs, 1)
  })
}

test('обычный подъём сохраняет лестницу и её расход инструмента', async () => {
  const { moves } = await climb()
  assert.equal(moves.pillar, 0)
  assert.equal(moves.stairs, 1)
  assert.ok(moves.needs[0] >= 16 && moves.needs[0] <= 17)
})

test('неудачная постановка столба переключается на лестницу', async () => {
  const { moves, result } = await climb({ preferPillar: true, pillarMoves: false })
  assert.equal(moves.pillar, 1)
  assert.equal(moves.stairs, 1)
  assert.equal(result.climbed, 1)
})

test('без строительных блоков быстрый подъём использует лестницу', async () => {
  const { moves } = await climb({ preferPillar: true, filler: false })
  assert.equal(moves.pillar, 0)
  assert.equal(moves.stairs, 1)
})

async function guardedPillar (dangerAfter) {
  const file = path.join(__dirname, '../src/build.js')
  const realRequire = createRequire(file)
  const moves = { digs: 0, jumps: 0 }
  const bot = { entity: { position: new Vec3(0.5, 0, 0.5) },
    blockAt: pos => ({ name: 'stone', boundingBox: 'block', position: pos }),
    dig: async () => { moves.digs++ } }
  const context = {
    module: { exports: {} as Record<string, any> }, console, setTimeout, Date, moves,
    require: name => {
      const actual = realRequire(name)
      if (name === './items') return { ...actual, equipBestTool: async () => {} }
      if (name === './movement') return { ...actual, sleep: async () => {} }
      return actual
    }
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    towerUp = async () => { moves.jumps++; return { placed: 1 }; };
    module.exports.testDigUp = digUp;
  `, context)
  const result = await context.module.exports.testDigUp(bot, { aborted: false }, {
    blocks: 1, guard: () => moves.digs >= dangerAfter ? { who: { name: 'zombie' }, dist: 5 } : null
  })
  return { moves, result }
}

test('столб не начинает копать, если моб уже подошёл', async () => {
  const { moves, result } = await guardedPillar(0)
  assert.equal(moves.digs, 0)
  assert.equal(moves.jumps, 0)
  assert.ok(result.stopped)
})

test('моб, подошедший за время копки, отменяет следующий блок и прыжок', async () => {
  const { moves, result } = await guardedPillar(1)
  assert.equal(moves.digs, 1)
  assert.equal(moves.jumps, 0)
  assert.ok(result.stopped)
})
