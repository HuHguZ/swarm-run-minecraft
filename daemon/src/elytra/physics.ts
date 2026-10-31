'use strict'
// Элитры (elytra.ts): физика полёта и падения, мир (твёрдость клеток), прогон полёта, потолок, досягаемость.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const teamWind: typeof import('../combat/team-wind') = require('../combat/team-wind')
const { G, HALF, BODY_H, FLY_H, ROCKET_BOOST, clamp }: typeof import('./consts') = require('./consts')

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
  // LivingEntity.aiStep 1.21.11 and the live integrator discard tiny vertical motion before flight forces.
  if (Math.abs(v.y) < 0.003) v.y = 0
  // shortcut: horizontal deadzones differ in the jar and client; align the client before changing them here.
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
  const key = (x, y, z) => ((x + 30000) * 60001 + (z + 30000)) * 1024 + (y + 512)
  // Сырые чтения — общие для всех лучей одного синхронного прохода (cl28g, 28.10: прогноз полёта — 68% остановок цикла событий,
  // девять лучей каждой клетки заново читали те же блоки); проход кончился (микрозадача) — мир читается заново.
  const raw = new Map()
  const blocks = observed ? (require('../fastblocks') as typeof import('../fastblocks')).install(bot) : null
  let rawArmed = false
  const rawAt = (p: import('vec3').Vec3) => {
    if (!rawArmed) { rawArmed = true; queueMicrotask(() => { raw.clear(); rawArmed = false }) }
    const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    if (raw.has(k)) return raw.get(k)
    const b = blocks ? blocks.block(p.x, p.y, p.z) : bot.blockAt(p, false)
    // Match FastBlocks' capacity: microtasks cannot release Blocks during a synchronous forecast.
    if (raw.size >= 120000) raw.clear()
    raw.set(k, b)
    return b
  }
  const source = observed ? (require('../pvp/search') as typeof import('../pvp/search')).observedCollision(bot, rawAt, true) : bot
  const cells = new Map()
  const shaped = new Map()
  const unknown = new Set<number>()
  let observedAt = -Infinity
  let clearedAt = gameClock.now()
  const read = (x, y, z, now) => {
    if (observedAt !== now) { unknown.clear(); observedAt = now }
    if (cells.size + unknown.size > 250000 || now - clearedAt > 20000) { cells.clear(); shaped.clear(); unknown.clear(); clearedAt = now }
    const k = key(x, y, z)
    let v = cells.get(k)
    if (v === undefined) {
      // observedCollision already keeps these negative observations for this tick; avoid repeating its Vec3/ray lookup.
      if (unknown.has(k)) return 1
      let b = null
      try { b = source.blockAt(new Vec3(x, y, z), false) } catch {}
      if (!b) { v = 1; if (observed) unknown.add(k) }
      else if (b.boundingBox === 'block') v = 1
      else if (b.name === 'lava') v = 2
      else if (b.name === 'water' || b.name === 'bubble_column') v = 3
      else v = 0
      // Unknown cells block flight, but never become remembered landing supports.
      if (b) {
        cells.set(k, v)
        const shapes = b.shapes || []
        // Partial blocks must not become phantom ceilings around a glider beside their shape.
        if (v === 1 && shapes.length && (shapes.length !== 1 || shapes[0].some((n, i) => n !== (i < 3 ? 0 : 1)))) shaped.set(k, shapes)
      }
    }
    return v
  }
  const at = (x, y, z) => read(x, y, z, gameClock.now())
  bot.on('blockUpdate', (o, n) => {
    const b = n || o
    if (b && b.position) {
      const k = key(b.position.x, b.position.y, b.position.z)
      cells.delete(k); shaped.delete(k); unknown.delete(k)
    }
  })
  // Partial blocks occupy only their shape, including fences/walls above their cell.
  const intersects = (shapes, X, Y, Z, x, y, z, h) => shapes.some(s =>
    x + HALF > X + s[0] && x - HALF < X + s[3] && y + h > Y + s[1] && y < Y + s[4] && z + HALF > Z + s[2] && z - HALF < Z + s[5])
  const W = {
    at,
    airborneInertia: bot.physics?.airborneInertia ?? 0.91,
    solid: (x, y, z) => at(x, y, z) === 1,
    // Рамка (полуширина HALF, высота h) в точке задевает твёрдое или жидкость.
    boxHit (x, y, z, h = BODY_H) {
      // One synchronous box query shares a clock stamp, not a new clock lookup per cell.
      const now = gameClock.now()
      const x0 = Math.floor(x - HALF); const x1 = Math.floor(x + HALF - 1e-9)
      const y0 = Math.floor(y); const y1 = Math.floor(y + h - 1e-9)
      const z0 = Math.floor(z - HALF); const z1 = Math.floor(z + HALF - 1e-9)
      for (let X = x0; X <= x1; X++) for (let Y = y0; Y <= y1; Y++) for (let Z = z0; Z <= z1; Z++) if (read(X, Y, Z, now) !== 0) {
        const tall = shaped.get(key(X, Y, Z))
        if (!tall || intersects(tall, X, Y, Z, x, y, z, h)) return true
      }
      // 1.21.11 fences/walls extend up to half a block above the cell beneath our feet.
      if (y - y0 < .5) for (let X = x0; X <= x1; X++) for (let Z = z0; Z <= z1; Z++) {
        read(X, y0 - 1, Z, now)
        const tall = shaped.get(key(X, y0 - 1, Z))
        if (tall && intersects(tall, X, y0 - 1, Z, x, y, z, h)) return true
      }
      return false
    },
    // Верх опоры под точкой (колонка под центром), не глубже depth; null — пустота.
    floorBelow (x, y, z, depth = 40) {
      const now = gameClock.now()
      const X = Math.floor(x); const Z = Math.floor(z)
      for (let Y = Math.floor(y); Y >= Math.floor(y) - depth; Y--) {
        const v = read(X, Y, Z, now)
        if (v === 1) {
          const k = key(X, Y, Z)
          if (!cells.has(k)) return null
          const tall = shaped.get(k)
          if (!tall) return { top: Y + 1 }
          const supports = tall.filter(s => x >= X + s[0] && x <= X + s[3] && z >= Z + s[2] && z <= Z + s[5])
          if (supports.length) return { top: Y + Math.max(...supports.map(s => s[4])) }
        }
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
    clear: () => { cells.clear(); shaped.clear(); unknown.clear() }
  }
  bot[cacheProperty] = W
  return W
}

// Прогон полёта: взгляд держим n тиков. boost — сколько тиков ещё тянет
// фейерверк. Событие — первое касание: 'floor' (сели), 'ceil', 'wall' с уроном
// о стену; fd — высота падения по правилам сервера на конце.
function rollout (W, p0, v0, yaw, pitch, boost, n, { fd = 0, keepPath = false, arena = null, movementFall = false, floorDepth = 12 }: any = {}) {
  const p = { x: p0.x, y: p0.y, z: p0.z }
  const v = { x: v0.x, y: v0.y, z: v0.z }
  const path = keepPath ? [] : null
  let minFloorGap = Infinity
  let firstCeiling = null
  const inside = q => !arena || teamWind.windInside(q, arena, HALF)
  if (!inside(p)) return { t: 0, kind: 'outside', p, v, fd, path, minFloorGap }
  for (let t = 0; t < n; t++) {
    const px = p.x; const py = p.y; const pz = p.z; const previousFd = fd
    // Высота падения: сервер держит ≤ 1, пока v.y > −0.5 (до хода этого тика).
    if (!movementFall && v.y > -0.5 && fd > 1) fd = 1
    glideStep(p, v, yaw, pitch, boost > t)
    // Player movement packets clear fallDistance on an accepted rise, not on the client's shallow velocity.
    if (movementFall && p.y > py) fd = 0
    else if (p.y < py) fd += py - p.y
    // Entity.collideWithShapes / Direction.axisStepOrder 1.21.11: the diagonal can clear a corner hit by the axis path.
    const endX = p.x, endY = p.y, endZ = p.z
    p.x = px; p.y = py; p.z = pz
    let ceiling = false
    for (const axis of Math.abs(v.x) < Math.abs(v.z) ? 'yzx' : 'yxz') {
      const start = p[axis], end = axis === 'x' ? endX : axis === 'y' ? endY : endZ, delta = end - start
      if (!delta) continue
      const steps = Math.max(1, Math.ceil(Math.abs(delta) / .45))
      for (let k = 1; k <= steps; k++) {
        p[axis] = start + delta * k / steps
        if (!inside(p)) return { t, kind: 'outside', p, v, fd, path, minFloorGap }
        if (!W.boxHit(p.x, p.y, p.z, FLY_H)) continue
        if (axis === 'y' && delta < 0) return { t, kind: 'floor', p, v, fd, vyHit: v.y, remainingMove: { x: endX - p.x, z: endZ - p.z }, path, minFloorGap: 0 }
        if (axis === 'y') {
          // worldOf uses full cells: clip the head below their bottom, then finish X/Z as Entity.move does.
          p.y = Math.max(py, Math.floor(p.y + FLY_H - 1e-9) - FLY_H)
          if (W.boxHit(p.x, p.y, p.z, FLY_H)) return { t, kind: 'ceil', p, v, fd, path, minFloorGap }
          if (movementFall && p.y === py) fd = previousFd
          v.y = 0; ceiling = true
          break
        }
        return { t, kind: 'wall', p, v, fd, dmg: Math.max(0, Math.hypot(v.x, v.z) * 10 - 3), path, minFloorGap }
      }
      if (axis !== 'y' || !ceiling) p[axis] = end
    }
    // A ceiling leaves horizontal momentum alive: look for later impacts before pricing this first contact.
    if (ceiling && !firstCeiling) firstCeiling = { t, kind: 'ceil', p: { ...p }, v: { ...v }, fd, path: path?.slice() ?? null, minFloorGap }
    if (keepPath) path.push({ x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, fd })
    if ((t & 3) === 3) {
      const f = W.floorBelow(p.x, p.y, p.z, floorDepth)
      const gap = f ? p.y - f.top : 12
      if (gap < minFloorGap) minFloorGap = gap
    }
  }
  return firstCeiling || { t: n, kind: null, p, v, fd, path, minFloorGap }
}

// Потолок над точкой: сколько блоков воздуха над головой (до n).
function headroom (W, p, n = 30) {
  // Ноги внутри твёрдой клетки — стоит на нижней плите (модель считает её целым блоком): от верха клетки, иначе с гребня
  // Колизея (весь в плитах) потолок всегда 0 и взлёт не начинался (стенд 25.10: «над головой блок»).
  const y = W.solid?.(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) && p.y - Math.floor(p.y) > .01 ? Math.floor(p.y) + 1 - 0.2 : p.y
  for (let i = 0; i < n; i++) if (W.boxHit(p.x, y + 0.2 + i, p.z)) return i
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
