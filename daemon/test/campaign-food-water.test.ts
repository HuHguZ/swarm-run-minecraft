import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

function fixture({ water = true, prey = true, hp = 9, surface = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
  const body = source.slice(source.indexOf('async function foodRun ('), source.indexOf('async function quickHunt ('))
  const calls: Array<{ method: string; params?: any }> = []
  let now = 0, food = 0
  const context: Record<string, any> = {
    state: { health: hp, food: 11, pos: { x: 0, y: 64, z: 0 }, inventory: {} }, sit: { surface: true }, died: false,
    OW_DEEP: false, FOOD_STOCK: 8, huntWool: false, wantBeds: 0, foodSpentMs: 0, FOOD_CAP_MS: 180000,
    FOOD: /cooked_/, RAW: /beef/, gameClock: { now: () => now }, y: () => 64,
    have: (re: RegExp | string) => re instanceof RegExp && re.test('beef') ? food : 0,
    foodUnits: () => food, foodShort: () => Math.max(0, 8 - food), entrySupplies: () => false, cook: async () => {}, makeBed: async () => {}, sense: async () => {},
    toSurface: async () => surface, unclutter: async () => {}, lumber: async () => {}, nightWork: () => false,
    nightGuard: async () => {}, recoverGuard: async () => {}, refresh: async () => {}, log: () => {},
    awayFrom: async () => { calls.push({ method: 'away' }); now += 120001 },
    walkAway: async () => { calls.push({ method: 'walk' }); now += 120001; return { status: 'done' } },
    act: async (method: string, params: any) => {
      calls.push({ method, params })
      if (method === 'observe') return { detail: {
        blocks: water ? [{ name: 'water', dist: 2, nearest: { x: 2, y: 63, z: 0 } }] : [],
        entities: prey ? [{ name: 'cow', dist: 3, pos: { x: 3, y: 64, z: 0 } }] : [] } }
      if (method === 'fight') { food = 8; return { status: 'done', detail: { kills: ['cow'] } } }
      throw new Error('unexpected method ' + method)
    }
  }
  vm.runInNewContext(body, context)
  return { context, calls }
}

test('the real foodRun hunts a visible passive animal at nine HP beside water', async () => {
  const { context, calls } = fixture()
  await context.foodRun()
  assert.equal(calls.filter(c => c.method === 'fight').length, 1)
  assert.equal(calls.filter(c => c.method === 'away').length, 0)
  assert.equal(calls.find(c => c.method === 'fight')?.params.purpose, 'food')
})
test('a shore without visible prey continues searching instead of repeatedly fleeing visible water', async () => {
  const { context, calls } = fixture({ prey: false })
  await context.foodRun()
  assert.equal(calls.filter(c => c.method === 'walk').length, 1)
  assert.equal(calls.filter(c => c.method === 'away').length, 0)
})
test('water visibility does not change a high-HP hunt and no surface still stops it physically', async () => {
  const high = fixture({ hp: 20 }); await high.context.foodRun()
  assert.equal(high.calls.filter(c => c.method === 'fight').length, 1)
  const buried = fixture({ surface: false }); await buried.context.foodRun()
  assert.equal(buried.calls.length, 0)
})
test('the real foodRun propagates tactical cancellation without issuing another hunt', async () => {
  const { context, calls } = fixture({ water: false })
  context.act = async (method: string) => { calls.push({ method }); if (method === 'observe') throw new Error('STRATEGY_INTERRUPTED'); return {} }
  await assert.rejects(context.foodRun(), /STRATEGY_INTERRUPTED/)
  assert.deepEqual(calls.map(c => c.method), ['observe'])
})

for (const biome of ['plains', 'snowy_slopes']) {
  test(`a speedrun food step still hunts visible prey after the legacy pre-portal budget; biome=${biome}`, async () => {
    const { context, calls } = fixture({ hp: 3 })
    Object.assign(context, { OW_DEEP: true, known: {}, foodSpentMs: 240000, weakAndHungry: () => true })
    Object.assign(context.state, { food: 6, biome, playPolicy: { mode: 'speedrun' } })
    await context.foodRun()
    assert.equal(calls.filter(c => c.method === 'fight').length, 1)
    assert.equal(calls.find(c => c.method === 'fight')?.params.purpose, 'food')
  })
}

test('the legacy pre-portal search keeps its explicit budget when no speedrun was selected', async () => {
  const { context, calls } = fixture()
  Object.assign(context, { OW_DEEP: true, known: {}, foodSpentMs: 240000, weakAndHungry: () => false })
  await context.foodRun()
  assert.equal(calls.length, 0)
})
