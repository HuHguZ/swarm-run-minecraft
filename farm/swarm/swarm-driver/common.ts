// Рой: общее для частей драйвера — оружие, блоки, еда, расстояние, ключ клетки.
export const WEAPON = /(_sword|_axe|_spear)$|^(mace|trident|bow|crossbow)$/
export const BLOCK = /^(cobblestone|stone|dirt|smooth_sandstone|cut_sandstone|sandstone|sand|red_sand|netherrack|.*_planks)$/
export const blockCount = (inv = {}) => Object.entries(inv).filter(([n]) => BLOCK.test(n)).reduce((s, [, c]: any) => s + c, 0)
export const FOOD = /^(bread|cooked_.*|golden_apple|enchanted_golden_apple)$/
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
export const cellKey = p => `${p.x},${p.y},${p.z}`


// Контекст драйвера: параметры, общее состояние (state.ts) и функции частей; части берут нужное из него при создании,
// а то, что создаётся позже (обратные ссылки), — через sw при вызове.
export type SwarmDriverCtx = Record<string, any>

// Ход бота по частям: общее — тело, его задача и доска, раунд, враги, ближний враг и контакт, манёвр, цель боя.
export interface TurnCtx { b: any; context: any; board: any; member: any; task: any; round: number; m: any; enemies: any[]; nearest?: any; gap?: number; contact?: boolean; maneuver?: boolean; foe?: any }
