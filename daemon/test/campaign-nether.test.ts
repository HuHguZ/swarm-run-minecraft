'use strict'
// Кампания: Ад — вход и бой у спавнера, крепость и стержни, броня по цене, возврат через портал, угрозы, поиск крепости, жемчуг и эндермены.
import { campaignScript } from './campaign-source'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as vm from 'node:vm'
import { campaign } from './campaign-fixture'

// Бой у спавнера без щита и брони — цена (blazeRisk графа), не запрет (AGENTS.md «гибкость», агент Ада 14.10); ворота — кирка и еда.
test('вход в Ад и бой у спавнера — кирка и еда; щит и броня — цена, не запрет', () => {
  const state: Record<string, any> = { health: 20, food: 20, armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'iron_helmet' }, inventory: { stone_pickaxe: 1, stone_sword: 1, shield: 1, cooked_beef: 8 } }
  const c = campaign(state, {} as Record<string, any>)
  assert.equal(c.ready('nether'), true)
  assert.equal(c.fightReady(), true)
  delete state.inventory.shield
  assert.equal(c.ready('nether'), true, 'в Ад — без щита (путь спидраннеров)')
  assert.equal(c.fightReady(), true, 'без щита — цена боя, а не запрет')
  state.inventory.shield = 1
  state.armor = {} as Record<string, any>
  assert.equal(c.ready('nether'), true, 'в Ад — без брони')
  assert.equal(c.fightReady(), true, 'без брони — ближняя коробка у спавнера, а не отказ')
  state.armor.torso = 'iron_chestplate'
  state.inventory.cooked_beef = 1
  assert.equal(c.ready('nether'), false, 'запас лечения должен пережить Ад')
  assert.equal(c.fightReady(), false, 'без еды на лечение бой не начинается')
})
test('смена измерения на обратном пути прекращает маршрут и не отправляет домой через портал повторно', async () => {
  const state: Record<string, any> = { health: 13, food: 20, dimension: 'the_nether', pos: { x: -400, y: 70, z: -200 }, inventory: { stone_pickaxe: 2, blaze_rod: 2 } }
  const calls = []
  const c = campaign(state, { free: 10 }, method => {
    calls.push(method)
    if (method === 'goto') { state.dimension = 'overworld'; state.pos = { x: -7, y: 67, z: 1 } }
    return {} as Record<string, any>
  })
  c.known.netherPortal = { x: 4, y: 69, z: 4 }
  assert.equal(await c.returnFromNether(), true)
  assert.equal(calls.filter(x => x === 'goto').length, 1)
  assert.equal(calls.includes('portal'), false, 'возрождение/переход уже вернул в верхний мир')
  assert.equal(state.inventory.blaze_rod, 2)
})
test('у известного спавнера кампания начинает открытый бой без возврата за стрелами', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { stone_pickaxe: 2, shield: 1, cooked_beef: 8, ender_pearl: 14,
    oak_planks: 32, stick: 12, crafting_table: 1, cobblestone: 64 },
    armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'golden_helmet' }, dimension: 'the_nether' }
  let returns = 0
  const c = campaign(state, { pickLeft: 300 }, (method, params) => {
    if (method === 'portal') returns++
    if (method === 'fortress') return { reached: true, spawner: { x: -404, y: 70, z: -200 } }
    // Без огнестойкости коробка с окном разрешена навыку (box не false), бой всё равно начинается сразу.
    if (method === 'blaze' && params.box !== false) state.inventory.blaze_rod = 7
    return {} as Record<string, any>
  })
  c.known.fortress = { x: -424, y: 42, z: -180 }
  c.hooks({ spares: async () => {}, recoverGuard: async () => {} })
  await c.runStage('nether')
  assert.equal(returns, 0, 'открытый бой не требует отдельного этапа стрел')
  assert.equal(state.inventory.blaze_rod, 7)
})
test('new observed fortress stops continue the search before rods instead of triggering a five-minute home trip', async () => {
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 162, y: 75, z: -49 },
    inventory: { iron_pickaxe: 1, stone_pickaxe: 2, iron_sword: 1, cooked_beef: 12 } }
  const clock = { t: Date.parse('2026-10-11T10:27:57Z') }
  let attempts = 0
  let waits = 0
  const logs: string[] = []
  const c = campaign(state, { foes: 0, pickLeft: 400 }, (method, params) => {
    if (method === 'wait') { waits++; clock.t += params.seconds * 1000 }
    if (method === 'fortress') return { found: false, explored: attempts }
    if (method === 'portal') { assert.equal(state.inventory.blaze_rod, 7, 'return home after resources, not during useful exploration'); state.dimension = 'overworld'; return { went: true } }
    return {}
  }, { argv: ['nether'], clock, logs })
  c.hooks({ recoverGuard: async () => {} })
  c.netherOnly(async () => {
    attempts++
    clock.t += 60000
    await c.act('fortress', { mode: 'spawner' })
    const observation = await c.intelligenceObservation()
    assert.equal(observation.facts.fortress_explored.value, attempts)
    assert.equal(observation.facts.fortress_explored.source, 'observed')
    if (attempts === 3) state.inventory.blaze_rod = 7
  })
  await c.boot()
  assert.equal(attempts, 3)
  assert.equal(waits, 0)
  assert.doesNotMatch(logs.join(''), /пауза 5 мин/)
})
test('каменная кирка и имеющаяся броня позволяют идти за стержнями без нового железного захода', () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld',
    inventory: { stone_pickaxe: 3, stone_sword: 1, water_bucket: 1, flint_and_steel: 1 },
    armor: { head: 'golden_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' } }
  const c = campaign(state, {} as Record<string, any>)
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
test('броня по расчёту «время против риска»: при цене смерти 6 мин из рюкзака — берёт, отдельный поход — нет; цифры в строке', () => {
  const state: Record<string, any> = { health: 20, food: 20, armor: {} as Record<string, any>, inventory: { iron_ingot: 8 } }
  const c = campaign(state, {} as Record<string, any>, undefined, { env: { ND_DEATH_COST_MIN: '6' } })
  const bag = c.gearWorth('iron_chestplate', { inBag: true })
  assert.equal(bag.take, true)
  assert.match(bag.line, /из рюкзака ≈ 0\.3 мин против пользы [0-9.]+ мин .* беру$/)
  state.inventory.iron_ingot = 0
  const trip = c.gearWorth('iron_chestplate')
  assert.equal(trip.missing, 8)
  assert.equal(trip.take, false, 'поход за 8 слитками дороже ожидаемой пользы')
  assert.match(trip.line, /поход за 8 слитк\. ≈ 12\.8 мин .* не беру$/)
})
test('цена смерти по умолчанию — как у графа (60 мин, keep_inventory=false): поход за нагрудником окупается', () => {
  const state: Record<string, any> = { health: 20, food: 20, armor: {} as Record<string, any>, inventory: {} }
  const trip = campaign(state, {} as Record<string, any>).gearWorth('iron_chestplate')
  assert.equal(trip.missing, 8)
  assert.equal(trip.take, true)
  assert.match(trip.line, /смерть 60 мин\) — беру$/)
})
test('у крепости бот добывает стержни без повторного похода за золотым шлемом', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: -401, y: 69, z: -199 },
    armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'iron_helmet' },
    inventory: { cooked_beef: 8, stone_pickaxe: 2, cobblestone: 64, oak_planks: 32, stick: 12,
      stone_sword: 1, shield: 1, crafting_table: 1, ender_pearl: 14 } }
  const calls = []
  const c = campaign(state, { pickLeft: 300 }, (method, params) => {
    calls.push({ method, params })
    if (method === 'fortress') return { reached: true, spawner: { x: -404, y: 70, z: -200 }, dist: 4 }
    if (method === 'blaze') state.inventory.blaze_rod = 7
    return {} as Record<string, any>
  })
  c.known.portal = { x: -19, y: 65, z: -24 }
  c.known.fortress = true
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('nether')
  assert.equal(state.inventory.blaze_rod, 7)
  assert.equal(calls.some(c => /mine|explore/.test(c.method) && c.params.block === 'nether_gold_ore'), false,
    'золотая броня нужна перед пиглинами, не перед боем с блейзами')
})
test('без поножей и шлема бой у спавнера начинается: железо за бронёй не требуется (цена, не запрет)', () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld',
    armor: { torso: 'iron_chestplate', feet: 'iron_boots' }, offHand: { item: 'shield' },
    inventory: { stone_pickaxe: 2, iron_sword: 1, cooked_beef: 8, blaze_rod: 4 } }
  const c = campaign(state, {} as Record<string, any>)
  c.known.portal = { x: -19, y: 65, z: -24 }
  assert.equal(c.ready('nether'), true, 'вход в Ад — без брони (разведка крепости сразу)')
  assert.equal(c.fightReady(), true, 'риск без брони считает blazeRisk графа')
  c.wantFightGear()
  assert.equal(c.needs('iron'), false, 'за бронёй к спавнеру домой не идём')
})
test('возврат из Ада: портал не начинает пеший путь после отказа безопасного штрека у бастиона', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 84, y: 38, z: 125 },
    armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, stone_pickaxe: 4, cooked_beef: 8 } }
  const calls = []
  const c = campaign(state, { foes: 0, surface: false, free: 10 }, method => {
    calls.push(method)
    if (method === 'nether_tunnel') return { ok: false, why: 'пути нет' }
    return {} as Record<string, any>
  })
  c.known.netherPortal = { x: 3, y: 69, z: 2 }
  c.known.bastions = [{ key: 'бастион (ад)', x: 105, y: 43, z: 87 }]
  assert.equal(await c.returnFromNether(), false)
  assert.equal(calls.includes('portal'), false, 'portal enter не должен обходить отказ goToward')
})
for (const stage of ['stronghold', 'dragon']) {
  test(`${stage}: возврат из Ада также соблюдает отказ безопасного пути`, async () => {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 84, y: 38, z: 125 },
      armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, stone_pickaxe: 4, cooked_beef: 8, ender_eye: 12 } }
    const calls = []
    const c = campaign(state, { foes: 0, surface: false, free: 10 }, method => {
      calls.push(method)
      return method === 'nether_tunnel' ? { ok: false, why: 'пути нет' } : {} as Record<string, any>
    })
    c.known.netherPortal = { x: 3, y: 69, z: 2 }
    c.known.bastions = [{ key: 'бастион (ад)', x: 105, y: 43, z: 87 }]
    await c.runStage(stage)
    assert.equal(calls.includes('portal'), false, 'отказ пути нельзя обходить прямым portal enter')
  })
}
test('лечение в Аду не уводит пешком через бастион после отказа штрека', async () => {
  const state: Record<string, any> = { health: 6, food: 20, dimension: 'the_nether', pos: { x: 84, y: 38, z: 125 },
    armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, stone_pickaxe: 4, cooked_beef: 8 } }
  const calls = []
  const c = campaign(state, { foes: 0, surface: false, free: 10 }, method => {
    calls.push(method)
    if (method === 'nether_tunnel') return { ok: false, why: 'пути нет' }
    // Отлёжка — аварийный отход на месте (в Аду — коробка, не нора).
    if (method === 'refuge') { state.health = 20; return { how: 'box', code: 'OK', healed: true } }
    return {} as Record<string, any>
  })
  c.known.netherPortal = { x: 3, y: 69, z: 2 }
  c.known.bastions = [{ key: 'бастион (ад)', x: 105, y: 43, z: 87 }]
  await c.rest()
  assert.equal(calls.includes('portal'), false)
  assert.equal(calls.includes('shelter'), false)
  assert.equal(state.health, 20, 'восстановление — отходом на месте, а не пешком через бастион')
})
test('s1c: hit by a wither skeleton in the Nether at 11 hp — into the rock (ne_burrow), not an open fight', async () => {
  const state: Record<string, any> = { health: 11, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 }, inventory: { iron_sword: 1, cooked_beef: 8 } }
  const situation = { foes: 1, armed: true, fight: { first: { name: 'wither_skeleton', dist: 2 }, order: [{ name: 'wither_skeleton', dist: 2 }] } }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'damage' }, state, events: [] } }
    return {} as Record<string, any>
  })
  c.stage('nether')
  await c.act('mine').catch(() => {})
  assert.ok(calls.includes('ne_burrow'), calls.join(','))
  assert.equal(calls.includes('fight'), false)
})
test('s1d: a piglin brute in the Nether at full hp — still into the rock, never an open fight (13 per hit)', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 }, inventory: { iron_sword: 1, cooked_beef: 8 } }
  const situation = { foes: 1, armed: true, fight: { first: { name: 'piglin_brute', dist: 2 }, order: [{ name: 'piglin_brute', dist: 2 }] } }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'damage' }, state, events: [] } }
    return {} as Record<string, any>
  })
  c.stage('nether')
  await c.act('mine').catch(() => {})
  assert.ok(calls.includes('ne_burrow'), calls.join(','))
  assert.equal(calls.includes('fight'), false)
})
test('s1c: огнестойкость кончилась, а её можно купить (золото на руках) — этап отдаёт решение графу после одного вызова blaze', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { stone_pickaxe: 2, shield: 1, cooked_beef: 8, ender_pearl: 14,
    oak_planks: 32, stick: 12, crafting_table: 1, cobblestone: 64, gold_ingot: 20 },
    armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'golden_helmet' }, dimension: 'the_nether' }
  const calls = []
  const c = campaign(state, { pickLeft: 300 }, (method) => {
    calls.push(method)
    if (method === 'fortress') return { reached: true, spawner: { x: -404, y: 70, z: -200 } }
    return {} as Record<string, any>
  })
  c.known.fortress = { x: -424, y: 42, z: -180 }
  c.hooks({ spares: async () => {}, recoverGuard: async () => {} })
  await c.runStage('nether')
  assert.equal(calls.filter(m => m === 'blaze').length, 1, calls.join(','))
  assert.ok(calls.includes('ne_burrow'), 'в толщу до решения графа')
})
test('s1f: спавнер вслепую не увиден, но обход видел ифритов в 24 бл. — бой с ними отсюда (ND_BLAZE_SEEN=0 — нет)', async () => {
  for (const off of [false, true]) {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: -87, y: 50, z: 55 },
      armor: { torso: 'iron_chestplate', legs: 'iron_leggings', head: 'iron_helmet' }, offHand: { item: 'shield' },
      inventory: { iron_pickaxe: 1, iron_sword: 1, cooked_beef: 10, blaze_rod: 3, crafting_table: 1, oak_planks: 8, netherrack: 64 } }
    const calls = []
    const c = campaign(state, { foes: 0, surface: false, pickLeft: 260 }, method => {
      calls.push(method)
      if (method === 'fortress') return { found: false, stopped: 'у крепости спавнера в прогруженных чанках не видно (обход 6 остановок)', blazes: { seen: 2, nearest: 14 } }
      if (method === 'blaze') state.inventory.blaze_rod = 7
      return {} as Record<string, any>
    }, { env: off ? { ND_BLAZE_SEEN: '0' } : {} })
    c.known.portal = { x: -19, y: 65, z: -24 }
    c.known.fortress = true
    c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
    await c.runStage('nether')
    assert.equal(calls.includes('blaze'), !off, off ? 'выключено — без боя' : 'ифриты видны — бой')
  }
})
test('s1f: в Аду ход отрезками по 32 (длинная цель в рельефе Ада — «Took to long to decide path»); ND_NE_LEG=64 — прежнее', async () => {
  for (const leg of [undefined, '64']) {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 }, inventory: { iron_pickaxe: 1 } }
    const gotos: any[] = []
    const c = campaign(state, { foes: 0 }, (method, params) => {
      if (method === 'goto') { gotos.push(params.x); state.pos.x = params.x; state.pos.z = params.z }
      return {} as Record<string, any>
    }, { env: leg ? { ND_NE_LEG: leg } : {} })
    c.hooks({ ensurePick: async () => true })
    await c.goToward({ x: 59, z: 0 }, 20)
    assert.deepEqual(gotos, leg ? [59] : [32, 59], leg ? 'прежнее: сразу к цели' : 'отрезок 32, затем цель')
  }
})
test('s1f: эндермены — леса не нашёл: этап кончается неудачей (директор отступит и возьмёт другое), ND_EM_FAIL=0 — тихий выход', async () => {
  for (const off of [false, true]) {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 },
      inventory: { iron_pickaxe: 1, iron_sword: 1, cooked_beef: 10, blaze_rod: 7, netherrack: 64 } }
    const c = campaign(state, { foes: 0 }, (method) => {
      if (method === 'explore') return { found: false }
      return {} as Record<string, any>
    }, { env: { ND_ENDERMEN: '1', ...(off ? { ND_EM_FAIL: '0' } : {}) } })
    c.known.portal = { x: -19, y: 65, z: -24 }
    c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
    let err = null
    try { await c.runStage('pearls') } catch (e) { err = e }
    assert.equal(!!err, !off, off ? 'выключено — без ошибки' : 'неудача этапа')
  }
})
test('neR-1: five carried meals do not force a healthy Nether body back through the portal', () => {
  const state: any = { health: 20, food: 19, dimension: 'the_nether', pos: { x: 31, y: 58, z: -11 },
    inventory: { iron_pickaxe: 1, iron_sword: 1, cooked_mutton: 5 } }
  const c = campaign(state, { foes: 0, surface: false })
  assert.equal(c.fightReady(), true)
  delete state.inventory.iron_pickaxe
  assert.equal(c.fightReady(), false, 'a digging route still needs its physical tool')
})
test('neP-1: a tactical interruption exits covered healing after one observation wait', async () => {
  const state: any = { health: 8, food: 20, dimension: 'the_nether', pos: { x: -45, y: 28, z: 96 },
    inventory: { iron_pickaxe: 1, cooked_mutton: 6 } }
  let waits = 0
  const c = campaign(state, { foes: 0 }, method => method === 'ne_burrow' ? { ok: true } :
    method === 'wait' ? (waits++, { rpcResult: { status: 'interrupted', code: 'TACTICAL', by: { type: 'tactical' }, detail: {}, state, events: [] } }) : {},
    { env: { ND_NE_STAY: '1' } })
  await c.rest(18)
  assert.equal(waits, 1, 'the next decision must see the changed physical state')
})
test('a failed spawner approach returns for observation instead of repeating the same RPC in the stage', async () => {
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 3, y: 66, z: 1 },
    inventory: { iron_pickaxe: 1, iron_sword: 1, cooked_mutton: 8, cobblestone: 64, crafting_table: 1 } }
  let attempts = 0
  const c = campaign(state, { foes: 0, pickLeft: 381 }, method => {
    if (method === 'fortress') { attempts++; return { found: false, stopped: 'no newly seen deck or spawner' } }
    return {}
  })
  c.known.portal = { x: 0, y: 65, z: 0 }; c.known.fortress = true
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('nether')
  assert.equal(attempts, 1)
})
test('failed Nether search retries on changed evidence or eight-block displacement, never on elapsed time or unrelated stock', () => {
  const state: any = { health: 20, food: 19, dimension: 'the_nether', pos: { x: 7.99, y: 58, z: -11 },
    inventory: { iron_pickaxe: 1, cooked_mutton: 5 } }
  const situation: any = { foes: 0, pickLeft: 300, fight: { order: [] } }
  const c = campaign(state, situation)
  const source = campaignScript()
  const start = source.indexOf('const cooling ='), end = source.indexOf('const resetPauses =', start)
  assert.ok(start >= 0 && end > start)
  let now = 0
  const context: any = { state, fails: new Map(), failureKey: s => s, netherRetryState: c.retryState,
    dim: () => state.dimension, gameClock: { now: () => now }, process: { env: { ND_NE_STAY: '1' } },
    PAUSE_MIN: [5,10,20,40], log() {}, have: () => 0, known: c.known, barterFlow: { enabled: () => false } }
  vm.runInNewContext(source.slice(start, end) + '\n    globalThis.isBlocked = () => cooling({ name: "nether" }); globalThis.fail = () => failStage("nether", "nether");', cjsContext(context))
  context.fail()
  assert.equal(context.isBlocked(), true)
  now += 24 * 3600000; state.health = 20; state.inventory.quartz = 64
  assert.equal(context.isBlocked(), true)
  state.pos.x = 8.01
  assert.equal(context.isBlocked(), true, 'crossing a coordinate grid edge is not a new approach')
  state.pos.x = 16
  assert.equal(context.isBlocked(), false)
  context.fail()
  assert.equal(context.isBlocked(), true, 'the new failure has its own spatial origin')
  state.tactics = { threatLevel: 2 }
  assert.equal(context.isBlocked(), false, 'the physical threat changed')
})
for (const change of ['position', 'geometry']) test(`a blocked fortress search creates its own new ${change} before another search`, async () => {
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 },
    inventory: { iron_pickaxe: 1, iron_sword: 1, cooked_beef: 12, cobblestone: 64 } }
  let attempts = 0, advances = 0, waits = 0
  const c = campaign(state, { foes: 0, pickLeft: 400 }, (method, params) => {
    if (method === 'fortress' && params.mode === 'advance') {
      advances++
      if (change === 'position') state.pos.x += 8
      return { advanced: true, frontierTried: 1, frontierRevision: change === 'geometry' ? 2 : 1 }
    }
    if (method === 'wait') { waits++; state.inventory.blaze_rod = 7 }
    if (method === 'portal') { state.dimension = 'overworld'; return { went: true } }
    return {}
  }, { argv: ['nether'], env: { ND_NE_STAY: '1' } })
  c.known.fortress = { x: 32, y: 64, z: 0 }
  c.hooks({ recoverGuard: async () => {} })
  c.netherOnly(async () => { if (++attempts === 2) state.inventory.blaze_rod = 7 })
  await c.boot()
  assert.equal(advances, 1, 'the state gate needs an action that changes what the bot can observe')
  assert.equal(attempts, 2)
  assert.equal(waits, 0, 'HP20/food20 must not enter the observation polling loop')
})
test('ND_FORTRESS_FRONTIER=0 preserves the previous blocked-search control', async () => {
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 },
    inventory: { iron_pickaxe: 1, iron_sword: 1, cooked_beef: 12 } }
  let advances = 0, waits = 0
  const c = campaign(state, { foes: 0, pickLeft: 400 }, (method, params) => {
    if (method === 'fortress' && params.mode === 'advance') advances++
    if (method === 'wait') { waits++; state.inventory.blaze_rod = 7 }
    if (method === 'portal') { state.dimension = 'overworld'; return { went: true } }
    return {}
  }, { argv: ['nether'], env: { ND_NE_STAY: '1', ND_FORTRESS_FRONTIER: '0' } })
  c.known.fortress = { x: 32, y: 64, z: 0 }
  c.hooks({ recoverGuard: async () => {} })
  c.netherOnly(async () => {})
  await c.boot()
  assert.equal(advances, 0)
  assert.equal(waits, 1)
})
test('a changed tactical action reopens its interrupted fortress route even at the same threat level', () => {
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 },
    inventory: { iron_pickaxe: 1 }, tactics: { threatLevel: 1, action: 'Fight' } }
  const c = campaign(state, { foes: 1, pickLeft: 400, fight: { order: [{ name: 'blaze' }] } })
  const before = c.retryState(state.pos)
  state.tactics.action = 'Idle'
  assert.notEqual(c.retryState(state.pos), before)
})
test('the shared Nether stage advances a failed view before repeating spawner search, including graph callers', async () => {
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 },
    inventory: { iron_pickaxe: 1, iron_sword: 1, cooked_beef: 12, cobblestone: 64 } }
  const modes: string[] = []
  let searches = 0
  const c = campaign(state, { foes: 0, pickLeft: 400 }, (method, params) => {
    if (method === 'fortress') {
      modes.push(params.mode)
      if (params.mode === 'advance') { state.pos.x += 8; return { advanced: true, frontierTried: 1, frontierRevision: 1 } }
      if (++searches === 2) state.inventory.blaze_rod = 7
      return { found: false, explored: 1, frontierRevision: 1, stopped: 'not visible' }
    }
    return {}
  })
  c.known.fortress = { x: 32, y: 64, z: 0 }
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('nether')
  await c.runStage('nether')
  assert.deepEqual(modes, ['spawner', 'advance', 'spawner'])
})
test('a calm failed Nether search takes its own new exploration action, never idle wait; unchanged failed actions are finite', async()=>{
  const state:any={health:20,food:20,dimension:'the_nether',pos:{x:-8,y:64,z:69},inventory:{iron_pickaxe:1,stone_pickaxe:1,iron_sword:1,cooked_mutton:8,cobblestone:64,crafting_table:1}}
  const calls:any[]=[],c=campaign(state,{foes:0,pickLeft:381},(m,p)=>{calls.push({m,p});return{}},{env:{ND_NE_RECOVER:'1'}})
  c.known.portal={x:0,y:65,z:0};c.known.fortress={x:-25,y:65,z:97}
  await c.changeNetherCause()
  assert.ok(calls.some(r=>r.m==='explore'),'a refused observation must have a physical actuator')
  assert.equal(calls.some(r=>r.m==='wait'),false,'calm is not a reason to wait for the same state')
  const n=calls.filter(r=>r.m==='explore').length
  await c.changeNetherCause()
  assert.equal(calls.filter(r=>r.m==='explore').length,n,'the failed actuator cannot repeat without changed cause')
  state.pos.x+=8
  await c.refresh()
  await c.changeNetherCause()
  assert.equal(calls.filter(r=>r.m==='explore').length,n+1,'an actual new viewpoint permits another leg')
})
test('Nether recovery waits only for an observed active threat and does not start a new exploration leg',async()=>{
  const state:any={health:20,food:20,dimension:'the_nether',pos:{x:-8,y:64,z:69},tactics:{threatLevel:2},inventory:{iron_pickaxe:1,cooked_mutton:8}}
  const calls:string[]=[],c=campaign(state,{foes:1,pickLeft:300},m=>{calls.push(m);return{}},{env:{ND_NE_RECOVER:'1'}})
  await c.changeNetherCause()
  assert.equal(calls.includes('explore'),false)
  assert.equal(calls.filter(m=>m==='wait').length,1)
})
test('an interrupted scout with no physical or observed change is still a failed actuator, not a new retry cause',async()=>{
  const state:any={health:20,food:20,dimension:'the_nether',pos:{x:-8,y:64,z:69},inventory:{iron_pickaxe:1,stone_pickaxe:1,iron_sword:1,cooked_mutton:8,cobblestone:64,crafting_table:1}}
  let attempts=0
  const c=campaign(state,{foes:0,pickLeft:381},m=>m==='explore'?(attempts++,{rpcResult:{status:'interrupted',by:{type:'cancelled'},state,events:[],detail:{}}}):{},{env:{ND_NE_RECOVER:'1'}})
  await c.changeNetherCause();await c.changeNetherCause()
  assert.equal(attempts,1)
})
test('fj2-1-b-101: a scout interrupted by a tactical reflex is retried once for the same state, not an immediate blocker',async()=>{
  const state:any={health:20,food:20,dimension:'the_nether',pos:{x:-8,y:64,z:69},inventory:{iron_pickaxe:1,stone_pickaxe:1,iron_sword:1,cooked_mutton:8,cobblestone:64,crafting_table:1}}
  let attempts=0
  const c=campaign(state,{foes:0,pickLeft:381},m=>m==='explore'?(attempts++,{rpcResult:{status:'interrupted',by:{type:'reflex'},state,events:[],detail:{}}}):{},{env:{ND_NE_RECOVER:'1'}})
  assert.equal(await c.changeNetherCause(),true)
  await c.changeNetherCause();await c.changeNetherCause()
  assert.equal(attempts,2,'one retry after the threat, then the unchanged interruption is a failed actuator')
})
test('bz0-b-101: the actual campaign leaves a calm failed search through its own actuator instead of an eighteen-minute observe/wait loop',async()=>{
  const state:any={connected:true,health:20,food:20,dimension:'the_nether',playPolicy:{mode:'speedrun'},pos:{x:-8,y:64,z:69},inventory:{iron_pickaxe:1,stone_pickaxe:1,iron_sword:1,cooked_mutton:8,cobblestone:64,crafting_table:1}}
  const calls:any[]=[],logs:string[]=[],clock={t:100000}
  const places={'портал':{x:0,y:65,z:0,dimension:'overworld'},'портал (ад)':{x:0,y:64,z:0,dimension:'the_nether'},'крепость (ад)':{x:-25,y:65,z:97,dimension:'the_nether'}}
  const c=campaign(state,{foes:0,pickLeft:381,surface:false},(m,p)=>{
    calls.push({m,p});if(m==='recall')return{state:{places}}
    if(m==='wait'){clock.t+=p.seconds*1000;if(calls.filter(r=>r.m==='wait').length>=400)state.inventory.blaze_rod=7}
    if(m==='portal'){state.dimension='overworld';return{went:true}}
    return{}
  },{env:{ND_NE_RECOVER:'1',ND_NE_STAY:'1'},argv:['nether'],clock,logs})
  c.netherOnly(async()=>{})
  await c.boot()
  assert.equal(calls.filter(r=>r.m==='wait').length,0)
  assert.equal(calls.filter(r=>r.m==='explore').length,1)
  assert.ok(logs.some(l=>l.includes('завершаю без пустого ожидания')))
  assert.ok(calls.some(r=>r.m==='disconnect'),'a physically unreachable scene ends explicitly rather than pretending progress')
})
test('p7-b-103: a tactically interrupted hunt still pays its actual seconds and inventory pearl once, without declaring an unseen forest empty',async()=>{
  const state:any={health:20,food:20,dimension:'the_nether',pos:{x:0,y:49,z:0},inventory:{iron_pickaxe:1,cooked_mutton:8,cobblestone:64}}
  const clock={t:100000};let n=0
  const c=campaign(state,{foes:0,pickLeft:300},m=>{
    if(m==='recall')return{state:{places:{'искажённый лес (ад)':{x:0,y:49,z:0,dimension:'the_nether'}}}}
    if(m==='pearls'){
      n++;clock.t+=n===1?396200:341700;state.inventory.ender_pearl=1
      return n===1?{seenEndermen:4}:{rpcResult:{status:'interrupted',by:{type:'tactical'},state,events:[],detail:{seenEndermen:0}}}
    }
    return{}
  },{clock,env:{ND_EM_PRICE_RECEIPTS:'1'}})
  await c.readMemory()
  await c.trackedHunt()
  assert.equal(Math.round(c.pearlPrice()),292)
  await assert.rejects(c.trackedHunt(),/STRATEGY_INTERRUPTED/)
  assert.equal(Math.round(c.pearlTrip().seconds*10)/10,737.9)
  assert.equal(c.pearlTrip().pearls,1)
  assert.equal(c.pearlTrip().zero,0,'an interrupted unseen interval is not proof of an empty forest')
  assert.equal(Math.round(c.pearlPrice()),406)
})
test('a completed hunt is charged once through the same real stage; disabling the switch preserves the legacy price path',async()=>{
  for(const enabled of ['0','1']){
    const state:any={health:20,food:20,dimension:'the_nether',pos:{x:0,y:49,z:0},inventory:{iron_pickaxe:1,cooked_mutton:8,cobblestone:64}}
    const clock={t:100000}
    const c=campaign(state,{foes:0,pickLeft:300},m=>{
      if(m==='recall')return{state:{places:{'искажённый лес (ад)':{x:0,y:49,z:0,dimension:'the_nether'}}}}
      if(m==='pearls'){clock.t+=10000;state.inventory.ender_pearl=14;return{seenEndermen:4}}
      return{}
    },{clock,env:{ND_EM_PRICE_RECEIPTS:enabled}})
    await c.readMemory();c.hooks({recoverGuard:async()=>{},spares:async()=>{}})
    await c.runStage('pearls')
    assert.equal(c.pearlTrip().seconds,10)
    assert.equal(c.pearlTrip().pearls,14)
  }
})
test('p7-b-101/102: failed foxhole preparation is one refused approach, not proof that the whole forest is empty; a new F3 forest position supplies the next approach',async()=>{
  const state:any={health:20,food:20,dimension:'the_nether',biome:'warped_forest',pos:{x:0,y:49,z:0},inventory:{iron_pickaxe:1,cooked_mutton:8,cobblestone:64}}
  let hunts=0
  const c=campaign(state,{foes:0,pickLeft:300},m=>{
    if(m==='recall')return{state:{places:{'искажённый лес (ад)':{x:0,y:49,z:0,dimension:'the_nether'}}}}
    if(m==='pearls'){hunts++;return{prepared:false,seenEndermen:0,stopped:'ровного места под окоп рядом нет'}}
    return{}
  },{env:{ND_NE_RECOVER:'1',ND_EM_PRICE_RECEIPTS:'1'}})
  await c.readMemory();c.hooks({recoverGuard:async()=>{},spares:async()=>{}})
  await assert.rejects(c.runStage('pearls'),/окоп не подготовлен/)
  assert.equal(hunts,1)
  assert.equal(c.pearlTrip().zero,0)
  assert.equal(c.emptyForests().length,0)
  assert.equal(c.forestToHunt(),null,'the failed physical approach is not retried from the same position')
  state.pos.x=10;await c.refresh()
  assert.equal(c.forestToHunt().x,10,'F3 underfoot and actual displacement provide a different approach without a seed map')
})
