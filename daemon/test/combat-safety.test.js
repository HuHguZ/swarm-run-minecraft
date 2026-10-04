'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluate, inspect, watch, disengage, recover } = require('../src/combat-safety')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')

const ready = { health: 20, food: 20, foodPoints: 18, weapon: true, threats: [{ hit: 4.8, distance: 2 }] }

test('пара железных вещей, меч, щит и обычная еда достаточны: полный комплект не требуется', () => {
  assert.equal(evaluate({ ...ready, phase: 'start' }).action, 'fight')
})
test('11.5 HP против удара 4.8: сначала отход, даже если враг вплотную', () => {
  const r = evaluate({ ...ready, health: 11.5 })
  assert.equal(r.action, 'recover')
  assert.ok(r.threshold > 11.5)
})
test('пришедший второй враг меняет решение до последних сердец', () => {
  assert.equal(evaluate({ ...ready, health: 15 }).action, 'fight')
  assert.equal(evaluate({ ...ready, health: 15, threats: [...ready.threats, { hit: 4.8, distance: 2 }] }).action, 'recover')
})
test('реальный сильный удар пересчитывает запас здоровья', () => {
  assert.equal(evaluate({ ...ready, health: 14, observedHit: 6 }).action, 'recover')
})
test('нет еды для регена или оружия — добровольный бой не начинается', () => {
  assert.equal(evaluate({ ...ready, phase: 'start', food: 13, foodPoints: 0 }).action, 'leave')
  assert.equal(evaluate({ ...ready, phase: 'start', weapon: false }).action, 'leave')
})
test('когда запас еды кончился в проигрываемом бою, нужно уходить полностью', () => {
  assert.equal(evaluate({ ...ready, health: 11, food: 15, foodPoints: 0 }).action, 'leave')
})
test('одна долька при сытости 15 не позволяет восстановить здоровье', () => {
  assert.equal(evaluate({ ...ready, food: 15, foodPoints: 2, phase: 'start' }).action, 'leave')
  assert.equal(evaluate({ ...ready, food: 15, foodPoints: 8, phase: 'start' }).action, 'recover')
})
test('мирная охота за едой разрешена с пустым запасом еды', () => {
  assert.equal(evaluate({ ...ready, food: 8, foodPoints: 0, weapon: false, threats: [], phase: 'start' }).action, 'fight')
})
test('мёртвое тело не начинает отход или лечение', () => {
  assert.equal(evaluate({ ...ready, health: 0 }).action, 'dead')
})
test('невозможный размен не превращается в бесконечное лечение до полного здоровья', () => {
  assert.equal(evaluate({ ...ready, threats: Array(4).fill({ hit: 7, distance: 2 }) }).action, 'leave')
})
test('зелье не разрешает атаковать толпу, которую нельзя пережить', () => {
  assert.equal(evaluate({ ...ready, instantHeal: true, threats: Array(4).fill({ hit: 7, distance: 2 }) }).action, 'leave')
})

function body (items = []) {
  const bot = new EventEmitter()
  Object.assign(bot, { version: '1.21.11', health: 20, food: 20, entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: {}, inventory: { items: () => items, slots: Array(46).fill(null) },
    blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }),
    pathfinder: { setGoal () {} }, clearControlStates () {} })
  return bot
}
test('еда оценивается по питательности реестра; ведро с рыбой и опасная еда не считаются запасом', () => {
  const b = body([{ name: 'melon_slice', count: 9 }, { name: 'cooked_mutton', count: 1 },
    { name: 'cod_bucket', count: 1 }, { name: 'rotten_flesh', count: 64 }])
  assert.equal(inspect(b).foodPoints, 24)
})
test('фактическая броня и ближний урон ифрита дают запас на два удара', () => {
  const b = body([{ name: 'iron_sword', count: 1, maxDurability: 250, durabilityUsed: 4 }])
  b.inventory.slots[6] = { name: 'iron_chestplate' }
  b.inventory.slots[8] = { name: 'iron_boots' }
  const e = { id: 2, name: 'blaze', isValid: true, position: new Vec3(0, 64, 2) }
  b.entities[e.id] = e
  b.health = 11.5
  const r = inspect(b, { target: e })
  assert.equal(r.action, 'recover')
  assert.equal(r.threats[0].hit, 4.8)
})
test('наблюдатель урона учитывает здоровье, затем снимает свой обработчик', () => {
  const b = body()
  const w = watch(b)
  b.health = 14; b.emit('health')
  assert.equal(w.hit(), 6)
  w.close()
  assert.equal(b.listenerCount('health'), 0)
})
test('подготовка проверяется и до сближения с далёким врагом', () => {
  const b = body()
  const e = { id: 2, name: 'blaze', isValid: true, position: new Vec3(0, 64, 24) }
  assert.equal(inspect(b, { target: e, phase: 'start' }).reason, 'нет пригодного оружия')
})
test('сначала разорвать дистанцию, затем разрешить лечение; не выдавать неудачный отход за успех', async () => {
  const b = body()
  const enemy = { id: 2, name: 'blaze', isValid: true, position: new Vec3(0, 64, 2) }
  const calls = []
  const ctl = { aborted: false }
  const r = await disengage({ bot: b }, ctl, () => [enemy], {
    kite: async () => { calls.push('run'); enemy.position = new Vec3(0, 64, 12); return 'оторвался' }
  })
  assert.equal(r.clear, true)
  assert.deepEqual(calls, ['run'])
  enemy.position = new Vec3(0, 64, 2)
  const trapped = await disengage({ bot: b }, ctl, () => [enemy], { kite: async () => 'некуда' })
  assert.equal(trapped.clear, false)
})
test('общий отдых не ест при незакрытой линии огня и не считает таймаут лечением', async () => {
  const b = body(); b.health = 10; b.food = 15
  let bites = 0
  const ctl = { aborted: false }
  const unsafe = await recover({ bot: b }, ctl, { safe: () => false, eat: async () => { bites++ } })
  assert.equal(unsafe.rested, false)
  assert.equal(bites, 0)
  const timeout = await recover({ bot: b }, ctl, { safe: () => true, maxMs: 0 })
  assert.equal(timeout.rested, false)
})
test('общий отдых пропускает уже здоровое тело и подтверждает фактическое восстановление', async () => {
  const b = body()
  let bites = 0
  const r = await recover({ bot: b }, { aborted: false }, { safe: () => true, eat: async () => { bites++ } })
  assert.equal(r.rested, true)
  assert.equal(bites, 0)
})
test('закрытая от врага точка в лаве не является безопасным местом лечения', async () => {
  const b = body()
  b.blockAt = () => ({ name: 'lava', boundingBox: 'empty' })
  const r = await recover({ bot: b }, { aborted: false }, { safe: () => true, maxMs: 0 })
  assert.equal(r.rested, false)
  assert.equal(r.hazard, true)
})
test('отход не останавливается в лаве, даже когда враги уже за стеной', async () => {
  const b = body()
  let lava = true; let runs = 0
  b.blockAt = p => ({ name: lava && p.y === 64 ? 'lava' : p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' })
  const r = await disengage({ bot: b }, { aborted: false }, () => [], {
    kite: async () => { runs++; lava = false; return 'оторвался' }
  })
  assert.equal(runs, 1)
  assert.equal(r.clear, true)
})

test('ND_FIGHT_COST: дешёвый по расчёту бой (один зомби, 20 хп, меч) — и без еды; дорогой и без флага — уход', () => {
  const zombie = { ...ready, food: 15, foodPoints: 0, threats: [{ name: 'zombie', hit: 3, distance: 3 }], phase: 'start' }
  const was = process.env.ND_FIGHT_COST
  try {
    process.env.ND_FIGHT_COST = '0'
    assert.equal(evaluate({ ...zombie, expected: 2 }).action, 'leave')
    process.env.ND_FIGHT_COST = '1'
    const r = evaluate({ ...zombie, expected: 2 })
    assert.equal(r.action, 'fight')
    assert.equal(r.cheap, true)
    assert.equal(evaluate({ ...zombie, expected: 6 }).action, 'leave')
    assert.equal(evaluate({ ...zombie, health: 12, expected: 2 }).action, 'leave')
    assert.equal(evaluate({ ...zombie, weapon: false, expected: 2 }).action, 'leave')
    assert.equal(evaluate({ ...zombie, threats: [{ name: 'creeper', hit: 22, distance: 3 }], expected: 1 }).action, 'leave')
    assert.equal(evaluate({ ...zombie, threats: [{ name: 'blaze', hit: 3, distance: 3 }], expected: 1 }).action, 'leave', 'ифриты — не «дёшево»')
  } finally { if (was === undefined) delete process.env.ND_FIGHT_COST; else process.env.ND_FIGHT_COST = was }
})

test('ND_FIGHT_COST: крипер, ведьма, утопленник или трое — не «дёшево»; зомби с мечом бьёт сильнее', () => {
  const was = process.env.ND_FIGHT_COST
  try {
    process.env.ND_FIGHT_COST = '1'
    const base = { ...ready, food: 15, foodPoints: 0, phase: 'start', expected: 1 }
    assert.equal(evaluate({ ...base, threats: [{ name: 'drowned', hit: 3, distance: 3 }] }).action, 'leave')
    assert.equal(evaluate({ ...base, threats: [{ name: 'witch', hit: 3, distance: 3 }] }).action, 'leave')
    assert.equal(evaluate({ ...base, threats: [{ name: 'zombie', hit: 1, distance: 3 }, { name: 'zombie', hit: 1, distance: 4 }, { name: 'zombie', hit: 1, distance: 5 }] }).action, 'leave')
    assert.equal(evaluate({ ...base, threats: [{ name: 'zombie', hit: 3, distance: 3 }] }).action, 'fight')
    // Зомби с деревянным мечом (удар 6): порог 14, 14 + 2.5 × 3 > 20 — уход.
    assert.equal(evaluate({ ...base, expected: 3, threats: [{ name: 'zombie', hit: 6, distance: 3 }] }).action, 'leave')
  } finally { if (was === undefined) delete process.env.ND_FIGHT_COST; else process.env.ND_FIGHT_COST = was }
})
