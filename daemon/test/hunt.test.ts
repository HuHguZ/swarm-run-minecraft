'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')

async function hunt ({ name = 'cow', distance = 14, dead = true, clearArea }: any = {} as Record<string, any>) {
  const file = path.join(__dirname, '../src/combat.js')
  const realRequire = createRequire(file)
  const entity = { name, position: new Vec3(distance, 65, 0), isValid: true }
  const items = []
  const calls: Record<string, any> = { loot: 0, pickupClosed: 0 }
  const bot = { health: 20, entity: { position: new Vec3(0, 65, 0) }, inventory: { items: () => items } }
  const context = { module: { exports: {} as Record<string, any> }, console, setTimeout, clearTimeout, Date,
    require: n => {
      const actual = realRequire(n)
      if (n === './movement') return { ...actual, inWater: () => false }
      if (n === './items') return { ...actual, bestWeapon: () => null }
      if (n === './combat-safety') return { ...actual, safeGround: () => true }
      if (n === './tempo') return { ...actual, track: (_b, options) => {
        assert.deepEqual(Array.from(options.threats()), [])
        return { safe: () => ({ ok: true }), close: () => { calls.pickupClosed++ } }
      } }
      if (n === './pvp') return { ...actual, duel: async (_s, _c, _e, p) => {
        calls.clearArea = p.clearArea
        return { kills: dead ? [name] : [] }
      } }
      if (n === './actions') return { ...actual, collectNearbyDrops: async (_b, _c, p) => {
        assert.equal(p.canContinue(), true, 'isolated safe pickup must honour the continuation contract')
        calls.loot++; calls.radius = p.radius
        if (p.radius >= distance) items.push({ name: 'beef', count: 1 })
      } }
      return actual
    }, entity }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    findTarget = () => entity;
    dressForFight = async () => ({}); countHostiles = () => 0;
    corridorShape = () => ({ corridor: false });
    module.exports.testFight = fightBody;
  `, context)
  const result = await context.module.exports.testFight({ bot }, { aborted: false }, { target: name, clearArea },
    // Эти тесты изолируют подбор; решение о риске проверяется отдельно.
    { watch () {}, sawMobs () {}, wear: async () => {}, safety: { check: () => ({ action: 'fight', threats: [] }) } })
  assert.equal(calls.pickupClosed, calls.loot, 'pickup observer closes for each collection')
  return { result, calls }
}

test('охота подбирает мясо животного, убитого луком дальше восьми блоков', async () => {
  const { result, calls } = await hunt()
  assert.ok(calls.radius >= 14, 'дроп у убитой коровы должен попасть в радиус подбора')
  assert.equal(result.picked, 1)
})

test('после животного бой не переключается на соседних врагов до подбора мяса', async () => {
  const { calls } = await hunt()
  assert.equal(calls.clearArea, 0, 'одна охота не заказывает зачистку площадки вокруг животного')
})

test('обычный бой сохраняет зачистку и прежний радиус подбора', async () => {
  const { calls } = await hunt({ name: 'zombie', distance: 5 })
  assert.equal(calls.clearArea, 10)
  assert.equal(calls.radius, 8)
})

test('явный заказ зачистки соблюдается и при животном', async () => {
  const { calls } = await hunt({ clearArea: 20 })
  assert.equal(calls.clearArea, 20)
})

test('неподтверждённое убийство не запускает сбор добычи', async () => {
  const { calls } = await hunt({ dead: false })
  assert.equal(calls.loot, 0)
})
