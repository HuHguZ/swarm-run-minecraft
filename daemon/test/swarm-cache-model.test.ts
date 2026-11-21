import test from 'node:test'
import assert from 'node:assert/strict'
import { CacheModel, castRays, pieCounts, rayDirs } from '../src/swarm/cache-model'
import { cacheJobs } from '../src/swarm/plan-jobs'
import { SwarmBoard } from '../src/swarm/board'
import { swarmCaches } from '../../farm/swarm/swarm-driver/caches'
import { createSwarmDriver } from '../../farm/swarm/swarm-driver'

// Игрушечный «колизей»: пол y −1, поле |x|,|z| < 14, ряды ступенями (кольцо 14..23, высота n − 13), стена 24..26 высотой 16.
// Сундуки рядов — на ступенях (видны), тайник — в толще (6 соседей сплошные).
type P = { x: number; y: number; z: number }
function arena (cache: P) {
  const solid = new Set<string>()
  const k = (x: number, y: number, z: number) => `${x},${y},${z}`
  for (let x = -27; x <= 27; x++) for (let z = -27; z <= 27; z++) {
    solid.add(k(x, -1, z))
    const n = Math.max(Math.abs(x), Math.abs(z))
    const h = n >= 24 && n <= 26 ? 16 : n >= 14 && n < 24 ? n - 13 : 0
    for (let y = 0; y < h; y++) solid.add(k(x, y, z))
  }
  const chests: P[] = []
  for (const [x, z] of [[0, -16], [16, 0], [0, 18], [-20, 5], [-15, -15], [19, 19]]) {
    const n = Math.max(Math.abs(x), Math.abs(z)); const y = n - 13
    chests.push({ x, y, z })
  }
  const opaque = (x: number, y: number, z: number) => (x === cache.x && y === cache.y && z === cache.z) || solid.has(k(x, y, z)) ? 1 : 0
  return { solid, chests, opaque, all: [...chests, cache] }
}
const box = { x0: -28, x1: 28, y0: -1, y1: 18, z0: -28, z1: 28 }
// Видимые сундуки: луч из глаз к центру сундука первым входит в его клетку.
function visible (eye: P, chests: P[], opaque: (x: number, y: number, z: number) => number) {
  return chests.filter(c => {
    const d = { x: c.x + .5 - eye.x, y: c.y + .5 - eye.y, z: c.z + .5 - eye.z }, L = Math.hypot(d.x, d.y, d.z)
    for (let t = 0.2; t < L; t += 0.05) {
      const x = Math.floor(eye.x + d.x / L * t), y = Math.floor(eye.y + d.y / L * t), z = Math.floor(eye.z + d.z / L * t)
      if (x === c.x && y === c.y && z === c.z) return true
      if (opaque(x, y, z)) return false
    }
    return true
  }).map(c => [c.x, c.y, c.z])
}
function scan (w: ReturnType<typeof arena>, eye: P, spin: number, pie = true) {
  return { eye, n: 900, spin, range: 56, hits: castRays(eye, w.opaque, 900, spin, 56), chests: visible(eye, w.chests, w.opaque), ...(pie ? { pie: { step: 5, range: 64, bins: pieCounts(eye, w.all, 5, 64) } } : {}) }
}

test('лучи: сфера Фибоначчи — единичные векторы, покрытие без дыр', () => {
  const d = rayDirs(500, 0.37)
  assert.equal(d.length, 500)
  for (const v of d) assert.ok(Math.abs(Math.hypot(v[0], v[1], v[2]) - 1) < 1e-9)
  // Любое направление — в пределах ~10° от какого-то луча.
  for (const u of [[1, 0, 0], [0, 1, 0], [0, -1, 0], [.6, .0, .8], [-.5, .5, -.707]]) {
    const best = Math.max(...d.map(v => v[0] * u[0] + v[1] * u[1] + v[2] * u[2]))
    assert.ok(best > Math.cos(10 * Math.PI / 180), `дыра у ${u}`)
  }
})

test('толща: невиданные клетки под видимой формой — кандидаты; тайник среди них, но не известен', () => {
  const cache = { x: 18, y: 2, z: -6 }
  const w = arena(cache)
  const m = new CacheModel(box)
  const s = scan(w, { x: 0.5, y: 1.62, z: 0.5 }, 0.1, false)
  m.addScan(s)
  m.refresh()
  const i = m.idx(cache.x, cache.y, cache.z)
  assert.ok(m.candidate(i), 'клетка тайника — кандидат (толща под рядами)')
  assert.ok(!m.candidate(m.idx(0, 3, 0)), 'воздух над полем — не кандидат')
  const hit = s.hits.find(h => h && h[1] >= 1) as number[]
  assert.ok(hit && !m.candidate(m.idx(hit[0], hit[1], hit[2])), 'увиденная грань — не кандидат')
  assert.ok(m.cand.length > 1000, `толща: ${m.cand.length}`)
  assert.ok(!m.known.has(`${cache.x},${cache.y},${cache.z}`))
})

test('честность: без «пирога» решение не зависит от того, где тайник (невидимые клетки не читаются)', () => {
  const plans = [{ x: 18, y: 2, z: -6 }, { x: -20, y: 3, z: 9 }].map(cache => {
    const w = arena(cache), m = new CacheModel(box)
    for (const [k, eye] of [{ x: 0.5, y: 1.62, z: 0.5 }, { x: 15.5, y: 3.62, z: 0.5 }].entries()) m.addScan(scan(w, eye, 0.2 + k * 0.3, false))
    return m.planDig({ x: 15.5, y: 2, z: 0.5 })
  })
  assert.deepEqual(plans[0], plans[1])
})

test('«пирог» с наклоном: с трёх мест тайник выделен — горячая точка рядом с ним', () => {
  const cache = { x: 18, y: 2, z: -6 }
  const w = arena(cache)
  const m = new CacheModel(box)
  for (const [k, eye] of [{ x: 0.5, y: 1.62, z: 0.5 }, { x: 10.5, y: 1.62, z: -10.5 }, { x: -8.5, y: 1.62, z: 9.5 }, { x: 0.5, y: 5.62, z: 17.5 }].entries()) m.addScan(scan(w, eye, 0.13 * k + 0.05))
  const top = m.hotspots(3)
  assert.ok(top.length > 0)
  const d = Math.hypot(top[0].at.x - cache.x, top[0].at.y - cache.y, top[0].at.z - cache.z)
  assert.ok(d <= 4, `горячая точка ${JSON.stringify(top[0])} в ${d.toFixed(1)} бл. от тайника`)
  assert.ok(top[0].p > 0.05, `вероятность в точке ${top[0].p}`)
  const plan = m.planDig({ x: 10.5, y: 0, z: -10.5 })!
  assert.ok(plan && Math.hypot(plan.to.x - cache.x, plan.to.z - cache.z) <= 6, `ход к ${JSON.stringify(plan?.to)}`)
})

function scannerReports(extra: P[] = []) {
  const cache = { x: 18, y: 2, z: -6 }, w = arena(cache)
  w.all.push(...extra)
  const ground = w.opaque
  w.opaque = (x, y, z) => x >= -5 && x <= 4 && y >= 46 && y <= 49 && z >= -5 && z <= 4 ? 1 : ground(x, y, z)
  for (let i = 0; i < 64; i++) w.all.push({ x: i % 8 - 4, y: 47, z: Math.floor(i / 8) - 4 })
  const eyes = [{ x: .5, y: 1.62, z: .5 }, { x: 10.5, y: 1.62, z: -10.5 }, { x: -8.5, y: 1.62, z: 9.5 }, { x: .5, y: 5.62, z: 17.5 }]
  return eyes.map((eye, i) => scan(w, eye, .13 * i + .05))
}

test('a single unresolved eastern chest never pays the miner for the 64 chests upstairs in separate F3 sectors', t => {
  const m = new CacheModel(box)
  for (const s of scannerReports()) m.addScan(s)
  const me = { x: 10.5, y: 0, z: -10.5 }, plan = m.planDig(me)!
  const easternMass = [...m.cand].reduce((sum, i) => sum + (m.at(i).x > 1 ? m.prob(i) : 0), 0)
  assert.equal(m.unknown, 65)
  assert.ok(easternMass > .05 && easternMass <= 1.00001, `one unresolved eastern chest was priced as ${easternMass}`)
  assert.ok(plan && plan.gain <= 1.00001 && plan.gain > .05)
  assert.equal(m.dig(plan.from, plan.to, new Set(plan.exposed)).gain, 0, 'a teammate cannot count the other miner’s reserved discovery again')
  t.diagnostic(`estimated finds ${plan.gain.toFixed(3)} in ${plan.cost.toFixed(2)} s, ${(60 * plan.rate).toFixed(3)}/min`)
})

test('one unresolved chest can span multiple remaining cells, and two registered chests can pay for two discoveries', () => {
  const m = new CacheModel(box), reports = scannerReports()
  for (const [i, s] of reports.entries()) m.addScan(i ? { ...s, pie: undefined } : s)
  m.refresh()
  const eastern = [...m.cand].filter(i => m.at(i).x > 1 && m.prob(i) > 0)
  assert.ok(eastern.length > 1, 'a single bearing leaves several plausible supports')
  assert.ok(eastern.reduce((sum, i) => sum + m.prob(i), 0) <= 1.00001)
  const pair = new CacheModel(box)
  for (const s of scannerReports([{ x: 19, y: 2, z: -6 }])) pair.addScan(s)
  pair.refresh()
  const exposed = pair.dig({ x: 15, y: 2, z: -5 }, { x: 22, y: 2, z: -5 })
  assert.ok(exposed.gain > 1 && exposed.gain <= 2.00001, `two distinct chests along a single tunnel: ${exposed.gain}`)
  assert.ok([...pair.cand].every(i => pair.prob(i) <= 1), 'a physical cell holds at most one chest block')
})

test('a rejected miner leaves the profitable F3 sector to a safe teammate in the twenty-player round', async () => {
  let now = 1000, report: ReturnType<typeof scannerReports>[number]
  const orders: { by: string; method: string; p: any }[] = [], logs: string[] = [], pos: any = {}
  const blue = ['A', 'B', 'Scout', ...Array.from({ length: 17 }, (_, i) => 'Wing' + i)]
  const red = Array.from({ length: 20 }, (_, i) => 'Red' + i)
  const bots = [...blue, ...red].map(name => {
    if (blue.includes(name)) pos[name] = { p: { x: 0, y: 0, z: 0 }, hp: 20, inv: { iron_sword: 1 }, armor: {} }
    return { name, team: blue.includes(name) ? 'blue' : 'red', c: { async call(method, p) {
      orders.push({ by: name, method, p })
      if (method === 'cache_scan') return { detail: name === 'Scout' ? report : {} }
      if (method === 'goto' && name === 'B') {
        pos.B.p = { x: p.x, y: p.y, z: p.z }
        return { status: 'done', detail: { arrived: pos.B.p } }
      }
      return { status: 'done', detail: {} }
    } } }
  })
  const arena = { x: 0, y: 0, z: 0, r: 28 }
  const driver = createSwarmDriver({ arms: true, bots, pos, now: () => now, alive: () => true, arena,
    home: () => ({ x: 0, y: 0, z: 0 }), hostile: (_, id) => red.includes(id), log: s => logs.push(s) })
  for (report of scannerReports()) {
    pos.Scout.p = { ...report.eye, y: report.eye.y - 1.62 }; now += 21000
    await driver.turn(bots[2]); await new Promise(setImmediate)
  }
  assert.equal(orders.filter(o => o.by === 'Scout' && o.method === 'cache_scan').length, 4)
  pos.A.p = { x: -3.5, y: 0, z: -10.5 }; pos.A.inv.wooden_pickaxe = 1
  pos.B.p = { x: 10.5, y: 0, z: -10.5 }; pos.B.inv.iron_pickaxe = 1
  now += 3500
  driver.observe(bots[2], [{ id: 'Red0', visible: true, position: { x: -11.5, y: 0, z: -10.5 },
    equipment: { weapon: 'iron_sword', armor: [] } }], now)
  await driver.turn(bots[1]); await driver.turn(bots[1])
  assert.ok(logs.some(s => s.includes('B: ищу тайники')), 'B accepts the useful eastern tunnel after A declines')
  assert.ok(!logs.some(s => s.includes('A: ищу тайники')), 'A has a reported enemy eight blocks away')
  assert.ok(orders.some(o => o.by === 'B' && o.method === 'dig_to' && o.p.at.x > 14))
})

test('ordinary team miner receives the F3 reports and only takes the dig over a cheaper alternative', async t => {
  const reports = scannerReports(), arena = { x: 0, y: 0, z: 0, r: 28 }, calls: string[] = [], logs: string[] = []
  const me = { x: 10.5, y: 0, z: -10.5 }, pos = { A: { p: me, hp: 20, inv: { iron_pickaxe: 1 } } }
  let now = 1000, report = reports[0]
  const board = new SwarmBoard('blue', () => now, 8000)
  const b = { name: 'A', c: { call: async method => { calls.push(method); return { detail: method === 'cache_scan' ? report : {} } } } }
  const bots = [b, { ...b, name: 'B' }, { ...b, name: 'C' }]
  const work = swarmCaches({ arms: true, arena, bots, pos, now: () => now, alive: () => true, teamOf: () => 'blue',
    generation: 1, boardOf: () => board, lootArena: () => arena, detail: r => r?.detail, go: async () => { calls.push('goto'); return { status: 'interrupted' } },
    log: s => logs.push(s), placed: new Map(), blocked: () => false, failed() {} } as any)
  for (report of reports) {
    pos.A.p = { ...report.eye, y: report.eye.y - 1.62 }; now += 21000
    work.cacheObserve(b); await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(calls.filter(c => c === 'cache_scan').length, 4)
  pos.A.p = me; now += 3000
  board.setMembers(bots.map(bot => ({ id: bot.name, team: 'blue', position: me, health: 20, strength: 1, role: 'miner-builder' })))
  assert.ok(board.observe('A', now, { id: 'red', position: { ...me, x: me.x + 6 }, visible: true }))
  assert.equal(await work.cacheTurn(b, board), false, 'one nearby chest cannot justify turning away from the visible close enemy')
  assert.ok(!calls.includes('dig_to') && !calls.includes('goto'))
  now += 35000
  for (const ally of bots.slice(1)) pos[ally.name] = { ...pos.A }
  const assigned = await Promise.all(bots.map(miner => work.cacheTurn(miner, board)))
  assert.equal(assigned.filter(Boolean).length, 1, 'three equipped miners share one search, although two are allowed to dig')
  assert.ok(calls.includes('dig_to') || calls.includes('goto'))
  t.diagnostic(logs.find(s => s.includes('ищу тайники')))
})

for (const when of ['before planning', 'after selection', 'during approach']) test('cache miners hand off a single useful tunnel when the selected miner gets a flank: ' + when, async () => {
  let now = 1000, report: ReturnType<typeof scannerReports>[number], finishWalk: () => void
  let holdFirst = when === 'during approach'
  const me = { x: 10.5, y: 0, z: -10.5 }, arena = { x: 0, y: 0, z: 0, r: 28 }
  const calls: { miner: string; at: P }[] = []
  const rpc = { call: async method => {
    assert.equal(method, 'cache_scan')
    return { detail: report }
  } }
  const first: any = { name: 'A', c: rpc }, second = { name: 'B', c: rpc }, scout = { name: 'Scout', c: rpc }
  const bots = [first, second, scout], board = new SwarmBoard('red', () => now, 8000)
  const miner = () => ({ p: { ...me }, hp: 20, inv: { iron_pickaxe: 1 } })
  const pos = { A: miner(), B: miner(), Scout: { p: { ...me }, hp: 20, inv: {} } }
  const work = swarmCaches({ arms: true, arena, bots, pos, now: () => now, alive: () => true, teamOf: () => 'red',
    generation: 1, boardOf: () => board, lootArena: () => arena, detail: r => r?.detail || r || {},
    go: async (b, at) => {
      calls.push({ miner: b.name, at })
      if (b === first && holdFirst) await new Promise<void>(resolve => { finishWalk = resolve })
      return { status: 'interrupted' }
    }, log() {}, placed: new Map(), blocked: () => false, failed() {} } as any)
  for (report of scannerReports()) {
    pos.Scout.p = { ...report.eye, y: report.eye.y - 1.62 }; now += 21000
    work.cacheObserve(scout); await new Promise(resolve => setImmediate(resolve))
  }
  if (when === 'before planning') first.swarmReserved = {}
  assert.equal(await work.cacheTurn(scout, board), false)
  let pending
  if (when === 'during approach') {
    pending = work.cacheTurn(first, board)
    assert.deepEqual(calls.map(c => c.miner), ['A'])
    now += 2200
  }
  first.swarmReserved = {} // the ordinary lifecycle skips a fighter owned by an external manoeuvre
  if (pending) {
    try {
      assert.equal(await work.cacheTurn(second, board), false, 'the first approach still owns its front until the RPC yields')
    } finally { finishWalk!(); await pending }
  }
  assert.equal(await work.cacheTurn(second, board), true, 'free hands can take the same front on their next turn')
  assert.deepEqual(calls.map(c => c.miner), pending ? ['A', 'B'] : ['B'])
  if (pending) assert.deepEqual(calls[1].at, calls[0].at)
  assert.equal(await work.cacheTurn(first, board), false)
  holdFirst = false
  delete first.swarmReserved
  Object.assign(second, { swarmReserved: {} })
  assert.equal(await work.cacheTurn(first, board), true, 'the first miner is available again after the manoeuvre')
  assert.deepEqual(calls.at(-1).at, calls[0].at)
})

test('a miner that joined the flank keeps its confirmed last excavation and yields before issuing the next RPC', async () => {
  const from = { x: 15, y: 2, z: -6 }, to = { ...from, x: 17 }, arena = { x: 0, y: 0, z: 0, r: 28 }
  const pos = { A: { p: { ...from, x: from.x + .5, z: from.z + .5 }, hp: 20, inv: { iron_pickaxe: 1 } } }
  const calls: string[] = [], board = new SwarmBoard('red', () => 2100, 8000)
  const b: any = { name: 'A', c: { call: async method => {
    calls.push(method); b.swarmReserved = {}
    return method === 'dig_to' ? { detail: { ok: true, at: to, steps: 2, dug: 4 } } : {}
  } } }
  const work = swarmCaches({ arms: true, arena, bots: [b], pos, now: () => 2100, alive: () => true, teamOf: () => 'red',
    generation: 1, boardOf: () => board, lootArena: () => arena, detail: r => r?.detail, log() {},
    placed: new Map(), blocked: () => false, failed() {} } as any)
  const model = work.cacheModelOf(b)
  model.planDig = () => ({ from, to, gain: 1, cost: 3, cells: 4, rate: 1 / 3, exposed: [] })
  await work.cacheTurn(b, board)
  assert.equal(model.stateAt(to.x, to.y, to.z), 1, 'the server confirmed the final foot cell')
  assert.deepEqual(calls, ['dig_to'])
})

test('a chest personally uncovered under the field is remembered next round, a covered wall cache is not', async t => {
  const prev = process.env.ARMS_CACHE_MEMORY
  process.env.ARMS_CACHE_MEMORY = '0'
  t.after(() => { if (prev === undefined) delete process.env.ARMS_CACHE_MEMORY; else process.env.ARMS_CACHE_MEMORY = prev })
  for (const y of [-2, 1]) {
    const at = { x: 0, y, z: 1 }, from = { x: 0, y: y + 1, z: 0 }
    const p = { x: .5, y: from.y, z: .5 }, frame = { p, hp: 20, inv: { iron_pickaxe: 1 } }
    const board = new SwarmBoard('red', () => 2100, 8000)
    let opens = 0
    const b = { name: 'A', c: { call: async method => {
      if (method === 'dig_to') return { detail: { at: from, steps: 1, dug: 1 } }
      if (method === 'cache_scan') return { detail: { eye: p, n: 0, spin: 0, hits: [], chests: [[at.x, at.y, at.z]] } }
      if (method === 'swarm_work') return { detail: { done: true } }
      if (method === 'chest_take') return { detail: ++opens === 1 ? {} : { contents: {}, took: { iron_ingot: 1 } } }
      return {}
    } } }
    const sw = { arms: true, arena: { x: 0, y: 0, z: 0, r: 15 }, bots: [b], pos: { A: frame }, now: () => 2100,
      alive: () => true, teamOf: () => 'red', generation: 1, boardOf: () => board, detail: r => r?.detail || {},
      lootArena: () => ({}), log() {}, placed: new Map(), blocked: () => false, failed() {} }
    const work = swarmCaches(sw as any)
    work.cacheModelOf(b).planDig = () => ({ from, to: from, gain: 1, cost: 3, cells: 4, rate: 1 / 3, exposed: [] })
    await work.cacheTurn(b, board)
    assert.equal(opens, 2)
    sw.generation++
    assert.equal(work.cacheModelOf(b).known.has(`0,${y},1`), y === -2)
  }
})

test('узор копки без «пирога»: ходы 1×2 открывают ≥ 2.5 невиданных клеток толщи на блок', () => {
  const w = arena({ x: 100, y: 0, z: 100 })
  const m = new CacheModel(box)
  let me = { x: 15.5, y: 2, z: 0.5 }
  m.addScan(scan(w, { x: 0.5, y: 1.62, z: 0.5 }, 0.3, false))
  m.addScan(scan(w, { x: me.x, y: me.y + 1.62, z: me.z }, 0.7, false))
  let dugBlocks = 0, opened = 0
  const dug = new Set<string>()
  for (let step = 0; step < 8; step++) {
    const plan = m.planDig(me, { maxLen: 8 })
    assert.ok(plan, 'план есть')
    const { dug: cells } = m.dig(plan!.from, plan!.to)
    const fresh = plan!.exposed.filter(j => m.candidate(j))
    for (const c of cells) if (w.opaque(c.x, c.y, c.z) && !dug.has(`${c.x},${c.y},${c.z}`)) { dug.add(`${c.x},${c.y},${c.z}`); dugBlocks++; w.solid.delete(`${c.x},${c.y},${c.z}`) }
    for (let j = 0; j < cells.length; j += 2) m.markWalked(cells[j])
    me = { x: cells[cells.length - 2].x + .5, y: cells[cells.length - 2].y, z: cells[cells.length - 2].z + .5 }
    // Что открыл ход — видно из его конца и середины (честно: лучами по миру).
    m.addScan(scan(w, { x: me.x, y: me.y + 1.62, z: me.z }, 0.11 * step + 0.2, false))
    const mid = cells[Math.floor(cells.length / 4) * 2]
    m.addScan(scan(w, { x: mid.x + .5, y: mid.y + 1.62, z: mid.z + .5 }, 0.17 * step + 0.4, false))
    // Открыто — клетки толщи, что были невиданными до хода и стали увиденными после.
    opened += fresh.filter(j => !m.candidate(j)).length
  }
  assert.ok(dugBlocks > 20, `копано ${dugBlocks}`)
  assert.ok(opened / dugBlocks >= 2.5, `открыто ${opened} на ${dugBlocks} блоков (${(opened / dugBlocks).toFixed(2)})`)
})

test('копатели — числами: копка против боя и лута, не больше половины команды при враге, держатся с запасом', () => {
  const at = (x: number) => ({ x, y: 0, z: 0 })
  const team = ['a', 'b', 'c', 'd'].map((id, k) => ({ id, position: at(k * 30), health: 20, gear: 0.2, canDig: id !== 'd' }))
  const offer = (rate: number) => ({ rate, from: at(0), to: at(5) })
  const offers = new Map([['a', offer(0.006)], ['b', offer(0.006)], ['c', offer(0.0005)], ['d', offer(0.01)]])
  // Врага нет: копают те, у кого копка (rate·60·14) дороже лута ((1 − 0.2)·3 = 2.4): a, b — 5.04; c — 0.42; d — нечем.
  let jobs = cacheJobs(team, [], offers, 1000)
  assert.deepEqual([...jobs.keys()].sort(), ['a', 'b'])
  assert.ok(jobs.get('a')!.reason.includes('= 5.04 > 2.40 (лут)'), jobs.get('a')!.reason)
  // Враг в 5 бл. от a — у a бой (10 > 5.04); b в 35 бл. — готовность (4 < 5.04), копает.
  const foe = { id: 'x', position: at(-5), seenAt: 1000, source: 'b', sources: ['b'] } as any
  jobs = cacheJobs(team, [foe], offers, 1000)
  assert.deepEqual([...jobs.keys()], ['b'])
  // Не больше половины команды, пока враг недавно виден: четверо с копкой 5.04 при враге в 35+ бл. — копают двое.
  const far = { ...foe, position: at(-40) }
  const all = new Map(team.map(m => [m.id, offer(0.006)]))
  assert.equal(cacheJobs(team.map(m => ({ ...m, canDig: true })), [far], all, 1000).size, 2)
  // Держится с запасом: копка 3.36 при альтернативе 4 — уже копающий остаётся, новый — нет.
  const slow = new Map([['a', offer(0.004)]])
  assert.equal(cacheJobs([team[0]], [far], slow, 1000).size, 0)
  assert.equal(cacheJobs([team[0]], [far], slow, 1000, new Set(['a'])).size, 1)
})

test('жемчуг — каждому по одному: у кого лишний, тот несёт тому, у кого нет', () => {
  const { SwarmBoard, planTransfers } = require('../src/swarm') as typeof import('../src/swarm')
  const board = new SwarmBoard('blue', () => 1000, 8000)
  const m = (id: string, x: number, inv: Record<string, number>) => ({ id, team: 'blue', position: { x, y: 0, z: 0 }, health: 20, strength: 20, role: 'fighter' as const, inventory: inv, reserve: { ender_pearl: inv.ender_pearl ? 1 : 0 }, needs: {} })
  const members = [m('a', 0, { ender_pearl: 3 }), m('b', 5, {}), m('c', 30, { ender_pearl: 1 })]
  const t = planTransfers(board, members)
  assert.equal(t.length, 1)
  assert.deepEqual([t[0].data!.donor, t[0].data!.recipient, t[0].data!.item, t[0].data!.count], ['a', 'b', 'ender_pearl', 1])
  // Лишнего нет ни у кого (у каждого по одному) — передач нет.
  assert.equal(planTransfers(new SwarmBoard('blue', () => 1000, 8000), [m('a', 0, { ender_pearl: 1 }), m('b', 5, {})]).length, 0)
})

test('пол не копается: ход с пола арены вниз не планируется (под полем — пустота)', () => {
  const w = arena({ x: 100, y: 0, z: 100 })
  const m = new CacheModel(box)
  for (const [k, eye] of [{ x: 0.5, y: 1.62, z: 0.5 }, { x: 15.5, y: 3.62, z: 0.5 }].entries()) m.addScan(scan(w, eye, 0.2 + k * 0.3, false))
  for (const me of [{ x: 15.5, y: 2, z: 0.5 }, { x: 0.5, y: 0, z: 0.5 }]) {
    const plan = m.planDig(me)!
    assert.ok(plan, 'план есть')
    assert.ok(plan.to.y >= box.y0 + 1 && m.dig(plan.from, plan.to).dug.every(c => c.y >= box.y0 + 1), `ход ниже пола: ${JSON.stringify(plan)}`)
  }
})

test('копка против боя команды: незанятые бойцы копают ценой — первый за долю в бою, каждый следующий дороже', () => {
  const at = (x: number) => ({ x, y: 0, z: 0 })
  const offer = (rate: number) => ({ rate, from: at(0), to: at(5) })
  const team = ['a', 'b', 'c'].map((id, k) => ({ id, position: at(k * 5), health: 20, gear: 1, canDig: true, fighting: true }))
  const foe = { id: 'x', position: at(60), seenAt: 1000, source: 'b', sources: ['b'] } as any // в 50+ бл. — бой где-то ещё
  // 0.3/мин × 14 = 4.2: первый боец — против 3 (бой команды), второй — против 3 + 2 = 5, третий — 7.
  const jobs = cacheJobs(team, [foe], new Map(team.map(m => [m.id, offer(0.3 / 60)])), 1000)
  assert.deepEqual([...jobs.keys()], ['a'])
  assert.ok(jobs.get('a')!.reason.includes('(бой команды)'), jobs.get('a')!.reason)
  // Сильнее тайник (1/мин × 14 = 14) — копают двое: 14 > 3 и 14 > 5, третий — 14 > 7 тоже, но не больше половины команды (2).
  assert.equal(cacheJobs(team, [foe], new Map(team.map(m => [m.id, offer(1 / 60)])), 1000).size, 2)
})

test('луч в непрогруженное: воздух — только до края прогрузки, дальше неизвестно', () => {
  const opaque = (x: number) => x > 6 ? -1 : 0 // за x = 6 столбцы не прогружены
  const eye = { x: 0.5, y: 5.5, z: 0.5 }
  const hits = castRays(eye, (x) => opaque(x), 200, 0.3, 40)
  assert.ok(hits.some(h => h && (h as number[]).length === 1), 'есть лучи, кончившиеся в непрогруженном')
  const m = new CacheModel({ x0: -20, x1: 20, y0: -1, y1: 15, z0: -20, z1: 20 })
  m.addScan({ eye, n: 200, spin: 0.3, range: 40, hits })
  assert.equal(m.stateAt(15, 5, 0), 0, 'за краем прогрузки — не «увиденный воздух»')
  assert.equal(m.stateAt(3, 5, 0), 1, 'до края — увиденный воздух')
})
