'use strict'
const gameClock = require('./game-clock')
// Закрытый штрек: путь к цели сквозь твёрдое, при котором ни одна наша клетка
// не касается гранью чужого воздуха, лавы или огня. Так бастион копают без
// брутов, злых пиглинов и лавы: злые не дойдут (пути нет), арбалетчик не видит
// (луча нет), лава не течёт (её соседей не вскрываем). Вход из открытого мира —
// первый ход в толщу, клетки за спиной сразу засыпаются (sealBehind).
//
// Планировщик — чистая функция над cls(x,y,z) (класс клетки) и dig(x,y,z)
// (секунды копки): его гоняют на срезе мира без игры (scratch sealed-test.js).
//
// Модель тела: ноги f и голова f+1. Ходы (d — одна из 4 сторон):
//   flat  f → f+d        копать f+d+1, f+d          пол f+d−1
//   up    f → f+d+1      копать f+2, f+d+2, f+d+1   пол f+d (ступень)
//   down  f → f+d−1      копать f+d+1, f+d, f+d−1   пол f+d−2
//   vdown f → f−1        копать f−1                 пол f−2
//   vup   f → f+1        копать f+2, прыжок и блок под себя (столб)
// Копать клетку c можно, если каждый её сосед по грани — твёрдый, или наш
// (штрек, клетки хода, клетки прошлого хода), а не воздух/лава/огонь/неполный
// блок (плита, забор, цепь — через них бьют и видят). Над c — не гравий.

const { Vec3 } = require('vec3')

const AIR = 0; const SOLID = 1; const FLUID = 2; const HARD = 3; const GUARD = 4; const FALL = 5; const PARTIAL = 6; const HOT = 7; const UNKNOWN = 8
const CLS_NAMES = ['air', 'solid', 'fluid', 'hard', 'guard', 'fall', 'partial', 'hot', 'unknown']
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

const GUARDED = /^(gold_block|gilded_blackstone|chest|trapped_chest|barrel|ender_chest|raw_gold_block|gold_ore|deepslate_gold_ore|nether_gold_ore|[a-z_]*shulker_box|[a-z_]*copper_chest[a-z_]*)$/
const FLUIDS = /^(lava|water|bubble_column|fire|soul_fire|campfire|soul_campfire|powder_snow|sweet_berry_bush|cactus|wither_rose|pointed_dripstone|nether_portal|end_portal|end_gateway)$/
const HARDS = /^(bedrock|obsidian|crying_obsidian|ancient_debris|respawn_anchor|barrier|spawner|trial_spawner|vault|cobweb|end_portal_frame|reinforced_deepslate|lodestone|enchanting_table|ender_chest|beacon|conduit|structure_block|jigsaw|command_block)$/
const FALLS = /^(gravel|sand|red_sand|suspicious_sand|suspicious_gravel|[a-z_]*concrete_powder|anvil|chipped_anvil|damaged_anvil|dragon_egg|scaffolding)$/

const key = (x, y, z) => `${x},${y},${z}`
const keyV = v => `${v.x},${v.y},${v.z}`

// Класс по блоку mineflayer (prismarine-block): форма коллизии решает «неполный».
function classOf (b) {
  if (!b) return UNKNOWN
  const n = b.name
  if (FLUIDS.test(n) || /lava|water/.test(n)) return FLUID
  if (b.boundingBox === 'empty') return AIR
  if (GUARDED.test(n)) return GUARD
  if (HARDS.test(n)) return HARD
  if (FALLS.test(n)) return FALL
  if (n === 'magma_block') return HOT
  const sh = b.shapes
  if (Array.isArray(sh) && sh.length) {
    let x0 = 1; let z0 = 1; let x1 = 0; let z1 = 0; let y1 = 0
    for (const s of sh) { x0 = Math.min(x0, s[0]); z0 = Math.min(z0, s[2]); x1 = Math.max(x1, s[3]); y1 = Math.max(y1, s[4]); z1 = Math.max(z1, s[5]) }
    // Плита, ковёр, слой снега — низко; забор, стена, цепь, решётка, фонарь — не на всю клетку.
    if (y1 < 0.75 || x0 > 0.01 || z0 > 0.01 || x1 < 0.99 || z1 < 0.99) return PARTIAL
  }
  return SOLID
}

// Секунды копки лучшей киркой рюкзака (грубо: игра — hardness × 1.5 / скорость;
// не кирочное — рукой или лопатой, дольше).
const PICK_SPEED = { wooden_pickaxe: 2, golden_pickaxe: 12, stone_pickaxe: 4, iron_pickaxe: 6, diamond_pickaxe: 8, netherite_pickaxe: 9 }
function digSecondsOf (b, pickSpeed = 4) {
  if (!b) return 99
  const h = b.hardness ?? 1.5
  if (h < 0) return 99
  if (h === 0) return 0.05
  const pick = /mineable\/pickaxe/.test(b.material || '') || /blackstone|basalt|netherrack|brick|quartz|ore|magma|obsidian|stone/.test(b.name)
  return pick ? Math.max(0.05, h * 1.5 / pickSpeed) : Math.max(0.1, h * 1.5 / 1.5)
}

// Классификатор живого мира с кешем по клетке (одно планирование — один кеш).
function worldView (bot) {
  const cache = new Map()
  const bestPick = () => {
    let s = 1
    for (const it of bot.inventory.items()) if (PICK_SPEED[it.name] && PICK_SPEED[it.name] > s) s = PICK_SPEED[it.name]
    return s
  }
  const speed = bestPick()
  const get = (x, y, z) => {
    const k = key(x, y, z)
    let v = cache.get(k)
    if (v) return v
    const b = bot.blockAt(new Vec3(x, y, z), false)
    v = { c: classOf(b), s: b ? digSecondsOf(b, speed) : 99, name: b ? b.name : '?' }
    cache.set(k, v)
    return v
  }
  return {
    cls: (x, y, z) => get(x, y, z).c,
    dig: (x, y, z) => get(x, y, z).s,
    name: (x, y, z) => get(x, y, z).name,
    forget: () => cache.clear()
  }
}

// ------------------------------------------------------------------ планировщик
//
// o.cls, o.dig — мир; o.own — Set ключей наших клеток (штрек); o.starts —
// [{x,y,z,g}] откуда (своя клетка или клетки «куда дойду ногами»); o.goal(x,y,z)
// — стоя здесь, цель взята; o.h(x,y,z) — оценка до цели; o.breachOk(k) —
// клетку k можно вскрыть к чужому воздуху (яма бартера: голова под ртом ямы);
// o.dig ok — o.targets: Set ключей охраняемых клеток, которые копать можно;
// o.box — {x0,x1,y0,y1,z0,z1}; o.maxNodes; o.vup — столбом вверх можно.
function moveList (f, allowVup) {
  const out = []
  const { x, y, z } = f
  for (const [dx, dz] of DIRS) {
    out.push({ kind: 'flat', to: { x: x + dx, y, z: z + dz }, clear: [[x + dx, y + 1, z + dz], [x + dx, y, z + dz]], floor: [x + dx, y - 1, z + dz], cost: 1 })
    out.push({ kind: 'up', to: { x: x + dx, y: y + 1, z: z + dz }, clear: [[x, y + 2, z], [x + dx, y + 2, z + dz], [x + dx, y + 1, z + dz]], floor: [x + dx, y, z + dz], cost: 1.3 })
    out.push({ kind: 'down', to: { x: x + dx, y: y - 1, z: z + dz }, clear: [[x + dx, y + 1, z + dz], [x + dx, y, z + dz], [x + dx, y - 1, z + dz]], floor: [x + dx, y - 2, z + dz], cost: 1.2 })
  }
  out.push({ kind: 'vdown', to: { x, y: y - 1, z }, clear: [[x, y - 1, z]], floor: [x, y - 2, z], cost: 1.2 })
  if (allowVup) out.push({ kind: 'vup', to: { x, y: y + 1, z }, clear: [[x, y + 2, z]], floor: null, cost: 3 })
  return out
}

class Heap {
  declare a: any

  constructor () { this.a = [] }
  push (n) { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p } }
  pop () {
    const a = this.a; const top = a[0]; const last = a.pop()
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m } }
    return top
  }

  get size () { return this.a.length }
}

async function plan (o) {
  const { cls, dig, own = new Set(), starts, goal, h, box, maxNodes = 60000, targets = new Set(), breachOk = () => false, digW = 4, openOk = new Set(), breachCost = 0 } = o
  const inBox = (x, y, z) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1
  const open = new Heap()
  const best = new Map()
  let nodes = 0
  const why = { fluid: 0, foreign: 0, hard: 0, floor: 0, box: 0, gravel: 0 }
  for (const s of starts) {
    const k = key(s.x, s.y, s.z)
    const n = { x: s.x, y: s.y, z: s.z, g: s.g || 0, f: (s.g || 0) + h(s.x, s.y, s.z), parent: null, move: null, clear: [], k, start: true }
    if (best.has(k) && best.get(k) <= n.g) continue
    best.set(k, n.g)
    open.push(n)
  }
  while (open.size && nodes < maxNodes) {
    const cur = open.pop()
    if (best.get(cur.k) < cur.g) continue
    nodes++
    if (nodes % 3000 === 0) await new Promise<any>(r => setImmediate(r))
    if (goal(cur.x, cur.y, cur.z, cur)) {
      const path = []
      for (let n = cur; n && n.move; n = n.parent) path.push({ kind: n.move.kind, to: { x: n.x, y: n.y, z: n.z }, clear: n.move.clear.map(c => ({ x: c[0], y: c[1], z: c[2] })), floor: n.move.floor ? { x: n.move.floor[0], y: n.move.floor[1], z: n.move.floor[2] } : null })
      path.reverse()
      let s = cur; while (s.parent) s = s.parent
      return { ok: true, path, cost: cur.g, nodes, start: { x: s.x, y: s.y, z: s.z }, why }
    }
    const mine = new Set([key(cur.x, cur.y, cur.z), key(cur.x, cur.y + 1, cur.z), ...cur.clear])
    for (const mv of moveList(cur, !!o.vup)) {
      const t = mv.to
      if (!inBox(t.x, t.y, t.z)) { why.box++; continue }
      const tk = key(t.x, t.y, t.z)
      const clearK = mv.clear.map(c => key(c[0], c[1], c[2]))
      const ours = k => own.has(k) || mine.has(k) || clearK.includes(k)
      let cost = mv.cost
      let bad = false
      for (let i = 0; i < mv.clear.length && !bad; i++) {
        const [cx, cy, cz] = mv.clear[i]
        const ck = clearK[i]
        const c = cls(cx, cy, cz)
        if (c === AIR) {
          if (!own.has(ck) && !mine.has(ck) && !openOk.has(ck)) { bad = true; why.foreign++ }
          continue
        }
        if (c === FLUID || c === HARD || c === UNKNOWN) { bad = true; why.hard++; continue }
        if (c === GUARD && !targets.has(ck)) { bad = true; why.hard++; continue }
        if (own.has(ck)) continue
        // Копаем c: соседи по грани.
        for (const [fx, fy, fz] of FACES) {
          const nx = cx + fx; const ny = cy + fy; const nz = cz + fz
          const nk = key(nx, ny, nz)
          const nc = cls(nx, ny, nz)
          // Своя клетка могла залиться лавой — «своя» не прячет жидкость (ревью Codex 30.09).
          if (nc === FLUID) { bad = true; why.fluid++; break }
          if (ours(nk)) continue
          if (nc === UNKNOWN) { bad = true; why.fluid++; break }
          if ((nc === AIR || nc === PARTIAL) && !breachOk(ck, nk)) { bad = true; why.foreign++; break }
          // Вскрытие разрешено, но дорого (штрек по Аду: меньше пробоев — меньше встреч с хоглинами).
          if (nc === AIR || nc === PARTIAL) cost += breachCost
          if (nc === FALL && fy === 1) { bad = true; why.gravel++; break }
        }
        if (bad) break
        cost += digW * dig(cx, cy, cz)
      }
      if (bad) continue
      if (mv.floor) {
        const [fx, fy, fz] = mv.floor
        const fc = cls(fx, fy, fz)
        // Гравий/песок — не пол: после копки соседа FallingBlock падает через 2 тика (ревью Codex 30.09).
        if (!(fc === SOLID || fc === HARD || fc === GUARD) || ours(key(fx, fy, fz))) { why.floor++; continue }
      }
      const g = cur.g + cost
      if (best.has(tk) && best.get(tk) <= g) continue
      best.set(tk, g)
      open.push({ x: t.x, y: t.y, z: t.z, g, f: g + h(t.x, t.y, t.z), parent: cur, move: mv, clear: clearK, k: tk })
    }
  }
  return { ok: false, nodes, why }
}

// Стоя в f, цель t взята: t касается гранью клетки ног или головы, или над головой,
// или под ногами (если под t твёрдое — тело упадёт на клетку ниже).
function adjacentGoal (t, cls) {
  return (x, y, z) => {
    const d = Math.abs(x - t.x) + Math.abs(z - t.z)
    if (d === 1 && (t.y === y || t.y === y + 1)) return true
    if (d === 0 && t.y === y + 2) return true
    if (d === 0 && t.y === y - 1) { const c = cls(t.x, t.y - 1, t.z); return c === SOLID || c === HARD || c === GUARD }
    return false
  }
}
const manhattan = t => (x, y, z) => Math.max(0, Math.abs(x - t.x) + Math.abs(y - t.y) + Math.abs(z - t.z) - 2)

// Куда дойду ногами (старты штрека): шаг в 4 стороны с подъёмом на 1 и спуском
// до 3 (спрыгнуть можно, забраться назад — нет: walkable.js спуск больше 1 не
// берёт, и с кроны гриба над двором «входа нет», ферма 29.09 sealed-3).
function reachCells (view, from, { radius = 24, maxNodes = 4000 }: any = {}) {
  const c = view.cls
  const pass = (x, y, z) => c(x, y, z) === AIR
  const stand = (x, y, z) => { const f = c(x, y - 1, z); return (f === SOLID || f === HARD || f === GUARD) && pass(x, y, z) && pass(x, y + 1, z) }
  const s = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) }
  const seen = new Map([[key(s.x, s.y, s.z), 0]])
  const out = [{ ...s, d: 0 }]
  for (let i = 0; i < out.length && out.length < maxNodes; i++) {
    const p = out[i]
    for (const [dx, dz] of DIRS) {
      const nx = p.x + dx; const nz = p.z + dz
      if ((nx - s.x) ** 2 + (nz - s.z) ** 2 > radius * radius) continue
      const tries = []
      if (pass(p.x, p.y + 2, p.z)) tries.push(p.y + 1)
      tries.push(p.y)
      if (pass(nx, p.y, nz) && pass(nx, p.y + 1, nz)) for (let k = 1; k <= 3; k++) { if (!pass(nx, p.y - k, nz)) break; tries.push(p.y - k) }
      for (const ny of tries) {
        if (ny < p.y && !(pass(nx, p.y, nz) && pass(nx, p.y + 1, nz))) continue
        if (!stand(nx, ny, nz)) continue
        const k = key(nx, ny, nz)
        if (seen.has(k)) continue
        seen.set(k, p.d + 1)
        out.push({ x: nx, y: ny, z: nz, d: p.d + 1 })
      }
    }
  }
  return out
}

// ------------------------------------------------------------------ исполнение
//
// S — состояние штрека на весь вызов: own (Set ключей наших клеток), exposed
// (карман связан с чужим воздухом), счётчики. Путь исполняется ход за ходом,
// каждый ход сперва сверяется с живым миром (лава могла натечь, моб встать);
// не сошлось — отказ, вызывающий перепланирует.
const sleep = ms => new Promise<any>(r => gameClock.setTimeout(r, ms))
const vec = c => new Vec3(c.x, c.y, c.z)
const liveCls = (bot, v) => classOf(bot.blockAt(v, false))
// Клетка ног: на песке душ, грязи, грядке (высота 0.875–0.94) ноги на y−0.125 — floored() дал бы клетку пола
// (слот 26 02.10: «не шагнул up … пол soul_sand»). Как nether.sameCell; только на земле — в прыжке floored() верен.
const feetCell = bot => { const p = bot.entity.position; const f = p.floored(); return (bot.entity.onGround && p.y - f.y >= 0.8) ? f.offset(0, 1, 0) : f }
const bodyCells = bot => { const f = feetCell(bot); return [f, f.offset(0, 1, 0)] }
const FILL = ['netherrack', 'blackstone', 'basalt', 'polished_basalt', 'smooth_basalt', 'polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'polished_blackstone', 'cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'soul_soil', 'end_stone']
function fillerName (bot) {
  const items = bot.inventory.items()
  for (const n of FILL) if (items.some(i => i.name === n)) return n
  return null
}
function fillerCount (bot) { return bot.inventory.items().filter(i => FILL.includes(i.name)).reduce((n, i) => n + i.count, 0) }

// Карман тела: обход по нашим клеткам от клеток тела; пробой — наша клетка
// (или клетка тела), чей сосед по грани — чужой воздух, неполный блок, жидкость.
// Воздух вокруг тела (связный с клетками тела, не дальше r по каждой оси, не больше max клеток): для старта
// из «чужого» кармана — тело стоит в пустотах, которых нет в своих (main 30.09, 104,35,141 у стены бастиона:
// «яма: пути нет, nodes 1, foreign 14» — ни одного хода). Эти клетки можно пройти (openOk) и вскрыть к ним.
function localAir (bot, r = 3, max = 48) {
  const out = new Set()
  const q = []
  const c0 = feetCell(bot)
  for (const v of bodyCells(bot)) { out.add(keyV(v)); q.push(v) }
  for (let i = 0; i < q.length && out.size < max; i++) {
    for (const [dx, dy, dz] of FACES) {
      const n = q[i].offset(dx, dy, dz)
      const nk = keyV(n)
      if (out.has(nk) || Math.abs(n.x - c0.x) > r || Math.abs(n.y - c0.y) > r || Math.abs(n.z - c0.z) > r) continue
      if (liveCls(bot, n) !== AIR) continue
      out.add(nk); q.push(n)
      if (out.size >= max) break
    }
  }
  // Карман не замкнут (обход упёрся в предел) — это открытое, а не карман: не разрешать (ревью Codex 30.09).
  if (out.size >= max) return null
  // Злые рядом — не выходить из клетки тела и в карман.
  const foe = (Object.values(bot.entities || {}) as any[]).some((e : any) => e && e.position && /^(piglin_brute|hoglin|zoglin|magma_cube)$/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 10)
  return foe ? null : out
}

function exposure (bot, own) {
  const seen = new Set()
  const q = []
  for (const v of bodyCells(bot)) { seen.add(keyV(v)); q.push(v) }
  const breaches = []
  for (let i = 0; i < q.length && i < 4000; i++) {
    const v = q[i]
    for (const [dx, dy, dz] of FACES) {
      const n = v.offset(dx, dy, dz)
      const nk = keyV(n)
      if (seen.has(nk)) continue
      const c = liveCls(bot, n)
      if (own.has(nk)) {
        if (c === AIR) { seen.add(nk); q.push(n); continue }
        if (c !== FLUID && c !== PARTIAL) { own.delete(nk); continue }
      }
      if (c === AIR || c === PARTIAL || c === FLUID || c === UNKNOWN) breaches.push({ at: keyV(v), open: nk, c: CLS_NAMES[c] })
    }
  }
  return breaches
}

async function equipFor (bot, b) {
  const items = require('./items')
  const needsIron = /^(gold_block|raw_gold_block|gold_ore|deepslate_gold_ore|diamond_ore|deepslate_diamond_ore|emerald_ore|redstone_ore)$/.test(b.name)
  if (!needsIron && /pickaxe/.test(b.material || '')) {
    const stone = bot.inventory.items().find(i => i.name === 'stone_pickaxe')
    if (stone) { if (!bot.heldItem || bot.heldItem.type !== stone.type) await bot.equip(stone, 'hand'); return stone }
  }
  return items.equipBestTool(bot, b)
}

async function digCell (bot, v, { allowGuard = false, interrupted = () => false, onReceipt }: any = {}) {
  const b = bot.blockAt(v)
  if (!b) return 'unloaded'
  const c = classOf(b)
  if (c === AIR) return 'air'
  if (c === FLUID) return 'fluid'
  if (c === HARD || c === UNKNOWN) return 'hard:' + b.name
  if (c === GUARD && !allowGuard && b.name !== 'nether_gold_ore') return 'guard:' + b.name
  if (c === GUARD && typeof b.canHarvest === 'function' && !b.canHarvest(null) &&
    !bot.inventory.items().some(item => b.canHarvest(item.type))) return 'tool:' + b.name
  const diagnostic: Record<string, unknown> = { block: b.name, position: { x: v.x, y: v.y, z: v.z }, hardness: b.hardness }
  const receipt = bot.version === '1.21.11' && bot._client
    ? require('./environments/dig-receipt').watchDigReceipt(bot, v, interrupted) : null
  const confirm = async () => {
    const started = gameClock.now(); const wallStarted = gameClock.wall.monotonic()
    const result = await receipt.settle()
    onReceipt?.({ result, gameMs: Math.max(0, gameClock.now() - started), wallMs: Math.max(0, gameClock.wall.monotonic() - wallStarted), ...receipt.timing(), dig: diagnostic })
    return result
  }
  try {
  try { await equipFor(bot, b) } catch {}
  diagnostic.hand = bot.heldItem?.name ?? null
  diagnostic.grounded = bot.entity.onGround
  try { diagnostic.expectedTicks = bot.digTime(b) / 50 } catch {}
  diagnostic.startedClock = gameClock.snapshot()
  let ms = 4000
  // Срок — по самому медленному: рукой (обёртка bot.dig выбирает инструмент заново — фильтр штрека может
  // отнять железную: ревью Codex 30.09, рукой 2000 мс против срока 1360 мс по железной).
  try {
    let t = bot.digTime(b)
    try { t = Math.max(t, b.digTime(null, false, false, !bot.entity.onGround, [], bot.entity.effects || {})) } catch {}
    ms = Math.min(15000, 1200 + t * 1.6)
  } catch {}
  try {
    await Promise.race([bot.dig(b, true), sleep(ms).then(() => { throw new Error('долго') })])
  } catch (e) {
    diagnostic.error = e.message
    diagnostic.finishedClock = gameClock.snapshot()
    try { bot.stopDigging() } catch {}
    if (receipt) {
      const confirmed = await confirm()
      return confirmed === 'confirmed' ? 'ok' : 'failed:server ' + confirmed
    }
    const now0 = bot.blockAt(v)
    if (now0 && classOf(now0) === AIR) return 'ok'
    return 'failed:' + e.message
  }
  diagnostic.finishedClock = gameClock.snapshot()
  if (receipt) {
    const confirmed = await confirm()
    return confirmed === 'confirmed' ? 'ok' : 'left:server ' + confirmed
  }
  const now = bot.blockAt(v)
  return now && classOf(now) === AIR ? 'ok' : 'left:' + (now ? now.name : '?')
  } finally { receipt?.close() }
}

async function fillCell (bot, v) {
  const { placeBlockAt } = require('./build')
  const b = bot.blockAt(v)
  if (b && classOf(b) !== AIR && classOf(b) !== PARTIAL) return true
  const item = fillerName(bot)
  if (!item) return false
  try {
    const r = await placeBlockAt(bot, v, { item, timeoutMs: 1500, honest: true })
    return !!(r && r.ok)
  } catch { return false }
}

async function stepMove (bot, ctl, mv) {
  if (ctl.waitReflex) await ctl.waitReflex()
  const to = vec(mv.to)
  const at = () => feetCell(bot)
  if (mv.kind === 'vdown') {
    for (let i = 0; i < 12 && !(at().equals(to) && bot.entity.onGround); i++) await sleep(50)
    // Тело не по центру клетки (рамка 0.6 лежит и на соседнем блоке) — в яму 1×1 не падает (chain6-10 30.09:
    // «не шагнул vdown», тело на 105.75,…,139.30): подвинуть к центру короткими шажками. Без приседа: присед
    // не даёт рамке сойти с опоры (prismarine-physics, как ванилла) — тело так и висло на краю (chain6: 3,67,2).
    if (!at().equals(to)) {
      const cx = to.x + 0.5; const cz = to.z + 0.5
      try {
        for (let i = 0; i < 30 && !at().equals(to) && !ctl.aborted; i++) {
          if (ctl.waitReflex) await ctl.waitReflex()
      const p = bot.entity.position
          if (Math.hypot(cx - p.x, cz - p.z) < 0.1 || !bot.entity.onGround) { await sleep(50); continue }
          await bot.look(Math.atan2(-(cx - p.x), -(cz - p.z)), 0, true).catch(() => {})
          bot.setControlState('sneak', false)
          bot.setControlState('forward', true)
          await sleep(40)
          bot.setControlState('forward', false)
          await sleep(60)
        }
      } finally { bot.setControlState('forward', false); bot.setControlState('sneak', false) }
      for (let i = 0; i < 20 && !(at().equals(to) && bot.entity.onGround); i++) await sleep(50)
    }
    return at().equals(to)
  }
  if (mv.kind === 'vup') {
    const { towerUp } = require('./build')
    const item = fillerName(bot)
    if (!item) return false
    try { await towerUp(bot, ctl, 1, { item, maxDigMs: 1500 }) } catch {}
    await sleep(150)
    return at().equals(to)
  }
  const t0 = require('./reflex-lock').clock(bot._ndReflexSession)
  try {
    while (require('./reflex-lock').clock(bot._ndReflexSession) - t0 < 3000 && !ctl.aborted) {
      if (at().equals(to) && bot.entity.onGround) break
      if (ctl.waitReflex) await ctl.waitReflex()
      const p = bot.entity.position
      await bot.lookAt(new Vec3(to.x + 0.5, p.y + 1.6, to.z + 0.5), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', mv.kind === 'up')
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
  await sleep(120)
  // Не дошёл (зацепился за край; ферма 29.09: «я 74.49,29.00,106.69», клетки впереди пусты) —
  // шаг назад и снова вперёд с прыжком.
  if (!at().equals(to) && !ctl.aborted) {
    try {
      bot.setControlState('back', true); await sleep(180); bot.setControlState('back', false)
      const t1 = require('./reflex-lock').clock(bot._ndReflexSession)
      while (require('./reflex-lock').clock(bot._ndReflexSession) - t1 < 1600 && !(at().equals(to) && bot.entity.onGround)) {
        if (ctl.waitReflex) await ctl.waitReflex()
      const p = bot.entity.position
        await bot.lookAt(new Vec3(to.x + 0.5, p.y + 1.6, to.z + 0.5), true)
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        await sleep(50)
      }
    } finally { bot.setControlState('forward', false); bot.setControlState('jump', false); bot.setControlState('back', false) }
    await sleep(200)
  }
  return at().equals(to)
}

// Попутное золото: руда золота Ада и золотой блок у клетки тела (видно — мы
// рядом), если их вскрытие не откроет штрек чужому воздуху и лаве.
async function bonusGold (bot, S, ctl = { aborted: false }) {
  let got = 0
  for (const v of bodyCells(bot)) {
    for (const [dx, dy, dz] of FACES) {
      const n = v.offset(dx, dy, dz)
      const nk = keyV(n)
      if (S.own.has(nk)) continue
      const b = bot.blockAt(n)
      if (!b || !/^(nether_gold_ore|gold_block|raw_gold_block)$/.test(b.name)) continue
      let safe = true
      for (const [ex, ey, ez] of FACES) {
        const m = n.offset(ex, ey, ez)
        const mk = keyV(m)
        if (S.own.has(mk) || bodyCells(bot).some(q => q.equals(m))) continue
        const c = liveCls(bot, m)
        if (c === AIR || c === PARTIAL || c === FLUID || c === UNKNOWN || (c === FALL && ey === 1)) { safe = false; break }
      }
      if (!safe) continue
      const r = await digCell(bot, n, { allowGuard: true, interrupted: () => ctl.aborted })
      if (r === 'ok') { S.own.add(nk); got++; if (b.name === 'nether_gold_ore') S.ores++; else S.bonusBlocks++; S.lastBreak = gameClock.now() }
    }
  }
  if (got) await sleep(250)
  return got
}

// Исполнить путь плана. S: { own, exposed, deadline, targets:Set, breachOk(k,nk),
// onThreat(), dug, moves, fills, ores, bonusBlocks }.
async function execute (session, ctl, path, S) {
  const bot = session.bot
  for (let i = 0; i < path.length; i++) {
    if (ctl.waitReflex) await ctl.waitReflex()
    const mv = path[i]
    if (ctl.aborted) return { ok: false, why: 'прервано', done: i }
    if (gameClock.now() > S.deadline) return { ok: false, why: 'время', done: i }
    for (const q of bodyCells(bot)) { const b = bot.blockAt(q); if (b && /lava|fire/.test(b.name)) return { ok: false, why: 'огонь или лава в клетке тела', done: i } }
    // Страж ближнего боя (ne-guard, 03.10): удар/брут вплотную — ответ сразу (яма на 2 вниз, столб, бой), а не после
    // шага: VR23-2/VR26-2/VR31-3 — пиглин бил 5 раз за 5 с посреди хода штрека/ямы, тело шло дальше. По умолчанию вкл. (03.10, замер B0→B2→B4), ND_GUARD=0 — выкл.
    if (process.env.ND_GUARD !== '0' && !S.noGuard && require('./worlds').worldOf(bot) === 'the_nether') {
      const G = require('./ne-guard')
      const h = G.hot(bot)
      if (h) {
        const rr = await G.react(session, ctl, { force: h, onOwn: cells => { for (const k of cells) S.own.add(k) } })
        if (rr.cancelled || ctl.aborted || session.bot !== bot) return { ok: false, why: 'прервано', done: i }
        if (rr.acted !== false) {
          S.exposed = exposure(bot, S.own).length > 0
          S.guards = (S.guards || 0) + 1
          return { ok: false, why: `удар: ${h.why} → ${rr.how || '-'}`, done: i, guard: rr.how || null }
        }
      }
    }
    if ((bot.health ?? 20) < 7) return { ok: false, why: `хп ${Math.round(bot.health)}`, done: i }
    const body = bodyCells(bot).map(keyV)
    const moveK = mv.clear.map(keyV)
    // Сверка с живым миром.
    for (const c of mv.clear) {
      const v = vec(c)
      const k = keyV(c)
      const b = bot.blockAt(v, false)
      const cc = classOf(b)
      if (cc === FLUID || cc === HARD || cc === UNKNOWN) return { ok: false, why: `${b ? b.name : '?'} на пути ${k}`, done: i }
      if (cc === AIR) { if (!S.own.has(k) && !body.includes(k) && !(S.openOk && S.openOk.has(k))) return { ok: false, why: `чужой воздух ${k}`, done: i }; continue }
      for (const [dx, dy, dz] of FACES) {
        const n = v.offset(dx, dy, dz)
        const nk = keyV(n)
        const nc = liveCls(bot, n)
        if (nc === FLUID) return { ok: false, why: `жидкость у ${k}`, done: i }
        if (S.own.has(nk) || body.includes(nk) || moveK.includes(nk)) continue
        if (nc === UNKNOWN) return { ok: false, why: `жидкость у ${k}`, done: i }
        if ((nc === AIR || nc === PARTIAL) && !(S.breachOk && S.breachOk(k, nk))) return { ok: false, why: `вскрою чужой воздух ${nk}`, done: i }
        if (nc === FALL && dy === 1) return { ok: false, why: `над ${k} гравий/песок`, done: i }
      }
    }
    // Пол хода — по живому миру и до копки (для vdown после копки тело уже падает).
    if (mv.floor) {
      const fk = keyV(mv.floor)
      const fc = liveCls(bot, vec(mv.floor))
      if (!(fc === SOLID || fc === HARD || fc === GUARD) || S.own.has(fk)) return { ok: false, why: `пол хода ${fk} ненадёжен`, done: i }
    }
    if (mv.kind === 'vup' && !fillerName(bot)) return { ok: false, why: 'нечем строить столб', done: i }
    for (const c of mv.clear) {
      const k = keyV(c)
      const b0 = bot.blockAt(vec(c))
      const r = await digCell(bot, vec(c), { allowGuard: S.targets && S.targets.has(k), interrupted: () => ctl.aborted })
      if (r !== 'ok' && r !== 'air') return { ok: false, why: `копка ${k}: ${r}`, done: i }
      if (r === 'ok') {
        S.dug++
        if (b0 && b0.name === 'gold_block') { S.goldPassed = (S.goldPassed || 0) + 1; S.lastBreak = gameClock.now() }
        if (b0 && b0.name === 'nether_gold_ore') { S.ores++; S.lastBreak = gameClock.now() }
      }
      S.own.add(k)
    }
    const before = bodyCells(bot)
    const ok = await stepMove(bot, ctl, mv)
    for (const v of bodyCells(bot)) S.own.add(keyV(v))
    if (!ok) {
      const p = bot.entity.position
      const cells = mv.clear.map(c => { const bb = bot.blockAt(vec(c)); return bb ? bb.name : '?' }).join('/')
      const fl = mv.floor ? (bot.blockAt(vec(mv.floor)) || {}).name : '-'
      return { ok: false, why: `не шагнул ${mv.kind} в ${keyV(mv.to)} (я ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} земля ${bot.entity.onGround} клетки ${cells} пол ${fl})`, at: keyV(feetCell(bot)), done: i }
    }
    S.moves++
    if (!S.noBonus) { try { await bonusGold(bot, S, ctl) } catch {} }
    // Новый пробой после закрытого участка тоже засыпать (раньше S.exposed=false больше не пересчитывался:
    // ревью Codex 30.09 — пробой есть, fills 0).
    const exp0 = S.exposed ? null : exposure(bot, S.own)
    if (S.exposed || exp0.length > 0) {
      if (exp0 ? exp0.length : exposure(bot, S.own).length) {
        const now = bodyCells(bot).map(keyV)
        for (const v of before) {
          if (now.includes(keyV(v))) continue
          if (await fillCell(bot, v)) { S.own.delete(keyV(v)); S.fills++; (S.filled || (S.filled = new Set())).add(keyV(v)) }
        }
      }
      S.exposed = exposure(bot, S.own).length > 0
      if (S.exposed && S.onThreat) { try { await S.onThreat() } catch {} }
    }
  }
  return { ok: true, done: path.length }
}

module.exports = { localAir, bodyCells, FILL_NAMES: FILL, reachCells, AIR, SOLID, FLUID, HARD, GUARD, FALL, PARTIAL, HOT, UNKNOWN, CLS_NAMES, FACES, classOf, digSecondsOf, worldView, plan, adjacentGoal, manhattan, key, keyV, exposure, digCell, fillCell, stepMove, bonusGold, execute, fillerName, fillerCount }
