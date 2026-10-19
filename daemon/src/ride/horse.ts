'use strict'
// Езда (ride.ts): лошадь — выбрать, приручить, оседлать, ехать по пути, привязать.
import { canSeePoint } from '../perception'
import * as gameClock from '../game-clock'
import { itemNamed } from '../items'
import { Physics } from 'prismarine-physics'
import { Vec3 } from 'vec3'
import { withTimeout } from '../build'
import { goals } from 'mineflayer-pathfinder'
import {
  DEBUG, HORSES, TICK, attr, flat, isBaby, isSaddled, isTamedHorse, pacer, sendInput, sendLook, sendVehicle, sleep,
  standOn, toMcYaw, xyz
} from './base'
import { approach, dismount, emptyHand, mountOn, patchVehicle } from './mount'
import { astar, horseFit, horsePlanner, simplify } from './plan'


// ------------------------------------------------------------------ лошадь

export function pickHorse (bot, radius, id) {
  const me = bot.entity.position
  const all = (Object.values(bot.entities) as any[]).filter((e : any) => e && HORSES[e.name] && e.position && e.position.distanceTo(me) <= radius && !isBaby(e))
  if (id) return all.filter((e : any) => e.id === id)
  return all
    .filter((e : any) => canSeePoint(bot, e.position.offset(0, 1, 0)))
    .sort((a: any, b: any) => ((isTamedHorse(b) ? 2 : 0) + (isSaddled(b) ? 1 : 0)) - ((isTamedHorse(a) ? 2 : 0) + (isSaddled(a) ? 1 : 0)) || a.position.distanceTo(me) - b.position.distanceTo(me))
}

export function horseInfo (e) {
  const speed = attr(e, 'movement_speed', null)
  const jump = attr(e, 'jump_strength', null)
  return {
    id: e.id,
    kind: e.name,
    at: xyz(e.position),
    tamed: isTamedHorse(e),
    saddled: isSaddled(e),
    speed: speed === null ? undefined : Math.round(speed * 10000) / 10000,
    // Установившаяся скорость по земле: ввод вперёд 0.98, трение 0.546 — шаг
    // speed·0.98/(1−0.546) за тик, speed×43.2 бл/с (замер в прогоне сходится).
    blocksPerSecond: speed === null ? undefined : Math.round(speed * 0.98 / (1 - 0.546) * 20 * 10) / 10,
    jump: jump === null ? undefined : Math.round(jump * 1000) / 1000
  }
}

// Приручить именно эту лошадь — честно, сидя в седле, пока не стерпит.
// RunAroundLikeCrazyGoal.tick (javap): цель тикает через тик, и раз в
// nextInt(adjustedTickDelay(50)) = nextInt(25) — в среднем раз в 50 тиков
// (2.5 с) — бросок: nextInt(maxTemper=100) < temper → tameWithName (событие 7,
// сердечки), иначе modifyTemper(+5), ejectPassengers, makeMad, событие 6 (дым).
// Нрав дикой с нуля: n-я посадка приручает с шансом 5·(n−1)%, за 15 посадок —
// 99.9%. Слезать самому до броска нельзя: посадка без броска пропадает даром.
// Еда поднимает нрав (handleEating): сахар, пшеница, яблоко +3, золотая морковь
// +5, золотое яблоко +10.
export async function tameHorse (session, ctl, e, report, { tries = 20 }: any = {}) {
  const bot = session.bot
  patchVehicle(bot)
  const t: any = { tries: 0, bucked: 0, tamed: isTamedHorse(e) }
  report.tame = t
  if (t.tamed) return true
  const events = []
  const onStatus = pk => { if (pk.entityId === e.id) events.push(pk.entityStatus) }
  bot._client.on('entity_status', onStatus)
  const t0 = gameClock.now()
  try {
    for (let i = 0; i < tries + 6 && t.tries < tries && !ctl.aborted; i++) {
      if (!bot.entities[e.id]) { report.stopped = 'лошадь пропала из виду'; return false }
      if (isTamedHorse(e) || events.includes(7)) break
      if (!(await approach(bot, ctl, e, 1.5))) { report.stopped = 'не подошёл к лошади'; return false }
      const n0 = events.length
      if (!(await mountOn(bot, ctl, e))) { await sleep(600, ctl); continue }
      t.tries++
      const s0 = gameClock.now()
      while (gameClock.now() - s0 < 12000 && !ctl.aborted) {
        const ev = events.slice(n0)
        if (ev.includes(7) || isTamedHorse(e) || ev.includes(6) || !bot.vehicle || bot.vehicle.id !== e.id) break
        await sleep(100, ctl)
      }
      const ev = events.slice(n0)
      if (ev.includes(7) || isTamedHorse(e)) break
      if (ev.includes(6)) t.bucked++
      if (bot.vehicle && bot.vehicle.id === e.id) await dismount(bot)
      // Сбросив, лошадь встаёт на дыбы и отбегает: дать ей опуститься.
      await sleep(1000, ctl)
    }
  } finally {
    bot._client.removeListener('entity_status', onStatus)
  }
  // Флаг приходит метаданными следом за событием.
  const w0 = gameClock.now()
  while (!isTamedHorse(e) && events.includes(7) && gameClock.now() - w0 < 2000) await sleep(100)
  t.tamed = isTamedHorse(e) || events.includes(7)
  t.seconds = Math.round((gameClock.now() - t0) / 100) / 10
  if (t.tamed) {
    session.bus && session.bus.emit('tamed', { kind: e.name, id: e.id, text: `приручил ${e.name} (посадок ${t.tries})` })
    return true
  }
  if (!report.stopped) {
    report.stopped = ctl.aborted ? 'прервано'
      : `не стерпела за ${t.tries} посадок (сбросила ${t.bucked}) — нрав растёт на 5 за каждую, позови ещё раз; сахар/пшеница/яблоко с руки +3 к нраву`
  }
  return false
}

export async function saddleUp (session, ctl, e, report) {
  const bot = session.bot
  if (isSaddled(e)) return true
  const saddle = itemNamed(bot, 'saddle')
  if (!saddle) { report.need = { what: 'saddle', count: 1, have: 0 }; report.stopped = 'лошадь не осёдлана, а седла нет (седло не крафтится: сундуки, рыбалка, торговля; с 1.21.6 — 3 кожи + железный слиток на верстаке)'; return false }
  if (!(await approach(bot, ctl, e, 2))) { report.stopped = 'не подошёл к лошади'; return false }
  try { await bot.equip(saddle, 'hand') } catch {}
  try { await bot.lookAt(e.position.offset(0, (e.height || 1.6) * 0.7, 0), true) } catch {}
  try { bot.activateEntity(e) } catch {}
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 2000 && !isSaddled(e)) await sleep(100)
  if (isSaddled(e)) { report.saddled = true; return true }
  report.stopped = 'седло не надел (сервер не принял клик седлом)'
  return false
}

// Поехать на лошади до точки.
export async function rideHorse (session, ctl, e, target, report, { deadline, range = 1.5 }: any) {
  const bot = session.bot
  const dims = HORSES[e.name] || HORSES.horse
  const phys = Physics(bot.registry, { getBlock: p => bot.blockAt(p, false) })
  phys.playerHalfWidth = dims.w / 2
  phys.playerHeight = dims.h
  phys.stepHeight = 1.0
  const speed = attr(e, 'movement_speed', 0.225)
  const jumpStrength = attr(e, 'jump_strength', 0.7)
  // Прыжок: высота подъёма при vy0 и гравитации 0.08, сопротивлении 0.98.
  let hMax = 0; { let v = jumpStrength; let y = 0; for (let i = 0; i < 40 && v > 0; i++) { y += v; v = (v - 0.08) * 0.98 } hMax = y }
  report.horse = { ...horseInfo(e), jumpHeight: Math.round(hMax * 10) / 10 }
  const state = {
    pos: e.position.clone(), vel: new Vec3(0, 0, 0), onGround: true,
    isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    elytraFlying: false, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    attributes: { [phys.movementSpeedAttribute]: { value: speed, modifiers: [] } },
    yaw: bot.entity.yaw, pitch: 0,
    control: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    jumpBoost: 0, speed: 0, slowness: 0, dolphinsGrace: 0, slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false
  }
  const hw = dims.w / 2
  const planner = horsePlanner(bot, { canJump2: hMax >= 2.2, hw })
  const { boxFree } = horseFit(bot, hw)
  // Куда править: центр клетки со сдвигом от стены, который нашёл планировщик.
  const aim = n => ({ x: n.x + 0.5 + (n.sx || 0), z: n.z + 0.5 + (n.sz || 0) })
  const feetNode = () => ({ x: Math.floor(state.pos.x), y: Math.floor(state.pos.y + 0.01), z: Math.floor(state.pos.z) })
  const goalOk = n => Math.hypot(n.x + 0.5 - target.x, n.z + 0.5 - target.z) <= Math.max(1, range) && (target.y === undefined || Math.abs(n.y - target.y) <= 2)
  const h = n => Math.hypot(n.x + 0.5 - target.x, n.z + 0.5 - target.z)
  // Прямая между точками чиста, если вся коробка лошади проходит по ней на
  // одном уровне и под центром всё время есть земля.
  const clearLine = (a, b) => {
    if (a.y !== b.y) return false
    const A = aim(a); const Bp = aim(b)
    const n = Math.ceil(Math.hypot(Bp.x - A.x, Bp.z - A.z) * 3)
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const cx = A.x + (Bp.x - A.x) * t; const cz = A.z + (Bp.z - A.z) * t
      if (!boxFree(cx, a.y, cz)) return false
      if (!standOn(bot.blockAt(new Vec3(Math.floor(cx), a.y - 1, Math.floor(cz))))) return false
    }
    return true
  }
  let path = []
  let wp = 0
  const plan = () => {
    const r = astar(feetNode(), goalOk, planner, h, 40000)
    path = simplify(r.path, clearLine)
    wp = path.length > 1 ? 1 : 0
    report.plans = (report.plans || 0) + 1
    return r
  }
  let r0 = plan()
  report.route = { nodes: r0.path.length, complete: r0.complete, legs: path.length - 1 }
  if (r0.path.length <= 1 && !goalOk(feetNode())) {
    report.stopped = `дороги верхом не нашёл (${r0.seen} клеток перебрал) — препятствие выше ${hMax >= 2.2 ? 2 : 1} блоков, вода или узко для лошади`
    return false
  }

  // Поправка от сервера: vehicle_move к клиенту — это «ты не там».
  let snapped = 0
  const onSnap = p => { state.pos = new Vec3(p.x, p.y, p.z); state.vel.set(0, 0, 0); snapped++ }
  bot._client.on('vehicle_move', onSnap)
  let lastInput = ''
  const input = inp => { const k = JSON.stringify(inp); if (k !== lastInput) { sendInput(bot, inp); lastInput = k } }
  const t0 = gameClock.now()
  let stuckSince = null
  // Остаток маршрута: до текущей точки и дальше по ногам.
  const remaining = () => {
    const cur = path[wp]
    if (!cur) return flat(state.pos, target)
    let s = Math.hypot(aim(cur).x - state.pos.x, aim(cur).z - state.pos.z)
    for (let i = wp; i < path.length - 1; i++) { const a = aim(path[i]); const b = aim(path[i + 1]); s += Math.hypot(b.x - a.x, b.z - a.z) }
    return s
  }
  let lastProgress = { at: gameClock.now(), d: remaining() }
  let stuckPlans = 0
  let ticks = 0
  let jumps = 0
  let arrived = false
  const tick = pacer(ctl)
  try {
    while (!ctl.aborted && gameClock.now() < deadline) {
      if (!bot.vehicle || bot.vehicle.id !== e.id) { report.stopped = 'выпал из седла'; break }
      const here = flat(state.pos, target)
      if (here <= range && (target.y === undefined || Math.abs(state.pos.y - target.y) <= 2)) { arrived = true; break }
      // Точка маршрута.
      let goal = path[wp] || { x: target.x - 0.5, y: Math.floor(state.pos.y), z: target.z - 0.5 }
      const g0 = aim(goal)
      if (Math.hypot(g0.x - state.pos.x, g0.z - state.pos.z) < 0.9 && wp < path.length - 1) { wp++; goal = path[wp] }
      const ga = aim(goal)
      const dx = ga.x - state.pos.x; const dz = ga.z - state.pos.z
      state.yaw = Math.atan2(-dx, -dz)
      state.control.forward = true
      // Прыжок: следующая точка выше на 2 (шаг берёт только 1), или упёрлись.
      const need2 = goal.jump || (goal.y - Math.floor(state.pos.y + 0.01) >= 2)
      const close = Math.hypot(dx, dz) < 2.2
      if (state.onGround && ((need2 && close) || (stuckSince && gameClock.now() - stuckSince > 600))) {
        const dir = new Vec3(-Math.sin(state.yaw), 0, -Math.cos(state.yaw))
        state.vel.y = jumpStrength
        state.vel.x += dir.x * 0.4; state.vel.z += dir.z * 0.4
        try { bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 'start_horse_jump', jumpBoost: 100 }) } catch {}
        jumps++
        stuckSince = null
      }
      phys.simulatePlayer(state, { getBlock: p => bot.blockAt(p, false) })
      const mcYaw = toMcYaw(state.yaw)
      sendLook(bot, mcYaw, 0)
      input({ forward: true })
      sendVehicle(bot, state.pos, mcYaw, state.onGround)
      e.position = state.pos.clone()
      bot.entity.position = state.pos.offset(0, dims.h * 0.75, 0)
      bot.entity.yaw = state.yaw
      if (state.isCollidedHorizontally) { if (!stuckSince) stuckSince = gameClock.now() } else stuckSince = null
      // Продвижение — по остатку МАРШРУТА, не по прямой до цели: объезд стены
      // уводит от цели, и это не «застрял». Нет продвижения 3 с — новый маршрут
      // отсюда; шесть таких подряд — дорога не для лошади.
      const d = remaining()
      if (d < lastProgress.d - 0.5) lastProgress = { at: gameClock.now(), d }
      else if (gameClock.now() - lastProgress.at > 3000) {
        if (++stuckPlans > 6) { report.stopped = `застрял верхом в ${Math.round(flat(state.pos, target))} блоках от цели — дорога не для лошади`; break }
        plan()
        lastProgress = { at: gameClock.now(), d: remaining() }
      }
      if (DEBUG && ticks % 10 === 0) console.log(`[ride] t${ticks} pos ${state.pos.x.toFixed(2)},${state.pos.y.toFixed(2)},${state.pos.z.toFixed(2)} v ${Math.hypot(state.vel.x, state.vel.z).toFixed(3)} wp ${wp}/${path.length - 1} aim ${ga.x},${goal.y},${ga.z} ground ${state.onGround} hit ${state.isCollidedHorizontally} rest ${d.toFixed(1)}`)
      ticks++
      await tick()
    }
    // Остановиться: без ввода лошадь гасит скорость трением за полсекунды.
    input({})
    for (let i = 0; i < 12 && !ctl.aborted; i++) {
      state.control.forward = false
      phys.simulatePlayer(state, { getBlock: p => bot.blockAt(p, false) })
      sendLook(bot, toMcYaw(state.yaw), 0)
      sendVehicle(bot, state.pos, toMcYaw(state.yaw), state.onGround)
      e.position = state.pos.clone()
      bot.entity.position = state.pos.offset(0, dims.h * 0.75, 0)
      await sleep(TICK)
    }
  } finally {
    bot._client.removeListener('vehicle_move', onSnap)
    sendInput(bot, {})
  }
  const secs = (gameClock.now() - t0) / 1000
  report.rode = { seconds: Math.round(secs * 10) / 10, ticks, jumps, corrections: snapped || undefined, at: xyz(state.pos), left: Math.round(flat(state.pos, target) * 10) / 10 }
  return arrived
}

// Привязать лошадь к забору: поводок на неё, потом клик по столбу забора
// (FenceBlock.useWithoutItem → LeadItem.bindPlayerMobs).
export async function tie (session, ctl, e, report) {
  const bot = session.bot
  const lead = itemNamed(bot, 'lead')
  if (!lead) { report.tied = false; report.note = 'привязать нечем: нужен поводок (lead)'; return false }
  const ids = (Object.values(bot.registry.blocksByName) as any[]).filter((b : any) => /_fence$/.test(b.name)).map((b : any) => b.id)
  const post = bot.findBlocks({ matching: ids, maxDistance: 7, count: 20 }).map(p => bot.blockAt(p)).filter(Boolean)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  if (!post) { report.tied = false; report.note = 'забора в 7 блоках нет — привязывать не к чему'; return false }
  let leashed = false
  const onAttach = pk => { if (pk.entityId === e.id && pk.vehicleId === bot.entity.id) leashed = true }
  bot._client.on('attach_entity', onAttach)
  try {
    if (!(await approach(bot, ctl, e, 2))) { report.tied = false; return false }
    try { await bot.equip(lead, 'hand') } catch {}
    try { await bot.lookAt(e.position.offset(0, 1, 0), true) } catch {}
    try { bot.activateEntity(e) } catch {}
    const t0 = gameClock.now()
    while (!leashed && gameClock.now() - t0 < 1500) await sleep(100)
    if (!leashed) { report.tied = false; report.note = 'поводок не накинулся'; return false }
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(post.position.x, post.position.y, post.position.z, 2)), 8000) } catch { try { bot.pathfinder.setGoal(null) } catch {} }
    await emptyHand(bot)
    try { await bot.lookAt(post.position.offset(0.5, 0.5, 0.5), true) } catch {}
    let knot = false
    const onKnot = pk => { if (pk.entityId === e.id && pk.vehicleId !== bot.entity.id && pk.vehicleId !== -1) knot = true }
    bot._client.on('attach_entity', onKnot)
    try {
      await bot.activateBlock(post, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5))
      const t1 = gameClock.now()
      while (!knot && gameClock.now() - t1 < 1500) await sleep(100)
    } finally { bot._client.removeListener('attach_entity', onKnot) }
    report.tied = knot
    if (knot) report.tiedTo = xyz(post.position)
    return knot
  } finally {
    bot._client.removeListener('attach_entity', onAttach)
  }
}
