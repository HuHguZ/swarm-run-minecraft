'use strict'
import * as gameClock from './game-clock'
// Чтение противника (PVP-RESEARCH б.20 и в.7; просьба 2026-09-26: «все приёмы
// про-игроков, по максимуму того, что даёт версия»). Что сервер сам говорит о
// нём всем, кто рядом, — и что бот раньше пропускал:
//  · поглощение — метаданные игрока player_absorption (Player.DATA_PLAYER_ABSORPTION_ID,
//    №17 у 1.21.11): healthOf считал 20 хп там, где было 20 + 16 (зачарованное яблоко);
//  · эффекты — частицы entity_effect в метаданных effect_particles
//    (LivingEntity.DATA_EFFECT_PARTICLES, №10; updateSynchronizedMobEffectParticles
//    кладёт по частице на каждый видимый эффект, цвет — MobEffect.color,
//    ARGB.color(isAmbient ? 38 : 255, color) — MobEffect.java);
//  · срабатывание тотема — событие сущности 35 (LivingEntity.checkTotemDeathProtection:
//    здоровье 1, DeathProtection.TOTEM_OF_UNDYING снимает все эффекты и даёт
//    регенерацию II 900 т, поглощение II 100 т, огнестойкость 800 т) — 5 с у него
//    1 хп + 8 поглощения и нет силы и сопротивления: всё в ход;
//  · выбитый щит — звук item.shield.break у его ног (BlocksAttacks.disable: кулдаун
//    щита round(5 с × disable_cooldown_scale 1.0 × 20) = 100 тиков у топора —
//    Item.Properties.axe: tool(…, 5.0F) — и stopUsingItem);
//  · заряженный арбалет — компонент charged_projectiles предмета в его руке
//    (CrossbowItem.use: заряженный стреляет следующим «использовать», сразу; предмет
//    с компонентами приходит в entity_equipment целиком);
//  · копьё в руке — укол по лучу 2.0–4.5 от его глаз (AttackRange копья, Item.Properties.spear).
// Всё — декомпилированный клиент 1.21.11 (github extremeheat/extracted_minecraft_data,
// ветка client1.21.11), класс указан рядом с числом.

// Имя звука — общим разбором melee.soundName (2026-09-26): своя копия поправки
// номера (SOUND_SHIFT) здесь была второй правдой, которая могла разойтись с
// melee.js; melee.js ничего не требует, круга нет.
import { soundName } from './melee'

const TICK_MS = 50
const EYE = 1.62
// DeathProtection.TOTEM_OF_UNDYING: поглощение II на 100 тиков — окно добивания.
const TOTEM_WINDOW_MS = 100 * TICK_MS
// BlocksAttacks.disable у топора: 100 тиков без щита.
const SHIELD_OFF_MS = 100 * TICK_MS

// MobEffects.java (1.21.11): цвет эффекта → имя. У «мгновенного лечения» и
// «насыщения» один цвет, а мгновенные эффекты частиц не оставляют.
const EFFECT_COLOR = {
  3402751: 'speed', 9154528: 'slowness', 14270531: 'haste', 4866583: 'mining_fatigue',
  16762624: 'strength', 11101546: 'instant_damage', 16646020: 'jump_boost', 5578058: 'nausea',
  13458603: 'regeneration', 9520880: 'resistance', 16750848: 'fire_resistance', 10017472: 'water_breathing',
  16185078: 'invisibility', 2039587: 'blindness', 12779366: 'night_vision', 5797459: 'hunger',
  4738376: 'weakness', 8889187: 'poison', 7561558: 'wither', 16284963: 'health_boost',
  2445989: 'absorption', 16262179: 'saturation', 9740385: 'glowing', 13565951: 'levitation',
  5882118: 'luck', 12624973: 'unluck', 15978425: 'slow_falling', 1950417: 'conduit_power',
  8954814: 'dolphins_grace', 745784: 'bad_omen', 4521796: 'hero_of_the_village', 2696993: 'darkness',
  12438015: 'wind_charged', 7891290: 'weaving', 10092451: 'oozing', 9214860: 'infested', 65518: 'breath_of_the_nautilus'
}

function metaIdx (bot, e, key, fallback) {
  try {
    const keys = bot.registry.entitiesByName[(e && e.name) || 'player'].metadataKeys
    const i = keys ? keys.indexOf(key) : -1
    return i >= 0 ? i : fallback
  } catch { return fallback }
}
function isPlayer (e) { return !!e && (e.type === 'player' || !!e.username) }

// Поглощение — только у игроков: у мобов его в метаданных нет.
function absorptionOf (bot, e) {
  if (!isPlayer(e) || !e.metadata) return 0
  const v = e.metadata[metaIdx(bot, e, 'player_absorption', 17)]
  return typeof v === 'number' && v > 0 ? v : 0
}
function healthRaw (bot, e) {
  if (!e || !e.metadata) return null
  const v = e.metadata[metaIdx(bot, e, 'health', 9)]
  return typeof v === 'number' ? v : null
}

// Эффекты по частицам: Set имён. Частица приходит как { type: 'entity_effect',
// data: ARGB } (протокол 1.21.11: Particle, entity_effect → i32).
function effectsOf (bot, e) {
  const out = new Set<string>()
  if (!e || !e.metadata) return out
  const arr = e.metadata[metaIdx(bot, e, 'effect_particles', 10)]
  if (!Array.isArray(arr)) return out
  for (const p of arr) {
    if (!p) continue
    const t = p.type
    if (t !== 'entity_effect' && t !== 21) continue
    const c = Number(p.data) & 0xFFFFFF
    const n = EFFECT_COLOR[c]
    if (n) out.add(n)
  }
  return out
}

// Уровень чар предмета: компонент enchantments { enchantments: [{ id, level }] },
// id — номер в реестре чар (у 1.21.11 по алфавиту, как в minecraft-data).
function enchLevel (bot, item, name) {
  try {
    const c = item && item.componentMap && item.componentMap.get('enchantments')
    const d = c && c.data
    const list = (d && (d.enchantments || (Array.isArray(d) ? d : null))) || []
    for (const x of list) {
      const id = x.id ?? x.enchantment
      const n = typeof id === 'number' ? ((bot.registry.enchantments[id] || {}).name) : String(id || '').replace(/^minecraft:/, '')
      if (n === name) return x.level ?? x.lvl ?? 1
    }
  } catch {}
  return 0
}

// Арбалет: заряжен ли и чем, чары. Снаряды в компоненте — сырые слоты
// ({ itemId, itemCount, components }).
function crossbowInfo (bot, item) {
  if (!item || item.name !== 'crossbow') return null
  let names = []
  // Звёзды заряженной ракеты: сеть шлёт только добавленные компоненты, у
  // пустой ракеты (для элитр) fireworks нет — 0 звёзд, урона 0
  // (FireworkRocketEntity.dealExplosionDamage: f = 5 + 2·звёзд, только если их > 0).
  let stars = 0
  try {
    const c = item.componentMap && item.componentMap.get('charged_projectiles')
    const list = (c && c.data && (c.data.projectiles || c.data.items)) || []
    names = list.map(s => {
      if (!s) return null
      const fw = Array.isArray(s.components) && s.components.find(x => x && /fireworks$/.test(String(x.type)))
      if (fw) stars = Math.max(stars, (fw.data && fw.data.explosions && fw.data.explosions.length) || 0)
      if (s.name) return s.name
      const id = s.itemId ?? s.id
      return id != null && bot.registry.items[id] ? bot.registry.items[id].name : null
    }).filter(Boolean)
  } catch {}
  const rocket = names.includes('firework_rocket')
  return {
    loaded: names.length > 0,
    ammo: rocket ? 'firework' : (names[0] || null),
    stars: rocket ? stars : null,
    count: names.length,
    quickCharge: enchLevel(bot, item, 'quick_charge'),
    multishot: enchLevel(bot, item, 'multishot'),
    piercing: enchLevel(bot, item, 'piercing')
  }
}

// Куда он смотрит: головой (entity_head_rotation), иначе телом; наклон — pitch.
function lookDir (e) {
  const yaw = typeof e.headYaw === 'number' ? e.headYaw : (e.yaw || 0)
  const pitch = e.pitch || 0
  return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) }
}
// Угол между его взглядом и направлением на середину нашего тела, градусы.
function aimAngle (bot, e) {
  const me = bot.entity.position
  const eye = e.position.offset(0, EYE, 0)
  const dx = me.x - eye.x; const dy = me.y + 0.9 - eye.y; const dz = me.z - eye.z
  const n = Math.hypot(dx, dy, dz) || 1
  const l = lookDir(e)
  const c = (l.x * dx + l.y * dy + l.z * dz) / n
  return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI
}

function heldIn (e) {
  const eq = (e && e.equipment) || []
  return { main: eq[0] || null, off: eq[1] || null }
}
function hasTotemInHand (e) {
  const h = heldIn(e)
  return !!((h.main && h.main.name === 'totem_of_undying') || (h.off && h.off.name === 'totem_of_undying'))
}
function spearIn (e) {
  const h = heldIn(e)
  return h.main && /_spear$/.test(h.main.name) ? h.main.name : null
}

// ---------------------------------------------------------------- слежка
//
// На событиях: тотем (entity_status 35), выбитый щит (звук). Остальное —
// по запросу из метаданных и снаряжения, они и так приходят событиями.
// «Клиент загрузился» после входа и каждого возрождения. Сервер 1.21.11 до
// этого пакета или 60 тиков (3 с) молча выбрасывает use_item, удары, действия
// (ServerGamePacketListenerImpl.hasClientLoaded: CLIENT_LOADED_TIMEOUT_TIME = 60,
// restartClientLoadTimerAfterRespawn), а mineflayer его не шлёт — замер
// 2026-09-26: первый «использовать» арбалетом после входа не заряжал ничего.
// Ванильный клиент шлёт ServerboundPlayerLoadedPacket, как только мир вокруг
// загружен, — делаем так же.
function installLoaded (bot) {
  (require('./client-loaded') as typeof import('./client-loaded')).install(bot)
}

function watch (bot, { threats = () => [], visible = () => true }: any = {}) {
  installLoaded(bot)
  const S = new Map()
  const stats: any = { pops: 0, allIn: 0, shieldBreaks: 0, aimedAtMe: 0, absorb: 0, effects: {} }
  const st = (id) => {
    let s = S.get(id)
    if (!s) S.set(id, s = { popAt: 0, pops: 0, shieldOffUntil: 0, aimedAt: 0, seenEff: new Set(), absMax: 0 })
    return s
  }
  const foes = () => { try { return (threats() || []).filter(e => e && e.position && e.isValid !== false) } catch { return [] } }
  const onStatus = (p) => {
    try {
      if (!p || p.entityStatus !== 35) return
      if (bot.entity && p.entityId === bot.entity.id) return
      if (!visible(bot.entities?.[p.entityId])) return
      const s = st(p.entityId)
      s.popAt = gameClock.now()
      s.pops++
      stats.pops++
      if (process.env.ND_DEBUG_PVP) console.log('[read] totem pop', p.entityId, (bot.entities[p.entityId] || {}).username)
      bot.emit('nd_foeTotem', bot.entities[p.entityId] || null)
    } catch {}
  }
  // Звук — сырым пакетом: номера звуков в minecraft-data 1.21.11 на 1 больше,
  // чем у сервера (замер melee.js 2026-09-26), и soundEffectHeard mineflayer
  // называл бы выбитый щит «item.shield.block». Имя — melee.soundName (поправка
  // номера и звук, заданный в пакете именем, — в одном месте).
  const onSound = (p) => {
    try {
      if (soundName(bot, p) !== 'item.shield.break') return
      const pt = { x: p.x / 8, y: p.y / 8, z: p.z / 8 }
      // Звук — у ног того, чей щит выбит (BlocksAttacks.disable: playSound в
      // позиции жертвы): ближайший к точке, и не мы (арена 2026-09-26: наш щит
      // выбили в обнимку — считали выбитым его).
      const dist = (q) => Math.hypot(q.x - pt.x, q.y - pt.y, q.z - pt.z)
      let best = null
      for (const e of foes()) { const dd = dist(e.position); if (dd <= 1.2 && (!best || dd < best.dd)) best = { e, dd } }
      if (!best || (bot.entity && dist(bot.entity.position) < best.dd)) return
      const s = st(best.e.id)
      if (gameClock.now() < s.shieldOffUntil - SHIELD_OFF_MS + 500) return
      s.shieldOffUntil = gameClock.now() + SHIELD_OFF_MS
      stats.shieldBreaks++
    } catch {}
  }
  try { bot._client.on('entity_status', onStatus) } catch {}
  try { bot._client.on('sound_effect', onSound) } catch {}

  const W: any = { stats }
  W.close = () => {
    try { bot._client.removeListener('entity_status', onStatus) } catch {}
    try { bot._client.removeListener('sound_effect', onSound) } catch {}
  }
  // Сколько мс назад сработал его тотем (Infinity — не было).
  W.poppedAgo = (e) => { const s = e && S.get(e.id); return s && s.popAt ? gameClock.now() - s.popAt : Infinity }
  // Эффективное здоровье: здоровье + поглощение.
  W.ehp = (e) => { const h = healthRaw(bot, e); return h == null ? null : h + absorptionOf(bot, e) }
  // Всё о нём одним объектом — для решений и для отчёта.
  W.state = (e) => {
    if (!e || !e.position) return {}
    const s = st(e.id)
    const now = gameClock.now()
    const hp = healthRaw(bot, e)
    const abs = absorptionOf(bot, e)
    const eff: Set<string> = effectsOf(bot, e) as Set<string>
    if (abs > s.absMax) { s.absMax = abs; if (abs > 0) stats.absorb = Math.max(stats.absorb, abs) }
    for (const n of eff) if (!s.seenEff.has(n)) { s.seenEff.add(n); stats.effects[n] = (stats.effects[n] || 0) + 1 }
    const h = heldIn(e)
    const cb = crossbowInfo(bot, h.main) || crossbowInfo(bot, h.off)
    return {
      hp, abs, ehp: hp == null ? null : hp + abs,
      effects: eff,
      popAgo: s.popAt ? now - s.popAt : Infinity,
      totemInHand: hasTotemInHand(e),
      shieldOff: Math.max(0, s.shieldOffUntil - now),
      crossbow: cb,
      spear: spearIn(e)
    }
  }
  // Окно «всё в ход»: сработал его тотем — 5 с у него 1 хп + 8 поглощения и нет
  // эффектов (сила, сопротивление сняты). null — окна нет.
  W.allIn = (e) => {
    const ago = W.poppedAgo(e)
    if (ago >= TOTEM_WINDOW_MS) return null
    const s = st(e.id)
    if (s.allInFor !== s.popAt) { s.allInFor = s.popAt; stats.allIn++ }
    return { why: 'сработал его тотем', left: TOTEM_WINDOW_MS - ago }
  }
  // Его заряженный арбалет смотрит на нас (угол ≤ maxDeg): чем заряжен и с какими чарами.
  W.aimedAtMe = (e, maxDeg = 10) => {
    if (!e || !e.position || !bot.entity) return null
    const h = heldIn(e)
    const cb = crossbowInfo(bot, h.main) || crossbowInfo(bot, h.off)
    if (!cb || !cb.loaded) return null
    const ang = aimAngle(bot, e)
    if (ang > maxDeg) return null
    const s = st(e.id)
    const now = gameClock.now()
    if (now - s.aimedAt > 2000) stats.aimedAtMe++
    // Сколько он держит прицел без перерыва (перерыв > 250 мс — новый прицел):
    // чем дольше держит, тем ближе спуск (2026-09-26).
    if (now - s.aimedAt > 250) s.aimedSince = now
    s.aimedAt = now
    return { ...cb, angle: Math.round(ang), steadyMs: now - (s.aimedSince || now) }
  }
  W.shieldOff = (e) => { const s = e && S.get(e.id); return s ? Math.max(0, s.shieldOffUntil - gameClock.now()) : 0 }
  W.has = (e, effect) => effectsOf(bot, e).has(effect)
  return W
}

export {
  watch, installLoaded, absorptionOf, healthRaw, effectsOf, enchLevel, crossbowInfo, aimAngle, lookDir, hasTotemInHand, spearIn,
  EFFECT_COLOR, TOTEM_WINDOW_MS, SHIELD_OFF_MS
}
