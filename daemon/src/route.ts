'use strict'
// Маршрут спидраннера по знанию карты (поток route, 03.10.2026; журнал research/dev-E-overworld.md).
//
// Знание карты — из копии этого же мира (AGENTS.md: разрешено): постройки — seedtool (cubiomes, 1.21.11: деревня,
// руина портала, корабль, клад), лава — скан копии (farm/seeds/good-v2.json: sky — видимая сверху, lavaAt/lavaClass/
// lavaDepth — ближняя годная любого класса), руда на виду — скан копии (farm/route-scan/<сид>.json, если есть).
// Модуль ничего не двигает: по сиду и рюкзаку строит план шагов с бюджетом времени на шаг, кампания (campaign.js,
// ND_ROUTE=1) идёт по нему, пишет время шага и перепланирует при провале (шаг — в avoid).
//
// Числа — из jar 1.21.11 (loot_table) и замеров фермы:
//   сундук руин — 4–8 заходов по весу 398: огниво 40 + заряд 40 → огонь хотя бы раз ≈ 0.73; обсидиан 40 (1–2) ≈ 0.9 шт;
//     самородки 40 (9–18) — слиток хотя бы раз ≈ 0.47;
//   голем — железо 3–5 (всегда); деревня — ещё сундуки кузнецов (оружейник: железо 10/107, обсидиан 3–7 5/107),
//     сено (9 пшеницы = 3 хлеба), кровати;
//   сундук сокровищ корабля — 3–6 заходов, железо 90/150 по 1–5 (≈ 8 слитков, если сундук есть в этом обломке ≈ 0.6);
//   клад — 5–8 заходов, железо 20/35 по 1–4 (≈ 9), жареная рыба 2–8;
//   литьё у видимой лавы (portal_natural run с подсказкой) — медиана 161 с от подсказки до горящей рамы (07 §8.1).
// Ходьба по рельефу — ~2.5 м/с (portal_natural «к подсказке»: 245 м за ~100 с).

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const SEEDTOOL = path.join(ROOT, 'tools', 'seedtool', 'seedtool.exe')
const POOL = path.join(ROOT, 'farm', 'seeds', 'good-v2.json')
const CACHE = path.join(ROOT, 'farm', 'seeds', 'route-info.json')
const ORES = path.join(ROOT, 'farm', 'route-scan')

const SPEED = 2.5 // м/с по рельефу
// Общий бюджет поиска ресурсов в постройках, включая переходы. Это политика
// маршрута, не коэффициент механики; ND_ROUTE_STRUCTURE_BUDGET=0 — прежний выбор.
function structureSearchLeft (seconds = 0) {
  return process.env.ND_ROUTE_STRUCTURE_BUDGET === '0' ? Infinity : Math.max(0, 180 - Math.max(0, Number(seconds) || 0))
}
// Ожидания по луту (см. шапку).
const LOOT = {
  ruin: { lighter: 0.73, obsidian: 0.9, iron: 0.47 },
  golem: { iron: 4, ironMin: 3 },
  ship: { iron: 5, ironMin: 0, food: 2 },
  treasure: { iron: 9, ironMin: 2, food: 3 }
}
// Работа на месте, с (без дороги).
const WORK = { wood: 90, stone: 90, ruin: 45, village: 80, golem: 60, ship: 150, treasure: 120, ore: 40, smelt: 15, water: 40, food: 60, castSky: 90, castCave: 200, enter: 30 }

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const asXZ = p => (Array.isArray(p) ? { x: p[0], z: p[1] } : p)

// ------------------------------------------------------------------ данные по сиду

let poolCache = null
function poolRow (seed) {
  if (!poolCache) { try { poolCache = JSON.parse(fs.readFileSync(POOL, 'utf8')).seeds || [] } catch { poolCache = [] } }
  return poolCache.find(x => String(x.seed) === String(seed)) || null
}
let infoCache = null
function readCache () {
  if (infoCache) return infoCache
  try { infoCache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) } catch { infoCache = {} }
  return infoCache
}
// seedtool info <сид> — постройки от спавна (одна строка JSON). Кэш — farm/seeds/route-info.json.
function seedInfo (seed, { run = true }: any = {}) {
  const c = readCache()
  if (!/^-?\d+$/.test(String(seed))) return null
  if (c[String(seed)]) return c[String(seed)]
  if (!run || !fs.existsSync(SEEDTOOL)) return null
  try {
    const out = require('child_process').execFileSync(SEEDTOOL, ['info', String(seed)], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    const j = JSON.parse(out.trim().split('\n')[0])
    c[String(seed)] = j
    try { fs.writeFileSync(CACHE, JSON.stringify(c)) } catch {}
    return j
  } catch { return null }
}
// Руда на виду из скана копии мира (если сканирован): [{x,y,z,n,open}] — n руды в жиле, open — сколько у воздуха.
function oresOf (seed) {
  try { const j = JSON.parse(fs.readFileSync(path.join(ORES, `${seed}.json`), 'utf8')); return { v: j.v || 1, spawn: j.spawn, half: j.half, iron: j.iron || [], water: j.water || [], gravel: j.gravel || [], coal: j.coal || [], trees: j.trees || [], wood: j.wood || [], lava: j.lava || [], chests: j.chests || [], structures: j.structures || [], golems: j.golems || [], animals: j.animals || [], beds: j.beds || [], ironBuried: j.ironBuried || [], gravelBuried: j.gravelBuried || [] } } catch { return null }
}

// Всё, что известно о мире по сиду: { seed, spawn, biome, rp, village, ship, treasure, lava, sky, ores }.
function routeInfo (seed, { ores = true }: any = {}) {
  if (seed === undefined || seed === null || seed === '') return null
  const s = seedInfo(seed)
  const p = poolRow(seed)
  if (!s && !p) return null
  const st = k => (s && s[k] && Number.isFinite(s[k].x)) ? { x: s[k].x, z: s[k].z, d: s[k].d } : null
  const spawn = s && Array.isArray(s.spawn) ? { x: s.spawn[0], z: s.spawn[1] } : (p && Array.isArray(p.spawn) ? { x: p.spawn[0], z: p.spawn[1] } : { x: 0, z: 0 })
  const sky = p && p.sky && Array.isArray(p.sky.at) ? { x: p.sky.at[0], y: p.sky.at[1], z: p.sky.at[2], cls: p.sky.cls, src: p.sky.src, d: p.sky.d } : null
  const lava = p && Array.isArray(p.lavaAt) ? { x: p.lavaAt[0], y: p.lavaAt[1], z: p.lavaAt[2], cls: p.lavaClass, depth: p.lavaDepth, src: p.lavaSrc, d: p.lava } : null
  const sc = ores ? oresOf(seed) : null
  // Аванпосты разбойников: точка seedtool и коробки из скана копии (где встал). Пиллагеры появляются в коробке
  // постоянно и стреляют с 15+ бл. (rtV-A слот 10: аванпост в 50 м от спавна — смерть на 1-й мин за брёвнами).
  const outposts = []
  if (s && s.outpost && Number.isFinite(s.outpost.x)) outposts.push({ x: s.outpost.x, z: s.outpost.z, r: 72, src: 'seedtool' })
  for (const t of ((sc && sc.structures) || [])) {
    if (!/outpost/.test(t.name) || !Array.isArray(t.bb)) continue
    const c = { x: Math.round((t.bb[0] + t.bb[3]) / 2), z: Math.round((t.bb[2] + t.bb[5]) / 2), r: 64 + Math.round(Math.max(t.bb[3] - t.bb[0], t.bb[5] - t.bb[2]) / 2), src: 'скан' }
    const same = outposts.findIndex(o => flat(o, c) <= 48)
    if (same >= 0) outposts[same] = c; else outposts.push(c)
  }
  return {
    seed: String(seed),
    spawn,
    biome: (s && s.biome) || (p && p.biome) || null,
    rp: st('rp'),
    village: st('village'),
    ship: st('shipwreck'),
    treasure: st('treasure'),
    rpLavaOk: !!(p && p.rpLavaOk),
    sky,
    lava,
    outposts,
    ores: sc
  }
}

// Аванпост рядом с точкой (r — радиус опасной зоны): { o, d } или null.
function outpostNear (info, at, pad = 0) {
  for (const o of ((info && info.outposts) || [])) { const d = flat(o, at); if (d <= o.r + pad) return { o, d } }
  return null
}
// Отрезок from → to задевает зону аванпоста — точка обхода сбоку (на r + 20 от центра), иначе null.
// Путевую точку pathfinder может срезать через опасную зону. Ограничиваем каждую клетку пути;
// старт внутри зоны допускает только движения наружу, без телепорта.
function outpostStepCost (info, from, next) {
  for (const o of ((info && info.outposts) || [])) {
    const r = o.r + 24; const now = flat(o, from); const after = flat(o, next)
    if (after <= r && (now > r || after + 0.01 < now)) return Infinity
  }
  return 0
}
function outpostWaypoint (info, from, to) {
  for (const o of ((info && info.outposts) || [])) {
    const vx = to.x - from.x; const vz = to.z - from.z
    const L2 = vx * vx + vz * vz
    if (L2 < 1) continue
    const t = Math.max(0, Math.min(1, ((o.x - from.x) * vx + (o.z - from.z) * vz) / L2))
    const px = from.x + vx * t; const pz = from.z + vz * t
    const d = Math.hypot(o.x - px, o.z - pz)
    if (d >= o.r || flat(o, to) <= o.r || flat(o, from) <= o.r * 0.6) continue
    // Сторона обхода — та, где ближайшая точка отрезка; на самой оси — слева.
    let nx = px - o.x; let nz = pz - o.z
    const n = Math.hypot(nx, nz)
    if (n < 1) { nx = -vz; nz = vx } else { nx /= n; nz /= n }
    const k = (o.r + 20) / Math.hypot(nx, nz)
    return { x: Math.round(o.x + nx * k), z: Math.round(o.z + nz * k), outpost: o }
  }
  return null
}

// Кровать к ночи (поток route, 03.10): rtV/R7 — 17 из 24 смертей ночью, кровать к 10-й мин была в 7 прогонах из 48.
// Ночь (сон с 12542 тиков) при старте с утра (1000) — на ~9.6-й мин. Источники по карте копии мира: стадо ≥ 3 овец
// одного цвета (скан v6: овцы при генерации, с 1.21.5 цвет от биома), кровать постройки (деревня, иглу; скан v6 beds).
// Цена — крюк + работа; дороже 240 с — не план, а попутно (кампания: овцы на виду, сторож ночи).
function sheepHerds (info) {
  const sh = ((info.ores && info.ores.animals) || []).filter(a => a.id === 'sheep' && !a.sh)
  const herds = []
  const used = new Set()
  for (const a of sh) {
    if (used.has(a)) continue
    const mates = sh.filter(b => !used.has(b) && b.c === a.c && Math.hypot(b.x - a.x, b.z - a.z) <= 16)
    if (mates.length < 3) continue
    for (const b of mates) used.add(b)
    const x = Math.round(mates.reduce((n, b) => n + b.x, 0) / mates.length)
    const z = Math.round(mates.reduce((n, b) => n + b.z, 0) / mates.length)
    herds.push({ x, z, y: Math.round(mates.reduce((n, b) => n + b.y, 0) / mates.length), c: a.c, n: mates.length })
  }
  return herds
}
// Группы съедобных зверей по скану копии (корова, свинья, овца, курица, кролик; ≥ 2 в 16 бл.).
function foodHerds (info) {
  const an = ((info.ores && info.ores.animals) || []).filter(a => /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(a.id))
  const out = []
  const used = new Set()
  for (const a of an) {
    if (used.has(a)) continue
    const mates = an.filter(b => !used.has(b) && Math.hypot(b.x - a.x, b.z - a.z) <= 16)
    if (mates.length < 2) continue
    for (const b of mates) used.add(b)
    out.push({ x: Math.round(mates.reduce((n, b) => n + b.x, 0) / mates.length), y: Math.round(mates.reduce((n, b) => n + b.y, 0) / mates.length), z: Math.round(mates.reduce((n, b) => n + b.z, 0) / mates.length), n: mates.length })
  }
  return out
}
function bedCands (info, from, end) {
  const out = []
  const detour = at => (flat(from, at) + flat(at, end) - flat(from, end)) / SPEED
  for (const h of sheepHerds(info)) {
    if (outpostNear(info, h, 16)) continue
    out.push({ id: 'bed', kind: 'bed', how: 'sheep', at: { x: h.x, y: h.y, z: h.z }, color: h.c, n: h.n, cost: Math.round(detour(h) + 20 + 3 * 12 - Math.min(h.n - 3, 4) * 3) })
  }
  for (const b of ((info.ores && info.ores.beds) || [])) {
    // Испытания, древний город, особняк — под землёй/с мобами; кровать в деревне и иглу — наверху.
    // Только деревня и верх иглу (кровать без постройки или глубже 40 — подвал иглу/испытания/город: rt3-A2 слот 11 —
    // «кровать по карте» на y −36, два захода по 100 с).
    if (!b.in || !/village|igloo/.test(b.in) || b.y < 40) continue
    if (outpostNear(info, b, 16)) continue
    out.push({ id: 'bed', kind: 'bed', how: 'block', at: { x: b.x, y: b.y, z: b.z }, in: b.in, cost: Math.round(detour(b) + 25) })
  }
  // Деревня вне квадрата скана (кроватей не видно в скане, но в деревне они есть): кровать — обходом домов (structure
  // explore beds) — rt3-A1 слот 15: деревня в 215 м выпала из плана после руин, кровати не стало.
  const sc = info.ores
  const inScan = at => sc && sc.spawn && Math.abs(at.x - sc.spawn.x) <= (sc.half || 0) - 8 && Math.abs(at.z - sc.spawn.z) <= (sc.half || 0) - 8
  if (info.village && !inScan(info.village) && !outpostNear(info, info.village)) out.push({ id: 'bed', kind: 'bed', how: 'village', at: { x: info.village.x, z: info.village.z }, cost: Math.round(detour(info.village) + 70) })
  return out.sort((a, b) => a.cost - b.cost)
}

// ------------------------------------------------------------------ план

// Сколько вёдер нужно: литьё одним ведром с берега (cast1.js, ND_ROUTE_ONE, по умолчанию вкл.) — 1, cast.js — 2.
const BUCKETS = () => (process.env.ND_ROUTE_ONE === '0' ? 2 : 1)
// Сколько железа нужно до портала: 3 на ведро, огниво — слиток, если огня нет.
function ironNeed (have: any = {}, { buckets: want = BUCKETS() }: any = {}) {
  const buckets = (have.bucket || 0) + (have.water_bucket || 0) + (have.lava_bucket || 0)
  const lighter = (have.flint_and_steel || 0) + (have.fire_charge || 0) > 0
  return Math.max(0, 3 * Math.max(0, want - buckets) + (lighter ? 0 : 1) - (have.iron_ingot || 0) - (have.raw_iron || 0) - Math.floor((have.iron_nugget || 0) / 9))
}

// Перебор порядка точек (их ≤ 5): кратчайший путь от from через все, последняя — last (если задана).
function orderPoints (from, pts, last = null) {
  const best = { len: Infinity, order: pts }
  const permute = (rest, cur, len, acc) => {
    if (len >= best.len) return
    if (!rest.length) {
      const total = len + (last ? flat(cur, last) : 0)
      if (total < best.len) { best.len = total; best.order = acc.slice() }
      return
    }
    for (let i = 0; i < rest.length; i++) {
      const p = rest[i]
      acc.push(p)
      permute(rest.slice(0, i).concat(rest.slice(i + 1)), p.at, len + flat(cur, p.at), acc)
      acc.pop()
    }
  }
  permute(pts, from, 0, [])
  return best
}

// Лава для портала. Кандидаты: видимая сверху из good-v2 (sky: озеро или руины) — литьё поверху portal_natural;
// тела лавы из скана копии (farm/route-scan: ≥ 10 источников с воздухом сверху) — глубина ≤ 3 тоже «поверху», глубже —
// колодцем вниз к ней и литьё с окнами; ближняя годная из good-v2 (lavaAt). Цена — дорога (2.5 м/с) + спуск
// (~2 с на уровень) + литьё (поверху ~170 с, в пещере ~230 с). Не вышло — id в avoid, следующий кандидат; никого —
// вниз вслепую (deep).
// Доля удачного литья по классу лавы — night05t+day05r (05.10, 20 TPS, код c1c3726; 304 прогона, шаги castSky/castCave):
// поверху ≥ 40 источников 85/204 ≈ 0.42, < 40 — 8/34 ≈ 0.24; пещера 7–12 под рельефом 18/40 ≈ 0.45, ≤ 6 — 5/15 ≈ 0.33,
// глубже 12 — 28/180 ≈ 0.16 (и 14 смертей); лава у руин (rp: берег — незерак и магма, «места на берегу нет») — 0/24.
function castOdds (kind, cls, depth, src) {
  if (cls === 'rp') return 0.03
  if (kind === 'sky') return (Number.isFinite(src) ? src : 40) >= 40 ? 0.42 : 0.24
  if (cls === 'open-cave') return 0.45
  return (depth || 0) <= 6 ? 0.33 : (depth || 0) <= 12 ? 0.45 : 0.16
}
// По умолчанию (ND_ROUTE_LAVAP=0 — прежняя цена по дороге): цена кандидата = (дорога + работа) / доля: ожидаемое время до горящей рамы с учётом повторов у
// следующей лавы, а не только дорога (рядом глубокая пещера 16 % проигрывала озеру поверху в 300 м с 42 %).
const LAVAP = () => process.env.ND_ROUTE_LAVAP !== '0'
function lavaCands (info, from) {
  const out = []
  const add = (kind, at, cls, depth, src, tag) => {
    if (process.env.ND_ROUTE_OUTPOSTPATH !== '0' && outpostNear(info, at, 24)) return
    const id = kind === 'sky' ? `lava:sky:${at.x},${at.z}` : `lava:cave:${at.x},${at.z}`
    if (out.some(c => c.id === id)) return
    // Пещера дороже: R3–R4 — литьё у пещерной лавы 0 из 6 (нет берега, закрытая полость), у лавы под небом — 3 из 4.
    // Лава в зоне аванпоста — +200 с (пиллагеры у литья; лучше другая, если есть).
    const base = flat(from, at) / SPEED + (kind === 'sky' ? WORK.castSky : WORK.castCave + 90 + (depth || 0) * 2)
    const odds = castOdds(kind, cls, depth, src)
    const cost = (LAVAP() ? base / odds : base) + (outpostNear(info, at) ? 200 : 0)
    out.push({ id, kind, at, cls, depth: depth || 0, src, cost, odds, tag })
  }
  if (info.sky) add('sky', { x: info.sky.x, y: info.sky.y, z: info.sky.z }, info.sky.cls, 0, info.sky.src, 'пул')
  for (const b of ((info.ores && info.ores.lava) || [])) {
    // Пещерная лава — только неглубокая (≤ 20 под рельефом): глубокое литьё в R1 — 0 из 4 (434–1290 с).
    if ((b.top || 0) < 12 || (b.depth || 0) > 20) continue
    add((b.depth || 0) <= 3 && b.openTop > 0 ? 'sky' : 'cave', { x: b.x, y: b.y, z: b.z }, (b.depth || 0) <= 3 ? 'surface' : (b.openTop > 0 ? 'open-cave' : 'closed-cave'), b.depth, b.top, 'скан')
  }
  if (info.lava && ((info.lava.depth || 0) <= 20 || info.lava.cls === 'surface' || info.lava.cls === 'rp')) add(info.lava.cls === 'surface' || info.lava.cls === 'rp' ? 'sky' : 'cave', { x: info.lava.x, y: info.lava.y, z: info.lava.z }, info.lava.cls, info.lava.depth, info.lava.src, 'пул')
  return out.sort((a, b) => a.cost - b.cost)
}
function pickLava (info, from, { skyMax = 520, caveMax = 420, avoid = new Set() }: any = {}) {
  const c = lavaCands(info, from).find(x => !avoid.has(x.id) && !avoid.has(`lava:${x.kind}`) && flat(from, x.at) <= (x.kind === 'sky' ? skyMax : caveMax))
  if (c) return c
  return { kind: 'deep', at: null, id: 'lava:deep' }
}

// План: шаги по порядку. opts.from — где тело (по умолчанию спавн), opts.have — рюкзак (имя → число),
// opts.avoid — шаги, которые уже не вышли (id), opts.done — сделанные (id). Шаг: { id, kind, at?, budget, why, gives? }.
// Скан v7 даёт видимую древесину построек и сухую клетку подхода; v6 — рощи.
function woodCandidates (info, from, fromY) {
  const sc = (info && info.ores) || {}
  const score = p => flat(from, p.stand || p) / SPEED + (Number.isFinite(fromY) && Number.isFinite(p.y) ? Math.abs(p.y - fromY) * 2 : 0)
  const safe = p => p.n >= 3 && flat(from, p.stand || p) <= 520 && !outpostNear(info, p, 24) && !/outpost/.test(p.in || '')
  const mapped = (sc.wood || []).filter(safe).sort((a, b) => score(a) - score(b))
  const buildings = mapped.filter(p => p.in)
  const natural = [...mapped.filter(p => !p.in), ...(sc.trees || []).filter(safe)].sort((a, b) => score(a) - score(b))
  return [...buildings, ...natural]
}

function plan (info, opts: any = {}) {
  const from = asXZ(opts.from || info.spawn)
  const have = opts.have || {}
  const avoid = opts.avoid instanceof Set ? opts.avoid : new Set(opts.avoid || [])
  const done = opts.done instanceof Set ? opts.done : new Set(opts.done || [])
  const ok = id => !avoid.has(id) && !done.has(id)
  const steps = []
  if (opts.portal) return { seed: info.seed, lava: { kind: 'lit' }, ironNeed: 0, ironExpect: 0, short: false, steps: [{ id: 'enter', kind: 'enter', budget: WORK.enter, why: 'портал горит — в Ад' }], budget: WORK.enter, route: 'портал горит → вход' }
  const logs = (Object.entries(have) as [string, any][]).filter(([k]) => /_(log|stem)$/.test(k)).reduce((n: any, [, v]) => n + v, 0)
  const pick = Object.keys(have).some(k => /_pickaxe$/.test(k))
  const stonePick = Object.keys(have).some(k => /^(stone|iron|diamond|netherite)_pickaxe$/.test(k))
  if (!pick && ok('wood')) {
    // Деревья по скану копии: ближняя роща (≥ 8 брёвен) — к ней, если рядом с телом деревьев нет (равнины: «не вижу
    // any_log в 48» и разведка на 2 мин — rt-S1 03.10, слот 29).
    const treesAll = (info.ores && Array.isArray(info.ores.trees) ? info.ores.trees : []).filter(t => !outpostNear(info, t, 8))
    let all = treesAll.filter(t => !Number.isFinite(opts.fromY) || Math.abs(t.y - (opts.fromY + 3)) <= 8)
    // Своей высоты деревьев нет в 160 м, а выше/ниже — есть (−4303…: равнина у спавна, все деревья на горе в 60–90 м, на 40–55
    // выше; без них — «дома деревни», которых не видно, и 4×120 с разведки вслепую, s8-f1-7/f2-7) — те, что есть.
    const anyY = process.env.ND_ROUTE_TREEANYY !== '0' && !all.some(t => flat(from, t) <= 160) && treesAll.some(t => flat(from, t) <= 160)
    if (anyY) all = treesAll.filter(t => flat(from, t) <= 160)
    const trees = all.filter(t => t.n >= 8).sort((a, b) => flat(from, a) - flat(from, b))
    // Аванпост рядом со спавном — роща подальше от него, даже если деревья тут есть (пиллагеры бьют с 15+ бл.).
    const nearAny = all.some(t => t.n >= 4 && flat(from, t) <= 40) && !outpostNear(info, from, 24)
    let grove = !nearAny && trees[0] && flat(from, trees[0]) <= 160 ? trees[0] : null
    // Только чужой высоты и мелкие (n 4–7) — ближняя по дороге с подъёмом (2 с на блок высоты), не дома деревни.
    if (!grove && anyY) grove = all.filter(t => t.n >= 4).sort((a, b) => flat(from, a) + 2 * Math.abs(a.y - (opts.fromY + 3)) - flat(from, b) - 2 * Math.abs(b.y - (opts.fromY + 3)))[0] || null
    // Рощи нет ближе 100 м (24 % сканированных сидов пула: пустыня, океан, степь) — дерево из построек (правило
    // пользователя: ресурсы сначала из построек): деревня ближе 260 м — брёвна/доски её домов (rt3-A1 слоты 16, 17: брёвна
    // искались вслепую 8–11 мин, смерти).
    let src = null
    if (!nearAny && (!grove || flat(from, grove) > 100) && info.village && flat(from, info.village) <= 260 && !outpostNear(info, info.village) && process.env.ND_ROUTE_VWOOD !== '0') {
      const vch = info.ores && (info.ores.chests || []).filter(c => /^village\//.test(c.table) && flat(c, info.village) <= 96).sort((a, b) => flat(from, a) - flat(from, b))[0]
      grove = vch ? { x: vch.x, y: vch.y, z: vch.z, n: 0 } : { x: info.village.x, y: undefined, z: info.village.z, n: 0 }
      src = 'village'
    }
    if (process.env.ND_ROUTE_WOODMAP !== '0') {
      const mapped = woodCandidates(info, from, opts.fromY)[0]
      if (mapped && (mapped.in || !grove)) { grove = { ...mapped, ...(mapped.stand || {}) }; src = 'mapwood' }
    }
    steps.push({ id: 'wood', kind: 'wood', ...(grove ? { at: { x: grove.x, y: grove.y, z: grove.z }, d: Math.round(flat(from, grove)) } : {}), ...(src ? { src } : {}), ...(grove && grove.in ? { in: grove.in } : {}), budget: WORK.wood + (grove ? Math.round(flat(from, grove) / SPEED) : 0), why: `брёвна, верстак, деревянная кирка${src === 'village' ? ' (рощ рядом нет — дома деревни по карте)' : grove ? ` (роща ${grove.n} брёвен по карте)` : ''}` })
  }
  if (!stonePick && ok('stone')) steps.push({ id: 'stone', kind: 'stone', budget: WORK.stone, why: 'каменная кирка, меч, печь, блоки на литьё' })
  void logs
  // Шаг кровати встаёт сразу после камня (меч есть) — место в списке шагов запоминаем здесь.
  const bedAt = steps.length

  // Готовая рама без огня (opts.frame, campaign castOneAt) — не новая лава, а огонь и поджиг её (шаг light).
  const frame = opts.frame && ok('light') ? opts.frame : null
  const lava = frame ? { kind: 'frame', id: 'light', at: { x: frame.x, y: frame.y, z: frame.z } } : pickLava(info, from, { avoid })
  // Куда идём в конце: лава (или спавн, если вниз вслепую).
  const end = lava.at ? { x: lava.at.x, z: lava.at.z } : from
  let iron = ironNeed(have)
  // Огонь есть или будет из рюкзака: огниво/заряд, или кремень + слиток сверх вёдер (огниво — крафт на месте).
  const ingotsSpare = (have.iron_ingot || 0) + (have.raw_iron || 0) - 3 * Math.max(0, BUCKETS() - ((have.bucket || 0) + (have.water_bucket || 0) + (have.lava_bucket || 0)))
  const lighter = (have.flint_and_steel || 0) + (have.fire_charge || 0) > 0 || ((have.flint || 0) > 0 && ingotsSpare >= 1)
  // Кандидаты на заход: { id, kind, at, cost (крюк, с), gives }.
  const detour = at => (flat(from, at) + flat(at, end) - flat(from, end)) / SPEED
  const cand = []
  // Скан копии v2 знает сундуки построек (место и таблицу лута) и где постройки встали: место — сундук, нет сундука в
  // скане, а постройка внутри квадрата скана — её нет (cubiomes знает попытку). Вне квадрата — по seedtool.
  const sc = info.ores && info.ores.v >= 2 ? info.ores : null // v3: у руды ещё wet (вода/лава в ±3)
  const inScan = at => sc && sc.spawn && Math.abs(at.x - sc.spawn.x) <= (sc.half || 0) - 8 && Math.abs(at.z - sc.spawn.z) <= (sc.half || 0) - 8
  // Постройка вокруг сундука (по BB из скана): океанские руины и затонувший (не выброшенный на берег) корабль — под водой:
  // утопленники и воздух (rt-R0: 3 из 7 смертей — утопленники/утонул) — туда не ходим.
  const structAt = c => sc ? (sc.structures || []).find(t => Array.isArray(t.bb) && c.x >= t.bb[0] - 1 && c.x <= t.bb[3] + 1 && c.z >= t.bb[2] - 1 && c.z <= t.bb[5] + 1 && c.y >= t.bb[1] - 2 && c.y <= t.bb[4] + 2) : null
  const wet = c => { const t = structAt(c); return (c.wet || 0) > 2 || (!!t && (/ocean|underwater/.test(t.name) || (/^shipwreck$/.test(t.name)))) }
  const chestOf = (re, near, r = 48) => sc ? (sc.chests || []).filter(c => re.test(c.table) && (!near || flat(c, near) <= r) && !wet(c)).sort((a, b) => (near ? flat(a, near) - flat(b, near) : flat(from, a) - flat(from, b)))[0] || null : null
  if (info.rp && ok('ruin') && !(lighter && (have.obsidian || 0) >= 2)) {
    const ch0 = chestOf(/^ruined_portal$/, info.rp, 40)
    // Руины под землёй (сундук ниже 48: вариант underground) — в темноте пещеры мобы: rtV-A 14 сундук на y −43 (хп 20 →
    // 13, 3 захода), R7 29 скелет у руин в пещере на 11-й мин. Такие — мимо (ND_ROUTE_DEEPRUIN=1 — брать).
    // Скан v6 знает верх рельефа над сундуком (gy): глубже 20 под ним — тоже под землёй (rtV-A 15: сундук y49 под горой
    // y88–104). Полузасыпанные (≤ 20) — берём: на D1 таких 3 из 16, а глубоких 5 (огонь тогда — кремень).
    const under = c => c.y < 30 || (Number.isFinite(c.gy) && c.y < c.gy - 20)
    const ch = ch0 && under(ch0) && process.env.ND_ROUTE_DEEPRUIN !== '1' ? null : ch0
    if (ch0 && !ch) { /* руины под землёй — не заход */ } else if (ch) cand.push({ id: 'ruin', kind: 'ruin', at: { x: ch.x, z: ch.z }, y: ch.y, chest: true, work: WORK.ruin - 10, gives: LOOT.ruin })
    else if (!inScan(info.rp)) cand.push({ id: 'ruin', kind: 'ruin', at: { x: info.rp.x, z: info.rp.z }, work: WORK.ruin, gives: LOOT.ruin })
  }
  if (info.village && ok('village')) {
    const vch = sc ? (sc.chests || []).filter(c => /^village\//.test(c.table) && flat(c, info.village) <= 96) : []
    const smith = vch.filter(c => /weaponsmith|toolsmith|armorer/.test(c.table))
    const golem = sc ? (sc.golems || []).filter(g => flat(g, info.village) <= 96).sort((a, b) => flat(a, info.village) - flat(b, info.village))[0] : null
    const outside = !sc || !inScan(info.village)
    const there = outside || vch.length > 0 || golem
    const iron = (golem || outside ? LOOT.golem.iron : 0) + smith.reduce((n, c) => n + (/weaponsmith/.test(c.table) ? 1.4 : /toolsmith/.test(c.table) ? 1.0 : 1.2), 0)
    // Место — у голема (по скану), иначе у кузницы, иначе точка seedtool.
    const at = golem ? { x: golem.x, z: golem.z } : smith[0] ? { x: smith[0].x, z: smith[0].z } : { x: info.village.x, z: info.village.z }
    if (there && iron > 0) cand.push({ id: 'village', kind: 'village', at, ...(golem ? { y: golem.y } : {}), work: WORK.village + WORK.golem, gives: { iron, ironMin: golem || outside ? LOOT.golem.ironMin : 0, food: 6, beds: true, smith: smith.map(c => c.table) } })
  }
  if (info.treasure && ok('treasure')) {
    const ch = chestOf(/^buried_treasure$/, info.treasure, 24)
    if (ch) cand.push({ id: 'treasure', kind: 'treasure', at: { x: ch.x, z: ch.z }, y: ch.y, work: WORK.treasure, gives: LOOT.treasure })
    else if (!inScan(info.treasure)) cand.push({ id: 'treasure', kind: 'treasure', at: { x: info.treasure.x, z: info.treasure.z }, work: WORK.treasure, gives: LOOT.treasure })
  }
  if (info.ship && ok('ship')) {
    const ch = chestOf(/^shipwreck_treasure$/, info.ship, 40)
    if (ch) cand.push({ id: 'ship', kind: 'ship', at: { x: ch.x, z: ch.z }, y: ch.y, work: WORK.ship, gives: { iron: 8, ironMin: 1, food: 1 } })
    else if (!inScan(info.ship)) cand.push({ id: 'ship', kind: 'ship', at: { x: info.ship.x, z: info.ship.z }, work: WORK.ship, gives: LOOT.ship })
  }
  // Руда у воздуха из скана копии (жила ≥ 3, не глубже 40 под рельефом): колодцем вниз у места (~1.2 с на уровень),
  // руда видна из пещеры, копка ~2 с на блок, назад наверх (~0.8 с на уровень).
  if (info.ores && Array.isArray(info.ores.iron)) {
    let k = 0
    for (const o of info.ores.iron) {
      const id = `ore:${o.x},${o.y},${o.z}`
      // Только руда, к которой идти пещерой от поверхности недалеко (скан v4: walk — шагов по воздуху от поверхности):
      // колодцы к пещерной руде вставали на воде водоносного слоя и кончались утопленниками (rt-R1: слоты 8, 14, 10).
      const walk = Number.isFinite(o.walk) ? o.walk : null
      if (!ok(id) || (o.n || 0) < 3 || (o.wet || 0) > 0) continue
      // rt-R1 (03:05): 7 смертей из 12 — все у пещерной руды глубже 17 бл. (утопленники в водоносном слое, скелеты,
      // крипер). Теперь только руда у самой поверхности (≤ 6 под рельефом) или пещера в 20 шагах от входа.
      if ((o.depth || 0) > 6 && (walk === null || walk > 20)) continue
      const st = o.stand || o
      // Риск пещеры (темно — мобы; rt-R1: 4 смерти из 12, все у пещерной руды) — к цене +90 с: голем со столба и сундуки
      // идут первыми, руда — добор.
      cand.push({ id, kind: 'ore', at: { x: st.x, z: st.z }, y: st.y, walk, depth: o.depth || 0, ore: { x: o.x, y: o.y, z: o.z }, work: 25 + (walk === null ? (o.depth || 0) * 2.2 : walk * 0.7) + Math.min(o.n, 10) * 2 + ((o.depth || 0) > 6 ? 90 : 0), gives: { iron: Math.min(o.n, 8) * 0.9, ironMin: Math.min(o.open || 1, 3) } })
      if (++k >= 16) break
    }
  }
  // Закрытая жила неглубоко (скан v6 ironBuried): свой колодец сверху (столбец без пещер), руда под ногами, назад своим
  // колодцем. Колодец ~2 с на уровень вниз и ~0.8 вверх; без пещер и воды по пути (проверено сканом). ND_ROUTE_DIG=0 — выкл.
  if (info.ores && Array.isArray(info.ores.ironBuried) && process.env.ND_ROUTE_DIG !== '0') {
    let k = 0
    for (const o of info.ores.ironBuried) {
      const id = 'dig:' + o.x + ',' + o.y + ',' + o.z
      if (!ok(id) || (o.n || 0) < 3 || flat(from, o) > 200) continue
      cand.push({ id, kind: 'ore', buried: true, at: { x: o.x, z: o.z }, y: o.y, depth: o.depth, top: o.top, ore: { x: o.x, y: o.y, z: o.z }, work: 20 + o.depth * 2.8 + Math.min(o.n, 8) * 2.5, gives: { iron: Math.min(o.n, 8) * 0.95, ironMin: Math.min(o.n, 3) } })
      if (++k >= 12) break
    }
  }
  for (const c of cand) {
    c.cost = detour(c.at) + c.work
    c.d = Math.round(flat(from, c.at))
  }
  // Заходы в зону аванпоста — мимо (пиллагеры в коробке постройки появляются всё время и бьют с 15+ бл.).
  for (let i = cand.length - 1; i >= 0; i--) if (outpostNear(info, cand[i].at, 8)) cand.splice(i, 1)
  // Выбор: руины — если крюк ≤ 100 с (огонь, обсидиан — дешевле, чем кремень и литьё лишней клетки); железо — по цене
  // слитка (с), пока ожидаемого не хватит с запасом (×1.25), а гарантированного — хотя бы на ведро.
  const chosen = []
  const structureBudgetSeconds = structureSearchLeft(opts.structureSeconds)
  let structureLeft = structureBudgetSeconds
  const ruin = cand.find(c => c.kind === 'ruin')
  // Без огня — руины и подальше: кремень из гравия в rt-R3/R4 — 1 из 7 и 2 из 8 (гравий у рек под водой, «не вижу»),
  // а сундук руин даёт огниво или заряд в 73 %.
  if (ruin && ruin.cost <= structureLeft && (ruin.cost <= 100 || (!lighter && ruin.cost <= 260))) {
    chosen.push(ruin); structureLeft -= ruin.cost; iron -= ruin.gives.iron * 0.5
  }
  if (ruin && chosen.includes(ruin) && !lighter) iron -= LOOT.ruin.lighter // огонь из сундука снимает слиток на огниво
  const structuresFirst = process.env.ND_ROUTE_STRUCTURES_FIRST !== '0'
  const ironCand = cand.filter(c => c.kind !== 'ruin' && c.d <= (c.kind === 'ore' ? 160 : 360))
    .sort((a, b) => (structuresFirst ? Number(a.kind === 'ore') - Number(b.kind === 'ore') : 0) ||
      a.cost / Math.max(0.5, a.gives.iron) - b.cost / Math.max(0.5, b.gives.iron))
  let expect = 0
  let sure = 0
  const need = Math.max(0, iron)
  for (const c of ironCand) {
    if (expect >= need && sure >= Math.min(need - 1, 2)) break
    if (c.cost > 420 || (c.kind !== 'ore' && c.cost > structureLeft)) continue
    chosen.push(c)
    if (c.kind !== 'ore') structureLeft -= c.cost
    expect += c.gives.iron
    sure += c.gives.ironMin || 0
  }
  // Не хватает и с этим — копать по пути (видимая руда), потом этап железа кампании (лесенка к y 16, штреки).
  const short = need > 0 && expect < need
  const ordered = orderPoints(from, chosen, end).order
  if (structuresFirst) ordered.sort((a, b) => Number(a.kind === 'ore') - Number(b.kind === 'ore'))
  for (const c of ordered) {
    steps.push({ id: c.id, kind: c.kind, at: { ...c.at, ...(c.y !== undefined ? { y: c.y } : {}) }, ...(c.ore ? { ore: c.ore, walk: c.walk, depth: c.depth, ...(c.buried ? { buried: true, top: c.top } : {}) } : {}), budget: Math.round(c.cost), d: c.d, gives: c.gives, why: whyOf(c) })
  }
  const needNow = ironNeed(have)
  const buckets = (have.bucket || 0) + (have.water_bucket || 0) + (have.lava_bucket || 0)
  // Железа в рюкзаке (с сырым и самородками) не хватает, а заходов за ним больше нет — копать; не вышло и это — этап
  // железа кампании; не вышло и он — маршрут кончается, дальше обычные этапы (giveup).
  const sourcesLeft = ordered.some(c => c.kind !== 'ruin')
  if (needNow > 0 && !sourcesLeft) {
    if (ok('mine')) steps.push({ id: 'mine', kind: 'mine', budget: 300, why: `железа ${needNow} не хватает — видимая руда в 48` })
    else if (ok('ironStage')) steps.push({ id: 'ironStage', kind: 'ironStage', budget: 600, why: `железа ${needNow} не хватает — этап железа (y 16)` })
    else steps.push({ id: 'giveup', kind: 'giveup', budget: 0, why: 'железа нет и не нашлось — дальше обычные этапы' })
  } else if (short && ok('mine') && !ordered.length) steps.push({ id: 'mine', kind: 'mine', budget: 300, why: `железа ожидается ${Math.round(expect * 10) / 10} из ${need} — руда по пути` })
  if (buckets < BUCKETS() && ok('smelt')) steps.push({ id: 'smelt', kind: 'smelt', budget: 60, why: BUCKETS() === 1 ? 'ведро' : 'вёдра' })
  // Огонь: огнива и заряда нет — кремень из гравия (10 % за блок): ближний гравий у воздуха из скана, иначе видимый.
  // Руины ещё впереди — огонь, скорее всего, будет оттуда (73 %), кремень — только если руины не дали.
  const ruinAhead = ordered.some(c => c.kind === 'ruin')
  if (!lighter && !ruinAhead && ok('flint')) {
    // Жила с открытыми гранями (open — клеток гравия у воздуха): у жилы с 1–2 открытыми клетками на 2–6 под рельефом тело
    // вставало у клетки скана и «не вижу gravel в 12» (rt3-A1 слоты 29, 18: кремень ✗ 73–112 с). Открытая и неглубокая — вперёд.
    const gScore = g => flat(from, g) + (g.depth || 0) * 8 - Math.min(g.open || 0, 40) * 1.5
    const grs = info.ores && Array.isArray(info.ores.gravel) ? info.ores.gravel.filter(g => (g.n || 0) >= 6 && (g.open || 0) >= 4 && (g.depth || 0) <= 6 && !(g.wet > 0) && flat(from, g) <= 200).sort((a, b) => gScore(a) - gScore(b)) : []
    // Открытого сухого гравия нет — закрытая залежь (скан v6 gravelBuried): свой колодец к ней, как к жиле железа.
    // Открытый — если дешевле: путь (2.5 м/с) + 30 с против пути + 3 с на уровень колодца + 40 с.
    const gb0 = info.ores && Array.isArray(info.ores.gravelBuried) && process.env.ND_ROUTE_DIGGRAVEL !== '0' ? info.ores.gravelBuried.filter(g => flat(from, g) <= 200 && !outpostNear(info, g, 8)).sort((a, b) => (flat(from, a) + a.depth * 7) - (flat(from, b) + b.depth * 7))[0] : null
    const gb = gb0 && (!grs.length || flat(from, gb0) / SPEED + gb0.depth * 3 + 40 < flat(from, grs[0]) / SPEED + 30) ? gb0 : null
    if (gb) {
      steps.push({ id: 'flint', kind: 'flint', buried: true, at: { x: gb.x, y: gb.top + 1, z: gb.z }, top: gb.top, ore: { x: gb.x, y: gb.y, z: gb.z }, n: gb.n, d: Math.round(flat(from, gb)), budget: 50 + Math.round(flat(from, gb) / SPEED) + gb.depth * 3, why: 'огниво: кремень из залежи гравия ' + gb.n + ' бл. в ' + gb.depth + ' под землёй (колодец)' })
    }
    const gat = gb ? null : (grs[0] || null)
    const alts = grs.slice(1, 4).map(g => ({ x: (g.stand || g).x, y: (g.stand || g).y, z: (g.stand || g).z }))
    if (!gb) steps.push({ id: 'flint', kind: 'flint', ...(gat ? { at: { x: (gat.stand || gat).x, y: (gat.stand || gat).y, z: (gat.stand || gat).z }, alts, d: Math.round(flat(from, gat)) } : {}), budget: 60 + (gat ? Math.round(flat(from, gat) / SPEED) : 120), why: `огниво: кремень из гравия${gat ? ` (гравий ${gat.n} по карте, запасных ${alts.length})` : ''}` })
  }
  if (ok('food')) {
    // Стадо съедобных по скану копии (звери при генерации стоят у места): крюк ≤ 60 с к самому дешёвому. Еды на входе в Ад
    // было 0 в 7 из 9 удачных (S8 07.10), а без еды ночью тело не лечится — смерти от пауков на 13–16 мин. ND_ROUTE_FOODMAP=0 — выкл.
    const herd = process.env.ND_ROUTE_FOODMAP === '0' ? null : foodHerds(info).filter(h => !outpostNear(info, h, 16) && (!Number.isFinite(opts.fromY) || Math.abs(h.y - opts.fromY) <= 16))
      .map(h => ({ h, c: detour(h) })).filter(x => x.c <= 60).sort((a, b) => a.c - b.c)[0]
    steps.push({ id: 'food', kind: 'food', ...(herd ? { at: { x: herd.h.x, y: herd.h.y, z: herd.h.z }, d: Math.round(flat(from, herd.h)) } : {}), budget: WORK.food + (herd ? Math.round(herd.c) : 0), why: `еды на вход ≥ 6 (${herd ? `стадо ${herd.h.n} по карте` : 'сено, звери по пути'})` })
  }
  if (ok('water') && !have.water_bucket && !frame) {
    // Вода с открытым верхом из скана: у лавы поверху (≤ 24) — литьё само зачерпнёт (cast.ensureWater), шаг не нужен;
    // иначе — источник с наименьшим крюком по пути к лаве (не подо льдом: у скана вода только с воздухом сверху).
    // Вода в зоне аванпоста — мимо (rt3-A5 слот 10: вода по карте в 68 м от аванпоста, сон там — пиллагер).
    const ws = info.ores && Array.isArray(info.ores.water) ? info.ores.water.filter(w => !outpostNear(info, w, 8)) : []
    const nearLava = lava.kind === 'sky' && lava.at && ws.some(w => flat(w, lava.at) <= 24)
    if (!nearLava) {
      const endW = lava.at || from
      const best = ws.map(w => ({ w, c: flat(from, w) + flat(w, endW) })).sort((a, b) => a.c - b.c)[0]
      // Крюк до 200 с; нет такой — ближняя вода карты в 250 м (rt3-V1: шаг воды без точки — разведка вслепую 43–92 с, ✗).
      const wat = best && best.c - flat(from, endW) <= 200 ? best.w : (ws.slice().sort((a, b) => flat(from, a) - flat(from, b)).find(w => flat(from, w) <= 250) || null)
      steps.push({ id: 'water', kind: 'water', ...(wat ? { at: { x: (wat.stand || wat).x, y: (wat.stand || wat).y, z: (wat.stand || wat).z }, d: Math.round(flat(from, wat)) } : {}), budget: WORK.water + (wat ? Math.round((flat(from, wat) + flat(wat, endW) - flat(from, endW)) / SPEED) : 30), why: `ведро воды на литьё${wat ? ' (вода по карте)' : ''}` })
    }
  }
  const travel = Math.round(flat(ordered.length ? ordered[ordered.length - 1].at : from, end) / SPEED)
  if (lava.kind === 'frame') steps.push({ id: 'light', kind: 'light', at: lava.at, budget: travel + 30, d: Math.round(flat(from, lava.at)), why: "готовая рама без огня — поджиг" })
  else if (lava.kind === 'sky') steps.push({ id: lava.id, kind: 'castSky', at: lava.at, budget: travel + WORK.castSky, d: Math.round(flat(from, lava.at)), why: `лава под небом (${lava.cls}, ${lava.tag}, источников ${lava.src ?? '?'}) — литьё поверху` })
  else if (lava.kind === 'cave') steps.push({ id: lava.id, kind: 'castCave', at: lava.at, budget: travel + WORK.castCave + Math.round((lava.depth || 0) * 2), d: Math.round(flat(from, lava.at)), why: `лава в пещере (${lava.cls}, ${lava.tag}, глубина ${lava.depth ?? '?'}, источников ${lava.src ?? '?'}) — вниз к ней и литьё с окнами` })
  else steps.push({ id: 'lava:deep', kind: 'castDeep', budget: 600, why: 'видимой лавы по карте нет — вниз к −54 (глубокое литьё)' })
  steps.push({ id: 'enter', kind: 'enter', budget: WORK.enter, why: 'в Ад' })
  // Кровать к ночи: нет кровати и 3 шерсти одного цвета, план до Ада не успевает до ~9-й мин — шаг bed после камня
  // (стадо или кровать постройки по карте, дешевле 240 с). Деревня с кроватями в плане до ~8-й мин — кровать оттуда.
  const bedOwned = Object.keys(have).some(k => /_bed$/.test(k)) || (Object.entries(have) as [string, any][]).some(([k, v]: any) => /_wool$/.test(k) && v >= 3)
  const elapsed = Number(opts.elapsed) || 0
  let bedStep = null
  // Кровать в маршруте — только ND_ROUTE_BED=1: в спидране сон запрещён (routeSleep при speedrun выходит), кровать — потеря
  // ~1.3 мин на прогон (night05t/day05r, S8 07.10).
  if (!bedOwned && ok('bed') && process.env.ND_ROUTE_BED === '1') {
    const total = steps.reduce((n, s) => n + (s.budget || 0), 0)
    let cum = elapsed
    let villageBy = Infinity
    for (const s of steps) { cum += s.budget || 0; if (s.kind === 'village') { villageBy = cum; break } }
    const villageBeds = villageBy <= 480 && (!sc || (sc.beds || []).some(b => /village/.test(b.in || '') && info.village && flat(b, info.village) <= 120) || !inScan(info.village))
    if (elapsed + total > 560 && !villageBeds) {
      const b = bedCands(info, from, ordered.length ? ordered[0].at : end)[0]
      if (b && b.cost <= 240) bedStep = { id: 'bed', kind: 'bed', how: b.how, at: b.at, ...(b.color !== undefined ? { color: b.color, n: b.n } : {}), ...(b.in ? { in: b.in } : {}), budget: b.cost, d: Math.round(flat(from, b.at)), why: b.how === 'sheep' ? `кровать: стадо ${b.n} овец цвета ${b.color} по карте` : `кровать: ${b.in || 'постройка'} по карте` }
    }
  }
  if (bedStep) steps.splice(bedAt, 0, bedStep)
  const budget = steps.reduce((n, s) => n + (s.budget || 0), 0)
  return { seed: info.seed, lava, ironNeed: need, ironExpect: Math.round(expect * 10) / 10, short, steps, budget, structureBudgetSeconds, route: routeName(steps) }
}

function whyOf (c) {
  if (c.kind === 'ruin') return `сундук руин: огонь ${Math.round(LOOT.ruin.lighter * 100)} %, обсидиан ~${LOOT.ruin.obsidian}, ${c.d} м`
  if (c.kind === 'village') return `деревня ${c.d} м: голем 3–5 железа, сено, кровати, сундуки`
  if (c.kind === 'treasure') return `клад ${c.d} м: железо ~9, рыба`
  if (c.kind === 'ship') return `корабль ${c.d} м: сундук сокровищ ~8 железа (если есть), еда`
  if (c.kind === 'ore' && c.buried) return 'жила железа в ' + c.depth + ' бл. под землёй, ' + c.d + ' м: колодец сверху, ~' + Math.round(c.gives.iron * 10) / 10 + ' железа'
  if (c.kind === 'ore') return `руда на виду ${c.d} м: ~${c.gives.iron} железа`
  return c.kind
}
// Короткое имя маршрута для журнала: A — руины + лава под небом, B — деревня + лава под небом, C — глубоко, …
function routeName (steps) {
  const k = new Set(steps.map(s => s.kind))
  const lava = k.has('light') ? 'готовая рама' : k.has('castSky') ? 'небо' : k.has('castCave') ? 'пещера' : 'глубоко'
  const iron = ['village', 'treasure', 'ship', 'ore', 'mine'].filter(x => k.has(x))
  return `${k.has('ruin') ? 'руины + ' : ''}${iron.join('+') || 'без железа'} → лава: ${lava}`
}

// Строка для журнала: шаги с бюджетом.
function describe (p) {
  return `маршрут [${p.route}], бюджет ${Math.round(p.budget / 60 * 10) / 10} мин` +
    (Number.isFinite(p.structureBudgetSeconds) ? `; поиск построек осталось ${Math.floor(p.structureBudgetSeconds)} с, затем руда` : '') + ': ' +
    p.steps.map(s => `${s.id}${s.d !== undefined ? `(${s.d} м)` : ''} ${s.budget} с`).join(' → ')
}

// Кэш seedtool по пулу: node daemon/src/route.js cache  (300 сидов — ~10 с).
if (require.main === module) {
  const cmd = process.argv[2]
  if (cmd === 'cache') {
    const seeds = (JSON.parse(fs.readFileSync(POOL, 'utf8')).seeds || []).map(s => String(s.seed))
    const c = readCache()
    const left = seeds.filter(s => !c[s])
    for (let i = 0; i < left.length; i += 50) {
      const chunk = left.slice(i, i + 50)
      const out = require('child_process').execFileSync(SEEDTOOL, ['info', ...chunk], { encoding: 'utf8', timeout: 120000, windowsHide: true })
      for (const line of out.trim().split('\n')) { try { const j = JSON.parse(line); c[String(j.seed)] = j } catch {} }
    }
    fs.writeFileSync(CACHE, JSON.stringify(c))
    console.log(`кэш: ${Object.keys(c).length} сидов → ${CACHE}`)
  } else if (cmd === 'plan') {
    const info = routeInfo(process.argv[process.argv.length - 1])
    if (!info) { console.log('сида нет'); process.exit(1) }
    console.log(describe(plan(info)))
  } else if (cmd === 'stats') {
    const seeds = (JSON.parse(fs.readFileSync(POOL, 'utf8')).seeds || []).filter(s => typeof s.lava === 'number').map(s => String(s.seed))
    const by = {}
    const budgets = []
    for (const s of seeds) { const p = plan(routeInfo(s)); by[p.route] = (by[p.route] || 0) + 1; budgets.push(p.budget) }
    budgets.sort((a, b) => a - b)
    console.log(JSON.stringify({ n: seeds.length, medianBudgetMin: Math.round(budgets[budgets.length >> 1] / 6) / 10, p90Min: Math.round(budgets[Math.floor(budgets.length * 0.9)] / 6) / 10, routes: (Object.entries(by) as [string, any][]).sort((a: any, b: any) => b[1] - a[1]) }, null, 1))
  } else console.log('node daemon/src/route.js cache | plan <сид> | stats')
}

module.exports = { foodHerds, structureSearchLeft, outpostStepCost, woodCandidates, outpostNear, outpostWaypoint, sheepHerds, bedCands, BUCKETS, routeInfo, seedInfo, poolRow, oresOf, plan, pickLava, lavaCands, castOdds, ironNeed, orderPoints, describe, routeName, LOOT, WORK, SPEED }
