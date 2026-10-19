'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { withTimeout, towerUp } from '../build'
import { itemNamed, countItems, equipBestTool } from '../items'
import * as bp from '../blueprint'
import { EYE, REACH, AIR, FLUID, INTERACTIVE, YAW, V, HORIZ, sleep, k3, isSolid, isPassable, holds, isDone, eyeOf, centre, inReach, canStand } from './world'
import { scaffoldItem } from './estimate'
import { walk, waitLook, waitChange } from './reach'

// Куда кликать, по видам блоков (см. kindOf в blueprint.js). Вектор face — от
// опоры к клетке, cursor — точка клика внутри опоры.
function placeOptions (bot, c) {
  const opts = []
  const add = (dir, cursorY = null) => {
    const d = V[dir]
    const ref = bot.blockAt(c.pos.plus(d))
    if (!isSolid(ref)) return
    if ((c.kind === 'wall' || c.kind === 'floor' || c.kind === 'lantern') && !holds(c, ref)) return
    const face = d.scaled(-1)
    const cursor = new Vec3(0.5 + face.x * 0.5, cursorY ?? 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
    opts.push({ ref, face, cursor, dir, sneak: INTERACTIVE.test(ref.name) })
  }
  const props = c.props || {}
  switch (c.kind) {
    case 'wall': add(c.support); break
    case 'floor': case 'door': case 'bed': add('down'); break
    case 'lantern': add(c.support || 'down'); break
    case 'facer': add('down'); for (const h of HORIZ) add(h); add('up'); break
    case 'stairs': case 'slab': {
      const top = props.half === 'top' || props.type === 'top'
      if (top) { add('up'); for (const h of HORIZ) add(h, 0.75) } else { add('down'); for (const h of HORIZ) add(h, 0.25) }
      break
    }
    case 'pillar': {
      const axis = props.axis || 'y'
      const along = axis === 'y' ? ['down', 'up'] : axis === 'x' ? ['east', 'west'] : ['north', 'south']
      for (const d of along) add(d)
      for (const d of ['down', ...HORIZ, 'up']) if (!along.includes(d)) add(d)
      break
    }
    default:
      for (const d of ['down', ...HORIZ, 'up']) add(d)
  }
  const eye = eyeOf(bot)
  // Порядок вида важен (ступени: сначала грань, которая точно даёт нужную
  // половину), поэтому сортируем устойчиво и только по приседу и досягаемости.
  return opts
    .map((o, i) => ({ ...o, i, far: eye.distanceTo(o.ref.position.plus(o.cursor)) > REACH + 0.9 }))
    .filter(o => !o.far)
    .sort((a, b) => (a.sneak - b.sneak) || (a.i - b.i))
}

function yawFor (c) {
  const f = c.props && c.props.facing
  switch (c.kind) {
    case 'stairs': case 'door': case 'bed': return f ? YAW[f] : null
    case 'facer': return f ? YAW[bp.OPP[f]] : null
    case 'floor': return c.faces ? YAW[bp.OPP[c.faces]] : null
    default: return null
  }
}

// Одна постановка. Возвращает приговор миру, а не пакету.
async function putCell (bot, c, { onSign = null }: any = {}) {
  const opts = placeOptions(bot, c)
  if (!opts.length) return { ok: false, why: 'не к чему прислонить (или опора далеко)' }
  const stack = itemNamed(bot, c.item)
  if (!stack) return { ok: false, noItem: true, why: `нет ${c.item}` }
  if (!bot.heldItem || bot.heldItem.name !== c.item) {
    try { await bot.equip(stack, 'hand') } catch (e) { return { ok: false, why: e.message } }
  }
  const want = yawFor(c)
  let last = null
  for (const o of opts.slice(0, 3)) {
    const aim = o.ref.position.plus(o.cursor)
    const eye = eyeOf(bot)
    const dx = aim.x - eye.x; const dy = aim.y - eye.y; const dz = aim.z - eye.z
    const yaw = want ?? Math.atan2(-dx, -dz)
    const pitch = Math.atan2(dy, Math.hypot(dx, dz))
    await bot.look(yaw, pitch, true)
    await waitLook(bot)
    const before = (bot.blockAt(c.pos) || {}).name
    if (o.sneak) { bot.setControlState('sneak', true); await sleep(100) }
    const signOpen = onSign ? onSign() : null
    try {
      await bot._genericPlace(o.ref, o.face, { forceLook: 'ignore', delta: o.cursor, swingArm: 'right' })
    } catch (e) { last = e.message }
    const got = await waitChange(bot, c.pos, before, 1200)
    if (o.sneak) { await sleep(60); bot.setControlState('sneak', false) }
    if (got && !AIR.has(got.name)) return { ok: true, name: got.name, match: isDone(bot, c), signOpen }
    if (signOpen && signOpen.cancel) signOpen.cancel()
    last = last || `сервер не поставил (клик в ${o.ref.name} ${o.dir})`
    const e = bot.entity.position
    console.log(`[build] мимо ${c.key} ${c.name}: в руке ${bot.heldItem && bot.heldItem.name}, клик ${o.ref.name}@${k3(o.ref.position)} грань ${o.dir}` +
      ` курсор ${o.cursor.x},${o.cursor.y},${o.cursor.z} yaw ${yaw.toFixed(2)} я ${e.x.toFixed(2)},${e.y.toFixed(2)},${e.z.toFixed(2)}` +
      ` клетка ${(bot.blockAt(c.pos) || {}).name} над ней ${(bot.blockAt(c.pos.offset(0, 1, 0)) || {}).name}`)
  }
  return { ok: false, why: last }
}

async function digAt (bot, pos, { timeoutMs = 15000 }: any = {}) {
  const b = bot.blockAt(pos)
  if (!b || AIR.has(b.name)) return { ok: true, already: true }
  if (FLUID.test(b.name)) return { ok: false, hard: true, why: `в клетке ${b.name}` }
  if (b.name === 'bedrock' || b.hardness === null || b.hardness < 0) return { ok: false, hard: true, why: `${b.name} не ломается` }
  for (const dir of ['up', ...HORIZ, 'down']) {
    const n = bot.blockAt(pos.plus(V[dir]))
    if (n && /lava/.test(n.name)) return { ok: false, hard: true, why: `за ${b.name} лава (${n.position.x},${n.position.y},${n.position.z}) — не вскрываю` }
  }
  try {
    await equipBestTool(bot, b)
    await withTimeout(bot.dig(b, true), timeoutMs, `${b.name} не ломается`)
    return { ok: true, name: b.name }
  } catch (e) {
    const now = bot.blockAt(pos)
    if (now && AIR.has(now.name)) return { ok: true, name: b.name }
    return { ok: false, why: e.message }
  }
}

// ---------------------------------------------------------------- scaffold

function onTower (bot, t) {
  const f = bot.entity.position.floored()
  return f.x === t.x && f.z === t.z && f.y > t.base
}

async function towerFor (bot, ctl, c, ctx) {
  const item = scaffoldItem(bot, ctx.planNeeds)
  if (!item) return { ok: false, why: 'лесам нечем: ни земли, ни булыжника, ни досок' }
  const T = centre(c.pos)
  const me = bot.entity.position
  const cands = []
  let unreachable = 0
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      const x = c.pos.x + dx; const z = c.pos.z + dz
      let g = null
      for (let y = c.pos.y - 1; y >= c.pos.y - 14; y--) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (!b || FLUID.test(b.name)) break
        if (isSolid(b)) { g = y; break }
      }
      if (g === null) continue
      const base = g + 1
      let top = null
      for (let y = base + 1; y <= c.pos.y + 1; y++) {
        if (new Vec3(x + 0.5, y + EYE, z + 0.5).distanceTo(T) <= REACH - 0.4) { top = y; break }
      }
      if (top === null) continue
      let ok = true
      for (let y = base; y <= top + 1 && ok; y++) {
        const p = new Vec3(x, y, z)
        if (!isPassable(bot.blockAt(p)) || ctx.pendingSolid.has(k3(p)) || p.equals(c.pos)) ok = false
      }
      if (!ok || !canStand(bot, new Vec3(x, base, z))) continue
      if (ctx.reach && !ctx.reach.has(`${x},${base},${z}`) && !(me.floored().x === x && me.floored().z === z)) { unreachable++; continue }
      const h = top - base
      if (h > 12 || (countItems(bot)[item] || 0) < h) continue
      const inside = x > ctx.box.x1 && x < ctx.box.x2 && z > ctx.box.z1 && z < ctx.box.z2
      cands.push({ x, z, base, top, h, score: h * 2 + Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) - (inside ? 2 : 0) })
    }
  }
  cands.sort((a, b) => a.score - b.score)
  if (!cands.length) console.log(`[build] лесов под ${c.key} нет: столбов не дойти ${unreachable}, досягаемо всего ${ctx.reach ? ctx.reach.size : '-'}`)
  for (const s of cands.slice(0, 3)) {
    if (ctl.aborted) break
    const here = bot.entity.position.floored()
    if (!(here.x === s.x && here.z === s.z && here.y === s.base)) {
      await walk(bot, new goals.GoalBlock(s.x, s.base, s.z), 12000)
      const now = bot.entity.position.floored()
      if (!(now.x === s.x && now.z === s.z && now.y === s.base)) continue
    }
    const tower = { x: s.x, z: s.z, base: s.base, top: s.base, item }
    ctx.towers.push(tower)
    ctx.saveTowers()
    const r = await towerUp(bot, ctl, s.h, { sneak: true, item })
    tower.top = s.base + r.placed
    ctx.saveTowers()
    ctx.stats.scaffold += r.placed
    const e = bot.entity.position
    console.log(`[build] леса ${s.x},${s.base},${s.z} +${s.h} под ${c.key}: встало ${r.placed}${r.why ? ` (${r.why.join('; ')})` : ''}, я ${e.x.toFixed(1)},${e.y.toFixed(1)},${e.z.toFixed(1)}, достаю ${inReach(bot, c)}`)
    if (r.placed && inReach(bot, c)) return { ok: true, tower }
    await descend(bot, tower, ctx)
  }
  return { ok: false, why: 'не нашёл, где поставить леса' }
}

// Разобрать свой столб, стоя на нём: копать блок под ногами, падать на следующий.
async function descend (bot, tower, ctx) {
  for (let i = 0; i < 40; i++) {
    const feet = bot.entity.position.floored()
    if (feet.y <= tower.base) break
    const below = bot.blockAt(feet.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') { await sleep(200); continue }
    if (below.position.x !== tower.x || below.position.z !== tower.z || below.position.y < tower.base) break
    try {
      await equipBestTool(bot, below)
      await withTimeout(bot.dig(below, true), 8000, 'леса не ломаются')
    } catch { break }
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && bot.entity.position.y > below.position.y + 0.05) await sleep(50)
  }
  await sweepTower(bot, tower, ctx)
}

// Что от столба осталось (тело слетело с него, или обрыв) — снять в досягаемости.
async function sweepTower (bot, tower, ctx) {
  let left = 0
  for (let y = tower.base; y <= tower.top; y++) {
    const p = new Vec3(tower.x, y, tower.z)
    const b = bot.blockAt(p)
    if (!b || b.name !== tower.item) continue
    if (ctx.byKey.has(k3(p))) continue // клетка плана — не наши леса
    if (eyeOf(bot).distanceTo(centre(p)) > REACH) { left++; continue }
    const r = await digAt(bot, p, { timeoutMs: 8000 })
    if (!r.ok) left++
  }
  if (!left) {
    const i = ctx.towers.indexOf(tower)
    if (i >= 0) ctx.towers.splice(i, 1)
    ctx.saveTowers()
  }
  return left
}

export { placeOptions, putCell, digAt, onTower, towerFor, descend, sweepTower }
