// Паркур на нативной физике клиента: прыжок по прогнозу кадров, посадка, вода и паутина, маршрут по опорам. Части — в
// navigation/parkour/: model (типы тела, константы, физика кадра), search (поиск прыжка), execute (исполнение плана),
// water (вода, паутина, мягкая посадка), moves (край, лестница, спуск, дверь), route (маршрут по опорам), navigate.
export { ROUTE_FRAMES, JUMP_FRAMES, FORECAST_TTL_MS, forecastOwner, IDLE, withinArena, arenaAround, visibleLanding, reboundApex, chainApex, MAX_FALL_DAMAGE, simulatePlan, settledLanding } from './parkour/model'
export type { Control, State, Step, WaterLaunch, MovementBot, Cancellation, PlanningDiagnostics, MovementArena, JumpOptions, JumpPlan } from './parkour/model'
export { planJump, reboundCeiling, planJumpAsync } from './parkour/search'
export { bodyObservation, executeJump, ledgeTo, executePlan } from './parkour/execute'
export { planWebCatch, inWaterCell, planImpulseLanding, planNearbySoftLanding, planImpulseLandingAsync, planWaterEntry, planNearbyWaterEntry, enterWater, catchWeb } from './parkour/water'
export { holdEdge, climb, openDoor } from './parkour/moves'
export { route, localOptions, combatHop, tryLocal } from './parkour/route'
export { navigate } from './parkour/navigate'
