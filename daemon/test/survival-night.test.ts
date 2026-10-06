'use strict'
// Ночь не пережидать (ND_NIGHT_DOWN, поток survival 02.10): нора — вход вниз, ожидание только лечащее или аварийное.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { withClockFixture } = require('./clock-fixture')

// Настоящие функции кампании, внешняя граница — RPC вместо живого Minecraft.
// Загрузчик не открывает сокет, не пишет журнал и не запускает кампанию сам.
// Часы кампании для тестов политики повторов: Date.now() — clock.t, «ожидание» двигает его вперёд.
function fakeDate (clock) { return class extends Date { static now () { return clock.t } } }

function campaign (state, situation, handle: (...args: any[]) => any = () => ({} as Record<string, any>), { logs = null, env = {} as Record<string, any>, argv = [], clock = null, onStatus = null }: any = {} as Record<string, any>) {
  class Socket {
  declare listeners: any

    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method, params } = JSON.parse(raw)
      const detail = method === 'situation' ? situation : method === 'status' ? ((onStatus && onStatus()) || {} as Record<string, any>) : handle(method, params)
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({
        id, ok: true, result: detail?.rpcResult || { status: 'done', detail, state, events: [] }
      })))
    }
    close () {}
  }
  const context = {
    require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync (file, line) { if (logs) logs.push(String(line)) } } : require(name),
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} as Record<string, any> },
    process: { argv: ['node', 'campaign.js', ...argv], env },
    console: { log () {}, error () {} }, setTimeout, Date: clock ? fakeDate(clock) : Date, queueMicrotask
  }
  vm.runInNewContext(fs.readFileSync(process.env.CAMPAIGN_TEST_SOURCE || path.join(__dirname, '../campaign.js'), 'utf8') + `
    module.exports = { act, refresh, readMemory, nextBastion, died: () => died, stage: name => { stage = name }, craft, nightGuard, nightGuardBody, rest, eatTo, recoverGuard, descend, goToward, returnFromNether, spares, toSurface, unclutter, smeltAll, lightUp, known, makeBed,
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


const ON = { ND_NIGHT_DOWN: '1' }

test('NIGHT_DOWN: ночь наверху, хп 12 без еды — закрытая нора и сразу дальше работа, без ожидания утра', async () => {
  const state: Record<string, any> = { health: 12, food: 10, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 }, inventory: { stone_pickaxe: 1, cobblestone: 16 } }
  const situation: Record<string, any> = { night: true, surface: true, foes: 0 }
  const calls = []
  const logs = []
  const c = campaign(state, situation, (method, params) => {
    calls.push({ method, params })
    if (method === 'shelter' && params.mode === 'enter') { situation.surface = false; return { sealed: true } }
    return {} as Record<string, any>
  }, { logs, env: ON })
  await c.nightGuard()
  assert.equal(calls.filter(x => x.method === 'shelter' && x.params.mode === 'enter').length, 1)
  assert.equal(calls.filter(x => x.method === 'wait').length, 0, 'ожидание не лечит — не ждать')
  assert.equal(calls.filter(x => x.method === 'shelter' && x.params.mode === 'exit').length, 0, 'из норы наверх ночью не лезть')
  assert.match(logs.join(''), /утра не жду, работаю внизу/)
})

test('NIGHT_DOWN: под крышей ночью — не «жду утра»; хп 12 и сытость 20 — отлёжка, пока лечит, потом работа', async () => {
  const state: Record<string, any> = { health: 12, food: 20, dimension: 'overworld', pos: { x: 100, y: 40, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const situation: Record<string, any> = { night: true, surface: false, foes: 0 }
  const calls = []
  const c = campaign(state, situation, method => {
    calls.push(method)
    if (method === 'wait') state.health = Math.min(20, state.health + 4)
    return {} as Record<string, any>
  }, { env: ON })
  await c.nightGuard()
  const waits = calls.filter(x => x === 'wait').length
  assert.ok(waits >= 1 && waits <= 2, `ждал ${waits} раз — только пока лечит`)
  assert.equal(calls.includes('shelter'), false)
})

test('NIGHT_DOWN: авария (хп 6, есть нечего) — сидит не дольше 4 мин; без флага — до утра', async () => {
  const run = async env => {
    const state: Record<string, any> = { health: 6, food: 8, dimension: 'overworld', pos: { x: 100, y: 40, z: 0 }, inventory: { stone_pickaxe: 1 } }
    const situation: Record<string, any> = { night: true, surface: false, foes: 0 }
    let waits = 0
    const c = campaign(state, situation, method => { if (method === 'wait' && ++waits >= 40) situation.night = false; return {} as Record<string, any> }, { env })
    await c.nightGuard()
    return waits
  }
  const on = await run(ON)
  assert.ok(on >= 1 && on <= 8, `с флагом ждал ${on} раз по 30 с`)
  assert.ok((await run({ ND_NIGHT_DOWN: '0' })) >= 20, 'ND_NIGHT_DOWN=0 — прежнее ожидание утра')
})

test('NIGHT_DOWN=2: ночь наверху с мечом и 20 хп — не работа наверху, а нора и вниз; =1 — работает наверху', async () => {
  const run = async env => {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 }, inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 16 } }
    const situation: Record<string, any> = { night: true, surface: true, foes: 0 }
    const calls = []
    const c = campaign(state, situation, (method, params) => {
      calls.push({ method, params })
      if (method === 'shelter' && params.mode === 'enter') { situation.surface = false; return { sealed: true } }
      return {} as Record<string, any>
    }, { env })
    c.stage('food')
    await c.nightGuard()
    return calls
  }
  const strict = await run({ ND_NIGHT_DOWN: '2' })
  assert.equal(strict.filter(x => x.method === 'shelter' && x.params.mode === 'enter').length, 1)
  assert.equal(strict.filter(x => x.method === 'wait').length, 0)
  const soft = await run({ ND_NIGHT_DOWN: '1' })
  assert.equal(soft.filter(x => x.method === 'shelter').length, 0, 'уровень 1 — прежнее «работаю ночью наверху»')
})

test('NIGHT_DOWN=2: сумерки наверху в простое (dusk) — нора сразу; без dusk — не трогать', async () => {
  const run = async opts => {
    const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 }, inventory: { stone_pickaxe: 1, stone_sword: 1, cobblestone: 16 } }
    const situation: Record<string, any> = { night: false, dusk: true, surface: true, foes: 0 }
    const calls = []
    const c = campaign(state, situation, (method, params) => {
      calls.push({ method, params })
      if (method === 'shelter' && params.mode === 'enter') { situation.surface = false; return { sealed: true } }
      return {} as Record<string, any>
    }, { env: { ND_NIGHT_DOWN: '2' } })
    await c.nightGuard(opts)
    return calls.filter(x => x.method === 'shelter' && x.params.mode === 'enter').length
  }
  assert.equal(await run({ dusk: true }), 1)
  assert.equal(await run({} as Record<string, any>), 0)
})

test('NIGHT_DOWN: ночь, враг у места норы — коробка stayIn и нора из неё; работа без ожидания', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 100, y: 65, z: 0 }, inventory: { stone_pickaxe: 1, cobblestone: 32 } }
  const situation: Record<string, any> = { night: true, surface: true, foes: 2, armed: false, fight: { order: [{ name: 'zombie', dist: 5 }, { name: 'zombie', dist: 7 }] } }
  const calls = []
  const c = campaign(state, situation, (method, params) => {
    calls.push({ method, params })
    if (method === 'refuge') return { stayed: !!params.stayIn, how: 'box', code: 'OK' }
    if (method === 'shelter' && params.mode === 'enter') { situation.surface = false; situation.foes = 0; return { sealed: true } }
    return {} as Record<string, any>
  }, { env: { ND_NIGHT_DOWN: '2' } })
  await c.nightGuard()
  const ref = calls.find(x => x.method === 'refuge')
  assert.ok(ref && ref.params.stayIn, 'коробка с stayIn')
  const iRef = calls.indexOf(ref)
  const iHole = calls.findIndex(x => x.method === 'shelter' && x.params.mode === 'enter')
  assert.ok(iHole > iRef, 'нора — после коробки, из неё')
  assert.equal(calls.filter(x => x.method === 'wait').length, 0)
})
