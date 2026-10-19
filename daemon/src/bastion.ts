const { PLACE, admiring, angerSet, goldWorn, wearGold, makeIronPick, dropJunk }: typeof import('./bastion/take-gold-block') = require('./bastion/take-gold-block')
const { goldExposes, burrowColumn, burrow, sealBody, moveBarterSite, bastion }: typeof import('./bastion/bastion') = require('./bastion/bastion')
const { burrowIntent }: typeof import('./bastion/burrow-intent') = require('./bastion/burrow-intent')
const { pitAt, trapAt, exitReserveReady }: typeof import('./bastion/booth-trade') = require('./bastion/booth-trade')
const { baitAim, handNoWalk, dumpAim, pitJunk, throwLands, pitLures, unholdGold, tossLands }: typeof import('./bastion/predict-gold') = require('./bastion/predict-gold')

'use strict'

module.exports = { exitReserveReady, handNoWalk, moveBarterSite, makeIronPick, burrowColumn, goldExposes, burrow, burrowIntent, bastion, angerSet, admiring, goldWorn, wearGold, PLACE, pitAt, trapAt, baitAim, dumpAim, tossLands, throwLands, pitLures, unholdGold, sealBody, pitJunk, dropJunk }
export {
  exitReserveReady, handNoWalk, moveBarterSite, makeIronPick, burrowColumn, goldExposes, burrow, burrowIntent,
  bastion, angerSet, admiring, goldWorn, wearGold, PLACE, pitAt, trapAt, baitAim, dumpAim, tossLands, throwLands,
  pitLures, unholdGold, sealBody, pitJunk, dropJunk
}
