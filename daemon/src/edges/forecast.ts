'use strict'
// Прогноз тела: числа игры (отбрасывание, безопасное падение), мир для симуляции, колонна под ногами, шаг физики.
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { PlayerState } = (require('../tick-plugins') as typeof import('../tick-plugins')).getPhysics()
const geometry: typeof import('../navigation/geometry') = require('../navigation/geometry')
// LivingEntity.hurtServer: любой урон с источником — knockback(0.4) от него
// (и при неполном заряде: заряд режет урон, а не этот толчок).
const KB_HIT = 0.4
// Player.attack: спринт и заряд > 0.9 — causeExtraKnockback(getKnockback + 0.5)
// по взгляду бьющего; getKnockback без чар «Отдача» = attack_knockback/2 = 0.
const KB_SPRINT = 0.5
// ArmorMaterials: knockbackResistance за вещь — незерит 0.1, алмаз и прочие 0.
// LivingEntity.knockback: сила *= 1 − knockback_resistance.
const RESIST_PER_NETHERITE = 0.1
// Attributes.SAFE_FALL_DISTANCE = 3.0; LivingEntity.calculateFallDamage =
// floor(высота − 3): три блока бесплатно, с четырёх — урон.
const SAFE_FALL = 3
// Player.createAttributes: block_interaction_range 4.5 — ведро (BucketItem.use)
// бьёт лучом от глаз не дальше.
const USE_RANGE = 4.5
const EYE = 1.62
// EntityType.PLAYER: ширина 0.6.
const HALF = 0.3
// Вода глубже этого в колонке — «упадёт в воду, но вылетит с арены»: в небе
// над морем это тоже падение.
const WATER_DEPTH_OK = 12

const IDLE: Readonly<Record<'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'sneak', boolean>> = Object.freeze({ forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
// Рефлекс в полёте — до посадки и ближе к ходу боя (pvp.js FIX, 2026-09-26);
// ND_FIGHTFIX=0 — как раньше.
const FIX = process.env.ND_FIGHTFIX !== '0'
const CORNERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const RING8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

function worldOf (bot) {
  // Один синхронный прогноз многократно читает те же клетки. Храним полный
  // Block (shapes/properties тоже), только до конца синхронного run/pushPlan:
  // следующий вызов заново увидит обновления мира и незагруженные колонки.
  const xs = new Map()
  const absent = Symbol('undefined Block')
  return { getBlock (p) {
    const x = Math.floor(p.x); const z = Math.floor(p.z); const y = Math.floor(p.y)
    let zs = xs.get(x)
    if (zs === undefined) xs.set(x, (zs = new Map()))
    let ys = zs.get(z)
    if (ys === undefined) zs.set(z, (ys = new Map()))
    let block = ys.get(y)
    if (block === undefined) {
      block = bot.blockAt(p, false)
      ys.set(y, block === undefined ? absent : block)
    }
    return block === absent ? undefined : block
  } }
}

// Настоящий simulatePlayer — мимо обёртки рефлекса (прогнозы не должны
// сами себя фильтровать).
function simOf (bot) {
  const ph = bot.physics
  return (bot._ndSimOrig || ph.simulatePlayer).bind(ph)
}

// ---------------------------------------------------------------- рельеф

// Колонка (bx, bz) под уровнем ног feetY: куда упадёт тело. drop — высота
// падения до опоры (≤ 0 — опора на уровне ног или стена), water — внизу вода
// (гасит падение: Entity.updateInWaterState сбрасывает fallDistance), lava.
function column (bot, bx, bz, feetY, cache?) {
  const fy = Math.floor(feetY + 1e-6)
  const key = `${bx},${bz},${fy}`
  if (cache && cache.has(key)) {
    const c = cache.get(key)
    return { ...c, drop: feetY - c.top }
  }
  let out: any = { top: -Infinity }
  for (let k = 0; k <= WATER_DEPTH_OK + 2; k++) {
    const y = fy - k
    const b = bot.blockAt(new Vec3(bx, y, bz), false)
    if (!b) { out = { top: feetY, unknown: true }; break }
    if (b.name === 'lava') { out = { top: y + 1, lava: true }; break }
    if (b.name === 'water' || b.name === 'bubble_column') { out = { top: y + 1, water: k <= WATER_DEPTH_OK }; break }
    // This helper describes the CENTER of a column. The body's whole footprint
    // is checked by support() below; a pane/fence's empty corners are not floor.
    const shapes = geometry.shapeBoxes(b.position ? b : { ...b, position: new Vec3(bx, y, bz) }).filter(s => bx + .5 > s.minX && bx + .5 < s.maxX && bz + .5 > s.minZ && bz + .5 < s.maxZ && s.maxY <= feetY + 1e-7)
    if (shapes.length) { out = { top: Math.max(...shapes.map(s => s.maxY)) }; break }
  }
  if (cache) cache.set(key, out)
  return { ...out, drop: feetY - out.top }
}

function hazardCol (c, safe = SAFE_FALL) {
  return !!(c.lava || (!c.water && c.drop > safe))
}

// Опора под телом в точке pos: колонки под четырьмя углами хитбокса. Тело
// падает, только если пусты все; садится на самую высокую опору.
function support (bot, pos, cache?) {
  const actual = geometry.supportAt(bot, pos, WATER_DEPTH_OK + 2)
  let best: any = actual ? { top: actual.top, drop: pos.y - actual.top } : null
  for (const [sx, sz] of CORNERS) {
    const c = column(bot, Math.floor(pos.x + sx * (HALF - 1e-3)), Math.floor(pos.z + sz * (HALF - 1e-3)), pos.y, cache)
    // Fluids and unloaded columns retain their conservative old behavior.
    if ((!best || c.drop < best.drop) && (c.water || c.lava || c.unknown)) best = c
  }
  return best || { top: -Infinity, drop: Infinity }
}

function lethalAt (bot, pos, cache, safe = SAFE_FALL) {
  return hazardCol(support(bot, pos, cache), safe)
}

// Запас до края: сколько от края хитбокса до ближайшей опасной колонки (по
// восьми сторонам), не больше max.
function clearance (bot, pos, max = 1.2, cache?, safe = SAFE_FALL) {
  for (const r of [0.05, 0.2, 0.35, 0.5, 0.7, 0.9, 1.2, 1.6, 2.0, 2.5, 3.0]) {
    if (r > max) break
    const d = HALF + r
    for (const [sx, sz] of RING8) {
      if (hazardCol(column(bot, Math.floor(pos.x + sx * d), Math.floor(pos.z + sz * d), pos.y, cache), safe)) return r
    }
  }
  return max
}

// Есть ли опасность в радиусе r от точки (по сетке через блок): дешёвая
// проверка перед подробной.
function hazardAround (bot, pos, r, cache) {
  const cx = Math.floor(pos.x); const cz = Math.floor(pos.z)
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > (r + 0.5) * (r + 0.5)) continue
      if (hazardCol(column(bot, cx + dx, cz + dz, pos.y, cache))) return true
    }
  }
  return false
}

// ---------------------------------------------------------------- прогноз

function cloneState (base, control) {
  const st = Object.create(PlayerState.prototype)
  Object.assign(st, base)
  st.pos = base.pos.clone()
  st.vel = base.vel.clone()
  st.control = { ...control }
  if (!control.jump) st.jumpQueued = false
  return st
}

// Прогон физики: control держим hold тиков, потом всё отпущено, до остановки
// (или max тиков). fall — тело ушло ниже уровня опоры groundY в пустоту
// (глубже safe, не в воду) или в лаву.
// land — клавиши держим только до касания земли, дальше отпущены (2026-09-26):
// прогноз полёта держал их все 40 тиков, и тело «доходило» по земле до ямы в
// пяти блоках — рефлекс рулил в каждом прыжке и отбросе рядом с дырой (арена
// «арсенал»: «в полёте рулю от ямы» ×515 за 10 раундов у одного бота). После
// посадки ход решает рефлекс на земле, тик за тиком.
function run (bot, base, control, { hold = 2, max = 18, groundY, cache, safe = SAFE_FALL, land = false, world = worldOf(bot) }: any) {
  const sim = simOf(bot)
  const st = cloneState(base, control)
  let held = true
  for (let t = 0; t < max; t++) {
    if (t === hold) { st.control = { ...IDLE }; held = false }
    sim(st, world)
    if (st.isInLava) return { fall: true, lava: true, t, at: st.pos }
    if (!st.onGround && st.pos.y < groundY - 0.4) {
      const s = support(bot, st.pos, cache)
      const top = st.pos.y - s.drop
      if (s.lava || (!s.water && groundY - top > safe)) return { fall: true, t, at: st.pos }
    }
    if (land && held && st.onGround) { st.control = { ...IDLE }; held = false }
    if (st.onGround && !held && Math.hypot(st.vel.x, st.vel.z) < 0.003) return { fall: false, rest: st.pos, t }
  }
  return { fall: false, rest: st.pos, airborne: !st.onGround }
}

function stateOf (bot, control: Record<string, boolean> = IDLE) {
  return new PlayerState(bot, { ...control })
}

export { PlayerState, KB_HIT, KB_SPRINT, RESIST_PER_NETHERITE, SAFE_FALL, USE_RANGE, EYE, HALF, IDLE, FIX, CORNERS,
  worldOf, simOf, column, support, lethalAt, clearance, hazardAround, cloneState, run, stateOf }
