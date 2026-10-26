'use strict'
// Гонка вооружений в Колизее (пользователь 10.10: «чтобы в колизее была гонка вооружений, там красиво… комнат по всему
// колизею»). Колизей уже стоит (colosseum.js, центр поля — X Y Z, ноги на dy 0); здесь — только то, что добавляется к нему:
//   · поле открыто (барьер кольца и потолок над полем — воздух), на песке укрытия: обломки колонн, стенки;
//   · 8 камер (carceres) под подиумом и первым ярусом рядов, вход с песка; по 2 сундука, в 4 — тайник за досками;
//   · лаборатория под северной ложей (стойка, верстак, печь, наковальня, стол, вода), оружейная под пульвинаром (юг);
//   · 4 лестницы с песка на террасу (диагонали) — дальше ряды, пояса и вомитории на галереи 2-го и 3-го ярусов;
//   · сундуки в галереях всех трёх ярусов, на первом — 2 тайника в стене; старты — у ворот (запад красным, восток синим);
//   · комнаты спавна людей — по две у каждых ворот, сквозные: колоннада в тоннель и портал на песок (spawnRooms).
// Тот же формат, что arms-layout (farm/arena/ffa.js arms): chests, rooms, secret, spawns, lab, areas (зоны лута с высотой), half.
import * as C from './colosseum'

const FACADE = 'oak_planks' // облицовка тайника, как в arms-layout: признак, ломается рукой
const UNDER = 'coarse_dirt'
const FILL = 'smooth_sandstone'
const deg = (d) => d * Math.PI / 180

function rng (seed) {
  let h = [...String(seed)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7)
  return () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296 }
}

// Камеры под подиумом и лестницы на террасу (углы, °): их места обходят и укрытия на песке.
const CAMERAS = [25, 55, 125, 155, 205, 235, 305, 335]
const STAIRS = [45, 135, 225, 315]

// Раскладка — части по порядку (номера разделов — в комментариях частей; зерно rnd тянется в том же порядке).
function generate (seed = 'colos') {
  const ac = armsContext(seed)
  const { p, R, out } = ac
  armsCameras(ac)
  const lab = armsHalls(ac)
  armsStairs(ac)
  armsGalleries(ac)
  armsCover(ac)
  armsField(ac)
  const spawnRooms = armsSpawnRooms(ac)

  return {
    seed: String(seed), version: 1, map: 'colosseum', half: Math.ceil(p.outA + 3), ellipse: { a: p.outA, b: p.outB }, y0: -4, y1: 40, R,
    chests: out.chests, rooms: out.rooms, secret: out.secret, areas: out.areas, set: out.set, field: out.field,
    spawns: [{ x: -36, y: 0, z: 0, yaw: -90 }, { x: 36, y: 0, z: 0, yaw: 90 }], spawnRooms,
    lab, facade: FACADE, under: UNDER
  }
}

// Общее для частей раскладки: эллипс колизея, зерно, сбор блоков и сундуков (прежние const тела generate).
function armsContext (seed) {
  const p = C.params({})
  const { A1, B1, R } = p
  const rnd = rng(seed)
  const E = (t) => ({ x: A1 * Math.cos(t), z: B1 * Math.sin(t) })
  const Nt = (t) => { const x = B1 * Math.cos(t); const z = A1 * Math.sin(t); const l = Math.hypot(x, z); return { x: x / l, z: z / l } }
  const Tt = (t) => { const n = Nt(t); return { x: -n.z, z: n.x } }
  const out = { field: [] as any[], set: [] as any[], chests: [] as any[], rooms: [] as any[], secret: [] as string[], areas: [] as any[] }
  const S = (x, y, z, b) => out.set.push([x, y, z, b])
  // Клетки кольца n∈[n0,n1) в полосе |сдвиг вдоль касательной в точке t0| ≤ lat.
  const band = (t0, n0, n1, lat) => {
    const e = E(t0); const T = Tt(t0); const N = Nt(t0); const cells = []
    const cx = Math.round(e.x + N.x * (n0 + n1) / 2); const cz = Math.round(e.z + N.z * (n0 + n1) / 2)
    const r = Math.ceil(Math.abs(n1 - n0) + lat + 3)
    for (let x = cx - r; x <= cx + r; x++) {
      for (let z = cz - r; z <= cz + r; z++) {
        const f = C.foot(A1, B1, x, z)
        if (f.n < n0 || f.n >= n1) continue
        const l = (x - e.x) * T.x + (z - e.z) * T.z
        if (Math.abs(l) > lat) continue
        cells.push({ x, z, n: f.n, k: Math.floor(f.n), l })
      }
    }
    return cells
  }
  const at = (t0, n, l = 0) => { const e = E(t0); const N = Nt(t0); const T = Tt(t0); return { x: Math.round(e.x + N.x * n + T.x * l), z: Math.round(e.z + N.z * n + T.z * l) } }
  const inward = (t0) => { const N = Nt(t0); return C.dir4(-N.x, -N.z) }
  const outward = (t0) => { const N = Nt(t0); return C.dir4(N.x, N.z) }
  let nid = 0
  const chest = (x, y, z, facing, room, kind, tier, cover = null) => {
    out.chests.push({ id: `c${++nid}`, x, y, z, facing, room, kind, tier, ...(cover ? { cover } : {}) })
    S(x, y, z, `chest[facing=${facing}]`)
  }
  return { p, A1, B1, R, rnd, E, Nt, Tt, out, S, band, at, inward, outward, chest }
}

type ArmsCtx = ReturnType<typeof armsContext>

function armsCameras (ac: ArmsCtx) {
  const { out, S, band, at, inward, chest } = ac
  // ---- 1. Камеры под подиумом (k 0..7): дверь 3×2 в подиуме, зал 6 бл. шириной, свет в потолке.
  CAMERAS.forEach((d, j) => {
    const t = deg(d); const id = `камера${j + 1}`
    for (const c of band(t, 0, 8, 2.6)) {
      if (c.k === 0 && Math.abs(c.l) > 1.2) continue // дверь уже зала
      for (let y = 0; y <= (c.k === 0 ? 1 : 2); y++) S(c.x, y, c.z, 'air')
    }
    for (const n of [3.5, 6.5]) { const q = at(t, n); S(q.x, 3, q.z, 'glowstone') }
    const f = inward(t)
    const a = at(t, 7.5, -2); const b = at(t, 7.5, 2)
    chest(a.x, 0, a.z, f, id, 'room', 1)
    chest(b.x, 0, b.z, f, id, 'room', 2)
    const mid = at(t, 4)
    out.rooms.push({ id, x0: mid.x - 3, x1: mid.x + 3, z0: mid.z - 3, z1: mid.z + 3 })
    out.areas.push({ id, x: mid.x, y: 0, z: mid.z })
    // Тайник в задней стене (каждая вторая камера): доски в стене, сундук за ними.
    if (j % 2 === 0) {
      const cv = at(t, 8.5); const sc = at(t, 9.5)
      S(sc.x, 0, sc.z, 'air'); S(sc.x, 1, sc.z, FILL)
      S(cv.x, 0, cv.z, FACADE); S(cv.x, 1, cv.z, FACADE)
      chest(sc.x, 0, sc.z, f, id, 'niche', 3, [{ x: cv.x, y: 0, z: cv.z, block: FACADE }, { x: cv.x, y: 1, z: cv.z, block: FACADE }])
      out.secret.push(`${id}-тайник`)
    }
  })
}

function armsHalls (ac: ArmsCtx) {
  const { B1, out, S, chest } = ac
  // ---- 2. Лаборатория (север, под ложей) и оружейная (юг, под пульвинаром): |x| ≤ 5, k 0..7.
  const hall = (sgn, id) => {
    const zIn = sgn * (B1 + 0); const zBack = sgn * (B1 + 7)
    for (let x = -5; x <= 5; x++) {
      for (let k = 0; k <= 7; k++) { const z = sgn * (B1 + k); for (let y = 0; y <= 2; y++) S(x, y, z, 'air') }
    }
    for (const x of [-3, 3]) S(x, 3, sgn * (B1 + 4), 'glowstone')
    out.rooms.push({ id, x0: -5, x1: 5, z0: Math.min(zIn, zBack), z1: Math.max(zIn, zBack) })
    out.areas.push({ id, x: 0, y: 0, z: sgn * (B1 + 4) })
    return zBack
  }
  const zl = hall(-1, 'лаборатория')
  const lab = {
    room: 'лаборатория',
    brewing: { x: 2, y: 0, z: zl }, crafting: { x: -2, y: 0, z: zl }, furnace: { x: -4, y: 0, z: zl },
    anvil: { x: 4, y: 0, z: zl }, table: { x: 0, y: 0, z: zl }, water: { x: 0, y: -1, z: zl + 3 }
  }
  S(lab.brewing.x, 0, zl, 'brewing_stand'); S(lab.crafting.x, 0, zl, 'crafting_table'); S(lab.furnace.x, 0, zl, 'furnace[facing=south]')
  S(lab.anvil.x, 0, zl, 'anvil[facing=east]'); S(lab.table.x, 0, zl, 'enchanting_table')
  // Полки — не над сундуком-складом алхимика (x 1, ffa brewTask: labChest): над ним полка — сундук не открыть (10.10).
  for (const x of [-1, -3]) S(x, 1, zl, 'bookshelf')
  S(1, 1, zl, 'air')
  S(lab.water.x, -1, lab.water.z, 'water')
  const za = hall(1, 'оружейная')
  for (const x of [-4, -2, 2, 4]) chest(x, 0, za, 'north', 'оружейная', 'armory', 3)
  S(0, 0, za, 'smithing_table')
  return lab
}

function armsStairs (ac: ArmsCtx) {
  const { out, S, band, at, outward } = ac
  // ---- 3. Лестницы с песка на террасу (диагонали): ступени n −4..−1 (ноги 0→4), парапет над ними снят.
  for (const d of STAIRS) {
    const t = deg(d); const up = outward(t)
    for (const c of band(t, -4, 1, 1.2)) {
      if (c.k === 0) { S(c.x, 4, c.z, 'air'); continue }
      const h = c.k + 4 // −4→0, −1→3
      for (let y = 0; y < h; y++) S(c.x, y, c.z, FILL)
      S(c.x, h, c.z, `smooth_sandstone_stairs[facing=${up}]`)
      for (let y = h + 1; y <= h + 2; y++) S(c.x, y, c.z, 'air')
    }
    const q = at(t, -6)
    out.areas.push({ id: `лестница${d}`, x: q.x, y: 0, z: q.z })
  }
}

function armsGalleries (ac: ArmsCtx) {
  const { A1, B1, out, S, at, inward, outward, chest } = ac
  // ---- 4. Галереи: сундук у внутренней стены (k 22) на ярусах 0/8/16; на первом ярусе — 2 тайника в стене рядов.
  // Нижний ярус — вдвое гуще (10.10: «больше сундуков и нычек — замес»).
  const G = [[0, [20, 40, 55, 70, 110, 125, 140, 160, 200, 220, 235, 250, 290, 305, 320, 340]], [8, [30, 150, 210, 330]], [16, [60, 120, 240, 300]]]
  for (const [y, list] of G as any) {
    for (const d of list) {
      const t = deg(d); const c = at(t, 22.5)
      chest(c.x, y, c.z, outward(t), `галерея${y / 8 + 1}`, 'gallery', y ? 3 : 2)
      const m = at(t, 23.5)
      out.areas.push({ id: `галерея${y / 8 + 1}-${d}`, x: m.x, y, z: m.z })
    }
  }
  out.rooms.push({ id: 'галерея1', x0: -A1 - 25, x1: A1 + 25, z0: -B1 - 25, z1: B1 + 25 })
  for (const d of [90, 270]) {
    const t = deg(d); const cv = at(t, 21.5); const sc = at(t, 20.5)
    S(sc.x, 0, sc.z, 'air'); S(sc.x, 1, sc.z, FILL)
    S(cv.x, 0, cv.z, FACADE); S(cv.x, 1, cv.z, FACADE)
    chest(sc.x, 0, sc.z, outward(t), 'галерея1', 'secret', 3, [{ x: cv.x, y: 0, z: cv.z, block: FACADE }, { x: cv.x, y: 1, z: cv.z, block: FACADE }])
    out.secret.push(`галерея-${d}-тайник`)
  }

  // ---- 4б. Ярусы вверх (пользователь 14.10: «чем выше этаж — тем круче лут; сундуки на самом верху Колизея, куда можно
  // жемчугом, — там тоже вооружение, и боты пусть туда лазают»): проходы рядов (пояс 1 — dy 8, пояс 2 — dy 16), галерея
  // 4-го яруса (dy 24), крыша-терраса над рядами (dy 31, кольца 21–24: с верха рядов +7 — только жемчугом, столбом, на
  // элитрах) и венец стены (dy 34, кольца 25–27: ещё +3 над террасой). Ярус лута считает набивка по высоте (ffa loot).
  // Сундук на проходе — у внутреннего края (кольцо 8 и 15), вторая клетка прохода свободна.
  for (const [n, y, list, id] of [[8.3, 8, [60, 120, 240, 300], 'пояс1'], [15.3, 16, [30, 150, 210, 330], 'пояс2'], [22.5, 24, [45, 135, 225, 315], 'галерея4'],
    [22.5, 31, [20, 70, 110, 160, 200, 250, 290, 340], 'крыша'], [26.5, 34, [45, 135, 225, 315], 'венец']] as any) {
    for (const d of list) {
      const t = deg(d); const c = at(t, n)
      // Крыша и венец выложены нижними плитами (dy 30 и 33, ноги на +½): сундук — на месте плиты, не висит над ней.
      chest(c.x, y >= 31 ? y - 1 : y, c.z, inward(t), id, y >= 31 ? 'roof' : 'tier', 3)
      out.areas.push({ id: `${id}-${d}`, x: c.x, y, z: c.z })
    }
  }
}

function armsCover (ac: ArmsCtx) {
  const { R, rnd, Tt, S, at } = ac
  // ---- 5. Укрытия на песке: обломки колонн (1–3) и стенки 3×2 по касательной; не на дороге, лестницах, у дверей и лож.
  const avoid = [...CAMERAS, ...STAIRS, 0, 90, 180, 270, 10, 170, 190, 350].map(deg) // 10/170/190/350 — боковые порталы комнат спавна
  const angDist = (a, b) => { const v = Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI); return v }
  let placed = 0
  for (let tries = 0; tries < 400 && placed < 22; tries++) {
    const t = rnd() * 2 * Math.PI; const n = -3 - rnd() * 7
    if (avoid.some(a => angDist(a, t) < deg(9))) continue
    const q = at(t, n)
    if (Math.abs(q.x) <= R + 3 && Math.abs(q.z) <= R + 3) continue // у бордюра поля
    if (Math.abs(q.z) <= 5 && Math.abs(q.x) > R) continue // дорога к воротам
    if (rnd() < 0.55) {
      const h = 1 + Math.floor(rnd() * 3)
      for (let y = 0; y < h; y++) S(q.x, y, q.z, y === h - 1 && h < 3 ? 'chiseled_quartz_block' : 'quartz_pillar[axis=y]')
    } else {
      const T = Tt(t)
      for (let l = -1; l <= 1; l++) {
        const x = Math.round(q.x + T.x * l); const z = Math.round(q.z + T.z * l)
        S(x, 0, z, 'cut_sandstone'); S(x, 1, z, l === 0 && rnd() < 0.5 ? 'smooth_sandstone_slab' : 'cut_sandstone')
      }
    }
    placed++
  }
}

function armsField (ac: ArmsCtx) {
  const { R, rnd, out, at, chest } = ac
  // Поле — рельеф по зерну (пользователь 10.10: «мало ям с лавой, куда скидывать друг друга, рельеф ровный — разнообразнее»):
  // холмы-конусы и площадки с пандусом (высота карты h ≥ 0), у их подножия — ямы с лавой (h = −1, лава вровень с полом, под
  // ней песчаник, край — магма), между ними — колонны-укрытия. Центр (|x|,|z| < 4) ровный: там сходятся.
  const H = new Map<string, number>()
  const key = (x, z) => `${x},${z}`
  const inField = (x, z) => Math.abs(x) <= R - 1 && Math.abs(z) <= R - 1
  const central = (x, z) => Math.abs(x) < 4 && Math.abs(z) < 4
  const tops: any[] = []
  for (let k = 0, tries = 0; k < 4 + Math.floor(rnd() * 3) && tries < 100; tries++) {
    const cx = Math.round((rnd() * 2 - 1) * (R - 6)); const cz = Math.round((rnd() * 2 - 1) * (R - 6))
    if (Math.abs(cx) < 8 && Math.abs(cz) < 8) continue
    const r = 3 + Math.floor(rnd() * 4); const h = 2 + Math.floor(rnd() * 3)
    for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++) {
      if (!inField(x, z) || central(x, z)) continue
      const v = Math.round(h * (1 - Math.hypot(x - cx, z - cz) / (r + 0.5)))
      if (v > 0) H.set(key(x, z), Math.max(H.get(key(x, z)) || 0, v))
    }
    tops.push({ x: cx, z: cz, r })
    k++
  }
  for (let k = 0, tries = 0; k < 1 + Math.floor(rnd() * 2) && tries < 50; tries++) {
    const cx = Math.round((rnd() * 2 - 1) * (R - 7)); const cz = Math.round((rnd() * 2 - 1) * (R - 7))
    if (Math.abs(cx) < 9 && Math.abs(cz) < 9) continue
    const w = 2 + Math.floor(rnd() * 2); const h = 3
    for (let x = cx - w; x <= cx + w; x++) for (let z = cz - w; z <= cz + w; z++) if (inField(x, z)) H.set(key(x, z), Math.max(H.get(key(x, z)) || 0, h))
    // Пандус к центру по большей оси: ступени h-1 … 1.
    const sx = Math.sign(-cx) || 1
    for (let s = 1; s < h; s++) for (let z = cz - 1; z <= cz + 1; z++) { const x = cx + sx * (w + s); if (inField(x, z)) H.set(key(x, z), Math.max(H.get(key(x, z)) || 0, h - s)) }
    tops.push({ x: cx, z: cz, r: w + 1 })
    k++
  }
  // Ямы с лавой — у подножия возвышений (скинуть с высоты), 1–2 бл. в радиусе.
  for (let k = 0, tries = 0; k < 4 + Math.floor(rnd() * 3) && tries < 200; tries++) {
    const t = tops[Math.floor(rnd() * tops.length)]; if (!t) break
    const a = rnd() * Math.PI * 2; const d = t.r + 1.5 + rnd()
    const cx = Math.round(t.x + Math.cos(a) * d); const cz = Math.round(t.z + Math.sin(a) * d)
    const pr = rnd() < 0.5 ? 1 : 1.6
    if (!inField(cx, cz) || central(cx, cz) || (H.get(key(cx, cz)) || 0) > 0) continue
    for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) if (inField(x, z) && !central(x, z) && Math.hypot(x - cx, z - cz) <= pr && !(H.get(key(x, z)) > 0)) H.set(key(x, z), -1)
    k++
  }
  for (const [k, h] of H) {
    const [x, z] = k.split(',').map(Number)
    if (h < 0) {
      out.field.push([x, -2, z, 'sandstone'], [x, -1, z, 'lava'])
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!H.has(key(x + dx, z + dz)) && inField(x + dx, z + dz)) out.field.push([x + dx, -1, z + dz, 'magma_block'])
    } else for (let y = 0; y < h; y++) out.field.push([x, y, z, y === h - 1 ? 'sand' : 'smooth_sandstone'])
  }
  // Нычки под песком поля (10.10): сундук на −2, сверху песок пола — раскопать (cover). Не в ямах и не под холмами.
  for (let k = 0, tries = 0; k < 10 && tries < 300; tries++) {
    const x = Math.round((rnd() * 2 - 1) * (R - 2)); const z = Math.round((rnd() * 2 - 1) * (R - 2))
    if (central(x, z) || [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => H.has(key(x + dx, z + dz)))) continue
    if (out.chests.some(c => c.kind === 'under' && Math.abs(c.x - x) + Math.abs(c.z - z) < 6)) continue
    chest(x, -2, z, 'north', 'нычка поля', 'under', 3, [{ x, y: -1, z, block: 'sand' }])
    k++
  }
  // Колонны-укрытия — на ровном.
  for (let k = 0, tries = 0; k < 6 && tries < 200; tries++) {
    const x = Math.round((rnd() * 2 - 1) * (R - 3)); const z = Math.round((rnd() * 2 - 1) * (R - 3))
    if (central(x, z) || H.has(key(x, z))) continue
    const h = 1 + Math.floor(rnd() * 3)
    for (let y = 0; y < h; y++) out.field.push([x, y, z, y === h - 1 && h < 3 ? 'chiseled_quartz_block' : 'quartz_pillar[axis=y]'])
    k++
  }
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) out.areas.push({ id: `поле${sx}${sz}`, x: 12 * sx, y: 0, z: 12 * sz })
  for (const d of [20, 160, 200, 340]) { const q = at(deg(d), -5); out.areas.push({ id: `песок${d}`, x: q.x, y: 0, z: q.z }) }
}

function armsSpawnRooms (ac: ArmsCtx) {
  const { A1, B1, S, chest } = ac
  // ---- 6. Комнаты спавна людей (пользователь 14.10: «комнаты закрытые с освещением для спавна игроков, интегрировать в
  // колизей, чтобы красиво; сундуки с лутом с некоторой вероятностью»; затем: «проход только широкий — узкий не для толпы
  // ботов; двери не надо, сквозной»): по две у каждых ворот, по бокам тоннеля, в засыпке под рядами (кольца 6..16, |z| 3..9,
  // высота 4). Комната сквозная: к тоннелю — колоннада (проёмы 2+3+2), к арене — боковой портал 5 бл. сквозь подиум рядом с
  // воротами. Запад — красным, восток — синим (как старты). Внутри: колонны по углам, пилястры, пол — шахматка
  // кварц/песчаник с каймой, дорожка и знамя цвета команды, свет в потолке. Не в areas: сундуки боты видят только глазами.
  const spawnRooms: any[] = []
  for (const sx of [-1, 1]) {
    const team = sx < 0 ? 'red' : 'blue'
    for (const sz of [-1, 1]) {
      const id = `спавн-${sx < 0 ? 'запад' : 'восток'}-${sz < 0 ? 'север' : 'юг'}`
      // u — вдоль тоннеля от поля наружу (1..11 внутри, 0 и 12 — торцы), v = |z| (3..9 внутри, 2 — стена тоннеля, 10 — задняя).
      const X = (u) => sx * (A1 + 5 + u); const Zv = (v) => sz * v
      const front = sz > 0 ? 'north' : 'south' // к тоннелю
      for (let u = 1; u <= 11; u++) {
        for (let v = 3; v <= 9; v++) {
          const rim = u === 1 || u === 11 || v === 3 || v === 9
          S(X(u), -1, Zv(v), rim ? 'quartz_bricks' : (u + v) % 2 ? 'cut_sandstone' : 'smooth_quartz')
          for (let y = 0; y <= 3; y++) S(X(u), y, Zv(v), 'air')
          S(X(u), 4, Zv(v), 'smooth_quartz')
        }
      }
      // Стены: цоколь кварцем, фриз резным песчаником (задняя и торцы).
      for (let u = 0; u <= 12; u++) { S(X(u), 0, Zv(10), 'smooth_quartz'); S(X(u), 3, Zv(10), 'cut_sandstone') }
      for (const u of [0, 12]) for (let v = 3; v <= 9; v++) { S(X(u), 0, Zv(v), 'smooth_quartz'); S(X(u), 3, Zv(v), 'cut_sandstone') }
      // Пилястры задней стены и колонны в углах.
      for (const u of [4, 8]) { for (let y = 0; y <= 2; y++) S(X(u), y, Zv(10), 'quartz_pillar[axis=y]'); S(X(u), 3, Zv(10), 'chiseled_quartz_block') }
      for (const u of [1, 11]) for (const v of [3, 9]) { for (let y = 0; y <= 2; y++) S(X(u), y, Zv(v), 'quartz_pillar[axis=y]'); S(X(u), 3, Zv(v), 'chiseled_quartz_block') }
      // Свет: светогриб в центре потолка, два фонаря под резными кессонами.
      S(X(6), 4, Zv(6), 'shroomlight')
      for (const u of [3, 9]) { S(X(u), 4, Zv(6), 'chiseled_quartz_block'); S(X(u), 3, Zv(6), 'lantern[hanging=true]') }
      // Колоннада к тоннелю: стена тоннеля открыта на u 2..10, две колонны (u 4, 8), порог кварцем, архитрав сверху.
      for (let u = 1; u <= 11; u++) S(X(u), 3, Zv(2), 'smooth_quartz')
      for (let u = 2; u <= 10; u++) {
        const col = u === 4 || u === 8
        S(X(u), -1, Zv(2), 'quartz_bricks')
        for (let y = 0; y <= 2; y++) S(X(u), y, Zv(2), col ? 'quartz_pillar[axis=y]' : 'air')
      }
      // Боковой портал на арену: проход v 4..8 от торца комнаты сквозь засыпку и подиум до песка (n < 0), высота 3;
      // в лице подиума — перемычка резным кварцем и колонны по краям, свет в потолке прохода (плитка на террасе).
      const face = (v) => { let u = 0; while (C.foot(A1, B1, X(u - 1), Zv(v)).n >= 0) u--; return u }
      for (let v = 4; v <= 8; v++) {
        for (let u = 0; u >= face(v); u--) { S(X(u), -1, Zv(v), 'cut_sandstone'); for (let y = 0; y <= 2; y++) S(X(u), y, Zv(v), 'air') }
        S(X(face(v)), 3, Zv(v), 'chiseled_quartz_block')
      }
      for (const v of [3, 9]) for (let y = 0; y <= 3; y++) S(X(face(v)), y, Zv(v), 'quartz_pillar[axis=y]')
      S(X(-2), 3, Zv(6), 'glowstone')
      // Дорожка от тоннеля к знамени, знамя цвета команды на задней стене.
      for (let v = 3; v <= 6; v++) S(X(6), 0, Zv(v), `${team}_carpet`)
      S(X(6), 2, Zv(9), `${team}_wall_banner[facing=${front}]{patterns:[{color:"yellow",pattern:"minecraft:border"},{color:"yellow",pattern:"minecraft:stripe_middle"}]}`)
      // Сундуки у задней стены — места; есть ли сундук в раунде, решает набивка (ARMS_SPAWN_CHEST, ffa loot).
      chest(X(2), 0, Zv(9), front, id, 'spawn', 2)
      chest(X(10), 0, Zv(9), front, id, 'spawn', 2)
      // Точка — в конце дорожки, у знамени (не на ковре: точке возрождения нужна целая клетка воздуха), лицом к тоннелю.
      spawnRooms.push({ id, team, spot: { x: X(6), y: 0, z: Zv(7), yaw: front === 'north' ? 180 : 0 } })
    }
  }
  return spawnRooms
}

// Команды: поле открыть (барьер — воздух), затем блоки поверх колизея. Сундуки — пустыми (набивает ffa по раунду).
function commands (L, { X, Y, Z }) {
  const cmds = []
  const r = L.R + 1
  for (const [y0, y1] of [[-1, 7], [8, 17]]) cmds.push(`fill ${X - r} ${Y + y0} ${Z - r} ${X + r} ${Y + y1} ${Z + r} minecraft:air replace minecraft:barrier`)
  // Поле ровное: всё выше пола — воздух (рельеф прошлых сцен), пол — песок; потом укрытия.
  const f = L.R
  for (const [y0, y1] of [[0, 8], [9, 17]]) cmds.push(`fill ${X - f} ${Y + y0} ${Z - f} ${X + f} ${Y + y1} ${Z + f} minecraft:air`)
  cmds.push(`fill ${X - f} ${Y - 1} ${Z - f} ${X + f} ${Y - 1} ${Z + f} minecraft:sand`)
  for (const [x, y, z, b] of L.field) cmds.push(`setblock ${X + x} ${Y + y} ${Z + z} minecraft:${b}`)
  // Сундук — после воздуха и стен клетки: последним по клетке побеждает поздний.
  const last = new Map()
  for (const [x, y, z, b] of L.set) last.set(`${x},${y},${z}`, [x, y, z, b])
  const order = [...last.values()].sort((a, b) => (/chest|stand|table|anvil|furnace|water|bookshelf/.test(a[3]) ? 1 : 0) - (/chest|stand|table|anvil|furnace|water|bookshelf/.test(b[3]) ? 1 : 0))
  for (const [x, y, z, b] of order) cmds.push(`setblock ${X + x} ${Y + y} ${Z + z} minecraft:${b}`)
  // Над сундуком — не сплошной блок: иначе крышка упирается и сундук не открывается ни у кого (ChestBlock.isChestBlockedAt,
  // 10.10: ниши и галереи — «сундуки не открываются»). Верхняя плита держит вид стены и не мешает.
  for (const c of L.chests.filter(c => !(c.cover || []).some(v => v.x === c.x && v.z === c.z && v.y === c.y + 1))) cmds.push(`execute unless block ${X + c.x} ${Y + c.y + 1} ${Z + c.z} minecraft:air run setblock ${X + c.x} ${Y + c.y + 1} ${Z + c.z} minecraft:smooth_sandstone_slab[type=top]`)
  return cmds
}

export { generate, commands, FACADE, UNDER }
