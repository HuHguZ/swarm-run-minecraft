const { PHASE, PHASE_RU, SITTING, PART, holdingOdds, dragonWaitBand, dragonWaitStop, KIT, BEDS_KIT, dragonOf, phaseOf, hpOf, makeTrack, partsOf, supportCell, offIsland, floorAt, runwayAhead, stepKeys, cloudZones, stepIntoZone, cloudsOf, starer, safePitch } = require('./dragon/dig-down-to')
const { straightOut, crystalsOf, breathOf, fallGuard, aboveCloudY, fastTower, wingBoxes, STAY_R, straightWalkable, awayFromHead } = require('./dragon/fall-guard')
const { waterToHotbar, onOwnPillar, onSpike, pillarHere, stationPlan } = require('./dragon/station-plan')
const { DAMAGE_TYPES, yRotOf, pushedForecast, closestNode, findNodePath, takeoffNode, blastPush, takeoffForecast, tsPlan, tsSecond, blastDestroyed, stationCells, stationWorld, tsOwnStation, tsOwnPlan } = require('./dragon/ts-plan')
const { kitOf, clearCrystalKnowledge, noteCrystalClear, crystalKitState, missing, bridgeToIsland, islandEdgeTop, tsAddStation, tsAPlan } = require('./dragon/bridge-to-island')
const { crystalShotSpot } = require('./dragon/crystal-shot-spot')
const { crystalTimingAllowed, meleeSpot, scanPredict, faceClick, pillarPlan, BED_GAP_MS, noteTakeoff, bedClickPoint, cellsOnSeg } = require('./dragon/pillar-plan')
const { earlyCrystalStep, crystalWait, sitState, blindKnown, dragonZones, bedsLayout, bedsDouble, pillarBuild, pillarRun } = require('./dragon/pillar-run')
const { dangerAt, SCAN_RANGE, noteNear, escapeSpot, msin, mcos, simStep, turnLanding, simHead, simNeck, landingForecast, predParts, landingHits, exposure, tsClickPoint, blastReaches, hurtNear, bedDamage } = require('./dragon/evade-raw')
const { takeoffAzOf, headAfterTakeoff, pillarPlanAuto } = require('./dragon/blind-pit')
const { dragon } = require('./dragon/dragon')

'use strict'

module.exports = { pillarHere, pillarPlanAuto,
  dragon,
  // для сцен и разбора
  crystalWait, crystalTimingAllowed, earlyCrystalStep,
  dragonOf, phaseOf, hpOf, partsOf, crystalsOf, cloudsOf, breathOf, starer, safePitch, meleeSpot, kitOf, missing,
  noteCrystalClear, clearCrystalKnowledge, crystalKitState,
  makeTrack, crystalShotSpot, bridgeToIsland, fallGuard, waterToHotbar, fastTower, stationPlan, PHASE, PHASE_RU, PART, SITTING, KIT,
  floorAt, runwayAhead, stepKeys, straightOut, dragonZones, dangerAt, wingBoxes, islandEdgeTop, awayFromHead, cloudZones, stepIntoZone,
  supportCell, offIsland, escapeSpot, noteNear, blindKnown, STAY_R, SCAN_RANGE, straightWalkable, onSpike, sitState, PHASE_SIT: SITTING,
  onOwnPillar, DAMAGE_TYPES, aboveCloudY,
  bedsLayout, bedClickPoint, hurtNear, bedDamage, BEDS_KIT, BED_GAP_MS, bedsDouble, cellsOnSeg, headAfterTakeoff, noteTakeoff, takeoffAzOf,
  simStep, simHead, simNeck, turnLanding, landingForecast, predParts, landingHits, yRotOf, msin, mcos, tsPlan, exposure, tsClickPoint,
  closestNode, findNodePath, takeoffNode, blastPush, takeoffForecast, tsSecond, blastReaches,
  holdingOdds, dragonWaitBand, dragonWaitStop,
  pillarPlan, pillarBuild, pillarRun, faceClick, scanPredict, tsAPlan, tsOwnPlan, tsOwnStation, tsAddStation, stationCells, blastDestroyed, stationWorld, pushedForecast
}

const alternateDragon = process.env.ND_DRAGON_IMPL

if (alternateDragon) {
  const alternatePath = require("node:path").resolve(__dirname, alternateDragon)
  if (alternatePath !== __filename) module.exports = require(alternatePath)
}
