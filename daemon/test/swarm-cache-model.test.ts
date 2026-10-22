import test from 'node:test'
import assert from 'node:assert/strict'
import { CacheModel, castRays, pieCounts, rayDirs } from '../src/swarm/cache-model'
import { cacheJobs } from '../src/swarm/plan-jobs'

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
