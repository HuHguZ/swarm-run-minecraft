'use strict'
// Страж Ада (ne-guard.ts): укрытия — столб, яма, коробка из своих блоков.
import { sleep } from '../movement'
import * as gameClock from '../game-clock'
import { meleeFoes } from './foes'

// Высота столба: проба 03.10 (2 брута) — с +2 брут достаёт (удары по ногам на y+2.00 от брута на y+0.00), берём +3.
export function pillarHeight () { return Math.max(process.env.ND_BRUTE_GUARD === '1' ? 4 : 2, Math.min(4, Number(process.env.ND_GUARD_PILLAR || 3))) }
// Столб на месте встаёт: над головой PH+1 воздуха, блоков хватает, и только на открытом (хотя бы 2 стороны у ног —
// воздух): из ямы бартера столб выводил к бруту у её рта (B1-3 03.10: брут во рту ямы бил сверху, +2 — достаёт).
export function pillarFits (bot) {
  if (!bot.entity) return false
  const PH = pillarHeight()
  if (guardCount(bot) < PH) return false
  const f0 = bot.entity.position.floored()
  const air = v => { const b = bot.blockAt(v); return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
  for (let k = 2; k <= PH + 1; k++) if (!air(f0.offset(0, k, 0))) return false
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => air(f0.offset(dx, 0, dz))).length >= 2
}
// Тело вне их рук: выше всех ближних на 2.5+ (свой столб) или ниже на 2+ (своя нора: рамка атаки ходячего не опускается ниже
// его ног — Mob.getAttackBoundingBox раздувает только по горизонтали).
export function above (bot, foes) {
  const y = bot.entity.position.y
  return foes.length > 0 && foes.every((f: any) => {
    const brute = process.env.ND_BRUTE_GUARD === '1' && f.name === 'piglin_brute'
    // A higher enemy can walk or fall down. Only an actual sealed pocket keeps it above us (s15, 21.10).
    // 1.95 body + 1.252 jump reaches above a three-block pillar; four is the flat-ground reserve.
    return y - f.position.y >= (brute ? 4 : 2.5) || f.position.y - y >= 2 && (!brute || sealedAt(bot, bot.entity.position.floored()))
  })
}
// Нора на месте копается: толща на 2 вниз, пол и стенки твёрдые, под полом не лава, и есть кирка.
export function holeFits (bot) {
  if (!bot.entity || process.env.ND_GUARD_HOLE === '0') return false
  if (!bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) return false
  return holeOk(bot, bot.entity.position.floored(), 2)
}

function sealOn () { return process.env.ND_GUARD_SEAL !== '0' }
function cls (bot, v) { return (require('../sealed') as typeof import('../sealed')).classOf(bot.blockAt(v)) }
// Клетка — толща (твёрдое: можно копать и стоять, не руда-охрана, не гравий).
function solidish (k, SL) { return k === SL.SOLID || k === SL.HOT }
function wallOk (k, SL) { return k === SL.SOLID || k === SL.HARD || k === SL.GUARD || k === SL.HOT }
// Можно ли уйти вниз на n клеток из клетки ног f: клетки f−1..f−n — копаемая толща, пол под ними твёрдый, стенки у
// клеток f−1..f−n — твёрдые (не воздух — пещера, не лава), под полом не лава.
export function holeOk (bot, f, n) {
  const SL: typeof import('../sealed') = require('../sealed')
  for (let i = 1; i <= n; i++) {
    const v = f.offset(0, -i, 0)
    if (!solidish(cls(bot, v), SL)) return false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!wallOk(cls(bot, v.offset(dx, 0, dz)), SL)) return false
  }
  const fl = cls(bot, f.offset(0, -n - 1, 0))
  if (!(fl === SL.SOLID || fl === SL.HARD || fl === SL.GUARD || fl === SL.HOT)) return false
  if (cls(bot, f.offset(0, -n - 2, 0)) === SL.FLUID) return false
  return true
}

// «Вниз на 2» (+ третья и пробка, если можно). { ok, depth, capped, cells: ['x,y,z' …] }.
export async function hideDown (session, ctl) {
  const bot = session.bot
  const SL: typeof import('../sealed') = require('../sealed')
  for (let i = 0; i < 6 && !bot.entity.onGround; i++) await sleep(50)
  if (!bot.entity.onGround) return { ok: false, why: 'не на земле' }
  const p = bot.entity.position
  const f = p.floored()
  // Стоит на неполном блоке (плита) — клетка ног выше пола: так не копаем.
  if (p.y - f.y > 0.05) return { ok: false, why: 'не на полном блоке' }
  if (!holeOk(bot, f, 2)) return { ok: false, why: 'под ногами не толща' }
  try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const cells = []
  const t0 = gameClock.now()
  const ms = []
  for (let i = 1; i <= 2; i++) {
    const v = f.offset(0, -i, 0)
    const r = await SL.digCell(bot, v)
    ms.push(gameClock.now() - t0)
    // Глубина 1 — не нора: тело торчит на 0.8 в рамку удара (ревью Codex q7).
    if (r !== 'ok' && r !== 'air') return { ok: false, depth: i - 1, why: 'копка: ' + r, cells, ms }
    cells.push(SL.keyV(v))
    const ok = await SL.stepMove(bot, ctl, { kind: 'vdown', to: { x: v.x, y: v.y, z: v.z } })
    ms.push(gameClock.now() - t0)
    if (!ok) return { ok: false, depth: i - 1, why: 'не опустился', cells, ms }
  }
  // Третья копка и пробка над головой (от арбалета и огня): клетка f−3 — толща, пол под ней твёрдый.
  let capped = false
  let depth = 2
  if (SL.fillerCount(bot) >= 1 && holeOk(bot, f.offset(0, -2, 0), 1)) {
    const v = f.offset(0, -3, 0)
    const r = await SL.digCell(bot, v)
    if (r === 'ok' || r === 'air') {
      cells.push(SL.keyV(v))
      if (await SL.stepMove(bot, ctl, { kind: 'vdown', to: { x: v.x, y: v.y, z: v.z } })) {
        depth = 3
        capped = await SL.fillCell(bot, f.offset(0, -1, 0))
        if (capped) cells.splice(cells.indexOf(SL.keyV(f.offset(0, -1, 0))), 1)
      }
    }
  }
  ms.push(gameClock.now() - t0)
  return { ok: true, depth, capped, cells, ms }
}

const EXTRA_FILL = ['crying_obsidian', 'nether_bricks', 'red_nether_bricks', 'gilded_blackstone', 'chiseled_polished_blackstone', 'polished_blackstone_brick_stairs', 'soul_soil', 'magma_block', 'end_stone', 'obsidian']
export function guardItem (bot) {
  const SL: typeof import('../sealed') = require('../sealed')
  const n = SL.fillerName(bot)
  if (n) return n
  const items = bot.inventory.items()
  for (const name of EXTRA_FILL) {
    const c = items.filter(i => i.name === name).reduce((k, i) => k + i.count, 0)
    if (name === 'obsidian' ? c > 10 : c > 0) return name
  }
  return null
}
export function guardCount (bot) {
  const SL: typeof import('../sealed') = require('../sealed')
  const items = bot.inventory.items()
  let k = SL.fillerCount(bot)
  for (const name of EXTRA_FILL) { const c = items.filter(i => i.name === name).reduce((m, i) => m + i.count, 0); k += name === 'obsidian' ? Math.max(0, c - 10) : c }
  return k
}
async function guardFill (bot, v) {
  const SL: typeof import('../sealed') = require('../sealed')
  const b = bot.blockAt(v)
  if (b && SL.classOf(b) !== SL.AIR && SL.classOf(b) !== SL.PARTIAL) return sealOn() ? fullWall(b) : true
  const item = guardItem(bot)
  if (!item) return false
  try { const r = await (require('../build') as typeof import('../build')).placeBlockAt(bot, v, { item, timeoutMs: 1500, honest: process.env.ND_BRUTE_GUARD === '1' }); return !!(r && r.ok) } catch { return false }
}

// Коробка вокруг тела: блоки в открытые клетки у ног и головы (4 стороны) и над головой, ближние к врагу — первыми.
// Клетка, где стоит сущность, — не заложить (ok:false, если открытой осталась). { ok, placed, left }.
function fullWall (b) {
  return !!b && b.boundingBox === 'block' && !/lava|water|fire/.test(b.name || '') &&
    Array.isArray(b.shapes) && b.shapes.some(a => a.length === 6 && a.every((n, i) => n === (i < 3 ? 0 : 1)))
}
function shellCells (f) {
  const cells = []
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = 0; y <= 2; y++) {
    if (x || z || y === 2) cells.push(f.offset(x, y, z))
  }
  return cells
}
type InteriorHostile = { id: number, position: { x: number, y: number, z: number }, width?: number, height?: number }
function interiorHostiles (bot, f): InteriorHostile[] {
  return (meleeFoes(bot, 6) as InteriorHostile[]).filter(e => {
    const half = (e.width || .6) / 2
    if (e.position.x + half <= f.x || e.position.x - half >= f.x + 1 ||
      e.position.z + half <= f.z || e.position.z - half >= f.z + 1 ||
      e.position.y >= f.y + 2 || e.position.y + (e.height || 1.8) <= f.y) return false
    try { return !!(require('../pick') as typeof import('../pick')).aim(bot, e, { range: 6 })?.point } catch { return false }
  })
}
function sealedAt (bot, f) {
  const p = bot.entity.position; const half = (bot.entity.width || 0.6) / 2
  // Knockback can put the body into a neighbouring cell while placements still
  // finish around the old cell. A shell around that cell is no longer cover.
  return p.y >= f.y && p.y + (bot.entity.height || 1.8) <= f.y + 2 &&
    p.x - half >= f.x && p.x + half <= f.x + 1 && p.z - half >= f.z && p.z + half <= f.z + 1 &&
    shellCells(f).every(v => fullWall(bot.blockAt(v))) && interiorHostiles(bot, f).length === 0
}
// Итог коробки: placed — поставлено, left — незакрытые клетки, pressure/interior — внутри стоит моб, why — отказ.
interface BoxResult { ok: boolean; placed?: number; left?: string[]; why?: string; cancelled?: boolean; pressure?: boolean; interior?: number[] }
export async function boxIn (bot, foe = null, { diag = false, ctl = null }: any = {}): Promise<BoxResult> {
  const SL: typeof import('../sealed') = require('../sealed')
  const cancelled = () => ctl?.aborted || bot._ndGuard?.ended || (bot.health ?? 20) <= 0
  if (cancelled()) return { ok: false, placed: 0, cancelled: true }
  if (guardCount(bot) < 2) return { ok: false, why: 'нечем' }
  const f = bot.entity.position.floored()
  const interiorPressure = placed => {
    const occupants = interiorHostiles(bot, f)
    return occupants.length ? { ok: false, placed, left: [SL.keyV(f)], pressure: true, interior: occupants.map(e => e.id) } : null
  }
  const initialPressure = interiorPressure(0)
  if (initialPressure) return initialPressure
  const cells = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) cells.push(f.offset(dx, dy, dz))
  cells.push(f.offset(0, 2, 0))
  if (diag) for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const dy of [0, 1]) cells.push(f.offset(dx, dy, dz))
  if (sealOn()) cells.splice(0, cells.length, ...shellCells(f))
  const open = v => { const b = bot.blockAt(v); return !!b && (SL.classOf(b) === SL.AIR || SL.classOf(b) === SL.PARTIAL || SL.classOf(b) === SL.FLUID) }
  const occupied = v => Object.values(bot.entities || {}).some((e : any) => e && e !== bot.entity && e.position && e.isValid !== false && e.name !== 'item' &&
    Math.abs(e.position.x - (v.x + 0.5)) < 0.5 + (e.width || 0.6) / 2 && Math.abs(e.position.z - (v.z + 0.5)) < 0.5 + (e.width || 0.6) / 2 &&
    e.position.y < v.y + 1 && e.position.y + (e.height || 1.8) > v.y)
  const todo = cells.filter(open).sort((a, b) => foe ? a.distanceTo(foe.position) - b.distanceTo(foe.position) : 0)
  if (sealOn() && todo.some(occupied)) return { ok: false, placed: 0, left: todo.filter(occupied).map(SL.keyV), pressure: true }
  // Сперва уровень ног (опора для уровня головы), ближние к врагу.
  todo.sort((a, b) => (a.y - b.y) || (foe ? a.distanceTo(foe.position) - b.distanceTo(foe.position) : 0))
  let placed = 0
  const left = []
  for (const v of todo) {
    if (cancelled()) return { ok: false, placed, left, cancelled: true }
    const pressure = interiorPressure(placed)
    if (pressure) return pressure
    if (occupied(v)) { left.push(SL.keyV(v)); continue }
    if (await guardFill(bot, v)) placed++; else left.push(SL.keyV(v))
  }
  if (cancelled()) return { ok: false, placed, left, cancelled: true }
  const finalPressure = interiorPressure(placed)
  if (finalPressure) return finalPressure
  if (sealOn()) {
    for (const v of cells) if (!fullWall(bot.blockAt(v)) && !left.includes(SL.keyV(v))) left.push(SL.keyV(v))
    return { ok: left.length === 0 && sealedAt(bot, f), placed, left }
  }
  return { ok: left.length === 0, placed, left }
}
