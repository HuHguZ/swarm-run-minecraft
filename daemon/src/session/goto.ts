'use strict'
// goto сессии: проверка арены, затем ход по фазам — границы арены (gotoArenaBounds), подготовка цели (gotoPrepare),
// ходы до pathfinder'а (gotoPreMoves: жемчуг, спуск, лодка), попытка pathfinder'а (gotoAttempt) и план с повторами
// (gotoLoop). Общее состояние хода — объект GotoRun; поля, которые фазы меняют (failDescent), читаются через него.
import type { Session } from '../session'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { xyz, standableY, stuckGuard, unstick, escapeWater, inWater, gotoGoal, gotoWaitOn } from '../movement'
import { escapePit } from '../build'
import * as blockmoves from '../blockmoves'
import * as hopgoto from '../hopgoto'
import { skyLightAt, HOLDING } from './shared'

// Ленивые модули (загрузка при первом вызове, как было), запомненные: require из папки части не попадает в быстрый кеш
// Node по (папка, spec), и в горячем цикле (клетка A*, физический тик) каждый вызов разбирал бы путь заново.
let parkourLoaded: typeof import('../navigation/parkour') | undefined
const lazyParkour = (): typeof import('../navigation/parkour') => (parkourLoaded ??= require('../navigation/parkour'))
let unstuckLoaded: typeof import('../unstuck') | undefined
const lazyUnstuck = (): typeof import('../unstuck') => (unstuckLoaded ??= require('../unstuck'))
let fortifyLoaded: typeof import('../fortify') | undefined
const lazyFortify = (): typeof import('../fortify') => (fortifyLoaded ??= require('../fortify'))
let boatMovesLoaded: typeof import('../navigation/boat-moves') | undefined
const lazyBoatMoves = (): typeof import('../navigation/boat-moves') => (boatMovesLoaded ??= require('../navigation/boat-moves'))
let descentLoaded: typeof import('../navigation/descent') | undefined
const lazyDescent = (): typeof import('../navigation/descent') => (descentLoaded ??= require('../navigation/descent'))

type Pit = { wasInPit: boolean; climbed?: number; stopped?: string }

// Граница арены на время goto: проверка следующего физического шага каждый тик и возврат прежних настроек пути.
interface GotoBounds {
  error: any
  failure: Promise<unknown>
  check: () => void
  restore: () => void
}

interface GotoRun {
  bot: any
  ctl: any
  // параметры goto
  x: any; y: any; z: any; range: number; surface: any; bridge: any; pathWait: any; pearl: any; sprint: any; sprintJump: any
  descent: any; unstuckWanted: any; climb: any; exactY: any
  secs: number
  boundedArena: any
  avoiding: boolean
  bounds: GotoBounds
  // gotoPrepare
  deadline?: number
  strict?: boolean
  waitPartial?: boolean
  un?: any
  goalBelow?: () => boolean
  pit?: Pit
  bx?: number
  bz?: number
  goal?: any
  resolvedTo?: any
  surfaceWalk?: boolean
  // gotoPreMoves
  pearlRun?: any
  descentRuns?: any[]
  descentOpt?: any
  descentWatch?: any
  // попытка ставит, сторож спуска зовёт
  failDescent?: ((err: any) => void) | null
}

// runIntent's clock ran out, and on an abort it throws — so the report was
function goto (this: Session, { x, y, z, range = 2, timeoutSeconds = 90, surface, bridge, pathWait, pearl, sprint, sprintJump, descent, unstuck: unstuckWanted, arena, climb, exactY }: any): Promise<any> {
  // Validate before runIntent can cancel another action or change its movement settings.
  let boundedArena
  if (arena !== undefined) {
    const bot = this.require(), target = { x: Number(x), y: y == null ? bot.entity.position.y : Number(y), z: Number(z) }
    if (!arena || typeof arena !== 'object' || ![target.x, target.y, target.z].every(Number.isFinite)) throw Object.assign(new Error('invalid arena goto'), { code: 'ARENA_BOUNDARY' })
    if (arena.avoid !== undefined && (!Array.isArray(arena.avoid) || !arena.avoid.every(e => e && [e.x, e.y, e.z, e.r].every(Number.isFinite) && e.r >= 0))) throw Object.assign(new Error('invalid arena avoid'), { code: 'ARENA_BOUNDARY' })
    const start = bot.entity.position
    // A bot already near a threat may stand or leave, but must not get any closer.
    const avoid = arena.avoid?.map(e => Object.freeze({ ...e, r: Math.min(e.r, Math.hypot(start.x - e.x, start.y - e.y, start.z - e.z)) }))
    boundedArena = Object.freeze({ ...arena, ...(avoid ? { avoid: Object.freeze(avoid) } : {}) })
    const within = lazyParkour().withinArena
    if (!within(bot, target, boundedArena) || !within(bot, { ...target, x: Math.floor(target.x) + .5, z: Math.floor(target.z) + .5 }, boundedArena)) throw Object.assign(new Error('goto target is outside arena bounds'), { code: 'ARENA_BOUNDARY' })
  }
  const avoiding = !!boundedArena?.avoid?.length
  const secs = Math.max(5, Math.min(600, timeoutSeconds))
  return this.runIntent('goto', async (ctl) => {
    const bot = this.require()
    const bounds = gotoArenaBounds.call(this, bot, ctl, boundedArena, avoiding, climb)
    const run: GotoRun = { bot, ctl, x, y, z, range, surface, bridge, pathWait, pearl, sprint, sprintJump, descent, unstuckWanted, climb, exactY,
      secs, boundedArena, avoiding, bounds }
    try {
      bounds.check()
      if (bounds.error) throw bounds.error
      await gotoPrepare.call(this, run)
      await gotoPreMoves.call(this, run)
      return await gotoLoop.call(this, run)
    } finally { bounds.restore() }
  }, { timeoutMs: (secs + 15) * 1000, params: { climb: !!climb }, ...(climb ? { interruptOn: HOLDING } : {}) })
}

function gotoArenaBounds (this: Session, bot, ctl, boundedArena, avoiding: boolean, climb): GotoBounds {
  const previousArena = this.gotoArena, previousStrict = this.surfaceStrict
  const previousSurface = this.surfaceWalk, previousY = this.pathGoalY
  const previousThinkTimeout = bot.pathfinder.thinkTimeout
  let rejectBounds, restored = false
  const boundsFailure = new Promise((resolve, reject) => { rejectBounds = reject })
  boundsFailure.catch(() => {})
  const restoreBounds = () => {
    if (!boundedArena || restored) return
    restored = true; bot.removeListener('physicsTick', checkBounds)
    if (this.gotoArena !== boundedArena) return
    this.gotoArena = previousArena; this.surfaceStrict = previousStrict
    this.surfaceWalk = previousSurface; this.pathGoalY = previousY
    if (avoiding) bot.pathfinder.thinkTimeout = previousThinkTimeout
    this.updateMovements(true)
  }
  const checkBounds = () => {
    if (!boundedArena || ctl.aborted || bounds.error || this.gotoArena !== boundedArena) return
    const parkour = lazyParkour()
    let next = bot.entity.position
    try {
      if (bot.physics?.simulatePlayer && bot.entity.velocity) next = parkour.simulatePlan(bot, [{ yaw: bot.entity.yaw ?? 0, control: { ...parkour.IDLE, ...bot.controlState } }]).pos
      if (parkour.withinArena(bot, bot.entity.position, boundedArena) && parkour.withinArena(bot, next, boundedArena, bot.entity.position)) return
      bounds.error = Object.assign(new Error('next physical step leaves arena bounds'), { code: 'ARENA_BOUNDARY' })
    } catch (err) { bounds.error = Object.assign(new Error('cannot verify next arena step: ' + err.message), { code: 'ARENA_BOUNDARY' }) }
    rejectBounds(bounds.error)
    try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch {}
  }
  const bounds: GotoBounds = { error: undefined, failure: boundsFailure, check: checkBounds, restore: restoreBounds }
  if (boundedArena) {
    // В границах арены — по поверхности (без копания и столбов), кроме подъёма к цели (climb, пользователь 14.10: «залез
    // наверх — не строятся»): столбы из своих блоков и прокоп разрешены, границы те же.
    this.gotoArena = boundedArena; this.surfaceStrict = !climb
    ctl.onAbort.push(restoreBounds); bot.on('physicsTick', checkBounds)
  }
  return bounds
}

// Настройки пути на этот переход, выход из воды и ямы, цель (с высотой или без), ходьба поверху.
async function gotoPrepare (this: Session, run: GotoRun): Promise<void> {
  const { bot, ctl, x, y, z, range, surface, bridge, pathWait, pearl, sprint, sprintJump, unstuckWanted, climb, exactY, secs, boundedArena, avoiding } = run
  const deadline = gameClock.now() + secs * 1000
  const strict = surface === 'strict' || !!boundedArena && !climb
  // Мост на ходу на этот переход (сцены A/B на одном демоне): bridge true/false поверх ND_BRIDGE; не задан —
  // как в окружении. Держится до следующего goto.
  this.bridgeWanted = typeof bridge === 'boolean' ? bridge : undefined
  this.sprintWanted = typeof sprint === 'boolean' ? sprint : undefined
  // Бег вприпрыжку на этот переход (A/B в одном сеансе, try-parkour-sprint): поверх ND_SPRINT_JUMP.
  bot._ndSprintJumpWanted = typeof sprintJump === 'boolean' ? sprintJump : undefined
  // Цель — для выбора бега (болото у цели — шагом), высота — тела, если не задана.
  this.gotoTarget = bot.entity ? new Vec3(Math.floor(x) + 0.5, y == null ? bot.entity.position.y : Number(y), Math.floor(z) + 0.5) : null
  // Пустой частичный результат поиска — ждать продолжения, а не «дошёл» (movement.gotoGoal): ND_GOTO_WAIT=1,
  // pathWait:true или мост на ходу (обход и мост ищутся дольше 40 мс первого тика).
  const waitPartial = avoiding || (typeof pathWait === 'boolean' ? pathWait : (gotoWaitOn() || !!(this.bridgeWanted ?? blockmoves.on())))
  if (this.bridgeWanted) blockmoves.install(this)
  this.updateMovements()
  // Лестница выхода из застреваний (unstuck.js): ND_UNSTUCK или goto { unstuck }; только в новом goto (gotoGoal).
  const un = !strict && waitPartial && lazyUnstuck().on(unstuckWanted) ? lazyUnstuck().watch(this, ctl, { deadline }) : null
  console.log('[goto]', JSON.stringify({ to: [x, y ?? null, z], from: bot.entity ? [Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z)] : null,
    bridge: !!(this.movements && this.movements.bridge), wait: waitPartial, unstuck: !!un, sprint: !!(bot.pathfinder.movements && bot.pathfinder.movements.allowSprinting), pearl: hopgoto.on(pearl) }))
  // С лестницей выхода к берегу плыть, только если он вплавь есть: пруд в яме (берег выше воды на 2+) escapeWater
  // обходил по 25 с впустую (try-lab-stuck pond, us-pilot1) — оттуда выводит ступенька/лесенка лестницы.
  if (!strict && inWater(bot) && !(un && !lazyUnstuck().landBySwim(bot))) await escapeWater(bot, ctl)
  const goalBelow = () => waitPartial && y != null && Number.isFinite(Number(y)) && Number(y) < bot.entity.position.y - 2
  const pit: Pit = strict || goalBelow() ? { wasInPit: false } : await escapePit(bot, ctl, { mcData: this.mcData, maxClimb: 24 })
  const bx = Math.floor(x)
  const bz = Math.floor(z)
  if (strict && !boundedArena) await lazyFortify().leaveSealedCell(this, ctl, { x: bx + 0.5, z: bz + 0.5 })
  let goal
  let resolvedTo
  if (y === undefined || y === null) {
    goal = new goals.GoalNearXZ(bx, bz, Math.max(1, range))
    resolvedTo = { x: bx, y: null, z: bz, mode: 'xz' }
  } else {
    // exactY — ровно на эту высоту, хоть в воздух (столбик к цели на краю крыши): standableY нашёл бы пол ниже, и «дошёл»
    // засчитывался внизу (Codex 15.10, паузы стенда «-2.5 по высоте»).
    const yy = exactY && climb ? Math.floor(y) : standableY(bot, bx, Math.floor(y), bz) ?? (strict ? Math.floor(y) : null)
    if (yy === null) {
      goal = new goals.GoalNearXZ(bx, bz, Math.max(2, range))
      resolvedTo = { x: bx, y: null, z: bz, mode: 'xz (нет места встать на заданной высоте)' }
    } else {
      goal = new goals.GoalNear(bx, yy, bz, range)
      resolvedTo = { x: bx, y: yy, z: bz, mode: 'near' }
    }
  }

  if (boundedArena && resolvedTo.y != null && !lazyParkour().withinArena(bot, { x: bx + .5, y: resolvedTo.y, z: bz + .5 }, boundedArena)) throw Object.assign(new Error('resolved goto support is outside arena bounds'), { code: 'ARENA_BOUNDARY' })
  // Цель под крышей (небо ≤ 7 в клетке ног цели): поверху к ней не дойти, а штраф крыши раздувает A* у самой цели
  // (s6b 06.10, арена S7: комнаты под перекрытием; над западом висит кусок рельефа, небо там на 1 темнее — A* запад
  // 62 узла против 9 зеркально, на 750 TPS «partial» по кругу; try-parkour-path-mirror.js). Только для цели с высотой:
  // у цели без y клетка «на высоте тела» в колонне горы — внутри камня (небо 0), и strict снимался — штрек сквозь гору
  // (замечание проверки S6c 07.10).
  // Снимается только штраф крыши; запрет копки strict остаётся как до правки.
  const goalSky = resolvedTo.y == null ? null : skyLightAt(bot, new Vec3(bx, Math.floor(resolvedTo.y), bz))
  const overSurface = surface !== false && (surface === true || this.underSky())
  const surfaceWalk = overSurface && !(goalSky !== null && goalSky <= 7)

  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  Object.assign(run, { deadline, strict, waitPartial, un, goalBelow, pit, bx, bz, goal, resolvedTo, surfaceWalk })
}

// Ходы до pathfinder'а: жемчуг, быстрый спуск, подъём на лодке; сторож края обрыва на время попыток.
async function gotoPreMoves (this: Session, run: GotoRun): Promise<void> {
  const { bot, ctl, pearl, descent, boundedArena, bx, bz, goal, resolvedTo } = run
  // Жемчуг как ход (hopgoto.js): пеший путь по A* долгий (обход) — бросок к цели, дальше пешком.
  // pearl: true | { reserve, … } или ND_PEARL_GOTO=1; резерв по умолчанию 12 (очи Края).
  let pearlRun = null
  if (!boundedArena && hopgoto.on(pearl)) {
    try { pearlRun = await hopgoto.maybeHop(this, ctl, { x: bx, y: resolvedTo.y, z: bz }, goal, pearl) } catch (err) { pearlRun = { hopped: false, why: 'ошибка: ' + err.message } }
    if (ctl.aborted) throw new Error('прервано')
  }
  run.pearlRun = pearlRun

  // Быстрый спуск со скалы (navigation/descent.ts, S6c): цель ниже на 6+ — прыжок в воду, уступы или блоки вдоль
  // стены, если быстрее пешего пути pathfinder'а. descent: false | { minGain, maxFallDamage, … }; ND_DESCENT=0 — выкл.
  // На ходу — сторож (descent.watch): у края с готовым вариантом попытка pathfinder'а обрывается, решает maybeDescend.
  run.descentRuns = []
  const descentMod = lazyDescent()
  run.descentOpt = typeof descent === 'object' && descent ? descent : {}
  const descentOpt = run.descentOpt
  const firstDescent = !boundedArena && descentMod.on(descent) ? await gotoDescendNow.call(this, run) : null
  // Подъём на лодке по уступам (navigation/boat-moves.ts): цель выше на 4+ — сравнить с пешим путём. ND_ASCENT_BOAT=0 — выкл.
  if (!boundedArena && descentMod.on(descent) && !(firstDescent && firstDescent.used)) {
    try { await lazyBoatMoves().maybeAscend(this, ctl, { x: bx, y: resolvedTo.y, z: bz }, goal, descentOpt) } catch (err) { console.log('[ascent] ошибка: ' + err.message) }
    if (ctl.aborted) throw new Error('прервано')
  }
  run.failDescent = null
  run.descentWatch = !boundedArena && descentMod.on(descent) && !(firstDescent && firstDescent.efficient) ? descentMod.watch(bot, { x: bx, y: resolvedTo.y, z: bz }, () => { if (!run.failDescent) return false; run.failDescent(Object.assign(new Error('край обрыва — спуск'), { descent: true })); return true }) : null
}

// Спуск у края сейчас (descent.maybeDescend); удачный — в отчёт goto.
async function gotoDescendNow (this: Session, run: GotoRun): Promise<any> {
  const { ctl, bx, bz, goal, resolvedTo, descentOpt } = run
  const descentMod = lazyDescent()
  let r
  try { r = await descentMod.maybeDescend(this, ctl, { x: bx, y: resolvedTo.y, z: bz }, goal, descentOpt) } catch (err) { r = { used: null, why: 'ошибка: ' + err.message } }
  if (ctl.aborted) throw new Error('прервано')
  if (r && r.used) run.descentRuns.push(r)
  return r
}

// Одна попытка pathfinder'а к цели g: сторож застревания, отказы установки, сторож спуска и границы арены.
async function gotoAttempt (this: Session, run: GotoRun, g): Promise<void> {
  const { bot, ctl, un, strict, surfaceWalk, avoiding, waitPartial, boundedArena, climb, bounds } = run
  // С лестницей выхода сторож — последняя страховка: застревание раньше ловит и лечит unstuck.
  const guard = stuckGuard(bot, ctl, un && !un.exhausted() ? 45000 : 8000)
  const mv = bot.pathfinder.movements
  const dug = mv ? mv.canDig : undefined
  const scaffold = mv ? mv.scafoldingBlocks : undefined
  if (strict && mv) { mv.canDig = false; mv.scafoldingBlocks = [] }
  this.surfaceWalk = surfaceWalk
  this.pathGoalY = typeof g.y === 'number' ? g.y : null
  this.surfaceStrict = strict
  let failPlace
  const placeGuard = new Promise((resolve, reject) => { failPlace = reject })
  const descentGuard = new Promise((resolve, reject) => { run.failDescent = reject })
  let placeErrors = 0
  const onReset = (reason) => {
    if (reason === 'place_error' && ++placeErrors >= 6) failPlace(new Error('блок под ноги не ставится — шесть отказов подряд, этот путь не работает'))
  }
  const onPath = r => {
    // Исчерпан поиск — нет пути в обход; «timeout» с частичным путём — идти по нему (соседи уже вне зоны врага): со срезом
    // 250 мс и отказом на timeout лутающие стояли — путь по колизею в 40 бл. не находился (стенд 15.10: 11–18 сбросов сторожа).
    if (avoiding && (r?.status === 'noPath' || r?.status === 'timeout' && !r.path?.length)) failPlace(Object.assign(new Error('no route outside enemy clearance: ' + r.status), { code: 'AVOID_NO_PATH' }))
  }
  bot.on('path_reset', onReset)
  if (avoiding) bot.on('path_update', onPath)
  let pathRequest
  const cancelPath = () => pathRequest?.cancel?.()
  ctl.onAbort.push(cancelPath)
  try {
    pathRequest = waitPartial ? gotoGoal(bot, g, { unstuck: un }) : bot.pathfinder.goto(g)
    if (ctl.aborted) cancelPath()
    await Promise.race([pathRequest, guard.promise, placeGuard, descentGuard, ...(boundedArena ? [bounds.failure] : [])])
    if (bounds.error) throw bounds.error
    // goto резолвит и пустой partial-путь. Достигнутая цель определяется
    // координатами тела, включая высоту для 3D-плана.
    if (!g.isEnd(bot.entity.position.floored())) {
      throw Object.assign(new Error('pathfinder закончил путь, но не достиг цели — не дошёл'), { noStep: true })
    }
  } finally {
    // An Emergency can fence setGoal(null); closing our waiter also cancels its queued lease resume.
    cancelPath()
    const index = ctl.onAbort.indexOf(cancelPath)
    if (index >= 0) ctl.onAbort.splice(index, 1)
    run.failDescent = null
    bot.removeListener('path_reset', onReset)
    if (avoiding) bot.removeListener('path_update', onPath)
    this.surfaceWalk = false
    this.pathGoalY = null
    this.surfaceStrict = !!boundedArena && !climb
    if (strict && mv) { mv.canDig = dug; mv.scafoldingBlocks = scaffold }
    guard.stop()
  }
}

// План (цель с высотой, затем по XZ) и повторы попыток: спуск у края, прогресс, пустой маршрут, яма, встряска.
async function gotoLoop (this: Session, run: GotoRun): Promise<any> {
  const { bot, ctl, y, range, secs, boundedArena, avoiding, climb, exactY, bounds, deadline, strict, waitPartial, un, goalBelow, pit, bx, bz, goal, resolvedTo, surfaceWalk, pearlRun, descentRuns, descentWatch } = run
  const plan = [{ goal, mode: resolvedTo.mode }]
  if (resolvedTo.mode === 'near' && !strict && !(exactY && climb)) {
    plan.push({ goal: new goals.GoalNearXZ(bx, bz, Math.max(2, range)), mode: 'xz' })
  }

  const tried = []
  let settledRetry = false
  let lastError = null
  const outOfTime = () => gameClock.now() >= deadline
  const away = () => Math.round(Math.hypot(bot.entity.position.x - bx, bot.entity.position.z - bz))
  const report = why => ({
    at: xyz(bot.entity.position),
    target: { x: bx, y: resolvedTo.y, z: bz, mode: resolvedTo.mode },
    attempts: tried.length,
    tried: tried.length ? tried : undefined,
    awayBlocks: away(),
    stopped: why,
    climbedOut: pit.wasInPit ? pit.climbed : undefined
  })
  const ranOut = () => report(
    `время вышло за ${secs}с — не дошёл, до цели ещё ${away()} блоков по горизонтали` +
    (lastError ? `: ${lastError.message}` : ''))

  let progressRetries = 0
  let descentChecks = 0
  let stuckOut = false
  let strictEscaped = false
  ctl.onAbort.push(() => descentWatch && descentWatch.stop())
  try {
  for (const step of plan) {
    if (stuckOut) break
    for (let retry = 0; retry < 2; retry++) {
      if (outOfTime()) return ranOut()
      const away0 = away()
      try {
        await gotoAttempt.call(this, run, step.goal)
        return {
          arrived: xyz(bot.entity.position),
          target: { x: bx, y: resolvedTo.y, z: bz, mode: step.mode },
          attempts: tried.length + 1,
          climbedOut: pit.wasInPit ? pit.climbed : undefined,
          surface: surfaceWalk || undefined,
          pearl: pearlRun || undefined,
          descent: descentRuns.length ? (descentRuns.length === 1 ? descentRuns[0] : descentRuns) : undefined,
          unstuck: un && (un.stats.detected || un.stats.refusals) ? un.report() : undefined
        }
      } catch (err) {
        if (bounds.error) throw bounds.error
        if (ctl.aborted) throw err
        if (avoiding) {
          try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch {}
          throw Object.assign(err, { code: err.code || 'AVOID_NO_PATH' })
        }
        if (err.descent) {
          // Сторож спуска: решить у края; «пешком» — сюда не возвращаться. Попытка не в счёт.
          try { bot.pathfinder.setGoal(null) } catch {}
          const r = await gotoDescendNow.call(this, run)
          if (descentWatch) descentWatch.skip(bot.entity.position)
          if (descentWatch && r && r.efficient) descentWatch.stop()
          tried.push(`спуск: ${r && r.used ? r.used + (r.why ? ' (' + r.why + ')' : '') : 'пешком'}`)
          if (++descentChecks >= 6 && descentWatch) descentWatch.stop()
          retry--
          continue
        }
        lastError = err
        tried.push(`${step.mode}#${retry + 1}: ${err.message}`)
        const gained = away0 - away()
        if (waitPartial && progressRetries < 12 && gained >= 8 && away() > Math.max(4, range + 2)) {
          progressRetries++
          retry--
          tried[tried.length - 1] += ` (ближе на ${gained} бл. — ещё раз)`
          try { bot.pathfinder.setGoal(null) } catch {}
          continue
        }
        // Пустой маршрут — не физическое застревание. Для 3D ещё есть
        // отдельный план XZ; последнюю такую попытку прекращаем сразу.
        if (err.noStep) {
          try { bot.pathfinder.setGoal(null) } catch {}
          // Поверху без копки из кармана ни шагу (своя лестница под крышей, верх своего столба — cl-l/cl-n 14.10: 5–35 мин
          // «pathfinder закончил путь» на месте, потом смерть): один короткий отрезок к цели с копкой, дальше снова поверху.
          if (strict && !boundedArena && !strictEscaped && away0 - away() < 1 && !outOfTime()) {
            strictEscaped = true
            const was = bot.entity.position.clone()
            const ex = bx + .5 - was.x, ez = bz + .5 - was.z, n = Math.hypot(ex, ez) || 1
            const leg = Math.min(12, n)
            let timer
            try {
              await Promise.race([bot.pathfinder.goto(new goals.GoalNearXZ(Math.floor(was.x + ex / n * leg), Math.floor(was.z + ez / n * leg), 2)),
                new Promise(resolve => { timer = gameClock.setTimeout(resolve, 20000) })])
            } catch {} finally { gameClock.clearTimeout(timer); try { bot.pathfinder.setGoal(null) } catch {} }
            if (ctl.aborted) throw new Error('прервано')
            const moved = bot.entity.position.distanceTo(was)
            tried.push(`выход с копкой: ${Math.round(moved)} бл.`)
            if (moved >= 3) { retry--; continue }
          }
          if (y != null && resolvedTo.y != null && !outOfTime()) {
            const parkour = lazyParkour()
            const local = boundedArena ? await parkour.executeJump(bot, ctl, { x: bx + .5, y: resolvedTo.y, z: bz + .5 }, { arena: boundedArena }) : await parkour.tryLocal(bot, ctl, { x: bx + .5, y: resolvedTo.y, z: bz + .5 })
            if (ctl.aborted) throw new Error('прервано')
            if (local.ok) return { arrived: xyz(bot.entity.position), target: { x: bx, y: resolvedTo.y, z: bz, mode: 'parkour' }, attempts: tried.length + 1, parkour: { ticks: local.ticks } }
          }
          if (waitPartial && !settledRetry && (!bot.entity.onGround || bot.entity.isInWater)) {
            settledRetry = true
            const t0 = gameClock.now()
            while (gameClock.now() - t0 < 1500 && !ctl.aborted && (!bot.entity.onGround || bot.entity.isInWater)) await new Promise(resolve => gameClock.setTimeout(resolve, 50))
            tried.push('ждал посадки')
            continue
          }
          break
        }
        // exactly how the answer used to turn into a bare clock: the abort
        if (outOfTime()) return ranOut()
        const out: Pit = strict || goalBelow() ? { wasInPit: false } : await escapePit(bot, ctl, { mcData: this.mcData, maxClimb: 24 })
        if (out.wasInPit) tried.push(`вылез из ямы на ${out.climbed}${out.stopped ? ' (' + out.stopped + ')' : ''}`)
        if (!strict) await unstick(bot)
      }
    }
  }
  } finally { if (descentWatch) descentWatch.stop() }
  if (un) console.log('[unstuck] goto', JSON.stringify(un.report()))
  throw new Error(
    `не дошёл (${tried.length} попытки)${pit.wasInPit ? `, из ямы вылез на ${pit.climbed}${pit.stopped ? ' — ' + pit.stopped : ''}` : ''}. ` +
    `Последняя: ${lastError.message}`)
}

export { goto }
