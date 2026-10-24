// Рой: сброс — групповая атака на одного у обрыва (пользователь 14.10: «если рядом обрыв — всегда пытаться скинуть, это
// приоритетный способ убить»; 21.10: «скинул — и он умер сразу; вместе они толкают жёстко»). Цена сброса — убьёт ли
// падение: пустота — насмерть, высота — урон падения ceil(h − 3) (safe_fall_distance 3, без Невесомости на нём —
// её не видно) против оценки его хп, лава — её урон по его видимой броне за время, пока он из неё выбирается. Чем
// смертельнее, тем сильнее бьющие встают с другой стороны (удар отбрасывает от бьющего — в обрыв), а заряды ветра идут
// в ход у всех, у кого есть (wind_push сам проверяет прогоном тела, что всплеск его скинет). Ломка пола под ним —
// ямы-ловушки (plan-jobs.pvpDiggers) с местами у самых его ног.
import * as damage from '../pvp/damage-model'
import type { SharedEnemy } from './types'

// Сторона падения от цели (единичный вектор), глубина (Infinity — пустота или лава), лава ли внизу и в скольких блоках
// от него край (at; нет — вплотную).
export type Edge = { x: number; z: number; drop?: number; lava?: boolean; at?: number }
export const SHOVE = 0.5 // ценность, с которой сброс — способ убить (полхп и больше)
// Докуда край — сброс ударом (отброс спринт-удара 1.21 — до 3 бл.); дальше — только заряд ветра (wind_push считает прогоном).
export const SHOVE_REACH = 3
// Сколько он в лаве ямы, пока не выйдет (ямы поля — 1–1.6 бл. в радиусе, выход шагом на край): секунды горения.
const LAVA_S = 4

// Лава (10 тиков на удар 4 по броне, lava.json) и горение на теле (1 в секунду, мимо брони) за LAVA_S — по видимой броне:
// незерит с блеском (Защита IV) теряет ~4 хп, голый — смерть (стенд 21.10: чемпион выходил из ям, лечась яблоками).
function lavaLoss(foe: Pick<SharedEnemy, 'equipment'>): number {
  const armor = (foe.equipment?.armor || []).map(name => ({ name, ench: { protection: foe.equipment?.enchanted ? 4 : 0 } }))
  const def = damage.defenseOf(armor)
  return LAVA_S * (2 * damage.afterDefense(4, 'fire', def) + (1 - damage.epfFor(def, 'fire') / 25))
}

export function shoveValue(foe: Pick<SharedEnemy, 'hpEstimate' | 'equipment'>, edge: Edge | null | undefined): number {
  if (!edge) return 0
  const hp = Math.max(1, foe.hpEstimate ?? 20)
  if (edge.lava) return Math.min(1, lavaLoss(foe) / hp)
  const drop = edge.drop ?? Infinity
  if (!Number.isFinite(drop)) return 1
  return Math.min(1, Math.max(0, Math.ceil(drop - 3)) / hp)
}

// shortcut: плоский каменный пол и неизвестные клавиши цели; коллизии и безопасное место проверяет тело, план обновляется
// по видимой скорости. Числа — LivingEntity.knockback/travelInAir, Player.attack, ArmorMaterials из jar 1.21.11.
export function shoveHits(foe: Pick<SharedEnemy, 'velocity' | 'equipment'>, edge: Edge | null | undefined, { sprint = true, kb = 0 }: { sprint?: boolean; kb?: number } = {}): number {
  const norm = edge && Math.hypot(edge.x, edge.z), at = edge?.at ?? 0
  if (!norm || !Number.isFinite(norm) || !Number.isFinite(at)) return Infinity
  const goal = Math.max(0, at) + .3 // За край должен выйти весь хитбокс шириной .6.
  const resistance = Math.min(1, (foe.equipment?.armor || []).filter(n => /^netherite_(helmet|chestplate|leggings|boots)$/.test(n)).length * .1)
  const k = 1 - resistance, extra = .5 * (Number(sprint) + Math.max(0, kb))
  let v = ((foe.velocity?.x || 0) * edge!.x + (foe.velocity?.z || 0) * edge!.z) / norm
  let vy = foe.velocity?.y || 0, x = 0, y = 0, ground = vy <= 0 && vy >= -.08, hits = 0, tail = 0
  if (!Number.isFinite(v) || !Number.isFinite(vy) || !Number.isFinite(extra)) return Infinity
  for (let tick = 0; tick < 200; tick++) {
    if (tick === 180) tail = x
    if (tick % damage.IFRAME_TICKS === 0) {
      hits++
      v = v / 2 + .4 * k
      if (ground) vy = Math.min(.4, vy / 2 + .4 * k)
      if (extra > 0) { v = v / 2 + extra * k; if (ground) vy = Math.min(.4, vy / 2 + extra * k) }
    }
    if (Math.abs(v) < .003) v = 0
    if (Math.abs(vy) < .003) vy = 0
    const drag = .91 * (ground ? .6 : 1)
    x += v; y += vy
    if (y < 0) { y = 0; vy = 0; ground = true } else ground = false
    v *= drag; vy = (vy - .08) * .98
    if (x >= goal) return hits
  }
  // После 10 с продолжаем ценой последних двух окон, а не запрещаем далёкий край ради ограничения вычислений.
  return x > tail ? hits + Math.ceil((goal - x) * 2 / (x - tail)) : Infinity
}
