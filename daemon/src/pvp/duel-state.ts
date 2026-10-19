import { type DuelCtx } from './turn'

// Состояние боя (бывшие let duelBody с начальными значениями-литералами): память неудач по входам, маршруты, отметки времени.
export function initDuelState (ctx: DuelCtx) {
  ctx.foodFire = { attempts: 0, ignited: 0, burningObserved: 0 }
  ctx.burningFood = new Set<number>()
  ctx.kills = []
  ctx.rushActive = false
  ctx.creeperBack = null
  ctx.fleeingSwell = false
  ctx.swellPlan = null
  ctx.swellPlanAt = 0
  ctx.unseen = false
  ctx.reposition = null
  ctx.failedReposition = null
  ctx.stuckTicks = 0
  // Копьё на изготовку против тарана с элитр (s7b): встречный разгон — отн. скорость = его скорость к нам.
  ctx.bracing = false
  ctx.gp = null
  ctx.myHpT = null
  ctx.losGoal = null
  ctx.foeSeenPos = null
  ctx.lastTrick = null
  ctx.shieldHitAt = -1e9
  ctx.foeHp = null
  ctx.exchangeStart = { swings: 0, landed: 0 }
  ctx.noticed = {}
  ctx.rolls = {}
  ctx.punches = 0
  ctx.nextReady = 0
  ctx.lastSwing = 0
  ctx.swingCrit = false
  ctx.killed = false
  ctx.dodgeKey = null
  ctx.dodgeLine = null
  // редко (обновление раз в 20 тиков, исследование исходников 1.21.11), и по
  ctx.theirDrawAt = 0
  ctx.jumpedForCrit = false
  ctx.hitKind = null
  ctx.firstHitDone = false
  ctx.totemAt = 0
  ctx.maceTotem = false
  ctx.selectSince = 0
  ctx.cd = {} // когда какой приём снова можно
  ctx.blockedShotTargets = { bow: null, xbow: null }

  ctx.targetHurtAt = 0
  ctx.shieldUpAt = 0
  ctx.shieldDownAt = 0
  ctx.attackers = new Map()
  ctx.dead = new Set()
  ctx.selfDied = false
  ctx.mobHits = new Map()
  ctx.mobDetour = null
  ctx.mobCheckAt = 0
  ctx.swatted = new Map()

  ctx.bowWatch = { drawAt: 0, shotAt: 0, shots: 0, seen: -1, loadedAt: 0, xbowShotAt: 0 }

  ctx.floorEscape = null // Concrete support being broken and the chosen safe exit.
  ctx.mlgArmed = false

  ctx.aim = 'target'
  ctx.aimPoint = null
  ctx.owShot = null
  ctx.sightOff = null

  ctx.keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
  ctx.pathing = false
  ctx.holdGoal = null
  ctx.holdGoalAt = 0
  ctx.badShafts = new Set()
  ctx.shaftInputs = null

  ctx.chosenWeapon = null

  ctx.failedWalls = new Map<string, any>()

  ctx.perch = null
  ctx.siegeGoal = null
  ctx.siegeRoute = null
  ctx.PERCH_MAX = 8
  ctx.failedPillar = null
  ctx.failedPerchDrop = null

  ctx.fort = null
  ctx.failedFort = null

  ctx.terrainAt = 0
  ctx.myPit = null
  ctx.theirPit = null
  ctx.nearFoe = []
  ctx.nearMe = []
  ctx.push = null
  ctx.pushAt = 0
  ctx.behindDrop = null
  ctx.jumpDrop = false
  ctx.jumpDropAt = 0
  ctx.backAt = 0
  ctx.flankRoute = null
  ctx.failedFlank = null
  ctx.counterRoute = null
  ctx.failedCounter = null
  ctx.failedClimb = null
  ctx.failedHop = null
  ctx.failedStandoff = null
  ctx.failedUnblock = null
  ctx.failedSky = null
  ctx.failedSmash = null
  ctx.failedBoom = null
  ctx.failedBoomDefense = null
  ctx.failedCrystal = null
  ctx.failedPearlResponse = null
  ctx.failedChorus = null
  ctx.failedDress = null
  ctx.failedStormCover = null
  ctx.failedArrowRun = null
  ctx.failedCutWeb = null
  ctx.failedHisWeb = null
  ctx.failedOutOfFire = null
  ctx.failedToWater = null
  ctx.failedBreakUnder = null
  ctx.failedSiege = null
  ctx.failedWindPush = null
  ctx.failedSpearCharge = null
  ctx.failedHealSpace = null
  ctx.failedBow = null
  ctx.failedXbow = null
  ctx.failedAirBow = null
  ctx.failedAirXbow = null
  ctx.exhaustedPunch = null
  ctx.falls = { mine: 0, ground: null, his: 0, hisY: [] }

  ctx.failedPitExit = null

  ctx.failedPitLava = null

  ctx.TOWER_SAFE_DRAW_MS = 500

  ctx.pendingLava = []
  ctx.pendingWater = []

  ctx.planText = null
  ctx.planVerdict = null
  ctx.replanAt = 0
  ctx.splashFirst = false
}
