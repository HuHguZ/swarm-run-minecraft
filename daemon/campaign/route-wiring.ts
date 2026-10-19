'use strict'
// Дальний маршрут (ND_ROUTE): состояние и переходники к src/campaign/overworld-route.
import { ROUTE } from './flags'
import { call } from './rpc'
import { manualControl, state, sit, hunting, died, known, descendLava, deepLava, skyLavaSeen, heardLava, surfaceShaft,
  routeEntered, routeFrame, routeHealing, setDeepLava, setDescendLava, setDied, setHunting, setManualControl,
  setRouteEntered, setRouteFrame, setRouteHealing, setSit, setState, setSurfaceShaft } from './state'
import { log } from './log'
import { have, y, dim, LOGS, COBBLE, RAW, FOOD, foodUnits, PICK_STONE, planksFor, woodNow, fillerCount, todNow,
  nightNow, lighter } from './queries'
import { acceptResult, sense, refresh, readMemory } from './observe'
import { stageRun } from './stages/table'
import { act } from './act'
import { answerThreat, leaveWater, waitDugOut } from './danger'
import { rest, nightGuard } from './guards'
import { goToward } from './travel'
import { ensureTable, craft, mineSeenAll, smeltAll } from './kit'
import { descend, toSurface } from './underground'
import { earlyShield } from './gear'
import { quickHunt, makeBed, cook, furnaceBack } from './food'
import { ensureFlint } from './portal-kit'
import { climbOwnShaft } from './scout'
import { listenForLava, deepCast } from './deep-cast'
import { enterNether } from './nether-trip'
import * as gameClock from '../src/game-clock'
import { createOverworldRoute } from '../src/campaign/overworld-route'
const routeMod = (() => { try { return (require('../src/route') as typeof import('../src/route')) } catch (e) { return null } })()
let routeInfoV
const routeAvoid = new Set<string>()
const routeDoneIds = new Set(String(process.env.ND_ROUTE_SKIP || '').split(',').map(x => x.trim()).filter(Boolean))
const routeFails = new Map()
function routeInfoGet (...args) { return routeSkills.routeInfoGet(...args) }
const rlog = line => log(`МАРШРУТ ${line}`)
async function routeGo (...args) { return routeSkills.routeGo(...args) }
function routeShaftBackOn (...args) { return routeSkills.routeShaftBackOn(...args) }
function routeRememberShaft (...args) { return routeSkills.routeRememberShaft(...args) }
async function routeFurnaceSupply (...args) { return routeSkills.routeFurnaceSupply(...args) }
async function routeReturnShaft (...args) { return routeSkills.routeReturnShaft(...args) }
async function routeGoPush (...args) { return routeSkills.routeGoPush(...args) }
function routeBlockTarget (...args) { return routeSkills.routeBlockTarget(...args) }
async function routeBlocks (...args) { return routeSkills.routeBlocks(...args) }
const ROUTE_COOKED_HUNGER = { cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6,
  cooked_chicken: 6, cooked_salmon: 6, cooked_cod: 5, cooked_rabbit: 5,
  bread: 5, baked_potato: 5, golden_carrot: 6 }
function routeCookedHunger (...args) { return routeSkills.routeCookedHunger(...args) }
function routeCookHunger (...args) { return routeSkills.routeCookHunger(...args) }
async function routeFood (...args) { return routeSkills.routeFood(...args) }
async function routeHunt (...args) { return routeSkills.routeHunt(...args) }
async function routeWater (...args) { return routeSkills.routeWater(...args) }
async function castOneAt (...args) { return routeSkills.castOneAt(...args) }
const ROUTE_SLEEP = process.env.ND_ROUTE_SLEEP !== '0'
const BED_BLOCKS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(c => `${c}_bed`).join(',')
let routeSleptAt = 0
async function routeSleep (...args) { return routeSkills.routeSleep(...args) }
let routeBedTries = 0
async function routeBedLate (...args) { return routeSkills.routeBedLate(...args) }
async function routeLeaveOutpost (...args) { return routeSkills.routeLeaveOutpost(...args) }
async function routeAroundOutpost (...args) { return routeSkills.routeAroundOutpost(...args) }
async function routeFlintFromBag (...args) { return routeSkills.routeFlintFromBag(...args) }
async function routeRecover (...args) { return routeSkills.routeRecover(...args) }
async function routeHealToEnter (...args) { return routeSkills.routeHealToEnter(...args) }
async function routeStep (...args) { return routeSkills.routeStep(...args) }

const routeSkills: any = createOverworldRoute({
get BED_BLOCKS () { return BED_BLOCKS },
get COBBLE () { return COBBLE },
get FOOD () { return FOOD },
get LOGS () { return LOGS },
get PICK_STONE () { return PICK_STONE },
get RAW () { return RAW },
get ROUTE () { return ROUTE },
get ROUTE_COOKED_HUNGER () { return ROUTE_COOKED_HUNGER },
get ROUTE_SLEEP () { return ROUTE_SLEEP },
get act () { return act },
get call () { return call },
get acceptResult () { return acceptResult },
get answerThreat () { return answerThreat },
get castOneAt () { return castOneAt },
get climbOwnShaft () { return climbOwnShaft },
get cook () { return cook },
get craft () { return craft },
get deepCast () { return deepCast },
get deepLava () { return deepLava }, set deepLava (value) { setDeepLava(value) },
get descend () { return descend },
get descendLava () { return descendLava }, set descendLava (value) { setDescendLava(value) },
get died () { return died }, set died (value) { setDied(value) },
get dim () { return dim },
get ensureFlint () { return ensureFlint },
get ensureTable () { return ensureTable },
get enterNether () { return enterNether },
get fillerCount () { return fillerCount },
get foodUnits () { return foodUnits },
get furnaceBack () { return furnaceBack },
get gameClock () { return gameClock },
get goToward () { return goToward },
get have () { return have },
get hunting () { return hunting }, set hunting (value) { setHunting(value) },
get known () { return known },
get leaveWater () { return leaveWater },
get lighter () { return lighter },
get makeBed () { return makeBed },
get manualControl () { return manualControl }, set manualControl (value) { setManualControl(value) },
get mineSeenAll () { return mineSeenAll },
get nightGuard () { return nightGuard },
get nightNow () { return nightNow },
get planksFor () { return planksFor },
get process () { return process },
get quickHunt () { return quickHunt },
get readMemory () { return readMemory },
get refresh () { return refresh },
get rest () { return rest },
get rlog () { return rlog },
get routeAroundOutpost () { return routeAroundOutpost },
get routeBedTries () { return routeBedTries }, set routeBedTries (value) { routeBedTries = value },
get routeBlockTarget () { return routeBlockTarget },
get routeBlocks () { return routeBlocks },
get routeCookHunger () { return routeCookHunger },
get routeEntered () { return routeEntered }, set routeEntered (value) { setRouteEntered(value) },
get routeFlintFromBag () { return routeFlintFromBag },
get routeFood () { return routeFood },
get routeFrame () { return routeFrame }, set routeFrame (value) { setRouteFrame(value) },
get routeFurnaceSupply () { return routeFurnaceSupply },
get routeGo () { return routeGo },
get routeGoPush () { return routeGoPush },
get routeHealToEnter () { return routeHealToEnter },
get routeHealing () { return routeHealing }, set routeHealing (value) { setRouteHealing(value) },
get routeHunt () { return routeHunt },
get routeInfoGet () { return routeInfoGet },
get skyLavaSeen () { return skyLavaSeen }, get heardLava () { return heardLava }, get listenForLava () { return listenForLava }, get routeAvoid () { return routeAvoid },
get routeInfoV () { return routeInfoV }, set routeInfoV (value) { routeInfoV = value },
get routeLeaveOutpost () { return routeLeaveOutpost },
get routeMod () { return routeMod },
get routeRememberShaft () { return routeRememberShaft },
get routeReturnShaft () { return routeReturnShaft },
get routeShaftBackOn () { return routeShaftBackOn },
get routeSleep () { return routeSleep },
get routeSleptAt () { return routeSleptAt }, set routeSleptAt (value) { routeSleptAt = value },
get routeWater () { return routeWater },
get sense () { return sense },
get sit () { return sit }, set sit (value) { setSit(value) },
get smeltAll () { return smeltAll },
get earlyShield () { return earlyShield },
get stageRun () { return stageRun },
get state () { return state }, set state (value) { setState(value) },
get surfaceShaft () { return surfaceShaft }, set surfaceShaft (value) { setSurfaceShaft(value) },
get toSurface () { return toSurface },
get todNow () { return todNow },
get waitDugOut () { return waitDugOut },
get woodNow () { return woodNow },
get y () { return y }
})

export { routeMod, routeAvoid, routeDoneIds, routeFails, routeInfoGet, rlog, routeBlocks, ROUTE_COOKED_HUNGER,
  routeCookedHunger, routeFood, routeHunt, ROUTE_SLEEP, routeSleep, routeBedLate, routeRecover, routeHealToEnter,
  routeStep, routeSkills }
