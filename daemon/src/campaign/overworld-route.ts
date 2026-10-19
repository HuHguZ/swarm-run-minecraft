// Маршрут по верхнему миру (сид / вслепую по увиденному): части — в overworld-route/ (seen, cave, travel, camp, supply,
// steps*), общее состояние — RouteState (types.ts).
import type { CampaignRouteContext, RouteState } from './overworld-route/types'
import { routeSeen } from './overworld-route/seen'
import { routeCave } from './overworld-route/cave'
import { routeTravel } from './overworld-route/travel'
import { routeCamp } from './overworld-route/camp'
import { routeSupply } from './overworld-route/supply'
import { routeSteps } from './overworld-route/steps'

export function createOverworldRoute(ctx: CampaignRouteContext) {
// Keep an actual unfinished fight across strategy interruptions. A failed retreat
// is not a completed escape (S23: the next filler mine dismantled the perch).
const rs: RouteState = { golemEncounter: null, caveMouth: null }
const seen = routeSeen(ctx)
const cave = routeCave(ctx, rs, seen)
const travel = routeTravel(ctx)
const camp = routeCamp(ctx)
const supply = routeSupply(ctx)
const { routeStep } = routeSteps(ctx, rs, { ...seen, ...cave, ...travel, ...camp, ...supply })
const { routeSeenRefresh, routeInfoGet } = seen
const { routeGo, routeShaftBackOn, routeRememberShaft, routeFurnaceSupply, routeReturnShaft, routeGoPush, routeBlockTarget, routeBlocks } = travel
const { routeSleep, routeBedLate, routeLeaveOutpost, routeAroundOutpost, routeFlintFromBag, routeRecover, routeHealToEnter } = camp
const { routeCookedHunger, routeCookHunger, routeFood, routeHunt, routeWater, castOneAt } = supply
return { routeSeenRefresh, routeInfoGet, routeGo, routeShaftBackOn, routeRememberShaft, routeFurnaceSupply, routeReturnShaft, routeGoPush, routeBlockTarget, routeBlocks, routeCookedHunger, routeCookHunger, routeFood, routeHunt, routeWater, castOneAt, routeSleep, routeBedLate, routeLeaveOutpost, routeAroundOutpost, routeFlintFromBag, routeRecover, routeHealToEnter, routeStep }
}
