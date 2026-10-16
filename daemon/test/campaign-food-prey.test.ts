export {}
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const esbuild = require('esbuild')

const source = fs.readFileSync(path.join(__dirname, '..', 'campaign.ts'), 'utf8')
const body = (name, next) => source.slice(source.indexOf(`async function ${name} (`), source.indexOf(`async function ${next} (`))

function fixture (prey) {
  const calls = []
  const hunt = new Error('food action reached')
  let elapsed = 0
  const state = { health: 3, food: 8, biome: 'plains', inventory: {}, playPolicy: { mode: 'speedrun' }, pos: { x: 0, y: 70, z: 0 } }
  const have = pattern => Object.entries(state.inventory).reduce((n, [name, count]) => n +
    ((typeof pattern === 'string' ? name === pattern : pattern.test(name)) ? Number(count) : 0), 0)
  const ctx: any = {
    state, have, LOGS: /_(log|stem)$/, RAW: /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/,
    FOOD: /^cooked_/, FOOD_STOCK: 8, FOOD_CAP_MS: 180000, foodSpentMs: 240000,
    OW_DEEP: true, known: {}, huntWool: false, wantBeds: 0, died: false,
    sit: { surface: true, night: false }, gameClock: { now: () => elapsed },
    foodUnits: () => 0, foodShort: () => 8, entrySupplies: () => false, y: () => state.pos.y, netherFoodNeed: () => 6, weakAndHungry: () => true,
    cook: async () => {}, makeBed: async () => {}, sense: async () => {}, refresh: async () => {},
    unclutter: async () => {}, toSurface: async () => true, nightWork: () => false,
    nightGuard: async () => {}, recoverGuard: async () => {}, canWorkAtNight: () => true, log: () => {},
    walkAway: async () => { throw new Error('visible food was ignored') },
    act: async (method, params) => {
      calls.push({ method, params })
      if (params.block === 'any_log') {
        elapsed += params.timeoutSeconds * 1000
        return { status: 'failed', detail: {} }
      }
      if (method === 'observe') return { status: 'done', detail: prey }
      if (method === 'fight' || params.block === 'melon') throw hunt
      throw new Error(`unexpected ${method}`)
    }
  }
  // Keep the actual lumber body: the earlier food fixture replaced it with a
  // no-op and could not detect a tree search spending the whole hunting budget.
  vm.createContext(ctx)
  vm.runInContext(esbuild.transformSync(body('lumber', 'unclutter') + body('foodRun', 'quickHunt'),
    { loader: 'ts', format: 'cjs' }).code, ctx)
  return { run: () => ctx.foodRun(), calls, hunt }
}

test('empty food and wood: visible passive prey is hunted before a tree search', async () => {
  const f = fixture({ entities: [{ name: 'cow', dist: 3, pos: { x: 3, y: 70, z: 0 } }], blocks: [] })
  await assert.rejects(f.run(), error => error === f.hunt)
  assert.deepEqual(f.calls.map(c => c.method), ['observe', 'fight'])
  assert.equal(f.calls[1].params.target, 'cow')
  assert.equal(f.calls[1].params.purpose, 'food')
})

test('empty food and wood: visible melons are harvested before a tree search', async () => {
  const f = fixture({ entities: [], blocks: [{ name: 'melon', dist: 3 }] })
  await assert.rejects(f.run(), error => error === f.hunt)
  assert.deepEqual(f.calls.map(c => c.method), ['observe', 'mine'])
  assert.equal(f.calls[1].params.block, 'melon')
})
