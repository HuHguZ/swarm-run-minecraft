'use strict'
// Езда (ride.ts): A* пути лошади и лодки, упрощение пути, коробки блоков и шаг физики лодки.
import { Vec3 } from 'vec3'
import AABB = require('prismarine-physics/lib/aabb')
import { BOAT, isWater, passable, standOn } from './base'


// ------------------------------------------------------------------ A*

export function astar (start, isGoal, neighbours, h, maxNodes = 30000) {
  const key = n => `${n.x},${n.y},${n.z}`
  const open = [{ n: start, g: 0, f: h(start) }]
  const came = new Map()
  const gBest = new Map([[key(start), 0]])
  let best = { n: start, h: h(start) }
  let seen = 0
  while (open.length && seen < maxNodes) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i
    const cur = open[bi]
    open[bi] = open[open.length - 1]; open.pop()
    const ck = key(cur.n)
    if (cur.g > (gBest.get(ck) ?? Infinity)) continue
    seen++
    if (isGoal(cur.n)) return { path: rebuild(came, cur.n, key), complete: true, seen }
    const hh = h(cur.n)
    if (hh < best.h) best = { n: cur.n, h: hh }
    for (const { n, cost } of neighbours(cur.n)) {
      const nk = key(n)
      const g = cur.g + cost
      if (g >= (gBest.get(nk) ?? Infinity)) continue
      gBest.set(nk, g)
      came.set(nk, cur.n)
      open.push({ n, g, f: g + h(n) })
    }
  }
  return { path: rebuild(came, best.n, key), complete: false, seen }
}

function rebuild (came, n, key) {
  const out = [n]
  let k = key(n)
  while (came.has(k)) { n = came.get(k); out.unshift(n); k = key(n) }
  return out
}

export const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

// Сухопутная сетка для лошади: стоять на блоке, две клетки воздуха над ним,
// шаг вверх на 1 без прыжка (step_height 1.0), на 2 — прыжком, если сил хватает,
// вниз до 3 (safe_fall_distance 6). Лошадь шире блока (1.4): в клетке у стены
// её коробка залезает в стену на 0.2 — центр сдвигается от стены на 0.25
// (shift sx, sz), а проход в один блок для неё закрыт вовсе, как в игре.
const SHIFTS = [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25], [0.25, 0.25], [0.25, -0.25], [-0.25, 0.25], [-0.25, -0.25]]
export function horseFit (bot, hw) {
  const solidC = new Map()
  const solid = (x, y, z) => {
    const k = `${x},${y},${z}`
    let v = solidC.get(k)
    if (v === undefined) { v = !passable(bot.blockAt(new Vec3(x, y, z))); solidC.set(k, v) }
    return v
  }
  // Коробка лошади с центром (cx, cz) на уровне y свободна: клетки y и y+1.
  const boxFree = (cx, y, cz) => {
    const x0 = Math.floor(cx - hw + 1e-3); const x1 = Math.floor(cx + hw - 1e-3)
    const z0 = Math.floor(cz - hw + 1e-3); const z1 = Math.floor(cz + hw - 1e-3)
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (solid(x, y, z) || solid(x, y + 1, z)) return false
    return true
  }
  const fitC = new Map()
  const fit = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (fitC.has(k)) return fitC.get(k)
    let r = null
    for (const [sx, sz] of SHIFTS) if (boxFree(x + 0.5 + sx, y, z + 0.5 + sz)) { r = { sx, sz }; break }
    fitC.set(k, r)
    return r
  }
  return { fit, boxFree, solid }
}

export function horsePlanner (bot, { canJump2, hw }: any) {
  const B = p => bot.blockAt(p)
  const { fit } = horseFit(bot, hw)
  const standable = (x, y, z) => standOn(B(new Vec3(x, y - 1, z))) ? fit(x, y, z) : null
  return function neighbours (n) {
    const out = []
    for (const [dx, dz] of DIRS8) {
      const x = n.x + dx; const z = n.z + dz
      let found = null
      for (const dy of [0, 1, -1, -2, -3, 2]) {
        if (dy === 2 && !canJump2) continue
        const y = n.y + dy
        const f = standable(x, y, z)
        if (!f) continue
        // Вверх: над исходной клеткой место на подъём; вниз: над целевой — на спуск.
        if (dy > 0 && !fit(n.x, n.y + dy, n.z)) continue
        if (dy < 0 && !fit(x, n.y, z)) continue
        if (dx && dz && !(fit(n.x + dx, Math.max(y, n.y), n.z) && fit(n.x, Math.max(y, n.y), n.z + dz))) continue
        found = { x, y, z, jump: dy === 2, sx: f.sx, sz: f.sz }
        break
      }
      if (!found) continue
      let cost = (dx && dz ? 1.414 : 1) + (found.y > n.y ? 0.4 : 0) + (found.jump ? 2 : 0)
      // Клетка, где коробку пришлось сдвигать, — у стены: дороже, держаться середины.
      if (found.sx || found.sz) cost += 0.8
      const under = B(new Vec3(found.x, found.y - 1, found.z))
      if (under && under.name === 'farmland') cost += 3
      out.push({ n: found, cost })
    }
    return out
  }
}

// Водная сетка для лодки: вода на уровне y, над ней воздух. Лодка шире блока:
// клетка у берега дороже, диагональ — только если обе боковые тоже вода.
export function boatPlanner (bot, y) {
  const water = (x, z) => { const b = bot.blockAt(new Vec3(x, y, z)); const a = bot.blockAt(new Vec3(x, y + 1, z)); return isWater(b) && !!a && a.boundingBox === 'empty' && !isWater(a) }
  return {
    water,
    neighbours (n) {
      const out = []
      for (const [dx, dz] of DIRS8) {
        const x = n.x + dx; const z = n.z + dz
        if (!water(x, z)) continue
        if (dx && dz && !(water(n.x + dx, n.z) && water(n.x, n.z + dz))) continue
        let cost = dx && dz ? 1.414 : 1
        const shore = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => !water(x + a, z + b)).length
        cost += shore * 0.7
        out.push({ n: { x, y, z }, cost })
      }
      return out
    }
  }
}

// Проредить путь: идти к дальней точке, до которой прямая чистая.
export function simplify (path, clearLine) {
  if (path.length <= 2) return path
  const out = [path[0]]
  let i = 0
  while (i < path.length - 1) {
    let j = path.length - 1
    while (j > i + 1 && !(clearLine(path[i], path[j]) && !path.slice(i + 1, j + 1).some(p => p.jump))) j--
    out.push(path[j])
    i = j
  }
  return out
}

// ------------------------------------------------------------------ коллизия лодки

function blockBoxes (bot, box) {
  const out = []
  const c = new Vec3(0, 0, 0)
  for (c.y = Math.floor(box.minY) - 1; c.y <= Math.floor(box.maxY); c.y++) {
    for (c.z = Math.floor(box.minZ); c.z <= Math.floor(box.maxZ); c.z++) {
      for (c.x = Math.floor(box.minX); c.x <= Math.floor(box.maxX); c.x++) {
        const b = bot.blockAt(c, false)
        if (!b) continue
        for (const s of b.shapes || []) out.push(new AABB(s[0], s[1], s[2], s[3], s[4], s[5]).offset(b.position.x, b.position.y, b.position.z))
      }
    }
  }
  return out
}

// Сдвинуть коробку лодки на (dx, dz) с упором в блоки, как Entity.move.
export function moveBoat (bot, pos, dx, dz) {
  const hw = BOAT.w / 2
  const box = new AABB(pos.x - hw, pos.y, pos.z - hw, pos.x + hw, pos.y + BOAT.h, pos.z + hw)
  const bbs = blockBoxes(bot, box.clone().extend(dx, 0, dz))
  let mx = dx; let mz = dz
  for (const bb of bbs) mx = bb.computeOffsetX(box, mx)
  box.offset(mx, 0, 0)
  for (const bb of bbs) mz = bb.computeOffsetZ(box, mz)
  box.offset(0, 0, mz)
  return { pos: new Vec3(box.minX + hw, pos.y, box.minZ + hw), hitX: mx !== dx, hitZ: mz !== dz }
}
