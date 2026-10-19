// Офлайн-стенд A* (S9, 07.10): тот же Movements, что строит Session.updateMovements демона (цены лавы, магмы, мобов,
// крыши, мосты/спуски blockmoves, MLG-цены edges, фильтры Ада worlds), на сохранённом мире фермы (region-файлы, только
// чтение) или на синтетическом мире теста. Поиск — настоящий AStar pathfinder'а 2.4.5 без бюджета времени, с пределом
// раскрытых узлов (одинаковый для обоих плеч), поэтому результат детерминирован: равенство путей и порядка раскрытия
// узлов «до/после» (ND_S9=0 против ND_S9=1) — тест поведения оптимизаций.
//   node try-astar-bench.js <server-dir> [overworld|the_nether] [пар=60] [предел узлов=6000] [радиус чанков=6] [сид=1]
//   BENCH_MODES=0,1 (порядок плеч), BENCH_REPEAT=2 (повторов на плечо — прогрев JIT), BENCH_ONLY=<плечо> (профиль)
// ponytail: статический мир (без сущностей и обновлений блоков), без разреза поиска по тикам.
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { Vec3 } from 'vec3'
import * as nbt from 'prismarine-nbt'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
// Колонка — с внутренностями prismarine-chunk (skyLightSections, точки без Vec3): его типы этого не описывают.
const Chunk: any = (require('prismarine-chunk') as typeof import('prismarine-chunk').default)(registry)
const World = (require('prismarine-world') as typeof import('prismarine-world').default)('1.21.11')
const Item = (require('prismarine-item') as typeof import('prismarine-item').default)(registry)
import BitArray = require('prismarine-chunk/src/pc/common/BitArray')
import { goals } from 'mineflayer-pathfinder'
import AStar = require('mineflayer-pathfinder/lib/astar')
import Move = require('mineflayer-pathfinder/lib/move')

const MIN_Y = -64
const HEIGHT = 384

function emptyColumn () { return new Chunk({ minY: MIN_Y, worldHeight: HEIGHT }) }

// Небо: столбец из секций света, полностью 15 (как у Minecraft над рельефом); свои значения — setSkyLight.
function fullSky (col) {
  for (let i = 0; i < col.skyLightSections.length; i++) {
    const a = new BitArray({ bitsPerValue: 4, capacity: 4096 })
    for (let k = 0; k < 4096; k++) a.set(k, 15)
    col.skyLightSections[i] = a
  }
}

const stateCache = new Map<string, number>()
function stateOf (entry: { Name: string; Properties?: Record<string, string> }) {
  const key = JSON.stringify(entry)
  let id = stateCache.get(key)
  if (id === undefined) {
    const name = entry.Name.replace('minecraft:', '')
    const props = Object.fromEntries(Object.entries(entry.Properties ?? {}).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v]))
    try { id = registry.blocksByName[name] ? Block.fromProperties(name, props as Record<string, any>, 0).stateId : registry.blocksByName.stone.defaultState } catch { id = registry.blocksByName[name] ? registry.blocksByName[name].defaultState : registry.blocksByName.stone.defaultState }
    stateCache.set(key, id as number)
  }
  return id as number
}

// Столбец из NBT чанка region-файла (1.18+: sections[].block_states, SkyLight). Не «full» — null (сервер его не шлёт).
function columnFromNbt (data: any) {
  if (!data || !Array.isArray(data.sections)) return null
  if (data.Status && !/full/.test(String(data.Status))) return null
  const col = emptyColumn()
  fullSky(col)
  const p = { x: 0, y: 0, z: 0 }
  for (const s of data.sections) {
    const y0 = s.Y * 16
    if (y0 < MIN_Y - 16 || y0 >= MIN_Y + HEIGHT + 16) continue
    const states = s.block_states
    if (states && y0 >= MIN_Y && y0 < MIN_Y + HEIGHT) {
      const { palette, data: longs } = states
      const ids = palette.map(stateOf)
      if (ids.length === 1 || !longs) {
        if (ids[0] !== 0) for (let i = 0; i < 4096; i++) { p.x = i & 15; p.z = (i >> 4) & 15; p.y = y0 + (i >> 8); col.setBlockStateId(p, ids[0]) }
      } else {
        const bits = Math.max(4, Math.ceil(Math.log2(palette.length))); const per = Math.floor(64 / bits); const mask = (1n << BigInt(bits)) - 1n
        for (let i = 0; i < 4096; i++) {
          const long = longs[Math.floor(i / per)]
          const value = (BigInt.asUintN(32, BigInt(long[0])) << 32n) | BigInt.asUintN(32, BigInt(long[1]))
          const id = ids[Number((value >> BigInt((i % per) * bits)) & mask)]
          if (!id) continue
          p.x = i & 15; p.z = (i >> 4) & 15; p.y = y0 + (i >> 8)
          col.setBlockStateId(p, id)
        }
      }
    }
    if (Array.isArray(s.SkyLight) && s.SkyLight.length === 2048) {
      const li = s.Y - MIN_Y / 16 + 1
      if (li >= 0 && li < col.skyLightSections.length) {
        const a = new BitArray({ bitsPerValue: 4, capacity: 4096 })
        for (let i = 0; i < 4096; i++) { const byte = s.SkyLight[i >> 1] & 0xff; a.set(i, i & 1 ? byte >> 4 : byte & 15) }
        col.skyLightSections[li] = a
      }
    }
  }
  return col
}

// Мир из region-файлов: столбцы в радиусе radius чанков от центра (x, z).
export function regionWorld (regionDir: string, center: { x: number; z: number }, radius = 6) {
  const world = new World(null).sync
  const ccx = Math.floor(center.x / 16); const ccz = Math.floor(center.z / 16)
  let loaded = 0
  for (let cx = ccx - radius; cx <= ccx + radius; cx++) for (let cz = ccz - radius; cz <= ccz + radius; cz++) {
    const file = path.join(regionDir, `r.${cx >> 5}.${cz >> 5}.mca`)
    if (!fs.existsSync(file)) continue
    const buf = fs.readFileSync(file); const i = 4 * ((cx & 31) + (cz & 31) * 32); const off = (buf.readUInt32BE(i) >>> 8) * 4096
    if (!off) continue
    const len = buf.readUInt32BE(off); const raw = buf.subarray(off + 5, off + 4 + len)
    const data = nbt.simplify(nbt.parseUncompressed(buf[off + 4] === 2 ? zlib.inflateSync(raw) : buf[off + 4] === 1 ? zlib.gunzipSync(raw) : raw, 'big'))
    const col = columnFromNbt(data)
    if (!col) continue
    world.setColumn(cx, cz, col)
    loaded++
  }
  return { world, loaded }
}

// Синтетический мир теста: fill(x, y, z) → имя блока или null (воздух), в квадрате чанков [c0, c1].
export function syntheticWorld (fill: (x: number, y: number, z: number) => string | null, c0: number, c1: number, yMin = 40, yMax = 110) {
  const world = new World(null).sync
  for (let cx = c0; cx <= c1; cx++) for (let cz = c0; cz <= c1; cz++) {
    const col = emptyColumn(); fullSky(col)
    const p = { x: 0, y: 0, z: 0 }
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      let sky = true
      for (let y = yMax; y >= yMin; y--) {
        const name = fill(cx * 16 + x, y, cz * 16 + z)
        p.x = x; p.y = y; p.z = z
        if (name) { col.setBlockStateId(p, registry.blocksByName[name].defaultState); if (registry.blocksByName[name].boundingBox === 'block') sky = false }
        if (!sky) col.setSkyLight(p, 0)
      }
      for (let y = yMin - 1; y >= MIN_Y; y--) { p.x = x; p.y = y; p.z = z; col.setBlockStateId(p, registry.blocksByName.stone.defaultState); col.setSkyLight(p, 0) }
    }
    world.setColumn(cx, cz, col)
  }
  return world
}

const KIT_DEFAULT = ['stone_pickaxe', 'stone_axe', 'wooden_shovel', 'cobblestone:48', 'dirt:24', 'oak_log:8', 'oak_planks:12', 'bread:6', 'stick:4', 'crafting_table:1']
// Поддельное тело с настоящим pathfinder'ом 2.4.5 поверх мира prismarine-world (bot.blockAt — как у mineflayer).
export function fakeBot (world: any, { dim = 'overworld', at = new Vec3(0, 64, 0), kit = KIT_DEFAULT }: any = {}) {
  const bot: any = new EventEmitter()
  bot.setMaxListeners(0)
  bot.registry = registry
  bot.version = '1.21.11'
  bot.supportFeature = registry.supportFeature
  bot.world = world
  bot.game = { dimension: dim, minY: MIN_Y, height: HEIGHT, gameMode: 'survival' }
  bot.entity = { position: at.clone(), velocity: new Vec3(0, 0, 0), onGround: true, effects: {}, height: 1.8, width: 0.6, metadata: [], isInWater: false, isInLava: false }
  bot.entities = {}
  bot.health = 20; bot.food = 20; bot.quickBarSlot = 0
  const slots = new Array(46).fill(null)
  let k = 36
  for (const spec of kit) {
    const [name, n] = spec.split(':'); const it = new Item(registry.itemsByName[name].id, Number(n || 1))
    it.slot = k; slots[k] = it; k = k === 44 ? 9 : k + 1
  }
  bot.inventory = { slots, items: () => slots.filter(Boolean), on () {}, removeListener () {} }
  Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + bot.quickBarSlot] })
  bot.blockAt = (p: any, extra = true) => { const b = world.getBlock(p); if (b && extra) b.painting = undefined; return b }
  bot._client = Object.assign(new EventEmitter(), { write () {} })
  bot._client.setMaxListeners(0)
  bot.clearControlStates = () => {}; bot.setControlState = () => {}; bot.getControlState = () => false
  bot.look = async () => {}; bot.lookAt = async () => {}
  ;(require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')).pathfinder(bot)
  return bot
}

// Movements демона: Session.updateMovements на поддельной сессии (настройки сессии — cfg).
export function daemonMovements (bot: any, cfg: any = {}) {
  const { Session }: typeof import('../../src/session') = require('../../src/session')
  const s: any = Object.create(Session.prototype)
  s.bot = bot
  s.surfaceWalk = !!cfg.surface; s.surfaceStrict = false; s.pathGoalY = cfg.goalY ?? null
  s.bridgeWanted = cfg.bridge; s.sprintWanted = cfg.sprint
  bot._ndLavaStrict = !!cfg.lavaStrict
  s.updateMovements(true)
  return { session: s, movements: bot.pathfinder.movements }
}

const CAP = new Error('cap')
// Один поиск A* с пределом раскрытых узлов. Подпись — статус, цена, число узлов, порядок раскрытия (хеш) и путь.
export function search (bot: any, mv: any, start: any, goal: any, cap = 6000) {
  bot.entity.position = start.clone()
  if (mv.allowEntityDetection) { mv.clearCollisionIndex(); mv.updateCollisionIndex() }
  let pops = 0; let h = 2166136261
  const g = {
    heuristic: (n: any) => goal.heuristic(n),
    isEnd: (n: any) => {
      if (++pops > cap) throw CAP
      const s = n.hash
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
      return goal.isEnd(n)
    }
  }
  const p = start.floored()
  const t0 = performance.now()
  const a = new AStar(new Move(p.x, p.y, p.z, mv.countScaffoldingItems(), 0), mv, g, 1e12, 1e12, -1)
  let r
  let slices = 0
  try { do { r = a.compute(); slices++ } while (r.status === 'partial') } catch (err) { if (err !== CAP) throw err; r = a.makeResult('partial', a.bestNode) }
  const ms = performance.now() - t0
  return {
    sig: {
      status: r.status, cost: r.cost, visited: r.visitedNodes, generated: r.generatedNodes, pops: Math.min(pops, cap), order: h,
      path: r.path.map((m: any) => `${m.x},${m.y},${m.z}` + (m.toBreak.length ? ` b${m.toBreak.map((q: any) => `${q.x},${q.y},${q.z}`).join(';')}` : '') +
        (m.toPlace.length ? ` p${m.toPlace.length}` : '') + (m.ndBridge ? ' M' : '') + (m.ndDescend ? ' S' : '') + (m.parkour ? ' J' : ''))
    },
    ms, slices
  }
}

// Ноги на опоре: опора — полный блок не жидкость, ноги и голова — пусто не жидкость.
function standable (world: any, x: number, y: number, z: number) {
  const f = world.getBlock(new Vec3(x, y - 1, z)); const a = world.getBlock(new Vec3(x, y, z)); const b = world.getBlock(new Vec3(x, y + 1, z))
  return !!(f && a && b && f.boundingBox === 'block' && a.boundingBox === 'empty' && b.boundingBox === 'empty' && !/lava|water|fire/.test(a.name + b.name + f.name))
}
export function surfaceY (world: any, x: number, z: number, top = 200, bottom = MIN_Y + 1) {
  for (let y = top; y > bottom; y--) if (standable(world, x, y, z)) return y
  return null
}

// Пары «старт → цель» по сиду: старт на опоре, цель на 8–64 бл. (GoalNear у опоры, GoalNearXZ, GoalNear под землёй).
export function pairs (world: any, center: { x: number; z: number }, span: number, n: number, seed = 1, { top = 200, bottom = MIN_Y + 1 } = {}) {
  let s = seed >>> 0 || 1
  const rnd = () => { s = Math.imul(s ^ (s >>> 15), 2246822507) >>> 0; s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0; s ^= s >>> 16; return (s >>> 0) / 4294967296 }
  const out = []
  for (let tries = 0; out.length < n && tries < n * 60; tries++) {
    const x = Math.floor(center.x + (rnd() * 2 - 1) * span); const z = Math.floor(center.z + (rnd() * 2 - 1) * span)
    const yTop = Math.floor(bottom + rnd() * (top - bottom))
    const y = surfaceY(world, x, z, yTop, bottom)
    if (y == null) continue
    const d = 8 + rnd() * 56; const ang = rnd() * Math.PI * 2
    const gx = Math.floor(x + Math.cos(ang) * d); const gz = Math.floor(z + Math.sin(ang) * d)
    if (Math.abs(gx - center.x) > span || Math.abs(gz - center.z) > span) continue
    const gyTop = Math.floor(bottom + rnd() * (top - bottom))
    const gy = surfaceY(world, gx, gz, gyTop, bottom)
    if (gy == null) continue
    const kind = out.length % 3
    const goal = kind === 0 ? new goals.GoalNear(gx, gy, gz, 2) : kind === 1 ? new goals.GoalNearXZ(gx, gz, 2) : new goals.GoalNear(gx, gy - 6, gz, 1)
    out.push({ start: new Vec3(x + 0.5, y, z + 0.5), goal, kind: ['near', 'xz', 'under'][kind], d: Math.round(d) })
  }
  return out
}

// Конфигурации сессии по очереди: поверху/нет, мост, строгая лава (бастион).
export const CONFIGS = [
  { surface: true, bridge: true },
  { surface: false, bridge: true },
  { surface: false, bridge: false, lavaStrict: true }
]

export function runAll (world: any, list: any[], { dim = 'overworld', cap = 6000, mode = '1' }: any = {}) {
  const prev = process.env.ND_S9
  process.env.ND_S9 = mode
  try {
    const bot = fakeBot(world, { dim, at: list[0] ? list[0].start : new Vec3(0, 64, 0) })
    const out = []
    let ms = 0; let nodes = 0
    for (let i = 0; i < list.length; i++) {
      const cfg = CONFIGS[i % CONFIGS.length]
      bot.entity.position = list[i].start.clone()
      const { movements } = daemonMovements(bot, { ...cfg, goalY: list[i].goal.y ?? null })
      const r = search(bot, movements, list[i].start, list[i].goal, cap)
      out.push(r.sig); ms += r.ms; nodes += r.sig.pops
    }
    return { sigs: out, ms, nodes, cache: bot._ndFastBlocks ? bot._ndFastBlocks.stats : null }
  } finally { if (prev === undefined) delete process.env.ND_S9; else process.env.ND_S9 = prev }
}

if (require.main === module) {
  const log = console.log
  console.log = (...a: any[]) => { if (typeof a[0] === 'string' && /^\[(mlg|bridge|path)\]/.test(a[0])) return; log(...a) }
  const [serverDir, dimArg = 'overworld', nArg = '60', capArg = '6000', radArg = '6', seedArg = '1'] = process.argv.slice(2)
  const dim = dimArg === 'the_nether' ? 'the_nether' : 'overworld'
  const regionDir = dim === 'the_nether' ? path.join(serverDir, 'world_nether', 'DIM-1', 'region') : path.join(serverDir, 'world', 'region')
  const lvl = nbt.simplify(nbt.parseUncompressed(zlib.gunzipSync(fs.readFileSync(path.join(serverDir, 'world', 'level.dat'))), 'big'))
  const sp = lvl.Data.spawn ? { x: lvl.Data.spawn.pos[0], z: lvl.Data.spawn.pos[2] } : { x: lvl.Data.SpawnX ?? 0, z: lvl.Data.SpawnZ ?? 0 }
  const center = process.env.BENCH_CENTER ? (([x, z]) => ({ x, z }))(process.env.BENCH_CENTER.split(',').map(Number)) : dim === 'the_nether' ? { x: Math.floor(sp.x / 8), z: Math.floor(sp.z / 8) } : sp
  const t0 = performance.now()
  const { world, loaded } = regionWorld(regionDir, center, Number(radArg))
  const span = Number(radArg) * 16 - 24
  const list = pairs(world, center, span, Number(nArg), Number(seedArg), dim === 'the_nether' ? { top: 118, bottom: 20 } : {})
  console.log(JSON.stringify({ dim, center, loaded, pairs: list.length, loadMs: Math.round(performance.now() - t0) }))
  const modes = (process.env.BENCH_ONLY ? [process.env.BENCH_ONLY] : (process.env.BENCH_MODES || '0,1').split(','))
  const repeat = Number(process.env.BENCH_REPEAT || 2)
  const res: any = {}
  for (let k = 0; k < repeat; k++) for (const m of modes) {
    const r = runAll(world, list, { dim, cap: Number(capArg), mode: m })
    if (!res[m] || r.ms < res[m].ms) res[m] = r
    console.log(JSON.stringify({ mode: m, round: k, ms: Math.round(r.ms), nodes: r.nodes, nodesPerMs: +(r.nodes / r.ms).toFixed(2), cache: r.cache }))
  }
  if (res['0'] && res['1']) {
    let diff = 0
    for (let i = 0; i < list.length; i++) {
      const a = JSON.stringify(res['0'].sigs[i]); const b = JSON.stringify(res['1'].sigs[i])
      if (a !== b) { diff++; if (diff <= 3) console.log('DIFF', i, list[i].kind, '\n A', a.slice(0, 400), '\n B', b.slice(0, 400)) }
    }
    const st: any = {}
    for (const s of res['0'].sigs) st[s.status] = (st[s.status] || 0) + 1
    console.log(JSON.stringify({ equal: diff === 0, diff, statuses: st, speedup: +(res['0'].ms / res['1'].ms).toFixed(2) }))
  }
}
