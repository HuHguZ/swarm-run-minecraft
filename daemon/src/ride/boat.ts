'use strict'
// Езда (ride.ts): лодка — скрафтить, спустить на воду, найти, плыть по пути, подобрать.
import { countItems, itemNamed, bestWeapon, diffItems } from '../items'
import { canSeePoint } from '../perception'
import { withTimeout } from '../build'
import { goals } from 'mineflayer-pathfinder'
import * as gameClock from '../game-clock'
import { Vec3 } from 'vec3'
import { planBoatRoute } from '../boat-route-plan'
import { inWater, escapeWater } from '../movement'
import {
  BOAT, DEBUG, RAD, TICK, WOODS, flat, fromMcYaw, isBoatName, isWater, pacer, passable, sendInput, sendLook,
  sendVehicle, sleep, standOn, toMcYaw, xyz
} from './base'
import { DIRS8, astar, boatPlanner, moveBoat, simplify } from './plan'


// ------------------------------------------------------------------ лодка

export function boatItemIn (bot) {
  return bot.inventory.items().find(i => /(_boat|_raft)$/.test(i.name) && !/chest/.test(i.name)) ||
    bot.inventory.items().find(i => /(_boat|_raft)$/.test(i.name)) || null
}

// Лодка из досок: 5 одной породы, на верстаке (рецепт 3×2).
export async function craftBoat (session, ctl, report) {
  const bot = session.bot
  let stock = countItems(bot)
  // Досок нет, а брёвна есть — сперва доски (лодку спидраннеры делают из того,
  // что в рюкзаке; ферма, крепость A — «нужно 5 досок» при 6 брёвнах).
  if (!WOODS.some(w => (stock[`${w}_planks`] || 0) >= 5)) {
    const log = WOODS.find(w => (stock[`${w}_log`] || 0) + (stock[`stripped_${w}_log`] || 0) >= 2)
    if (log) {
      try { await (require('../actions') as typeof import('../actions')).craft(session, ctl, { item: `${log}_planks`, count: 8 }) } catch {}
      stock = countItems(bot)
    }
  }
  const wood = WOODS.find(w => (stock[`${w}_planks`] || 0) >= 5)
  if (!wood) {
    const most = WOODS.map(w => ({ w, n: stock[`${w}_planks`] || 0 })).sort((a, b) => b.n - a.n)[0]
    report.need = { what: 'oak_planks', count: 5, have: most.n }
    report.stopped = 'лодки нет, а на неё нужно 5 досок одной породы (и верстак)'
    return null
  }
  const name = wood === 'bamboo' ? 'bamboo_raft' : `${wood}_boat`
  const actions: typeof import('../actions') = require('../actions')
  try {
    await actions.craft(session, ctl, { item: name, count: 1 })
  } catch (err) {
    report.stopped = `лодку не скрафтил: ${err.message}`
    return null
  }
  const it = itemNamed(bot, name)
  if (it) report.crafted = name
  return it
}

// Найти, откуда спустить лодку: видимая вода в досягаемости с воздухом над ней.
function launchSpot (bot) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const ids = ['water'].map(n => bot.registry.blocksByName[n].id)
  const found = bot.findBlocks({ matching: ids, maxDistance: 5, count: 64 })
    .map(p => bot.blockAt(p))
    .filter(b => b && b.getProperties && Number(b.getProperties().level || 0) === 0)
    .filter(b => { const a = bot.blockAt(b.position.offset(0, 1, 0)); return a && a.name === 'air' })
    .filter(b => eye.distanceTo(b.position.offset(0.5, 0.9, 0.5)) <= 4.2)
    .filter(b => {
      // BoatItem.use: лодка встаёт центром в точку попадания луча, и если её
      // коробка (1.375 × 0.5625, низ на поверхности воды) задевает блок —
      // level.noCollision ложно, отказ. С центра клетки коробка залезает во все
      // восемь соседних на 0.19: у берега не встанет. Нужна вода кругом, над
      // ней воздух.
      for (const [dx, dz] of DIRS8) {
        if (!isWater(bot.blockAt(b.position.offset(dx, 0, dz)))) return false
        const up = bot.blockAt(b.position.offset(dx, 1, dz))
        if (!up || up.boundingBox !== 'empty') return false
      }
      return true
    })
    .sort((a, b) => eye.distanceTo(a.position) - eye.distanceTo(b.position))
  return found[0] || null
}

export async function launchBoat (session, ctl, report) {
  const bot = session.bot
  let item = boatItemIn(bot)
  if (!item) item = await craftBoat(session, ctl, report)
  if (!item) return null
  // Подойти к воде, если её нет в досягаемости.
  let spot = launchSpot(bot)
  if (!spot) {
    const ids = [bot.registry.blocksByName.water.id]
    // Открытая вода: кругом вода, над ней воздух — туда лодка встанет.
    const open = b => DIRS8.every(([dx, dz]) => isWater(bot.blockAt(b.position.offset(dx, 0, dz))))
    const near = bot.findBlocks({ matching: ids, maxDistance: 24, count: 400 })
      .map(p => bot.blockAt(p))
      .filter(b => b && Number((b.getProperties && b.getProperties().level) || 0) === 0 && open(b) && canSeePoint(bot, b.position.offset(0.5, 0.9, 0.5)))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    if (!near.length) { report.stopped = 'не вижу открытой воды в 24 блоках (клетка, вокруг которой вода со всех 8 сторон) — лодку спускать некуда'; return null }
    const w = near[0].position
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(w.x, w.y + 1, w.z, 3)), 20000, 'не дошёл до воды') } catch { try { bot.pathfinder.setGoal(null) } catch {} }
    spot = launchSpot(bot)
    if (!spot) { report.stopped = 'дошёл до воды, а спустить лодку некуда: нужна клетка воды в 4 блоках, вокруг которой вода со всех 8 сторон'; return null }
  }
  const before = new Set((Object.values(bot.entities) as any[]).filter((e : any) => isBoatName(e.name)).map((e : any) => e.id))
  try { await bot.equip(item, 'hand') } catch {}
  // BoatItem.use — луч из глаз с Fluid.ANY: целиться в поверхность воды.
  try { await bot.lookAt(spot.position.offset(0.5, 0.88, 0.5), true) } catch {}
  await sleep(100)
  try { bot.activateItem() } catch {}
  const t0 = gameClock.now()
  let boat = null
  while (!boat && gameClock.now() - t0 < 2500) {
    boat = (Object.values(bot.entities) as any[]).find((e : any) => e && isBoatName(e.name) && !before.has(e.id) && e.position.distanceTo(spot.position) < 3)
    if (!boat) await sleep(100)
  }
  if (!boat) { report.stopped = 'лодка не появилась (луч ушёл мимо воды или место занято)'; return null }
  report.launched = { boat: boat.name, at: xyz(boat.position) }
  await sleep(600)
  return boat
}

export function findBoat (bot, radius = 12) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[])
    .filter((e : any) => e && isBoatName(e.name) && e.position && e.position.distanceTo(me) <= radius && (!e.passengers || e.passengers.length === 0))
    .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
}

export async function rideBoat (session, ctl, boat, target, report, { deadline, stay = false }: any) {
  const bot = session.bot
  let pos = boat.position.clone()
  const wy = Math.floor(pos.y + 0.3) - (isWater(bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y + 0.3), Math.floor(pos.z)))) ? 0 : 1)
  const grid = boatPlanner(bot, wy)
  const start = { x: Math.floor(pos.x), y: wy, z: Math.floor(pos.z) }
  const landingAt = stay ? null : n => {
    let best = null
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (!dx && !dz) continue
      for (const y of [wy, wy + 1]) {
        const p = new Vec3(n.x + dx, y, n.z + dz)
        if (!standOn(bot.blockAt(p.offset(0, -1, 0))) || !passable(bot.blockAt(p)) || !passable(bot.blockAt(p.offset(0, 1, 0)))) continue
        const dry = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }
        if (!best || flat(dry, target) < flat(best, target)) best = dry
      }
    }
    return best
  }
  const r = planBoatRoute({ start, target, grid, astar, landingAt })
  const goalCell = r.goal
  if (r.landing) { report.landingTarget = r.landing; target = r.landing }
  const clearLine = (a, b) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 2)
    for (let i = 1; i <= n; i++) {
      const t = i / n
      for (const [ox, oz] of [[0, 0], [0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75]]) {
        if (!grid.water(Math.floor(a.x + 0.5 + (b.x - a.x) * t + ox), Math.floor(a.z + 0.5 + (b.z - a.z) * t + oz))) return false
      }
    }
    return true
  }
  const path = simplify(r.path, clearLine)
  report.route = { nodes: r.path.length, complete: r.complete, legs: path.length - 1, to: goalCell, fromShore: Math.round(r.fromShore * 10) / 10 }
  if (!r.complete) { report.stopped = `по воде до цели не доплыть: ${stay ? 'нет связной воды' : 'нет связного сухого берега'} (${r.seen} клеток перебрал) — ближе всего доплыву до ${r.path[r.path.length - 1].x},${r.path[r.path.length - 1].z}`; return false }

  let yawDeg = toMcYaw(bot.entity.yaw)
  // Взгляд лодки при посадке: у сущности свой yaw.
  if (typeof boat.yaw === 'number') yawDeg = toMcYaw(boat.yaw)
  let vel = new Vec3(0, 0, 0)
  let dRot = 0
  let wp = path.length > 1 ? 1 : 0
  let snapped = 0
  const onSnap = p => { pos = new Vec3(p.x, p.y, p.z); vel = new Vec3(0, 0, 0); snapped++ }
  bot._client.on('vehicle_move', onSnap)
  let lastInput = ''
  const t0 = gameClock.now()
  let lastProgress = { at: gameClock.now(), d: Infinity }
  let arrived = false
  let bumps = 0
  let ticks = 0
  const tick = pacer(ctl)
  try {
    while (!ctl.aborted && gameClock.now() < deadline) {
      if (!bot.vehicle || bot.vehicle.id !== boat.id) { report.stopped = 'выпал из лодки'; break }
      const cell = path[wp]
      const gx = cell.x + 0.5; const gz = cell.z + 0.5
      const dist = Math.hypot(gx - pos.x, gz - pos.z)
      if (wp === path.length - 1 && dist < 1.2) { arrived = true; break }
      if (dist < 1.5 && wp < path.length - 1) wp++
      const c2 = path[wp]
      const want = Math.atan2(-(c2.x + 0.5 - pos.x), c2.z + 0.5 - pos.z) * RAD // градусы MC: 0 — юг
      let diff = ((want - yawDeg + 540) % 360) - 180
      // Ввод как у игрока: влево/вправо — вращение, вперёд — гребок.
      // Упреждение: вращение гаснет 0.9 за тик, остановится само через ~10·dRot.
      const left = diff < -2 && !(dRot < 0 && diff > dRot * 9)
      const right = diff > 2 && !(dRot > 0 && diff < dRot * 9)
      const forward = Math.abs(diff) < 50
      // floatBoat: трение воды 0.9 — скорости и вращения.
      vel = vel.scaled(0.9)
      dRot *= 0.9
      // controlBoat.
      let f = 0
      if (left) dRot -= 1
      if (right) dRot += 1
      if (right !== left && !forward) f += 0.005
      yawDeg += dRot
      if (forward) f += 0.04
      vel = vel.plus(new Vec3(Math.sin(-yawDeg / RAD) * f, 0, Math.cos(yawDeg / RAD) * f))
      const m = moveBoat(bot, pos, vel.x, vel.z)
      if (m.hitX) vel.x = 0
      if (m.hitZ) vel.z = 0
      if (m.hitX || m.hitZ) bumps++
      pos = m.pos
      const inp = { forward, left, right }
      const k = JSON.stringify(inp)
      if (k !== lastInput) { sendInput(bot, inp); lastInput = k }
      // Весло — ServerboundPaddleBoatPacket; в minecraft-data он зовётся
      // steer_boat (0x22). Под именем paddle_boat node-minecraft-protocol шлёт
      // id 0 — сервер читает его как accept_teleportation и рвёт соединение.
      try { bot._client.write('steer_boat', { leftPaddle: (right && !left) || forward, rightPaddle: (left && !right) || forward }) } catch {}
      sendLook(bot, yawDeg, 0)
      sendVehicle(bot, pos, yawDeg, false)
      boat.position = pos.clone()
      bot.entity.position = pos.offset(0, 0.3, 0)
      bot.entity.yaw = fromMcYaw(yawDeg)
      // Продвижение — по остатку маршрута (обход острова уводит от цели).
      let d = Math.hypot(path[wp].x + 0.5 - pos.x, path[wp].z + 0.5 - pos.z)
      for (let i = wp; i < path.length - 1; i++) d += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z)
      if (d < lastProgress.d - 1) lastProgress = { at: gameClock.now(), d }
      else if (gameClock.now() - lastProgress.at > 6000) { report.stopped = `лодка застряла в ${Math.round(Math.hypot(goalCell.x + 0.5 - pos.x, goalCell.z + 0.5 - pos.z))} блоках от места высадки (упор в берег ${bumps} раз)`; break }
      if (DEBUG && ticks % 10 === 0) console.log(`[boat] t${ticks} pos ${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)} v ${Math.hypot(vel.x, vel.z).toFixed(3)} yaw ${yawDeg.toFixed(0)} want ${want.toFixed(0)} wp ${wp}/${path.length - 1} bumps ${bumps} rest ${d.toFixed(1)}`)
      ticks++
      await tick()
    }
    // Причалить. Высадка (AbstractBoat.getDismountLocationForPassenger) — в
    // точку на (1.375·√2 + 0.6)/2 = 1.27 блока по взгляду наездника
    // (getCollisionHorizontalEscapeVector), и только если под ней не вода;
    // иначе сервер ставит тело на саму лодку — в воду. Догрести к цели, пока
    // эта точка не ляжет на сушу.
    if (arrived && !stay) {
      const top = Math.floor(pos.y + BOAT.h)
      const dryAt = yaw => {
        const f = -Math.sin(yaw / RAD); const f1 = Math.cos(yaw / RAD); const m = Math.max(Math.abs(f), Math.abs(f1))
        const d0 = (BOAT.w * Math.SQRT2 + 0.6) / 2
        const ex = Math.floor(pos.x + f * d0 / m); const ez = Math.floor(pos.z + f1 * d0 / m)
        const below = bot.blockAt(new Vec3(ex, top - 1, ez))
        return !!below && !isWater(below) && below.boundingBox === 'block' && passable(bot.blockAt(new Vec3(ex, top, ez))) && passable(bot.blockAt(new Vec3(ex, top + 1, ez)))
      }
      const faceTo = () => Math.atan2(-(target.x - pos.x), target.z - pos.z) * RAD
      let i = 0
      for (; i < 60 && !ctl.aborted && !dryAt(faceTo()); i++) {
        const diff = ((faceTo() - yawDeg + 540) % 360) - 180
        const left = diff < -3; const right = diff > 3
        const forward = Math.abs(diff) < 30
        vel = vel.scaled(0.9)
        dRot *= 0.9
        let f = 0
        if (left) dRot -= 1
        if (right) dRot += 1
        if (right !== left && !forward) f += 0.005
        yawDeg += dRot
        if (forward) f += 0.04
        vel = vel.plus(new Vec3(Math.sin(-yawDeg / RAD) * f, 0, Math.cos(yawDeg / RAD) * f))
        const m = moveBoat(bot, pos, vel.x, vel.z)
        if (m.hitX) vel.x = 0
        if (m.hitZ) vel.z = 0
        pos = m.pos
        sendInput(bot, { forward, left, right })
        sendLook(bot, yawDeg, 0)
        sendVehicle(bot, pos, yawDeg, false)
        boat.position = pos.clone()
        bot.entity.position = pos.offset(0, 0.3, 0)
        await tick()
      }
      report.beached = dryAt(faceTo())
      if (i) report.beachTicks = i
    }
    sendInput(bot, {})
    // Погасить ход, продолжая слать место.
    for (let i = 0; i < 10 && !ctl.aborted; i++) {
      vel = vel.scaled(0.9)
      const m = moveBoat(bot, pos, vel.x, vel.z)
      pos = m.pos
      sendLook(bot, yawDeg, 0)
      sendVehicle(bot, pos, yawDeg, false)
      boat.position = pos.clone()
      await sleep(TICK)
    }
  } finally {
    bot._client.removeListener('vehicle_move', onSnap)
    sendInput(bot, {})
  }
  report.rode = { seconds: Math.round((gameClock.now() - t0) / 100) / 10, bumps: bumps || undefined, corrections: snapped || undefined, at: xyz(pos) }
  return arrived
}

// Разбить свою лодку и подобрать: AbstractBoat.hurtServer — урон ×10 копится,
// ломается от > 40; кулаком это несколько ударов подряд, мечом/топором — один-два.
export async function pickUpBoat (session, ctl, boat, report) {
  const bot = session.bot
  const before = countItems(bot)
  const w = bestWeapon ? bestWeapon(bot) : null
  if (w) { try { await bot.equip(w, 'hand') } catch {} }
  for (let i = 0; i < 20 && !ctl.aborted; i++) {
    if (!boat.isValid && !bot.entities[boat.id]) break
    if (boat.position.distanceTo(bot.entity.position) > 3.5) {
      try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(boat.position.x, boat.position.y, boat.position.z, 2)), 6000) } catch { try { bot.pathfinder.setGoal(null) } catch {} }
    }
    try { await bot.lookAt(boat.position.offset(0, 0.3, 0), true) } catch {}
    try { bot.attack(boat) } catch {}
    await sleep(260)
  }
  // Предмет падает на место лодки и плавает. Подбор — коробка игрока +1 блок
  // вбок (Player.aiStep, inflate(1, 0.5, 1)): с кромки берега дотягивается,
  // в воду лезть не надо. Сначала подойти на 1.5 (кромка), потом ближе; залез
  // в воду — выплыть (pathfinder из воды на берег выше воды не строит).
  const t0 = gameClock.now()
  let close = 1.5
  while (gameClock.now() - t0 < 8000 && !ctl.aborted) {
    const got = diffItems(before, countItems(bot))
    if (Object.keys(got).some(n => /(_boat|_raft)$/.test(n))) break
    const drop: any = (Object.values(bot.entities) as any[]).find((e : any) => e && e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
    if (drop) {
      try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, close)), 4000) } catch { try { bot.pathfinder.setGoal(null) } catch {} }
      await sleep(600)
      close = 0.8
    }
    await sleep(200)
  }
  if (inWater(bot)) await escapeWater(bot, ctl, { timeoutMs: 8000 })
  const got = diffItems(before, countItems(bot))
  const name = Object.keys(got).find(n => /(_boat|_raft)$/.test(n))
  report.pickedUp = name || false
  if (!name) report.note = (report.note ? report.note + ' ' : '') + 'лодку не подобрал — осталась у берега'
  return !!name
}
