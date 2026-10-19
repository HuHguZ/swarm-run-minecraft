'use strict'
// Боевой калькулятор, часть 4 — адаптер наблюдения из mineflayer для kill-planner. Только чтение bot/entity
// и подписка на пакеты: телом не управляет.
//
// Что реально получает клиент (проверено):
//  * снаряжение — пакет entity_equipment, предметы целиком с компонентами (чары, charged_projectiles,
//    fireworks): server-run/config/paper-global.yml obfuscation.items.enable-item-obfuscation: false;
//    читаем read.enchLevel / read.crossbowInfo;
//  * щит поднят — метаданные living_entity_flags (0x01 использует, 0x02 левой рукой) + предмет в этой руке;
//  * тотем в руке — снаряжение; срабатывание — entity_status 35;
//  * эффекты — только частицы (метаданные effect_particles, read.effectsOf): имя, без уровня; нет частиц —
//    неизвестно;
//  * попадание — damage_event (тип, кто): в его окне неуязвимости пакета НЕТ (LivingEntity.hurtServer,
//    ветка invulnerableTime > 10 не шлёт broadcastDamageEvent) — такие удары идут как «может, прошло».
//
// ХП ПРОТИВНИКА-ИГРОКА — ОЦЕНКА (hp-estimate), не метаданные: пользователь 06.10 — точное хп игрока чит.
// Точное хп — только мобам (honest:false для игрока — только для замеров сцен) и телеметрии:
// exactHpTelemetryOnly.
import * as read from '../read'
import * as dm from './damage-model'
import { createHpEstimate } from './hp-estimate'
import * as gameClock from '../game-clock'

const lazy = (path) => { let m = null; return () => m || (m = require(path)) }
const pick = lazy('../pick')
const assess = lazy('../assess')
const gamedata = lazy('../gamedata')
const potions = lazy('./potions')

const isPlayer = (e) => !!e && (e.type === 'player' || !!e.username)

// ТОЛЬКО ТЕЛЕМЕТРИЯ И ЗАМЕРЫ СЦЕН (trickDmg, mace.dealt): точное здоровье + поглощение из метаданных.
// В решения против игрока не идёт никогда.
function exactHpTelemetryOnly (bot, e) {
  const h = read.healthRaw(bot, e)
  return h == null ? null : h + read.absorptionOf(bot, e)
}

function rocketStars (it) {
  try {
    const c = it.componentMap && it.componentMap.get('fireworks')
    const ex = c && c.data && c.data.explosions
    return Array.isArray(ex) ? ex.length : 0
  } catch { return 0 }
}
function itemObs (bot, it) {
  if (!it || !it.name) return null
  const ench = {}
  // Полный map нужен и подготовке: Unbreaking не усиливает удар, но стол не зачарует такую вещь заново.
  try { for (const e of (require('../enchant') as typeof import('../enchant')).enchantsOf(bot, it)) if (e.level > 0) ench[e.name] = e.level } catch {}
  const o: any = { name: it.name, count: it.count ?? 1, ench }
  if (it._ndVisual) o.enchanted = !!it.enchanted
  if (it.name === 'crossbow') o.crossbow = read.crossbowInfo(bot, it)
  if (it.name === 'firework_rocket') o.stars = rocketStars(it)
  return o
}

function livingFlags (bot, e) {
  try {
    const keys = bot.registry.entitiesByName.player.metadataKeys
    const i = keys.indexOf('living_entity_flags')
    const f = e.metadata[i >= 0 ? i : 8]
    return typeof f === 'number' ? f : 0
  } catch { return 0 }
}
// Что он сейчас «использует»: { name, item } или null.
function usingOf (bot, e) {
  const f = livingFlags(bot, e)
  if (!(f & 0x01)) return null
  const eq = e.equipment || []
  const it = (f & 0x02) ? eq[1] : eq[0]
  return it ? { name: it.name, item: it } : null
}

function effectAmp (bot, name) {
  try {
    const ef = bot.registry.effectsByName[name]
    const e = ef && bot.entity.effects && bot.entity.effects[ef.id]
    return e ? e.amplifier : -1
  } catch { return -1 }
}

// Урон от видимых источников — признаки, а не числа: интервал после его брони (наша оценка).
// lava 4, огонь/костёр 1–2 за удар; взрыв чужой — широко; прочее — широко.
const ENV = {
  lava: [0.5, 4], in_fire: [0.2, 1], on_fire: [0.2, 1], campfire: [0.2, 2], hot_floor: [0.2, 1],
  explosion: [0.5, 12], player_explosion: [0.5, 12], bad_respawn_point: [0.5, 12], fireworks: [0.5, 8],
  wither: [0.2, 1], magic: [0.5, 6], indirect_magic: [0.5, 6], cactus: [0.2, 1], sweet_berry_bush: [0.2, 1]
}
const OUR_WINDOW_MELEE = 6
const OUR_WINDOW_PROJECTILE = 60

// Память знания своего бота. Scope задаёт раунд; entity id различает жизни одного UUID.
// Сохраняем estimator целиком: snapshot не содержит оставшееся время эффектов.
const hpMemories = new WeakMap<object, any>()
const foeKey = e => e?.uuid ? `uuid:${e.uuid}` : e?.username ? `name:${e.username.toLowerCase()}` : null
function memoryFor (bot, roundScope) {
  if (typeof roundScope !== 'string' || !roundScope) return null
  let memory = hpMemories.get(bot)
  if (memory?.scope === roundScope) return memory
  memory?.close()
  memory = { scope: roundScope, targets: new Map(), close: null }
  const clear = () => { for (const entry of memory.targets.values()) entry.stop?.(); memory.targets.clear() }
  const onDead = e => {
    if (e?.id === bot.entity?.id) { clear(); return }
    for (const [key, entry] of memory.targets) {
      if (key === foeKey(e) || e?.id === entry.entityId) { entry.stop?.(); memory.targets.delete(key) }
    }
  }
  const close = () => {
    clear()
    bot.removeListener('death', clear); bot.removeListener('spawn', clear)
    bot.removeListener('entityDead', onDead); bot.removeListener('end', close)
    if (hpMemories.get(bot) === memory) hpMemories.delete(bot)
  }
  memory.close = close
  bot.on('death', clear); bot.on('spawn', clear)
  bot.on('entityDead', onDead); bot.on('end', close)
  hpMemories.set(bot, memory)
  return memory
}

function ageMemory (entry) {
  if (!entry || entry.at == null) return // активный tracker уже стареет на physicsTick
  const at = Math.max(entry.at, entry.now())
  entry.hp.tick((at - entry.at) / 50, { visible: false })
  entry.at = at // общий cursor для status и следующего Engage
}
// Только чтение существующего знания: не создаёт/переключает scope и не подписывается на события.
// Верх оценки хп противника (с поглощением) по своим подтверждённым попаданиям — для общего журнала роя (swarmSightings).
// Память — текущего раунда этого тела; ни одного своего попадания — null (тогда рой считает 20).
function foeHpUpper (bot, entity) {
  const memory = hpMemories.get(bot), key = foeKey(entity)
  const entry = memory && key && (memory.targets.get(key) || [...memory.targets.values()].find(e => e.username === entity?.username?.toLowerCase()))
  if (!entry) return null
  ageMemory(entry)
  return entry.hp.snapshot().hi
}

function readFoeEstimate (bot, { roundScope, target }: any = {}) {
  const memory = hpMemories.get(bot)
  if (!memory || memory.scope !== roundScope || typeof target !== 'string' || !target) return null
  const entry = memory.targets.get(`uuid:${target}`) || [...memory.targets.values()].find(e => e.username === target.toLowerCase())
  if (!entry) return null
  ageMemory(entry)
  return entry.hp.snapshot()
}

// Трекер противника: подписки на пакеты + оценка хп + окно неуязвимости по нашим попаданиям.
// noteAttack(range) зовёт бой сразу после удара/выстрела (range — planAttack(...).action.range).
function trackFoe (bot, entity, { honest = true, visible: isVisible = null, roundScope = null, now = () => gameClock.now() }: any = {}) {
  const player = isPlayer(entity)
  const visible = () => { try { return isVisible ? isVisible(entity) : (entity._ndVisible ?? (player ? (require('./last-seen') as typeof import('./last-seen')).seesPlayer(bot, entity) : assess().inSight(bot, entity))) } catch { return false } }
  const memory = player && honest ? memoryFor(bot, roundScope) : null
  const key = foeKey(entity)
  let entry = key && memory?.targets.get(key)
  entry?.stop?.()
  if (entry?.entityId !== entity.id) entry = null
  ageMemory(entry)
  const hp = entry?.hp || createHpEstimate()
  if (memory && key) { entry = { hp, entityId: entity.id, username: entity.username?.toLowerCase(), at: null, now, stop: null }; memory.targets.set(key, entry) }
  const T: any = {
    entity, hp, honestHp: player && honest, tick: 0,
    iframe: null, pending: [], using: null, prev: null, vel: { x: 0, y: 0, z: 0 },
    foeAir: null, foeFall: 0, lastLanding: null, myAir: null, myFall: 0, pops: 0, splashes: new Map(), seenApples: 0
  }
  const near = (p, d) => entity.position && p && Math.hypot(p.x - entity.position.x, p.y - entity.position.y, p.z - entity.position.z) <= d

  // Только еда и зелья (ревью Codex: опущенный щит/лук после ≥ 30 тиков тоже «кончил использовать» — шёл в «съел»).
  const consumed = (u) => {
    if (/potion$/.test(u.name)) { const n = potions().potionOf(u.item); if (n) hp.drink(n); else if (T.honestHp) hp.heal(0, 20) } else if (bot.registry?.foodsByName?.[u.name]) {
      hp.eat(u.name)
      if (/^(enchanted_)?golden_apple$/.test(u.name)) T.seenApples++
    }
  }
  const onTick = () => {
    T.tick++
    const pos = entity.position
    const seen = !T.honestHp || visible()
    if (pos && seen) {
      if (T.prev) T.vel = { x: pos.x - T.prev.x, y: pos.y - T.prev.y, z: pos.z - T.prev.z }
      T.prev = { x: pos.x, y: pos.y, z: pos.z }
      // Его высота падения: от вершины в воздухе (mineflayer onGround по пакетам движения).
      if (entity.onGround === false) { T.foeAir = Math.max(T.foeAir ?? pos.y, pos.y); T.foeFall = Math.max(0, T.foeAir - pos.y) } else if (T.foeAir != null) { T.lastLanding = { h: T.foeAir - pos.y, tick: T.tick }; T.foeAir = null; T.foeFall = 0 }
    } else { T.prev = null; T.vel = { x: 0, y: 0, z: 0 }; T.foeAir = null; T.foeFall = 0; T.lastLanding = null }
    const me = bot.entity
    if (me && me.position) {
      if (!me.onGround) { T.myAir = Math.max(T.myAir ?? me.position.y, me.position.y); T.myFall = Math.max(0, T.myAir - me.position.y) } else { T.myAir = null; T.myFall = 0 }
    }
    if (!T.honestHp) {
      const h = read.healthRaw(bot, entity)
      if (h != null) hp.exact(h, read.absorptionOf(bot, entity))
    } else hp.tick(1, { visible: seen })
    // Наш удар без damage_event: в его окне неуязвимости пакета нет — может, прошло превышение.
    T.pending = T.pending.filter(p => {
      if (T.tick <= p.until) return true
      if (p.inIframe && T.honestHp) hp.maybeHit(p.range.max)
      return false
    })
    // Еда и питьё: использование еды/зелья ≥ 30 тиков (Consumable 1.6 с = 32 т) и отпустил — съел.
    // Честно (S7d, ревью Codex): пакеты «использует предмет» приходят и сквозь стену — еда/питьё засчитываются, только
    // если я видел и начало, и конец (пропал из виду посреди — не подтверждено; человек видит еду, только видя его).
    if (T.honestHp && T.using) {
      let vis = false
      vis = visible()
      if (!vis) T.using = null
    }
    const rawUse = usingOf(bot, entity)
    const u = rawUse && T.honestHp ? { name: rawUse.name, item: (require('./last-seen') as typeof import('./last-seen')).visiblePlayerItem(rawUse.item) } : rawUse
    if (u && (!T.using || T.using.name !== u.name)) {
      let vis = !T.honestHp
      vis = vis || visible()
      T.using = vis ? { ...u, since: T.tick } : null
    }
    if (!u && T.using) {
      if (T.tick - T.using.since >= 30) consumed(T.using)
      T.using = null
    }
  }
  // Разброс урона моего попадания: ближний — заряд 0.9…1 без крита и с критом; лук/арбалет — стрела.
  const guessRange = (type = 'player_attack') => {
    try {
      const def = dm.defenseOf([2, 3, 4, 5].map(i => itemObs(bot, T.honestHp ? (require('./last-seen') as typeof import('./last-seen')).visiblePlayerItem((entity.equipment || [])[i]) : (entity.equipment || [])[i])))
      // Не обычный удар рукой: таран/разгон копья (spear, до ~30 до брони), булава с падения (mace_smash, до ~45),
      // ракета/взрыв, трезубец — широкий разброс по своему типу (броня и чары — его, видимые).
      const wide = (rawMax, kind) => { const hi = dm.afterDefense(rawMax, kind, def); return { min: Math.min(1, hi), max: hi, mean: hi / 2, raw: rawMax } }
      if (type === 'spear') return wide(33, 'melee')
      if (type === 'mace_smash') return wide(45, 'melee')
      if (type === 'trident') return wide(8, 'projectile')
      if (type === 'arrow') return wide(11, 'projectile')
      if (/firework|explosion/.test(type)) return wide(20, 'explosion')
      const held = bot.heldItem ? itemObs(bot, bot.heldItem) : null
      const name = held && held.name
      if (name === 'bow' || name === 'crossbow') {
        const outs = dm.arrowOutcomes({ speed: name === 'bow' ? 3 : dm.CROSSBOW_ARROW_SPEED, power: (held.ench && held.ench.power) || 0, crit: true })
        const ds = outs.map(o => dm.afterDefense(o.raw, 'projectile', def))
        return { min: Math.min(...ds) * 0.5, max: Math.max(...ds), mean: ds.reduce((a, b) => a + b, 0) / ds.length, raw: Math.max(...outs.map(o => o.raw)) }
      }
      const sharp = (held && held.ench && held.ench.sharpness) || 0
      const w = name && dm.isMeleeWeapon(name) ? name : null
      // Низ — удар не на полном заряде (ответный в тик его отброса, спешный): заряд 0.6.
      const lo = dm.afterDefense(dm.meleeRaw({ weapon: w, sharpness: sharp, charge: 0.6 }), 'melee', def)
      const hiRaw = dm.meleeRaw({ weapon: w, sharpness: sharp, charge: 1, crit: true })
      const hi = dm.afterDefense(hiRaw, 'melee', def)
      return { min: Math.max(0.5, lo), max: Math.max(hi, lo + 0.5), mean: (lo + hi) / 2, raw: hiRaw }
    } catch { return { min: 0.5, max: 12, mean: 4, raw: 12 } }
  }
  const onDamage = (pk) => {
    if (!pk || pk.entityId !== entity.id) return
    const cause = pk.sourceCauseId > 0 ? pk.sourceCauseId - 1 : null
    if (bot.entity && cause === bot.entity.id) {
      const p = T.pending.shift()
      // Без заявки (удар боя мимо noteAttack) — разброс по модели урона моего предмета в руке и его видимой броне
      // (S7d: прежний запасной 0.5–12 на каждое попадание за 3–4 удара раздувал оценку до «0–20» — решения по хп
      // противника слепли: «оценка 0–20, точно 15» в трассах).
      const r = p ? p.range : guessRange(gamedata().damageTypeName(pk.sourceTypeId) || '')
      T.iframe = { raw: r.raw ?? r.max, at: T.tick }
      if (T.honestHp) hp.hit(r)
      return
    }
    if (!T.honestHp || !visible()) return
    const type = gamedata().damageTypeName(pk.sourceTypeId) || ''
    if (type === 'fall' && T.lastLanding && T.tick - T.lastLanding.tick <= 2) {
      const def = dm.defenseOf([2, 3, 4, 5].map(i => itemObs(bot, T.honestHp ? (require('./last-seen') as typeof import('./last-seen')).visiblePlayerItem((entity.equipment || [])[i]) : (entity.equipment || [])[i])))
      const d = dm.afterDefense(dm.fallRaw(T.lastLanding.h), 'fall', def)
      hp.env(d * 0.8, d * 1.1)
    } else {
      const [lo, hi] = ENV[type] || [0.5, 6]
      hp.env(lo, hi)
    }
    T.iframe = { raw: 4, at: T.tick }
  }
  const onStatus = (p) => {
    if (!p || p.entityId !== entity.id || p.entityStatus !== dm.TOTEM.status) return
    if (T.honestHp && !visible()) return
    T.pops++
    if (T.honestHp) hp.totem()
  }
  // Брошенное зелье лопнуло рядом с ним: лечение/регенерация — верхняя граница.
  const onSpawn = (e) => { if (e && /^(splash|lingering)_potion$/.test(e.name || '')) T.splashes.set(e.id, e) }
  const onGone = (e) => {
    if (!e || !T.splashes.has(e.id)) return
    T.splashes.delete(e.id)
    if (!T.honestHp || !visible() || !near(e.position, 4.25)) return
    try {
      const raw = (e.metadata || []).find(x => x && (x.itemId != null || x.components))
      const Item = (require('prismarine-item') as typeof import('prismarine-item').default)(bot.version)
      const item = raw ? Item.fromNotch(raw) : null
      const n = potions().potionOf(T.honestHp ? (require('./last-seen') as typeof import('./last-seen')).visiblePlayerItem(item) : item)
      if (n) hp.splash(n)
      else if (T.honestHp) hp.heal(0, 20)
    } catch {}
  }
  bot.on('physicsTick', onTick)
  bot.on('entitySpawn', onSpawn)
  bot.on('entityGone', onGone)
  try { bot._client.on('damage_event', onDamage) } catch {}
  try { bot._client.on('entity_status', onStatus) } catch {}

  T.noteAttack = (range, { projectile = false }: any = {}) => {
    if (!range) return
    const inIframe = !!(T.iframe && T.tick - T.iframe.at < dm.IFRAME_TICKS)
    T.pending.push({ range, until: T.tick + (projectile ? OUR_WINDOW_PROJECTILE : OUR_WINDOW_MELEE), inIframe })
  }
  let stopped = false
  T.stop = () => {
    if (stopped) return
    stopped = true
    if (entry) entry.at = now()
    bot.removeListener('physicsTick', onTick)
    bot.removeListener('entitySpawn', onSpawn)
    bot.removeListener('entityGone', onGone)
    try { bot._client.removeListener('damage_event', onDamage) } catch {}
    try { bot._client.removeListener('entity_status', onStatus) } catch {}
  }
  if (entry) entry.stop = T.stop
  return T
}

// Расстояние от наших глаз до его рамки (как достаёт удар).
function reachTo (bot, e) {
  const eye = pick().eyeOf(bot)
  const box = pick().hitboxOf(bot, e)
  const hw = (e.width || 0.6) / 2
  const p = e.position
  const c = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  return Math.hypot(eye.x - c(eye.x, p.x - hw, p.x + hw), eye.y - c(eye.y, p.y, p.y + box.h), eye.z - c(eye.z, p.z - hw, p.z + hw))
}

// Наблюдение для planAttack. tracker — trackFoe (без него хп игрока — «не знаю»: 0..20).
// opts: since — тиков с нашего удара/смены предмета (pvp.ts знает), smash — { h, ticks } от mace.smashPlan,
// boom — { crystal: { dist, seen, angle }, anchor: … } от crystal.ts, shieldOffTicks — read.watch.shieldOff/50.
function observe (bot, entity, { tracker = null, since = 99, smash = null, boom = null, shieldOffTicks = 0, honest = true }: any = {}) {
  const me = bot.entity
  const player = isPlayer(entity)
  const eq = (entity.equipment || []).map(it => player && honest ? (require('./last-seen') as typeof import('./last-seen')).visiblePlayerItem(it) : it)
  let hp
  if (player && honest) hp = tracker ? tracker.hp.snapshot() : { lo: 0, hi: 20, mean: 10, conf: 0, exact: false }
  else { const h = exactHpTelemetryOnly(bot, entity) ?? 20; hp = { lo: h, hi: h, mean: h, conf: 1, exact: true } }
  const los = (() => { try { return entity._ndVisible ?? (player ? (require('./last-seen') as typeof import('./last-seen')).seesPlayer(bot, entity) : assess().inSight(bot, entity)) } catch { return false } })()
  const effects = {}
  if (!honest || !player || los) for (const n of read.effectsOf(bot, entity)) effects[n] = true
  const using = !honest || !player || los ? usingOf(bot, entity) : null
  // Щит держит через 5 тиков после подъёма (blockDelayTicks): трекер видит начало использования.
  const blocking = !!(using && using.name === 'shield' && (!tracker || !tracker.using || tracker.tick - tracker.using.since >= dm.SHIELD_DELAY_TICKS))
  const vel = tracker ? tracker.vel : (!honest || !player || los && entity._ndVisible === true ? entity.velocity || { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: 0 })
  const dx = me.position.x - entity.position.x; const dz = me.position.z - entity.position.z
  const dh = Math.hypot(dx, dz) || 1
  const myItems = bot.inventory.items().map(it => itemObs(bot, it))
  const myAbs = read.absorptionOf(bot, me)
  // Его снаряжение — то, что видно (S7d, честное восприятие): пакеты снаряжения приходят и сквозь стену; пока его не
  // видно — последнее увиденное (человек помнит, с чем тот был), а не свежее из пакета.
  const gearNow = () => ({ armor: [2, 3, 4, 5].map(i => itemObs(bot, eq[i])), main: itemObs(bot, eq[0]), off: itemObs(bot, eq[1]), totem: read.hasTotemInHand(entity) })
  let gear
  if (!honest || !player || los) { gear = gearNow(); if (tracker) tracker.gearSeen = gear }
  else gear = tracker?.gearSeen || { armor: [null, null, null, null], main: null, off: null, totem: false }
  return {
    difficulty: (bot.game && bot.game.difficulty) || 'normal',
    dist: !honest || !player || los || entity._ndSeenAt != null ? reachTo(bot, entity) : Infinity,
    los,
    foe: {
      player,
      hp,
      totem: gear.totem,
      armor: gear.armor,
      main: gear.main,
      off: gear.off,
      using: using ? using.name : null,
      blocking,
      shieldAngle: !honest || !player || los || entity._ndSeenAt != null ? dm.shieldAngle(typeof entity.headYaw === 'number' ? entity.headYaw : (entity.yaw || 0), entity.position, me.position) : null,
      shieldOffTicks,
      effects,
      // Сопротивление по частицам: уровень не виден — I.
      resistance: effects['resistance'] ? 0 : -1,
      approach: (vel.x * dx + vel.z * dz) / dh,
      // Поперечная к лучу скорость (б/т): от неё промах броска/выстрела по видимому ходу (упреждение не точное).
      lateral: Math.abs(vel.x * dz - vel.z * dx) / dh,
      fallDistance: tracker ? tracker.foeFall : 0,
      iframe: tracker && tracker.iframe ? { raw: tracker.iframe.raw, ago: tracker.tick - tracker.iframe.at } : null
    },
    me: {
      ehp: (bot.health ?? 20) + myAbs,
      armor: [5, 6, 7, 8].map(i => itemObs(bot, bot.inventory.slots[i])),
      resistance: effectAmp(bot, 'resistance'),
      strength: effectAmp(bot, 'strength'),
      weakness: effectAmp(bot, 'weakness'),
      held: bot.heldItem ? bot.heldItem.name : null,
      since,
      onGround: !!me.onGround,
      canCrit: !me.isInWater && effectAmp(bot, 'blindness') < 0,
      fallDistance: tracker ? tracker.myFall : 0,
      items: myItems,
      hasShield: myItems.some(i => i && i.name === 'shield')
    },
    smash,
    boom
  }
}

export { observe, trackFoe, readFoeEstimate, foeHpUpper, itemObs, usingOf, exactHpTelemetryOnly, reachTo, isPlayer, ENV }
