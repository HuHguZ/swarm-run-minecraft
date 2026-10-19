'use strict'
// Шаг маршрута (routeStep): бой с големом, охота перед спуском, кремень из гравия — и шаг своего вида (steps-gather, steps-ore,
// steps-cast). Голем, не добитый до прерывания стратегии, — общее состояние маршрута (rs.golemEncounter).
import type { CampaignRouteContext, RouteState } from './types'
import type { routeSeen } from './seen'
import type { routeCave } from './cave'
import type { routeTravel } from './travel'
import type { routeCamp } from './camp'
import type { routeSupply } from './supply'
import { routeStepsGather } from './steps-gather'
import { routeStepsOre } from './steps-ore'
import { routeStepsFlint } from './steps-flint'
import { routeStepsCast } from './steps-cast'

export type RouteHelpers = ReturnType<typeof routeSeen> & ReturnType<typeof routeCave> & ReturnType<typeof routeTravel> &
  ReturnType<typeof routeCamp> & ReturnType<typeof routeSupply> & { ironNow: () => number, retreatFromGolem: () => Promise<boolean> }

export function routeSteps (ctx: CampaignRouteContext, rs: RouteState, helpers: Omit<RouteHelpers, 'ironNow' | 'retreatFromGolem'>) {
const { needFlint } = helpers
// Keep an actual unfinished fight across strategy interruptions. A failed retreat
// is not a completed escape (S23: the next filler mine dismantled the perch).
async function retreatFromGolem () {
  const to = rs.golemEncounter?.to
  if (!to) return true
  const r = await ctx.act('goto', { ...to, range: 6, timeoutSeconds: 40, retreat: true, sprint: true })
  await ctx.refresh()
  if (r.status !== 'done' || !ctx.state.pos || Math.hypot(ctx.state.pos.x - to.x, ctx.state.pos.z - to.z) > 6) return false
  const o = await ctx.act('observe', { radius: 32 })
  const entities = o.detail?.entities
  // Mob1.21.11's default follow range is 16; IronGolem does not override it.
  // Check the actual visible pursuer after arrival, not just displacement from home.
  if (!Array.isArray(entities) || entities.some(e => /iron[ _]?golem/i.test(String(e.name || '')) && e.dist <= 16)) return false
  rs.golemEncounter = null
  return true
}
const ironNow = () => ctx.have('iron_ingot') + ctx.have('raw_iron') + Math.floor(ctx.have('iron_nugget') / 9)
const h: RouteHelpers = { ...helpers, ironNow, retreatFromGolem }
const { stepWood, stepBed, stepStone, stepRuin, stepVillage, stepTreasure, stepShip } = routeStepsGather(ctx, rs, h)
const { stepOre, stepMine, stepSmelt, stepFood, stepWater } = routeStepsOre(ctx, rs, h)
const { stepFlint } = routeStepsFlint(ctx, rs, h)
const { stepCastSky, stepCastCave, stepScoutIron, stepLookout, stepScoutLava, stepCave, stepLight, stepIronStage, stepEnter } = routeStepsCast(ctx, rs, h)

async function routeStep (s) {
  await ctx.refresh()
  await ctx.earlyShield?.()
  if (rs.golemEncounter && ctx.state.pos) {
    const g = await ctx.act('golem', { mode: 'kill', radius: 64, timeoutSeconds: 30, angry: true })
    if (g.detail?.killed) rs.golemEncounter = null
    else if (!(await retreatFromGolem())) return false
  }
  // S8d: гравий в рюкзаке (колодец, штрек, пещера) — кремень сразу, ~15 с, а не на шаге flint через 5–8 мин (s8d-a-v1-3: гравий ×5
  // с 3-й мин, кремень искали с 11-й — ночью). ND_ROUTE_EARLYFLINT=0 — выкл.
  // S8d: ранен и есть нечего — перед спуском (пещера, этап железа) охота поверху: под землёй без еды хп не растёт (s8d-c-v1-1: хп 8
  // с 3-й по 15-ю мин в штреках, «лечение 2200 т»). ND_ROUTE_HUNTFIRST=0 — выкл.
  if (/^(cave|ironStage)$/.test(s.kind) && (ctx.state.health ?? 20) < 14 && typeof ctx.foodUnits === 'function' && ctx.foodUnits() < 2 && ctx.process.env.ND_ROUTE_HUNTFIRST !== '0' && !ctx.died) {
    await ctx.sense()
    if (ctx.sit.surface) { ctx.rlog(`хп ${Math.round(ctx.state.health ?? 0)}, еды нет — сперва охота поверху`); await ctx.routeHunt(48, 60) }
  }
  if (!/^(wood|stone|flint|enter)$/.test(s.kind) && ctx.have('gravel') > 0 && typeof ctx.lighter === 'function' && needFlint() &&ctx.process.env.ND_ROUTE_EARLYFLINT !== '0' && !ctx.died) await ctx.routeFlintFromBag()
  switch (s.kind) {
    case 'wood': return stepWood(s)
    case 'bed': return stepBed(s)
    case 'stone': return stepStone(s)
    case 'ruin': return stepRuin(s)
    case 'village': return stepVillage(s)
    case 'treasure': return stepTreasure(s)
    case 'ship': return stepShip(s)
    case 'ore': return stepOre(s)
    case 'mine': return stepMine(s)
    case 'smelt': return stepSmelt(s)
    case 'flint': return stepFlint(s)
    case 'food': return stepFood(s)
    case 'water': return stepWater(s)
    case 'castSky': return stepCastSky(s)
    case 'castCave': return stepCastCave(s)
    case 'scoutIron': return stepScoutIron(s)
    case 'lookout': return stepLookout(s)
    case 'scoutLava': return stepScoutLava(s)
    case 'cave': return stepCave(s)
    case 'castDeep':
    case 'giveup':
      return 'delegate'
    case 'light': return stepLight(s)
    case 'ironStage': return stepIronStage(s)
    case 'enter': return stepEnter(s)
  }
  return false
}
return { routeStep }
}
