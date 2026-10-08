'use strict'
const gameClock = require('./game-clock')
// Булава и заряды ветра (просьба 2026-09-26: «всё, что даёт версия»).
// Четыре вещи:
//  1. Удар с падения: взлёт на заряде ветра под ноги (или спуск со своего
//     столба) и удар булавой на спуске — бонус растёт с высотой падения.
//  2. Заряд ветра как толчок: в яму, со столба, сбить рывок, сбить еду.
//  3. Защита от чужой булавы: щит к нему, без щита — шаг из-под него, не
//     стоять под тем, кто сидит сверху с булавой.
//  4. Посадка: свой заряд — урон от падения только ниже точки всплеска; иначе
//     вода (edges.installFallGuard) или второй заряд под ноги.
//
// Числа — декомпилированный клиент 1.21.11 (github extremeheat/
// extracted_minecraft_data, ветка client1.21.11, пути от net/minecraft/):
//  * world/item/MaceItem: урон 1 + 5, скорость 4 − 3.4 = 0.6 (33 тика заряда);
//    удар с падения, если fallDistance > 1.5 (canSmashAttack); бонус
//    getAttackDamageBonus: 4h до 3 бл., 12 + 2(h − 3) до 8, 22 + (h − 8) выше;
//    после удара (hurtEnemy) вертикальная скорость бьющего 0.01, падение
//    обнулено (postHurtEnemy), точка для урона от падения — ниже из «точки
//    всплеска ветра» и места удара (calculateImpactPosition);
//  * world/entity/player/Player.attack: бонус прибавляется ПОСЛЕ множителя
//    заряда, крит ×1.5 — заряд > 0.9, падение, не спринт (canCriticalAttack);
//    урон и заряд — атрибуты руки (обновятся в тике), предмет для бонуса —
//    getWeaponItem() в момент пакета: свап «меч → булава» в одном тике даёт
//    урон и заряд меча плюс бонус булавы (MC-28289, PVP-RESEARCH б.3);
//  * world/item/WindChargeItem: скорость 1.5, неточность 1.0, появляется в x,z
//    игрока на высоте глаз, + своё смещение (Projectile.shootFromRotation:
//    x,z всегда, y — если не на земле); перезарядка 0.5 с (Items.WIND_CHARGE);
//  * world/entity/projectile/hurtingprojectile/windcharge/AbstractWindCharge:
//    без гравитации и трения; о блок — всплеск в точке удара + 0.25 по нормали
//    грани (onHitBlock), о сущность — 1 урона и всплеск там же (onHitEntity);
//  * .../windcharge/WindCharge + world/level/ServerExplosion.hurtEntities:
//    радиус 1.2, задевает, если НОГИ в 2.4 от центра; толчок
//    (1 − d/2.4)·видимость·1.22 по направлению «центр → глаза»;
//  * server/level/ServerPlayer.onExplosionHit + Player.causeFallDamage: после
//    заряда ветра игрока урон от падения = min(падение, точка всплеска − y):
//    сел не ниже точки всплеска — урона нет (40 тиков «прощения»);
//  * world/entity/LivingEntity.applyItemBlocking: щит держит, если источник
//    в 90° от взгляда ПО ГОРИЗОНТАЛИ; ровно над головой (горизонталь 0) — нет.
// Замеры — daemon/try-mace.js на тестовом сервере (2026-09-26).

const Vec3 = require('vec3')
const edges = require('./edges')
// Честный удар (pick.js, 2026-09-26): сквозь крышу его коробки не бить.
const pick = require('./pick')

const EYE = 1.62
// Player: entity_interaction_range 3.0 — от глаз до рамки цели.
const REACH = 3.0
const MACE_BASE = 6
const SMASH_MIN = 1.5
const WIND_SPEED = 1.5
const WIND_REACH = 2.4
const WIND_KB = 1.22
const BURST_LIFT = 0.25
const WIND_CD_MS = 500
// Атрибут-свап (б.3) на тестовом Paper 1.21.11-132 НЕ работает — замер
// 2026-09-26 (probe-swap): меч заряжен, в одном тике «булава → удар → меч» —
// сервер взял урон и скорость булавы и заряд с нуля (−0.25 хп по алмазу
// вместо −1.89 мечом). Значит, Paper обновляет атрибуты на смене слота. По
// умолчанию выключен; ND_ATTR_SWAP=1 — для ванильного сервера, где он есть.
// Без свапа: булава в руке заранее (33 тика заряда), а заряд ветра — из
// левой руки, чтобы смена предмета не обнулила заряд булавы.
const SWAP = process.env.ND_ATTR_SWAP === '1'
// Свой заряд под ноги — не строго вниз, а на столько блоков за спину: всплеск
// толкает «от центра к глазам», и горизонталь этого толчка несёт к нему.
const LAUNCH_BACK = 0.3

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const yawTo = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z))
const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

function smashBonus (h) {
  if (!(h > SMASH_MIN)) return 0
  if (h <= 3) return 4 * h
  if (h <= 8) return 12 + 2 * (h - 3)
  return 22 + (h - 8)
}

// Урон до брони: (урон × множитель заряда + бонус) × крит. base — атрибут
// руки на момент удара (меч при свапе: 7 у алмазного). density — уровень
// «Плотности» булавы: +0.5 за блок падения на уровень (MaceItem.
// getAttackDamageBonus → modifyFallBasedDamage × fallDistance; арена с чарами).
function smashDamage (h, { base = MACE_BASE, charge = 1, density = 0 }: any = {}) {
  const scale = 0.2 + charge * charge * 0.8
  const crit = charge > 0.9 ? 1.5 : 1
  const dens = h > SMASH_MIN ? 0.5 * density * h : 0
  return (base * scale + smashBonus(h) + dens) * crit
}
function densityOf (bot) {
  const m = findItem(bot, 'mace')
  try { return m ? require('./read').enchLevel(bot, m, 'density') : 0 } catch { return 0 }
}

function reachFrom (eye, e, bot = null) {
  const hw = (e.width || 0.6) / 2
  const h = bot ? pick.hitboxOf(bot, e).h : (e.height || 1.8)
  const p = e.position
  const cx = clamp(eye.x, p.x - hw, p.x + hw)
  const cy = clamp(eye.y, p.y, p.y + h)
  const cz = clamp(eye.z, p.z - hw, p.z + hw)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

// varint с позиции off (сырой пакет: номер пакета впереди или нет).
function readVarIntAt (buf, off) {
  let v = 0; let s = 0; let b
  do { b = buf[off++]; v |= (b & 0x7f) << s; s += 7 } while (b & 0x80 && s < 35)
  return v
}
// Разбор неудачного взлёта одной строкой (windSmash).
function diagText (dg) {
  const r = (x) => Math.round(x * 100) / 100
  const bits = [dg.boom ? `всплеск пришёл, vy до него ${dg.boomVy}` : 'всплеска не было']
  if (dg.kicks) bits.push(`скорость от сервера ×${dg.kicks}`)
  if (dg.off !== 'wind_charge') bits.push(`в левой ${dg.off || 'пусто'}`)
  bits.push(dg.vy0 > 0.2 ? 'прыжок был' : 'без прыжка')
  if (dg.web) bits.push('в паутине')
  bits.push(`vy max ${r(dg.vyMax)}`)
  return bits.join(', ')
}

function countOf (bot, name) {
  return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
}
function findItem (bot, name) {
  return bot.inventory.items().find(i => i.name === name) || null
}
function hotbarIndex (bot, name) {
  for (let i = 0; i < 9; i++) {
    const it = bot.inventory.slots[36 + i]
    if (it && it.name === name) return i
  }
  return -1
}
function healthOf (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' ? h : null
  } catch { return null }
}
function livingFlags (bot, e) {
  try {
    const keys = bot.registry.entitiesByName.player.metadataKeys
    const i = keys.indexOf('living_entity_flags')
    const f = e.metadata[i >= 0 ? i : 8]
    return typeof f === 'number' ? f : 0
  } catch { return 0 }
}
function heldName (e) {
  const eq = e && e.equipment
  return eq && eq[0] ? eq[0].name : ''
}
// Его щит поднят и смотрит на нас (передняя полусфера по горизонтали). Прямо сверху — тоже держит:
// LivingEntity.applyItemBlocking берёт горизонталь к источнику, у нуля normalize() = 0, acos(0) = 90° — ещё в угле
// (BlocksAttacks.DamageReduction: блок, пока угол ≤ 90°, javap 1.21.11; s7b 06.10 — раньше над макушкой считали «мимо»).
function shieldAtUs (bot, e, at = bot.entity.position) {
  const f = livingFlags(bot, e)
  if (!(f & 0x01)) return false
  const eq = e.equipment || []
  const it = (f & 0x02) ? eq[1] : eq[0]
  if (!it || it.name !== 'shield') return false
  const fx = -Math.sin(e.yaw || 0); const fz = -Math.cos(e.yaw || 0)
  const tx = at.x - e.position.x; const tz = at.z - e.position.z
  const h = Math.hypot(tx, tz)
  if (h < 0.35) return true
  return (fx * tx + fz * tz) / h >= -0.02
}

// Удар булавой с падения по поднятому щиту — 0 урона (s7c: 2 из 5 «снял 0» — щит; булава щит не выбивает:
// Items.MACE Weapon(1)). «Оглушающий удар» (stun slam): в одном тике топор (Weapon axe: щит на 5 с в откат,
// BlocksAttacks.disable → stopUsingItem) и сразу булава — она уже не в щит. Бонус падения к заряду не привязан
// (Player.attack: getAttackDamageBonus прибавляется после множителя заряда, javap 1.21.11), так что сброс заряда
// топором удар с падения не портит. Возвращает true, если был топор.
function slamHit (bot, e, stats = null) {
  const mi = hotbarIndex(bot, 'mace')
  const cur = bot.quickBarSlot
  let ai = -1
  if (shieldAtUs(bot, e)) for (let i = 0; i < 9; i++) { const it = bot.inventory.slots[36 + i]; if (it && /_axe$/.test(it.name)) { ai = i; break } }
  if (ai >= 0) {
    bot.setQuickBarSlot(ai)
    bot.attack(e)
    if (stats) stats.stunSlams = (stats.stunSlams || 0) + 1
  }
  if (mi >= 0 && bot.quickBarSlot !== mi) bot.setQuickBarSlot(mi)
  bot.attack(e)
  return { stun: ai >= 0, swapped: mi >= 0 && mi !== cur, cur }
}

// Сделать fn после пакета позиции этого тика: setImmediate — или в начале
// следующего тика, если он пришёл раньше. mineflayer, отстав, гонит два тика
// физики подряд в одном таймере, и setImmediate срабатывал уже ПОСЛЕ пакета
// приземления: сервер обнулял высоту падения до удара, и булава била без
// бонуса (замер 2026-09-26: из трёх ударов с 8 бл. два — по 1.56 хп, один
// убил; в трассе тики с одной меткой времени).
function afterPacket (bot, fn) {
  let done = false
  const run = () => {
    if (done) return
    done = true
    bot.removeListener('physicsTick', run)
    try { fn() } catch {}
  }
  bot.prependListener('physicsTick', run)
  setImmediate(run)
}

const nextTick = (bot) => new Promise<any>(resolve => {
  const on = () => { gameClock.clearTimeout(t); resolve(true) }
  const t = gameClock.setTimeout(() => { bot.removeListener('physicsTick', on); resolve(false) }, 300)
  bot.once('physicsTick', on)
})

// Перезарядка заряда ветра — по пакету set_cooldown (группа minecraft:
// wind_charge): mineflayer его не разбирает (ждёт itemID, а в 1.21.11 там
// cooldownGroup), читаем сырой пакет, один раз на бота.
function install (bot) {
  if (bot._ndMaceInstalled) return
  bot._ndMaceInstalled = true
  bot._ndWindCd = 0
  try {
    bot._client.on('set_cooldown', (p) => {
      const g = String((p && p.cooldownGroup) || '')
      if (/wind_charge/.test(g)) bot._ndWindCd = gameClock.now() + Math.max(0, p.cooldownTicks || 0) * 50
    })
  } catch {}
  // Когда булава взята в правую: заряд (33 тика) считается от смены предмета.
  bot._ndMaceHeldAt = 0
  bot.on('heldItemChanged', (it) => {
    if (it && it.name === 'mace') { if (!bot._ndMaceHeldAt) bot._ndMaceHeldAt = gameClock.now() } else bot._ndMaceHeldAt = 0
  })
  // Сторож ведра (edges.installFallGuard) спрашивает, не прикрыто ли падение
  // зарядом ветра: тогда вода не нужна, а рука занята булавой.
  bot._ndWindFall = (top) => {
    const w = bot._ndWind
    if (!w || gameClock.now() > w.until) return false
    // Урон = floor(min(падение, всплеск − y) − 3): сел не ниже всплеска − 3 — ноль.
    return top >= w.impactY - 3 + 0.2
  }
}

// Заряды ветра в левой руке (слот 45).
function offWind (bot) {
  const it = bot.inventory.slots[45]
  return !!(it && it.name === 'wind_charge')
}

// Сколько зарядов: рюкзак (inventory.items() — слоты 9..44) и левая рука.
function windCount (bot) {
  return countOf(bot, 'wind_charge') + (offWind(bot) ? bot.inventory.slots[45].count : 0)
}

function windReady (bot) {
  return gameClock.now() >= (bot._ndWindCd || 0) && windCount(bot) > 0
}

// Нужное — в хотбар (свап берёт слоты хотбара, из рюкзака — только кликами).
// Не на выбранный слот и не поверх оружия, еды, тотема, ведра.
const KEEP = /_sword$|_axe$|^mace$|^wind_charge$|^bow$|^crossbow$|^totem_of_undying$|golden_apple$|^water_bucket$|^ender_pearl$|^shield$/
async function ensureHotbar (bot, names) {
  for (const name of names) {
    if (hotbarIndex(bot, name) >= 0) continue
    const it = findItem(bot, name)
    if (!it) return false
    if (bot.currentWindow || bot.inventory.selectedItem) return false
    let dest = -1
    for (let i = 0; i < 9; i++) if (i !== bot.quickBarSlot && !bot.inventory.slots[36 + i]) { dest = i; break }
    if (dest < 0) for (let i = 8; i >= 0; i--) { const s = bot.inventory.slots[36 + i]; if (i !== bot.quickBarSlot && s && !KEEP.test(s.name)) { dest = i; break } }
    if (dest < 0) return false
    try { await bot.moveSlotItem(it.slot, 36 + dest) } catch { return false }
    if (hotbarIndex(bot, name) < 0) return false
  }
  return true
}

// Заряд ветра на тике физики: aim() считает взгляд по позиции этого тика
// (пакет позиции уйдёт с ним же), бросок — после пакета (afterPacket; как у
// лука и броска, throw.js). Заряды в левой руке — «использовать» левой, правая
// не меняется. Иначе — выбрать слот заряда, «использовать» и (swap) сразу
// вернуть прежний: на Paper заряд меча всё равно обнулится (см. SWAP), зато
// меч снова в руке без лишнего тика.
function fireWind (bot, aim, { swap = SWAP, before = null, hand = null }: any = {}) {
  return new Promise<any>(resolve => {
    const off = hand === 'off' || (hand == null && offWind(bot))
    const wi = off ? -1 : hotbarIndex(bot, 'wind_charge')
    if (!off && wi < 0) return resolve({ fired: false, why: 'заряда нет в хотбаре' })
    if (gameClock.now() < (bot._ndWindCd || 0)) return resolve({ fired: false, why: 'перезарядка' })
    let done = false
    const onT = () => {
      if (done) return
      done = true
      gameClock.clearTimeout(timer)
      bot.removeListener('physicsTick', onT)
      let sol = null
      try { if (before) before(); sol = aim() } catch {}
      if (!sol) return resolve({ fired: false, why: 'некуда' })
      bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      afterPacket(bot, () => {
        try {
          const back = bot.quickBarSlot
          if (off) bot.activateItem(true)
          else {
            if (back !== wi) bot.setQuickBarSlot(wi)
            bot.activateItem()
            if (swap && back !== wi) bot.setQuickBarSlot(back)
          }
          // Заряд — не «натягивают»: mineflayer иначе считает руку занятой.
          bot.usingHeldItem = false
          bot._ndWindCd = gameClock.now() + WIND_CD_MS
          resolve({ fired: true, yaw: sol.yaw, pitch: sol.pitch, from: bot.entity.position.clone(), off, swapped: !off && swap && back !== wi })
        } catch (e) { resolve({ fired: false, why: e.message }) }
      })
    }
    const timer = gameClock.setTimeout(() => { if (!done) { done = true; bot.removeListener('physicsTick', onT); resolve({ fired: false, why: 'физика стоит' }) } }, 400)
    bot.on('physicsTick', onT)
  })
}

// Верх опоры под телом (edges.support: самая высокая колонка под углами рамки).
function floorTop (bot, pos) {
  try {
    const s = edges.support(bot, pos, new Map())
    return Number.isFinite(s.drop) ? pos.y - s.drop : -Infinity
  } catch { return -Infinity }
}

// Стоит ли он на чём-то: mineflayer onGround чужих сущностей не ведёт вовсе
// (entities.js его не пишет — поле всегда undefined), поэтому по опоре под
// рамкой (edges.support) и по вертикальной скорости.
function grounded (bot, e, vy = 0) {
  if (!e || !e.position) return true
  if (Math.abs(vy) > 0.1) return false
  try {
    const s = edges.support(bot, e.position, new Map())
    return s.drop <= 0.05
  } catch { return true }
}

// Огонь и лава у ног в радиусе r: сесть туда после взлёта — 4 хп за 10 тиков
// (арена 2026-09-26: удар с падения убил, а сам сел в лаву — −11 и смерть).
const BURN = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/
function burnNear (bot, pos, r = 2.5) {
  const c = pos.floored()
  for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
    for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
      if (dx * dx + dz * dz > r * r + 0.5) continue
      for (const dy of [0, -1]) {
        const b = bot.blockAt(c.offset(dx, dy, dz))
        if (b && BURN.test(b.name)) return true
      }
    }
  }
  return false
}

// Где сядем с этими клавишами (2026-09-26): прогон той же физики
// (prismarine-physics мимо рефлекса края — bot._ndSimOrig) до первой опоры или
// лавы; burn — посадка в лаву, огонь, магму, костёр.
function burnAt (bot, pos) {
  for (const [sx, sz] of [[0, 0], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
    for (const dy of [0.2, -0.5]) {
      const b = bot.blockAt(new Vec3(Math.floor(pos.x + sx), Math.floor(pos.y + dy), Math.floor(pos.z + sz)))
      if (b && BURN.test(b.name)) return true
    }
  }
  return false
}
function landing (bot, control) {
  try {
    const sim = (bot._ndSimOrig || bot.physics.simulatePlayer).bind(bot.physics)
    const world = { getBlock: (p) => bot.blockAt(p, false) }
    const st = edges.stateOf(bot, control)
    for (let t = 0; t < 60; t++) {
      sim(st, world)
      if (st.isInLava) return { at: st.pos, burn: true, t }
      if (st.onGround) return { at: st.pos, burn: burnAt(bot, st.pos), t }
    }
    return { at: st.pos, burn: false, t: 60 }
  } catch { return null }
}
const NO_KEYS = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
const AIR_KEYS = [{}, { forward: true }, { back: true }, { left: true }, { right: true }, { forward: true, left: true }, { forward: true, right: true }, { back: true, left: true }, { back: true, right: true }].map(k => ({ ...NO_KEYS, ...k }))

// Паутина в рамке тела (ноги и голова, четыре угла) — prismarine ставит
// isInWeb по тем же клеткам.
function webOnBody (bot) {
  if (bot.entity && bot.entity.isInWeb) return true
  const p = bot.entity.position
  for (const [dx, dz] of [[0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
    for (const dy of [0.1, 1.0, 1.7]) {
      const b = bot.blockAt(new Vec3(Math.floor(p.x + dx), Math.floor(p.y + dy), Math.floor(p.z + dz)))
      if (b && b.name === 'cobweb') return true
    }
  }
  return false
}

// Сколько блоков воздуха над головой (до n).
function headroom (bot, pos, n = 14) {
  const f = pos.floored()
  for (let i = 2; i < n + 2; i++) {
    for (const [dx, dz] of [[0, 0], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
      const b = bot.blockAt(new Vec3(Math.floor(pos.x + dx), f.y + i, Math.floor(pos.z + dz)))
      if (!b || b.boundingBox !== 'empty') return i - 2
    }
  }
  return n
}

// ---------------------------------------------------------------- слежка

// За ним на каждом тике физики: вертикальная скорость по позициям (скорость
// сущностей из пакетов mineflayer на 1.21.11 делит на 8000 — edges.
// fixSelfKnockback), взлёт (быстрее прыжка: прыжок 0.42 б/т), вершина полёта,
// что в руке. Отсюда threat() — «булава сверху».
function track (bot, { enemy, telemetryHp = e => healthOf(bot, e) }: any) {
  install(bot)
  const st: any = {
    launches: 0, launched: 0, peaks: [], smashes: 0, smashHits: 0, dealt: [], selfDmg: 0, fallSmash: 0,
    pushes: 0, pushHits: 0, knockoffs: 0, pushWhy: {}, threats: 0, shieldUps: 0, dodges: 0, threatHp: 0,
    counterHits: 0, mlg: 0
  }
  const his = { id: null, y: null, vy: 0, air: false, launchedAt: 0, peak: null, maceAt: 0, airSince: 0, hist: [] }
  let active = null
  let pushWatch = null
  let hpLast = bot.health ?? 20
  const onHealth = () => {
    const now = bot.health ?? 20
    if (active && now < hpLast) st.threatHp += hpLast - now
    hpLast = now
  }
  const onTick = () => {
    try {
      const e = enemy()
      if (!e || !e.position || e.isValid === false) return
      if (his.id !== e.id) { his.id = e.id; his.y = null; his.air = false; his.peak = null; his.launchedAt = 0; his.hist = [] }
      const y = e.position.y
      // Позиции чужих приходят пакетами, не в такт нашему тику: скорость — по
      // окну в ~150 мс, иначе она скачет между нулём и двойной.
      const now = gameClock.now()
      his.hist.push({ y, t: now })
      while (his.hist.length > 2 && now - his.hist[0].t > 160) his.hist.shift()
      const h0 = his.hist[0]
      const vy = now - h0.t > 30 ? (y - h0.y) / ((now - h0.t) / 50) : 0
      his.y = y
      his.vy = vy
      const air = !grounded(bot, e, vy)
      if (air && !his.air) { his.airSince = gameClock.now(); his.peak = y }
      if (!air) { his.peak = null; his.launchedAt = 0 }
      his.air = air
      if (air && (his.peak == null || y > his.peak)) his.peak = y
      if (air && vy > 0.55) his.launchedAt = gameClock.now()
      if (heldName(e) === 'mace') his.maceAt = gameClock.now()
      // Итог толчка: упал ниже, чем стоял, на 3+ — сбили.
      if (pushWatch && pushWatch.id === e.id) {
        if (y < pushWatch.y0 - 3 && !pushWatch.fell) { pushWatch.fell = true; st.knockoffs++ }
        const hp = telemetryHp(e)
        if (hp != null && pushWatch.hp0 != null && hp < pushWatch.hp0 - 0.4 && !pushWatch.hurt) { pushWatch.hurt = true; st.pushHits++ }
        if (gameClock.now() > pushWatch.until) pushWatch = null
      }
    } catch {}
  }
  bot.on('physicsTick', onTick)
  bot.on('health', onHealth)

  // Он в воздухе над нами после взлёта (или с булавой в руке) и может
  // достать при спуске — или сидит сверху с булавой. null — угрозы нет.
  const threat = () => {
    const e = enemy()
    if (!e || !e.position || e.isValid === false || !bot.entity) return (active = null)
    const me = bot.entity.position
    const dy = e.position.y - me.y
    const dh = Math.hypot(e.position.x - me.x, e.position.z - me.z)
    const mace = gameClock.now() - his.maceAt < 4000
    // Подбросили его мы сами (свой заряд в него) — это не его взлёт.
    const ours = pushWatch && pushWatch.id === e.id && gameClock.now() - pushWatch.at < 2000
    const launched = his.launchedAt && gameClock.now() - his.launchedAt < 2500 && !ours
    let out = null
    // Без взлёта и без булавы — только настоящее падение на нас (уже летит
    // вниз и упал от вершины на 1.5+): подпрыгивать на своём столбе — не угроза
    // (арена 2026-09-26: «булава сверху ×21» от прыжков на столбе).
    const dropping = his.vy < -0.3 && his.peak != null && his.peak - e.position.y > 1.5 && his.peak - me.y > 3.5 && dh < 3.5
    if (his.air && dy > 1.5 && dh < 5.5 && (launched || mace || dropping)) {
      // Когда он будет на высоте нашей головы: прогон по вертикали.
      let yy = e.position.y; let vv = his.vy; let n = 0
      const headY = me.y + 1.8
      while (n < 40 && !(vv < 0 && yy <= headY + 1.2)) { vv = (vv - 0.08) * 0.98; yy += vv; n++ }
      out = { kind: 'air', dy, dh, vy: his.vy, eta: n, mace, launched: !!launched, peak: his.peak }
    } else if (!his.air && mace && dy > 2.4 && dh < 3.6) {
      out = { kind: 'above', dy, dh, eta: 99, mace: true }
    }
    if (out && !active) st.threats++
    // Та же угроза, что и тиком раньше, — тот же объект: на нём метки «щит уже
    // подняли», «уже уходил» (счёт в отчёте — по угрозам, не по тикам).
    if (out && active && active.kind === out.kind) { Object.assign(active, out); return active }
    active = out
    return out
  }

  return {
    st,
    his,
    threat,
    notePush (e, why) {
      st.pushes++
      st.pushWhy[why] = (st.pushWhy[why] || 0) + 1
      pushWatch = { id: e.id, y0: e.position.y, hp0: telemetryHp(e), at: gameClock.now(), until: gameClock.now() + 3000 }
    },
    report () {
      const avg = a => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length * 10) / 10 : undefined
      const out = {
        launches: st.launches || undefined,
        launched: st.launched || undefined,
        peak: st.peaks.length ? avg(st.peaks) : undefined,
        smashes: st.smashes || undefined,
        smashHits: st.smashHits || undefined,
        fallSmash: st.fallSmash || undefined,
        stunSlams: st.stunSlams || undefined,
        dealt: st.dealt.length ? st.dealt.map(x => Math.round(x * 10) / 10) : undefined,
        selfDmg: st.selfDmg ? Math.round(st.selfDmg * 10) / 10 : undefined,
        pushes: st.pushes || undefined,
        pushHits: st.pushHits || undefined,
        knockoffs: st.knockoffs || undefined,
        pushWhy: Object.keys(st.pushWhy).length ? st.pushWhy : undefined,
        threats: st.threats || undefined,
        shieldUps: st.shieldUps || undefined,
        dodges: st.dodges || undefined,
        threatHp: st.threatHp ? Math.round(st.threatHp * 10) / 10 : undefined,
        counterHits: st.counterHits || undefined,
        mlg: st.mlg || undefined,
        // 2026-09-26: второй заряд стоя после неудачного взлёта; увёл посадку
        // из огня/лавы или не смог.
        retries: st.retries || undefined,
        burnDodge: st.burnDodge || undefined,
        burnNoWay: st.burnNoWay || undefined
      }
      return (Object.values(out) as any[]).some(v => v !== undefined) ? out : undefined
    },
    close () {
      bot.removeListener('physicsTick', onTick)
      bot.removeListener('health', onHealth)
    }
  }
}

// ---------------------------------------------------------------- удар

// Когда взлетать. Он рядом по горизонтали (долететь рулём в воздухе:
// ускорение 0.02 б/т², трение 0.91 — за 25 тиков до ~4 блоков), на нашей
// высоте и на земле; его щит не смотрит на нас (передний щит держит удар
// булавы целиком); над головой есть воздух; вокруг нет ям (снесёт — и сели
// ниже всплеска). Ожидаемый урон — по высоте, какую даст потолок.
// Он в коробке: крыша над головой и стены с трёх сторон — сверху булавой не
// достать, прицел упрётся в крышу или стену (pick.js). Взлетать незачем.
function boxedIn (bot, e) {
  const c = e.position.floored()
  const hard = (p) => { const b = bot.blockAt(p); return !!b && (b.boundingBox === 'block' || b.name === 'cobweb') }
  if (!hard(c.offset(0, 2, 0))) return false
  let walls = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (hard(c.offset(dx, 1, dz))) walls++
  return walls >= 3
}

function smashPlan (bot, e, { minRoom = 5 }: any = {}) {
  const b = bot.entity
  if (!b || !b.onGround || b.isInWater || b.isInLava) return null
  if (boxedIn(bot, e)) return null
  // В паутине всплеск не поднимет (webOnBody ниже, 2026-09-26).
  if (webOnBody(bot)) return null
  if (!findItem(bot, 'mace') || !windReady(bot)) return null
  const me = b.position
  const dh = Math.hypot(e.position.x - me.x, e.position.z - me.z)
  const dy = e.position.y - me.y
  if (dh < 0.6 || dh > 4.2 || Math.abs(dy) > 1.0) return null
  if (shieldAtUs(bot, e)) return null
  const room = headroom(bot, me, 12)
  if (room < minRoom) return null
  try {
    const cache = new Map()
    if (edges.hazardAround(bot, me, 3, cache) || edges.hazardAround(bot, e.position, 3, cache)) return null
  } catch {}
  if (burnNear(bot, me) || burnNear(bot, e.position)) return null
  // Вершина (замер probe-mace 2026-09-26): стоя 6.1 бл., с прыжком 8.3–11.2;
  // потолок срезает. Удар — у самой земли, падение ≈ вершина. Булава к удару
  // заряжена (windSmash держит её с запасом) — крит.
  const top = Math.min(8, room - 0.2)
  const h = Math.max(0, top - 0.3)
  return { dh, room, h, expect: Math.round(smashDamage(h, { base: SWAP ? 7 : MACE_BASE, charge: 1, density: densityOf(bot) })) }
}

// Спуск на цель: рулить в воздухе к точке, где он будет, и ударить булавой в
// последний тик, когда ещё достаём (дальше — земля или он выйдет из руки):
// бонус растёт с высотой. Своей скоростью по вертикали и сносом по
// горизонтали считаем, где окажемся; клавиши — относительно взгляда на него.
// Без спринта: спринт снимает крит.
function descend (bot, ctl, e, { vel = () => ({ x: 0, y: 0, z: 0 }), swap = SWAP, maxMs = 3500, windMlg = true, stats = null, telemetryHp = e => healthOf(bot, e) }: any = {}) {
  return new Promise<any>(resolve => {
    const t0 = gameClock.now()
    let peak = bot.entity.position.y
    let hit = null
    let done = false
    let lastYaw = bot.entity.yaw
    let mlgFired = false
    const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
    // Сторож ведра (edges.installFallGuard) видит спуск и бросает воду только в
    // последний тик, а наш удар этого тика делает первым (bot._ndSmashNow) —
    // раньше ведро отнимало руку и взгляд посреди спуска (2026-09-26).
    const mark = { at: t0 }
    bot._ndDescend = mark
    let burnNext = 0
    let burnPlan = null
    const burnSteer = () => {
      const now = gameClock.now()
      if (now < burnNext) return burnPlan
      burnNext = now + 100
      if (bot.entity.onGround || bot.entity.isInWater) return (burnPlan = null)
      const cur = { ...NO_KEYS }
      for (const k of ['forward', 'back', 'left', 'right']) cur[k] = bot.getControlState(k)
      const here = landing(bot, cur)
      if (!here || !here.burn) return (burnPlan = null)
      let best = null
      for (const c of AIR_KEYS) {
        const l = landing(bot, c)
        if (!l || l.burn) continue
        const d = e && e.position ? Math.hypot(l.at.x - e.position.x, l.at.z - e.position.z) : 0
        if (!best || d < best.d) best = { keys: c, d }
      }
      if (stats && !burnPlan) { if (best) stats.burnDodge = (stats.burnDodge || 0) + 1; else stats.burnNoWay = (stats.burnNoWay || 0) + 1 }
      burnPlan = best ? { keys: best.keys } : { keys: null, none: true }
      return burnPlan
    }
    const finish = (why) => {
      if (done) return
      done = true
      if (bot._ndDescend === mark) bot._ndDescend = null
      bot.removeListener('physicsTick', onT)
      for (const k of KEYS) set(k, false)
      resolve({ peak, hit, why, ms: gameClock.now() - t0 })
    }
    const onT = () => {
      try {
        if (done) return
        if (ctl.aborted || !bot.entity || (bot.health ?? 0) <= 0) return finish('прервали')
        const b = bot.entity
        const p = b.position
        if (p.y > peak) peak = p.y
        if (b.onGround && gameClock.now() - t0 > 120) return finish(hit ? 'сел после удара' : 'сел')
        if (b.isInWater) return finish('в воде')
        if (gameClock.now() - t0 > maxMs) return finish('долго')
        const v = b.velocity
        const top = floorTop(bot, p)
        // Посадка в лаву или огонь (2026-09-26): он вылил лаву или поджёг
        // место, куда мы сядем, пока летим, — рулить прочь (в воздухе клавиши
        // дают ~0.02 б/т², за 10–20 тиков до блока в сторону). Раз в 100 мс
        // прогон физики до земли с нынешними клавишами; в огонь — восемь
        // сторон, берём ту, где посадка чистая и ближе к нему. Удар — как был:
        // клавиши ему не нужны.
        const burn = burnSteer()
        const applyBurn = () => { for (const k of ['forward', 'back', 'left', 'right']) set(k, !!burn.keys[k]); set('sprint', false); set('jump', false) }
        if (hit) {
          if (burn && burn.keys) applyBurn()
          else for (const k of KEYS) set(k, false)
          const hp = telemetryHp(e)
          if (hp != null && (hit.hpMin == null || hp < hit.hpMin)) hit.hpMin = hp
          return
        }
        if (!e.isValid) {
          if (burn && burn.keys) applyBurn()
          else for (const k of KEYS) set(k, false)
          return
        }
        const tv = vel() || { x: 0, y: 0, z: 0 }
        const ep = e.position
        // Где мы по вертикали: тики до «ноги на уровне его головы + 1».
        let n = 0; let yy = p.y; let vv = v.y
        const hitY = ep.y + 1.0
        while (n < 40 && !(vv < 0 && yy <= hitY)) { yy += vv; vv = (vv - 0.08) * 0.98; n++ }
        n = Math.max(1, n)
        const dh = Math.hypot(ep.x - p.x, ep.z - p.z)
        if (dh > 0.25) lastYaw = yawTo(p, ep)
        const yaw = lastYaw
        // Целимся не точно в него, а на 0.6 перед ним (со своей стороны): над
        // самой макушкой горизонталь для щита — ноль (applyItemBlocking), и
        // удобнее бить: глаза ближе к его рамке.
        const aimX = ep.x + tv.x * n + Math.sin(yaw) * 0.6
        const aimZ = ep.z + tv.z * n + Math.cos(yaw) * 0.6
        const pitch = Math.atan2(ep.y + pick.hitboxOf(bot, e).h / 2 - pick.eyeOf(bot).y, Math.max(0.3, dh))
        bot.look(yaw, pitch, true).catch(() => {})
        // Снос без клавиш (трение в воздухе 0.91): v·(1 − 0.91ⁿ)/0.09.
        const k = (1 - Math.pow(0.91, n)) / 0.09
        const ex = aimX - (p.x + v.x * k); const ez = aimZ - (p.z + v.z * k)
        const fwd = ex * -Math.sin(yaw) + ez * -Math.cos(yaw)
        const right = ex * Math.cos(yaw) + ez * -Math.sin(yaw)
        set('forward', fwd > 0.3); set('back', fwd < -0.3)
        set('right', right > 0.3); set('left', right < -0.3)
        set('sprint', false); set('jump', false); set('sneak', false)
        if (burn && burn.keys) applyBurn()
        // Удар: падаем, высота падения > 1.5, достаём — и дальше не будет
        // лучше: на следующем тике земля или он вне руки.
        const fall = peak - p.y
        const eye = pick.eyeOf(bot)
        const rNow = reachFrom(eye, e, bot)
        const pNext = p.plus(v)
        const rNext = reachFrom(pNext.offset(0, pick.eyeHeight(bot), 0), { ...e, position: ep.offset(tv.x, tv.y || 0, tv.z) }, bot)
        const landNext = v.y < 0 && pNext.y <= top + 0.05
        if (process.env.ND_DEBUG_MACE) console.log('[mace]', JSON.stringify({ t: gameClock.now() - t0, y: +(p.y - top).toFixed(2), vy: +v.y.toFixed(3), fall: +(peak - p.y).toFixed(2), r: +rNow.toFixed(2), rN: +rNext.toFixed(2), landNext, dh: +dh.toFixed(2), ey: +(ep.y - top).toFixed(2) }))
        // Удар — только если он под прицелом, как у клиента: сквозь крышу его
        // коробки или стенку сервер удар бы принял, а игрок так не может.
        if (v.y < 0 && fall > SMASH_MIN + 0.1 && rNow <= REACH - 0.05 && (landNext || rNext > REACH - 0.1 || fall > 14) && pick.canHit(bot, e, { eye, range: REACH })) {
          const hp0 = telemetryHp(e)
          hit = { fall: Math.round(fall * 100) / 100, r: Math.round(rNow * 100) / 100, hp0, at: gameClock.now(), charged: !!(bot._ndMaceHeldAt && gameClock.now() - bot._ndMaceHeldAt >= 1550), selfHp: bot.health ?? 20 }
          const doHit = () => {
            try {
              if (ctl.aborted || e.isValid === false || !pick.canHit(bot, e, { range: REACH })) { hit = null; return }
              const sh = slamHit(bot, e, stats)
              if (swap && sh.swapped) bot.setQuickBarSlot(sh.cur)
              hit.swapped = swap && sh.swapped
              hit.stun = sh.stun
            } catch {}
          }
          bot._ndSmashNow = doHit
          afterPacket(bot, () => { if (bot._ndSmashNow === doHit) { bot._ndSmashNow = null; doHit() } })
          return
        }
        // Мимо и садимся ниже, чем прощает всплеск (или падения своего нет) —
        // второй заряд под ноги за пару тиков до земли, если ведра нет.
        const w = bot._ndWind
        const h = p.y - top
        const hurtFall = w && gameClock.now() < w.until ? (w.impactY - top) : (peak - top)
        if (windMlg && !mlgFired && v.y < -0.35 && hurtFall > 3.6 && h > 1.0 && h < 3.2 && !findItem(bot, 'water_bucket') && windReady(bot)) {
          mlgFired = true
          fireWind(bot, () => ({ yaw: bot.entity.yaw, pitch: -Math.PI / 2 }), { swap: true }).then((r : any) => {
            if (r.fired) { bot._ndWind = { impactY: bot.entity.position.y, until: gameClock.now() + 2000 }; if (stats) stats.mlg++ }
          })
        }
      } catch (err) { finish('ошибка: ' + err.message) }
    }
    bot.on('physicsTick', onT)
  })
}

// Взлёт на заряде ветра и удар с падения. Без свапа (Paper, см. SWAP):
// булава — в правую заранее (крит от заряда > 0.9: 30 тиков из 33), заряды
// ветра — в левую (смена ЛЕВОЙ руки заряд правой не трогает: Player.tick
// сверяет только главную руку), щит или тотем из левой — в рюкзак и обратно
// после посадки. Прыжок и в следующем тике (уже в воздухе, пакет позиции
// ушёл) — заряд под ноги, чуть за спину: всплеск в 0.25 над полом, толчок «от
// центра к глазам» — вверх и немного к нему.
// stillOk() — пока копится заряд булавы, он не ушёл и не поднял щит.
async function windSmash (bot, ctl, e, { vel, swap = SWAP, stats = null, jump = true, chargeTicks = 9, stillOk = null, telemetryHp = e => healthOf(bot, e) }: any = {}) {
  const out: any = { launched: false, hit: false, swung: false, note: '' }
  install(bot)
  const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
  const offBefore = bot.inventory.slots[45] ? bot.inventory.slots[45].name : null
  const restoreOff = async () => {
    if (!offBefore || offBefore === 'wind_charge') return
    const it = findItem(bot, offBefore)
    if (it && !(bot.inventory.slots[45] && bot.inventory.slots[45].name === offBefore)) { try { await bot.equip(it, 'off-hand') } catch {} }
  }
  let armedAt = gameClock.now()
  if (swap) {
    if (!(await ensureHotbar(bot, ['wind_charge', 'mace']))) { out.note = 'булава: заряд или булава не в хотбаре'; return out }
    armedAt = 0
  } else {
    const m = findItem(bot, 'mace')
    if (!m) { out.note = 'булава: нет булавы'; return out }
    if (!bot.heldItem || bot.heldItem.name !== 'mace') { try { await bot.equip(m, 'hand') } catch {} }
    armedAt = gameClock.now()
    if (!offWind(bot)) {
      const w = findItem(bot, 'wind_charge')
      if (w) { try { await bot.equip(w, 'off-hand') } catch {} }
    }
    if (!offWind(bot) || !bot.heldItem || bot.heldItem.name !== 'mace') { await restoreOff(); out.note = 'булава: не взял булаву и заряд в руки'; return out }
  }
  // Заряд булавы до взлёта: сам полёт ~25 тиков.
  while (gameClock.now() - armedAt < chargeTicks * 50 && !ctl.aborted) {
    await sleep(50)
    if (stillOk && !stillOk()) { await restoreOff(); out.note = 'булава: передумал взлетать'; out.cancelled = true; return out }
  }
  // Пока заряжалась булава, его удар мог подбросить: прыжок — только с земли,
  // а всплеск под летящим телом — вдалеке от ног. Ждём землю до 300 мс, иначе
  // не взлетать (2026-09-26).
  const tg = gameClock.now()
  while (!bot.entity.onGround && !ctl.aborted && gameClock.now() - tg < 300) await nextTick(bot)
  if (!bot.entity.onGround) { await restoreOff(); out.note = 'булава: передумал взлетать (не на земле)'; out.cancelled = true; return out }
  // Паутина на теле или блок над головой — всплеск не поднимет: в паутине
  // скорость гасится каждый тик (WebBlock.entityInside → makeStuckInBlock),
  // потолок её обнуляет. Арена 2026-09-26: «всплеск пришёл, vy 1.02 … vy max
  // −0.08» без толчков сервера — ровно (0 − 0.08)·0.98 после обнуления; его
  // «паутина под него» ложится за 9 тиков заряда булавы.
  const webNow = webOnBody(bot)
  if (webNow || headroom(bot, bot.entity.position, 4) < 3) { await restoreOff(); out.note = `булава: передумал взлетать (${webNow ? 'паутина' : 'над головой блок'})`; out.cancelled = true; return out }
  const hpSelf0 = bot.health ?? 20
  const theirHp0 = telemetryHp(e)
  const y0 = bot.entity.position.y
  const toward = yawTo(bot.entity.position, e.position)
  for (const k of KEYS) { try { bot.setControlState(k, false) } catch {} }
  if (stats) stats.launches++
  // Разбор взлёта (2026-09-26: в боях ~1 из 4 — «всплеск не поднял»): пришёл
  // ли всплеск (пакет explosion — mineflayer прибавляет его толчок к скорости),
  // били ли нас в эти тики (entity_velocity себе — сервер ставит скорость
  // целиком и может срезать подъём), что было в левой руке и на земле ли.
  const dg: any = { boom: 0, boomVy: null, kicks: 0, vyMax: -9, off: null, vy0: 0 }
  const onBoom = () => { dg.boom++; if (dg.boomVy == null) dg.boomVy = Math.round(bot.entity.velocity.y * 100) / 100 }
  const onKick = (buf) => { try { if (bot.entity && buf && [0, 1].some(o => buf[o] !== undefined && readVarIntAt(buf, o) === bot.entity.id)) dg.kicks++ } catch {} }
  try { bot._client.on('explosion', onBoom); bot._client.on('raw.entity_velocity', onKick) } catch {}
  const unDiag = () => { try { bot._client.removeListener('explosion', onBoom); bot._client.removeListener('raw.entity_velocity', onKick) } catch {} }
  // Прыжок: тик с отпущенным прыжком — сброс перезарядки автопрыжка
  // (prismarine-physics jumpTicks: пока прыжок зажат, следующий — через 10
  // тиков; бой перед этим мог прыгать за критом). Бросок — на тике прыжка
  // (fireWind ждёт ближайший тик); не прыгнул — бросок стоя, строго вниз
  // (прицел ниже), 2026-09-26.
  if (jump && bot.entity.onGround) {
    await nextTick(bot)
    try { bot.setControlState('jump', true) } catch {}
  }
  const fired: any = await fireWind(bot, () => {
    const p = bot.entity.position
    const eyeY = pick.eyeOf(bot).y
    // Стоим (прыжка не было) — строго под ноги: центр всплеска в 0.25 над
    // полом прямо под нами, толчок вверх целиком (стоя — v ≈ 1.09, замер
    // probe-mace). В прыжке — чуть за спину (LAUNCH_BACK): горизонталь к нему.
    if (bot.entity.onGround || bot.entity.velocity.y < 0.2) return { yaw: bot.entity.yaw, pitch: -Math.PI / 2 }
    // Точка всплеска: на полу, LAUNCH_BACK за спиной (взгляд к нему — (−sin, −cos)).
    const bx = p.x + Math.sin(toward) * LAUNCH_BACK
    const bz = p.z + Math.cos(toward) * LAUNCH_BACK
    const dx = bx - p.x; const dz = bz - p.z
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(y0 - eyeY, Math.hypot(dx, dz)) }
  }, { swap, hand: swap ? 'main' : 'off', before: () => { try { bot.setControlState('jump', false); dg.off = bot.inventory.slots[45] ? bot.inventory.slots[45].name : null; dg.vy0 = bot.entity.velocity.y; dg.web = webOnBody(bot) } catch {} } })
  try { bot.setControlState('jump', false) } catch {}
  if (!fired.fired) { unDiag(); await restoreOff(); out.note = 'булава: заряд не ушёл — ' + fired.why; return out }
  // Точка всплеска для урона от падения: сервер ставит позицию игрока в тик
  // всплеска (onExplosionHit); на подъёме это чуть выше пола — берём пол.
  bot._ndWind = { impactY: y0, until: gameClock.now() + 2000 }
  // Толчок приходит пакетом explosion (mineflayer прибавляет его к скорости):
  // ждём скачок вертикальной скорости.
  let launched = false
  const waitLift = async () => {
    for (let i = 0; i < 10 && !ctl.aborted; i++) {
      await nextTick(bot)
      dg.vyMax = Math.max(dg.vyMax, bot.entity.velocity.y)
      if (bot.entity.velocity.y > 0.55) return true
    }
    return false
  }
  launched = await waitLift()
  // Бой прервали или нас убили посреди взлёта (арена 2026-09-26: «не взлетел»
  // оказался смертью от его булавы в тот же миг) — это не неудача взлёта.
  if (!launched && (ctl.aborted || (bot.health ?? 0) <= 0)) {
    unDiag(); bot._ndWind = null
    if (stats) stats.launches--
    out.aborted = true; out.note = 'булава: взлёт прерван (' + ((bot.health ?? 0) <= 0 ? 'убит' : 'бой прервали') + ')'
    return out
  }
  // Не поднял — второй заряд стоя, строго под ноги (стоя всплеск даёт
  // v ≈ 1.09, замер probe-mace): как сядем (слабый всплеск подкинул на блок),
  // после перезарядки (10 тиков).
  if (!launched) { const t2 = gameClock.now(); while (!bot.entity.onGround && !ctl.aborted && gameClock.now() - t2 < 1500) await nextTick(bot) }
  if (!launched && bot.entity.onGround && windCount(bot) > 0 && !ctl.aborted && (!stillOk || stillOk())) {
    const why1 = diagText(dg)
    const t1 = gameClock.now()
    while (gameClock.now() < (bot._ndWindCd || 0) && gameClock.now() - t1 < 700) await sleep(25)
    const f2: any = await fireWind(bot, () => ({ yaw: bot.entity.yaw, pitch: -Math.PI / 2 }), { swap, hand: swap ? 'main' : 'off' })
    if (f2.fired) {
      bot._ndWind = { impactY: bot.entity.position.y, until: gameClock.now() + 2000 }
      launched = await waitLift()
      if (launched) { out.retry = why1; if (stats) stats.retries = (stats.retries || 0) + 1 }
    }
  }
  unDiag()
  if (!launched) { bot._ndWind = null; await restoreOff(); out.note = 'булава: всплеск не поднял (' + diagText(dg) + ')'; out.why = diagText(dg); return out }
  out.launched = true
  if (stats) stats.launched++
  const r: any = await descend(bot, ctl, e, { vel, swap, stats, telemetryHp })
  const peak = r.peak - y0
  out.peak = Math.round(peak * 100) / 100
  if (stats) stats.peaks.push(out.peak)
  out.hit = !!r.hit
  out.swung = !!r.hit
  if (r.hit) {
    await sleep(200)
    out.fall = r.hit.fall
    out.charged = r.hit.charged
    out.expect = Math.round(smashDamage(r.hit.fall, { base: MACE_BASE, charge: r.hit.charged ? 1 : 0.8, density: densityOf(bot) }))
    // Сколько снял: минимум его здоровья после удара (регенерация при
    // сытости возвращает по 1 хп в 10 тиков — берём самое низкое).
    const hpMin = r.hit.hpMin != null ? r.hit.hpMin : telemetryHp(e)
    out.dealt = theirHp0 != null && hpMin != null ? Math.max(0, theirHp0 - hpMin) : null
    if (stats) { stats.smashHits++; if (out.dealt != null) stats.dealt.push(out.dealt) }
  }
  await sleep(150)
  out.self = Math.max(0, hpSelf0 - (bot.health ?? 20))
  // Откуда урон себе: в воздухе (его удары, стрелы) или при посадке (падение
  // ниже всплеска, лава, огонь) — для разбора.
  if (out.self > 0.5) {
    const feet = bot.blockAt(bot.entity.position.floored())
    const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    out.selfWhy = `в воздухе −${Math.round(Math.max(0, hpSelf0 - (r.hit ? r.hit.selfHp : hpSelf0)) * 10) / 10}, сел на ${under ? under.name : '?'}${feet && feet.name !== 'air' ? ' в ' + feet.name : ''}, от всплеска ${Math.round((bot.entity.position.y - y0) * 10) / 10}`
  }
  if (stats) { stats.selfDmg += out.self; stats.smashes++ }
  await restoreOff()
  out.note = r.hit
    ? `булава: взлёт ${out.peak} бл., удар с падения ${out.fall} бл.${out.charged ? ' (заряжена)' : ''}${out.dealt != null ? ` — снял ${Math.round(out.dealt * 10) / 10} хп` : ''}${out.self ? `, себе −${Math.round(out.self)} (${out.selfWhy || ''})` : ''}`
    : `булава: взлёт ${out.peak} бл., не достал (${r.why})${out.self ? `, себе −${Math.round(out.self)} (${out.selfWhy || ''})` : ''}`
  return out
}

// Падаем сами (со столба, с уступа) — и он внизу рядом: тот же спуск с ударом.
// Булава должна быть в хотбаре; урон — от высоты этого падения.
function fallSmashReady (bot, e) {
  if (!e || !e.position || !bot.entity) return false
  if (!findItem(bot, 'mace')) return false
  const me = bot.entity.position
  const dy = me.y - e.position.y
  const dh = Math.hypot(e.position.x - me.x, e.position.z - me.z)
  return dy > 2 && dh < 4.5
}

// ---------------------------------------------------------------- толчок

// Толчок зарядом по нему: прямое попадание — 1 урона (LivingEntity.
// hurtServer → knockback 0.4 по полёту снаряда, вверх до 0.4) и всплеск на
// его рамке (у ног: (1 − 0.63/2.4)·1.22 ≈ 0.9 «от центра к глазам» — вбок ~0.35,
// вверх ~0.83). Щит гасит урон и его толчок, всплеск — нет. Оценка снизу:
// только всплеск, по нему — прогон тела edges.knockRun (падение в яму/пустоту).
function pushVelocity (bot, e, from, { blocking = false }: any = {}) {
  const dx = e.position.x - from.x; const dz = e.position.z - from.z
  const n = Math.hypot(dx, dz) || 1
  const h = 0.35 + (blocking ? 0 : 0.4)
  const up = !grounded(bot, e) ? 0.3 : (blocking ? 0.8 : 0.9)
  return new Vec3(dx / n * h, up, dz / n * h)
}

function knockOff (bot, e, { blocking = false }: any = {}) {
  try {
    const cache = new Map()
    if (!edges.hazardAround(bot, e.position, 5, cache)) return false
    const base = edges.stateOf(bot)
    const v = pushVelocity(bot, e, bot.entity.position, { blocking })
    const face = yawTo(e.position, bot.entity.position)
    const r = edges.knockRun(bot, base, e.position, v, grounded(bot, e), face, true, cache)
    return !!(r && r.fall)
  } catch { return false }
}

// Чем толкнуть сейчас — или null. Порядок: в яму (сброс насмерть), со столба
// (ниже всплеска — урон от падения, и он снова внизу), сбить еду/лук (он
// медленный, 1 урона, а бот-противник бросает глоток от удара), сбить рывок,
// пока свой удар не заряжен.
function pushPlan (bot, e, { sees = true, theyUp = false, busy = null, closing = 0, cooldownLeft = 0, blocking = false }: any = {}) {
  if (!sees || !windReady(bot)) return null
  if (!e || !e.position || e.isValid === false) return null
  const me = bot.entity.position
  const dist = pick.eyeOf(bot).distanceTo(e.position.offset(0, pick.hitboxOf(bot, e).h / 2, 0))
  if (dist < 2.2 || dist > 14) return null
  const have = windCount(bot)
  if (knockOff(bot, e, { blocking })) return { why: 'в яму' }
  if (theyUp && dist < 12) return { why: 'со столба' }
  if (busy && have >= 2 && dist > 3.6) return { why: busy }
  if (closing > 0.18 && dist < 6 && dist > 2.8 && cooldownLeft > 300 && have >= 3) return { why: 'сбил рывок' }
  return null
}

// Выстрел зарядом в него: прямая без гравитации, скорость 1.5 + своё
// смещение (x,z — всегда, y — в воздухе). Цель — его ноги + 0.3 с упреждением
// по его скорости: всплеск у ног подкидывает выше всего.
async function windPush (bot, e, { vel = () => ({ x: 0, y: 0, z: 0 }), swap = SWAP }: any = {}) {
  install(bot)
  if (!offWind(bot) && !(await ensureHotbar(bot, ['wind_charge']))) return { fired: false, why: 'заряда нет в хотбаре' }
  let lastPos = bot.entity.position.clone()
  const r = await fireWind(bot, () => {
    const p = bot.entity.position
    const u = { x: p.x - lastPos.x, y: bot.entity.onGround ? 0 : p.y - lastPos.y, z: p.z - lastPos.z }
    const from = pick.eyeOf(bot)
    const tv = vel() || { x: 0, y: 0, z: 0 }
    let t = from.distanceTo(e.position) / WIND_SPEED
    let P = null
    for (let i = 0; i < 4; i++) {
      P = new Vec3(e.position.x + tv.x * t, e.position.y + 0.3, e.position.z + tv.z * t)
      t = from.distanceTo(P) / WIND_SPEED
    }
    const w = P.minus(from).scaled(1 / Math.max(1, t))
    const d = new Vec3(w.x - u.x, w.y - u.y, w.z - u.z)
    return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) }
  }, { swap, before: () => { lastPos = bot.entity.position.clone() } })
  return r
}

// ---------------------------------------------------------------- защита

// Ответ на «булаву сверху». Щит надет — поднять к нему (5 тиков до того,
// как держит: поднимать сразу, пока он ещё летит вверх); почти над головой —
// шаг назад, чтобы горизонталь до него не была нулём. Щита нет или поздно —
// в сторону от точки, куда он сядет (его руль в воздухе — ~0.02 б/т²), спринтом.
// Сидит сверху с булавой — не стоять под ним: отойти на 3.6+.
function defend (bot, t, { guard = null, entity: e = null, vel = null, set, keyDir, stepSafe, stats = null }: any = {}) {
  const shield = !!(guard && guard.stats && guard.stats.worn)
  const setKeys = (k) => { for (const x of ['forward', 'back', 'left', 'right']) set(x, x === k); set('sprint', k === 'forward'); set('jump', false) }
  if (t.kind === 'above') {
    setKeys(stepSafe(keyDir(bot, 'back')) ? 'back' : null)
    return 'не стою под ним — он сверху с булавой'
  }
  // Щит держит только через 5 тиков после подъёма (Items.SHIELD:
  // BlocksAttacks(0.25F, …) — blockDelayTicks 5) и тик — на доставку: до удара
  // меньше 6 тиков, а щит ещё не поднят — не успеет, уходить (арена 2026-09-26:
  // «булава сверху: щит 1, уклон 1, получил 20» — щит подняли за 3 тика).
  if (shield && (t.eta >= 6 || t.shielded)) {
    guard.raise(true)
    if (stats && !t.shielded) { t.shielded = true; stats.shieldUps++ }
    // Над самой головой щит не держит (горизонталь 0) — шаг назад.
    setKeys(t.dh < 0.7 && stepSafe(keyDir(bot, 'back')) ? 'back' : null)
    set('sprint', false)
    return 'щит к булаве сверху'
  }
  // Шаг в сторону: куда дальше от точки, где он сядет.
  const me = bot.entity.position
  let land = e && e.position ? e.position : null
  if (land && vel) { const v = vel() || { x: 0, z: 0 }; land = land.offset(v.x * Math.min(t.eta, 20), 0, v.z * Math.min(t.eta, 20)) }
  let best = null
  for (const k of ['back', 'left', 'right', 'forward']) {
    const dir = keyDir(bot, k)
    if (!stepSafe(dir)) continue
    const q = me.offset(dir.x * 2, 0, dir.z * 2)
    const dd = land ? Math.hypot(q.x - land.x, q.z - land.z) : 0
    if (!best || dd > best.dd) best = { k, dd }
  }
  if (!best) return null
  for (const x of ['forward', 'back', 'left', 'right']) set(x, x === best.k)
  set('sprint', true)
  if (stats && !t.dodged) { t.dodged = true; stats.dodges++ }
  return 'ушёл из-под булавы'
}

module.exports = {
  SWAP, REACH, smashBonus, smashDamage, install, track, smashPlan, windSmash, descend, fallSmashReady,
  pushPlan, windPush, knockOff, defend, fireWind, ensureHotbar, hotbarIndex, headroom, windReady, shieldAtUs, slamHit,
  // utility.js (2026-09-26): удочка, трезубец — тот же «после пакета этого тика».
  afterPacket,
  // Посадка в огонь (прогон физики до земли) — для сцены try-burnland.js.
  landing, burnAt, AIR_KEYS, NO_KEYS
}
