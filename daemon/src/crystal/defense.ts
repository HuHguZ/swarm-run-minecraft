'use strict'
// Кристаллы (crystal.ts): защита — худший его кристалл по мне, урон в точке, клетка-укрытие, блок между,
// заслон своего якоря.

import { Vec3 } from './geometry'
import * as pick from '../pick'
import { P, EYE, HIT_R, PLACE_R, SIDES, ANCHOR_P, without, boxOf, intersects, crystalBox, boxDist, blockAt, copyCache, isAirB, solidB, baseFree, centerOf, feetCell } from './geometry'
import { countOf, kitOf } from './scoring'
import type { CrystalDeps, CrystalState } from './state'

function createDefense (S: CrystalState, deps: CrystalDeps) {
  const { bot, cellKey } = S
  const { gameClock, boom, trade } = deps
  // Худший для меня кристалл, который он может поставить прямо сейчас
  // (обсидиан/бедрок в 4.5 от его глаз, рядом со мной, столб свободен).
  function worstVsMe (foe, cache, dMe) {
    const now = gameClock.now()
    if (now - S.worstCache.at < 250) return S.worstCache.v
    const me = bot.entity.position
    const cell = feetCell(me)
    const hisEye = foe.position.offset(0, EYE, 0)
    const ents = (Object.values(bot.entities) as any[])
    let worst = 0
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -2; dy <= 0; dy++) {
          const base = new Vec3(cell.x + dx, cell.y + dy, cell.z + dz)
          if (!baseFree(bot, base, { cache, ents })) continue
          const c = centerOf(base)
          if (c.distanceTo(hisEye) > PLACE_R + 0.3) continue
          if (boxDist(hisEye, crystalBox(c)) > HIT_R + 0.6) continue
          const m = boom.blast(bot, c, P, me, { def: dMe, cache })
          if (m.dmg > worst) worst = m.dmg
        }
      }
    }
    S.worstCache = { at: now, v: worst }
    return worst
  }

  // ------------------------------------------------------------ уклонение (S7c)
  // Его кристалл у меня, он его достаёт. Варианты — щит лицом к кристаллу, клетка-укрытие, блок между —
  // считаются ожидаемым уроном: пока вариант не готов (тики), подрыв может прийти с прежней силой.
  // Подрыв — равномерно в ближайшие haz тиков (evade: 6, если он достаёт кристалл рукой или лук в руке, иначе 25).

  const passable = (b) => !!b && b.boundingBox === 'empty' && !/lava|fire|cobweb|water|powder_snow/.test(b.name)
  const standable = (cell, cache) => {
    const below = blockAt(bot, cache, cell.x, cell.y - 1, cell.z)
    return solidB(below) && below.name !== 'magma_block' && passable(blockAt(bot, cache, cell.x, cell.y, cell.z)) && passable(blockAt(bot, cache, cell.x, cell.y + 1, cell.z))
  }
  // Сколько мне от его кристаллов в точке pos: худший целиком, остальные — доля (окно после первого).
  function hurtAt (threats, pos, dMe, cache) {
    const d = threats.map(th => boom.blast(cache?.world || bot, th.c.position, th.power || P, pos, { def: dMe, cache: th.cell ? without(cache, th.cell) : cache }).dmg).sort((a, b) => b - a)
    return d.length ? d[0] + 0.3 * d.slice(1).reduce((s, x) => s + x, 0) : 0
  }
  // Прямой ход по ровному: каждая точка линии — клетка на высоте ног проходима, под ней опора.
  function lineClear (from, to, cache) {
    const n = Math.max(1, Math.ceil(from.distanceTo(to) / 0.25))
    for (let i = 1; i <= n; i++) {
      const p = from.plus(to.minus(from).scaled(i / n))
      const c = new Vec3(Math.floor(p.x), Math.floor(from.y + 1e-3), Math.floor(p.z))
      if (!standable(c, cache)) return false
    }
    return true
  }
  // haz — когда подрыв: равномерно в [lo, hi] тиков; клетка — по ожидаемому урону (не успел — пришло как стоя).
  function coverSpot (threats, dMe, cache, R = 3, haz = { lo: 0, hi: 6 }) {
    const me = bot.entity.position
    const here = hurtAt(threats, me, dMe, cache)
    const fc = feetCell(me)
    let best = null
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        for (const dy of [0, -1, 1]) {
          if (!dx && !dz) continue
          const h = Math.hypot(dx, dz)
          if (h > R + 0.2 || (dy !== 0 && h > 1.5)) continue
          const cell = new Vec3(fc.x + dx, fc.y + dy, fc.z + dz)
          if (!standable(cell, cache)) continue
          if (dy === 1 && !passable(blockAt(bot, cache, fc.x, fc.y + 2, fc.z))) continue
          if (dy === 0 && !lineClear(me, new Vec3(cell.x + 0.5, me.y, cell.z + 0.5), cache)) continue
          const pos = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5)
          const dmg = hurtAt(threats, pos, dMe, cache)
          const ticks = Math.ceil(Math.hypot(pos.x - me.x, pos.z - me.z) / 0.26) + (dy ? 3 : 1)
          const pr = Math.max(0, Math.min(1, (ticks - haz.lo) / Math.max(1, haz.hi - haz.lo)))
          const e = pr * here + (1 - pr) * dmg + ticks * 0.01
          if (!best || e < best.e) best = { pos, cell, dmg, ticks, e }
        }
      }
    }
    return best
  }
  // Чем ставить блок между: обсидиан, иначе булыжник, иначе светокамень сверх двух (заряд якоря).
  const wallItem = () => { const k = kitOf(bot); return k.obsidian > 0 ? 'obsidian' : countOf(bot, 'cobblestone') > 0 ? 'cobblestone' : k.glowstone > 2 ? 'glowstone' : null }
  const wallBlocks = () => { const k = kitOf(bot); return k.obsidian + countOf(bot, 'cobblestone') + Math.max(0, k.glowstone - 2) }
  // Блок обсидиана между мной и кристаллом (один или столбик из двух): лучи к телу упираются в него.
  // Ставится только честно (видимая грань опоры) и не в рамку сущности (кристалл 2×2×2 мешает стройке).
  function wallSpot (threats, dMe, cache) {
    if (wallBlocks() < 1) return null
    const me = bot.entity.position
    const eye = me.offset(0, EYE, 0)
    const fc = feetCell(me)
    const view = cache?.world || bot
    const boxes = (Object.values(view.entities) as any[]).filter((e : any) => e && e.position && e.isValid !== false &&
      (e.type === 'player' || e.name === 'end_crystal' || /mob|hostile|animal|passive/.test(e.type || ''))).map((e : any) => e.name === 'end_crystal' ? crystalBox(e.position) : boxOf(e))
    const key = (c) => `${c.x},${c.y},${c.z}`
    const faceOk = (cell) => {
      for (const n of [new Vec3(0, -1, 0), ...SIDES]) {
        const ref = cell.plus(n)
        if (!solidB(blockAt(bot, cache, ref.x, ref.y, ref.z))) continue
        if (pick.faceAim(view, ref, n.scaled(-1), { eye, range: PLACE_R - 0.05 })) return true
      }
      return false
    }
    const singles = []
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (!dx && !dz) continue
        const cell = new Vec3(fc.x + dx, fc.y, fc.z + dz)
        if (!isAirB(blockAt(bot, cache, cell.x, cell.y, cell.z))) continue
        if (!threats.some(th => (cell.x + 0.5 - me.x) * (th.c.position.x - me.x) + (cell.z + 0.5 - me.z) * (th.c.position.z - me.z) > 0)) continue
        const cb = { minX: cell.x, minY: cell.y, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 1, maxZ: cell.z + 1 }
        if (boxes.some(b => intersects(cb, b))) continue
        if (!faceOk(cell)) continue
        const sim = copyCache(cache)
        sim.set(key(cell), [[0, 0, 0, 1, 1, 1]])
        singles.push({ cells: [cell], dmg: hurtAt(threats, me, dMe, sim), ticks: 3, sim })
      }
    }
    singles.sort((a, b) => a.dmg - b.dmg)
    let best = singles[0] || null
    // Столбик: второй блок на первый (грань — его верх, глаза выше неё).
    for (const s of singles.slice(0, 4)) {
      const up = s.cells[0].offset(0, 1, 0)
      if (!isAirB(blockAt(bot, cache, up.x, up.y, up.z))) continue
      const ub = { minX: up.x, minY: up.y, minZ: up.z, maxX: up.x + 1, maxY: up.y + 1, maxZ: up.z + 1 }
      if (boxes.some(b => intersects(ub, b)) || up.offset(0.5, 1, 0.5).distanceTo(eye) > PLACE_R - 0.2 || eye.y <= up.y) continue
      if (wallBlocks() < 2) break
      const sim = copyCache(s.sim)
      sim.set(key(up), [[0, 0, 0, 1, 1, 1]])
      const dmg = hurtAt(threats, me, dMe, sim)
      if (!best || dmg + 0.15 < best.dmg) best = { cells: [s.cells[0], up], dmg, ticks: 6, sim }
    }
    return best
  }
  // Блок-заслон для своего якоря: клетка у моих ног (или у головы) в сторону якоря, честно ставится, не прячет
  // от глаз верх якоря (по нему клик заряда и подрыва). Возвращает лучший { cell, t } по размену.
  function guardFor (anchorCell, center, cache, living, { himAt, dHim, dMe, foe, himShield }: any) {
    const me = bot.entity.position
    const eye = me.offset(0, EYE, 0)
    const mc = feetCell(me)
    const top = anchorCell.offset(0.5, 1, 0.5)
    const toTop = top.minus(eye); const lenTop = toTop.norm(); const dirTop = toTop.scaled(1 / lenTop)
    let best = null
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const dy of [0, 1]) {
          if (!dx && !dz) continue
          const cell = new Vec3(mc.x + dx, mc.y + dy, mc.z + dz)
          if (cell.equals(anchorCell)) continue
          if ((cell.x + 0.5 - me.x) * (center.x - me.x) + (cell.z + 0.5 - me.z) * (center.z - me.z) <= 0) continue
          if (!isAirB(blockAt(bot, cache, cell.x, cell.y, cell.z))) continue
          const cb = { minX: cell.x, minY: cell.y, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 1, maxZ: cell.z + 1 }
          if (living.some(e => intersects(cb, boxOf(e)))) continue
          if (pick.rayBox(eye, dirTop, { x: cb.minX, y: cb.minY, z: cb.minZ }, { x: cb.maxX, y: cb.maxY, z: cb.maxZ }, lenTop) != null) continue
          let face = false
          for (const n of [new Vec3(0, -1, 0), ...SIDES]) {
            const ref = cell.plus(n)
            if (ref.equals(anchorCell) || !solidB(blockAt(bot, cache, ref.x, ref.y, ref.z))) continue
            if (pick.faceAim(bot, ref, n.scaled(-1), { eye, range: PLACE_R - 0.05 })) { face = true; break }
          }
          if (!face) continue
          const sim = new Map(cache)
          sim.set(cellKey(cell), [[0, 0, 0, 1, 1, 1]])
          const t = trade(bot, center, foe, bot.entity, dHim, dMe, without(sim, anchorCell), { himAt, power: ANCHOR_P, himShield })
          if (!best || t.him - 1.3 * t.me > best.t.him - 1.3 * best.t.me) best = { cell, t }
        }
      }
    }
    return best
  }
  return { worstVsMe, passable, standable, hurtAt, lineClear, coverSpot, wallItem, wallBlocks, wallSpot, guardFor }
}

export { createDefense }
