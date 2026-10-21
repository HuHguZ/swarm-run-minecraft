'use strict'
// Ходьба тела: застревание и встряска, вода (выход на сушу, цена шага по воде), отрезок по XZ, ожидание pathfinder'а.
// Части — в movement/: basics (сон, координаты, застревание, встряска, центр клетки), water (вода: клетки, воздух, цена,
// маршрут вплавь), escape-water (выход из воды), travel (travelXZ), goto (gotoGoal, бег, удержание пути).
export { sleep, xyz, shaftFromDescent, standableY, describeStall, stuckGuard, unstick, centerOnFloor, waterBudgetOn } from './movement/basics'
export { findNearestLand, findSwimRoute, inWater, waterCell, waterStepCost, waterApproachCost, airTicks, owDeathWaterOn, owAirEmergency } from './movement/water'
export { escapeWater } from './movement/escape-water'
export { travelXZ } from './movement/travel'
export { gotoGoal, gotoPath, gotoWaitOn, sprintOn, pathKeepAlive, pathKeepAliveOn, timeoutWalkOn } from './movement/goto'
