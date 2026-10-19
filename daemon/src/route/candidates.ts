'use strict'
// Маршрут: кандидаты по карте — стада и кровати, нужда в железе, порядок заходов, лава для литья, рощи.
import { flat, SPEED, outpostNear, WORK } from './data'

// Кровать к ночи (поток route, 03.10): rtV/R7 — 17 из 24 смертей ночью, кровать к 10-й мин была в 7 прогонах из 48.
// Ночь (сон с 12542 тиков) при старте с утра (1000) — на ~9.6-й мин. Источники по карте копии мира: стадо ≥ 3 овец
// одного цвета (скан v6: овцы при генерации, с 1.21.5 цвет от биома), кровать постройки (деревня, иглу; скан v6 beds).
// Цена — крюк + работа; дороже 240 с — не план, а попутно (кампания: овцы на виду, сторож ночи).
export function sheepHerds (info) {
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
export function foodHerds (info) {
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
export function bedCands (info, from, end) {
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
export const BUCKETS = () => (process.env.ND_ROUTE_ONE === '0' ? 2 : 1)
// Сколько железа нужно до портала: 3 на ведро, огниво — слиток, если огня нет.
export function ironNeed (have: any = {}, { buckets: want = BUCKETS() }: any = {}) {
  const buckets = (have.bucket || 0) + (have.water_bucket || 0) + (have.lava_bucket || 0)
  const lighter = (have.flint_and_steel || 0) + (have.fire_charge || 0) > 0
  return Math.max(0, 3 * Math.max(0, want - buckets) + (lighter ? 0 : 1) - (have.iron_ingot || 0) - (have.raw_iron || 0) - Math.floor((have.iron_nugget || 0) / 9))
}

// Перебор порядка точек (их ≤ 5): кратчайший путь от from через все, последняя — last (если задана).
export function orderPoints (from, pts, last = null) {
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
export function castOdds (kind, cls, depth, src) {
  if (cls === 'rp') return 0.03
  if (kind === 'sky') return (Number.isFinite(src) ? src : 40) >= 40 ? 0.42 : 0.24
  if (cls === 'open-cave') return 0.45
  return (depth || 0) <= 6 ? 0.33 : (depth || 0) <= 12 ? 0.45 : 0.16
}
// По умолчанию (ND_ROUTE_LAVAP=0 — прежняя цена по дороге): цена кандидата = (дорога + работа) / доля: ожидаемое время до горящей рамы с учётом повторов у
// следующей лавы, а не только дорога (рядом глубокая пещера 16 % проигрывала озеру поверху в 300 м с 42 %).
const LAVAP = () => process.env.ND_ROUTE_LAVAP !== '0'
export function lavaCands (info, from) {
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
export function pickLava (info, from, { skyMax = 520, caveMax = 420, avoid = new Set() }: any = {}) {
  const c = lavaCands(info, from).find(x => !avoid.has(x.id) && !avoid.has(`lava:${x.kind}`) && flat(from, x.at) <= (x.kind === 'sky' ? skyMax : caveMax))
  if (c) return c
  return { kind: 'deep', at: null, id: 'lava:deep' }
}

// План: шаги по порядку. opts.from — где тело (по умолчанию спавн), opts.have — рюкзак (имя → число),
// opts.avoid — шаги, которые уже не вышли (id), opts.done — сделанные (id). Шаг: { id, kind, at?, budget, why, gives? }.
// Скан v7 даёт видимую древесину построек и сухую клетку подхода; v6 — рощи.
export function woodCandidates (info, from, fromY) {
  const sc = (info && info.ores) || {}
  const score = p => flat(from, p.stand || p) / SPEED + (Number.isFinite(fromY) && Number.isFinite(p.y) ? Math.abs(p.y - fromY) * 2 : 0)
  const safe = p => p.n >= 3 && flat(from, p.stand || p) <= 520 && !outpostNear(info, p, 24) && !/outpost/.test(p.in || '')
  const mapped = (sc.wood || []).filter(safe).sort((a, b) => score(a) - score(b))
  const buildings = mapped.filter(p => p.in)
  const natural = [...mapped.filter(p => !p.in), ...(sc.trees || []).filter(safe)].sort((a, b) => score(a) - score(b))
  return [...buildings, ...natural]
}
