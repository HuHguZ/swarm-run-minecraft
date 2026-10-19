'use strict'
// Сборы перед долгим делом (preflight, у двери session.runIntent): что навыку нужно на теле (таблица NEEDS); броня и оружие
// из рюкзака — надеть и взять в руку (did), нехватка (факелы, еда, щит) — словами в ответе (need), без отказа. Части — в
// preflight/: table (бюджет, оружие, таблица нужд), needs (руки и рюкзак, подсказки, нужды по видам), clicks (надеть, взять
// в руку, перевооружиться), run (preflight, сводка).
export { requirements, NEEDS, PREFLIGHT_MS, FOOD_FOR_TRIP, FOOD_FROM_CELLS, MELEE, meleeScore, bestMelee } from './preflight/table'
export { foodInBag } from './preflight/needs'
export { rearm } from './preflight/clicks'
export { preflight, freshKit, summary } from './preflight/run'
