// Протокол хода боя (pvp.ts duelBody): контекст боя ctx, кадр хода turn и ответ ступени хода.
//
// ctx — всё, что раньше было замыканием duelBody: состояние (бывшие let), службы (темп, чтение соперника, ближний бой,
// элитры, кристаллы…) и помощники. Ставят его install*-функции частей duel-*.ts в прежнем порядке.
// turn — значения одного хода (расстояния, что у него в руках, видно ли его, вперёд/назад…), их считают и читают
// ступени хода turn-*.ts. Ступень — функция (ctx, turn), её ответ:
//   undefined — ход идёт дальше (следующая ступень);
//   NEXT — новый ход (прежнее continue);
//   { end } — бой окончен, end — отчёт finish (прежнее return finish(…)).
// Ступень без await — синхронная функция: лишнего перехода микрозадач нет, как и в прежнем теле цикла.

export const NEXT = 'next'

export interface DuelCtx {
  session: any; ctl: any; entity: any; opts: any; rangedAllowed: any; bot: any; vision: any; deadline: any;
  acquired: any; strategicTargetId: any; lastStand: any; foodFire: any; burningFood: any; fireTerrainSafe: any;
  retreatAtHealth: any; guard: any; calmAfterMs: any; healAt: any; clearArea: any; arena: any; label: any;
  track: any; prof: any; kills: any; rushActive: any; creeperBack: any; fleeingSwell: any; swellPlan: any;
  swellPlanAt: any; seenAt: any; unseen: any; reposition: any; failedReposition: any; stuckTicks: any;
  bracing: any; HOP: any; st: any; traceT0: any; co: any; telemetryHp: any; calc: any; foeEst: any;
  foeHpDecide: any; fg: any; GRAPH: any; combo: any; blk: any; gp: any; noteGate: any; gate: any; skyOver: any;
  shelterNear: any; TRACE: any; myHpT: any; trace: any; losGoal: any; foeSeenPos: any; losSpot: any; AR: any;
  onField: any; routeInputs: any; lastTrick: any; shieldHitAt: any; foeHp: any; onTickDmg: any; used: any;
  quiet: any; noteExchange: any; ovl: any; style: any; exchangeStart: any; tt: any; attackers: any; foe: any;
  fortSealed: any; fort: any; noticed: any; after: any; rolls: any; roll: any; punches: any; weapon: any;
  nextReady: any; lastSwing: any; swingCrit: any; lastHurtByTarget: any; killed: any; strafeKey: any;
  strafeFrom: any; strafeAxis: any; strafeStep: any; dodgeKey: any; dodgeLine: any; theirDrawAt: any;
  sawRelease: any; jumpedForCrit: any; mf: any; tot: any; use0: any; hitKind: any; firstHitDone: any; totemAt: any;
  maceTotem: any; selectSince: any; cd: any; ready: any; rest: any; blockedShotTargets: any; shotReady: any;
  targetHurtAt: any; shieldUpAt: any; shieldDownAt: any; onHurt: any; otherAttacker: any; dead: any; onDead: any;
  selfDied: any; onSelfDeath: any; mobHits: any; onMobHurt: any; mobDetour: any; mobCheckAt: any; mobThreat: any;
  mobCtl: any; duo: any; holdWeapon: any; aim: any; util: any; swatted: any; onTickSwat: any; bowWatch: any;
  onTickArcher: any; floorEscape: any; safeNeighbor: any; onCrack: any; onCrackEnd: any; groundY: any;
  mlgArmed: any; onTickFall: any; onMlg: any; aimPoint: any; owShot: any; sightOff: any; aimTimer: any;
  pathing: any; keys: any; clear: any; set: any; hm: any; pathTo: any; coverFrom: any; holdGoal: any;
  miningProgress: any; onRoutePath: any; flankRoute: any; counterRoute: any; siegeRoute: any; restoreMoves: any;
  holdGoalAt: any; guardSpot: any; badShafts: any; shaftInputs: any; edgeGuard: any; mc: any; sky: any;
  pearlResponse: any; pvpSkills: any; bm: any; cx: any; maceNow: any; maceAbort: any; buildGuard: any;
  guardCtl: any; buildDone: any; buildHot: any; noteBuild: any; heldName: any; switched: any; chosenWeapon: any;
  pickWeaponFor: any; holdItem: any; useAt: any; foeGrounded: any; leadFn: any; reachable: any; throwAt: any;
  placeUnder: any; failedWalls: any; wallInputs: any; coverForDrink: any; perch: any; siegeGoal: any;
  perchHeight: any; PERCH_MAX: any; headroom: any; failedPillar: any; pillarOut: any; columnInputs: any;
  failedPerchDrop: any; dropFromPerch: any; itemInputs: any; healItem: any; fortPossible: any; isAir: any;
  cellOk: any; fortSpot: any; failedFort: any; fortOut: any; punchThrough: any; terrainAt: any; myPit: any;
  theirPit: any; nearFoe: any; nearMe: any; push: any; pushAt: any; behindDrop: any; jumpDrop: any;
  jumpDropAt: any; backAt: any; failedFlank: any; failedCounter: any; failedClimb: any; failedHop: any;
  failedStandoff: any; failedUnblock: any; failedSky: any; failedSmash: any; failedBoom: any;
  failedBoomDefense: any; failedCrystal: any; failedPearlResponse: any; failedChorus: any; failedDress: any;
  failedStormCover: any; failedArrowRun: any; failedCutWeb: any; failedHisWeb: any; failedOutOfFire: any;
  failedToWater: any; failedBreakUnder: any; failedSiege: any; failedWindPush: any; failedSpearCharge: any; spearBlockedAt?: number | null; spearOffUntil?: number;
  failedHealSpace: any; failedBow: any; failedXbow: any; failedAirBow: any; failedAirXbow: any; shotInputs: any;
  exhaustedPunch: any; windInputs: any; blastRetreat: any; falls: any; edgeTally: any; failedPitExit: any;
  climbOut: any; failedPitLava: any; lavaIntoPit: any; bucketLanding: any; useOnGroundAt: any; scoop: any;
  TOWER_SAFE_DRAW_MS: any; towerShield: any; pendingLava: any; pendingWater: any; hazardOnLine: any;
  unblockPath: any; digWatch: any; punishable: any; eatHeld: any; consumeItem: any; drink: any; escapePearl: any;
  releaseFightItems: any; strategicRequest: any; finish: any; crowd: any; throwWhy: any; targetHurtBy: any; strikeSlotAt: any; strikeSlot: any; planText: any; planVerdict: any; replanAt: any;
  retarget: any; maceChain: any; seesNow: any; buffUp: any; splashFirst: any; spearChargeFar: any; sleep: any;
  glideChase: any;
}

export interface TurnFrame {
  now: any; me: any; eye: any; d: any; dy: any; r: any; theirR: any; hp: any; medical: any; safety: any;
  safeMedical: any; arenaStay: any; flightRecovery: any; meInWeb: any; skyThreat: any; punishAfterRecovery: any;
  their: any; blocking: any; theyEat: any; theyBow: any; theirHp: any; seesBody: any; sight: any; inSight: any;
  hidden: any; theyUp: any; busyFoe: any; pressing: any; meBelow: any; meOut: any; heOut: any; inWeb: any;
  cooldownLeft: any; webPlan: any; webSafe: any; archer: any; calmHeal: any; canHeal: any; inc: any; aimedCb: any;
  hisCb: any; bolt: any; cbShield: any; punRush: any; punStep: any; punBow: any; meleeDmg: any; blockedLong: any;
  arrowsWeak: any; noMelee: any; bowItem: any; arrowItem: any; sees: any; pillarNeeded: any; bowShield: any;
  closing: any; smashSetup: any; axe: any; iframes: any; shieldFresh: any; intoShield: any; punish: any;
  hisHand: any; hisReadyMs: any; race: any; cdHit: any; owMelee: any; canHit: any; forward: any; back: any;
  strafe: any; sprint: any; vulnerable: any; rush: any; pushing: any; edgeHit: any; intoHazard: any; jump: any;
}
