import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

// Исполняем настоящий ArmsEnv, не сетевой bootstrap сцены внизу arms-run.
const source = readFileSync(join(__dirname, '../arms-run.js'), 'utf8')
const body = source.slice(source.indexOf('class ArmsEnv {'), source.indexOf('async function brain('))
function fixture({ food = 10, inventory = {}, items = null, eat = null, at = null, interrupted = false }: any = {}) {
  let now = 0
  let health = 3
  const side: any = { t0: 0, know: { foe: null, areas: [], scouted: new Set(), chests: new Map(), caches: new Map() }, stats: {},
    async call(method: string, params: any) {
      if (method === 'status') return { state: { pos: { x: 0, y: 0, z: 0 }, health, food, inventory }, detail: params?.items ? { items } : {} }
      if (method === 'players') return { detail: { players: [] } }
      if (method === 'eat') {
        if (eat) { food = eat.food; inventory = {}; return { status: 'done', detail: eat } }
        return { status: interrupted ? 'interrupted' : 'done', detail: { ate: null, food } }
      }
      throw new Error(`unexpected RPC ${method}`)
    }
  }
  const { emptyWorld, fact } = require('../src/core/world-state')
  const context = { AG: require('../src/pvp/arms-graph'), emptyWorld, fact, LOOT_MS: 60000, X: 0, Y: 0, Z: 0, L: { spawns: [{}] }, W: (p: any) => p,
    every: () => null, gameClock: { now: () => now, clearInterval() {} },
    pace: async (ms: number) => { now += ms; if (at) ({ health, food } = at(now, { health, food })) }
  }
  const ArmsEnv = runInNewContext(body + '\nArmsEnv', context)
  const env = new ArmsEnv(side, { over: false })
  return { side, now: () => now, observe: () => env.observe(), run: () => env.execute({ skill: 'arms.heal' }, new AbortController().signal) }
}

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
