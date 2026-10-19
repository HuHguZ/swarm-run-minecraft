'use strict'
// Кампания: бастион — выработанный и следующий, отказ с причиной, золото на тело, паузы мест B1/B2, перезаход, штрек, выработка пола.
import test = require('node:test')
import assert = require('node:assert/strict')
import { campaign } from './campaign-fixture'

test('возобновление кампании сохраняет выработанный бастион и выбирает следующий', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 300, y: 20, z: 150 },
    inventory: { iron_pickaxe: 1, blaze_rod: 7, ender_pearl: 2 } }
  const places = {
    'портал': { x: 0, y: 65, z: 0, dimension: 'overworld' },
    'бастион (ад)': { x: 100, y: 40, z: 80, dimension: 'the_nether' },
    'бастион 2 (ад)': { x: 700, y: 45, z: 300, dimension: 'the_nether' },
    'выработан: бастион (ад)': { x: 94, y: 40, z: 120, dimension: 'the_nether', note: 'Бартер завершён' }
  }
  const c = campaign(state, {} as Record<string, any>, method => method === 'recall' ? { state: { places } } : {} as Record<string, any>)
  await c.readMemory()
  assert.equal(c.nextBastion().key, 'бастион 2 (ад)', 'после перезапуска не идёт обратно в уже выработанный бастион')
  // Запись от другого мира или перемещённого места не должна сдавать новый бастион.
  places['бастион (ад)'].x = 2000
  const fresh = campaign(state, {} as Record<string, any>, method => method === 'recall' ? { state: { places } } : {} as Record<string, any>)
  await fresh.readMemory()
  assert.equal(fresh.nextBastion().key, 'бастион (ад)')
})
test('a refused Bastion preserves its exact cover reason and bounded execution failures in the real act telemetry', async () => {
  const records: Array<Record<string, any>> = []
  const logs: string[] = []
  const failures = ['old0', 'old1', 'old2', 'old3', 'old4', 'old5', 'old6', 'яма: не шагнул down в54,35,111']
  const cover = { position: { x: 53.1723, y: 37, z: 112.9182 }, onGround: true, body: { minX: 52.8723, maxX: 53.4723 }, cells: [] }
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 53, y: 37, z: 112 }, inventory: { gold_ingot: 135 } }
  const c = campaign(state, { foes: 0 }, () => ({ stopped: 'защищённое укрытие для бартера не подтверждено',
    barterRetry: 'стены или потолок физически не замкнуты', barterCover: cover, sealed: { fails: failures } }), { records, logs })
  await c.act('bastion', { mode: 'barter', x: 87, y: 35, z: 139 })
  const row = records.find(record => record.level === 'act' && record.skill === 'bastion')!
  assert.equal(row.barterRetry, 'стены или потолок физически не замкнуты')
  assert.deepEqual(Array.from(row.sealedFails), failures.slice(-6))
  assert.deepEqual(JSON.parse(JSON.stringify(row.barterCover)), cover)
  assert.ok(logs.some(line => line.includes('стены или потолок физически не замкнуты')))
  assert.ok(logs.some(line => line.includes('яма: не шагнул down в54,35,111')))
})
test('bastion campaign wears carried gold before mining armor resources or refusing the stage', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 87, y: 36, z: 137 },
    armor: { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' },
    playPolicy: { mode: 'speedrun' }, inventory: { golden_chestplate: 1, golden_boots: 1, iron_pickaxe: 1, stone_pickaxe: 2,
      oak_planks: 10, stick: 2, crafting_table: 1, cooked_beef: 12, fire_charge: 12 } }
  const methods: string[] = []
  const places = { 'портал': { x: -6, y: 67, z: 6, dimension: 'overworld' },
    'бастион (ад)': { x: 87, y: 35, z: 139, dimension: 'the_nether' } }
  const c = campaign(state, { pickLeft: 300, foes: 0, inWater: false }, method => {
    methods.push(method)
    if (method === 'recall') return { state: { places } }
    if (method === 'armor') { state.armor.feet = 'golden_boots'; return {} }
    if (method === 'bastion') { state.inventory.ender_pearl = 12; state.inventory.obsidian = 10; return { done: true } }
    return {}
  })
  c.hooks({ spares: async () => {}, ensurePick: async () => {}, recoverGuard: async () => {} })
  await c.readMemory()
  await c.runStage('bastion')
  assert.ok(methods.includes('armor'))
  assert.ok(methods.includes('bastion'), 'the existing mature bastion skill must actually execute')
  assert.ok(methods.indexOf('armor') < methods.indexOf('bastion'))
  assert.equal(methods.includes('mine'), false)
  assert.equal(methods.includes('explore'), false)
})
test('a B1 stage pause belongs to its attempted site, allows B2 and still bounds a return to B1', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether',
    pos: { x: 96, y: 49, z: 143 }, inventory: { oak_planks: 8, crafting_table: 1, iron_pickaxe: 1, stone_pickaxe: 2, cooked_beef: 12 } }
  const clock = { t: Date.parse('2026-10-06T00:47:04Z') }
  const start = clock.t
  const attempts: Array<{ site: string; elapsed: number }> = []
  const places = { 'портал': { x: 9, y: 65, z: -5, dimension: 'overworld' },
    'бастион (ад)': { x: 87, y: 35, z: 139, dimension: 'the_nether' },
    'бастион 2 (ад)': { x: 545, y: 48, z: -99, dimension: 'the_nether' } }
  const c = campaign(state, { foes: 0, pickLeft: 413 }, (method, params) => {
    if (method === 'recall') return { state: { places } }
    if (method === 'wait') clock.t += (params.seconds || 30) * 1000
    return {}
  }, { clock, argv: ['bastion'] })
  c.hooks({ recoverGuard: async () => {} })
  c.bastionOnly(async () => {
    const site = c.nextBastion()
    attempts.push({ site: site.key, elapsed: clock.t - start })
    if (attempts.length === 2) c.deferBastion(site, clock.t + 300000)
    if (site.key === 'бастион 2 (ад)') {
      c.deferBastion(c.known.bastions[0], 0)
      c.deferBastion(site, clock.t + 600000)
    }
    if (attempts.length === 4) state.playPolicy = { mode: 'free' }
  })
  await c.boot()
  assert.deepEqual(attempts, [{ site: 'бастион (ад)', elapsed: 0 }, { site: 'бастион (ад)', elapsed: 0 },
    { site: 'бастион 2 (ад)', elapsed: 0 }, { site: 'бастион (ад)', elapsed: 300000 }])
})
test('two bounded mapped B1 failures select B2 even when the first attempt only approached gold', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether',
    pos: { x: 96, y: 49, z: 143 }, inventory: { oak_planks: 8, crafting_table: 1,
      iron_pickaxe: 1, stone_pickaxe: 2, cooked_beef: 12, blackstone: 59 } }
  const clock = { t: Date.parse('2026-10-06T01:10:00Z') }
  const start = clock.t
  const attempts: Array<{ site: string; elapsed: number }> = []
  const methods: string[] = []
  const logs: string[] = []
  const places = { 'портал': { x: 9, y: 65, z: -5, dimension: 'overworld' },
    'бастион (ад)': { x: 87, y: 35, z: 139, dimension: 'the_nether', gold: [[88, 35, 140]] },
    'бастион 2 (ад)': { x: 545, y: 48, z: -99, dimension: 'the_nether', gold: [[544, 48, -98]] } }
  const c = campaign(state, { foes: 0, pickLeft: 413 }, (method, params) => {
    methods.push(method)
    if (method === 'recall') return { state: { places } }
    if (method === 'wait') clock.t += (params.seconds || 30) * 1000
    return {}
  }, { clock, logs, argv: ['bastion'], env: { ND_GOLD_FAST_SAFE: '1' } })
  c.hooks({ recoverGuard: async () => {} })
  c.bastionOnly(async () => {
    attempts.push({ site: c.nextBastion().key, elapsed: clock.t - start })
    state.pos = { x: 104, y: 35, z: 141 }
    state.inventory.blackstone += 12
    if (attempts.length === 3) state.playPolicy = { mode: 'free' }
  })
  await c.boot()
  assert.deepEqual(attempts, [{ site: 'бастион (ад)', elapsed: 0 }, { site: 'бастион (ад)', elapsed: 0 },
    { site: 'бастион 2 (ад)', elapsed: 0 }], 'approach and incidental blocks are failures, so the existing pause must advance to the real next site')
  assert.equal(methods.includes('portal'), false, 'a known eligible B2 does not require leaving the Nether')
  assert.equal(c.nextBastion().key, 'бастион 2 (ад)')
  assert.doesNotMatch(logs.join(''), /выработан/)
})
test('already deferred mapped sites cannot reset a failed bastion by alternating the earliest fallback', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether',
    pos: { x: 104, y: 35, z: 141 }, inventory: { oak_planks: 8, crafting_table: 1,
      iron_pickaxe: 1, stone_pickaxe: 2, cooked_beef: 12 } }
  const clock = { t: Date.parse('2026-10-06T01:10:00Z') }
  const start = clock.t
  const places = { 'портал': { x: 9, y: 65, z: -5, dimension: 'overworld' },
    'бастион (ад)': { x: 87, y: 35, z: 139, dimension: 'the_nether', gold: [[88, 35, 140]] },
    'бастион 2 (ад)': { x: 545, y: 48, z: -99, dimension: 'the_nether', gold: [[544, 48, -98]] } }
  const attempts: string[] = []
  const logs: string[] = []
  const c = campaign(state, { foes: 0, pickLeft: 413 }, method => method === 'recall' ? { state: { places } } : {},
    { clock, logs, argv: ['bastion'], env: { ND_GOLD_FAST_SAFE: '1' } })
  await c.readMemory()
  c.deferBastion(c.known.bastions[0], start + 60000)
  c.deferBastion(c.known.bastions[1], start + 120000)
  c.hooks({ recoverGuard: async () => {} })
  c.bastionOnly(async () => {
    attempts.push(c.nextBastion().key)
    if (attempts.length === 2) state.playPolicy = { mode: 'free' }
  })
  await c.boot()
  assert.deepEqual(attempts, ['бастион (ад)', 'бастион (ад)'])
  assert.equal(clock.t, start)
  assert.equal(c.nextBastion().key, 'бастион (ад)', 'a still deferred B2 is not a new eligible route')
  assert.doesNotMatch(logs.join(''), /отложен на бюджет следующего маршрута/)
  assert.match(logs.join(''), /два пустых захода подряд — пауза 5 мин/)
})
test('two tactical interruptions of the real bastion stage do not exhaust its admission budget', async () => {
  const state: any = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 172, y: 59, z: -238 },
    armor: { feet: 'golden_boots' }, inventory: { stone_pickaxe: 3, oak_planks: 4, stick: 2,
      cobblestone: 8, iron_ingot: 2, cooked_beef: 7, water_bucket: 1, flint_and_steel: 1 } }
  const clock = { t: Date.parse('2026-10-11T18:54:03Z') }
  const start = clock.t; const attempts = []; const logs = []; const methods = []
  const places = { 'портал': { x: 32, y: 65, z: -73, dimension: 'overworld' },
    'бастион (ад)': { x: 154, y: 47, z: -250, dimension: 'the_nether' } }
  const c = campaign(state, { foes: 0, pickLeft: 330 }, (method, params) => {
    methods.push(method)
    if (method === 'recall') return { state: { places } }
    if (method === 'wait') clock.t += (params.seconds || 30) * 1000
    if (method === 'bastion') {
      attempts.push({ x: params.x, z: params.z, elapsed: clock.t - start })
      if (attempts.length < 3) return { rpcResult: { status: 'interrupted', code: 'TACTICAL',
        by: { type: 'tactical' }, state, detail: {}, events: [] } }
      state.playPolicy = { mode: 'free' }
    }
    return {}
  }, { clock, logs, argv: ['bastion'] })
  c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
  await c.boot()
  assert.deepEqual(attempts.slice(0, 3), [0, 0, 0].map(elapsed => ({ x: 154, z: -250, elapsed })),
    'preempted reconnaissance must remain eligible after observing the released Tactical owner')
  assert.doesNotMatch(logs.join(''), /пауза 5 мин/)
  assert.equal(methods.includes('nether_tunnel'), false, 'an interruption must not send the body home as though the bastion were exhausted')
})
test('speedrun bastion re-entry preserves prepared wood and iron instead of creating an optional base cache', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 5, y: 67, z: -12 },
    playPolicy: { mode: 'speedrun' }, armor: { feet: 'golden_boots' }, inventory: { oak_planks: 14,
      crafting_table: 1, iron_ingot: 7, stick: 2, iron_pickaxe: 1, stone_pickaxe: 2, cooked_beef: 12, flint_and_steel: 1 } }
  const methods: string[] = []
  const crafted: string[] = []
  const c = campaign(state, { foes: 0, pickLeft: 343, surface: true, night: false }, (method, params) => {
    methods.push(method)
    if (method === 'craft') crafted.push(params && params.item)
    if (method === 'chest_list') assert.fail('ready Nether supplies must not be spent on a new optional base chest')
    if (method === 'portal') { state.dimension = 'the_nether'; state.pos = { x: 87, y: 36, z: 137 }; return { went: true } }
    if (method === 'bastion') {
      assert.equal(state.inventory.oak_planks, 14)
      assert.equal(state.inventory.iron_ingot, 7)
      assert.equal(state.inventory.stick, 2)
      state.inventory.ender_pearl = 12; state.inventory.obsidian = 10; state.potions = { fire_resistance: 3 }
      return { goldBlocksDug: 1, ingotsTraded: 9 }
    }
    return {}
  }, { env: { ND_NE_ROUTE: '1' } })
  c.known.portal = { x: 5, y: 67, z: -12, dimension: 'overworld' }
  c.known.bastions = [{ key: 'бастион (ад)', x: 87, y: 35, z: 139, dimension: 'the_nether', gold: [[88, 35, 140]] }]
  c.hooks({ recoverGuard: async () => {}, spares: async () => {}, ensurePick: async () => {} })
  await c.runStage('bastion')
  assert.ok(methods.includes('portal'))
  assert.ok(methods.includes('bastion'), 'the real mature skill still executes after entering the Nether')
  assert.equal(methods.includes('chest_put'), false)
  // The only spend at the door is the shield the spawner fight requires (fightReady); a cheap one, crafted before entry (cl-ab 14.10).
  assert.deepEqual(crafted.filter(item => item !== 'shield'), [])
})
test('бастион: выработанный первый — этап идёт ко второму по памяти, сухой заход не выжигает бастион', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 90, y: 45, z: 140 },
    armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, stone_pickaxe: 1, blaze_rod: 7, cooked_beef: 10, oak_planks: 16, crafting_table: 1 } }
  const targets = []
  const c = campaign(state, { foes: 0, pickLeft: 381 }, (method, params) => {
    if (method !== 'bastion') return {} as Record<string, any>
    targets.push(params.x)
    if (targets.length === 1) { state.inventory.ender_pearl = 6; return { goldBlocksDug: 17, ingotsTraded: 150, stopped: 'золото кончилось: видимых блоков больше нет', bag: {} as Record<string, any> } }
    if (targets.length === 2) return { goldBlocksDug: 0, ingotsTraded: 0, stopped: 'до бастиона не дошёл: 300 блоков', bag: {} as Record<string, any> }
    state.inventory.ender_pearl = 12
    state.potions = { fire_resistance: 3 }
    return { goldBlocksDug: 18, ingotsTraded: 160, bag: {} as Record<string, any> }
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
test('s1f: вслепую закрытый штрек у бастиона ничего не дал — следующий заход открытым обзором только при ND_BASTION_OPEN=1 (по умолчанию выкл.)', async () => {
  for (const off of [false, true]) {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 100, y: 50, z: 90 },
      armor: { head: 'golden_helmet' }, inventory: { iron_pickaxe: 1, stone_pickaxe: 1, blaze_rod: 7, cooked_beef: 10, oak_planks: 16, crafting_table: 1 } }
    const calls: any[] = []
    const c = campaign(state, { foes: 0, pickLeft: 381 }, (method, params) => {
      if (method !== 'bastion') return {} as Record<string, any>
      calls.push(params.sealed)
      return { goldBlocksDug: 0, ingotsTraded: 0, stopped: 'золото кончилось: видимых блоков больше нет', bag: {} as Record<string, any> }
    }, { env: off ? {} : { ND_BASTION_OPEN: '1' } })
    c.known.portal = { x: -19, y: 65, z: -24 }
    c.known.bastions = [{ key: 'бастион (ад)', x: 105, y: 43, z: 87 }]
    c.known.stronghold = { x: -400, y: 30, z: 1776 }
    c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
    await c.runStage('bastion')
    assert.deepEqual(calls, off ? [true] : [true, false], off ? 'выключено — один закрытый заход' : 'закрытый, затем открытый')
  }
})
test('s1f: у бастиона штрек «пути нет» — прочь от бастиона пешком можно, к нему — нет (ND_NE_BASTION_AWAY=0 — никогда)', async () => {
  for (const [target, off, walks] of [[{ x: -100, z: 0 }, false, true], [{ x: 100, z: 60 }, false, false], [{ x: -100, z: 0 }, true, false]] as any[]) {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 0, y: 64, z: 0 }, inventory: { iron_pickaxe: 1 } }
    const gotos: any[] = []
    const c = campaign(state, { foes: 0 }, (method, params) => {
      if (method === 'nether_tunnel') return { ok: false, why: 'пути нет', segs: 0, dug: 0 }
      if (method === 'ne_burrow') return { ok: false }
      if (method === 'perceive') return { seen: [], entities: [] }
      if (method === 'goto') { gotos.push(params.x); state.pos.x = params.x; state.pos.z = params.z }
      return {} as Record<string, any>
    }, { env: off ? { ND_NE_BASTION_AWAY: '0' } : {} })
    c.known.bastions = [{ key: 'бастион (ад)', x: 40, y: 50, z: 0 }]
    c.hooks({ ensurePick: async () => true })
    await c.goToward(target, 6)
    assert.equal(gotos.length > 0, walks, JSON.stringify({ target, off, gotos }))
  }
})
test('s1f: огнестойкость в рюкзаке, жемчуга ≥ 6, крепость известна — бастион ждёт (неудача этапа: сперва стержни), ND_RODS_FIRST_FR=0 — как было', async () => {
  for (const off of [false, true]) {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 100, y: 50, z: 90 }, armor: { head: 'golden_helmet' },
      potions: { fire_resistance: 2 }, inventory: { iron_pickaxe: 1, stone_pickaxe: 1, cooked_beef: 10, oak_planks: 16, crafting_table: 1, ender_pearl: 8 } }
    const calls: any[] = []
    const c = campaign(state, { foes: 0, pickLeft: 381 }, (method) => { calls.push(method); return {} as Record<string, any> }, { env: off ? { ND_RODS_FIRST_FR: '0' } : {} })
    c.known.portal = { x: -19, y: 65, z: -24 }
    c.known.fortress = { x: 40, y: 64, z: 40 }
    c.known.bastions = [{ key: 'бастион (ад)', x: 105, y: 43, z: 87 }]
    c.hooks({ recoverGuard: async () => {}, spares: async () => {} })
    let err = null
    try { await c.runStage('bastion') } catch (e) { err = e }
    assert.equal(!!err && /стержни/.test(err.message), !off, off ? 'выключено — бастион как прежде' : 'сперва стержни')
    assert.equal(calls.includes('bastion'), off)
  }
})
test('failed bastion stock stays remembered while its unchanged approach is replaced by a different known site',async()=>{
  const state:any={health:20,food:20,dimension:'the_nether',pos:{x:0,y:64,z:0},inventory:{iron_pickaxe:1,stone_pickaxe:1,cooked_mutton:8}}
  const c=campaign(state,{foes:0,pickLeft:381},()=>({}),{env:{ND_NE_RECOVER:'1'}})
  const a={key:'бастион (ад)',dimension:'the_nether',x:10,y:40,z:0,gold:[[10,36,0]]},b={...a,key:'бастион 2 (ад)',x:80}
  c.known.bastions=[a,b]
  c.deferBastionMining(a)
  assert.equal(c.nextBastion().key,b.key)
  assert.equal(a.gold.length,1)
})
test('fs1: after floor exhaustion a priced physical continuation competes with the next graph goal', async()=>{
  for(const seconds of [1,10000]) {
    const state:any={health:20,food:20,dimension:'the_nether',pos:{x:12,y:72,z:-12},inventory:{iron_pickaxe:1,stone_pickaxe:1,iron_sword:1,cooked_mutton:8,cobblestone:64,crafting_table:1}}
    const calls:any[]=[],c=campaign(state,{foes:0,pickLeft:381},(m,p)=>{
      calls.push({m,p});if(m==='recall')return{state:{places:{'крепость (ад)':{x:46,y:70,z:-13,dimension:'the_nether'}}}}
      return m==='fortress' && p.planOnly ? {plan:{key:'observed-plan',seconds}} : {}
    },{env:{ND_FORTRESS_CONTINUE:'1',ND_NE_RECOVER:'1'}})
    c.known.fortress={x:46,y:70,z:-13}
    const before=await c.worldObservation()
    const blocked={observed:c.retryState(),origin:{...state.pos},frontier:c.retryState()}
    const selected:any={before,strategy:{id:'HuntEndermen',estimateCost:()=>2000,estimateRisk:()=>0.5}}
    const ran=await c.continueFortressChoice(selected,blocked)
    assert.equal(!!ran,seconds===1)
    assert.equal(calls.filter(r=>r.m==='fortress' && !r.p.planOnly).length,seconds===1?1:0)
    assert.equal(calls.some(r=>r.m==='wait'),false)
  }
})
test('fs1: failed continuation leaves the actual campaign through B7 recovery, with no healthy observe/wait loop',async()=>{
  const state:any={connected:true,health:20,food:20,dimension:'the_nether',playPolicy:{mode:'speedrun'},pos:{x:12,y:72,z:-12},inventory:{iron_pickaxe:1,stone_pickaxe:1,iron_sword:1,cooked_mutton:8,cobblestone:64,crafting_table:1}}
  const calls:any[]=[],logs:string[]=[],clock={t:100000}
  let attempted=0
  const places={'портал':{x:0,y:65,z:0,dimension:'overworld'},'крепость (ад)':{x:46,y:70,z:-13,dimension:'the_nether'}}
  const c=campaign(state,{foes:0,pickLeft:381,surface:false},(m,p)=>{
    calls.push({m,p});if(m==='recall')return{state:{places}}
    if(m==='fortress') {
      if(p.mode!=='continue')return{frontierExhausted:true}
      if(p.planOnly)return{plan:attempted?null:{key:'failed-physical-leg',seconds:1}}
      attempted++;return{advanced:false,continuationTried:1}
    }
    if(m==='wait'){clock.t+=p.seconds*1000;if(calls.filter(r=>r.m==='wait').length>=400)state.inventory.blaze_rod=7}
    return{}
  },{env:{ND_NE_STAY:'1'},argv:['nether'],clock,logs})
  c.netherOnly(async()=>{})
  await c.boot()
  assert.ok(calls.some(r=>r.m==='fortress' && r.p.mode==='continue'),'the body asks for a physical continuation after floor exhaustion')
  assert.equal(attempted,1,'the same failed physical actuator is not an endless source of RPC retries')
  assert.equal(calls.filter(r=>r.m==='wait').length,0)
  assert.equal(calls.filter(r=>r.m==='explore').length,1,'the fallback is B7, not a second general scout loop')
  assert.ok(logs.some(l=>l.includes('завершаю без пустого ожидания')))
})
test('fs1: a real active threat or the continuation switch prevents starting a new construction leg',async()=>{
  for(const [flag,threat] of [['0',0],['1',2]]) {
    const env={ND_FORTRESS_CONTINUE:flag}
    const state:any={health:20,food:20,dimension:'the_nether',tactics:{threatLevel:threat},pos:{x:12,y:72,z:-12},inventory:{iron_pickaxe:1}}
    const calls:string[]=[],c=campaign(state,{foes:1,pickLeft:200},m=>{calls.push(m);return{}},{env})
    c.known.fortress={x:46,y:70,z:-13}
    const mark={observed:c.retryState(),origin:{...state.pos},frontier:c.retryState()}
    assert.equal(await c.continueFortressChoice(null,mark),false)
    assert.equal(calls.length,0)
  }
})
