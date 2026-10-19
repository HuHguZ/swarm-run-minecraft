'use strict'
// Маршрут: данные по сиду (seedtool, пул, скан копии) и вслепую (увиденное), скорость и цены работы, аванпост.
import { REPO_ROOT } from '../paths'
import * as fs from 'fs'
import * as path from 'path'
import * as knowledge from '../perception/knowledge'

const ROOT = REPO_ROOT
export const SEEDTOOL = path.join(ROOT, 'tools', 'seedtool', 'seedtool.exe')
export const POOL = path.join(ROOT, 'farm', 'seeds', 'good-v2.json')
export const CACHE = path.join(ROOT, 'farm', 'seeds', 'route-info.json')
const ORES = path.join(ROOT, 'farm', 'route-scan')

export const SPEED = 2.5 // м/с по рельефу
export const MINE_IRON_S = 700 // железо копкой без руды по карте, с (см. plan)
// Общий бюджет поиска ресурсов в постройках, включая переходы. Это политика
// маршрута, не коэффициент механики; ND_ROUTE_STRUCTURE_BUDGET=0 — прежний выбор.
export function structureSearchLeft (seconds = 0) {
  return process.env.ND_ROUTE_STRUCTURE_BUDGET === '0' ? Infinity : Math.max(0, 180 - Math.max(0, Number(seconds) || 0))
}
// Ожидания по луту (см. шапку).
export const LOOT = {
  ruin: { lighter: 0.73, obsidian: 0.9, iron: 0.47 },
  golem: { iron: 4, ironMin: 3 },
  ship: { iron: 5, ironMin: 0, food: 2 },
  treasure: { iron: 9, ironMin: 2, food: 3 }
}
// Работа на месте, с (без дороги).
export const WORK = { wood: 90, stone: 90, ruin: 45, village: 80, golem: 60, ship: 150, treasure: 120, ore: 40, smelt: 15, water: 40, food: 60, castSky: 90, castCave: 200, enter: 30 }
// Цена смерти в секундах — как у графа (72000 тиков = 1 ч игры).
export const DEATH_S = 3600
// Риск голема деревни (S8d, замечание проверки S8c «д»): по всем сериям S8–S8c (farm/results/s8*, 706 прогонов) деревню с
// големом навещали в 49 прогонах, убит голем 35 раз из 85 вызовов, смертей «slain by Iron Golem» — 5 (удар голема на normal
// 7.5–21.5, два удара — смерть). Лаплас: (5 + 0.5) / (49 + 1) ≈ 0.11 на заход. К цене деревни — риск × цена смерти, а не запрет.
// ND_ROUTE_GOLEM_RISK=0 — без риска (прежняя цена).
export const GOLEM_DEATH_P = 0.11
// Риск копки железа (то, с чем голем сравнивается): s8c вслепую (78 прогонов s8c-a…g-v) — 8 смертей на шагах железа (ironStage 5,
// MineIron 2, iron 1): (8 + 0.5) / (78 + 1) ≈ 0.11.
export const MINE_DEATH_P = 0.11

export const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
export const asXZ = p => (Array.isArray(p) ? { x: p[0], z: p[1] } : p)
let poolCache = null
export function poolRow (seed) {
  if (!knowledge.allows('lava', 'route.poolRow')) return null // S10: в rsg скан копии (good-v2) не читается
  if (!poolCache) { try { poolCache = JSON.parse(fs.readFileSync(POOL, 'utf8')).seeds || [] } catch { poolCache = [] } }
  return poolCache.find(x => String(x.seed) === String(seed)) || null
}
let infoCache = null
export function readCache () {
  if (infoCache) return infoCache
  try { infoCache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) } catch { infoCache = {} }
  return infoCache
}
// seedtool info <сид> — постройки от спавна (одна строка JSON). Кэш — farm/seeds/route-info.json.
export function seedInfo (seed, { run = true }: any = {}) {
  if (!knowledge.allows('seedtool', 'route.seedInfo')) return null // S10: в rsg ни seedtool, ни его кэш
  const c = readCache()
  if (!/^-?\d+$/.test(String(seed))) return null
  if (c[String(seed)]) return c[String(seed)]
  if (!run || !fs.existsSync(SEEDTOOL)) return null
  try {
    const out = (require('child_process') as typeof import('child_process')).execFileSync(SEEDTOOL, ['info', String(seed)], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    const j = JSON.parse(out.trim().split('\n')[0])
    c[String(seed)] = j
    try { fs.writeFileSync(CACHE, JSON.stringify(c)) } catch {}
    return j
  } catch { return null }
}
// Руда на виду из скана копии мира (если сканирован): [{x,y,z,n,open}] — n руды в жиле, open — сколько у воздуха.
export function oresOf (seed) {
  if (!knowledge.allows('structures', 'route.oresOf')) return null // S10: скан копии — от ssg (блоки — mapLevel blocks)
  try { const j = JSON.parse(fs.readFileSync(path.join(ORES, `${seed}.json`), 'utf8')); return { v: j.v || 1, spawn: j.spawn, half: j.half, iron: j.iron || [], water: j.water || [], gravel: j.gravel || [], coal: j.coal || [], trees: j.trees || [], wood: j.wood || [], lava: j.lava || [], chests: j.chests || [], structures: j.structures || [], golems: j.golems || [], animals: j.animals || [], beds: j.beds || [], ironBuried: j.ironBuried || [], gravelBuried: j.gravelBuried || [] } } catch { return null }
}

// Уровень знания карты копии (S8c 07.10; AGENTS.md 03.10, замечание проверки а). Каждый уровень включается явно:
//   ND_MAP=0      — вслепую (по умолчанию, главная метрика с 09:24): из копии ничего (сид — только в телеметрию);
//   ND_MAP=struct — «известный сид»: постройки (seedtool; из скана — коробки построек, их сундуки и кровати,
//                   дерево построек, голем деревни) и лава (good-v2 и тела лавы скана);
//   ND_MAP=blocks — плюс блоки скана: руда, гравий, вода, деревья, уголь (с пользователем не согласовано — отдельная строка).
// Стада (сущности скана) — только ND_ROUTE_FOODMAP=1 и только на blocks.
// Решение пользователя 07.10 09:24 (AGENTS.md): ГЛАВНАЯ метрика — как игрок на случайном сиде (вслепую), поэтому по умолчанию
// blind; «известный сид» (struct) и «полный скан» (blocks) — отдельными строками. ND_KNOWLEDGE=rsg|ssg|scan (общий
// переключатель S10) — то же: rsg → blind, ssg → struct, scan → blocks; ND_MAP главнее.
// S10: уровень — perception/knowledge (ND_KNOWLEDGE — потолок, если задан; ND_MAP ниже потолка — ND_MAP; без
// ND_KNOWLEDGE — по ND_MAP, по умолчанию blind).
export function mapLevel (): 'blind' | 'struct' | 'blocks' { return knowledge.mapLevel() }
// Вслепую — то, что тело само увидело/услышало (S8c): постройки по взгляду (structure scan/list демона), лава на виду или по
// слуху. Форма — как у routeInfo, без скана копии (ores null).
export function seenInfo ({ spawn, structures = [], lava = null, cave: cave0 = null }: { spawn: { x: number, z: number }, structures?: any[], lava?: any, cave?: any }) {
  const st = (kind: string) => {
    const s = structures.filter(q => q && q.kind === kind && !q.done && q.at && Number.isFinite(q.at.x)).sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0))[0]
    return s ? { x: s.at.x, z: s.at.z, ...(Number.isFinite(s.at.y) ? { y: s.at.y } : {}), d: Math.round(flat(spawn, s.at)) } : null
  }
  const sky = lava && lava.sky ? { x: lava.x, y: lava.y, z: lava.z, cls: 'surface', src: lava.src ?? 40, d: Math.round(flat(spawn, lava)) } : null
  // Пещерная — из lava без sky или отдельным cave (поверху и в пещере видели обе: обе в кандидатах литья).
  const cv = lava && !lava.sky ? lava : cave0
  const cave = cv ? { x: cv.x, y: cv.y, z: cv.z, cls: 'open-cave', depth: cv.depth ?? 8, src: cv.src ?? 20, d: Math.round(flat(spawn, cv)) } : null
  return { seed: 'seen', map: 'blind', spawn, biome: null, rp: st('ruined_portal'), village: st('village'), ship: st('shipwreck'), treasure: st('buried_treasure'),
    rpLavaOk: false, sky, lava: cave, outposts: [], ores: null }
}
export function structOnly (sc) {
  if (!sc) return sc
  return { ...sc, iron: [], ironBuried: [], gravel: [], gravelBuried: [], water: [], trees: [], coal: [], animals: [], wood: (sc.wood || []).filter(w => w.in) }
}

// Всё, что известно о мире по сиду: { seed, spawn, biome, rp, village, ship, treasure, lava, sky, ores, map }.
export function routeInfo (seed, { ores = true }: any = {}) {
  if (seed === undefined || seed === null || seed === '') return null
  const level = mapLevel()
  if (level === 'blind') return null
  const s = seedInfo(seed)
  const p = poolRow(seed)
  if (!s && !p) return null
  const st = k => (s && s[k] && Number.isFinite(s[k].x)) ? { x: s[k].x, z: s[k].z, d: s[k].d } : null
  const spawn = s && Array.isArray(s.spawn) ? { x: s.spawn[0], z: s.spawn[1] } : (p && Array.isArray(p.spawn) ? { x: p.spawn[0], z: p.spawn[1] } : { x: 0, z: 0 })
  const sky = p && p.sky && Array.isArray(p.sky.at) ? { x: p.sky.at[0], y: p.sky.at[1], z: p.sky.at[2], cls: p.sky.cls, src: p.sky.src, d: p.sky.d } : null
  const lava = p && Array.isArray(p.lavaAt) ? { x: p.lavaAt[0], y: p.lavaAt[1], z: p.lavaAt[2], cls: p.lavaClass, depth: p.lavaDepth, src: p.lavaSrc, d: p.lava } : null
  const sc0 = ores ? oresOf(seed) : null
  const sc = level === 'blocks' ? sc0 : structOnly(sc0)
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
    map: level,
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
export function outpostNear (info, at, pad = 0) {
  for (const o of ((info && info.outposts) || [])) { const d = flat(o, at); if (d <= o.r + pad) return { o, d } }
  return null
}
// Отрезок from → to задевает зону аванпоста — точка обхода сбоку (на r + 20 от центра), иначе null.
// Путевую точку pathfinder может срезать через опасную зону. Ограничиваем каждую клетку пути;
// старт внутри зоны допускает только движения наружу, без телепорта.
export function outpostStepCost (info, from, next) {
  for (const o of ((info && info.outposts) || [])) {
    const r = o.r + 24; const now = flat(o, from); const after = flat(o, next)
    if (after <= r && (now > r || after + 0.01 < now)) return Infinity
  }
  return 0
}
export function outpostWaypoint (info, from, to) {
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
