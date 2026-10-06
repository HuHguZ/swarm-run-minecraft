'use strict'
// Оценка хп противника-игрока без метаданных (src/pvp/hp-estimate.ts) и честность адаптера
// (src/pvp/combat-observe.ts): против игрока точное хп в решения не идёт.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { createHpEstimate, cdf, REGEN_FAST, REGEN_SLOW } = require('../src/pvp/hp-estimate')
const co = require('../src/pvp/combat-observe')

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`)

test('старт 20, подтверждённое попадание сужает снизу и сверху', () => {
  const h = createHpEstimate()
  assert.deepEqual([h.snapshot().lo, h.snapshot().hi, h.snapshot().conf], [20, 20, 1])
  h.hit({ min: 4, max: 6, mean: 5 })
  const s = h.snapshot()
  assert.deepEqual([s.lo, s.hi, s.mean], [14, 16, 15])
  near(s.conf, 0.9)
})

test('регенерация по голоду: верх 1/10, низ 1/80 за тик, не выше 20', () => {
  const h = createHpEstimate()
  h.hit({ min: 10, max: 10 })
  h.tick(40)
  const s = h.snapshot()
  near(s.hi, 10 + 40 * REGEN_FAST)
  near(s.lo, 10 + 40 * REGEN_SLOW)
  h.tick(200)
  assert.equal(h.snapshot().hi, 20)
})

test('неподтверждённый удар (его окно неуязвимости) опускает только низ', () => {
  const h = createHpEstimate()
  h.maybeHit(5)
  assert.deepEqual([h.snapshot().lo, h.snapshot().hi], [15, 20])
})

test('золотое яблоко: поглощение 4 (сначала оно), Регенерация II 100 тиков', () => {
  const h = createHpEstimate()
  h.hit({ min: 10, max: 10 })
  assert.equal(h.eat('golden_apple'), true)
  assert.equal(h.snapshot().absorption.hi, 4)
  h.hit({ min: 3, max: 3 })
  assert.deepEqual([h.snapshot().absorption.hi, h.snapshot().health.hi], [1, 10])
  // Регенерация II: +1 раз в 25 тиков, 100 тиков — +4 к обеим границам (сверх голода).
  h.tick(100)
  const s = h.snapshot()
  near(s.health.lo, 10 + 100 * REGEN_SLOW + 4)
  assert.equal(h.eat('bread'), false) // обычная еда сразу не лечит
})

test('тотем (статус 35): 1 хп + 8 поглощения, эффекты сняты', () => {
  const h = createHpEstimate()
  h.eat('enchanted_golden_apple')
  h.totem()
  const s = h.snapshot()
  assert.deepEqual([s.health.lo, s.health.hi, s.absorption.lo, s.absorption.hi, s.lo, s.hi, s.totems], [1, 1, 8, 8, 9, 9, 1])
  // Поглощение тотема — 100 тиков.
  h.tick(100)
  assert.equal(h.snapshot().absorption.hi, 0)
})

test('зелья: выпил лечение II — +8; брошенное рядом — только верх', () => {
  const h = createHpEstimate()
  h.hit({ min: 12, max: 12 })
  h.drink('strong_healing')
  assert.deepEqual([h.snapshot().lo, h.snapshot().hi], [16, 16])
  h.hit({ min: 8, max: 8 })
  h.splash('healing')
  assert.deepEqual([h.snapshot().lo, h.snapshot().hi], [8, 12])
})

test('распределение: кусочно-линейное через (lo, 0), (mean, ½), (hi, 1)', () => {
  const est = { lo: 4, hi: 12, mean: 6 }
  assert.equal(cdf(est, 3), 0)
  near(cdf(est, 5), 0.25)
  near(cdf(est, 6), 0.5)
  near(cdf(est, 9), 0.75)
  assert.equal(cdf(est, 12), 1)
  assert.equal(cdf({ lo: 5, hi: 5, mean: 5 }, 5), 1)
  assert.equal(cdf({ lo: 5, hi: 5, mean: 5 }, 4.9), 0)
})

// ---------------------------------------------------------------- адаптер

function fakeBot (foe) {
  const me = { id: 1, position: new Vec3(0, 0, 0), onGround: true, metadata: [], effects: {}, height: 1.8, width: 0.6 }
  const handlers: Record<string, any> = {}
  return {
    entity: me,
    health: 20,
    heldItem: { name: 'diamond_sword' },
    game: { difficulty: 'normal' },
    inventory: { items: () => [{ name: 'diamond_sword', count: 1 }], slots: [] },
    entities: { 1: me, [foe.id]: foe },
    on () {}, removeListener () {},
    _client: { on: (n, f) => { handlers[n] = f }, removeListener () {} },
    handlers
  }
}
const foePlayer = () => {
  const metadata = []
  metadata[9] = 3 // здоровье в метаданных — 3
  metadata[17] = 0
  return { id: 7, type: 'player', username: 'Foe', name: 'player', position: new Vec3(2, 0, 0), onGround: true, metadata, equipment: [], height: 1.8, width: 0.6 }
}

test('адаптер: против игрока хп — оценка, метаданные не читаются (без трекера — «не знаю»)', () => {
  const foe = foePlayer()
  const bot = fakeBot(foe)
  const o = co.observe(bot, foe)
  assert.equal(o.foe.player, true)
  assert.deepEqual([o.foe.hp.lo, o.foe.hp.hi, o.foe.hp.exact], [0, 20, false])
  // Телеметрия может читать точное — явно названной функцией.
  assert.equal(co.exactHpTelemetryOnly(bot, foe), 3)
  // Только для замеров сцены: honest:false.
  assert.equal(co.observe(bot, foe, { honest: false }).foe.hp.lo, 3)
})

test('адаптер: моб — точное хп; трекер: наше подтверждённое попадание и тотем', () => {
  const zombie = { id: 8, type: 'mob', name: 'zombie', position: new Vec3(2, 0, 0), metadata: [], equipment: [], height: 1.95, width: 0.6 }
  zombie.metadata[9] = 11
  const zb = fakeBot(zombie)
  assert.deepEqual([co.observe(zb, zombie).foe.hp.lo, co.observe(zb, zombie).foe.hp.exact], [11, true])

  const foe = foePlayer()
  const bot = fakeBot(foe)
  const T = co.trackFoe(bot, foe)
  T.noteAttack({ min: 5, max: 7, mean: 6, raw: 9 })
  bot.handlers.damage_event({ entityId: 7, sourceTypeId: 0, sourceCauseId: 2, sourceDirectId: 2 })
  let s = T.hp.snapshot()
  assert.deepEqual([s.lo, s.hi], [13, 15])
  assert.deepEqual(T.iframe, { raw: 9, at: 0 })
  bot.handlers.entity_status({ entityId: 7, entityStatus: 35 })
  s = T.hp.snapshot()
  assert.deepEqual([s.lo, s.hi, T.pops], [9, 9, 1])
  T.stop()
})
