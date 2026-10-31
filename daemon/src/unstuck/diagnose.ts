'use strict'
// Застревание: включение, клетки (твёрдое, жидкость), направление, диагноз и лестница ступеней по диагнозу.
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// По умолчанию включено с 03.10.2026 ~01:55 МСК после замеров (research/dev-H-unstuck.md): стенды по случаям — kelp 0/10 → 9/10,
// lavapit0 0/10 → 10/10, pond 4/10 → 10/10 (−48 % времени); MLG 24/24, стенд mv-gap и рельеф — без регресса.
// ND_UNSTUCK=0 — откат (прежний goto).
export const DEFAULT_ON = true
export function on (override?) {
  if (typeof override === 'boolean') return override
  const v = process.env.ND_UNSTUCK
  if (v === '1') return true
  if (v === '0') return false
  return DEFAULT_ON
}

export const sleepReal = ms => new Promise<any>(resolve => gameClock.setTimeout(resolve, ms))

// ------------------------------------------------------------------ блоки
export const solid = b => !!b && b.boundingBox === 'block'
export const liquid = b => !!b && /^(water|lava|bubble_column|flowing_water|flowing_lava)$/.test(b.name)
export const lavaB = b => !!b && /lava/.test(b.name)
export const waterB = b => !!b && /^(water|bubble_column|flowing_water)$/.test(b.name)
// Пол и заросли, на которых pathfinder и физика расходятся (журналы: kelp, seagrass, mud, mangrove_roots, moss_carpet,
// vine, leaves, warped_wart_block, snow, soul_sand, powder_snow, leaf_litter).
export const SOFT = /leaves|^snow$|powder_snow|soul_sand|soul_soil|^mud$|mangrove_roots|moss_carpet|_carpet$|vine|ladder|scaffolding|honey_block|cobweb|sweet_berry|kelp|seagrass|lily_pad|pointed_dripstone|azalea|bamboo|sugar_cane|leaf_litter|short_grass|tall_grass|^fern$|large_fern|_roots$|nether_sprouts|wart_block|shroomlight|_fungus$|dripleaf/
// Без коллизии, но мешают ходу и берутся прицелом (контур — полный куб): рыхлый снег (тело тонет и мёрзнет), паутина,
// куст ягод, водоросли, лианы. Их и ломаем, хоть они и «не твёрдые».
export const IMPEDE = /^(powder_snow|cobweb|sweet_berry_bush|kelp|kelp_plant|seagrass|tall_seagrass|vine|weeping_vines|weeping_vines_plant|twisting_vines|twisting_vines_plant)$/
// Водные растения: клетка и после них вода — ломать можно, хоть вода и рядом.
export const AQUATIC = /^(kelp|kelp_plant|seagrass|tall_seagrass|sea_pickle)$/
// Не ломать: служебное, чужие постройки-вещи, лестницы/леса (по ним лезут), золото (пиглины в Аду злятся — BlockGoldGuard).
export const UNBREAKABLE = /^(ladder|scaffolding|gold_block|gilded_blackstone|nether_gold_ore|gold_ore|deepslate_gold_ore|raw_gold_block|bedrock|barrier|end_portal_frame|end_portal|nether_portal|command_block|structure_block|reinforced_deepslate|spawner|chest|trapped_chest|barrel|ender_chest|furnace|crafting_table|.*_bed|.*shulker_box)$/

export const DIRS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

export function at (bot, p) { try { return bot.blockAt(p) } catch { return null } }

// Пересекает ли блок коробку текущей позы: стоя — 1.8 м, на элитрах — 0.6 м.
export function overlapsBody (bot, b) {
  if (!solid(b) || !bot.entity) return false
  const p = bot.entity.position
  const { h } = (require('../pick') as typeof import('../pick')).hitboxOf(bot, bot.entity)
  const lo = { x: p.x - 0.29, y: p.y + 0.05, z: p.z - 0.29 }
  const hi = { x: p.x + 0.29, y: p.y + h - .05, z: p.z + 0.29 }
  const shapes = b.shapes ?? [[0, 0, 0, 1, 1, 1]]
  for (const s of shapes) {
    const x0 = b.position.x + s[0]; const y0 = b.position.y + s[1]; const z0 = b.position.z + s[2]
    const x1 = b.position.x + s[3]; const y1 = b.position.y + s[4]; const z1 = b.position.z + s[5]
    if (x0 < hi.x && x1 > lo.x && y0 < hi.y && y1 > lo.y && z0 < hi.z && z1 > lo.z) return true
  }
  return false
}

// Куда тело хочет: следующий узел пути (если он не под ногами) или цель goto.
export function towardOf (bot, goal, nodes) {
  const p = bot.entity.position
  if (Array.isArray(nodes)) {
    for (const n of nodes.slice(0, 4)) {
      if (n && (Math.abs(n.x + 0.5 - p.x) > 0.8 || Math.abs(n.z + 0.5 - p.z) > 0.8 || Math.abs(n.y - p.y) > 0.8)) return new Vec3(n.x + 0.5, n.y, n.z + 0.5)
    }
  }
  if (goal && typeof goal.x === 'number' && typeof goal.z === 'number') return new Vec3(goal.x + 0.5, typeof goal.y === 'number' ? goal.y : p.y, goal.z + 0.5)
  return null
}

// Горизонтальное направление к цели по большей оси (шаг в соседнюю клетку).
export function axisTo (bot, toward) {
  if (!toward) return null
  const p = bot.entity.position
  const dx = toward.x - p.x; const dz = toward.z - p.z
  if (Math.abs(dx) < 0.3 && Math.abs(dz) < 0.3) return null
  return Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
}

// ------------------------------------------------------------------ диагноз
export function diagnose (bot, toward = null) {
  const e = bot.entity
  const p = e.position
  const feet = p.floored()
  const fb = at(bot, feet); const hb = at(bot, feet.offset(0, 1, 0)); const gb = at(bot, feet.offset(0, -1, 0)); const ab = at(bot, feet.offset(0, 2, 0))
  const f: any = {
    pos: { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, z: Math.round(p.z * 100) / 100 },
    feet: fb ? fb.name : '?', head: hb ? hb.name : '?', ground: gb ? gb.name : '?', above: ab ? ab.name : '?',
    onGround: !!e.onGround
  }
  try { f.digFlag = !!(bot.pathfinder && typeof bot.pathfinder.isMining === 'function' && bot.pathfinder.isMining() && !bot.targetDigBlock) } catch { f.digFlag = false }
  f.buried = overlapsBody(bot, hb) || overlapsBody(bot, fb) || [fb, hb].some(b => b && /^(powder_snow|cobweb)$/.test(b.name))
  f.water = !!e.isInWater || waterB(fb) || waterB(hb) || !!(fb && fb.getProperties && (fb.getProperties() || {}).waterlogged)
  f.lava = !!e.isInLava || lavaB(fb) || lavaB(hb)
  let blocked = 0
  const open = []
  for (const d of DIRS) {
    const s = at(bot, feet.plus(d)); const s2 = at(bot, feet.plus(d).offset(0, 1, 0))
    if (solid(s) || solid(s2)) blocked++
    else open.push(d)
  }
  f.blockedSides = blocked
  f.enclosed = blocked === 4
  f.roof = solid(ab)
  f.roofLiquid = liquid(ab) || (solid(ab) && liquid(at(bot, feet.offset(0, 3, 0))))
  const dir = axisTo(bot, toward)
  if (dir) {
    const front = feet.plus(dir)
    const ff = at(bot, front); const fh = at(bot, front.offset(0, 1, 0)); const fa = at(bot, front.offset(0, 2, 0))
    f.dir = { x: dir.x, z: dir.z }
    f.front = [ff ? ff.name : '?', fh ? fh.name : '?', fa ? fa.name : '?']
    f.wallAhead = solid(ff) || solid(fh)
    f.highWall = solid(ff) && solid(fh)
    f.softAhead = (ff && SOFT.test(ff.name)) || (fh && SOFT.test(fh.name))
  }
  f.soft = [fb, hb, gb].some(b => b && SOFT.test(b.name)) || !!f.softAhead
  f.cls = f.digFlag ? 'dig-flag' : f.buried ? 'buried' : f.lava ? 'lava' : f.water ? 'water' : f.enclosed ? 'enclosed' : f.wallAhead ? 'wall' : f.soft ? 'soft' : 'open'
  return f
}

// ------------------------------------------------------------------ лестница
// Ступени по классу; 'refused' — поиск отказал (пусто/нет пути/таймаут), тело не застревало физически.
export const LADDERS = {
  'dig-flag': ['clearDig', 'replan', 'backJump', 'breakAhead', 'bypass'],
  buried: ['digOut', 'backJump', 'replan', 'climbOut'],
  lava: ['swimOutLava', 'backJump', 'replan'],
  water: ['swimOut', 'notch', 'stepUp', 'swimOut2', 'breakAhead', 'backJump', 'replan', 'bypass'],
  enclosed: ['replan', 'breakAhead', 'climbOut', 'stepUp', 'breakAhead2', 'bypass'],
  wall: ['backJump', 'breakAhead', 'stepUp', 'replan', 'bypass', 'breakAhead2'],
  soft: ['backJump', 'breakAhead', 'replan', 'waypoint', 'stepUp', 'bypass'],
  open: ['replan', 'backJump', 'waypoint', 'breakAhead', 'stepUp', 'bypass', 'climbOut']
}
export const REFUSED = {
  'dig-flag': ['clearDig', 'replan'],
  buried: ['digOut', 'replan'],
  lava: ['swimOutLava', 'replan'],
  water: ['swimOut', 'notch', 'stepUp', 'swimOut2', 'breakAhead', 'bypass'],
  enclosed: ['bypass', 'breakAhead', 'climbOut', 'breakAhead2', 'stepUp'],
  wall: ['bypass', 'breakAhead', 'stepUp', 'breakAhead2'],
  soft: ['waypoint', 'bypass', 'breakAhead', 'backJump'],
  open: ['waypoint', 'bypass', 'breakAhead', 'stepUp']
}
export function ladder (cls, kind = 'still', status = null) {
  const table = kind === 'refused' ? REFUSED : LADDERS
  const out = (table[cls] || table.open).slice()
  // A* не уложился в 5 с (дальняя цель, лавовые озёра Ада): сначала промежуточная цель ближе — её поиск короче.
  if (status === 'timeout') { const i = out.indexOf('waypoint'); if (i >= 0) out.splice(i, 1); out.unshift('waypoint') }
  return out
}
