'use strict'
const gameClock = require('./game-clock')
// Края, ямы и пустота: не упасть самому, выбить туда другого, пережить
// падение ведром воды. Арена в небе (2026-09-25): дыра в полу, бот «не
// увидел» её и разбился о землю в полусотне блоков внизу.
//
// Три слоя:
//  1. Рефлекс (guard): перед каждым тиком физики — не уведут ли нажатые
//     клавиши тело с обрыва. Считает той же физикой, что двигает тело
//     (prismarine-physics), с инерцией: спринт после отпускания клавиш
//     скользит ещё ~0.34 блока, прыжок с разбега уносит на 3-4. Опасно —
//     клавиши этого тика заменяются безопасными: без прыжка, без спринта,
//     тормоз, шаг от края, в воздухе — рулить от ямы. Ловит все пути сразу:
//     бой, еду и питьё на ходу, лук, выход из коробки, pathfinder.
//  2. Позиция (pvp.js): куда кинет нас его удар со спринтом и куда наш —
//     его (knock, backToDrop, pushPlan).
//  3. Ведро воды (installFallGuard): с высоты — вода под ноги в последний
//     тик, после приземления — обратно в ведро. Всегда, не только в бою.
//
// Числа — из игры: декомпиляция клиента 1.21.11 (extremeheat/
// extracted_minecraft_data, ветка client1.21.11).

const Vec3 = require('vec3')
const { PlayerState } = require('./tick-plugins').getPhysics()
const clutch = require('./clutch')
const geometry = require('./navigation/geometry')

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

const IDLE = Object.freeze({ forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
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
function column (bot, bx, bz, feetY, cache) {
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
function support (bot, pos, cache) {
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
function clearance (bot, pos, max = 1.2, cache, safe = SAFE_FALL) {
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

function stateOf (bot, control = IDLE) {
  return new PlayerState(bot, { ...control })
}

// ---------------------------------------------------------------- рефлекс

// Клавиши на восемь сторон (без спринта) — для шага от края и руля в воздухе.
const DIRS8 = [
  { forward: true }, { back: true }, { left: true }, { right: true },
  { forward: true, left: true }, { forward: true, right: true }, { back: true, left: true }, { back: true, right: true }
].map(k => ({ ...IDLE, ...k }))

// Рефлекс на время боя. opts.margin() — запас от края, пока враг может
// ударить (его удар кидает на 2-4 блока: стоять вплотную к краю нельзя);
// сам край — никогда. Возвращает { stop, allow(depth, ms), stats }.
function guard (bot, { margin = () => 0 }: any = {}) {
  const ph = bot.physics
  if (!ph || typeof ph.simulatePlayer !== 'function') return { stop () {}, allow () {}, stats: {} }
  if (!bot._ndSimOrig) bot._ndSimOrig = ph.simulatePlayer
  const orig = bot._ndSimOrig
  const stats = { saves: 0, air: 0, idle: 0, why: {} }
  let lastGroundY = bot.entity ? bot.entity.position.y : 0
  let allowSafe = SAFE_FALL
  let allowUntil = 0
  let on = true
  // Настоящий тик от прогнозов (pathfinder тоже зовёт simulatePlayer) —
  // по объекту клавиш: mineflayer передаёт один и тот же объект каждый тик,
  // прогнозы создают свой на каждый расчёт.
  let realControl = null
  const seen = new WeakMap()
  const isReal = (c) => {
    if (realControl) return c === realControl
    const now = gameClock.now()
    const s = seen.get(c)
    if (!s) { seen.set(c, { last: now, n: 1 }); return false }
    if (now - s.last > 30) { s.n++; s.last = now }
    if (s.n >= 3) { realControl = c; return true }
    return false
  }
  const note = (why) => { stats.why[why] = (stats.why[why] || 0) + 1 }

  const filter = (state) => {
    if (state.onGround) lastGroundY = state.pos.y
    // A native movement plan already checked this exact body and its controls.
    // Keep the real integrator, but do not replace those controls with another
    // forecast while the confirmed owner remains healthy, current and nearby.
    const planned = bot._ndParkourForecast
    if (planned && planned.until > gameClock.now() && (bot.health ?? 0) >= planned.hp && state.pos.distanceTo(planned.from) <= .1) return
    // A supported body with no horizontal momentum or movement/jump request
    // cannot walk over an edge. Native physics still handles gravity, changed
    // support and fluid contact; actual motion or knockback resumes forecasting.
    if (state.onGround && state.vel.y <= 0 && Math.hypot(state.vel.x, state.vel.z) <= 1e-7 &&
      !state.control.forward && !state.control.back && !state.control.left && !state.control.right && !state.control.jump && !state.jumpQueued) { stats.idle++; return }
    if (state.isInWater || state.isInLava) return
    // Уже летим вниз с края — рулить поздно, дальше дело ведра (fallGuard).
    if (!state.onGround && state.pos.y < lastGroundY - 2) return
    const safe = gameClock.now() < allowUntil ? allowSafe : SAFE_FALL
    const groundY = state.onGround ? state.pos.y : lastGroundY
    const cache = new Map()
    // Дешёвая проверка: опасности в 5 блоках нет — нечего и считать.
    if (!hazardAround(bot, state.pos, 5, cache)) return
    const want = { ...IDLE }
    for (const k of Object.keys(IDLE)) want[k] = !!state.control[k]
    const m = state.onGround ? Math.max(0, margin() || 0) : 0
    const cur = state.onGround ? clearance(bot, state.pos, 1.2, cache, safe) : 0
    const opt = { groundY, cache, safe }
    const ok = (res) => {
      if (res.fall) return false
      if (!state.onGround || !res.rest) return true
      return clearance(bot, res.rest, 1.2, cache, safe) >= Math.min(m, cur - 0.05)
    }
    if (state.onGround) {
      const res = run(bot, state, want, { ...opt, hold: 2 })
      if (ok(res)) return
      const cands = []
      if (want.jump) cands.push({ ...want, jump: false })
      if (want.sprint) cands.push({ ...want, jump: false, sprint: false })
      if ((want.forward || want.back) && (want.left || want.right)) {
        cands.push({ ...IDLE, forward: want.forward, back: want.back })
        cands.push({ ...IDLE, left: want.left, right: want.right })
      }
      cands.push({ ...IDLE })
      cands.push({ ...IDLE, sneak: true })
      let pick = cands.find(c => ok(run(bot, state, c, { ...opt, hold: 2 })))
      if (!pick) {
        // Уже у самого края (отбросило): шаг туда, где запас больше.
        let best = -1
        for (const c of DIRS8) {
          const r = run(bot, state, c, { ...opt, hold: 3 })
          const sc = r.fall ? -1 : clearance(bot, r.rest, 1.2, cache, safe)
          if (sc > best) { best = sc; pick = c }
        }
        if (!pick || best < 0) pick = { ...IDLE, sneak: true }
        note('шаг от края')
      } else note(pick.sneak ? 'присел у края' : 'тормоз у края')
      stats.saves++
      // Метка «клавиши рефлекса»: спринт по правилам клиента (itemuse.js) их
      // спринт не включает (2026-09-26).
      state.control = { ...pick, _ndGuard: true }
      if (!pick.jump) state.jumpQueued = false
      return
    }
    // В воздухе (отбросило ударом, прыжок): куда сядем с этими клавишами —
    // клавиши до посадки (FIX, land), не на две секунды вперёд.
    const air = { ...opt, hold: 40, max: 40, land: FIX }
    const res = run(bot, state, { ...want, jump: false }, air)
    if (!res.fall) return
    let pick = null
    let bestT = -1
    // Рулить — как можно ближе к тому, чего хотел бой (FIX): сперва его же
    // клавиши без спринта, потом без клавиш, потом стороны по близости к его
    // ходу. Раньше первым шёл «вперёд со спринтом», что бы бой ни держал.
    let cands = [...DIRS8, { ...IDLE }]
    if (FIX) {
      const wx = (want.right ? 1 : 0) - (want.left ? 1 : 0)
      const wz = (want.forward ? 1 : 0) - (want.back ? 1 : 0)
      const sc = c => ((c.right ? 1 : 0) - (c.left ? 1 : 0)) * wx + ((c.forward ? 1 : 0) - (c.back ? 1 : 0)) * wz
      cands = [{ ...want, jump: false, sprint: false }, { ...IDLE }, ...DIRS8.slice().sort((a, b) => sc(b) - sc(a))]
    }
    for (const base of cands) {
      for (const sprint of [true, false]) {
        const c = { ...base, sprint: sprint && (base.forward || base.back || base.left || base.right) }
        const r = run(bot, state, c, air)
        if (!r.fall) { pick = c; bestT = Infinity; break }
        // Не спастись — тянуть к краю как можно дольше: может зацепиться.
        if (r.t > bestT) { bestT = r.t; pick = c }
      }
      if (bestT === Infinity) break
    }
    if (pick) {
      state.control = { ...pick, _ndGuard: true }
      state.jumpQueued = false
      stats.air++
      note(bestT === Infinity ? 'в полёте рулю от ямы' : 'в полёте тяну к краю')
    }
  }

  const wrapped = function (state, world) {
    try {
      if (on && state && state.control && typeof state.control === 'object' && isReal(state.control) && bot.entity) filter(state)
    } catch (e) {
      if (process.env.ND_DEBUG_EDGES) console.log('[edges] guard', e.message)
    }
    return orig.call(this, state, world)
  }
  ph.simulatePlayer = wrapped
  return {
    stats,
    // Намеренный спуск (со своего столба): падение до depth блоков — можно.
    // Клатч блоком (clutch.js) тоже видит намеренный спуск: bot._ndClutchAllowUntil.
    allow (depth, ms = 1500) {
      allowSafe = Math.max(SAFE_FALL, depth)
      allowUntil = gameClock.now() + ms
      bot._ndClutchAllowUntil = allowUntil
    },
    stop () {
      on = false
      if (bot._ndClutchAllowUntil === allowUntil) delete bot._ndClutchAllowUntil
      if (ph.simulatePlayer === wrapped) ph.simulatePlayer = orig
    }
  }
}

// ---------------------------------------------------------------- удары

function netheriteResist (items) {
  let n = 0
  for (const it of items || []) if (it && /^netherite_(helmet|chestplate|leggings|boots)$/.test(it.name)) n++
  return Math.min(1, n * RESIST_PER_NETHERITE)
}
// Сопротивление отбрасыванию: броня сущности (entity.equipment 2..5) или своя
// (слоты 5..8).
function resistOf (bot, e) {
  if (e === bot.entity) return netheriteResist([5, 6, 7, 8].map(s => bot.inventory.slots[s]))
  return netheriteResist((e.equipment || []).slice(2, 6))
}

// LivingEntity.knockback(s, x, z): скорость = старая/2 − (x, z)/|(x, z)|·s;
// вверх, если на земле, — min(0.4, vy/2 + s).
function knockback (vel, s, x, z, onGround) {
  const n = Math.hypot(x, z) || 1
  return new Vec3(vel.x / 2 - x / n * s, onGround ? Math.min(0.4, vel.y / 2 + s) : vel.y, vel.z / 2 - z / n * s)
}

// Скорость жертвы после удара: сперва 0.4 от бьющего (hurtServer), потом за
// спринт +0.5 по его взгляду (causeExtraKnockback). mineflayer: взгляд =
// (−sin yaw, −cos yaw), так что толчок «по взгляду» — это x = sin, z = cos.
// kb — уровень «Отдачи» на оружии бьющего (арена с чарами): Player.attack
// толкает вторым вызовом с силой 0.5 × (уровень + спринт) — getKnockback даёт
// +1 за уровень (effect minecraft:knockback, linear base 1), спринт ещё +1.
function hitVelocity ({ vel, pos, onGround }: any, from, lookYaw, { sprint = false, resist = 0, kb = 0 }: any = {}) {
  const k = 1 - resist
  let v = knockback(vel || new Vec3(0, 0, 0), KB_HIT * k, from.x - pos.x, from.z - pos.z, onGround)
  const extra = KB_SPRINT * ((sprint ? 1 : 0) + Math.max(0, kb || 0))
  if (extra > 0) v = knockback(v, extra * k, Math.sin(lookYaw), Math.cos(lookYaw), onGround)
  return v
}

// Полёт тела после удара той же физикой. Жертва смотрит на бьющего и держит
// «вперёд» (counter) — так гасят отбрасывание в воздухе; без counter — стоит.
function knockRun (bot, base, pos, vel, onGround, faceYaw, counter, cache, world?: any) {
  const st = cloneState(base, counter ? { ...IDLE, forward: true, sprint: true } : IDLE)
  st.pos = pos.clone()
  st.vel = vel.clone()
  st.onGround = onGround
  st.isInWater = false
  st.isInLava = false
  st.isInWeb = false
  st.yaw = faceYaw
  const groundY = onGround ? pos.y : pos.y - Math.max(0, support(bot, pos, cache).drop)
  // Полёт после удара ~10 тиков, потом скольжение: 28 тиков с запасом.
  return run(bot, st, st.control, { hold: 28, max: 28, groundY, cache, world })
}

function yawFrom (a, b) { return Math.atan2(-(b.x - a.x), -(b.z - a.z)) }

// Нас бьют из foePos со спринтом (взгляд на нас) — не в яму ли. Считаем с
// нашим встречным «вперёд» (рефлекс рулит в полёте) — если и так в яму,
// стоим спиной к обрыву.
function backToDrop (bot, foePos, { sprint = true, kb = 0 }: any = {}) {
  const me = bot.entity
  const cache = new Map()
  if (!hazardAround(bot, me.position, 6, cache)) return null
  const base = stateOf(bot)
  const v = hitVelocity({ vel: me.velocity, pos: me.position, onGround: me.onGround }, foePos, yawFrom(foePos, me.position), { sprint, kb, resist: resistOf(bot, me) })
  // Модель сходится с игрой (try-knock.js, 2026-09-26: толчок 0.4 — 1.99
  // блока и в замере, и в прогоне). Запас 10% — на пинг и на то, что его
  // позицию мы видим с опозданием: для себя берём худший случай.
  v.x *= 1.1; v.z *= 1.1
  const r = knockRun(bot, base, me.position, v, me.onGround, yawFrom(me.position, foePos), true, cache)
  return r.fall ? { fall: true, at: r.at, t: r.t } : null
}

// Яма по линии толчка (2026-09-26): от точки from через нас на dist блоков —
// под рамкой пусто глубже SAFE_FALL или лава (lethalAt). Для «не прыгать у
// края»: его спринт-удар (0.4 + 0.5, LivingEntity.knockback и
// Player.causeExtraKnockback) уносит тело в прыжке на 4–5 блоков — прыжок за
// критом, жест «прыжки», jump-reset к нему — только если по линии чисто.
function dropAlong (bot, from, dist = 4.5) {
  const me = bot.entity && bot.entity.position
  if (!me || !from) return false
  const cache = new Map()
  if (!hazardAround(bot, me, Math.ceil(dist) + 1, cache)) return false
  let dx = me.x - from.x
  let dz = me.z - from.z
  const n = Math.hypot(dx, dz)
  if (n < 1e-3) return hazardAround(bot, me, 2, cache)
  dx /= n; dz /= n
  for (let t = 0.25; t <= dist + 1e-6; t += 0.25) {
    if (lethalAt(bot, new Vec3(me.x + dx * t, me.y, me.z + dz * t), cache)) return true
  }
  return false
}

// Толкнуть его в яму. now — удар отсюда и сейчас сбросит его: 'hit' (хватит
// обычного, даже если он тянет назад), 'sprint' (нужен спринт-удар), null.
// stand — откуда бить (точка за ним на линии «яма → он»), если сейчас не
// выходит, а с другой стороны — да. ours — наш взгляд (yaw) на него.
function pushPlan (bot, foe, { vel = null, reach = 2.7, kb = null }: any = {}) {
  const cache = new Map()
  const fp = foe.position
  if (!hazardAround(bot, fp, 5, cache)) return null
  const world = worldOf(bot)
  const base = stateOf(bot)
  const resist = resistOf(bot, foe)
  const fv = vel ? new Vec3(vel.x, 0, vel.z) : new Vec3(0, 0, 0)
  // onGround чужих сущностей mineflayer не ведёт (всегда undefined — находка
  // mace.js 2026-09-26): на земле ли он — по опоре под рамкой.
  const onGround = support(bot, fp, cache).drop <= 0.05
  const me = bot.entity.position
  // Своя «Отдача» на том, чем бьём (арена с чарами) — толкает дальше.
  if (kb == null) { try { kb = bot.heldItem ? require('./read').enchLevel(bot, bot.heldItem, 'knockback') : 0 } catch { kb = 0 } }
  const outcome = (from, sprint, counter) => {
    const look = yawFrom(from, fp)
    const v = hitVelocity({ vel: fv, pos: fp, onGround }, from, look, { sprint, resist, kb })
    return knockRun(bot, base, fp, v, onGround, yawFrom(fp, from), counter, cache, world).fall
  }
  let now = null
  if (outcome(me, false, true)) now = 'hit'
  else if (outcome(me, true, true) || outcome(me, true, false)) now = 'sprint'
  if (now) return { now, stand: null }
  // Откуда бы вышло: 16 сторон вокруг него, бьём с края досягаемости.
  const bearing = yawFrom(me, fp)
  let best = null
  for (let i = 0; i < 16; i++) {
    const yaw = (i / 16) * Math.PI * 2
    // Точка бьющего: от него против направления толчка.
    const from = new Vec3(fp.x + Math.sin(yaw) * reach, fp.y, fp.z + Math.cos(yaw) * reach)
    if (!outcome(from, true, false)) continue
    // Нам там стоять можно: не над ямой и не у самого края.
    if (lethalAt(bot, from, cache) || clearance(bot, from, 0.6, cache) < 0.35) continue
    let dy = Math.abs(yaw - bearing) % (Math.PI * 2)
    if (dy > Math.PI) dy = Math.PI * 2 - dy
    const sure = outcome(from, true, true)
    const sc = dy - (sure ? 0.6 : 0)
    if (!best || sc < best.sc) best = { sc, from, yaw, sure }
  }
  return best ? { now: null, stand: best.from, look: best.yaw, sure: best.sure } : { now: null, stand: null }
}

// ---------------------------------------------------------------- ведро воды

// Сторож падения — всегда, не только в бою. Вода под ноги в последний тик до
// земли (BucketItem.use: луч от глаз на 4.5 блока; сервер считает от позиции
// последнего пакета движения, поэтому use_item уходит ПОСЛЕ пакета этого
// тика — setImmediate из physicsTick), вода гасит падение (LivingEntity.
// checkFallDamage: сначала updateInWaterState → fallDistance = 0, потом fallOn).
// Потом — обратно в ведро. В Аду вода испаряется — там не пробуем.
//
// Рука — сторожу (2026-09-26). Спуск 7–9 бл. с крыши коробки и со столба на
// арене: ведро «срабатывало», а воды не было. use_item несёт свой поворот
// (ServerGamePacketListenerImpl.handleUseItem: absSnapRotationTo по углам из
// пакета) и берёт предмет выбранного слота; сторож ставил слот и взгляд на
// тике физики, а use_item слал из setImmediate — между ними успевали чужой
// взгляд (спуск булавы mace.descend смотрит на цель каждый тик, таймер
// прицела), смена слота и bot.equip меча (перекладывает слоты кликами). Теперь
// слот, взгляд и use_item — одним синхронным куском после пакета позиции
// (afterPacket ниже, как в mace.js), а пока сторож взведён и три тика после
// броска, чужие смены слота, equip в руку и «использовать» правой ждут или
// отменяются (lockHand).
function afterPacket (bot, fn) {
  // The clock adapter emits after movement/tick_end, in this physical frame.
  // Retain the legacy fallback for unadapted clients and callers between ticks.
  let done = false
  const act = require('node:async_hooks').AsyncResource.bind(fn)
  const run = () => {
    if (done) return
    done = true
    bot.removeListener('physicsTick', run)
    bot.removeListener('ndMovementSent', run)
    try { act() } catch {}
  }
  bot.on('ndMovementSent', run)
  bot.prependListener('physicsTick', run)
  setImmediate(run)
}

function lockHand (bot) {
  if (bot._ndHandLock) return bot._ndHandLock
  const L: any = { until: 0, own: false, blocked: { slot: 0, equip: 0, use: 0 } }
  bot._ndHandLock = L
  L.on = () => !L.own && gameClock.now() < L.until
  L.hold = (ms) => { L.until = Math.max(L.until, gameClock.now() + ms) }
  L.as = (fn) => { const was = L.own; L.own = true; try { return require("./reflex-lock").emergency(bot._ndReflexSession, fn) } finally { L.own = was } }
  // Слот, который ставит сервер (held_item_slot), — всегда: иначе рассинхрон.
  let srv = false
  try { bot._client.prependListener('held_item_slot', () => { srv = true; setImmediate(() => { srv = false }) }) } catch {}
  const origSlot = bot.setQuickBarSlot
  bot.setQuickBarSlot = function (slot) {
    if (L.on() && !srv && slot !== bot.quickBarSlot) { L.blocked.slot++; return }
    return origSlot.apply(this, arguments)
  }
  const wait = async () => { const t0 = gameClock.now(); while (L.on() && gameClock.now() - t0 < 2500) await new Promise<any>(r => gameClock.setTimeout(r, 25)) }
  const origEquip = bot.equip
  bot.equip = async function (item, dest) {
    if ((dest == null || dest === 'hand') && L.on()) { L.blocked.equip++; await wait() }
    return origEquip.apply(this, arguments)
  }
  const origAct = bot.activateItem
  bot.activateItem = function (offHand) {
    if (!offHand && L.on()) { L.blocked.use++; return }
    return origAct.apply(this, arguments)
  }
  const origConsume = bot.consume
  if (typeof origConsume === 'function') {
    bot.consume = async function () {
      if (L.on()) { L.blocked.use++; await wait() }
      return origConsume.apply(this, arguments)
    }
  }
  return L
}

function installFallGuard (session, { minFall = 6 }: any = {}) {
  const bot = session.bot
  if (!bot || bot._ndFallGuard) return bot && bot._ndFallGuard
  const st: any = { peak: null, placed: null, moving: false, fired: 0, saved: 0, picked: 0, missed: 0, busy: false }
  const hand = lockHand(bot)
  // Блочный клатч (clutch.js, 30.09.2026): там, где воду не поставить или посадка
  // «плохая» (Ад, ведра нет в хотбаре, листва/полублок, лава, пустота), — блок на
  // видимую грань в первые тики падения. Его решение — первым в тике: 'water' —
  // дальше как было (ведро), 'clutch' — ведро молчит, 'none' — как было.
  // ND_CLUTCH=0 — выключить.
  let blockClutch = null
  if (process.env.ND_CLUTCH !== '0' && bot.registry && bot.world && typeof bot._genericPlace === 'function') {
    try {
      const Block = require('prismarine-block')(bot.registry)
      blockClutch = clutch.install(session, {
        listen: false, Vec3, PlayerState, hand, afterPacket,
        faceAim: require('./pick').faceAim,
        mlgDrop, mlgLandingBad, waterMinFall: minFall,
        makeBlock (p, stateId = bot.registry.blocksByName.cobblestone.defaultState) {
          const b = Block.fromStateId(stateId, 0)
          b.position = p.floored()
          return b
        }
      })
      bot.on('nd_clutch', (e) => {
        if (/^(placed|saved|denied|timeout|damaged_or_unconfirmed|stale|send_error|to_bar_failed|no_bar_slot)$/.test(e.what) || (e.what === 'no_face' && !blockClutch._noFaceSaid)) {
          if (e.what === 'no_face') blockClutch._noFaceSaid = true
          const p = bot.entity && bot.entity.position
          console.log('[clutch]', JSON.stringify({ ...e, cell: e.cell && [e.cell.x, e.cell.y, e.cell.z], ref: undefined, face: undefined, y: p && Math.round(p.y * 100) / 100, hp: bot.health }))
        }
        if (e.what === 'landed' || e.what === 'saved' || e.what === 'damaged_or_unconfirmed') blockClutch._noFaceSaid = false
      })
    } catch (err) { console.log('[clutch] не подключён:', err.message) }
  }
  st.clutch = blockClutch
  if (!blockClutch && process.env.ND_CLUTCH !== '0') console.log('[clutch] нет: registry/world/_genericPlace', !!bot.registry, !!bot.world, typeof bot._genericPlace)
  st.hand = hand.blocked
  const hotbar = (name) => {
    for (let s = 36; s <= 44; s++) { const it = bot.inventory.slots[s]; if (it && it.name === name) return s }
    return -1
  }
  const emit = (what, extra: any = {}) => { try { bot.emit('nd_mlg', { what, ...extra }) } catch {} }
  const toHotbar = async () => {
    // Перекладка не дольше 3 с: зависший флаг навсегда оставил бы ведро в
    // рюкзаке, а прыжки — выключенными.
    if (st.moving && gameClock.now() - st.moving < 3000) return
    // В творческом клики по рюкзаку сервер ведёт иначе, и ведро «в хотбаре»
    // было только у клиента (ферма 30.09, mlg-final-1: первый заход, −5 хп).
    if (!survivalMode(bot)) return
    const wb = bot.inventory.items().find(i => i.name === 'water_bucket')
    if (!wb || (wb.slot >= 36 && wb.slot <= 44)) return
    st.moving = gameClock.now()
    try {
      // Свободный слот хотбара или самый дешёвый — не оружие и не то, что в руке.
      const sel = 36 + bot.quickBarSlot
      const keep = /sword|_axe|bow|crossbow|trident|mace|totem|golden_apple/
      let dest = -1
      for (let k = 36; k <= 44; k++) if (k !== sel && !bot.inventory.slots[k]) { dest = k; break }
      if (dest < 0) for (let k = 36; k <= 44; k++) if (k !== sel && !keep.test(bot.inventory.slots[k].name)) { dest = k; break }
      if (dest >= 0) await bot.moveSlotItem(wb.slot, dest)
      else emit('no_bar_slot')
    } catch (e) { emit('to_bar_failed', { err: e.message }) } finally { st.moving = false }
  }
  const inWaterNow = () => {
    const p = bot.entity.position
    for (const dy of [0, 0.5]) { const b = bot.blockAt(p.offset(0, dy, 0), false); if (b && b.name === 'water') return true }
    return !!bot.entity.isInWater
  }
  const onTick = () => {
    try {
      let clutchChoice: any = { action: 'none' }
      if (blockClutch) {
        try {
          clutchChoice = blockClutch.step()
          const ee = bot.entity
          // Падаем быстро, а клатч молчит не из-за воды/безопасной посадки — раз за полёт в журнал.
          if (ee && !ee.onGround && ee.velocity && ee.velocity.y < -0.5 && clutchChoice.action === 'none' && !/^(safe_landing|natural_water|on_ground)$/.test(clutchChoice.why) && survivalMode(bot) && !blockClutch._whySaid) {
            blockClutch._whySaid = true
            console.log('[clutch] молчит', JSON.stringify({ ...clutchChoice, y: Math.round(ee.position.y * 100) / 100, peak: blockClutch.peak, dbg: blockClutch._dbg }))
          }
          if (ee && ee.onGround) blockClutch._whySaid = false
        } catch (err) {
          // Ошибка клатча не должна молчать (и не должна валить ведро): раз в 10 с — в журнал.
          if (gameClock.now() - (blockClutch._errAt || 0) > 10000) { blockClutch._errAt = gameClock.now(); console.log('[clutch] ошибка', err && err.stack ? err.stack.split(String.fromCharCode(10)).slice(0, 3).join(' | ') : err) }
        }
      }
      const e = bot.entity
      if (!e || !e.position || (bot.health ?? 20) <= 0) { st.peak = null; return }
      // У дракона свой сторож (dragon.js fallGuard) — не драться с ним за руку.
      if (session.current && session.current.name === 'dragon') { st.peak = null; return }
      // В творческом падение не ранит, а вылитое ведро «промахом» уводило
      // прыжки в осторожный режим (ферма 30.09, mlg-final-3: телепорты сцены).
      if (!survivalMode(bot)) { st.peak = null; st.placed = null; return }
      const p = e.position
      // Уже приземлялись, а тело снова высоко в воздухе (подбросили,
      // телепорт) — новое падение важнее старой лужи.
      if (st.placed && st.placed.landed && !e.onGround && !inWaterNow() && p.y > st.placed.pos.y + 3) st.placed = null
      // Приземлились в свою воду — через пару тиков забрать её.
      if (st.placed) {
        const pl = st.placed
        if (e.onGround || inWaterNow()) {
          if (!pl.landed) { pl.landed = gameClock.now(); pl.hpLand = bot.health ?? 20 }
          const since = gameClock.now() - pl.landed
          // Спасло ли — по здоровью: блок воды приходит клиенту позже, чем
          // сервер уже погасил им падение (прогон 2026-09-26: «промах» без урона).
          if (!pl.said && since >= 300) {
            pl.said = true
            if ((bot.health ?? 0) >= pl.hpAir - 0.5) { st.saved++; emit('saved', { fall: pl.fall, hp: bot.health }) } else { st.missed++; st.missedAt = gameClock.now(); emit('missed', { fall: pl.fall, hp: bot.health }) }
          }
          if (since < 150) return
          // Вода — в клетке посадки или внутри залитого блока под ней (нижний
          // полублок: ведро заливает его, а не клетку над ним — ферма 30.09,
          // mlg-surf-1: урона нет, а вода оставалась в полублоке 8 из 8).
          const w = waterAt(bot, pl.pos)
          if (w && !w.position.equals(pl.pos)) pl.pos = w.position
          if (!w) {
            if (pl.tries && hotbar('water_bucket') >= 0) { st.picked++; emit('picked'); st.placed = null } else if (since > 1200) { emit(pl.tries ? 'pickup_failed' : 'no_water_block'); st.placed = null }
            return
          }
          if (gameClock.now() - (pl.lastTry || 0) < 250) return
          if (pl.tries >= 6) { st.placed = null; emit('pickup_failed'); return }
          if (hotbar('bucket') < 0) { st.placed = null; return }
          pl.tries = (pl.tries || 0) + 1
          pl.lastTry = gameClock.now()
          // reflex-lock делает даже force-look асинхронным: клик ждёт поворота.
          hand.hold(200)
          setImmediate(() => hand.as(async () => {
            try {
              const q = bot.entity.position
              const c = pl.pos.offset(0.5, 0.3, 0.5)
              const eye = q.offset(0, EYE, 0)
              const yaw = Math.atan2(-(c.x - eye.x), -(c.z - eye.z))
              const pitch = Math.atan2(c.y - eye.y, Math.hypot(c.x - eye.x, c.z - eye.z))
              await bot.look(yaw, pitch, true)
              if (st.placed !== pl) return
              hand.as(() => {
                const b = hotbar('bucket')
                if (b < 0) return
                if (bot.quickBarSlot !== b - 36) bot.setQuickBarSlot(b - 36)
                bot.activateItem()
                hand.hold(150)
              })
            } catch {}
          }))
          return
        }
        if (gameClock.now() - pl.t > 3000) { st.placed = null; st.missed++; st.missedAt = gameClock.now(); emit('missed') }
        return
      }
      if (e.onGround || inWaterNow() || e.isInLava) { st.peak = null; st.busy = false; return }
      if (st.peak === null || p.y > st.peak) st.peak = p.y
      // Клатч взял падение на себя — ведро не трогает руку.
      if (clutchChoice.action === 'clutch') return
      if (e.velocity.y > -0.2) return
      const dim = String((bot.game && bot.game.dimension) || '')
      if (/nether/.test(dim)) return
      // Куда садимся: самая высокая опора под хитбоксом (до 80 блоков).
      let top = -Infinity; let wet = false; let cell = null
      for (const [sx, sz] of CORNERS) {
        const bx = Math.floor(p.x + sx * (HALF - 1e-3)); const bz = Math.floor(p.z + sz * (HALF - 1e-3))
        for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 80; y--) {
          const b = bot.blockAt(new Vec3(bx, y, bz), false)
          if (!b) break
          if (b.name === 'water' || b.name === 'bubble_column') { if (y + 1 > top) { top = y + 1; wet = true; cell = null } break }
          if (b.boundingBox === 'block') { if (y + 1 > top) { top = y + 1; wet = false; cell = new Vec3(bx, y + 1, bz) } break }
        }
      }
      if (!Number.isFinite(top) || wet) return
      // Свой заряд ветра (mace.js, 2026-09-26): урон от падения — только ниже
      // точки всплеска (Player.causeFallDamage); сядем не ниже неё — ведро не
      // нужно, а смена слота на ведро сорвала бы удар булавой на спуске.
      if (typeof bot._ndWindFall === 'function' && bot._ndWindFall(top)) return
      const fall = st.peak - top
      const hp = bot.health ?? 20
      // Урон = floor(высота − 3); ведро — когда это 3+ хп или смерть.
      if (fall - SAFE_FALL < Math.min(minFall - SAFE_FALL, hp - 1)) return
      st.busy = true
      if (hotbar('water_bucket') < 0) { toHotbar(); return }
      // Взведён: рука — сторожу до броска (чужой equip ждёт, слот не меняется).
      hand.hold(250)
      const h = p.y - top
      // Сервер кинет луч от глаз этой позиции (пакет этого тика уйдёт раньше
      // use_item): дотянуться — h + 1.62 ≤ 4.5. Выше — ждём следующий тик,
      // если он ещё не земля; иначе — сейчас, другого не будет.
      const next = h + e.velocity.y
      if (h + EYE > USE_RANGE - 0.08 && next > 0.05) return
      if (h <= 0) return
      // Спуск булавы (mace.descend) — ведро в последний тик: удар с падения
      // обнуляет падение (MaceItem.postHurtEnemy), и он бьёт у самой земли;
      // раньше ведро отнимало у него руку и взгляд (2026-09-26).
      if (bot._ndDescend && next > 0.05) return
      // Куда ляжет вода: луч прямо вниз — в колонку под центром; её верх
      // дальше руки (центр над ямой, опора — под углом) — целим в верх той
      // клетки, на которую сядем.
      let aim = null
      const cx = Math.floor(p.x); const cz = Math.floor(p.z)
      let land = null
      for (let y = Math.floor(p.y); y >= Math.floor(p.y + EYE - USE_RANGE); y--) {
        const b = bot.blockAt(new Vec3(cx, y, cz), false)
        if (b && b.boundingBox !== 'empty') { land = new Vec3(cx, y + 1, cz); break }
      }
      if (!land && cell) { land = cell; aim = cell.offset(0.5, 0, 0.5) }
      const landCell = land || new Vec3(cx, top, cz)
      st.fired++
      st.placed = { t: gameClock.now(), pos: landCell, fall: Math.round(fall), hpAir: hp }
      const pl = st.placed
      emit('fired', { fall: Math.round(fall), h: Math.round(h * 100) / 100 })
      afterPacket(bot, () => hand.as(async () => {
        try {
          // Удар булавы этого же тика (mace.descend) — первым: он с высоты.
          hand.as(() => {
            const smash = bot._ndSmashNow
            if (typeof smash === 'function') { bot._ndSmashNow = null; try { smash() } catch {} }
          })
          if (hotbar('water_bucket') < 0) return
          const q = bot.entity.position
          if (aim) {
            const eye = q.offset(0, EYE, 0)
            await bot.look(Math.atan2(-(aim.x - eye.x), -(aim.z - eye.z)), Math.atan2(aim.y - eye.y, Math.hypot(aim.x - eye.x, aim.z - eye.z)), true)
          } else await bot.look(bot.entity.yaw, -Math.PI / 2, true)
          if (st.placed !== pl) return
          hand.as(() => {
            const s = hotbar('water_bucket')
            if (s < 0) return
            const slot0 = bot.quickBarSlot
            if (bot.quickBarSlot !== s - 36) bot.setQuickBarSlot(s - 36)
            if (process.env.ND_DEBUG_MLG) console.log('[mlg-dbg] выстрел', JSON.stringify({ dt: gameClock.now() - pl.t, y: Math.round(q.y * 100) / 100, vy: Math.round(bot.entity.velocity.y * 100) / 100, slot0, slot: bot.quickBarSlot, want: s - 36, held: bot.heldItem && bot.heldItem.name, aim: !!aim, barAgo: st.barAt ? gameClock.now() - st.barAt : null }))
            bot.activateItem()
            hand.hold(150)
          })
        } catch {}
      }))
    } catch (err) {
      if (process.env.ND_DEBUG_EDGES) console.log('[edges] fall', err.message)
    }
  }
  bot.on('physicsTick', onTick)
  st.toHotbar = toHotbar
  // Когда ведро легло в хотбар: перекладку кликами сервер принимает не сразу,
  // и прыжок в первые мгновения — вода из пустой руки (ферма 30.09, mlg-drop-1:
  // перекладка и прыжок за 1.3 с — промах, −5 хп).
  try {
    bot.inventory.on('updateSlot', (slot, was, now) => {
      if (slot >= 36 && slot <= 44 && now && now.name === 'water_bucket' && !(was && was.name === 'water_bucket')) st.barAt = gameClock.now()
    })
  } catch {}
  bot._ndFallGuard = st
  return st
}

// Прыжок с ведром как ход, а не только спасение (пользователь 30.09.2026:
// спидраннеры прыгают с высоты и гасят падение водой вместо лестниц, обходов
// и столбов; «даже блоков с 50»). Сторож выше ловит любое падение; здесь — на
// сколько блоков pathfinder'у можно планировать спуск.
// Ферма 30.09 (mlg-drop-4, mlg-surf-1/2): 40 из 40 с 8–60 блоков без урона,
// вода возвращена всегда; трава, снег, песок — так же; листва и заборы воду
// в себя забирают — туда прыжок не планируется (mlgLandingBad ниже).
// Смело — до MLG_MAX при хп от MLG_BOLD_HP. Промах за последние 30 мин —
// осторожно: не глубже, чем промах оставит MLG_SAFE_RESERVE хп.
// Ад — нет (вода испаряется), у дракона свой сторож и свои ходы.
// ND_MLG_RESERVE — постоянный запас хп вместо смелого режима, ND_MLG_MAX —
// предел, ND_MLG=0 — выключить.
const MLG_MIN = 6
const MLG_SETTLE = 300
const MLG_SAFE_RESERVE = 4
const MLG_BOLD_HP = 8
const MLG_MISS_MS = 30 * 60 * 1000
function survivalMode (bot) {
  const m = bot && bot.game && bot.game.gameMode
  return m == null || m === 'survival' || m === 'adventure'
}
function envNum (name) {
  const v = process.env[name]
  return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null
}
function mlgDrop (session) {
  const bot = session && session.bot
  if (!bot || !bot.entity || !bot.inventory) return { ok: false, why: 'нет тела' }
  if (process.env.ND_MLG === '0' || session.mlgOff) return { ok: false, why: 'выключено' }
  const st = bot._ndFallGuard
  if (!st) return { ok: false, why: 'нет сторожа падения' }
  if (/nether/.test(String((bot.game && bot.game.dimension) || ''))) return { ok: false, why: 'Ад: вода испаряется' }
  if (session.current && session.current.name === 'dragon') return { ok: false, why: 'бой с драконом' }
  if (!survivalMode(bot)) return { ok: false, why: 'не выживание' }
  if (!bot.inventory.items().some(i => i.name === 'water_bucket')) return { ok: false, why: 'нет ведра воды' }
  // Только из хотбара, и не в первые MLG_SETTLE мс после перекладки (см. barAt).
  const inBar = bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')
  if (!inBar) return { ok: false, why: 'ведро не в хотбаре', toBar: true }
  if (st.barAt && gameClock.now() - st.barAt < MLG_SETTLE) return { ok: false, why: 'ведро только что в хотбаре', retryMs: MLG_SETTLE - (gameClock.now() - st.barAt) + 20 }
  const hp = Math.floor(bot.health ?? 20)
  const max = envNum('ND_MLG_MAX') > 0 ? envNum('ND_MLG_MAX') : 60
  const reserve = envNum('ND_MLG_RESERVE')
  const recentMiss = !!(st.missedAt && gameClock.now() - st.missedAt < MLG_MISS_MS)
  const bold = reserve == null && !recentMiss && hp >= MLG_BOLD_HP
  const drop = bold ? max : Math.min(max, hp + SAFE_FALL - (reserve == null ? MLG_SAFE_RESERVE : reserve))
  if (drop < MLG_MIN) return { ok: false, why: 'мало хп', drop }
  return { ok: true, drop, bold }
}

// Блок держит воду в себе (waterlogged): ведро заливает его, а не клетку над
// ним. Лист, ступень, забор, верхний полублок — тело садится сверху мимо воды:
// ферма 30.09, mlg-surf-1, листва — 0 из 8, с 40 блоков смерть. Нижний
// полублок спас (тело стоит внутри залитой половины), но прыжок на него
// планировать незачем.
function waterloggable (b) {
  if (!b || typeof b.getProperties !== 'function') return false
  try { return 'waterlogged' in (b.getProperties() || {}) } catch { return false }
}
function waterAt (bot, pos) {
  for (const p of [pos, pos.offset(0, -1, 0)]) {
    const b = bot.blockAt(p, false)
    if (!b) continue
    if (b.name === 'water') return b
    try { if (b.getProperties && b.getProperties().waterlogged === true) return b } catch {}
  }
  return null
}
// Куда прыгать с ведром нельзя: вода не встанет над опорой, или сама опора ранит.
const MLG_BAD_FLOOR = /^(cactus|magma_block|campfire|soul_campfire|pointed_dripstone|sweet_berry_bush|powder_snow)$/
function mlgLandingBad (bot, x, y, z) {
  const Vec = Vec3
  const under = bot.blockAt(new Vec(x, y - 1, z), false)
  const feet = bot.blockAt(new Vec(x, y, z), false)
  if (!under) return true
  if (waterloggable(under) || MLG_BAD_FLOOR.test(under.name)) return true
  if (feet && (waterloggable(feet) || MLG_BAD_FLOOR.test(feet.name))) return true
  return false
}

// Спуск глубже обычного стоит времени: вылить воду, забрать её — ~1 с, это
// ~4 шага. Без надбавки pathfinder прыгал бы с 20 блоков ради одного шага.
// Ноги вниз на 4–5 — без воды (сторож ставит её с 6), это 1–2 хп, и урон
// рвёт само намерение (ферма 30.09, mlg-surf-2: goto «interrupted» у подножия
// столба). Такие спуски не планировать вовсе — как до ведра (maxDropDown 4
// пускал ноги лишь на 3).
const MLG_COST = 4
function priceDrops (movements) {
  if (!movements || movements._ndMlgPriced) return movements
  movements._ndMlgPriced = true
  for (const name of ['getMoveDropDown', 'getMoveDown']) {
    const orig = movements[name]
    if (typeof orig !== 'function') continue
    movements[name] = function (node, ...rest: any[]) {
      const neighbors = rest[rest.length - 1]
      const n0 = Array.isArray(neighbors) ? neighbors.length : 0
      const out = orig.call(this, node, ...rest)
      if (Array.isArray(neighbors)) {
        for (let i = neighbors.length - 1; i >= n0; i--) {
          const m = neighbors[i]
          if (!m) continue
          const d = node.y - m.y
          if (d >= MLG_MIN) {
            if (this.bot && mlgLandingBad(this.bot, m.x, m.y, m.z)) { neighbors.splice(i, 1); continue }
            m.cost += MLG_COST
          } else if (d > SAFE_FALL) neighbors.splice(i, 1)
        }
      }
      return out
    }
  }
  return movements
}

// ---------------------------------------------------------------- наверх

// Вернуться наверх к нему: выпал с арены в небе живым (ведро спасло) и стоял
// внизу, глядя на него за полсотни блоков (2026-09-25: «не понимает, что между
// ними огромная высота»). Столб из блоков под ногами (build.towerUp) — в
// шахте, которая выходит на его пол: дыра в полу рядом с ним (край дыры —
// опора, над ним свободно). Нет такой — столб на месте, потолок над головой
// выломать (tools.breakFast) и дальше вверх.
// Куда подниматься обратно на арену (2026-09-27, пользователь: «поднимался
// на блоке, упёрся в обсидиан, в потолок — не увидел, что не может подняться»).
// Раньше дыра искалась в 20 блоках от НЕГО и только с землёй на нашей высоте,
// а не нашлась — столб на месте, в обсидиановый пол (9 с киркой, 12 с — отказ).
// Теперь: открытые клетки пола (дыры, выбитый взрывом светокамень) в radius от
// НАС; под дырой — земля у нашей высоты (±6) или свободный столб на нашей
// высоте (мы на уступе или старом столбе — к нему мост, pathfinder ставит
// блоки); нет дыр — клетка пола, которая ломается быстро (светокамень рукой
// ~0.5 с), под ней столб, её — ломать. Цена — путь по земле, мост, ломка.
function findShaft (bot, target, { radius = 40, archer: shooter = false, floorY: floorAt = null, exclude = null, digNear = 3000 }: any = {}) {
  // floorAt — уровень ног на поле арены (он сам может стоять на столбе выше).
  const Ty = floorAt != null ? Math.floor(floorAt + 1e-6) : Math.floor(target.position.y + 1e-6)
  const floorY = Ty - 1
  const me = bot.entity.position
  const myY = Math.floor(me.y + 1e-3)
  const tools = require('./tools')
  const pass = (p) => { const b = bot.blockAt(p, false); return !!b && b.boundingBox === 'empty' && !/lava|water|fire|cobweb/.test(b.name) }
  const solidAt = (p) => { const b = bot.blockAt(p, false); return !!b && b.boundingBox === 'block' }
  const cx = Math.floor(me.x); const cz = Math.floor(me.z)
  // Столб от уровня y вверх до пола свободен?
  const openUp = (x, z, y) => { for (let yy = y; yy < floorY; yy++) if (!pass(new Vec3(x, yy, z))) return false; return true }
  // Где стоять под клеткой пола (x, z): земля у нашей высоты или наш уровень.
  const standUnder = (x, z) => {
    for (let y = floorY - 1; y >= myY - 8; y--) {
      const p = new Vec3(x, y, z)
      if (pass(p)) continue
      if (solidAt(p) && Math.abs(y + 1 - me.y) <= 6 && Ty - (y + 1) >= 2) return { gy: y + 1, bridge: false }
      break
    }
    if (myY < floorY - 1 && openUp(x, z, myY)) return { gy: myY, bridge: !solidAt(new Vec3(x, myY - 1, z)) }
    return null
  }
  // Он у выхода — ударит, пока вылезаем; лук у края — весь подъём под
  // стрелами. Как человек: вылезать подальше от него (дыр в полу арены 8).
  const him = target.position
  const hand = target.equipment && target.equipment[0] ? target.equipment[0].name : ''
  // Лук в руке сейчас или стрелял в этом бою (меняет лук на меч и обратно).
  const archer = shooter || hand === 'bow' || hand === 'crossbow'
  const threat = (x, z, n) => {
    const dh = Math.hypot(x + 0.5 - him.x, z + 0.5 - him.z)
    let c = dh < 6 ? (6 - dh) * 5 : 0
    if (archer && dh < 24) c += n * 1.6 * (1 - dh / 24)
    return c
  }
  let best = null
  const consider = (x, z, digMs) => {
    const u = standUnder(x, z)
    if (!u) return
    const cost = Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) + Math.abs(u.gy - me.y) * 2 + (u.bridge ? 6 : 0) + digMs / 250 + threat(x, z, Ty - u.gy)
    if (!best || cost < best.cost) best = { x, z, gy: u.gy, n: Ty - u.gy, cost, bridge: u.bridge, digMs: Math.round(digMs) }
  }
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz > radius * radius) continue
      const x = cx + dx; const z = cz + dz
      if (exclude && exclude.has(x + ',' + z)) continue
      const top = new Vec3(x, floorY, z)
      if (!pass(top.offset(0, 1, 0)) || !pass(top.offset(0, 2, 0))) continue
      if (pass(top)) {
        // Открытая клетка пола: край, с которого шагнуть на пол.
        let rim = false
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = top.offset(ax, 0, az)
          if (solidAt(n) && pass(n.offset(0, 1, 0)) && pass(n.offset(0, 2, 0))) { rim = true; break }
        }
        if (rim) consider(x, z, 0)
        continue
      }
      // Закрытая клетка пола: ломать, если быстро (светокамень, дерево, песок).
      const b = bot.blockAt(top, false)
      if (!b || b.boundingBox !== 'block') continue
      const ms = tools.bestFor(bot, b).ms
      // Прямо над нами (или рядом) — ломать и дольше (digNear): застряли под
      // полом на своём столбе, а до дыр не дойти (живая арена 2026-09-27).
      if (ms <= 3000 || (ms <= digNear && Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) <= 1.6)) consider(x, z, ms)
    }
  }
  return best
}

async function climbBack (bot, ctl, target, { maxMs = 60000, beforeStep = null, archer = false, floorY = null, exclude = null, digNear = 3000 }: any = {}) {
  const { goals } = require('mineflayer-pathfinder')
  const { towerUp, pickFiller } = require('./build')
  const tools = require('./tools')
  const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
  const t0 = gameClock.now()
  const Ty = floorY != null ? Math.floor(floorY + 1e-6) : Math.floor(target.position.y + 1e-6)
  const fillers = () => fillerCount(bot)
  // Обсидиан — последним: он нужен на коробки, но лучше подняться им, чем стоять внизу.
  const towerItem = () => pickFiller(bot) ? null : (bot.inventory.items().find(i => i.name === 'obsidian' || i.name === 'crying_obsidian') || {}).name || null
  const need0 = Ty - Math.floor(bot.entity.position.y)
  if ((!pickFiller(bot) && !towerItem()) || fillers() < need0) return { ok: false, why: `блоков ${fillers()}, надо ${need0}`, need: need0, have: fillers() }
  const shaft = findShaft(bot, target, { archer, floorY: Ty, exclude, digNear })
  if (process.env.ND_DEBUG_CLIMB) console.log('[climbBack] shaft', JSON.stringify({ me: bot.entity.position.floored(), him: target.position.floored(), hand: target.equipment && target.equipment[0] && target.equipment[0].name, archer, shaft }))
  let how = 'столб на месте, потолок — ломать'
  if (!shaft) return { ok: false, how: 'нет дыры в полу и нет пола, что ломается быстро', placed: 0, why: 'над головой только обсидиан', seconds: 0 }
  if (shaft) {
    how = shaft.digMs ? `под быстрый пол у ${shaft.x},${shaft.z} (${shaft.n} бл., ломать ${(shaft.digMs / 1000).toFixed(1)} с)` : `через дыру в полу у ${shaft.x},${shaft.z} (${shaft.n} бл.${shaft.bridge ? ', мостом' : ''})`
    try {
      bot.pathfinder.setGoal(new goals.GoalBlock(shaft.x, shaft.gy, shaft.z))
      const until = gameClock.now() + (shaft.bridge ? 30000 : 20000)
      // Пути нет (стоим на своём столбе под полом) — не ждать 20 с впустую.
      let noPath = 0
      const onPath = (r) => { if (r && r.status === 'noPath') noPath++ }
      bot.on('path_update', onPath)
      try {
        while (gameClock.now() < until && !ctl.aborted && noPath < 2) {
          const p = bot.entity.position
          if (Math.floor(p.x) === shaft.x && Math.floor(p.z) === shaft.z && Math.abs(p.y - shaft.gy) < 1.1) break
          await sleep(100)
        }
      } finally { bot.removeListener('path_update', onPath) }
    } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    let p = bot.entity.position
    if (!(Math.floor(p.x) === shaft.x && Math.floor(p.z) === shaft.z)) {
      // Не дошли, а стоим высоко — на своём столбе под сплошным полом (живая
      // арена 2026-09-27: 53 блока столба с земли, упёрся в край пола; кирки
      // нет — «небо и порох»). Как человек: мост под потолком к столбу дыры на
      // своём уровне, потом вверх сквозь неё.
      const myY2 = Math.floor(p.y + 1e-3)
      const dist = Math.abs(shaft.x - Math.floor(p.x)) + Math.abs(shaft.z - Math.floor(p.z))
      const passAt = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z), false); return !!b && b.boundingBox === 'empty' && !/lava|water|fire|cobweb/.test(b.name) }
      let open = true
      for (let yy = myY2; yy <= Ty + 1 && open; yy++) if (!passAt(shaft.x, yy, shaft.z)) open = false
      if ((shaft.bridge || myY2 > shaft.gy + 1) && dist <= 24 && open && fillers() >= dist + (Ty - myY2) + 2) {
        const br = await bridgeUnder(bot, ctl, shaft.x, shaft.z, { maxBlocks: dist + 2 })
        p = bot.entity.position
        how += br.ok ? ' — мостом под полом' : ' — мост под полом не вышел: ' + br.why
      }
      if (!(Math.floor(p.x) === shaft.x && Math.floor(p.z) === shaft.z)) return { ok: false, how, placed: 0, why: 'до места под дырой не дошёл', shaft, seconds: Math.round((gameClock.now() - t0) / 1000) }
    }
  }
  // Вверх, кусками: наполнитель пересчитывать (стопка кончается).
  let placed = 0
  while (!ctl.aborted && gameClock.now() - t0 < maxMs && Math.floor(bot.entity.position.y + 1e-6) < Ty) {
    const f = bot.entity.position.floored()
    for (const up of [2, 3]) {
      const b = bot.blockAt(f.offset(0, up, 0), false)
      if (b && b.boundingBox === 'block') {
        // Ломать только быстрое (светокамень выбранной клетки, мусор): в
        // обсидиан над головой не упираться.
        // Наверху столба потолок — ломать и обсидиан, если кирка берёт его за 12 с
        // (живая арена 2026-09-27: дыру над шахтой закрыли, 9.4 с алмазной —
        // «слишком долго» при пределе 3.5 с, и 50 блоков столба впустую).
        const r = await tools.breakFast(bot, b.position, { maxMs: Math.max(12000, ((shaft && shaft.digMs) || 0) + 2000) }).catch(() => ({ ok: false }))
        if (process.env.ND_DEBUG_CLIMB) console.log('[climbBack] ceiling', JSON.stringify({ at: b.position, name: b.name, up, r, onGround: bot.entity.onGround, held: bot.heldItem && bot.heldItem.name, plan: tools.bestFor(bot, bot.blockAt(b.position) || b) && tools.bestFor(bot, bot.blockAt(b.position) || b).ms }))
        if (!r.ok && up === 2) return { ok: false, how, placed, why: `не выломал потолок ${b.name}`, shaft, seconds: Math.round((gameClock.now() - t0) / 1000) }
      }
    }
    const left = Ty - Math.floor(bot.entity.position.y + 1e-6)
    const r = await towerUp(bot, ctl, Math.min(8, left), { sneak: true, fast: true, beforeStep, item: towerItem() })
    placed += (r && r.placed) || 0
    if (!r || !r.placed) {
      const again = await towerUp(bot, ctl, 1, { sneak: true, fast: true, beforeStep, item: towerItem() })
      if (!again || !again.placed) {
        const why = [].concat((again && (again.why || again.reason)) || [], (r && (r.why || r.reason)) || []).join('; ')
        return { ok: false, how, placed, why: why || 'столб не растёт', shaft, seconds: Math.round((gameClock.now() - t0) / 1000) }
      }
      placed++
    }
  }
  try { bot.setControlState('sneak', false) } catch {}
  const ok = Math.floor(bot.entity.position.y + 1e-6) >= Ty
  return { ok, how, placed, shaft, seconds: Math.round((gameClock.now() - t0) / 1000) }
}

// Мост на своём уровне к столбу (x, z): клетка за клеткой по большей оси,
// присев (bridge.nextCell / stepOnto). Над мостом нужны две клетки воздуха.
async function bridgeUnder (bot, ctl, x, z, { maxBlocks = 24, timeoutMs = 20000 }: any = {}) {
  const bridge = require('./bridge')
  const { placeBlockAt } = require('./build')
  const t0 = gameClock.now()
  let placed = 0
  const goal = new Vec3(x + 0.5, 0, z + 0.5)
  try { bot.setControlState('sprint', false); bot.setControlState('sneak', true) } catch {}
  try {
    while (!ctl.aborted && gameClock.now() - t0 < timeoutMs && placed <= maxBlocks) {
      const cell = bridge.nextCell(bot, goal)
      if (!cell) return { ok: true, placed }
      const b = bot.blockAt(cell)
      if (!b) return { ok: false, placed, why: 'мир не прогружен' }
      if (b.boundingBox !== 'block') {
        const r = await placeBlockAt(bot, cell, { timeoutMs: 900 })
        if (!r.ok) return { ok: false, placed, why: r.reason || 'не поставил' }
        if (!r.already) placed++
      }
      for (const up of [1, 2]) { const hb = bot.blockAt(cell.offset(0, up, 0)); if (hb && hb.boundingBox === 'block') return { ok: false, placed, why: 'над мостом блок' } }
      await bridge.stepOnto(bot, ctl, cell)
    }
  } finally {
    try { bot.setControlState('sneak', false); bot.setControlState('forward', false) } catch {}
  }
  return { ok: false, placed, why: 'не успел' }
}

// Блоки, которыми строится столб (build.pickFiller), и обсидиан — счёт на подъём.
const CLIMB_FILLER = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt|sand|gravel|obsidian|crying_obsidian|[a-z_]+_planks)$/
function fillerCount (bot) {
  return bot.inventory.items().filter(i => CLIMB_FILLER.test(i.name)).reduce((n, i) => n + i.count, 0)
}

// Блоки на подъём кончились — добыть (2026-09-27, пользователь: «если нет
// блоков, должна включаться программа выживания: землю лопатой легко
// добыть, и потом строиться»). Ближайшие блоки, что ломаются быстро и
// выпадают строительным блоком: земля и дёрн (→ земля), песок, гравий, камень
// (→ булыжник), сланец, андезит, диорит, гранит, туф, незерак. По одному:
// подойти на руку, сломать лучшим инструментом (tools.breakFast), подобрать.
// Не клетку под собой: столб из своей же ямки начинать незачем.
const GATHER = /^(dirt|grass_block|podzol|mycelium|sand|gravel|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|blackstone|basalt|netherrack|[a-z_]+_planks)$/
async function gatherBlocks (bot, ctl, { want = 20, maxMs = 30000, radius = 10 }: any = {}) {
  const tools = require('./tools')
  const { goals } = require('mineflayer-pathfinder')
  const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
  const t0 = gameClock.now()
  const before = fillerCount(bot)
  const what = {}
  const bad = new Set()
  let why = null
  let broke = 0
  const key = (p) => p.x + ',' + p.y + ',' + p.z
  const wet = (p) => { for (const [ax, ay, az] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) { const n = bot.blockAt(p.offset(ax, ay, az)); if (n && /lava|water/.test(n.name)) return true } return false }
  const fast = (b) => !!b && GATHER.test(b.name) && !bad.has(key(b.position)) && tools.bestFor(bot, b).ms <= 1600 && !wet(b.position)
  const airish = (b) => !!b && b.boundingBox === 'empty' && !/lava|water|fire|cobweb/.test(b.name)
  const solidAt = (p) => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' }
  const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  const STRAIGHT = AROUND.slice(0, 4)
  const hit = async (p) => {
    const b = bot.blockAt(p)
    const r = await tools.breakFast(bot, p, { maxMs: 2500 }).catch(() => ({ ok: false }))
    if (r && r.ok) { broke++; what[b.name] = (what[b.name] || 0) + 1; return true }
    bad.add(key(p))
    return false
  }
  // Шаг в соседнюю клетку (в ямку или по траншее): вперёд, пока ноги не там.
  const stepTo = async (cell) => {
    const t1 = gameClock.now()
    try {
      while (gameClock.now() - t1 < 1500 && !ctl.aborted) {
        const p = bot.entity.position
        if (Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && Math.abs(p.y - cell.y) < 0.6) break
        const dx = cell.x + 0.5 - p.x; const dz = cell.z + 0.5 - p.z
        await bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
        bot.setControlState('forward', true)
        bot.setControlState('jump', cell.y > Math.floor(p.y + 1e-3))
        await sleep(50)
      }
    } finally {
      try { bot.setControlState('forward', false); bot.setControlState('jump', false) } catch {}
    }
    await sleep(120)
  }
  // Траншея, как у человека (2026-09-27: 26 блоков за минуту обходом по
  // одному). Выпавшее из соседней клетки на уровне ног подбирается само:
  // рамка игрока, раздутая на блок в стороны и на полблока по высоте
  // (Player.aiStep), её накрывает — ходить за каждым не нужно. Поэтому:
  // (1) стенки вокруг на уровне ног и головы — ломать, стоя на месте;
  // (2) нет стенок — шаг по траншее к клетке, у которой они есть;
  // (3) и её нет — сломать землю рядом и шагнуть в ямку (яма в блок глубиной:
  // стенки вокруг — это и есть земля).
  while (!ctl.aborted && gameClock.now() - t0 < maxMs && fillerCount(bot) - before < want) {
    const feet = bot.entity.position.floored()
    let wall = null
    for (const dy of [0, 1]) {
      for (const [dx, dz] of AROUND) {
        const p = feet.offset(dx, dy, dz)
        if (fast(bot.blockAt(p))) { wall = p; break }
      }
      if (wall) break
    }
    if (wall) { await hit(wall); continue }
    let move = null
    for (const [dx, dz] of STRAIGHT) {
      const c = feet.offset(dx, 0, dz)
      if (!airish(bot.blockAt(c)) || !airish(bot.blockAt(c.offset(0, 1, 0))) || !solidAt(c.offset(0, -1, 0))) continue
      let n = 0
      for (const [ax, az] of AROUND) if (fast(bot.blockAt(c.offset(ax, 0, az)))) n++
      if (n >= 2 && (!move || n > move.n)) move = { c, n }
    }
    if (move) { await stepTo(move.c); continue }
    let pit = null
    for (const [dx, dz] of STRAIGHT) {
      const g = feet.offset(dx, -1, dz)
      if (!fast(bot.blockAt(g)) || !solidAt(g.offset(0, -1, 0))) continue
      if (!airish(bot.blockAt(g.offset(0, 1, 0))) || !airish(bot.blockAt(g.offset(0, 2, 0)))) continue
      pit = g
      break
    }
    if (pit) {
      if (await hit(pit)) await stepTo(pit)
      continue
    }
    // Вокруг ничего — ближайший подходящий блок в округе (подойти, сломать, подобрать).
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const ids = (Object.values(bot.registry.blocksByName) as any[]).filter((b : any) => GATHER.test(b.name)).map((b : any) => b.id)
    const far = bot.findBlocks({ matching: ids, maxDistance: radius, count: 60 })
      .map(p => bot.blockAt(p)).filter(b => fast(b))
      .filter(b => { for (const [ax, ay, az] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) if (airish(bot.blockAt(b.position.offset(ax, ay, az)))) return true; return false })
      .sort((a, b) => a.position.offset(0.5, 0.5, 0.5).distanceTo(eye) - b.position.offset(0.5, 0.5, 0.5).distanceTo(eye))
    if (!far.length) { why = 'рядом нечего ломать'; break }
    const t = far[0].position
    if (t.offset(0.5, 0.5, 0.5).distanceTo(eye) > 4.3) {
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(t.x, t.y, t.z, 2))
        const until = gameClock.now() + 6000
        while (gameClock.now() < until && !ctl.aborted && t.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) > 4.2) await sleep(100)
      } catch {}
      try { bot.pathfinder.setGoal(null) } catch {}
      if (t.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) > 4.5) { bad.add(key(t)); continue }
    }
    if (await hit(t)) await pickupNear(bot, ctl, t, 1600)
  }
  // Задержка подбора выпавшего из блока — 10 тиков (ItemEntity): дождаться.
  const t2 = gameClock.now()
  while (gameClock.now() - t2 < 700 && !ctl.aborted) {
    const me = bot.entity.position
    if (!(Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(me) < 2.2)) break
    await sleep(100)
  }
  const got = fillerCount(bot) - before
  return {
    got,
    broke,
    what: (Object.entries(what) as [string, any][]).map(([k, v]) => k + '×' + v).join(', '),
    ms: gameClock.now() - t0,
    why: got >= want ? null : (why || (ctl.aborted ? 'прервали' : gameClock.now() - t0 >= maxMs ? 'не успел' : 'не вышло'))
  }
}

// Подобрать выпавшее из клетки pos: подойти к предмету (подбирается, когда
// рамка игрока, раздутая на блок по горизонтали, его касается).
async function pickupNear (bot, ctl, pos, maxMs = 1500) {
  const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
  const t0 = gameClock.now()
  const c = pos.offset(0.5, 0.5, 0.5)
  await sleep(120)
  try {
    while (gameClock.now() - t0 < maxMs && !ctl.aborted) {
      const it: any = (Object.values(bot.entities) as any[]).find((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(c) < 3)
      if (!it) return true
      const me = bot.entity.position
      const dx = it.position.x - me.x; const dz = it.position.z - me.z
      if (Math.hypot(dx, dz) < 0.8 && Math.abs(it.position.y - me.y) < 1.2) { bot.setControlState('forward', false); await sleep(80); continue }
      await bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
      bot.setControlState('forward', true)
      bot.setControlState('jump', !!bot.entity.isCollidedHorizontally || it.position.y > me.y + 0.6)
      await sleep(80)
    }
  } finally {
    try { bot.setControlState('forward', false); bot.setControlState('jump', false) } catch {}
  }
  return false
}

// ---------------------------------------------------------------- отбрасывание

// mineflayer 4.37 на 1.21.11: скорость в пакете entity_velocity приходит уже
// в блоках за тик (тип lpVec3, minecraft-protocol datatypes/lpVec3.js), а
// mineflayer entities.js делит её на 8000, как старые short-значения. Своё
// отбрасывание бот получал в 8000 раз слабее — удар его не сдвигал вовсе
// (замер 2026-09-26, try-knock.js: /damage … by — сдвиг 0.00 при 1.99 по
// формуле игры). Ставим скорость как есть, после обработчика mineflayer.
// И сам разбор lpVec3 в minecraft-protocol (datatypes/lpVec3.js) читает
// 4 старших байта как little-endian (readUInt32LE), а игра пишет их
// big-endian (LpVec3.write → ByteBuf.writeInt): y и z приходили мусором —
// {x: 3, y: 2.98, z: 2.65} при ударе в 0.4, бота однажды унесло на 86 блоков
// вверх (прогон 2026-09-26). Поэтому скорость читаем из сырого пакета сами.
function readVarInt (buf, off) {
  let v = 0; let shift = 0; let b
  do { b = buf[off++]; v |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80 && shift < 35)
  return { v, off }
}
function readLpVec3BE (buf, off) {
  const a = buf[off]
  if (a === 0) return { x: 0, y: 0, z: 0 }
  const b = buf[off + 1]
  const c = buf.readUInt32BE(off + 2)
  const packed = c * 65536 + b * 256 + a
  let scale = a & 3
  if ((a & 4) === 4) scale += readVarInt(buf, off + 6).v * 4
  // LpVec3.unpack: (min(v & 32767, 32766) * 2 / 32766) − 1.
  const unpack = (shift) => { const v = Math.floor(packed / Math.pow(2, shift)) % 32768; return Math.min(v, 32766) * 2 / 32766 - 1 }
  return { x: unpack(3) * scale, y: unpack(18) * scale, z: unpack(33) * scale }
}

function fixSelfKnockback (bot) {
  if (!bot || !bot._client || bot._ndKbFix) return
  // Только там, где скорость в пакете — lpVec3 (1.21.9+); раньше были short
  // в 1/8000, и их mineflayer считает верно.
  let lp = false
  try { lp = /lpVec3/.test(JSON.stringify(bot.registry.protocol.play.toClient.types.packet_entity_velocity)) } catch {}
  if (!lp) return
  bot._ndKbFix = true
  // minecraft-protocol шлёт raw.* после разобранного пакета — то есть после
  // обработчика mineflayer: здесь его неверная скорость и заменяется.
  bot._client.on('raw.entity_velocity', (buf) => {
    try {
      if (!bot.entity || !buf) return
      // Буфер — с номером пакета впереди или без него: сверяем id сущности.
      for (const start of [readVarInt(buf, 0).off, 0]) {
        const id = readVarInt(buf, start)
        if (id.v !== bot.entity.id) continue
        const { x, y, z } = readLpVec3BE(buf, id.off)
        // Больше, чем даёт удар (0.4 + спринт 0.5 + «Отдача II» 1.0) и прыжок,
        // — не верить, а записать в лог.
        if (Math.hypot(x, z) > 2.5 || Math.abs(y) > 1.5 || ![x, y, z].every(Number.isFinite)) {
          console.log('[kb] странная скорость — не применяю', JSON.stringify({ x, y, z }))
          return
        }
        bot.entity.velocity.set(x, y, z)
        return
      }
    } catch {}
  })
}

// Тело в долгом падении и ведро наготове — бою не мешать руке.
function falling (bot) {
  const g = bot && bot._ndFallGuard
  return !!(g && (g.busy || (g.placed && !g.placed.landed)))
}

module.exports = {
  SAFE_FALL, KB_HIT, KB_SPRINT, column, support, lethalAt, clearance, hazardAround,
  run, stateOf, guard, knockback, hitVelocity, knockRun, backToDrop, pushPlan, resistOf, dropAlong,
  installFallGuard, afterPacket, mlgDrop, priceDrops, mlgLandingBad, waterloggable, falling, findShaft, climbBack, fixSelfKnockback, fillerCount, gatherBlocks
}
