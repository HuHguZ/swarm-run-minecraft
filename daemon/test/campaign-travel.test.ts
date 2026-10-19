'use strict'
// Кампания: дороги поверху, разведка построек, подъём из-под земли, литьё портала (поверху и глубоко, ND_OW_DEEP).
import test = require('node:test')
import assert = require('node:assert/strict')
import { campaign } from './campaign-fixture'

test('structure scout loots a freshly observed chest before walking another search leg', async () => {
  const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const clock = { t: 100000 }; const calls = []
  const at = { x: 3, y: 64, z: 0 }
  const c = campaign(state, {}, (method, params) => {
    calls.push({ method, params })
    if (method === 'structure') return { known: [] }
    if (method === 'explore') { clock.t += 400; return { found: 'chest', at, note: 'уже видно отсюда' } }
    if (method === 'goto') clock.t += 30000
    if (method === 'loot') {
      assert.equal(params.visibleOnly, true, 'the new scout path must require client visibility rather than force loot')
      assert.ok(params.timeoutSeconds <= 179.6)
      clock.t += 500; state.inventory.iron_ingot = 4
      return { took: { iron_ingot: 4 } }
    }
    return {}
  }, { clock })
  await c.executeStrategy({ skill: 'scoutStructures' }, new AbortController().signal)
  assert.equal(calls.filter(call => call.method === 'loot').length, 1, 'the actual campaign adapter must preserve the observed chest receipt')
  assert.equal(calls.filter(call => call.method === 'goto').length, 0, 'take the resource before leaving the chest for another direction')
  assert.equal(state.inventory.iron_ingot, 4)
})

test('portal-room retries eat carried food and replace an exhausted pick before resuming the search', async () => {
  const state: any = { health: 20, food: 6, dimension: 'overworld', pos: { x: 1118, y: -27, z: 890 },
    inventory: { cooked_beef: 8, crafting_table: 1, stick: 2, cobblestone: 30 } }
  const calls: string[] = []
  const c = campaign(state, { free: 30 }, (method, params) => {
    if (method === 'eat') { calls.push('eat'); state.food = 20; state.inventory.cooked_beef-- }
    if (method === 'craft') {
      calls.push(params.item)
      if (params.item === 'stone_pickaxe') { state.inventory.stick -= 2; state.inventory.cobblestone -= 3; state.inventory.stone_pickaxe = 1 }
    }
    if (method === 'stronghold') {
      calls.push(params.mode)
      assert.ok(state.food >= 18, 'food already carried must enable regeneration while searching')
      assert.equal(state.inventory.stone_pickaxe, 1, 'spent pick must be replaced from carried materials')
    }
    return {}
  })
  await c.act('stronghold', { mode: 'room', timeoutSeconds: 120 })
  await c.act('stronghold', { mode: 'room', timeoutSeconds: 120 })
  assert.deepEqual(calls, ['eat', 'stone_pickaxe', 'room', 'room'])
})

test('overland travel tries a bounded surface exit before the distant XZ leg, and still travels if the exit is unavailable', async () => {
  for (const out of [true, false]) {
    const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 530, y: 1, z: 468 }, inventory: { iron_pickaxe: 1 } }
    const calls: any[] = []
    const sit: any = { surface: false, foes: 0, free: 30 }
    const c = campaign(state, sit, (method, params) => {
      if (method === 'surface') { calls.push({ method, params }); if (out) { state.pos.y = 70; sit.surface = true }; return { out } }
      if (method === 'goto') { calls.push({ method, params }); state.pos = { x: 1136, y: out ? 70 : 1, z: 896 } }
      return {}
    })
    await c.goToward({ x: 1136, z: 896 })
    assert.equal(calls[0]?.method, 'surface')
    assert.ok(calls[0].params.timeoutSeconds <= 120, 'recovery has a travel-sized budget')
    assert.equal(calls[1]?.method, 'goto', 'a failed climb does not prohibit the cheaper cave alternative')
    assert.equal(calls[1].params.surface, true)
  }
})

test('overland recovery leaves a nearby explicit underground destination and Nether travel alone', async () => {
  for (const dimension of ['overworld', 'the_nether']) {
    const state: any = { health: 20, food: 20, dimension, pos: { x: 530, y: 1, z: 468 }, inventory: { iron_pickaxe: 1 } }
    const calls: string[] = []
    const c = campaign(state, { surface: false, foes: 0, free: 30 }, (method, params) => {
      calls.push(method)
      if (method === 'goto') state.pos = { x: params.x, y: params.y ?? 1, z: params.z }
      return {}
    })
    await c.goToward({ x: 655, y: 1, z: 480 })
    assert.equal(calls.includes('surface'), false)
    assert.equal(calls.includes('goto'), true)
  }
})

test('overland recovery returns an interruption or changed dimension to its caller before another leg', async () => {
  for (const kind of ['tactical', 'dimension']) {
    const state: any = { health: 20, food: 20, dimension: 'overworld', pos: { x: 530, y: 1, z: 468 }, inventory: { iron_pickaxe: 1 } }
    const calls: string[] = []
    const c = campaign(state, { surface: false, foes: 0, free: 30 }, method => {
      calls.push(method)
      if (method === 'surface') {
        if (kind === 'dimension') { state.dimension = 'the_end'; return { out: false } }
        return { rpcResult: { status: 'interrupted', code: 'TACTICAL', state, events: [] } }
      }
      return {}
    })
    assert.equal(await c.goToward({ x: 1136, z: 896 }), false)
    assert.equal(calls.includes('goto'), false)
  }
})

test('portal-room search still walks known corridors without food or materials to craft a pick', async () => {
  const state: any = { health: 20, food: 17, dimension: 'overworld', pos: { x: 0, y: -20, z: 0 }, inventory: {} }
  const calls: string[] = []
  const c = campaign(state, {}, method => { calls.push(method); return {} })
  await c.act('stronghold', { mode: 'room', timeoutSeconds: 120 })
  assert.deepEqual(calls, ['stronghold'])
})
test('отказ отхода от воды прекращает спуск вместо повторной копки той же ямы', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 621, y: 64, z: -53 },
    inventory: { stone_pickaxe: 1, cobblestone: 16, crafting_table: 1, oak_log: 8 } }
  let digs = 0
  const c = campaign(state, { surface: true, pickLeft: 300 }, method => {
    if (method === 'dig_down') { digs++; return { stopped: 'вода у 621,62,-54 — дальше не копаю' } }
    if (method === 'goto') return { rpcResult: { status: 'failed', error: 'No path', state, events: [] } }
    return {} as Record<string, any>
  })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await assert.rejects(c.descend(16), /воды/)
  assert.equal(digs, 1, 'failed отход не разрешает ещё семь спусков в ту же воду')
})

test('подъём прекращает одинаковые попытки без движения и без нового инструмента', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: { wooden_pickaxe: 1 }, pos: { x: 22, y: 111, z: 88 } }
  const situation: Record<string, any> = { surface: false, pickLeft: 3 }
  let attempts = 0
  const c = campaign(state, situation, method => {
    if (method === 'surface') { attempts++; return { stopped: 'У кирки осталось ~3 удара — останавливаюсь заранее', out: false } }
    return {} as Record<string, any>
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => true })
  assert.equal(await c.toSurface(), false)
  assert.equal(attempts, 1, 'повтор без изменения условий не может сработать')
})

test('повторный отказ прыжка и отхода прекращает подъём, сохраняя сытость', async () => {
  const state: Record<string, any> = { health: 20, food: 20, pos: { x: -82, y: 85, z: 7 }, inventory: { stone_pickaxe: 2 } }
  let attempts = 0
  const c = campaign(state, { surface: false }, method => {
    if (method === 'surface') { attempts++; return { stopped: 'столб не встал: не подпрыгнул; лестница — не смог шагнуть', out: false } }
    return {} as Record<string, any>
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => true })
  assert.equal(await c.toSurface(8), false)
  assert.equal(attempts, 2, 'следующий неизменный прыжок тратит еду, а не даёт высоту')
})

test('неудачный подъём не запускает охоту под землёй', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: {} as Record<string, any>, pos: { x: 22, y: 111, z: 88 } }
  let attempts = 0
  const c = campaign(state, { surface: false }, method => {
    if (!['recall', 'situation', 'status'].includes(method)) attempts++
    return {} as Record<string, any>
  })
  c.hooks({ toSurface: async () => false })
  await c.runStage('food')
  assert.equal(attempts, 0, 'после отказа подъёма нельзя идти за деревом или зверями')
})

test('дорога в верхнем мире: новая кирка готовится до следующего перехода, если прежние стёрты', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: -81, y: 44, z: 243 },
    inventory: { crafting_table: 1, cobblestone: 416, stick: 8 } }
  let repaired = 0
  const c = campaign(state, { night: false, surface: false, foes: 0 }, (method, params) => {
    if (method === 'goto') {
      assert.ok(state.inventory.stone_pickaxe, 'переход не начинается без инструмента')
      state.pos.x = params.x; state.pos.z = params.z
    }
    return {} as Record<string, any>
  })
  c.hooks({ ensurePick: async () => { repaired++; state.inventory.stone_pickaxe = 1; return true } })
  await c.goToward({ x: -400, z: 1776 }, 150)
  assert.equal(repaired, 1)
})

for (const why of ['пути нет', 'кирок на дорогу не хватит: копок ~2244']) {
  test(`бастион: отказ маршрута «${why}» не подменяет завершённый бартер`, async () => {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 3, y: 69, z: 2 },
      armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, stone_pickaxe: 5, blaze_rod: 7, cooked_beef: 10, oak_planks: 16, crafting_table: 1 } }
    let attempts = 0
    const c = campaign(state, { foes: 0, pickLeft: 905 }, method => {
      if (method === 'nether_tunnel') { attempts++; return { ok: false, why, dug: 0, moves: 0 } }
      if (method === 'bastion') assert.fail('до самого бастиона не дошёл')
      return {} as Record<string, any>
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


test('вода над головой: подъём уходит штреком по очереди во все стороны, а не четырежды на восток', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 197, y: 57, z: 689 }, inventory: { stone_pickaxe: 3 } }
  const dirs = []
  const c = campaign(state, { surface: false, pickLeft: 300 }, (method, params) => {
    if (method === 'surface') return { out: false, stopped: 'вода у 197,60,689 — туда не копаю; отошёл на 4 и всё равно вода' }
    if (method === 'tunnel') { dirs.push(params.direction); return { stopped: 'вода на 198,59,689 (в 1 впереди сверху) — не копаю' } }
    return {} as Record<string, any>
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => true })
  assert.equal(await c.toSurface(), false)
  // Under a lake the 10-block tunnel stays put: each side then goes 3 lower and 16 aside (cl-b 14.10).
  assert.deepEqual(dirs, ['east', 'east', 'south', 'south', 'west', 'west', 'north', 'north'])
})

test('снег над головой без лопаты: подъём делает лопату из рюкзака и лезет снова', async () => {
  const state: Record<string, any> = { health: 3, food: 14, dimension: 'overworld', pos: { x: -105, y: 91, z: -23 },
    inventory: { stone_pickaxe: 4, cobblestone: 35, stick: 2, crafting_table: 1 } }
  const situation: Record<string, any> = { surface: false, pickLeft: 300 }
  const crafted = []
  const c = campaign(state, situation, (method, params) => {
    if (method === 'surface') {
      if (state.inventory.stone_shovel) { situation.surface = true; return { out: true } }
      return { out: false, stopped: 'snow_block голыми руками не ломается, а лопаты в рюкзаке нет вовсе. можно скрафтить iron_shovel' }
    }
    if (method === 'craft') { crafted.push(params.item); state.inventory[params.item] = (state.inventory[params.item] || 0) + 1 }
    return {} as Record<string, any>
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => true })
  assert.equal(await c.toSurface(), true)
  assert.ok(crafted.includes('stone_shovel'))
})

test('подъём без блоков: порода вокруг киркой, потом снова наверх (cl-c 14.10: «строить нечем» — простой до сторожа)', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 166, y: 65, z: 276 }, inventory: { stone_pickaxe: 1 } }
  const situation: Record<string, any> = { surface: false, pickLeft: 120 }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push(method)
    if (method === 'mine') { state.inventory.cobblestone = 12; return { dug: 12 } }
    if (method === 'surface') {
      if (state.inventory.cobblestone) { situation.surface = true; return { out: true } }
      return { out: false, stopped: 'столб строить нечем, а лестницу не вырубить: ступеньку не на что положить, и строить нечем' }
    }
    return {} as Record<string, any>
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => true })
  assert.equal(await c.toSurface(), true)
  assert.deepEqual(calls.filter(m => m !== 'situation' && m !== 'status'), ['surface', 'mine', 'surface'])
})

test('руда над головой не по кирке: шаг вбок штреком и снова наверх (cl-f 14.10: медь над деревянной киркой)', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: -31, y: 25, z: -70 }, inventory: { wooden_pickaxe: 1, cobblestone: 40 } }
  const situation: Record<string, any> = { surface: false, pickLeft: 98 }
  const tunnels = []
  const c = campaign(state, situation, (method, params) => {
    if (method === 'tunnel') { tunnels.push(params.direction); state.pos = { ...state.pos, x: state.pos.x + 4 }; return {} }
    if (method === 'surface') {
      if (tunnels.length) { situation.surface = true; return { out: true } }
      return { out: false, stopped: 'для copper_ore нужна кирка получше (copper_pickaxe / stone_pickaxe / iron_pickaxe / diamond_pickaxe)' }
    }
    return {} as Record<string, any>
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => true })
  assert.equal(await c.toSurface(), true)
  assert.deepEqual(tunnels, ['east'])
})

test('литьё глубоко без видимой лавы: штрек вскрывает лаву, её место запоминается, литьё идёт у неё', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 354, y: -53, z: -177 },
    inventory: { diamond_pickaxe: 1, stone_pickaxe: 2, bucket: 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 6, cobblestone: 64 } }
  const places: Record<string, any> = {} as Record<string, any>
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
    // S8d: лава из стопа штрека — цель, только если её видно (вскрыта): глаза её помнят.
    if (method === 'perceive' && params.mode === 'seen') return { seen: [{ name: 'lava', x: 380, y: -56, z: -177, dist: 0, ago: 0 }] }
    if (method === 'goto') { state.pos = { x: 376, y: -55, z: -177 }; return {} as Record<string, any> }
    return {} as Record<string, any>
  })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('cast')
  assert.ok(calls.includes('tunnel'), 'глубоко — штрек, а не разведка ходьбой')
  assert.equal(calls.includes('explore'), false)
  assert.deepEqual({ x: c.known.lava.x, y: c.known.lava.y, z: c.known.lava.z }, { x: 380, y: -56, z: -177 })
  assert.ok(calls.indexOf('goto') > calls.indexOf('tunnel'), 'к вскрытой лаве')
  assert.equal(casts, 3)
})

test('глубоко с алмазной киркой литьё отложено — берётся обсидиан ведром', () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: -53, z: 0 },
    inventory: { diamond_pickaxe: 1, bucket: 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 8 } }
  const c = campaign(state, { surface: false, night: false })
  assert.equal(c.needs('cast'), true)
  assert.equal(c.ready('cast'), true)
  assert.equal(c.defers('cast'), true, 'под землёй раме негде расти')
  state.pos.y = 64
  assert.equal(c.defers('cast'), false, 'поверху литьё — как раньше')
})

test('литью не хватает одного блока — добирает недостающий наполнитель и пробует снова', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: -651, y: 86, z: -232 },
    inventory: { stone_pickaxe: 1, bucket: 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 8, dirt: 2 } }
  const places = { 'лава': { x: -640, y: 80, z: -230, dimension: 'overworld' } }
  const calls = []
  let casts = 0
  const c = campaign(state, { surface: true, foes: 0, night: false, free: 20 }, (method, params) => {
    calls.push({ method, params })
    if (method === 'recall') return { state: { places } }
    if (method === 'portal') {
      casts++
      if (state.inventory.dirt < 3) return { stopped: 'нужно блоков 3', need: { what: 'cobblestone', count: 3, have: state.inventory.dirt } }
      places['портал'] = { x: -645, y: 80, z: -230, dimension: 'overworld' }
      return { built: true }
    }
    if (method === 'mine' && params.block.split(',').includes('grass_block')) state.inventory.dirt += params.count
    return {} as Record<string, any>
  })
  c.hooks({ recoverGuard: async () => {} })
  await c.runStage('cast')
  assert.ok(calls.some(x => x.method === 'mine' && x.params.block.split(',').includes('grass_block') && x.params.count === 1 && x.params.timeoutSeconds === 35))
  assert.equal(calls.some(x => x.method === 'dig_down'), false)
  assert.equal(state.inventory.dirt, 3)
  assert.equal(casts, 2)
  assert.ok(c.known.portal)
})

test('литьё поверху: обзор и две разведки без лавы — запасной путь через алмазы (кирка из железа), литьё ждёт лаву', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 70, z: 0 },
    inventory: { stone_pickaxe: 2, bucket: 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 8, cobblestone: 64 } }
  const calls = []
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    calls.push(method)
    if (method === 'portal') return { stopped: 'не вижу лавы-источника в 24 блоках — подойди к лаве (озеро, пещера)' }
    if (method === 'explore') return { note: 'не нашёл за отведённое время' }
    return {} as Record<string, any>
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

test('горы без зверей: две пустые охоты — железо и при сытости 8; пустой отрезок в гору — поворот', async () => {
  const state: Record<string, any> = { health: 20, food: 10, dimension: 'overworld', pos: { x: 0, y: 120, z: 0 },
    inventory: { stone_pickaxe: 1, stone_sword: 1, oak_log: 4 } }
  const gotos = []
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    if (method === 'goto') { gotos.push(params); state.pos = { x: params.x, y: state.pos.y + 15, z: params.z } }
    if (method === 'observe') return { entities: [], blocks: [] }
    return {} as Record<string, any>
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

test('ND_OW_DEEP: legacy-компаратор два ведра — колодец к −54 и окно у известной по раскладке лавы', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 70, z: 0 },
    inventory: { stone_pickaxe: 2, bucket: 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 8, cobblestone: 64, oak_log: 8, crafting_table: 1 } }
  const places: Record<string, any> = {} as Record<string, any>
  const calls = []
  const situation: Record<string, any> = { surface: true, foes: 0, night: false, pickLeft: 400, free: 20 }
  const c = campaign(state, situation, (method, params) => {
    calls.push({ method, params })
    if (method === 'recall') return { state: { places } }
    if (method === 'dig_down') { state.pos = { x: 10, y: -54, z: 0 }; situation.surface = false; return { dug: 40, steps: 30 } }
    if (method === 'tunnel' && params.direction === 'down') { state.pos = { x: 10, y: -54, z: 0 }; situation.surface = false; return { dug: 124, descended: 124 } }
    if (method === 'tunnel') return { stopped: 'лава на 11,-55,0 (в 1 впереди, ниже) — не копаю, обходи другим направлением или на 3 блока в сторону' }
    if (method === 'portal') {
      assert.equal(params.windows, true)
      assert.equal(params.one, undefined)
      assert.deepEqual(params.hint, { x: 11, y: -55, z: 0 })
      places['портал'] = { x: 3, y: -54, z: 0, dimension: 'overworld' }
      return { built: true, lit: true }
    }
    return {} as Record<string, any>
  // Отдельный прежний профиль со знанием раскладки; не метрика RSG.
  }, { env: { ND_OW_DEEP: '1', ND_OW_HEAR: '0', ND_HONEST_LAVA: '0', ND_ROUTE_ONE: '0' } })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('cast')
  assert.ok(c.known.portal, 'портал отлит глубоко')
  const ms = calls.map(x => x.method === 'tunnel' && x.params.direction === 'down' ? 'shaft' : x.method)
  assert.ok(ms.includes('shaft') && ms.indexOf('tunnel') > ms.indexOf('shaft') && ms.indexOf('portal') > ms.indexOf('tunnel'))
  assert.equal(ms.includes('dig_down'), false, 'колодец дошёл — лесенка не нужна')
  assert.equal(ms.includes('explore'), false, 'без разведки поверху')
})

for (const buckets of [1, 2]) test(`ND_OW_DEEP: скрытый источник не превращается в портал, даже с ${buckets} вёдрами`, async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 10, y: -54, z: 0 },
    inventory: { stone_pickaxe: 2, bucket: buckets - 1, water_bucket: 1, flint_and_steel: 1, cooked_beef: 8, cobblestone: 64 } }
  const lava = { x: 11, y: -55, z: 0, dimension: 'overworld' }
  const calls: Array<{ method: string, params: any }> = []
  const c = campaign(state, { surface: false, foes: 0, night: false, pickLeft: 400, free: 20 }, (method, params) => {
    calls.push({ method, params })
    if (method === 'recall') return { state: { places: { 'лава': lava } } }
    if (method === 'perceive') return { seen: [] }
    if (method === 'portal') return { built: false, stopped: 'не вижу лавы-источника в 24 блоках' }
    if (method === 'tunnel') return { stopped: 'лава на 11,-55,0 (в 1 впереди, ниже) — не копаю' }
    return {}
  }, { env: { ND_OW_DEEP: '1', ND_OW_HEAR: '0', ND_ROUTE_ONE: '1', ND_MAP: '0', ND_HONEST_LAVA: '1' } })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('cast')
  const casts = calls.filter(x => x.method === 'portal')
  assert.ok(casts.length > 0, 'раньше увиденную лаву пробует снова найти глазами')
  assert.ok(casts.every(x => x.params.one === true && x.params.hint === undefined))
  assert.equal(c.known.portal, null, 'стена перед известной лавой не означает физически доступный источник')
})

test('ND_OW_DEEP: вода под землёй — штрек встал у воды, окно и черпак тем же литьём, без подъёма', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 16, z: 0 },
    inventory: { stone_pickaxe: 2, bucket: 2, flint_and_steel: 1, cooked_beef: 8, cobblestone: 64 } }
  const calls = []
  const c = campaign(state, { surface: false, foes: 0, night: true }, (method, params) => {
    calls.push(method)
    if (method === 'bucket') return { filled: false, stopped: 'не вижу источника воды в 32 блоках' }
    if (method === 'tunnel') return { stopped: 'вода на 5,16,-3 (слева) — не копаю, обходи другим направлением или на 3 блока в сторону' }
    if (method === 'portal') { assert.deepEqual(params.waterHint, { x: 5, y: 16, z: -3 }); state.inventory.bucket = 1; state.inventory.water_bucket = 1; return { water: true } }
    return {} as Record<string, any>
  }, { env: { ND_OW_DEEP: '1', ND_OW_HEAR: '0' } })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.runStage('water')
  assert.equal(state.inventory.water_bucket, 1)
  assert.equal(calls.includes('surface'), false, 'наверх не лезет')
})

test('ND_OW_DEEP: до портала под землёй за едой не поднимается (сытость ≥ 10), ранен и голоден — поднимается', () => {
  const state: Record<string, any> = { health: 20, food: 15, dimension: 'overworld', pos: { x: 0, y: 16, z: 0 }, inventory: { stone_pickaxe: 1, cooked_beef: 2 } }
  const situation: Record<string, any> = { surface: false, night: false }
  const c = campaign(state, situation, () => ({} as Record<string, any>), { env: { ND_OW_DEEP: '1' } })
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
