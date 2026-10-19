'use strict'
// Чертёж постройки: части плана (стены, пол, крыша, двери, кровати, утварь) → клетки с блоками и свойствами, поворот
// фасада, готовые виды (хижина, дом, комната, склад, замок). Без бота и мира — только геометрия; мир — в architect.
// Части — в blueprint/: names (направления, фазы, палитра, имена блоков), compile (части → клетки, крыша),
// layout (поворот и раскладка), kinds (готовые виды).
export { DIRS, OPP, CW, HORIZONTAL, STEPS, PHASE, WOODS, STONES, key, vec, kindOf, itemFor, wallVariant, derived, palette } from './blueprint/names'
export { compileParts, signLines } from './blueprint/compile'
export { layout, rotateCells, bounds, turn } from './blueprint/layout'
export { KINDS, hut, house, room, storage, castle } from './blueprint/kinds'
