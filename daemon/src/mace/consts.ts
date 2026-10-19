// Булава (mace.ts): числа игры 1.21.11 (руки, заряд ветра, свап атрибутов), мелкие функции и урон с падения.
const EYE = 1.62
// Player: entity_interaction_range 3.0 — от глаз до рамки цели.
export const REACH = 3.0
export const MACE_BASE = 6
export const SMASH_MIN = 1.5
export const WIND_SPEED = 1.5
const WIND_REACH = 2.4
const WIND_KB = 1.22
const BURST_LIFT = 0.25
export const WIND_CD_MS = 500
// Атрибут-свап (б.3) на тестовом Paper 1.21.11-132 НЕ работает — замер
// 2026-09-26 (probe-swap): меч заряжен, в одном тике «булава → удар → меч» —
// сервер взял урон и скорость булавы и заряд с нуля (−0.25 хп по алмазу
// вместо −1.89 мечом). Значит, Paper обновляет атрибуты на смене слота. По
// умолчанию выключен; ND_ATTR_SWAP=1 — для ванильного сервера, где он есть.
// Без свапа: булава в руке заранее (33 тика заряда), а заряд ветра — из
// левой руки, чтобы смена предмета не обнулила заряд булавы.
export const SWAP = process.env.ND_ATTR_SWAP === '1'
// Свой заряд под ноги — не строго вниз, а на столько блоков за спину: всплеск
// толкает «от центра к глазам», и горизонталь этого толчка несёт к нему.
export const LAUNCH_BACK = 0.3

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
export const yawTo = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z))
export const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

export function smashBonus (h) {
  if (!(h > SMASH_MIN)) return 0
  if (h <= 3) return 4 * h
  if (h <= 8) return 12 + 2 * (h - 3)
  return 22 + (h - 8)
}

// Урон до брони: (урон × множитель заряда + бонус) × крит. base — атрибут
// руки на момент удара (меч при свапе: 7 у алмазного). density — уровень
// «Плотности» булавы: +0.5 за блок падения на уровень (MaceItem.
// getAttackDamageBonus → modifyFallBasedDamage × fallDistance; арена с чарами).
export function smashDamage (h, { base = MACE_BASE, charge = 1, density = 0 }: any = {}) {
  const scale = 0.2 + charge * charge * 0.8
  const crit = charge > 0.9 ? 1.5 : 1
  const dens = h > SMASH_MIN ? 0.5 * density * h : 0
  return (base * scale + smashBonus(h) + dens) * crit
}
