'use strict'
const gameClock = require('./game-clock')
// Общий выход из застреваний (поток unstuck, 02.10.2026; журнал research/dev-H-unstuck.md, разбор research/stuck-cases.md).
//
// До этого выход был разбросан по модулям: stuckGuard (8 с без сдвига → отказ), unstick (рывок назад с прыжком),
// escapePit (столб из своей шахты), escapeWater, свои «не шагнул» в штреке, бастионе, запечатке. На ферме (683 журнала
// кампаний, 219 ч) это ~20 ч потерь: тело стоит у стены, в воде, в яме под лавой, на листве — и goto зовут снова и снова
// тем же планом (до 6801 раза в одной точке, neF-S26-1).
//
// Здесь одно на всех:
//   детектор — цель движения активна, а тело за stillMs не сдвинулось (или за progressMs не приблизилось, топчась на
//              месте), или один и тот же отказ поиска повторяется в той же точке;
//   диагноз — класс ситуации по блокам вокруг тела: флаг копки, завалило, вода, замкнутая яма, стена, мягкий пол, открыто;
//   лестница — ступени выхода по классу: перестроить путь → шаг назад и прыжок → снести видимый блок к цели →
//              вылезти/выкопаться → ступенька/столб → обход блоками (мост и спуск blockmoves) → отказ с классом и местом.
// Честность: ломаем и ставим только то, что видит прицел (pick.blockOnRay / faceAim), как клиент; жидкость за блоком не
// вскрываем; пол под собой не копаем.
//
// Подключение — крючки: movement.gotoGoal(bot, goal, { unstuck }) и session.goto (watch на весь переход).
// Флаг ND_UNSTUCK: по умолчанию вкл., '0' — выкл.; goto { unstuck: true|false } — поверх флага (сцены A/B на одном демоне).
const Vec3 = require('vec3')

// По умолчанию включено с 03.10.2026 ~01:55 МСК после замеров (research/dev-H-unstuck.md): стенды по случаям — kelp 0/10 → 9/10,
// lavapit0 0/10 → 10/10, pond 4/10 → 10/10 (−48 % времени); MLG 24/24, стенд mv-gap и рельеф — без регресса.
// ND_UNSTUCK=0 — откат (прежний goto).
const DEFAULT_ON = true
function on (override) {
  if (typeof override === 'boolean') return override
  const v = process.env.ND_UNSTUCK
  if (v === '1') return true
  if (v === '0') return false
  return DEFAULT_ON
}

const sleepReal = ms => new Promise(resolve => gameClock.setTimeout(resolve, ms))

// ------------------------------------------------------------------ блоки
const solid = b => !!b && b.boundingBox === 'block'
const liquid = b => !!b && /^(water|lava|bubble_column|flowing_water|flowing_lava)$/.test(b.name)
const lavaB = b => !!b && /lava/.test(b.name)
const waterB = b => !!b && /^(water|bubble_column|flowing_water)$/.test(b.name)
// Пол и заросли, на которых pathfinder и физика расходятся (журналы: kelp, seagrass, mud, mangrove_roots, moss_carpet,
// vine, leaves, warped_wart_block, snow, soul_sand, powder_snow, leaf_litter).
const SOFT = /leaves|^snow$|powder_snow|soul_sand|soul_soil|^mud$|mangrove_roots|moss_carpet|_carpet$|vine|ladder|scaffolding|honey_block|cobweb|sweet_berry|kelp|seagrass|lily_pad|pointed_dripstone|azalea|bamboo|sugar_cane|leaf_litter|short_grass|tall_grass|^fern$|large_fern|_roots$|nether_sprouts|wart_block|shroomlight|_fungus$|dripleaf/
// Без коллизии, но мешают ходу и берутся прицелом (контур — полный куб): рыхлый снег (тело тонет и мёрзнет), паутина,
// куст ягод, водоросли, лианы. Их и ломаем, хоть они и «не твёрдые».
const IMPEDE = /^(powder_snow|cobweb|sweet_berry_bush|kelp|kelp_plant|seagrass|tall_seagrass|vine|weeping_vines|weeping_vines_plant|twisting_vines|twisting_vines_plant)$/
// Водные растения: клетка и после них вода — ломать можно, хоть вода и рядом.
const AQUATIC = /^(kelp|kelp_plant|seagrass|tall_seagrass|sea_pickle)$/
// Не ломать: служебное, чужие постройки-вещи, лестницы/леса (по ним лезут), золото (пиглины в Аду злятся — BlockGoldGuard).
const UNBREAKABLE = /^(ladder|scaffolding|gold_block|gilded_blackstone|nether_gold_ore|gold_ore|deepslate_gold_ore|raw_gold_block|bedrock|barrier|end_portal_frame|end_portal|nether_portal|command_block|structure_block|reinforced_deepslate|spawner|chest|trapped_chest|barrel|ender_chest|furnace|crafting_table|.*_bed|.*shulker_box)$/

const DIRS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

function at (bot, p) { try { return bot.blockAt(p) } catch { return null } }

// Пересекает ли блок коробку тела (0.6 × 1.8): «завалило» — голова или ноги в твёрдом.
function overlapsBody (bot, b) {
  if (!solid(b) || !bot.entity) return false
  const p = bot.entity.position
  const lo = { x: p.x - 0.29, y: p.y + 0.05, z: p.z - 0.29 }
  const hi = { x: p.x + 0.29, y: p.y + 1.75, z: p.z + 0.29 }
  const shapes = b.shapes && b.shapes.length ? b.shapes : [[0, 0, 0, 1, 1, 1]]
  for (const s of shapes) {
    const x0 = b.position.x + s[0]; const y0 = b.position.y + s[1]; const z0 = b.position.z + s[2]
    const x1 = b.position.x + s[3]; const y1 = b.position.y + s[4]; const z1 = b.position.z + s[5]
    if (x0 < hi.x && x1 > lo.x && y0 < hi.y && y1 > lo.y && z0 < hi.z && z1 > lo.z) return true
  }
  return false
}

// Куда тело хочет: следующий узел пути (если он не под ногами) или цель goto.
function towardOf (bot, goal, nodes) {
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
function axisTo (bot, toward) {
  if (!toward) return null
  const p = bot.entity.position
  const dx = toward.x - p.x; const dz = toward.z - p.z
  if (Math.abs(dx) < 0.3 && Math.abs(dz) < 0.3) return null
  return Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
}

// ------------------------------------------------------------------ диагноз
function diagnose (bot, toward = null) {
  const e = bot.entity
  const p = e.position
  const feet = p.floored()
  const fb = at(bot, feet); const hb = at(bot, feet.offset(0, 1, 0)); const gb = at(bot, feet.offset(0, -1, 0)); const ab = at(bot, feet.offset(0, 2, 0))
  const f = {
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
const LADDERS = {
  'dig-flag': ['clearDig', 'replan', 'backJump', 'breakAhead', 'bypass'],
  buried: ['digOut', 'backJump', 'replan', 'climbOut'],
  lava: ['swimOutLava', 'backJump', 'replan'],
  water: ['swimOut', 'notch', 'stepUp', 'swimOut2', 'breakAhead', 'backJump', 'replan', 'bypass'],
  enclosed: ['replan', 'breakAhead', 'climbOut', 'stepUp', 'breakAhead2', 'bypass'],
  wall: ['backJump', 'breakAhead', 'stepUp', 'replan', 'bypass', 'breakAhead2'],
  soft: ['backJump', 'breakAhead', 'replan', 'waypoint', 'stepUp', 'bypass'],
  open: ['replan', 'backJump', 'waypoint', 'breakAhead', 'stepUp', 'bypass', 'climbOut']
}
const REFUSED = {
  'dig-flag': ['clearDig', 'replan'],
  buried: ['digOut', 'replan'],
  lava: ['swimOutLava', 'replan'],
  water: ['swimOut', 'notch', 'stepUp', 'swimOut2', 'breakAhead', 'bypass'],
  enclosed: ['bypass', 'breakAhead', 'climbOut', 'breakAhead2', 'stepUp'],
  wall: ['bypass', 'breakAhead', 'stepUp', 'breakAhead2'],
  soft: ['waypoint', 'bypass', 'breakAhead', 'backJump'],
  open: ['waypoint', 'bypass', 'breakAhead', 'stepUp']
}
function ladder (cls, kind = 'still', status = null) {
  const table = kind === 'refused' ? REFUSED : LADDERS
  const out = (table[cls] || table.open).slice()
  // A* не уложился в 5 с (дальняя цель, лавовые озёра Ада): сначала промежуточная цель ближе — её поиск короче.
  if (status === 'timeout') { const i = out.indexOf('waypoint'); if (i >= 0) out.splice(i, 1); out.unshift('waypoint') }
  return out
}

// ------------------------------------------------------------------ ступени
// ctx: { bot, session, ctl, toward, diag, mcData, sleep }
const aborted = ctx => !!(ctx.ctl && ctx.ctl.aborted)

function eye (bot) { return bot.entity.position.offset(0, 1.62, 0) }

// Видимая точка блока: луч из глаз до неё упирается именно в этот блок (как прицел клиента), не дальше 4.5.
function visiblePoint (bot, pos) {
  const pick = require('./pick')
  const o = eye(bot)
  const c = pos.offset(0.5, 0.5, 0.5)
  const d0 = c.minus(o)
  const len = d0.norm()
  if (len < 1e-3) return c
  const tb = at(bot, pos)
  if (tb && tb.boundingBox !== 'block' && IMPEDE.test(tb.name)) {
    // Контур — куб клетки: виден, если луч до входа в клетку не упёрся в твёрдое. Глаза внутри клетки — виден.
    if (len > 4.5) return null
    const d = d0.scaled(1 / len)
    const tIn = pick.rayBox(o, d, pos, pos.offset(1, 1, 1), len + 1)
    if (tIn == null) return null
    const hit = pick.blockOnRay(bot, o, d, Math.max(tIn, 0.001))
    return !hit || hit.t >= tIn - 1e-6 ? c : null
  }
  if (len <= 4.5) {
    const hit = pick.blockOnRay(bot, o, d0.scaled(1 / len), len + 0.6)
    if (hit && hit.pos.equals(pos)) return c
  }
  // Грани, обращённые к глазам.
  const faces = []
  for (const f of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
    const fc = c.offset(f.x * 0.5, f.y * 0.5, f.z * 0.5)
    if ((o.x - fc.x) * f.x + (o.y - fc.y) * f.y + (o.z - fc.z) * f.z > 0) faces.push(f)
  }
  for (const f of faces) {
    const P = pick.faceAim(bot, pos, f)
    if (P) return P
  }
  return null
}

// Можно ли вскрыть блок: не жидкость за ним (кроме нашей стороны), не бедрок/контейнер, не пол под ногами.
function safeToBreak (bot, pos, { maxMs = 6000 } = {}) {
  const b = at(bot, pos)
  if (!solid(b) && !(b && SOFT.test(b.name) && b.name !== 'water')) return { ok: false, why: 'не твёрдый' }
  if (UNBREAKABLE.test(b.name)) return { ok: false, why: b.name }
  const feet = bot.entity.position.floored()
  if (pos.equals(feet.offset(0, -1, 0))) return { ok: false, why: 'пол под ногами' }
  for (const d of [new Vec3(0, 1, 0), ...DIRS, new Vec3(0, -1, 0)]) {
    const n = at(bot, pos.plus(d))
    if (n && liquid(n) && !(AQUATIC.test(b.name) && waterB(n))) {
      // Жидкость в клетке тела или головы — уже наша сторона.
      const np = pos.plus(d)
      if (np.equals(feet) || np.equals(feet.offset(0, 1, 0))) continue
      return { ok: false, why: `${n.name} за ${b.name}` }
    }
  }
  try {
    const tools = require('./tools')
    if (!tools.breakable(b)) return { ok: false, why: `${b.name} не ломается` }
    const plan = tools.bestFor(bot, b)
    if (plan.ms > maxMs) return { ok: false, why: `${b.name}: ${(plan.ms / 1000).toFixed(1)} с` }
  } catch {}
  return { ok: true, block: b }
}

async function digVisible (ctx, pos, opts = {}) {
  const { bot } = ctx
  const s = safeToBreak(bot, pos, opts)
  if (!s.ok) return { ok: false, why: s.why }
  const P = visiblePoint(bot, pos)
  if (!P) return { ok: false, why: `${s.block.name} не видно` }
  try {
    await bot.lookAt(P, true)
    let ms = 6000
    try { ms = require('./tools').bestFor(bot, s.block).ms } catch {}
    const done = bot.dig(s.block, 'ignore')
    await withTimeout(done, ms + 1500)
    return { ok: true, name: s.block.name }
  } catch (err) {
    try { bot.stopDigging() } catch {}
    return { ok: false, why: String(err && err.message || err).slice(0, 80) }
  }
}

function withTimeout (p, ms) {
  let t = null
  return Promise.race([p, new Promise((_r, reject) => { t = gameClock.setTimeout(() => reject(new Error('копка не кончилась')), ms) })]).finally(() => gameClock.clearTimeout(t))
}

async function hold (ctx, keys, ms) {
  const { bot } = ctx
  try {
    for (const k of keys) bot.setControlState(k, true)
    await (ctx.sleep || sleepReal)(ms)
  } finally {
    for (const k of keys) { try { bot.setControlState(k, false) } catch {} }
  }
}

// Пол в 3 вниз у клетки (не лава): шагнуть туда не значит упасть.
function groundNear (bot, cell) {
  for (let dy = 0; dy <= 3; dy++) {
    const b = at(bot, cell.offset(0, -dy - 1, 0))
    if (!b) return false
    if (lavaB(b)) return false
    if (solid(b) || waterB(b)) return true
  }
  return false
}

const RUNGS = {
  // Флаг копки pathfinder'а без копки (смерть посреди копки, чанк ушёл): сбросить.
  async clearDig (ctx) {
    const did = require('./tools').unstickPathfinderDig(ctx.bot)
    return { applied: did, why: did ? 'флаг копки снят' : 'флага нет' }
  },
  // Свежие ходы pathfinder'а и поиск с нуля из этой точки.
  async replan (ctx) {
    const { bot, session } = ctx
    try { bot.clearControlStates() } catch {}
    try { require('./tools').unstickPathfinderDig(bot) } catch {}
    if (session && typeof session.updateMovements === 'function') { try { session.updateMovements(true) } catch {} }
    return { applied: true, why: 'новые ходы, поиск заново' }
  },
  // Шаг к цели с прыжком (порог, полублок, край воды); не сдвинулся — назад (если сзади пол) и снова с прыжком вбок.
  async backJump (ctx) {
    const { bot, toward } = ctx
    const p0 = bot.entity.position.clone()
    const feet = p0.floored()
    const dir = axisTo(bot, toward)
    let yaw = bot.entity.yaw
    if (toward) yaw = Math.atan2(-(toward.x - p0.x), -(toward.z - p0.z))
    try { await bot.look(yaw, 0, true) } catch {}
    const frontOk = dir ? groundNear(bot, feet.plus(dir)) || solid(at(bot, feet.plus(dir))) : true
    if (frontOk) await hold(ctx, ['forward', 'jump'], 450)
    if (bot.entity.position.distanceTo(p0) >= 0.5) return { applied: true, why: 'шаг с прыжком' }
    const back = new Vec3(Math.sin(yaw), 0, Math.cos(yaw))
    const behind = p0.plus(back).floored()
    if (groundNear(bot, behind) && !solid(at(bot, behind)) && !solid(at(bot, behind.offset(0, 1, 0)))) await hold(ctx, ['back'], 350)
    const side = (Math.floor(gameClock.now() / 1000) % 2) ? 'left' : 'right'
    if (frontOk) await hold(ctx, ['forward', 'jump', side], 550)
    const moved = bot.entity.position.distanceTo(p0)
    return { applied: moved >= 0.3, why: `назад и прыжок, сдвиг ${moved.toFixed(2)}` }
  },
  // Снести видимое, что стоит между телом и целью: клетки ног и головы впереди, при подъёме — над головой.
  async breakAhead (ctx) { return breakToward(ctx, 1) },
  async breakAhead2 (ctx) { return breakToward(ctx, 2) },
  // Завалило: твёрдое в клетке головы/ног — выкопать (глаза внутри блока — он и есть под прицелом).
  async digOut (ctx) {
    const { bot } = ctx
    const feet = bot.entity.position.floored()
    const dug = []
    for (const c of [feet.offset(0, 1, 0), feet]) {
      const b = at(bot, c)
      if (!overlapsBody(bot, b) && !(b && /^(powder_snow|cobweb|sweet_berry_bush)$/.test(b.name))) continue
      const r = await digVisible(ctx, c)
      if (r.ok) dug.push(r.name)
      if (aborted(ctx)) break
    }
    return { applied: dug.length > 0, why: dug.length ? `выкопался: ${dug.join(', ')}` : 'нечего копать' }
  },
  // Из воды — к ближнему берегу (movement.escapeWater: путь по клеткам воды до сухой опоры или до воздуха).
  async swimOut (ctx) {
    const { bot } = ctx
    const m = require('./movement')
    if (!m.inWater(bot)) return { applied: false, why: 'не в воде' }
    // Берег вплавь в 16 бл. (с прыжком на уступ в 1 блок); нет — сразу ступенька/лесенка (пруд в яме, берег на 2+ выше).
    return swimTo(ctx, waterB, () => m.inWater(bot), { radius: 16, ms: 10000 })
  },
  // Из лавы (тонет с огнестойкостью — neF-mB26-1: goto ×214 «путь кончился» из лавового моря и смерть): путь по клеткам
  // лавы до сухой опоры, вверх и к ней.
  async swimOutLava (ctx) {
    const { bot } = ctx
    const inLava = () => !!bot.entity.isInLava || lavaB(at(bot, bot.entity.position.floored())) || lavaB(at(bot, bot.entity.position.offset(0, 0.9, 0).floored()))
    if (!inLava()) return { applied: false, why: 'не в лаве' }
    return swimTo(ctx, lavaB, inLava, { radius: 10, ms: 6000 })
  },
  // Ещё раз к берегу (после выемки или ступеньки берег вплавь мог появиться).
  async swimOut2 (ctx) { return RUNGS.swimOut(ctx) },
  // Выемка в берегу: берег выше воды на 1+ (из воды на него не вылезти: prismarine-physics — тело у стенки поднимается
  // до верха воды + 0.43, а надо + 1; kelp us-main2). Снести блоки берега впереди над уровнем воды (+1, +2), и берег —
  // вровень с водой: вперёд с прыжком — и на нём (симуляция: 36 тиков). Под водой копка медленнее — до 12 с.
  async notch (ctx) {
    const { bot, toward } = ctx
    const m = require('./movement')
    if (!m.inWater(bot)) return { applied: false, why: 'не в воде' }
    const dir = axisTo(bot, toward)
    if (!dir) return { applied: false, why: 'нет направления' }
    const col = bot.entity.position.floored()
    let y = col.y
    while (y < col.y + 3 && waterB(at(bot, new Vec3(col.x, y + 1, col.z)))) y++
    if (!waterB(at(bot, new Vec3(col.x, y, col.z)))) y--
    const front = new Vec3(col.x + dir.x, y, col.z + dir.z)
    if (!solid(at(bot, front))) return { applied: false, why: 'впереди не берег' }
    const dug = []; const skip = []
    for (const c of [front.offset(0, 2, 0), front.offset(0, 1, 0)]) {
      if (aborted(ctx)) break
      const b = at(bot, c)
      if (!solid(b)) continue
      const r = await digVisible(ctx, c, { maxMs: 12000 })
      if (r.ok) dug.push(r.name); else skip.push(`${b.name}: ${r.why}`)
    }
    if (solid(at(bot, front.offset(0, 1, 0))) || solid(at(bot, front.offset(0, 2, 0)))) return { applied: false, why: `выемку не сделал: ${skip.slice(0, 2).join('; ')}` }
    try { await bot.look(Math.atan2(-dir.x, -dir.z), 0, true) } catch {}
    const t0 = gameClock.now()
    try {
      bot.setControlState('forward', true); bot.setControlState('jump', true)
      while (gameClock.now() - t0 < 3000 && !aborted(ctx) && !(bot.entity.onGround && !m.inWater(bot))) await (ctx.sleep || sleepReal)(100)
    } finally { try { bot.clearControlStates() } catch {} }
    const out = bot.entity.onGround && !m.inWater(bot)
    return { applied: out || dug.length > 0, why: `выемка ${dug.join(', ') || 'уже была'}${out ? ', вылез' : ', не вылез'}` }
  },
  // Ступенька к цели: блок в клетку ног впереди (вода или пусто, под ней опора) и прыжок на него; стена в два блока —
  // столб на 1 и шаг.
  async stepUp (ctx) {
    const { bot, toward, ctl } = ctx
    const build = require('./build')
    const dir = axisTo(bot, toward)
    if (!dir) return { applied: false, why: 'нет направления' }
    const feet = bot.entity.position.floored()
    const front = feet.plus(dir)
    const ff = at(bot, front); const fh = at(bot, front.offset(0, 1, 0)); const fa = at(bot, front.offset(0, 2, 0))
    const yaw = Math.atan2(-dir.x, -dir.z)
    const wet = waterB(at(bot, feet)) || waterB(ff)
    const higher = !!toward && toward.y > bot.entity.position.y + 0.9
    // (а) Впереди вода или пусто (под ней опора), а выше по ходу — уступ: блок в клетку ног впереди и прыжок на него.
    if (!solid(ff) && !solid(fh) && !lavaB(ff) && (wet || higher)) {
      const r = await build.placeBlockAt(bot, front, { honest: true, steady: true, timeoutMs: 2500 })
      if (!r.ok) return { applied: false, why: `ступенька: ${r.reason}` }
      try { await bot.look(yaw, 0, true) } catch {}
      await hold(ctx, ['forward', 'jump'], 600)
      return { applied: true, why: 'ступенька и прыжок' }
    }
    // (б) Стена в два блока, над ней и над головой свободно: столб на 1 и шаг на стену.
    if (solid(ff) && solid(fh) && !solid(fa) && !solid(at(bot, feet.offset(0, 2, 0))) && !wet) {
      const up = await build.towerUp(bot, ctl, 1, { sneak: false })
      if (!up.placed) return { applied: false, why: `столб: ${up.reason || (up.why && up.why[0]) || 'не встал'}` }
      try { await bot.look(yaw, 0, true) } catch {}
      await hold(ctx, ['forward', 'jump'], 600)
      return { applied: true, why: 'столб на 1 и шаг на стену' }
    }
    return { applied: false, why: 'ступенька некуда' }
  },
  // Вылезти из своей ямы/шахты столбом (build.escapePit: потолок с жидкостью за ним не вскрывает).
  async climbOut (ctx) {
    const { bot, ctl, mcData } = ctx
    const build = require('./build')
    if (!build.inPit(bot)) return { applied: false, why: 'не в яме' }
    const r = await build.escapePit(bot, ctl, { maxClimb: 8, mcData })
    return { applied: !!(r && r.climbed > 0), why: `из ямы на ${r && r.climbed}${r && r.stopped ? ' — ' + r.stopped : ''}` }
  },
  // Промежуточная цель: A* к дальней цели не укладывается в 5 с (ферма: 17–34 узла за 40 мс), а к точке в 16–22 бл. по
  // пути — укладывается. Пробуем прямо к цели и под углом ±35°/±70°; засчитано, если тело стало ближе к цели на 6+.
  async waypoint (ctx) {
    const { bot, toward } = ctx
    if (!toward) return { applied: false, why: 'нет цели' }
    const { goals } = require('mineflayer-pathfinder')
    const { gotoGoal } = require('./movement')
    const p0 = bot.entity.position.clone()
    const dx = toward.x - p0.x; const dz = toward.z - p0.z
    const dist = Math.hypot(dx, dz)
    if (dist < 14) return { applied: false, why: 'цель близко' }
    const left = () => Math.hypot(toward.x - bot.entity.position.x, toward.z - bot.entity.position.z)
    const len = Math.min(22, dist * 0.6)
    const tried = []
    const tw = gameClock.now()
    for (const deg of [0, 35, -35, 70, -70]) {
      if (aborted(ctx) || gameClock.now() - tw > 25000 || (ctx.deadline && (ctx.now ? ctx.now() : gameClock.now()) > ctx.deadline - 8000)) break
      const a = deg * Math.PI / 180
      const ux = (dx * Math.cos(a) - dz * Math.sin(a)) / dist; const uz = (dx * Math.sin(a) + dz * Math.cos(a)) / dist
      const wx = Math.floor(p0.x + ux * len); const wz = Math.floor(p0.z + uz * len)
      const sub = new goals.GoalNearXZ(wx, wz, 3)
      let t = null
      try {
        await Promise.race([gotoGoal(bot, sub), new Promise((_r, reject) => { t = gameClock.setTimeout(() => reject(new Error('промежуточная: 15 с')), 15000) })])
      } catch (err) { tried.push(`${deg}°: ${String(err.message).slice(0, 40)}`) } finally { gameClock.clearTimeout(t); try { bot.pathfinder.setGoal(null) } catch {} }
      if (dist - left() >= 6) return { applied: true, why: `промежуточная ${wx},${wz} (${deg}°): ближе на ${Math.round(dist - left())}` }
      if (bot.entity.position.distanceTo(p0) < 1) tried.push(`${deg}°: ни шага`)
    }
    return { applied: false, why: `промежуточные не помогли: ${tried.slice(0, 3).join('; ')}` }
  },
  // Обход блоками: мост на ходу и спуск блоками (blockmoves.js) — для этого перехода.
  async bypass (ctx) {
    const { session } = ctx
    if (!session) return { applied: false, why: 'нет сессии' }
    if (session.bridgeWanted === true || (session.movements && session.movements.bridge)) return { applied: false, why: 'мост уже включён' }
    session.bridgeWanted = true
    try { session.updateMovements(true) } catch {}
    return { applied: true, why: 'мост и спуск блоками на этот переход' }
  }
}

// Путь по клеткам жидкости (fluid) и воздуха до сухой опоры (ноги и голова — воздух, под ногами твёрдое): BFS как
// movement.findSwimRoute, но для любой жидкости. { target, path } или null.
function fluidRoute (bot, fluid, { radius = 8, rise = 8, toward = null } = {}) {
  const start = bot.entity.position.floored()
  const key = p => `${p.x},${p.y},${p.z}`
  const wet = b => !!b && (fluid(b) || (AQUATIC.test(b.name) && !lavaB(b)))
  const pass = b => !!b && (wet(b) || (b.boundingBox === 'empty' && !liquid(b)))
  const land = (fb, hb, gb) => !!fb && !!hb && !wet(fb) && !wet(hb) && fb.boundingBox === 'empty' && hb.boundingBox === 'empty' && solid(gb) && !lavaB(gb)
  const q = [{ p: start, parent: -1 }]
  const seen = new Set([key(start)])
  let best = null
  for (let i = 0; i < q.length && i < 6000; i++) {
    const p = q[i].p
    const f = at(bot, p); const h = at(bot, p.offset(0, 1, 0)); const g = at(bot, p.offset(0, -1, 0))
    if (land(f, h, g)) {
      // Берег: без цели — первый (ближний); с целью — лучший по «шаги + полрасстояния до цели» (стенка пруда сзади не
      // годится, если берег к цели рядом — kelp, us-main1: тело выплыло к западной стенке, а цель на востоке).
      let steps = 0; let j = i
      while (q[j].parent >= 0) { steps++; j = q[j].parent }
      const score = steps + (toward ? 0.5 * Math.hypot(p.x + 0.5 - toward.x, p.z + 0.5 - toward.z) : 0)
      if (!best || score < best.score) best = { i, score }
      if (!toward) break
      continue
    }
    const next = [...DIRS.map(d => p.plus(d)), p.offset(0, 1, 0)]
    // Прыжок из воды на уступ в 1 блок (как findSwimRoute): над клеткой свободно.
    if (wet(f) && pass(at(bot, p.offset(0, 2, 0)))) next.push(...DIRS.map(d => p.plus(d).offset(0, 1, 0)))
    // С поверхности (голова над водой) — на берег на 1 выше воды: в воде у стенки с прыжком тело лезет вверх
    // (LivingEntity.travel: в жидкости и упёрся — +0.3 по y).
    if (wet(f) && !wet(h) && pass(at(bot, p.offset(0, 2, 0))) && pass(at(bot, p.offset(0, 3, 0)))) next.push(...DIRS.filter(d => solid(at(bot, p.plus(d).offset(0, 1, 0)))).map(d => p.plus(d).offset(0, 2, 0)))
    for (const n of next) {
      if (Math.max(Math.abs(n.x - start.x), Math.abs(n.z - start.z)) > radius || n.y - start.y > rise || n.y < start.y - 2) continue
      if (seen.has(key(n))) continue
      const nf = at(bot, n); const nh = at(bot, n.offset(0, 1, 0)); const ng = at(bot, n.offset(0, -1, 0))
      if (!pass(nf) || !pass(nh)) continue
      // По воздуху не летаем: клетка без жидкости — только берег (твёрдое под ногами).
      if (!wet(nf) && !wet(nh) && !land(nf, nh, ng)) continue
      seen.add(key(n))
      q.push({ p: n, parent: i })
    }
  }
  if (!best) return null
  const path = []; let j = best.i
  while (q[j].parent >= 0) { path.unshift(q[j].p); j = q[j].parent }
  return { target: q[best.i].p, path }
}

// Плыть по пути fluidRoute к берегу: взгляд на следующую клетку, вперёд и прыжок (в жидкости — всплытие).
async function swimTo (ctx, fluid, inFluid, { radius = 8, ms = 8000 } = {}) {
  const { bot } = ctx
  const toward = ctx.toward || null
  const route = fluidRoute(bot, fluid, { radius, toward })
  if (!route) return { applied: false, why: 'берега рядом нет' }
  const t0 = gameClock.now()
  const p0 = bot.entity.position.clone()
  // До сухой опоры: тело на земле и не в жидкости. «Вышел из воды» на миг (прыжок у стенки) — ещё не берег: отпустить
  // клавиши там — упасть обратно (kelp, us-main1).
  const dry = () => !inFluid() && !!bot.entity.onGround
  try {
    let bestD = Infinity; let bestT = gameClock.now()
    while (gameClock.now() - t0 < ms && !aborted(ctx) && !dry()) {
      // 3 с не ближе к берегу (упёрся в стенку, не вылезти) — бросить: следующая ступень (выемка, ступенька).
      const dT = bot.entity.position.distanceTo(route.target.offset(0.5, 0, 0.5))
      if (dT < bestD - 0.2) { bestD = dT; bestT = gameClock.now() } else if (gameClock.now() - bestT > 3000) break
      const r = (inFluid() && fluidRoute(bot, fluid, { radius, toward })) || route
      const next = inFluid() ? (r.path[0] || r.target) : r.target
      await bot.lookAt(next.offset(0.5, 1.6, 0.5), true)
      const hz = Math.hypot(next.x + 0.5 - bot.entity.position.x, next.z + 0.5 - bot.entity.position.z)
      bot.setControlState('forward', hz > 0.2)
      bot.setControlState('jump', true)
      await (ctx.sleep || sleepReal)(150)
    }
  } finally { try { bot.clearControlStates() } catch {} }
  const out = dry()
  return { applied: out || bot.entity.position.distanceTo(p0) > 2, why: out ? `вышел на берег ${route.target.x},${route.target.y},${route.target.z}` : 'плыл к берегу, не вышел' }
}

async function breakToward (ctx, depth) {
  const { bot, toward } = ctx
  const dir = axisTo(bot, toward)
  if (!dir) return { applied: false, why: 'нет направления' }
  const feet = bot.entity.position.floored()
  const up = toward && toward.y > bot.entity.position.y + 0.6
  const down = toward && toward.y < bot.entity.position.y - 1.2
  const cells = []
  // Вверх — лесенкой: над головой, впереди на +2 и +1; клетка ног впереди остаётся ступенькой (на неё и прыжок).
  // Ровно — проход 1×2. Вниз — ещё и клетка под проходом (ступень вниз).
  for (let k = 1; k <= depth; k++) {
    const f = feet.plus(dir.scaled(k))
    const y0 = up ? k - 1 : 0
    if (up) cells.push(feet.offset(0, 2 + y0, 0).plus(dir.scaled(k - 1)), f.offset(0, 2 + y0, 0), f.offset(0, 1 + y0, 0))
    else cells.push(f.offset(0, 1, 0), f)
    // Ступень вниз — только если под ней опора в 2 бл. (не лава): иначе шаг в дыру над пещерой — падение.
    if (down && k === 1 && groundNear(bot, f.offset(0, -1, 0)) && solid(at(bot, f.offset(0, -2, 0)))) cells.push(f.offset(0, -1, 0))
  }
  const dug = []; const skip = []
  for (const c of cells) {
    if (aborted(ctx)) break
    const b = at(bot, c)
    if (!b || (!solid(b) && !IMPEDE.test(b.name) && !(SOFT.test(b.name) && b.boundingBox !== 'empty'))) continue
    const r = await digVisible(ctx, c)
    if (r.ok) dug.push(r.name)
    else skip.push(`${b.name}: ${r.why}`)
  }
  if (dug.length) {
    try { await bot.look(Math.atan2(-dir.x, -dir.z), 0, true) } catch {}
    await hold(ctx, up ? ['forward', 'jump'] : ['forward'], 450)
  }
  return { applied: dug.length > 0, why: dug.length ? `снёс ${dug.join(', ')}` : skip.length ? `не снёс: ${skip.slice(0, 2).join('; ')}` : 'впереди пусто' }
}

// ------------------------------------------------------------------ детектор
// Застревание при живой цели: (а) still — за stillMs тело не сдвинулось на minMove; (б) noprogress — за progressMs
// эвристика цели не улучшилась на 1.5, а тело топчется в радиусе roam; (в) dig — одна и та же копка дольше digMs.
// Не застревание: идёт поиск (последний path_update — 'partial' с пустым путём, свежий), pathfinder копает/ставит,
// исполнитель моста/спуска держит своё (bot._ndBridgeExec).
function createDetector (bot, { goal = null, stillMs = 3000, minMove = 0.4, progressMs = 20000, roam = 5, digMs = 10000, buildMs = 6000, now = () => gameClock.now() } = {}) {
  let anchor = null; let anchorT = 0
  let best = Infinity; let bestT = 0; let roamAt = null
  let lastPath = null; let lastPathT = 0; let lastPartialT = -Infinity
  let digKey = null; let digT = 0
  let buildT = 0
  const h = () => {
    if (!goal || typeof goal.heuristic !== 'function') return null
    const p = bot.entity.position
    try { return goal.heuristic({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }) } catch { return null }
  }
  const reset = () => {
    const t = now()
    anchor = bot.entity.position.clone(); anchorT = t
    const v = h(); best = v == null ? Infinity : v; bestT = t; roamAt = anchor.clone()
    digKey = null; buildT = 0
  }
  reset()
  return {
    reset,
    feed (r) { if (r) { lastPath = { status: r.status, len: Array.isArray(r.path) ? r.path.length : 0 }; lastPathT = now(); if (r.status === 'partial') lastPartialT = lastPathT } },
    check () {
      const t = now()
      const e = bot.entity
      if (!e) return null
      const p = e.position
      // Цель ближе — прогресс.
      const v = h()
      if (v != null && v < best - 1.5) { best = v; bestT = t; roamAt = p.clone() }
      if (roamAt && p.distanceTo(roamAt) > roam) { roamAt = p.clone(); bestT = t; if (v != null) best = Math.min(best, v) }
      // В воде тело качается вверх-вниз на полблока — сдвиг там считаем по горизонтали.
      const wet = !!e.isInWater || waterB(at(bot, p.floored()))
      const moved = wet ? Math.hypot(p.x - anchor.x, p.z - anchor.z) : p.distanceTo(anchor)
      if (moved > minMove) { anchor = p.clone(); anchorT = t; digKey = null; buildT = 0 }
      // Поиск идёт — стоять можно.
      const searching = !lastPath || (lastPath.status === 'partial' && lastPath.len === 0 && t - lastPathT < 1500)
      let mining = false; let building = false
      try { mining = !!(bot.pathfinder && bot.pathfinder.isMining && bot.pathfinder.isMining()) } catch {}
      try { building = !!(bot.pathfinder && bot.pathfinder.isBuilding && bot.pathfinder.isBuilding()) } catch {}
      const exec = bot._ndBridgeExec
      const blockWork = !!(exec && (exec.seg || exec.desc || (exec.queue && exec.queue.length)))
      if (mining) {
        const tb = bot.targetDigBlock
        const k = tb && tb.position ? `${tb.position.x},${tb.position.y},${tb.position.z}` : 'none'
        if (k !== digKey) { digKey = k; digT = t }
        anchorT = t
        if (t - digT > digMs) return { kind: 'dig', ms: t - digT }
        return null
      }
      if (building || blockWork) {
        if (!buildT) buildT = t
        anchorT = t
        if (t - buildT > buildMs) return { kind: 'still', ms: t - buildT, why: 'стройка без сдвига' }
        return null
      }
      if (searching) { anchorT = t; return null }
      if (t - anchorT >= stillMs) return { kind: 'still', ms: t - anchorT }
      // Поиск A* идёт (свежий 'partial', с путём или без) — топтание у старта не застревание: тело ходит по частичным
      // путям, пока ищется обход (лавовое озеро на стенде mv-gap: 40–55 с у старта, и поиск доходил; перестройка
      // каждые 20 с его обнуляла — us-reg-gap: озеро 1/4 вместо 4/4).
      if (t - lastPartialT < 2500) { bestT = t; return null }
      if (t - bestT >= progressMs) return { kind: 'noprogress', ms: t - bestT }
      return null
    }
  }
}

// ------------------------------------------------------------------ память отказов (между вызовами goto)
// Один и тот же отказ поиска в той же точке: кампания звала goto 6801 раз за 5 мин у ямы под лавой (neF-S26-1).
const memory = new WeakMap()
function noteRefusal (bot, kind, pos, t = gameClock.now()) {
  let m = memory.get(bot)
  if (!m) { m = []; memory.set(bot, m) }
  m.push({ kind, pos: pos.clone ? pos.clone() : new Vec3(pos.x, pos.y, pos.z), t })
  while (m.length > 40 || (m.length && t - m[0].t > 120000)) m.shift()
  return m.filter(r => r.pos.distanceTo(pos) <= 2.5 && t - r.t <= 90000).length
}

// ------------------------------------------------------------------ наблюдатель на весь переход (session.goto)
// watch(session, ctl, { deadline }) → { attach(bot, goal, { resume, fail }) → handle, stats, report() }.
// handle (на один gotoGoal): busy() — идёт ступень (gotoGoal не реагирует на свои setGoal(null)); refused(r) — отказ поиска:
// true — забрали себе (ступень и resume/fail), false — пусть gotoGoal отвечает как раньше; stop().
function watch (session, ctl, { deadline = Infinity, maxRungs = 7, maxTotal = 30, log = console.log, now = () => gameClock.now(), sleep = sleepReal, tickMs = 250, detector = {} } = {}) {
  const st = { detected: 0, refusals: 0, rungs: [], freed: 0, gaveUp: null, cls: {} }
  let spot = null; let tried = []; let spotH = null; let total = 0
  // Лестница в этой точке исчерпана — до конца перехода не вмешиваемся (дальше прежний goto: сторож 8 с, рывки, план XZ).
  let exhausted = false
  let current = null
  const deadlineOk = () => now() < deadline - 2000
  const report = () => ({ detected: st.detected, refusals: st.refusals, rungs: st.rungs.map(r => `${r.cls}:${r.rung}${r.applied ? '' : '-'}`), gaveUp: st.gaveUp || undefined })

  function attach (bot, goal, { resume, fail }) {
    if (exhausted) return { busy: () => false, refused: () => false, stop () {} }
    const det = createDetector(bot, { goal, now, ...detector })
    let busy = false
    let stopped = false
    const onPath = r => det.feed(r)
    bot.on('path_update', onPath)
    const timer = gameClock.setInterval(() => {
      if (busy || stopped || (ctl && ctl.aborted)) return
      let v = null
      try { v = det.check() } catch {}
      if (v) escape(v.kind, v).catch(() => {})
    }, tickMs)
    // Прерывание посреди ступени: gotoGoal свои события в это время не слушает — отпустить его отказом, иначе промис и
    // его слушатели на теле повисли бы навсегда.
    if (ctl && ctl.onAbort) ctl.onAbort.push(() => { const was = busy && !stopped; stop(); if (was) { try { fail(Object.assign(new Error('прервано посреди выхода из застревания'), { name: 'Aborted' })) } catch {} } })

    async function escape (kind, info = {}) {
      busy = true
      try {
        try { bot.pathfinder.setGoal(null) } catch {}
        try { bot.clearControlStates() } catch {}
        const pos = bot.entity.position.clone()
        // Новое место — лестница заново: ушли от точки начала на 3+ или стали ближе к цели на 0.9+ (штрек руками к цели
        // по блоку за ступень — каждая ступень с продвижением открывает следующую). Всего ступеней на переход — maxTotal.
        const hNow = (() => { try { return goal.heuristic({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }) } catch { return null } })()
        if (!spot || pos.distanceTo(spot) > 3 || (hNow != null && spotH != null && hNow < spotH - 0.9)) { spot = pos; spotH = hNow; tried = [] }
        if (kind === 'refused') st.refusals++
        else st.detected++
        // До 3 ступеней подряд, если ступень «не применилась» (нечего ломать, не в яме) — следующая сразу.
        for (let i = 0; i < 4; i++) {
          if (stopped || (ctl && ctl.aborted)) return
          const toward = towardOf(bot, goal, session && session.pathNodes)
          const d = diagnose(bot, toward)
          st.cls[d.cls] = (st.cls[d.cls] || 0) + 1
          const rungs = ladder(d.cls, kind === 'refused' ? 'refused' : 'still', info.status).filter(r => !tried.includes(r))
          if (!rungs.length || tried.length >= maxRungs || total >= maxTotal || !deadlineOk()) {
            exhausted = true
            // Поиск отказал в открытом месте, а лестнице помочь нечем — ответ goto прежний (повторы, план XZ) — рельеф,
            // us-reg-terr: «застрял (open) … пути нет» за 18 с там, где прежний goto доходил.
            if (kind === 'refused' && info.answer && !['dig-flag', 'buried', 'water', 'enclosed', 'lava'].includes(d.cls)) {
              log('[unstuck] отдаю', JSON.stringify({ cls: d.cls, tried: tried.slice() }))
              stopped = true
              info.answer()
              return
            }
            st.gaveUp = { cls: d.cls, at: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, kind, tried: tried.slice(), facts: { feet: d.feet, head: d.head, ground: d.ground, front: d.front } }
            log('[unstuck] отказ', JSON.stringify(st.gaveUp))
            stopped = true
            const err = Object.assign(new Error(`застрял (${d.cls}) у ${st.gaveUp.at.x},${st.gaveUp.at.y},${st.gaveUp.at.z}: ${kind === 'refused' ? 'пути нет' : 'не сдвигаюсь'}; испробовано: ${tried.join(', ') || 'ничего'}`), { code: 'STUCK', unstuck: st.gaveUp })
            fail(err)
            return
          }
          const rung = rungs[0]
          tried.push(rung)
          total++
          const t0 = now()
          let res = { applied: false, why: 'ошибка' }
          try { res = await RUNGS[rung]({ bot, session, ctl, toward, goal, diag: d, mcData: session && session.mcData, sleep, deadline, now }) || res } catch (err) { res = { applied: false, why: String(err && err.message || err).slice(0, 80) } }
          st.rungs.push({ cls: d.cls, rung, applied: !!res.applied, ms: now() - t0 })
          log('[unstuck]', JSON.stringify({ kind, cls: d.cls, rung, applied: !!res.applied, why: res.why, ms: now() - t0, pos: d.pos, feet: d.feet, head: d.head, ground: d.ground, front: d.front, info: info.ms ? info.ms : undefined }))
          if (res.applied) break
        }
        if (stopped || (ctl && ctl.aborted)) return
        det.reset()
        busy = false
        try { resume() } catch {}
      } finally {
        if (!stopped) busy = false
      }
    }

    let detached = false
    function stop () {
      if (detached) return
      detached = true
      stopped = true
      gameClock.clearInterval(timer)
      bot.removeListener('path_update', onPath)
    }

    current = {
      busy: () => busy,
      // Отказ поиска (r — path_update): пусто/нет пути/таймаут не у цели. Берём себе, если тело в «ловушке» (завалило,
      // вода, яма, стена к цели, флаг копки) или отказ в этой точке повторяется (≥ 2 за 90 с, и между вызовами goto).
      refused (r, answer) {
        if (busy || stopped || (ctl && ctl.aborted)) return busy
        if (!bot.entity) return false
        const toward = towardOf(bot, goal, null)
        const d = diagnose(bot, toward)
        const n = noteRefusal(bot, r && r.status, bot.entity.position, now())
        const trap = ['dig-flag', 'buried', 'water', 'enclosed', 'wall', 'lava'].includes(d.cls)
        const far = !!toward && Math.hypot(toward.x - bot.entity.position.x, toward.z - bot.entity.position.z) >= 20
        if (!trap && n < 2 && !(r && r.status === 'timeout' && far)) return false
        if (!deadlineOk()) return false
        escape('refused', { status: r && r.status, repeats: n, answer }).catch(() => {})
        return true
      },
      stop
    }
    return current
  }

  return { attach, stats: st, report, exhausted: () => exhausted }
}

// Есть ли сухой берег вплавь (movement.findSwimRoute — путь по клеткам воды до опоры).
function landBySwim (bot) {
  try { const r = require('./movement').findSwimRoute(bot); return !!r && r.kind === 'land' } catch { return true }
}

// Один заход лестницы вне goto (для этапов: штрек, колодец, подъём): до maxRungs ступеней, пока тело не сдвинется на 1.5.
async function freeHere (session, ctl, { toward = null, maxRungs = 5, log = console.log } = {}) {
  const bot = session.bot
  const p0 = bot.entity.position.clone()
  const tried = []
  for (let i = 0; i < maxRungs && !(ctl && ctl.aborted); i++) {
    const d = diagnose(bot, toward)
    const rung = ladder(d.cls).find(r => !tried.includes(r))
    if (!rung) break
    tried.push(rung)
    let res
    try { res = await RUNGS[rung]({ bot, session, ctl, toward, diag: d, mcData: session.mcData, sleep: sleepReal }) } catch (err) { res = { applied: false, why: err.message } }
    log('[unstuck] free', JSON.stringify({ cls: d.cls, rung, applied: !!(res && res.applied), why: res && res.why }))
    if (bot.entity.position.distanceTo(p0) >= 1.5) return { ok: true, cls: d.cls, tried }
  }
  const d = diagnose(bot, toward)
  return { ok: bot.entity.position.distanceTo(p0) >= 1.5, cls: d.cls, tried }
}

module.exports = { on, DEFAULT_ON, landBySwim, fluidRoute, diagnose, ladder, createDetector, watch, freeHere, noteRefusal, RUNGS, LADDERS, REFUSED, overlapsBody, towardOf, axisTo, safeToBreak, visiblePoint, SOFT }
