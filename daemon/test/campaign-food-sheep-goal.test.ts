const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { decideFight, foodUnits } = require('../src/play-policy')

const source = fs.readFileSync(path.resolve(__dirname, '../campaign.ts'), 'utf8')
const food = source.slice(source.indexOf('async function foodRun ('), source.indexOf('async function quickHunt ('))

function fixture(inventory: Record<string, number>, wantBeds = 1, firstDrop?: string) {
  const stop = new Error('first hunt dispatch')
  const calls: any[] = []
  const state = { health: 11, food: 14, biome: 'plains', inventory, playPolicy: { mode: 'speedrun' }, pos: { x: 0, y: 70, z: 0 } }
  const context: any = {
    state,
    have: (re: string | RegExp) => Object.entries(state.inventory).reduce((n, [name, count]) => n + ((typeof re === 'string' ? name === re : re.test(name)) ? count : 0), 0),
    RAW: /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/, FOOD: /^cooked_/,
    FOOD_STOCK: 8, FOOD_CAP_MS: 180000, foodSpentMs: 0, OW_DEEP: true, known: {}, huntWool: wantBeds > 1, wantBeds, died: false,
    sit: { surface: true, night: false }, gameClock: { now: () => 0 }, foodUnits: () => foodUnits(state.inventory), y: () => 70,
    foodShort: () => Math.max(0, 8 - foodUnits(state.inventory)), entrySupplies: () => false, netherFoodNeed: () => 6, weakAndHungry: () => true,
    cook: async () => {}, makeBed: async () => {}, sense: async () => {}, refresh: async () => {}, unclutter: async () => {},
    toSurface: async () => true, nightWork: () => false, nightGuard: async () => {}, recoverGuard: async () => {}, log: () => {},
    walkAway: async () => { throw new Error('visible prey ignored') },
    act: async (method: string, params: any) => {
      if (method === 'observe') return { status: 'done', detail: { entities: [{ name: 'sheep', dist: 3, pos: { x: 3, y: 70, z: 0 } }], blocks: [] } }
      calls.push({ method, params })
      if (method === 'fight' && firstDrop && calls.length === 1) {
        state.inventory[firstDrop] = (state.inventory[firstDrop] || 0) + 1
        return { status: 'done' }
      }
      throw stop
    }
  }
  vm.runInNewContext(food, context)
  const decision = (index = 0) => decideFight({
    bot: { inventory: { items: () => Object.entries(state.inventory).map(([name, count]) => ({ name, count })) } }, playPolicy: { mode: 'speedrun' }
  }, { name: 'sheep' }, calls[index].params)
  return { state, calls, stop, decision, run: () => context.foodRun() }
}

for (const inventory of [{ white_wool: 2, gray_wool: 1 }, { white_wool: 3 }, { white_wool: 2, gray_wool: 1, cooked_mutton: 7 }]) {
  test(`food shortage dispatches an executable sheep food goal: ${JSON.stringify(inventory)}`, async () => {
    const f = fixture(inventory)
    await assert.rejects(f.run(), (e: any) => e === f.stop)
    assert.equal(f.calls[0].params.purpose, 'food')
    assert.equal(f.calls[0].params.resourceGoal, undefined)
    assert.equal(f.decision().skip, false)
  })
}

for (const wantBeds of [1, 7]) {
  test(`fed bed hunting preserves the requested wool goal for ${wantBeds} beds`, async () => {
    const f = fixture({ cooked_mutton: 8, white_wool: 1 }, wantBeds)
    await assert.rejects(f.run(), (e: any) => e === f.stop)
    assert.equal(f.calls[0].params.purpose, 'resource')
    assert.equal(f.calls[0].params.resourceGoal.item, 'wool')
    assert.equal(f.calls[0].params.resourceGoal.count, wantBeds * 3)
    assert.equal(f.decision().skip, false)
  })
}

for (const [inventory, wantBeds, count] of [
  [{ cooked_mutton: 8, white_wool: 2, gray_wool: 1 }, 1, 4],
  [{ cooked_mutton: 8, white_wool: 2, gray_wool: 1, white_bed: 1 }, 2, 7],
  [{ cooked_mutton: 8, white_wool: 2, gray_wool: 2, black_wool: 2 }, 1, 7]
] as Array<[Record<string, number>, number, number]>) {
  test('fed mixed colours require executable remaining same-colour wool: ' + JSON.stringify(inventory), async () => {
    const f = fixture(inventory, wantBeds)
    await assert.rejects(f.run(), (e: any) => e === f.stop)
    assert.equal(f.calls[0].params.purpose, 'resource')
    assert.equal(f.calls[0].params.resourceGoal.count, count)
    assert.equal(f.decision().skip, false)
  })
}

test('a different-colour drop updates the next wool goal from actual inventory', async () => {
  const f = fixture({ cooked_mutton: 8, white_wool: 2, gray_wool: 1 }, 1, 'gray_wool')
  await assert.rejects(f.run(), (e: any) => e === f.stop)
  assert.deepEqual(f.calls.map(c => c.params.resourceGoal.count), [4, 5])
  assert.equal(f.decision(1).skip, false)
})

test('same-colour completion stops further fed sheep fights', async () => {
  const f = fixture({ cooked_mutton: 8, white_wool: 2, gray_wool: 1 }, 1, 'white_wool')
  await f.run()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].params.resourceGoal.count, 4)
  assert.equal(f.state.inventory.white_wool, 3)
})
