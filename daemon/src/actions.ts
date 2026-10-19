'use strict'
// Тело модуля — src/actions/: gather (mine, explore, подбор), place, craft, food (eat; RISKY_FOOD и NOT_ACTUALLY_FOOD
// берёт и preflight: «еда в дорогу» считается по тем же правилам, что выбирает bestFood), bed, dig-down
// (digDown, digStairs) с drop-judge, stair-steps и descent-guard.
export { mine, explore, collectNearbyDrops, reachBlock } from './actions/gather'
export { place } from './actions/place'
export { craft, ensureTable } from './actions/craft'
export { equip, eat, drop, RISKY_FOOD, NOT_ACTUALLY_FOOD, bestFood } from './actions/food'
export { sleepInBed, wakeUp, placeBed, bedHalves, describeBed } from './actions/bed'
export { digDown, digStairs } from './actions/dig-down'
export { GROUPS } from './items'
const swarmWork = (...args: Parameters<typeof import('./swarm-work').swarmWork>) => (require('./swarm-work') as typeof import('./swarm-work')).swarmWork(...args)
export { swarmWork }
