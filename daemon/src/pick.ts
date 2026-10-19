'use strict'
// Честный удар (2026-09-26, пользователь: «боты через один блок пробивают…
// крепость бессмысленна, он всё равно её пробивает»). Сервер удар по сущности
// на прямую видимость не проверяет: ServerGamePacketListenerImpl.handleInteract
// смотрит только расстояние от глаз до рамки цели (entityInteractionRange 3.0
// плюс 3.0 запаса на задержку). Бот слал attack по одной дистанции — и бил
// сквозь стенку коробки и сквозь крышу, чего клиент игры не может.
//
// Клиент бьёт то, что под прицелом (GameRenderer.pick 1.21.11): луч из глаз
// до первого блока по КОНТУРУ (ClipContext.Block.OUTLINE, жидкости мимо —
// Fluid.NONE), сущность засчитывается, только если луч входит в её рамку
// раньше этого блока и не дальше 3.0. Контур паутины — полный куб (коллизии у
// неё нет, а прицел в неё упирается); глаза внутри контура (голова в паутине)
// — прицел на ней с первого же шага (VoxelShape.clip: старт внутри формы).
// Здесь то же самое: ищем точку его рамки, до которой луч свободен.
const { Vec3 }: typeof import('vec3') = require('vec3')

const RANGE = 3.0
const PICK_RADIUS = { fireball: 1.0, wind_charge: 1.0, breeze_wind_charge: 1.0 }
// Нет коллизии, но контур есть и прицел в него упирается.
const OUTLINE_FULL = new Set(['cobweb'])
const FULL = [[0, 0, 0, 1, 1, 1]]

function shapesOf (b) {
  if (!b) return null
  if (OUTLINE_FULL.has(b.name)) return FULL
  const p = b.getProperties?.() || {}
  if (b.name === 'stone_pressure_plate') return [[1 / 16, 0, 1 / 16, 15 / 16, p.powered ? 1 / 32 : 1 / 16, 15 / 16]]
  if (b.name === 'tripwire') return [[0, p.attached ? 1 / 16 : 0, 0, 1, p.attached ? 2.5 / 16 : 8 / 16, 1]]
  if (b.name === 'tripwire_hook') return [{
    north: [5 / 16, 0, 10 / 16, 11 / 16, 10 / 16, 1], south: [5 / 16, 0, 0, 11 / 16, 10 / 16, 6 / 16],
    east: [0, 0, 5 / 16, 6 / 16, 10 / 16, 11 / 16], west: [10 / 16, 0, 5 / 16, 1, 10 / 16, 11 / 16]
  }[p.facing]]
  if (b.boundingBox !== 'block') return null
  return b.shapes && b.shapes.length ? b.shapes : null
}

// Вход луча o + t·d в коробку [lo, hi]: t входа (0, если начало внутри) или null.
function rayBox (o, d, lo, hi, tMax) {
  let t0 = 0; let t1 = tMax
  for (const a of ['x', 'y', 'z']) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return null
      continue
    }
    let ta = (lo[a] - o[a]) / d[a]
    let tb = (hi[a] - o[a]) / d[a]
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return null
  }
  return t0
}

// Первый блок на луче до tMax, в чей контур луч входит (DDA по клеткам). Глаза
// внутри контура — блок на t = 0. skip — имена, сквозь которые луч идёт (для зрения: стекло, барьер).
function blockOnRay (bot, o, d, tMax, skip = null) {
  let x = Math.floor(o.x); let y = Math.floor(o.y); let z = Math.floor(o.z)
  const sx = d.x > 0 ? 1 : -1; const sy = d.y > 0 ? 1 : -1; const sz = d.z > 0 ? 1 : -1
  const next = (c, s, dc, oc) => Math.abs(dc) < 1e-12 ? Infinity : ((s > 0 ? c + 1 : c) - oc) / dc
  let tx = next(x, sx, d.x, o.x); let ty = next(y, sy, d.y, o.y); let tz = next(z, sz, d.z, o.z)
  const dx = Math.abs(d.x) < 1e-12 ? Infinity : Math.abs(1 / d.x)
  const dy = Math.abs(d.y) < 1e-12 ? Infinity : Math.abs(1 / d.y)
  const dz = Math.abs(d.z) < 1e-12 ? Infinity : Math.abs(1 / d.z)
  const steps = Math.max(16, Math.ceil(tMax) * 3 + 3)
  for (let i = 0; i < steps; i++) {
    let b = null
    try { b = bot.blockAt(new Vec3(x, y, z), false) } catch {}
    const sh = skip && b && skip.test(b.name) ? null : shapesOf(b)
    if (sh) {
      for (const s of sh) {
        const t = rayBox(o, d, { x: x + s[0], y: y + s[1], z: z + s[2] }, { x: x + s[3], y: y + s[4], z: z + s[5] }, tMax)
        if (t != null) return { t, block: b, pos: new Vec3(x, y, z) }
      }
    }
    const tNext = Math.min(tx, ty, tz)
    if (tNext > tMax) return null
    if (tx <= ty && tx <= tz) { x += sx; tx += dx } else if (ty <= tz) { y += sy; ty += dy } else { z += sz; tz += dz }
  }
  return null
}

// Рамка сущности с учётом позы: присел — 1.5, плывёт/летит на элитрах — 0.6.
function poseOf (bot, entity) {
  const keys = bot.registry?.entitiesByName?.player?.metadataKeys
  const poseIndex = keys ? keys.indexOf('pose') : 6
  const flagsIndex = keys ? keys.indexOf('shared_flags') : 0
  if (entity.elytraFlying || (entity.metadata?.[flagsIndex >= 0 ? flagsIndex : 0] & 0x80)) return 'fall_flying'
  return entity.metadata?.[poseIndex >= 0 ? poseIndex : 6] ?? null
}

// Avatar.POSES in Minecraft 1.21.11 supplies pose-specific eye heights.
function eyeHeight (bot, entity = bot.entity) {
  const pose = poseOf(bot, entity)
  if (entity === bot.entity && process.env.ND_WATER_ESCAPE_BUDGET !== '0' && entity._ndPoseHeight != null && ![1, 4, 'fall_flying', 'spin_attack'].includes(pose)) {
    return entity._ndPoseHeight === .6 ? .4 : entity._ndPoseHeight === 1.5 ? 1.27 : 1.62
  }
  if (pose === 1 || pose === 3 || pose === 4 || pose === 'fall_flying' || pose === 'swimming' || pose === 'spin_attack') return 0.4
  if (pose === 5 || pose === 'crouching' || entity.height === 1.5 || (entity === bot.entity && bot.getControlState?.('sneak'))) return 1.27
  return 1.62
}

function hitboxOf (bot, e) {
  let h = e.height || 1.8
  const w = e.width || 0.6
  if (e.type === 'player' || e.name === 'player') {
    try {
      const pose = poseOf(bot, e)
      if (pose === 5 || pose === 'crouching') h = 1.5
      else if (pose === 1 || pose === 3 || pose === 4 || pose === 'fall_flying' || pose === 'swimming' || pose === 'spin_attack') h = 0.6
    } catch {}
  }
  const p = e.position
  return { lo: { x: p.x - w / 2, y: p.y, z: p.z - w / 2 }, hi: { x: p.x + w / 2, y: p.y + h, z: p.z + w / 2 }, w, h }
}

// Точки прицела: грудь, голова, дальше сетка по рамке — первая свободная.
const FRACS = []
for (const fy of [0.6, 0.88, 0.35, 0.97, 0.12]) {
  for (const [fx, fz] of [[0.5, 0.5], [0.12, 0.5], [0.88, 0.5], [0.5, 0.12], [0.5, 0.88], [0.12, 0.12], [0.88, 0.88], [0.12, 0.88], [0.88, 0.12]]) FRACS.push([fx, fy, fz])
}

function eyeOf (bot) {
  return bot.entity.position.offset(0, eyeHeight(bot), 0)
}

// Куда целиться, чтобы удар по нему был честным: { point, dist, off } —
// точка на его рамке (off — от его позиции), или null — отовсюду блок.
// blocked — чем закрыт прямой луч к груди (блок и клетка), для «сломать».
function aim (bot, e, { eye = null, range = RANGE }: any = {}) {
  if (!bot.entity || !e || !e.position) return null
  const o = eye || eyeOf(bot)
  const box = hitboxOf(bot, e)
  // Снаряд с тегом redirectable_projectile (шар гаста, заряды ветра) прицел берёт по раздутой рамке: Projectile.getPickRadius = 1.0
  // при isPickable (1.21.11; GameRenderer.pick → ProjectileUtil.getEntityHitResult, рамка inflate(pickRadius)).
  const g = PICK_RADIUS[e.name] || 0
  if (g) Object.assign(box, { lo: { x: box.lo.x - g, y: box.lo.y - g, z: box.lo.z - g }, hi: { x: box.hi.x + g, y: box.hi.y + g, z: box.hi.z + g }, w: box.w + 2 * g, h: box.h + 2 * g })
  let first = null
  for (const [fx, fy, fz] of FRACS) {
    const tp = new Vec3(box.lo.x + box.w * fx, box.lo.y + box.h * fy, box.lo.z + box.w * fz)
    const delta = tp.minus(o)
    const len = delta.norm()
    if (len < 1e-6) { if (e._ndVisible !== false) return { point: tp, dist: 0, off: tp.minus(e.position) }; continue }
    const d = delta.scaled(1 / len)
    const tE = rayBox(o, d, box.lo, box.hi, range + 0.001)
    if (tE == null || tE > range) continue
    const hit = blockOnRay(bot, o, d, tE)
    if (!hit && e._ndVisible !== false) return { point: tp, dist: tE, off: tp.minus(e.position) }
    if (!first) first = hit
  }
  return first ? { blocked: first } : null
}

// Видна ли грань блока refPos со стороны face (Vec3 нормали) — можно ли в неё
// «кликнуть», как клиент: луч из глаз до точки грани не упирается ни в другой
// блок (контур), ни в рамку живой сущности (прицел взял бы её, а не блок —
// GameRenderer.pick), и грань не дальше blockInteractionRange 4.5. Возвращает
// точку на грани или null. avoid — сущности, чьи рамки мешают (по умолчанию все
// живые в 6 блоках, кроме нас).
const LIVING = /^(player|zombie|husk|drowned|skeleton|stray|creeper|spider|cave_spider|enderman|witch|pillager|vindicator|evoker|ravager|blaze|piglin|piglin_brute|zombified_piglin|hoglin|zoglin|wither_skeleton|slime|magma_cube|iron_golem|villager|cow|pig|sheep|chicken|horse|wolf)$/
function faceAim (bot, refPos, face, { eye = null, range = 4.5, avoid = null }: any = {}) {
  if (!bot.entity) return null
  const o = eye || eyeOf(bot)
  const others = avoid || (Object.values(bot.entities || {}) as any[]).filter((e : any) => e && e !== bot.entity && e.position && LIVING.test(e.name || e.type || '') && e.position.distanceTo(o) < 6)
  const axis = face.x ? 'x' : face.y ? 'y' : 'z'
  const us = axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['x', 'z'] : ['x', 'y']
  const i = 'xyz'.indexOf(axis), u = 'xyz'.indexOf(us[0]), v = 'xyz'.indexOf(us[1])
  // Грань — по контуру блока, а не куба: верх нижней плиты — y+0.5 (Codex 15.10: ямы на крыше-террасе «occluded» — прицел
  // искал плоскость y+1, где плиты нет).
  for (const box of shapesOf(bot.blockAt(refPos)) || FULL) for (const [a, b] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8], [0.5, 0.15], [0.5, 0.85], [0.15, 0.5], [0.85, 0.5]]) {
    const p = { x: 0, y: 0, z: 0 }
    p[axis] = refPos[axis] + box[i + (face[axis] > 0 ? 3 : 0)]
    p[us[0]] = refPos[us[0]] + box[u] + (box[u + 3] - box[u]) * a
    p[us[1]] = refPos[us[1]] + box[v] + (box[v + 3] - box[v]) * b
    const P = new Vec3(p.x, p.y, p.z)
    const delta = P.minus(o)
    const len = delta.norm()
    if (len > range || len < 1e-4) continue
    // С лица, а не с изнанки: луч идёт против нормали грани.
    if (delta.x * face.x + delta.y * face.y + delta.z * face.z >= 0) continue
    const d = delta.scaled(1 / len)
    const hit = blockOnRay(bot, o, d, len + 0.01)
    if (!hit || !hit.pos.equals(refPos) || hit.t < len - 0.02) continue
    let blocked = false
    for (const e of others) {
      const box = hitboxOf(bot, e)
      const t = rayBox(o, d, box.lo, box.hi, len)
      if (t != null && t < len - 0.01) { blocked = true; break }
    }
    if (!blocked) return P
  }
  return null
}

// Видно ли блок pos глазами (s7b 06.10, замечание проверки: raySees с допуском 1.2 бл. «видел» сундук за облицовкой).
// Как прицел клиента: луч из глаз до точки на обращённой к глазам грани контура блока первым входит в контур
// САМОГО блока. Сквозь стекло и барьер видно; жидкости лучу не мешают (контура нет). Сетка 5 точек на грань.
const SEE_THROUGH = /glass|_pane$|^barrier$|^iron_bars$/
const FACE_FRACS = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]
function blockAim (bot, pos, { eye = null, range = 64, seeThrough = SEE_THROUGH }: any = {}) {
  if (!bot.entity) return false
  const o = eye || eyeOf(bot)
  let b = null
  try { b = bot.blockAt(pos, false) } catch {}
  for (const s of shapesOf(b) || FULL) {
    const lo = { x: pos.x + s[0], y: pos.y + s[1], z: pos.z + s[2] }
    const hi = { x: pos.x + s[3], y: pos.y + s[4], z: pos.z + s[5] }
    for (const a of ['x', 'y', 'z']) {
      // Грань, к которой глаза снаружи: со стороны lo или hi по оси a.
      const plane = o[a] < lo[a] ? lo[a] : o[a] > hi[a] ? hi[a] : null
      if (plane === null) continue
      const [u, v] = a === 'x' ? ['y', 'z'] : a === 'y' ? ['x', 'z'] : ['x', 'y']
      for (const [fu, fv] of FACE_FRACS) {
        const p = { x: 0, y: 0, z: 0 }
        p[a] = plane
        p[u] = lo[u] + (hi[u] - lo[u]) * fu
        p[v] = lo[v] + (hi[v] - lo[v]) * fv
        const delta = new Vec3(p.x - o.x, p.y - o.y, p.z - o.z)
        const len = delta.norm()
        if (len > range) continue
        if (len < 1e-6) return new Vec3(p.x, p.y, p.z)
        const dir = delta.scaled(1 / len)
        const hit = blockOnRay(bot, o, dir, len + 0.01, seeThrough)
        if (hit && hit.pos.equals(pos)) {
          const blocked = seeThrough === null && (Object.values(bot.entities || {}) as any[]).some(e => {
            if (!e || e === bot.entity || !e.position || !LIVING.test(e.name || e.type || '')) return false
            const box = hitboxOf(bot, e); const t = rayBox(o, dir, box.lo, box.hi, len)
            return t != null && t < hit.t - 0.01
          })
          if (!blocked) return new Vec3(p.x, p.y, p.z)
        }
      }
    }
  }
  return false
}

function blockSeen (bot, pos, opts: any = {}) { return !!blockAim(bot, pos, opts) }

// Честно ли бить прямо сейчас (для сторожа attack и сцен).
function canHit (bot, e, opts: any = {}) {
  const a = aim(bot, e, opts)
  return !!(a && a.point)
}

// Сторож: удар по сущности, которую клиент игры не взял бы в прицел, не
// уходит (как guardCrossbow в ranged.js). Всё, что не сущность с позицией
// (части дракона, фаерболы без рамки), — как было.
function install (bot) {
  if (!bot || bot._ndPickGuard || typeof bot.attack !== 'function') return
  bot._ndPickGuard = true
  const raw = bot.attack
  bot._ndBlockedHits = 0
  bot.attack = function (target, swing) {
    try {
      if (process.env.ND_PICK_GUARD !== '0' && target && target.position && typeof target.id === 'number' && target.width != null && bot.entity) {
        const a = aim(bot, target)
        if (!a || !a.point) {
          bot._ndBlockedHits++
          if (process.env.ND_DEBUG_PICK) console.log('[pick] удар не отправлен — не в прицеле:', target.username || target.name, a && a.blocked ? `${a.blocked.block && a.blocked.block.name} ${a.blocked.pos}` : 'дальше 3')
          return
        }
      }
    } catch {}
    return raw.call(bot, target, swing)
  }
}

module.exports = { aim, canHit, faceAim, blockSeen, blockAim, install, hitboxOf, blockOnRay, rayBox, eyeOf, eyeHeight, poseOf, RANGE, PICK_RADIUS }
export {
  aim, canHit, faceAim, blockSeen, blockAim, install, hitboxOf, blockOnRay, rayBox, eyeOf, eyeHeight, poseOf,
  RANGE, PICK_RADIUS
}
