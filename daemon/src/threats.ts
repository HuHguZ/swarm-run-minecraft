'use strict'
const gameClock: typeof import('./game-clock') = require('./game-clock')
const { Vec3 }: typeof import('vec3') = require('vec3')
const { seesPlayer, createLastSeen, visiblePlayerItem }: typeof import('./pvp/last-seen') = require('./pvp/last-seen')
// Что летит в бота и куда от этого деваться. Общий для PvP и для побега от
// мобов: стрела скелета и стрела человека — одна и та же сущность, и уклоняться
// от неё надо одинаково.
//
// Скорость снаряда меряется по двум native position receipts; опросы не
// меняют историю. Без адаптера остаётся прежний fallback. Скорость в пакете приходит в тех единицах, что
// выбрал протокол версии (1/8000 блока за тик раньше, упакованный вектор с
// 1.21.9), и mineflayer не везде переводит её одинаково; две позиции,
// пришедшие от сервера, в переводе не нуждаются. Цена — первый опрос после
// появления стрелы ничего не знает, и это 50 мс из ~500, что она летит.

const PROJECTILES = new Set([
  'arrow', 'spectral_arrow', 'trident', 'snowball', 'egg', 'fireball',
  'small_fireball', 'wind_charge', 'breeze_wind_charge', 'shulker_bullet',
  'splash_potion', 'lingering_potion', 'potion', 'llama_spit', 'dragon_fireball',
  'wither_skull', 'ender_pearl',
  // Фейерверк из арбалета (2026-09-26): летит по прямой без гравитации
  // (FireworkRocketEntity, shotAtAngle), 1.6 бл/тик — от него успеть уйти можно.
  'firework_rocket'
])

// Снаряды, которые бьют. Жемчуг и чужие зелья лечения тоже летят, но
// уворачиваться от своего же жемчуга незачем, поэтому бросок самого бота
// отсекается по владельцу ниже, а не по имени.
const HARMLESS = new Set(['ender_pearl'])
// AbstractHurtingProjectile.tick/applyInertia, local Java 1.21.11: accelerate before moving.
// These subclasses inherit its .1 power and .95 air inertia; they do not use arrow drag.
const FIREBALLS = new Set(['fireball', 'small_fireball', 'dragon_fireball'])
const FIREBALL_INERTIA = Math.fround(.95)

const seen = new WeakMap() // observed entity -> { x, y, z, t }
const smashDescents = new WeakMap<object, 'launch' | 'descent'>()
const fastWindRises = new WeakMap<object, { epoch: number; receipt: object }>()
const playerSights = new WeakMap()
const projectileSights = new WeakMap()

function visiblePlayer (bot, raw, scope: string | null = null) {
  if (!seesPlayer(bot, raw)) return null
  let sight = playerSights.get(bot)
  if (!sight) {
    sight = { vision: null, scope }; playerSights.set(bot, sight)
    bot.once?.('end', () => { sight.vision?.close(); playerSights.delete(bot) })
  }
  if (!sight.vision) sight.vision = createLastSeen(bot)
  const view = sight.vision.observe(raw)
  return view?._ndVisible ? view : null
}

function projectileView (bot, raw, now) {
  let records = projectileSights.get(bot)
  if (!records) {
    records = new Map(); projectileSights.set(bot, records)
    const tick = () => {
      for (const [id, rec] of records) {
        if (bot.entities[id] !== rec.raw) { rec.raw.removeListener?.('ndPositionObserved', rec.update); records.delete(id); continue }
        projectileView(bot, rec.raw, gameClock.now())
      }
    }
    bot.on?.('physicsTick', tick)
    bot.once?.('end', () => {
      bot.removeListener?.('physicsTick', tick)
      for (const rec of records.values()) rec.raw.removeListener?.('ndPositionObserved', rec.update)
      records.clear(); projectileSights.delete(bot)
    })
  }
  let record = records.get(raw.id)
  if (!record || record.raw !== raw) {
    record?.raw.removeListener?.('ndPositionObserved', record.update)
    record = { raw, visible: false, view: null, receipt: null, update: null }
    record.update = () => projectileView(bot, raw, gameClock.now())
    raw.on?.('ndPositionObserved', record.update)
    records.set(raw.id, record)
  }
  if (!seesPlayer(bot, raw)) { record.visible = false; return null }
  const receipt = raw._ndPositionReceipts?.[1]
  if (!record.visible) {
    record.view = { id: raw.id, name: raw.name, position: raw.position.clone(),
      _ndPositionReceipts: [null, { x: raw.position.x, y: raw.position.y, z: raw.position.z, t: now }],
      _ndObservationNow: () => gameClock.observationNow() }
  } else if (!record.view.position.equals(raw.position) || (receipt && receipt !== record.receipt)) {
    // A visible zero-displacement position packet is a real stop observation.
    // Diagnostics may read it repeatedly, but cannot become extra motion frames.
    record.view._ndPositionReceipts = [record.view._ndPositionReceipts[1], { x: raw.position.x, y: raw.position.y, z: raw.position.z, t: receipt && receipt !== record.receipt ? receipt.t : now }]
    record.view.position.update(raw.position)
  }
  record.receipt = receipt
  record.visible = true
  return record.view
}

function sample (e, now) {
  const receipts = e._ndPositionReceipts
  if (receipts?.[0] && receipts[1]) {
    const [prev, cur] = receipts
    const dtTicks = (cur.t - prev.t) / 50
    const ageTicks = ((e._ndObservationNow?.() ?? gameClock.observationNow()) - cur.t) / 50
    if (dtTicks <= .2 || dtTicks > 10 || ageTicks > 20) return null
    return { x: (cur.x - prev.x) / dtTicks, y: (cur.y - prev.y) / dtTicks, z: (cur.z - prev.z) / dtTicks }
  }
  const prev = seen.get(e)
  const cur = { x: e.position.x, y: e.position.y, z: e.position.z, t: now }
  seen.set(e, cur)
  if (!prev) return null
  const dtTicks = (now - prev.t) / 50
  if (dtTicks <= 0.2 || dtTicks > 10) return null
  return {
    x: (cur.x - prev.x) / dtTicks,
    y: (cur.y - prev.y) / dtTicks,
    z: (cur.z - prev.z) / dtTicks
  }
}

// Стрела, которая лежит на земле или воткнулась в стену, тоже сущность arrow.
// Отличить её можно только по тому, что она не движется.
const RESTING = 0.05

// Ближайший подход снаряда к телу бота за horizonTicks. Та же физика, что у
// игры для стрел: сначала шаг, потом сопротивление 0.99 и гравитация.
// Брошенное рукой (ThrowableProjectile.tick, 1.21.2+) за тик: гравитация,
// трение, сдвиг. Стрела и трезубец (AbstractArrow.tick): сдвиг, трение,
// гравитация. Разница — полблока на двадцати тиках.
const THROWN = new Set(['snowball', 'egg', 'ender_pearl', 'splash_potion', 'lingering_potion', 'potion', 'experience_bottle'])

function flightBlock (bot, from, to) {
  const v = new Vec3(to.x - from.x, to.y - from.y, to.z - from.z)
  const n = v.norm()
  return n > 1e-8 ? (require('./pick') as typeof import('./pick')).blockOnRay(bot, from, v.scaled(1 / n), n) : null
}

function closestApproach (bot, pos, vel, gravity, horizonTicks, thrown = false, fireball = false, moving = false) {
  const me = bot.entity.position
  const cx = me.x
  const cy = me.y + 0.9
  const cz = me.z
  let p = { x: pos.x, y: pos.y, z: pos.z }
  let v = { x: vel.x, y: vel.y, z: vel.z }
  let best: any = { dist: Infinity, ticks: 0 }
  const mv = bot.entity.velocity || { x: 0, y: 0, z: 0 }
  for (let t = 1; t <= horizonTicks; t++) {
    const prev = p
    if (fireball) {
      const speed = Math.hypot(v.x, v.y, v.z)
      const scale = speed > 0 ? (1 + .1 / speed) * FIREBALL_INERTIA : 0
      v = { x: v.x * scale, y: v.y * scale, z: v.z * scale }
      p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }
    } else if (thrown) {
      v = { x: v.x * 0.99, y: (v.y - gravity) * 0.99, z: v.z * 0.99 }
      p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }
    } else {
      p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }
      v = { x: v.x * 0.99, y: v.y * 0.99 - gravity, z: v.z * 0.99 }
    }
    if (moving) {
      // Луч относительно движущегося тела ловит и быстрый пролёт между двумя тиками.
      const delta = { x: p.x - prev.x, y: p.y - prev.y, z: p.z - prev.z }
      const relative = { x: prev.x - me.x - mv.x * (t - 1), y: prev.y - me.y - mv.y * (t - 1), z: prev.z - me.z - mv.z * (t - 1) }
      const radius = (bot.entity.width || .6) / 2 + .25
      const u = (require('./pick') as typeof import('./pick')).rayBox(relative,
        { x: delta.x - mv.x, y: delta.y - mv.y, z: delta.z - mv.z },
        { x: -radius, y: -.25, z: -radius }, { x: radius, y: (bot.entity.height || 1.8) + .25, z: radius }, 1)
      const wall = flightBlock(bot, prev, p)
      if (u != null && (!wall || u * Math.hypot(delta.x, delta.y, delta.z) < wall.t)) return { dist: 0,
        ticks: Math.max(1, t - 1 + u), at: { x: prev.x + delta.x * u, y: prev.y + delta.y * u, z: prev.z + delta.z * u }, vel: v }
      if (wall) break
      continue
    }
    // Тело — столб высотой 1.8, а не точка: стрела, пролетающая над головой на
    // уровне 1.7, попадает, и считать по центру значит уворачиваться поздно.
    const dy = Math.max(0, Math.abs(p.y - cy) - 0.9)
    const d = Math.hypot(p.x - cx, dy, p.z - cz)
    if (d < best.dist) best = { dist: d, ticks: t, at: p, vel: v }
  }
  return best
}

const GRAVITY = {
  arrow: 0.05, spectral_arrow: 0.05, trident: 0.05,
  snowball: 0.03, egg: 0.03, ender_pearl: 0.03,
  splash_potion: 0.05, lingering_potion: 0.05, potion: 0.05, experience_bottle: 0.07, llama_spit: 0.06
}

// Всё, что летит в нас и попадёт в ближайшие horizonTicks. Самые срочные первыми.
function incoming (bot, { horizonTicks = 24, hitRadius = 0.9 }: any = {}) {
  if (!bot || !bot.entity) return []
  const now = gameClock.now()
  const out = []
  const me = bot.entity.position
  for (const raw of ((Object.values(bot.entities) as any[]) as any)) {
    if (!raw || !raw.position || !PROJECTILES.has(raw.name)) continue
    const e = projectileView(bot, raw, now)
    const th = bot._ndThrown?.get(raw.id)
    if (!e || th?.own === true) continue
    // Разгон стрелой (combat/arrow-boost): стрела того, чьего толчка жду, — не угроза, уворот её и сорвёт.
    if (th?.rawOwner && bot._ndBoostFrom?.has(bot.entities[th.rawOwner]?.username)) continue
    if (e.position.distanceTo(me) > 48) continue
    const vel = sample(e, now)
    if (!vel || HARMLESS.has(e.name)) continue
    const speed = Math.hypot(vel.x, vel.y, vel.z)
    if (speed < RESTING) continue
    const g = GRAVITY[e.name] ?? 0
    const hit: any = closestApproach(bot, e.position, vel, g, horizonTicks, THROWN.has(e.name), FIREBALLS.has(e.name))
    if (hit.dist > hitRadius) continue
    out.push({ entity: e, name: e.name, ticks: hit.ticks, dist: hit.dist, at: hit.at, vel, speed })
  }
  return out.sort((a, b) => a.ticks - b.ticks)
}

// Куда шагнуть, чтобы сойти с линии: поперёк полёта, в ту сторону, где
// стоять можно. Ответ — имя клавиши относительно того, куда бот смотрит
// сейчас ('left' | 'right'), потому что именно ей и будут двигать тело.
function dodgeKey (bot, proj, safe: (direction: string) => boolean = () => true) {
  const yaw = bot.entity.yaw
  // Взгляд (-sin, -cos); правая рука — взгляд, повёрнутый по часовой (сверху):
  // смотрит на север (0,-1) — правая рука на востоке (1,0).
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) }
  // Прочь от точки, где линия полёта ближе всего к нам. Если она идёт ровно в
  // центр, любая сторона поперёк полёта одинаково хороша.
  const me = bot.entity.position
  let away = proj.at ? { x: me.x - proj.at.x, z: me.z - proj.at.z } : { x: 0, z: 0 }
  if (Math.hypot(away.x, away.z) < 0.15) away = { x: -proj.vel.z, z: proj.vel.x }
  const side = away.x * right.x + away.z * right.z
  const first = side >= 0 ? 'right' : 'left'
  const second = first === 'right' ? 'left' : 'right'
  if (safe(first)) return first
  if (safe(second)) return second
  return null
}

// Зелья, от которых уходить (арена 12.10: «кидаю зелья — стоят со щитом и помирают»): щит брызги не держит, а лягут
// они в радиусе 4 (ThrownSplashPotion.applySplash: рамка ±4 по горизонтали, ±2 по вертикали). Видно глазами:
// летящее зелье несёт свой предмет (метаданные, тот же индекс, что у выпавшего), в руке у игрока — его снаряжение.
// Лечение, реген и баффы — не угроза (свои кидают лечение); неизвестное — угроза.
const SPLASH = /^(splash_potion|lingering_potion)$/
function potionRoleOf (bot, item) {
  try { const pvp: typeof import('./pvp') = require('./pvp'); return pvp.potionRole(pvp.potionOf(item)) } catch { return null }
}
// Падающий сверху враг (булава с высоты, 12.10: «залетел на бота — он тупо смотрел»): его ноги — шаг тика как у игрока
// в воздухе (LivingEntity.travel: y = (y − 0.08)·0.98, по горизонтали трение 0.91), пока не опустятся до моей головы;
// сядет ближе 4 бл. и в 30 тиков — угроза. foes — имена врагов (команду знает арена).
function smashes (bot, foes: string[], scope: string | null = null, shieldAim = false) {
  const out = []
  if (!foes.length) return out
  const me = bot.entity.position
  const now = gameClock.now()
  for (const raw of Object.values(bot.entities) as any[]) {
    if (!raw || raw.type !== 'player' || !foes.includes(raw.username) || !raw.position) continue
    const e = visiblePlayer(bot, raw, scope); if (!e) { smashDescents.delete(raw); continue }
    const dy = e.position.y - me.y
    if (dy < 1.5 || Math.hypot(e.position.x - me.x, e.position.z - me.z) > 32) { smashDescents.delete(raw); fastWindRises.delete(e); continue }
    const v = e.velocity || { x: 0, y: 0, z: 0 }
    if (v.y >= -.3 && smashDescents.get(raw) === 'descent') smashDescents.delete(raw)
    const hand = (e.heldItem || e.equipment?.[0])?.name
    const mace = e._ndMaceSeen || hand === 'mace'
    // Поздний свап не отменяет высокий спуск на нас; обычный прыжок (вершина 1.25) этого не доказывает.
    const descent = v.y < -.3 && (dy > 3.5 || smashDescents.has(raw))
    // Как mace.track: видимый подъём быстрее прыжка, с зарядом в руке и уже высоко над нами.
    // Его апекс нельзя забыть до спуска: поднявшийся защитник оставляет меньше времени на щит.
    const legacyLaunch = smashDescents.get(raw) === 'launch' || dy > 3.5 && v.y > .55 && hand === 'wind_charge'
    const risePhase = e.onGround === false && !(require('./elytra/track') as typeof import('./elytra/track')).gliding(e)
    const epoch = e._ndMotionEpoch
    const [previous, receipt] = e._ndPositionReceipts || []
    const earlier = e._ndEarlierPositionReceipt
    const rise = fastWindRises.get(e)
    // The remembered rise belongs to this observer's body view and its continuous air receipts.
    const retained = risePhase && rise && rise.epoch === epoch && receipt && !receipt.grounded &&
      (rise.receipt === receipt || !previous?.grounded &&
        (rise.receipt === previous || rise.receipt === earlier && !earlier?.grounded))
    if (!retained) fastWindRises.delete(e)
    const fastWind = risePhase && Number.isInteger(epoch) && v.y > .55 && hand === 'wind_charge' && e._ndGearVisible?.[0] &&
      [previous, receipt].every(r => /^(rel_entity_move|entity_move_look)$/.test(r?.kind || ''))
    const launch = legacyLaunch || fastWind || retained
    if (!mace && !descent && !launch) continue
    // Стоит на крыше (под ногами блок) — не падает: скачок позиции (телепорт, ступенька) давал «падает на меня».
    let under = null
    try { under = bot.blockAt(e.position.offset(0, -0.3, 0), false) } catch {}
    const world = Object.create(bot)
    world.blockAt = p => { try { return bot.blockAt(p, false) || { name: 'unknown', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } } catch { return { name: 'unknown', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } } }
    const knownSupport = under?.boundingBox === 'block' && (require('./pick') as typeof import('./pick')).blockSeen(world, under.position || e.position.offset(0, -.3, 0).floored())
    if (knownSupport) { smashDescents.delete(raw); fastWindRises.delete(e); continue }
    // Запомнить видимый разгон, пока защитник сам прыгает или цель ещё не входит в прогноз удара.
    if ((fastWind || retained) && rise?.receipt !== receipt) fastWindRises.set(e, { epoch, receipt })
    // Взлёт (ветер, прыжок) — тоже угроза: вниз он вернётся; скачок позиции от телепорта даёт дикую скорость — в пределах
    // взлёта на заряде ветра (замер mace-2: телепорт на 14 бл. вверх — «летит вверх», удар замечен за 6 тиков).
    const p = { x: e.position.x, y: e.position.y, z: e.position.z }
    let vx = Math.max(-2, Math.min(2, v.x)); let vy = Math.max(-4, Math.min(1.2, v.y)); let vz = Math.max(-2, Math.min(2, v.z)); let t = 0
    while (t < 45 && !(vy < 0 && p.y <= me.y + 1.8)) { p.x += vx; p.y += vy; p.z += vz; vy = (vy - 0.08) * 0.98; vx *= 0.91; vz *= 0.91; t++ }
    // 5, а не 4: за время падения я и сам могу шагнуть под него (mace-6: шёл отдать броню — и под удар).
    if (t >= 45 || Math.hypot(p.x - me.x, p.z - me.z) > (mace ? 5 : 3.5)) continue
    if (descent) smashDescents.set(raw, 'descent')
    else if (legacyLaunch) smashDescents.set(raw, 'launch')
    const shieldFrom = shieldAim ? (require('./combat/shield') as typeof import('./combat/shield')).smashShieldAim(bot, e) : null
    out.push({ name: e.username, at: { x: p.x, y: p.y, z: p.z }, from: { x: e.position.x, y: e.position.y + 1.6, z: e.position.z },
      ...(shieldFrom ? { shieldFrom } : {}), vel: sample(e, now), ticks: t, dbg: `support unknown@${e.position.y.toFixed(2)} vy ${v.y.toFixed(2)}` })
  }
  return out
}
// Брошенное зелье — с мига броска (12.10: «на зелья плохо реагируют»): позиция летящего зелья приходит раз в 10 тиков
// (трекинг брошенных), скорость по двум позициям опаздывала на полсекунды — бот узнавал, когда оно уже падало. Точка
// и скорость вылета — из пакета появления (lpVec3, drops.velocityFromRaw), дальше — своя физика брошенного.
function thrownTracker (bot) {
  if (bot._ndThrown) return bot._ndThrown
  const T = new Map()
  bot._ndThrown = T
  // Стрелы и трезубец — так же (12.10: «стрелы — уворачиваться, просчитывать заранее»): их позиция приходит раз в 20 тиков.
  // Всё, что летит (12.10: «уворот от зелий — такой же, как от снежков, от любых предметов, что летят в бота»): снаряды
  // Жемчуг нужен засаде, хотя не входит в список угроз.
  const types = new Map([...PROJECTILES].map(n => [bot.registry.entitiesByName[n]?.id, n]).filter(([id]) => id != null) as any)
  const windVelocity = (id, velocity, position = null, birthSample = false) => {
    const record = T.get(id), entity = bot.entities[id]
    if (!record || !entity || !velocity || !/^(?:breeze_)?wind_charge$/.test(record.name)) return
    const time = gameClock.observationNow(), view = projectileView(bot, entity, time)
    // Native motion is public only with its visible receipt. A LOS rebaseline creates a new view without it.
    if (!view) return
    const previous = view._ndWindMotion, axes = ['x', 'y', 'z']
    let birth = birthSample ? { record, velocity: null } : null
    if (position && previous?.birth?.record === record && axes.every(a => position[a] === record.p[a])) {
      // The first full sync refines LpVec3's packed spawn velocity; later duplicates must match its exact doubles.
      const scale = Math.ceil(Math.max(...axes.map(a => Math.abs(velocity[a]))))
      const same = previous.birth.velocity
        ? axes.every(a => velocity[a] === previous.birth.velocity[a])
        : scale > 0 && axes.every(a => (Math.min(Math.round((velocity[a] / scale * .5 + .5) * 32766), 32766) * 2 / 32766 - 1) * scale === record.v[a])
      if (same) {
        const age = Math.max(0, (time - record.observedAt) / 50)
        position = Object.fromEntries(axes.map(a => [a, record.p[a] + velocity[a] * age]))
        birth = { record, velocity: { ...velocity } }
      }
    }
    if (!position) {
      const previous = view._ndWindMotion, receipt = view._ndPositionReceipts[1]
      const native = previous?.t >= receipt.t, motion = native ? previous.velocity : sample(view, time)
      if (!motion) return
      const start = native ? previous.position : view.position, age = (time - (native ? previous.t : receipt.t)) / 50
      position = { x: start.x + motion.x * age, y: start.y + motion.y * age, z: start.z + motion.z * age }
    }
    view._ndWindMotion = { position: { ...position }, velocity: { ...velocity }, t: time, ...(birth ? { birth } : {}) }
  }
  bot._client.on('packet', (data, meta, buf) => {
    if (data && meta?.name === 'entity_velocity') {
      if (/^(?:breeze_)?wind_charge$/.test(T.get(data.entityId)?.name || '')) windVelocity(data.entityId, (require('./drops') as typeof import('./drops')).velocityFromRaw(buf, 'velocity'))
      return
    }
    if (!meta || meta.name !== 'spawn_entity' || !data || !types.has(data.type)) return
    const v = (require('./drops') as typeof import('./drops')).velocityFromRaw(buf, 'spawn')
    // objectData снаряда — id бросившего (Projectile.getOwner в пакете спавна, 1.21): свой бросок и союзный — не угроза.
    const own = Number(data.objectData) > 0 && Number(data.objectData) === bot.entity.id
    const body = { name: types.get(data.type), position: new Vec3(data.x, data.y, data.z), width: .25, height: .25 }
    if (!own && !seesPlayer(bot, body)) return
    const owner = bot.entities[Number(data.objectData)]
    const knownOwner = own ? bot.entity.id : owner && seesPlayer(bot, owner) ? owner.id : 0
    // rawOwner — id стрелка без проверки видимости: только чтобы узнать «свою» стрелу разгона (лучник за спиной не виден).
    const name = types.get(data.type)
    const gameTick = name === 'ender_pearl' ? (require('./combat/team-wind') as typeof import('./combat/team-wind')).worldTick(bot) : undefined
    if (v) T.set(data.entityId, { name, p: { x: data.x, y: data.y, z: data.z }, v, t0: gameClock.now(), observedAt: gameClock.observationNow(), owner: knownOwner, rawOwner: Number(data.objectData) || 0, own, gameTick })
  })
  const spawn = entity => windVelocity(entity.id, T.get(entity.id)?.v, T.get(entity.id)?.p, true)
  const sync = packet => { if (T.has(packet.entityId)) windVelocity(packet.entityId, { x: packet.dx, y: packet.dy, z: packet.dz }, { x: packet.x, y: packet.y, z: packet.z }) }
  bot.on('entitySpawn', spawn)
  bot._client.on('sync_entity_position', sync)
  bot.once('end', () => { bot.removeListener('entitySpawn', spawn); bot._client.removeListener('sync_entity_position', sync) })
  bot.on('entityGone', e => { if (e) T.delete(e.id) })
  return T
}
// Куда ляжет: шаг ThrowableProjectile (гравитация, трение 0.99, сдвиг) от вылета до высоты моих ног.
function thrownLanding (r, age, floorY) {
  const p = { ...r.p }; let vx = r.v.x; let vy = r.v.y; let vz = r.v.z
  for (let t = 1; t <= age + 60; t++) {
    vy = (vy - (GRAVITY.splash_potion)) * 0.99; vx *= 0.99; vz *= 0.99
    p.x += vx; p.y += vy; p.z += vz
    if (t > age && vy < 0 && p.y <= floorY) return { at: p, ticks: t - age }
  }
  return null
}
// Целится в меня из лука или арбалета (12.10: «уворачиваться заранее — как только я нацеливаюсь, это же видно»): лук
// натянут (living_entity_flags 0x01 — «использует», рука — бит 0x02) или арбалет в руке, взгляд по горизонтали — на
// меня в пределах 8°, ближе 64 бл. Видно глазами (поза и поворот головы), без прицела в пакетах.
function aims (bot, foes: string[] | null, scope: string | null, flight = false) {
  const out = []
  const me = bot.entity.position
  let ix = 8
  try { const k = bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags'); if (k >= 0) ix = k } catch {}
  for (const raw of Object.values(bot.entities) as any[]) {
    if (!raw || raw === bot.entity || raw.type !== 'player' || (foes !== null && !foes.includes(raw.username)) || !raw.position) continue
    const e = visiblePlayer(bot, raw, scope); if (!e) continue
    const d = e.position.distanceTo(me)
    if (d < 1.5 || d > 64) continue
    const f = e.metadata?.[ix]
    const eq = e.equipment || []
    const it = typeof f === 'number' && (f & 0x02) ? eq[1] : eq[0]
    // Трезубец в замахе (рука активна, как натянутый лук) — тоже прицел (пользователь 14.10: «трезубцы — плохо уворачиваются,
    // только прыжки, а надо стрейфить постоянно»): раньше видели только летящий трезубец — поздно, рывок вместо джука.
    const loaded = it?.componentMap?.get('charged_projectiles')?.data
    const drawn = it && (((it.name === 'bow' || it.name === 'trident') && typeof f === 'number' && (f & 0x01)) || it.name === 'crossbow' &&
      (!flight || !!(f & 0x01) || (loaded?.projectiles || loaded?.items || []).length > 0))
    if (!drawn) continue
    // Взгляд mineflayer: (−sin yaw, …, −cos yaw); угол до меня по горизонтали.
    const want = Math.atan2(-(me.x - e.position.x), -(me.z - e.position.z))
    let dy = Math.abs(want - e.yaw) % (2 * Math.PI); if (dy > Math.PI) dy = 2 * Math.PI - dy
    // Допуск — полширины тела на этой дистанции и 5° сверху (12.10: «вблизи перестают уворачиваться» — при 8° вблизи
    // прицел в край тела выходил за допуск).
    if (dy > Math.max(8 * Math.PI / 180, Math.atan2(0.7, d) + 5 * Math.PI / 180)) continue
    const hx = me.x - e.position.x; const hz = me.z - e.position.z; const h = Math.hypot(hx, hz) || 1
    out.push({ id: e.id, name: e.username, at: { x: e.position.x, y: e.position.y, z: e.position.z },
      from: { x: e.position.x, y: e.position.y + 1.62, z: e.position.z }, weapon: it.name, side: { x: -hz / h, z: hx / h } })
  }
  return out
}
// Видимые события рядом храним и для объяснения слышимой копки; опасность — только форма под своей рамкой ног.
function floorSupport (bot, boxes) {
  if (!bot.entity) return false
  const { bodyBox }: typeof import('./navigation/geometry') = require('./navigation/geometry')
  const body = bodyBox(bot, bot.entity.position), feet = bot.entity.position.y
  return boxes.some(b => b.maxY <= feet + 1e-7 && feet - b.maxY <= 3 &&
    Math.min(body.maxX, b.maxX) - Math.max(body.minX, b.minX) > 1e-7 && Math.min(body.maxZ, b.maxZ) - Math.max(body.minZ, b.minZ) > 1e-7)
}

// Свою активную копку не считаем, события живут прежние 0.8 с. Союзная копка собственной опоры — всё ещё угроза.
function floorTracker (bot) {
  if (bot._ndFloor) return bot._ndFloor
  const senses: typeof import('./perception/senses') = require('./perception/senses')
  senses.installHearing(bot)
  const { shapeBoxes }: typeof import('./navigation/geometry') = require('./navigation/geometry')
  const ev: any[] = []
  bot._ndFloor = ev
  bot.on('diggingCompleted', () => { bot._ndFloorOwnDigAt = gameClock.now() })
  const near = (p) => {
    const me = bot.entity?.position
    return !!me && Math.abs(p.x + .5 - me.x) <= 1.8 && Math.abs(p.z + .5 - me.z) <= 1.8 && p.y < me.y && p.y >= Math.floor(me.y) - 3
  }
  const mine = (p) => !!bot.targetDigBlock?.position && bot.targetDigBlock.position.equals(p)
  const seen = (block) => {
    // Для уже исчезнувшей опоры проверяем прежний контур, не меняя мир тела.
    const view = Object.create(bot)
    view.blockAt = p => p.floored().equals(block.position) ? block : bot.blockAt(p)
    return (require('./pick') as typeof import('./pick')).blockSeen(view, block.position)
  }
  const remember = (block, sound) => {
    const me = bot.entity.position, at = block.position.clone(), dx = at.x + .5 - me.x, dz = at.z + .5 - me.z
    ev.push({ at, t: gameClock.now(), boxes: shapeBoxes(block), sound, dir8: senses.dir8(dx, dz),
      band: senses.band(Math.hypot(dx, at.y + .5 - me.y, dz)) })
  }
  bot.on('blockUpdate', (oldB, newB) => {
    try { if (oldB?.boundingBox === 'block' && newB && newB.boundingBox !== 'block' && near(newB.position) && !mine(newB.position) && seen(oldB)) remember(oldB, 'break') } catch {}
  })
  bot.on('blockBreakProgressObserved', (block, stage, breaker) => {
    try { if (block?.position && breaker?.id !== bot.entity?.id && near(block.position) && !mine(block.position) && seen(block)) remember(block, 'hit') } catch {}
  })
  return ev
}
function floorDanger (bot) {
  const F = floorTracker(bot)
  const now = gameClock.now()
  while (F.length && now - F[0].t > 800) F.shift()
  if (!bot.entity) return []
  const me = bot.entity.position
  const support = F.filter(e => floorSupport(bot, e.boxes))
  if (!support.length) {
    // Слышно лишь близкую копку, не личность копающего и не клетку под полом.
    const senses: typeof import('./perception/senses') = require('./perception/senses')
    // Видимая соседняя копка объясняет совпавший грубый звук, пока вся рамка стоит на видимой целой опоре.
    // Без этого объяснения звук под непрозрачным полом остаётся неопределённой угрозой, без раскрытия клетки.
    const { supportAt, bodyBox }: typeof import('./navigation/geometry') = require('./navigation/geometry')
    const own = F.length ? supportAt(bot, me, .04) : null, body = bodyBox(bot, me)
    const intact = own && own.overlap >= (body.maxX - body.minX) * (body.maxZ - body.minZ) - 1e-7 &&
      (require('./pick') as typeof import('./pick')).blockSeen(bot, own.block.position)
    const h = !bot.targetDigBlock && now - (bot._ndFloorOwnDigAt ?? -Infinity) > 800 && senses.heard(bot, { sinceMs: 800, match: /^block\.[a-z_]+\.(hit|break)$/ })
      .find(h => h.band === 'рядом' && !(intact && F.some(e => e.sound === h.what && e.dir8 === h.dir8 && e.band === h.band)))
    const at = h && senses.hearPoint(bot, h)
    return at ? [{ name: 'копка рядом', at, from: at, ticks: 0, holes: 0, signal: 'sound' }] : []
  }
  const at = { x: support.reduce((s, e) => s + e.at.x + .5, 0) / support.length, y: Math.floor(me.y) - 1, z: support.reduce((s, e) => s + e.at.z + .5, 0) / support.length }
  return [{ name: 'видимый подкоп', at, from: at, ticks: 0, holes: support.length, signal: 'sight' }]
}
// Один расчёт на игровой тик (стенд 22.10: опрос состояния драйвера 4 раза в секунду считал опасности заново, хотя рассылка
// уже посчитала их в этом тике, — 6 % процессора тела). Копия верхнего уровня: вызывающий может переназначить поле.
const dangerMemo = new WeakMap<object, { key: string, value: any }>()
function dangers (bot, opts: { radius?: number, foes?: string[] | null } = {}) {
  const tick = bot?.ndClock?.ticks
  if (!Number.isSafeInteger(tick) || !bot.entity) return dangersNow(bot, opts)
  const foes = opts.foes == null ? null : [...new Set(Array.isArray(opts.foes) ? opts.foes.filter(n => typeof n === 'string') : [])].sort()
  const key = `${tick}|${opts.radius ?? 12}|${foes === null ? '*' : foes.join(',')}`
  const hit = dangerMemo.get(bot)
  if (hit?.key === key) return { ...hit.value }
  const value = dangersNow(bot, opts)
  dangerMemo.set(bot, { key, value })
  return { ...value }
}
// Лёгкий прогноз для тела: без сканирования лавы, пола, паутины и чужих прыжков.
const projectileMemo = new WeakMap<object, { key: string, boostFrom: Set<string> | null | undefined, value: any }>()
function projectileDangers (bot, { foes = null as string[] | null } = {}) {
  if (!bot?.entity) return { potions: [], arrows: [], aims: [] }
  foes = foes === null ? null : [...new Set(Array.isArray(foes) ? foes.filter(name => typeof name === 'string') : [])].sort()
  const scope = foes === null ? null : JSON.stringify(foes)
  const sight = playerSights.get(bot)
  if (sight && sight.scope !== scope) { sight.vision?.close(); sight.vision = null; sight.scope = scope }
  const tick = bot.ndClock?.ticks, key = `${tick}|${scope}`, boostFrom = bot._ndBoostFrom
  const memo = projectileMemo.get(bot)
  if (Number.isSafeInteger(tick) && memo?.key === key && memo.boostFrom === boostFrom) return { ...memo.value }
  const value = { ...projectileThreats(bot, foes, true), aims: aims(bot, foes, scope, true) }
  if (boostFrom) {
    // rawOwner also identifies an expected boost archer behind us; all other shots stay threats.
    value.arrows = value.arrows.filter(shot => !/^(arrow|spectral_arrow)$/.test(shot.name) ||
      !boostFrom.has(bot.entities[bot._ndThrown?.get(shot.id)?.rawOwner]?.username))
    value.aims = value.aims.filter(aim => aim.weapon !== 'bow' || !boostFrom.has(aim.name))
  }
  if (Number.isSafeInteger(tick)) projectileMemo.set(bot, { key, boostFrom, value })
  return { ...value }
}

const gliderSights = new WeakMap()
// One manual tracker per visible glider; no extra physics listener for each enemy.
function incomingGliders (bot, { foes = null as string[] | null } = {}) {
  if (!bot?.entity) return []
  const sky: typeof import('./elytra/track') = require('./elytra/track')
  let state = gliderSights.get(bot)
  const now = gameClock.now()
  // A suspended movement owner cannot supply velocity across the missed observation window.
  if (state && now - state.at > 160) { for (const r of state.records.values()) r.tracker.close(); state.records.clear() }
  const visible = new Set(), out = []
  for (const raw of Object.values(bot.entities || {}) as any[]) {
    if (!raw || raw === bot.entity || raw.type !== 'player' || !raw.position || !sky.gliding(raw) ||
      (foes !== null && !foes.includes(raw.username)) || (require('./combat/ally-safety') as typeof import('./combat/ally-safety')).isAlly(bot, raw)) continue
    const view = visiblePlayer(bot, raw, foes === null ? null : JSON.stringify(foes))
    if (!view || !sky.gliding(view)) continue
    if (!state) {
      const lance: typeof import('./combat/aerial-lance') = require('./combat/aerial-lance')
      const clip = lance.lanceCollider((require('./pvp/search') as typeof import('./pvp/search')).observedCollision(bot))
      state = { records: new Map(), clip, at: now }; gliderSights.set(bot, state)
      const reset = () => { for (const r of state.records.values()) r.tracker.close(); state.records.clear() }
      bot.on?.('death', reset); bot.on?.('respawn', reset)
      bot.once?.('end', () => { reset(); bot.removeListener?.('death', reset); bot.removeListener?.('respawn', reset); gliderSights.delete(bot) })
    }
    visible.add(raw.id)
    let r = state.records.get(raw.id)
    if (!r || r.raw !== raw) {
      r?.tracker.close()
      r = { raw, view, tracker: null }
      r.tracker = sky.track(bot, { enemy: () => r.view, listen: false, clip: state.clip })
      state.records.set(raw.id, r)
    }
    r.view = view; r.tracker.update()
    const threat = r.tracker.threat()
    if (!threat) continue
    const vel = r.tracker.vel(), n = Math.hypot(vel.x, vel.z)
    out.push({ id: raw.id, name: 'glider', kind: threat.kind, ticks: threat.eta, at: threat.at,
      from: { x: view.position.x, y: view.position.y, z: view.position.z }, vel,
      ...(n > 0 ? { side: { x: -vel.z / n, z: vel.x / n } } : {}), blockable: threat.kind === 'lance' })
  }
  if (state) {
    state.at = now
    for (const [id, r] of state.records) if (!visible.has(id)) { r.tracker.close(); state.records.delete(id) }
  }
  return out.sort((a, b) => a.ticks - b.ticks)
}

function projectileThreats (bot, foes, moving = false) {
  const me = bot.entity.position
  const potions = []
  const arrows = []
  const T = thrownTracker(bot)
  for (const [id, r] of T) {
    const e = bot.entities[id]
    const age = Math.round((gameClock.now() - r.t0) / 50)
    if (!e) { T.delete(id); continue }
    if (HARMLESS.has(r.name)) continue
    if (age > 60 && !moving) {
      // Старый опрос не удаляет свежую траекторию, которую ведёт слой тела.
      if (!r.visibleMotion) T.delete(id)
      continue
    }
    // Бросил я сам (12.10: кидал себе зелье лечения и сам же от него отпрыгивал) или не враг — пропуск; бросивший неизвестен — угроза.
    const owner = r.owner ? bot.entities[r.owner] : null
    if ((r.owner && r.owner === bot.entity.id) || (owner && owner.type === 'player' && foes !== null && !foes.includes(owner.username))) {
      if (age > 60) T.delete(id)
      continue
    }
    const view = moving && projectileView(bot, e, gameClock.now())
    if (moving && !view) { r.visibleMotion = false; if (age > 60) T.delete(id); continue }
    const measured = view && sample(view, gameClock.now())
    const stopped = measured && Math.hypot(measured.x, measured.y, measured.z) < RESTING
    if (moving) r.visibleMotion = !!measured && !stopped
    // Долгий полёт подтверждает свежая видимая скорость, старый вылет сам себя не продлевает.
    if (age > 60 && (!measured || stopped)) { T.delete(id); continue }
    if (stopped) continue
    // Прямое попадание (стрела, трезубец, снежок, яйцо, заряд ветра, огненный шар; брызгающее зелье — тоже, если летит в
    // тело): свой выстрел (вылет у меня) и застрявшее (дольше 25 тиков) — мимо. Где оно сейчас — своя физика от вылета
    // (стрела: сдвиг, потом трение и гравитация; брошенное: наоборот; шары — инерция), дальше — ближайший подход за 30 тиков.
    const direct = () => {
      if (!moving && (age > 25 || Math.hypot(r.p.x - me.x, r.p.y - me.y - 1.5, r.p.z - me.z) < 2)) return null
      const g = GRAVITY[r.name] ?? 0; const thrown = THROWN.has(r.name); const fire = FIREBALLS.has(r.name)
      // Новый видимый пакет исправляет прогноз после остановки или отражения снаряда.
      let p = { ...(measured ? view.position : r.p) }; let v = { ...(measured || r.v) }
      for (let t = 0; t < (measured ? 0 : age); t++) {
        const prev = p
        if (fire) { const sp = Math.hypot(v.x, v.y, v.z); const k = sp > 0 ? (1 + 0.1 / sp) * FIREBALL_INERTIA : 0; v = { x: v.x * k, y: v.y * k, z: v.z * k }; p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z } }
        else if (thrown) { v = { x: v.x * 0.99, y: (v.y - g) * 0.99, z: v.z * 0.99 }; p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z } }
        else { p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }; v = { x: v.x * 0.99, y: v.y * 0.99 - g, z: v.z * 0.99 } }
        if (moving && flightBlock(bot, prev, p)) return null
      }
      const hit: any = closestApproach(bot, p, v, g, 30, thrown, fire, moving)
      return hit.dist > 1.0 ? null : { hit, v, from: p }
    }
    if (moving || !SPLASH.test(r.name)) {
      const dh = direct()
      if (!dh && !SPLASH.test(r.name)) continue
      if (dh) {
        const { hit, v, from } = dh
        // Шаг — поперёк полёта, в сторону от линии (прямо в центр — любая сторона).
        const hv = Math.hypot(v.x, v.z) || 1
        let sx = -v.z / hv; let sz = v.x / hv
        if ((me.x - hit.at.x) * sx + (me.z - hit.at.z) * sz < 0) { sx = -sx; sz = -sz }
        arrows.push({ id, name: r.name, ticks: hit.ticks, at: hit.at, from: moving ? from : r.p, side: { x: sx, z: sz }, vel: v,
          blockable: !/(?:potion|wind_charge|dragon_fireball)$/.test(r.name) })
      }
      if (!SPLASH.test(r.name)) continue
    }
    const l = thrownLanding(r, age, me.y + 0.3)
    if (!l || Math.hypot(l.at.x - me.x, l.at.z - me.z) > 4.5) continue
    // Содержимое чужого зелья не видно: неизвестный бросок считаем угрозой.
    const role = null
    if (!/^(heal|regen|buff)$/.test(role || '')) potions.push({ id, at: l.at, from: r.p, ticks: l.ticks, name: r.name, role, blockable: false })
  }
  return { potions, arrows: arrows.sort((a, b) => a.ticks - b.ticks) }
}

function dangersNow (bot, { radius = 12, foes = null as string[] | null } = {}) {
  if (!bot || !bot.entity) return { potions: [], holders: [], clouds: [], smashes: [], arrows: [], aims: [], lava: [], floor: [], blasts: [], web: [] }
  // An explicit empty team list differs from the legacy unfiltered observation.
  foes = foes === null ? null : [...new Set(Array.isArray(foes) ? foes.filter(name => typeof name === 'string') : [])].sort()
  const scope = foes === null ? null : JSON.stringify(foes)
  const sight = playerSights.get(bot)
  if (sight && sight.scope !== scope) { sight.vision?.close(); sight.vision = null; sight.scope = scope }
  const me = bot.entity.position
  const { potions, arrows } = projectileThreats(bot, foes)
  const holders = []
  for (const raw of Object.values(bot.entities) as any[]) {
    if (!raw || raw === bot.entity || raw.type !== 'player' || (foes !== null && !foes.includes(raw.username)) || !raw.position || raw.position.distanceTo(me) > radius) continue
    const e = visiblePlayer(bot, raw, scope); if (!e) continue
    const it = (e.equipment || [])[0]
    if (!it || !SPLASH.test(it.name) || /^(heal|regen|buff)$/.test(potionRoleOf(bot, it) || '')) continue
    holders.push({ name: e.username, at: e.position, dist: Math.round(e.position.distanceTo(me) * 10) / 10 })
  }
  // Облако оседающего зелья (AreaEffectCloud, радиус — метаданные 8): стою в нём или у края — уйти.
  const clouds = []
  for (const e of Object.values(bot.entities) as any[]) {
    if (!e || e.name !== 'area_effect_cloud' || !e.position) continue
    if (!seesPlayer(bot, e)) continue
    const r = Number(e.metadata?.[8]) || 3
    if (Math.hypot(e.position.x - me.x, e.position.z - me.z) <= r + 1 && Math.abs(e.position.y - me.y) < 2.5) clouds.push({ at: e.position, r })
  }
  // Лава рядом (12.10: «лаву водой убирать заранее, а не когда упали»): клетка лавы в 2 бл. по горизонтали на уровне ног
  // (на клетку ниже — до клетки выше) — ближайшая.
  const lava = []
  const f0 = me.floored()
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) {
    const b = bot.blockAt(f0.offset(dx, dy, dz))
    if (b && b.name === 'lava' && seesPlayer(bot, { position: b.position.offset(.5, 0, .5), height: 1, width: 1 })) lava.push({ at: { x: b.position.x, y: b.position.y, z: b.position.z }, d: Math.hypot(dx, dz) })
  }
  lava.sort((a, b) => a.d - b.d)
  // Динамит: горящий и блоки, которые он подожжёт цепочкой (tactics/blast.tntCharges), в досягаемости взрыва с запасом.
  const B: typeof import('./tactics/blast') = require('./tactics/blast')
  const blasts = B.tntCharges(bot, me).filter(c => c.position.distanceTo(me) <= B.TNT_REACH + 2)
    .map(c => ({ at: { x: c.position.x, y: c.position.y, z: c.position.z }, fuse: c.fuse, primed: c.primed, ...(c.id != null ? { id: c.id } : {}) }))
  // Паутина на теле (клетка ног или головы): в ней шаг вчетверо медленнее — ни уйти, ни догнать (стенд бота-противника 22.10:
  // паутина на боте — 10 с на месте под ударами).
  const webs = (require('./hazards') as typeof import('./hazards')).webCells(bot)
  const web = webs.length ? [{ at: { x: webs[0].x, y: webs[0].y, z: webs[0].z }, cells: webs.length }] : []
  return { potions, holders, clouds, smashes: smashes(bot, foes || [], scope), arrows, aims: aims(bot, foes, scope), lava: lava.slice(0, 1), floor: floorDanger(bot), blasts, web }
}

module.exports = { incoming, dodgeKey, PROJECTILES, closestApproach, dangers, projectileDangers, incomingGliders, smashes, thrownTracker, projectileView, projectileVelocity: sample }
export { incoming, dodgeKey, PROJECTILES, closestApproach, dangers, projectileDangers, incomingGliders, smashes, thrownTracker, projectileView, sample as projectileVelocity }
