'use strict'
// Инструменты воксельной архитектуры для castle.js: шум, семейства блоков,
// примитивы (окна, розы, контрфорсы, башни, крыши, шпили, лестницы) и мебель.
// Всё рисует в Grid (colosseum.js) через объект B = kit(g): поздний вызов
// перекрывает ранний в той же клетке.
//
// Состояния — как их понимает игра (paper 1.21.11):
//   ступени facing — куда подъём (высокая часть с этой стороны), half=top — перевёрнутые;
//   wall_torch, ladder, *_wall_sign, *_wall_banner facing — от стены (держатель — сзади);
//   двери, кровати: кровать facing — от ног к изголовью; сундук facing — перёд;
//   двойной сундук: у LEFT сосед по часовой от facing (ChestBlock.getConnectedDirection).

import * as C from '../arena/colosseum'
const { st } = C

const DIR = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
const OPP = { north: 'south', south: 'north', west: 'east', east: 'west' }
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' }

// ------------------------------------------------------------------ шум

function hash (x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144269504) | 0
  h = (h ^ (h >>> 13)) * 1274126177 | 0
  h = h ^ (h >>> 16)
  return (h >>> 0) / 4294967296
}
const smooth = t => t * t * (3 - 2 * t)
function vnoise (x, z, seed) {
  const xi = Math.floor(x); const zi = Math.floor(z); const xf = smooth(x - xi); const zf = smooth(z - zi)
  const a = hash(xi, 0, zi, seed); const b = hash(xi + 1, 0, zi, seed); const c = hash(xi, 0, zi + 1, seed); const d = hash(xi + 1, 0, zi + 1, seed)
  return (a * (1 - xf) + b * xf) * (1 - zf) + (c * (1 - xf) + d * xf) * zf
}
function vnoise3 (x, y, z, seed) {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z)
  const xf = smooth(x - xi); const yf = smooth(y - yi); const zf = smooth(z - zi)
  let s = 0
  for (let dy = 0; dy < 2; dy++) {
    for (let dz = 0; dz < 2; dz++) {
      for (let dx = 0; dx < 2; dx++) {
        const w = (dx ? xf : 1 - xf) * (dy ? yf : 1 - yf) * (dz ? zf : 1 - zf)
        s += w * hash(xi + dx, yi + dy, zi + dz, seed)
      }
    }
  }
  return s
}
function fbm (x, z, seed, oct = 4) {
  let s = 0; let a = 0.5; let f = 1; let n = 0
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, z * f, seed + i * 17); n += a; a *= 0.5; f *= 2 }
  return s / n
}

// ------------------------------------------------------------- семейства

// База → ступени / плиты / стена / забор. Нет стены — полный блок базы.
const FAM: Record<string, any> = {} as Record<string, any>
const fam = (base, stairs, slab, wall) => { FAM[base] = { base, stairs, slab, wall } }
fam('stone_bricks', 'stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall')
fam('mossy_stone_bricks', 'mossy_stone_brick_stairs', 'mossy_stone_brick_slab', 'mossy_stone_brick_wall')
fam('cracked_stone_bricks', 'stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall')
fam('tuff_bricks', 'tuff_brick_stairs', 'tuff_brick_slab', 'tuff_brick_wall')
fam('polished_tuff', 'polished_tuff_stairs', 'polished_tuff_slab', 'polished_tuff_wall')
fam('tuff', 'tuff_stairs', 'tuff_slab', 'tuff_wall')
fam('deepslate_tiles', 'deepslate_tile_stairs', 'deepslate_tile_slab', 'deepslate_tile_wall')
fam('deepslate_bricks', 'deepslate_brick_stairs', 'deepslate_brick_slab', 'deepslate_brick_wall')
fam('polished_deepslate', 'polished_deepslate_stairs', 'polished_deepslate_slab', 'polished_deepslate_wall')
fam('cobblestone', 'cobblestone_stairs', 'cobblestone_slab', 'cobblestone_wall')
fam('mossy_cobblestone', 'mossy_cobblestone_stairs', 'mossy_cobblestone_slab', 'mossy_cobblestone_wall')
fam('stone', 'stone_stairs', 'stone_slab', 'stone_brick_wall')
fam('andesite', 'andesite_stairs', 'andesite_slab', 'andesite_wall')
fam('polished_andesite', 'polished_andesite_stairs', 'polished_andesite_slab', 'andesite_wall')
fam('bricks', 'brick_stairs', 'brick_slab', 'brick_wall')
fam('oxidized_cut_copper', 'oxidized_cut_copper_stairs', 'oxidized_cut_copper_slab', null)
fam('weathered_cut_copper', 'weathered_cut_copper_stairs', 'weathered_cut_copper_slab', null)
fam('spruce_planks', 'spruce_stairs', 'spruce_slab', 'spruce_fence')
fam('dark_oak_planks', 'dark_oak_stairs', 'dark_oak_slab', 'dark_oak_fence')
fam('oak_planks', 'oak_stairs', 'oak_slab', 'oak_fence')
fam('smooth_stone', 'stone_stairs', 'smooth_stone_slab', 'stone_brick_wall')
fam('smooth_quartz', 'smooth_quartz_stairs', 'smooth_quartz_slab', 'diorite_wall')
fam('polished_blackstone_bricks', 'polished_blackstone_brick_stairs', 'polished_blackstone_brick_slab', 'polished_blackstone_brick_wall')
fam('mud_bricks', 'mud_brick_stairs', 'mud_brick_slab', 'mud_brick_wall')
fam('end_stone_bricks', 'end_stone_brick_stairs', 'end_stone_brick_slab', 'end_stone_brick_wall')
fam('polished_diorite', 'polished_diorite_stairs', 'polished_diorite_slab', 'diorite_wall')
fam('diorite', 'diorite_stairs', 'diorite_slab', 'diorite_wall')
fam('quartz_block', 'quartz_stairs', 'quartz_slab', 'diorite_wall')
fam('smooth_sandstone', 'smooth_sandstone_stairs', 'smooth_sandstone_slab', 'sandstone_wall')
fam('cut_sandstone', 'smooth_sandstone_stairs', 'cut_sandstone_slab', 'sandstone_wall')
fam('calcite', 'polished_diorite_stairs', 'polished_diorite_slab', 'diorite_wall')
fam('stone_bricks_light', 'stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall')

const stairs = (f, facing, half = 'bottom') => st(FAM[f] ? FAM[f].stairs : f, { facing, half, shape: 'straight', waterlogged: 'false' })
const slab = (f, type = 'bottom') => st(FAM[f] ? FAM[f].slab : f, { type, waterlogged: 'false' })
const wall = f => FAM[f] && FAM[f].wall ? FAM[f].wall : f

// ---------------------------------------------------------------- набор

function kit (g) {
  const B: Record<string, any> = {} as Record<string, any>
  B.g = g
  B.S = (x, y, z, s) => g.set(x, y, z, s)
  B.G = (x, y, z) => g.get(x, y, z)
  B.nbt = (x, y, z, n) => { if (g.in(x, y, z)) g.nbt.set(g.i(x, y, z), n) }
  B.box = (x0, y0, z0, x1, y1, z1, s) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) g.set(x, y, z, s)
  }
  B.air = (x0, y0, z0, x1, y1, z1) => B.box(x0, y0, z0, x1, y1, z1, '')
  // Только где пусто.
  B.fillEmpty = (x0, y0, z0, x1, y1, z1, s) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) if (!g.get(x, y, z)) g.set(x, y, z, s)
  }
  B.hollow = (x0, y0, z0, x1, y1, z1, s) => {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (x === x0 || x === x1 || z === z0 || z === z1) g.set(x, y, z, s)
        }
      }
    }
  }
  B.column = (x, z, y0, y1, s) => { for (let y = y0; y <= y1; y++) g.set(x, y, z, s) }

  // ---- плоскость стены: along — ось вдоль стены ('x' | 'z'), c — координата
  // поперёк, out — наружная сторона. P(a, y, d) → клетка: a — вдоль, d — вглубь
  // (0 — плоскость, +1 — наружу).
  B.plane = (along, c, out) => {
    const sgn = (out === 'south' || out === 'east') ? 1 : -1
    const lo = along === 'x' ? 'west' : 'north'
    const hi = along === 'x' ? 'east' : 'south'
    return {
      along, c, out, in: OPP[out], lo, hi,
      at: (a, y, d = 0) => along === 'x' ? [a, y, c + sgn * d] : [c + sgn * d, y, a],
      set: (a, y, s, d = 0) => { const [x, yy, z] = along === 'x' ? [a, y, c + sgn * d] : [c + sgn * d, y, a]; g.set(x, yy, z, s) },
      get: (a, y, d = 0) => { const [x, yy, z] = along === 'x' ? [a, y, c + sgn * d] : [c + sgn * d, y, a]; return g.get(x, yy, z) }
    }
  }

  // Стрельчатое окно ширины w (1, 2, 3, 5) в плоскости P: низ y0, прямой
  // проём h рядов, сверху пяты-ступени и острие. glass(a, y) → стекло клетки.
  // mullion — средник из стены семейства (для w ≥ 3), sill — подоконник.
  B.lancet = (P, a0, y0, w, h, { glass = () => 'glass_pane', famName = 'tuff_bricks', mullion = false, sill = true, depth = 0, frame = null }: any = {} as Record<string, any>) => {
    const a1 = a0 + w - 1
    for (let y = y0; y < y0 + h; y++) {
      for (let a = a0; a <= a1; a++) {
        const mid = mullion && w >= 3 && (w % 2 === 1) && a === (a0 + a1) / 2 && y < y0 + h - 1
        P.set(a, y, mid ? wall(famName) : glass(a, y), depth)
      }
    }
    const yt = y0 + h
    if (w === 1) {
      P.set(a0, yt, stairs(famName, P.in, 'top'), depth) // острие — полуарка
    } else if (w === 2) {
      P.set(a0, yt, stairs(famName, P.lo, 'top'), depth); P.set(a1, yt, stairs(famName, P.hi, 'top'), depth)
    } else {
      P.set(a0, yt, stairs(famName, P.lo, 'top'), depth); P.set(a1, yt, stairs(famName, P.hi, 'top'), depth)
      for (let a = a0 + 1; a < a1; a++) P.set(a, yt, glass(a, yt), depth)
      if (w >= 5) {
        P.set(a0 + 1, yt + 1, stairs(famName, P.lo, 'top'), depth); P.set(a1 - 1, yt + 1, stairs(famName, P.hi, 'top'), depth)
        for (let a = a0 + 2; a < a1 - 1; a++) P.set(a, yt + 1, glass(a, yt + 1), depth)
        P.set((a0 + a1) / 2, yt + 2, glass((a0 + a1) / 2, yt + 2), depth)
      } else P.set((a0 + a1) / 2, yt + 1, glass((a0 + a1) / 2, yt + 1), depth)
    }
    if (sill) for (let a = a0; a <= a1; a++) { const [x, y, z] = P.at(a, y0 - 1, depth + 1); if (!g.get(x, y, z)) g.set(x, y, z, slab(famName, 'top')) }
    if (frame) {
      // Наличник: выступ на +1 по краям.
      for (let y = y0; y <= yt; y++) { P.set(a0 - 1, y, frame, depth + 1); P.set(a1 + 1, y, frame, depth + 1) }
    }
  }

  // Роза: окно-круг радиуса R в плоскости P с центром (ac, yc). Стекло —
  // в глубине d = −1 (внутри стены), обвод и ажур — в плоскости.
  B.rose = (P, ac, yc, R, { famName = 'tuff_bricks', spokes = 12, colors = ['yellow', 'blue', 'red', 'blue', 'purple'], ring = 'chiseled_tuff', boss = 'chiseled_tuff_bricks', back = null }: any = {} as Record<string, any>) => {
    const tr = wall(famName)
    for (let dy = -Math.ceil(R + 1); dy <= Math.ceil(R + 1); dy++) {
      for (let da = -Math.ceil(R + 1); da <= Math.ceil(R + 1); da++) {
        const r = Math.hypot(da, dy)
        const a = ac + da; const y = yc + dy
        if (r > R + 0.5) continue
        if (r > R - 0.5) { P.set(a, y, ring, 0); P.set(a, y, back || famName, -1); continue }
        // Внутри: стекло в глубине, ажур — в плоскости.
        const th = Math.atan2(dy, da)
        const sector = ((Math.round(th / (2 * Math.PI) * spokes) % spokes) + spokes) % spokes
        const onSpoke = r > 1.3 && Math.abs(Math.sin((th * spokes) / 2)) * r < 0.5
        const onRing = Math.abs(r - R * 0.5) < 0.5
        let col
        if (r < 1.3) col = colors[0]
        else if (r < R * 0.5) col = sector % 2 ? colors[2] : colors[1]
        else col = sector % 2 ? colors[3] : colors[4]
        P.set(a, y, `${col}_stained_glass_pane`, -1)
        if (r < 0.6) P.set(a, y, boss, 0)
        else P.set(a, y, (onSpoke || onRing) ? tr : '', 0)
      }
    }
  }

  // Пинакль: башенка на (x, y, z) — блок, стенка, стенка, концевой стержень.
  B.pinnacle = (x, y, z, f = 'tuff_bricks', h = 3, cap = null) => {
    g.set(x, y, z, cap || B.pinCap || 'chiseled_tuff_bricks')
    for (let i = 1; i < h; i++) g.set(x, y + i, z, wall(f))
    g.set(x, y + h, z, st('end_rod', { facing: 'up' }))
  }

  // Зубцы вдоль отрезка клеток cells (массив [x, z]) на высоте y: парапет
  // стеной семейства, зубец (полный блок + плита) через один.
  B.crenel = (cells, y, f = 'stone_bricks', { every = 2 }: any = {} as Record<string, any>) => {
    cells.forEach(([x, z]: any, i) => {
      if (i % every === 0) { g.set(x, y, z, f); g.set(x, y + 1, z, slab(f)) } else g.set(x, y, z, slab(f))
    })
  }

  // ---- круглые формы
  // Клетки кольца r0 < d ≤ r1 от центра (cx, cz) (центр клетки).
  B.disc = (cx, cz, r, fn) => {
    const R = Math.ceil(r + 1)
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) { const d = Math.hypot(dx, dz); if (d <= r) fn(cx + dx, cz + dz, d, dx, dz) }
  }
  B.ringCells = (cx, cz, r0, r1) => {
    const out = []
    const R = Math.ceil(r1 + 1)
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) { const d = Math.hypot(dx, dz); if (d > r0 && d <= r1) out.push([cx + dx, cz + dz, d, dx, dz]) }
    // По кругу — для зубцов через один.
    out.sort((p, q) => Math.atan2(p[4], p[3]) - Math.atan2(q[4], q[3]))
    return out
  }

  // Конус крыши: радиус r у основания yb, высота k·r; черепица семейства,
  // плиты на полушагах, свес — перевёрнутые ступени. Вершина — финиал.
  B.cone = (cx, cz, r, yb, k, f = 'deepslate_tiles', finial = 'lightning_rod') => {
    const top = yb + k * r
    const R = Math.ceil(r + 1)
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dz)
        if (d > r + 0.5) continue
        const h = top - k * Math.max(0, d - 0.35)
        const hi = Math.floor(h)
        const x = cx + dx; const z = cz + dz
        for (let y = yb; y < hi; y++) g.set(x, y, z, f)
        if (h - hi >= 0.5) g.set(x, hi, z, slab(f))
        if (d > r - 0.5) g.set(x, yb - 1, z, stairs(f, dirTo(dx, dz), 'top')) // свес-консоль, опорой к башне
      }
    }
    g.set(cx, Math.floor(top), cz, f)
    if (finial) g.set(cx, Math.floor(top) + 1, cz, finial === 'lightning_rod' ? st('lightning_rod', { facing: 'up', powered: 'false', waterlogged: 'false' }) : finial)
    return Math.floor(top) + 1
  }

  // Восьмигранный шпиль: у основания yb «радиус» r0, высота h; оболочка
  // семейства f, по рёбрам — краббы (ступени) через 3 блока, ажурные пояса
  // (решётки) через 6. Вершина — золотой шар и стержень.
  B.spire = (cx, cz, r0, yb, h, { f = 'oxidized_cut_copper', grate = 'oxidized_copper_grate', crocket = true, every = 3, cross = null }: any = {} as Record<string, any>) => {
    const inOct = (dx, dz, r) => Math.max(Math.abs(dx), Math.abs(dz)) <= r + 0.01 && Math.abs(dx) + Math.abs(dz) <= r * 1.42 + 0.01
    for (let y = yb; y < yb + h; y++) {
      const r = r0 * (1 - (y - yb) / h)
      const R = Math.ceil(r) + 1
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          if (!inOct(dx, dz, r)) continue
          const edge = !inOct(dx + 1, dz, r) || !inOct(dx - 1, dz, r) || !inOct(dx, dz + 1, r) || !inOct(dx, dz - 1, r)
          if (!edge && r > 1) continue
          const band = (y - yb) % 6 === 3 && r > 1.5
          g.set(cx + dx, y, cz + dz, band ? grate : f)
        }
      }
      if (crocket && (y - yb) % every === 1 && r > 1.2) {
        // Краббы — на восьми рёбрах: перевёрнутые ступени наружу.
        const ri = Math.floor(r)
        const pts = [[ri + 1, 0], [-ri - 1, 0], [0, ri + 1], [0, -ri - 1]]
        for (const [dx, dz] of pts) g.set(cx + dx, y, cz + dz, stairs(f, dirTo(-dx, -dz), 'top'))
      }
    }
    const yt = yb + h
    g.set(cx, yt, cz, 'gold_block')
    if (cross) {
      // Золотой крест на шаре: столб 4, перекладина на третьем, громоотвод.
      for (let i = 1; i <= 4; i++) g.set(cx, yt + i, cz, 'gold_block')
      const [ax, az] = cross === 'x' ? [1, 0] : [0, 1]
      g.set(cx + ax, yt + 3, cz + az, 'gold_block'); g.set(cx - ax, yt + 3, cz - az, 'gold_block')
      g.set(cx, yt + 5, cz, st('lightning_rod', { facing: 'up', powered: 'false', waterlogged: 'false' }))
      return yt + 5
    }
    g.set(cx, yt + 1, cz, st('lightning_rod', { facing: 'up', powered: 'false', waterlogged: 'false' }))
    g.set(cx, yt + 2, cz, st('lightning_rod', { facing: 'up', powered: 'false', waterlogged: 'false' }))
    return yt + 2
  }

  // Двускатная крыша над прямоугольником стен x0..x1 × z0..z1 (стены — до
  // ye − 1), конёк вдоль оси axis. Скат — ступени к коньку; slope 2 — ступень
  // на блоке (крутая готическая). Свес ov по скатам и торцам; торцевые стены
  // (фронтоны) — треугольник блока gable под скатом; ends: false — без
  // фронтонов (торец закрывает соседний объём). Возвращает высоту конька.
  B.gable = (x0, x1, z0, z1, axis, ye, { f = 'deepslate_tiles', slope = 1, gable = 'stone_bricks', ov = 1, ends = true, ridge = null, fillUnder = false }: any = {} as Record<string, any>) => {
    const w0 = axis === 'x' ? z0 : x0; const w1 = axis === 'x' ? z1 : x1
    const l0 = axis === 'x' ? x0 : z0; const l1 = axis === 'x' ? x1 : z1
    const mid = (w0 + w1) / 2
    const up = w => axis === 'x' ? (w < mid ? 'south' : 'north') : (w < mid ? 'east' : 'west')
    const at = (l, y, w, s) => axis === 'x' ? g.set(l, y, w, s) : g.set(w, y, l, s)
    const yTop = w => ye - 1 + (Math.min(w - (w0 - ov), (w1 + ov) - w)) * slope
    let top = ye
    for (let w = w0 - ov; w <= w1 + ov; w++) {
      const yt = yTop(w)
      const ridgeCell = Math.abs(w - mid) < 0.25
      for (let l = l0 - ov; l <= l1 + ov; l++) {
        if (ridgeCell) {
          at(l, yt - (slope === 2 ? 1 : 0), w, f); at(l, yt, w, f)
          at(l, yt + 1, w, ridge || slab(f))
          top = Math.max(top, yt + 1)
        } else {
          at(l, yt, w, stairs(f, up(w)))
          if (slope === 2) at(l, yt - 1, w, f)
          top = Math.max(top, yt)
        }
        if (fillUnder && l >= l0 && l <= l1 && w >= w0 && w <= w1) for (let y = ye; y < yt - (slope === 2 ? 1 : 0); y++) at(l, y, w, f)
      }
    }
    if (ends) {
      for (const l of [l0, l1]) {
        for (let w = w0; w <= w1; w++) {
          const yt = yTop(w)
          const under = Math.abs(w - mid) < 0.25 ? yt - (slope === 2 ? 1 : 0) : yt - (slope === 2 ? 1 : 0)
          for (let y = ye; y < under; y++) at(l, y, w, gable)
        }
      }
    }
    return top
  }

  // Односкатная (пристройка, приделы): вдоль axis, подъём в сторону upDir,
  // от yLow на краю low до выше, шаг slope.
  B.leanTo = (x0, x1, z0, z1, upDir, yLow, f = 'deepslate_tiles') => {
    const along = upDir === 'north' || upDir === 'south' ? 'z' : 'x'
    const [a0, a1] = along === 'z' ? [z0, z1] : [x0, x1]
    const sgn = (upDir === 'south' || upDir === 'east') ? 1 : -1
    const start = sgn > 0 ? a0 : a1
    for (let a = a0; a <= a1; a++) {
      const i = (a - start) * sgn
      const y = yLow + Math.floor(i / 2)
      const half = i % 2 === 1
      for (let b = (along === 'z' ? x0 : z0); b <= (along === 'z' ? x1 : z1); b++) {
        const [x, z] = along === 'z' ? [b, a] : [a, b]
        g.set(x, y, z, half ? stairs(f, upDir) : slab(f))
        for (let yy = yLow - 1; yy < y; yy++) if (!g.get(x, yy, z)) g.set(x, yy, z, f)
      }
    }
  }

  // Винтовая лестница в круглой башне: центр (cx, cz), внутренний радиус ri
  // (≥ 3.2), столб 3×3; 16 секторов, подъём rev за оборот полублоками,
  // две площадки. Старт — сектор площадки, обращённый к landDir.
  // Возвращает клетки площадок по уровням (для дверей).
  // Сектора: 16 по кругу, 0 и 1 — площадка с серединой на landDir (там
  // двери на каждом уровне: уровни через rev), 2..15 — полушаги вверх, по
  // ходу против часовой, если смотреть сверху. Поверхность площадки оборота
  // t — yBase + t·rev. Последняя площадка — yTop.
  B.spiral = (cx, cz, ri, yBase, yTop, { f = 'stone_bricks', rev = 7, landDir = 'north', newel = 'stone_bricks' }: any = {} as Record<string, any>) => {
    const land0 = { north: -Math.PI / 2, south: Math.PI / 2, east: 0, west: Math.PI }[landDir]
    const cells = []
    const R = Math.ceil(ri)
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (Math.hypot(dx, dz) > ri) continue
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue
        let th = Math.atan2(dz, dx) - land0 + Math.PI / 8 // середина площадки — граница секторов 0|1
        th = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
        cells.push({ x: cx + dx, z: cz + dz, sec: Math.floor(th / (2 * Math.PI) * 16) % 16 })
      }
    }
    for (let x = cx - 1; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++) B.column(x, z, yBase - 1, yTop + 2, newel)
    const put = (c, hs) => { // hs — высота поверхности в полублоках
      const yb = Math.floor(hs / 2)
      if (hs % 2 === 0) g.set(c.x, yb - 1, c.z, f); else g.set(c.x, yb, c.z, slab(f))
      return hs % 2 === 0 ? yb : yb + 1 // первая свободная клетка над ступенью
    }
    for (let t = 0; yBase + t * rev <= yTop; t++) {
      const base2 = (yBase + t * rev) * 2
      for (const c of cells) {
        const hs = c.sec <= 1 ? base2 : base2 + (c.sec - 1)
        if (hs > yTop * 2) continue
        const free = put(c, hs)
        for (let y = free; y < free + rev - 1; y++) g.set(c.x, y, c.z, '')
      }
    }
    return cells.filter(c => c.sec <= 1)
  }

  // Прямой марш: ступени от (x, z) в сторону dir, ширина width (в сторону
  // side), подъём rise с уровня y0 (поверхность); под ступенями — fill до
  // yFill; над — воздух (3). Возвращает клетку за последней ступенью.
  B.flight = (x, z, dir, width, side, y0, rise, { f = 'stone_bricks', fill = 'stone_bricks', yFill = null, clear = 4 }: any = {} as Record<string, any>) => {
    const [dx, dz] = DIR[dir]; const [sx, sz] = DIR[side]
    for (let i = 0; i < rise; i++) {
      for (let j = 0; j < width; j++) {
        const cx = x + dx * i + sx * j; const cz = z + dz * i + sz * j
        const y = y0 + i
        g.set(cx, y, cz, stairs(f, dir))
        const yb = yFill === null ? y0 - 1 : yFill
        for (let yy = yb; yy < y; yy++) g.set(cx, yy, cz, fill)
        for (let yy = y + 1; yy <= y + clear; yy++) g.set(cx, yy, cz, '')
      }
    }
    return [x + dx * rise, z + dz * rise]
  }

  // ---- мебель и детали
  B.doors = [] // для проверки проходов (castle-walk.js)
  B.door = (x, y, z, facing, mat = 'spruce_door', hinge = 'left') => {
    B.doors.push({ x, y, z, facing, mat })
    g.set(x, y, z, st(mat, { facing, half: 'lower', hinge, open: 'false', powered: 'false' }))
    g.set(x, y + 1, z, st(mat, { facing, half: 'upper', hinge, open: 'false', powered: 'false' }))
  }
  B.bed = (x, y, z, facing, color = 'red') => {
    const [dx, dz] = DIR[facing]
    g.set(x, y, z, st(`${color}_bed`, { facing, part: 'foot', occupied: 'false' }))
    g.set(x + dx, y, z + dz, st(`${color}_bed`, { facing, part: 'head', occupied: 'false' }))
  }
  // Двойной сундук: левая половина в (x, z), правая — по часовой от facing.
  B.chest2 = (x, y, z, facing, mat = 'chest') => {
    const [dx, dz] = DIR[CW[facing]]
    g.set(x, y, z, st(mat, { facing, type: 'left', waterlogged: 'false' }))
    g.set(x + dx, y, z + dz, st(mat, { facing, type: 'right', waterlogged: 'false' }))
  }
  B.chest = (x, y, z, facing, mat = 'chest') => g.set(x, y, z, st(mat, { facing, type: 'single', waterlogged: 'false' }))
  B.barrel = (x, y, z, facing = 'up') => g.set(x, y, z, st('barrel', { facing, open: 'false' }))
  B.torchWall = (x, y, z, facing) => g.set(x, y, z, st('wall_torch', { facing }))
  B.lanternHang = (x, y, z) => g.set(x, y, z, st('lantern', { hanging: 'true', waterlogged: 'false' }))
  B.lanternStand = (x, y, z) => g.set(x, y, z, st('lantern', { hanging: 'false', waterlogged: 'false' }))
  // Люстра: цепь от потолка (y — клетка под потолком) длиной n, фонарь,
  // по бокам — свечи на плитах не нужны: крест из фонарей.
  B.chandelier = (x, y, z, n = 2, cross = true) => {
    for (let i = 0; i < n; i++) g.set(x, y - i, z, st('iron_chain', { axis: 'y', waterlogged: 'false' }))
    const yl = y - n
    g.set(x, yl, z, st('lantern', { hanging: 'true', waterlogged: 'false' }))
    if (cross) {
      g.set(x, yl + 1, z, st('iron_chain', { axis: 'y', waterlogged: 'false' }))
      for (const [dx, dz, ax] of ([[1, 0, 'x'], [-1, 0, 'x'], [0, 1, 'z'], [0, -1, 'z']] as Array<any>)) {
        g.set(x + dx, yl + 1, z + dz, st('iron_chain', { axis: ax, waterlogged: 'false' }))
        g.set(x + dx * 2, yl + 1, z + dz * 2, st('iron_chain', { axis: ax, waterlogged: 'false' }))
        g.set(x + dx * 2, yl, z + dz * 2, st('lantern', { hanging: 'true', waterlogged: 'false' }))
      }
    }
  }
  B.candles = (x, y, z, n = 3, color = '') => g.set(x, y, z, st(color ? `${color}_candle` : 'candle', { candles: String(n), lit: 'true', waterlogged: 'false' }))
  // Стол: плиты сверху вдоль отрезка.
  B.table = (x0, z0, x1, z1, y, f = 'dark_oak_planks') => { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) g.set(x, y, z, slab(f, 'top')) }
  B.bench = (x0, z0, x1, z1, y, facing, f = 'spruce_planks') => { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) g.set(x, y, z, stairs(f, facing)) }
  // Ковёр — только на пустые клетки (не прорезать стены и мебель).
  B.carpet = (x0, z0, x1, z1, y, color = 'red') => { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) if (!g.get(x, y, z)) g.set(x, y, z, `${color}_carpet`) }
  B.sign = (x, y, z, facing, text, wood = 'spruce') => {
    g.set(x, y, z, st(`${wood}_wall_sign`, { facing, waterlogged: 'false' }))
    const lines = [].concat(text).slice(0, 4)
    while (lines.length < 4) lines.push('')
    B.nbt(x, y, z, `{front_text:{messages:[${lines.map(t => JSON.stringify(t)).join(',')}]}}`)
  }
  B.banner = (x, y, z, facing, color = 'red') => g.set(x, y, z, st(`${color}_wall_banner`, { facing }))
  B.pot = (x, y, z, plant = 'red_tulip') => g.set(x, y, z, `potted_${plant}`)
  return B
}

// Сторона света по вектору (x — восток, z — юг); inv — от центра наружу.
function dirTo (dx, dz, inv = false) {
  let d
  if (Math.abs(dx) >= Math.abs(dz)) d = dx >= 0 ? 'east' : 'west'
  else d = dz >= 0 ? 'south' : 'north'
  return inv ? d : OPP[d]
}

export { kit, hash, vnoise, vnoise3, fbm, FAM, stairs, slab, wall, DIR, OPP, CW, CCW, dirTo }
