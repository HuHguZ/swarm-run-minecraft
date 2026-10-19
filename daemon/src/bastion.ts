'use strict'
// Бастион — фасад: bastion() и то, что зовут снаружи (кампания, крепость, сцены, тесты). Тело — daemon/src/bastion/.
export { PLACE, admiring, angerSet, goldWorn, wearGold, makeIronPick, dropJunk } from './bastion/take-gold-block'
export { goldExposes, burrowColumn, burrow, sealBody, moveBarterSite, bastion } from './bastion/bastion'
export { burrowIntent } from './bastion/burrow-intent'
export { pitAt, trapAt, exitReserveReady } from './bastion/booth-trade'
export { baitAim, handNoWalk, dumpAim, pitJunk, throwLands, pitLures, unholdGold, tossLands } from './bastion/predict-gold'
