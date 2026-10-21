// C2, выключен: вода — отдельная цена перехода и память фактически сорванного подхода.
import { Vec3 as WaterRouteVec3 } from 'vec3'
import { seesNow as routeSeesNow, entities as routeEntities } from '../perception/eyes'
import { waterCell as routeWater, airTicks as routeAirTicks, swimUpTicks as routeUpTicks, headWet as routeHeadWet } from '../movement/water'
const RouteMove: typeof import('mineflayer-pathfinder/lib/move') = require('mineflayer-pathfinder/lib/move')
const waterRouteEnv = name => typeof process !== 'undefined' ? process.env[name] : undefined
export const waterRouteOn = bot => waterRouteEnv('ND_OW_WATER_ROUTE') === '1' &&
  String(bot.game?.dimension || '').replace(/^minecraft:/, '') === 'overworld'
const routeCellKey = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const routePassable = b => !!b && b.boundingBox === 'empty' && !/lava|fire|cobweb/.test(b.name)
type RoutePoint = { x: number; y: number; z: number }
type WetFact = RoutePoint & { state: number | string }
type WaterFailure = { target: string; capability: string; cells: WetFact[]; count: number;
  plan: RoutePoint[]; wetPlan: RoutePoint[]; startAir: number; cause: string; foes: string }
type WaterRouteScope = { target: string; capability: string; previous: any; ticks: number;
  known: Map<string, any>; wet: Map<string, WetFact>; foes: RoutePoint[]; observe: () => void;
  changed: () => void; plan: RoutePoint[]; wetPlan: RoutePoint[]; startAir: number;
  risk?: { failures: WaterFailure[]; prices: Map<string, number> } }
const routeFoesKey = scope => scope.foes.map(p => `${Math.floor(p.x / 4)},${Math.floor(p.y / 4)},${Math.floor(p.z / 4)}`).sort().join('|')
const routeState = b => b?.stateId ?? `${b?.name}:${JSON.stringify(b?.getProperties?.() || {})}`
function waterCapability(bot) {
  // Вернувшийся полный воздух после shore не меняет пропускную способность озера.
  const items = bot.inventory?.items?.() || []
  const kit = items.filter(i => /(^|_)boat$|turtle_helmet|water_breathing/.test(i.name)).map(i => i.name).sort()
  const effects = Object.keys(bot.entity?.effects || {}).sort()
  return `${kit.join(',')}|${effects.join(',')}`
}
function routeKnown(bot, scope: WaterRouteScope, p) {
  const q = p.floored(), key = routeCellKey(q)
  if (!scope.known.has(key)) {
    const me = bot.entity.position
    const occupied = q.x === Math.floor(me.x) && q.z === Math.floor(me.z) &&
      q.y >= Math.floor(me.y) && q.y <= Math.floor(me.y + 1.62)
    const seen = occupied || !!bot.registry && routeSeesNow(bot, q)
    scope.known.set(key, seen ? bot.blockAt(q, false) : null)
  }
  return scope.known.get(key)
}
export function startWaterRoute(bot, { x, y = null, z, range = 2 }) {
  if (!waterRouteOn(bot)) return null
  const scope: WaterRouteScope = { target: `${bot.game.dimension}|${Math.floor(x)},${y == null ? '*' : Math.floor(y)},${Math.floor(z)}|${range}`,
    capability: waterCapability(bot), previous: bot._ndOwWaterRoute, ticks: 0,
    known: new Map(), wet: new Map(), foes: [], observe: () => {}, changed: () => {}, plan: [], wetPlan: [], startAir: routeAirTicks(bot) }
  scope.changed = () => { scope.known.clear(); scope.risk = undefined }
  scope.observe = () => {
    if (bot._ndOwWaterRoute !== scope) return
    if (++scope.ticks === 1 || scope.ticks % 10 === 0) {
      scope.changed()
      scope.foes = bot.registry ? routeEntities(bot, { radius: 20 }).filter(e => e.seen && e.name === 'drowned').map(e => e.pos) : []
    }
    const p = bot.entity.position.floored()
    const feet = bot.blockAt(p, false), head = bot.blockAt(p.offset(0, 1, 0), false)
    if (routeWater(feet) && routeWater(head)) {
      scope.wet.delete(routeCellKey(p))
      scope.wet.set(routeCellKey(p), { x: p.x, y: p.y, z: p.z, state: routeState(feet) })
      if (scope.wet.size > 128) scope.wet.delete(scope.wet.keys().next().value)
    }
    // Pathfinder 2.4.5 index:611 доверяет isInWater, который на 1.21.11
    // отстаёт от тела. Его штатный плавательный ход — jump, без sprint.
    const active = bot._ndReflexSession?._reflexState?.active
    if (!active && !bot.vehicle && bot.pathfinder?.isMoving?.() && (routeWater(feet) || routeWater(head)) &&
        !bot.pathfinder.isMining?.() && !bot.pathfinder.isBuilding?.()) {
      bot.setControlState?.('jump', true)
      bot.setControlState?.('sprint', false)
    }
  }
  bot._ndOwWaterRoute = scope
  scope.observe()
  bot.on?.('physicsTick', scope.observe)
  bot.on?.('blockUpdate', scope.changed)
  return scope
}
export function stopWaterRoute(bot, scope) {
  if (!scope) return
  bot.removeListener?.('physicsTick', scope.observe)
  bot.removeListener?.('blockUpdate', scope.changed)
  if (bot._ndOwWaterRoute === scope) bot._ndOwWaterRoute = scope.previous
}
function routeFailures(bot, scope: WaterRouteScope): WaterFailure[] {
  if (scope.risk) return scope.risk.failures
  const failures: WaterFailure[] = bot._ndOwWaterFailures || []
  const active = failures.filter(f => f.target === scope.target && f.capability === scope.capability &&
    (f.cause !== 'drowned' || f.foes === routeFoesKey(scope)) &&
    // Сброс только по изменившемуся увиденному месту/снаряжению, не по таймеру.
    !f.cells.some(p => { const b = routeKnown(bot, scope, new WaterRouteVec3(p.x, p.y, p.z)); return b && routeState(b) !== p.state }))
  const prices = new Map<string, number>()
  for (const f of active) {
    const cells = new Set<string>()
    for (const p of f.cells) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      cells.add(`${p.x + dx},${p.y + dy},${p.z + dz}`)
    for (const key of cells) prices.set(key, (prices.get(key) || 0) + Math.min(240, 60 * f.count))
  }
  scope.risk = { failures: active, prices }
  return active
}
export function recordWaterRouteFailure(bot, scope, by) {
  if (!scope || !waterRouteOn(bot) || by?.type !== 'tactical' || !routeHeadWet(bot)) return
  if (routeAirTicks(bot) > 120 && !scope.foes.length) return // бой/лечение в воде сами по себе не отказ водного пути
  // Синхронный abort capture только читает тело: клавиши уже принадлежат тактике.
  const p = bot.entity.position.floored(), feet = bot.blockAt(p, false)
  if (routeWater(feet)) {
    scope.wet.delete(routeCellKey(p))
    scope.wet.set(routeCellKey(p), { x: p.x, y: p.y, z: p.z, state: routeState(feet) })
  }
  if (!scope.wet.size) return
  const cells: WetFact[] = [...scope.wet.values()]
  const last = cells.at(-1)
  const failures: WaterFailure[] = bot._ndOwWaterFailures ||= []
  const same = failures.find(f => f.target === scope.target && f.capability === scope.capability &&
    f.cells.some(p => p.x === last.x && p.y === last.y && p.z === last.z))
  const cause = routeAirTicks(bot) <= 120 ? 'air' : scope.foes.length ? 'drowned' : 'water'
  if (same) {
    same.count++; same.cells = cells; same.plan = scope.plan; same.wetPlan = scope.wetPlan; same.startAir = scope.startAir
    same.cause = cause; same.foes = routeFoesKey(scope)
  } else failures.push({ target: scope.target, capability: scope.capability, cells, count: 1,
    plan: scope.plan, wetPlan: scope.wetPlan, startAir: scope.startAir, cause, foes: routeFoesKey(scope) })
  bot._ndOwWaterFailures = failures.slice(-8)
  scope.risk = undefined
}
export function waterRouteRefusal(bot, scope, path) {
  if (!scope || !waterRouteOn(bot) || !path?.length) return null
  const plan = path.map(p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }))
  scope.plan = plan
  scope.wetPlan = plan.filter(p => {
    const at = new WaterRouteVec3(p.x, p.y, p.z)
    return routeWater(routeKnown(bot, scope, at)) && routeWater(routeKnown(bot, scope, at.offset(0, 1, 0)))
  })
  for (const f of routeFailures(bot, scope)) {
    const terminal = f.cells.at(-1), match = p => p.x === terminal.x && p.y === terminal.y && p.z === terminal.z
    const previousAt = f.plan.findIndex(match), nextAt = plan.findIndex(match)
    if (previousAt < 0 || nextAt < 0) continue // исполнение отошло от плана: лишь цена фактической неудачи
    const previousTail = f.plan.slice(previousAt), nextTail = plan.slice(nextAt)
    const previousWetAt = f.wetPlan.findIndex(match), nextWetAt = scope.wetPlan.findIndex(match)
    if (previousWetAt < 0 || nextWetAt < 0 || scope.startAir > f.startAir) continue
    const sameDive = JSON.stringify(f.wetPlan.slice(0, previousWetAt + 1)) === JSON.stringify(scope.wetPlan.slice(0, nextWetAt + 1))
    if (sameDive && previousTail.length > 1 && JSON.stringify(previousTail) === JSON.stringify(nextTail))
      return 'тот же затопленный подход уже прерван тактикой; нужен другой путь или изменение увиденной причины'
  }
  return null
}
export function waterRouteCost(bot, block, scope: WaterRouteScope = bot._ndOwWaterRoute) {
  if (!waterRouteOn(bot) || !scope || !block?.position) return 0
  const p = block.position
  routeFailures(bot, scope)
  let cost = scope.risk.prices.get(routeCellKey(p)) || 0
  const wet = routeKnown(bot, scope, p)
  if (!routeWater(wet)) return cost
  let depth = 0
  for (let dy = 1; dy <= 16; dy++) {
    if (!routeWater(routeKnown(bot, scope, p.offset(0, dy, 0)))) break
    depth++
  }
  const walkTicks = (1 - .546) / (.1 * .98 * ((bot.food ?? 20) > 6 ? 1.3 : 1))
  const swimTicks = (1 - .8) / (.02 * .98) // штатный нескользящий водный ход pathfinder
  const returnTicks = routeUpTicks(depth)
  const hp = 2 * Math.ceil(Math.max(0, swimTicks + returnTicks - routeAirTicks(bot) - 20) / 20)
  cost += Math.max(0, swimTicks / walkTicks - 1) + (depth ? 2 + returnTicks / walkTicks : 0) + hp
  const level = Number(wet.getProperties?.().level ?? 0)
  if (level > 0) cost += level >= 8 ? 40 : 4
  for (const foe of scope.foes) cost += Math.max(0, 8 - Math.hypot(foe.x - p.x, foe.y - p.y, foe.z - p.z)) * 2
  return cost
}
export function priceWaterMoves(bot, movements) {
  const nativeNeighbors = movements.getNeighbors.bind(movements)
  movements.getNeighbors = node => {
    const moves = nativeNeighbors(node), scope: WaterRouteScope = bot._ndOwWaterRoute
    if (!waterRouteOn(bot) || !scope) return moves
    const add = p => {
      if (moves.some(n => n.x === p.x && n.y === p.y && n.z === p.z)) return
      const feet = routeKnown(bot, scope, p), head = routeKnown(bot, scope, p.offset(0, 1, 0))
      if (!routeWater(feet) || !routePassable(feet) || !routePassable(head)) return
      const nativeFeet = movements.getBlock(p, 0, 0, 0), nativeHead = movements.getBlock(p, 0, 1, 0), breaks = []
      // Дополнительное ребро сохраняет native safety/cost (мобы, лава,
      // strict-крыша, exclusion). Новый водный риск прибавляется уже ниже.
      const cost = 1 + movements.exclusionStep(nativeFeet) + movements.safeOrBreak(nativeHead, breaks) + movements.safeOrBreak(nativeFeet, breaks)
      if (breaks.length || cost > 100 || !Number.isFinite(cost)) return
      moves.push(new RouteMove(p.x, p.y, p.z, node.remainingBlocks, cost, [], []))
    }
    const from = new WaterRouteVec3(node.x, node.y, node.z)
    // Реальная водная клетка с воздухом над головой, а не воображаемый пол:
    // native getLandingBlock начинает с y-2 и пропускает верхнюю воду под берегом.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, -1, 1]) {
      const p = from.offset(dx, dy, dz)
      const head = routeKnown(bot, scope, p.offset(0, 1, 0))
      if (!routeWater(head) && routePassable(head) && (dy <= 0 || routePassable(routeKnown(bot, scope, from.offset(0, 2, 0))))) add(p)
    }
    // Из уже затопленного кармана можно плыть вверх: native getMoveUp отклоняет liquid.
    if (routeWater(routeKnown(bot, scope, from))) add(from.offset(0, 1, 0))
    for (const move of moves) move.cost += waterRouteCost(bot, { position: new WaterRouteVec3(move.x, move.y, move.z) }, scope)
    return moves
  }
}
