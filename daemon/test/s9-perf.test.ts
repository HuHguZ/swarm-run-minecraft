// S9 (скорость тела): кеш блоков pathfinder'а, описания по номеру состояния, память инструмента и бюджет A* в узлах
// не меняют решений. Равенство поисков «до/после» (ND_S9=0 против 1) — на синтетическом мире с лавой, водой, магмой,
// оврагом, деревьями и обрывом через тот же Movements, что строит Session.updateMovements (try-astar-bench.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as bench from '../scenes/infra/try-astar-bench'
import fastblocks = require('../src/fastblocks')
import AStar = require('mineflayer-pathfinder/lib/astar')
import Move = require('mineflayer-pathfinder/lib/move')
import { goals } from 'mineflayer-pathfinder'

function height (x: number, z: number) {
  const h = 60 + Math.round(4 * Math.sin(x / 7) + 3 * Math.cos(z / 9))
  return x >= 20 ? h + 12 : h
}
const TREES = [[-8, -8], [3, 12], [-25, -3], [12, 20]]
function fill (x: number, y: number, z: number): string | null {
  const h = height(x, z)
  if (x >= 14 && x <= 16 && y > 44 && y <= h) return y === 45 ? 'lava' : null // овраг с лавой на дне
  for (const [tx, tz] of TREES) {
    const th = height(tx, tz)
    if (x === tx && z === tz && y > th && y <= th + 5) return 'oak_log'
    if (Math.abs(x - tx) <= 2 && Math.abs(z - tz) <= 2 && y >= th + 4 && y <= th + 6 && !(x === tx && z === tz && y <= th + 5)) return 'oak_leaves'
  }
  if (y > h) return null
  if (x >= 5 && x <= 10 && z >= -10 && z <= -5 && y >= h - 1) return 'lava'
  if (x >= -20 && x <= -12 && z >= 8 && z <= 16 && y >= h - 1) return 'water'
  if (y === h) return x >= -5 && x <= -2 && z >= -20 && z <= -17 ? 'magma_block' : x === 0 && z >= -30 && z <= -24 ? 'cobweb' : 'grass_block'
  return y >= h - 3 ? 'dirt' : 'stone'
}
let cached: any
const world = () => (cached ??= bench.syntheticWorld(fill, -2, 1, 40, 90))

test('S9: поиски A* на синтетическом мире — те же пути и порядок раскрытия узлов с кешем и без', () => {
  const w = world()
  const list = bench.pairs(w, { x: 0, z: 0 }, 26, 12, 7, { top: 90, bottom: 41 })
  assert.ok(list.length >= 10, 'пары нашлись')
  const old = bench.runAll(w, list, { cap: 700, mode: '0' })
  const fast = bench.runAll(w, list, { cap: 700, mode: '1' })
  for (let i = 0; i < list.length; i++) assert.deepEqual(fast.sigs[i], old.sigs[i], `поиск ${i} (${list[i].kind})`)
  assert.ok(fast.cache && fast.cache.hits > fast.cache.misses, 'кеш работает')
  assert.ok(old.sigs.some((s: any) => s.status === 'success') && old.sigs.some((s: any) => s.path.some((p: string) => / b/.test(p))), 'есть успехи и копка')
  // Nether-настройки (пол Ада, строгая лава) — тот же мир как Ад.
  const oldN = bench.runAll(w, list.slice(0, 6), { cap: 500, mode: '0', dim: 'the_nether' })
  const fastN = bench.runAll(w, list.slice(0, 6), { cap: 500, mode: '1', dim: 'the_nether' })
  assert.deepEqual(fastN.sigs, oldN.sigs)
})

test('S9: кеш блоков сбрасывают обновление блока, загрузка/выгрузка столбца, пакет света и тихая постановка', () => {
  const w = world()
  const bot = bench.fakeBot(w, { at: new Vec3(0.5, height(0, 0) + 1, 0.5) })
  const fb = fastblocks.install(bot)
  const p = new Vec3(3, height(3, 3) + 1, 3)
  const was = fb.block(p.x, p.y, p.z)
  assert.equal(was.name, 'air')
  assert.equal(fb.block(p.x, p.y, p.z), was, 'второй раз — из кеша')
  w.setBlockStateId(p, bot.registry.blocksByName.stone.defaultState)
  assert.equal(fb.block(p.x, p.y, p.z).name, 'stone', 'blockUpdate')
  assert.equal(fb.def(p.x, p.y, p.z).name, 'stone')
  w.setBlockStateId(p, 0)
  // Свет: пакет update_light столбца — свежий skyLight.
  const col = w.getColumnAt(p)
  const b1 = fb.block(p.x, p.y, p.z)
  col.setSkyLight({ x: p.x & 15, y: p.y, z: p.z & 15 }, 3)
  bot._client.emit('update_light', { chunkX: p.x >> 4, chunkZ: p.z >> 4 })
  const b2 = fb.block(p.x, p.y, p.z)
  assert.notEqual(b2, b1)
  assert.equal(b2.skyLight, 3)
  // Тихая постановка (blockmoves silentSet): столбец напрямую + invalidate.
  col.setBlockStateId({ x: p.x & 15, y: p.y, z: p.z & 15 }, bot.registry.blocksByName.dirt.defaultState)
  assert.equal(fb.block(p.x, p.y, p.z).name, 'air', 'без события — старое (поэтому silentSet зовёт invalidate)')
  fb.invalidate(p.x, p.y, p.z)
  assert.equal(fb.block(p.x, p.y, p.z).name, 'dirt')
  col.setBlockStateId({ x: p.x & 15, y: p.y, z: p.z & 15 }, 0)
  fb.invalidate(p.x, p.y, p.z)
  // Выгрузка столбца — null, как bot.blockAt; загрузка — снова блоки.
  const cx = p.x >> 4; const cz = p.z >> 4
  w.unloadColumn(cx, cz)
  assert.equal(fb.block(p.x, p.y, p.z), null)
  assert.equal(fb.def(p.x, p.y, p.z), null)
  w.setColumn(cx, cz, col)
  assert.equal(fb.block(p.x, p.y, p.z).name, 'air')
  // Поиск после правки мира — как у бота без кеша (стена поперёк пути).
  const wall = []
  for (let z = -6; z <= 6; z++) for (let dy = 1; dy <= 3; dy++) wall.push(new Vec3(-3, height(-3, z) + dy, z))
  const start = new Vec3(-8.5, height(-9, 0) + 1, 0.5); const goal = new goals.GoalNear(2, height(2, 0) + 1, 0, 1)
  const run = (mode: string) => {
    const prev = process.env.ND_S9; process.env.ND_S9 = mode
    try {
      const b = bench.fakeBot(w, { at: start })
      const { movements } = bench.daemonMovements(b, {})
      const before = bench.search(b, movements, start, goal, 900).sig
      for (const q of wall) w.setBlockStateId(q, b.registry.blocksByName.stone.defaultState)
      const after = bench.search(b, movements, start, goal, 900).sig
      for (const q of wall) w.setBlockStateId(q, 0)
      return { before, after }
    } finally { if (prev === undefined) delete process.env.ND_S9; else process.env.ND_S9 = prev }
  }
  const a = run('0'); const f = run('1')
  assert.deepEqual(f, a)
  assert.notDeepEqual(a.after, a.before, 'стена меняет путь')
})

test('S9: бюджет A* в узлах без среза (ND_ASTAR_SLICE_NODES=0) — только поиск без шага: тот же таймаут на том же числе узлов; с шагом — как было', () => {
  const w = world()
  const prev = { s9: process.env.ND_S9, r: process.env.ND_ASTAR_NODES_PER_MS, n: process.env.ND_ASTAR_SLICE_NODES }
  process.env.ND_S9 = '1'; process.env.ND_ASTAR_NODES_PER_MS = '1'; process.env.ND_ASTAR_SLICE_NODES = '0'
  try {
    // Без шага: старт — верх плато, цель высоко над ним, блоков нет — лучший узел так и остаётся стартом.
    const top = new Vec3(20.5, height(20, 0) + 1, 0.5)
    const sky = new goals.GoalNear(20, height(20, 0) + 31, 0, 1)
    const bot = bench.fakeBot(w, { at: top, kit: ['stone_pickaxe'] })
    const { movements } = bench.daemonMovements(bot, {})
    const capped = bench.search(bot, movements, top, sky, 200).sig // предел раскрытых узлов стенда
    assert.equal(capped.path.length, 0, 'пути нет — тело стоит')
    const p = top.floored()
    const a = new AStar(new Move(p.x, p.y, p.z, movements.countScaffoldingItems(), 0), movements, sky, 200, 1e9, -1) // 200 мс × 1 узел/мс
    const r = a.compute()
    assert.equal(r.status, 'timeout')
    assert.equal(r.visitedNodes, 200)
    assert.equal(r.generatedNodes, capped.generated)
    assert.equal(r.path.length, 0)
    assert.equal(a.compute().status, 'timeout', 'повторный вызов — тот же таймаут')
    // С шагом (лучший узел ушёл от старта) — бюджет в узлах не режет: тот же поиск, что без него.
    const start = new Vec3(-20.5, height(-21, -20) + 1, -20.5)
    const far = new goals.GoalNear(25, height(25, 25) - 8, 25, 1) // под плато — дорого
    const bot2 = bench.fakeBot(w, { at: start })
    const mv2 = bench.daemonMovements(bot2, {}).movements
    const q = start.floored()
    const run = (rate: string) => {
      process.env.ND_ASTAR_NODES_PER_MS = rate
      const s = new AStar(new Move(q.x, q.y, q.z, mv2.countScaffoldingItems(), 0), mv2, far, 200, 1e9, -1)
      const g = s.goal
      s.goal = { heuristic: (n: any) => g.heuristic(n), isEnd: (n: any) => { if (s.closedDataSet.size >= 700) throw new Error('stop'); return g.isEnd(n) } }
      assert.throws(() => s.compute(), /stop/, 'дошёл до 700 узлов — бюджет 200 не срезал')
      return { best: s.bestNode.data.hash, g: s.bestNode.g, open: s.openHeap.size(), closed: s.closedDataSet.size }
    }
    assert.deepEqual(run('1'), run('0'))
  } finally {
    if (prev.s9 === undefined) delete process.env.ND_S9; else process.env.ND_S9 = prev.s9
    if (prev.r === undefined) delete process.env.ND_ASTAR_NODES_PER_MS; else process.env.ND_ASTAR_NODES_PER_MS = prev.r
    if (prev.n === undefined) delete process.env.ND_ASTAR_SLICE_NODES; else process.env.ND_ASTAR_SLICE_NODES = prev.n
  }
})

test('S9: срез A* в узлах (ND_ASTAR_SLICE_NODES) — та же развёртка поиска; бюджет всего поиска — и с шагом', () => {
  const w = world()
  const prev = { s9: process.env.ND_S9, r: process.env.ND_ASTAR_NODES_PER_MS, n: process.env.ND_ASTAR_SLICE_NODES }
  process.env.ND_S9 = '1'
  try {
    const start = new Vec3(-20.5, height(-21, -20) + 1, -20.5)
    const far = new goals.GoalNear(25, height(25, 25) - 8, 25, 1)
    const bot = bench.fakeBot(w, { at: start })
    const mv = bench.daemonMovements(bot, {}).movements
    const q = start.floored()
    const fresh = (timeout: number) => new AStar(new Move(q.x, q.y, q.z, mv.countScaffoldingItems(), 0), mv, far, timeout, 1e9, -1)
    process.env.ND_ASTAR_NODES_PER_MS = '0'; process.env.ND_ASTAR_SLICE_NODES = '0'
    const whole = bench.search(bot, mv, start, far, 900).sig
    // Срез 50 узлов: каждый вызов — partial ровно через 50 раскрытых, развёртка та же.
    process.env.ND_ASTAR_SLICE_NODES = '50'
    const a = fresh(1e9)
    const r1 = a.compute()
    assert.equal(r1.status, 'partial')
    assert.equal(r1.visitedNodes, 50)
    assert.equal(a.compute().visitedNodes, 100)
    assert.equal(a.tickTimeout, 1e9, 'tickTimeout восстановлен')
    const sliced = bench.search(bot, mv, start, far, 900)
    assert.deepEqual(sliced.sig, whole)
    assert.ok(sliced.slices >= 18, 'поиск шёл срезами')
    // Бюджет всего поиска со срезом — и для поиска с шагом: таймаут на 300 узлах (300 мс × 1 узел/мс).
    process.env.ND_ASTAR_NODES_PER_MS = '1'
    const b = fresh(300)
    let r
    do { r = b.compute() } while (r.status === 'partial')
    assert.equal(r.status, 'timeout')
    assert.equal(r.visitedNodes, 300)
    assert.ok(r.path.length > 0, 'шаг был — бюджет всё равно режет (игровое время как прежде)')
  } finally {
    for (const [k, v] of [['ND_S9', prev.s9], ['ND_ASTAR_NODES_PER_MS', prev.r], ['ND_ASTAR_SLICE_NODES', prev.n]] as [string, string | undefined][]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})

test('S9: accelerated A* yields within the server tick and keeps the same search', t => {
  const gameClock: typeof import('../src/game-clock') = require('../src/game-clock')
  let rate = 20
  t.mock.method(gameClock, 'snapshot', () => ({ tickRate: rate }))
  const prev = { s9: process.env.ND_S9, r: process.env.ND_ASTAR_NODES_PER_MS, n: process.env.ND_ASTAR_SLICE_NODES }
  process.env.ND_S9 = '1'; process.env.ND_ASTAR_NODES_PER_MS = '0'; process.env.ND_ASTAR_SLICE_NODES = '120'
  t.after(() => {
    for (const [k, v] of [['ND_S9', prev.s9], ['ND_ASTAR_NODES_PER_MS', prev.r], ['ND_ASTAR_SLICE_NODES', prev.n]] as [string, string | undefined][]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  const run = (tickTimeout = 40, fail = false) => {
    let a
    const budgets = []
    const mv = { getNeighbors(n) {
      budgets.push(a.tickTimeout)
      if (fail) throw new Error('neighbor failed')
      return [new Move(n.x + 1, 0, 0, 0, 1)]
    } }
    a = new AStar(new Move(0, 0, 0, 0, 0), mv, new goals.GoalBlock(300, 0, 0), 1e6, tickTimeout)
    const goal = a.goal
    if (fail) {
      assert.throws(() => a.compute(), /neighbor failed/)
      assert.equal(a.tickTimeout, tickTimeout)
      assert.equal(a.goal, goal)
      return
    }
    let result
    do { result = a.compute() } while (result.status === 'partial')
    assert.equal(result.status, 'success')
    assert.equal(a.tickTimeout, tickTimeout, 'caller budget restored')
    assert.equal(a.goal, goal)
    return { path: result.path.map(n => n.hash), visited: result.visitedNodes, budgets }
  }
  const normal = run()
  assert.ok(normal.budgets.every(ms => ms === 40 || ms === -Infinity))
  rate = 750
  const accelerated = run()
  assert.deepEqual(accelerated.path, normal.path)
  assert.equal(accelerated.visited, normal.visited)
  assert.ok(accelerated.budgets.every(ms => ms <= 40 * 20 / 750), 'compute must leave time for the next physical step')
  assert.ok(run(.25).budgets.every(ms => ms <= .25), 'smaller caller budget wins')
  run(40, true)
})

test('S9: память инструмента — сброс по updateSlot рюкзака, эффекты в ключе', () => {
  const w = world()
  const prev = process.env.ND_S9; process.env.ND_S9 = '1'
  try {
    const bot = bench.fakeBot(w, { at: new Vec3(0.5, 70, 0.5), kit: ['stone_pickaxe', 'dirt:4'] })
    const inv = Object.assign(new EventEmitter(), { slots: bot.inventory.slots, items: bot.inventory.items })
    bot.inventory = inv
    const orig = bot.pathfinder.bestHarvestTool
    bench.daemonMovements(bot, {})
    assert.notEqual(bot.pathfinder.bestHarvestTool, orig, 'обёрнут')
    const stone = bot.blockAt(new Vec3(0, 50, 0))
    assert.equal(stone.name, 'stone')
    assert.equal(bot.pathfinder.bestHarvestTool(stone).name, 'stone_pickaxe')
    const pick = inv.slots[36]
    inv.slots[36] = null
    assert.equal(bot.pathfinder.bestHarvestTool(stone).name, 'stone_pickaxe', 'без события — из памяти')
    inv.emit('updateSlot', 36, pick, null)
    assert.equal(bot.pathfinder.bestHarvestTool(stone), orig(stone), 'после updateSlot — как без памяти')
    inv.slots[36] = pick; inv.emit('updateSlot', 36, null, pick)
    const t0 = bot._ndFastBlocks.digTime(stone, pick)
    bot.entity.effects = { 2: { id: 2, amplifier: 1, duration: 100 } } // спешка II (id реестра 1.21.11)
    const t1 = bot._ndFastBlocks.digTime(stone, pick)
    assert.ok(t1 < t0, 'спешка — копка быстрее, не из старой памяти')
    assert.equal(t1, stone.digTime(pick.type, false, false, false, [], bot.entity.effects))
  } finally { if (prev === undefined) delete process.env.ND_S9; else process.env.ND_S9 = prev }
})

test('S9: findBlocks по номеру состояния — те же клетки и порядок, что у mineflayer', () => {
  const w = world()
  const prev = process.env.ND_S9; process.env.ND_S9 = '1'
  try {
    const bot = bench.fakeBot(w, { at: new Vec3(0.5, 70, 0.5) })
    require('mineflayer/lib/plugins/blocks')(bot, { version: '1.21.11' })
    bot.world = w
    fastblocks.install(bot)
    assert.ok(bot.findBlocks._ndFast, 'подменён')
    const orig = bot.findBlocks._ndOrig
    const ids = (...names: string[]) => names.map(n => bot.registry.blocksByName[n].id)
    const cases = [
      { matching: ids('oak_log'), maxDistance: 24, count: 24 },
      { matching: ids('lava', 'water'), maxDistance: 32, count: 64 },
      { matching: ids('magma_block')[0], maxDistance: 40, count: 5, point: new Vec3(-10.2, 61, -12.7) },
      { matching: ids('cobweb', 'oak_leaves'), maxDistance: 16, count: 1 },
      { matching: ids('chest'), maxDistance: 24, count: 24 },
      { matching: ids('stone'), maxDistance: 6, count: 200, point: new Vec3(3, 50, -4) }
    ]
    for (const c of cases) {
      const a = orig(c).map((p: any) => p.toString()); const b = bot.findBlocks(c).map((p: any) => p.toString())
      assert.deepEqual(b, a, JSON.stringify(c.matching))
    }
    assert.ok(orig(cases[0]).length > 0 && orig(cases[1]).length > 0, 'находит')
    const fn = (b: any) => b && b.name === 'oak_log'
    assert.deepEqual(bot.findBlocks({ matching: fn, maxDistance: 24, count: 3 }).map(String), orig({ matching: fn, maxDistance: 24, count: 3 }).map(String))
  } finally { if (prev === undefined) delete process.env.ND_S9; else process.env.ND_S9 = prev }
})

test('S9: нарезка кадров протокола без исключения на конце буфера — те же кадры при любой нарезке потока', async () => {
  const framing = require('minecraft-protocol/src/transforms/framing')
  const [, writeVarInt, sizeOfVarInt] = (require('protodef') as any).types.varint
  // Поток кадров разной длины (длины с 1-, 2- и 3-байтовым varint).
  const frames: Buffer[] = []
  let s = 12345
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  for (let i = 0; i < 49; i++) { const n = [0, 1, 5, 127, 128, 300, 17000][i % 7] + Math.floor(rnd() * 3); const b = Buffer.alloc(n); for (let k = 0; k < n; k++) b[k] = (i * 31 + k) & 255; frames.push(b) }
  const stream = Buffer.concat(frames.map(f => { const h = Buffer.alloc(sizeOfVarInt(f.length)); writeVarInt(f.length, h, 0); return Buffer.concat([h, f]) }))
  const run = async (soft: boolean, cuts: number[]) => {
    const sp = framing.createSplitter()
    const proto = Object.getPrototypeOf(sp)
    const out: string[] = []
    const t = soft ? fastblocks._softTransform : proto._ndOrigTransform || proto._transform
    sp.push = (b: Buffer) => { out.push(b.toString('hex')); return true }
    let at = 0
    for (const c of [...cuts, stream.length]) {
      await new Promise<void>((resolve, reject) => t.call(sp, stream.subarray(at, c), null, error => error ? reject(error) : resolve()))
      at = c
    }
    return { out, rest: sp.buffer.toString('hex') }
  }
  for (let trial = 0; trial < 12; trial++) {
    const cuts: number[] = []
    let p = 0
    while (p < stream.length) { p += 1 + Math.floor(rnd() * (trial < 6 ? 9 : 4000)); if (p < stream.length) cuts.push(p) }
    const a = await run(false, cuts); const b = await run(true, cuts)
    assert.deepEqual(b, a, `нарезка ${trial}`)
    assert.equal(a.out.length, frames.length)
  }
})
