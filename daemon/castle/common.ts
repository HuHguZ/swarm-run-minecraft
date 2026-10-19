'use strict'
// Общее для частей замка (castle.ts): палитры камня, ярусы, вершина и площадки,
// разметка дворца и собора, круглая башня и дерево.

import * as C from '../arena/colosseum'
import * as K from './kit'
const { st } = C
const { stairs, slab, wall, fbm, vnoise, vnoise3, hash, DIR, OPP, CW, CCW, dirTo } = K

const DEFAULTS = { seed: 11, cat: 'diorite', version: 1, trap: 'armed' }
// Камень собора: стены, тёсаный (цоколи, пояса), резной (капители), резной
// блок (тимпаны, центры роз), ажур (средники, балюстрады).
const CAT_PAL = {
  tuff: { T: 'tuff_bricks', TP: 'polished_tuff', TC: 'chiseled_tuff', TCB: 'chiseled_tuff_bricks', TW: 'tuff_brick_wall', TPW: 'polished_tuff_wall' },
  diorite: { T: 'polished_diorite', TP: 'smooth_quartz', TC: 'chiseled_quartz_block', TCB: 'chiseled_quartz_block', TW: 'diorite_wall', TPW: 'diorite_wall' },
  endstone: { T: 'end_stone_bricks', TP: 'smooth_sandstone', TC: 'chiseled_sandstone', TCB: 'chiseled_quartz_block', TW: 'end_stone_brick_wall', TPW: 'sandstone_wall' },
  quartz: { T: 'smooth_quartz', TP: 'quartz_block', TC: 'chiseled_quartz_block', TCB: 'quartz_pillar[axis=y]', TW: 'diorite_wall', TPW: 'diorite_wall' },
  stone: { T: 'stone_bricks', TP: 'polished_andesite', TC: 'chiseled_stone_bricks', TCB: 'chiseled_stone_bricks', TW: 'stone_brick_wall', TPW: 'andesite_wall' }
}
const LV = { S0: 2, S1: 16, S2: 30 }
const ZC = -9 // ось собора (z)
const DISK = 68 // радиус модели (море вокруг)

const smoothstep = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }

// Знаковое расстояние до скруглённого прямоугольника (радиусы по углам).
function sdRoundRect (x, z, x0, z0, x1, z1, r) {
  const cx = (x0 + x1) / 2; const cz = (z0 + z1) / 2; const hx = (x1 - x0) / 2; const hz = (z1 - z0) / 2
  const px = x - cx; const pz = z - cz
  const rr = px < 0 ? (pz < 0 ? r.nw : r.sw) : (pz < 0 ? r.ne : r.se)
  const qx = Math.abs(px) - hx + rr; const qz = Math.abs(pz) - hz + rr
  return Math.min(Math.max(qx, qz), 0) + Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) - rr
}

// Плато вершины.
const SUMMIT = { x0: -49, z0: -33, x1: 43, z1: 15, r: { nw: 12, ne: 14, se: 6, sw: 2 } }
const summitSd = (x, z) => sdRoundRect(x, z, SUMMIT.x0, SUMMIT.z0, SUMMIT.x1, SUMMIT.z1, SUMMIT.r)

// Ровные площадки (верх — y блока пола; пол — top + 1).
const ZONES = [
  { name: 'S1', x0: -49, x1: 44, z0: 28, z1: 36, top: LV.S1 - 1, edge: 'crenel' },
  { name: 'palace', x0: -30, x1: 26, z0: 16, z1: 27, top: LV.S1 - 1, edge: null },
  { name: 'S0', x0: -43, x1: 39, z0: 37, z1: 47, top: LV.S0 - 1, edge: null },
  { name: 'landW', x0: -49, x1: -44, z0: 14, z1: 17, top: LV.S2 - 1, edge: 'crenel' }
]
const zoneAt = (x, z) => ZONES.find(q => x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1) || null

// ================================================================ части

// Круглая башня: центр (cx, cz), внешний радиус r, стена от земли до yTop,
// полы на floors (y блока пола), машикули и зубцы (crenel) или конус (cone),
// окна-бойницы: [{ y, h, angles: [рад] }], двери: [{ y, dir }].
function roundTower (ctx, o) {
  const { B, Hat } = ctx
  const { cx, cz, r, yTop } = o
  const f = o.f || 'stone_bricks'
  const inner = r - 1.2
  const R = Math.ceil(r + 2)
  const ground = (x, z) => { const h = Hat(x, z); return h === -999 ? -18 : h }
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dz)
      if (d > r) continue
      const x = cx + dx; const z = cz + dz
      const y0 = Math.min(ground(x, z), o.yBase !== undefined ? o.yBase : 99)
      const isWall = d > inner
      for (let y = y0 - 1; y <= yTop; y++) {
        if (isWall) B.S(x, y, z, o.mat ? o.mat(x, y, z) : ctx.masonry(x, y, z))
        else if (y >= (o.yFloor0 !== undefined ? o.yFloor0 : y0 + 1)) B.S(x, y, z, '')
        else B.S(x, y, z, o.core || 'stone_bricks')
      }
      if (!isWall) {
        for (const fy of (o.floors || [])) B.S(x, fy, z, o.floorMat || 'spruce_planks')
        B.S(x, yTop, z, o.roofFloor || 'stone_bricks')
      }
    }
  }
  // Бойницы и окна.
  for (const w of (o.windows || [])) {
    for (const a of w.angles) {
      const ex = Math.round(cx + Math.cos(a) * (r - 0.5)); const ez = Math.round(cz + Math.sin(a) * (r - 0.5))
      const ix = Math.round(cx + Math.cos(a) * (r - 1.5)); const iz = Math.round(cz + Math.sin(a) * (r - 1.5))
      for (let y = w.y; y < w.y + w.h; y++) { B.S(ex, y, ez, w.glass || 'glass_pane'); if (Math.hypot(ix - cx, iz - cz) > inner) B.S(ix, y, iz, '') }
      B.S(ex, w.y + w.h, ez, stairs(f, dirTo(ex - cx, ez - cz, true), 'top'))
    }
  }
  // Двери наружу.
  for (const dd of (o.doors || [])) {
    const [ux, uz] = DIR[dd.dir]
    for (let k = Math.floor(r - 1.5); k <= Math.ceil(r); k++) {
      const x = cx + ux * k; const z = cz + uz * k
      B.S(x, dd.y, z, ''); B.S(x, dd.y + 1, z, ''); B.S(x, dd.y + 2, z, '')
    }
    const x = cx + ux * Math.round(r - 0.5); const z = cz + uz * Math.round(r - 0.5)
    if (dd.door !== false) B.door(x, dd.y, z, dd.dir, dd.mat || 'spruce_door')
    B.S(x, dd.y + 2, z, stairs(f, OPP[dd.dir], 'top'))
  }
  // Лестница-стремянка по внутренней стене — с нижнего яруса на верхние (и
  // на боевую площадку, если нет конуса). Угол — подальше от окон и дверей.
  const floors = (o.floors || []).slice().sort((a, b) => a - b)
  if (o.ladder !== false && floors.length) {
    const busy = []
    for (const w of (o.windows || [])) busy.push(...w.angles)
    for (const dd of (o.doors || [])) busy.push({ east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 }[dd.dir])
    let best = 0; let bestD = -1
    for (let k = 0; k < 4; k++) { // по осям: клетка у стены ровно за лучом
      const a = k * Math.PI / 2
      const d = Math.min(...busy.map(b => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))), 9)
      if (d > bestD) { bestD = d; best = a }
    }
    // Клетка у стены: ближайшая к лучу внутренняя клетка, за ней — стена.
    const [ux, uz] = Math.abs(Math.cos(best)) >= Math.abs(Math.sin(best)) ? [Math.sign(Math.cos(best)), 0] : [0, Math.sign(Math.sin(best))]
    let k = 0
    while (Math.hypot(ux * (k + 1), uz * (k + 1)) <= inner) k++
    const lx = cx + ux * k; const lz = cz + uz * k
    const face = dirTo(-ux, -uz, true) // лицом к центру
    const y0 = o.yFloor0 !== undefined ? o.yFloor0 : floors[0]
    const y1 = o.cone ? floors[floors.length - 1] : yTop
    for (let y = y0; y <= y1; y++) B.S(lx, y, lz, st('ladder', { facing: face, waterlogged: 'false' }))
  }
  // Верх: машикули (консоли на r..r+1 под парапетом) и зубцы — или конус.
  if (o.crenel !== false) {
    const ring = B.ringCells(cx, cz, r, r + 1)
    ring.forEach(([x, z, d, dx, dz]: any, i) => {
      B.S(x, yTop - 1, z, stairs(f, dirTo(dx, dz), 'top'))
      B.S(x, yTop, z, i % 2 ? f : slab(f, 'top'))
      if (!o.cone) { B.S(x, yTop + 1, z, f); if (i % 2 === 0) B.S(x, yTop + 2, z, slab(f)) }
    })
  }
  if (o.cone) B.cone(cx, cz, r + (o.crenel === false ? 1 : 1.5), yTop + 1, o.cone.k || 2, o.cone.f || 'deepslate_tiles')
}

function tree (B, x, y, z, kind = 'oak', h = 4) {
  for (let i = 0; i < h; i++) B.S(x, y + i, z, st(`${kind}_log`, { axis: 'y' }))
  const leaves = st(`${kind}_leaves`, { distance: '1', persistent: 'true', waterlogged: 'false' })
  for (let dy = -1; dy <= 2; dy++) {
    const r = dy === 2 ? 1 : dy === -1 ? 2 : 2.4
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        if (Math.hypot(dx, dz) > r) continue
        const yy = y + h - 1 + dy
        if (dx === 0 && dz === 0 && dy < 1) continue
        if (!B.G(x + dx, yy, z + dz)) B.S(x + dx, yy, z + dz, leaves)
      }
    }
  }
}

// Дворец (разметка; постройка — palace.ts).
const PAL = { x0: -30, x1: 26, zN: 16, zS: 27, A: 16, Bf: 23, Cf: 30, top: 38 }

// Разметка (x — запад → восток): башни x −37..−27; неф — опоры x −26, −20,
// −14, −8; средокрестие −2..10; хор — опоры 10, 16, 22; апсида — центр
// (22, ZC), обход до r 11. Поперёк: неф |dz| ≤ 5, аркада |dz| = 6, приделы
// 7..10, стены 11, контрфорсы 12..14. Пол 30; своды нефа 50..55, крыша 2:1
// до ~67; средокрестие — башня до 77 и шпиль; западные башни до 80.
const CAT = { xW: -37, xT: -27, piers: [-26, -20, -14, -8], xC0: -2, xC1: 10, choir: [10, 16, 22], ax: 22, F: 30 }

export { st, stairs, slab, wall, fbm, vnoise, vnoise3, hash, DIR, OPP, CW, CCW, dirTo, DEFAULTS, CAT_PAL, LV, ZC, DISK, smoothstep, sdRoundRect, SUMMIT, summitSd, ZONES, zoneAt, PAL, CAT, roundTower, tree }
