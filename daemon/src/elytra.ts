'use strict'
const gameClock = require('./game-clock')
// Элитры в бою (просьба 2026-09-26: «крылья … летать, убегать от соперника,
// лететь с высоты в него, обстреливать…»). Что умеет:
//  1. Полёт: взлёт (прыжок → «раскрыть» → фейерверк), управление одним
//     взглядом, набор высоты, круги под потолком арены, посадка без урона.
//  2. Уход с фейерверками на малом хп: подальше от него и повыше, глоток или
//     яблоко в воздухе, посадка там, где его нет.
//  3. Пике с булавой: сверху почти отвесно (щит сверху не держит), перед
//     ударом элитры — на нагрудник (полёт кончается, высота падения, набранная
//     в пике, остаётся) и удар с падения; мимо — элитры обратно и уйти в полёт.
//  4. Против летуна (крючки в pvp.js): не гоняться по земле, стрелять в его
//     рамку 0.6, щит или шаг из-под пике.
//
// Физика — своя, та же, что в игре (декомпиляция клиента 1.21.11,
// extremeheat/extracted_minecraft_data, ветка client1.21.11):
//  * world/entity/LivingEntity.travelFallFlying → updateFallFlyingMovement:
//    v.y += g·(−1 + 0.75·cos²θ); вниз — часть v.y уходит вперёд по взгляду;
//    взгляд вверх — горизонталь уходит в подъём (×3.2); горизонталь
//    поворачивается к взгляду на 10% за тик; ×(0.99, 0.98, 0.99), потом ход.
//    prismarine-physics (moveEntityWithHeading, ветка elytraFlying) считает
//    ровно так же — сверено построчно, и тело на тестовом Paper летит без
//    единого отката (elytra-probe 2026-09-26: 400 тиков, 0 forcedMove);
//  * world/entity/projectile/FireworkRocketEntity.tick: пока жив прицепленный
//    фейерверк, каждый тик v += взгляд·0.1 + (взгляд·1.5 − v)·0.5 — предел
//    1.7 б/т по взгляду; живёт 10·(1 + flight_duration) + rand(6) + rand(7)
//    тиков (обычная ракета — 20–31). Клиент игры разгоняется, пока сущность
//    фейерверка не пропала; mineflayer — по своей случайной оценке: здесь —
//    как у клиента (до entityGone);
//  * Entity.checkFallDistanceAccumulation (LivingEntity.updateFallFlying):
//    в полёте, пока v.y > −0.5, высота падения держится ≤ 1 — посадка из
//    планирования без урона; в пике (v.y < −0.5) копится как обычно. Замер
//    /data get fall_distance: пике 28 тиков — 31.3, выход в планирование —
//    через 4 тика снова 1.36 (elytra-probe dive);
//  * LivingEntity.handleFallFlyingCollisions: удар о стену в полёте —
//    (горизонталь до − после)·10 − 3 урона (fly_into_wall): 1.7 б/т — 14 хп;
//  * world/entity/Avatar.POSES: FALL_FLYING — рамка 0.6×0.6, глаза 0.4:
//    сервер меряет от них руку и выпускает стрелу. prismarine двигает рамку
//    1.8 и в полёте — прогноз ниже тоже (1.8 не пролезет туда, где 0.6
//    пролезла бы, — осторожнее, откатов не будет);
//  * Player.canCriticalAttack полёт не запрещает; MaceItem.canSmashAttack —
//    запрещает (fallDistance > 1.5 && !isFallFlying): удар булавой с пике —
//    только после свапа элитр на нагрудник (Equippable.swapWithEquipmentSlot:
//    «использовать» нагрудник в руке — одним пакетом, левой рукой, чтобы
//    заряд булавы в правой не обнулился — Player.tick сверяет только правую);
//  * ServerGamePacketListenerImpl.handleMovePlayer: в полёте «слишком быстро»
//    — только за 300 (квадрат блоков за пакет), а тело сервер не моделирует,
//    лишь сверяет сдвиг с коллизиями — чужая физика не мешает;
//  * FireworkRocketItem.use: ракета — только если isFallFlying на сервере;
//    ServerGamePacketListenerImpl START_FALL_FLYING → Player.tryToStartFallFlying:
//    не на земле, не в воде, элитры на теле.

const Vec3 = require('vec3')
const pick = require('./pick')

const TICK_MS = 50
const G = 0.08
const EYE = 1.62
const EYE_FLY = 0.4
const HALF = Math.fround(0.6) / 2
const BODY_H = 1.8
const FLY_H = 0.6
const REACH = 3.0
const SAFE_FALL = 3
const ROCKET_BOOST = 1.5
const ROCKET_MAX_TICKS = 40
const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
const DEBUG = !!process.env.ND_DEBUG_ELYTRA
// ND_ELYTRA=0 — не летать в бою (прогон «до»); защита от летуна остаётся.
const ON = process.env.ND_ELYTRA !== '0'
// Рефлекс столкновения в полёте без руля (install); ND_ELYTRA_GUARD=0 — выкл.
const GUARD = process.env.ND_ELYTRA_GUARD !== '0'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
const yawTo = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z))
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
const r2 = (x) => Math.round(x * 100) / 100

// ---------------------------------------------------------------- физика

// Взгляд mineflayer: yaw 0 — на север (−z), pitch + — вверх (у игры xRot
// наоборот). Вектор взгляда тот же, что Entity.calculateViewVector.
function lookVec (yaw, pitch) {
  const c = Math.cos(pitch)
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c }
}

// Один тик полёта (порядок prismarine-physics: толчок фейерверка, потом
// элитры, потом ход). p, v — {x,y,z}, меняются на месте.
function glideStep (p, v, yaw, pitch, boost, g = G) {
  const L = lookVec(yaw, pitch)
  if (boost) {
    v.x += L.x * 0.1 + (L.x * ROCKET_BOOST - v.x) * 0.5
    v.y += L.y * 0.1 + (L.y * ROCKET_BOOST - v.y) * 0.5
    v.z += L.z * 0.1 + (L.z * ROCKET_BOOST - v.z) * 0.5
  }
  const hs = Math.hypot(v.x, v.z)
  const c = Math.cos(pitch)
  const c2 = c * c
  v.y += g * (-1 + c2 * 0.75)
  if (v.y < 0 && c > 0) {
    const m = v.y * -0.1 * c2
    v.x += L.x * m / c; v.y += m; v.z += L.z * m / c
  }
  if (pitch > 0 && c > 0) {
    const m = hs * Math.sin(pitch) * 0.04
    v.x -= L.x * m / c; v.y += m * 3.2; v.z -= L.z * m / c
  }
  if (c > 0) {
    v.x += (L.x / c * hs - v.x) * 0.1
    v.z += (L.z / c * hs - v.z) * 0.1
  }
  v.x *= 0.99; v.y *= 0.98; v.z *= 0.99
  p.x += v.x; p.y += v.y; p.z += v.z
}

// Тик свободного падения (LivingEntity.travelInAir без клавиш): ход, потом
// v.y = (v.y − 0.08)·0.98, горизонталь ×0.91.
function fallStep (p, v) {
  p.x += v.x; p.y += v.y; p.z += v.z
  v.y = (v.y - G) * 0.98
  v.x *= 0.91; v.z *= 0.91
}

// ---------------------------------------------------------------- мир

// Твёрдость клеток — с кэшем: прогноз полёта спрашивает тысячи клеток за тик,
// а bot.blockAt создаёт объект на каждый вызов. Кэш чистится по blockUpdate
// (взрыв, поставленный блок) и целиком раз в 20 с. 1 — твёрдое (и не
// прогруженное), 2 — лава, 3 — вода, 0 — воздух.
function worldOf (bot) {
  if (bot._ndSkyWorld) return bot._ndSkyWorld
  const cells = new Map()
  const key = (x, y, z) => ((x + 30000) * 60001 + (z + 30000)) * 1024 + (y + 512)
  let clearedAt = gameClock.now()
  const at = (x, y, z) => {
    if (cells.size > 250000 || gameClock.now() - clearedAt > 20000) { cells.clear(); clearedAt = gameClock.now() }
    const k = key(x, y, z)
    let v = cells.get(k)
    if (v === undefined) {
      let b = null
      try { b = bot.blockAt(new Vec3(x, y, z), false) } catch {}
      if (!b) v = 1
      else if (b.boundingBox === 'block') v = 1
      else if (b.name === 'lava') v = 2
      else if (b.name === 'water' || b.name === 'bubble_column') v = 3
      else v = 0
      cells.set(k, v)
    }
    return v
  }
  bot.on('blockUpdate', (o, n) => {
    const b = n || o
    if (b && b.position) cells.delete(key(b.position.x, b.position.y, b.position.z))
  })
  const W = {
    at,
    solid: (x, y, z) => at(x, y, z) === 1,
    // Рамка (полуширина HALF, высота h) в точке задевает твёрдое или жидкость.
    boxHit (x, y, z, h = BODY_H) {
      const x0 = Math.floor(x - HALF); const x1 = Math.floor(x + HALF - 1e-9)
      const y0 = Math.floor(y); const y1 = Math.floor(y + h - 1e-9)
      const z0 = Math.floor(z - HALF); const z1 = Math.floor(z + HALF - 1e-9)
      for (let X = x0; X <= x1; X++) for (let Y = y0; Y <= y1; Y++) for (let Z = z0; Z <= z1; Z++) if (at(X, Y, Z) !== 0) return true
      return false
    },
    // Верх опоры под точкой (колонка под центром), не глубже depth; null — пустота.
    floorBelow (x, y, z, depth = 40) {
      const X = Math.floor(x); const Z = Math.floor(z)
      for (let Y = Math.floor(y); Y >= Math.floor(y) - depth; Y--) {
        const v = at(X, Y, Z)
        if (v === 1) return { top: Y + 1 }
        if (v === 2) return { top: Y + 1, lava: true }
        if (v === 3) return { top: Y + 1, water: true }
      }
      return null
    },
    clear: () => cells.clear()
  }
  bot._ndSkyWorld = W
  return W
}

// Прогон полёта: взгляд держим n тиков. boost — сколько тиков ещё тянет
// фейерверк. Событие — первое касание: 'floor' (сели), 'ceil', 'wall' с уроном
// о стену; fd — высота падения по правилам сервера на конце.
function rollout (W, p0, v0, yaw, pitch, boost, n, { fd = 0, keepPath = false }: any = {}) {
  const p = { x: p0.x, y: p0.y, z: p0.z }
  const v = { x: v0.x, y: v0.y, z: v0.z }
  const path = keepPath ? [] : null
  let minFloorGap = Infinity
  for (let t = 0; t < n; t++) {
    const px = p.x; const py = p.y; const pz = p.z
    // Высота падения: сервер держит ≤ 1, пока v.y > −0.5 (до хода этого тика).
    if (v.y > -0.5 && fd > 1) fd = 1
    glideStep(p, v, yaw, pitch, boost > t)
    if (p.y < py) fd += py - p.y
    if (W.boxHit(p.x, p.y, p.z)) {
      const vert = W.boxHit(px, p.y, pz)
      const hs = Math.hypot(v.x, v.z)
      if (vert && p.y < py) return { t, kind: 'floor', p, v, fd, vyHit: v.y, path, minFloorGap: 0 }
      if (vert && p.y > py) return { t, kind: 'ceil', p, v, fd, path, minFloorGap }
      return { t, kind: 'wall', p, v, fd, dmg: Math.max(0, hs * 10 - 3), path, minFloorGap }
    }
    if (keepPath) path.push({ x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, fd })
    if ((t & 3) === 3) {
      const f = W.floorBelow(p.x, p.y, p.z, 12)
      const gap = f ? p.y - f.top : 12
      if (gap < minFloorGap) minFloorGap = gap
    }
  }
  return { t: n, kind: null, p, v, fd, path, minFloorGap }
}

// ---------------------------------------------------------------- тело

function findItem (bot, test) {
  const f = typeof test === 'string' ? (i => i.name === test) : test
  return bot.inventory.items().find(f) || null
}
function countOf (bot, name) {
  return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
}
function offName (bot) { const o = bot.inventory.slots[45]; return o ? o.name : null }
function chestName (bot) { const c = bot.inventory.slots[6]; return c ? c.name : null }
function hotbarIndex (bot, name) {
  for (let i = 0; i < 9; i++) { const it = bot.inventory.slots[36 + i]; if (it && it.name === name) return i }
  return -1
}
function rocketCount (bot) {
  return countOf(bot, 'firework_rocket') + (offName(bot) === 'firework_rocket' ? bot.inventory.slots[45].count : 0)
}
// Фейерверк со звёздами взрывается на прицепленном: 5 + 2·звёзд по себе
// (FireworkRocketEntity.dealExplosionDamage) — для полёта только пустые.
function plainRocket (it) {
  if (!it || it.name !== 'firework_rocket') return false
  try {
    const c = it.componentMap && it.componentMap.get('fireworks')
    const ex = c && c.data && (c.data.explosions || c.data.explosion)
    return !(Array.isArray(ex) && ex.length)
  } catch { return true }
}
function bestChest (bot) {
  const order = ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'copper_chestplate', 'leather_chestplate']
  for (const n of order) { const it = findItem(bot, n); if (it) return it }
  return null
}
const hasElytra = (bot) => chestName(bot) === 'elytra' || !!findItem(bot, 'elytra') || offName(bot) === 'elytra'
const wearingElytra = (bot) => chestName(bot) === 'elytra'
// Что есть для полёта: элитры (на теле или в рюкзаке) и простые фейерверки.
function kit (bot) {
  const rockets = bot.inventory.items().filter(plainRocket).reduce((n, i) => n + i.count, 0) + (plainRocket(bot.inventory.slots[45]) ? bot.inventory.slots[45].count : 0)
  return { elytra: hasElytra(bot), rockets, mace: !!findItem(bot, 'mace'), chest: !!bestChest(bot) || /_chestplate$/.test(chestName(bot) || '') }
}

// Установка на бота (раз): фейерверк тянет, пока его сущность жива (как у
// клиента игры), высота падения по правилам сервера (для прогноза посадки),
// сторож ведра не льёт воду в полёте.
function install (bot) {
  if (bot._ndElytra) return bot._ndElytra
  const S: any = { rocketIds: new Set(), fd: 0, lastY: null, startedAt: 0, flightStart: 0, lastRocketAt: 0, phase: null, box: [], crashes: [] }
  bot._ndElytra = S
  // Чёрный ящик полёта (S7c, замечание проверки S7b а: 18 из 49 раундов «элитры и копьё» — разбился сам):
  // последние 30 тиков в воздухе; удар о стену (fly_into_wall) или пол (fall) себе в полёте/сразу после — запись
  // { kind, phase, dmg, hp, ticks[] } в S.crashes и строка [elytra-crash] в лог демона.
  bot.on('physicsTick', () => {
    try {
      const b = bot.entity
      if (!b) return
      if (b.onGround && !b.elytraFlying) { if (!S.boxHold) { S.box.length = 0; S.phase = null } return }
      // Рефлекс столкновения (S7c, а): летит, а рулит никто (между вызовами fly — удар копьём в воздухе, выстрел,
      // жемчуг, решение боя) — нынешний взгляд за 8 тиков ведёт в стену с уроном или в пол с высотой падения > 3:
      // этот тик — безопасный взгляд (choose: прямо по ходу на 12 бл., выше пола на 3).
      if (b.elytraFlying && !S.driving && GUARD) {
        const W = worldOf(bot)
        const st = { p: b.position, v: b.velocity, boost: bot.fireworkRocketDuration || 0, fd: S.fd }
        const r = rollout(W, b.position, b.velocity, b.yaw, b.pitch, st.boost, 8, { fd: S.fd })
        if ((r.kind === 'wall' && r.dmg >= 1) || (r.kind === 'floor' && r.fd > 3)) {
          const h = Math.hypot(b.velocity.x, b.velocity.z) > 0.2 ? Math.atan2(-b.velocity.x, -b.velocity.z) : b.yaw
          const L = lookVec(h, 0)
          const pl = choose(W, st, { kind: 'point', at: new Vec3(b.position.x + L.x * 12, b.position.y + 2, b.position.z + L.z * 12), gap: 3, speedMin: 0.3 })
          if (pl) { bot.look(pl.yaw, pl.pitch, true).catch(() => {}); S.guardSaves = (S.guardSaves || 0) + 1; S.phase = S.phase || 'рефлекс' }
        }
      }
      S.box.push({ x: r2(b.position.x), y: r2(b.position.y), z: r2(b.position.z), vx: r2(b.velocity.x), vy: r2(b.velocity.y), vz: r2(b.velocity.z), ef: b.elytraFlying ? 1 : 0, fd: r2(S.fd), ph: S.phase, fw: bot.fireworkRocketDuration > 0 ? 1 : 0 })
      if (S.box.length > 30) S.box.shift()
    } catch {}
  })
  try {
    bot._client.on('damage_event', (pk) => {
      try {
        if (!bot.entity || pk.entityId !== bot.entity.id) return
        const type = require('./gamedata').damageTypeName(pk.sourceTypeId)
        if (type !== 'fly_into_wall' && type !== 'fall') return
        if (!S.box.length) return
        const hp0 = bot.health ?? 20
        const rec: any = { kind: type === 'fly_into_wall' ? 'стена' : 'пол', phase: S.phase || S.box[S.box.length - 1].ph || null, at: gameClock.now(), ticks: S.box.slice(-12) }
        S.boxHold = true
        gameClock.setTimeout(() => {
          S.boxHold = false
          rec.dmg = r2(Math.max(0, hp0 - (bot.health ?? 0)))
          rec.died = (bot.health ?? 0) <= 0
          S.crashes.push(rec)
          if (S.crashes.length > 20) S.crashes.shift()
          console.log('[elytra-crash]', JSON.stringify(rec))
        }, 100)
      } catch {}
    })
  } catch {}
  bot.on('usedFirework', (id) => {
    S.rocketIds.add(id)
    // Тянет до entityGone: сервер убирает ракету на исходе её жизни.
    bot.fireworkRocketDuration = Math.max(bot.fireworkRocketDuration || 0, ROCKET_MAX_TICKS)
  })
  bot.on('entityGone', (e) => {
    if (!e || !S.rocketIds.has(e.id)) return
    S.rocketIds.delete(e.id)
    if (!S.rocketIds.size) bot.fireworkRocketDuration = 0
  })
  bot.on('physicsTick', () => {
    try {
      const b = bot.entity
      if (!b) return
      const y = b.position.y
      if (b.onGround || b.isInWater) S.fd = 0
      else {
        if (b.elytraFlying && b.velocity.y > -0.5 && S.fd > 1) S.fd = 1
        if (S.lastY != null && y < S.lastY) S.fd += S.lastY - y
      }
      S.lastY = y
      if (b.elytraFlying && !S.flightStart) S.flightStart = gameClock.now()
      if (!b.elytraFlying) S.flightStart = 0
    } catch {}
  })
  // Сторож ведра (edges.installFallGuard) спрашивает bot._ndWindFall(top): «падение
  // прикрыто — вода не нужна». В полёте на элитрах — прикрыто всегда: посадку
  // ведёт полёт (высота падения ≤ 1, пока v.y > −0.5), а вода под ноги в
  // последний тик — это взгляд вниз, то есть пике в землю. Свойство, а не
  // функция поверх: булава (mace.install) ставит свою позже — оборачиваем и её.
  let inner = bot._ndWindFall
  try {
    Object.defineProperty(bot, '_ndWindFall', {
      configurable: true,
      get: () => (top) => {
        if (bot.entity && bot.entity.elytraFlying) return true
        return typeof inner === 'function' ? inner(top) : false
      },
      set: (f) => { inner = f }
    })
  } catch {}
  return S
}

// «Раскрыть» элитры: пакет START_FALL_FLYING и, как клиент игры
// (LocalPlayer.aiStep → tryToStartFallFlying), флаг у себя сразу — без
// ожидания метаданных сервера (тик). Сервер откажет — пришлёт флаг назад.
function startGlide (bot) {
  const b = bot.entity
  if (!b || b.onGround || b.isInWater || !wearingElytra(bot)) return false
  try {
    bot._client.write('entity_action', { entityId: b.id, actionId: bot.supportFeature('entityActionUsesStringMapper') ? 'start_elytra_flying' : 8, jumpBoost: 0 })
  } catch { return false }
  b.elytraFlying = true
  install(bot).startedAt = gameClock.now()
  return true
}

// Фейерверк: из левой руки (правая с оружием не трогается), иначе из хотбара —
// слот, «использовать», слот назад в том же тике.
function fireRocket (bot) {
  const S = install(bot)
  if (!bot.entity || !bot.entity.elytraFlying) return { ok: false, why: 'не лечу' }
  if (gameClock.now() - S.lastRocketAt < 250) return { ok: false, why: 'только что' }
  if (plainRocket(bot.inventory.slots[45])) {
    bot.activateItem(true)
    bot.usingHeldItem = false
    S.lastRocketAt = gameClock.now()
    return { ok: true, hand: 'off' }
  }
  let idx = -1
  for (let i = 0; i < 9; i++) if (plainRocket(bot.inventory.slots[36 + i])) { idx = i; break }
  if (idx < 0) return { ok: false, why: 'фейерверка нет в хотбаре' }
  const back = bot.quickBarSlot
  try {
    if (back !== idx) bot.setQuickBarSlot(idx)
    bot.activateItem()
    bot.usingHeldItem = false
    if (back !== idx) bot.setQuickBarSlot(back)
  } catch (e) { return { ok: false, why: e.message } }
  S.lastRocketAt = gameClock.now()
  return { ok: true, hand: 'main' }
}

// Предмет в хотбар (оттуда — «использовать» сменой слота). Не на выбранный
// слот и не поверх оружия/тотема/ведра.
const KEEP = /_sword$|_axe$|^mace$|^bow$|^crossbow$|^totem_of_undying$|golden_apple$|^water_bucket$|^ender_pearl$|^shield$/
async function toHotbar (bot, pred) {
  for (let i = 0; i < 9; i++) if (pred(bot.inventory.slots[36 + i])) return i
  const it = bot.inventory.items().find(pred)
  if (!it || bot.currentWindow) return -1
  let dest = -1
  for (let i = 0; i < 9; i++) if (i !== bot.quickBarSlot && !bot.inventory.slots[36 + i]) { dest = i; break }
  if (dest < 0) for (let i = 8; i >= 0; i--) { const s = bot.inventory.slots[36 + i]; if (i !== bot.quickBarSlot && s && !KEEP.test(s.name)) { dest = i; break } }
  if (dest < 0) return -1
  try { await bot.moveSlotItem(it.slot, 36 + dest) } catch { return -1 }
  return pred(bot.inventory.slots[36 + dest]) ? dest : -1
}

// Элитры ↔ нагрудник одним «использовать» (Equippable.swapWithEquipmentSlot):
// предмет в руке встаёт на тело, снятое — в ту же руку. hand 'off' — левой:
// заряд оружия в правой не сбрасывается. Ждём подтверждения сервера (слот 6).
async function swapChest (bot, want, { hand = 'main', waitMs = 400 }: any = {}) {
  const isWanted = (n) => want === 'elytra' ? n === 'elytra' : /_chestplate$/.test(n || '')
  if (isWanted(chestName(bot))) return { ok: true, already: true }
  const item = want === 'elytra' ? (offName(bot) === 'elytra' ? bot.inventory.slots[45] : findItem(bot, 'elytra')) : (/_chestplate$/.test(offName(bot) || '') ? bot.inventory.slots[45] : bestChest(bot))
  if (!item) return { ok: false, why: want === 'elytra' ? 'элитр нет' : 'нагрудника нет' }
  try {
    if (hand === 'off') {
      if (bot.inventory.slots[45] !== item) await bot.equip(item, 'off-hand')
      bot.activateItem(true)
    } else {
      const idx = await toHotbar(bot, (it) => !!it && it.name === item.name)
      if (idx < 0) { await bot.equip(item, 'hand') } else if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
      bot.activateItem()
    }
    bot.usingHeldItem = false
  } catch (e) { return { ok: false, why: e.message } }
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < waitMs && !isWanted(chestName(bot))) await sleep(25)
  return isWanted(chestName(bot)) ? { ok: true, ms: gameClock.now() - t0 } : { ok: false, why: 'сервер не надел' }
}

const nextTick = (bot) => new Promise<any>(resolve => {
  const on = () => { gameClock.clearTimeout(t); resolve(true) }
  const t = gameClock.setTimeout(() => { bot.removeListener('physicsTick', on); resolve(false) }, 300)
  bot.once('physicsTick', on)
})

// Потолок над точкой: сколько блоков воздуха над головой (до n).
function headroom (W, p, n = 30) {
  for (let i = 0; i < n; i++) if (W.boxHit(p.x, p.y + 0.2 + i, p.z)) return i
  return n
}

// Где стены, пол и потолок вокруг (для круга под потолком и уходов): лучи на
// 8 сторон на высоте y, вверх — потолок. Кэш на 1 с.
function arenaAround (bot, W, at, { reach = 48 }: any = {}) {
  const S = install(bot)
  const k = `${Math.floor(at.x / 4)},${Math.floor(at.y / 2)},${Math.floor(at.z / 4)}`
  if (S.arena && S.arena.k === k && gameClock.now() - S.arena.at < 1000) return S.arena.v
  const dirs = []
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2
    const dx = -Math.sin(a); const dz = -Math.cos(a)
    let d = 0
    for (; d < reach; d += 0.5) if (W.boxHit(at.x + dx * d, at.y, at.z + dz * d)) break
    dirs.push({ yaw: a, d })
  }
  const ceil = headroom(W, at, 40)
  const v = { dirs, ceilY: at.y + 0.2 + ceil + BODY_H }
  S.arena = { k, at: gameClock.now(), v }
  return v
}

// ---------------------------------------------------------------- управление

const PITCHES = [-1.3, -1.0, -0.75, -0.55, -0.38, -0.22, -0.1, 0, 0.12, 0.28, 0.45, 0.7, 0.95]
const YAW_OFF = [0, 0.12, -0.12, 0.3, -0.3, 0.55, -0.55, 0.9, -0.9, 1.35, -1.35, 2.0, -2.0, Math.PI]

// Выбор взгляда на этот тик: перебор (yaw, pitch), каждый — прогон H тиков
// своей физикой, цена — по цели. goal:
//  { kind: 'point', at: Vec3 | (t)→Vec3, minY, maxY, away: Vec3, awayR, speedMin }
//  { kind: 'land', at: Vec3 (точка пола), away: Vec3 }
//  { kind: 'strike', at: (t)→Vec3, within }
function choose (W, st, goal, { H = 18, rocketNow = false }: any = {}) {
  const at = typeof goal.at === 'function' ? goal.at : () => goal.at
  const tgt0 = at(0)
  const hs0 = Math.hypot(st.v.x, st.v.z)
  const bearing = yawTo(st.p, tgt0)
  const heading = hs0 > 0.2 ? Math.atan2(-st.v.x, -st.v.z) : bearing
  const yaws = new Set()
  for (const o of YAW_OFF) { yaws.add(wrap(bearing + o)); if (Math.abs(o) <= 0.9) yaws.add(wrap(heading + o)) }
  const boost = Math.max(0, st.boost || 0) + (rocketNow ? 26 : 0)
  let best = null
  for (const yaw of yaws) {
    for (const pitch of goal.pitches || PITCHES) {
      const r = rollout(W, st.p, st.v, yaw, pitch, boost, H, { fd: st.fd, keepPath: goal.kind === 'strike' || !!goal.reach })
      const c = cost(W, st, goal, at, r, yaw, pitch)
      if (!best || c < best.c) best = { c, yaw, pitch, r }
    }
  }
  return best
}

function cost (W, st, goal, at, r, yaw, pitch) {
  let c = 0
  const end = r.p
  // Удар о стену — самое дорогое: урон ×, и полёт кончается.
  if (r.kind === 'wall') c += 400 + r.dmg * 40 + (18 - r.t) * 10
  if (r.kind === 'ceil') c += 60 + (18 - r.t) * 3
  if (goal.kind === 'land') {
    if (r.kind === 'floor') {
      // Сели: высота падения по правилам сервера, пустота/лава под точкой.
      const fall = Math.max(0, r.fd - SAFE_FALL)
      c += fall * 60
      const f = W.floorBelow(r.p.x, r.p.y + 0.5, r.p.z, 3)
      if (!f || f.lava) c += 5000
      c += Math.hypot(r.p.x - goal.at.x, r.p.z - goal.at.z) * 1.5
      if (goal.away) c -= Math.min(20, Math.hypot(r.p.x - goal.away.x, r.p.z - goal.away.z)) * 0.5
      // Край рядом: скольжение после касания (трение 0.546) — до ~2 блоков.
      if (goal.edge && goal.edge(r.p)) c += 300
      c += r.t * 0.3
    } else {
      // Не сели за горизонт: ближе к точке и ниже, но не в пустоту.
      c += Math.hypot(end.x - goal.at.x, end.z - goal.at.z) * 1.5 + Math.max(0, end.y - goal.at.y) * 2 + 20
      const f = W.floorBelow(end.x, end.y, end.z, 30)
      if (!f) c += 80
    }
    return c
  }
  // Пике: пол после точки свапа — не беда (дальше свободное падение и удар).
  if (r.kind === 'floor' && goal.kind !== 'strike') c += 300 + Math.max(0, r.fd - SAFE_FALL) * 60 + (18 - r.t) * 8
  if (goal.kind === 'strike') {
    // Пике: в какой первый тик прогона свап на нагрудник даёт удар — свободное
    // падение с этой точки (fallStep) входит в его руку за 1–3 тика выше его
    // головы, а высота падения к этому тику уже > 1.8 (MaceItem.canSmashAttack
    // > 1.5). Нет такого — насколько близко пройдём.
    const path = r.path || []
    const foot = goal.foot || ((t) => at(t))
    let first = null
    let bestD = Infinity
    for (let t = 0; t < path.length && !first; t++) {
      const s = path[t]
      const f0 = foot(t + 1)
      const d0 = Math.hypot(s.x - f0.x, s.y - f0.y, s.z - f0.z)
      if (d0 < bestD) bestD = d0
      if (s.fd < 1.8 || s.vy > -0.45) continue
      const q = { x: s.x, y: s.y, z: s.z }; const w = { x: s.vx, y: s.vy, z: s.vz }
      for (let k = 1; k <= 3; k++) {
        fallStep(q, w)
        const fk = foot(t + 1 + k)
        if (q.y < fk.y + 0.6) break
        const rr = reachFromBox({ x: q.x, y: q.y + EYE, z: q.z }, fk, 0.6, 1.8)
        if (rr <= REACH - 0.3) { first = { t, k, fd: s.fd + (s.y - q.y) }; break }
      }
    }
    if (first) c += first.t + first.k * 0.5 - Math.min(10, first.fd) * 0.8
    else c += 60 + bestD * 4 + (r.kind === 'floor' ? 300 + (18 - r.t) * 8 : 0)
    return c
  }
  // point: к точке, в коридоре высот, подальше от него, не сваливаться.
  // reach — важно пройти через точку (ближе всего за прогон), а не где конец.
  const tgt = at(r.t)
  if (goal.reach && r.path && r.path.length) {
    let bestD = Infinity; let bestT = 0
    for (let t = 0; t < r.path.length; t++) {
      const q = r.path[t]
      const d = Math.hypot(q.x - tgt.x, q.y - tgt.y, q.z - tgt.z)
      if (d < bestD) { bestD = d; bestT = t }
    }
    c += bestD + bestT * 0.15
  } else c += Math.hypot(end.x - tgt.x, end.y - tgt.y, end.z - tgt.z)
  if (goal.minY != null && end.y < goal.minY) c += (goal.minY - end.y) * 4
  if (goal.maxY != null && end.y > goal.maxY) c += (end.y - goal.maxY) * 4
  if (goal.gap != null && r.minFloorGap < goal.gap) c += (goal.gap - r.minFloorGap) * 10
  const hs = Math.hypot(r.v.x, r.v.z)
  if (goal.speedMin != null && hs < goal.speedMin) c += (goal.speedMin - hs) * 30
  if (goal.away) {
    const dd = Math.hypot(end.x - goal.away.x, end.z - goal.away.z)
    if (dd < (goal.awayR || 8)) c += ((goal.awayR || 8) - dd) * 4
  }
  // Резкий крен без нужды — дрожь взгляда: чуть дороже.
  c += Math.abs(pitch) * 0.5
  return c
}

// ---------------------------------------------------------------- полёт

// Лететь, пока until() не скажет «хватит» (или сели, кончился полёт, время).
// goal() — цель этого тика; ракета — когда с ней прогноз заметно лучше или
// скорость/высота ниже нужной (rocketIf). Всё — на тике физики: взгляд этого
// тика двигает тело на следующем.
function fly (bot, ctl, { goal, until = null, maxMs = 15000, rocketIf = null, onTick = null, stats = null, noRocket = null, phase = null }: any = {}) {
  const W = worldOf(bot)
  const S = install(bot)
  return new Promise<any>(resolve => {
    const t0 = gameClock.now()
    let done = false
    let ticks = 0
    let planMs = 0
    S.driving = (S.driving || 0) + 1
    const finish = (why) => {
      if (done) return
      done = true
      S.driving = Math.max(0, (S.driving || 1) - 1)
      bot.removeListener('physicsTick', onT)
      resolve({ why, ms: gameClock.now() - t0, ticks, planMs: ticks ? r2(planMs / ticks) : 0 })
    }
    const onT = () => {
      if (done) return
      try {
        const b = bot.entity
        if (ctl.aborted || !b || (bot.health ?? 0) <= 0) return finish('прервали')
        if (b.onGround) return finish('сел')
        if (b.isInWater) return finish('в воде')
        if (!b.elytraFlying && gameClock.now() - S.startedAt > 400) return finish('полёт кончился')
        if (gameClock.now() - t0 > maxMs) return finish('долго')
        if (until) { const u = until(); if (u) return finish(u) }
        ticks++
        const g = typeof goal === 'function' ? goal() : goal
        if (!g) return finish('цели нет')
        S.phase = phase || g.kind
        const st = { p: b.position, v: b.velocity, boost: bot.fireworkRocketDuration || 0, fd: S.fd }
        const tp = gameClock.wall.now()
        const pl = choose(W, st, g)
        let fire = false
        if (!(noRocket && noRocket()) && !(bot.fireworkRocketDuration > 0) && rocketCount(bot) > 0) {
          const want = rocketIf ? rocketIf(st, pl, g) : false
          if (want === true) fire = true
          else if (want !== false) {
            const withR = choose(W, st, g, { rocketNow: true })
            if (withR && withR.c < pl.c - 4) { fire = true; pl.yaw = withR.yaw; pl.pitch = withR.pitch; pl.c = withR.c }
          }
        }
        planMs += gameClock.wall.now() - tp
        bot.look(pl.yaw, pl.pitch, true).catch(() => {})
        if (fire) {
          const fr = fireRocket(bot)
          if (fr.ok && stats) stats.rockets = (stats.rockets || 0) + 1
        }
        if (onTick) onTick(pl, st)
        if (DEBUG && ticks % 5 === 0) console.log('[elytra]', JSON.stringify({ t: ticks, kind: g.kind, p: [r2(b.position.x), r2(b.position.y), r2(b.position.z)], v: [r2(b.velocity.x), r2(b.velocity.y), r2(b.velocity.z)], yaw: r2(pl.yaw), pitch: r2(pl.pitch), c: r2(pl.c), ev: pl.r.kind, fw: bot.fireworkRocketDuration, fd: r2(S.fd) }))
      } catch (e) { finish('ошибка: ' + e.message) }
    }
    bot.on('physicsTick', onT)
  })
}

// Взлёт: элитры на теле, прыжок, в воздухе — «раскрыть», взгляд вверх и
// фейерверк. Отказ — с причиной (потолок, воды, нет ракет).
async function takeoff (bot, ctl, { pitch = 1.0, yaw = null, stats = null, liquidStart = false }: any = {}) {
  const W = worldOf(bot)
  install(bot)
  const b = bot.entity
  if (!b) return { ok: false, why: 'нет тела' }
  if (b.isInWater) return { ok: false, why: 'в воде' }
  const fromLava = liquidStart && !!b.isInLava
  if (fromLava ? !lavaLaunchClear(bot) : headroom(W, b.position, 6) < 4) return { ok: false, why: 'над головой блок' }
  if (!rocketCount(bot)) return { ok: false, why: 'фейерверков нет' }
  if (!wearingElytra(bot)) {
    const s = await swapChest(bot, 'elytra', { hand: offName(bot) === 'elytra' ? 'off' : 'main' })
    if (!s.ok) return { ok: false, why: 'элитры не надел: ' + s.why }
  }
  for (const k of KEYS) { try { bot.setControlState(k, false) } catch {} }
  const y0 = b.position.y
  if (b.onGround) {
    await nextTick(bot)
    try { bot.setControlState('jump', true) } catch {}
    await nextTick(bot)
    try { bot.setControlState('jump', false) } catch {}
  }
  // В воздухе: подъём прыжка ещё идёт — «раскрыть» сейчас.
  for (let i = 0; i < 4 && bot.entity.onGround; i++) await nextTick(bot)
  if (bot.entity.onGround) return { ok: false, why: 'не оторвался от земли' }
  if (!startGlide(bot)) return { ok: false, why: 'не раскрыл элитры' }
  install(bot).phase = 'взлёт'
  await bot.look(yaw ?? bot.entity.yaw, pitch, true).catch(() => {})
  await nextTick(bot)
  let fr = fireRocket(bot)
  if (!fr.ok && /хотбаре/.test(fr.why || '')) {
    // Ракеты в рюкзаке — в хотбар (клики) и ещё раз.
    await toHotbar(bot, plainRocket)
    fr = fireRocket(bot)
  }
  if (fr.ok && stats) stats.rockets = (stats.rockets || 0) + 1
  // Сервер подтвердил полёт (метаданные) и ракету (сущность прицепилась).
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 600 && !ctl.aborted && !(bot.fireworkRocketDuration > 0)) await nextTick(bot)
  if (fromLava) {
    try {
      bot.setControlState('jump', true)
      const liftAt = gameClock.now()
      while (!ctl.aborted && bot.health > 0 && bot.entity.isInLava && gameClock.now() - liftAt < 1500) {
        if (!lavaLaunchClear(bot)) return { ok: false, why: 'проход из лавы перекрыт' }
        if (!bot.entity.elytraFlying) startGlide(bot)
        await bot.look(yaw ?? bot.entity.yaw, 1.2, true).catch(() => {})
        await nextTick(bot)
      }
      if (ctl.aborted || bot.entity.isInLava) return { ok: false, why: 'не вышел из лавы под тягой ракеты' }
    } finally { bot.setControlState('jump', false) }
  }
  if (stats) stats.takeoffs = (stats.takeoffs || 0) + 1
  return { ok: !!bot.entity.elytraFlying, rocket: bot.fireworkRocketDuration > 0, dy: r2(bot.entity.position.y - y0), why: bot.entity.elytraFlying ? null : 'сервер не дал лететь' }
}

function lavaLaunchClear(bot) {
  const p = bot.entity.position
  let air = 0
  for (let dy = 0; dy < 8; dy++) {
    for (const [dx, dz] of [[-.3, -.3], [-.3, .3], [.3, -.3], [.3, .3]]) {
      const block = bot.blockAt(new Vec3(Math.floor(p.x + dx), Math.floor(p.y + dy), Math.floor(p.z + dz)))
      if (!block || block.boundingBox === 'block' || /water|bubble_column/.test(block.name)) return false
      if (block.name !== 'lava' && block.boundingBox !== 'empty') return false
    }
    if (bot.blockAt(p.offset(0, dy, 0).floored())?.name !== 'lava') air++
  }
  return air >= 4
}

// Точка посадки: твёрдый пол 3×3 без пустоты рядом, как можно ближе к near и
// дальше от away. Перебор по кольцам вокруг near.
function landingSpot (bot, W, { near, away = null, floorY = null, radius = 20, minFromAway = 0, inside = null }: any = {}) {
  let best = null
  const y0 = floorY != null ? floorY : near.y
  for (let r = 0; r <= radius; r += 2) {
    const n = Math.max(1, Math.round(r * 1.5))
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2
      const x = Math.floor(near.x + Math.sin(a) * r) + 0.5
      const z = Math.floor(near.z + Math.cos(a) * r) + 0.5
      if (inside && !inside(x, z)) continue
      const f = W.floorBelow(x, y0 + 6, z, 14)
      if (!f || f.lava || f.water) continue
      let ok = true
      for (let dx = -2; dx <= 2 && ok; dx++) {
        for (let dz = -2; dz <= 2 && ok; dz++) {
          const g = W.floorBelow(x + dx, f.top + 0.5, z + dz, 4)
          if (!g || g.lava || Math.abs(g.top - f.top) > 1) ok = false
        }
      }
      if (!ok || W.boxHit(x, f.top, z) || headroom(W, new Vec3(x, f.top, z), 4) < 3) continue
      const da = away ? Math.hypot(x - away.x, z - away.z) : 0
      if (away && da < minFromAway) continue
      const sc = r - (away ? Math.min(30, da) * 0.6 : 0)
      if (!best || sc < best.sc) best = { sc, at: new Vec3(x, f.top, z) }
    }
    if (best && r >= 6) break
  }
  return best ? best.at : null
}

// Посадка: планирование к точке пола, касание с v.y > −0.5 (высота падения ≤ 1
// — без урона), не в пустоту и не у самого края. Ракеты — нет.
async function land (bot, ctl, { at = null, away = null, maxMs = 12000, stats = null }: any = {}) {
  const W = worldOf(bot)
  const b = bot.entity
  if (!b || !b.elytraFlying) return { ok: !!(b && b.onGround), why: 'не лечу' }
  let spot = at || landingSpot(bot, W, { near: b.position, away, floorY: null })
  if (!spot) {
    const f = W.floorBelow(b.position.x, b.position.y, b.position.z, 60)
    spot = f ? new Vec3(b.position.x, f.top, b.position.z) : null
  }
  if (!spot) return { ok: false, why: 'сесть некуда' }
  const hp0 = bot.health ?? 20
  const edge = (p) => {
    for (const [dx, dz] of [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const f = W.floorBelow(p.x + dx, p.y + 0.5, p.z + dz, 4)
      if (!f || f.lava) return true
    }
    return false
  }
  const r: any = await fly(bot, ctl, {
    phase: 'посадка',
    goal: () => ({ kind: 'land', at: spot, away, edge }),
    maxMs,
    noRocket: () => true,
    stats
  })
  // Скольжение после касания (трение) — рефлекс края держит от ям.
  await sleep(150)
  const lost = Math.max(0, hp0 - (bot.health ?? 20))
  if (stats) { stats.landings = (stats.landings || 0) + 1; if (lost > 0.5) stats.landDmg = r2((stats.landDmg || 0) + lost) }
  return { ok: !!bot.entity.onGround, why: r.why, lost: r2(lost), at: spot }
}

// Нагрудник назад — только внизу (S7c, а): свап в воздухе гасит полёт, и тело падает с высоты («fell from a
// high place»). Летит — посадка (до двух попыток); падает без полёта высоко над полом — снова раскрыть и сесть;
// на земле или в воде (или пол в 1.2 бл. и v.y > −0.5) — свап.
async function chestDown (bot, ctl, { stats = null, away = null, at = null }: any = {}) {
  const W = worldOf(bot)
  const low = () => {
    const b = bot.entity
    if (!b) return true
    if (b.onGround || b.isInWater) return true
    const f = W.floorBelow(b.position.x, b.position.y, b.position.z, 6)
    return !!f && b.position.y - f.top < 1.2 && b.velocity.y > -0.5
  }
  const landCtl = { get aborted () { return (bot.health ?? 0) <= 0 } }
  for (let i = 0; i < 3 && (bot.health ?? 0) > 0 && !low(); i++) {
    if (bot.entity.elytraFlying) { await land(bot, landCtl, { at: i === 0 ? at : null, away, stats }); continue }
    const f = W.floorBelow(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z, 40)
    if (f && bot.entity.position.y - f.top > 3.5 && wearingElytra(bot) && startGlide(bot)) { if (stats) stats.reglide = (stats.reglide || 0) + 1; continue }
    const t0 = gameClock.now()
    while (!low() && (bot.health ?? 0) > 0 && gameClock.now() - t0 < 3000) await sleep(TICK_MS)
  }
  if ((bot.health ?? 0) <= 0) return { ok: false, why: 'погиб' }
  if (/_chestplate$/.test(chestName(bot) || '')) return { ok: true, already: true }
  if (!low()) { if (stats) stats.chestAir = (stats.chestAir || 0) + 1; return { ok: false, why: 'не сел — нагрудник не меняю в воздухе' } }
  return swapChest(bot, 'chest', { hand: /_chestplate$/.test(offName(bot) || '') ? 'off' : 'main' })
}

// ---------------------------------------------------------------- слежка

// Он на элитрах: метаданные shared_flags 0x80 (mineflayer entity.elytraFlying)
// или поза FALL_FLYING (1). Скорость — по позициям за ~150 мс.
function gliding (e) {
  if (!e) return false
  if (e.elytraFlying) return true
  try { return (e.metadata?.[0] & 0x80) !== 0 || e.metadata?.[6] === 1 || e.metadata?.[6] === 'fall_flying' } catch { return false }
}

// Где он будет через t тиков: по его скорости, в полёте без ракеты — той же
// физикой по его взгляду (метаданные yaw/pitch mineflayer ведёт для всех).
function predictGlider (e, vel, t) {
  const p = { x: e.position.x, y: e.position.y, z: e.position.z }
  const v = { x: vel.x, y: vel.y, z: vel.z }
  if (!gliding(e)) return new Vec3(p.x + v.x * t, p.y + v.y * t, p.z + v.z * t)
  const n = Math.floor(t)
  for (let i = 0; i < n; i++) glideStep(p, v, e.yaw || 0, e.pitch || 0, false)
  const fraction = t - n
  if (fraction > 0) {
    const next = { ...p }
    glideStep(next, v, e.yaw || 0, e.pitch || 0, false)
    p.x += (next.x - p.x) * fraction; p.y += (next.y - p.y) * fraction; p.z += (next.z - p.z) * fraction
  }
  return new Vec3(p.x, p.y, p.z)
}

// Слежка за ним в бою: летит ли, сколько в воздухе, его пике на нас (время до
// сближения по его скорости и точке ближе всего).
function track (bot, { enemy }: any) {
  const st = { seen: 0, dives: 0, shots: 0, hits: 0, shieldUps: 0, dodges: 0, counterHits: 0, airMs: 0 }
  const his = { id: null, hist: [], vel: { x: 0, y: 0, z: 0 }, flying: false, since: 0 }
  let active = null
  const onTick = () => {
    try {
      const e = enemy()
      if (!e || !e.position || e.isValid === false) return
      if (his.id !== e.id) { his.id = e.id; his.hist = []; his.flying = false }
      const now = gameClock.now()
      his.hist.push({ x: e.position.x, y: e.position.y, z: e.position.z, t: now })
      while (his.hist.length > 2 && now - his.hist[0].t > 160) his.hist.shift()
      const a = his.hist[0]; const bb = his.hist[his.hist.length - 1]
      const dt = (bb.t - a.t) / 50
      if (dt > 0.6) his.vel = { x: (bb.x - a.x) / dt, y: (bb.y - a.y) / dt, z: (bb.z - a.z) / dt }
      const fl = gliding(e)
      if (fl && !his.flying) { his.since = now; st.seen++ }
      if (!fl && his.flying) st.airMs += now - his.since
      his.flying = fl
    } catch {}
  }
  bot.on('physicsTick', onTick)
  // Пике на нас: он летит, до точки ближе всего ≤ 20 тиков, пройдёт ближе 3.5
  // от нашей середины. eta — тиков до неё.
  const threat = () => {
    const e = enemy()
    if (!e || !e.position || !his.flying || !bot.entity) return (active = null)
    const me = bot.entity.position.offset(0, 0.9, 0)
    let best = null
    for (let t = 1; t <= 24; t++) {
      const q = predictGlider(e, his.vel, t)
      const d = Math.hypot(q.x - me.x, q.y + 0.3 - me.y, q.z - me.z)
      if (!best || d < best.d) best = { d, t, q }
    }
    const sp = Math.hypot(his.vel.x, his.vel.y, his.vel.z)
    if (best && best.d < 3.5 && best.t <= 20 && sp > 0.5) {
      const out = { kind: 'dive', eta: best.t, miss: r2(best.d), at: best.q, speed: r2(sp), mace: !!(e.equipment && e.equipment[0] && e.equipment[0].name === 'mace') }
      if (!active) st.dives++
      active = active ? Object.assign(active, out) : out
      return active
    }
    active = null
    return null
  }
  return {
    st,
    his,
    threat,
    flying: () => his.flying,
    vel: () => his.vel,
    at: (t) => { const e = enemy(); return e ? predictGlider(e, his.vel, t) : null },
    report () {
      const out = {
        seen: st.seen || undefined,
        airS: st.airMs ? Math.round(st.airMs / 100) / 10 : undefined,
        dives: st.dives || undefined,
        shots: st.shots || undefined,
        hits: st.hits || undefined,
        shieldUps: st.shieldUps || undefined,
        dodges: st.dodges || undefined,
        counterHits: st.counterHits || undefined
      }
      return (Object.values(out) as any[]).some(v => v !== undefined) ? out : undefined
    },
    close () { bot.removeListener('physicsTick', onTick) }
  }
}

// ---------------------------------------------------------------- тактики

// Куда уходить: из 16 сторон вокруг себя — где дальше от него и есть место до
// стены (arenaAround), на высоте cruiseY.
function farPoint (bot, W, foe, cruiseY) {
  const me = bot.entity.position
  const ar = arenaAround(bot, W, new Vec3(me.x, cruiseY, me.z))
  let best = null
  for (const d of ar.dirs) {
    const reach = Math.max(0, d.d - 5)
    for (const k of [0.4, 0.7, 1]) {
      const run = reach * k
      const x = me.x - Math.sin(d.yaw) * run
      const z = me.z - Math.cos(d.yaw) * run
      const sc = Math.hypot(x - foe.x, z - foe.z)
      if (!best || sc > best.sc) best = { sc, at: new Vec3(x, cruiseY, z) }
    }
  }
  return best ? best.at : new Vec3(me.x, cruiseY, me.z)
}

// Высота круга: под потолком с запасом (рамка 1.8 и крен) и не выше, чем
// нужно, чтобы его рука и прыжок не достали: его ноги + 6.
function cruiseAlt (bot, W, foe) {
  const me = bot.entity.position
  const ar = arenaAround(bot, W, me)
  const top = ar.ceilY - BODY_H - 1.6
  return Math.min(top, Math.max(foe.y + 7, me.y + 4))
}

// Съесть или выпить в воздухе: предмет в правую, «использовать», ждать, пока
// его станет меньше (32 тика), руль — у полёта (он крутит взгляд на тике).
async function consumeAir (bot, ctl, item, { maxMs = 2600, safe = () => true }: any = {}) {
  if (!item) return false
  const name = item.name
  const had = countOf(bot, name) + (offName(bot) === name ? bot.inventory.slots[45].count : 0)
  const before = offName(bot)
  const offhand = !bot.usingHeldItem && /(?:_sword|_axe|_spear)$|^mace$/.test(bot.heldItem?.name ?? '')
  try {
    if (offhand) await bot.equip(item, 'off-hand')
    else {
      const idx = await toHotbar(bot, (it) => !!it && it.name === name)
      if (idx < 0) await bot.equip(item, 'hand')
      else if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
    }
  } catch { return false }
  try {
  await nextTick(bot)
  if (ctl.aborted || !safe() || (offhand ? offName(bot) !== name : bot.heldItem?.name !== name)) return false
  bot.activateItem(offhand)
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < maxMs && !ctl.aborted && countOf(bot, name) + (offName(bot) === name ? bot.inventory.slots[45].count : 0) >= had) {
    if (!bot.entity || !bot.entity.elytraFlying || !safe()) break
    await sleep(50)
  }
  const ok = countOf(bot, name) + (offName(bot) === name ? bot.inventory.slots[45].count : 0) < had
  if (!ok) { try { bot.deactivateItem() } catch {} }
  return ok
  } finally {
    if (offhand && before && before !== name && !ctl.aborted) {
      const previous = findItem(bot, before)
      if (previous) await bot.equip(previous, 'off-hand').catch(() => {})
    }
  }
}

// Уход с фейерверками: взлёт прочь от него, круг под потолком, лечение в
// воздухе (яблоко, питьё — 32 тика), посадка подальше от него, нагрудник
// обратно. Его меч в воздухе не достаёт, стрела по цели 0.6×0.6 на 1–1.7 б/т —
// редко. heal() — чем лечиться сейчас (или null), enough() — хватит ли.
async function escape (bot, ctl, e, { heal, enough = () => (bot.health ?? 0) >= 16, stats = {}, used = () => {}, maxMs = 16000, allow = null, arena = null }: any = {}) {
  const W = worldOf(bot)
  const S = install(bot)
  const out: any = { ok: false, ate: [], hp0: r2(bot.health ?? 0), note: '' }
  const t0 = gameClock.now()
  const foe = () => (e && e.isValid !== false && e.position) ? e.position : bot.entity.position
  const away = yawTo(foe(), bot.entity.position)
  // Арена (живой прогон 2026-09-27): жуя в планировании, бот провалился в
  // дыру пола и сел на землю под Колизеем, в 56 блоках ниже поля. Над полем —
  // не ниже пола + 5, жевать — только с запасом высоты, просел к полу — глоток
  // бросить (ракеты при занятой руке нет), садиться — на поле.
  const floorRef = () => arena ? arena.y : foe().y
  const onField = (x, z) => !arena || (Math.abs(x - arena.x) <= arena.r - 1 && Math.abs(z - arena.z) <= arena.r - 1)
  if (allow) allow()
  const to = await takeoff(bot, ctl, { pitch: 1.05, yaw: away, stats })
  if (!to.ok) { out.note = 'уход на элитрах: не взлетел — ' + to.why; await chestDown(bot, ctl, { stats }); return out }
  stats.escapes = (stats.escapes || 0) + 1
  used('элитры: взлёт — ухожу лечиться в воздух')
  let target = farPoint(bot, W, foe(), cruiseAlt(bot, W, foe()))
  let pickAt = gameClock.now()
  let phase = 'climb'
  let eating = null
  let hurtAir = 0
  let hpPrev = bot.health ?? 20
  const onHp = () => { const h = bot.health ?? 20; if (h < hpPrev) hurtAir += hpPrev - h; hpPrev = h }
  bot.on('health', onHp)
  const alt = () => cruiseAlt(bot, W, foe())
  const r: any = await fly(bot, ctl, {
    maxMs, phase: 'уход',
    stats,
    goal: () => {
      if (gameClock.now() - pickAt > 500) { target = farPoint(bot, W, foe(), alt()); pickAt = gameClock.now() }
      return { kind: 'point', at: target, minY: Math.max(foe().y + 4.5, arena ? arena.y + 5 : -1e9), maxY: alt() + 1.5, gap: 3.5, speedMin: 0.55, away: foe(), awayR: 10 }
    },
    // Во время глотка рука занята — ракет нет; до него — когда низко или медленно.
    noRocket: () => !!eating,
    rocketIf: (st) => (st.p.y < Math.max(foe().y, floorRef()) + 5 || Math.hypot(st.v.x, st.v.z) < 0.45) ? true : null,
    onTick: () => {
      if (allow) allow()
      const me = bot.entity.position
      const dh = Math.hypot(me.x - foe().x, me.z - foe().z)
      if (phase === 'climb' && ((me.y > foe().y + 5 && dh > 7) || gameClock.now() - t0 > 2500)) phase = 'heal'
      if (arena && eating && me.y < floorRef() + 3) { try { bot.deactivateItem() } catch {} }
      if (phase === 'heal' && !eating && !(arena && me.y < floorRef() + 5)) {
        const it = heal ? heal() : null
        if (!it || enough()) { phase = 'land'; return }
        eating = consumeAir(bot, ctl, it, { safe: () => bot.entity.position.distanceTo(foe()) > 8 && !bot._ndDescend }).then(ok => { if (ok) { out.ate.push(it.name); used('элитры: ' + (/potion/.test(it.name) ? 'выпил' : 'съел') + ' в воздухе ' + it.name) } eating = null; if (!ok) phase = 'land' })
      }
    },
    until: () => (phase === 'land' && !eating) ? 'лечение' : (rocketCount(bot) === 0 && bot.entity.position.y < foe().y + 3 ? 'ракеты кончились' : null)
  })
  if (eating) { try { await eating } catch {} }
  // Посадка: подальше от него, на целый пол.
  let l: any = { ok: !!bot.entity.onGround, why: r.why }
  if (bot.entity.elytraFlying) {
    const inside = arena ? onField : null
    const fy = arena ? arena.y : foe().y
    const spot = landingSpot(bot, W, { near: target, away: foe(), floorY: fy, radius: 16, minFromAway: 8, inside }) || landingSpot(bot, W, { near: bot.entity.position, away: foe(), floorY: fy, inside })
    l = await land(bot, ctl, { at: spot, away: foe(), stats })
  }
  bot.removeListener('health', onHp)
  const sw = await chestDown(bot, ctl, { stats, away: foe() })
  out.ok = !!l.ok
  out.hp1 = r2(bot.health ?? 0)
  out.hurtAir = r2(hurtAir)
  out.ms = gameClock.now() - t0
  out.chest = sw.ok
  stats.escapeMs = (stats.escapeMs || 0) + out.ms
  stats.escapeHp = r2((stats.escapeHp || 0) + ((bot.health ?? 0) - out.hp0))
  stats.hurtAir = r2((stats.hurtAir || 0) + hurtAir)
  out.note = `элитры: уход ${Math.round(out.ms / 100) / 10} с, хп ${out.hp0}→${out.hp1}${out.ate.length ? ', ' + out.ate.join(' + ') : ''}${hurtAir ? `, в воздухе −${out.hurtAir}` : ''}, посадка ${l.ok ? 'цела' : (l.why || '?')}${l.lost ? ' −' + l.lost : ''}${sw.ok ? '' : ', нагрудник не надел: ' + sw.why}`
  void S
  return out
}

// Пике с булавой. Булава в правой заранее (33 тика заряда: к удару — крит),
// фейерверки в левой; набор высоты над ним со сдвигом, перед пике в левую —
// нагрудник; пике почти отвесно (щит держит по горизонтали — сверху почти
// ноль), за 2–3 тика до руки — нагрудник на тело («использовать» левой):
// полёт кончился, высота падения из пике осталась (MaceItem.canSmashAttack);
// удар в первый тик, когда он в руке и под прицелом. Мимо и высоко —
// элитры обратно и в полёт.
function smashBonus (h) {
  if (!(h > 1.5)) return 0
  if (h <= 3) return 4 * h
  if (h <= 8) return 12 + 2 * (h - 3)
  return 22 + (h - 8)
}

// Щит у него (в руке и не выбит) — пике не делать: он видит взлёт и заход
// (mace.track: «булава сверху») и поднимает щит, а щит держит удар и сверху:
// горизонталь «к источнику» ноль → normalize() ноль → acos(0) = 90°, и это
// ещё «в угле» (BlocksAttacks.DamageReduction.resolve: блок, пока угол ≤ 90°).
// Замер try-elytra «пике» 2026-09-26: 8 пике из 8 в щит — снял 0, себе −15 за
// раунд (высота падения из пике без удара — вся в урон).
function divePlan (bot, e, { d, dy, hp, foeGrounded, hisShield = false, W = worldOf(bot) }: any = {}) {
  if (!ON || hisShield) return null
  const k = kit(bot)
  if (!k.elytra || !k.mace || k.rockets < 2 || !k.chest) return null
  if (!bot.entity || !bot.entity.onGround || bot.entity.isInWater) return null
  if (hp < 9 || !foeGrounded || Math.abs(dy) > 2 || d < 3 || d > 22) return null
  const me = bot.entity.position
  if (headroom(W, me, 12) < 10) return null
  if (headroom(W, e.position, 12) < 9) return null
  return { kind: 'dive' }
}

async function diveSmash (bot, ctl, e, { vel = () => ({ x: 0, y: 0, z: 0 }), stats = {}, used = () => {}, allow = null, maxMs = 12000 }: any = {}) {
  const W = worldOf(bot)
  const S = install(bot)
  const out: any = { ok: false, hit: false, note: '' }
  const t0 = gameClock.now()
  const foe = () => e.position
  const hp0 = bot.health ?? 20
  const hisHp0 = healthOf(bot, e)
  // Подготовка на земле: элитры на тело (правой), булава — в правую (заряд
  // пошёл), фейерверки — в левую.
  const sw = await swapChest(bot, 'elytra', { hand: 'main' })
  if (!sw.ok) { out.note = 'пике: элитры не надел — ' + sw.why; return out }
  const mace = findItem(bot, 'mace')
  try { if (mace && (!bot.heldItem || bot.heldItem.name !== 'mace')) await bot.equip(mace, 'hand') } catch {}
  const maceAt = gameClock.now()
  try { const rk = bot.inventory.items().find(plainRocket); if (rk && !plainRocket(bot.inventory.slots[45])) await bot.equip(rk, 'off-hand') } catch {}
  if (!bot.heldItem || bot.heldItem.name !== 'mace' || !plainRocket(bot.inventory.slots[45])) {
    await swapChest(bot, 'chest')
    out.note = 'пике: булава или фейерверк не в руках'
    return out
  }
  const hands = () => `слот ${bot.quickBarSlot}, в руке ${bot.heldItem ? bot.heldItem.name : '-'}, левая ${offName(bot) || '-'}, грудь ${chestName(bot) || '-'}, хотбар ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => (bot.inventory.slots[36 + i] || {}).name || '-').join(',')}`
  if (DEBUG) console.log('[dive] руки перед взлётом:', hands())
  if (allow) allow()
  const toward = yawTo(bot.entity.position, foe())
  const to = await takeoff(bot, ctl, { pitch: 1.1, yaw: wrap(toward + Math.PI), stats })
  if (!to.ok) { await chestDown(bot, ctl, { stats }); out.note = 'пике: не взлетел — ' + to.why; return out }
  stats.dives = (stats.dives || 0) + 1
  // Набор высоты: точка над ним со сдвигом 6 бл. в нашу сторону, на высоте
  // его ног + 10 (под потолком — ниже).
  const topY = () => {
    const ar = arenaAround(bot, W, bot.entity.position)
    return Math.min(ar.ceilY - BODY_H - 1.4, foe().y + 11)
  }
  let phase = 'climb'
  let chestReady = false
  // Сторона захода — та, где мы были на взлёте: точка над ним не прыгает с
  // одной стороны на другую, пока мы кружим.
  const side = yawTo(foe(), bot.entity.position)
  // Заход — дольше и шире (арена 2026-09-26: он бегает, и за 6 с условие «выше
  // на 8 и ближе 5.5» не выполнялось — «не зашёл сверху (долго)», 5 ракет зря).
  const r: any = await fly(bot, ctl, {
    maxMs: 8000, phase: 'пике: заход',
    stats,
    goal: () => {
      const f = foe()
      const L = lookVec(side, 0)
      const P = new Vec3(f.x + L.x * 3, topY(), f.z + L.z * 3)
      return { kind: 'point', at: P, reach: true, minY: f.y + 3, maxY: topY() + 1, gap: 2.5, speedMin: 0.3 }
    },
    rocketIf: (st) => st.p.y < topY() - 3 ? true : null,
    onTick: () => { if (allow) allow() },
    // Пике — только с заряженной булавой (33 тика с того, как взяли в руку):
    // без крита удар с 6 бл. по алмазу — 8 хп вместо 20 (замер elytra-probe3:
    // пике раньше заряда — свапа нет, и в пол с высотой падения 6.9, −5 себе).
    until: () => {
      const me = bot.entity.position; const f = foe()
      const dh = Math.hypot(me.x - f.x, me.z - f.z)
      return (me.y > f.y + 7 && dh < 6.5 && gameClock.now() - maceAt >= 33 * TICK_MS + 150) ? 'над ним' : null
    }
  })
  if (r.why !== 'над ним') {
    const l: any = bot.entity.elytraFlying ? await land(bot, ctl, { away: null, stats }) : { ok: true }
    await chestDown(bot, ctl, { stats })
    out.note = `пике: не зашёл сверху (${r.why})${l.ok ? '' : ', посадка: ' + l.why}`
    return out
  }
  // Нагрудник — в левую на втором тике пике: на первом — фейерверк из левой
  // (пике на ракете — вниз ~1.5 б/т, высота падения копится сразу; без ракеты
  // медленный спуск держит v.y > −0.5, и высота падения залипает на 1 —
  // замер elytra-probe3: 3 из 6 заходов без ракеты вышли из пике без удара).
  // Ракета — отдельная сущность: уход стопки из руки её не гасит.
  let chestAsked = false
  const askChest = () => {
    if (chestAsked) return
    chestAsked = true
    const cp = bestChest(bot)
    if (cp) bot.equip(cp, 'off-hand').then(() => { chestReady = /_chestplate$/.test(offName(bot) || '') }).catch(() => {})
  }
  let diveRocket = !(bot.fireworkRocketDuration > 3) && plainRocket(bot.inventory.slots[45]) ? 'нужна' : 'нет'
  phase = 'dive'
  // Пике: цель — его голова с упреждением; свап, когда до руки 2–3 тика.
  let swapped: any = false
  let hit = null
  let deployBack = false
  // Сторож ведра (edges.installFallGuard): после свапа мы падаем, и он взвёл
  // бы воду в последний тик — сменой слота на ведро под самым ударом (замер
  // 2026-09-26: удар ушёл «ведром» — 0.04 хп вместо 18). Как у спуска булавы
  // (mace.descend): метка спуска — вода только в последний тик, и наш удар
  // этого тика (bot._ndSmashNow) сторож делает первым.
  const mark = { at: gameClock.now() }
  const res = await new Promise<any>(resolve => {
    let done = false
    S.driving = (S.driving || 0) + 1
    const fin = (why) => { if (done) return; done = true; S.driving = Math.max(0, (S.driving || 1) - 1); bot.removeListener('physicsTick', onT); if (bot._ndDescend === mark) bot._ndDescend = null; resolve(why) }
    const tD = gameClock.now()
    const W2 = W
    const footAt = (t) => { const f = foe(); const tv = vel() || { x: 0, y: 0, z: 0 }; return new Vec3(f.x + tv.x * t, f.y, f.z + tv.z * t) }
    const strikeAt = (t) => footAt(t).offset(0, 2.4, 0)
    const DIVE_PITCHES = [-1.52, -1.4, -1.25, -1.1, -0.95, -0.8, -0.65, -0.5, -0.35, -0.2]
    const onT = () => {
      if (done) return
      try {
        if (ctl.aborted || (bot.health ?? 0) <= 0) return fin('прервали')
        const b = bot.entity
        if (b.onGround) return fin(hit ? 'сел после удара' : 'сел')
        if (gameClock.now() - tD > 3500) return fin('долго')
        if (allow) allow()
        const f = foe()
        const tv = vel() || { x: 0, y: 0, z: 0 }
        const p = b.position; const v = b.velocity
        if (!swapped) {
          // Пике: взгляд, который за 18 тиков проводит нас ближе всего к точке
          // над его головой (2.4 — чтобы свап успел до его рамки), только круто
          // вниз: скорость вниз копит высоту падения (> −0.5), горизонталь для
          // его щита — почти ноль.
          const pl = choose(W2, { p, v, boost: bot.fireworkRocketDuration || 0, fd: S.fd }, { kind: 'strike', at: strikeAt, foot: footAt, pitches: DIVE_PITCHES }, { rocketNow: diveRocket === 'нужна' })
          bot.look(pl.yaw, pl.pitch, true).catch(() => {})
          if (diveRocket === 'нужна') {
            // Взгляд этого тика уйдёт пакетом с ним же — ракета после пакета.
            afterPacket(bot, () => { const fr = fireRocket(bot); if (fr.ok && stats) stats.rockets = (stats.rockets || 0) + 1 })
            diveRocket = 'была'
            return
          }
          askChest()
          // Свап: прогноз свободного падения с этого тика — войдём ли в его руку
          // (глаза 1.62 после свапа) за ≤ 4 тика и выше его головы.
          const q = { x: p.x, y: p.y, z: p.z }; const w = { x: v.x, y: v.y, z: v.z }
          let enter = -1
          for (let t = 1; t <= 6; t++) {
            fallStep(q, w)
            const ep = new Vec3(f.x + tv.x * t, f.y, f.z + tv.z * t)
            const rr = reachFromBox(new Vec3(q.x, q.y + EYE, q.z), ep, 0.6, 1.8)
            if (rr <= REACH - 0.25 && q.y > ep.y + 0.6) { enter = t; break }
          }
          const charged = gameClock.now() - maceAt >= 33 * TICK_MS + 60
          if (DEBUG) console.log('[dive]', JSON.stringify({ t: gameClock.now() - tD, p: [r2(p.x - f.x), r2(p.y - f.y), r2(p.z - f.z)], v: [r2(v.x), r2(v.y), r2(v.z)], enter, charged, chestReady, fd: r2(S.fd), fly: b.elytraFlying }))
          if (enter >= 1 && enter <= 3 && charged && chestReady && S.fd > 1.8 && v.y < -0.45) {
            bot.activateItem(true)
            bot.usingHeldItem = false
            swapped = gameClock.now()
            bot._ndDescend = mark
            if (stats) stats.swaps = (stats.swaps || 0) + 1
          } else if (gameClock.now() - tD > 2500 || (p.y < f.y + 2 && Math.hypot(f.x - p.x, f.z - p.z) > 3)) {
            return fin('промахнулся на подлёте')
          } else {
            // Свапа не будет, а пол близко и высота падения уже набрана —
            // выйти из пике (взгляд вверх: v.y > −0.5 — и высота падения снова
            // ≤ 1), иначе удар о пол.
            const fl0 = W2.floorBelow(p.x, p.y, p.z, 20)
            const hh = fl0 ? p.y - fl0.top : 20
            if (S.fd > 2.5 && hh < 3 + Math.max(0, -v.y) * 3 && enter < 0) return fin('вышел из пике — удара не будет')
          }
          return
        }
        bot._ndDescend = mark
        // После свапа: смотреть на него и бить в первый тик, когда достаём.
        const eye = pick.eyeOf(bot)
        const targetBox = pick.hitboxOf(bot, e)
        const target = new Vec3(f.x, f.y + targetBox.h / 2, f.z)
        bot.look(yawTo(p, target), Math.atan2(target.y - eye.y, Math.max(0.2, Math.hypot(target.x - p.x, target.z - p.z))), true).catch(() => {})
        // Клавиши — к нему (0.02 б/т² в воздухе), без спринта (крит).
        const yawNow = bot.entity.yaw
        const ex = f.x - p.x; const ez = f.z - p.z
        const fwd = ex * -Math.sin(yawNow) + ez * -Math.cos(yawNow)
        const right = ex * Math.cos(yawNow) + ez * -Math.sin(yawNow)
        try { bot.setControlState('forward', fwd > 0.3); bot.setControlState('back', fwd < -0.3); bot.setControlState('right', right > 0.3); bot.setControlState('left', right < -0.3); bot.setControlState('sprint', false) } catch {}
        if (DEBUG) console.log('[dive] после свапа', JSON.stringify({ t: gameClock.now() - swapped, p: [r2(p.x - f.x), r2(p.y - f.y), r2(p.z - f.z)], v: [r2(v.x), r2(v.y), r2(v.z)], r: r2(reachFromBox(eye, f, 0.6, 1.8)), fly: b.elytraFlying, chest: chestName(bot), fd: r2(S.fd) }))
        // Удар — не раньше, чем сервер снял полёт (флаг у нас — по его метаданным
        // или по слоту груди): в одном тике со свапом сервер ещё считает полёт,
        // и удара с падения нет (замер: 2.6 хп вместо 20).
        if (!hit && !b.elytraFlying && gameClock.now() - swapped >= 45 && v.y < 0 && reachFromBox(eye, f, 0.6, 1.8) <= REACH - 0.05) {
          // Булава — в правой (сторож ведра мог сменить слот): слот булавы и
          // удар одним куском; сторож в том же тике зовёт нас первым.
          const doHit = () => {
            try {
              if (ctl.aborted || e.isValid === false || !pick.canHit(bot, e, { range: REACH })) { hit = null; return }
              // Его щит поднят — «оглушающий»: топор и булава в одном тике (mace.slamHit).
              require('./mace').slamHit(bot, e, stats)
            } catch {}
          }
          hit = { at: gameClock.now(), fd: r2(S.fd), hp0: healthOf(bot, e), sinceSwap: gameClock.now() - swapped, fly: !!b.elytraFlying }
          if (DEBUG) console.log('[dive] удар, руки:', hands())
          bot._ndSmashNow = doHit
          afterPacket(bot, () => { if (bot._ndSmashNow === doHit) { bot._ndSmashNow = null; doHit() } })
          return
        }
        // Проскочили мимо и ещё высоко — элитры обратно (левой) и в полёт.
        const f0 = W.floorBelow(p.x, p.y, p.z, 30)
        const h = f0 ? p.y - f0.top : 30
        const away = reachFromBox(eye, f, 0.6, 1.8)
        if (!hit && !deployBack && gameClock.now() - swapped > 150 && away > REACH + 0.5 && h > 3.5 && v.y < -0.3) {
          deployBack = true
          require('./combat/aerial-recovery').beginAerialRecovery(bot, ctl)
          bot.activateItem(true)
          bot.usingHeldItem = false
          gameClock.setTimeout(() => { try { startGlide(bot); bot.look(bot.entity.yaw, 0.5, true).catch(() => {}) } catch {} }, 60)
          return fin('мимо — элитры обратно')
        }
      } catch (err) { fin('ошибка: ' + err.message) }
    }
    bot.on('physicsTick', onT)
  })
  for (const k of KEYS) { try { bot.setControlState(k, false) } catch {} }
  // Мимо на подлёте (не свапнули) — сесть; свапнули и вернули элитры — сесть.
  if (bot.entity.elytraFlying) await land(bot, ctl, { away: null, stats })
  await sleep(250)
  await chestDown(bot, ctl, { stats })
  out.hit = !!hit
  out.ok = true
  const hisHp1 = healthOf(bot, e)
  out.dealt = hit && hisHp0 != null && hisHp1 != null ? r2(Math.max(0, hisHp0 - hisHp1)) : null
  out.self = r2(Math.max(0, hp0 - (bot.health ?? 20)))
  out.fd = hit ? hit.fd : r2(S.fd)
  out.ms = gameClock.now() - t0
  if (hit) { stats.diveHits = (stats.diveHits || 0) + 1; if (out.dealt != null) (stats.diveDealt = stats.diveDealt || []).push(out.dealt) }
  stats.diveSelf = r2((stats.diveSelf || 0) + out.self)
  out.note = `элитры: пике с булавой — ${hit ? `удар с падения ${hit.fd} бл.${out.dealt != null ? `, снял ${out.dealt}` : ''}` : res}${out.self ? `, себе −${out.self}` : ''}`
  void phase
  return out
}

// Расстояние от глаз до рамки (ширина w, высота h) с ногами в pos.
function reachFromBox (eye, pos, w = 0.6, h = 1.8) {
  const hw = w / 2
  const cx = clamp(eye.x, pos.x - hw, pos.x + hw)
  const cy = clamp(eye.y, pos.y, pos.y + h)
  const cz = clamp(eye.z, pos.z - hw, pos.z + hw)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

function healthOf (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' ? h : null
  } catch { return null }
}

// После пакета позиции этого тика (как mace.afterPacket): удар уходит с
// позицией, в которой мы его посчитали.
function afterPacket (bot, fn) {
  let done = false
  const run = () => { if (done) return; done = true; bot.removeListener('physicsTick', run); try { fn() } catch {} }
  bot.prependListener('physicsTick', run)
  setImmediate(run)
}

// ---------------------------------------------------------------- в бою

// На бой: слежка за ним и решения. pvp.js зовёт decide() в цикле; run()
// держит тело до посадки. allow() — отпустить рефлекс края на время полёта
// (он рулил бы клавишами, которые элитрам не нужны).
function create (bot, { enemy, used = () => {}, edgeGuard = null, arena = null }: any = {}) {
  install(bot)
  const createdAt = gameClock.now()
  const guard0 = bot._ndElytra?.guardSaves || 0
  worldOf(bot)
  const fl = track(bot, { enemy })
  const st: any = {}
  const allow = () => { try { if (edgeGuard) edgeGuard.allow(400, 400) } catch {} }
  const aerial = require('./combat/aerial-executor').createAerialCombat(bot, {
    enemy, worldOf, kit, landingSpot, gliding, predictGlider, takeoff, fly, land,
    swapChest, startGlide, allow, used, stats: st
  })
  const lanceMod = require('./combat/aerial-lance')
  let nextDive = 0
  let nextEscape = 0
  let nextLance = 0
  return {
    fl,
    st,
    gliding: () => fl.flying(),
    threat: () => fl.threat(),
    // Что делать сейчас: 'escape' — уход лечиться, 'dive' — пике с булавой.
    decide (ctx) {
      // Без элитр в рюкзаке (весь нынешний «арсенал») — сразу мимо: ни
      // разбора рюкзака, ни прогнозов.
      if (!ON || !bot.entity || !hasElytra(bot)) return null
      const e = enemy()
      if (!e || !e.position) return null
      if (gliding(bot.entity) || gliding(e)) {
        if (ctx.hp <= ctx.healAt && ctx.heal?.() && kit(bot).rockets >= 2 && gameClock.now() >= nextEscape) {
          nextEscape = gameClock.now() + 8000
          return { kind: 'escape' }
        }
        // Таран копьём (s7b): в полёте — тоже, если копьё и ракеты есть, а его щит не в деле.
        if (gameClock.now() >= nextLance && lanceMod.lancePlan(bot, e, ctx)) { nextLance = gameClock.now() + 4000; return { kind: 'lance' } }
        const decision = aerial.decide(undefined, ctx)
        return decision.selected ? { kind: 'aerial', decision } : null
      }
      if (!bot.entity.onGround) return null
      const now = gameClock.now()
      const k = kit(bot)
      if (!k.elytra || k.rockets < 1) return null
      if (ctx.hp <= ctx.healAt && ctx.heal && !ctx.eatSafe && now >= nextEscape && k.rockets >= 2) {
        const W = worldOf(bot)
        if (headroom(W, bot.entity.position, 8) >= 6) { nextEscape = now + 8000; return { kind: 'escape' } }
      }
      if (now >= nextLance && lanceMod.lancePlan(bot, e, ctx)) { nextLance = now + 6000; return { kind: 'lance' } }
      if (now >= nextDive && divePlan(bot, e, ctx)) { nextDive = now + 9000; return { kind: 'dive' } }
      return null
    },
    async run (ctl, plan, ctx: any = {}) {
      const e = enemy()
      if (plan.kind === 'aerial') return aerial.run(ctl, ctx)
      if (plan.kind === 'escape') return escape(bot, ctl, e, { heal: ctx.heal, enough: ctx.enough, stats: st, used, allow, arena })
      if (plan.kind === 'lance') {
        const res: any = await lanceMod.lance(bot, ctl, e, { vel: ctx.vel, stats: st, used, allow, arena })
        // Ни одного попадания — не сразу снова (ракеты и время).
        if (!res.hit) nextLance = gameClock.now() + 15000
        return res
      }
      if (plan.kind === 'dive') {
        const res: any = await diveSmash(bot, ctl, e, { vel: ctx.vel, stats: st, used, allow })
        // Удар дошёл, а урона нет (щит поднял, тотем) или мимо — не повторять
        // сразу: высота падения из пике без удара — вся в урон себе.
        if (!res.hit || !(res.dealt > 1)) nextDive = gameClock.now() + 30000
        return res
      }
      return { ok: false, note: 'нечего' }
    },
    report () {
      const t = fl.report()
      const out = {
        takeoffs: st.takeoffs || undefined,
        rockets: st.rockets || undefined,
        escapes: st.escapes || undefined,
        escapeS: st.escapeMs ? Math.round(st.escapeMs / 100) / 10 : undefined,
        escapeHp: st.escapeHp || undefined,
        hurtAir: st.hurtAir || undefined,
        dives: st.dives || undefined,
        diveHits: st.diveHits || undefined,
        diveDealt: st.diveDealt,
        diveSelf: st.diveSelf || undefined,
        landings: st.landings || undefined,
        landDmg: st.landDmg || undefined,
        aerialNodes: st.aerialNodes,
        airJabs: st.airJabs || undefined,
        airSmashes: st.airSmashes || undefined,
        airPearls: st.airPearls || undefined,
        airArrows: st.airArrows || undefined,
        airArrowHits: st.airArrowHits || undefined,
        lances: st.lances || undefined,
        lancePasses: st.lancePasses || undefined,
        lanceHits: st.lanceHits || undefined,
        lanceDealt: st.lanceDealt,
        lanceSelf: st.lanceSelf || undefined,
        lanceBadLand: st.lanceBadLand || undefined,
        lanceDeaths: st.lanceDeaths || undefined,
        lanceTrace: st.lanceTrace,
        lanceEarly: st.lanceEarly || undefined,
        lanceBail: st.lanceBail || undefined,
        guardSaves: ((bot._ndElytra?.guardSaves || 0) - guard0) || undefined,
        chestAir: st.chestAir || undefined,
        reglide: st.reglide || undefined,
        // Удары о стену/пол себе за этот бой (чёрный ящик install): вид/фаза/урон, † — насмерть; ticks — первого.
        crashes: (() => { const c = (bot._ndElytra?.crashes || []).filter(x => x.at >= createdAt); return c.length ? c.map(x => `${x.kind}/${x.phase || '?'}/−${x.dmg}${x.died ? '†' : ''}`) : undefined })(),
        crashTicks: (() => { const c = (bot._ndElytra?.crashes || []).find(x => x.at >= createdAt); return c ? c.ticks.slice(-6).map(k => `${k.ph || '-'} y${k.y} v${k.vx},${k.vy},${k.vz} fd${k.fd}${k.ef ? '' : ' нет полёта'}${k.fw ? ' ракета' : ''}`) : undefined })(),
        foe: t
      }
      return (Object.values(out) as any[]).some(v => v !== undefined) ? out : undefined
    },
    close () { fl.close() }
  }
}

module.exports = {
  ON, EYE_FLY, FLY_H, lookVec, glideStep, fallStep, rollout, worldOf, install, startGlide, fireRocket, swapChest,
  toHotbar, takeoff, fly, land, landingSpot, choose, headroom, arenaAround, kit, hasElytra, wearingElytra,
  rocketCount, plainRocket, bestChest, gliding, predictGlider, track, nextTick, lavaLaunchClear,
  escape, diveSmash, divePlan, chestDown, smashBonus, reachFromBox, consumeAir, create
}
