'use strict'
import { REPO_ROOT } from '../src/paths'
// Рендер воксельной модели (Grid из colosseum.js) в PNG без игры.
//
// Геометрия блоков — модели prismarine-viewer (blocksStates 1.21.4: элементы
// с UV, повороты элементов и вариантов, multipart со стенами/заборами/
// панелями) — то же, из чего вьювер строит меши. Блоки без геометрии в
// модели (сундуки, кровати, таблички, флаги, вода) — своими коробками.
// Растеризация своя, ортографическая: z-буфер, альфа-тест, полупрозрачное
// (вода, витражи) вторым проходом от дальнего к ближнему, тени от солнца
// картой теней, AO по соседним кубам (как у вьювера), ночь — по блочному
// свету (colosseum-light.blockLight).
//
//   node voxel-render.js <модуль> out.png [--az 35] [--el 30] [--scale 6] [--ss 2]
//        [--cut x>0|z<-3] [--ylim 40] [--ymin 0] [--crop x0,z0,x1,z1] [--night]
//        [--sunaz 85] [--sunel 40] [--opts '{"json":1}']
// Модуль — путь от daemon/arena/ (colosseum, ../castle/castle) к файлу с model(opts) → { g }.

import path = require('path')
import * as C from './colosseum'

const PV = path.join(REPO_ROOT, 'daemon/node_modules/prismarine-viewer/public')
const STATES = require(path.join(PV, 'blocksStates/1.21.4.json'))
const ATLAS = path.join(PV, 'textures/1.21.4.png')
const ALIAS = { iron_chain: 'chain' } // переименован в 1.21.9, в атласе 1.21.4 — chain

// ------------------------------------------------------------- варианты

function matchProps (props, when) {
  if (!when) return true
  if (typeof when === 'string') {
    const o: Record<string, any> = {} as Record<string, any>
    for (const kv of when.split(',')) { if (!kv) continue; const [k, v] = kv.split('='); o[k] = v }
    when = o
  }
  if (when.OR) return when.OR.some(w => matchProps(props, w))
  if (when.AND) return when.AND.every(w => matchProps(props, w))
  for (const k of Object.keys(when)) {
    const want = String(when[k]).split('|')
    const have = props[k] === undefined ? null : String(props[k])
    if (have === null) continue // свойство не задано — берём первый подходящий
    if (!want.includes(have)) return false
  }
  return true
}

function variantsOf (name, props) {
  const st = STATES[ALIAS[name] || name]
  if (!st) return null
  if (st.variants) {
    for (const [k, v] of Object.entries<any>(st.variants)) {
      if (matchProps(props, k)) return [Array.isArray(v) ? v[0] : v]
    }
    const v = Object.values<any>(st.variants)[0]
    return [Array.isArray(v) ? v[0] : v]
  }
  if (st.multipart) {
    const out = []
    for (const part of st.multipart) {
      if (!matchProps(props, part.when)) continue
      if (Array.isArray(part.apply)) out.push(part.apply[0]); else out.push(part.apply)
    }
    return out
  }
  return null
}

// ------------------------------------------------------------ математика

const rotM = (axis, deg) => {
  const r = deg / 180 * Math.PI; const c = Math.cos(r); const s = Math.sin(r)
  const a0 = { x: 0, y: 1, z: 2 }[axis]; const a1 = (a0 + 1) % 3; const a2 = (a0 + 2) % 3
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  m[a0][a0] = 1; m[a1][a1] = c; m[a1][a2] = -s; m[a2][a1] = s; m[a2][a2] = c
  return m
}
const mulMV = (m, v) => m ? [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]] : v
const mulMM = (a, b) => {
  const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
  return o
}
const add3 = (a, b) => b ? [a[0] + b[0], a[1] + b[1], a[2] + b[2]] : a
const sub3 = (a, b) => b ? [a[0] - b[0], a[1] - b[1], a[2] - b[2]] : a

// Углы граней — как во вьювере (models.js elemFaces): [x?, y?, z?, u, v].
const FACES = {
  up: { dir: [0, 1, 0], m1: [1, 1, 0], m2: [0, 1, 1], c: [[0, 1, 1, 0, 1], [1, 1, 1, 1, 1], [0, 1, 0, 0, 0], [1, 1, 0, 1, 0]] },
  down: { dir: [0, -1, 0], m1: [1, 1, 0], m2: [0, 1, 1], c: [[1, 0, 1, 0, 1], [0, 0, 1, 1, 1], [1, 0, 0, 0, 0], [0, 0, 0, 1, 0]] },
  east: { dir: [1, 0, 0], m1: [1, 1, 0], m2: [1, 0, 1], c: [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]] },
  west: { dir: [-1, 0, 0], m1: [1, 1, 0], m2: [1, 0, 1], c: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]] },
  north: { dir: [0, 0, -1], m1: [1, 0, 1], m2: [0, 1, 1], c: [[1, 0, 0, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 1, 0, 1, 0]] },
  south: { dir: [0, 0, 1], m1: [1, 0, 1], m2: [0, 1, 1], c: [[0, 0, 1, 0, 1], [1, 0, 1, 1, 1], [0, 1, 1, 0, 0], [1, 1, 1, 1, 0]] }
}

// Оттенки (равнины).
const TINT = {
  grass: [0.57, 0.74, 0.35], foliage: [0.47, 0.67, 0.18], spruce: [0.38, 0.6, 0.38], birch: [0.5, 0.65, 0.33], water: [0.25, 0.46, 0.89]
}

// Цвет шерсти для кроватей и флагов — текстура шерсти этого цвета.
const COLORS16 = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const colorOf = name => COLORS16.find(c => name.startsWith(c + '_')) || 'white'

// ---------------------------------------------------- геометрия состояния

// Текстура-«плитка» по имени блока (для своих коробок).
function texOf (name, key = 'all') {
  const v = variantsOf(name, {} as Record<string, any>)
  if (!v || !v[0] || !v[0].model) return null
  const t = v[0].model.textures || {} as Record<string, any>
  return t[key] || t.all || t.side || t.texture || t.particle || Object.values<any>(t)[0]
}

// Коробка [x0,y0,z0,x1,y1,z1] в 1/16 с одной текстурой на все грани (или
// {up, down, side}) → элемент в формате модели.
function boxEl (b, tex, opts: any = {} as Record<string, any>) {
  const faces: Record<string, any> = {} as Record<string, any>
  for (const f of Object.keys(FACES)) {
    const t = typeof tex === 'object' && !tex.u ? (f === 'up' ? tex.up : f === 'down' ? tex.down : tex.side) : tex
    if (!t) continue
    faces[f] = { texture: t, cullface: opts.cull ? f : undefined }
  }
  return { from: [b[0], b[1], b[2]], to: [b[3], b[4], b[5]], faces }
}

// Элементы для блоков без геометрии в модели вьювера.
function specialElements (name, props) {
  const R = f => ({ north: 0, east: 90, south: 180, west: 270 })[f] || 0
  if (/^(chest|trapped_chest|ender_chest)$/.test(name)) {
    const body = name === 'ender_chest' ? texOf('obsidian') : texOf('oak_planks')
    const top = name === 'ender_chest' ? texOf('obsidian') : texOf('stripped_oak_log', 'end') || body
    let x0 = 1; let x1 = 15
    // Двойной: половина тянется к соседу. Сосед LEFT — по часовой от facing
    // (ChestBlock.getConnectedDirection); модель рисуем в системе facing=north,
    // там по часовой — восток.
    if (props.type === 'left') x1 = 16
    if (props.type === 'right') x0 = 0
    const els = [boxEl([x0, 0, 1, x1, 14, 15], { up: top, down: body, side: body }), boxEl([x0, 9, 0.6, x1, 10, 15], texOf('spruce_planks'))]
    if (props.type !== 'left') els.push(boxEl([props.type === 'right' ? 15 : 7, 7, 0, props.type === 'right' ? 16 : 9, 11, 1], texOf('iron_block')))
    return { els, y: R(props.facing || 'north') }
  }
  if (/_bed$/.test(name)) {
    const wool = texOf(colorOf(name) + '_wool')
    const els = [boxEl([0, 3, 0, 16, 9, 16], wool)]
    // В системе facing=north изголовье — к северу (z = 0).
    if (props.part === 'head') els.push(boxEl([2, 9, 1, 14, 11, 7], texOf('white_wool')))
    const leg = texOf('dark_oak_planks')
    for (const [lx, lz] of [[0, 0], [13, 0], [0, 13], [13, 13]]) {
      const near = props.part === 'head' ? lz === 0 : lz === 13
      if (near) els.push(boxEl([lx, 0, lz, lx + 3, 3, lz + 3], leg))
    }
    return { els, y: R(props.facing || 'north') }
  }
  if (/_wall_banner$/.test(name)) {
    const wool = texOf(colorOf(name) + '_wool')
    return { els: [boxEl([1, -14, 14, 15, 14, 15.5], wool), boxEl([0, 13, 13.5, 16, 14, 16], texOf('oak_planks'))], y: R(props.facing || 'north') }
  }
  if (/_banner$/.test(name)) {
    const wool = texOf(colorOf(name) + '_wool')
    const rot = Number(props.rotation || 0) * 22.5
    return { els: [boxEl([7, 0, 7, 9, 30, 9], texOf('oak_planks')), boxEl([1, 2, 6.5, 15, 29, 7.5], wool), boxEl([0, 29, 6, 16, 30, 8], texOf('oak_planks'))], y: rot, free: true }
  }
  if (/_wall_sign$/.test(name)) {
    const wood = name.replace(/_wall_sign$/, '')
    return { els: [boxEl([0, 4.5, 14, 16, 12.5, 16], texOf(wood + '_planks') || texOf('oak_planks'))], y: R(props.facing || 'north') }
  }
  if (/_sign$/.test(name) && !/hanging/.test(name)) {
    const wood = name.replace(/_sign$/, '')
    return { els: [boxEl([7.5, 0, 7.5, 8.5, 9, 8.5], texOf('stripped_' + wood + '_log') || texOf('oak_planks')), boxEl([0, 9, 7, 16, 17, 9], texOf(wood + '_planks') || texOf('oak_planks'))], y: Number(props.rotation || 0) * 22.5, free: true }
  }
  if (name === 'decorated_pot') return { els: [boxEl([1, 0, 1, 15, 13, 15], texOf('terracotta')), boxEl([4, 13, 4, 12, 16, 12], texOf('terracotta'))], y: 0 }
  if (/_head$|_skull$/.test(name)) return { els: [boxEl([4, 0, 4, 12, 8, 12], texOf('bone_block', 'side') || texOf('white_concrete'))], y: 0 }
  return null
}

const DIRV = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] }

// Все четырёхугольники состояния в координатах блока (0..1).
function stateGeometry (s) {
  const { name, props } = C.parse(s)
  const out: Record<string, any> = { quads: [], opaque: false, translucent: false, water: false, invisible: false, missing: false }
  if (!s || name === 'air' || name === 'light' || name === 'barrier' || name === 'structure_void' || name === 'cave_air') { out.invisible = true; return out }
  if (name === 'water' || name === 'bubble_column') { out.water = true; out.translucent = true; return out }
  if (name === 'lava') { out.lava = true; return out }
  out.translucent = /stained_glass|^ice$|slime_block|honey_block|tinted_glass/.test(name)
  let variants = variantsOf(name, props)
  let els = null; let globalY = 0; let free = false
  const sp = specialElements(name, props)
  if (sp) { els = sp.els; globalY = sp.y; free = !!sp.free; variants = [{ model: { elements: els, ao: true }, y: globalY }] }
  if (!variants) { out.missing = true; variants = [{ model: { elements: [boxEl([0, 0, 0, 16, 16, 16], texOf('magenta_concrete'))], ao: true } }] }
  const tintOf = () => {
    if (/spruce_leaves/.test(name)) return TINT.spruce
    if (/birch_leaves/.test(name)) return TINT.birch
    if (/leaves|vine/.test(name)) return TINT.foliage
    if (name === 'lily_pad') return [0.13, 0.5, 0.19]
    return TINT.grass
  }
  let fullCount = 0
  for (const variant of variants) {
    if (!variant || !variant.model) continue
    let gm = null
    for (const axis of ['x', 'y', 'z']) {
      if (axis in variant && variant[axis]) {
        const m = rotM(axis, -variant[axis])
        gm = gm ? mulMM(gm, m) : m
      }
    }
    if (free && globalY) gm = rotM('y', -globalY)
    const gshift = gm ? sub3([8, 8, 8], mulMV(gm, [8, 8, 8])) : null
    for (const el of (variant.model.elements || [])) {
      if (el.from.join() === '0,0,0' && el.to.join() === '16,16,16' && !el.rotation) fullCount++
      let lm = null; let lshift = null
      if (el.rotation) {
        lm = rotM(el.rotation.axis, el.rotation.angle)
        lshift = sub3(el.rotation.origin, mulMV(lm, el.rotation.origin))
      }
      for (const fname of Object.keys(el.faces || {} as Record<string, any>)) {
        const ef = el.faces[fname]
        if (!ef || !ef.texture || ef.texture.u === undefined) continue
        const F = FACES[fname]
        const dir = mulMV(gm, mulMV(lm, F.dir))
        const r = ef.rotation || 0
        const cs = Math.cos(r * Math.PI / 180); const sn = -Math.sin(r * Math.PI / 180)
        const { u, v, su, sv } = ef.texture
        const p = []; const uv = []; const ao = []
        for (const c of F.c) {
          let vert = [c[0] ? el.to[0] : el.from[0], c[1] ? el.to[1] : el.from[1], c[2] ? el.to[2] : el.from[2]]
          vert = add3(mulMV(lm, vert), lshift)
          vert = add3(mulMV(gm, vert), gshift)
          p.push(vert[0] / 16, vert[1] / 16, vert[2] / 16)
          const bu = (c[3] - 0.5) * cs - (c[4] - 0.5) * sn + 0.5
          const bv = (c[3] - 0.5) * sn + (c[4] - 0.5) * cs + 0.5
          uv.push(bu * su + u, bv * sv + v)
          const dx = c[0] * 2 - 1; const dy = c[1] * 2 - 1; const dz = c[2] * 2 - 1
          const rr = w => mulMV(gm, w).map(Math.round)
          ao.push(rr([dx * F.m1[0], dy * F.m1[1], dz * F.m1[2]]), rr([dx * F.m2[0], dy * F.m2[1], dz * F.m2[2]]), rr([dx, dy, dz]))
        }
        // Плитка атласа (для зажима выборки).
        const us = uv.filter((_, i) => i % 2 === 0); const vs = uv.filter((_, i) => i % 2 === 1)
        const tile = [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)]
        let cull = -1
        if (ef.cullface) {
          const cd = mulMV(gm, DIRV[ef.cullface]).map(Math.round)
          cull = cd
        }
        const tint = ef.tintindex !== undefined ? tintOf() : null
        const n = dir
        out.quads.push({ p, uv, n, cull, tint, tile, ao, shade: el.shade !== false, doAO: variant.model.ao !== false })
      }
    }
  }
  out.opaque = fullCount > 0 && C.isFullCube(s) && !out.translucent && !/glass|leaves|grate|spawner|^ice$|barrier|scaffolding|mangrove_roots|chorus/.test(name)
  out.glow = false
  return out
}

// --------------------------------------------------------------- рендер

async function render (g, opt: any = {} as Record<string, any>) {
  const { createCanvas, loadImage }: typeof import('canvas') = require('canvas')
  const az = (opt.az ?? 35) * Math.PI / 180
  const el = (opt.el ?? 30) * Math.PI / 180
  const ss = opt.ss || 1
  const scale = (opt.scale || 6) * ss
  const sunAz = (opt.sunaz ?? ((opt.az ?? 35) + 50)) * Math.PI / 180
  const sunEl = (opt.sunel ?? 42) * Math.PI / 180
  const night = !!opt.night
  const skirt = opt.skirt !== false
  const mcData = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')

  // Отбор клеток (срез, кадр по высоте, окно).
  let keep: any = () => true
  {
    const conds = []
    if (opt.cut) {
      for (const part of String(opt.cut).split('|')) {
        const mm = part.match(/^([xyz])([<>])(-?\d+)$/)
        if (mm) { const ax = mm[1]; const gt = mm[2] === '>'; const v = Number(mm[3]); conds.push((x, y, z) => { const a = ax === 'x' ? x : ax === 'y' ? y : z; return gt ? a > v : a < v }) }
      }
    }
    const cutAny = conds.length ? (x, y, z) => conds.some(f => f(x, y, z)) : null
    const crop = opt.crop ? String(opt.crop).split(',').map(Number) : null
    const ylim = opt.ylim !== undefined ? Number(opt.ylim) : null
    const ymin = opt.ymin !== undefined ? Number(opt.ymin) : null
    keep = (x, y, z) => {
      if (cutAny && cutAny(x, y, z)) return false
      if (crop && (x < crop[0] || x > crop[2] || z < crop[1] || z > crop[3])) return false
      if (ylim !== null && y > ylim) return false
      if (ymin !== null && y < ymin) return false
      return true
    }
  }

  // Геометрия палитры.
  const geo = g.pal.map(s => stateGeometry(s))
  const missing = [...new Set(g.pal.filter((s, i) => geo[i].missing).map(s => C.parse(s).name))]
  if (missing.length) console.warn('нет модели: ' + missing.join(' '))
  const emit = new Uint8Array(g.pal.length)
  g.pal.forEach((s, i) => { if (!s) return; const b = mcData.blocksByName[C.parse(s).name]; if (b && b.emitLight) emit[i] = b.emitLight; const nm = C.parse(s).name; if (/_candle$|^candle$|candles/.test(nm) && C.parse(s).props.lit !== 'true') emit[i] = 0; if (/furnace|smoker|campfire|redstone_lamp|copper_bulb/.test(nm) && C.parse(s).props.lit === 'false') emit[i] = 0 })

  const at = (x, y, z) => (g.in(x, y, z) && keep(x, y, z)) ? g.data[g.i(x, y, z)] : 0
  const opaqueAt = (x, y, z) => { const v = at(x, y, z); return v !== 0 && geo[v].opaque }

  // Блочный свет для ночи.
  let L = null
  if (night) {
    const LG: typeof import('./colosseum-light') = require('./colosseum-light')
    L = LG.blockLight(g, LG.tables(g))
  }

  // Камера.
  const basis = (a, e) => {
    const f = [-Math.sin(a) * Math.cos(e), -Math.sin(e), -Math.cos(a) * Math.cos(e)]
    const r = [Math.cos(a), 0, -Math.sin(a)]
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
    return { f, r, u }
  }
  const cam = basis(az, el)
  const sun = basis(sunAz, sunEl)
  const toSun = sun.f.map(v => -v)

  // Габарит занятого (для размера кадра).
  let bx0 = Infinity; let bx1 = -Infinity; let by0 = Infinity; let by1 = -Infinity; let bz0 = Infinity; let bz1 = -Infinity
  for (let y = g.y0; y <= g.y1; y++) {
    for (let z = g.z0; z <= g.z1; z++) {
      for (let x = g.x0; x <= g.x1; x++) {
        const v = g.data[g.i(x, y, z)]
        if (!v || geo[v].invisible || !keep(x, y, z)) continue
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z
      }
    }
  }
  if (bx0 === Infinity) throw new Error('пусто')
  bx1++; by1 += 2; bz1++ // флаги выше клетки
  const corners = []
  for (const x of [bx0, bx1]) for (const y of [by0, by1]) for (const z of [bz0, bz1]) corners.push([x, y, z])
  const proj = (b, p) => [p[0] * b.r[0] + p[1] * b.r[1] + p[2] * b.r[2], -(p[0] * b.u[0] + p[1] * b.u[1] + p[2] * b.u[2]), p[0] * b.f[0] + p[1] * b.f[1] + p[2] * b.f[2]]
  const frame = (b, sc, pad) => {
    let a0 = Infinity; let a1 = -Infinity; let c0 = Infinity; let c1 = -Infinity
    for (const p of corners) { const q = proj(b, p); if (q[0] < a0) a0 = q[0]; if (q[0] > a1) a1 = q[0]; if (q[1] < c0) c0 = q[1]; if (q[1] > c1) c1 = q[1] }
    return { ox: -a0 * sc + pad, oy: -c0 * sc + pad, W: Math.ceil((a1 - a0) * sc + 2 * pad), H: Math.ceil((c1 - c0) * sc + 2 * pad), sc }
  }

  const atlasImg = await loadImage(ATLAS)
  const ac = createCanvas(atlasImg.width, atlasImg.height)
  ac.getContext('2d').drawImage(atlasImg, 0, 0)
  const AW = atlasImg.width; const AH = atlasImg.height
  const A = ac.getContext('2d').getImageData(0, 0, AW, AH).data

  // Обход сцены: для каждой видимой грани — cb(quad мировой, v, клетка).
  const walk = (viewF, cb, wantTranslucent?: any) => {
    for (let y = g.y0; y <= g.y1; y++) {
      for (let z = g.z0; z <= g.z1; z++) {
        for (let x = g.x0; x <= g.x1; x++) {
          const v = g.data[g.i(x, y, z)]
          if (!v) continue
          const G = geo[v]
          if (G.invisible || !keep(x, y, z)) continue
          if (G.water) {
            if (wantTranslucent === false) continue
            waterFaces(x, y, z, v, viewF, cb)
            continue
          }
          if (G.lava) continue
          if (wantTranslucent !== undefined && G.translucent !== wantTranslucent) continue
          for (const q of G.quads) {
            if (q.n[0] * viewF[0] + q.n[1] * viewF[1] + q.n[2] * viewF[2] >= -1e-6) continue
            if (skirt && y < 0 && q.n[1] < 0.5) {
              // Край модели под водой (срез диска) — не рисуем «стакан».
              const nx = x + Math.round(q.n[0]); const nz = z + Math.round(q.n[2])
              if (!at(nx, y, nz) && (q.cull !== -1 || Math.abs(q.n[0]) + Math.abs(q.n[2]) > 0.9)) continue
            }
            if (q.cull !== -1) {
              const [cx, cy, cz] = q.cull
              const nv = at(x + cx, y + cy, z + cz)
              if (nv && geo[nv].opaque) continue
              if (G.translucent && nv === v) continue
              if (/glass/.test(g.pal[v]) && nv && /glass/.test(g.pal[nv]) && C.parse(g.pal[nv]).name === C.parse(g.pal[v]).name) continue
            }
            cb(q, x, y, z, v)
          }
        }
      }
    }
  }
  // Вода: верх (14/16) под воздухом и бока к воздуху/прозрачному.
  const waterTex = STATES.water.variants[''].model.textures.particle
  const waterQuads: Record<string, any> = {} as Record<string, any>
  for (const [fn, F] of Object.entries<any>(FACES)) {
    const p = []; const uv = []
    for (const c of F.c) { p.push(c[0], c[1] ? 14 / 16 : 0, c[2]); uv.push(waterTex.u + c[3] * waterTex.su, waterTex.v + c[4] * waterTex.sv) }
    waterQuads[fn] = { p, uv, n: F.dir, cull: -1, tint: TINT.water, tile: [waterTex.u, waterTex.v, waterTex.u + waterTex.su, waterTex.v + waterTex.sv], ao: null, shade: true, doAO: false, water: true }
  }
  function waterFaces (x, y, z, v, viewF, cb) {
    for (const [fn, F] of Object.entries<any>(FACES)) {
      const [dx, dy, dz] = F.dir
      if (dx * viewF[0] + dy * viewF[1] + dz * viewF[2] >= 0) continue
      const nv = at(x + dx, y + dy, z + dz)
      if (nv && (geo[nv].water || geo[nv].opaque)) continue
      if (fn !== 'up' && nv && !geo[nv].invisible) continue
      if (fn === 'down') continue
      if (fn !== 'up' && !g.in(x + dx, y + dy, z + dz)) continue
      if (fn !== 'up' && skirt && !nv) continue
      cb(waterQuads[fn], x, y, z, v)
    }
  }

  // ---- карта теней
  const SH = frame(sun, (opt.shadowScale || 4) * Math.max(1, ss / 2), 4)
  const sdepth = new Float32Array(SH.W * SH.H).fill(Infinity)
  const sampleAlpha = (u, v, tile) => {
    let tx = Math.floor(u * AW); let ty = Math.floor(v * AH)
    const t0 = Math.floor(tile[0] * AW + 1e-6); const t1 = Math.ceil(tile[2] * AW - 1e-6) - 1
    const s0 = Math.floor(tile[1] * AH + 1e-6); const s1 = Math.ceil(tile[3] * AH - 1e-6) - 1
    if (tx < t0) tx = t0; if (tx > t1) tx = t1; if (ty < s0) ty = s0; if (ty > s1) ty = s1
    return (ty * AW + tx) * 4
  }
  // Растеризация треугольника: p — [sx, sy, depth] ×3, attrs — по вершинам,
  // frag(px, py, depth, w0, w1, w2).
  const tri = (W, H, a, b, c, frag) => {
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))); const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])))
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))); const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])))
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if (Math.abs(area) < 1e-9) return
    const inv = 1 / area
    const eps = -1e-4
    for (let py = minY; py <= maxY; py++) {
      const y = py + 0.5
      for (let px = minX; px <= maxX; px++) {
        const x = px + 0.5
        let w0 = ((b[0] - x) * (c[1] - y) - (b[1] - y) * (c[0] - x)) * inv
        let w1 = ((c[0] - x) * (a[1] - y) - (c[1] - y) * (a[0] - x)) * inv
        let w2 = 1 - w0 - w1
        if (w0 < eps || w1 < eps || w2 < eps) continue
        if (w0 < 0) w0 = 0; if (w1 < 0) w1 = 0; if (w2 < 0) w2 = 0
        frag(px, py, a[2] * w0 + b[2] * w1 + c[2] * w2, w0, w1, w2)
      }
    }
  }
  const TRI = [[0, 1, 2], [2, 1, 3]]
  {
    const P = new Array(4)
    walk(sun.f, (q, x, y, z) => {
      if (q.water) return
      for (let k = 0; k < 4; k++) { const pr = proj(sun, [x + q.p[k * 3], y + q.p[k * 3 + 1], z + q.p[k * 3 + 2]]); P[k] = [pr[0] * SH.sc + SH.ox, pr[1] * SH.sc + SH.oy, pr[2]] }
      for (const [i0, i1, i2] of TRI) {
        tri(SH.W, SH.H, P[i0], P[i1], P[i2], (px, py, d, w0, w1, w2) => {
          const u = q.uv[i0 * 2] * w0 + q.uv[i1 * 2] * w1 + q.uv[i2 * 2] * w2
          const v = q.uv[i0 * 2 + 1] * w0 + q.uv[i1 * 2 + 1] * w1 + q.uv[i2 * 2 + 1] * w2
          if (A[sampleAlpha(u, v, q.tile) + 3] < 128) return
          const k = py * SH.W + px
          if (d < sdepth[k]) sdepth[k] = d
        })
      }
    }, false)
  }
  const inShadow = (wx, wy, wz) => {
    const q = proj(sun, [wx, wy, wz])
    const sx = q[0] * SH.sc + SH.ox; const sy = q[1] * SH.sc + SH.oy
    let lit = 0; let n = 0
    for (const [ox, oy] of [[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) {
      const ix = Math.floor(sx + ox); const iy = Math.floor(sy + oy)
      if (ix < 0 || iy < 0 || ix >= SH.W || iy >= SH.H) { lit++; n++; continue }
      n++
      if (q[2] <= sdepth[iy * SH.W + ix] + 0.12) lit++
    }
    return 1 - lit / n
  }

  // ---- основной проход
  const FR = frame(cam, scale, 20 * ss)
  const W = FR.W; const H = FR.H
  const depth = new Float32Array(W * H).fill(Infinity)
  const col = new Float32Array(W * H * 3)
  // Фон.
  for (let py = 0; py < H; py++) {
    const t = py / H
    const c = night ? [0.04 + 0.03 * t, 0.06 + 0.04 * t, 0.13 + 0.06 * t] : [0.5 + 0.31 * t, 0.69 + 0.2 * t, 0.88 + 0.08 * t]
    for (let px = 0; px < W; px++) { const k = (py * W + px) * 3; col[k] = c[0]; col[k + 1] = c[1]; col[k + 2] = c[2] }
  }
  const faceShade = n => n[0] * n[0] * 0.6 + n[1] * n[1] * (n[1] > 0 ? 1 : 0.5) + n[2] * n[2] * 0.8
  const lightCurve = l => Math.pow(0.76, 15 - l)
  const shade = (q, x, y, z, v, cornerAO?: any) => {
    // Возвращает множитель яркости для четырёх вершин и цвет света.
    const n = q.n
    const fs = q.shade ? faceShade(n) : 0.95
    let lightK = 1; let warm = [1, 1, 1]
    if (night) {
      if (emit[v]) { lightK = 1; warm = [1, 0.95, 0.85] } else {
        const fx = Math.round(x + 0.5 + n[0] * 0.6 - 0.5); const fy = Math.round(y + 0.5 + n[1] * 0.6 - 0.5); const fz = Math.round(z + 0.5 + n[2] * 0.6 - 0.5)
        let l = 0
        if (g.in(fx, fy, fz)) l = L[g.i(fx, fy, fz)]
        if (g.in(x, y, z)) l = Math.max(l, geo[v].opaque ? 0 : L[g.i(x, y, z)])
        const bl = lightCurve(l)
        const moon = 0.06
        lightK = Math.max(moon, bl)
        warm = bl > moon ? [1.0, 0.86, 0.66] : [0.7, 0.8, 1.1]
      }
    }
    return { fs, lightK, warm }
  }
  const translucent = []
  {
    const P = new Array(4); const Wp = new Array(4); const AOv = [1, 1, 1, 1]
    walk(cam.f, (q, x, y, z, v) => {
      const G = geo[v]
      for (let k = 0; k < 4; k++) {
        const wp = [x + q.p[k * 3], y + q.p[k * 3 + 1], z + q.p[k * 3 + 2]]
        Wp[k] = wp
        const pr = proj(cam, wp)
        P[k] = [pr[0] * FR.sc + FR.ox, pr[1] * FR.sc + FR.oy, pr[2]]
        if (q.ao && q.doAO) {
          const [s1, s2, cr] = [q.ao[k * 3], q.ao[k * 3 + 1], q.ao[k * 3 + 2]]
          const b1 = opaqueAt(x + s1[0], y + s1[1], z + s1[2]) ? 1 : 0
          const b2 = opaqueAt(x + s2[0], y + s2[1], z + s2[2]) ? 1 : 0
          const bc = opaqueAt(x + cr[0], y + cr[1], z + cr[2]) ? 1 : 0
          const ao = (b1 && b2) ? 0 : 3 - (b1 + b2 + bc)
          AOv[k] = 0.55 + 0.45 * (ao / 3)
        } else AOv[k] = 1
      }
      const sh = shade(q, x, y, z, v)
      const sunFacing = q.n[0] * toSun[0] + q.n[1] * toSun[1] + q.n[2] * toSun[2]
      if (G.translucent) {
        translucent.push({ q, x, y, z, v, P: P.map(p => p.slice()), sh, AO: AOv.slice(), d: (P[0][2] + P[1][2] + P[2][2] + P[3][2]) / 4 })
        return
      }
      const tint = q.tint
      for (const [i0, i1, i2] of TRI) {
        tri(W, H, P[i0], P[i1], P[i2], (px, py, d, w0, w1, w2) => {
          const k = py * W + px
          if (d >= depth[k]) return
          const u = q.uv[i0 * 2] * w0 + q.uv[i1 * 2] * w1 + q.uv[i2 * 2] * w2
          const vv = q.uv[i0 * 2 + 1] * w0 + q.uv[i1 * 2 + 1] * w1 + q.uv[i2 * 2 + 1] * w2
          const ai = sampleAlpha(u, vv, q.tile)
          if (A[ai + 3] < 128) return
          depth[k] = d
          let r = A[ai] / 255; let gg = A[ai + 1] / 255; let b = A[ai + 2] / 255
          if (tint) { r *= tint[0]; gg *= tint[1]; b *= tint[2] }
          const aoK = AOv[i0] * w0 + AOv[i1] * w1 + AOv[i2] * w2
          let k2
          if (night) k2 = sh.fs * sh.lightK * aoK
          else {
            let lit = sunFacing > 0.02 ? 1 : 0
            if (lit) {
              const wx = Wp[i0][0] * w0 + Wp[i1][0] * w1 + Wp[i2][0] * w2
              const wy = Wp[i0][1] * w0 + Wp[i1][1] * w1 + Wp[i2][1] * w2
              const wz = Wp[i0][2] * w0 + Wp[i1][2] * w1 + Wp[i2][2] * w2
              lit = 1 - inShadow(wx + q.n[0] * 0.02, wy + q.n[1] * 0.02, wz + q.n[2] * 0.02)
            }
            const direct = Math.min(1, 0.55 + 0.9 * Math.max(0, sunFacing))
            k2 = sh.fs * aoK * (0.62 + 0.38 * lit * direct) * 1.08
          }
          const o = k * 3
          col[o] = r * k2 * sh.warm[0]; col[o + 1] = gg * k2 * sh.warm[1]; col[o + 2] = b * k2 * sh.warm[2]
        })
      }
    })
  }
  // ---- море до горизонта (плоскость y = seaY за краем модели)
  if (opt.sea !== undefined && opt.sea !== null) {
    const hy = Number(opt.sea) + 14 / 16
    const tile = [waterTex.u, waterTex.v, waterTex.u + waterTex.su, waterTex.v + waterTex.sv]
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const k = py * W + px
        if (depth[k] !== Infinity) continue
        const a = (px + 0.5 - FR.ox) / FR.sc; const b = -((py + 0.5 - FR.oy) / FR.sc)
        // Точка экрана: a·r + b·u + t·f, у = hy.
        const t = (hy - (a * cam.r[1] + b * cam.u[1])) / cam.f[1]
        const wx = a * cam.r[0] + b * cam.u[0] + t * cam.f[0]
        const wz = a * cam.r[2] + b * cam.u[2] + t * cam.f[2]
        if (!isFinite(t)) continue
        const u = waterTex.u + ((wx % 1) + 1) % 1 * waterTex.su; const v = waterTex.v + ((wz % 1) + 1) % 1 * waterTex.sv
        const ai = sampleAlpha(u, v, tile)
        const dist = Math.hypot(wx, wz)
        const fade = Math.min(1, Math.max(0, (dist - 60) / 260))
        const base = night ? [0.03, 0.06, 0.12] : [0.2, 0.38, 0.7]
        const sky = night ? [0.05, 0.08, 0.16] : [0.62, 0.78, 0.92]
        const tx = A[ai] / 255 * TINT.water[0] * 0.9; const ty = A[ai + 1] / 255 * TINT.water[1] * 0.9; const tz = A[ai + 2] / 255 * TINT.water[2] * 0.9
        const o = k * 3
        const mix = (c0, c1) => c0 * (1 - fade) + c1 * fade
        col[o] = mix(base[0] * 0.5 + tx * 0.5 * (night ? 0.2 : 1), sky[0]); col[o + 1] = mix(base[1] * 0.5 + ty * 0.5 * (night ? 0.2 : 1), sky[1]); col[o + 2] = mix(base[2] * 0.5 + tz * 0.5 * (night ? 0.2 : 1), sky[2])
        depth[k] = t
      }
    }
  }
  // ---- полупрозрачное: от дальнего к ближнему, без записи глубины
  translucent.sort((a, b) => b.d - a.d)
  for (const t of translucent) {
    const { q, P, sh, AO, v } = t
    const isWater = !!q.water
    for (const [i0, i1, i2] of TRI) {
      tri(W, H, P[i0], P[i1], P[i2], (px, py, d, w0, w1, w2) => {
        const k = py * W + px
        if (d >= depth[k]) return
        const u = q.uv[i0 * 2] * w0 + q.uv[i1 * 2] * w1 + q.uv[i2 * 2] * w2
        const vv = q.uv[i0 * 2 + 1] * w0 + q.uv[i1 * 2 + 1] * w1 + q.uv[i2 * 2 + 1] * w2
        const ai = sampleAlpha(u, vv, q.tile)
        let a = A[ai + 3] / 255
        if (a < 0.04) return
        let r = A[ai] / 255; let gg = A[ai + 1] / 255; let b = A[ai + 2] / 255
        if (q.tint) { r *= q.tint[0]; gg *= q.tint[1]; b *= q.tint[2] }
        const aoK = AO[i0] * w0 + AO[i1] * w1 + AO[i2] * w2
        const kk = (night ? sh.lightK : 1) * sh.fs * aoK
        if (isWater) {
          // Глубина воды за поверхностью — к синеве: отмели светлые.
          const behind = depth[k] - d
          a = Math.min(0.92, 0.38 + (isFinite(behind) ? 1 - Math.exp(-behind / 7) : 1) * 0.55)
          r = r * 1.05; gg = gg * 1.05; b = b * 1.05
        } else a = Math.max(a, 0.45)
        const o = k * 3
        col[o] = col[o] * (1 - a) + r * kk * sh.warm[0] * a
        col[o + 1] = col[o + 1] * (1 - a) + gg * kk * sh.warm[1] * a
        col[o + 2] = col[o + 2] * (1 - a) + b * kk * sh.warm[2] * a
      })
    }
    void v
  }
  // ---- вывод (со сглаживанием ss×ss)
  const OW = Math.floor(W / ss); const OH = Math.floor(H / ss)
  const cv = createCanvas(OW, OH)
  const cx = cv.getContext('2d')
  const img = cx.createImageData(OW, OH)
  for (let y = 0; y < OH; y++) {
    for (let x = 0; x < OW; x++) {
      let r = 0; let gg = 0; let b = 0
      for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) { const o = ((y * ss + j) * W + (x * ss + i)) * 3; r += col[o]; gg += col[o + 1]; b += col[o + 2] }
      const n = ss * ss
      const o = (y * OW + x) * 4
      img.data[o] = Math.min(255, Math.max(0, 255 * r / n)); img.data[o + 1] = Math.min(255, Math.max(0, 255 * gg / n)); img.data[o + 2] = Math.min(255, Math.max(0, 255 * b / n)); img.data[o + 3] = 255
    }
  }
  cx.putImageData(img, 0, 0)
  return { png: cv.toBuffer('image/png'), W: OW, H: OH, missing }
}

export { render, stateGeometry, variantsOf }

// ------------------------------------------------------------------ CLI
if (require.main === module) {
  const args = process.argv.slice(2)
  const mod = args[0]; const out = args[1]
  const opt = (k, d?: any) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
  const flag = k => args.includes('--' + k)
  const num = k => opt(k) !== undefined ? Number(opt(k)) : undefined
  ;(async () => {
    const t0 = Date.now()
    const M = require('./' + mod)
    const m = M.model(JSON.parse(opt('opts', '{}')))
    const t1 = Date.now()
    const r = await render(m.g, { az: num('az'), el: num('el'), scale: num('scale'), ss: num('ss'), cut: opt('cut'), ylim: opt('ylim'), ymin: opt('ymin'), crop: opt('crop'), night: flag('night'), sunaz: num('sunaz'), sunel: num('sunel'), sea: opt('sea') })
    ;(require('fs') as typeof import('fs')).writeFileSync(out, r.png)
    console.log(`${path.basename(out)}: ${r.W}×${r.H}; модель ${((t1 - t0) / 1000).toFixed(1)} с, рендер ${((Date.now() - t1) / 1000).toFixed(1)} с`)
  })().catch(e => { console.error(e); process.exit(1) })
}
