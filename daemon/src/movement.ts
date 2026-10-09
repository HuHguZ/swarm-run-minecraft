'use strict'
const gameClock = require('./game-clock')
const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const geometry = require('./navigation/geometry')

const sleep = (ms) => gameClock.sleep(ms)
// Floor, not round. An entity standing at x=121.5 is in block 121, but rounding
// reports 122 — and the brain then hands 122 to /setblock or to its own
// coordinate arithmetic and acts on the block next door. This is what the game
// itself shows on the F3 "Block" line, and block positions are integers already,
// so nothing else changes.
const xyz = v => (v ? { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) } : null)

// A route shaft is usable only after an actual descent in one block column.
function shaftFromDescent (from, to) {
  if (![from, to].every(p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k])))) return null
  const a = xyz(from); const b = xyz(to)
  if (a.x !== b.x || a.z !== b.z || a.y <= b.y) return null
  return { x: a.x, z: a.z, top: a.y, bottom: b.y }
}

// Coordinates handed to us usually come from observe(), which reports the
// position of a block, not of a place you can stand. Asking pathfinder to
// reach the inside of a stone block means no valid node exists, and with
// canDig enabled A* will happily explore twenty thousand nodes before giving
// up. So snap to the nearest standable column first.
function standableY (bot, x, y, z) {
  return geometry.standPositions(bot, new Vec3(x, y, z), { rise: 8, drop: 8 })[0]?.y ?? null
}

// What the bot is physically sitting in when it refuses to move. A valid path
// the bot cannot walk almost always means the body is caught on something.
function describeStall (bot) {
  const name = b => (b ? b.name : 'void')
  const p = bot.entity.position
  return {
    pos: xyz(p),
    ground: name(bot.blockAt(p.offset(0, -1, 0))),
    legs: name(bot.blockAt(p)),
    head: name(bot.blockAt(p.offset(0, 1, 0))),
    ahead: (() => { try { const b = bot.blockAtCursor(4); return b ? b.name : 'air' } catch { return '?' } })(),
    inWater: !!bot.entity.isInWater,
    onGround: !!bot.entity.onGround
  }
}

// Pathfinder reports "partial" forever when the goal is unreachable; the bot
// just stands there. Fail loudly instead of burning the whole timeout.
function stuckGuard (bot, ctl, stagnantLimitMs = 8000) {
  let last = bot.entity.position.clone()
  let stagnant = 0
  let timer = null
  const promise = new Promise<any>((_resolve, reject) => {
    timer = gameClock.setInterval(() => {
      const now = bot.entity.position
      if (now.distanceTo(last) > 0.6) {
        last = now.clone()
        stagnant = 0
      } else {
        stagnant += 1500
      }
      if (stagnant >= stagnantLimitMs) {
        gameClock.clearInterval(timer)
        const diag = describeStall(bot)
        console.log('[stuck]', JSON.stringify(diag))
        try { bot.pathfinder.setGoal(null) } catch {}
        reject(new Error(`застрял на ${diag.legs} у ${diag.ahead}: за ${stagnantLimitMs / 1000}с не сдвинулся`))
      }
    }, 1500)
  })
  ctl.onAbort.push(() => gameClock.clearInterval(timer))
  return { promise, stop: () => gameClock.clearInterval(timer) }
}

// mineflayer-pathfinder is a 2023-era library driving a 2026 game; it
// regularly plans a route the body then fails to walk. Rather than chase every
// individual mismatch, shake the bot loose and let it re-plan from a slightly
// different spot — which is what a person does when they snag on a corner.
function groundBehind (bot) {
  try {
    const yaw = bot.entity.yaw
    // mineflayer: взгляд вперёд — (-sin yaw, -cos yaw); назад — наоборот.
    const bx = Math.sin(yaw)
    const bz = Math.cos(yaw)
    const p = bot.entity.position
    for (const d of [1, 2]) {
      const c = p.offset(bx * d, 0, bz * d).floored()
      let ok = false
      for (let dy = 0; dy <= 3; dy++) {
        const b = bot.blockAt(c.offset(0, -dy - 1, 0))
        if (!b) break
        if (/lava/.test(b.name)) return false
        if (b.boundingBox === 'block') { ok = true; break }
      }
      if (!ok) return false
    }
    return true
  } catch { return false }
}

async function unstick (bot) {
  try { bot.pathfinder.setGoal(null) } catch {}
  try {
    bot.clearControlStates()
    await sleep(150)
    bot.setControlState('jump', true)
    // Назад — только если за спиной есть пол в трёх блоках вниз: рывок назад
    // с прыжком у края обрыва — это падение, а не освобождение.
    if (groundBehind(bot)) bot.setControlState('back', true)
    await sleep(600)
    bot.setControlState('back', false)
    bot.setControlState('jump', false)
    await bot.look(bot.entity.yaw + Math.PI / 2, 0, true)
    await sleep(250)
  } catch {
  } finally {
    try { bot.clearControlStates() } catch {}
  }
}

// Jumping against a shaft wall can repeatedly be rejected by the server.
// Walk to the middle of the same supported cell before jumping; no position
// packets or local onGround overrides, just ordinary movement controls.
async function centerOnFloor (bot, ctl, timeoutMs = 1000, { water = false } = {}) {
  const support = geometry.supportAt(bot, bot.entity.position, .04)
  if (!support) return false
  const target = new Vec3((support.box.minX + support.box.maxX) / 2, support.top, (support.box.minZ + support.box.maxZ) / 2)
  if (!geometry.bodyClear(bot, target, { water })) return false
  const away = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z)
  if (away() <= 0.08) return true
  const end = gameClock.now() + timeoutMs
  try {
    bot.clearControlStates()
    while (!(ctl && ctl.aborted) && gameClock.now() < end && away() > 0.08) {
      await bot.lookAt(target.offset(0, 1.62, 0), true)
      if (ctl?.aborted) break
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false) }
  await sleep(100)
  return away() <= 0.12
}

// bot.entity.isInWater comes from the physics simulation and does not reliably
// flip on 1.21.11 — the bot was drowning with the flag reading false. Trust the
// blocks the body actually occupies instead.
function inWater (bot) {
  if (!bot || !bot.entity) return false
  if (bot.entity.isInWater) return true
  const p = bot.entity.position
  for (const dy of [0, 0.9, -0.2]) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (b && (b.name === 'water' || b.name === 'bubble_column')) return true
  }
  return false
}

// Nearest spot with solid ground and breathable air above it.
function findNearestLand (bot, maxRadius = 24) {
  const me = bot.entity.position.floored()
  for (let r = 1; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (let dy = -2; dy <= 12; dy++) {
          const p = me.offset(dx, dy, dz)
          const feet = bot.blockAt(p)
          const head = bot.blockAt(p.offset(0, 1, 0))
          const ground = bot.blockAt(p.offset(0, -1, 0))
          if (!feet || !head || !ground) continue
          if (ground.name === 'water' || ground.boundingBox !== 'block') continue
          if (feet.name === 'water' || feet.boundingBox !== 'empty') continue
          if (head.name === 'water' || head.boundingBox !== 'empty') continue
          return p
        }
      }
    }
  }
  return null
}

const waterCell = b => !!b && /^(water|bubble_column)$/.test(b.name)
const swimPassable = b => !!b && b.boundingBox === 'empty' && !/lava/.test(b.name)
const headWet = bot => waterCell(bot.blockAt(require('./pick').eyeOf(bot)))
const dryFooting = bot => !!bot.entity.onGround && !inWater(bot) && bot.blockAt(bot.entity.position.offset(0, -0.2, 0))?.boundingBox === 'block'

// Search connected body-sized cells, rather than declaring a whole pool closed
// because one column has a roof. Unknown cells and lava cannot be crossed.
// The first breath wins when air is scarce; otherwise try to reach dry ground.
function findSwimRoute (bot, { radius = 8, rise = 12, visibleOnly = false }: any = {}) {
  // The PvP escape observes water/air as well as solid faces. Do not plan through
  // an opaque block containing our head; that remains the embedded-body rescue.
  if (visibleOnly && !geometry.bodyClear(bot, bot.entity.position, { water: true, web: true })) return null
  const known = new Map()
  const read = p => {
    if (!visibleOnly) return bot.blockAt(p)
    const key = p.toString()
    if (!known.has(key)) {
      let block = null
      try { if (require('./perception/eyes').seesNow(bot, p)) block = bot.blockAt(p) } catch {}
      known.set(key, block)
    }
    return known.get(key)
  }
  const start = bot.entity.position.floored()
  const key = p => `${p.x},${p.y},${p.z}`
  const queue = [{ p: start, parent: -1 }]
  const seen = new Set([key(start)])
  let air = null
  const urgent = (bot.oxygenLevel ?? 20) <= 8 && headWet(bot)
  const route = (i, kind) => {
    const path = []
    const target = queue[i].p
    while (queue[i].parent >= 0) { path.unshift(queue[i].p); i = queue[i].parent }
    return { kind, target, path }
  }
  const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i].p
    const feet = read(p)
    const head = read(p.offset(0, 1, 0))
    const floor = read(p.offset(0, -1, 0))
    const land = swimPassable(feet) && swimPassable(head) && !waterCell(feet) && !waterCell(head) && floor?.boundingBox === 'block'
    if (land) return route(i, 'land')
    if (swimPassable(head) && !waterCell(head)) {
      if (!air) air = route(i, 'air')
      if (urgent) return air
    }
    const over = read(p.offset(0, 2, 0))
    const next = [...sides.map(d => p.plus(d)), p.offset(0, 1, 0)]
    // A swim jump can leave water onto the ledge one block above it.
    if (swimPassable(over)) next.push(...sides.map(d => p.plus(d).offset(0, 1, 0)))
    for (const q of next) {
      if (Math.max(Math.abs(q.x - start.x), Math.abs(q.z - start.z)) > radius || q.y - start.y > rise) continue
      if (seen.has(key(q))) continue
      const f = read(q); const h = read(q.offset(0, 1, 0)); const g = read(q.offset(0, -1, 0))
      if (!swimPassable(f) || !swimPassable(h)) continue
      if (!waterCell(f) && !waterCell(h) && g?.boundingBox !== 'block') continue
      seen.add(key(q))
      queue.push({ p: q, parent: i })
    }
  }
  return air
}

// Follow the connected swim route with manual controls: the old direct line to
// the bank could point through a wall while jump stayed stuck under a roof.
async function escapeWater (bot, ctl, { timeoutMs = 25000, visibleOnly = false }: any = {}) {
  if (!inWater(bot)) return { ok: true, wasInWater: false }

  try { bot.pathfinder.setGoal(null) } catch {}
  const deadline = gameClock.now() + timeoutMs
  let target = null

  try {
    while (gameClock.now() < deadline && !ctl.aborted && !dryFooting(bot)) {
      const route = findSwimRoute(bot, { visibleOnly })
      target = route?.target || null
      if (!route) break
      if (route.kind === 'air' && !headWet(bot)) break
      const next = route.path[0] || route.target
      const horizontal = Math.hypot(next.x + 0.5 - bot.entity.position.x, next.z + 0.5 - bot.entity.position.z)
      await bot.lookAt(next.offset(0.5, 1.62, 0.5), true)
      if (ctl.aborted || gameClock.now() >= deadline) break
      bot.setControlState('forward', horizontal > 0.25)
      bot.setControlState('sprint', horizontal > 0.25 && (bot.food ?? 20) > 6)
      // Jump doubles as "swim up" in water and keeps the head above surface.
      bot.setControlState('jump', inWater(bot))
      await sleep(160)
    }
  } finally {
    try { bot.clearControlStates() } catch {}
  }

  const out = dryFooting(bot)
  const head = bot.blockAt(require('./pick').eyeOf(bot))
  const breathing = swimPassable(head) && !waterCell(head)
  return {
    ok: out,
    breathing,
    wasInWater: true,
    target: target ? xyz(target) : null,
    error: out ? undefined : breathing ? 'голова в воздухе, но на сухой берег не вышел' : 'не нашёл доступного пути из воды'
  }
}

// Walk toward a column, guarded. Used by exploration, where a failed leg just
// means "try another direction" rather than "the intent failed".
async function travelXZ (bot, ctl, x, z, { range = 4, retries = 2, deadline = null }: any = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (ctl.aborted) return { ok: false, error: 'прервано' }
    if (deadline && gameClock.now() >= deadline) return { ok: false, error: 'время вышло', outOfTime: true }

    // Never start a walk from inside a river — pathfinder will just thrash.
    if (inWater(bot)) {
      const esc = await escapeWater(bot, ctl)
      // Отказ без единого таймера (нет пути из воды) — тик игрового времени, иначе цикл вызывающего крутится микрозадачами
      // и вешает демон (s5c-f4-4 06.10: explore, 100 % CPU, часы стоят).
      if (!esc.ok) { await sleep(50); return { ok: false, error: esc.error } }
    }

    const guard = stuckGuard(bot, ctl)
    const racers = [
      bot.pathfinder.goto(new goals.GoalNearXZ(Math.floor(x), Math.floor(z), range)),
      guard.promise
    ]
    // A single leg must not outlive the caller's budget: the guard only fires
    // when the bot stops moving, and a bot walking the wrong way forever is
    // still "moving".
    let timer = null
    if (deadline) {
      const left = Math.max(1000, deadline - gameClock.now())
      racers.push(new Promise<any>((_resolve, reject) => {
        timer = gameClock.setTimeout(() => reject(Object.assign(new Error('время вышло'), { outOfTime: true })), left)
      }))
    }

    try {
      await Promise.race(racers)
      // mineflayer-pathfinder 2.4.5 lib/goto.js: путь длиной 0 («partial», ни
      // одного шага) goto считает ДОСТИГНУТОЙ целью и резолвит без ошибки.
      // В Аду (искажённый лес, обрывы) это «ok» у тела, не сдвинувшегося ни на
      // блок: разведка крепости насчитала 208 пройденных блоков при 47
      // настоящих (try-nether-trip, 2026-09-25). Свидетель — где тело.
      const at = bot.entity.position
      if (Math.hypot(at.x - (Math.floor(x) + 0.5), at.z - (Math.floor(z) + 0.5)) > range + 1.5) {
        throw Object.assign(new Error('pathfinder не нашёл к цели ни шага (путь длиной 0) — не дошёл'), { noStep: true })
      }
      return { ok: true }
    } catch (err) {
      lastError = err
      try { bot.pathfinder.setGoal(null) } catch {}
      if (ctl.aborted) return { ok: false, error: err.message }
      if (err.outOfTime) return { ok: false, error: 'время вышло', outOfTime: true }
      // Пути нет вовсе — тело и не застревало: рывок назад тут не лечит, а у
      // обрыва в Аду убивает (падение насмерть, try-nether-trip 2026-09-25).
      if (err.noStep) {
        if (bot.physics && bot.entity.onGround && Math.hypot(bot.entity.position.x - (Math.floor(x) + .5), bot.entity.position.z - (Math.floor(z) + .5)) <= 6) {
          const jump = await require('./navigation/parkour').tryLocal(bot, ctl, { x, z })
          if (jump.ok) return { ok: true, parkour: jump }
        }
        return { ok: false, error: err.message, noStep: true }
      }
      await unstick(bot)
    } finally {
      guard.stop()
      if (timer) gameClock.clearTimeout(timer)
    }
  }
  return { ok: false, error: lastError ? lastError.message : 'не дошёл' }
}

// bot.pathfinder.goto (mineflayer-pathfinder 2.4.5 lib/goto.js) резолвит промис на первом path_update с пустым путём
// — и на ЧАСТИЧНОМ результате поиска (status 'partial': 40 мс поиска на тик), если лучший узел пока сам старт: провал,
// стена или река между телом и целью, а обход уводит сначала прочь от цели. Тогда goto «дошёл», не сделав шага,
// session.goto засчитывает «путь длиной 0» и сдаётся за 0.1–0.3 с (ферма 02.10, mv-gap-dbg4: обход провала по
// перемычке в 11 блоках вбок не находился ни разу, 17–34 узла за 40 мс). Здесь тот же контракт, но пустой partial —
// ждать: поиск продолжается в следующих тиках (monitorMovement: astarContext.compute, пока partial; не дольше
// thinkTimeout = 5 с, потом 'timeout').
// По умолчанию включено (02.10, после серий на ферме); ND_GOTO_WAIT=0 — старое поведение goto.js. Сцены — goto { pathWait }.
function gotoWaitOn () { return process.env.ND_GOTO_WAIT !== '0' }
// Бег в goto (pathfinder allowSprinting). По умолчанию — в верхнем мире (02.10, после серий на ферме: рельеф пула
// mv-spr-1/2, mv-ka-A/B — медиана −13…−14 % по 72 парам, урон тот же; стенд и MLG — без падений и урона); в Аду и Крае —
// шагом, пока бег не померен у лавы и пустоты. ND_SPRINT=1 — везде, ND_SPRINT=0 — нигде (откат).
function sprintOn (dim) {
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
// и идёт к настоящему path[0]. Стоит на месте — метки нет, честный «stuck» остаётся. ND_PATH_KEEPALIVE=1 — вкл. (до замера выкл.).
function pathKeepAliveOn () { return process.env.ND_PATH_KEEPALIVE === '1' }
// Таймаут A* с лучшим путём — идти по нему до конца, а не отказывать (gotoGoal). ND_GOTO_TIMEOUT_WALK=1 — вкл. (до замера выкл.).
function timeoutWalkOn () { return process.env.ND_GOTO_TIMEOUT_WALK === '1' }
function pathKeepAlive (bot, { minMove = 0.8 }: any = {}) {
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
      const n = new Vec3(p.x, p.y, p.z)
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
function gotoGoal (bot, goal, opts: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const error = (name, message) => Object.assign(new Error(message), { name })
    let done = false
    let un = null
    const cleanup = (err?: any) => {
      if (done) return
      done = true
      if (un) un.stop()
      bot.removeListener('end', onEnd)
      bot.removeListener('goal_reached', onReached)
      bot.removeListener('path_update', onPath)
      bot.removeListener('goal_updated', onGoal)
      bot.removeListener('path_stop', onStop)
      bot.removeListener('physicsTick', onTick)
      bot.removeListener('path_reset', onReset)
      gameClock.setTimeout(() => (err ? reject(err) : resolve(undefined)), 0)
    }
    const onReached = () => { if (un && un.busy()) return; cleanup() }
    // A* не уложился в 5 с ('timeout'), но лучший путь есть — pathfinder идёт по нему (index.js: path = лучший), а в
    // конце встаёт: нового поиска сам не начнёт (pathUpdated). goto.js тут отказывал «Took to long», и попытка пропадала.
    // Идём до конца этого пути и отдаём «дошёл, но не до цели» — session.goto повторит из нового места (ближе — не в счёт).
    let walkingTimeout = false
    const onTick = () => { if (walkingTimeout && !bot.pathfinder.isMoving()) cleanup() }
    const onReset = () => { walkingTimeout = false }
    const onPath = (r) => {
      if (!r || (un && un.busy())) return
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
        lease.after(() => gameClock.setTimeout(() => { if (!done && paused) { paused = false; bot.pathfinder.setGoal(goal) } }, 0))
        return
      }
      if (g !== goal) cleanup(error('GoalChanged', 'The goal was changed before it could be completed!'))
    }
    const onStop = () => { if (un && un.busy()) return; cleanup(error('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.')) }
    const onEnd = () => cleanup(error('Disconnected', 'соединение закрыто посреди пути'))
    bot.on('end', onEnd)
    bot.on('path_stop', onStop)
    bot.on('goal_reached', onReached)
    bot.on('path_update', onPath)
    bot.on('goal_updated', onGoal)
    bot.on('physicsTick', onTick)
    bot.on('path_reset', onReset)
    if (opts.unstuck) un = opts.unstuck.attach(bot, goal, { resume: () => { if (!done) bot.pathfinder.setGoal(goal) }, fail: err => cleanup(err) })
    bot.pathfinder.setGoal(goal)
  })
}

module.exports = {
  sleep, xyz, shaftFromDescent, standableY, describeStall, stuckGuard, unstick, centerOnFloor, travelXZ,
  findNearestLand, findSwimRoute, escapeWater, inWater, gotoGoal, gotoWaitOn, sprintOn, pathKeepAlive, pathKeepAliveOn, timeoutWalkOn
}
