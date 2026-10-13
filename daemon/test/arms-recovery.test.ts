import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'

// Исполняем настоящий ArmsEnv, не сетевой bootstrap сцены внизу arms-run.
const source = readFileSync(join(__dirname, '../arms-run.js'), 'utf8')
const body = source.slice(source.indexOf('class ArmsEnv {'), source.indexOf('async function brain('))
const indexPath = join(__dirname, '../src/index.js')
const indexSource = readFileSync(indexPath, 'utf8')
const statusBody = indexSource.slice(indexSource.indexOf('function enchantedGear'), indexSource.indexOf('const wss ='))
function fixture({ food = 10, inventory = {}, items = null, eat = null, at = null, interrupted = false, foe = null, bot = null, fight = null }: any = {}) {
  let now = 0
  let health = 3
  const calls: any[] = []
  const status = bot && runInNewContext(statusBody + '\nmethods.status', {
    session: { bot, immediate: (fn: any) => fn() }, cfg: {}, require: createRequire(indexPath)
  })
  const side: any = { t0: 0, foe: foe?.name, know: { foe: null, areas: [], scouted: new Set(), chests: new Map(), caches: new Map() },
    stats: { engages: 0, firstEngage: null, powerAtEngage: null, fightEvents: [], fightWhy: {}, fights: 0 },
    async call(method: string, params: any) {
      calls.push({ method, params })
      if (method === 'status') return { state: { pos: { x: 0, y: 0, z: 0 }, health, food, inventory }, detail: status ? await status(params) : params?.items ? { items } : {} }
      if (method === 'players') return { detail: { players: foe ? [foe] : [] } }
      if (method === 'armor') return { status: 'done' }
      if (method === 'fight') return fight ? fight(params) : { status: 'done', detail: { killed: foe.name } }
      if (method === 'eat') {
        if (eat) { food = eat.food; inventory = {}; return { status: 'done', detail: eat } }
        return { status: interrupted ? 'interrupted' : 'done', detail: { ate: null, food } }
      }
      throw new Error(`unexpected RPC ${method}`)
    }
  }
  const { emptyWorld, fact } = require('../src/core/world-state')
  const context = { AG: require('../src/pvp/arms-graph'), Loot: require('../src/pvp/arms-loot'), LOOT_PRIOR: [], emptyWorld, fact, LOOT_MS: 60000, X: 0, Y: 0, Z: 0, L: { spawns: [{}] }, W: (p: any) => p,
    every: () => null, gameClock: { now: () => now, clearInterval() {} },
    pace: async (ms: number) => { now += ms; if (at) ({ health, food } = at(now, { health, food })) }
  }
  const ArmsEnv = runInNewContext(body + '\nArmsEnv', context)
  const env = new ArmsEnv(side, { over: false, roundScope: 'test-round' })
  return { side, calls, now: () => now, observe: () => env.observe(), run: () => env.execute({ skill: 'arms.heal' }, new AbortController().signal),
    engage: () => env.execute({ skill: 'arms.engage' }, new AbortController().signal) }
}

test('P8 status → Recover → Engage: observer и бой читают одну честную оценку без двойного aging', async () => {
  const co = require('../src/pvp/combat-observe')
  const { Vec3 } = require('vec3')
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter(); bot.inventory = { slots: [] }
  bot.entity = { id: 1, position: new Vec3(0, 0, 0), onGround: true }
  const metadata = []
  Object.defineProperty(metadata, 9, { get() { throw new Error('raw HP соперника запрещено') } })
  const entity = { id: 7, uuid: 'foe-uuid', username: 'Foe', type: 'player', position: new Vec3(20, 0, 0), equipment: [], metadata }
  let resumed: any
  const f = fixture({ bot, food: 18, foe: { name: 'Foe', canSee: true, gear: [], at: entity.position, dist: 20 },
    at: (now: number) => now >= 4000 ? { health: 4, food: 17 } : { health: 3, food: 18 },
    fight: (params: any) => {
      resumed = co.trackFoe(bot, entity, { roundScope: params.roundScope, now: f.now, visible: () => true })
      return { status: 'done', detail: { killed: 'Foe' } }
    } })
  const first = co.trackFoe(bot, entity, { roundScope: 'test-round', now: f.now, visible: () => true })
  try {
    first.noteAttack({ min: 14, max: 16, mean: 15, raw: 16 })
    bot._client.emit('damage_event', { entityId: 7, sourceTypeId: 0, sourceCauseId: 2, sourceDirectId: 2 })
    first.stop()
    const before = await f.observe()
    assert.equal(before.facts.enemy_hp_lo.value, 4)
    assert.equal(before.facts.enemy_hp_hi.value, 6)
    assert.equal(before.facts.enemy_hp_lo.source, 'inferred')
    assert.equal((await f.run()).outcome, 'SUCCESS')
    const after = await f.observe()
    assert.equal(after.facts.enemy_hp_lo.value, 4)
    assert.equal(after.facts.enemy_hp_hi.value, 14)
    assert.ok(after.facts.enemy_hp_conf.value < before.facts.enemy_hp_conf.value)
    await f.engage()
    assert.deepEqual([resumed.hp.snapshot().lo, resumed.hp.snapshot().hi], [4, 14])
    assert.equal(bot.listenerCount('physicsTick'), 1)
  } finally { first.stop(); resumed?.stop(); bot.emit('end') }
})

test('P8 Arms: Engage передаёт scope раунда, сохраняя прежний бюджет боя', async () => {
  const f = fixture({ foe: { name: 'Foe', canSee: true, gear: [], at: { x: 2, y: 0, z: 0 }, dist: 2 } })
  await f.engage()
  const fight = f.calls.find(c => c.method === 'fight')
  assert.equal(fight.params.roundScope, 'test-round')
  assert.equal(fight.params.timeoutSeconds, 120)
})

test('Arms observation: заряженный арбалет из собственного status сохраняет боеприпас', async () => {
  const f = fixture({ inventory: { crossbow: 1 }, items: [{ name: 'crossbow', count: 1, crossbow: { loaded: true, ammo: 'arrow' } }] })
  const observed = await f.observe()
  assert.equal(observed.resources.power, 5)
})

test('Recover executor: без еды и регенерации возвращает FAILURE без 15 секунд ожидания', async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(result.outcome, 'FAILURE')
  assert.equal(f.now(), 0)
  assert.equal(f.side.stats.heals || 0, 0)
})

test('Recover executor: неудачный eat не превращается в ожидание или успешное лечение', async () => {
  const f = fixture({ inventory: { bread: 1 } })
  const result = await f.run()
  assert.equal(result.outcome, 'FAILURE')
  assert.equal(f.now(), 0)
  assert.equal(f.side.stats.heals || 0, 0)
})

test('Recover executor: подтверждённая еда ниже порога регенерации — PARTIAL без ожидания', async () => {
  const f = fixture({ inventory: { bread: 1 }, eat: { ate: 'bread', food: 15, gain: 5, spent: 1 } })
  const result = await f.run()
  assert.equal(result.outcome, 'PARTIAL')
  assert.equal(result.detail.foodGain, 5)
  assert.equal(result.detail.hpGain, 0)
  assert.equal(f.now(), 0)
  assert.equal(f.side.stats.heals || 0, 0)
})

test('Recover executor: один реальный HP достаточен; падение hunger прекращает ожидание', async () => {
  const f = fixture({ food: 18, at: (now: number) => now >= 4000 ? { health: 4, food: 17 } : { health: 3, food: 18 } })
  const result = await f.run()
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(result.detail.hpGain, 1)
  assert.equal(f.now(), 4000)
  assert.equal(f.side.stats.heals, 1)
})

test('Recover executor: прерванное поедание возвращает управление без ожидания', async () => {
  const f = fixture({ inventory: { bread: 1 }, interrupted: true })
  const result = await f.run()
  assert.equal(result.outcome, 'INTERRUPTED')
  assert.equal(f.now(), 0)
  assert.equal(f.side.stats.heals || 0, 0)
})

test('Recover executor: полная сытость без фактического HP gain — ограниченный FAILURE', async () => {
  const f = fixture({ food: 20 })
  const result = await f.run()
  assert.equal(result.outcome, 'FAILURE')
  assert.equal(result.detail.hpGain, 0)
  assert.equal(f.now(), 15000)
  assert.equal(f.side.stats.heals || 0, 0)
})

test('Recover executor: подтверждённое золотое яблоко лечит при hunger ниже 18', async () => {
  const f = fixture({ inventory: { golden_apple: 1 }, eat: { ate: 'golden_apple', food: 14, gain: 4, spent: 1 },
    at: (now: number) => ({ health: 3 + Math.floor(now / 1250), food: 14 }) })
  const result = await f.run()
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(result.detail.hpGain, 4)
  assert.equal(f.now(), 5000)
  assert.equal(f.side.stats.heals, 1)
})

test('Recover executor: рост hunger без расхода яблока не доказывает эффект регенерации', async () => {
  const f = fixture({ inventory: { golden_apple: 1 }, eat: { ate: 'golden_apple', food: 14, gain: 4, spent: 0 } })
  const result = await f.run()
  assert.equal(result.outcome, 'PARTIAL')
  assert.equal(result.detail.hpGain, 0)
  assert.equal(f.now(), 0, 'автопилот мог съесть другую еду; нет свидетеля яблока')
})
