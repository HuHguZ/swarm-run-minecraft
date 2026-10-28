'use strict'
// Заслон от ифрита (ND_BLZ2_WALL=1, поток blaze2 27.10). Ифрит стреляет и целится только при луче своего глаза к глазу цели
// (BlazeAttackGoal 1.21.11: Sensing.hasLineOfSight — ClipContext глаз → глаз), заряд — 60 тиков до первого шара (setCharged).
// Значит, за 3 с заряда достаточно одного-двух блоков у тела на этом луче: шаров не будет вовсе, а через 3 с без луча цель
// забыта (TargetGoal.unseenMemoryTicks 60) — заряд сброшен. Уклонение (ND_BLZ_REFLEX) — для шаров, уже летящих.
// Здесь — только геометрия: какие клетки поставить. Ставит blaze-melee (build.placeBlockAt honest — грань видна из глаз).
const EYE = 1.62
const solid = (b: any) => !!b && b.boundingBox === 'block'
const free = (b: any) => !!b && b.boundingBox === 'empty' && !/lava|fire|water/.test(b.name)

// Клетка задевает коробку тела 0.6×1.8 с ногами в pos (туда сервер блок не поставит).
function hitsBody (pos: any, c: any) {
  return c.x < pos.x + 0.3 && c.x + 1 > pos.x - 0.3 && c.z < pos.z + 0.3 && c.z + 1 > pos.z - 0.3 && c.y < pos.y + 1.8 && c.y + 1 > pos.y
}

// Клетки заслона тела (ноги в pos) от глаза ифрита `from`: первая пустая клетка луча глаз → глаз за коробкой тела (до 2.5 бл.),
// и подпорка под ней, если ставить не на что (пол под подпоркой — твёрдый). [] — не встаёт: луч упёрся в блок или жидкость,
// клетка над пустотой, ифрит ближе 1.5 бл. blockAt(Vec3) — как bot.blockAt; from, pos — Vec3.
export function screenCells (blockAt: (p: any) => any, pos: any, from: any): any[] {
  const eye = pos.offset(0, EYE, 0)
  const d = from.minus(eye), L = d.norm()
  if (L < 1.5) return []
  const u = d.scaled(1 / L)
  for (let t = 0.2; t <= Math.min(2.5, L - 0.8); t += 0.05) {
    const c = eye.plus(u.scaled(t)).floored()
    if (hitsBody(pos, c)) continue
    const b = blockAt(c)
    if (!free(b)) return []
    const below = c.offset(0, -1, 0)
    const sides = [below, c.offset(1, 0, 0), c.offset(-1, 0, 0), c.offset(0, 0, 1), c.offset(0, 0, -1), c.offset(0, 1, 0)]
    if (sides.some(q => !hitsBody(pos, q) && solid(blockAt(q)))) return [c]
    if (!hitsBody(pos, below) && free(blockAt(below)) && solid(blockAt(below.offset(0, -1, 0)))) return [below, c]
    return []
  }
  return []
}
