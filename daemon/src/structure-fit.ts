'use strict'
import { REPO_ROOT } from './paths'
// Шаблоны построек — знание игры, как у спидраннера (пользователь 14.10: «спидраннеры просто знают устройство всех структур
// и откапывают все сундуки»). Это не карта сида и не рентген: бот видит часть постройки (блоки по лучу из глаз), подбирает
// шаблон jar 1.21.11 (tools/structure-templates.js → data/structure-templates.json), поворот, отражение и сдвиг — и знает,
// где в ней сундуки. Клетки за стеной не читаются: узнавание — по видимому (и по запомненному виденному), сверка — лучом.
//
// Узнавание — голосование (как bastion-pieces.voteBy): видимый блок класса c × клетка шаблона того же класса × поворот
// (× зеркало) → голос за сдвиг. Лучшие гипотезы сверяются глазами: клетка шаблона, до которой доходит луч, — тот же класс
// (совпало), иной блок, или пусто/вода там, где в шаблоне блок (луч прошёл клетку насквозь), или блок там, где шаблон ставит
// воздух, — промах. Класс — форма без породы дерева и мха: палитры корабля меняют дерево, процессоры — мох и трещины
// (деревни, руины), руины портала — обсидиан → плачущий (7 %), золото → воздух (30 %) (RuinedPortalPiece.makeSettings).
//
// Перенос шаблона в мир — StructureTemplate.transform: сперва зеркало (FRONT_BACK: x → -x), потом поворот вокруг вертикали;
// точка поворота (pivot) — постоянный сдвиг, он входит в t. Корабль, иглу, подводные руины, дома деревни (jigsaw) — без
// зеркала; руины портала и слепки храмов (StructurePiece.setOrientation: SOUTH и WEST — с отражением) — все 8.
import * as fs from 'fs'
import path = require('path')
import 'vec3'
import { Vec3 } from 'vec3'

const CH = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-/:;<=>?@[]^_`{|}~'

// Класс блока для сверки; '' — не учитывать (рельеф, растения, мелочь, вода). '.' — воздух шаблона.
const RULES: Array<[RegExp, string]> = [
  [/^(chest|trapped_chest|barrel)$/, 'C'],
  [/_trapdoor$/, 'T'],
  [/_door$/, 'D'],
  [/_fence_gate$|_fence$/, 'F'],
  [/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_stairs$/, 'S'],
  [/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_slab$/, '_'],
  [/_stairs$/, 's'],
  [/_slab$/, '-'],
  [/_wall$/, 'W'],
  [/_planks$|^bamboo_mosaic$/, 'P'],
  [/_log$|_wood$|_stem$|_hyphae$|^bamboo_block$/, 'L'],
  [/^(infested_)?(mossy_)?cobblestone$/, 'c'],
  [/^(infested_)?(mossy_|cracked_|chiseled_)?stone_bricks$/, 'b'],
  [/^(red_)?sandstone$/, 'n'],
  [/^(cut_|chiseled_|smooth_)(red_)?sandstone$/, 'm'],
  [/^blue_terracotta$/, 'U'],
  [/terracotta$/, 'o'],
  [/^(crying_)?obsidian$/, 'O'],
  [/^(netherrack|magma_block)$/, 'N'],
  [/^gold_block$/, 'G'],
  [/glass(_pane)?$/, 'g'],
  [/_wool$/, 'w'],
  [/_carpet$/, 'k'],
  [/_bed$/, 'B'],
  [/^(crafting_table|furnace|smoker|blast_furnace|lectern|composter|smithing_table|fletching_table|cartography_table|grindstone|stonecutter|loom|brewing_stand|cauldron|water_cauldron|anvil|bell|bookshelf|jukebox)$/, 'J'],
  [/^hay_block$/, 'h'],
  [/^snow_block$/, 'X'],
  [/^(ice|packed_ice|blue_ice)$/, 'I'],
  [/^ladder$/, 'H'],
  [/^iron_bars$/, 'r'],
  [/^(tripwire_hook|tripwire|lever|redstone_wire|repeater|dispenser|sticky_piston|stone_pressure_plate|tnt)$/, 'M'],
  [/^(smooth_stone|polished_andesite|polished_diorite|polished_granite|stone_brick_wall)$/, 'x']
]
const clsCache = new Map<string, string>()
function cls (name: string): string {
  if (!name) return ''
  let v = clsCache.get(name)
  if (v !== undefined) return v
  v = name === 'air' || name === 'cave_air' || name === 'void_air' ? '.' : ''
  if (!v) for (const [re, c] of RULES) if (re.test(name)) { v = c; break }
  clsCache.set(name, v)
  return v
}
// Классы, которые в мире растут и сами (камень, песчаник пустыни, бревна леса) — голосовать ими нельзя, сверять можно.
const COMMON = new Set(['L', 'n', 'x', 'o', 'N', 'I'])

// ---------------------------------------------------------------- библиотека

let LIB = null
const PREP = new Map()
function lib () {
  if (!LIB) {
    const f = path.join(REPO_ROOT, 'daemon/data/structure-templates.json')
    LIB = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).templates : {}
  }
  return LIB
}
function names (kind: string, biome: string | null = null) {
  return Object.entries(lib()).filter(([, t]: any) => t.kind === kind && (!biome || !t.biome || t.biome === biome)).map(([n]) => n)
}
// Шаблон для сверки: класс на клетку, поверхность (клетки с открытой гранью) по классам, воздух.
function prep (name: string) {
  let P = PREP.get(name)
  if (P) return P
  const T = lib()[name]
  if (!T) return null
  const [X, Y, Z] = T.size
  const c = new Array(X * Y * Z)
  for (let i = 0; i < c.length; i++) { const ch = T.grid[i]; c[i] = ch === ' ' ? ' ' : cls(T.pal[CH.indexOf(ch)]) }
  const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= X || y >= Y || z >= Z) ? ' ' : c[x + X * (z + Z * y)]
  const surface = []
  const byClass = new Map<string, number[][]>()
  const air = []
  for (let y = 0; y < Y; y++) {
    for (let z = 0; z < Z; z++) {
      for (let x = 0; x < X; x++) {
        const k = at(x, y, z)
        if (k === '.') { if (T.air) air.push([x, y, z]); continue }
        if (k === ' ' || k === '') continue
        let open = false
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const n = at(x + dx, y + dy, z + dz)
          if (n === ' ' || n === '.' || n === '' || n === 'g' || n === 'r' || n === 'F' || n === 'H' || n === 'M') { open = true; break }
        }
        if (!open) continue
        surface.push([x, y, z, k])
        if (!byClass.has(k)) byClass.set(k, [])
        byClass.get(k).push([x, y, z])
      }
    }
  }
  P = { name, kind: T.kind, size: T.size, at, surface, byClass, air, chests: T.chests || [], w: T.w || {}, mirror: !!T.mirror, T }
  PREP.set(name, P)
  return P
}

// ---------------------------------------------------------------- перенос

function rotXZ (r: number, x: number, z: number) {
  switch (r & 3) {
    case 0: return [x, z]
    case 1: return [-z, x]
    case 2: return [-x, -z]
    default: return [z, -x]
  }
}
// h = { r, m, t } → мир.
function toWorld (h, x: number, y: number, z: number) {
  const [rx, rz] = rotXZ(h.r, h.m ? -x : x, z)
  return { x: rx + h.t.x, y: y + h.t.y, z: rz + h.t.z }
}
function toLocal (h, wx: number, wy: number, wz: number) {
  const [ux, uz] = rotXZ((4 - h.r) & 3, wx - h.t.x, wz - h.t.z)
  return [h.m ? -ux : ux, wy - h.t.y, uz]
}

// ---------------------------------------------------------------- глаза

// Под водой дальше ~20 блоков не видно (туман воды); над водой — до 48.
const SEE_R = 48
const SEE_R_WET = 20
function eyeOf (bot) { const p = bot.entity.position; return { x: p.x, y: p.y + (bot.entity.eyeHeight || 1.62), z: p.z } }
function visionKit (bot) {
  const eyes: typeof import('./perception/eyes') = require('./perception/eyes')
  const read = eyes.reader(bot)
  const shapes = (bot._ndEyes && bot._ndEyes.shapes) || eyes.shapeCache(bot.registry)
  const o = eyeOf(bot)
  const wetEye = shapes.name(read.at(Math.floor(o.x), Math.floor(o.y), Math.floor(o.z))) === 'water'
  return { eyes, read, shapes, o, wetEye }
}
// Дойдёт ли луч до клетки (видна — блок или пустота в ней).
function reach (kit, c) {
  const dx = c.x + 0.5 - kit.o.x; const dy = c.y + 0.5 - kit.o.y; const dz = c.z + 0.5 - kit.o.z
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (d > (kit.wetEye ? SEE_R_WET : SEE_R)) return false
  return kit.eyes.seesCell(kit.read, kit.shapes, kit.o, c)
}

// Память виденного для узнавания: клетка → класс (то, что глаза видели раньше, с других мест; не рентген).
function memoOf (bot) {
  if (!bot._ndStructSeen || bot._ndStructSeenWorld !== bot.world || bot._ndStructSeenDim !== bot.game.dimension) {
    bot._ndStructSeen = new Map()
    bot._ndStructSeenWorld = bot.world
    bot._ndStructSeenDim = bot.game.dimension
  }
  return bot._ndStructSeen
}
// Видимые блоки классов постройки около center (в радиусе R): [{x,y,z,c}] — сейчас видимые плюс виденные раньше.
const STATES = new WeakMap()
function stateClasses (registry) {
  let m = STATES.get(registry)
  if (!m) {
    m = new Map<number, string>()
    for (const b of registry.blocksArray) {
      const k = cls(b.name)
      if (!k || k === '.') continue
      for (let s = b.minStateId; s <= b.maxStateId; s++) m.set(s, k)
    }
    STATES.set(registry, m)
  }
  return m
}
function observe (bot, center, { radius = 32, max = 900, classes = null }: any = {}) {
  const kit = visionKit(bot)
  const all = stateClasses(bot.registry)
  const pick = s => { const k = all.get(s); return k && (!classes || classes.has(k)) ? k : undefined }
  const memo = memoOf(bot)
  const cx = Math.floor(center.x); const cz = Math.floor(center.z)
  const cy = Number.isFinite(center.y) ? Math.floor(center.y) : Math.floor(bot.entity.position.y)
  const minY = bot.game.minY
  const cand = []
  const r2 = radius * radius
  const out = new Map<string, any>()
  let rays = 0
  for (const [key, last] of memo) {
    if ((last.x - cx) ** 2 + (last.y - cy) ** 2 + (last.z - cz) ** 2 > r2) continue
    let q = last
    if (rays < max) {
      rays++
      if (reach(kit, q)) {
        const s = kit.read.at(q.x, q.y, q.z)
        const c = cls(kit.shapes.name(s))
        if (!c || c === '.') { memo.delete(key); continue }
        q = { ...last, c, opaque: kit.shapes.opaque(s) }
        memo.set(key, q)
      }
    }
    if (!classes || classes.has(q.c)) out.set(key, q)
  }
  for (let ccx = (cx - radius) >> 4; ccx <= (cx + radius) >> 4; ccx++) {
    for (let ccz = (cz - radius) >> 4; ccz <= (cz + radius) >> 4; ccz++) {
      const col = kit.read.column(ccx, ccz)
      if (!col) continue
      for (let sy = Math.max(0, (cy - radius - minY) >> 4); sy <= Math.min(((bot.game.height) >> 4) - 1, (cy + radius - minY) >> 4); sy++) {
        const data = col.sections && col.sections[sy] && col.sections[sy].data
        if (!data) continue
        if (data.palette && !data.palette.some(s => pick(s))) continue
        if (!data.palette && data.value !== undefined && !pick(data.value)) continue
        const y0 = minY + sy * 16
        for (let i = 0; i < 4096; i++) {
          const s = data.get ? data.get(i) : col.getBlockStateId({ x: i & 15, y: y0 + (i >> 8), z: (i >> 4) & 15 })
          const k = pick(s)
          if (!k) continue
          const x = ccx * 16 + (i & 15); const y = y0 + (i >> 8); const z = ccz * 16 + ((i >> 4) & 15)
          const ddx = x - cx; const ddy = y - cy; const ddz = z - cz
          if (ddx * ddx + ddy * ddy + ddz * ddz > r2) continue
          cand.push({ x, y, z, c: k, d: (x + 0.5 - kit.o.x) ** 2 + (y + 0.5 - kit.o.y) ** 2 + (z + 0.5 - kit.o.z) ** 2 })
        }
      }
    }
  }
  cand.sort((a, b) => a.d - b.d)
  let tries = 0
  for (const q of cand) {
    if (rays >= max || ++tries > 4000) break
    const key = `${q.x},${q.y},${q.z}`
    if (out.has(key)) continue
    if (!reach(kit, q)) continue
    // Лимит наблюдений не зависит от количества невидимых кандидатов (потолок лучей — 4000, по времени).
    rays++
    out.set(key, q)
    memo.set(key, { x: q.x, y: q.y, z: q.z, c: q.c, opaque: kit.shapes.opaque(kit.read.at(q.x, q.y, q.z)) })
  }
  if (memo.size > 60000) memo.clear()
  return [...out.values()]
}

// ---------------------------------------------------------------- узнавание

const SHIFT = 1024
function keyOf (ti, r, m, tx, ty, tz) {
  if (tx < -512 || tx >= 512 || ty < -512 || ty >= 512 || tz < -512 || tz >= 512) throw new RangeError('structure shift outside packed range')
  return (((ti * 8 + r * 2 + m) * SHIFT + tx + 512) * SHIFT + ty + 512) * SHIFT + tz + 512
}
function unkey (k) {
  const tz = k % SHIFT - 512; k = Math.floor(k / SHIFT)
  const ty = k % SHIFT - 512; k = Math.floor(k / SHIFT)
  const tx = k % SHIFT - 512; k = Math.floor(k / SHIFT)
  const rm = k % 8
  return { ti: Math.floor(k / 8), r: rm >> 1, m: rm & 1, t: { x: tx, y: ty, z: tz } }
}

// Сверка гипотезы глазами: { match, miss, checked }.
function verify (bot, P, h, { maxChecks = 360, kit = null }: any = {}) {
  kit = kit || visionKit(bot)
  const cells = []
  for (const [x, y, z, k] of P.surface) {
    const w = toWorld(h, x, y, z)
    const d = (w.x + 0.5 - kit.o.x) ** 2 + (w.y + 0.5 - kit.o.y) ** 2 + (w.z + 0.5 - kit.o.z) ** 2
    if (d <= SEE_R * SEE_R) cells.push({ w, k, d })
  }
  for (const [x, y, z] of P.air) {
    const w = toWorld(h, x, y, z)
    const d = (w.x + 0.5 - kit.o.x) ** 2 + (w.y + 0.5 - kit.o.y) ** 2 + (w.z + 0.5 - kit.o.z) ** 2
    if (d <= 24 * 24) cells.push({ w, k: '.', d })
  }
  cells.sort((a, b) => a.d - b.d)
  const memo = memoOf(bot)
  let match = 0; let miss = 0; let checked = 0
  for (const { w, k } of cells) {
    if (checked >= maxChecks) break
    const key = `${w.x},${w.y},${w.z}`
    let wc; let opaque
    if (reach(kit, w)) {
      const s = kit.read.at(w.x, w.y, w.z)
      if (s < 0) continue
      wc = cls(kit.shapes.name(s))
      opaque = kit.shapes.opaque(s)
      if (wc && wc !== '.') memo.set(key, { ...w, c: wc, opaque })
      else memo.delete(key)
    } else {
      const last = memo.get(key)
      if (!last) continue
      wc = last.c
      opaque = last.opaque
    }
    checked++
    if (k === '.') { if (opaque) miss++; continue }
    if (wc === k) match++
    else if (wc === '' && opaque) continue
    else miss++
  }
  return { match, miss, checked }
}

// Лучшие гипотезы вида kind по видимым блокам около center. opts: radius, biome (деревня), top, minMatch, exclude (клетки,
// уже объяснённые другим домом), env ('ocean' | 'beached' — вес вариантов корабля).
function fit (bot, kind: string, center, opts: any = {}) {
  const { radius = 32, biome = null, top = 10, minMatch = 10, maxMissRatio = 0.3, env = null, debug = null, observed = null } = opts
  const list = names(kind, biome)
  if (!list.length) return null
  const preps = list.map(prep).filter(Boolean)
  const classes = new Set<string>()
  for (const P of preps) for (const k of P.byClass.keys()) classes.add(k)
  const seen = observed || observe(bot, center, { radius, classes })
  const voters = seen.filter(q => !COMMON.has(q.c) && !(opts.exclude && opts.exclude.has(`${q.x},${q.y},${q.z}`)))
  if (voters.length < 4) return { kind, seen: seen.length, voters: voters.length, best: null, hyps: [] }
  // Не больше 120 голосующих: редкие классы первыми (люк, дверь, сундук, забор — по ним поворот надёжнее досок).
  const freq = new Map<string, number>()
  for (const q of voters) freq.set(q.c, (freq.get(q.c) || 0) + 1)
  const per = new Map<string, number>()
  const vs = voters.slice().sort((a, b) => freq.get(a.c) - freq.get(b.c)).filter(q => { const n = (per.get(q.c) || 0) + 1; per.set(q.c, n); return n <= 50 }).slice(0, 120)
  // Сдвиг — от центра поиска (ключ голоса держит ±512 по осям).
  const O = { x: Math.floor(center.x), y: Math.floor(Number.isFinite(center.y) ? center.y : bot.entity.position.y), z: Math.floor(center.z) }
  const votes = new Map<number, number>()
  preps.forEach((P, ti) => {
    for (let m = 0; m <= (P.mirror ? 1 : 0); m++) {
      for (let r = 0; r < 4; r++) {
        for (const q of vs) {
          const cells = P.byClass.get(q.c)
          if (!cells) continue
          for (const [x, y, z] of cells) {
            const [rx, rz] = rotXZ(r, m ? -x : x, z)
            const k = keyOf(ti, r, m, q.x - rx - O.x, q.y - y - O.y, q.z - rz - O.z)
            votes.set(k, (votes.get(k) || 0) + 1)
          }
        }
      }
    }
  })
  const best: Array<[number, number]> = []
  for (const e of votes) {
    if (best.length < top || e[1] > best[best.length - 1][1]) {
      let at = best.length
      while (at > 0 && best[at - 1][1] < e[1]) at--
      best.splice(at, 0, e)
      if (best.length > top) best.pop()
    }
  }
  const kit = visionKit(bot)
  const hyps = []
  for (const [k, n] of best) {
    if (n < 4) continue
    const u = unkey(k)
    const P = preps[u.ti]
    const h = { name: P.name, r: u.r, m: u.m, t: { x: u.t.x + O.x, y: u.t.y + O.y, z: u.t.z + O.z }, votes: n }
    const v = verify(bot, P, h, { kit })
    const prior = env && P.w[env] !== undefined ? P.w[env] : (P.w.ocean !== undefined ? Math.max(P.w.ocean, P.w.beached || 0) : (P.w.slot ?? P.w.any ?? 1))
    const score = v.match - 2 * v.miss
    if (debug) debug.push({ name: P.name, r: u.r, m: u.m, t: u.t, votes: n, ...v })
    if (v.match >= minMatch && v.miss <= maxMissRatio * v.match && prior > 0) hyps.push({ ...h, ...v, score, prior })
  }
  hyps.sort((a, b) => b.score - a.score)
  return { kind, seen: seen.length, voters: voters.length, best: hyps[0] || null, hyps }
}

// Сундуки гипотез с долями: гипотезы в пределах 6 очков от лучшей — вместе, доля — по весу варианта × e^(score/3).
// [{ x, y, z, table, p, from }]
function chestsOf (r) {
  if (!r || !r.best) return []
  const near = r.hyps.filter(h => h.score >= r.best.score - 6)
  const wsum = near.reduce((s, h) => s + h.prior * Math.exp((h.score - r.best.score) / 3), 0)
  const out = new Map<string, any>()
  // hyps — номера гипотез клетки: сундук нашёлся — клетки других гипотез не копать; пусто — гипотезы этой клетки вон.
  near.forEach((h, hi) => {
    const w = h.prior * Math.exp((h.score - r.best.score) / 3) / wsum
    for (const [x, y, z, table] of prep(h.name).chests) {
      const p = toWorld(h, x, y, z)
      const k = `${p.x},${p.y},${p.z}`
      const cur = out.get(k)
      if (cur) { cur.p += w; cur.hyps.push(hi) } else out.set(k, { ...p, table, p: w, from: h.name, hyps: [hi] })
    }
  })
  return [...out.values()].map(c => ({ ...c, p: Math.min(1, Math.round(c.p * 100) / 100) })).sort((a, b) => b.p - a.p)
}

// Дома деревни: жадно, дом за домом — лучший, его клетки из голосования вон, снова (до maxHouses).
function fitHouses (bot, center, { radius = 48, biome = null, maxHouses = 8, debug = null }: any = {}) {
  const list = names('village', biome)
  const classes = new Set<string>()
  for (const n of list) for (const k of prep(n).byClass.keys()) classes.add(k)
  const seen = observe(bot, center, { radius, classes, max: 1600 })
  const exclude = new Set<string>()
  const houses = []
  for (let i = 0; i < maxHouses; i++) {
    const r = fit(bot, 'village', center, { radius, biome, observed: seen, exclude, minMatch: 12, debug })
    if (!r || !r.best) break
    const P = prep(r.best.name)
    houses.push({ ...r.best, chests: chestsOf({ best: r.best, hyps: [r.best] }) })
    const [X, Y, Z] = P.size
    for (const q of seen) {
      const [x, y, z] = toLocal(r.best, q.x, q.y, q.z)
      if (x >= -1 && y >= -1 && z >= -1 && x <= X && y <= Y && z <= Z) exclude.add(`${q.x},${q.y},${q.z}`)
    }
  }
  return houses
}

// Тип деревни — по биому на экране F3 у деревни (village_plains: plains, meadow; _desert; _savanna; _snowy; _taiga —
// tags/worldgen/biome/has_structure/village_*.json). Неизвестный биом — все пять.
function villageBiome (bot, center) {
  let b = null
  try { b = (require('./perception') as typeof import('./perception')).biomeName(bot, bot.entity.position.floored()) } catch {}
  if (!b) return null
  return /desert/.test(b) ? 'desert' : /savanna/.test(b) ? 'savanna' : /snowy/.test(b) ? 'snowy' : /taiga/.test(b) ? 'taiga' : /plains|meadow|sunflower/.test(b) ? 'plains' : null
}

// Иглу: верх узнан → где ствол подвала (под люком верха) и сундук лаборатории — по x,z (глубина 4..11 кусков по 3 —
// узнаётся спуском). IglooPieces: OFFSETS и PIVOTS кусков, поворот общий, сдвиги кусков без поворота (makePosition).
function iglooBasement (h) {
  const T = lib()
  const top = T['igloo/top']; const bottom = T['igloo/bottom']
  if (!top || !bottom) return null
  const c = (piv, r) => r === 0 ? [0, 0] : r === 1 ? [piv[0] + piv[2], piv[2] - piv[0]] : r === 2 ? [2 * piv[0], 2 * piv[2]] : [piv[0] - piv[2], piv[0] + piv[2]]
  const [ctx, ctz] = c(top.pivot, h.r)
  const start = { x: h.t.x - ctx, y: h.t.y, z: h.t.z - ctz }
  const [cbx, cbz] = c(bottom.pivot, h.r)
  const hatch = toWorld(h, 3, 0, 5)
  const [lx, ly, lz, table] = bottom.chests[0]
  const [rx, rz] = rotXZ(h.r, lx, lz)
  return {
    hatch,
    carpet: toWorld(h, 3, 1, 5),
    chest: { x: start.x + bottom.offset[0] + rx + cbx, z: start.z + bottom.offset[2] + rz + cbz, yTop: start.y + bottom.offset[1] - 12 + ly, yBottom: start.y + bottom.offset[1] - 33 + ly, table }
  }
}

export { lib, names, prep, cls, toWorld, toLocal, rotXZ, observe, verify, fit, chestsOf, fitHouses, villageBiome, iglooBasement, COMMON }
