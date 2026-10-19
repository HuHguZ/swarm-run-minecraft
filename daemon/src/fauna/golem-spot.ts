'use strict'
// Голем: место над ним — столб, досягаемость удара, опора у столба, высота и клетка насеста.
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// ------------------------------------------------------------------- голем

// Место перед собой: ровный пол 3 в ширину и 3 свободных в высоту.
export function golemSpot (bot, kind) {
  const f = bot.entity.position.floored()
  const yaw = bot.entity.yaw
  const fx = Math.round(-Math.sin(yaw))
  const fz = Math.round(-Math.cos(yaw))
  const dirs = [[fx, fz], [1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [dx, dz] of dirs) {
    if (dx === 0 && dz === 0) continue
    const base = f.offset(dx * 2, 0, dz * 2)
    // Руки голема — поперёк направления на нас.
    const sx = dz
    const sz = -dx
    const cells = kind === 'iron'
      ? [base, base.offset(0, 1, 0), base.offset(sx, 1, sz), base.offset(-sx, 1, -sz), base.offset(0, 2, 0),
          base.offset(sx, 0, sz), base.offset(-sx, 0, -sz), base.offset(sx, 2, sz), base.offset(-sx, 2, -sz)]
      : [base, base.offset(0, 1, 0), base.offset(0, 2, 0)]
    const free = cells.every(c => { const b = bot.blockAt(c); return b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) })
    const floor = bot.blockAt(base.offset(0, -1, 0))
    if (free && floor && floor.boundingBox === 'block') return { base, side: new Vec3(sx, 0, sz) }
  }
  return null
}

// ------------------------------------------------------------------- голем на железо (поток route, 03.10.2026)
// Железный голем деревни — 3–5 слитков всегда (loot_table entities/iron_golem.json, 1.21.11): ведро без шахты. Как
// спидраннеры — со столба. Голем бьёт, только если его коробка атаки пересекает хитбокс цели (Mob.isWithinMeleeAttackRange
// → getAttackBoundingBox: своя коробка, раздутая ТОЛЬКО по горизонтали на √2.04 − 0.6 ≈ 0.83; байткод Mob 1.21.11,
// codex-lab/early-nether-evidence/Mob.javap.txt). Голем 1.4 × 2.7: ноги игрока на 3 блока выше пола голема — вне его
// коробки (2.7 < 3), а удар игрока (3.0 от глаз, +4.62) до макушки голема (+2.7) достаёт при горизонтали ≤ 2.3.
// Пол вокруг столба — ровный: шаг голема (step 1.0) на бугор поднял бы его коробку на блок. Бьём топором (без взмаха
// по соседям — меч на земле задевает жителя рядом, а у жителей память на удары) или мечом.
export const GOLEM_PILLAR = 3
export function golemReach (bot, g) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const hw = (g.width || 1.4) / 2
  const h = g.height || 2.7
  const p = g.position
  const cx = Math.max(p.x - hw, Math.min(eye.x, p.x + hw))
  const cy = Math.max(p.y, Math.min(eye.y, p.y + h))
  const cz = Math.max(p.z - hw, Math.min(eye.z, p.z + hw))
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}
// Столб можно ставить здесь: под ногами твёрдое, вокруг (±2) пол не выше ног (иначе голем шагнёт на бугор), над
// головой на 4 — пусто.
export function pillarSpotOk (bot, feet) {
  for (let dy = 0; dy <= GOLEM_PILLAR + 1; dy++) {
    const b = bot.blockAt(feet.offset(0, dy + 1, 0))
    if (b && b.boundingBox === 'block') return false
  }
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (!dx && !dz) continue
      for (let dy = 0; dy <= 2; dy++) {
        const b = bot.blockAt(feet.offset(dx, dy, dz))
        if (b && b.boundingBox === 'block') return false
      }
    }
  }
  return true
}
// Самые высокие ноги голема у столба: клетки в 3 бл. вокруг (кроме самого столба), где под ногами твёрдое, а выше 3
// клетки свободны (голем 2.7 в высоту), на высоте пола столба −2…+4.
// Коробка атаки: половина ширины голема 0.7 + расширение 0.828 + половина игрока 0.3.
// На краю третьей клетки голем ещё может опираться ногами и доставать по обеим осям.
export function golemTopNear (bot, base, golem?: any) {
  let top = base.y
  // The golem can still stand on the edge of the third cell: half-width .7
  // plus native melee inflation .828 plus player half-width .3 reaches 1.828
  // from our center; its feet then overlap that cell by up to .028 blocks.
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (!dx && !dz) continue
      for (let y = base.y + 4; y >= base.y - 2; y--) {
        const p = base.offset(dx, y - base.y, dz)
        const fl = bot.blockAt(p.offset(0, -1, 0))
        if (!fl || fl.boundingBox !== 'block') continue
        let free = true
        for (let k = 0; k < 3; k++) { const b = bot.blockAt(p.offset(0, k, 0)); if (b && b.boundingBox === 'block') { free = false; break } }
        if (free) { top = Math.max(top, y); break }
      }
    }
  }
  if (!golem || top <= base.y + 1) return top
  // A roof over a four-block wall is not a walking threat. Reuse the mob's
  // bounded step search with our future supported column; retain real stairs.
  const { reachOf }: typeof import('../reach') = require('../reach')
  const future = Object.create(bot)
  future.entity = { ...bot.entity }
  const walking = { ...golem, name: 'iron_golem', width: golem.width || 1.4, height: golem.height || 2.7 }
  const fringe = (golem.width || 1.4) / 2 + .5
  for (let h = GOLEM_PILLAR; h <= 6 && h <= top - base.y + GOLEM_PILLAR; h++) {
    const center = base.offset(.5, h, .5), cache = new Map()
    future.blockAt = p => p.x === base.x && p.z === base.z && p.y >= base.y && p.y < base.y + h
      ? { name: 'cobblestone', boundingBox: 'block' } : bot.blockAt(p)
    let reaches = false
    // The search uses cell centers. A wide golem's feet can rest on the
    // neighbouring cell's edge: half its width plus half a cell of slack.
    for (const dx of [-fringe, 0, fringe]) {
      for (const dz of [-fringe, 0, fringe]) {
        future.entity.position = center.offset(dx, 0, dz)
        if (reachOf(future, walking, { cache }).reaches) { reaches = true; break }
      }
      if (reaches) break
    }
    if (!reaches) return base.y + h - GOLEM_PILLAR
  }
  return top
}
// Клетка для столба у голема: ровно вокруг (golemTopNear не выше пола), пол твёрдый, ноги и 5 над ними свободны, пол не
// ниже ног голема, до голема по горизонтали 1.8–2.8 (сверху удар достаёт: глаза +4.62, макушка +2.7).
export function golemSpotNear (bot, g) {
  const gp = g.position
  const gy = Math.floor(gp.y + 0.01)
  const me = bot.entity.position
  let best = null
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const c = new Vec3(Math.floor(gp.x) + dx, gy + dy, Math.floor(gp.z) + dz)
        const h = Math.hypot(c.x + 0.5 - gp.x, c.z + 0.5 - gp.z)
        if (h < 1.6 || h > 3.6) continue
        const fl = bot.blockAt(c.offset(0, -1, 0))
        if (!fl || fl.boundingBox !== 'block' || /water|lava/.test(fl.name)) continue
        // Пол столба — полный куб: тропа деревни (15/16), плита, грядка ниже соседнего дёрна — голем на дёрне выше нас
        // (rt-R4 слот 30: удар голема по телу на столбе 3, 20 → 11).
        if (/path|slab|farmland|soul_sand|mud$|snow|carpet|stairs|chest|_bed$|fence|wall|bell|lantern|composter|lectern/.test(fl.name)) continue
        let free = true
        for (let k = 0; k <= 4; k++) { const b = bot.blockAt(c.offset(0, k, 0)); if (!b || b.boundingBox === 'block' || /water|lava/.test(b.name)) { free = false; break } }
        if (!free || c.y < gy) continue
        // Выше пола на 1 вокруг — столб 4 (голем тогда достаётся, только прижавшись к столбу); выше — мимо.
        const extra = golemTopNear(bot, c, g) - c.y
        if (extra > 1) continue
        const strike = golemReach({ entity: { position: c.offset(.5, GOLEM_PILLAR + extra, .5) } }, g)
        // A neutral mob outside legal strike range costs the existing six-second
        // no-hit wait; prefer a perch from which the first safe hit is possible.
        const score = Math.hypot(c.x + 0.5 - me.x, c.z + 0.5 - me.z) + Math.abs(c.y - me.y) * 2 + extra * 6 + (strike > 2.95 ? 6 : 0)
        if (!best || score < best.score) best = { c, score }
      }
    }
  }
  return best && best.c
}
