// Рой: общее для частей драйвера — оружие, блоки, еда, расстояние, ключ клетки.
import { bowScreenStep } from '../../../daemon/src/swarm/common'
export const WEAPON = /(_sword|_axe|_spear)$|^(mace|trident|bow|crossbow)$/
export const BLOCK = /^(cobblestone|stone|dirt|smooth_sandstone|cut_sandstone|sandstone|sand|red_sand|netherrack|.*_planks)$/
export const blockCount = (inv = {}) => Object.entries(inv).filter(([n]) => BLOCK.test(n)).reduce((s, [, c]: any) => s + c, 0)
export const buildStock = (inv: Record<string, number> = {}) => Object.keys(inv).filter(n => inv[n] > 0 && BLOCK.test(n)).sort().map(n => `${n}:${inv[n]}`).join(',')
export const FOOD = /^(bread|cooked_.*|golden_apple|enchanted_golden_apple)$/
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
export const PILE_MEMORY_MS = 280000
export const inDropPile = (item, site) => Math.abs(item.y - site.y) < 2 && Math.hypot(item.x - site.x, item.z - site.z) <= 6
export const cellKey = p => `${p.x},${p.y},${p.z}`

// Свежая видимая линия стрельбы дороже лута; за укрытием тихий датчик снимает угрозу сразу.
export const underArrowFire = (b, at = Date.now()) => !!b.arrowThreat?.active && at >= b.arrowThreat.at && at - b.arrowThreat.at <= 1500


// Контекст драйвера: параметры, общее состояние (state.ts) и функции частей; части берут нужное из него при создании,
// а то, что создаётся позже (обратные ссылки), — через sw при вызове.
export type SwarmDriverCtx = Record<string, any>

export function busyForCover(sw: SwarmDriverCtx, b, board) {
  const m = sw.pos[b.name], action = b.last
  return b.swarmReserved || m?.combo || m?.gliding || m?.rescuing || b.webRescue || b.maceDefense?.until > sw.now() ||
    b.climbing && b.swarmAscent?.pending && !b.swarmAscent.stalled ||
    /^(Tactical|Emergency)$/.test(m?.tactics?.owner || '') || action?.pending === true &&
    (['flee', 'lava_escape', 'dodge_blast', 'clear_web'].includes(action.m) || b.shieldHold && action.m === 'swarm_hold' ||
      action.m === 'chest_take' && action.p?.stay && sw.chestSafe(b, board, action.p))
}
export function currentShieldLane(guard, ward, report, aim) {
  const then = report.ward && bowScreenStep(guard, report.ward, aim.at), now = bowScreenStep(guard, ward, aim.at)
  return !!then && !!now && distance(then, now) <= .3
}

// Ход бота по частям: общее — тело, его задача и доска, раунд, враги, ближний враг и контакт, манёвр, цель боя.
export interface TurnCtx { b: any; context: any; board: any; member: any; task: any; round: number; m: any; enemies: any[]; nearest?: any; gap?: number; contact?: boolean; maneuver?: boolean; foe?: any }

// Ракеты и заряды ветра во второй руке — тоже запас (пользователь 25.10: «ракеты кончаются»): состояние тела считает в рюкзаке
// только еду из второй руки, и у летающего с ракетами в левой руке драйвер видел 0 — пороги полёта, запас и раздача врали.
export function withOffHand(inventory: Record<string, number> | undefined, off: { item?: string; count?: number } | null | undefined) {
  const inv = { ...(inventory || {}) }
  if (off?.item && /^(firework_rocket|wind_charge|milk_bucket)$/.test(off.item) && off.count) inv[off.item] = (inv[off.item] || 0) + off.count
  return inv
}
