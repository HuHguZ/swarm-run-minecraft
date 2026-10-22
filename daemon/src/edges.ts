'use strict'
// Края, ямы и пустота: не упасть самому, выбить туда другого, пережить
// падение ведром воды. Арена в небе (2026-09-25): дыра в полу, бот «не
// увидел» её и разбился о землю в полусотне блоков внизу.
//
// Три слоя:
//  1. Рефлекс (guard): перед каждым тиком физики — не уведут ли нажатые
//     клавиши тело с обрыва. Считает той же физикой, что двигает тело
//     (prismarine-physics), с инерцией: спринт после отпускания клавиш
//     скользит ещё ~0.34 блока, прыжок с разбега уносит на 3-4. Опасно —
//     клавиши этого тика заменяются безопасными: без прыжка, без спринта,
//     тормоз, шаг от края, в воздухе — рулить от ямы. Ловит все пути сразу:
//     бой, еду и питьё на ходу, лук, выход из коробки, pathfinder.
//  2. Позиция (pvp.js): куда кинет нас его удар со спринтом и куда наш —
//     его (knock, backToDrop, pushPlan).
//  3. Ведро воды (installFallGuard): с высоты — вода под ноги в последний
//     тик, после приземления — обратно в ведро. Всегда, не только в бою.
//
// Числа — из игры: декомпиляция клиента 1.21.11 (extremeheat/
// extracted_minecraft_data, ветка client1.21.11).
// Тело модуля — src/edges/: forecast (прогноз и числа игры), reflex (guard), knockback, mlg (ведро воды), climb.
export { SAFE_FALL, KB_HIT, KB_SPRINT, column, support, lethalAt, clearance, hazardAround, run, stateOf, worldOf,
  simOf, cloneState, IDLE } from './edges/forecast'
export { guard } from './edges/reflex'
export { knockback, hitVelocity, knockRun, backToDrop, pullDrop, pushPlan, resistOf, dropAlong, fixSelfKnockback } from './edges/knockback'
export { installFallGuard, afterPacket, mlgDrop, priceDrops, mlgLandingBad, waterloggable, falling } from './edges/mlg'
export { findShaft, climbBack, fillerCount, gatherBlocks } from './edges/climb'
