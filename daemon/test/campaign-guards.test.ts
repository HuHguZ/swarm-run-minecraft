'use strict'
// Кампания: ночь, отдых и лечение, нора и отход, урон, угрозы (крипер, утопленник), смерть и возрождение.
import test = require('node:test')
import assert = require('node:assert/strict')
import { campaign } from './campaign-fixture'

test('speedrun night guard keeps supplied work available without sleep or waiting for dawn', async () => {
  for (const scenario of [{ night: true, surface: true, bed: true }, { night: false, dusk: true, surface: true, bed: true },
    { night: true, surface: false, bed: false }]) {
    const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: -20, y: 67, z: 3 },
      playPolicy: { mode: 'speedrun' }, inventory: { oak_log: 3, oak_planks: 4, iron_pickaxe: 1, ...(scenario.bed ? { white_bed: 1 } : {}) } }
    const situation = { ...scenario, foes: 0, inWater: false }
    const methods: string[] = []
    const c = campaign(state, situation, method => {
      methods.push(method)
      if (method === 'sleep') return { morning: true }
      if (method === 'wait') situation.night = false
      return {}
    }, { env: { ND_NIGHT_DOWN: '0' } })
    await c.nightGuard({ dusk: true })
    assert.deepEqual(methods.filter(method => ['sleep', 'wait', 'shelter', 'craft'].includes(method)), [], JSON.stringify(scenario))
    assert.equal(state.inventory.oak_log, 3)
  }
})

test('speedrun recovery heals with food instead of sleeping in a nearby bed', async () => {
  const state = { health: 6, food: 20, dimension: 'overworld', pos: { x: -20, y: 67, z: 3 },
    playPolicy: { mode: 'speedrun' }, inventory: { cooked_beef: 4, white_bed: 1, iron_pickaxe: 1 } }
  const methods: string[] = []
  const c = campaign(state, { night: true, surface: true, foes: 0, bed: true }, method => {
    methods.push(method)
    if (method === 'sleep' || method === 'refuge') state.health = 16
    return {}
  })
  await c.rest()
  assert.equal(methods.includes('sleep'), false)
  assert.ok(methods.includes('refuge'), 'food-based healing still uses the existing protected recovery skill')
})

test('speedrun recovery without food keeps food search available at night', async () => {
  const state = { health: 6, food: 17, dimension: 'overworld', pos: { x: -20, y: 67, z: 3 },
    playPolicy: { mode: 'speedrun' }, inventory: { iron_pickaxe: 1, cobblestone: 32 } }
  const situation = { night: true, surface: true, foes: 0, bed: false }
  const methods: string[] = []
  const c = campaign(state, situation, method => {
    methods.push(method)
    if (method === 'wait') situation.night = false
    if (method === 'shelter') return { sealed: true }
    return {}
  })
  await c.rest()
  assert.deepEqual(methods.filter(method => ['sleep', 'wait', 'shelter', 'refuge'].includes(method)), [])
  assert.equal(situation.night, true, 'the fixture must not manufacture dawn')
})

test('ночное восстановление использует близкую кровать до ожидания в норе', async () => {
  const state: Record<string, any> = { health: 6, food: 17, dimension: 'overworld', pos: { x: -85, y: 72, z: 0 },
    inventory: { iron_pickaxe: 1, cobblestone: 32 } }
  const situation: Record<string, any> = { night: true, surface: false, foes: 0, bed: false }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push({ method, params })
    if (method === 'recall') return { state: { places: { 'точка возрождения': { x: -84, y: 75, z: 0 } } } }
    if (method === 'sleep') { situation.night = false; return { morning: true } }
    if (method === 'shelter') return { sealed: true }
    if (method === 'wait') situation.night = false
    return {} as Record<string, any>
  })
  await c.rest()
  assert.equal(calls.filter(x => x.method === 'sleep').length, 1)
  assert.equal(calls.some(x => x.method === 'wait'), false, 'сон быстрее бесполезного лечения на сытости 17')
  const sleep = calls.find(x => x.method === 'sleep').params
  assert.equal(sleep.take, false, 'кровать возрождения остаётся стоять')
  assert.equal(sleep.bunker, false, 'при отказе возвращаемся в готовую нору')
})

for (const surface of [true, false]) test(`здоровый бот без угроз продолжает ночную работу, поверхность=${surface}`, async () => {
  const state: Record<string, any> = { health: 20, food: 18, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 32 } }
  const situation: Record<string, any> = { night: true, surface, foes: 0 }
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

test('кровать пропускает ночь также под крышей, без многоминутного ожидания', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 61, z: 0 }, inventory: { white_bed: 1 } }
  const situation: Record<string, any> = { night: true, surface: false }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'sleep' || method === 'wait') situation.night = false
    return method === 'sleep' ? { woke: true } : {} as Record<string, any>
  })
  await c.nightGuard()
  assert.equal(calls.includes('sleep'), true)
  assert.equal(calls.includes('wait'), false)
})

test('две неудачные норы не отключают бота: РИСК в журнал, без ожидания на улице, повторная нора не копается сразу', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 },
    inventory: { stone_pickaxe: 1, cobblestone: 16 } }
  const calls = []
  const logs = []
  const c = campaign(state, { night: true, surface: true }, (method, params) => {
    calls.push({ method, params })
    if (method === 'shelter') return { sealed: false, stopped: 'яма не углубляется' }
    return {} as Record<string, any>
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
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 },
    inventory: { stone_pickaxe: 1, cobblestone: 16 } }
  const situation: Record<string, any> = { night: true, surface: true }
  const calls = []
  let enters = 0
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'shelter' && params.mode === 'enter') return { sealed: ++enters === 2 }
    if (method === 'wait') {
      assert.equal(enters, 2)
      situation.night = false
    }
    return {} as Record<string, any>
  // Прежнее ожидание в норе — при ND_NIGHT_DOWN=0 (по умолчанию нора — вход вниз, без ожидания: test/survival-night).
  }, { env: { ND_NIGHT_DOWN: '0' } })
  await c.nightGuard()
  assert.equal(calls.filter(x => x === 'wait').length, 1)
  assert.equal(calls.includes('disconnect'), false)
})

test('неудачное укрытие в воде не запускает лечение ожиданием и не отключает бота', async () => {
  const state: Record<string, any> = { health: 8, food: 20, dimension: 'overworld', pos: { x: 618, y: 59, z: -60 },
    inventory: { stone_pickaxe: 1, cobblestone: 16 } }
  const calls = []
  const logs = []
  const c = campaign(state, { inWater: true, surface: false, foes: 0, night: true }, (method, params) => {
    calls.push({ method, params })
    if (method === 'shelter') return { sealed: false, stopped: 'я в воде — тут не окопаешься' }
    if (method === 'surface') return { out: false, stopped: 'всплыть некуда — каменный потолок' }
    if (method === 'goto') return { rpcResult: { status: 'failed', error: 'No path', state, events: [] } }
    return {} as Record<string, any>
  }, { logs })
  await c.rest()
  assert.equal(calls.some(x => x.method === 'wait'), false, 'ожидание в воде тратит воздух вместо лечения')
  assert.equal(calls.some(x => x.method === 'surface'), true, 'перед лечением нужно выйти из воды')
  // S8c 07.10: walkAway при «No path» поверху повторяет тот же отрезок обычным goto (ND_WALK_LOOSE) — два отрезка по две попытки.
  assert.equal(calls.filter(x => x.method === 'goto').length, 4, 'не всплыл — к берегу, два отрезка')
  assert.equal(calls.filter(x => x.method === 'goto' && !x.params.surface).length, 2, 'вторая попытка каждого отрезка — без surface strict')
  assert.equal(calls.some(x => x.method === 'shelter'), false, 'в воде копать нору нельзя')
  assert.equal(calls.some(x => x.method === 'disconnect'), false, 'не отключается')
  assert.match(logs.join(''), /РИСК укрытие:WATER/)
})

test('смерть как причина прерывания учитывается даже без повторного события в списке', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { blaze_rod: 2 } }
  const c = campaign(state, {} as Record<string, any>, () => ({ rpcResult: { status: 'interrupted', by: { type: 'death', seq: 7 }, state, events: [] } }))
  await c.act('goto', { x: 4, z: 4 })
  assert.equal(c.died(), true)
})

test('запись последней смерти обнаруживается после чтения событий другим наблюдателем', async () => {
  const state: Record<string, any> = { health: 20, food: 20, lastDeathAt: '2026-09-28T16:08:19Z', inventory: { blaze_rod: 2 } }
  const c = campaign(state, {} as Record<string, any>)
  await c.refresh()
  assert.equal(c.died(), false, 'старая смерть при старте не является новой')
  state.lastDeathAt = '2026-09-28T17:07:53Z'
  await c.refresh()
  assert.equal(c.died(), true, 'hp20 после возрождения не означает, что старый маршрут продолжается')
})

test('смерть прекращает активный этап до его следующих действий', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { blaze_rod: 2 } }
  const c = campaign(state, {} as Record<string, any>, () => ({ rpcResult: { status: 'interrupted', by: { type: 'death' }, state, events: [] } }))
  c.stage('iron')
  await assert.rejects(c.act('goto', { x: 4, z: 4 }), /умер/)
})

test('смерть во время чтения состояния отменяет очередной отрезок старого маршрута', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 74, z: 0 },
    lastDeathAt: '2026-09-28T16:08:19Z', inventory: { stone_pickaxe: 1 } }
  let walks = 0
  const c = campaign(state, { surface: true }, method => { if (method === 'goto') walks++; return {} as Record<string, any> })
  await c.refresh()
  state.lastDeathAt = '2026-09-28T17:07:53Z'
  assert.equal(await c.goToward({ x: 200, y: 74, z: 0 }), false)
  assert.equal(walks, 0, 'прежняя цель не отправляется после обнаружения возрождения')
})

test('урон от голода не копает нору: есть еда — ест, нет — нора не нужна', async () => {
  for (const food of [true, false]) {
    const state: Record<string, any> = { health: 15, food: 0, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
      inventory: { stone_pickaxe: 1, cobblestone: 16, ...(food ? { cooked_beef: 3 } : {} as Record<string, any>) } }
    const calls = []
    const c = campaign(state, { surface: true, foes: 0, night: false }, method => {
      calls.push(method)
      if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 15, lost: 1, cause: 'starve' }, state, events: [] } }
      return {} as Record<string, any>
    })
    await c.act('mine')
    assert.equal(calls.includes('shelter'), false, 'нора от голода не спасает')
    assert.equal(calls.includes('eat'), food)
  }
})

test('урон от падения или удушья — без укрытия; удар невидимого моба на хп < 16 — аварийный отход, не нора', async () => {
  for (const [cause, hp, refuge] of [['fall', 15, false], ['in_wall', 15, false], [undefined, 15, true], ['mob_attack', 15, true], ['arrow', 18, false]]) {
    const state: Record<string, any> = { health: hp, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1, cobblestone: 16 } }
    const calls = []
    const c = campaign(state, { surface: true, foes: 0 }, method => {
      calls.push(method)
      if (method === 'goto') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: hp, lost: 2, ...(cause ? { cause } : {} as Record<string, any>) }, state, events: [] } }
      if (method === 'refuge') { state.health = 16; return { how: 'box', code: 'OK', healed: true } }
      return { sealed: true }
    })
    await c.act('goto')
    assert.equal(calls.includes('refuge'), refuge, `урон ${cause}, хп ${hp}`)
    assert.equal(calls.includes('shelter'), false, `нора на 2 и сразу выход — не укрытие (урон ${cause})`)
  }
})

test('отлёжка на малом хп — аварийный отход (refuge), а не нора с ожиданием; после отхода толпа — уход, не бой', async () => {
  const state: Record<string, any> = { health: 5, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 16, cooked_beef: 2 } }
  const situation: Record<string, any> = { surface: true, foes: 0, night: true, armed: true, verdict: 'драться' }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push({ method, params })
    if (method === 'refuge') { state.health = 17; situation.foes = 3; return { how: 'box', code: 'OK', hp0: 5, hp: 17, healed: true } }
    if (method === 'flee') situation.foes = 0
    return {} as Record<string, any>
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
  const state: Record<string, any> = { health: 6, food: 10, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1, cobblestone: 16 } }
  const situation: Record<string, any> = { surface: true, foes: 0, night: true }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'shelter' && params.mode === 'enter') return { sealed: true }
    if (method === 'wait') situation.night = false
    return {} as Record<string, any>
  })
  await c.rest()
  assert.equal(calls.includes('refuge'), false)
  assert.equal(calls.includes('shelter'), true)
  assert.equal(calls.includes('wait'), true)
})

test('шаг оборван аварийным отходом автопилота: без ответа поверх (нора/бой), ждать конца опросом status и повторить шаг', async () => {
  const state: Record<string, any> = { health: 7, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 30, cooked_beef: 4 } }
  const situation: Record<string, any> = { surface: true, foes: 0, armed: true, verdict: 'драться' }
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
    if (++polls < 2) return {} as Record<string, any>
    state.busy = null
    state.health = 16
    return { rpcResult: { status: 'done', detail: {} as Record<string, any>, state, events: [{ type: 'refuge', how: 'box', code: 'OK', hp0: 7, hp: 16, healed: true, seconds: 24 }] } }
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
  const state: Record<string, any> = { health: 12, food: 20, busy: 'refuge', dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_sword: 1, stone_pickaxe: 1 } }
  const situation: Record<string, any> = { surface: true, foes: 1, armed: true, verdict: 'драться' }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'goto') assert.equal(state.busy, null, 'goto оборвал бы отход')
    if (method === 'fight') situation.foes = 0
    return {} as Record<string, any>
  }, { onStatus: () => { calls.push('status'); state.busy = null } })
  await c.act('goto', { x: 10, z: 10 })
  assert.deepEqual(calls, ['status', 'fight', 'goto'])
})

test('навык отказал из-за моба (CAST_UNSAFE) — ответ на моба боем, а не тот же вызов снова (cl-b 14.10)', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 71, y: 50, z: 224 },
    inventory: { stone_sword: 1, bucket: 1, flint_and_steel: 1 } }
  const situation: Record<string, any> = { foes: 1, armed: true, surface: true, verdict: 'драться', fight: { first: { name: 'zombie', dist: 2 }, order: [{ name: 'zombie', dist: 2 }] } }
  const calls = []
  const c = campaign(state, situation, (method) => {
    calls.push(method)
    if (method === 'portal') return { stopped: 'CAST_UNSAFE: zombie', code: 'CAST_UNSAFE' }
    if (method === 'fight') { situation.foes = 0; situation.fight = { order: [] }; return { kills: ['zombie'] } }
    return {} as Record<string, any>
  })
  await c.act('portal', { mode: 'cast', timeoutSeconds: 540 })
  assert.ok(calls.includes('fight'), JSON.stringify(calls))
})

test('возрождение ночью наверху: сразу нора до рассвета, а не работа среди тех же мобов', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 20, cooked_beef: 4 } }
  const situation: Record<string, any> = { night: true, surface: true, foes: 0 }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'death' }, state, events: [] } }
    if (method === 'shelter' && params.mode === 'enter') return { sealed: true }
    if (method === 'wait') situation.night = false
    return {} as Record<string, any>
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
  const state: Record<string, any> = { health: 18, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_sword: 1, stone_pickaxe: 1 } }
  const calls = []
  const c = campaign(state, { surface: true, foes: 1, armed: true, verdict: 'драться', fight: { first: { name: 'creeper', swelling: true, dist: 3 } } }, method => {
    calls.push(method)
    if (method === 'goto') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 18, lost: 2, cause: 'mob_attack', source: 'zombie' }, state, events: [] } }
    return {} as Record<string, any>
  })
  await c.act('goto')
  assert.equal(calls.includes('flee'), true)
  assert.equal(calls.includes('fight'), false)
})

test('утопленник у воды: уйти на сушу прочь от воды, не драться и не копать нору в берегу', async () => {
  const state: Record<string, any> = { health: 16, food: 20, dimension: 'overworld', pos: { x: 10, y: 63, z: 10 }, inventory: { stone_sword: 1, stone_pickaxe: 1 } }
  const calls = []
  const c = campaign(state, { surface: true, foes: 0, armed: true, verdict: 'чисто' }, (method, params) => {
    calls.push({ method, params })
    if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 16, lost: 4, cause: 'mob_attack', source: 'drowned' }, state, events: [] } }
    if (method === 'observe') return { blocks: [{ name: 'water', dist: 3, nearest: { x: 12, y: 62, z: 10 } }] }
    return {} as Record<string, any>
  })
  await c.act('mine')
  const go = calls.find(x => x.method === 'goto')
  assert.ok(go, 'уход от воды')
  assert.ok(go.params.x < 10, 'прочь от воды (вода на востоке — идти на запад)')
  assert.equal(calls.some(x => x.method === 'shelter' || x.method === 'fight'), false)
})

test('ранен и голоден, охота отказывает сразу: еда повторяется не чаще раза в 90 с, без кручения ходов', async () => {
  const state: Record<string, any> = { health: 6, food: 10, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const clock: Record<string, any> = { t: Date.parse('2026-09-30T12:00:00Z') }
  let waits = 0
  const logs = []
  const c = campaign(state, { surface: true, foes: 0, night: false }, (method, params) => {
    if (method === 'wait') { waits++; clock.t += (params.seconds || 30) * 1000 }
    return {} as Record<string, any>
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
    const state: Record<string, any> = { health: 18, food: 20, dimension: 'overworld', pos: { x: 0, y: 62, z: 0 }, inventory: { stone_sword: 1, stone_pickaxe: 1 } }
    const calls = []
    const situation: Record<string, any> = { surface: true, inWater, foes, armed: true, verdict: 'драться', fight: { first: { name: 'drowned', dist: 5, ranged: true } } }
    const c = campaign(state, situation, method => {
      calls.push(method)
      if (method === 'dig_down') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 18, lost: 2, cause: 'trident', source: 'drowned' }, state, events: [] } }
      if (method === 'observe') return { blocks: [{ name: 'water', dist: 2, nearest: { x: 2, y: 61, z: 0 } }] }
      if (method === 'surface') situation.inWater = false
      return {} as Record<string, any>
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
    const state: Record<string, any> = { health: 17, food: 15, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
      inventory: { stone_sword: 1, stone_pickaxe: 1, ...(food ? { cooked_beef: 4 } : {} as Record<string, any>) } }
    const calls = []
    const c = campaign(state, { surface: true, foes: 1, armed: true, verdict: 'драться', fight: { first: { name: 'zombie', dist: 2 } } }, method => {
      calls.push(method)
      if (method === 'goto') return { rpcResult: { status: 'interrupted', by: { type: 'damage', health: 17, lost: 3, cause: 'mob_attack', source: 'zombie' }, state, events: [] } }
      if (method === 'eat') { state.food = 20; return { ate: 'cooked_beef' } }
      if (method === 'fight') return state.food >= 18 ? { swings: 4, kills: ['zombie'] } : { swings: 0, stopped: 'сытость не позволяет лечиться' }
      return {} as Record<string, any>
    })
    await c.act('goto')
    assert.equal(calls.includes('eat'), food)
    assert.equal(calls.includes('fight'), true)
    assert.equal(calls.includes('flee'), !food, food ? 'доел и дрался' : 'отказ боя — уйти')
  }
})

test('смерть во время ожидания «нет шага»: возрождение разобрано, ожидание не пропускается, ходы не крутятся', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1, cooked_beef: 3, stone_sword: 1 } }
  const clock: Record<string, any> = { t: Date.parse('2026-09-30T12:00:00Z') }
  let waits = 0
  const logs = []
  const c = campaign(state, { surface: false, foes: 0 }, (method, params) => {
    if (method === 'wait') {
      waits++
      clock.t += (params.seconds || 30) * 1000
      if (waits === 1) return { rpcResult: { status: 'interrupted', by: { type: 'death' }, state, events: [] } }
    }
    return {} as Record<string, any>
  }, { clock, logs, env: { ND_WATCHDOG_MIN: '10' } })
  c.ironOnly(async () => {})
  await c.boot()
  const turns = logs.filter(l => /(нет доступного шага|нужные этапы отложены)/.test(l)).length
  assert.ok(turns <= 15, `ходов ожидания ${turns}`)
  assert.match(logs.join(''), /БЛОКЕР: сторож/)
})

test('тело выпало из игры посреди прогона — кампания переподключает его, а не крутит этапы на пустом рюкзаке', async () => {
  const state: Record<string, any> = { connected: true, health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const calls = []
  let runs = 0
  const c = campaign(state, { surface: true, foes: 0 }, method => {
    calls.push(method)
    if (method === 'connect') state.connected = true
    return {} as Record<string, any>
  }, { argv: ['iron'] })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => { runs++; if (runs === 1) state.connected = false; else state.inventory.iron_pickaxe = 1 })
  await c.boot()
  assert.equal(calls.filter(x => x === 'connect').length, 2, 'в начале и после обрыва')
  assert.equal(runs, 2)
})

test('ночь, враг у места норы — нору под ним не копать: сперва бой (1–2 и меч) или отход, потом нора', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 16, cooked_beef: 4 } }
  const situation: Record<string, any> = { night: true, surface: true, foes: 1, armed: true, verdict: 'драться', fight: { first: { name: 'zombie', dist: 4 } } }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'fight') { situation.foes = 0; return { swings: 3, kills: ['zombie'] } }
    if (method === 'shelter' && params.mode === 'enter') {
      assert.equal(situation.foes, 0, 'нора копается только без врагов рядом')
      return { sealed: true }
    }
    if (method === 'wait') situation.night = false
    return {} as Record<string, any>
  })
  await c.nightGuard()
  assert.ok(calls.indexOf('fight') >= 0 && calls.indexOf('fight') < calls.indexOf('shelter'))
})

test('отход автопилота не вылечил (хп < 10) — своя отлёжка отходом, а не тот же шаг под стрелами', async () => {
  const state: Record<string, any> = { health: 12, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1, cobblestone: 30, cooked_beef: 4 } }
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
  }, { onStatus: () => { state.busy = null; state.health = 9; return { rpcResult: { status: 'done', detail: {} as Record<string, any>, state, events: [{ type: 'refuge', how: 'flee', code: 'CORNERED', hp0: 12, hp: 9 }] } } } })
  c.stage('stone')
  await c.act('mine', { block: 'stone', count: 20 })
  assert.ok(calls.indexOf('refuge') > 0, 'отлёжка — отходом кампании')
  assert.ok(calls.lastIndexOf('mine') > calls.indexOf('refuge'), 'шаг — после лечения')
})
