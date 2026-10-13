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
    blockAt: p => ({ name: 'air', position: p, boundingBox: 'empty', shapes: [] }),
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

test('S7d: быстрая регенерация ограничена насыщением — за 60 с без попаданий верх не больше 20, а после ~13 хп — медленная', () => {
  const { createHpEstimate } = require('../src/pvp/hp-estimate')
  const e = createHpEstimate()
  e.hit({ min: 15, max: 15 }) // 5 хп
  e.tick(200) // 10 с: быстрая по насыщению до +13.3, не больше
  const s1 = e.snapshot()
  assert.ok(s1.hi <= 5 + 13.4 + 0.9, `верх ${s1.hi}`) // +13.3 быстрой, остаток 67 т — медленной (+0.8)
  // Бюджет исчерпан: ещё 10 с — только медленная (1/80 т) — +2.5.
  e.hit({ min: 10, max: 10 })
  const before = e.snapshot().hi
  e.tick(200)
  assert.ok(e.snapshot().hi - before <= 2.6, `${before} → ${e.snapshot().hi}`)
  // Видимая еда (золотое яблоко, насыщение 9.6) снова даёт быструю регенерацию.
  e.eat('golden_apple')
  const b2 = e.snapshot().hi
  e.tick(40)
  assert.ok(e.snapshot().hi - b2 > 3, 'после яблока — быстрая (и регенерация II)')
})

test('S7d: насыщение тратится только на лечение — минута на полном хп бюджет быстрой регенерации не съедает', () => {
  const { createHpEstimate } = require('../src/pvp/hp-estimate')
  const e = createHpEstimate()
  e.tick(1200) // 60 с без урона: верх у 20, лечить нечего
  near(e.snapshot().satHp, 20 / 1.5, 1e-6)
  e.hit({ min: 10, max: 10 })
  const b = e.snapshot().hi
  e.tick(40) // 2 с: быстрая — 4 хп
  assert.ok(e.snapshot().hi - b > 3.5, `${b} → ${e.snapshot().hi}`)
})

test('S7d (честность): его еда — только увиденная от начала до конца; щит/лук «опустил» — не еда', () => {
  const visionMod = require('../src/pvp/last-seen')
  const was = visionMod.seesPlayer
  let visible = true
  visionMod.seesPlayer = () => visible
  try {
    const foe: any = foePlayer()
    const bot: any = fakeBot(foe)
    bot.registry = require('minecraft-data')('1.21.11')
    let tick = null
    bot.on = (n, f) => { if (n === 'physicsTick') tick = f }
    const keys = bot.registry.entitiesByName.player.metadataKeys
    const FL = keys.indexOf('living_entity_flags') >= 0 ? keys.indexOf('living_entity_flags') : 8
    const T = co.trackFoe(bot, foe)
    const use = (item, n) => { foe.equipment = [{ name: item }]; foe.metadata[FL] = 1; for (let i = 0; i < n; i++) tick(); foe.metadata[FL] = 0; tick() }
    T.hp.hit({ min: 10, max: 10 })
    use('shield', 40) // опустил щит после 2 с — не еда
    assert.equal(T.seenApples, 0)
    visible = false
    use('golden_apple', 34) // ел за стеной — не знаю
    assert.equal(T.seenApples, 0)
    visible = true
    use('golden_apple', 34) // видел, как ел
    assert.equal(T.seenApples, 1)
    assert.ok(T.hp.snapshot().absorption.hi > 0, 'поглощение от увиденного яблока')
    T.stop()
  } finally { visionMod.seesPlayer = was }
})
