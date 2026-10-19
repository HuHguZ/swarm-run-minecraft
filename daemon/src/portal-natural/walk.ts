'use strict'
// Природная лава для портала (portal-natural.ts): куда идти и откуда смотреть — точка обзора, ноги поиска, берег лавы, мягкие клетки, столб над листвой.
import { Vec3 } from 'vec3'
import { goals } from 'mineflayer-pathfinder'
import * as gameClock from '../game-clock'
import { REPO_ROOT } from '../paths'
import { xyz, sleep } from '../movement'
import { isAir, isLavaSrc, lavaBody, survey } from './look'


// ---------------------------------------------------------------- ход

// Ближняя высота: самый высокий столб в radius, куда можно встать (верх — твёрдый не лист, над ним два воздуха).
export function lookoutSpot (bot, radius = 24) {
  const me = bot.entity.position.floored()
  let best = null
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dz = -radius; dz <= radius; dz += 2) {
      if (dx * dx + dz * dz > radius * radius) continue
      for (let y = me.y + 30; y >= me.y - 4; y--) {
        const p = new Vec3(me.x + dx, y, me.z + dz)
        const b = bot.blockAt(p)
        if (!b) break
        if (isAir(b)) continue
        if (b.boundingBox === 'block' && !/leaves|log|water|lava/.test(b.name) && isAir(bot.blockAt(p.offset(0, 1, 0))) && isAir(bot.blockAt(p.offset(0, 2, 0)))) {
          if (!best || y > best.y) best = { x: p.x, y: p.y + 1, z: p.z }
        }
        break
      }
    }
  }
  return best && best.y >= me.y + 4 ? best : null
}

export async function walkNear (bot, ctl, at, range, ms) {
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(at.x, at.y, at.z, range)),
      new Promise<any>((resolve, reject) => gameClock.setTimeout(() => reject(new Error('не дошёл')), ms))
    ])
    return true
  } catch { try { bot.pathfinder.setGoal(null) } catch {} return false }
}

export const SWEEP = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]

// Верх столба (первая сверху не-воздушная клетка) около высоты yRef; null — чанк не прогружен.
const WET = /water|kelp|seagrass|bubble_column|lily_pad/
function surfaceTop (bot, x, z, yRef) {
  for (let y = Math.round(yRef) + 40; y >= Math.round(yRef) - 40; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)))
    if (!b) return null
    if (isAir(b)) continue
    return b
  }
  return null
}

// Доля воды по прямой от from до to (n точек; непрогруженные не в счёт).
export function wetShare (bot, from, to, n = 8) {
  let wet = 0; let seen = 0
  for (let k = 1; k <= n; k++) {
    const t = k / n
    const b = surfaceTop(bot, from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t, from.y)
    if (!b) continue
    seen++
    if (WET.test(b.name)) wet++
  }
  return seen ? wet / seen : 0
}

// Конец луча по направлению [dx, dz] от start: сушей. pn-pool 02.10 (сиды 5647…, 6162…, −4332…, −5289…): лучи вслепую
// уводили тело в океан, дальше каждый луч «не дошёл» и «в воде — без столба» (~25 с впустую). Конец в воде или путь по
// воде больше трети — короче (¾, ½), иначе направление пропустить. Непрогруженный конец — идти (вода не видна).
export function legTarget (bot, start, dir, step, here = null) {
  for (const f of [1, 0.75, 0.5]) {
    const to = { x: start.x + dir[0] * step * f, y: start.y, z: start.z + dir[1] * step * f }
    const top = surfaceTop(bot, to.x, to.z, start.y)
    if (top && WET.test(top.name)) continue
    if (wetShare(bot, start, to) > 0.34) continue
    if (here && wetShare(bot, here, to) > 0.34) continue
    return to
  }
  return null
}

// Подсказка из скана копии этого же мира (AGENTS.md: «знание карты из копии этого же мира — разрешено»):
// farm/seeds/good-v2.json, поле sky — ближайшая годная лава, видимая сверху (озеро или руины на поверхности, ≥ 10
// источников), farm/portal-scan/pool-merge.js; сида нет в пуле — скан farm/portal-scan/results-pool/<сид>.json (скан
// копии любого мира, например server-run). Только место, куда идти: лава засчитывается, когда её увидел глаз.
// skyOfScan — одно правило для pool-merge.js и для подсказки: тела классов surface и rp с глубиной ≤ 3, ≥ 10
// источников; тело < 20 источников — штраф 40 м (открытых сверху может не хватить на 10 наливов).
export function skyOfScan (r) {
  let sky = null
  for (const k of ['surface', 'rp']) {
    const e = r && r.byClass && r.byClass[k]
    if (!e) continue
    for (const c of [e.nearest10, e.fastest10]) {
      if (!c || c.depth > 3) continue
      const cost = c.near + (c.src < 20 ? 40 : 0)
      if (!sky || cost < sky.cost) sky = { d: c.near, cls: k, at: c.at, src: c.src, cost }
    }
  }
  if (sky) delete sky.cost
  return sky
}

// { scanned, hint }: scanned — сид есть в good-v2 со сканом или есть файл скана; hint — {x,y,z,kind,src,dist} или null.
export function poolInfo (seed, { file = null, dir = null }: any = {}) {
  const none = { scanned: false, hint: null }
  if (seed === undefined || seed === null || seed === '') return none
  if (!(require('../perception/knowledge') as typeof import('../perception/knowledge')).allows('lava', 'portal-natural.poolInfo')) return none // S10: в rsg скан не читается
  const path: typeof import('path') = require('path'); const fs: typeof import('fs') = require('fs')
  const toHint = sky => sky && Array.isArray(sky.at) ? { x: sky.at[0], y: sky.at[1], z: sky.at[2], kind: sky.cls, src: sky.src, dist: sky.d } : null
  try {
    const f = file || path.join(REPO_ROOT, 'farm/seeds/good-v2.json')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    const s = (j.seeds || []).find(x => String(x.seed) === String(seed))
    if (s && (s.sky !== undefined || (s.lava !== null && s.lava !== undefined))) return { scanned: true, hint: toHint(s.sky) }
  } catch {}
  try {
    const f = path.join(dir || path.join(REPO_ROOT, 'farm/portal-scan/results-pool'), `${seed}.json`)
    if (fs.existsSync(f)) return { scanned: true, hint: toHint(skyOfScan(JSON.parse(fs.readFileSync(f, 'utf8')))) }
  } catch {}
  return none
}
export function hintFor (seed, file?: any) { return poolInfo(seed, { file }).hint }

// Клетка на берегу у открытого источника того же тела лавы: пол твёрдый, ноги и голова — пусто, без жидкости. С неё
// черпак cast.js достаёт лаву (refillLava ищет источники в досягаемости от глаз).
// Тело ищется от любого открытого источника в кубе r у места: сама клетка site.at к этому времени часто вычерпана
// (pn-hint 02.10, сид 2911374257081450067: рама 9/10, озеро 57 открытых, пять заходов «лава кончилась» — тело от
// вычерпанной клетки пустое, к берегу не шёл). Слой снега под ногами — можно стоять (снежная тайга).
export function shoreSources (bot, at, { r = 12 }: any = {}) {
  const c = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
  const seen = new Set()
  const out = []
  const free = b => !!b && !/lava|water/.test(b.name) && (b.boundingBox === 'empty' || b.name === 'snow')
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = c.offset(dx, dy, dz)
        if (seen.has(`${p.x},${p.y},${p.z}`)) continue
        if (!isLavaSrc(bot.blockAt(p)) || !isAir(bot.blockAt(p.offset(0, 1, 0)))) continue
        const body = lavaBody(bot, p, seen, 600)
        for (const o of body.openCells) {
          // Берег вровень с гладью или на клетку выше (край чаши: LakeFeature — гладь ниже рельефа).
          for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
            const n = o.offset(ox, oy, oz)
            const feet = bot.blockAt(n); const head = bot.blockAt(n.offset(0, 1, 0)); const floor = bot.blockAt(n.offset(0, -1, 0))
            if (!free(feet) || !head || head.boundingBox !== 'empty' || /lava|water/.test(head.name)) continue
            if (!floor || floor.boundingBox !== 'block') continue
            out.push({ src: o, stand: n })
          }
        }
      }
    }
  }
  return out
}

export function edgeSpot (bot, at, opts?: any) {
  const me = bot.entity.position
  let best = null
  for (const x of shoreSources(bot, at, opts)) { const d = x.stand.distanceTo(me); if (!best || d < best.d) best = { at: x.stand, d } }
  return best && best.at
}

// Живые источники у берега для добора cast.js: refillLava ходит только к session.castPlan.lavaAt (12 источников,
// видимых при выборе места) и ±2 от них; когда они вычерпаны — «лава кончилась» при живом озере (pn-hint 02.10, сид
// 6162616963942616824: рама 4/10, 63 открытых источника, шесть заходов «к 231,68,349: дошёл, видно 0»; переход тела
// к берегу не помогал — cast.js сперва идёт к раме). Обновить список ближними к раме живыми источниками с берегом.
export function refreshCastLava (session, at, ref?) {
  const bot = session.bot
  const plan = session.castPlan
  if (!plan) return 0
  const o = ref || bot.entity.position
  const seen = new Set()
  const live = []
  for (const x of shoreSources(bot, at).sort((a, b) => a.src.distanceTo(o) - b.src.distanceTo(o))) {
    const k = `${x.src.x},${x.src.y},${x.src.z}`
    if (seen.has(k)) continue
    seen.add(k)
    live.push(xyz(x.src))
    if (live.length >= 12) break
  }
  if (!live.length) return 0
  plan.lavaAt = live
  try { session.journal.patch(st => { const pl = st.places && st.places[(require('../cast') as typeof import('../cast')).PLACE]; if (pl) pl.lavaAt = live }) } catch {}
  return live.length
}

// Трава и слой снега на месте рамы: у них нет коллизии, и pick.js (shapesOf: только boundingBox 'block' и паутина)
// их не видит — cast.js digVisible бросает «блок не виден прицелом», рама встаёт на «не выкопано 2: … short_grass»
// и «луч к грани … упирается в …» (pn-hint 02.10: снежная тайга 2911…, саванна 6162… — заходы по 0 с). Прицел
// клиента упирается в их контур (у травы 2..14 × 0..13/16, у снега — высота слоя): снять их самому, если луч из глаз к
// контуру не проходит через чужую коллизию раньше. Клетки — из trace/stopped литья.
const SOFT_PLANT = /^(short_grass|tall_grass|fern|large_fern|snow|dead_bush|bush|short_dry_grass|tall_dry_grass|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|.*_petals|leaf_litter|sweet_berry_bush|firefly_bush|sunflower|lilac|rose_bush|peony)$/
export function softCells (cast) {
  const out = []
  const text = [...(Array.isArray(cast && cast.trace) ? cast.trace.filter(t => /не выкопано/.test(t)) : []), String((cast && cast.stopped) || '')].join('; ')
  for (const m of text.matchAll(/(-?\d+),(-?\d+),(-?\d+)/g)) out.push(new Vec3(Number(m[1]), Number(m[2]), Number(m[3])))
  return out
}
export async function clearSoft (bot, ctl, cells) {
  const { blockOnRay, eyeOf }: typeof import('../pick') = require('../pick')
  let n = 0
  const done = new Set()
  for (const p of cells) {
    const key = `${p.x},${p.y},${p.z}`
    if (done.has(key) || ctl.aborted) continue
    done.add(key)
    const b = bot.blockAt(p)
    if (!b || !SOFT_PLANT.test(b.name)) continue
    let h = 13 / 16
    if (b.name === 'snow') { try { h = Number(b.getProperties().layers || 1) * 2 / 16 } catch { h = 2 / 16 } }
    const aimP = p.offset(0.5, Math.max(0.06, h / 2), 0.5)
    if (eyeOf(bot).distanceTo(aimP) > 4.3) await walkNear(bot, ctl, p, 2, 8000)
    const o = eyeOf(bot)
    const delta = aimP.minus(o)
    const len = delta.norm()
    if (len > 4.5) continue
    const hit = blockOnRay(bot, o, delta.scaled(1 / len), len)
    if (hit && !hit.pos.equals(p)) continue // чужая коллизия раньше контура — не видно
    try { await bot.lookAt(aimP, true); await bot.dig(b, 'ignore'); n++ } catch {}
  }
  return n
}

// Столб обзора: озеро лавы — чаша на 4 ниже рельефа (LakeFeature), руины — вровень с землёй; с земли их закрывает
// первый же бугор (смоук pn-smoke2: озеро в 27 бл. за подъёмом в 4 бл. от глаз не видно, руины видно только с 25 бл.).
// С высоты +10 взгляд идёт поверх рельефа до края прорисовки. Встать на столб своими блоками (build.towerUp),
// осмотреться, спуститься, копая свой столб (свои блоки вернутся в рюкзак).
// Верх кроны рядом (листва и стволы в радиусе r): столб должен поднять глаза над ней.
function canopyTop (bot, r = 6) {
  const me = bot.entity.position.floored()
  let top = me.y
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let y = me.y + 24; y > top; y--) {
        const b = bot.blockAt(new Vec3(me.x + dx, y, me.z + dz))
        if (b && /leaves|_log$/.test(b.name)) { top = y; break }
      }
    }
  }
  return top
}

export async function pillarLook (session, ctl, { height = 10, radius = 128 }: any = {}) {
  const bot = session.bot
  const { towerUp }: typeof import('../build') = require('../build')
  const { equipBestTool }: typeof import('../items') = require('../items')
  const y0 = bot.entity.position.floored().y
  // В лесу — выше кроны (глаза на +1.6 над её верхом), но не больше 20.
  height = Math.min(20, Math.max(height, canopyTop(bot) - y0 + 1))
  // В воде столб не растёт («не подпрыгнул» десять раз — pn-rand, берег океана): только осмотр.
  const feetB = bot.blockAt(bot.entity.position.floored())
  if (feetB && /water|lava/.test(feetB.name)) return { placed: 0, why: 'в воде — без столба', survey: survey(bot, { radius }) }
  const t = await towerUp(bot, ctl, height, { sneak: true })
  const s = survey(bot, { radius })
  // Вниз: копать блок под ногами, пока не на прежней высоте.
  for (let k = 0; k < height + 2 && !ctl.aborted; k++) {
    const feet = bot.entity.position.floored()
    if (feet.y <= y0) break
    const under = bot.blockAt(feet.offset(0, -1, 0))
    if (!under || under.boundingBox !== 'block') { await sleep(250); continue }
    try { await equipBestTool(bot, under); await bot.dig(under, true) } catch { break }
    await sleep(350)
  }
  return { placed: t.placed || 0, why: t.why || t.reason || null, survey: s }
}
