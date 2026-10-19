'use strict'
// The fourth milestone: a way out of the overworld. `build` is deliberately
// narrow — frame, fire, and the coordinates in memory; it never walks in (see
// WHY_NOT_THROUGH). Going through is `enter` at the bottom of this file: its own
// memory per world (worlds.js portalKey) and its own witness of arrival
// (worlds.js installWorldTracker).
//
// Parts (daemon/src/nether/): shape — frame geometry and block predicates; plan — judging a site, the portal
// memory, shortfalls, the exit kit; dig — clearing cells and the bore; walk — guarded walking to a point; frame —
// building and lighting the frame (portal, link); enter — finding a lit portal and going through.
export {
  sameCell, innerCells, frameCells, cornerCells, propFor, reader, FRAME_MIN, INNER_W, INNER_H, FRAME_BLOCK,
  IGNITERS, OBSIDIAN_TOOLS, OBSIDIAN_SECONDS, MAX_DIG
} from './nether/shape'
export {
  exitKit, portalNow, planPortal, judge, frameAt, findFrames, standSpots, standable, obsidianShortfall,
  propShortfall, igniterShortfall, portalNote, PORTAL
} from './nether/plan'
export { clearCells, bore } from './nether/dig'
export { walkToward, guarded } from './nether/walk'
export { portalExport as portal, placeLeash, MINEFLAYER_PLACE_WAIT_MS, WHY_NOT_THROUGH } from './nether/frame'
export {
  enter, findLitPortal, notForeign, describePortal, doorways, clearStand, doorwayPlan, prepareDoorway,
  portalChanged
} from './nether/enter'
