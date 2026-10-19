'use strict'
const FOOD_MOBS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'])
const FOOD = /^(cooked_.+|beef|porkchop|mutton|chicken|rabbit|cod|salmon|bread|baked_potato|golden_carrot|apple|carrot|sweet_berries|melon_slice|pumpkin_pie|golden_apple|mushroom_stew|beetroot_soup|rabbit_stew|dried_kelp|cookie)$/
const DROPS = { cow: ['beef'], mooshroom: ['beef'], pig: ['porkchop'], sheep: ['mutton', 'wool'],
  chicken: ['chicken', 'feather'], rabbit: ['rabbit', 'rabbit_hide', 'rabbit_foot'],
  blaze: ['blaze_rod'], enderman: ['ender_pearl'], spider: ['string', 'spider_eye'],
  cave_spider: ['string', 'spider_eye'], skeleton: ['arrow', 'bone'], stray: ['arrow', 'bone'],
  bogged: ['arrow', 'bone'], parched: ['arrow', 'bone', 'tipped_arrow'], creeper: ['gunpowder'], zombie: ['rotten_flesh'],
  witch: ['redstone', 'glowstone_dust', 'sugar', 'gunpowder', 'spider_eye', 'stick', 'glass_bottle'] }
const DEFAULTS = { mode: 'free', arrowReserve: 16, foodTarget: 8,
  resources: { blaze_rod: 7, ender_pearl: 14, string: 3 } }

function quantity (name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 4096) throw new Error(`${name}: нужно целое число от 0 до 4096`)
  return value
}
function configure (current, patch: any = {}) {
  const next = { ...DEFAULTS, ...current, resources: { ...DEFAULTS.resources, ...current?.resources } }
  if (patch.mode !== undefined) {
    if (!['speedrun', 'free'].includes(patch.mode)) throw new Error('режим: speedrun или free')
    next.mode = patch.mode
  }
  for (const key of ['arrowReserve', 'foodTarget']) if (patch[key] !== undefined) next[key] = quantity(key, patch[key])
  if (patch.resources !== undefined) {
    if (!patch.resources || typeof patch.resources !== 'object' || Array.isArray(patch.resources)) throw new Error('resources: нужна карта предмет -> требуемое количество')
    for (const [name, count] of (Object.entries(patch.resources) as [string, any][])) {
      if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`неверное имя ресурса: ${name}`)
      next.resources[name] = quantity(name, count)
    }
  }
  return next
}
function inventory (session) {
  const inv = {}
  for (const item of session.bot?.inventory?.items() || []) inv[item.name] = (inv[item.name] || 0) + item.count
  return inv
}
// Сытость предмета (единицы голода, данные 1.21). Запас еды — в «кусках» по
// 6 единиц (жареная баранина): 8 арбузных долек не равны 8 стейкам, а лечение
// в бою ест около 1.5 единицы на 1 хп. Сильная еда — один кусок (счёт прежний),
// сырое мясо — тоже (его жарят). Общая мера для демона и кампании.
const HUNGER = { melon_slice: 2, sweet_berries: 2, glow_berries: 2, cookie: 2, dried_kelp: 1, carrot: 3,
  apple: 4, golden_apple: 4, bread: 5, baked_potato: 5, cooked_cod: 5, cooked_rabbit: 5 }
function foodUnits (inv) {
  let n = 0
  for (const [k, v] of ((Object.entries(inv || {}) as [string, any][]) as any)) if (FOOD.test(k)) n += v * Math.min(1, (HUNGER[k] ?? 6) / 6)
  return Math.round(n * 100) / 100
}
// Nutrition is what can be eaten now; raw meat's stock credit above assumes cooking.
// Only nutrition is read from minecraft-data: its saturation field is not a vanilla value.
let foods
function foodPoints (inv) {
  foods ||= (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11').foodsByName
  return Object.entries(inv || {}).reduce((n, [name, count]: any) => n + (FOOD.test(name) ? (foods[name]?.foodPoints || 0) * count : 0), 0)
}
function foodMeal (inv, hunger) {
  foodPoints(inv)
  const inventory = {}
  let points = 0; let ticks = 0
  const edible = Object.entries(inv || {}).filter(([name, count]: any) => count > 0 && FOOD.test(name) && foods[name])
    .sort(([a], [b]) => foods[b].foodPoints + foods[b].saturation - (b === 'chicken' ? 100 : 0) -
      foods[a].foodPoints - foods[a].saturation + (a === 'chicken' ? 100 : 0))
  for (const [name, count] of edible as [string, number][]) {
    const used = Math.min(count, Math.ceil((20 - hunger) / foods[name].foodPoints))
    if (used <= 0) break
    inventory[name] = -used
    points += used * foods[name].foodPoints
    ticks += used * (name === 'dried_kelp' ? 16 : 32) // 1.21.11 Consumables: kelp 0.8s, normal food 1.6s
    hunger = Math.min(20, hunger + used * foods[name].foodPoints)
  }
  return { inventory, hunger, points, ticks, units: foodUnits(Object.fromEntries(Object.entries(inventory).map(([name, n]: any) => [name, -n]))) }
}
function amount (inv, name) {
  if (name === 'food') return foodUnits(inv)
  if (name === 'wool') return (Object.entries(inv) as [string, any][]).reduce((n: any, [k, v]: any) => n + (/_wool$/.test(k) ? v : /_bed$/.test(k) ? 3 * v : 0), 0)
  if (name === 'ender_pearl') return (inv.ender_pearl || 0) + (inv.ender_eye || 0)
  if (name === 'blaze_rod') return (inv.blaze_rod || 0) + Math.floor((inv.blaze_powder || 0) / 2) + Math.floor((inv.ender_eye || 0) / 2)
  if (name === 'string') return (inv.string || 0) + (inv.bow ? 3 : 0)
  if (name === 'arrow') return (Object.entries(inv) as [string, any][]).reduce((n: any, [k, v]) => n + (/arrow$/.test(k) ? v : 0), 0)
  return inv[name] || 0
}
function canUseRanged (session, entity, opts: any = {}) {
  if (typeof opts.allowRanged === 'boolean') return opts.allowRanged
  const policy = session.playPolicy || DEFAULTS
  if (policy.mode !== 'speedrun') return true
  if (FOOD_MOBS.has(entity.name) || entity.name === 'enderman') return false
  return amount(inventory(session), 'arrow') > (policy.arrowReserve ?? DEFAULTS.arrowReserve)
}
// Решение о бое: skip — не драться (stopped — почему), clearArea — радиус зачистки.
interface FightDecision { skip: boolean; clearArea: number; purpose: string; stopped?: string }
function decideFight (session, entity, opts: any = {}): FightDecision {
  const policy = session.playPolicy || DEFAULTS
  const speedrun = policy.mode === 'speedrun'
  const purpose = opts.purpose || (opts.target ? 'command' : 'defense')
  const clearArea = opts.clearArea ?? (speedrun || FOOD_MOBS.has(entity.name) ? 0 : 10)
  const decision = { skip: false, clearArea, purpose }
  if (!speedrun || purpose === 'command' || purpose === 'defense') return decision
  const inv = inventory(session)
  if (purpose === 'food') {
    if (!FOOD_MOBS.has(entity.name) || amount(inv, 'food') >= (policy.foodTarget ?? DEFAULTS.foodTarget)) {
      return { ...decision, skip: true, stopped: 'охота не нужна: запас еды уже достаточен или цель не даёт нужную еду' }
    }
  } else if (purpose === 'resource') {
    const goals = opts.resourceGoal ? { [opts.resourceGoal.item]: quantity('resourceGoal.count', opts.resourceGoal.count) }
      : policy.resources || DEFAULTS.resources
    const useful = (DROPS[entity.name] || []).some(name => (goals[name] || 0) > amount(inv, name))
    if (!useful) return { ...decision, skip: true, stopped: 'бой не приближает к цели: нужный дроп уже собран или от этого моба не требуется' }
  } else throw new Error('purpose: food, resource, defense или command')
  return decision
}
export { configure, canUseRanged, decideFight, foodUnits, foodPoints, foodMeal }
