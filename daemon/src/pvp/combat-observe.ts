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
const read = require('../read')
const dm = require('./damage-model')
const { createHpEstimate } = require('./hp-estimate')

const lazy = (path) => { let m = null; return () => m || (m = require(path)) }
const pick = lazy('../pick')
const assess = lazy('../assess')
const gamedata = lazy('../gamedata')
const pvp = lazy('../pvp')

const isPlayer = (e) => !!e && (e.type === 'player' || !!e.username)

// ТОЛЬКО ТЕЛЕМЕТРИЯ И ЗАМЕРЫ СЦЕН (trickDmg, mace.dealt): точное здоровье + поглощение из метаданных.
// В решения против игрока не идёт никогда.
function exactHpTelemetryOnly (bot, e) {
  const h = read.healthRaw(bot, e)
  return h == null ? null : h + read.absorptionOf(bot, e)
}

const ENCH = ['sharpness', 'protection', 'blast_protection', 'projectile_protection', 'feather_falling', 'fire_protection',
  'power', 'piercing', 'quick_charge', 'multishot', 'density', 'breach']
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
  for (const k of ENCH) { const L = read.enchLevel(bot, it, k); if (L) ench[k] = L }
  const o: any = { name: it.name, count: it.count ?? 1, ench }
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

// Трекер противника: подписки на пакеты + оценка хп + окно неуязвимости по нашим попаданиям.
// noteAttack(range) зовёт бой сразу после удара/выстрела (range — planAttack(...).action.range).
function trackFoe (bot, entity, { honest = true }: any = {}) {
  const player = isPlayer(entity)
  const hp = createHpEstimate()
  const T: any = {
    entity, hp, honestHp: player && honest, tick: 0,
    iframe: null, pending: [], using: null, prev: null, vel: { x: 0, y: 0, z: 0 },
    foeAir: null, foeFall: 0, lastLanding: null, myAir: null, myFall: 0, pops: 0, splashes: new Map()
  }
  const near = (p, d) => entity.position && p && Math.hypot(p.x - entity.position.x, p.y - entity.position.y, p.z - entity.position.z) <= d

  const consumed = (u) => {
    if (/potion$/.test(u.name)) { const n = pvp().potionOf(u.item); if (n) hp.drink(n) } else hp.eat(u.name)
  }
  const onTick = () => {
    T.tick++
    const pos = entity.position
    if (pos) {
      if (T.prev) T.vel = { x: pos.x - T.prev.x, y: pos.y - T.prev.y, z: pos.z - T.prev.z }
      T.prev = { x: pos.x, y: pos.y, z: pos.z }
      // Его высота падения: от вершины в воздухе (mineflayer onGround по пакетам движения).
      if (entity.onGround === false) { T.foeAir = Math.max(T.foeAir ?? pos.y, pos.y); T.foeFall = Math.max(0, T.foeAir - pos.y) } else if (T.foeAir != null) { T.lastLanding = { h: T.foeAir - pos.y, tick: T.tick }; T.foeAir = null; T.foeFall = 0 }
    }
    const me = bot.entity
    if (me && me.position) {
      if (!me.onGround) { T.myAir = Math.max(T.myAir ?? me.position.y, me.position.y); T.myFall = Math.max(0, T.myAir - me.position.y) } else { T.myAir = null; T.myFall = 0 }
    }
    if (!T.honestHp) {
      const h = read.healthRaw(bot, entity)
      if (h != null) hp.exact(h, read.absorptionOf(bot, entity))
    } else hp.tick(1)
    // Наш удар без damage_event: в его окне неуязвимости пакета нет — может, прошло превышение.
    T.pending = T.pending.filter(p => {
      if (T.tick <= p.until) return true
      if (p.inIframe && T.honestHp) hp.maybeHit(p.range.max)
      return false
    })
    // Еда и питьё: использование еды/зелья ≥ 30 тиков (Consumable 1.6 с = 32 т) и отпустил — съел.
    const u = usingOf(bot, entity)
    if (u && (!T.using || T.using.name !== u.name)) T.using = { ...u, since: T.tick }
    if (!u && T.using) {
      if (T.tick - T.using.since >= 30 && T.honestHp) consumed(T.using)
      T.using = null
    }
  }
  const onDamage = (pk) => {
    if (!pk || pk.entityId !== entity.id) return
    const cause = pk.sourceCauseId > 0 ? pk.sourceCauseId - 1 : null
    if (bot.entity && cause === bot.entity.id) {
      const p = T.pending.shift()
      const r = p ? p.range : { min: 0.5, max: 12, mean: 4, raw: 12 }
      T.iframe = { raw: r.raw ?? r.max, at: T.tick }
      if (T.honestHp) hp.hit(r)
      return
    }
    if (!T.honestHp) return
    const type = gamedata().damageTypeName(pk.sourceTypeId) || ''
    if (type === 'fall' && T.lastLanding && T.tick - T.lastLanding.tick <= 2) {
      const def = dm.defenseOf([2, 3, 4, 5].map(i => itemObs(bot, (entity.equipment || [])[i])))
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
    T.pops++
    if (T.honestHp) hp.totem()
  }
  // Брошенное зелье лопнуло рядом с ним: лечение/регенерация — верхняя граница.
  const onSpawn = (e) => { if (e && /^(splash|lingering)_potion$/.test(e.name || '')) T.splashes.set(e.id, e) }
  const onGone = (e) => {
    if (!e || !T.splashes.has(e.id)) return
    T.splashes.delete(e.id)
    if (!T.honestHp || !near(e.position, 4.25)) return
    try {
      const raw = (e.metadata || []).find(x => x && (x.itemId != null || x.components))
      const Item = require('prismarine-item')(bot.version)
      const n = raw ? pvp().potionOf(Item.fromNotch(raw)) : null
      if (n) hp.splash(n)
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
  T.stop = () => {
    bot.removeListener('physicsTick', onTick)
    bot.removeListener('entitySpawn', onSpawn)
    bot.removeListener('entityGone', onGone)
    try { bot._client.removeListener('damage_event', onDamage) } catch {}
    try { bot._client.removeListener('entity_status', onStatus) } catch {}
  }
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
  const eq = entity.equipment || []
  const player = isPlayer(entity)
  let hp
  if (player && honest) hp = tracker ? tracker.hp.snapshot() : { lo: 0, hi: 20, mean: 10, conf: 0, exact: false }
  else { const h = exactHpTelemetryOnly(bot, entity) ?? 20; hp = { lo: h, hi: h, mean: h, conf: 1, exact: true } }
  const effects = {}
  for (const n of read.effectsOf(bot, entity)) effects[n] = true
  const using = usingOf(bot, entity)
  // Щит держит через 5 тиков после подъёма (blockDelayTicks): трекер видит начало использования.
  const blocking = !!(using && using.name === 'shield' && (!tracker || !tracker.using || tracker.tick - tracker.using.since >= dm.SHIELD_DELAY_TICKS))
  const vel = tracker ? tracker.vel : (entity.velocity || { x: 0, y: 0, z: 0 })
  const dx = me.position.x - entity.position.x; const dz = me.position.z - entity.position.z
  const dh = Math.hypot(dx, dz) || 1
  const myItems = bot.inventory.items().map(it => itemObs(bot, it))
  const myAbs = read.absorptionOf(bot, me)
  return {
    difficulty: (bot.game && bot.game.difficulty) || 'normal',
    dist: reachTo(bot, entity),
    los: (() => { try { return assess().inSight(bot, entity) } catch { return true } })(),
    foe: {
      player,
      hp,
      totem: read.hasTotemInHand(entity),
      armor: [2, 3, 4, 5].map(i => itemObs(bot, eq[i])),
      main: itemObs(bot, eq[0]),
      off: itemObs(bot, eq[1]),
      using: using ? using.name : null,
      blocking,
      shieldAngle: dm.shieldAngle(typeof entity.headYaw === 'number' ? entity.headYaw : (entity.yaw || 0), entity.position, me.position),
      shieldOffTicks,
      effects,
      // Сопротивление по частицам: уровень не виден — I.
      resistance: effects['resistance'] ? 0 : -1,
      approach: (vel.x * dx + vel.z * dz) / dh,
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

module.exports = { observe, trackFoe, itemObs, usingOf, exactHpTelemetryOnly, reachTo, isPlayer, ENV }
