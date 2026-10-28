'use strict'
// Укрытие от ифритов-«турелей» (ND_BLZ_COVER=1, поток blaze 27.10). Ифрит с лучом к цели по горизонтали не летит (BlazeAttackGoal 1.21.11:
// только висит и стреляет; без луча — 4 тика к цели и стоп), стреляет лишь при луче глаза → глаза (Sensing.hasLineOfSight). Значит, пока
// никого не достать мечом, стоять там, куда не смотрит ни один живой ифрит, — в 16 бл. от спавнера (он работает), и выходить к одному.
// rx8–rx11: «жду ифритов» до 119 с из 225 на открытом помосте; урон ~10 хп на убийство при бюджете ~4.
import { walkable } from '../walkable'
import { losClear, blazeEye } from './radar'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

const EYE = 1.62

// Сколько ифритов видят глаза тела в клетке cell (ноги) и вес: ближние и заряженные опаснее.
export function exposure (bot: any, cell: any, blazes: any[], charged: (e: any) => boolean = () => false) {
  const eye = new Vec3(cell.x + 0.5, cell.y + EYE, cell.z + 0.5)
  let n = 0, w = 0
  for (const e of blazes) {
    const from = blazeEye(e)
    if (from.distanceTo(eye) > 48) continue
    // Запас на ширину тела и сдвиг ифрита: открыт хоть один из глаз ±0.3 по x/z — на виду (клетка на кромке тени стены — не укрытие).
    if (![eye, eye.offset(0.3, 0, 0), eye.offset(-0.3, 0, 0), eye.offset(0, 0, 0.3), eye.offset(0, 0, -0.3)].some(q => losClear(bot, from, q))) continue
    n++
    w += (charged(e) ? 2 : 1) * (from.distanceTo(eye) < 8 ? 2 : 1)
  }
  return { n, w }
}

// Ближняя клетка, где вес взглядов меньше всего (0 — лучше всех), в radius ходом от тела и в maxSpawner от спавнера; ноги не в огне,
// не у лавы (walkable/standable). null — лучше текущей нет.
// minSpawner: ближе к спавнеру не стоять — ифриты появляются в ±4 от него (центр чаще) прямо у тела и сразу бьют вплотную
// (cv7-s17: ифриты в 0.6–1.7 бл. у тела рядом со спавнером, 42 урона ударами).
const farFrom = (pos: any, spawner: any, r: number) => !spawner || Math.hypot(pos.x - spawner.x, pos.z - spawner.z) >= r
export function coverCell (bot: any, blazes: any[], { spawner = null, radius = 7, maxSpawner = 13, minSpawner = 0, charged = undefined as any, maxNodes = 400 } = {}) {
  const here = bot.entity.position.floored()
  const cur = farFrom(here, spawner, minSpawner) ? exposure(bot, here, blazes, charged) : { n: 99, w: 99 }
  if (cur.w === 0) return null
  let best: any = null
  for (const { pos, d } of walkable(bot, here, { radius, maxNodes })) {
    if (spawner && pos.offset(0.5, 0.5, 0.5).distanceTo(spawner.offset(0.5, 0.5, 0.5)) > maxSpawner) continue
    if (!farFrom(pos, spawner, minSpawner)) continue
    // Не ниже пола зала (спавнер на помосте в 2 над полом): ниже — ифриты над головой недосягаемы, обратно — подъём (cv10-s15).
    if (spawner && pos.y < spawner.y - 2) continue
    const f = bot.blockAt(pos), g = bot.blockAt(pos.offset(0, -1, 0))
    if (!f || /fire|lava/.test(f.name) || !g || /magma|lava/.test(g.name)) continue
    const x = exposure(bot, pos, blazes, charged)
    const score = x.w * 10 + d
    if (!best || score < best.score) best = { pos, d, n: x.n, w: x.w, score }
    if (x.w === 0 && d <= 2) break
  }
  return best && best.w < cur.w ? best : null
}
