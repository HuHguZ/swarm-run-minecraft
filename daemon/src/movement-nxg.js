'use strict'
// A second engine for the same body, standing NEXT TO movement.js instead of
// replacing it. movement.js is the floor the other six modules stand on, and
// swapping the pathfinder underneath them blind costs a day of debugging in
// places that have nothing to do with walking. ND_PATHFINDER=nxg picks this
// file; every existing call site keeps writing bot.pathfinder.goto(...),
// bot.pathfinder.setGoal(null) and `new goals.GoalNear(...)` from the 2.4.5
// namespace, because the plugin below re-implements that surface on top of
// @nxg-org/mineflayer-pathfinder 0.0.26.
//
// Why a translation layer and not a straight port: seven files construct 2.4.5
// goal objects at their own require() (actions, combat, containers, mining,
// survival, movement, session). Porting means editing all seven, which is
// exactly the blind swap this task exists to avoid.
const nxg = require('@nxg-org/mineflayer-pathfinder')
const { BlockInfo } = require('@nxg-org/mineflayer-pathfinder/dist/mineflayer-specific/world/cacheWorld')
const legacy = require('mineflayer-pathfinder')
const base = require('./movement')

const { sleep, xyz, standableY, describeStall, findNearestLand, inWater, stuckGuard, unstick } = base

const num = (v, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

// 0.0.26 builds its A* with timeout = -1 and searchRadius = -1
// (pathProducers/continuousPathProducer.js: new AStar(start, mh, goal, -1, 40, -1, 0)),
// so a search for an unreachable goal never gives up on its own — and
// ThePathfinder._goto then re-plans it in a do/while loop that only exits on
// arrival or on userAborted. 2.4.5 had thinkTimeout = 5000 and rejected with
// NoPath. Callers like actions.js reachBlock() pass no deadline of their own and
// would hang to the intent timeout, so this wrapper carries the cap the library
// does not have.
const GOTO_MS = num(process.env.ND_NXG_GOTO_MS, 45000)
// Sprint is off in session.js because client/server physics diverge and the
// server rubber-bands the body. 0.0.26 simulates movement with its own physics
// engine, so "does sprint work now" is worth a separate switch — but it stays
// off by default: turning it on changes the variable the comparison is about.
const SPRINT = process.env.ND_NXG_SPRINT === '1'
// Baritone-style incremental planning: start walking on the first 50 moves
// instead of waiting for the whole path. Off by default for the same reason.
const PARTIAL = process.env.ND_NXG_PARTIAL === '1'

// getScaffoldCount() decides whether a 1x1 tower move is generated at all, and
// it counts only BlockInfo.scaffoldingBlockItems — which cacheWorld.js seeds
// with dirt and cobblestone only (2.4.5 seeds the same two). session.js already
// counts a wider list when it decides `towers`, so at depth, with a bag full of
// cobbled_deepslate, that flag was a lie for both libraries. Here it is not.
const SCAFFOLD_NAMES = [
  'dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone',
  'oak_planks', 'spruce_planks', 'birch_planks'
]

// ------------------------------------------------------------- goal translation

// 2.4.5 goal object -> 0.0.26 goal object. Only the shapes this codebase
// actually builds are handled; anything else is refused loudly rather than
// silently walked to the wrong place.
function translateGoal (bot, goal) {
  if (goal === null || goal === undefined) return null
  if (goal instanceof nxg.goals.Goal) return goal

  const name = goal.constructor ? goal.constructor.name : '?'
  const range = (sq) => Math.max(0, Math.sqrt(sq || 0))

  switch (name) {
    case 'GoalBlock':
      return new nxg.goals.GoalBlock(goal.x, goal.y, goal.z)
    case 'GoalGetToBlock':
      return new nxg.goals.GoalNear(goal.x, goal.y, goal.z, 1)
    case 'GoalNear':
      return new nxg.goals.GoalNear(goal.x, goal.y, goal.z, range(goal.rangeSq))
    case 'GoalNearXZ':
      return new nxg.goals.GoalNearXZ(goal.x, goal.z, range(goal.rangeSq))
    case 'GoalXZ':
      return new nxg.goals.GoalNearXZ(goal.x, goal.z, 0)
    case 'GoalY':
      throw new Error('nxg: GoalY не поддержан — в 0.0.26 нет цели по одной высоте')
    case 'GoalFollow':
      // The 0.0.26 goal holds the entity's live position vector by identity and
      // re-plans on entityMoved; handing it anything but entity.position makes
      // hasChanged() compare against a copy and never fire.
      return new nxg.goals.GoalFollowEntity(goal.entity.position, range(goal.rangeSq), {
        dynamic: true, neverfinish: true
      })
    case 'GoalLookAtBlock':
      // 0.0.26 wants ITS world (the cached one hanging off the pathfinder), not
      // bot.world: GoalLookAt.isEnd raycasts through world.raycast during the
      // search, once per candidate node.
      return nxg.goals.GoalLookAt.fromBlock(
        bot.pathfinder.world, { position: goal.pos }, goal.reach, goal.entityHeight)
    default:
      throw new Error(`nxg: не знаю, как перевести цель ${name}`)
  }
}

// Did the body actually end up where the ORIGINAL goal wanted? 0.0.26's goto()
// resolves on arrival, on abort and on "gave up" alike, so resolving proves
// nothing. Judged against the 2.4.5 goal's own geometry (sphere, not the box
// 0.0.26 uses), so both arms answer the same question.
function reachedGoal (bot, goal) {
  if (!goal) return true
  const p = bot.entity.position
  const name = goal.constructor ? goal.constructor.name : '?'
  const d2 = (dx, dy, dz) => dx * dx + dy * dy + dz * dz
  switch (name) {
    case 'GoalBlock':
    case 'GoalGetToBlock':
      return d2(p.x - (goal.x + 0.5), p.y - goal.y, p.z - (goal.z + 0.5)) <= 2.25
    case 'GoalNear':
      return d2(p.x - (goal.x + 0.5), p.y - goal.y, p.z - (goal.z + 0.5)) <= (goal.rangeSq || 0) + 1
    case 'GoalNearXZ':
    case 'GoalXZ':
      return d2(p.x - (goal.x + 0.5), 0, p.z - (goal.z + 0.5)) <= (goal.rangeSq || 0) + 1
    case 'GoalFollow':
      return d2(p.x - goal.entity.position.x, p.y - goal.entity.position.y, p.z - goal.entity.position.z) <= (goal.rangeSq || 0) + 1
    case 'GoalLookAtBlock':
      return p.offset(0, goal.entityHeight, 0).distanceTo(goal.pos.offset(0.5, 0.5, 0.5)) <= goal.reach + 0.5
    default:
      return true
  }
}

// --------------------------------------------------------------- stop / unwedge

// ThePathfinder.cancel() awaits currentExecutor.abort(), and during the search
// phase that executor is a throwaway IdleMovementExecutor built inside
// getPathFromTo(). Its Task is only finished by cleanupBot(), which walks the
// registered-movements map the idle executor is not in — so awaiting cancel()
// mid-search never returns. Setting the two flags is all of cancel() that
// matters; the interrupt is fired and forgotten on purpose.
function stopPathing (bot) {
  const pf = bot && bot.pathfinder
  if (!pf) return
  try {
    pf.userAborted = true
    pf.abortCalculation = true
    // Only when there is something to interrupt: with no producer the library
    // answers with a bare console.log('no producer'), and setGoal(null) is
    // called on every abort path in six modules — that is a log full of noise
    // for no information.
    if (pf.currentProducer && typeof pf.interrupt === 'function') {
      const p = pf.interrupt(0, true)
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
  } catch {}
}

// A throw out of _goto() skips cleanupAll(), and cleanupAll() is the only place
// executeTask.finish() is called — so one failed walk leaves every later goto()
// awaiting a promise that never settles. Reachable in normal play:
// holdUntilAborted() throws a plain Error('Movement failed to abort properly.')
// one second after an abort the body cannot honour, and perform() rethrows
// anything that is not Abort/Reset/CancelError.
async function unwedge (bot, nxgGoal) {
  const pf = bot && bot.pathfinder
  if (!pf) return
  // isPathing is `executeTask.done` — true means the task HAS finished, despite
  // what the name suggests. Nothing to unwedge in that case.
  if (pf.isPathing) return
  // A dynamic goal has to be handed back its own object: cleanupAll() is what
  // calls goal.cleanup(), and that is the only thing unhooking the entityMoved
  // listeners a follow goal registered. Everything else gets a neutral goal so
  // that onFinish() cannot start work of its own — GoalLookAt.onFinish awaits
  // two bot.lookAt() calls, and on a body that is disconnecting those never
  // return. Bounded anyway: unwedging is housekeeping, not the intent.
  const goal = (nxgGoal instanceof nxg.goals.GoalDynamic) ? nxgGoal : new nxg.goals.GoalNear(0, 0, 0, 1)
  let timer = null
  try {
    await Promise.race([
      pf.cleanupAll(goal),
      new Promise(resolve => { timer = setTimeout(resolve, 3000) })
    ])
  } catch {} finally {
    if (timer) clearTimeout(timer)
  }
}

// ------------------------------------------------------------------ the plugin

// 0.0.26 cannot be loaded the way 2.4.5 is. Its ThePathfinder constructor builds
// one MovementExecutor per movement type, and each calls
// EPhysicsCtx.FROM_BOT(engine, bot), which reads bot.entity.metadata,
// bot.game.gameMode and bot.inventory. mineflayer injects plugins on
// 'inject_allowed' (plugin_loader.js), long before spawn, so a plain
// loadPlugin() throws "Cannot read properties of undefined (reading 'find')".
// Checked offline against a stub bot on the 1.21.11 registry.
//
// A lazy accessor keeps session.js's `bot.loadPlugin(pathfinder)` exactly where
// it is: the real object is built on first touch after spawn, and session.js
// already guards with `if (!bot.pathfinder) return`.
function pathfinder (bot) {
  let real = null
  Object.defineProperty(bot, 'pathfinder', {
    configurable: true,
    enumerable: true,
    get () {
      if (real) return real
      if (!bot.entity || !bot.entity.metadata || !bot.inventory || !bot.game || !bot.game.gameMode) return undefined
      // createPlugin assigns bot.pathfinder, which lands in the setter below.
      nxg.createPlugin({ settings: { partialPathProducer: PARTIAL, partialPathLength: 50 } })(bot)
      if (!real) return undefined
      installShim(bot, real)
      const built = real
      Object.defineProperty(bot, 'pathfinder', {
        configurable: true, enumerable: true, writable: true, value: built
      })
      return built
    },
    set (v) { real = v }
  })
}

function installShim (bot, pf) {
  const rawGoto = pf.goto.bind(pf)

  for (const name of SCAFFOLD_NAMES) {
    const item = bot.registry.itemsByName[name]
    if (item) BlockInfo.scaffoldingBlockItems.add(item.id)
  }

  // Re-emitted so session.js's wire() keeps printing its [path] diagnostics.
  // Note what is missing: 0.0.26 has no "noPath" event at all — a failed search
  // is silent and simply re-planned — which is why goto() below has to judge
  // arrival by geometry rather than by listening.
  bot.on('pathGenerated', p => {
    bot.emit('path_update', {
      status: p.status,
      cost: p.cost,
      visitedNodes: p.visitedNodes,
      generatedNodes: p.generatedNodes,
      path: p.path,
      time: p.calcTime
    })
  })
  bot.on('goalFinished', () => bot.emit('goal_reached'))
  bot.on('resetPath', reason => bot.emit('path_reset', reason))

  pf.setMovements = (m) => {
    pf.setMoveOptions({
      canDig: !!m.canDig,
      allow1by1towers: !!m.allow1by1towers,
      allowSprinting: SPRINT ? true : !!m.allowSprinting,
      allowJumpSprint: SPRINT ? true : !!m.allowSprinting,
      // 2.4.5 defaults maxDropDown to 4 and every route in this world was
      // measured against that. 0.0.26 ships 3, which would fail the cliff leg
      // for a reason that has nothing to do with the executor.
      maxDropDown: 4
    })
  }

  pf.stop = () => stopPathing(bot)
  pf.isMoving = () => !pf.isPathing

  // 2.4.5 semantics: null clears the goal, anything else starts and returns
  // immediately.
  pf.setGoal = (goal, _dynamic = false) => {
    if (goal === null || goal === undefined) return stopPathing(bot)
    const translated = translateGoal(bot, goal)
    stopPathing(bot)
    // Fire and forget, as setGoal always was. There is no caller to throw at.
    Promise.resolve()
      .then(() => rawGoto(translated))
      .catch(() => {})
      .then(() => unwedge(bot, translated))
  }

  // 2.4.5 semantics: resolve on arrival, reject otherwise. 0.0.26 gives neither
  // — it resolves after an abort and spins forever on an unreachable goal — so
  // both halves are supplied here.
  pf.goto = async (goal, opts = {}) => {
    if (goal === null || goal === undefined) return stopPathing(bot)
    const translated = translateGoal(bot, goal)
    const limit = num(opts.timeoutMs, GOTO_MS)
    let timer = null
    let expired = false
    try {
      await Promise.race([
        rawGoto(translated),
        new Promise(resolve => {
          timer = setTimeout(() => { expired = true; stopPathing(bot); resolve() }, limit)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
      await unwedge(bot, translated)
    }
    if (reachedGoal(bot, goal)) return
    if (expired) throw Object.assign(new Error(`путь не сложился за ${Math.round(limit / 1000)}с`), { name: 'Timeout' })
    throw Object.assign(new Error('путь не найден'), { name: 'NoPath' })
  }

  pf.nxg = true
}

// A stand-in for 2.4.5's Movements. session.js builds one, sets three fields on
// it and hands it to setMovements(); nothing else in the tree reads it. Keeping
// it a plain bag means the switch does not have to touch session.js's body.
class Movements {
  constructor (bot) {
    this.bot = bot
    this.canDig = true
    this.allow1by1towers = true
    this.allowSprinting = true
    this.allowParkour = true
    this.maxDropDown = 4
  }
}

// ------------------------------------------------------------------- water

// 0.0.26 can genuinely swim, and that is one of the things worth measuring:
// StraightUp costs only jumpCost + liquidCost when the block above the head is
// liquid (movementProviders.js getMoveUp: the tower branch is skipped when
// block3.liquid), where 2.4.5 refuses the move outright on its first line
// (`if (block1.liquid) return`); and the forward executors hold `jump` while
// isInWater. So ask the pathfinder first and keep the hand-paddle as the
// fallback it should always have been.
//
// Same return shape as movement.js escapeWater, plus `via`, so the comparison
// scene can tell which of the two actually did the work.
async function escapeWater (bot, ctl, { timeoutMs = 25000 } = {}) {
  if (!inWater(bot)) return { ok: true, wasInWater: false }

  const deadline = Date.now() + timeoutMs
  const target = findNearestLand(bot, 24)

  if (target && !ctl.aborted) {
    try {
      await bot.pathfinder.goto(
        new legacy.goals.GoalNearXZ(target.x, target.z, 1),
        { timeoutMs: Math.max(4000, Math.min(timeoutMs, deadline - Date.now())) })
    } catch {}
    if (!inWater(bot)) {
      return { ok: true, wasInWater: true, target: xyz(target), via: 'pathfinder' }
    }
  }

  // Fallback, identical to movement.js: hold jump to stay afloat and paddle at
  // the nearest dry ground.
  stopPathing(bot)
  let aimed = target
  try {
    while (Date.now() < deadline && !ctl.aborted && inWater(bot)) {
      aimed = findNearestLand(bot, 24)
      if (aimed) {
        await bot.lookAt(aimed.offset(0.5, 1.6, 0.5), true)
        bot.setControlState('forward', true)
      }
      bot.setControlState('jump', true)
      await sleep(600)
    }
  } finally {
    try { bot.clearControlStates() } catch {}
  }

  const out = !inWater(bot)
  return {
    ok: out,
    wasInWater: true,
    target: aimed ? xyz(aimed) : null,
    via: out ? 'ручной гребок' : undefined,
    error: out ? undefined : 'не смог выбраться из воды'
  }
}

// ------------------------------------------------------------------- travel

// Same contract, same retry count, same guard as movement.js travelXZ — copied
// rather than reused only so the water escape it calls is the nxg one above.
// Everything else about the loop is deliberately unchanged: the comparison is
// about the engine, not about the retry policy wrapped around it.
async function travelXZ (bot, ctl, x, z, { range = 4, retries = 2, deadline = null } = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (ctl.aborted) return { ok: false, error: 'прервано' }
    if (deadline && Date.now() >= deadline) return { ok: false, error: 'время вышло', outOfTime: true }

    if (inWater(bot)) {
      const esc = await escapeWater(bot, ctl)
      if (!esc.ok) return { ok: false, error: esc.error }
    }

    const guard = stuckGuard(bot, ctl)
    const racers = [
      bot.pathfinder.goto(new legacy.goals.GoalNearXZ(Math.floor(x), Math.floor(z), range)),
      guard.promise
    ]
    let timer = null
    if (deadline) {
      const left = Math.max(1000, deadline - Date.now())
      racers.push(new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('время вышло'), { outOfTime: true })), left)
      }))
    }

    try {
      await Promise.race(racers)
      return { ok: true }
    } catch (err) {
      lastError = err
      stopPathing(bot)
      if (ctl.aborted) return { ok: false, error: err.message }
      if (err.outOfTime) return { ok: false, error: 'время вышло', outOfTime: true }
      await unstick(bot)
    } finally {
      guard.stop()
      if (timer) clearTimeout(timer)
    }
  }
  return { ok: false, error: lastError ? lastError.message : 'не дошёл' }
}

module.exports = {
  // Identical to movement.js on purpose: geometry is not what is being
  // compared, and two copies of standableY would drift apart within a week.
  sleep, xyz, standableY, describeStall, stuckGuard, unstick, findNearestLand, inWater,
  // nxg-specific
  travelXZ, escapeWater,
  // the 2.4.5-shaped surface session.js needs in order to switch engines
  pathfinder, Movements, goals: nxg.goals, translateGoal, stopPathing,
  PATHFINDER: 'nxg'
}
