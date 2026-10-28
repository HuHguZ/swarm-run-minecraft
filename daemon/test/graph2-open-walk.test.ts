import test from 'node:test'
import assert from 'node:assert/strict'

// ND_GRAPH2_OPEN_WALK (поток graph2 sr27): отрезок поиска без золотой вещи — ногами, пока пиглинов не видно и не слышно;
// закрытый штрек (2.3–2.8 взмаха на блок хода) — только при них, брутах/хоглинах, бастионе рядом.
const stub = (rel: string, exports: Record<string, unknown>) => {
  const id = require.resolve(rel)
  require.cache[id] = { id, filename: id, loaded: true, exports } as any
}
const calls: string[] = []
let seen: any[] = []
let boreMoved = 16
stub('../src/nether-cover', { closedBore: async () => { calls.push('cover'); return { ok: boreMoved > 0, moved: boreMoved, dug: 2, why: boreMoved ? undefined : 'на открытом: ни вниз, ни в стену — закрылся на месте' } } })
stub('../src/nether', { guarded: async () => { calls.push('walk'); return { ok: true } }, bore: async () => { calls.push('bore'); return { ok: true, dug: 30 } } })
stub('../src/bastion/take-gold-block', { goldWorn: () => false })
stub('../src/perception/eyes', { entities: () => seen })
stub('../src/perception/senses', { heard: () => [] })
stub('../src/fortress/look', { log: () => {}, bastionNear: () => false })
stub('../src/worlds', { worldOf: () => 'the_nether', worldOfRecord: () => 'the_nether' })
let picks = 500
stub('../src/tunnel', { lowUses: () => 999, pickBudget: () => ({ total: picks }) })
let biome = 'soul_sand_valley'
stub('../src/perception', { biomeName: () => biome })
import { legTo } from '../src/fortress/legs'

const session: any = { bot: { entity: { position: new (require('vec3').Vec3)(0, 70, 0) }, inventory: { items: () => [] } }, journal: { state: {} } }
const run = async (env: string | undefined) => {
  const old = process.env.ND_GRAPH2_OPEN_WALK
  if (env === undefined) delete process.env.ND_GRAPH2_OPEN_WALK; else process.env.ND_GRAPH2_OPEN_WALK = env
  calls.length = 0
  try { await legTo(session, { aborted: false }, 16, 0, Date.now() + 60000) } finally { if (old === undefined) delete process.env.ND_GRAPH2_OPEN_WALK; else process.env.ND_GRAPH2_OPEN_WALK = old }
  return calls.slice()
}

test('graph2 open walk: без золота и без пиглинов — ногами; без флага — закрытый штрек, как прежде', async () => {
  seen = []
  assert.deepEqual(await run(undefined), ['cover'])
  assert.deepEqual(await run('1'), ['walk'])
  biome = 'nether_wastes'
  assert.deepEqual(await run('1'), ['cover'], 'пустоши — пиглины родятся: штрек')
  picks = 40
  assert.deepEqual(await run('1'), ['walk'], 'кирок меньше чем на два отрезка штрека — в пустошах ногами')
  picks = 500
  biome = 'soul_sand_valley'
})

test('graph2 open walk: пиглин на виду в 24 — штрек и с флагом; брут — штрек', async () => {
  seen = [{ seen: true, name: 'piglin', dist: 12 }]
  assert.deepEqual(await run('1'), ['cover'])
  seen = [{ seen: true, name: 'piglin_brute', dist: 30 }]
  assert.deepEqual(await run('1'), ['cover'])
  seen = [{ seen: true, name: 'piglin', dist: 30 }]
  assert.deepEqual(await run('1'), ['walk'], 'пиглин дальше 24 — не повод')
})

// ND_GRAPH2_STONE_WAY: чернокамень на виду, булыжника меньше чем на две кирки, палки есть — 6 − камень блоков, как дерево по пути.
const mined: any[] = []
stub('../src/sight', { visibleOf: () => [{ name: 'blackstone' }] })
stub('../src/actions', { mine: async (_s: any, _c: any, p: any) => { mined.push(p); return { dug: p.count } } })
import { stoneOnTheWay } from '../src/fortress/legs'
test('graph2 stone way: камень кирок по пути — только при недостаче и с палками', async () => {
  const items = (stone: number) => [{ name: 'cobblestone', count: stone }, { name: 'stick', count: 4 }, { name: 'stone_pickaxe', count: 1 }].filter(i => i.count)
  const bot: any = { inventory: { items: () => items(1) }, registry: { blocksByName: { blackstone: { id: 1 } } }, entity: { position: { x: 0, y: 70, z: 0 } } }
  seen = []
  process.env.ND_GRAPH2_STONE_WAY = '1'
  try {
    await stoneOnTheWay({ bot }, { aborted: false })
    assert.deepEqual(mined.map(p => [p.block, p.count]), [['blackstone', 5]])
    bot._ndStoneWayAt = 0; bot.inventory.items = () => items(9)
    await stoneOnTheWay({ bot }, { aborted: false })
    assert.equal(mined.length, 1, 'камня на 3 кирки — мимо')
  } finally { delete process.env.ND_GRAPH2_STONE_WAY }
})

test('graph2 cover stall: два штрека без шага с клетки — третий не копает, пока тело не сдвинулось', async () => {
  seen = []; boreMoved = 0
  process.env.ND_GRAPH2_COVER_STALL = '1'
  try {
    for (let i = 0; i < 3; i++) await run(undefined)
    calls.length = 0
    const r = await legTo(session, { aborted: false }, 16, 0, Date.now() + 60000)
    assert.deepEqual(calls, [], 'третий с той же клетки — без копки')
    assert.equal(r.ok, false)
    session.bot.entity.position = session.bot.entity.position.offset(3, 0, 0)
    assert.deepEqual(await run(undefined), ['cover'], 'сдвинулся — штрек снова')
  } finally { delete process.env.ND_GRAPH2_COVER_STALL; boreMoved = 16; session.bot.entity.position = session.bot.entity.position.offset(-3, 0, 0); session.bot._ndCoverStall = null }
})
