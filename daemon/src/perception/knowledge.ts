'use strict'
// Что бот знает о мире помимо глаз (S10, 07.10; AGENTS.md «Что бот знает о мире — как игрок на случайном сиде»).
//
//   ND_KNOWLEDGE=rsg  — ПО УМОЛЧАНИЮ, главная метрика: случайный сид. Ни seedtool, ни /locate, ни скана копии мира —
//                       только игровое: глаза (perception/eyes), F3, «пирог», звук (perception/senses), око эндера.
//   ND_KNOWLEDGE=ssg  — «известный сид», отдельная строка: постройки по сиду (seedtool, /locate построек копии, коробки
//                       построек скана с их сундуками) и лава скана (good-v2).
//   ND_KNOWLEDGE=scan — «полный скан», отдельная строка: плюс блоки скана (руда, гравий, вода, деревья), стада, биомы,
//                       сетки Ада (GRID), золото бастиона (MAP).
//
// Старые флаги. ND_KNOWLEDGE не задан — уровень выводится из них (сцены и цепочки потоков, писавшие ND_MAP/MAP_*/GRID):
// ND_MAP=0 → rsg (окончательно), ND_MAP=struct|1, MAP_SH=1, MAP_BASTIONS → ssg, ND_MAP=blocks, MAP=1, GRID=1 → scan.
// ND_ROUTE, MAP_LAVA, ND_ROUTE_FOODMAP уровня не поднимают (S8c: они действуют только поверх ND_MAP≠0). ND_KNOWLEDGE задан —
// он ПОТОЛОК: старый флаг, просящий больше, не действует (allows отвечает «нет», строка в журнал один раз).
//
// Проверка — в загрузчиках (route.seedInfo/poolRow/oresOf, portal-natural.poolInfo, сцены карты): allows(вид) до чтения файла.

type Level = 'rsg' | 'ssg' | 'scan'
const RANK: Record<Level, number> = { rsg: 0, ssg: 1, scan: 2 }

// Вид знания → наименьший уровень, на котором его можно читать.
const NEED: Record<string, Level> = {
  seedtool: 'ssg', // постройки по сиду: деревня, руины, корабль, клад, аванпост, крепость
  structures: 'ssg', // /locate построек в копии (бастионы, крепости Ада и Края), коробки построек скана и их сундуки
  lava: 'ssg', // лава скана копии (good-v2 sky/lavaAt, portal-scan)
  blocks: 'scan', // руда, гравий, вода, деревья, уголь скана
  herds: 'scan', // стада скана
  biomes: 'scan', // /locate biome, биомы скана
  grid: 'scan', // сетки Ада по копии (GRID)
  gold: 'scan' // золото бастиона из копии (MAP=1)
}

const env = () => process.env
const valid = (v): v is Level => v === 'rsg' || v === 'ssg' || v === 'scan'

// Уровень по старым флагам (ND_KNOWLEDGE не задан).
function legacy (e = env()): Level {
  const map = String(e.ND_MAP || '').toLowerCase()
  if (map === '0' || map === 'blind') return 'rsg'
  if (map === 'blocks' || e.MAP === '1' || e.GRID === '1') return 'scan'
  if (map === 'struct' || map === '1' || e.MAP_SH === '1' || (e.MAP_BASTIONS && e.MAP_BASTIONS !== '0')) return 'ssg'
  return 'rsg'
}

function explicit (e = env()): Level | null {
  const k = String(e.ND_KNOWLEDGE || '').toLowerCase()
  return valid(k) ? k : null
}

function level (e = env()): Level { return explicit(e) || legacy(e) }

const told = new Set()
// Можно ли читать вид знания what. who — кто спрашивает (для строки журнала при отказе).
function allows (what: string, who = '', e = env()): boolean {
  const need = NEED[what]
  if (!need) throw new Error(`knowledge: неизвестный вид знания ${what}`)
  const ok = RANK[level(e)] >= RANK[need]
  if (!ok && !told.has(what + who)) {
    told.add(what + who)
    try { console.log(`[знание] ${level(e)}: ${who || what} — ${what} не читаю (нужно ${need})`) } catch {}
  }
  return ok
}

// Уровень карты маршрута (route.mapLevel, S8c): blind | struct | blocks. ND_MAP ниже потолка — ND_MAP.
function mapLevel (e = env()): 'blind' | 'struct' | 'blocks' {
  const byLevel = { rsg: 'blind', ssg: 'struct', scan: 'blocks' } as const
  const cap = level(e)
  const map = String(e.ND_MAP || '').toLowerCase()
  const asked: Level | null = map === '0' || map === 'blind' ? 'rsg' : map === 'blocks' ? 'scan' : (map === 'struct' || map === '1') ? 'ssg' : null
  return byLevel[asked && RANK[asked] < RANK[cap] ? asked : cap]
}

// Подпись для строк итогов и журналов: «rsg (случайный сид)» и т. п.
const TITLE: Record<Level, string> = { rsg: 'случайный сид', ssg: 'известный сид', scan: 'полный скан' }
function describe (e = env()) { const l = level(e); return `${l} (${TITLE[l]}${explicit(e) ? '' : ', из старых флагов'})` }

module.exports = { level, allows, mapLevel, describe, legacy, NEED, RANK }
