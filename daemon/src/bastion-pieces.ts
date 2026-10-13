'use strict'
// Узнавание кусков бастиона по видимому — как спидраннер узнаёт «стену с
// золотом» по сундукам и кладке. Шаблоны — из jar 1.21.11
// (data/minecraft/structure/bastion/**.nbt → data/bastion-pieces.json, сборка
// scratch build-lib.js, 2026-09-29): сетка символов на кусок, золото и сундуки
// с facing/type.
//
// Как узнаём: сундук (процессоры бастиона сундуки не трогают; кусок кладут
// только поворотом вокруг вертикали, без зеркала — jigsaw) даёт кандидата
// «кусок P, поворот r, сдвиг t»: facing и left/right сундука должны сойтись с
// шаблоном после поворота. Кандидата проверяем глазами: клетки шаблона, чья
// грань открыта в шаблоне, — видим ли мы в мире на этом месте блок того же
// семейства (кирпич/треснутый/чернокамень — одно семейство: процессоры
// housing/generic меняют их между собой, золото 30% → треснутый кирпич). Видим
// твёрдое там, где в шаблоне воздух, — промах. Проверяем только видимое
// (sight.seesBlock): где золото спрятано, узнаём из шаблона, а не рентгеном.
//
// Мир прохождения, бастион 105,43,87 (сверено 2026-09-29 по ферме): тип
// «жилой» (units): units/walls/wall_base с началом 82,32,129 без поворота —
// 9 золотых блоков в нижней камере (y 35–36) и 3 в средней (y 49–50), сундуки
// 84–85,36,134; рядом units/walls/connected_wall (98,32,129) — ещё 5.
const path = require('path')
const { Vec3 } = require('vec3')

let LIB = null
function lib () {
  if (!LIB) LIB = require(path.join(__dirname, '..', 'data', 'bastion-pieces.json'))
  return LIB
}

function symOf (n) {
  if (!n || n === 'structure_void' || n === 'jigsaw') return ' '
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return '.'
  if (n === 'lava') return 'L'
  if (n === 'gold_block') return 'G'
  if (n === 'chest' || n === 'trapped_chest' || n === 'barrel') return 'C'
  if (n === 'gilded_blackstone') return 'g'
  if (/stairs|slab|wall$|chain|lantern|fence|bars|button|pressure_plate|torch|carpet|ladder|vine|roots|fungus|sprouts|rod$/.test(n)) return 's'
  if (/basalt/.test(n)) return 'b'
  if (n === 'magma_block') return 'M'
  if (/blackstone/.test(n)) return 'B'
  return 'o'
}
// Семейство для сверки: процессоры меняют кирпич↔треснутый↔чернокамень↔
// позолоченный, золото → треснутый кирпич.
const FAM = { B: 'B', g: 'B', G: 'B', b: 'b', M: 'o', o: 'o', s: 's', C: 'C', L: 'L', '.': '.' }

// Поворот шаблона вокруг вертикали (кусок кладут без зеркала).
function rot (r, x, z) {
  switch (r & 3) {
    case 0: return [x, z]
    case 1: return [-z, x]
    case 2: return [-x, -z]
    default: return [z, -x]
  }
}
const FACE = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
function rotFacing (r, f) {
  const v = FACE[f]
  if (!v) return f
  const [x, z] = rot(r, v[0], v[1])
  return Object.keys(FACE).find(k => FACE[k][0] === x && FACE[k][1] === z)
}
function cellOf (P, x, y, z) {
  const [X, Y, Z] = P.size
  if (x < 0 || y < 0 || z < 0 || x >= X || y >= Y || z >= Z) return ' '
  return P.grid[x + X * (z + Z * y)]
}
// Мир → клетка шаблона для кандидата { r, t }.
function toTemplate (c, w) {
  const [x, z] = rot((4 - c.r) & 3, w.x - c.t.x, w.z - c.t.z)
  return [x, w.y - c.t.y, z]
}
function toWorld (c, x, y, z) {
  const [wx, wz] = rot(c.r, x, z)
  return new Vec3(wx + c.t.x, y + c.t.y, wz + c.t.z)
}

// Кандидаты по видимым сундукам: [{ piece, r, t }].
function candidatesFromChests (bot, chests) {
  const L = lib()
  const out = new Map()
  for (const o of chests) {
    let props: any = {}
    try { props = o.block.getProperties() || {} } catch {}
    for (const [name, P] of ((Object.entries(L) as [string, any][]) as any)) {
      if (!P.chests.length) continue
      for (const [cx, cy, cz, facing, type] of P.chests) {
        for (let r = 0; r < 4; r++) {
          if (props.facing && facing && rotFacing(r, facing) !== props.facing) continue
          if (props.type && type && props.type !== type) continue
          const [rx, rz] = rot(r, cx, cz)
          const t = { x: o.pos.x - rx, y: o.pos.y - cy, z: o.pos.z - rz }
          const k = `${name}|${r}|${t.x},${t.y},${t.z}`
          if (!out.has(k)) out.set(k, { piece: name, r, t, anchors: 0 })
          out.get(k).anchors++
        }
      }
    }
  }
  return [...out.values()]
}

// Проверка кандидата глазами: до maxChecks открытых в шаблоне клеток ближе
// radius к телу. { match, miss, checked }.
function verify (bot, c, { radius = 28, maxChecks = 260 }: any = {}) {
  const { seesBlock } = require('./sight')
  const P = lib()[c.piece]
  const [X, Y, Z] = P.size
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const cells = []
  for (let y = 0; y < Y; y++) {
    for (let z = 0; z < Z; z++) {
      for (let x = 0; x < X; x++) {
        const s = P.grid[x + X * (z + Z * y)]
        if (s === ' ' || s === '.') continue
        // Открытая в шаблоне грань: сосед — воздух шаблона.
        let open = false
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (cellOf(P, x + dx, y + dy, z + dz) === '.') { open = true; break }
        if (!open) continue
        const w = toWorld(c, x, y, z)
        const d = w.offset(0.5, 0.5, 0.5).distanceTo(eye)
        if (d > radius) continue
        cells.push({ w, s, d })
      }
    }
  }
  cells.sort((a, b) => a.d - b.d)
  let match = 0
  let miss = 0
  let checked = 0
  for (const { w, s } of cells) {
    if (checked >= maxChecks) break
    const b = bot.blockAt(w)
    if (!b || b.boundingBox === 'empty') continue
    checked++
    if (!seesBlock(bot, b)) continue
    const ws = symOf(b.name)
    if (FAM[ws] === FAM[s]) match++
    else miss++
  }
  // Видимое твёрдое там, где в шаблоне воздух.
  let airMiss = 0
  let airChecked = 0
  for (let i = 0; i < 400 && airChecked < 80; i++) {
    const x = Math.floor(Math.random() * X)
    const y = Math.floor(Math.random() * Y)
    const z = Math.floor(Math.random() * Z)
    if (cellOf(P, x, y, z) !== '.') continue
    const w = toWorld(c, x, y, z)
    if (w.offset(0.5, 0.5, 0.5).distanceTo(eye) > radius) continue
    const b = bot.blockAt(w)
    if (!b) continue
    airChecked++
    if (b.boundingBox === 'block' && seesBlock(bot, b)) airMiss++
  }
  return { match, miss: miss + airMiss, checked, airChecked }
}

// Видимые сундуки → проверенные куски с золотом (лучший на кусок).
function locate (bot, chests, { minMatch = 14, maxMissRatio = 0.25, radius = 28, debug = null }: any = {}) {
  const cands = candidatesFromChests(bot, chests)
  const found = []
  for (const c of cands) {
    const P = lib()[c.piece]
    const v = verify(bot, c, { radius })
    c.match = v.match
    c.miss = v.miss
    c.gold = P.gold.length
    if (debug) debug.push({ piece: c.piece.split("/").slice(-2).join("/"), r: c.r, t: c.t, match: v.match, miss: v.miss, checked: v.checked })
    if (v.match >= minMatch && v.miss <= maxMissRatio * v.match) found.push(c)
  }
  found.sort((a, b) => (b.match - 2 * b.miss) - (a.match - 2 * a.miss))
  const best = new Map()
  for (const c of found) if (!best.has(c.piece)) best.set(c.piece, c)
  return { candidates: cands.length, found: [...best.values()] }
}

// Где у узнанного куска золото (по шаблону).
function goldOf (c) {
  const P = lib()[c.piece]
  return P.gold.map(([x, y, z]) => toWorld(c, x, y, z))
}
// Тип бастиона по куску: bridge, hoglin_stable, treasure, units.
function typeOf (c) { return lib()[c.piece].type }

// Голосование по видимому базальту: у вала ramparts_0 — 342 базальтовые клетки
// (колонны башни, процессоры его не трогают), видны издалека. Каждый видимый
// базальт × каждая открытая базальтовая клетка шаблона × 4 поворота — голос за
// сдвиг; верхушки проверяем глазами (verify). [{ piece, r, t, votes, match, miss }]
const surfaceCache = new Map()
function surfaceCells (name, sym) {
  const k = `${name}|${sym}`
  if (surfaceCache.has(k)) return surfaceCache.get(k)
  const P = lib()[name]
  const [X, Y, Z] = P.size
  const out = []
  for (let y = 0; y < Y; y++) {
    for (let z = 0; z < Z; z++) {
      for (let x = 0; x < X; x++) {
        if (P.grid[x + X * (z + Z * y)] !== sym) continue
        let open = false
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const c = cellOf(P, x + dx, y + dy, z + dz)
          if (c === '.' || c === ' ') { open = true; break }
        }
        if (open) out.push([x, y, z])
      }
    }
  }
  surfaceCache.set(k, out)
  return out
}
function complete (steps) {
  let next = steps.next()
  while (!next.done) next = steps.next()
  return next.value
}
function * topVotesSteps (votes, top) {
  const best = []
  const end = Math.trunc(Number(top) || 0)
  top = Math.min(votes.size, Math.max(0, end < 0 ? votes.size + end : end))
  if (top === 0) return best
  let checked = 0
  for (const entry of votes) {
    // Keep the same stable descending top as sort, without allocating/sorting
    // every rejected hypothesis in one uninterruptible CPU slice.
    if (best.length < top || entry[1] > best[best.length - 1][1]) {
      let at = best.length
      while (at > 0 && best[at - 1][1] < entry[1]) at--
      best.splice(at, 0, entry)
      if (best.length > top) best.pop()
    }
    if ((++checked & 1023) === 0) yield
  }
  return best
}
function voteByBasalt (bot, seen, pieces = [...RAMPART_SHAPES], opts: any = {}) {
  return complete(voteByBasaltSteps(bot, seen, pieces, opts))
}
function * voteByBasaltSteps (bot, seen, pieces = [...RAMPART_SHAPES], { top = 10, minMatch = 15, maxMissRatio = 0.25, debug = null }: any = {}) {
  const votes = new Map()
  for (const name of pieces) {
    if (!lib()[name]) continue
    const cells = surfaceCells(name, 'b')
    for (const o of seen) {
      const p = o.position || o
      for (const [x, y, z] of cells) {
        for (let r = 0; r < 4; r++) {
          const [rx, rz] = rot(r, x, z)
          const k = `${name}|${r}|${p.x - rx}|${p.y - y}|${p.z - rz}`
          votes.set(k, (votes.get(k) || 0) + 1)
        }
      }
      yield
    }
  }
  const best = yield * topVotesSteps(votes, top)
  const out = []
  for (const [k, n] of best) {
    if (n < 6) continue
    const [piece, r, tx, ty, tz] = k.split('|')
    const c: any = { piece, r: Number(r), t: { x: Number(tx), y: Number(ty), z: Number(tz) }, votes: n }
    const v = verify(bot, c, { radius: 56, maxChecks: 500 })
    c.match = v.match
    c.miss = v.miss
    if (debug) debug.push({ piece: c.piece.split('/').pop(), r: c.r, t: c.t, votes: n, match: v.match, miss: v.miss })
    if (v.match >= minMatch && v.miss <= maxMissRatio * v.match) out.push(c)
    yield
  }
  return out
}

// Жилой бастион (units), пулы 1.21.11: air_base (старт) цепляет на западе
// ВСЕГДА units/walls/wall_base (12 золотых: 9 в нижней камере, 3 в средней);
// у wall_base на востоке (jigsaw path_connected_wall → wall_connected_wall)
// ВСЕГДА units/walls/connected_wall (5 золотых); на верху wall_base — пул
// large_ramparts = только ramparts_0 (тройной сундук на террасе), на верху
// connected_wall — ramparts_0/1/2. Стык стена→вал «aligned»: стена (15,23,15)
// up_south, вал (0,0,15) down_west — поворот стены = поворот вала + 1.
// Та же форма вала — у bridge/rampart_1 и hoglin_stable/ramparts_1, поэтому
// кандидата любого из них проверяем как жилой.
const RAMPART_SHAPES = new Set(['units/ramparts/ramparts_0', 'units/ramparts/ramparts_1', 'units/ramparts/ramparts_2', 'bridge/ramparts/rampart_1', 'hoglin_stable/ramparts/ramparts_1'])
function unitsWallsFromRampart (c) {
  if (!RAMPART_SHAPES.has(c.piece)) return null
  const J = toWorld(c, 0, 0, 15)
  const rw = (c.r + 1) & 3
  const [ox, oz] = rot(rw, 15, 15)
  const T = { x: J.x - ox, y: J.y - 1 - 23, z: J.z - oz }
  const [ex, ez] = rot(rw, 16, 0)
  return {
    // A: под валом wall_base (его вал всегда ramparts_0), восточнее — connected_wall.
    A: [{ piece: 'units/walls/wall_base', r: rw, t: T }, { piece: 'units/walls/connected_wall', r: rw, t: { x: T.x + ex, y: T.y, z: T.z + ez } }],
    // B: под валом connected_wall, западнее — wall_base.
    B: [{ piece: 'units/walls/connected_wall', r: rw, t: T }, { piece: 'units/walls/wall_base', r: rw, t: { x: T.x - ex, y: T.y, z: T.z - ez } }]
  }
}


// ---------------------------------------------------------------- вывод «якорь → старт → куски с золотом»
// Раскладка бастиона от стартового куска (jigsaw пулов 1.21.11): куски с золотом и куски-якоря (сундуки, базальт,
// открытое золото) стоят на ПОСТОЯННЫХ местах относительно старта; случайно только «какой вариант» в слоте. Таблица —
// по правде фермы 02.10 (стартовые записи построек в регионах 6 случайных миров, 35 бастионов: farm/keep/neF-nether,
// codex-lab/ne-tools/relpieces.js): d — сдвиг в осях старта, dr — поворот относительно старта, v — варианты слота с долей.
// Узнали любой кусок таблицы (сундук, базальт, золото — verify глазами) — знаем старт, а с ним все куски с золотом:
// так спидраннер по одному валу знает, где золото конюшен или моста (dev-F 02.10: до этого на случайных сидах
// «бастион не узнан» — 0 золотых блоков в 2 из 2).
// Доли вариантов — веса пулов jar 1.21.11 (сверка Codex 02.10: codex-lab/ne-tools/jar-audit-corrections.json; места
// слотов подтверждены jigsaw-связями, у жилого слота валов есть и ramparts_2).
const START_REL = {
  bridge: [
    { d: [0, 0, 0], dr: 0, v: { 'bridge/starting_pieces/entrance_base': 1 } },
    { d: [2, 0, -16], dr: 0, v: { 'bridge/walls/wall_base_0': 1 } },
    { d: [0, 32, 0], dr: 0, v: { 'bridge/starting_pieces/entrance': 1 } },
    { d: [-31, 21, 7], dr: 0, v: { 'bridge/bridge_pieces/bridge': 1 } },
    { d: [2, 24, 32], dr: 0, v: { 'bridge/ramparts/rampart_0': 0.5, 'bridge/ramparts/rampart_1': 0.5 } },
    { d: [2, 24, -16], dr: 0, v: { 'bridge/ramparts/rampart_0': 0.5, 'bridge/ramparts/rampart_1': 0.5 } }
  ],
  treasure: [
    { d: [25, 33, -19], dr: 1, v: { 'treasure/entrances/entrance_0': 1 } },
    { d: [25, 21, -36], dr: 1, v: { 'treasure/ramparts/mid_wall_main': 1 } },
    { d: [11, 21, -38], dr: 1, v: { 'treasure/ramparts/mid_wall_side': 1 } },
    { d: [25, 53, -36], dr: 1, v: { 'treasure/ramparts/top_wall': 1 } },
    { d: [11, 52, -38], dr: 1, v: { 'treasure/ramparts/top_wall': 1 } },
    { d: [15, 1, 15], dr: 0, v: { 'treasure/bases/centers/center_0': 0.25, 'treasure/bases/centers/center_1': 0.25, 'treasure/bases/centers/center_2': 0.25, 'treasure/bases/centers/center_3': 0.25 } }
  ],
  units: [
    { d: [-1, 0, 18], dr: 1, v: { 'units/walls/wall_base': 1 } },
    { d: [-1, 0, 34], dr: 1, v: { 'units/walls/connected_wall': 1 } },
    { d: [-16, 24, 18], dr: 0, v: { 'units/ramparts/ramparts_0': 1 } },
    { d: [-16, 24, 34], dr: 0, v: { 'units/ramparts/ramparts_0': 1 / 3, 'units/ramparts/ramparts_1': 1 / 3, 'units/ramparts/ramparts_2': 1 / 3 } },
    { d: [19, 0, 19], dr: 0, v: { 'units/center_pieces/center_0': 1 / 3, 'units/center_pieces/center_1': 1 / 3, 'units/center_pieces/center_2': 1 / 3 } }
  ],
  hoglin_stable: [
    { d: [-16, -1, 16], dr: 0, v: { 'hoglin_stable/walls/wall_base': 1 } },
    { d: [-18, -1, 15], dr: 3, v: { 'hoglin_stable/walls/side_wall_0': 0.5, 'hoglin_stable/walls/side_wall_1': 0.5 } },
    { d: [-18, -1, 47], dr: 3, v: { 'hoglin_stable/walls/side_wall_1': 0.5, 'hoglin_stable/walls/side_wall_0': 0.5 } },
    { d: [-16, 23, 16], dr: 0, v: { 'hoglin_stable/ramparts/ramparts_1': 1 / 3, 'hoglin_stable/ramparts/ramparts_2': 1 / 3, 'hoglin_stable/ramparts/ramparts_3': 1 / 3 } },
    { d: [-18, 23, 32], dr: 0, v: { 'hoglin_stable/ramparts/ramparts_1': 1 / 3, 'hoglin_stable/ramparts/ramparts_2': 1 / 3, 'hoglin_stable/ramparts/ramparts_3': 1 / 3 } },
    { d: [-18, 23, 0], dr: 0, v: { 'hoglin_stable/ramparts/ramparts_1': 1 / 3, 'hoglin_stable/ramparts/ramparts_2': 1 / 3, 'hoglin_stable/ramparts/ramparts_3': 1 / 3 } }
  ]
}
// Узнанный кусок c {piece, r, t} → гипотезы старта [{ type, r, t, w }] (кусок встречается в таблице — по месту слота).
function startsFrom (c) {
  const out = []
  for (const [type, slots] of (Object.entries(START_REL) as [string, any][])) {
    slots.forEach((sl, slot) => {
      const p = sl.v[c.piece]
      if (!p) return
      const r = (c.r - sl.dr + 4) & 3
      const [ox, oz] = rot(r, sl.d[0], sl.d[2])
      out.push({ type, r, t: { x: c.t.x - ox, y: c.t.y - sl.d[1], z: c.t.z - oz }, w: p, from: c.piece, slot })
    })
  }
  return out
}
// Старт → куски с золотом по слотам: [{ piece, r, t, p, slot, type }] (варианты слота — каждый со своей долей).
function goldPiecesFromStart (S) {
  const out = []
  const slots = START_REL[S.type] || []
  slots.forEach((sl, slot) => {
    const [ox, oz] = rot(S.r, sl.d[0], sl.d[2])
    const t = { x: S.t.x + ox, y: S.t.y + sl.d[1], z: S.t.z + oz }
    for (const [piece, p] of (Object.entries(sl.v) as [string, any][])) {
      const P = lib()[piece]
      if (P && P.gold.length) out.push({ piece, r: (S.r + sl.dr) & 3, t, p, slot, type: S.type })
    }
  })
  return out
}
// Голосование по видимым блокам символа sym (b — базальт, G — золото) за сдвиг кусков pieces, верх — проверка глазами.
function voteBy (bot, seen, pieces, sym, opts: any = {}) {
  return complete(voteBySteps(bot, seen, pieces, sym, opts))
}
function * voteBySteps (bot, seen, pieces, sym, { top = 12, minMatch = 15, maxMissRatio = 0.25, minVotes = 6, radius = 56, debug = null }: any = {}) {
  const votes = new Map()
  for (const name of pieces) {
    if (!lib()[name]) continue
    const cells = surfaceCells(name, sym)
    if (!cells.length) continue
    for (const o of seen) {
      const p = o.position || o
      for (const [x, y, z] of cells) {
        for (let r = 0; r < 4; r++) {
          const [rx, rz] = rot(r, x, z)
          const k = name + '|' + r + '|' + (p.x - rx) + '|' + (p.y - y) + '|' + (p.z - rz)
          votes.set(k, (votes.get(k) || 0) + 1)
        }
      }
      yield
    }
  }
  const best = yield * topVotesSteps(votes, top)
  const out = []
  for (const [k, n] of best) {
    if (n < minVotes) continue
    const [piece, r, tx, ty, tz] = k.split('|')
    const c: any = { piece, r: Number(r), t: { x: Number(tx), y: Number(ty), z: Number(tz) }, votes: n }
    const v = verify(bot, c, { radius, maxChecks: 500 })
    c.match = v.match
    c.miss = v.miss
    if (debug) debug.push({ piece: piece.split("/").slice(-2).join("/"), r: c.r, t: c.t, votes: n, match: v.match, miss: v.miss })
    if (v.match >= minMatch && v.miss <= maxMissRatio * v.match) out.push(c)
    yield
  }
  return out
}
// Куски таблицы с базальтом и с открытым золотом — кого голосовать (якоря).
const BASALT_ANCHORS = ['bridge/bridge_pieces/bridge', 'bridge/starting_pieces/entrance', 'hoglin_stable/ramparts/ramparts_1', 'hoglin_stable/ramparts/ramparts_2', 'hoglin_stable/ramparts/ramparts_3', 'treasure/ramparts/mid_wall_main', 'treasure/ramparts/mid_wall_side', 'treasure/ramparts/top_wall']
const GOLD_ANCHORS = ['bridge/bridge_pieces/bridge', 'treasure/bases/centers/center_0', 'treasure/bases/centers/center_1', 'treasure/bases/centers/center_2', 'treasure/bases/centers/center_3']

module.exports = { lib, symOf, rot, rotFacing, toWorld, toTemplate, candidatesFromChests, verify, locate, goldOf, typeOf, cellOf, unitsWallsFromRampart, RAMPART_SHAPES, voteByBasalt, voteByBasaltSteps, surfaceCells, START_REL, startsFrom, goldPiecesFromStart, voteBy, voteBySteps, BASALT_ANCHORS, GOLD_ANCHORS }
