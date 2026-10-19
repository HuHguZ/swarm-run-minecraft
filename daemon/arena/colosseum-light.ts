'use strict'
// Проверка света Колизея на модели (colosseum.js): BFS блочного света как в
// движке игры (LightEngine 1.20+) и поиск клеток, где может заспавниться моб.
//
// Свет: источник держит свой уровень (светокамень, фонарь, грибосвет 15,
// плачущий обсидиан 10, …); в соседа переходит level − max(1, lightBlock
// соседа), полный непрозрачный куб не пропускает; ступени и плиты гасят
// переход своими гранями (useShapeForLightOcclusion: объединение граней пары
// закрывает весь квадрат — хода нет).
//
// Спавн (NaturalSpawner, SpawnPlacementTypes.ON_GROUND, Monster): под ногами
// блок с прочной верхней гранью, светом < 14, не стекло/барьер/листва; клетки
// ног и головы — не полный куб коллизии, без жидкости; хитбокс моба
// (зомби 0.6×1.95, паук 1.4×0.9, эндермен 0.6×2.9) ни во что не упирается;
// в Верхнем мире — блочный свет в клетке ног 0. Если хоть один моб
// помещается, а свет 0, — это дыра в освещении.
//
//   node colosseum-light.js [R] [ceilH]   — отчёт по модели в консоль

import * as C from './colosseum'

function tables (g) {
  const mcData = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const Block = (require('prismarine-block') as typeof import('prismarine-block'))('1.21.11')
  const n = g.pal.length
  const T = {
    emit: new Uint8Array(n),
    opacity: new Uint8Array(n), // max(1, lightBlock); 15 — непрозрачный куб
    occ: new Uint8Array(n), // октанты формы для гашения света (ступени/плиты), 0 — нет
    surface: new Uint8Array(n), // можно встать сверху (isValidSpawn)
    fullColl: new Uint8Array(n), // полный куб коллизии
    boxes: new Array(n) // коллизия [x0,y0,z0,x1,y1,z1]
  }
  T.opacity[0] = 1; T.boxes[0] = []
  for (let v = 1; v < n; v++) {
    const s = g.pal[v]
    const { name, props } = C.parse(s)
    const b = mcData.blocksByName[name]
    if (!b) throw new Error('нет блока ' + name)
    const p: Record<string, any> = {} as Record<string, any>
    for (const st of b.states || []) {
      if (props[st.name] !== undefined) p[st.name] = st.type === 'bool' ? props[st.name] === 'true' : props[st.name]
      else if (st.type === 'bool') p[st.name] = false
    }
    const blk = Block.fromProperties(name, p, 0)
    const boxes = blk.shapes || []
    T.boxes[v] = boxes
    const full = boxes.length === 1 && boxes[0].join() === '0,0,0,1,1,1'
    T.fullColl[v] = full ? 1 : 0
    T.emit[v] = b.emitLight || 0
    let lb = b.filterLight
    if (/_slab$/.test(name) && props.type === 'double') lb = 15
    T.opacity[v] = Math.max(1, lb)
    const shaped = /_stairs$/.test(name) || (/_slab$/.test(name) && props.type !== 'double')
    T.occ[v] = shaped ? C.octMask(s) : 0
    // Прочная верх: полный куб, верхняя/двойная плита, перевёрнутая ступень.
    let sturdyTop = full
    if (shaped) sturdyTop = C.faceBits(C.octMask(s), 'up') === 15
    const never = /(glass|^barrier$|_leaves$|ice$)/.test(name)
    T.surface[v] = sturdyTop && !never && T.emit[v] < 14 ? 1 : 0
  }
  return T
}

// Мир для проверки: модель + поле (обсидиан с линиями, как ставит arena.js в
// стиле «колизей») + барьерная коробка + дыры по выбору.
function scene (m, { holes = [], noGlowstone = false }: any = {} as Record<string, any>) {
  const { g, p } = m
  const R = p.R
  const put = (x, y, z, s) => g.set(x, y, z, s)
  for (let x = -R; x <= R; x++) {
    for (let z = -R; z <= R; z++) {
      let s = 'obsidian'
      if ((((Math.abs(z) % 8) + 8) % 8) === 4 && !noGlowstone) s = 'glowstone'
      if ((((Math.abs(x) % 8) + 8) % 8) === 4) s = 'crying_obsidian'
      put(x, -1, z, s)
    }
  }
  for (const h of holes) for (let x = h.x; x < h.x + h.s; x++) for (let z = h.z; z < h.z + h.s; z++) put(x, -1, z, '')
  const r = R + 1
  for (let y = -1; y < p.ceilH; y++) {
    for (let d = -r; d <= r; d++) { put(d, y, -r, 'barrier'); put(d, y, r, 'barrier'); put(-r, y, d, 'barrier'); put(r, y, d, 'barrier') }
  }
  for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) put(x, p.ceilH, z, 'barrier')
}

const DIRS = [[1, 0, 0, 'east'], [-1, 0, 0, 'west'], [0, 1, 0, 'up'], [0, -1, 0, 'down'], [0, 0, 1, 'south'], [0, 0, -1, 'north']]
const OPP = { east: 'west', west: 'east', up: 'down', down: 'up', south: 'north', north: 'south' }

function blockLight (g, T) {
  const N = g.data.length
  const L = new Uint8Array(N)
  const buckets = Array.from({ length: 16 }, () => [])
  for (let i = 0; i < N; i++) {
    const e = T.emit[g.data[i]]
    if (e) { L[i] = e; buckets[e].push(i) }
  }
  const sx = g.sx; const sxz = g.sx * g.sz
  for (let lv = 15; lv >= 2; lv--) {
    const q = buckets[lv]
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi]
      if (L[i] !== lv) continue
      const x: any = i % sx; const zz: any = Math.floor(i / sx) % g.sz; const y: any = Math.floor(i / sxz)
      const sv = g.data[i]
      for (const [dx, dy, dz, dn] of (DIRS as Array<any>)) {
        const nx = x + dx; const ny = y + dy; const nz = zz + dz
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= g.sy || nz >= g.sz) continue
        const j = i + dx + dz * sx + dy * sxz
        const tv = g.data[j]
        const pl = lv - T.opacity[tv]
        if (pl <= L[j]) continue
        const fa = T.occ[sv] ? C.faceBits(T.occ[sv], dn) : 0
        const fb = T.occ[tv] ? C.faceBits(T.occ[tv], OPP[dn]) : 0
        if ((fa | fb) === 15) continue
        L[j] = pl
        buckets[pl].push(j)
      }
    }
  }
  return L
}

// Помещается ли моб (ширина w, высота h) стоя ногами на y клетки (x, y, z).
function fits (g, T, x, y, z, w, h) {
  const lo = 0.5 - w / 2; const hi = 0.5 + w / 2
  const cx0 = Math.floor(lo); const cx1 = Math.floor(hi - 1e-9)
  for (let yy = y - 1; yy <= y + Math.ceil(h); yy++) {
    for (let ix = cx0; ix <= cx1; ix++) {
      for (let iz = cx0; iz <= cx1; iz++) {
        const s = g.data[g.i(x + ix, yy, z + iz)] || 0
        for (const b of T.boxes[s]) {
          const bx0 = ix + b[0]; const bx1 = ix + b[3]; const bz0 = iz + b[2]; const bz1 = iz + b[5]
          const by0 = yy - y + b[1]; const by1 = yy - y + b[4]
          if (bx1 > lo && bx0 < hi && bz1 > lo && bz0 < hi && by1 > 0 && by0 < h) return false
        }
      }
    }
  }
  return true
}

const MOBS = [['зомби', 0.6, 1.95], ['паук', 1.4, 0.9], ['эндермен', 0.6, 2.9]]

function check (m, opts: any = {} as Record<string, any>) {
  const { g } = m
  scene(m, opts)
  const T = tables(g)
  const L = blockLight(g, T)
  const bad = []; const low = []; let spots = 0; let minLight = 16
  const hist = new Array(16).fill(0)
  for (let y = g.y0 + 1; y < g.y1 - 2; y++) {
    for (let z = g.z0 + 1; z < g.z1; z++) {
      for (let x = g.x0 + 1; x < g.x1; x++) {
        const below = g.data[g.i(x, y - 1, z)]
        if (!T.surface[below]) continue
        const i = g.i(x, y, z)
        const feet = g.data[i]; const head = g.data[g.i(x, y + 1, z)]
        if (T.fullColl[feet] || T.fullColl[head]) continue
        const who = MOBS.filter(([, w, h]: any) => fits(g, T, x, y, z, w, h)).map(mm => mm[0])
        if (!who.length) continue
        spots++
        hist[L[i]]++
        if (L[i] < minLight) minLight = L[i]
        if (L[i] === 0) bad.push({ x, y, z, on: g.pal[below], who })
        if (L[i] <= (opts.lowAt || 2)) low.push({ x, y, z, L: L[i], on: g.pal[below] })
      }
    }
  }
  return { spots, bad, low, minLight, hist, L, T }
}

export { tables, scene, blockLight, check, fits }

if (require.main === module) {
  const R = Number(process.argv[2] || 24); const ceilH = Number(process.argv[3] || 16)
  const scenarios = [
    ['поле целое', {} as Record<string, any>],
    ['8 дыр 3×3 у краёв', { holes: [{ x: -21, z: -21, s: 3 }, { x: 18, z: -21, s: 3 }, { x: -21, z: 18, s: 3 }, { x: 18, z: 18, s: 3 }, { x: -3, z: -21, s: 3 }, { x: -3, z: 18, s: 3 }, { x: -21, z: -1, s: 3 }, { x: 18, z: -1, s: 3 }] }],
    ['весь светокамень поля выбит', { noGlowstone: true }]
  ]
  for (const [name, o] of scenarios) {
    const m = C.model({ R, ceilH })
    const t0 = Date.now()
    const r = check(m, o)
    console.log(`${name}: мест для спавна ${r.spots}, мин. свет ${r.minLight}, тёмных ${r.bad.length} (${Date.now() - t0} мс)`)
    console.log('  свет по местам: ' + r.hist.map((c, i) => c ? `${i}:${c}` : '').filter(Boolean).join(' '))
    const groups: Record<string, any> = {} as Record<string, any>
    for (const b of r.bad) { const k = `${b.on.replace(/\[.*/, '')} y${b.y}`; (groups[k] = groups[k] || []).push(`${b.x},${b.z}`) }
    for (const [k, v] of Object.entries<any>(groups)) console.log(`  ТЕМНО ${k}: ${v.length} — ${v.slice(0, 12).join(' ')}${v.length > 12 ? ' …' : ''}`)
    const lg: Record<string, any> = {} as Record<string, any>
    for (const b of r.low) { const k = `свет ${b.L} на ${b.on.replace(/\[.*/, '')} dy${b.y}`; (lg[k] = lg[k] || []).push(`${b.x},${b.z}`) }
    for (const [k, v] of Object.entries<any>(lg)) console.log(`  мало: ${k}: ${v.length} — ${v.slice(0, 8).join(' ')}${v.length > 8 ? ' …' : ''}`)
  }
}
