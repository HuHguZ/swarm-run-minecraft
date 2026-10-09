'use strict'
// «Гонка вооружений» (TODO «PvP Гонка вооружений» п.1–3, 8; s7 2026-10-06):
// генератор раскладки по seed. Только данные — без игры: воксельная модель
// (Grid из colosseum.js, координаты от центра, пол — y=-1, стоят на y=0),
// сундуки с содержимым, лаборатория, старты, комнаты, опись для сброса,
// проверки чар (таблица jar 1.21.11 из arena-ench) и достижимости.
//
// Карта (зеркальна по x → −x: старты на западе и востоке, лаборатория на оси):
//   поле |x|,|z| ≤ 12 — трава, холмы, деревья, открытая руда, пруд на оси;
//   внутренняя стена (13), кольцевой коридор 14..16, средняя стена (17),
//   комнаты 18..25 (16 шт.: углы и по три на сторону), внешняя стена 26..28;
//   крыша коридора и комнат (y=4) — второй уровень, лестницы из коридора;
//   потолок-барьер y=12. Тайники: ниша во внешней стене за облицовкой
//   (доски oak_planks), сундук под полом поля (coarse_dirt), закрытая
//   угловая комната (дверь заложена облицовкой). Бот знает архитектуру
//   (комнаты), но не сундуки: их видят только глазами (arms-run).
//
//   node arms-layout.js <seed> [--json]      — сводка раскладки и проверок
const { Grid } = require('./colosseum')
const ench = require('./arena-ench')

const HALF = 28 // габарит по x/z (внешняя стена 26..28)
const Y0 = -4
const Y1 = 12 // потолок-барьер
const WALL = 'stone_bricks'
const FACADE = 'oak_planks' // облицовка тайника — «заколочено» доской: признак, ломается рукой (≈3 с); cracked_stone_bricks mine без кирки не берёт (s7-arms24/25)
const UNDER = 'coarse_dirt' // заплатка над сундуком под полом
const ROCKET3 = 'firework_rocket[fireworks={flight_duration:1,explosions:[{shape:"small_ball"},{shape:"small_ball"},{shape:"small_ball"}]}]'
const pot = (kind, name) => `${kind}[potion_contents={potion:"minecraft:${name}"}]`

// ---------------------------------------------------------------- случайность
function rng (seed) {
  let a = 0
  for (const ch of String(seed)) a = (Math.imul(a, 31) + ch.charCodeAt(0)) | 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const mk = (rand) => ({
  f: rand,
  i: (a, b) => a + Math.floor(rand() * (b - a + 1)),
  pick: (xs) => xs[Math.floor(rand() * xs.length)],
  w: (list) => { const s = list.reduce((n, x) => n + x.w, 0); let r = rand() * s; for (const x of list) { r -= x.w; if (r <= 0) return x } return list[list.length - 1] }
})

// ---------------------------------------------------------------- чары
// Случайные ванильные чары предмету: применимые (supported_items), без
// исключающих пар (exclusive_set), уровень ≤ max_level. Проклятия — нет.
const CURSE = /curse/
function randomEnch (id, R, n) {
  const pool = ench.applicable(id).filter(e => !CURSE.test(e))
  const out = {}
  for (let k = 0; k < 8 && Object.keys(out).length < n && pool.length; k++) {
    const e = R.pick(pool)
    if (out[e] || Object.keys(out).some(o => ench.clash(o, e))) continue
    const max = ench.ENCH[e][0]
    out[e] = Math.max(1, Math.min(max, 1 + Math.floor(R.f() * R.f() * max + 0.35)))
  }
  return out
}
const enchStr = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(',')
function gear (id, R, p = 0.3, n = 2) {
  if (R.f() >= p || !ench.applicable(id).length) return id
  const e = randomEnch(id, R, R.i(1, n))
  return Object.keys(e).length ? `${id}[enchantments={${enchStr(e)}}]` : id
}
function book (R) {
  const all = Object.keys(ench.ENCH).filter(e => !CURSE.test(e))
  const e = R.pick(all)
  return `enchanted_book[stored_enchantments={${e}:${R.i(1, ench.ENCH[e][0])}}]`
}

// Проверка строки предмета: чары применимы, уровень в пределах, без конфликтов.
function checkItem (s) {
  const id = s.replace(/\[.*$/, '').split(' ')[0]
  const errs = []
  const m = s.match(/(stored_enchantments|enchantments)=\{([^}]*)\}/)
  if (!m) return errs
  const list = m[2].split(',').filter(Boolean).map(kv => { const [k, v] = kv.split(':'); return [k, Number(v)] })
  for (const [k, v] of list) {
    if (!ench.ENCH[k]) { errs.push(`${id}: нет чар ${k}`); continue }
    if (!(v >= 1 && v <= ench.ENCH[k][0])) errs.push(`${id}: ${k} ${v} > ${ench.ENCH[k][0]}`)
    if (m[1] === 'enchantments' && !ench.applicable(id).includes(k)) errs.push(`${id}: ${k} неприменимо`)
  }
  for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) if (ench.ENCH[list[a][0]] && ench.ENCH[list[b][0]] && ench.clash(list[a][0], list[b][0])) errs.push(`${id}: ${list[a][0]}+${list[b][0]} несовместимы`)
  return errs
}

// ---------------------------------------------------------------- пул лута
// w — вес, v — ценность (сила в бою, грубо: алмазный меч 7, тотем 10),
// tier — где лежит: 0 обычный, 1 комнаты, 2 тайники и редкое.
// Комплекты: арбалету — боеприпасы, якорю — светокамень, элитрам — ракеты.
const MAT: [string, number][] = [['wooden', 1], ['stone', 2], ['copper', 2.5], ['iron', 4], ['diamond', 7]]
const ARM: [string, number][] = [['leather', 1], ['copper', 1.5], ['chainmail', 2], ['iron', 3], ['diamond', 5]]
const POOL = [
  { w: 10, v: 1, t: 0, g: (R) => [`cooked_beef ${R.i(3, 8)}`] },
  { w: 6, v: 1, t: 0, g: (R) => [`bread ${R.i(4, 8)}`] },
  { w: 5, v: 1, t: 0, g: (R) => [`cobblestone ${R.i(16, 48)}`] },
  { w: 5, v: 1, t: 0, g: (R) => [`oak_planks ${R.i(8, 24)}`] },
  { w: 3, v: 1, t: 0, g: (R) => [`oak_log ${R.i(3, 8)}`] },
  { w: 4, v: 2, t: 0, g: (R) => [`golden_apple ${R.i(1, 2)}`] },
  { w: 10, v: 0, t: 0, g: (R) => { const [m, v] = R.pick(MAT.slice(0, 4)); return [gear(`${m}_sword`, R, 0.2)] }, val: (s) => valOf(s, 'sword') },
  { w: 6, v: 0, t: 0, g: (R) => { const [m] = R.pick(MAT.slice(0, 4)); return [gear(`${m}_axe`, R, 0.2)] }, val: (s) => valOf(s, 'axe') },
  { w: 6, v: 0, t: 0, g: (R) => { const [m] = R.pick(MAT.slice(1, 4)); return [gear(`${m}_pickaxe`, R, 0.2)] }, val: (s) => valOf(s, 'pickaxe') },
  { w: 16, v: 0, t: 0, g: (R) => { const [m] = R.pick(ARM); const part = R.pick(['helmet', 'chestplate', 'leggings', 'boots']); return [gear(`${m}_${part}`, R, 0.25)] }, val: (s) => valOf(s, 'armor') },
  { w: 4, v: 4, t: 0, g: () => ['shield'] },
  { w: 5, v: 5, t: 1, g: (R) => [gear('bow', R, 0.3), `arrow ${R.i(12, 32)}`] },
  { w: 4, v: 1.5, t: 0, g: (R) => [`arrow ${R.i(8, 24)}`] },
  { w: 3, v: 5, t: 1, g: (R) => [gear('crossbow', R, 0.35), `arrow ${R.i(12, 24)}`] },
  { w: 4, v: 3, t: 1, g: (R) => [`${pot('splash_potion', R.pick(['healing', 'strong_healing']))} 1`] },
  { w: 2, v: 3, t: 1, g: (R) => [`${pot('potion', R.pick(['strength', 'swiftness', 'regeneration']))} 1`] },
  { w: 2, v: 3, t: 1, g: (R) => [`${pot('splash_potion', R.pick(['harming', 'poison', 'weakness', 'slowness']))} 1`] },
  { w: 3, v: 3, t: 1, g: (R) => [`ender_pearl ${R.i(1, 3)}`] },
  { w: 3, v: 2, t: 0, g: (R) => [`cobweb ${R.i(2, 6)}`] },
  { w: 2, v: 3, t: 1, g: () => ['lava_bucket'] },
  { w: 3, v: 2, t: 0, g: () => ['water_bucket'] },
  { w: 2, v: 1, t: 0, g: () => ['flint_and_steel'] },
  { w: 2, v: 2, t: 1, g: () => ['fishing_rod'] },
  // Материал для улучшения: лаборатория (стол, наковальня, стойка) и верстак.
  { w: 5, v: 2, t: 0, g: (R) => [`lapis_lazuli ${R.i(6, 18)}`] },
  { w: 4, v: 3, t: 1, g: (R) => [`experience_bottle ${R.i(8, 24)}`] },
  { w: 4, v: 4, t: 1, g: (R) => [book(R)] },
  { w: 4, v: 2, t: 0, g: (R) => [`iron_ingot ${R.i(3, 8)}`] },
  { w: 2, v: 4, t: 1, g: (R) => [`diamond ${R.i(1, 3)}`] },
  { w: 3, v: 1, t: 0, g: (R) => [`stick ${R.i(2, 6)}`, `string ${R.i(1, 3)}`] },
  { w: 2, v: 1, t: 0, g: (R) => [`flint ${R.i(2, 5)}`, `feather ${R.i(2, 5)}`] },
  { w: 3, v: 2, t: 1, g: (R) => [`blaze_powder ${R.i(1, 3)}`, `nether_wart ${R.i(1, 3)}`, `glass_bottle ${R.i(2, 3)}`] },
  { w: 3, v: 1, t: 0, g: (R) => [`${R.pick(['glistering_melon_slice', 'sugar', 'spider_eye', 'fermented_spider_eye', 'ghast_tear', 'gunpowder'])} ${R.i(1, 3)}`] },
  // Редкое и сильное — комплектами.
  { w: 2, v: 10, t: 2, g: () => ['totem_of_undying'] },
  { w: 2, v: 7, t: 2, g: (R) => [gear(R.pick(['iron_spear', 'diamond_spear']), R, 0.4)] },
  { w: 1.5, v: 10, t: 2, g: (R) => [gear('mace', R, 0.3), `wind_charge ${R.i(4, 12)}`] },
  { w: 1.5, v: 9, t: 2, g: (R) => [gear('crossbow', R, 0.6), `${ROCKET3} ${R.i(4, 10)}`] },
  { w: 1, v: 9, t: 2, g: (R) => ['elytra', `firework_rocket ${R.i(8, 16)}`] },
  { w: 1, v: 10, t: 2, g: (R) => [`end_crystal ${R.i(3, 8)}`, `obsidian ${R.i(4, 10)}`] },
  { w: 1, v: 8, t: 2, g: (R) => [`respawn_anchor ${R.i(2, 4)}`, `glowstone ${R.i(4, 12)}`] },
  { w: 1, v: 6, t: 2, g: (R) => [gear('trident', R, 0.5)] },
  { w: 1, v: 10, t: 2, g: () => ['enchanted_golden_apple'] }
]
function valOf (s, kind) {
  const id = s.replace(/\[.*$/, '')
  const m = id.match(/^([a-z]+)_/)
  const e = /enchantments=/.test(s) ? 1.5 : 0
  if (kind === 'armor') { const a = ARM.find(x => x[0] === (m && m[1])); return (a ? a[1] : 1) + e }
  const t = MAT.find(x => x[0] === (m && m[1]))
  const base = t ? t[1] : 1
  return (kind === 'sword' ? base : kind === 'axe' ? base * 0.8 : base * 0.5) + e
}
// Содержимое сундука по ярусу: ценность — сумма.
function fillChest (R, tier) {
  const n = tier === 2 ? R.i(2, 3) : R.i(2, 4)
  const items = []
  let value = 0
  for (let k = 0; k < n; k++) {
    const opts = POOL.filter(p => p.t <= tier).map(p => ({ ...p, w: p.w * (p.t === tier && tier > 0 ? 2 : 1) }))
    const p = R.w(opts)
    const got = p.g(R)
    items.push(...got)
    value += p.val ? p.val(got[0]) : p.v
  }
  return { items, value: Math.round(value * 10) / 10 }
}

// ---------------------------------------------------------------- геометрия
const ROOMS_SIDE = [[-16, -7], [-5, 5], [7, 16]]
function roomsList () {
  const out = []
  const corner = (id, sx, sz) => out.push({ id, x0: sx < 0 ? -25 : 18, x1: sx < 0 ? -18 : 25, z0: sz < 0 ? -25 : 18, z1: sz < 0 ? -18 : 25, corner: true })
  corner('NW', -1, -1); corner('NE', 1, -1); corner('SW', -1, 1); corner('SE', 1, 1)
  ROOMS_SIDE.forEach(([a, b], k) => {
    out.push({ id: `W${k + 1}`, x0: -25, x1: -18, z0: a, z1: b, side: 'W' })
    out.push({ id: `E${k + 1}`, x0: 18, x1: 25, z0: a, z1: b, side: 'E' })
    out.push({ id: `N${k + 1}`, x0: a, x1: b, z0: -25, z1: -18, side: 'N' })
    out.push({ id: `S${k + 1}`, x0: a, x1: b, z0: 18, z1: 25, side: 'S' })
  })
  return out
}
const mirrorId = (id) => id.replace(/W/g, '#').replace(/E/g, 'W').replace(/#/g, 'E').replace(/^N([13])$/, (m, k) => `N${k === '1' ? 3 : 1}`).replace(/^S([13])$/, (m, k) => `S${k === '1' ? 3 : 1}`)

function generate (seed, opts: any = {}) {
  const R = mk(rng(seed))
  const g = new Grid(-HALF, HALF, Y0, Y1, -HALF, HALF)
  const set = (x, y, z, s) => g.set(x, y, z, s)
  const both = (x, y, z, s) => { set(x, y, z, s); set(-x, y, z, s) }
  const box = (x0, y0, z0, x1, y1, z1, s, mirror = false) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) (mirror ? both : set)(x, y, z, s)
  }
  const cheb = (x, z) => Math.max(Math.abs(x), Math.abs(z))
  // Основание, полы.
  box(-HALF, Y0, -HALF, HALF, -3, HALF, 'stone')
  box(-25, -2, -25, 25, -2, 25, 'stone')
  box(-25, -1, -25, 25, -1, 25, WALL)
  box(-12, -2, -12, 12, -2, 12, 'dirt')
  box(-12, -1, -12, 12, -1, 12, 'grass_block')
  // Внешняя стена 3 толщиной, барьер над ней и потолок.
  for (let x = -HALF; x <= HALF; x++) for (let z = -HALF; z <= HALF; z++) {
    if (cheb(x, z) < 26) continue
    box(x, -1, z, x, 8, z, WALL)
    box(x, 9, z, x, Y1, z, 'barrier')
  }
  box(-HALF, Y1, -HALF, HALF, Y1, HALF, 'barrier')
  // Внутренняя (13) и средняя (17) стены, перекрытие коридора и комнат (y=4).
  for (let x = -25; x <= 25; x++) for (let z = -25; z <= 25; z++) {
    const c = cheb(x, z)
    if (c === 13 || c === 17) box(x, 0, z, x, 3, z, WALL)
    if (c >= 13 && c <= 25) set(x, 4, z, WALL)
  }
  // Перегородки комнат (x/z = ±17 — углы, ±6 — средние).
  for (const k of [-17, -6, 6, 17]) {
    box(k, 0, -25, k, 3, -18, WALL); box(k, 0, 18, k, 3, 25, WALL)
    box(-25, 0, k, -18, 3, k, WALL); box(18, 0, k, 25, 3, k, WALL)
  }
  // Двери в поле: середины сторон (ширина 3) и ±8 на западе/востоке.
  const doorX = (x, z0, z1) => box(x, 0, z0, x, 1, z1, 'air')
  const doorZ = (z, x0, x1) => box(x0, 0, z, x1, 1, z, 'air')
  doorX(-13, -1, 1); doorX(13, -1, 1); doorZ(-13, -1, 1); doorZ(13, -1, 1)
  for (const z of [-8, 8]) { doorX(-13, z - 1, z); doorX(13, z - 1, z) }
  const rooms = roomsList()
  // Тайная угловая комната: пара NW/NE или SW/SE.
  const secret = R.f() < 0.5 ? ['NW', 'NE'] : ['SW', 'SE']
  const lab = rooms.find(r => r.id === 'N2')
  lab.lab = true
  // Двери комнат в коридор (средняя стена 17): по комнате запада, зеркально на восток;
  // N/S — для x ≤ 0 и зеркально; середины N2/S2 — по оси.
  const doors = []
  const roomDoor = (r, facade = false) => {
    const s = facade ? FACADE : 'air'
    // Дверь на стене к коридору: для W/E-комнат — x = ∓17, для N/S — z = ∓17, для углов — одна из двух.
    let d
    if (r.side === 'W' || r.side === 'E') { const z = Math.round((r.z0 + r.z1) / 2); d = { x: r.side === 'W' ? -17 : 17, z0: z - 1, z1: z, axis: 'x' } }
    else if (r.side === 'N' || r.side === 'S') { const x = r.id.endsWith('2') ? 0 : Math.round((r.x0 + r.x1) / 2); d = { z: r.side === 'N' ? -17 : 17, x0: r.id.endsWith('2') ? -1 : x - 1, x1: r.id.endsWith('2') ? 1 : x, axis: 'z' } }
    else { const sx = r.x0 < 0 ? -1 : 1; const sz = r.z0 < 0 ? -1 : 1; d = { x: 17 * sx, z0: 21 * sz - 1, z1: 21 * sz, axis: 'x' } }
    if (d.axis === 'x') box(d.x, 0, d.z0, d.x, 1, d.z1, s); else box(d.x0, 0, d.z, d.x1, 1, d.z, s)
    doors.push({ room: r.id, ...d, facade })
  }
  for (const r of rooms) {
    if (r.x0 > 0 || (r.side === 'N' || r.side === 'S') && r.x0 > 0) continue
    const isSecret = secret.includes(r.id)
    if (r.id === 'N2' || r.id === 'S2') { roomDoor(r); continue }
    if (isSecret) { roomDoor(r, true); roomDoor(rooms.find(q => q.id === mirrorId(r.id)), true); continue }
    if (R.f() < 0.9) { roomDoor(r); roomDoor(rooms.find(q => q.id === mirrorId(r.id))) }
  }
  // Каждая несекретная комната без двери — дверь всё равно (иначе недостижима).
  for (const r of rooms) if (!doors.some(d => d.room === r.id)) { roomDoor(r); }
  // Лестницы на второй уровень: в западном/восточном коридоре и северном/южном (зеркально).
  const stairs = []
  const stairRun = (cells, open) => { cells.forEach(([x, z], k) => { box(x, 0, z, x, k, z, WALL); stairs.push({ x, y: k + 1, z }) }); for (const [x, z] of open) set(x, 4, z, 'air') }
  for (const sz of [-1, 1]) {
    // Запад: x = -15, ступени по z от ±3 к ±7, проём в перекрытии над верхними.
    const cells = [0, 1, 2, 3, 4].map(k => [-15, sz * (3 + k)])
    stairRun(cells, cells.slice(1).map(([x, z]) => [x, z]))
    stairRun(cells.map(([x, z]) => [-x, z]), cells.slice(1).map(([x, z]) => [-x, z]))
  }
  // Парапет у края крыши над полем: нет — край открыт (уровни и обрыв 5 бл.).
  // Поле: холмы (зеркально), деревья, руда, пруд на оси, старты.
  const spawns = [{ x: -10, y: 0, z: 0, yaw: -90 }, { x: 10, y: 0, z: 0, yaw: 90 }]
  const freeField = (x, z, pad = 0) => Math.abs(x) <= 12 - pad && Math.abs(z) <= 12 - pad && !(Math.abs(z) <= 2 + pad && Math.abs(x) >= 7 - pad) && !(Math.abs(x) <= 2 + pad && Math.abs(z) <= 2 + pad)
  const used = []
  const far = (x, z, r) => used.every(u => Math.hypot(u.x - x, u.z - z) >= r + u.r + 1)
  const hills = []
  for (let k = 0, tries = 0; k < 2 && tries < 60; tries++) {
    const x = -R.i(4, 10); const z = R.i(-10, 10); const r = R.i(2, 3); const h = R.i(1, 3)
    if (!freeField(x, z, r) || !far(x, z, r)) continue
    used.push({ x, z, r }); k++
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const hh = Math.round(h * (1 - Math.max(Math.abs(dx), Math.abs(dz)) / (r + 1))) || 0
      if (hh <= 0) continue
      box(x + dx, 0, z + dz, x + dx, hh - 2, z + dz, 'stone', true)
      both(x + dx, hh - 1, z + dz, 'grass_block')
    }
    hills.push({ x, z, r, h })
  }
  const ores = []
  const oreAt = (x, z, kind) => {
    // Открытая руда — в полу поля или в склоне холма (верхний блок колонки).
    let y = -1
    while (g.get(x, y + 1, z) && g.get(x, y + 1, z) !== 'air') y++
    both(x, y, z, kind); ores.push({ x, y, z, kind }, { x: -x, y, z, kind })
  }
  for (const [kind, n] of [['coal_ore', 3], ['iron_ore', 3], ['diamond_ore', 1]] as [string, number][]) {
    for (let k = 0, tries = 0; k < n && tries < 80; tries++) {
      const x = -R.i(3, 11); const z = R.i(-11, 11)
      if (!freeField(x, z) || ores.some(o => o.x === x && o.z === z)) continue
      oreAt(x, z, kind); k++
    }
  }
  const trees = []
  for (let k = 0, tries = 0; k < 2 && tries < 80; tries++) {
    const x = -R.i(4, 11); const z = R.i(-11, 11)
    if (!freeField(x, z, 2) || !far(x, z, 2)) continue
    used.push({ x, z, r: 2 }); k++
    const h = R.i(4, 5); const log = R.f() < 0.5 ? 'oak' : 'birch'
    for (let y = 0; y < h; y++) both(x, y, z, `${log}_log`)
    for (let y = h - 2; y <= h + 1; y++) {
      const r = y >= h ? 1 : 2
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if ((dx || dz) || y >= h) if (!g.get(x + dx, y, z + dz) || g.get(x + dx, y, z + dz) === 'air') both(x + dx, y, z + dz, `${log}_leaves[persistent=true]`)
      }
    }
    trees.push({ x, z, h, log })
  }
  // Лестницы с поля на крышу вдоль северного и южного края (x −7…−11, высота 1…5, зеркально): с крыши иначе
  // только обрыв в 5 бл. — pathfinder его не берёт, и тела застревали наверху (s7-arms14: западный по 60 с на разведку).
  for (const z of [-12, 12]) for (let k = 0; k < 5; k++) box(-7 - k, 0, z, -7 - k, k, z, WALL, true)
  // Пруд на оси (вода — источник для бутылок и спасение от огня).
  const pz = R.pick([-9, 9])
  box(-1, -2, pz - 1, 1, -1, pz + 1, 'water')
  // ---------------------------------------------------------------- сундуки
  const chests = []
  const chestAt = (c) => { chests.push(c) }
  const wallSpot = (r) => {
    // Клетка у стены комнаты (не у двери), сундук «лицом» в комнату.
    const opts = []
    for (let x = r.x0; x <= r.x1; x++) for (let z = r.z0; z <= r.z1; z++) {
      const edge = x === r.x0 || x === r.x1 || z === r.z0 || z === r.z1
      if (!edge) continue
      if (doors.some(d => d.room === r.id && (d.axis === 'x' ? Math.abs(x - d.x) <= 1 && z >= d.z0 - 1 && z <= d.z1 + 1 : Math.abs(z - d.z) <= 1 && x >= d.x0 - 1 && x <= d.x1 + 1))) continue
      if (g.get(x, 0, z) && g.get(x, 0, z) !== 'air') continue
      // Соседние сундуки слились бы в двойной — не вплотную.
      if (chests.some(c => c.y === 0 && Math.abs(c.x - x) <= 1 && Math.abs(c.z - z) <= 1)) continue
      opts.push({ x, z })
    }
    return opts.length ? R.pick(opts) : null
  }
  const facing = (r, x, z) => x === r.x0 ? 'east' : x === r.x1 ? 'west' : z === r.z0 ? 'south' : 'north'
  const westRooms = rooms.filter(r => !r.lab && (r.x1 < 0 || ((r.side === 'N' || r.side === 'S') && r.x1 <= 0) || r.id === 'S2'))
  let nid = 0
  for (const r of westRooms) {
    const secretRoom = secret.includes(r.id)
    const n = secretRoom ? 2 : r.id === 'S2' ? 1 : (R.f() < 0.15 ? 0 : R.f() < 0.2 ? 2 : 1)
    for (let k = 0; k < n; k++) {
      const s = wallSpot(r)
      if (!s) continue
      const f = facing(r, s.x, s.z)
      const c: any = { id: `c${++nid}`, x: s.x, y: 0, z: s.z, facing: f, room: r.id, kind: secretRoom ? 'secret_room' : 'room', tier: secretRoom ? 2 : 1 }
      // Тайная комната: «облицовка» — заложенная дверь (её клетки).
      const coverOf = (id) => doors.filter(d => d.room === id && d.facade).flatMap(d => d.axis === 'x' ? [d.z0, d.z1].flatMap(z => [0, 1].map(y => ({ x: d.x, y, z, block: FACADE }))) : [d.x0, d.x1].flatMap(x => [0, 1].map(y => ({ x, y, z: d.z, block: FACADE }))))
      if (secretRoom) c.cover = coverOf(r.id)
      set(c.x, 0, c.z, `chest[facing=${f}]`)
      chestAt(c)
      if (r.id !== 'S2' || c.x !== 0) { // ось S2 — пара x↔−x в той же комнате
        const m = { ...c, id: `c${++nid}`, x: -c.x, room: mirrorId(r.id), facing: f === 'east' ? 'west' : f === 'west' ? 'east' : f }
        if (secretRoom) m.cover = coverOf(mirrorId(r.id))
        set(m.x, 0, m.z, `chest[facing=${m.facing}]`)
        chestAt(m)
      }
    }
  }
  // Второй уровень: открытые сундуки на крыше (зеркально).
  for (let k = 0, tries = 0; k < 2 && tries < 40; tries++) {
    const x = -R.i(15, 24); const z = R.i(-24, 24)
    if (stairs.some(s => Math.abs(s.x - x) <= 1 && Math.abs(s.z - z) <= 1) || g.get(x, 5, z) || chests.some(c => c.x === x && c.z === z)) continue
    if (g.get(x, 4, z) !== WALL) continue
    k++
    for (const sx of [1, -1]) { const c = { id: `c${++nid}`, x: sx * x, y: 5, z, facing: sx < 0 ? 'east' : 'west', room: 'roof', kind: 'roof', tier: 1 }; set(c.x, 5, c.z, `chest[facing=${c.facing}]`); chestAt(c) }
  }
  // Поле: открытый сундук у дерева (зеркально).
  if (trees[0]) {
    const t = trees[0]; const x = t.x + (t.x > -10 ? -1 : 1) * 2; const z = t.z
    if (!g.get(x, 0, z) || g.get(x, 0, z) === 'air') for (const sx of [1, -1]) { const c = { id: `c${++nid}`, x: sx * x, y: 0, z, facing: 'south', room: 'field', kind: 'field', tier: 0 }; set(c.x, 0, c.z, `chest[facing=south]`); chestAt(c) }
  }
  // Тайники: под полом поля (coarse_dirt над сундуком) и в нише внешней стены.
  for (let k = 0, tries = 0; k < 1 && tries < 60; tries++) {
    const x = -R.i(3, 11); const z = R.i(-11, 11)
    if (!freeField(x, z, 1) || g.get(x, 0, z) || ores.some(o => o.x === x && o.z === z) || !far(x, z, 0)) continue
    k++
    for (const sx of [1, -1]) {
      const c = { id: `c${++nid}`, x: sx * x, y: -2, z, facing: 'north', room: 'field', kind: 'under', tier: 2, cover: [{ x: sx * x, y: -1, z, block: UNDER }] }
      set(c.x, -2, c.z, 'chest[facing=north]'); set(c.x, -1, c.z, UNDER); chestAt(c)
    }
  }
  for (let k = 0, tries = 0; k < 1 && tries < 60; tries++) {
    const z = R.pick([-22, -20, 20, 22, -10, 10, -2, 2]); const x = -26
    const room = rooms.find(r => r.x0 === -25 && z >= r.z0 && z <= r.z1)
    if (!room || secret.includes(room.id) || chests.some(c => c.z === z && Math.abs(c.x) >= 24)) continue
    k++
    for (const sx of [1, -1]) {
      const cx = sx * -27
      const c = { id: `c${++nid}`, x: cx, y: 0, z, facing: cx < 0 ? 'east' : 'west', room: cx < 0 ? room.id : mirrorId(room.id), kind: 'niche', tier: 2, cover: [{ x: sx * x, y: 0, z, block: FACADE }, { x: sx * x, y: 1, z, block: FACADE }] }
      set(c.x, 0, z, `chest[facing=${c.facing}]`); set(c.x, 1, z, 'air')
      for (const cv of c.cover) set(cv.x, cv.y, cv.z, cv.block)
      chestAt(c)
    }
  }
  // Лаборатория (N2, x −5..5, z −25..−18): стол с 15 полками, наковальня,
  // варочная стойка, вода, верстак, печь.
  const T = { x: 0, y: 0, z: -22 }
  set(T.x, 0, T.z, 'enchanting_table')
  const shelves = []
  for (let x = -2; x <= 2; x++) shelves.push([x, 0, -24])
  for (const x of [-2, 2]) for (const z of [-23, -22, -21]) shelves.push([x, 0, z])
  for (const x of [-2, -1, 1, 2]) shelves.push([x, 1, -24])
  for (const [x, y, z] of shelves) set(x, y, z, 'bookshelf')
  const labBlocks = { table: T, anvil: { x: -4, y: 0, z: -24 }, brewing: { x: 4, y: 0, z: -24 }, crafting: { x: -4, y: 0, z: -19 }, furnace: { x: 4, y: 0, z: -19 }, water: { x: -4, y: -1, z: -21 }, shelves: shelves.length }
  set(-4, 0, -24, 'anvil[facing=north]')
  set(4, 0, -24, 'brewing_stand')
  set(-4, 0, -19, 'crafting_table')
  set(4, 0, -19, 'furnace[facing=south]')
  set(-4, -1, -21, 'water')
  // Содержимое: запад и ось — розыгрыш, восток — зеркальная копия (равный старт: у сторон один и тот же
  // набор на одинаковом расстоянии; s7 06.10 — раньше два розыгрыша уравнивались по грубой цене до 12 %).
  const twin = new Map(chests.map(c => [`${c.x},${c.y},${c.z}`, c]))
  for (const c of chests) if (c.x <= 0) Object.assign(c, fillChest(R, c.tier))
  for (const c of chests) if (c.x > 0) { const m = twin.get(`${-c.x},${c.y},${c.z}`); c.items = [...m.items]; c.value = m.value }
  const half = (s) => Math.round(chests.reduce((n, c) => n + ((s < 0 ? c.x < 0 : c.x > 0) ? c.value : 0), 0) * 10) / 10
  const best = { w: half(-1), e: half(1), diff: 0 }
  const layout = {
    seed: String(seed), version: 1, half: HALF, y0: Y0, y1: Y1, g, rooms, doors, secret, stairs, hills, trees, ores, chests, spawns,
    lab: { room: 'N2', ...labBlocks }, budget: { west: Math.round(best.w * 10) / 10, east: Math.round(best.e * 10) / 10, diff: Math.round(best.diff * 1000) / 1000 },
    facade: FACADE, under: UNDER
  }
  return layout
}

// ---------------------------------------------------------------- проверки
const PASS = /^(|air|water|short_grass|torch)$/
const solidAt = (g, x, y, z) => { const s = g.get(x, y, z); return !!s && !PASS.test(s.replace(/\[.*$/, '')) }
const standable = (g, x, y, z) => solidAt(g, x, y - 1, z) && !solidAt(g, x, y, z) && !solidAt(g, x, y + 1, z) && !/barrier/.test(g.get(x, y - 1, z))
// Достижимые клетки от старта: шаг на соседнюю клетку того же уровня, вверх на
// 1 (прыжок, голова свободна) или вниз до 4 (maxDropDown pathfinder; обрыв крыши 5 — не путь, s7).
function reach (g, start, removed = new Set()) {
  const get0 = g.get.bind(g)
  const view = { get: (x, y, z) => removed.has(`${x},${y},${z}`) ? 'air' : get0(x, y, z) }
  const sol = (x, y, z) => solidAt(view, x, y, z)
  const st = (x, y, z) => sol(x, y - 1, z) && !sol(x, y, z) && !sol(x, y + 1, z) && !/barrier/.test(view.get(x, y - 1, z))
  const seen = new Set()
  const q = [[start.x, start.y, start.z]]
  seen.add(`${start.x},${start.y},${start.z}`)
  while (q.length) {
    const [x, y, z] = q.pop()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const nz = z + dz
      let ny = null
      if (!sol(x, y + 2, z) && st(nx, y + 1, nz)) ny = y + 1
      else if (st(nx, y, nz)) ny = y
      else if (!sol(nx, y, nz) && !sol(nx, y + 1, nz)) { for (let d = 1; d <= 4; d++) { if (st(nx, y - d, nz)) { ny = y - d; break } if (sol(nx, y - d, nz)) break } }
      if (ny === null || !g.in(nx, ny, nz)) continue
      const k = `${nx},${ny},${nz}`
      if (seen.has(k)) continue
      seen.add(k)
      q.push([nx, ny, nz])
    }
  }
  return seen
}
const nearChest = (cells, c) => {
  for (const k of cells) {
    const [x, y, z] = k.split(',').map(Number)
    if (Math.abs(x - c.x) <= 2 && Math.abs(z - c.z) <= 2 && y >= c.y - 1 && y <= c.y + 2 && Math.hypot(x - c.x, y + 1.62 - c.y - 0.5, z - c.z) <= 4.4) return true
  }
  return false
}
function validate (L) {
  const errs = []
  const g = L.g
  const cells = L.spawns.map(s => reach(g, s))
  if (!cells[0].has(`${L.spawns[1].x},0,${L.spawns[1].z}`)) errs.push('старты не связаны')
  for (const c of L.chests) {
    if (solidAt(g, c.x, c.y + 1, c.z) && !(c.cover || []).some(v => v.x === c.x && v.y === c.y + 1 && v.z === c.z)) errs.push(`${c.id}: над сундуком блок — не открыть`)
    if (c.cover) {
      // Тайник: облицовка рядом с достижимым местом, после её снятия сундук досягаем.
      const removed = new Set(c.cover.map(v => `${v.x},${v.y},${v.z}`))
      const okCover = c.cover.some(v => nearChest(cells[0], { x: v.x, y: v.y, z: v.z }))
      const after = reach(g, L.spawns[0], removed)
      if (!okCover) errs.push(`${c.id}: облицовка тайника недосягаема`)
      if (!nearChest(after, c)) errs.push(`${c.id}: тайник после вскрытия недосягаем`)
    } else if (!nearChest(cells[0], c) || !nearChest(cells[1], c)) errs.push(`${c.id} (${c.room}): сундук недосягаем`)
    for (const it of c.items || []) errs.push(...checkItem(it))
  }
  for (const k of ['table', 'anvil', 'brewing', 'crafting', 'furnace']) if (!nearChest(cells[0], L.lab[k])) errs.push(`лаборатория: ${k} недосягаем`)
  // Полки: 15, между столом и полкой воздух (EnchantingTableBlock.BOOKSHELF_OFFSETS, transmitter).
  let shelves = 0
  const T = L.lab.table
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 0; dy <= 1; dy++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue
    if (g.get(T.x + dx, T.y + dy, T.z + dz) !== 'bookshelf') continue
    if (g.get(T.x + Math.trunc(dx / 2), T.y + dy, T.z + Math.trunc(dz / 2))) continue
    shelves++
  }
  if (shelves < 15) errs.push(`лаборатория: рабочих полок ${shelves} < 15`)
  return { ok: !errs.length, errs, shelves, reach: cells.map(c => c.size) }
}

// ---------------------------------------------------------------- команды
// Сброс раунда = полная перестройка по описи (модель g): объём — воздух, затем
// массы материалов (greedy-параллелепипеды), навесное и сундуки последними,
// содержимое — /item replace block по слотам. X, Y, Z — центр, Y — уровень ног.
const LATE = /chest|anvil|brewing_stand|enchanting_table|crafting_table|furnace|water|leaves|bookshelf/
function commands (L, { X, Y, Z }, opts: any = {}) {
  const C = require('./colosseum')
  const g = L.g
  const out = []
  for (let y = g.y0; y <= g.y1; y++) out.push(`fill ${X + g.x0} ${Y + y} ${Z + g.z0} ${X + g.x1} ${Y + y} ${Z + g.z1} minecraft:air`)
  // Столб над комплексом — до верха мира (S6b 06.10: кусок рельефа над западной половиной давал небо на 1 темнее,
  // goto «поверху» штрафовал запад — перекос сторон). По 9 слоёв: fill ≤ 32768 блоков.
  const top = Number(opts.worldTop ?? 319)
  for (let y = Y + g.y1 + 1; y <= top; y += 9) out.push(`fill ${X + g.x0} ${y} ${Z + g.z0} ${X + g.x1} ${Math.min(top, y + 8)} ${Z + g.z1} minecraft:air`)
  const early = C.greedy(g, (v) => !LATE.test(g.pal[v]))
  const late = C.greedy(g, (v) => LATE.test(g.pal[v]))
  for (const b of [...early, ...late]) out.push(C.toCmd(b, g.pal[b.v], X, Y, Z).replace(/^\//, ''))
  for (const c of L.chests) {
    let slot = 0
    for (const it of c.items) {
      const [name, n] = splitCount(it)
      out.push(`item replace block ${X + c.x} ${Y + c.y} ${Z + c.z} container.${slot++} with minecraft:${name} ${n}`)
    }
  }
  return out
}
function splitCount (it) {
  const m = it.match(/^(.*?)(?: (\d+))?$/)
  return [m[1], m[2] ? Number(m[2]) : 1]
}

// Сводка для журнала и бота-наблюдателя (без содержимого сундуков).
function summary (L) {
  const kinds = {}
  for (const c of L.chests) kinds[c.kind] = (kinds[c.kind] || 0) + 1
  return { seed: L.seed, chests: L.chests.length, kinds, budget: L.budget, secret: L.secret, trees: L.trees.length * 2, ores: L.ores.length, hills: L.hills.length * 2, stairs: L.stairs.length / 5 }
}

let publicSamples: string[][] | null = null
// Публичное распределение специального режима arms v1. Ни текущего seed, ни координат наружу.
function publicLootSamples(): string[][] {
  if (!publicSamples) publicSamples = Array.from({ length: 16 }, (_, n) =>
    generate(`public-arms-prior:v1:${n}`).chests.map(c => [...c.items])).flat()
  return publicSamples.map(items => [...items])
}
module.exports = { generate, validate, commands, summary, checkItem, reach, standable, solidAt, rng, POOL, ROCKET3, FACADE, UNDER, HALF, publicLootSamples }

if (require.main === module) {
  const seed = process.argv[2] || 'demo'
  const L = generate(seed)
  const v = validate(L)
  console.log(JSON.stringify({ ...summary(L), valid: v }, null, 1))
  if (process.argv.includes('--json')) for (const c of L.chests) console.log(c.id, c.kind, c.room, `${c.x},${c.y},${c.z}`, c.value, c.items.join(' | '))
}

// Офлайн-рендер раскладки в PNG (voxel-render): общий вид и разрез по y ≤ 3
// (комнаты, сундуки, тайники). Барьер не рисуется.
//   node arms-layout.js <seed> --png <файл без .png>
async function renderPng (L, base) {
  const fs = require('fs')
  const { render } = require('./voxel-render')
  const g0 = L.g
  const g = new Grid(g0.x0, g0.x1, g0.y0, g0.y1, g0.z0, g0.z1)
  for (let y = g0.y0; y <= g0.y1; y++) for (let z = g0.z0; z <= g0.z1; z++) for (let x = g0.x0; x <= g0.x1; x++) {
    const s = g0.get(x, y, z)
    if (s && s !== 'barrier' && s !== 'air') g.set(x, y, z, s)
  }
  const out = []
  for (const [tag, o] of [['view', { az: 35, el: 32, scale: 7, ss: 2, ymin: -1 }], ['cut', { az: 20, el: 58, scale: 7, ss: 2, ylim: 3, ymin: -2 }]] as [string, any][]) {
    const r = await render(g, o)
    const f = `${base}-${tag}.png`
    fs.writeFileSync(f, r.png)
    out.push({ f, W: r.W, H: r.H })
  }
  return out
}
module.exports.renderPng = renderPng
if (require.main === module && process.argv.includes('--png')) {
  const base = process.argv[process.argv.indexOf('--png') + 1]
  renderPng(generate(process.argv[2] || 'demo'), base).then(r => console.log(JSON.stringify(r)))
}
