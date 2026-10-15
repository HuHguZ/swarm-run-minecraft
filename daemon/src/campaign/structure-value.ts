// Лут построек ценой (пользователь 14.10: «клады разные искать по структурам основного мира — это время экономит, если они
// рядом»; «спидраннеры просто знают устройство всех структур и откапывают все сундуки»). Идти или нет — выгода против цены,
// в секундах, с числами для журнала.
//
// Выгода — все сундуки шаблона (structure-fit: узнанный шаблон даёт клетки и таблицы сундуков; не узнан — среднее по
// вариантам постройки), ожидание на сундук — по таблицам лута сервера 1.21.11 (loot_table/chests/*.json в
// paper-1.21.11.jar: броски пула × вес / сумму весов × среднее set_count; железо — слитки + самородки/9 + железная кирка
// за 3; еда — в единицах campaign.foodUnits, min(1, голод/6), пшеница → хлеб /3). Цена предмета — сколько секунд он
// экономит при текущих нуждах, по априорам графа (core/speedrun.ts): MineIron 180 с на 8 слитков, FindFood 90 с на 8
// единиц еды, LavaPoolPortal 120 с на раму. Золото — на золотые ботинки дорого (координатор 14.10: без золотой вещи бот гибнет у
// портала Ада в 4 случаях из 5; это лут построек по цене, а не поиск золота), сверх ботинок — попутно.
// Цена — путь (по расстоянию, по воде в полтора раза дольше), сундук (открыть 8 с) и работа до него: копать к сундуку
// под песком или в доме, нырять под воду, колодец храма, лестница иглу (CHEST_WORK). Карта сокровищ — цепочка
// «корабль → карта → клад» целиком: доля карты × (выгода клада − путь к нему и копка).

export interface Needs {
  iron: number // слитков не хватает на набор (ведро, огниво, щит, кирка)
  lighter: boolean // нет ни огнива, ни огненного заряда, портала нет
  food: number // единиц еды до запаса 8
  portal: boolean // портал уже есть (обсидиан не нужен)
  diamondPick: boolean // запасной путь через алмазную кирку ещё открыт
  beds: number // кроватей не хватает на дракона
  gold?: number // слитков не хватает на золотые ботинки (0 — золотая вещь уже есть)
}

// Ожидание на сундук (таблицы jar 1.21.11, расчёт 14.10). lighter, golden_armor — вероятность хоть одного.
export const TABLE: Record<string, Record<string, number>> = {
  shipwreck_supply: { food: 4.94 },
  shipwreck_treasure: { iron: 9.44, gold: 1.17, diamond: 0.15 },
  shipwreck_map: { treasure_map: 1 },
  buried_treasure: { iron: 9.29, gold: 4.64, diamond: 1, food: 5.5 },
  desert_pyramid: { iron: 0.55, gold: 0.82, diamond: 0.12, food: 0.18, golden_apple: 0.27 },
  jungle_temple: { iron: 1.35, gold: 3.03, diamond: 0.27 },
  igloo_chest: { gold: 0.18, food: 2.81, golden_apple: 1 },
  ruined_portal: { iron: 0.9, gold: 0.93, food: 0.76, golden_apple: 0.24, obsidian: 0.9, lighter: 0.74, golden_armor: 0.62 },
  underwater_ruin_big: { gold: 0.34, food: 1.08, golden_apple: 0.04, treasure_map: 0.43 },
  underwater_ruin_small: { food: 1.16, treasure_map: 0.42 },
  pillager_outpost: { iron: 0.68, food: 3.04 },
  'village/village_weaponsmith': { iron: 2.31, gold: 0.51, diamond: 0.31, food: 2.31, obsidian: 1.29 },
  'village/village_toolsmith': { iron: 3.63, gold: 0.21, diamond: 0.21, food: 2.59 },
  'village/village_armorer': { iron: 1.5, food: 3.13 },
  'village/village_plains_house': { food: 6.08 },
  'village/village_desert_house': { food: 4.88 },
  'village/village_savanna_house': { iron: 0.36, food: 2.49 },
  'village/village_snowy_house': { food: 2.96 },
  'village/village_taiga_house': { food: 3.58 },
  'village/village_temple': { gold: 0.72, food: 4.22 },
  'village/village_cartographer': { food: 1.88 },
  'village/village_fisher': { iron: 1.64, food: 0.55 },
  'village/village_tannery': { food: 1.95 },
  'village/village_butcher': { food: 2.07 },
  'village/village_mason': { food: 1.92 },
  'village/village_shepherd': { food: 0.76, bed: 1.96 },
  'village/village_fletcher': {}
}

// Постройка, пока шаблон не узнан: средние сундуки по вариантам (веса списков кусков и пулов деревень jar 1.21.11) и
// добыча вне сундуков. Корабль: 20 шаблонов океана — карта 0.8, снабжение 0.7, сокровища 0.7 на корабль; на пляже (11)
// по 8/11. Деревня равнин: дома с сундуками — 13 из 87 весов пула домов, ~10 домов на деревню; сено (2 блока ≈ 5 ед.) и
// кровать — вне сундуков (ферма sv-1-* 14.10). Руины портала: 1 сундук. Храм пустыни 4, джунглей 2, иглу — подвал в половине.
export interface Prior { chests: Array<[string, number]>; outside?: Record<string, number>; water?: boolean; overhead: number }
export const PRIOR: Record<string, Prior> = {
  ruined_portal: { chests: [['ruined_portal', 1]], overhead: 0 },
  village: { chests: [['village/village_plains_house', 0.7], ['village/village_weaponsmith', 0.23], ['village/village_tannery', 0.23], ['village/village_fisher', 0.23], ['village/village_cartographer', 0.11]], outside: { food: 5, bed: 1 }, overhead: 40 },
  desert_pyramid: { chests: [['desert_pyramid', 4]], overhead: 10 },
  jungle_pyramid: { chests: [['jungle_temple', 2]], overhead: 10 },
  igloo: { chests: [['igloo_chest', 0.5]], overhead: 5 },
  shipwreck: { chests: [['shipwreck_map', 0.8], ['shipwreck_supply', 0.7], ['shipwreck_treasure', 0.7]], water: true, overhead: 10 },
  ocean_ruin: { chests: [['underwater_ruin_small', 1]], water: true, overhead: 10 },
  buried_treasure: { chests: [['buried_treasure', 1]], overhead: 0 }
}
// Работа до сундука сверх ходьбы и открытия, с: копать под песком/в стене, нырять, колодец храма, лестница иглу.
// Замер фермы 14.10 (try-lab-struct, с шаблонами, подход 10–16 бл.): пустынный храм — 4 сундука за 22–26 с (колодец 10 бл.,
// плита), иглу с подвалом 33 бл. — 30–32 с, корабль под палубой на 13 бл. — 27 с на сундук, rightsideup_full — 3 за 80 с,
// храм джунглей — 2 за 22 с, сундук храма деревни — 13–16 с, руины портала — ~12 с. Было 8 + 8 на сундук и 15 сверху —
// храм в 66 бл. «−25 с — мимо» (g1-1) при настоящих ~25 с работы.
export const CHEST_WORK: Record<string, number> = { shipwreck: 6, shipwreckWet: 22, ocean_ruin: 22, desert_pyramid: 2, jungle_pyramid: 6, igloo: 25, village: 6, ruined_portal: 3, buried_treasure: 15 }
// goldBoots — ботинки целиком: смерть у портала без них 4 из 5, с ними ~2 из 5 (агент Ада 14.10, серии g4/g5) — 0.4 × 1200 с.
export const SECONDS = { iron: 22, ironSpare: 6, lighter: 90, obsidian: 6, food: 11, gold: 2, goldBoots: 480, goldenApple: 20, diamond: 20, bed: 15 }
export const WALK_BPS = 2.5 // ход с обходами и прыжками; крюк — туда и половина обратно
export const DETOUR = 1.5
export const CHEST_SECONDS = 4 // открыть и взять, стоя у сундука (замер: 4 сундука храма — ~8 с после колодца)
// Путь к кладу по карте, пока карты нет: априор, не замер (поиск в 50 чанках — предел, не среднее; ревью Codex q2). Карта
// прочитана — у записи клада своё расстояние (explore пишет «клад на x,z (N бл.)»).
export const TREASURE_WALK = 160

export function itemSeconds (item: string, n: number, needs: Needs): number {
  switch (item) {
    case 'iron': return Math.min(n, Math.max(0, needs.iron)) * SECONDS.iron + Math.max(0, n - Math.max(0, needs.iron)) * SECONDS.ironSpare
    case 'lighter': return needs.lighter ? Math.min(1, n) * SECONDS.lighter : 0
    case 'obsidian': return needs.portal ? 0 : n * SECONDS.obsidian
    case 'food': return Math.min(n, Math.max(0, needs.food)) * SECONDS.food
    case 'gold': case 'golden_armor': return n * SECONDS.gold
    case 'golden_apple': return n * SECONDS.goldenApple
    case 'diamond': return needs.diamondPick ? n * SECONDS.diamond : 0
    case 'bed': return Math.min(n, Math.max(0, needs.beds)) * SECONDS.bed
    default: return 0
  }
}
// Нужды после добычи items (для цепочки: клад после корабля).
function after (needs: Needs, items: Record<string, number>): Needs {
  return { ...needs, iron: Math.max(0, needs.iron - (items.iron || 0)), food: Math.max(0, needs.food - (items.food || 0)), lighter: needs.lighter && (items.lighter || 0) < 0.5, beds: Math.max(0, needs.beds - (items.bed || 0)),
    gold: (items.golden_armor || 0) >= 0.5 ? 0 : Math.max(0, (needs.gold || 0) - (items.gold || 0)) }
}

export interface Chest { table: string; p: number; wet?: boolean }
export interface Worth { kind: string; distance: number; value: number; walk: number; cost: number; net: number; items: Array<[string, number, number]>; chests: number; chain?: number; known?: boolean; swim?: boolean; night?: number }

// kind, расстояние, нужды; chests — сундуки узнанного шаблона (иначе — среднее по вариантам); wet — постройка под водой
// (руины портала в океане: увидены ниже уровня моря — ферма 14.10, cs-3: «сундук 11 с» на 13 бл. под водой).
// outside — добыча вне сундуков по узнанным шаблонам (деревня: кровати и сено домов), вместо априора.
export function structureWorth (kind: string, distance: number, needs: Needs, chests: Chest[] | null = null, wet = false, outside: Record<string, number> | null = null): Worth | null {
  const P = PRIOR[kind]
  if (!P) return null
  const list: Chest[] = chests !== null ? chests : P.chests.map(([table, p]) => ({ table, p, wet: !!P.water || wet }))
  const items: Record<string, number> = { ...(outside || P.outside || {}) }
  let maps = 0
  let work = 0
  let nChests = 0
  for (const c of list) {
    if (!(c.p > 0)) continue // округлённая до 0 гипотеза — не цель (ревью Codex q2)
    const t = TABLE[c.table] || {}
    for (const [k, v] of Object.entries(t)) {
      if (k === 'treasure_map') maps += c.p * v
      else items[k] = (items[k] || 0) + c.p * v
    }
    nChests += c.p
    // Под водой — нырок у любой постройки (руины портала в океане, подводные руины): не меньше, чем у корабля.
    const W = Math.max(c.wet ? CHEST_WORK.shipwreckWet : 0, kind === 'shipwreck' ? CHEST_WORK.shipwreck : (CHEST_WORK[kind] || 5))
    // К клетке шаблона копать или нырять придётся целиком (пусто там или нет — видно, только дойдя; ревью Codex q2), с
    // вероятностью — лишь открытие и добыча. Без шаблона p — ожидаемое число сундуков, работа — тоже ожиданием.
    work += (chests !== null ? 1 : c.p) * W + c.p * CHEST_SECONDS
  }
  const priced = Object.entries(items).map(([item, n]) => [item, Math.round(n * 100) / 100, itemSeconds(item, n, needs)] as [string, number, number])
  // Ботинки — одна нужда на кусок золотой брони и слитки: доля, которой постройка её закрывает, × цена ботинок; слитки сверх — попутно.
  if (needs.gold) {
    const cover = Math.min(1, (items.golden_armor || 0) + (items.gold || 0) / needs.gold)
    for (const row of priced) {
      if (row[0] === 'gold') row[2] = cover * SECONDS.goldBoots + Math.max(0, row[1] - needs.gold) * SECONDS.gold
      if (row[0] === 'golden_armor') row[2] = 0
    }
    if (!items.gold && cover > 0) priced.push(['gold', 0, cover * SECONDS.goldBoots])
  }
  let value = priced.reduce((s, [, , v]) => s + v, 0)
  // Цепочка карты: клад после добычи этой постройки — доля карты × (выгода клада − путь и копка).
  let chain = 0
  if (maps > 0 && kind !== 'buried_treasure') {
    const t = structureWorth('buried_treasure', TREASURE_WALK, after(needs, items))
    if (t && t.net > 0) chain = Math.min(1, maps) * t.net
    value += chain
    if (chain >= 1) priced.push(['treasure_map', Math.round(Math.min(1, maps) * 100) / 100, chain])
  }
  // По воде — в полтора раза дольше; у узнанной постройки — по её сундукам (корабль на пляже — посуху).
  const swim = list.some(c => c.p > 0 && c.wet)
  const walk = distance / WALK_BPS * DETOUR * (swim ? 1.5 : 1)
  // Деревня с узнанными домами — без обхода дверей (structures.village): сверху 10 с, а не 40.
  const cost = walk + work + (kind === 'village' && outside ? 10 : P.overhead)
  return { kind, distance, value, walk, cost, net: value - cost, items: priced, chests: Math.round(nChests * 10) / 10, chain, known: chests !== null, swim }
}

// «путь ≈ 60 с + сундуки 3 ≈ 52 с, выгода ≈ 120 с (iron 9.4: 207 с, …) → +52 с».
// Заход, который кончится после сумерек (11840), — секунды поверху ночью: цена риска, а не запрет. Смерть — ~1200 с прогона
// (descent.DEATH_SECONDS); ночью поверху без брони серии cl-a…cl-ap и g1/g2 14.10 гибли за минуты (g2-s2-1: сундук под водой
// на 11528, сумерки в воде — утопленники) — ~1/300 в секунду, 4 с за секунду; в воде — вдвое.
export const NIGHT_SECONDS = 4
export function withNight (w: Worth, dayLeft: number): Worth {
  const over = Math.max(0, w.cost - Math.max(0, dayLeft))
  if (!(over > 0)) return w
  const night = over * NIGHT_SECONDS * (w.swim ? 2 : 1)
  return { ...w, night, net: w.net - night }
}

export function describeWorth (w: Worth): string {
  const parts = w.items.filter(([, , s]) => s >= 1).sort((a, b) => b[2] - a[2]).map(([item, n, s]) => `${item} ${n}: ${Math.round(s)} с`)
  return `путь ≈ ${Math.round(w.walk)} с + сундуки ${w.chests}${w.known ? ' по шаблону' : ''} ≈ ${Math.round(w.cost - w.walk)} с, выгода ≈ ${Math.round(w.value)} с` +
    `${parts.length ? ` (${parts.join(', ')})` : ''}${w.night ? `, ночь на исходе захода −${Math.round(w.night)} с` : ''} → ${w.net >= 0 ? '+' : ''}${Math.round(w.net)} с`
}
