'use strict'
// Звери и жители: приручить, посадить и поднять, развести, голем на железо, торговля с жителем, шерсть на кровать.
// Части — в fauna/: basics (общие помощники), animals (приручить, сидеть, развести), golem-spot (место над големом),
// golem (бой с големом), villagers (торговля), wool (шерсть).
export { castHazard, TAME, BREED, isTamed, isBaby } from './fauna/basics'
export { tame, breed, pet } from './fauna/animals'
export { golemReach, pillarSpotOk, golemTopNear, golemSpotNear, GOLEM_PILLAR } from './fauna/golem-spot'
export { golem, golemKill } from './fauna/golem'
export { trade } from './fauna/villagers'
export { wool, sheepAround, WOOL_COLORS } from './fauna/wool'
