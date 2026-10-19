'use strict'
// Everything that needs a block UI open in front of the bot. Grouped in one
// file because furnaces and chests fail the same way on 1.21.11 — the server
// silently ignores the activation, mineflayer waits 20s for a window that never
// arrives, and a window left open wedges the body so nothing else can open one.
//
// The base lives here too (bottom of the file) rather than in survival.js: a
// base IS its stash, and the only thing that makes the stash cheap for the
// brain is that the cache is written by the very chest calls above it.
//
// Parts (daemon/src/containers/): window — walking up, opening, closing, guarding a window; fuel — smelt tables and
// fuel choice; furnace — smelt/takeFurnace; chest — chest list/put/take and the deposit/withdraw passes; base-record —
// the journal record of the base; base-spot — base-spot geometry; shelves — growing and checking the stash shelves;
// keep — the reserve list; base — base dispatcher; stash — stash dispatcher.
export { smelt, takeFurnace } from './containers/furnace'
export { conversionFuels } from './containers/fuel'
export { chestPut, chestTake, chestTakeMs, chestList } from './containers/chest'
export { base, baseNow } from './containers/base'
export { stash, stashNow } from './containers/stash'
// Exported the way build.js exports inPit: the choice rules and the reserve
// list are the two things worth checking without a server, and the autopilot
// will want surplusPlan the day it starts tidying up on its own.
export { pickBaseSpot } from './containers/base-spot'
export { surplusPlan } from './containers/keep'
// Запас, который не выбрасывается и не кладётся (pack.js: рюкзак полон).
export { keepFor } from './containers/keep'
export { readBase, BASE as BASE_PLACE } from './containers/base-record'
// Для архитектора и склада (architect.js, sorting.js): открыть сундук со
// всеми здешними обходами болезней окна и переложить за один заход.
export { findAndOpen } from './containers/chest'
export { guardWindow } from './containers/window'
export { depositPass, withdrawPass } from './containers/chest'
