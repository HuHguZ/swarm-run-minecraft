'use strict'
// Видно ли блок от глаз — честный луч, как bot.canSeeBlock, но без его
// недолёта. mineflayer (blocks.js canSeeBlock) пускает луч к ЦЕНТРУ блока, а
// длину берёт до его УГЛА (distanceTo(block.position)). Для далёкого блока
// угол ближе грани, в которую луч входит, и луч обрывается, не дойдя: спавнер
// посреди открытого коридора в 34 блоках «не виден» (try-fortress (а),
// 2026-09-25). Здесь длина — до центра плюс полблока, а засчитан блок, только
// если луч упёрся именно в него.

// require вне горячих функций: visibleOf зовут на каждом шаге mine/explore (s5c-f4-4: 2109 проб профиля — разбор пути модуля).
const VEC3 = require('vec3')

function seesBlock (bot, block) {
  if (!block || !bot || !bot.entity) return false
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
  const centre = block.position.offset(0.5, 0.5, 0.5)
  const delta = centre.minus(eye)
  const dist = delta.norm()
  if (dist < 0.01) return true
  const match = (b, iter) => {
    if (iter.intersect(b.shapes, b.position)) return true
    return b.position.equals(block.position)
  }
  try {
    const hit = bot.world.raycast(eye, delta.normalize(), dist + 0.5, match)
    return !!hit && hit.position.equals(block.position)
  } catch {
    return false
  }
}

// Ближайшие ВИДИМЫЕ блоки из ids (для mine и explore), от ближнего к дальнему.
//
// Почему не findBlocks + луч. findBlocks отдаёт ближайшие по расстоянию, и на
// лугу ближние сорок клеток камня — это камень под дёрном, в трёх блоках под
// ногами: луч до них не доходит, а камень на склоне в двадцати блоках за
// отсечку не попадает никогда. Кампания 2026-09-25: «не вижу stone в радиусе
// 32» на каждом шаге, explore stone с отсечкой 12 не находил склон вовсе, и
// тело шло копать вниз туда, где камень стоял стеной рядом.
//
// Здесь сначала отсев «у клетки есть пустая грань» (блок, замурованный со всех
// шести сторон, не виден никому) — по одним номерам состояний, без объектов
// Block, — и только потом луч seesBlock, по порядку от ближнего. Честность та
// же: засчитан только блок, в который упёрся луч от глаз.
//   max  — сколько видимых вернуть; rays — потолок лучей на вызов;
//   skip(pos) — клетки, которые не брать (пол под ногами);
//   fair:false — без зрения, просто ближние (как findBlocks).
function visibleOf (bot, ids, radius, { max = 12, rays = 800, skip = null, fair = true }: any = {}) {
  const Vec3 = VEC3
  const reg = bot.registry
  const want = new Set()
  for (const id of ids) {
    const b = reg.blocks[id]
    if (!b) continue
    for (let s = b.minStateId; s <= b.maxStateId; s++) want.add(s)
  }
  // Пустая для луча клетка: воздух, вода, трава, цветы — всё без коробки.
  const openCache = new Map()
  const isOpen = s => {
    if (s === null) return false // чанк не прогружен — не знаем, не считаем
    let v = openCache.get(s)
    if (v === undefined) {
      const b = reg.blocksByStateId[s]
      v = !b || b.boundingBox === 'empty'
      openCache.set(s, v)
    }
    return v
  }
  const minY = bot.game.minY
  const maxY = minY + bot.game.height - 1
  const cols = new Map()
  const q = { x: 0, y: 0, z: 0 }
  const column = (x, z) => {
    const cx = x >> 4
    const cz = z >> 4
    const key = cx * 131072 + cz
    let col = cols.get(key)
    if (col === undefined) {
      col = bot.world.getColumn(cx, cz) || null
      cols.set(key, col)
    }
    return col
  }
  const stateAt = (x, y, z) => {
    if (y > maxY) return 0 // над миром — небо
    if (y < minY) return null
    const col = column(x, z)
    if (!col) return null
    q.x = x & 15; q.y = y; q.z = z & 15
    return col.getBlockStateId(q)
  }
  const c = bot.entity.position.floored()
  const r = Math.ceil(radius)
  const r2 = radius * radius
  const hits = []
  const sectionTargets = new Map()
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const h2 = dx * dx + dz * dz
      if (h2 > r2) continue
      const x = c.x + dx
      const z = c.z + dz
      const col = column(x, z)
      if (!col) continue
      const dy = Math.floor(Math.sqrt(r2 - h2))
      for (let y = Math.max(minY, c.y - dy); y <= Math.min(maxY, c.y + dy); y++) {
        // Палитра доказывает отсутствие целей во всей секции (как structures.gather).
        // Нет метаданных палитры — читаем состояния прежним способом.
        const sy = Math.floor((y - minY) / 16)
        const data = col.sections?.[sy]?.data
        let eligible = true
        if (data) {
          eligible = sectionTargets.get(data)
          if (eligible === undefined) {
            eligible = data.palette ? data.palette.some(st => want.has(st)) :
              data.value === undefined || want.has(data.value)
            sectionTargets.set(data, eligible)
          }
        }
        if (!eligible) {
          y = minY + (sy + 1) * 16 - 1
          continue
        }
        if (!want.has(stateAt(x, y, z))) continue
        if (fair && !(isOpen(stateAt(x, y + 1, z)) || isOpen(stateAt(x, y - 1, z)) ||
          isOpen(stateAt(x + 1, y, z)) || isOpen(stateAt(x - 1, y, z)) ||
          isOpen(stateAt(x, y, z + 1)) || isOpen(stateAt(x, y, z - 1)))) continue
        hits.push({ x, y, z, d2: h2 + (y - c.y) * (y - c.y) })
      }
    }
  }
  hits.sort((a, b) => a.d2 - b.d2)
  const out = []
  let cast = 0
  for (const h of hits) {
    const pos = new Vec3(h.x, h.y, h.z)
    if (skip && skip(pos)) continue
    const b = bot.blockAt(pos)
    if (!b) continue
    if (fair) {
      if (cast++ >= rays) break
      if (!seesBlock(bot, b)) continue
      // Память увиденного (perception/eyes, S10): что навык увидел лучом — помнит и слой.
      if (bot._ndEyes) { try { bot._ndEyes.saw(b.name, h.x, h.y, h.z) } catch {} }
    }
    out.push(b)
    if (out.length >= max) break
  }
  return out
}

module.exports = { seesBlock, visibleOf }
