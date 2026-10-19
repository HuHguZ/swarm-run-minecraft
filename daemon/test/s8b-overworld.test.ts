'use strict'
// S8b (07.10, верхний мир «новый мир → Ад», продолжение S8).
import test = require('node:test')
import assert = require('node:assert')
import route = require('../src/route')

const book = () => ({ done: new Set<string>(), fails: new Map<string, number>(), avoid: new Set<string>() })

test('bookStep: удачный шаг — только в done, без счёта провалов и avoid (плавка, постройки, жилы)', () => {
  const b = book()
  for (const id of ['wood', 'ruin', 'village', 'ore:1', 'smelt', 'lava:sky']) assert.strictEqual(route.bookStep(id, true, b), null)
  assert.deepStrictEqual([...b.done], ['wood', 'ruin', 'village', 'ore:1', 'smelt', 'lava:sky'])
  assert.strictEqual(b.fails.size, 0)
  assert.strictEqual(b.avoid.size, 0)
  // Три удачные плавки подряд маршрут не кончают (раньше удачный шаг считался провалом плавки).
  for (let i = 0; i < 3; i++) assert.strictEqual(route.bookStep('smelt', 'ok', b), null)
})

test('bookStep: провалы — food/water мягкие, плавка до трёх, постройки сразу в avoid, прочее со второго', () => {
  const b = book()
  assert.strictEqual(route.bookStep('water', false, b), null)
  assert.ok(b.done.has('water'))
  assert.strictEqual(route.bookStep('smelt', false, b), null)
  assert.strictEqual(route.bookStep('smelt', false, b), null)
  assert.strictEqual(route.bookStep('smelt', false, b), 'break')
  route.bookStep('ruin', false, b)
  assert.ok(b.avoid.has('ruin'))
  route.bookStep('wood', false, b)
  assert.ok(!b.avoid.has('wood'))
  route.bookStep('wood', false, b)
  assert.ok(b.avoid.has('wood'))
})

// Литьё одним ведром (cast1.judge1) на синтетическом озере: ось z, сторона +x; рама x=0, жёлоб x=1, берег x=2, озеро x≥3 на y 64.
function lakeWorld (lava: Array<[number, number]>, extra: Record<string, string> = {}) {
  const Vec3: typeof import('vec3').Vec3 = require('vec3')
  const set = new Set(lava.map(([x, z]) => `${x},${z}`))
  const mk = (p: any, name: string) => ({ name, boundingBox: /air|lava|water/.test(name) ? 'empty' : 'block', position: p, metadata: 0, getProperties: () => ({ level: 0 }) })
  const read = (p: any) => {
    const k = `${p.x},${p.y},${p.z}`
    if (extra[k]) return mk(p, extra[k])
    if (p.y < 64) return mk(p, 'stone')
    if (p.y === 64) return mk(p, set.has(`${p.x},${p.z}`) ? 'lava' : 'stone')
    return mk(p, 'air')
  }
  return { read, g: (require('../src/cast1') as typeof import('../src/cast1')).geom1(new Vec3(0, 65, 0), 'z', 1) }
}
const withEnv8b = (env: Record<string, string | undefined>, fn: () => void) => {
  const old: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  try { fn() } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k] } }
}

test('cast1: пол берега без блока (не под телом) — в план ставкой блока; ND_CAST1_SHORE=0 — «берег не твёрдый»', () => {
  const cast1: typeof import('../src/cast1') = require('../src/cast1')
  const lake: Array<[number, number]> = []
  for (let x = 3; x <= 9; x++) for (let z = -6; z <= 7; z++) lake.push([x, z])
  for (const gap of ['air', 'lava']) {
    const { read, g } = lakeWorld(lake, { '2,64,1': gap })
    const r = cast1.judge1(read, g, {})
    assert.ok(r.plan && r.plan.place.some((q: any) => q.x === 2 && q.y === 64 && q.z === 1), JSON.stringify(r).slice(0, 200))
    withEnv8b({ ND_CAST1_SHORE: '0' }, () => assert.strictEqual(cast1.judge1(read, g, {}).why, 'берег не твёрдый'))
  }
  // Под телом (G(0)) — по-прежнему нельзя.
  const { read, g } = lakeWorld(lake, { '2,64,0': 'air' })
  assert.strictEqual(cast1.judge1(read, g, {}).why, 'берег не твёрдый')
})

test('cast1: верх рамы — и со столба в G(±1): озеро, где из G(0) со столба 2 источника, годится со сдвигом; ND_CAST1_SHIFT=0 — нет', () => {
  const cast1: typeof import('../src/cast1') = require('../src/cast1')
  const lake: Array<[number, number]> = [[3, -3], [3, 3], [3, 4], [4, -2], [4, 2], [4, 3], [5, -1], [5, 0], [5, 1], [3, 1], [4, 1], [6, 0], [3, -4], [5, 2], [5, 3]]
  const { read, g } = lakeWorld(lake)
  const r = cast1.judge1(read, g, {})
  assert.ok(r.plan, JSON.stringify(r))
  assert.ok(r.plan.high0 < 4 && r.plan.high >= 4, JSON.stringify({ high0: r.plan.high0, high: r.plan.high }))
  withEnv8b({ ND_CAST1_SHIFT: '0' }, () => assert.ok(/со столба 2/.test(cast1.judge1(read, g, {}).why)))
})

test('goto: рефлекс падения (Emergency) снимает цель — после него та же цель снова, без «goal was changed»; чужая смена цели — отказ', async () => {
  const { EventEmitter }: typeof import('node:events') = require('node:events')
  const { gotoGoal }: typeof import('../src/movement') = require('../src/movement')
  const RL: typeof import('../src/reflex-lock') = require('../src/reflex-lock')
  const mkBot = () => {
    const b: any = new EventEmitter()
    b.goals = [] as any[]
    b.pathfinder = { setGoal (g: any) { b.goals.push(g); b.emit('goal_updated', g, false) }, isMoving: () => true }
    for (const k of ['stopDigging', 'clearControlStates', 'deactivateItem']) b[k] = () => {}
    b.inventory = { items: () => [] }
    return b
  }
  const b = mkBot()
  const s = { bot: b }
  const goal = { isEnd: () => true }
  const p = gotoGoal(b, goal)
  RL.emergency(s, () => 'clutch', 20)
  await (s as any).reflex
  await new Promise(r => setTimeout(r, 30))
  assert.strictEqual(b.goals.filter((g: any) => g === goal).length, 2, 'цель поставлена снова после рефлекса')
  b.emit('goal_reached')
  await p
  // Чужой setGoal(null) (не рефлекс) — прежний отказ GoalChanged.
  const b2 = mkBot()
  const p2 = gotoGoal(b2, goal)
  b2.pathfinder.setGoal(null)
  await assert.rejects(p2, /goal was changed/)
})

test('хп маршрута — цена: риск копки (хвост потерь × цена смерти) против лечения; нечем лечиться — копать; хп < 1 — нет', () => {
  const r: typeof import('../src/route') = require('../src/route')
  for (let h = 1; h < 13; h++) assert.ok(r.digRiskTicks(h) >= r.digRiskTicks(h + 1), `риск не растёт с хп (${h})`)
  assert.ok(r.digRiskTicks(6) < r.healTicks(6, true), 'хп 6 и еда есть — копать (регенерация идёт и в копке)')
  assert.ok(r.digRiskTicks(2) < r.healTicks(2, false), 'лечиться нечем — копать')
  assert.ok(r.digRiskTicks(0.5) > r.healTicks(0.5, true), 'полсердца — сперва лечение')
  assert.strictEqual(r.healTicks(15, true), 0)
  // Решение целиком (digRefuse): при хп ≥ 13 лечить нечего — не отказ (s8b-b до правки: хп 20 «риск 27 > лечение 0»).
  for (const hp of [20, 13, 15]) assert.strictEqual(r.digRefuse(hp, true).refuse, false, `хп ${hp}`)
  assert.strictEqual(r.digRefuse(6, true).refuse, false)
  assert.strictEqual(r.digRefuse(2, false).refuse, false)
  assert.strictEqual(r.digRefuse(0.5, true).refuse, true)
})

test('вода подо льдом: источники рядом есть, на виду ни одного — сломать лёд и черпнуть; ND_ROUTE_ICE=0 — нет', async () => {
  const { createOverworldRoute }: typeof import('../src/campaign/overworld-route') = require('../src/campaign/overworld-route')
  const run = async (env: Record<string, string>) => {
    const calls: string[] = []
    let water = false
    const ctx: any = {
      process: { env }, died: false, state: { pos: { x: 0, y: 63, z: 0 } }, known: {},
      have: (p: any) => (String(p).includes('water_bucket') ? (water ? 1 : 0) : String(p).includes('lava') ? 0 : String(p).includes('bucket') ? (water ? 0 : 1) : 0),
      routeInfoGet: () => null, routeMod: {}, rlog () {},
      act: async (m: string, p: any) => {
        calls.push(`${m}:${p.block || p.fluid}`)
        if (m === 'bucket' && calls.some(c => c === 'mine:ice')) { water = true; return { detail: {} } }
        if (m === 'bucket') return { detail: { stopped: 'не вижу источника воды в 48 блоках [клеток 400, источников 400, видно 0 ближний -112,61,-89 lvl 0]' } }
        if (m === 'mine') return { detail: { dug: 1 } }
        if (m === 'explore') return { detail: {} }
        return { detail: {} }
      }
    }
    const route = createOverworldRoute(ctx)
    const ok = await route.routeWater(null)
    return { ok, calls }
  }
  const on = await run({})
  assert.strictEqual(on.ok, true)
  assert.deepStrictEqual(on.calls.slice(0, 3), ['bucket:water', 'mine:ice', 'bucket:water'])
  const off = await run({ ND_ROUTE_ICE: '0' })
  assert.strictEqual(off.ok, false)
  assert.ok(!off.calls.includes('mine:ice'))
})

test('к стволу из скана — клетка рядом на его высоте (не сам ствол: goto поднимал на крону); дошли на высоту ствола — хватит', async () => {
  const { createOverworldRoute }: typeof import('../src/campaign/overworld-route') = require('../src/campaign/overworld-route')
  const gotos: any[] = []
  let y = 75
  let logs = 0
  const ctx: any = {
    process: { env: { ND_ROUTE_WOODN: '6' } }, died: false, state: { pos: { x: 0, y, z: 0 } }, known: {},
    have: (p: any) => (String(p).includes('pickaxe') && logs >= 6 ? 1 : 0), refresh: async () => {}, y: () => y, woodNow: () => logs,
    routeLeaveOutpost: async () => {}, routeGo: async () => true, planksFor: () => 'oak_planks', craft: async () => true,
    routeInfoGet: () => null, routeMod: {}, stageRun: () => async () => {}, rlog: () => {},
    act: async (m: string, p: any) => {
      if (m === 'goto') { gotos.push(p); y = p.y }
      if (m === 'mine') logs = 6
      return { status: 'done', detail: {} }
    }
  }
  await createOverworldRoute(ctx).routeStep({ kind: 'wood', src: 'mapwood', at: { x: 5, y: 70, z: 5 } })
  assert.strictEqual(gotos.length, 1)
  assert.deepStrictEqual([gotos[0].x, gotos[0].y, gotos[0].z, gotos[0].range], [6, 70, 5, 1])
})

test('кремень в залежи гравия: копать стенку по 6 (честные броски), рюкзак крутить, только когда стенка кончилась', async () => {
  const { createOverworldRoute }: typeof import('../src/campaign/overworld-route') = require('../src/campaign/overworld-route')
  const run = async (dugs: number[]) => {
    const calls: string[] = []
    let flint = 0, y = 70, gravel = 0
    let k = 0
    const ctx: any = {
      process: { env: {} }, died: false, state: { pos: { x: 5.5, y: 70, z: 5.5 } }, known: {}, flintTries: 0,
      lighter: () => false, have: (p: any) => (p === 'flint' ? flint : p === 'gravel' ? gravel : 0), refresh: async () => {}, sense: async () => {}, y: () => y,
      routeGo: async () => true, routeShaftBackOn: () => false, routeRememberShaft: () => {}, routeReturnShaft: async () => {}, rlog: () => {},
      routeFlintFromBag: async () => { calls.push('bag') },
      act: async (m: string, p: any) => {
        calls.push(`${m}${p.count ? ':' + p.count : ''}`)
        if (m === 'tunnel') y -= p.length
        if (m === 'mine') { const d = dugs[k++] ?? 0; gravel += d; if (k >= dugs.length) flint = 1; return { detail: { dug: d } } }
        return { status: 'done', detail: {} }
      }
    }
    await createOverworldRoute(ctx).routeStep({ kind: 'flint', buried: true, at: { x: 5, y: 71, z: 5 }, ore: { x: 5, y: 66, z: 5 }, top: 70 })
    return calls
  }
  const full = await run([6, 6])
  assert.ok(full.includes('mine:6'))
  assert.ok(!full.slice(0, full.lastIndexOf('mine:6') + 1).includes('bag'), full.join(' '))
  const thin = await run([2, 6])
  assert.ok(thin.indexOf('bag') > thin.indexOf('mine:6'), thin.join(' '))
})

test('дерево: кирка уже в рюкзаке и брёвен на топливо ≥ 3 — рощи дальше не ищем (рюкзак отстал от крафта)', async () => {
  const { createOverworldRoute }: typeof import('../src/campaign/overworld-route') = require('../src/campaign/overworld-route')
  const calls: string[] = []
  let pick = 0
  const ctx: any = {
    process: { env: {} }, died: false, state: { pos: { x: 0, y: 64, z: 0 } }, known: {},
    have: (p: any) => (String(p).includes('pickaxe') ? pick : 0), refresh: async () => { pick = 1 }, y: () => 64, woodNow: () => 4,
    routeLeaveOutpost: async () => {}, routeGo: async () => true, planksFor: () => 'oak_planks', craft: async () => true,
    routeInfoGet: () => ({ ores: { trees: [{ x: 30, y: 64, z: 0, n: 6 }] } }), routeMod: {}, stageRun: () => async () => { calls.push('stage') }, rlog: () => {},
    act: async (m: string) => { calls.push(m); return { status: 'done', detail: {} } }
  }
  // Рюкзак «без кирки» до первого refresh (как после «server did not confirm click»), затем кирка видна.
  ctx.process.env.ND_ROUTE_WOODMAP = '0'
  const ok = await createOverworldRoute(ctx).routeStep({ kind: 'wood', logs: 8 })
  assert.strictEqual(ok, true)
  assert.ok(!calls.includes('mine') && !calls.includes('stage'), calls.join(' '))
})

test('pathfinder: в верхнем мире вода дороже (liquidCost ≥ 3), в Аду — как было; ND_OW_LIQUID=0 — как было', () => {
  const worlds: typeof import('../src/worlds') = require('../src/worlds')
  const reg = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const mk = (dimension: string) => ({ movements: { liquidCost: 1, blocksToAvoid: new Set(), blocksCantBreak: new Set(), getNeighbors: () => [] } as any, bot: { registry: reg, entity: { position: { y: 64 } }, game: { dimension } } as any })
  const ow = mk('overworld'); worlds.tuneMovements(ow.bot, ow.movements)
  assert.strictEqual(ow.movements.liquidCost, 3)
  const ne = mk('the_nether'); worlds.tuneMovements(ne.bot, ne.movements)
  assert.strictEqual(ne.movements.liquidCost, 1)
  withEnv8b({ ND_OW_LIQUID: '0' }, () => { const off = mk('overworld'); worlds.tuneMovements(off.bot, off.movements); assert.strictEqual(off.movements.liquidCost, 1) })
})

test('запас блоков одного ведра: у лавы 16, на этапе камня 12 (добор под землёй дорог)', () => {
  const { createOverworldRoute }: typeof import('../src/campaign/overworld-route') = require('../src/campaign/overworld-route')
  const ctx: any = { process: { env: { ND_ROUTE: '1' } }, routeMod: { BUCKETS: () => 1 } }
  const r = createOverworldRoute(ctx)
  assert.strictEqual(r.routeBlockTarget(), 16)
  assert.strictEqual(r.routeBlockTarget(22, false), 12)
  ctx.routeMod.BUCKETS = () => 2
  assert.strictEqual(r.routeBlockTarget(22, false), 22)
})
