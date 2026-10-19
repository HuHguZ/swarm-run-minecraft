'use strict'
// Общее состояние прогона: переменные, которые читают и пишут разные части. Пишут их только через сеттеры отсюда
// (импорт ES-модуля только для чтения); чтение — как раньше, по имени.
import * as gameClock from '../src/game-clock'
let T0 = gameClock.now()
gameClock.changes.once('bound', clock => { if (clock) T0 = clock.now() })
let stage = '-'
let manualControl = false
let strategyExecuting = false
let strategyInterrupted = false
// Исполнитель стратегии, которого директор снял по тайм-ауту или прерыванию: директор возвращает ход сразу
// (strategy.ts run: Promise.race), а исполнитель ещё разматывается с поднятыми флагами — главный цикл ждёт его.
let strategyTail: Promise<unknown> = Promise.resolve()
let tacticalRevision = 0
let state: any = {}
let sit: any = {}
let memorySnapshot = null

let refugeSeenAt = 0
let lastRefuge = null
let hunting = false
let restIdleUntil = 0
let died = false
let lostBag = null
let lostAt = null
let resting = false
let fighting = false
// Место нападения из воды (утопленник с трезубцем): разведка туда не ходит 5 игр. мин. cl-o 14.10: тактика отбегала на 1–7 бл.,
// этап литья звал ту же разведку вдоль берега — пять попаданий, смерть днём на 26-й мин (утопленники: 6 смертей из 30 прогонов).
let dangerZone = null
let detached = false

const known: any = { portal: null, netherPortal: null, fortress: null, bastion: null, stronghold: null, endPortal: null, dragonWon: false, spawnBed: null }

// Курс поиска еды поверху. ND_HEADING — заданный курс в радианах (лаборатория еды try-lab-food: у пары один курс).
let heading = process.env.ND_HEADING ? Number(process.env.ND_HEADING) : Math.random() * 2 * Math.PI
let descendLava = null

let stairEntrance = null
let fightGearWanted = false

let netherExplored = 0
let netherViewRevision = 0
let foodHuntEmpty = 0
let foodSpentMs = 0

let quickHuntAt = 0
let nightHeld = false

let waterSearchView = '', waterSearchFailedView = ''
let castSurfaceFailed = false
let deepLava = null // лава за блоком у штрека (чутьё безопасности) — ориентир окна
let skyLavaSeen = (() => { try { const h = process.env.ND_OW_LAVA_HINT ? JSON.parse(process.env.ND_OW_LAVA_HINT) : null; return h && Number.isFinite(h.x) ? { x: h.x, y: h.y, z: h.z, hint: true } : null } catch { return null } })()

let naturalTried = 0
// Взгляд вдаль на лаву под небом (portal_natural survey: верх столбцов в 128 бл., луч видимости из глаз — как игрок, который
// осмотрелся): озеро лавы светится и видно издалека, а observe 64 и explore 48 его не видели (cl-k 14.10: озеро в 50 бл. от
// спавна, разведка ушла на север; ни один из 22 прогонов cl-a…cl-k не дошёл до литья). Годное озеро — в known.lava.
let skyLookAt = null
let lavaSourceKnown = false

let heardLava = null
let surfaceShaft = null // колодец глубокого пути от поверхности одной колонной: { x, z, top, bottom }
let shaftWaterSeen = null // вода, видная с устья этого колодца перед спуском
let waterDeepFailAt = 0 // глубокий путь: вода штреками не нашлась — этап воды ждёт, вода — попутно в литье
let knownWater = null // вода под землёй, у которой вставали или которую видели (глубокий путь)
let routeStructureSeconds = 0
let routeSleeping = false
let routeEntered = false
let routeFrame = null
let routeDeadline = 0
let routeStepNow = null // id текущего шага плана маршрута — для телеметрии вызовов внутри шага
let routeHealing = false
let huntWool = false
let wantBeds = 1
let exitFrameTarget = null
let barterRetryPending = false
let bastionDry = 0
let bastionGoldDug = 0
let bastionIngotsTraded = 0
let ironChestTried = false
// Бартер исчерпан: два захода подряд с сохранённым золотом не отдали ни слитка (укрытие не встало, торговцы не подходят).
let barterZero = 0
let bastionSearchRuns = 0
// S1e: бюджет поиска бастиона — игровое время обхода (900 с) и не больше 8 вызовов, а не «3 вызова»: вслепую вызовы рвутся за 3–24 с
// («прервано», «бастиона не видно» после отрезка без пути — s1e-B0-4: 3 вызова за 30 с, бастион не найден, дальше его не искали).
let bastionSearchSeconds = 0
// Бастион на паузе (пустые заходы) — паузу занять ифритами, а не ждать её у портала или дома (S1d s1d-M-2: 4/12 жемчуга на 14-й мин,
// «к крепости пока не иду» при паузе бастиона → граф unreachable → домой и обратно).
let bastionPausedUntil = 0
// Бастион и «нечем» (нет железной кирки на золото, мало еды) — то же: ждать нечего (s1d-M-4: 45 мин «нет доступного шага» на 4120…).
// Пауза бастиона и ифриты — цена (S1e, проверка S1d (б)): без огнестойкости риск этапа 0.7 против 0.35 с ней (калибровка s1c; S1d
// s1d-H22-3/H22-4: ифриты на 20–25-й мин без FR в паузу — обе смерти), но ждать паузу стоит, только если сделки после неё правда
// могут дать FR: выигрыш (риск сейчас − ожидаемый после) × час дороже оставшейся паузы (campaign/nether-pause.pauseBlazeChoice).
let lastBastionGoldLeft = 0
// Бастион ждёт пополнения инструментов, а пополнить здесь нечем (нет безопасного дерева, S1e s1e-B0-3: 70 игр. мин «откладываю до
// пополнения» ↔ «к крепости пока не иду, жемчуга 0/14» до таймаута) — «сперва жемчуг» не держит ифритов, как при READY.bastion «нечем».
let supplyBlockedAt = -Infinity
let supplyBlockedState = null

let blazeDugInAt = -Infinity
let blazeDugInPos = null
let netherSearchFailure = null
let homeForGearState = null
let endkitRuns = 0

// Сеттеры: части пишут общее состояние только через них (возвращают новое значение, как присваивание).
function setStage (v: typeof stage) { return (stage = v) }
function setManualControl (v: typeof manualControl) { return (manualControl = v) }
function setStrategyExecuting (v: typeof strategyExecuting) { return (strategyExecuting = v) }
function setStrategyInterrupted (v: typeof strategyInterrupted) { return (strategyInterrupted = v) }
function setStrategyTail (v: typeof strategyTail) { return (strategyTail = v) }
function setTacticalRevision (v: typeof tacticalRevision) { return (tacticalRevision = v) }
function setState (v: typeof state) { return (state = v) }
function setSit (v: typeof sit) { return (sit = v) }
function setMemorySnapshot (v: typeof memorySnapshot) { return (memorySnapshot = v) }
function setRefugeSeenAt (v: typeof refugeSeenAt) { return (refugeSeenAt = v) }
function setLastRefuge (v: typeof lastRefuge) { return (lastRefuge = v) }
function setHunting (v: typeof hunting) { return (hunting = v) }
function setRestIdleUntil (v: typeof restIdleUntil) { return (restIdleUntil = v) }
function setDied (v: typeof died) { return (died = v) }
function setLostBag (v: typeof lostBag) { return (lostBag = v) }
function setLostAt (v: typeof lostAt) { return (lostAt = v) }
function setResting (v: typeof resting) { return (resting = v) }
function setFighting (v: typeof fighting) { return (fighting = v) }
function setDangerZone (v: typeof dangerZone) { return (dangerZone = v) }
function setDetached (v: typeof detached) { return (detached = v) }
function setHeading (v: typeof heading) { return (heading = v) }
function setDescendLava (v: typeof descendLava) { return (descendLava = v) }
function setStairEntrance (v: typeof stairEntrance) { return (stairEntrance = v) }
function setNetherExplored (v: typeof netherExplored) { return (netherExplored = v) }
function setNetherViewRevision (v: typeof netherViewRevision) { return (netherViewRevision = v) }
function setFoodHuntEmpty (v: typeof foodHuntEmpty) { return (foodHuntEmpty = v) }
function setFoodSpentMs (v: typeof foodSpentMs) { return (foodSpentMs = v) }
function setQuickHuntAt (v: typeof quickHuntAt) { return (quickHuntAt = v) }
function setNightHeld (v: typeof nightHeld) { return (nightHeld = v) }
function setWaterSearchView (v: typeof waterSearchView) { return (waterSearchView = v) }
function setWaterSearchFailedView (v: typeof waterSearchFailedView) { return (waterSearchFailedView = v) }
function setCastSurfaceFailed (v: typeof castSurfaceFailed) { return (castSurfaceFailed = v) }
function setDeepLava (v: typeof deepLava) { return (deepLava = v) }
function setSkyLavaSeen (v: typeof skyLavaSeen) { return (skyLavaSeen = v) }
function setNaturalTried (v: typeof naturalTried) { return (naturalTried = v) }
function setSkyLookAt (v: typeof skyLookAt) { return (skyLookAt = v) }
function setLavaSourceKnown (v: typeof lavaSourceKnown) { return (lavaSourceKnown = v) }
function setHeardLava (v: typeof heardLava) { return (heardLava = v) }
function setSurfaceShaft (v: typeof surfaceShaft) { return (surfaceShaft = v) }
function setShaftWaterSeen (v: typeof shaftWaterSeen) { return (shaftWaterSeen = v) }
function setWaterDeepFailAt (v: typeof waterDeepFailAt) { return (waterDeepFailAt = v) }
function setKnownWater (v: typeof knownWater) { return (knownWater = v) }
function setRouteStructureSeconds (v: typeof routeStructureSeconds) { return (routeStructureSeconds = v) }
function setRouteSleeping (v: typeof routeSleeping) { return (routeSleeping = v) }
function setRouteEntered (v: typeof routeEntered) { return (routeEntered = v) }
function setRouteFrame (v: typeof routeFrame) { return (routeFrame = v) }
function setRouteDeadline (v: typeof routeDeadline) { return (routeDeadline = v) }
function setRouteStepNow (v: typeof routeStepNow) { return (routeStepNow = v) }
function setRouteHealing (v: typeof routeHealing) { return (routeHealing = v) }
function setHuntWool (v: typeof huntWool) { return (huntWool = v) }
function setWantBeds (v: typeof wantBeds) { return (wantBeds = v) }
function setExitFrameTarget (v: typeof exitFrameTarget) { return (exitFrameTarget = v) }
function setBarterRetryPending (v: typeof barterRetryPending) { return (barterRetryPending = v) }
function setBastionDry (v: typeof bastionDry) { return (bastionDry = v) }
function setBastionGoldDug (v: typeof bastionGoldDug) { return (bastionGoldDug = v) }
function setBastionIngotsTraded (v: typeof bastionIngotsTraded) { return (bastionIngotsTraded = v) }
function setIronChestTried (v: typeof ironChestTried) { return (ironChestTried = v) }
function setBarterZero (v: typeof barterZero) { return (barterZero = v) }
function setBastionSearchRuns (v: typeof bastionSearchRuns) { return (bastionSearchRuns = v) }
function setBastionSearchSeconds (v: typeof bastionSearchSeconds) { return (bastionSearchSeconds = v) }
function setBastionPausedUntil (v: typeof bastionPausedUntil) { return (bastionPausedUntil = v) }
function setLastBastionGoldLeft (v: typeof lastBastionGoldLeft) { return (lastBastionGoldLeft = v) }
function setSupplyBlockedAt (v: typeof supplyBlockedAt) { return (supplyBlockedAt = v) }
function setSupplyBlockedState (v: typeof supplyBlockedState) { return (supplyBlockedState = v) }
function setBlazeDugInAt (v: typeof blazeDugInAt) { return (blazeDugInAt = v) }
function setBlazeDugInPos (v: typeof blazeDugInPos) { return (blazeDugInPos = v) }
function setNetherSearchFailure (v: typeof netherSearchFailure) { return (netherSearchFailure = v) }
function setHomeForGearState (v: typeof homeForGearState) { return (homeForGearState = v) }
function setEndkitRuns (v: typeof endkitRuns) { return (endkitRuns = v) }

export { T0, stage, manualControl, strategyExecuting, strategyInterrupted, strategyTail, tacticalRevision, state, sit,
  memorySnapshot, refugeSeenAt, lastRefuge, hunting, restIdleUntil, died, lostBag, lostAt, resting, fighting,
  dangerZone, detached, known, heading, descendLava, stairEntrance, fightGearWanted, netherExplored,
  netherViewRevision, foodHuntEmpty, foodSpentMs, quickHuntAt, nightHeld, waterSearchFailedView, waterSearchView,
  castSurfaceFailed, deepLava, skyLavaSeen, naturalTried, skyLookAt, lavaSourceKnown, heardLava, surfaceShaft,
  shaftWaterSeen, waterDeepFailAt, knownWater, routeStructureSeconds, routeSleeping, routeEntered, routeFrame,
  routeDeadline, routeStepNow, routeHealing, huntWool, wantBeds, exitFrameTarget, barterRetryPending, bastionDry,
  bastionGoldDug, bastionIngotsTraded, ironChestTried, barterZero, bastionSearchRuns, bastionSearchSeconds,
  bastionPausedUntil, lastBastionGoldLeft, supplyBlockedAt, supplyBlockedState, blazeDugInAt, blazeDugInPos,
  netherSearchFailure, homeForGearState, endkitRuns, setBarterRetryPending, setBarterZero, setBastionDry,
  setBastionGoldDug, setBastionIngotsTraded, setBastionPausedUntil, setBastionSearchRuns, setBastionSearchSeconds,
  setBlazeDugInAt, setBlazeDugInPos, setCastSurfaceFailed, setDangerZone, setDeepLava, setDescendLava, setDetached,
  setDied, setEndkitRuns, setExitFrameTarget, setFighting, setFoodHuntEmpty, setFoodSpentMs, setHeading, setHeardLava,
  setHomeForGearState, setHunting, setHuntWool, setIronChestTried, setKnownWater, setLastBastionGoldLeft,
  setLastRefuge, setLavaSourceKnown, setLostAt, setLostBag, setManualControl, setMemorySnapshot, setNaturalTried,
  setNetherExplored, setNetherSearchFailure, setNetherViewRevision, setNightHeld, setQuickHuntAt, setRefugeSeenAt,
  setRestIdleUntil, setResting, setRouteDeadline, setRouteEntered, setRouteFrame, setRouteHealing, setRouteSleeping,
  setRouteStepNow, setRouteStructureSeconds, setShaftWaterSeen, setSit, setSkyLavaSeen, setSkyLookAt, setStage,
  setStairEntrance, setState, setStrategyExecuting, setStrategyInterrupted, setStrategyTail, setSupplyBlockedAt,
  setSupplyBlockedState, setSurfaceShaft, setTacticalRevision, setWantBeds, setWaterDeepFailAt,
  setWaterSearchFailedView, setWaterSearchView }
