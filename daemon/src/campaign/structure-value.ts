// Лут построек ценой (пользователь 14.10: «клады разные искать по структурам основного мира — это время экономит, если они
// рядом»). Идти или нет — выгода против пути, в секундах, с числами для журнала.
//
// Добыча — среднее из таблиц лута сервера 1.21.11 (data/minecraft/loot_table/chests/*.json в paper-1.21.11.jar: броски пула ×
// вес / сумма весов × set_count), на постройку — × сундуков в ней. Цена предмета — сколько секунд он экономит при текущих нуждах,
// по априорам графа (core/speedrun.ts): MineIron 180 с на 8 слитков, FindFood 90 с на 8 единиц еды, LavaPoolPortal 120 с на раму.
// Золото — попутно, не повод для крюка (пользователь 14.10: золото на броню и бартер — в Аду).
// Деревня и корабль — по факту фермы, а не по таблицам (sv-1-1..3 14.10): деревня дала сено ×2 и кровать (сундуков домов explore
// не находит), корабль — 0 сундуков из 3 заходов (под водой не видны). Таблицы: деревня ~4 сундука хлеба/еды и железо кузнецов,
// корабль — железо 9 в сундуке сокровищ; вернуть, когда explore начнёт их находить.

export interface Needs {
  iron: number // слитков не хватает на набор (ведро, огниво, щит, кирка)
  lighter: boolean // нет ни огнива, ни огненного заряда, портала нет
  food: number // единиц еды до запаса 8
  portal: boolean // портал уже есть (обсидиан не нужен)
  diamondPick: boolean // запасной путь через алмазную кирку ещё открыт
  beds: number // кроватей не хватает на дракона
}

export interface Loot { chests: number; overhead: number; water?: boolean; items: Record<string, number> }

// lighter — вероятность хоть одного огнива или заряда (portal-natural: «огниво или заряд в 73 %»); golden_armor — хоть одной части.
export const LOOT: Record<string, Loot> = {
  ruined_portal: { chests: 1, overhead: 0, items: { lighter: 0.73, obsidian: 0.9, iron: 0.9, golden_armor: 0.6, gold: 0.75, golden_apple: 0.25 } },
  village: { chests: 2, overhead: 20, items: { food: 6, bed: 1, iron: 0.3 } },
  desert_pyramid: { chests: 4, overhead: 30, items: { iron: 2.2, gold: 3.3, diamond: 0.5, golden_apple: 1 } },
  jungle_pyramid: { chests: 2, overhead: 40, items: { iron: 2.7, gold: 6.1, diamond: 0.54 } },
  igloo: { chests: 0.5, overhead: 20, items: { golden_apple: 0.5, food: 3 } },
  shipwreck: { chests: 2, overhead: 20, water: true, items: { iron: 1, food: 1.2 } }
}

export const SECONDS = { iron: 22, ironSpare: 6, lighter: 90, obsidian: 6, food: 11, gold: 2, goldenApple: 20, diamond: 20, bed: 15 }
export const WALK_BPS = 2.5 // ход с обходами и прыжками; крюк — туда и половина обратно
export const DETOUR = 1.5
export const CHEST_SECONDS = 8

export function itemSeconds (item: string, n: number, needs: Needs): number {
  switch (item) {
    case 'iron': return Math.min(n, needs.iron) * SECONDS.iron + Math.max(0, n - needs.iron) * SECONDS.ironSpare
    case 'lighter': return needs.lighter ? n * SECONDS.lighter : 0
    case 'obsidian': return needs.portal ? 0 : n * SECONDS.obsidian
    case 'food': return Math.min(n, needs.food) * SECONDS.food
    case 'gold': case 'golden_armor': return n * SECONDS.gold
    case 'golden_apple': return n * SECONDS.goldenApple
    case 'diamond': return needs.diamondPick ? n * SECONDS.diamond : 0
    case 'bed': return Math.min(n, needs.beds) * SECONDS.bed
    default: return 0
  }
}

export interface Worth { kind: string; distance: number; value: number; walk: number; cost: number; net: number; items: Array<[string, number, number]> }

export function structureWorth (kind: string, distance: number, needs: Needs): Worth | null {
  const loot = LOOT[kind]
  if (!loot) return null
  const items = Object.entries(loot.items).map(([item, n]) => [item, n, itemSeconds(item, n, needs)] as [string, number, number])
  const value = items.reduce((sum, [, , s]) => sum + s, 0)
  const walk = distance / WALK_BPS * DETOUR * (loot.water ? 1.5 : 1)
  const cost = walk + loot.chests * CHEST_SECONDS + loot.overhead
  return { kind, distance, value, walk, cost, net: value - cost, items }
}

// «путь ≈ 60 с + лут 8 с, выгода ≈ 120 с (огниво 0.73×90, железо 0.9×22) → +52 с».
export function describeWorth (w: Worth): string {
  const parts = w.items.filter(([, , s]) => s >= 1).sort((a, b) => b[2] - a[2]).map(([item, n, s]) => `${item} ${n}: ${Math.round(s)} с`)
  return `путь ≈ ${Math.round(w.walk)} с + лут ≈ ${Math.round(w.cost - w.walk)} с, выгода ≈ ${Math.round(w.value)} с` +
    `${parts.length ? ` (${parts.join(', ')})` : ''} → ${w.net >= 0 ? '+' : ''}${Math.round(w.net)} с`
}
