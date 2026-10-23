'use strict'
// Элитры (elytra.ts): физика полёта и падения, мир (твёрдость клеток), прогон полёта, потолок, досягаемость.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { G, HALF, BODY_H, ROCKET_BOOST, clamp }: typeof import('./consts') = require('./consts')

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
function worldOf (bot, { observed = false }: any = {}) {
  const cacheProperty = observed ? '_ndObservedSkyWorld' : '_ndSkyWorld'
  if (bot[cacheProperty]) return bot[cacheProperty]
  const source = observed ? (require('../pvp/search') as typeof import('../pvp/search')).observedCollision(bot) : bot
  const cells = new Map()
  const key = (x, y, z) => ((x + 30000) * 60001 + (z + 30000)) * 1024 + (y + 512)
  let clearedAt = gameClock.now()
  const at = (x, y, z) => {
    if (cells.size > 250000 || gameClock.now() - clearedAt > 20000) { cells.clear(); clearedAt = gameClock.now() }
    const k = key(x, y, z)
    let v = cells.get(k)
    if (v === undefined) {
      let b = null
      try { b = source.blockAt(new Vec3(x, y, z), false) } catch {}
      if (!b) v = 1
      else if (b.boundingBox === 'block') v = 1
      else if (b.name === 'lava') v = 2
      else if (b.name === 'water' || b.name === 'bubble_column') v = 3
      else v = 0
      // Unknown cells are rechecked as the observer moves; they are never remembered as observed walls.
      if (b || !observed) cells.set(k, v)
    }
    return v
  }
  bot.on('blockUpdate', (o, n) => {
    const b = n || o
    if (b && b.position) cells.delete(key(b.position.x, b.position.y, b.position.z))
  })
  const W = {
    at,
    airborneInertia: bot.physics?.airborneInertia ?? 0.91,
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
    // Check the complete standing footprint, including the support and non-solid hazards.
    // Same observed source as collisions; do not approve an unknown landing cell.
    landingSafe (p) {
      for (let X = Math.floor(p.x - HALF); X <= Math.floor(p.x + HALF - 1e-9); X++)
        for (let Y = Math.floor(p.y - 1e-6); Y <= Math.floor(p.y + BODY_H - 1e-9); Y++)
          for (let Z = Math.floor(p.z - HALF); Z <= Math.floor(p.z + HALF - 1e-9); Z++) {
            let b = null
            try { b = source.blockAt(new Vec3(X, Y, Z), false) } catch {}
            // Existing edges/mlg bad-floor list, plus fire and the wither flower.
            if (!b || /^(lava|water|bubble_column|fire|soul_fire|cactus|magma_block|campfire|soul_campfire|pointed_dripstone|sweet_berry_bush|powder_snow|wither_rose)$/.test(b.name)) return false
          }
      return true
    },
    // prismarine-physics: ground inertia = block slipperiness * airborneInertia.
    groundInertia (p) {
      let b = null
      try { b = source.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y - 1e-6), Math.floor(p.z)), false) } catch {}
      const air = bot.physics?.airborneInertia ?? 0.91
      if (!b) return air
      const slip = b.name === 'blue_ice' ? 0.989 : /^(ice|packed_ice|frosted_ice)$/.test(b.name) ? 0.98
        : /^(slime_block|slime)$/.test(b.name) ? 0.8 : bot.physics?.defaultSlipperiness ?? 0.6
      return slip * air
    },
    clear: () => cells.clear()
  }
  bot[cacheProperty] = W
  return W
}

// Прогон полёта: взгляд держим n тиков. boost — сколько тиков ещё тянет
// фейерверк. Событие — первое касание: 'floor' (сели), 'ceil', 'wall' с уроном
// о стену; fd — высота падения по правилам сервера на конце.
function rollout (W, p0, v0, yaw, pitch, boost, n, { fd = 0, keepPath = false, arena = null }: any = {}) {
  const p = { x: p0.x, y: p0.y, z: p0.z }
  const v = { x: v0.x, y: v0.y, z: v0.z }
  const path = keepPath ? [] : null
  let minFloorGap = Infinity
  const inside = q => !arena || (require('../combat/team-wind') as typeof import('../combat/team-wind')).windInside(q, arena, HALF)
  if (!inside(p)) return { t: 0, kind: 'outside', p, v, fd, path, minFloorGap }
  for (let t = 0; t < n; t++) {
    const px = p.x; const py = p.y; const pz = p.z
    // Высота падения: сервер держит ≤ 1, пока v.y > −0.5 (до хода этого тика).
    if (v.y > -0.5 && fd > 1) fd = 1
    glideStep(p, v, yaw, pitch, boost > t)
    if (p.y < py) fd += py - p.y
    // Ход тика — отрезком, а не концом (S7d, корень ударов о стену): под ракетой 1.6 б/т рамка 0.6 «перепрыгивает»
    // стену в 1 блок между концами соседних тиков (путь 176.3 → 174.7 мимо клетки 175) — прогноз не видел стекло
    // арены, и рулевой вёл прямо в него. Сервер и prismarine-physics двигают с упором (по осям) — тело упиралось.
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(p.x - px), Math.abs(p.y - py), Math.abs(p.z - pz)) / 0.45))
    for (let k = 1; k <= steps; k++) if (!inside({ x: px + (p.x - px) * k / steps, y: py + (p.y - py) * k / steps, z: pz + (p.z - pz) * k / steps })) return { t, kind: 'outside', p, v, fd, path, minFloorGap }
    let hitAt = 0
    for (let k = 1; k <= steps && !hitAt; k++) if (W.boxHit(px + (p.x - px) * k / steps, py + (p.y - py) * k / steps, pz + (p.z - pz) * k / steps)) hitAt = k
    if (hitAt) {
      const endX = p.x; const endZ = p.z
      if (hitAt < steps) { p.x = px + (p.x - px) * hitAt / steps; p.y = py + (p.y - py) * hitAt / steps; p.z = pz + (p.z - pz) * hitAt / steps }
      const vert = W.boxHit(px, p.y, pz)
      const hs = Math.hypot(v.x, v.z)
      if (vert && p.y < py) return { t, kind: 'floor', p, v, fd, vyHit: v.y, remainingMove: { x: endX - p.x, z: endZ - p.z }, path, minFloorGap: 0 }
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

// Потолок над точкой: сколько блоков воздуха над головой (до n).
function headroom (W, p, n = 30) {
  for (let i = 0; i < n; i++) if (W.boxHit(p.x, p.y + 0.2 + i, p.z)) return i
  return n
}

// Расстояние от глаз до рамки (ширина w, высота h) с ногами в pos.
function reachFromBox (eye, pos, w = 0.6, h = 1.8) {
  const hw = w / 2
  const cx = clamp(eye.x, pos.x - hw, pos.x + hw)
  const cy = clamp(eye.y, pos.y, pos.y + h)
  const cz = clamp(eye.z, pos.z - hw, pos.z + hw)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

export {
  lookVec, glideStep, fallStep, worldOf, rollout, headroom, reachFromBox
}
