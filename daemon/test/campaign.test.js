'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { withClockFixture } = require('./clock-fixture')
const pack = require('../src/pack')

test('возобновление кампании сохраняет выработанный бастион и выбирает следующий', async () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 300, y: 20, z: 150 },
    inventory: { iron_pickaxe: 1, blaze_rod: 7, ender_pearl: 2 } }
  const places = {
    'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' },
    'бастион (ад)': { x: 100, y: 40, z: 80, dimension: 'the_nether' },
    'бастион 2 (ад)': { x: 700, y: 45, z: 300, dimension: 'the_nether' },
    'выработан: бастион (ад)': { x: 94, y: 40, z: 120, dimension: 'the_nether', note: 'Бартер завершён' }
  }
  const c = campaign(state, {}, method => method === 'recall' ? { state: { places } } : {})
  await c.readMemory()
  assert.equal(c.nextBastion().key, 'бастион 2 (ад)', 'после перезапуска не идёт обратно в уже выработанный бастион')
  // Запись от другого мира или перемещённого места не должна сдавать новый бастион.
  places['бастион (ад)'].x = 2000
  const fresh = campaign(state, {}, method => method === 'recall' ? { state: { places } } : {})
  await fresh.readMemory()
  assert.equal(fresh.nextBastion().key, 'бастион (ад)')
})

// Настоящие функции кампании, внешняя граница — RPC вместо живого Minecraft.
// Загрузчик не открывает сокет, не пишет журнал и не запускает кампанию сам.
// Часы кампании для тестов политики повторов: Date.now() — clock.t, «ожидание» двигает его вперёд.
function fakeDate (clock) { return class extends Date { static now () { return clock.t } } }

function campaign (state, situation, handle = () => ({}), { logs = null, env = {}, argv = [], clock = null, onStatus = null } = {}) {
  class Socket {
    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method, params } = JSON.parse(raw)
      const detail = method === 'situation' ? situation : method === 'status' ? ((onStatus && onStatus()) || {}) : handle(method, params)
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({
        id, ok: true, result: detail?.rpcResult || { status: 'done', detail, state, events: [] }
      })))
    }
    close () {}
  }
  const context = {
    require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync (file, line) { if (logs) logs.push(String(line)) } } : require(name),
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
    process: { argv: ['node', 'campaign.js', ...argv], env },
    console: { log () {}, error () {} }, setTimeout, Date: clock ? fakeDate(clock) : Date, queueMicrotask
  }
  vm.runInNewContext(fs.readFileSync(process.env.CAMPAIGN_TEST_SOURCE || path.join(__dirname, '../campaign.js'), 'utf8') + `
    module.exports = { act, refresh, readMemory, nextBastion, viaNetherTo, died: () => died, stage: name => { stage = name }, craft, nightGuard, rest, eatTo, recoverGuard, descend, goToward, returnFromNether, spares, toSurface, unclutter, smeltAll, lightUp, known, makeBed,
      fightReady: () => fightReady(), gearWorth: (item, o) => gearWorth(item, o), wantFightGear: () => { fightGearWanted = true },
      runStage: name => STAGES.find(s => s.name === name).run(),
      needs: name => STAGES.find(s => s.name === name).needed(),
      ready: name => STAGES.find(s => s.name === name).ready(),
      defers: name => STAGES.find(s => s.name === name).defer(),
      boot: () => ws.listeners.get('open')(),
      keepStages: names => { const keep = STAGES.filter(s => names.includes(s.name)); STAGES.splice(0, STAGES.length, ...keep) },
      ironOnly: run => { STAGES.splice(0, STAGES.length, { name: 'iron', needed: () => !have(PICK_IRON),
        ready: () => true, defer: () => false, done: () => have(PICK_IRON) > 0, run }); },
      hooks: h => { if (h.spares) spares = h.spares; if (h.ensurePick) ensurePick = h.ensurePick;
        if (h.recoverGuard) recoverGuard = h.recoverGuard; if (h.toSurface) toSurface = h.toSurface; },
      init: () => { state = testState; sit = testSituation; }
    }
  `, withClockFixture(Object.assign(context, { testState: state, testSituation: situation })))
  context.module.exports.init()
  return context.module.exports
}

test('восстановление здоровья во время еды прекращает ненужное строительство норы', async () => {
  const state = { health: 6, food: 17, dimension: 'overworld', pos: { x: -83, y: 75, z: 0 },
    inventory: { stone_pickaxe: 1, melon_slice: 9 } }
  const calls = []
  const c = campaign(state, { night: true, foes: 0 }, method => {
    calls.push(method)
    if (method === 'eat') { state.health = 20; state.food = 20 }
    return { sealed: false }
  })
  await c.rest()
  assert.equal(calls.includes('eat'), true)
  assert.equal(calls.includes('shelter'), false)
  assert.equal(calls.includes('wait'), false)
})

test('ночной сон с восстановленным здоровьем не запускает строительство норы', async () => {
  const state = { health: 6, food: 18, dimension: 'overworld', pos: { x: -83, y: 75, z: 0 },
    inventory: { stone_pickaxe: 1 } }
  const situation = { night: true, foes: 0, bed: true }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'sleep') { state.health = 20; state.food = 20; situation.night = false }
    return { sealed: false }
  })
  await c.rest()
  assert.equal(calls.includes('sleep'), true)
  assert.equal(calls.includes('shelter'), false)
})

test('перед дорогой к спавнеру и боем слабые порции доводят сытость до лечения', async () => {
  const state = { health: 16, food: 13, dimension: 'the_nether', pos: { x: -300, y: 64, z: -150 },
    armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'iron_helmet' }, offHand: { item: 'shield' },
    inventory: { iron_pickaxe: 1, iron_sword: 1, melon_slice: 20, blaze_rod: 3 } }
  const calls = []
  const c = campaign(state, { foes: 0, surface: false }, method => {
    calls.push(method)
    if (method === 'eat') { state.food += 2; state.inventory.melon_slice--; return { ate: 'melon_slice' } }
    if (method === 'fortress') {
      assert.ok(state.food >= 18, 'до длинного маршрута должен начаться реген здоровья')
      state.food = 15
      return { reached: true, spawner: { x: -404, y: 70, z: -200 }, dist: 3 }
    }
    if (method === 'blaze') {
      assert.ok(state.food >= 18, 'одна долька даёт только17: до боя нужна ещё одна')
      state.inventory.blaze_rod = 7
    }
    return {}
  })
  c.known.portal = { x: -19, y: 65, z: -24 }
  c.known.fortress = true
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('nether')
  assert.equal(calls.filter(x => x === 'eat').length, 5)
  assert.equal(state.inventory.blaze_rod, 7)
})

test('отказ еды без роста сытости не запускает повторные укусы', async () => {
  const state = { health: 20, food: 13, inventory: { melon_slice: 9 } }
  let attempts = 0
  const c = campaign(state, { foes: 0 }, method => { if (method === 'eat') attempts++; return {} })
  assert.equal(await c.eatTo(18), false)
  assert.equal(attempts, 1)
})

test('сохранённый рюкзак после смерти не начинает новый этап до возрождения', async () => {
  const state = { health: 0, food: 17, inventory: { stone_pickaxe: 1, melon_slice: 9, blaze_rod: 3 } }
  const calls = []
  const c = campaign(state, { foes: 0 }, method => {
    calls.push(method)
    if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'death' }, state } }
    return {}
  })
  c.stage('nether')
  await assert.rejects(c.act('mine'), /умер/)
  const timer = setTimeout(() => { state.health = 20; state.food = 20 }, 100)
  try {
    await c.recoverGuard()
    assert.equal(state.health, 20, 'наличие вещей не заменяет подтверждение живого тела')
    assert.equal(calls.some(x => /sleep|shelter|eat/.test(x)), false)
  } finally { clearTimeout(timer) }
})

function inventoryBot (inventory) {
  const slots = Array(46).fill(null)
  let slot = 9
  for (const [name, count] of Object.entries(inventory)) {
    for (let remaining = count; remaining > 0;) {
      const n = Math.min(64, remaining)
      slots[slot] = { name, count: n, slot: slot++ }
      remaining -= n
    }
  }
  return {
    inventory: { slots, items: () => slots.filter(Boolean), emptySlotCount: () => slots.slice(9, 45).filter(x => !x).length },
    async tossStack (item) { slots[item.slot] = null; inventory[item.name] -= item.count; if (!inventory[item.name]) delete inventory[item.name] }
  }
}

test('ночное восстановление использует близкую кровать до ожидания в норе', async () => {
  const state = { health: 6, food: 17, dimension: 'overworld', pos: { x: -85, y: 72, z: 0 },
    inventory: { iron_pickaxe: 1, cobblestone: 32 } }
  const situation = { night: true, surface: false, foes: 0, bed: false }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push({ method, params })
    if (method === 'recall') return { state: { places: { 'точка возрождения': { x: -84, y: 75, z: 0 } } } }
    if (method === 'sleep') { situation.night = false; return { morning: true } }
    if (method === 'shelter') return { sealed: true }
    if (method === 'wait') situation.night = false
    return {}
  })
  await c.rest()
  assert.equal(calls.filter(x => x.method === 'sleep').length, 1)
  assert.equal(calls.some(x => x.method === 'wait'), false, 'сон быстрее бесполезного лечения на сытости 17')
  const sleep = calls.find(x => x.method === 'sleep').params
  assert.equal(sleep.take, false, 'кровать возрождения остаётся стоять')
  assert.equal(sleep.bunker, false, 'при отказе возвращаемся в готовую нору')
})

test('видимые арбузы дают еду до пустой прогулки за животными', async () => {
  const state = { health: 20, food: 16, dimension: 'overworld', biome: 'jungle', pos: { x: 0, y: 70, z: 0 },
    inventory: { stone_pickaxe: 1, stone_axe: 1, oak_planks: 30, white_bed: 1 } }
  const calls = []
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    calls.push({ method, params })
    if (method === 'observe') return { entities: [], blocks: [{ name: 'melon', dist: 12, nearest: { x: 12, y: 70, z: 0 } }] }
    // Запас — по сытости: 27 долек = 9 кусков (8 нужно); 9 долек — лишь 3.
    if (method === 'mine' && params.block === 'melon') { state.inventory.melon_slice = 27; return { dug: 5 } }
    return {}
  })
  c.hooks({ recoverGuard: async () => {}, toSurface: async () => true })
  await c.runStage('food')
  assert.equal(calls.filter(x => x.method === 'mine' && x.params.block === 'melon').length, 1)
  assert.equal(calls.some(x => x.method === 'goto'), false)
  assert.equal(c.needs('food'), false)
})

test('достаточный запас прочности не расходует дерево на ненужные палки', async () => {
  const state = { health: 20, food: 20, inventory: { oak_planks: 8, crafting_table: 1, iron_pickaxe: 2 } }
  const calls = []
  const c = campaign(state, { pickLeft: 400, free: 12 }, (method, params) => {
    calls.push([method, params])
    if (method === 'craft') state.inventory[params.item] = params.count || 1
    return {}
  })
  await c.spares(200)
  assert.equal(calls.filter(([method]) => method === 'craft').length, 0)
})

test('разгрузка кампании оставляет один переносной верстак и одну печь', async () => {
  let caps
  const c = campaign({ health: 20, food: 20, dimension: 'overworld', inventory: {} }, { free: 0 }, (method, params) => {
    if (method === 'pack') caps = params.also
    return {}
  })
  await c.unclutter()
  assert.match(caps, /crafting_table:1(?:,|$)/)
  assert.match(caps, /furnace:1(?:,|$)/)
})

for (const surface of [true, false]) test(`здоровый бот без угроз продолжает ночную работу, поверхность=${surface}`, async () => {
  const state = { health: 20, food: 18, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 32 } }
  const situation = { night: true, surface, foes: 0 }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'wait') situation.night = false
    return { sealed: true }
  // ND_NIGHT_DOWN=1 — мягкий уровень (меч наверху ночью можно); по умолчанию 2 — ночью наверху вниз (test/survival-night).
  }, { env: { ND_NIGHT_DOWN: '1' } })
  await c.nightGuard()
  assert.equal(calls.includes('wait'), false)
  assert.equal(calls.includes('shelter'), false)
})

test('еда полна без кровати — этап еды не нужен, и сборы за кроватью не охотятся (путь спидраннеров, 30.09)', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 2, y: 64, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, oak_log: 4, cooked_beef: 8, shield: 1, flint_and_steel: 1 } }
  const places = { 'портал': { x: 0, y: 64, z: 0, dimension: 'overworld' } }
  const calls = []
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    calls.push({ method, params })
    if (method === 'recall') return { state: { places } }
    if (method === 'observe') return { entities: [{ name: 'sheep', dist: 3, pos: { x: 3, y: 64, z: 0 } }] }
    if (method === 'fight') state.inventory.white_wool = 3
    if (method === 'craft') {
      state.inventory[params.item] = params.count || 1
      if (params.item === 'white_bed') delete state.inventory.white_wool
    }
    if (method === 'sleep' && params.mode === 'spawn') places['точка возрождения'] = { x: 1, y: 64, z: 1, dimension: 'overworld' }
    return {}
  })
  c.hooks({ recoverGuard: async () => {}, toSurface: async () => true })
  await c.readMemory()
  assert.equal(c.needs('food'), false, 'восемь кусков еды — запас набран, кровать тут ни при чём')
  // Решение пользователя 30.09: в Ад — кирка, ведро, еда; охота за шерстью на кровать — не условие входа.
  assert.equal(c.needs('prep'), false, 'огниво и еда есть — сборы не нужны')
  // Шерсть в рюкзаке уже есть — кровать делается попутно, без охоты.
  state.inventory.white_wool = 3
  state.inventory.shield = 0
  state.inventory.iron_ingot = 1
  assert.equal(c.needs('prep'), true, 'слиток в рюкзаке — щит сборов почти даром')
  await c.runStage('prep')
  assert.equal(calls.filter(x => x.method === 'fight').length, 0, 'за шерстью не охотится')
  assert.equal(state.inventory.white_bed, 1)
  assert.equal(state.inventory.shield, 1, 'щит — из слитка в рюкзаке')
})
test('древесный уголь на факелы получает место в рюкзаке до загрузки печки', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', inventory: { oak_log: 6, oak_planks: 4, furnace: 1, torch: 1 } }
  const situation = { free: 0 }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'pack') situation.free = 4
    if (method === 'smelt') {
      assert.ok(situation.free > 0, 'уголь не должен остаться в полной печке')
      state.inventory.charcoal = 2
    }
    if (method === 'craft') state.inventory.torch = 9
    return {}
  })
  await c.lightUp()
  assert.ok(calls.indexOf('pack') < calls.indexOf('smelt'))
})

test('крафт освобождает место до расхода материалов, а не повторяет потерянный результат', async () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', inventory: { cobblestone: 64, stick: 64, crafting_table: 1, netherrack: 2112 } }
  const situation = { free: 0 }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'pack') situation.free = 8
    if (method === 'craft') {
      assert.ok(situation.free > 0, 'полный рюкзак выбрасывает новый инструмент на землю')
      state.inventory.stone_pickaxe = 1
    }
    return {}
  })
  assert.equal(await c.craft('stone_pickaxe'), true)
  assert.ok(calls.indexOf('pack') < calls.indexOf('craft'))
  assert.equal(calls.filter(x => x === 'craft').length, 1)
})

test('вход в Ад — кирка и еда без брони; бой у спавнера после износа щита или брони требует восстановления', () => {
  const state = { health: 20, food: 20, armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'iron_helmet' }, inventory: { stone_pickaxe: 1, stone_sword: 1, shield: 1, cooked_beef: 8 } }
  const c = campaign(state, {})
  assert.equal(c.ready('nether'), true)
  assert.equal(c.fightReady(), true)
  delete state.inventory.shield
  assert.equal(c.ready('nether'), true, 'в Ад — без щита (путь спидраннеров)')
  assert.equal(c.fightReady(), false, 'сытость не заменяет щит от шаров')
  state.inventory.shield = 1
  state.armor = {}
  assert.equal(c.ready('nether'), true, 'в Ад — без брони')
  assert.equal(c.fightReady(), false, 'каменная кирка не заменяет броню у спавнера')
  state.armor.torso = 'iron_chestplate'
  state.inventory.cooked_beef = 1
  assert.equal(c.ready('nether'), false, 'запас лечения должен пережить Ад')
})

test('смена измерения на обратном пути прекращает маршрут и не отправляет домой через портал повторно', async () => {
  const state = { health: 13, food: 20, dimension: 'the_nether', pos: { x: -400, y: 70, z: -200 }, inventory: { stone_pickaxe: 2, blaze_rod: 2 } }
  const calls = []
  const c = campaign(state, { free: 10 }, method => {
    calls.push(method)
    if (method === 'goto') { state.dimension = 'overworld'; state.pos = { x: -7, y: 67, z: 1 } }
    return {}
  })
  c.known.netherPortal = { x: 4, y: 69, z: 4 }
  assert.equal(await c.returnFromNether(), true)
  assert.equal(calls.filter(x => x === 'goto').length, 1)
  assert.equal(calls.includes('portal'), false, 'возрождение/переход уже вернул в верхний мир')
  assert.equal(state.inventory.blaze_rod, 2)
})

test('кровать пропускает ночь также под крышей, без многоминутного ожидания', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 61, z: 0 }, inventory: { white_bed: 1 } }
  const situation = { night: true, surface: false }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'sleep' || method === 'wait') situation.night = false
    return method === 'sleep' ? { woke: true } : {}
  })
  await c.nightGuard()
  assert.equal(calls.includes('sleep'), true)
  assert.equal(calls.includes('wait'), false)
})

test('две неудачные норы не отключают бота: РИСК в журнал, без ожидания на улице, повторная нора не копается сразу', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 },
    inventory: { stone_pickaxe: 1, cobblestone: 16 } }
  const calls = []
  const logs = []
  const c = campaign(state, { night: true, surface: true }, (method, params) => {
    calls.push({ method, params })
    if (method === 'shelter') return { sealed: false, stopped: 'яма не углубляется' }
    return {}
  }, { logs })
  await c.nightGuard()
  assert.equal(calls.filter(x => x.method === 'wait').length, 0, 'неподтверждённая нора не является ночлегом')
  assert.equal(calls.filter(x => x.method === 'shelter' && x.params.mode === 'enter').length, 2)
  assert.equal(calls.filter(x => x.method === 'stop').length, 0, 'неудачная нора не останавливает кампанию')
  assert.equal(calls.filter(x => x.method === 'disconnect').length, 0, 'неудачная нора не отключает тело')
  assert.match(logs.join(''), /РИСК укрытие:NIGHT/)
  await c.nightGuard()
  assert.equal(calls.filter(x => x.method === 'shelter' && x.params.mode === 'enter').length, 2, 'та же яма сразу снова не копается')
})
test('ночное ожидание начинается после закрытия второй норы', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 },
    inventory: { stone_pickaxe: 1, cobblestone: 16 } }
  const situation = { night: true, surface: true }
  const calls = []
  let enters = 0
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'shelter' && params.mode === 'enter') return { sealed: ++enters === 2 }
    if (method === 'wait') {
      assert.equal(enters, 2)
      situation.night = false
    }
    return {}
  // Прежнее ожидание в норе — при ND_NIGHT_DOWN=0 (по умолчанию нора — вход вниз, без ожидания: test/survival-night).
  }, { env: { ND_NIGHT_DOWN: '0' } })
  await c.nightGuard()
  assert.equal(calls.filter(x => x === 'wait').length, 1)
  assert.equal(calls.includes('disconnect'), false)
})

test('неудачное укрытие в воде не запускает лечение ожиданием и не отключает бота', async () => {
  const state = { health: 8, food: 20, dimension: 'overworld', pos: { x: 618, y: 59, z: -60 },
    inventory: { stone_pickaxe: 1, cobblestone: 16 } }
  const calls = []
  const logs = []
  const c = campaign(state, { inWater: true, surface: false, foes: 0, night: true }, (method, params) => {
    calls.push({ method, params })
    if (method === 'shelter') return { sealed: false, stopped: 'я в воде — тут не окопаешься' }
    if (method === 'surface') return { out: false, stopped: 'всплыть некуда — каменный потолок' }
    if (method === 'goto') return { rpcResult: { status: 'failed', error: 'No path', state, events: [] } }
    return {}
  }, { logs })
  await c.rest()
  assert.equal(calls.some(x => x.method === 'wait'), false, 'ожидание в воде тратит воздух вместо лечения')
  assert.equal(calls.some(x => x.method === 'surface'), true, 'перед лечением нужно выйти из воды')
  assert.equal(calls.filter(x => x.method === 'goto').length, 2, 'не всплыл — к берегу, два отрезка')
  assert.equal(calls.some(x => x.method === 'shelter'), false, 'в воде копать нору нельзя')
  assert.equal(calls.some(x => x.method === 'disconnect'), false, 'не отключается')
  assert.match(logs.join(''), /РИСК укрытие:WATER/)
})
test('отказ отхода от воды прекращает спуск вместо повторной копки той же ямы', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 621, y: 64, z: -53 },
    inventory: { stone_pickaxe: 1, cobblestone: 16, crafting_table: 1, oak_log: 8 } }
  let digs = 0
  const c = campaign(state, { surface: true, pickLeft: 300 }, method => {
    if (method === 'dig_down') { digs++; return { stopped: 'вода у 621,62,-54 — дальше не копаю' } }
    if (method === 'goto') return { rpcResult: { status: 'failed', error: 'No path', state, events: [] } }
    return {}
  })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await assert.rejects(c.descend(16), /воды/)
  assert.equal(digs, 1, 'failed отход не разрешает ещё семь спусков в ту же воду')
})

test('восстановление у существующего портала пополняет дерево до поломки последних кирок', () => {
  const state = { health: 19, food: 17, inventory: { stone_pickaxe: 2, stone_axe: 1, blaze_rod: 2 } }
  const c = campaign(state, {})
  c.known.portal = { x: -19, y: 65, z: -24 }
  assert.equal(c.needs('wood'), true, 'без дерева нельзя восстановить щит или переплавить железо')
  state.inventory.oak_log = 4
  assert.equal(c.needs('wood'), false, 'пополнение не требует исходных 14 брёвен')
})

test('пополнение дерева сохраняет брёвна для щита и не создаёт лишнюю деревянную кирку', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 2, stone_axe: 1 } }
  let crafts = 0
  const c = campaign(state, { surface: true }, method => {
    if (method === 'mine') { state.inventory.oak_log = 4; return { dug: 4 } }
    if (method === 'craft') crafts++
    return {}
  })
  c.known.portal = { x: 0, y: 65, z: 0 }
  c.hooks({ recoverGuard: async () => {} })
  await c.runStage('wood')
  assert.equal(state.inventory.oak_log, 4)
  assert.equal(crafts, 0)
})

test('смерть как причина прерывания учитывается даже без повторного события в списке', async () => {
  const state = { health: 20, food: 20, inventory: { blaze_rod: 2 } }
  const c = campaign(state, {}, () => ({ rpcResult: { status: 'interrupted', by: { type: 'death', seq: 7 }, state, events: [] } }))
  await c.act('goto', { x: 4, z: 4 })
  assert.equal(c.died(), true)
})

test('запись последней смерти обнаруживается после чтения событий другим наблюдателем', async () => {
  const state = { health: 20, food: 20, lastDeathAt: '2026-09-28T16:08:19Z', inventory: { blaze_rod: 2 } }
  const c = campaign(state, {})
  await c.refresh()
  assert.equal(c.died(), false, 'старая смерть при старте не является новой')
  state.lastDeathAt = '2026-09-28T17:07:53Z'
  await c.refresh()
  assert.equal(c.died(), true, 'hp20 после возрождения не означает, что старый маршрут продолжается')
})

test('смерть прекращает активный этап до его следующих действий', async () => {
  const state = { health: 20, food: 20, inventory: { blaze_rod: 2 } }
  const c = campaign(state, {}, () => ({ rpcResult: { status: 'interrupted', by: { type: 'death' }, state, events: [] } }))
  c.stage('iron')
  await assert.rejects(c.act('goto', { x: 4, z: 4 }), /умер/)
})

test('смерть во время чтения состояния отменяет очередной отрезок старого маршрута', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 74, z: 0 },
    lastDeathAt: '2026-09-28T16:08:19Z', inventory: { stone_pickaxe: 1 } }
  let walks = 0
  const c = campaign(state, { surface: true }, method => { if (method === 'goto') walks++; return {} })
  await c.refresh()
  state.lastDeathAt = '2026-09-28T17:07:53Z'
  assert.equal(await c.goToward({ x: 200, y: 74, z: 0 }), false)
  assert.equal(walks, 0, 'прежняя цель не отправляется после обнаружения возрождения')
})

test('разгрузка перед плавкой освобождает место, сохраняя предметы прохождения', async () => {
  const inventory = {
    raw_copper: 101, leaf_litter: 43, cobblestone: 256, netherrack: 192,
    magma_block: 3, nether_brick_fence: 1, nether_bricks: 12, granite: 2,
    raw_iron: 4, coal: 32, birch_log: 7, stick: 6, crafting_table: 1,
    iron_pickaxe: 1, iron_chestplate: 1, shield: 1, water_bucket: 1,
    blaze_rod: 7, ender_pearl: 14, ender_eye: 2, obsidian: 3, gold_ingot: 5,
    arrow: 32, bow: 1, white_wool: 3, string: 6, potion: 1
  }
  const bot = inventoryBot(inventory)
  const state = { health: 20, food: 20, inventory, dimension: 'overworld' }
  const situation = { free: bot.inventory.emptySlotCount() }
  const c = campaign(state, situation, (method, params) => {
    if (method === 'pack') {
      // RPC асинхронен; ниже отдельный await для реального алгоритма рюкзака.
      const also = Object.fromEntries(params.also.split(',').map(x => x.trim().split(':')).map(([k, v]) => [k, +v]))
      situation.also = also
    }
    return {}
  })
  await c.unclutter()
  await pack.tidy(bot, { also: situation.also })
  assert.ok(bot.inventory.emptySlotCount() >= 8, 'нужно место под добычу, плавку и крафт')
  assert.equal(inventory.raw_copper || 0, 0)
  assert.equal(inventory.leaf_litter || 0, 0)
  assert.ok(inventory.cobblestone >= 128)
  for (const [name, count] of Object.entries({ raw_iron: 4, coal: 32, birch_log: 7, iron_pickaxe: 1,
    blaze_rod: 7, ender_pearl: 14, ender_eye: 2, obsidian: 3, gold_ingot: 5,
    white_wool: 3, string: 6, potion: 1, arrow: 32 })) assert.equal(inventory[name], count, name)
})

test('плавка разгружает полный рюкзак до загрузки руды', async () => {
  const state = { health: 20, food: 20, inventory: { raw_iron: 4, coal: 4, furnace: 1 }, dimension: 'overworld' }
  const situation = { free: 0 }
  const c = campaign(state, situation, method => {
    if (method === 'pack') situation.free = 8
    if (method === 'smelt') {
      delete state.inventory.raw_iron
      if (situation.free > 0) state.inventory.iron_ingot = 4
      return situation.free > 0 ? { gained: { iron_ingot: 4 } } : { stopped: 'инвентарь полон — выплавленное осталось в печке' }
    }
    return {}
  })
  await c.smeltAll('raw_iron', 'iron_ingot')
  assert.equal(state.inventory.iron_ingot, 4, 'добытое железо должно попасть в рюкзак')
})

test('изношенная кирка заменяется деревянной, если булыжника нет', async () => {
  const state = { health: 20, food: 20, inventory: { wooden_pickaxe: 1, oak_planks: 4, stick: 9, crafting_table: 1 } }
  const situation = { pickLeft: 3 }
  const c = campaign(state, situation, (method, params) => {
    if (method === 'craft' && params.item === 'wooden_pickaxe') {
      state.inventory.wooden_pickaxe++
      state.inventory.oak_planks -= 3
      state.inventory.stick -= 2
      situation.pickLeft += 59
    }
    return {}
  })
  await c.spares(40)
  assert.ok(situation.pickLeft >= 40, 'наличие старой кирки не означает, что ей можно подняться')
})

test('подъём прекращает одинаковые попытки без движения и без нового инструмента', async () => {
  const state = { health: 20, food: 20, inventory: { wooden_pickaxe: 1 }, pos: { x: 22, y: 111, z: 88 } }
  const situation = { surface: false, pickLeft: 3 }
  let attempts = 0
  const c = campaign(state, situation, method => {
    if (method === 'surface') { attempts++; return { stopped: 'У кирки осталось ~3 удара — останавливаюсь заранее', out: false } }
    return {}
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => true })
  assert.equal(await c.toSurface(), false)
  assert.equal(attempts, 1, 'повтор без изменения условий не может сработать')
})

test('повторный отказ прыжка и отхода прекращает подъём, сохраняя сытость', async () => {
  const state = { health: 20, food: 20, pos: { x: -82, y: 85, z: 7 }, inventory: { stone_pickaxe: 2 } }
  let attempts = 0
  const c = campaign(state, { surface: false }, method => {
    if (method === 'surface') { attempts++; return { stopped: 'столб не встал: не подпрыгнул; лестница — не смог шагнуть', out: false } }
    return {}
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => true })
  assert.equal(await c.toSurface(8), false)
  assert.equal(attempts, 2, 'следующий неизменный прыжок тратит еду, а не даёт высоту')
})

test('неудачный подъём не запускает охоту под землёй', async () => {
  const state = { health: 20, food: 20, inventory: {}, pos: { x: 22, y: 111, z: 88 } }
  let attempts = 0
  const c = campaign(state, { surface: false }, method => {
    if (!['recall', 'situation', 'status'].includes(method)) attempts++
    return {}
  })
  c.hooks({ toSurface: async () => false })
  await c.runStage('food')
  assert.equal(attempts, 0, 'после отказа подъёма нельзя идти за деревом или зверями')
})

test('у известного спавнера кампания начинает открытый бой без возврата за стрелами', async () => {
  const state = { health: 20, food: 20, inventory: { stone_pickaxe: 2, shield: 1, cooked_beef: 8 },
    armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'golden_helmet' }, dimension: 'the_nether' }
  let returns = 0
  const c = campaign(state, {}, (method, params) => {
    if (method === 'portal') returns++
    if (method === 'fortress') return { reached: true, spawner: { x: -404, y: 70, z: -200 } }
    if (method === 'blaze' && params.box === false) state.inventory.blaze_rod = 7
    return {}
  })
  c.known.fortress = { x: -424, y: 42, z: -180 }
  c.hooks({ spares: async () => {}, recoverGuard: async () => {} })
  await c.runStage('nether')
  assert.equal(returns, 0, 'открытый бой не требует отдельного этапа стрел')
  assert.equal(state.inventory.blaze_rod, 7)
})

test('пустые заходы — растущая пауза этапа 5/10/20 мин, а не остановка; сторож останавливает через 45 мин без прогресса', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', inventory: {} }
  const clock = { t: Date.parse('2026-09-30T12:00:00Z') }
  const t0 = clock.t
  const at = []
  let stops = 0
  let disconnects = 0
  const logs = []
  const c = campaign(state, {}, (method, params) => {
    if (method === 'wait') clock.t += (params.seconds || 30) * 1000
    if (method === 'stop') stops++
    if (method === 'disconnect') disconnects++
    return {}
  }, { logs, clock })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => { at.push(Math.round((clock.t - t0) / 60000)) })
  await c.boot()
  // Два пустых подряд → пауза 5; после неё каждый пустой → 10, 20; на 45-й минуте — сторож.
  assert.deepEqual(at, [0, 0, 5, 15, 35])
  const text = logs.join('')
  assert.match(text, /пауза 5 мин/)
  assert.match(text, /пауза 10 мин/)
  assert.match(text, /пауза 20 мин/)
  assert.doesNotMatch(text, /нет доступного шага \(.*\); одинаковые попытки прекращаю/)
  assert.match(text, /БЛОКЕР: сторож — 45 мин без прогресса ни в одном этапе \(последний этап iron\)/)
  assert.equal(stops, 1, 'сторож отменяет незавершённое намерение')
  assert.equal(disconnects, 1, 'остановленная кампания убирает тело из мира')
})

test('пауза этапа снимается рассветом и сменой измерения — этап берётся сразу', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', inventory: {} }
  const situation = { night: true, surface: false }
  const clock = { t: Date.parse('2026-09-30T12:00:00Z') }
  const t0 = clock.t
  const at = []
  let waits = 0
  const logs = []
  const c = campaign(state, situation, (method, params) => {
    if (method === 'wait') {
      waits++
      clock.t += (params.seconds || 30) * 1000
      if (waits === 2) situation.night = false
    }
    return {}
  }, { logs, clock, env: { ND_WATCHDOG_MIN: '20' } })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => { at.push(Math.round((clock.t - t0) / 60000)) })
  await c.boot()
  assert.deepEqual(at.slice(0, 3), [0, 0, 2], 'рассвет на второй минуте паузы — третий заход сразу, не через 5 мин')
  assert.match(logs.join(''), /паузы этапов сняты: рассвет/)
})
test('частичная добыча железа позволяет продолжить этап без десятиминутного отдыха', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', inventory: {} }
  let attempts = 0
  let waits = 0
  const c = campaign(state, {}, method => { if (method === 'wait') waits++; return {} }, { argv: ['iron'] })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => {
    attempts++
    state.inventory.raw_iron = attempts
    if (attempts === 3) state.inventory.iron_pickaxe = 1
  })
  await c.boot()
  assert.equal(state.inventory.iron_pickaxe, 1, 'добыча по частям должна довести до кирки')
  assert.equal(waits, 0, 'частичный полезный результат не является повторным провалом')
})

test('каменная кирка и имеющаяся броня позволяют идти за стержнями без нового железного захода', () => {
  const state = { health: 20, food: 20, dimension: 'overworld',
    inventory: { stone_pickaxe: 3, stone_sword: 1, water_bucket: 1, flint_and_steel: 1 },
    armor: { head: 'golden_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' } }
  const c = campaign(state, {})
  c.known.portal = { x: -19, y: 65, z: -24 }
  assert.equal(c.needs('iron'), false, 'стёртая железная кирка не должна отправлять в шахту перед блейзами')
  assert.equal(c.needs('nether'), true)
  state.inventory.blaze_rod = 7
  assert.equal(c.needs('iron'), true, 'для золота бастиона железная кирка всё ещё требуется')
  state.inventory.blaze_rod = 0
  state.armor.torso = null
  assert.equal(c.needs('iron'), false, 'вход в Ад без нагрудника — за ним не ходим, пока бой у спавнера не упёрся в броню')
  c.wantFightGear()
  assert.equal(c.needs('iron'), true, 'бой упёрся — заход за нагрудником')
  state.armor.torso = 'iron_chestplate'
  state.armor.head = null
  assert.equal(c.needs('iron'), true, 'без шлема бой у спавнера смертелен (ферма 2026-09-29)')
})

test('броня по расчёту «время против риска»: из рюкзака — берёт, отдельный поход — нет; цифры в строке', () => {
  const state = { health: 20, food: 20, armor: {}, inventory: { iron_ingot: 8 } }
  const c = campaign(state, {})
  const bag = c.gearWorth('iron_chestplate', { inBag: true })
  assert.equal(bag.take, true)
  assert.match(bag.line, /из рюкзака ≈ 0\.3 мин против пользы [0-9.]+ мин .* беру$/)
  state.inventory.iron_ingot = 0
  const trip = c.gearWorth('iron_chestplate')
  assert.equal(trip.missing, 8)
  assert.equal(trip.take, false, 'поход за 8 слитками дороже ожидаемой пользы')
  assert.match(trip.line, /поход за 8 слитк\. ≈ 12\.8 мин .* не беру$/)
})

test('кровать делается из смешанной шерсти и костей без новой охоты', async () => {
  const state = { health: 20, food: 20, inventory: { white_wool: 1, brown_wool: 2, light_gray_wool: 1,
    bone: 9, oak_planks: 7, crafting_table: 1 } }
  const c = campaign(state, {}, (method, p) => {
    if (method !== 'craft') return {}
    const inv = state.inventory
    if (p.item === 'bone_meal') { inv.bone--; inv.bone_meal = 3 }
    if (p.item === 'white_dye') { inv.bone_meal -= p.count; inv.white_dye = p.count }
    if (p.item === 'white_wool') { inv.brown_wool -= p.count; inv.white_dye -= p.count; inv.white_wool += p.count }
    if (p.item === 'white_bed' && inv.white_wool >= 3) { inv.white_wool -= 3; inv.oak_planks -= 3; inv.white_bed = 1 }
    return {}
  })
  await c.makeBed()
  assert.equal(state.inventory.white_bed, 1)
  assert.equal(state.inventory.light_gray_wool, 1)
  assert.equal(state.inventory.bone, 8)
})

test('частичный выход красителя добирается по рюкзаку до окраски шерсти', async () => {
  const state = { health: 20, food: 20, inventory: { white_wool: 1, brown_wool: 2,
    bone: 9, oak_planks: 7, crafting_table: 1 } }
  const c = campaign(state, {}, (method, p) => {
    if (method !== 'craft') return {}
    const inv = state.inventory
    if (p.item === 'bone_meal') { inv.bone--; inv.bone_meal = (inv.bone_meal || 0) + 3 }
    if (p.item === 'white_dye') { inv.bone_meal--; inv.white_dye = (inv.white_dye || 0) + 1 }
    if (p.item === 'white_wool' && inv.white_dye >= p.count) { inv.brown_wool -= p.count; inv.white_dye -= p.count; inv.white_wool += p.count }
    if (p.item === 'white_bed' && inv.white_wool >= 3) { inv.white_wool -= 3; inv.oak_planks -= 3; inv.white_bed = 1 }
    return {}
  })
  await c.makeBed()
  assert.equal(state.inventory.white_bed, 1, 'done при одном красителе не означает, что готово два')
})

test('смешанные цвета окрашиваются в несколько частичных крафтов до трёх белых', async () => {
  const state = { health: 20, food: 20, inventory: { white_wool: 1, light_gray_wool: 1, brown_wool: 2,
    white_dye: 2, oak_planks: 7, crafting_table: 1 } }
  const c = campaign(state, {}, (method, p) => {
    if (method !== 'craft') return {}
    const inv = state.inventory
    if (p.item === 'white_wool' && inv.white_dye > 0) {
      const color = inv.light_gray_wool > 0 ? 'light_gray_wool' : 'brown_wool'
      inv[color]--; inv.white_dye--; inv.white_wool++
    }
    if (p.item === 'white_bed' && inv.white_wool >= 3) { inv.white_wool -= 3; inv.oak_planks -= 3; inv.white_bed = 1 }
    return {}
  })
  await c.makeBed()
  assert.equal(state.inventory.white_bed, 1, 'после крафта одного цвета нужно использовать второй')
  assert.equal(state.inventory.brown_wool, 1)
})

test('охота заканчивается на запасе этапа еды и не добирает лишние шесть кусков', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 65, z: 0 },
    inventory: { cooked_beef: 7, oak_log: 10, stone_pickaxe: 1, cobblestone: 64, white_bed: 1 } }
  let fights = 0
  const c = campaign(state, { surface: true, free: 10 }, method => {
    if (method === 'observe') return { entities: [{ name: 'cow', dist: 3, pos: { x: 3, y: 65, z: 0 } }] }
    if (method === 'fight') { fights++; state.inventory.cooked_beef++ }
    return {}
  })
  c.hooks({ toSurface: async () => true, recoverGuard: async () => {} })
  await c.runStage('food')
  assert.equal(c.needs('food'), false)
  assert.equal(fights, 1, 'после восьмого куска пора возвращаться к следующей цели')
})

test('готовый запас, щит, огниво и кровать не отправляют на вторую охоту в сборах', () => {
  const state = { health: 20, food: 20, dimension: 'overworld',
    inventory: { cooked_beef: 8, shield: 1, flint_and_steel: 1, stone_pickaxe: 2, white_bed: 1 } }
  const c = campaign(state, { surface: true })
  c.known.portal = { x: -19, y: 65, z: -24 }
  assert.equal(c.needs('food'), false)
  assert.equal(c.needs('prep'), false, 'сборы не должны снова требовать 12 вместо уже собранных 8')
  assert.equal(c.needs('nether'), true)
})

test('пустая охота ограничена четырьмя новыми участками за попытку', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 65, z: 0 },
    inventory: { cooked_beef: 5, oak_log: 10, stone_pickaxe: 1, cobblestone: 64, white_bed: 1 } }
  let walks = 0
  const c = campaign(state, { surface: true, free: 10 }, method => {
    if (method === 'goto') { walks++; state.pos.x += 64 }
    return {}
  })
  c.hooks({ toSurface: async () => true, recoverGuard: async () => {} })
  await c.runStage('food')
  assert.ok(walks > 0 && walks <= 4, `пустых переходов: ${walks}`)
})

test('переключение в free прекращает кампанию без отмены следующего ручного действия', async () => {
  const state = { health: 20, food: 20, inventory: {}, dimension: 'overworld', playPolicy: { mode: 'speedrun' } }
  let attempts = 0
  let stops = 0
  const c = campaign(state, {}, method => { if (method === 'stop') stops++; return {} })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => { attempts++; state.playPolicy.mode = 'free' })
  await c.boot()
  assert.equal(attempts, 1)
  assert.equal(stops, 0, 'free уже отменил старое намерение; кампания не должна трогать новое')
})

test('у крепости бот добывает стержни без повторного похода за золотым шлемом', async () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: -401, y: 69, z: -199 },
    armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'iron_helmet' },
    inventory: { cooked_beef: 8, stone_pickaxe: 2, cobblestone: 64, oak_planks: 32, stick: 12,
      stone_sword: 1, shield: 1, crafting_table: 1 } }
  const calls = []
  const c = campaign(state, {}, (method, params) => {
    calls.push({ method, params })
    if (method === 'fortress') return { reached: true, spawner: { x: -404, y: 70, z: -200 }, dist: 4 }
    if (method === 'blaze') state.inventory.blaze_rod = 7
    return {}
  })
  c.known.portal = { x: -19, y: 65, z: -24 }
  c.known.fortress = true
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('nether')
  assert.equal(state.inventory.blaze_rod, 7)
  assert.equal(calls.some(c => /mine|explore/.test(c.method) && c.params.block === 'nether_gold_ore'), false,
    'золотая броня нужна перед пиглинами, не перед боем с блейзами')
})

test('охота с полным рюкзаком сначала освобождает место для добычи', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 65, z: 0 },
    inventory: { cooked_beef: 5, oak_log: 10, stone_pickaxe: 1, cobblestone: 64, white_bed: 1 } }
  const calls = []
  const sit = { surface: true, free: 0 }
  const c = campaign(state, sit, method => { calls.push(method); if (method === 'pack') sit.free = 8; return {} })
  c.hooks({ toSurface: async () => true, recoverGuard: async () => {} })
  await c.runStage('food')
  const tidy = calls.indexOf('pack')
  const search = calls.indexOf('observe')
  assert.ok(tidy >= 0 && tidy < search, 'сначала место под мясо, потом поиск и убийство животных')
})

test('без поножей и шлема бой у спавнера не начинается, пока железный заход не провалился восемь раз', () => {
  const state = { health: 20, food: 20, dimension: 'overworld',
    armor: { torso: 'iron_chestplate', feet: 'iron_boots' }, offHand: { item: 'shield' },
    inventory: { stone_pickaxe: 2, iron_sword: 1, cooked_beef: 8, blaze_rod: 4 } }
  const c = campaign(state, {})
  c.known.portal = { x: -19, y: 65, z: -24 }
  assert.equal(c.ready('nether'), true, 'вход в Ад — без брони (разведка крепости сразу)')
  assert.equal(c.fightReady(), false, 'ферма 2026-09-29: с нагрудником и ботинками 0 из 8 и 4 смерти')
  c.wantFightGear()
  assert.equal(c.needs('iron'), true)
  state.armor.legs = 'iron_leggings'
  state.armor.head = 'iron_helmet'
  assert.equal(c.fightReady(), true)
})

test('бастион: выработанный первый — этап идёт ко второму по памяти, сухой заход не выжигает бастион', async () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 90, y: 45, z: 140 },
    armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, blaze_rod: 7, cooked_beef: 10 } }
  const targets = []
  const c = campaign(state, { foes: 0 }, (method, params) => {
    if (method !== 'bastion') return {}
    targets.push(params.x)
    if (targets.length === 1) { state.inventory.ender_pearl = 6; return { goldBlocksDug: 17, ingotsTraded: 150, stopped: 'золото кончилось: видимых блоков больше нет', bag: {} } }
    if (targets.length === 2) return { goldBlocksDug: 0, ingotsTraded: 0, stopped: 'до бастиона не дошёл: 300 блоков', bag: {} }
    state.inventory.ender_pearl = 12
    state.potions = { fire_resistance: 3 }
    return { goldBlocksDug: 18, ingotsTraded: 160, bag: {} }
  })
  c.known.portal = { x: -19, y: 65, z: -24 }
  c.known.bastions = [{ key: 'бастион (ад)', x: 105, y: 43, z: 87 }, { key: 'бастион 2 (ад)', x: 672, y: 45, z: 272 }]
  c.known.stronghold = { x: -400, y: 30, z: 1776 } // крепость известна — жемчуга нужно ровно EYES_NEED
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  assert.equal(c.needs('bastion'), true)
  await c.runStage('bastion')
  assert.deepEqual(targets, [105, 672], 'после выработанного первого — второй; сухой заход обрывает этап')
  await c.runStage('bastion')
  assert.deepEqual(targets, [105, 672, 672], 'второй не выработан одним сухим заходом — снова к нему')
})

test('дорога в верхнем мире: новая кирка готовится до следующего перехода, если прежние стёрты', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: -81, y: 44, z: 243 },
    inventory: { crafting_table: 1, cobblestone: 416, stick: 8 } }
  let repaired = 0
  const c = campaign(state, { night: false, surface: false, foes: 0 }, (method, params) => {
    if (method === 'goto') {
      assert.ok(state.inventory.stone_pickaxe, 'переход не начинается без инструмента')
      state.pos.x = params.x; state.pos.z = params.z
    }
    return {}
  })
  c.hooks({ ensurePick: async () => { repaired++; state.inventory.stone_pickaxe = 1; return true } })
  await c.goToward({ x: -400, z: 1776 }, 150)
  assert.equal(repaired, 1)
})

for (const why of ['пути нет', 'кирок на дорогу не хватит: копок ~2244']) {
  test(`бастион: отказ маршрута «${why}» не подменяет завершённый бартер`, async () => {
    const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 3, y: 69, z: 2 },
      armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, stone_pickaxe: 5, blaze_rod: 7, cooked_beef: 10 } }
    let attempts = 0
    const c = campaign(state, { foes: 0 }, method => {
      if (method === 'nether_tunnel') { attempts++; return { ok: false, why, dug: 0, moves: 0 } }
      if (method === 'bastion') assert.fail('до самого бастиона не дошёл')
      return {}
    })
    c.known.portal = { x: -19, y: 65, z: -24 }
    c.known.netherPortal = { x: 3, y: 69, z: 2 }
    c.known.bastions = [{ key: 'бастион (ад)', x: 105, y: 43, z: 87,
      via: [[6, 62, 15], [18, 57, 23], [98, 38, 128]] }]
    c.known.stronghold = { x: -400, y: 30, z: 1776 }
    c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
    await c.runStage('bastion')
    assert.ok(attempts > 0)
    assert.equal(c.needs('bastion'), true, 'отказ пути сохраняет приоритет бартера')
  })
}

test('возврат из Ада: портал не начинает пеший путь после отказа безопасного штрека у бастиона', async () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 84, y: 38, z: 125 },
    armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, stone_pickaxe: 4, cooked_beef: 8 } }
  const calls = []
  const c = campaign(state, { foes: 0, surface: false, free: 10 }, method => {
    calls.push(method)
    if (method === 'nether_tunnel') return { ok: false, why: 'пути нет' }
    return {}
  })
  c.known.netherPortal = { x: 3, y: 69, z: 2 }
  c.known.bastions = [{ key: 'бастион (ад)', x: 105, y: 43, z: 87 }]
  assert.equal(await c.returnFromNether(), false)
  assert.equal(calls.includes('portal'), false, 'portal enter не должен обходить отказ goToward')
})

for (const stage of ['stronghold', 'dragon']) {
  test(`${stage}: возврат из Ада также соблюдает отказ безопасного пути`, async () => {
    const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 84, y: 38, z: 125 },
      armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, stone_pickaxe: 4, cooked_beef: 8, ender_eye: 12 } }
    const calls = []
    const c = campaign(state, { foes: 0, surface: false, free: 10 }, method => {
      calls.push(method)
      return method === 'nether_tunnel' ? { ok: false, why: 'пути нет' } : {}
    })
    c.known.netherPortal = { x: 3, y: 69, z: 2 }
    c.known.bastions = [{ key: 'бастион (ад)', x: 105, y: 43, z: 87 }]
    await c.runStage(stage)
    assert.equal(calls.includes('portal'), false, 'отказ пути нельзя обходить прямым portal enter')
  })
}

test('лечение в Аду не уводит пешком через бастион после отказа штрека', async () => {
  const state = { health: 6, food: 20, dimension: 'the_nether', pos: { x: 84, y: 38, z: 125 },
    armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, stone_pickaxe: 4, cooked_beef: 8 } }
  const calls = []
  const c = campaign(state, { foes: 0, surface: false, free: 10 }, method => {
    calls.push(method)
    if (method === 'nether_tunnel') return { ok: false, why: 'пути нет' }
    // Отлёжка — аварийный отход на месте (в Аду — коробка, не нора).
    if (method === 'refuge') { state.health = 20; return { how: 'box', code: 'OK', healed: true } }
    return {}
  })
  c.known.netherPortal = { x: 3, y: 69, z: 2 }
  c.known.bastions = [{ key: 'бастион (ад)', x: 105, y: 43, z: 87 }]
  await c.rest()
  assert.equal(calls.includes('portal'), false)
  assert.equal(calls.includes('shelter'), false)
  assert.equal(state.health, 20, 'восстановление — отходом на месте, а не пешком через бастион')
})

test('ВЕХА только по итогу: eyes при 2 очах и 0 жемчуга — этап снят без итога, не ВЕХА', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
    inventory: { ender_pearl: 2, blaze_rod: 3, crafting_table: 1 } }
  const logs = []
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    if (method === 'craft' && params.item === 'blaze_powder') { state.inventory.blaze_powder = params.count; state.inventory.blaze_rod -= Math.ceil(params.count / 2) }
    if (method === 'craft' && params.item === 'ender_eye') {
      state.inventory.ender_eye = params.count; state.inventory.ender_pearl -= params.count; state.inventory.blaze_powder -= params.count
      if (!state.inventory.ender_pearl) delete state.inventory.ender_pearl
    }
    return {}
  }, { logs })
  c.hooks({ recoverGuard: async () => {} })
  c.keepStages(['eyes'])
  await c.boot()
  assert.equal(state.inventory.ender_eye, 2)
  const text = logs.join('')
  assert.doesNotMatch(text, /ВЕХА eyes/, 'два ока из двенадцати — не итог этапа')
  assert.match(text, /итог этапа: снят без итога/)
})

test('ВЕХА по итогу: этап без своего done() остаётся вехой, когда он не нужен', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: {} }
  const logs = []
  const c = campaign(state, { surface: true, foes: 0 }, () => ({}), { logs })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => { state.inventory.iron_pickaxe = 1 })
  await c.boot()
  assert.match(logs.join(''), /ВЕХА iron/)
})

test('урон от голода не копает нору: есть еда — ест, нет — нора не нужна', async () => {
  for (const food of [true, false]) {
    const state = { health: 15, food: 0, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
      inventory: { stone_pickaxe: 1, cobblestone: 16, ...(food ? { cooked_beef: 3 } : {}) } }
    const calls = []
    const c = campaign(state, { surface: true, foes: 0, night: false }, method => {
      calls.push(method)
      if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 15, lost: 1, cause: 'starve' }, state, events: [] } }
      return {}
    })
    await c.act('mine')
    assert.equal(calls.includes('shelter'), false, 'нора от голода не спасает')
    assert.equal(calls.includes('eat'), food)
  }
})

test('урон от падения или удушья — без укрытия; удар невидимого моба на хп < 16 — аварийный отход, не нора', async () => {
  for (const [cause, hp, refuge] of [['fall', 15, false], ['in_wall', 15, false], [undefined, 15, true], ['mob_attack', 15, true], ['arrow', 18, false]]) {
    const state = { health: hp, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1, cobblestone: 16 } }
    const calls = []
    const c = campaign(state, { surface: true, foes: 0 }, method => {
      calls.push(method)
      if (method === 'goto') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: hp, lost: 2, ...(cause ? { cause } : {}) }, state, events: [] } }
      if (method === 'refuge') { state.health = 16; return { how: 'box', code: 'OK', healed: true } }
      return { sealed: true }
    })
    await c.act('goto')
    assert.equal(calls.includes('refuge'), refuge, `урон ${cause}, хп ${hp}`)
    assert.equal(calls.includes('shelter'), false, `нора на 2 и сразу выход — не укрытие (урон ${cause})`)
  }
})

test('отлёжка на малом хп — аварийный отход (refuge), а не нора с ожиданием; после отхода толпа — уход, не бой', async () => {
  const state = { health: 5, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 16, cooked_beef: 2 } }
  const situation = { surface: true, foes: 0, night: true, armed: true, verdict: 'драться' }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push({ method, params })
    if (method === 'refuge') { state.health = 17; situation.foes = 3; return { how: 'box', code: 'OK', hp0: 5, hp: 17, healed: true } }
    if (method === 'flee') situation.foes = 0
    return {}
  })
  await c.rest()
  const r = calls.find(x => x.method === 'refuge')
  assert.ok(r, 'отлёжка — отходом')
  assert.equal(r.params.minHp, 16)
  assert.equal(calls.some(x => x.method === 'shelter' || x.method === 'wait' || x.method === 'disconnect'), false)
  assert.equal(calls.some(x => x.method === 'flee'), true, 'трое у стен — уйти')
  assert.equal(calls.some(x => x.method === 'fight'), false, 'с толпой после отхода не драться')
})

test('ночь, есть нечего, мало хп — нора до утра (отход ≤ 2 мин не годится), без отхода', async () => {
  const state = { health: 6, food: 10, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1, cobblestone: 16 } }
  const situation = { surface: true, foes: 0, night: true }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'shelter' && params.mode === 'enter') return { sealed: true }
    if (method === 'wait') situation.night = false
    return {}
  })
  await c.rest()
  assert.equal(calls.includes('refuge'), false)
  assert.equal(calls.includes('shelter'), true)
  assert.equal(calls.includes('wait'), true)
})

test('шаг оборван аварийным отходом автопилота: без ответа поверх (нора/бой), ждать конца опросом status и повторить шаг', async () => {
  const state = { health: 7, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 30, cooked_beef: 4 } }
  const situation = { surface: true, foes: 0, armed: true, verdict: 'драться' }
  const calls = []
  const logs = []
  let polls = 0
  let mines = 0
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'mine' && ++mines === 1) {
      state.busy = 'refuge'
      return { rpcResult: { status: 'interrupted', by: { type: 'emergency', why: 'бьёт zombie (mob_attack)' }, code: 'EMERGENCY', state,
        events: [{ type: 'damage', health: 7, lost: 3, cause: 'mob_attack', source: 'zombie' }] } }
    }
    return { dug: 3 }
  }, { logs, onStatus: () => {
    calls.push('status')
    if (++polls < 2) return {}
    state.busy = null
    state.health = 16
    return { rpcResult: { status: 'done', detail: {}, state, events: [{ type: 'refuge', how: 'box', code: 'OK', hp0: 7, hp: 16, healed: true, seconds: 24 }] } }
  } })
  c.stage('iron')
  const r = await c.act('mine', { block: 'iron_ore' })
  assert.equal(polls, 2, 'ждал конца отхода опросом status')
  assert.equal(calls.includes('wait'), false, 'wait перезаписывал бы current отхода')
  assert.equal(calls.some(m => m === 'shelter' || m === 'fight' || m === 'flee' || m === 'refuge'), false, 'ни answerThreat, ни rest поверх отхода')
  assert.equal(mines, 2, 'шаг повторён после отхода')
  assert.equal(r.status, 'done')
  assert.match(logs.join(''), /отход кончился: box OK, хп 7 → 16/)
})

test('отход автопилота уже идёт (busy: refuge) — следующее намерение ждёт его конца; после — 1–2 врага: бой', async () => {
  const state = { health: 12, food: 20, busy: 'refuge', dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_sword: 1, stone_pickaxe: 1 } }
  const situation = { surface: true, foes: 1, armed: true, verdict: 'драться' }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'goto') assert.equal(state.busy, null, 'goto оборвал бы отход')
    if (method === 'fight') situation.foes = 0
    return {}
  }, { onStatus: () => { calls.push('status'); state.busy = null } })
  await c.act('goto', { x: 10, z: 10 })
  assert.deepEqual(calls, ['status', 'fight', 'goto'])
})


test('вода над головой: подъём уходит штреком по очереди во все стороны, а не четырежды на восток', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 197, y: 57, z: 689 }, inventory: { stone_pickaxe: 3 } }
  const dirs = []
  const c = campaign(state, { surface: false, pickLeft: 300 }, (method, params) => {
    if (method === 'surface') return { out: false, stopped: 'вода у 197,60,689 — туда не копаю; отошёл на 4 и всё равно вода' }
    if (method === 'tunnel') { dirs.push(params.direction); return { stopped: 'вода на 198,59,689 (в 1 впереди сверху) — не копаю' } }
    return {}
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => true })
  assert.equal(await c.toSurface(), false)
  assert.deepEqual(dirs, ['east', 'south', 'west', 'north'])
})

test('снег над головой без лопаты: подъём делает лопату из рюкзака и лезет снова', async () => {
  const state = { health: 3, food: 14, dimension: 'overworld', pos: { x: -105, y: 91, z: -23 },
    inventory: { stone_pickaxe: 4, cobblestone: 35, stick: 2, crafting_table: 1 } }
  const situation = { surface: false, pickLeft: 300 }
  const crafted = []
  const c = campaign(state, situation, (method, params) => {
    if (method === 'surface') {
      if (state.inventory.stone_shovel) { situation.surface = true; return { out: true } }
      return { out: false, stopped: 'snow_block голыми руками не ломается, а лопаты в рюкзаке нет вовсе. можно скрафтить iron_shovel' }
    }
    if (method === 'craft') { crafted.push(params.item); state.inventory[params.item] = (state.inventory[params.item] || 0) + 1 }
    return {}
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => true })
  assert.equal(await c.toSurface(), true)
  assert.ok(crafted.includes('stone_shovel'))
})

test('возрождение ночью наверху: сразу нора до рассвета, а не работа среди тех же мобов', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 20, cooked_beef: 4 } }
  const situation = { night: true, surface: true, foes: 0 }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'death' }, state, events: [] } }
    if (method === 'shelter' && params.mode === 'enter') return { sealed: true }
    if (method === 'wait') situation.night = false
    return {}
  }, { env: { ND_NIGHT_DOWN: '0' } })
  c.stage('iron')
  await assert.rejects(c.act('mine'), /умер/)
  calls.length = 0
  await c.recoverGuard()
  assert.ok(calls.includes('shelter'), 'нора до рассвета')
  assert.ok(calls.includes('wait'))
  assert.equal(calls.includes('dig_down'), false)
})

test('шипящий крипер из оценки боя (situation.fight.first) — бег, а не бой', async () => {
  const state = { health: 18, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_sword: 1, stone_pickaxe: 1 } }
  const calls = []
  const c = campaign(state, { surface: true, foes: 1, armed: true, verdict: 'драться', fight: { first: { name: 'creeper', swelling: true, dist: 3 } } }, method => {
    calls.push(method)
    if (method === 'goto') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 18, lost: 2, cause: 'mob_attack', source: 'zombie' }, state, events: [] } }
    return {}
  })
  await c.act('goto')
  assert.equal(calls.includes('flee'), true)
  assert.equal(calls.includes('fight'), false)
})

test('утопленник у воды: уйти на сушу прочь от воды, не драться и не копать нору в берегу', async () => {
  const state = { health: 16, food: 20, dimension: 'overworld', pos: { x: 10, y: 63, z: 10 }, inventory: { stone_sword: 1, stone_pickaxe: 1 } }
  const calls = []
  const c = campaign(state, { surface: true, foes: 0, armed: true, verdict: 'чисто' }, (method, params) => {
    calls.push({ method, params })
    if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 16, lost: 4, cause: 'mob_attack', source: 'drowned' }, state, events: [] } }
    if (method === 'observe') return { blocks: [{ name: 'water', dist: 3, nearest: { x: 12, y: 62, z: 10 } }] }
    return {}
  })
  await c.act('mine')
  const go = calls.find(x => x.method === 'goto')
  assert.ok(go, 'уход от воды')
  assert.ok(go.params.x < 10, 'прочь от воды (вода на востоке — идти на запад)')
  assert.equal(calls.some(x => x.method === 'shelter' || x.method === 'fight'), false)
})

test('литьё глубоко без видимой лавы: штрек вскрывает лаву, её место запоминается, литьё идёт у неё', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 354, y: -53, z: -177 },
    inventory: { diamond_pickaxe: 1, stone_pickaxe: 2, bucket: 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 6, cobblestone: 64 } }
  const places = {}
  const calls = []
  let casts = 0
  const c = campaign(state, { surface: false, foes: 0, pickLeft: 400, free: 20 }, (method, params) => {
    calls.push(method)
    if (method === 'recall') return { state: { places } }
    if (method === 'portal') {
      casts++
      if (casts === 1 || (casts === 2 && state.pos.x !== 376)) return { stopped: 'не вижу лавы-источника в 24 блоках — подойди к лаве (озеро, пещера)' }
      places['портал'] = { x: 360, y: -55, z: -170, dimension: 'overworld' }
      return { built: true, lit: true }
    }
    if (method === 'tunnel') return { stopped: 'лава у 380,-56,-177 — дальше не копаю' }
    if (method === 'goto') { state.pos = { x: 376, y: -55, z: -177 }; return {} }
    return {}
  })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('cast')
  assert.ok(calls.includes('tunnel'), 'глубоко — штрек, а не разведка ходьбой')
  assert.equal(calls.includes('explore'), false)
  assert.deepEqual({ x: c.known.lava.x, y: c.known.lava.y, z: c.known.lava.z }, { x: 380, y: -56, z: -177 })
  assert.ok(calls.indexOf('goto') > calls.indexOf('tunnel'), 'к вскрытой лаве')
  assert.equal(casts, 3)
})

test('ранен и голоден, охота отказывает сразу: еда повторяется не чаще раза в 90 с, без кручения ходов', async () => {
  const state = { health: 6, food: 10, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const clock = { t: Date.parse('2026-09-30T12:00:00Z') }
  let waits = 0
  const logs = []
  const c = campaign(state, { surface: true, foes: 0, night: false }, (method, params) => {
    if (method === 'wait') { waits++; clock.t += (params.seconds || 30) * 1000 }
    return {}
  }, { clock, logs, env: { ND_WATCHDOG_MIN: '10' } })
  c.hooks({ recoverGuard: async () => {} })
  c.keepStages(['food'])
  // Охота, которая ничего не делает (не вышел наверх) — отказ за миг.
  c.hooks({ toSurface: async () => false })
  await c.boot()
  assert.ok(waits > 0, 'между отказами — ожидание')
  const foodRuns = logs.filter(l => /foods+ход d+: начинаю/.test(l)).length
  assert.match(logs.join(''), /БЛОКЕР: сторож/)
  // 10 мин сторожа: не больше одной охоты в 90 с (и две подряд до первой паузы).
  assert.ok(foodRuns <= 10, `ходов еды ${foodRuns}`)
})

test('утопленник: я в воде — на сушу (всплыть к берегу, не плыть вдоль воды бегом); на суше и он на виду — обычный бой', async () => {
  for (const [inWater, foes, want] of [[true, 1, 'surface'], [false, 1, 'fight']]) {
    const state = { health: 18, food: 20, dimension: 'overworld', pos: { x: 0, y: 62, z: 0 }, inventory: { stone_sword: 1, stone_pickaxe: 1 } }
    const calls = []
    const situation = { surface: true, inWater, foes, armed: true, verdict: 'драться', fight: { first: { name: 'drowned', dist: 5, ranged: true } } }
    const c = campaign(state, situation, method => {
      calls.push(method)
      if (method === 'dig_down') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 18, lost: 2, cause: 'trident', source: 'drowned' }, state, events: [] } }
      if (method === 'observe') return { blocks: [{ name: 'water', dist: 2, nearest: { x: 2, y: 61, z: 0 } }] }
      if (method === 'surface') situation.inWater = false
      return {}
    // Прежний выход из воды всплытием — при ND_REFUGE_SHORE=0 (по умолчанию — отход к берегу, refuge shore).
    }, { env: { ND_REFUGE_SHORE: '0' } })
    await c.act('dig_down')
    assert.equal(calls.includes(want), true, `в воде: ${inWater}`)
    assert.equal(calls.includes('flee'), false, 'бег в воде оставлял тело в воде')
    assert.equal(calls.includes('goto'), false, 'всплыл на сушу — к берегу идти не нужно')
  }
})

test('бой не принят (сытость ниже 18 без еды) — не стоять под ударами: уйти; с едой — сперва доесть и драться', async () => {
  for (const food of [true, false]) {
    const state = { health: 17, food: 15, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
      inventory: { stone_sword: 1, stone_pickaxe: 1, ...(food ? { cooked_beef: 4 } : {}) } }
    const calls = []
    const c = campaign(state, { surface: true, foes: 1, armed: true, verdict: 'драться', fight: { first: { name: 'zombie', dist: 2 } } }, method => {
      calls.push(method)
      if (method === 'goto') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 17, lost: 3, cause: 'mob_attack', source: 'zombie' }, state, events: [] } }
      if (method === 'eat') { state.food = 20; return { ate: 'cooked_beef' } }
      if (method === 'fight') return state.food >= 18 ? { swings: 4, kills: ['zombie'] } : { swings: 0, stopped: 'сытость не позволяет лечиться' }
      return {}
    })
    await c.act('goto')
    assert.equal(calls.includes('eat'), food)
    assert.equal(calls.includes('fight'), true)
    assert.equal(calls.includes('flee'), !food, food ? 'доел и дрался' : 'отказ боя — уйти')
  }
})

test('глубоко с алмазной киркой литьё отложено — берётся обсидиан ведром', () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: -53, z: 0 },
    inventory: { diamond_pickaxe: 1, bucket: 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 8 } }
  const c = campaign(state, { surface: false, night: false })
  assert.equal(c.needs('cast'), true)
  assert.equal(c.ready('cast'), true)
  assert.equal(c.defers('cast'), true, 'под землёй раме негде расти')
  state.pos.y = 64
  assert.equal(c.defers('cast'), false, 'поверху литьё — как раньше')
})

test('литью не хватает блоков на столбы — булыжник добирается тут же, и литьё идёт снова', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: -651, y: 86, z: -232 },
    inventory: { stone_pickaxe: 1, bucket: 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 8, dirt: 13 } }
  const places = { 'лава': { x: -640, y: 80, z: -230, dimension: 'overworld' } }
  const calls = []
  let casts = 0
  const c = campaign(state, { surface: true, foes: 0, night: false, free: 20 }, (method, params) => {
    calls.push({ method, params })
    if (method === 'recall') return { state: { places } }
    if (method === 'portal') {
      casts++
      if ((state.inventory.cobblestone || 0) < 10) return { stopped: 'на углы, столбы и подпорки нужно блоков 10', need: { what: 'cobblestone', count: 10 } }
      places['портал'] = { x: -645, y: 80, z: -230, dimension: 'overworld' }
      return { built: true }
    }
    if (method === 'mine' && params.block === 'stone') state.inventory.cobblestone = params.count
    return {}
  })
  c.hooks({ recoverGuard: async () => {} })
  await c.runStage('cast')
  assert.ok(calls.some(x => x.method === 'mine' && x.params.block === 'stone' && x.params.count >= 14))
  assert.equal(casts, 2)
  assert.ok(c.known.portal)
})

test('смерть во время ожидания «нет шага»: возрождение разобрано, ожидание не пропускается, ходы не крутятся', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1, cooked_beef: 3, stone_sword: 1 } }
  const clock = { t: Date.parse('2026-09-30T12:00:00Z') }
  let waits = 0
  const logs = []
  const c = campaign(state, { surface: false, foes: 0 }, (method, params) => {
    if (method === 'wait') {
      waits++
      clock.t += (params.seconds || 30) * 1000
      if (waits === 1) return { rpcResult: { status: 'interrupted', by: { type: 'death' }, state, events: [] } }
    }
    return {}
  }, { clock, logs, env: { ND_WATCHDOG_MIN: '10' } })
  c.ironOnly(async () => {})
  await c.boot()
  const turns = logs.filter(l => /(нет доступного шага|нужные этапы отложены)/.test(l)).length
  assert.ok(turns <= 15, `ходов ожидания ${turns}`)
  assert.match(logs.join(''), /БЛОКЕР: сторож/)
})

test('тело выпало из игры посреди прогона — кампания переподключает его, а не крутит этапы на пустом рюкзаке', async () => {
  const state = { connected: true, health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const calls = []
  let runs = 0
  const c = campaign(state, { surface: true, foes: 0 }, method => {
    calls.push(method)
    if (method === 'connect') state.connected = true
    return {}
  }, { argv: ['iron'] })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => { runs++; if (runs === 1) state.connected = false; else state.inventory.iron_pickaxe = 1 })
  await c.boot()
  assert.equal(calls.filter(x => x === 'connect').length, 2, 'в начале и после обрыва')
  assert.equal(runs, 2)
})

test('ночь, враг у места норы — нору под ним не копать: сперва бой (1–2 и меч) или отход, потом нора', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 16, cooked_beef: 4 } }
  const situation = { night: true, surface: true, foes: 1, armed: true, verdict: 'драться', fight: { first: { name: 'zombie', dist: 4 } } }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'fight') { situation.foes = 0; return { swings: 3, kills: ['zombie'] } }
    if (method === 'shelter' && params.mode === 'enter') {
      assert.equal(situation.foes, 0, 'нора копается только без врагов рядом')
      return { sealed: true }
    }
    if (method === 'wait') situation.night = false
    return {}
  })
  await c.nightGuard()
  assert.ok(calls.indexOf('fight') >= 0 && calls.indexOf('fight') < calls.indexOf('shelter'))
})

test('литьё поверху: обзор и две разведки без лавы — запасной путь через алмазы (кирка из железа), литьё ждёт лаву', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 70, z: 0 },
    inventory: { stone_pickaxe: 2, bucket: 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 8, cobblestone: 64 } }
  const calls = []
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    calls.push(method)
    if (method === 'portal') return { stopped: 'не вижу лавы-источника в 24 блоках — подойди к лаве (озеро, пещера)' }
    if (method === 'explore') return { note: 'не нашёл за отведённое время' }
    return {}
  })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  assert.equal(c.needs('iron'), false, 'два ведра есть — за киркой не идём, пока литьё не сдалось')
  await c.runStage('cast')
  assert.equal(calls.filter(m => m === 'explore').length, 2)
  assert.equal(calls.includes('dig_down') || calls.includes('tunnel'), false, 'на −50 за лавой не спускается (выше её слоя)')
  assert.equal(c.defers('cast'), true, 'литьё ждёт, пока лава не станет известна')
  assert.equal(c.needs('iron'), true, 'запасной путь: железная кирка на алмазы')
  c.known.lava = { x: 5, y: 20, z: 5 }
  assert.equal(c.defers('cast'), false, 'лава стала известна — литьё снова')
})

test('отход автопилота не вылечил (хп < 10) — своя отлёжка отходом, а не тот же шаг под стрелами', async () => {
  const state = { health: 12, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1, cobblestone: 30, cooked_beef: 4 } }
  const calls = []
  let mines = 0
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    calls.push(method)
    if (method === 'mine' && ++mines === 1) {
      state.busy = 'refuge'
      return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 12, lost: 3, cause: 'arrow', source: 'skeleton' }, state, events: [] } }
    }
    if (method === 'refuge') { state.health = 16; return { how: 'hole', code: 'OK', healed: true } }
    return { dug: 3 }
  }, { onStatus: () => { state.busy = null; state.health = 9; return { rpcResult: { status: 'done', detail: {}, state, events: [{ type: 'refuge', how: 'flee', code: 'CORNERED', hp0: 12, hp: 9 }] } } } })
  c.stage('stone')
  await c.act('mine', { block: 'stone', count: 20 })
  assert.ok(calls.indexOf('refuge') > 0, 'отлёжка — отходом кампании')
  assert.ok(calls.lastIndexOf('mine') > calls.indexOf('refuge'), 'шаг — после лечения')
})

test('горы без зверей: две пустые охоты — железо и при сытости 8; пустой отрезок в гору — поворот', async () => {
  const state = { health: 20, food: 10, dimension: 'overworld', pos: { x: 0, y: 120, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, oak_log: 4 } }
  const gotos = []
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    if (method === 'goto') { gotos.push(params); state.pos = { x: params.x, y: state.pos.y + 15, z: params.z } }
    if (method === 'observe') return { entities: [], blocks: [] }
    return {}
  })
  c.hooks({ recoverGuard: async () => {}, toSurface: async () => true })
  assert.equal(c.ready('iron'), false, 'сытость 10 без еды — вниз не пускали')
  await c.runStage('food')
  await c.runStage('food')
  assert.equal(c.ready('iron'), true, 'охота пуста дважды — железо на склонах гор')
  // Отрезки в гору (+15 каждый) — курс поворачивает, а не идёт дальше по прямой вверх.
  const dirs = gotos.map(g => Math.atan2(g.z, g.x))
  assert.ok(new Set(dirs.map(d => d.toFixed(2))).size > 1, 'курс меняется')
})

test('ND_OW_DEEP: лавы поверху нет — колодец к −54, штрек встал у лавы за блоком, литьё с окном у неё', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 70, z: 0 },
    inventory: { stone_pickaxe: 2, bucket: 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 8, cobblestone: 64, oak_log: 8, crafting_table: 1 } }
  const places = {}
  const calls = []
  const situation = { surface: true, foes: 0, night: false, pickLeft: 400, free: 20 }
  const c = campaign(state, situation, (method, params) => {
    calls.push({ method, params })
    if (method === 'recall') return { state: { places } }
    if (method === 'dig_down') { state.pos = { x: 10, y: -54, z: 0 }; situation.surface = false; return { dug: 40, steps: 30 } }
    if (method === 'tunnel' && params.direction === 'down') { state.pos = { x: 10, y: -54, z: 0 }; situation.surface = false; return { dug: 124, descended: 124 } }
    if (method === 'tunnel') return { stopped: 'лава на 11,-55,0 (в 1 впереди, ниже) — не копаю, обходи другим направлением или на 3 блока в сторону' }
    if (method === 'portal') {
      assert.equal(params.windows, true)
      assert.deepEqual(params.hint, { x: 11, y: -55, z: 0 })
      places['портал'] = { x: 3, y: -54, z: 0, dimension: 'overworld' }
      return { built: true, lit: true }
    }
    return {}
  }, { env: { ND_OW_DEEP: '1', ND_OW_HEAR: '0' } })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('cast')
  assert.ok(c.known.portal, 'портал отлит глубоко')
  const ms = calls.map(x => x.method === 'tunnel' && x.params.direction === 'down' ? 'shaft' : x.method)
  assert.ok(ms.includes('shaft') && ms.indexOf('tunnel') > ms.indexOf('shaft') && ms.indexOf('portal') > ms.indexOf('tunnel'))
  assert.equal(ms.includes('dig_down'), false, 'колодец дошёл — лесенка не нужна')
  assert.equal(ms.includes('explore'), false, 'без разведки поверху')
})

test('ND_OW_DEEP: вода под землёй — штрек встал у воды, окно и черпак тем же литьём, без подъёма', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 16, z: 0 },
    inventory: { stone_pickaxe: 2, bucket: 2, flint_and_steel: 1, cooked_beef: 8, cobblestone: 64 } }
  const calls = []
  const c = campaign(state, { surface: false, foes: 0, night: true }, (method, params) => {
    calls.push(method)
    if (method === 'bucket') return { filled: false, stopped: 'не вижу источника воды в 32 блоках' }
    if (method === 'tunnel') return { stopped: 'вода на 5,16,-3 (слева) — не копаю, обходи другим направлением или на 3 блока в сторону' }
    if (method === 'portal') { assert.deepEqual(params.waterHint, { x: 5, y: 16, z: -3 }); state.inventory.bucket = 1; state.inventory.water_bucket = 1; return { water: true } }
    return {}
  }, { env: { ND_OW_DEEP: '1', ND_OW_HEAR: '0' } })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('water')
  assert.equal(state.inventory.water_bucket, 1)
  assert.equal(calls.includes('surface'), false, 'наверх не лезет')
})

test('ND_OW_DEEP: до портала под землёй за едой не поднимается (сытость ≥ 10), ранен и голоден — поднимается', () => {
  const state = { health: 20, food: 15, dimension: 'overworld', pos: { x: 0, y: 16, z: 0 }, inventory: { stone_pickaxe: 1, cooked_beef: 2 } }
  const situation = { surface: false, night: false }
  const c = campaign(state, situation, () => ({}), { env: { ND_OW_DEEP: '1' } })
  assert.equal(c.needs('food'), true)
  assert.equal(c.defers('food'), true)
  state.inventory = { stone_pickaxe: 1 }
  state.health = 8
  assert.equal(c.defers('food'), true, 'глубокий путь: хп 8 — ещё не «ранен и голоден» (порог 6)')
  state.health = 4
  assert.equal(c.defers('food'), false, 'ранен и есть нечего — охота')
  const plain = campaign({ ...state, health: 20, inventory: { stone_pickaxe: 1, cooked_beef: 2 } }, situation)
  assert.equal(plain.defers('food'), false, 'без флага — как раньше')
})


test('r4 exit: diamond pick and nine obsidian cannot skip bastion reserve', () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 50, z: 0 }, inventory: { blaze_rod: 7, obsidian: 9, diamond_pickaxe: 1, ender_pearl: 12, flint_and_steel: 1 } }
  const c = campaign(state, {}, () => ({}), { env: { ND_SH_NETHER: '1' } })
  c.known.portal = { x: 0, z: 0 }; c.known.stronghold = { x: 1000, z: 1000 }
  c.known.bastions = [{ key: '??????? (??)', x: 20, z: 20 }]
  assert.equal(c.needs('bastion'), true)
})
test('r4 exit: refuse the trip before movement or spending a link attempt', async () => {
  const calls = []
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 50, z: 0 }, inventory: { obsidian: 9, diamond_pickaxe: 1, flint_and_steel: 1 } }
  const c = campaign(state, {}, method => { calls.push(method); return {} }, { env: { ND_SH_NETHER: '1' } })
  assert.equal(await c.viaNetherTo({ x: 1000, z: 1000 }, 'test'), false)
  assert.equal(calls.some(m => ['goto','nether_tunnel','ne_route','portal','stronghold'].includes(m)), false)
})
test('r4 exit: missing igniter keeps bastion needed even at ten obsidian', () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', inventory: { blaze_rod: 7, obsidian: 10, ender_pearl: 12 } }
  const c = campaign(state, {}, () => ({}), { env: { ND_SH_NETHER: '1' } })
  c.known.portal = {}; c.known.stronghold = {}; c.known.bastions = [{ key: '??????? (??)', x: 0, z: 0 }]
  assert.equal(c.needs('bastion'), true)
})
test('r4 exit: explicit disable restores the former diamond-pick policy', () => {
  const state = { health: 20, food: 20, dimension: 'the_nether', inventory: { blaze_rod: 7, obsidian: 9, diamond_pickaxe: 1, ender_pearl: 12 } }
  const c = campaign(state, {}, () => ({}), { env: { ND_SH_NETHER: '1', ND_EXIT_KIT: '0' } })
  c.known.portal = {}; c.known.stronghold = {}; c.known.bastions = [{ key: '??????? (??)', x: 0, z: 0 }]
  assert.equal(c.needs('bastion'), false)
})

test('r4 exit: finding the room fills and enters in the same campaign stage', async () => {
  const calls = []
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: -883, y: -3, z: -1405 }, inventory: { ender_eye: 12 } }
  const c = campaign(state, { surface: false, foes: 0 }, (method, params) => {
    calls.push({ method, params })
    if (method === 'stronghold' && params.mode === 'room') return { room: { centre: { ...state.pos, y: -4 } } }
    if (method === 'stronghold' && params.mode === 'fill') { state.dimension = 'the_end'; return { entered: true } }
    return {}
  }, { env: { ND_ENDKIT: '0', ND_END_ENTRY: '1' } })
  c.known.stronghold = { x: -883, z: -1405, room: { x: -883, y: -4, z: -1405 } }
  c.hooks({ recoverGuard: async () => {} })
  await c.runStage('stronghold')
  const portal = calls.filter(c => c.method === 'stronghold')
  assert.deepEqual(portal.map(c => c.params.mode), ['room', 'fill'])
  assert.equal(portal[1].params.enter, true)
  assert.equal(state.dimension, 'the_end')
  assert.equal(c.needs('stronghold'), false)
})

test('r4 exit: a stopped mapped-room approach is not retried six times in one stage', async () => {
  let rooms = 0
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: -883, y: -3, z: -1405 }, inventory: { ender_eye: 12 } }
  const c = campaign(state, { surface: false, foes: 0 }, (method, params) => {
    if (method === 'stronghold' && params.mode === 'room') { rooms++; return { stopped: 'lava near the tunnel face' } }
    return {}
  }, { env: { ND_ENDKIT: '0' } })
  c.known.stronghold = { x: -883, z: -1405, room: { x: -883, y: -4, z: -1405 } }
  c.hooks({ recoverGuard: async () => {} })
  await c.runStage('stronghold')
  assert.equal(rooms, 1)
})
