// Рой: общее для частей драйвера — оружие, блоки, еда, расстояние, ключ клетки.
export const WEAPON = /(_sword|_axe|_spear)$|^(mace|trident|bow|crossbow)$/
export const BLOCK = /^(cobblestone|stone|dirt|smooth_sandstone|cut_sandstone|sandstone|sand|red_sand|netherrack|.*_planks)$/
export const blockCount = (inv = {}) => Object.entries(inv).filter(([n]) => BLOCK.test(n)).reduce((s, [, c]: any) => s + c, 0)
export const FOOD = /^(bread|cooked_.*|golden_apple|enchanted_golden_apple)$/
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
export const cellKey = p => `${p.x},${p.y},${p.z}`

// Свежая видимая линия стрельбы дороже лута; за укрытием тихий датчик снимает угрозу сразу.
export const underArrowFire = (b, at = Date.now()) => !!b.arrowThreat?.active && at >= b.arrowThreat.at && at - b.arrowThreat.at <= 1500


// Контекст драйвера: параметры, общее состояние (state.ts) и функции частей; части берут нужное из него при создании,
// а то, что создаётся позже (обратные ссылки), — через sw при вызове.
export type SwarmDriverCtx = Record<string, any>

// Ход бота по частям: общее — тело, его задача и доска, раунд, враги, ближний враг и контакт, манёвр, цель боя.
export interface TurnCtx { b: any; context: any; board: any; member: any; task: any; round: number; m: any; enemies: any[]; nearest?: any; gap?: number; contact?: boolean; maneuver?: boolean; foe?: any }

// Ракеты и заряды ветра во второй руке — тоже запас (пользователь 25.10: «ракеты кончаются»): состояние тела считает в рюкзаке
// только еду из второй руки, и у летающего с ракетами в левой руке драйвер видел 0 — пороги полёта, запас и раздача врали.
export function withOffHand(inventory: Record<string, number> | undefined, off: { item?: string; count?: number } | null | undefined) {
  const inv = { ...(inventory || {}) }
  if (off?.item && /^(firework_rocket|wind_charge)$/.test(off.item) && off.count) inv[off.item] = (inv[off.item] || 0) + off.count
  return inv
}
