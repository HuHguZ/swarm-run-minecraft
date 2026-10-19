'use strict'
// Ходьба: путь pathfinder'а с ожиданием частичного поиска (gotoGoal), бег, удержание пути узлом-меткой.
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// bot.pathfinder.goto (mineflayer-pathfinder 2.4.5 lib/goto.js) резолвит промис на первом path_update с пустым путём
// — и на ЧАСТИЧНОМ результате поиска (status 'partial': 40 мс поиска на тик), если лучший узел пока сам старт: провал,
// стена или река между телом и целью, а обход уводит сначала прочь от цели. Тогда goto «дошёл», не сделав шага,
// session.goto засчитывает «путь длиной 0» и сдаётся за 0.1–0.3 с (ферма 02.10, mv-gap-dbg4: обход провала по
// перемычке в 11 блоках вбок не находился ни разу, 17–34 узла за 40 мс). Здесь тот же контракт, но пустой partial —
// ждать: поиск продолжается в следующих тиках (monitorMovement: astarContext.compute, пока partial; не дольше
// thinkTimeout = 5 с, потом 'timeout').
// По умолчанию включено (02.10, после серий на ферме); ND_GOTO_WAIT=0 — старое поведение goto.js. Сцены — goto { pathWait }.
export function gotoWaitOn () { return process.env.ND_GOTO_WAIT !== '0' }
// Бег в goto (pathfinder allowSprinting). По умолчанию — в верхнем мире (02.10, после серий на ферме: рельеф пула
// mv-spr-1/2, mv-ka-A/B — медиана −13…−14 % по 72 парам, урон тот же; стенд и MLG — без падений и урона); в Аду и Крае —
// шагом, пока бег не померен у лавы и пустоты. ND_SPRINT=1 — везде, ND_SPRINT=0 — нигде (откат).
export function sprintOn (dim) {
  const v = process.env.ND_SPRINT
  if (v === '1') return true
  if (v === '0') return false
  // 03.10 пользователь: бег во всех мирах (Ад, Край — тоже), шагом — только когда надо (болото — session.updateMovements;
  // край лавы/пустоты — решают этапы). Было: только верхний мир.
  return dim !== undefined
}

// «stuck» на ходу (mineflayer-pathfinder 2.4.5, index.js): исполнитель засчитывает узел, только когда тело в 0.35 от
// path[0], и только тогда обновляет lastNodeTime; через 3.5 с без этого — resetPath('stuck') и поиск A* С НУЛЯ. Пока
// поиск идёт ('partial', каждый тик новый путь), pathFromPlayer срезает узел, на котором тело стоит (reached → minI + 1),
// ДО проверки прибытия — узел не засчитывается никогда, и через 3.5 с поиска путь сбрасывается, хотя тело бежит по нему
// (рельеф пула, mv-spr-dbg4: 41 → 33 по x за 1.5 с и «stuck» на 3.5 с поиска; поиск дальней ноги не доходил до конца).
// Лечим снаружи: в path_update (событие уходит до path = results.path) — если тело сдвинулось на 0.8+ блока с прошлой
// метки, кладём в начало пути узел-метку в точке тела: исполнитель в этом же тике засчитывает его (lastNodeTime = now)
// и идёт к настоящему path[0]. Стоит на месте — метки нет, честный «stuck» остаётся. По умолчанию вкл. (пользователь 10.10: «бот
// начинает бежать по пути и достраивает маршрут по ходу» — арена: поиск в Колизее 1.5–2.3 с, бот стоял); ND_PATH_KEEPALIVE=0 — выкл.
export function pathKeepAliveOn () { return process.env.ND_PATH_KEEPALIVE !== '0' }
// Таймаут A* с лучшим путём — идти по нему до конца, а не отказывать (gotoGoal). По умолчанию вкл. (10.10, как выше); ND_GOTO_TIMEOUT_WALK=0 — выкл.
export function timeoutWalkOn () { return process.env.ND_GOTO_TIMEOUT_WALK !== '0' }
export function pathKeepAlive (bot, { minMove = 0.8 }: any = {}) {
  let mark = null
  const stats = { marks: 0 }
  const onReset = () => { mark = null }
  const onUpdate = (r) => {
    try {
      if (!pathKeepAliveOn() || !r || !Array.isArray(r.path) || !r.path.length || !bot.entity) return
      const p = bot.entity.position
      if (!mark) { mark = p.clone(); return }
      if (p.distanceTo(mark) < minMove) return
      const n0 = r.path[0]
      // Узел с копкой/стройкой и узлы своих исполнителей (мост, спуск) не трогаем: там свой порядок.
      if (!n0 || (n0.toBreak && n0.toBreak.length) || (n0.toPlace && n0.toPlace.length) || n0.ndBridge || n0.ndDescend) return
      if (Math.abs(n0.x - p.x) <= 0.35 && Math.abs(n0.z - p.z) <= 0.35) { mark = p.clone(); return } // и так засчитает
      const n: any = new Vec3(p.x, p.y, p.z)
      n.toBreak = []; n.toPlace = []; n.parkour = false; n.cost = 0; n.remainingBlocks = n0.remainingBlocks; n.ndKeep = true
      r.path.unshift(n)
      mark = p.clone()
      stats.marks++
    } catch {}
  }
  bot.on('path_update', onUpdate)
  bot.on('path_reset', onReset)
  return { stats, stop () { bot.removeListener('path_update', onUpdate); bot.removeListener('path_reset', onReset) } }
}

// opts.unstuck — наблюдатель лестницы выхода (unstuck.watch, ND_UNSTUCK): пока идёт ступень, свои setGoal(null)/goal
// не рвут переход; отказ поиска не у цели он может взять себе (ступень, потом та же цель ещё раз).
export function gotoGoal (bot, goal, opts: any = {}) {
  // Native postProcessPath mutates partial A* nodes to block centres. Search and
  // execution must both check block coordinates, including fractional-radius goals.
  const ownEnd = Object.hasOwn(goal, 'isEnd')
  const isEnd = goal.isEnd
  const blockEnd = node => isEnd.call(goal, node.floored())
  goal.isEnd = blockEnd
  let cancel
  const promise = new Promise<any>((resolve, reject) => {
    const error = (name, message) => Object.assign(new Error(message), { name })
    let done = false
    let un = null
    let resumeTimer = null
    const cleanup = (err?: any) => {
      if (done) return
      done = true
      if (goal.isEnd === blockEnd) {
        if (ownEnd) goal.isEnd = isEnd
        else delete goal.isEnd
      }
      if (un) un.stop()
      if (resumeTimer) gameClock.clearTimeout(resumeTimer)
      bot.removeListener('end', onEnd)
      bot.removeListener('death', onDeath)
      bot.removeListener('goal_reached', onReached)
      bot.removeListener('path_update', onPath)
      bot.removeListener('goal_updated', onGoal)
      bot.removeListener('path_stop', onStop)
      bot.removeListener('physicsTick', onTick)
      bot.removeListener('path_reset', onReset)
      setImmediate(() => (err ? reject(err) : resolve(undefined)))
    }
    cancel = () => cleanup(error('PathStopped', 'Path caller finished before the goal!'))
    const onReached = () => { if (un && un.busy()) return; cleanup() }
    // A* не уложился в 5 с ('timeout'), но лучший путь есть — pathfinder идёт по нему (index.js: path = лучший), а в
    // конце встаёт: нового поиска сам не начнёт (pathUpdated). goto.js тут отказывал «Took to long», и попытка пропадала.
    // Идём до конца этого пути и отдаём «дошёл, но не до цели» — session.goto повторит из нового места (ближе — не в счёт).
  let walkingTimeout = false
  let pathContext = null, prefix = null, prefixEnd = null, prefixStarted = false, continuePrefix = false, terminalPrefix = false
    const onTick = () => {
      if (done) return
      // Custom bridge consumption need not emit another terminal path update.
      const exhausted = terminalPrefix && prefixStarted && !prefix.length && bot.entity?.onGround &&
        bot.pathfinder.goal === goal && !goal.isEnd(bot.entity.position) &&
        !bot.pathfinder.isMining?.() && !bot.pathfinder.isBuilding?.()
      if ((continuePrefix || exhausted) && !bot.pathfinder.isMoving() && !(un && un.busy())) {
        continuePrefix = false; terminalPrefix = false
        bot.pathfinder.setGoal(goal)
      } else if (walkingTimeout && !bot.pathfinder.isMoving()) cleanup()
    }
    const onReset = () => {
      walkingTimeout = false
      pathContext = null; prefix = null; prefixEnd = null; prefixStarted = false; continuePrefix = false; terminalPrefix = false
    }
    const onPath = (r) => {
      if (done || !r || (un && un.busy())) return
      if (r.context) {
        if (pathContext !== r.context) {
          pathContext = r.context; prefix = null; prefixEnd = null; prefixStarted = false; continuePrefix = false; terminalPrefix = false
        }
        if (prefixStarted && !prefix.length && (r.status === 'partial' || r.status === 'success')) {
          // Keep the continuing search. Its next child is ready only when the
          // parent chain still contains the exact Move consumed under our feet.
          if (r.status === 'partial') {
            const ready = []
            let n = r.ndPartialNode || r.context.bestNode
            for (; n && n.data !== prefixEnd; n = n.parent) ready.push(n.data)
            ready.reverse()
            // A different native branch is already trimmed from the body. Keep
            // that publication only when Physics proves its actual next edge.
            if (!n) ready.splice(0, ready.length, ...r.path)
            const p = bot.entity?.position
            const reached = q => p && q && Math.abs(p.x - q.x) <= .35 && Math.abs(p.z - q.z) <= .35 && Math.abs(p.y - q.y) < 1
            const marker = ready[0]?.ndKeep ? ready[0] : null
            const step = marker ? ready.slice(1) : ready, first = step[0]
            if (!reached(prefixEnd) || !bot.entity.onGround || bot.pathfinder.isMining?.() || bot.pathfinder.isBuilding?.() ||
                (marker && (!reached(marker) || marker.toBreak?.length || marker.toPlace?.length || marker.ndBridge || marker.ndDescend)) ||
                !first || reached(first) || first.toBreak?.length || first.toPlace?.length || first.ndBridge || first.ndDescend ||
                // canMove bypasses its simulator in water; it cannot prove a different branch there.
                (!n && bot.entity.isInWater) || bot.pathfinder.canMove?.(step) !== true) { r.path.length = 0; return }
            r.path.splice(0, r.path.length, ...ready)
          } else {
            const first = r.path[0]
            if (!bot.entity?.onGround || bot.pathfinder.isMining?.() || bot.pathfinder.isBuilding?.() ||
                !first || first.toBreak?.length || first.toPlace?.length || first.ndBridge || first.ndDescend ||
                bot.pathfinder.canMove?.(r.path) !== true) {
              continuePrefix = true; r.path.length = 0
              return
            }
          }
        }
        if (prefix && prefix.length) {
          const tail = r.path.indexOf(prefix[prefix.length - 1])
          if (tail >= 0) prefix.push(...r.path.slice(tail + 1))
          else if (r.status === 'success') {
            const first = prefix[0]
            const ready = []
            if (bot.entity?.onGround && !bot.pathfinder.isMining?.() && !bot.pathfinder.isBuilding?.() &&
                !first.toBreak?.length && !first.toPlace?.length && !first.ndBridge && !first.ndDescend &&
                bot.pathfinder.canMove?.(prefix) === false) {
              // The success node remains in native AStar's open map. bestNode
              // may be a different branch; keep every parent, including jumps
              // discarded by native nearest-node trimming.
              const last = r.path.at(-1), terminal = r.context.openDataMap?.get(last?.hash)
              if (terminal?.data === last) for (let n = terminal; n?.parent; n = n.parent) ready.push(n.data)
            }
            if (ready.length) { prefix = ready.reverse(); continuePrefix = false }
            else continuePrefix = true
          }
          // Session/custom executors already hold this publication's array.
          // Change its contents, so every consumer walks the selected prefix.
          if (r.path !== prefix) r.path.splice(0, r.path.length, ...prefix)
        } else if (!prefixStarted && r.status === 'partial' && r.path.length) {
          // Native nearest-node trimming can cut the detour before a wall.
          // Its already postprocessed A* chain still contains that ready prefix.
          const ready = []
          for (let n = r.ndPartialNode || r.context.bestNode; n && n.parent; n = n.parent) ready.push(n.data)
          r.path.splice(0, r.path.length, ...ready.reverse())
        }
        prefix = r.path
        if (prefix.length) prefixEnd = prefix.at(-1)
        prefixStarted ||= prefix.length > 0
        terminalPrefix = r.status === 'success'
      }
      walkingTimeout = false
      const empty = !r.path || r.path.length === 0
      if (empty && r.status === 'partial') return
      if (!empty && r.status !== 'noPath' && r.status !== 'timeout') return
      if (!empty && r.status === 'timeout' && timeoutWalkOn()) { walkingTimeout = true; return }
      // Как goto.js: пустой путь — «дошёл» (session проверит, у цели ли), noPath/timeout — отказ.
      const answer = () => {
        if (empty) return cleanup()
        return r.status === 'noPath' ? cleanup(error('NoPath', 'No path to the goal!')) : cleanup(error('Timeout', 'Took to long to decide path to goal!'))
      }
      // Отказ поиска не у цели — лестнице выхода, если возьмёт; не поможет — отдаст тот же ответ (answer).
      if (un && bot.entity && !(empty && goal.isEnd(bot.entity.position.floored())) && un.refused(r, answer)) return
      answer()
    }
    // Цель сбросил рефлекс падения (reflex-lock take, Emergency) — пауза: после рефлекса та же цель снова (ND_GOTO_RESUME=0 — выкл.).
    let paused = false
    const onGoal = (g) => {
      if (un && un.busy()) return
      const lease = g === null && bot._ndReflexTake
      if (lease && process.env.ND_GOTO_RESUME !== '0') {
        paused = true
        lease.after(() => { if (!done) resumeTimer = gameClock.setTimeout(() => { resumeTimer = null; if (!done && paused) { paused = false; bot.pathfinder.setGoal(goal) } }, 0) })
        return
      }
      if (g !== goal) cleanup(error('GoalChanged', 'The goal was changed before it could be completed!'))
    }
    const onStop = () => { if (un && un.busy()) return; cleanup(error('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.')) }
    const onEnd = () => cleanup(error('Disconnected', 'соединение закрыто посреди пути'))
    const onDeath = () => cleanup(error('Died', 'бот умер посреди пути'))
    bot.on('end', onEnd)
    bot.on('death', onDeath)
    bot.on('path_stop', onStop)
    bot.on('goal_reached', onReached)
    bot.on('path_update', onPath)
    bot.on('goal_updated', onGoal)
    bot.on('physicsTick', onTick)
    bot.on('path_reset', onReset)
    if (opts.unstuck) un = opts.unstuck.attach(bot, goal, { resume: () => { if (!done) bot.pathfinder.setGoal(goal) }, fail: err => cleanup(err) })
    bot.pathfinder.setGoal(goal)
  })
  return Object.assign(promise, { cancel: () => cancel?.() })
}

export function gotoPath (bot, goal) {
  return gotoWaitOn() ? gotoGoal(bot, goal) : bot.pathfinder.goto(goal)
}
