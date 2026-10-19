'use strict'
// Чертёж: готовые виды — хижина, дом, комната, склад, замок.
import type { BlueprintPart } from './names'

// ---------------------------------------------------------------- kinds

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

// Хижина на первую ночь: коробка с плоской крышей, дверь (или проём), факел.
// Пол не кладём — земля и есть пол; только заделываем дыры под стенами.
export function hut (p, pal) {
  const W = clampInt(p.width, 3, 9, 5); const D = clampInt(p.depth, 3, 9, 5); const H = clampInt(p.height, 2, 4, 2)
  const mid = Math.floor(W / 2)
  const parts: BlueprintPart[] = [
    { type: 'seal', from: [0, -1, 0], to: [W - 1, 0, D - 1], block: pal.fill || pal.main, role: 'foundation' },
    { type: 'clear', from: [1, 1, 1], to: [W - 2, H, D - 2], role: 'inside' },
    { type: 'walls', from: [0, 1, 0], to: [W - 1, H, D - 1], block: pal.main, role: 'walls' },
    { type: 'floor', from: [0, H + 1, 0], to: [W - 1, H + 1, D - 1], block: pal.roofFlat || pal.main, role: 'roof' },
    { type: 'clear', from: [mid, 1, D - 1], to: [mid, 2, D], role: 'doorway' }
  ]
  if (pal.door) parts.push({ type: 'door', at: [mid, 1, D - 1], block: pal.door, facing: 'north', role: 'door', optional: true })
  if (pal.light && W >= 3 && D >= 3) parts.push({ type: 'torch', at: [mid, Math.min(2, H), 1], facing: 'south', block: pal.light, role: 'light', optional: true })
  return parts
}

// Дом: каркас из брёвен по углам, стены, пол, окна со стеклом, дверь в
// торце под фронтоном, двускатная крыша со свесом, свет внутри и у входа.
export function house (p, pal) {
  const W = clampInt(p.width, 5, 15, 7); const D = clampInt(p.depth, 5, 17, 9); const H = clampInt(p.height, 3, 6, 4)
  const mid = Math.floor(W / 2); const zm = Math.floor(D / 2)
  const style = String(p.roof || 'gable').toLowerCase()
  const parts: BlueprintPart[] = [
    { type: 'seal', from: [0, -2, 0], to: [W - 1, -1, D - 1], block: pal.fill || pal.main, role: 'foundation' },
    { type: 'clear', from: [1, 1, 1], to: [W - 2, H, D - 2], role: 'inside' },
    { type: 'floor', from: [0, 0, 0], to: [W - 1, 0, D - 1], block: pal.floor, role: 'floor' },
    { type: 'walls', from: [0, 1, 0], to: [W - 1, H, D - 1], block: pal.main, role: 'walls' }
  ]
  for (const [x, z] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) {
    parts.push({ type: 'line', from: [x, 1, z], to: [x, H, z], block: pal.frame, axis: 'y', role: 'frame' })
  }
  // Окна: по одному на боковых стенах и на задней, плюс по бокам от двери.
  const winTop = Math.min(H - 1, 3)
  if (pal.window) {
    const win = (from, to) => parts.push({ type: 'window', from, to, block: pal.window, role: 'window', optional: true })
    for (const z of D >= 8 ? [zm - 2, zm + 1] : [zm]) {
      win([0, 2, z], [0, winTop, z]); win([W - 1, 2, z], [W - 1, winTop, z])
    }
    win([mid, 2, 0], [mid, winTop, 0])
    if (W >= 7) { win([mid - 2, 2, D - 1], [mid - 2, 2, D - 1]); win([mid + 2, 2, D - 1], [mid + 2, 2, D - 1]) }
  }
  parts.push({ type: 'clear', from: [mid, 1, D - 1], to: [mid, 2, D], role: 'doorway' })
  if (pal.door) parts.push({ type: 'door', at: [mid, 1, D - 1], block: pal.door, facing: 'north', role: 'door', optional: true })
  // Крыша.
  const roofBlock = pal.stairs || pal.roofFill
  if (style === 'flat') {
    parts.push({ type: 'roof', style: 'flat', from: [0, H, 0], to: [W - 1, H, D - 1], block: roofBlock, flat: pal.slab || pal.roofFill, overhang: 0, role: 'roof' })
  } else {
    parts.push({
      type: 'roof',
      style: style === 'hip' ? 'hip' : 'gable',
      axis: 'z',
      from: [0, H, 0],
      to: [W - 1, H, D - 1],
      overhang: 1,
      block: roofBlock,
      ridge: pal.slab || pal.roofFill,
      gable: pal.frame !== pal.main ? pal.main : pal.roofFill,
      role: 'roof'
    })
  }
  if (pal.light) {
    const t = Math.min(H - 1, 3)
    // Не на zm: там окно, а факел на стекле не держится.
    parts.push({ type: 'torch', at: [1, t, 1], facing: 'east', block: pal.light, role: 'light', optional: true })
    parts.push({ type: 'torch', at: [W - 2, t, D - 2], facing: 'west', block: pal.light, role: 'light', optional: true })
    parts.push({ type: 'torch', at: [mid - 1, 2, D], facing: 'south', block: pal.light, role: 'light', optional: true })
  }
  if (p.furnish) {
    parts.push({ type: 'bed', at: [1, 1, 2], facing: 'north', block: pal.bed || 'red_bed', role: 'furniture', optional: true })
    parts.push({ type: 'chest', at: [W - 2, 1, 1], facing: 'south', role: 'furniture', optional: true })
    parts.push({ type: 'block', at: [W - 2, 1, 2], block: 'crafting_table', role: 'furniture', optional: true })
  }
  return parts
}

// Комната под землёй: землянка в склоне и база в шахте — одна форма. Своё
// держится за природу: оболочка из seal заделывает только дыры, а цельную
// породу не трогает. Фасад — юг: там проём (и дверь, если просили).
export function room (p, pal, { door = true, lights = 1 }: any = {}) {
  const W = clampInt(p.width, 3, 9, 3); const D = clampInt(p.depth, 3, 9, 4); const H = clampInt(p.height, 2, 4, 3)
  const mid = Math.floor(W / 2)
  const fill = pal.fill || pal.main
  const parts: BlueprintPart[] = [
    { type: 'clear', from: [0, 1, 0], to: [W - 1, H, D - 1], role: 'inside' },
    { type: 'seal', from: [-1, 0, -1], to: [W, H + 1, D], block: fill, role: 'shell' },
    { type: 'clear', from: [mid, 1, D], to: [mid, 2, D + 1], role: 'doorway' }
  ]
  if (door && pal.door) parts.push({ type: 'door', at: [mid, 1, D], block: pal.door, facing: 'north', role: 'door', optional: true })
  if (pal.light) {
    parts.push({ type: 'torch', at: [mid, 2, 0], facing: 'south', block: pal.light, role: 'light', optional: true })
    if (lights > 1 && W >= 3) {
      parts.push({ type: 'torch', at: [0, 2, Math.floor(D / 2)], facing: 'east', block: pal.light, role: 'light', optional: true })
      parts.push({ type: 'torch', at: [W - 1, 2, Math.floor(D / 2)], facing: 'west', block: pal.light, role: 'light', optional: true })
    }
  }
  if (p.furnish) {
    parts.push({ type: 'chest', at: [0, 1, 0], facing: 'east', role: 'furniture', optional: true })
    if (W >= 3) parts.push({ type: 'block', at: [W - 1, 1, 0], block: 'crafting_table', role: 'furniture', optional: true })
    if (W >= 4 || D >= 4) parts.push({ type: 'block', at: [W - 1, 1, 1], block: 'furnace', facing: 'west', role: 'furniture', optional: true })
    if (D >= 4) parts.push({ type: 'bed', at: [0, 1, 2], facing: 'north', block: pal.bed || 'red_bed', role: 'furniture', optional: true })
  }
  return parts
}

// Склад: ряд сундуков у задней стенки, между ними столбы из брёвен, над
// каждым сундуком — табличка с категорией на стенке, факелы на столбах.
// Табличка над сундуком, а не на его передней грани: ставить её на сундук
// можно только присев (иначе клик откроет сундук), а висящая над ним не мешает
// его открывать — ChestBlock.isChestBlockedAt смотрит только на блок, который
// проводит сигнал, а табличка его не проводит.
export function storage (p, pal, labels) {
  const cats = labels.length ? labels : [{ key: 'misc', lines: ['Разное'] }]
  const dbl = !!p.double
  const step = dbl ? 3 : 2
  const L = cats.length * step
  const parts: BlueprintPart[] = [
    { type: 'seal', from: [0, -1, -1], to: [L, 0, 1], block: pal.fill || pal.main, role: 'foundation' },
    { type: 'clear', from: [0, 1, 0], to: [L, 3, 1], role: 'inside' },
    { type: 'box', from: [0, 1, -1], to: [L, 3, -1], block: pal.main, role: 'walls' }
  ]
  cats.forEach((c, k) => {
    const x = k * step + 1
    parts.push({ type: 'chest', at: [x, 1, 0], facing: 'south', role: 'chest', label: c.key })
    if (dbl) parts.push({ type: 'chest', at: [x + 1, 1, 0], facing: 'south', role: 'chest', label: c.key })
    parts.push({ type: 'sign', at: [x, 2, 0], facing: 'south', text: c.lines, block: pal.sign, role: 'sign', optional: true, label: c.key })
  })
  for (let k = 0; k <= cats.length; k++) {
    parts.push({ type: 'line', from: [k * step, 1, 0], to: [k * step, 2, 0], block: pal.frame, axis: 'y', role: 'frame' })
    if (pal.light && k % 2 === 0) parts.push({ type: 'torch', at: [k * step, 3, 0], block: pal.light, role: 'light', optional: true })
  }
  return parts
}

// Замок: квадратная стена с зубцами, четыре угловые башни выше стены с
// зубцами поверху, ворота посреди фасада с аркой из перевёрнутых ступеней,
// лестница на стену изнутри, свет по стенам.
export function castle (p, pal) {
  let S = clampInt(p.width ?? p.size, 9, 31, 13)
  if (S % 2 === 0) S++
  const H = clampInt(p.height, 3, 8, 4)
  const T = S >= 15 ? 5 : 3
  const TH = H + 2
  const mid = (S - 1) / 2
  const g = S >= 13 ? 1 : 0
  const gh = Math.min(H - 1, g ? 3 : 2)
  const m = pal.main
  const parts: BlueprintPart[] = [
    { type: 'seal', from: [0, -1, 0], to: [S - 1, 0, S - 1], block: pal.fill || m, role: 'foundation' },
    // Двор расчищается ПЕРВЫМ: поздняя часть перекрывает раннюю, и стены с
    // башнями должны лечь поверх воздуха, а не наоборот.
    { type: 'clear', from: [1, 1, 1], to: [S - 2, H + 1, S - 2], role: 'yard' },
    // Стены между башнями.
    { type: 'box', from: [T, 1, 0], to: [S - 1 - T, H, 0], block: m, role: 'walls' },
    { type: 'box', from: [T, 1, S - 1], to: [S - 1 - T, H, S - 1], block: m, role: 'walls' },
    { type: 'box', from: [0, 1, T], to: [0, H, S - 1 - T], block: m, role: 'walls' },
    { type: 'box', from: [S - 1, 1, T], to: [S - 1, H, S - 1 - T], block: m, role: 'walls' },
    // Зубцы на стенах.
    { type: 'crenel', from: [T, H + 1, 0], to: [S - 1 - T, H + 1, 0], block: m, role: 'battlement' },
    { type: 'crenel', from: [T, H + 1, S - 1], to: [S - 1 - T, H + 1, S - 1], block: m, role: 'battlement' },
    { type: 'crenel', from: [0, H + 1, T], to: [0, H + 1, S - 1 - T], block: m, role: 'battlement' },
    { type: 'crenel', from: [S - 1, H + 1, T], to: [S - 1, H + 1, S - 1 - T], block: m, role: 'battlement' }
  ]
  // Башни: полые при T=5 (глухой колодец — дешевле сплошной вдвое), сплошные при T=3.
  for (const [x0, z0] of [[0, 0], [S - T, 0], [0, S - T], [S - T, S - T]]) {
    parts.push({ type: 'box', from: [x0, 1, z0], to: [x0 + T - 1, TH, z0 + T - 1], block: pal.frame || m, hollow: T >= 5, role: 'tower' })
    if (T >= 5) parts.push({ type: 'clear', from: [x0 + 1, 1, z0 + 1], to: [x0 + T - 2, TH - 1, z0 + T - 2], role: 'tower' })
    const top = TH + 1
    const ring = []
    for (let i = 0; i < T; i++) ring.push([x0 + i, z0])
    for (let i = 1; i < T; i++) ring.push([x0 + T - 1, z0 + i])
    for (let i = T - 2; i >= 0; i--) ring.push([x0 + i, z0 + T - 1])
    for (let i = T - 2; i >= 1; i--) ring.push([x0, z0 + i])
    ring.forEach(([x, z], i) => { if (i % 2 === 0) parts.push({ type: 'block', at: [x, top, z], block: m, role: 'battlement' }) })
  }
  // Ворота в южной стене и арка.
  parts.push({ type: 'clear', from: [mid - g, 1, S - 1], to: [mid + g, gh, S - 1], role: 'gate' })
  parts.push({ type: 'clear', from: [mid - g, 1, S], to: [mid + g, gh, S], role: 'gate' })
  if (g && pal.stairs && gh >= 3) {
    parts.push({ type: 'block', at: [mid - g, gh, S - 1], block: pal.stairs, facing: 'west', half: 'top', role: 'arch' })
    parts.push({ type: 'block', at: [mid + g, gh, S - 1], block: pal.stairs, facing: 'east', half: 'top', role: 'arch' })
  }
  // Лестница на северную стену изнутри.
  if (pal.ladder) parts.push({ type: 'ladder', from: [mid, 1, 1], to: [mid, H, 1], facing: 'south', role: 'ladder', optional: true })
  if (pal.light) {
    for (const x of [T + 1, S - 2 - T]) parts.push({ type: 'torch', at: [x, 2, 1], facing: 'south', block: pal.light, role: 'light', optional: true })
    for (const x of [mid - g - 1, mid + g + 1]) parts.push({ type: 'torch', at: [x, 2, S], facing: 'south', block: pal.light, role: 'light', optional: true })
  }
  return parts
}

export const KINDS = {
  hut: { ru: 'хижина-укрытие', make: hut, site: 'surface', roles: ['door', 'light'], defaults: { width: 5, depth: 5, height: 2 }, note: 'на первую ночь: плоская крыша, дверь или проём, факел' },
  house: { ru: 'дом', make: house, site: 'surface', roles: ['stairs', 'slab', 'frame', 'door', 'window', 'light'], defaults: { width: 7, depth: 9, height: 4, roof: 'gable' }, note: 'пол, каркас из брёвен, окна, дверь, двускатная (hip/flat) крыша со свесом, свет; furnish — кровать, сундук, верстак' },
  dugout: { ru: 'землянка', make: (p, pal) => room(p, pal, { door: true, lights: 1 }), site: 'hill', roles: ['door', 'light'], defaults: { width: 3, depth: 4, height: 3 }, note: 'комната, выкопанная в склоне: копает, заделывает дыры, дверь и факел' },
  mine_room: { ru: 'комната в шахте', make: (p, pal) => room({ ...p, width: p.width ?? 5, depth: p.depth ?? 5 }, pal, { door: !!p.door, lights: 3 }), site: 'ahead', roles: ['light'], defaults: { width: 5, depth: 5, height: 3 }, note: 'база под землёй прямо перед ботом: выкапывает, заделывает пещеры, факелы; furnish — сундук, верстак, печь, кровать' },
  storage: { ru: 'склад', make: null, site: 'surface', roles: ['frame', 'light'], defaults: { double: false }, note: 'ряд сундуков по категориям с табличками над каждым; потом mc_sort раскладывает' },
  castle: { ru: 'замок', make: castle, site: 'surface', roles: ['stairs', 'frame', 'light'], defaults: { width: 13, height: 4 }, note: 'стена с зубцами, угловые башни, ворота с аркой, лестница на стену' }
}
