'use strict'
// От «крепость» в памяти до горящего портала в Край: дойти, уточнить точку оком,
// прокопаться вниз, найти портальную комнату по коридорам и вставить глаза в
// рамки (mc_stronghold mode=go / room / fill). Бросок ока и пересечение лучей —
// stronghold.js, здесь — всё, что после.
//
// Факты игры (байткод paper-1.21.11, разобран 2026-09-25):
//   * око летит к ChunkGenerator.findNearestMapStructure → getLocatePos стартового
//     чанка крепости: угол чанка (minBlockX, 0, minBlockZ), locateOffset у колец —
//     ZERO. Не к портальной комнате и не к середине чанка.
//   * EyeOfEnder.signalTo: дальше 12 блоков по горизонтали цель — 12 блоков в ту
//     сторону и +8 вверх; ближе — точная точка (око ныряет к y=0). Живёт 80 тиков,
//     потом падает предметом (80%) или бьётся (20%).
//   * старт крепости — StartPiece (StairsDown) 5x11x5 от (x0+2, 64, z0+2), вся
//     постройка потом сдвинута вниз (moveBelowSeaLevel, верх ниже seaLevel-10).
//     Значит, копать у (x0+4, z0+4) — попадаешь в лестничную башню старта.
//   * портальная комната есть всегда; её дверь не дальше 112 блоков по x и по z
//     от угла старта (generateAndAddPiece), глубина кусков до 50.
//   * комната 11x8x16: 12 рамок end_portal_frame на высоте пола+3, все смотрят
//     внутрь; под центром 3x3 — лава (пол+1), между ней и рамками воздух; лестница
//     к площадке (пол+3) и на средней верхней ступени — спавнер чешуйниц.
//     Каждая рамка с оком с шансом 10% (nextFloat() > 0.9).
//   * EnderEyeItem.useOn: блок end_portal_frame без ока → око встаёт, стак -1;
//     грань клика не проверяется. Когда все 12 с оком и смотрят внутрь — 3x3
//     end_portal на высоте рамок (getOrCreatePortalShape).
//   * end_portal: без коллизии, перенос в Край МГНОВЕННЫЙ (задержка 0), как только
//     хитбокс пересёк плиту y+0.375..0.75. Стоять на рамке безопасно (ноги на
//     +0.8125); опасно уйти хитбоксом целиком за край рамки над 3x3.

export { BRICKS, PLACE, ROOM } from './endportal/common'
export { shaftToBricks, cantDigThrough } from './endportal/shaft'
export { dryEntry } from './endportal/wet'
export { goStronghold, mappedStepRisk, goMappedRoom } from './endportal/go'
export { findRoom } from './endportal/room'
export { fillFrames, enterPortal } from './endportal/frames'
