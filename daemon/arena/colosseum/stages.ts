'use strict'
// Колизей (часть colosseum.ts): материалы и этапы модели по сечению от поля наружу. Каждый этап пишет в сетку
// контекста frame() — по порядку, как прежде одна функция model.
import { OPP, dir4, st, stairs, slab } from './blocks'
import type { ModelCtx } from './frame'

// ---------------------------------------------------------------- модель

// Материалы. Травертин — песчаник (гладкий, резной, обычный), мрамор колонн и
// карнизов — кварц.
const MAT = {
  base: 'obsidian', // фундамент dy −2 внутри постройки: лучи взрыва снизу не берут
  sand: 'sand',
  kerb: 'smooth_quartz',
  groove: 'crying_obsidian',
  lineZ: 'crying_obsidian', // линии вдоль z (x = const) — свет 10, взрывом не выбить
  lineX: 'glowstone', // линии вдоль x (z = const)
  rim: 'glowstone', // обод у подножия подиума
  via: 'smooth_quartz', // триумфальная дорога
  fill: 'smooth_sandstone',
  podium: 'smooth_quartz',
  terrace: 'smooth_quartz',
  parapet: 'diorite_wall',
  seat: 'smooth_sandstone_stairs',
  aisle: 'quartz_stairs',
  walk: 'cut_sandstone',
  balteus: 'cut_sandstone',
  wall: 'smooth_sandstone',
  band: 'cut_sandstone',
  keystone: 'chiseled_quartz_block',
  haunch: 'smooth_quartz_stairs',
  archivolt: 'smooth_quartz',
  galleryFloor: 'smooth_sandstone',
  plinth: 'smooth_sandstone_slab',
  colBase: 'smooth_quartz',
  architrave: 'cut_sandstone',
  cornice: 'smooth_quartz_stairs',
  corniceSlab: 'smooth_quartz_slab',
  coping: 'smooth_sandstone_slab',
  stylobate: 'sandstone',
  stepStairs: 'sandstone_stairs',
  lamp: 'shroomlight',
  mast: 'spruce_fence'
}
// Ордера ярусов: [ствол, капитель] (тосканский — гладкий, ионический и
// коринфский — каннелюры quartz_pillar; коринфская капитель в два блока).
const ORDER = [
  { shaft: 'smooth_quartz', cap: ['quartz_block'] },
  { shaft: 'quartz_pillar[axis=y]', cap: ['chiseled_quartz_block'] },
  { shaft: 'quartz_pillar[axis=y]', cap: ['chiseled_quartz_block', 'chiseled_quartz_block'] }
]

// ---- 1. Поле, щель, бордюр, песок, линии, фундамент
function field (ctx: ModelCtx) {
  const { R, cols, S, inField, cheb } = ctx
  for (const c of cols.values()) {
    const { x, z } = c
    if (inField(x, z)) continue
    const ch = cheb(x, z)
    if (ch === R + 1) { S(x, -2, z, MAT.groove); continue } // над ним барьер (arena.js)
    if (c.n < 0) {
      S(x, -2, z, MAT.base)
      // Песок без разметки; у подножия подиума — светящийся обод.
      let top = MAT.sand
      if (ch === R + 2) top = MAT.kerb
      else if (c.k === -1) top = MAT.rim
      S(x, -1, z, top)
      // Карниз подиума к арене: перевёрнутая ступень ступенькой к стене.
      if (c.k === -1) S(x, 3, z, stairs(MAT.cornice, dir4(c.N[0], c.N[1]), 'top'))
    }
  }
}

// Балюстрада без щелей (2026-09-26, пользователь: «заборчик кривоват, стыки
// неидеальные»): на кривой кольцо подиума местами касается себя только
// углом, а стенки (diorite_wall) соединяются лишь по сторонам — щель и зуб.
// В такой угол — перемычка: соседняя по стороне клетка снаружи (больше n,
// дальше от поля) становится подиумом.
function parapetSeams (ctx: ModelCtx) {
  const { K, cols, key } = ctx
  {
    const par = new Set([...cols.values()].filter(c => c.k === K.parapet && c.n >= 0).map(c => key(c.x, c.z)))
    const promote = new Set()
    for (const c of cols.values()) {
      if (c.k !== K.parapet || c.n < 0) continue
      for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (!par.has(key(c.x + dx, c.z + dz))) continue
        if (par.has(key(c.x + dx, c.z)) || par.has(key(c.x, c.z + dz))) continue
        const cand = [cols.get(key(c.x + dx, c.z)), cols.get(key(c.x, c.z + dz))].filter(q => q && q.n >= 0).sort((q, r) => r.n - q.n)[0]
        if (cand) promote.add(cand)
      }
    }
    for (const c of (promote as Iterable<any>)) { c.k = K.parapet; par.add(key(c.x, c.z)) }
  }
}

// ---- 2. Кавея: подиум, терраса, ряды, пояса, засыпка
function cavea (ctx: ModelCtx) {
  const { K, cols, S, colFill } = ctx
  for (const c of cols.values()) {
    const { x, z, k } = c
    if (c.n < 0 || k > K.relief + 2) continue
    const out = dir4(c.N[0], c.N[1])
    const aisle = c.b % 4 === 0 && Math.abs(c.v) < 1.0
    if (k <= K.gallery[1]) S(x, -2, z, MAT.base)
    if (k === K.parapet) { colFill(x, z, -1, 3, MAT.podium); S(x, 4, z, MAT.parapet) } else if (k >= K.terrace[0] && k <= K.terrace[1]) { colFill(x, z, -1, 2, MAT.fill); S(x, 3, z, MAT.terrace) } else if (k >= K.m1[0] && k <= K.m1[1]) {
      const i = k - K.m1[0]
      colFill(x, z, -1, 3 + i, MAT.fill)
      S(x, 4 + i, z, stairs(aisle ? MAT.aisle : MAT.seat, out))
    } else if (k >= K.p1[0] && k <= K.p1[1]) { colFill(x, z, -1, 6, MAT.fill); S(x, 7, z, MAT.walk) } else if (k >= K.m2[0] && k <= K.m2[1]) {
      const i = k - K.m2[0]
      colFill(x, z, -1, 10 + i, MAT.fill)
      if (i === 0) { colFill(x, z, 8, 10, MAT.balteus); if (aisle) S(x, 9, z, MAT.lamp) }
      S(x, 11 + i, z, stairs(aisle ? MAT.aisle : MAT.seat, out))
    } else if (k >= K.p2[0] && k <= K.p2[1]) { colFill(x, z, -1, 14, MAT.fill); S(x, 15, z, MAT.walk) } else if (k >= K.m3[0] && k <= K.m3[1]) {
      const i = k - K.m3[0]
      colFill(x, z, -1, 18 + i, MAT.fill)
      if (i === 0) { colFill(x, z, 16, 18, MAT.balteus); if (aisle) S(x, 17, z, MAT.lamp) }
      S(x, 19 + i, z, stairs(aisle ? MAT.aisle : MAT.seat, out))
    }
  }
}

// ---- 3. Галереи, портик, стена фасада, рельеф, стилобат
function facade (ctx: ModelCtx) {
  const { p, K, cols, key, ring, radial, pick, S, colFill, bayT, colT, attached } = ctx
  const reliefRing = ring(K.relief)
  const colAt = new Map() // key → номер границы
  pick(K.relief, colT).forEach((c, i) => { if (c) colAt.set(key(c.x, c.z), i) })
  // Окна аттика: клетки вдоль радиального отрезка сквозь обе полосы стены,
  // 4-связно (на диагоналях стена в две клетки по нормали — «ближайшие»
  // клетки полос давали глухую нишу, где темно и может встать моб).
  const winAt = new Map()
  bayT.forEach((t, b) => { for (const kk of radial(t, K.wall[0] - 0.5, K.wall[1] + 1.5)) winAt.set(kk, b) })
  const porticoCol = new Set(pick(K.gallery[0], colT).filter(Boolean).map(c => key(c.x, c.z)))
  const porticoLamp = new Set(pick(K.gallery[0] + 1, bayT).filter(Boolean).map(c => key(c.x, c.z)))
  const archLamp = new Set(pick(K.wall[0], bayT).filter(Boolean).map(c => key(c.x, c.z)))
  // Центр арки в каждой из двух полос стены — ровно одна клетка на пролёт.
  const archCenter = new Set()
  for (const k of K.wall) pick(k, bayT).forEach(c => { if (c) archCenter.add(key(c.x, c.z)) })
  for (const c of cols.values()) {
    const { x, z, k } = c
    const inward = dir4(-c.N[0], -c.N[1])
    const kk = key(x, z)
    if (k >= K.gallery[0] && k <= K.gallery[1]) {
      S(x, -1, z, MAT.galleryFloor)
      for (let s = 0; s < 3; s++) {
        S(x, 8 * s + 6, z, MAT.wall) // потолок
        if (s < 2) S(x, 8 * s + 7, z, MAT.galleryFloor) // пол следующего яруса
      }
      S(x, 23, z, MAT.walk) // пол портика
      S(x, 29, z, MAT.wall) // кровля портика
      S(x, 30, z, slab(MAT.coping))
      if (k === K.gallery[0] && porticoCol.has(kk)) {
        colFill(x, z, 24, 27, 'quartz_pillar[axis=y]'); S(x, 28, z, 'chiseled_quartz_block')
      }
      if (k === K.gallery[0] + 1 && porticoLamp.has(kk)) attached.push([x, 28, z, st('lantern', { hanging: 'true', waterlogged: 'false' })])
    }
    if (k === K.m3[1]) { // свес кровли портика к арене
      S(x, 29, z, stairs(MAT.cornice, dir4(c.N[0], c.N[1]), 'top'))
      S(x, 30, z, slab(MAT.coping))
    }
    // Близко к 45° ступени по касательной/нормали ложатся углами «пилой» —
    // там пяты арок из полных блоков, карнизы из верхних плит.
    const diag = Math.min(Math.abs(c.N[0]), Math.abs(c.N[1])) / Math.max(Math.abs(c.N[0]), Math.abs(c.N[1])) > 0.5
    if (k >= K.wall[0] && k <= K.wall[1]) {
      S(x, -2, z, MAT.stylobate)
      S(x, -1, z, MAT.galleryFloor)
      for (let s = 0; s < 3; s++) {
        const y0 = 8 * s
        const open = Math.abs(c.v) < 1.5
        const center = archCenter.has(kk)
        // Ярус 8 рядов: r0–3 проём во всю ширину, r4 — пяты арки (перевёрнутые
        // ступени ступенькой к опоре, по касательной) и центр, r5 — замок и
        // белый обвод над проёмом, r6 — за антаблементом, r7 — пол галереи.
        for (let r = 0; r < 8; r++) {
          const y = y0 + r
          let b = MAT.wall
          if (r <= 3) b = open ? '' : MAT.wall
          else if (r === 4) b = center ? '' : open ? (diag ? MAT.archivolt : stairs(MAT.haunch, dir4(Math.sign(c.v) * c.T[0], Math.sign(c.v) * c.T[1]), 'top')) : MAT.wall
          else if (r === 5) b = k === K.wall[1] && open ? (center ? MAT.keystone : MAT.archivolt) : MAT.wall
          S(x, y, z, b)
        }
        if (center && k === K.wall[0] && archLamp.has(kk)) attached.push([x, y0 + 4, z, st('lantern', { hanging: 'true', waterlogged: 'false' })])
      }
      // Аттик: стена с окнами через пролёт, копинг.
      for (let y = 24; y <= 32; y++) S(x, y, z, MAT.wall)
      const wb = winAt.get(kk)
      if (wb !== undefined && wb % 2 === 0) { S(x, 27, z, ''); S(x, 28, z, '') }
      S(x, 33, z, slab(MAT.coping))
    }
    if (k === K.relief) {
      S(x, -2, z, MAT.stylobate); S(x, -1, z, MAT.stylobate)
      const ci = colAt.get(kk)
      for (let s = 0; s < 3; s++) {
        const y0 = 8 * s
        const ord = ORDER[s]
        // Полуколонна: база r0, ствол, капитель под антаблементом r6
        // (резной песчаник), карниз r7 — белые перевёрнутые ступени.
        S(x, y0, z, ci !== undefined ? MAT.colBase : (s === 0 ? '' : slab(MAT.plinth)))
        if (ci !== undefined) {
          const capH = ord.cap.length
          for (let r = 1; r <= 5 - capH; r++) S(x, y0 + r, z, ord.shaft)
          ord.cap.forEach((cb, j) => S(x, y0 + 6 - capH + j, z, cb))
        }
        S(x, y0 + 6, z, MAT.architrave)
        S(x, y0 + 7, z, diag ? slab(MAT.corniceSlab, 'top') : stairs(MAT.cornice, inward, 'top'))
      }
      // Аттик: пилястры, консоли, венчающий карниз, копинг, мачты.
      S(x, 24, z, ci !== undefined ? MAT.colBase : slab(MAT.plinth))
      if (ci !== undefined) {
        for (let y = 25; y <= 29; y++) S(x, y, z, 'smooth_quartz')
        S(x, 30, z, 'chiseled_quartz_block')
        S(x, 31, z, stairs(MAT.cornice, inward, 'top'))
      }
      S(x, 32, z, stairs(MAT.cornice, inward, 'top'))
      const mast = ci !== undefined && ci % p.masts === 0
      if (mast) {
        for (let y = 33; y <= 38; y++) S(x, y, z, MAT.mast)
        const rot = Math.round(((Math.atan2(-c.N[0], c.N[1]) * 180 / Math.PI) + 360) / 22.5) % 16
        attached.push([x, 39, z, st(`${p.banner}_banner`, { rotation: rot }), '{patterns:[{color:"yellow",pattern:"minecraft:border"},{color:"yellow",pattern:"minecraft:stripe_middle"}]}'])
      } else S(x, 33, z, slab(MAT.coping))
    }
    if (k === K.step1) { S(x, -2, z, MAT.stylobate); S(x, -1, z, stairs(MAT.stepStairs, inward)) }
    if (k === K.step2) S(x, -2, z, stairs(MAT.stepStairs, inward))
  }
}

// ---- 4. Балюстрада: фонари на столбиках через пролёт.
function parapetLamps (ctx: ModelCtx) {
  const { K, pick, colT, attached } = ctx
  const parLamp = pick(K.parapet, colT.filter((_, i) => i % 2 === 1))
  for (const c of parLamp) if (c) attached.push([c.x, 5, c.z, st('lantern', { hanging: 'false', waterlogged: 'false' })])
}

// ---- 5. Вомитории (пролёты ≡ 2 mod 4): с поясов в галереи; свет в потолке.
function vomitoria (ctx: ModelCtx) {
  const { K, cols, S, g } = ctx
  for (const c of cols.values()) {
    const { x, z, k } = c
    if (c.b % 4 !== 2 || Math.abs(c.v) >= 1.0) continue
    if (k >= K.m2[0] && k <= K.m3[1]) { S(x, 8, z, ''); S(x, 9, z, ''); S(x, 10, z, k === K.m2[0] + 1 || k === K.m3[0] ? MAT.lamp : (k === K.m2[0] ? MAT.keystone : g.get(x, 10, z))) }
    if (k >= K.m3[0] && k <= K.m3[1]) { S(x, 16, z, ''); S(x, 17, z, ''); S(x, 18, z, k === K.m3[0] + 1 ? MAT.lamp : (k === K.m3[0] ? MAT.keystone : g.get(x, 18, z))) }
  }
}

// ---- 6. Ворота на большой оси: тоннель с поля к галерее первого яруса.
function gates (ctx: ModelCtx) {
  const { R, A1, K, cols, key, S, g, isGate, attached } = ctx
  for (const c of cols.values()) {
    if (!isGate(c)) continue
    const { x, z, k } = c
    if (c.n < -1) continue
    for (let y = 0; y <= 2; y++) S(x, y, z, '')
    if (k >= 0) S(x, -1, z, MAT.walk)
    if (k >= 0) S(x, 3, z, (z === 0 && k % 5 === 2) ? MAT.lamp : (k === 0 ? 'chiseled_quartz_block' : g.get(x, 3, z)))
  }
  // Триумфальная дорога: мощение по большой оси от бордюра к воротам и
  // фонари на столбиках по сторонам — свет в середину песка у торцов.
  for (const sx of [1, -1]) {
    for (let ax = R + 3; ax <= A1 + 1; ax++) {
      const x = sx * ax
      for (let z = -1; z <= 1; z++) { const c = cols.get(key(x, z)); if (c && c.n < 0) S(x, -1, z, MAT.via) }
      if ((ax - (R + 3)) % 5 === 2 && ax < A1 - 2) {
        for (const z of [-3, 3]) { S(x, 0, z, 'quartz_pillar[axis=y]'); S(x, 1, z, 'chiseled_quartz_block'); attached.push([x, 2, z, st('lantern', { hanging: 'false', waterlogged: 'false' })]) }
      }
    }
  }
  for (const c of cols.values()) { // обрамление ворот на подиуме
    if (c.k !== K.parapet || Math.abs(c.z) !== 2 || Math.abs(c.x) < R) continue
    for (let y = 0; y <= 3; y++) S(c.x, y, c.z, 'quartz_pillar[axis=y]')
  }
}

// ---- 7. Ложи на малой оси: юг — пульвинар (место зрителя), север — напротив.
function loges (ctx: ModelCtx) {
  const { K, B1, g, S, colFill, boxHalf, attached } = ctx
  const boxes = []
  for (const sgn of [1, -1]) {
    const f = sgn > 0 ? 'south' : 'north'; const bk = OPP[f]
    const Z = xz => xz * sgn
    // Край эллипса у оси ~ B1; ложа: кольца −2..7 при |dx| ≤ 6.
    const zAt = k => Z(Math.round(B1 + k))
    const kFront = -2; const kBack = K.m1[1]
    for (let x = -boxHalf; x <= boxHalf; x++) {
      for (let k = kFront; k <= kBack; k++) {
        const z = zAt(k)
        for (let y = 4; y <= 20; y++) S(x, y, z, '')
        S(x, -2, z, k < 0 ? MAT.base : MAT.base)
        if (k < 0) { S(x, -1, z, g.get(x, -1, z) || MAT.sand); S(x, 3, z, stairs(MAT.cornice, f, 'top')) } else colFill(x, z, -1, 3, MAT.fill)
        S(x, 4, z, MAT.terrace) // пол ложи: поверхность dy 5
        const edge = Math.abs(x) === boxHalf
        if (edge && k >= 0) colFill(x, z, 5, 8, MAT.podium) // бока у рядов
        if (k === kBack) colFill(x, z, 5, 8, MAT.podium) // задняя стена
        S(x, 9, z, 'smooth_quartz')
        // Двускатная кровля 1:2 полублоками, конёк по оси ложи.
        const h2 = boxHalf - Math.abs(x)
        for (let j = 0; j < (h2 >> 1); j++) S(x, 10 + j, z, 'smooth_quartz')
        if (h2 & 1) S(x, 10 + (h2 >> 1), z, slab('smooth_quartz_slab'))
      }
      // Фронт: балюстрада, колонны с золотыми капителями (у пульвинара).
      const z = zAt(kFront)
      const col = [-6, -2, 2, 6].includes(x)
      if (col) { colFill(x, z, 5, 7, 'quartz_pillar[axis=y]'); S(x, 8, z, sgn > 0 ? 'gold_block' : 'chiseled_quartz_block') } else S(x, 5, z, MAT.parapet)
    }
    // Красная дорожка и трон.
    for (let x = -2; x <= 2; x++) for (let k = -1; k <= kBack - 1; k++) S(x, 5, zAt(k), 'red_carpet')
    S(0, 5, zAt(kBack - 1), stairs('quartz_stairs', bk === 'south' ? 'south' : 'north'))
    for (const x of [-1, 1]) S(x, 5, zAt(kBack - 1), sgn > 0 ? 'gold_block' : 'smooth_quartz')
    for (const x of [-3, 3]) attached.push([x, 8, zAt(2), st('lantern', { hanging: 'true', waterlogged: 'false' })])
    // Акротерии: фонари на коньке и углах фронтона.
    attached.push([0, 13, zAt(kFront), st('lantern', { hanging: 'false', waterlogged: 'false' })])
    attached.push([0, 13, zAt(kBack), st('lantern', { hanging: 'false', waterlogged: 'false' })])
    for (const x of [-6, 6]) attached.push([x, 11, zAt(kFront), st('lantern', { hanging: 'false', waterlogged: 'false' })])
    boxes.push({ side: f, spot: { dx: 0, dy: 5, dz: zAt(-1) }, yaw: sgn > 0 ? 180 : 0 })
  }
  return boxes
}

export { MAT, ORDER, field, parapetSeams, cavea, facade, parapetLamps, vomitoria, gates, loges }
