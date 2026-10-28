// Офлайн-просчёт стратегического графа (поток graph, sr27): типичные состояния спидрана → план графа и цена каждого первого шага.
// Без сервера: тот же реестр (core/speedrun), те же цены телеметрии (daemon/strategy-costs.json), те же умолчания флагов.
//   node dist-sr-graph/farm/analysis/graph-scenarios.js [имя сценария…] [--json]
import '../../daemon/src/speedrun-defaults'
import { applyEffect, fact, type WorldState, type FactValue } from '../../daemon/src/core/world-state'
import { plan, type Strategy, type StrategyRegistry } from '../../daemon/src/core/strategy'
import { speedrunRegistry, dragonGoal } from '../../daemon/src/core/speedrun'
import { applyCosts } from '../../daemon/src/core/cost-model'
import { loadCosts } from '../../daemon/src/environments/cost-data'
import { worldFromObservation } from '../../daemon/src/environments/mineflayer'

export interface Scenario {
  name: string
  /** Что сделал бы сильный спидраннер (первый шаг: id стратегии или набор допустимых). */
  speedrunner: string[]
  why: string
  dimension: 'overworld' | 'the_nether'
  health?: number
  food?: number
  inventory: Record<string, number>
  known?: Record<string, unknown>
  facts?: Record<string, FactValue | null>
  pos?: { x: number; y: number; z: number }
  structureSearchMs?: number
  /** Стратегии, исчерпанные директором (2 неудачи подряд без смены причины). */
  exhausted?: string[]
}

/** Настоящий набор входа в Ад (BRIEF 27.10): каменные инструменты + железная кирка KIT_PICK, ведро, огниво, булыжник, палки, немного еды. */
export const ENTRY_KIT: Record<string, number> = { iron_pickaxe: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, bucket: 1,
  flint_and_steel: 1, cobblestone: 48, stick: 4, oak_planks: 3, crafting_table: 1, cooked_porkchop: 4 }
const without = (inventory: Record<string, number>, ...names: string[]) => Object.fromEntries(Object.entries(inventory).filter(([n]) => !names.includes(n)))

/** Факты, которые кампания отдаёт графу в Аду (strategy-bridge intelligenceObservation) при умолчаниях 27.10. */
function netherFacts(s: Scenario): Record<string, FactValue | null> {
  return { nether_ready: true, nether_tools_ready: (s.facts?.nether_pick_swings as number ?? 381) >= 260, nether_pick_swings: 381,
    fortress_explored: 0, fire_resistance_count: 0, fire_resistance_active: false, bastion_gold_dug: 0, bastion_traded: 0,
    barter_exhausted: false, blaze_allowed: true, end_ready: false, endermen_seconds_per_pearl: 900, bastions_exhausted: false,
    // Мост ставит bastion/bastion_position из nextBastion() (strategy-bridge.ts).
    ...(s.known?.bastion ? { bastion: true, bastion_position: s.known.bastion as FactValue } : {}), ...s.facts }
}

export function scenarioState(s: Scenario): WorldState {
  const facts = s.dimension === 'the_nether' ? netherFacts(s) : { nether_ready: false, end_ready: false, ...s.facts }
  const observed = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, fact(v as FactValue | null, 'observed', 0)]))
  return worldFromObservation({ state: { dimension: s.dimension, health: s.health ?? 20, food: s.food ?? 20, inventory: s.inventory, pos: s.pos ?? { x: 0, y: 70, z: 0 } },
    known: { portal: s.dimension === 'the_nether' ? { x: 0, y: 70, z: 0 } : null, ...s.known }, facts: observed, structureSearchMs: s.structureSearchMs ?? 0 }, 0)
}

export function graphRegistry(): StrategyRegistry {
  const registry = speedrunRegistry({ eyes: 12, beds: 5, portalBuckets: process.env.ND_ROUTE_ONE === '0' ? 2 : 1,
    deepLava: process.env.ND_OW_DEEP_LAVA === '1', scoutBudgetMs: process.env.ND_OW_SCOUT_MS ? Number(process.env.ND_OW_SCOUT_MS) : undefined })
  applyCosts(registry, loadCosts())
  return registry
}

export interface FirstStep { id: string; seconds: number; risk: number; toGoalMin: number; rest: string[] }
const RISK_TICKS = 72000
/** Цена «до дракона», если первым шагом взять эту стратегию: шаг (время + риск × 72000) + лучший план после него. */
export function firstSteps(registry: StrategyRegistry, state: WorldState, excluded: ReadonlySet<string> = new Set()): FirstStep[] {
  const rows: FirstStep[] = []
  for (const s of registry.all()) {
    if (excluded.has(s.id) || !s.preconditions(state) || s.failureCondition?.(state)) continue
    const effect = typeof s.expectedEffects === 'function' ? s.expectedEffects(state) : s.expectedEffects
    const next = applyEffect(state, effect)
    const cost = s.estimateCost(state), risk = s.estimateRisk(state)
    const rest = plan(registry, next, dragonGoal, { excluded })
    rows.push({ id: s.id, seconds: Math.round(cost / 20), risk: Math.round(risk * 1000) / 1000,
      toGoalMin: Math.round((cost + risk * RISK_TICKS + rest.cost) / 20 / 6) / 10, rest: rest.steps.map(x => x.id) })
  }
  return rows.sort((a, b) => a.toGoalMin - b.toGoalMin)
}

export function choose(registry: StrategyRegistry, state: WorldState, excluded: ReadonlySet<string> = new Set()): { first: string | null; steps: Strategy[]; cost: number } {
  const p = plan(registry, state, dragonGoal, { excluded })
  return { first: p.steps[0]?.id ?? null, steps: p.steps, cost: p.cost }
}

export const SCENARIOS: Scenario[] = [
  { name: 'ne-arrive-blind', speedrunner: ['FindBastions', 'FindFortress'], why: 'вход с настоящим набором, ничего не видно: искать то, что ближе (обычно бастион — жемчуг дольше)',
    dimension: 'the_nether', inventory: ENTRY_KIT },
  { name: 'ne-arrive-250', speedrunner: ['FindBastions', 'FindFortress'], why: 'вход с настоящим набором — 250 из 260 взмахов (журналы sr27): за стеблями по Аду не идут',
    dimension: 'the_nether', inventory: ENTRY_KIT, facts: { nether_pick_swings: 250, nether_tools_ready: false } },
  { name: 'ne-fortress-seen', speedrunner: ['GetBlazeRods', 'FindBastions'], why: 'крепость видна, бастиона нет: стержни сейчас (крепость рядом) или поиск бастиона — оба разумны, отказ от крепости — нет',
    dimension: 'the_nether', inventory: ENTRY_KIT, known: { fortress: { x: 80, y: 70, z: 40 } } },
  { name: 'ne-bastion-seen', speedrunner: ['BastionBarter'], why: 'бастион виден: золото и бартер',
    dimension: 'the_nether', inventory: ENTRY_KIT, known: { bastion: { x: 60, y: 70, z: 0 } } },
  { name: 'ne-both-seen', speedrunner: ['BastionBarter', 'GetBlazeRods'], why: 'оба видны: обычно бастион (жемчуг и FR от бартера), затем крепость',
    dimension: 'the_nether', inventory: ENTRY_KIT, known: { bastion: { x: 60, y: 70, z: 0 }, fortress: { x: 80, y: 70, z: 40 } } },
  { name: 'ne-worn-picks', speedrunner: ['AcquireNetherTools'], why: 'кирки стёрты (120 взмахов), есть палки, булыжник, верстак — новая кирка на месте, 10 с',
    dimension: 'the_nether', inventory: without(ENTRY_KIT, 'iron_pickaxe'), facts: { nether_pick_swings: 120, nether_tools_ready: false } },
  { name: 'ne-worn-picks-fortress', speedrunner: ['AcquireNetherTools', 'GetBlazeRods'], why: 'кирки стёрты, крепость видна: стержни киркой не добываются — к ифритам можно сразу, кирку сделать по пути',
    dimension: 'the_nether', inventory: without(ENTRY_KIT, 'iron_pickaxe'), facts: { nether_pick_swings: 120, nether_tools_ready: false }, known: { fortress: { x: 80, y: 70, z: 40 } } },
  { name: 'ne-worn-picks-hp10', speedrunner: ['AcquireNetherTools', 'EatFood', 'Heal'], why: 'кирки стёрты, хп 10: кирку скрафтить можно при любом хп (порог 12 — не физика)',
    dimension: 'the_nether', health: 10, food: 14, inventory: without(ENTRY_KIT, 'iron_pickaxe'), facts: { nether_pick_swings: 120, nether_tools_ready: false } },
  { name: 'ne-worn-tools-failed-fortress', speedrunner: ['GetBlazeRods'], why: 'жемчуг есть, кирки стёрты (120), пополнение не вышло дважды, крепость видна: бой мечом, 120 взмахов на укрытие хватит',
    dimension: 'the_nether', inventory: { ...without(ENTRY_KIT, 'iron_pickaxe'), ender_pearl: 12 }, facts: { nether_pick_swings: 120, nether_tools_ready: false },
    known: { fortress: { x: 80, y: 70, z: 40 } }, exhausted: ['AcquireNetherTools'] },
  { name: 'ne-worn-tools-failed-bastion', speedrunner: ['BastionBarter'], why: 'бастион виден, железная кирка на 120 взмахов, пополнение не вышло: на первый пакет золота хватит (так и этап при ND_BASTION_TOOLS_PRICE)',
    dimension: 'the_nether', inventory: without(ENTRY_KIT, 'stone_pickaxe'), facts: { nether_pick_swings: 120, nether_tools_ready: false },
    known: { bastion: { x: 60, y: 70, z: 0 } }, exhausted: ['AcquireNetherTools'] },
  { name: 'ne-hp9-starving-worn', speedrunner: ['AcquireNetherTools', 'FindBastions', 'FindFortress'], why: 'хп 9, еды 0, сытость 14 (лечится сама), кирки стёрты, есть палки/камень/верстак: кирка — 10 с крафта, хп не нужно',
    dimension: 'the_nether', health: 9, food: 14, inventory: without(ENTRY_KIT, 'iron_pickaxe', 'cooked_porkchop'), facts: { nether_pick_swings: 100, nether_tools_ready: false } },
  { name: 'ne-no-picks-no-wood', speedrunner: ['AcquireNetherTools', 'FindBastions', 'FindFortress'], why: 'кирок нет, дерева нет: стебли в Аду (дерево) — кирка; домой — только если нет и стеблей',
    dimension: 'the_nether', inventory: without(ENTRY_KIT, 'iron_pickaxe', 'stone_pickaxe', 'stick', 'oak_planks'), facts: { nether_pick_swings: 0, nether_tools_ready: false } },
  { name: 'ne-hungry', speedrunner: ['FindBastions', 'FindFortress', 'HuntEndermen'], why: 'еды 0, сытость 8, хп 20: в Аду еды нет кроме хоглинов/бартера, наверх за едой — 10+ мин; спидраннер идёт дальше (сытость 8 держит хп)',
    dimension: 'the_nether', food: 8, inventory: without(ENTRY_KIT, 'cooked_porkchop') },
  { name: 'ne-pearls-done-fortress', speedrunner: ['GetBlazeRods'], why: '12 жемчуга, крепость видна, FR нет: к ифритам (FR — бонус, не крюк в 10 мин)',
    dimension: 'the_nether', inventory: { ...ENTRY_KIT, ender_pearl: 12, gold_ingot: 10 }, known: { fortress: { x: 80, y: 70, z: 40 }, bastion: { x: 60, y: 70, z: 0 } } },
  { name: 'ne-pearls-done-fr', speedrunner: ['GetBlazeRods'], why: '12 жемчуга и FR, крепость видна',
    dimension: 'the_nether', inventory: { ...ENTRY_KIT, ender_pearl: 12, potion: 1 }, known: { fortress: { x: 80, y: 70, z: 40 } }, facts: { fire_resistance_count: 1 } },
  { name: 'ne-rods-done-pearls-short', speedrunner: ['BastionBarter', 'FindBastions', 'HuntEndermen'], why: '7 стержней, жемчуга 4, бастион выработан, золота нет: эндермены или новый бастион',
    dimension: 'the_nether', inventory: { ...ENTRY_KIT, blaze_rod: 7, ender_pearl: 4 }, facts: { bastions_exhausted: true, bastion: false } },
  { name: 'ne-all-done', speedrunner: ['CraftEyes'], why: 'всё собрано: очи в Аду и домой',
    dimension: 'the_nether', inventory: { ...ENTRY_KIT, blaze_rod: 7, ender_pearl: 13 } },
  { name: 'ow-start', speedrunner: ['AcquireWood'], why: 'спавн', dimension: 'overworld', inventory: {} },
  { name: 'ow-stone-no-iron', speedrunner: ['MineIron'], why: 'каменные инструменты, железа нет, построек не видно (разведка 0)',
    dimension: 'overworld', inventory: { stone_pickaxe: 1, stone_axe: 1, cobblestone: 20, oak_log: 3, crafting_table: 1 } },
  { name: 'ow-iron-kit-hungry', speedrunner: ['CraftPortalKit', 'MineIron'], why: 'железо есть, еды 0, сытость 10: набор и литьё, еда попутно',
    dimension: 'overworld', food: 10, inventory: { stone_pickaxe: 1, iron_ingot: 7, cobblestone: 20, crafting_table: 1, gravel: 2 } },
  { name: 'ow-kit-lava-unknown', speedrunner: ['GetWater', 'ScoutLava'], why: 'ведро и огниво, лава не видна',
    dimension: 'overworld', inventory: { iron_pickaxe: 1, stone_pickaxe: 1, bucket: 1, flint_and_steel: 1, cobblestone: 40, cooked_beef: 3 } },
  { name: 'ow-kit-lava-known', speedrunner: ['GetWater', 'LavaPoolPortal'], why: 'набор, лава видна, воды нет',
    dimension: 'overworld', inventory: { iron_pickaxe: 1, bucket: 1, flint_and_steel: 1, cobblestone: 40, cooked_beef: 3 }, known: { lava: { x: 30, y: 62, z: 10 } } },
  { name: 'ow-portal-food2', speedrunner: ['EnterNether', 'PrepareNether'], why: 'портал горит, еды 2 порции, сытость 18: вход (еда в Аду — цена, не ворота)',
    dimension: 'overworld', inventory: { ...ENTRY_KIT, cooked_porkchop: 2 }, known: { portal: { x: 5, y: 64, z: 5 } } },
  { name: 'ow-portal-food0', speedrunner: ['FindFood', 'PrepareNether'], why: 'портал горит, еды 0, сытость 12: быстрая охота у портала, если звери рядом',
    dimension: 'overworld', food: 12, inventory: without(ENTRY_KIT, 'cooked_porkchop'), known: { portal: { x: 5, y: 64, z: 5 } } },
  { name: 'ow-eyes-done', speedrunner: ['PrepareEnd', 'FindStronghold'], why: '12 очей наверху', dimension: 'overworld',
    inventory: { ...ENTRY_KIT, ender_eye: 12 }, known: { portal: { x: 5, y: 64, z: 5 } } },
  // Поток graph2 (ND_GRAPH2_BEDS): кровати на дракона (без них бой не начинается, 5 = 15 шерсти) — по пути, когда стадо на виду.
  { name: 'ow-sheep-4', speedrunner: ['CollectBedsNear'], why: 'каменные инструменты, стадо из 4 овец в 20 бл.: 4 шерсти сейчас (~40 с) дешевле поиска овец перед Краем',
    dimension: 'overworld', inventory: { stone_pickaxe: 1, stone_axe: 1, cobblestone: 20, oak_log: 3, crafting_table: 1 }, facts: { sheep_seen: 4 } },
  { name: 'ow-sheep-1', speedrunner: ['MineIron'], why: 'одна овца, шерсти нет: кровати не выйдет — мимо',
    dimension: 'overworld', inventory: { stone_pickaxe: 1, stone_axe: 1, cobblestone: 20, oak_log: 3, crafting_table: 1 }, facts: { sheep_seen: 1 } },
  { name: 'ow-eyes-sheep', speedrunner: ['CollectBedsNear', 'PrepareEnd'], why: '12 очей наверху, овцы у портала: шерсть сейчас',
    dimension: 'overworld', inventory: { ...ENTRY_KIT, ender_eye: 12 }, known: { portal: { x: 5, y: 64, z: 5 } }, facts: { sheep_seen: 3 } },
]

function main(args: string[]): void {
  const json = args.includes('--json')
  const names = args.filter(a => !a.startsWith('--'))
  const registry = graphRegistry()
  const out = []
  for (const s of SCENARIOS.filter(x => !names.length || names.includes(x.name))) {
    const state = scenarioState(s)
    const excluded = new Set(s.exhausted ?? [])
    const c = choose(registry, state, excluded)
    const steps = firstSteps(registry, state, excluded)
    const ok = c.first !== null && s.speedrunner.includes(c.first)
    out.push({ name: s.name, ok, graph: c.first, speedrunner: s.speedrunner, plan: c.steps.map(x => x.id), minutes: Math.round(c.cost / 20 / 6) / 10, steps })
    if (json) continue
    console.log(`\n${ok ? 'OK ' : 'XX '} ${s.name}: граф ${c.first ?? '—'} | спидраннер ${s.speedrunner.join('/')} — ${s.why}`)
    console.log(`    план: ${c.steps.map(x => x.id).join(' → ')} (${Math.round(c.cost / 1200)} мин с риском)`)
    for (const r of steps.slice(0, 8)) console.log(`    ${r.id.padEnd(24)} шаг ${String(r.seconds).padStart(6)} с  риск ${r.risk.toFixed(3)}  до дракона ${r.toGoalMin} мин`)
  }
  if (json) console.log(JSON.stringify(out, null, 1))
  else console.log(`\nсовпало с выбором спидраннера: ${out.filter(r => r.ok).length}/${out.length}`)
}

if (require.main === module) main(process.argv.slice(2))
