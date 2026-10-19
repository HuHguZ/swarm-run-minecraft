'use strict'
const gameClock: typeof import('./game-clock') = require('./game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { Physics } = require('prismarine-physics')
const AABB = require('prismarine-physics/lib/aabb')
const attribute = require('prismarine-physics/lib/attribute')
const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
const { withTimeout }: typeof import('./build') = require('./build')
const { itemNamed, countItems, diffItems, bestWeapon }: typeof import('./items') = require('./items')
const { canSeePoint }: typeof import('./perception') = require('./perception')
const { inWater, escapeWater }: typeof import('./movement') = require('./movement')
const { planBoatRoute }: typeof import('./boat-route-plan') = require('./boat-route-plan')

// Езда: лошадь (осёл, мул) и лодка. Одна и та же суть у обоих: транспорт,
// которым правит игрок, СЧИТАЕТ КЛИЕНТ, а сервер только принимает координаты.
//
// Сверено с paper-1.21.11.jar (javap), а не угадано:
//  · LivingEntity.travelRidden: getRiddenInput → tickRidden → если
//    canSimulateMovement() — travel(), иначе setDeltaMovement(ZERO). На
//    сервере у лошади с игроком в седле canSimulateMovement ложно: лошадь стоит,
//    пока клиент не пришлёт её новое место пакетом vehicle_move
//    (ServerboundMoveVehiclePacket). mineflayer 4.37 этого не делает вовсе: на
//    'mount' он выключает свою физику (physics.js shouldUsePhysics=false) и
//    больше ничего не шлёт — ни позиции, ни взгляда. bot.moveVehicle шлёт
//    только ввод (player_input), от которого на сервере лошадь не двигается.
//    Поэтому здесь своя маленькая физика транспорта и свои пакеты: как у
//    настоящего клиента — look, player_input, vehicle_move каждый тик.
//  · AbstractHorse.getRiddenInput: (xxa·0.5, 0, zza), назад ·0.25;
//    getRiddenSpeed = атрибут movement_speed лошади (у каждой своя, база
//    0.225); шаг вверх — атрибут step_height 1.0 (createBaseHorseAttributes):
//    на блок лошадь заходит без прыжка. Движение — обычное LivingEntity.travel:
//    ускорение speed·0.216/f³ (f=0.6 → ровно speed), трение 0.546 — это же
//    считает prismarine-physics для игрока, её и берём с хитбоксом лошади
//    (1.3964844 × 1.6, у осла 1.5).
//  · Прыжок: executeRidersJump — vy = jump_strength·scale (у лошади своя, база
//    0.7), и если едем вперёд — толчок 0.4·scale по взгляду. Полный прыжок —
//    scale 1 (handleStartJump: сила ≥ 90 → 1.0). Серверу — entity_action
//    start_horse_jump.
//  · Управлять можно только осёдланной (getControllingPassenger → isSaddled) и
//    приручённой (флаг 2 в DATA_ID_FLAGS, метаданные 17). Седло с 1.21.5 —
//    экипировка: клик седлом по приручённой (ItemStack.interactLivingEntity →
//    Equippable, canUseSlot(SADDLE): жива, взрослая, приручена).
//  · Слезть — shift в player_input (wantsToStopRiding). mineflayer.dismount
//    шлёт на 1.21.2+ прыжок, а прыжок в седле — это прыжок лошади.
//  · Лодка (AbstractBoat.controlBoat): влево/вправо — deltaRotation ∓1 за тик,
//    вперёд +0.04, назад −0.005, поворот на месте +0.005; floatBoat в воде —
//    трение 0.9 и скорости, и вращения. Поворот лодки — ВВОДОМ, а не взглядом
//    игрока; предельная скорость 0.4 блока за тик. Место — vehicle_move, весло —
//    paddle_boat.
//  · Сервер (handleMoveVehicle) сам двигает транспорт на присланную разницу с
//    коллизией и отбивает, если вышло не туда — поэтому посылать надо только
//    честно посчитанное место, без прохода сквозь блоки.

const HORSES = { horse: { w: 1.3964844, h: 1.6 }, donkey: { w: 1.3964844, h: 1.5 }, mule: { w: 1.3964844, h: 1.6 }, skeleton_horse: { w: 1.3964844, h: 1.6 }, zombie_horse: { w: 1.3964844, h: 1.6 } }
const BOAT = { w: 1.375, h: 0.5625 }
const isBoatName = n => /(_boat|_raft)$/.test(n || '')
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo']
const TICK = 50
const RAD = 180 / Math.PI
const DEBUG = !!process.env.ND_DEBUG_RIDE

function sleep (ms, ctl?: any) {
  return new Promise<any>(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve(undefined) })
  })
}

// Ровно 20 тиков в секунду по часам: sleep(50) плюс работа тика — это ~16 Гц,
// и транспорт ехал бы медленнее, чем в игре. Отстали больше чем на 5 тиков
// (перестройка маршрута) — не догонять рывком, а считать заново отсюда.
function pacer (ctl) {
  let base = gameClock.now(); let n = 0
  return () => {
    n++
    let wait = base + n * TICK - gameClock.now()
    if (wait < -5 * TICK) { base = gameClock.now(); n = 0; wait = 0 }
    return sleep(Math.max(0, wait), ctl)
  }
}

// mineflayer: yaw 0 — север, против часовой; сервер — градусы, 0 — юг.
const toMcYaw = yaw => (Math.PI - yaw) * RAD
const fromMcYaw = deg => Math.PI - deg / RAD
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const xyz = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

// minecraft-data 1.21.11: у маппера атрибутов в пакете entity_update_attributes
// нет mining_efficiency (20), movement_efficiency (21), oxygen_bonus (23),
// sneaking_speed (26), и с id 20 имена съехали. Реестр сервера (Attributes,
// javap): 22 — movement_speed, 25 — scale; а маппер зовёт 22 «generic.scale».
// Скорость лошади приходит под чужим именем, прыжок (15) — под своим. Здесь
// имя из маппера переводится обратно в id, а id — в настоящее имя реестра.
let ATTR_FIX = null
function attrFix (bot) {
  if (ATTR_FIX || !bot || !bot.registry) return
  const map: any = {}
  try {
    const find = o => {
      if (!o || typeof o !== 'object') return null
      if (o.mappings && (Object.values(o.mappings) as any[]).includes('generic.armor')) return o.mappings
      for (const v of (Object.values(o) as any[])) { const r = find(v); if (r) return r }
      return null
    }
    const mapper = find(bot.registry.protocol.play.toClient.types.packet_entity_update_attributes) || {}
    const real = bot.registry.attributesArray || []
    for (const [id, key] of (Object.entries(mapper) as [string, any][])) if (real[id]) map[key] = real[id].resource.replace(/^minecraft:/, '')
  } catch {}
  ATTR_FIX = map
}
const attrName = k => (ATTR_FIX && ATTR_FIX[k]) || k.replace(/^minecraft:/, '').replace(/^(generic|player|zombie)\./, '')

function attr (e, name, dflt) {
  const a = e && e.attributes
  if (!a) return dflt
  const k = Object.keys(a).find(k => attrName(k) === name)
  if (!k) return dflt
  try { return attribute.getAttributeValue(a[k]) } catch { return a[k].value ?? dflt }
}

const horseFlags = e => { const f = e.metadata && e.metadata[17]; return typeof f === 'number' ? f : 0 }
const isTamedHorse = e => (horseFlags(e) & 0x02) !== 0
const isBaby = e => !!(e.metadata && e.metadata[16] === true)
function isSaddled (e) {
  const eq = e.equipment || []
  if (eq.some(it => it && it.name === 'saddle')) return true
  return (horseFlags(e) & 0x04) !== 0
}

// Блоки: проходимо (для ног и головы) и можно стоять сверху.
const LIQUID = /^(water|lava|bubble_column)$/
const HURTS = /^(cactus|sweet_berry_bush|fire|soul_fire|magma_block|campfire|soul_campfire|powder_snow|wither_rose|pointed_dripstone)$/
const passable = b => !!b && b.boundingBox === 'empty' && !LIQUID.test(b.name) && !HURTS.test(b.name)
const standOn = b => !!b && b.boundingBox === 'block' && !HURTS.test(b.name) && !/fence|_wall$|iron_bars|pane/.test(b.name)
const isWater = b => !!b && (b.name === 'water' || b.name === 'bubble_column' || (() => { try { return b.getProperties().waterlogged === true } catch { return false } })())

// ------------------------------------------------------------------ пакеты

function sendLook (bot, yawDeg, pitchDeg) {
  try { bot._client.write('look', { yaw: yawDeg, pitch: pitchDeg, onGround: false, flags: { onGround: false, hasHorizontalCollision: false } }) } catch {}
}

function sendInput (bot, inp) {
  try {
    bot._client.write('player_input', {
      inputs: { forward: !!inp.forward, backward: !!inp.back, left: !!inp.left, right: !!inp.right, jump: !!inp.jump, shift: !!inp.shift, sprint: false }
    })
  } catch {}
}

function sendVehicle (bot, pos, yawDeg, onGround) {
  try { bot._client.write('vehicle_move', { x: pos.x, y: pos.y, z: pos.z, yaw: yawDeg, pitch: 0, onGround: !!onGround }) } catch {}
}

// mineflayer 4.37 (entities.js, set_passengers) снимает с транспорта только тех,
// кто ЕСТЬ в новом списке пассажиров, а сервер, когда игрок слез или лошадь его
// сбросила, шлёт список уже БЕЗ него: bot.vehicle остаётся навсегда, 'dismount'
// не приходит. Ванильный клиент в этом пакете сперва высаживает всех, потом
// сажает перечисленных — то же здесь, один раз на бота.
function patchVehicle (bot) {
  if (bot._ndVehiclePatch) return
  bot._ndVehiclePatch = true
  bot._client.on('set_passengers', ({ entityId, passengers }: any) => {
    const v = bot.vehicle
    if (!v || v.id !== entityId || !bot.entity || passengers.includes(bot.entity.id)) return
    const i = v.passengers ? v.passengers.indexOf(bot.entity) : -1
    if (i !== -1) v.passengers.splice(i, 1)
    bot.entity.vehicle = null
    bot.vehicle = null
    bot.emit('dismount', v)
  })
}

// Слезть: shift одним тиком, отпустить следующим.
async function dismount (bot, ms = 2500) {
  patchVehicle(bot)
  if (!bot.vehicle) return true
  const gone = new Promise<any>(resolve => {
    const t = gameClock.setTimeout(() => resolve(false), ms)
    bot.once('dismount', () => { gameClock.clearTimeout(t); resolve(true) })
  })
  sendInput(bot, { shift: true })
  await sleep(120)
  sendInput(bot, {})
  const ok = await gone
  // Сервер ставит тело на землю телепортом — дождаться, пока физика mineflayer
  // оживёт на новом месте.
  await sleep(300)
  return ok || !bot.vehicle
}

async function mountOn (bot, ctl, e, ms = 3000, getAim = null) {
  patchVehicle(bot)
  if (ctl.aborted) return false
  if (bot.vehicle && bot.vehicle.id === e.id) return true
  await emptyHand(bot)
  if (ctl.aborted) return false
  const point = getAim ? getAim() : e.position.offset(0, (e.height || 1) * 0.7, 0)
  if (!point) return false
  try { await bot.lookAt(point, true) } catch { return false }
  if (ctl.aborted || getAim && !getAim()?.equals(point)) return false
  const on = new Promise<any>(resolve => {
    const done = ok => { gameClock.clearTimeout(t); bot.removeListener('mount', h); ctl.onAbort = ctl.onAbort.filter(fn => fn !== abort); resolve(ok) }
    const abort = () => done(false)
    const t = gameClock.setTimeout(() => done(false), ms)
    const h = () => { if (bot.vehicle && bot.vehicle.id === e.id) done(true) }
    bot.on('mount', h)
    ctl.onAbort.push(abort)
  })
  try { bot.mount(e) } catch {}
  return on
}

async function emptyHand (bot) {
  if (!bot.heldItem) return
  const slot = bot.inventory.firstEmptyHotbarSlot ? bot.inventory.firstEmptyHotbarSlot() : null
  try {
    if (slot !== null && slot !== undefined) bot.setQuickBarSlot(slot - 36)
    else await bot.unequip('hand')
  } catch {}
}

async function approach (bot, ctl, e, range = 2, ms = 15000) {
  if (e.position.distanceTo(bot.entity.position) <= range + 0.5) return true
  const goal = new goals.GoalFollow(e, range)
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  try {
    bot.pathfinder.setGoal(goal, true)
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < ms && !ctl.aborted && e.isValid !== false) {
      if (e.position.distanceTo(bot.entity.position) <= range + 0.5) return true
      await sleep(150)
    }
    return false
  } finally {
    try { if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null) } catch {}
  }
}

// ------------------------------------------------------------------ A*

function astar (start, isGoal, neighbours, h, maxNodes = 30000) {
  const key = n => `${n.x},${n.y},${n.z}`
  const open = [{ n: start, g: 0, f: h(start) }]
  const came = new Map()
  const gBest = new Map([[key(start), 0]])
  let best = { n: start, h: h(start) }
  let seen = 0
  while (open.length && seen < maxNodes) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i
    const cur = open[bi]
    open[bi] = open[open.length - 1]; open.pop()
    const ck = key(cur.n)
    if (cur.g > (gBest.get(ck) ?? Infinity)) continue
    seen++
    if (isGoal(cur.n)) return { path: rebuild(came, cur.n, key), complete: true, seen }
    const hh = h(cur.n)
    if (hh < best.h) best = { n: cur.n, h: hh }
    for (const { n, cost } of neighbours(cur.n)) {
      const nk = key(n)
      const g = cur.g + cost
      if (g >= (gBest.get(nk) ?? Infinity)) continue
      gBest.set(nk, g)
      came.set(nk, cur.n)
      open.push({ n, g, f: g + h(n) })
    }
  }
  return { path: rebuild(came, best.n, key), complete: false, seen }
}

function rebuild (came, n, key) {
  const out = [n]
  let k = key(n)
  while (came.has(k)) { n = came.get(k); out.unshift(n); k = key(n) }
  return out
}

const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

// Сухопутная сетка для лошади: стоять на блоке, две клетки воздуха над ним,
// шаг вверх на 1 без прыжка (step_height 1.0), на 2 — прыжком, если сил хватает,
// вниз до 3 (safe_fall_distance 6). Лошадь шире блока (1.4): в клетке у стены
// её коробка залезает в стену на 0.2 — центр сдвигается от стены на 0.25
// (shift sx, sz), а проход в один блок для неё закрыт вовсе, как в игре.
const SHIFTS = [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25], [0.25, 0.25], [0.25, -0.25], [-0.25, 0.25], [-0.25, -0.25]]
function horseFit (bot, hw) {
  const solidC = new Map()
  const solid = (x, y, z) => {
    const k = `${x},${y},${z}`
    let v = solidC.get(k)
    if (v === undefined) { v = !passable(bot.blockAt(new Vec3(x, y, z))); solidC.set(k, v) }
    return v
  }
  // Коробка лошади с центром (cx, cz) на уровне y свободна: клетки y и y+1.
  const boxFree = (cx, y, cz) => {
    const x0 = Math.floor(cx - hw + 1e-3); const x1 = Math.floor(cx + hw - 1e-3)
    const z0 = Math.floor(cz - hw + 1e-3); const z1 = Math.floor(cz + hw - 1e-3)
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (solid(x, y, z) || solid(x, y + 1, z)) return false
    return true
  }
  const fitC = new Map()
  const fit = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (fitC.has(k)) return fitC.get(k)
    let r = null
    for (const [sx, sz] of SHIFTS) if (boxFree(x + 0.5 + sx, y, z + 0.5 + sz)) { r = { sx, sz }; break }
    fitC.set(k, r)
    return r
  }
  return { fit, boxFree, solid }
}

function horsePlanner (bot, { canJump2, hw }: any) {
  const B = p => bot.blockAt(p)
  const { fit } = horseFit(bot, hw)
  const standable = (x, y, z) => standOn(B(new Vec3(x, y - 1, z))) ? fit(x, y, z) : null
  return function neighbours (n) {
    const out = []
    for (const [dx, dz] of DIRS8) {
      const x = n.x + dx; const z = n.z + dz
      let found = null
      for (const dy of [0, 1, -1, -2, -3, 2]) {
        if (dy === 2 && !canJump2) continue
        const y = n.y + dy
        const f = standable(x, y, z)
        if (!f) continue
        // Вверх: над исходной клеткой место на подъём; вниз: над целевой — на спуск.
        if (dy > 0 && !fit(n.x, n.y + dy, n.z)) continue
        if (dy < 0 && !fit(x, n.y, z)) continue
        if (dx && dz && !(fit(n.x + dx, Math.max(y, n.y), n.z) && fit(n.x, Math.max(y, n.y), n.z + dz))) continue
        found = { x, y, z, jump: dy === 2, sx: f.sx, sz: f.sz }
        break
      }
      if (!found) continue
      let cost = (dx && dz ? 1.414 : 1) + (found.y > n.y ? 0.4 : 0) + (found.jump ? 2 : 0)
      // Клетка, где коробку пришлось сдвигать, — у стены: дороже, держаться середины.
      if (found.sx || found.sz) cost += 0.8
      const under = B(new Vec3(found.x, found.y - 1, found.z))
      if (under && under.name === 'farmland') cost += 3
      out.push({ n: found, cost })
    }
    return out
  }
}

// Водная сетка для лодки: вода на уровне y, над ней воздух. Лодка шире блока:
// клетка у берега дороже, диагональ — только если обе боковые тоже вода.
function boatPlanner (bot, y) {
  const water = (x, z) => { const b = bot.blockAt(new Vec3(x, y, z)); const a = bot.blockAt(new Vec3(x, y + 1, z)); return isWater(b) && !!a && a.boundingBox === 'empty' && !isWater(a) }
  return {
    water,
    neighbours (n) {
      const out = []
      for (const [dx, dz] of DIRS8) {
        const x = n.x + dx; const z = n.z + dz
        if (!water(x, z)) continue
        if (dx && dz && !(water(n.x + dx, n.z) && water(n.x, n.z + dz))) continue
        let cost = dx && dz ? 1.414 : 1
        const shore = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => !water(x + a, z + b)).length
        cost += shore * 0.7
        out.push({ n: { x, y, z }, cost })
      }
      return out
    }
  }
}

// Проредить путь: идти к дальней точке, до которой прямая чистая.
function simplify (path, clearLine) {
  if (path.length <= 2) return path
  const out = [path[0]]
  let i = 0
  while (i < path.length - 1) {
    let j = path.length - 1
    while (j > i + 1 && !(clearLine(path[i], path[j]) && !path.slice(i + 1, j + 1).some(p => p.jump))) j--
    out.push(path[j])
    i = j
  }
  return out
}

// ------------------------------------------------------------------ коллизия лодки

function blockBoxes (bot, box) {
  const out = []
  const c = new Vec3(0, 0, 0)
  for (c.y = Math.floor(box.minY) - 1; c.y <= Math.floor(box.maxY); c.y++) {
    for (c.z = Math.floor(box.minZ); c.z <= Math.floor(box.maxZ); c.z++) {
      for (c.x = Math.floor(box.minX); c.x <= Math.floor(box.maxX); c.x++) {
        const b = bot.blockAt(c, false)
        if (!b) continue
        for (const s of b.shapes || []) out.push(new AABB(s[0], s[1], s[2], s[3], s[4], s[5]).offset(b.position.x, b.position.y, b.position.z))
      }
    }
  }
  return out
}

// Сдвинуть коробку лодки на (dx, dz) с упором в блоки, как Entity.move.
function moveBoat (bot, pos, dx, dz) {
  const hw = BOAT.w / 2
  const box = new AABB(pos.x - hw, pos.y, pos.z - hw, pos.x + hw, pos.y + BOAT.h, pos.z + hw)
  const bbs = blockBoxes(bot, box.clone().extend(dx, 0, dz))
  let mx = dx; let mz = dz
  for (const bb of bbs) mx = bb.computeOffsetX(box, mx)
  box.offset(mx, 0, 0)
  for (const bb of bbs) mz = bb.computeOffsetZ(box, mz)
  box.offset(0, 0, mz)
  return { pos: new Vec3(box.minX + hw, pos.y, box.minZ + hw), hitX: mx !== dx, hitZ: mz !== dz }
}

// ------------------------------------------------------------------ лошадь

function pickHorse (bot, radius, id) {
  const me = bot.entity.position
  const all = (Object.values(bot.entities) as any[]).filter((e : any) => e && HORSES[e.name] && e.position && e.position.distanceTo(me) <= radius && !isBaby(e))
  if (id) return all.filter((e : any) => e.id === id)
  return all
    .filter((e : any) => canSeePoint(bot, e.position.offset(0, 1, 0)))
    .sort((a: any, b: any) => ((isTamedHorse(b) ? 2 : 0) + (isSaddled(b) ? 1 : 0)) - ((isTamedHorse(a) ? 2 : 0) + (isSaddled(a) ? 1 : 0)) || a.position.distanceTo(me) - b.position.distanceTo(me))
}

function horseInfo (e) {
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
async function tameHorse (session, ctl, e, report, { tries = 20 }: any = {}) {
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

async function saddleUp (session, ctl, e, report) {
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
async function rideHorse (session, ctl, e, target, report, { deadline, range = 1.5 }: any) {
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

// ------------------------------------------------------------------ лодка

function boatItemIn (bot) {
  return bot.inventory.items().find(i => /(_boat|_raft)$/.test(i.name) && !/chest/.test(i.name)) ||
    bot.inventory.items().find(i => /(_boat|_raft)$/.test(i.name)) || null
}

// Лодка из досок: 5 одной породы, на верстаке (рецепт 3×2).
async function craftBoat (session, ctl, report) {
  const bot = session.bot
  let stock = countItems(bot)
  // Досок нет, а брёвна есть — сперва доски (лодку спидраннеры делают из того,
  // что в рюкзаке; ферма, крепость A — «нужно 5 досок» при 6 брёвнах).
  if (!WOODS.some(w => (stock[`${w}_planks`] || 0) >= 5)) {
    const log = WOODS.find(w => (stock[`${w}_log`] || 0) + (stock[`stripped_${w}_log`] || 0) >= 2)
    if (log) {
      try { await (require('./actions') as typeof import('./actions')).craft(session, ctl, { item: `${log}_planks`, count: 8 }) } catch {}
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
  const actions: typeof import('./actions') = require('./actions')
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

async function launchBoat (session, ctl, report) {
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

function findBoat (bot, radius = 12) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[])
    .filter((e : any) => e && isBoatName(e.name) && e.position && e.position.distanceTo(me) <= radius && (!e.passengers || e.passengers.length === 0))
    .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
}

async function rideBoat (session, ctl, boat, target, report, { deadline, stay = false }: any) {
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
async function pickUpBoat (session, ctl, boat, report) {
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

// ------------------------------------------------------------------ вход

// Режимы. Лошадь (kind horse|donkey|mule): status — какая рядом; tame —
// приручить; saddle — приручить при нужде и осёдлать; mount — и сесть; go —
// и доехать до x,z (слезть, tie=true — привязать); tie — привязать ближнюю
// приручённую к забору; dismount. Лодка (kind boat): status; craft — лодку из
// досок; launch — спустить на воду; mount — сесть; go — доплыть до x,z,
// высадиться на берег, лодку разбить и подобрать (pickup=false — оставить);
// pickup — разбить и подобрать ближнюю пустую лодку; dismount.
const HORSE_MODES = ['status', 'tame', 'saddle', 'mount', 'go', 'tie', 'dismount']
const BOAT_MODES = ['status', 'craft', 'launch', 'mount', 'go', 'pickup', 'dismount']

async function run (session, ctl, p: any = {}) {
  const bot = session.bot
  patchVehicle(bot)
  attrFix(bot)
  // Транспорт, который далеко от тела или пропал, — призрак (пакет о высадке
  // пришёл до правки или сущность ушла без него): забыть.
  if (bot.vehicle && (!bot.entities[bot.vehicle.id] || bot.vehicle.position.distanceTo(bot.entity.position) > 4)) {
    bot.vehicle = null
    bot.entity.vehicle = null
  }
  const kind = String(p.kind || 'horse').toLowerCase()
  let mode = String(p.mode || 'go').toLowerCase()
  if (mode === 'ride' || mode === 'to' || mode === 'cross') mode = 'go'
  const report: any = { kind, mode }
  const t0 = gameClock.now()
  const deadline = t0 + Math.min(600, p.timeoutSeconds ?? 120) * 1000
  const target = (p.x !== undefined && p.z !== undefined) ? { x: Number(p.x) + 0.5, y: p.y !== undefined ? Number(p.y) : undefined, z: Number(p.z) + 0.5 } : null

  if (mode === 'dismount') {
    report.wasOn = bot.vehicle ? bot.vehicle.name : null
    report.dismounted = await dismount(bot)
    report.at = xyz(bot.entity.position)
    return report
  }

  if (kind === 'boat') {
    if (!BOAT_MODES.includes(mode)) throw new Error(`лодка: режим ${mode} не знаю — ${BOAT_MODES.join(' / ')}`)
    return runBoat(session, ctl, { ...p, mode }, report, target, deadline)
  }
  if (!HORSES[kind]) throw new Error(`не умею ездить на ${kind}: horse, donkey, mule или boat`)
  if (!HORSE_MODES.includes(mode)) throw new Error(`лошадь: режим ${mode} не знаю — ${HORSE_MODES.join(' / ')}`)

  // Лошадь: уже в седле — её, иначе ближайшая видимая. Привязать — только
  // приручённую: дикая с поводка не убежит, но и седла не примет.
  let e = bot.vehicle && HORSES[bot.vehicle.name] ? bot.vehicle : null
  if (!e) {
    const list = pickHorse(bot, p.radius ?? 24, p.id)
      .filter((x : any) => kind === 'horse' ? true : x.name === kind)
      .filter(x => mode !== 'tie' || isTamedHorse(x))
    if (!list.length) { report.stopped = `не вижу взрослой ${mode === 'tie' ? 'приручённой ' : ''}лошади (осла, мула) в ${p.radius ?? 24} блоках`; return report }
    e = list[0]
  }
  report.horse = horseInfo(e)
  if (mode === 'status') return report
  if (mode === 'tie') {
    if (bot.vehicle) await dismount(bot)
    await tie(session, ctl, e, report)
    if (!report.tied && !report.stopped) report.stopped = report.note || 'не привязал'
    return report
  }
  if (!isTamedHorse(e)) {
    if (p.tame === false) { report.stopped = 'лошадь дикая: mode=tame (или без tame=false)'; return report }
    const tamed = await tameHorse(session, ctl, e, report, { tries: p.tries ?? 20 })
    report.horse = horseInfo(e)
    if (!tamed) return report
    await sleep(800, ctl)
    if (bot.vehicle) await dismount(bot)
  }
  if (mode === 'tame') return report
  if (!(await saddleUp(session, ctl, e, report))) return report
  report.horse = horseInfo(e)
  if (mode === 'saddle') return report
  if (!bot.vehicle || bot.vehicle.id !== e.id) {
    if (!(await approach(bot, ctl, e, 1.8))) { report.stopped = 'не подошёл к лошади'; return report }
    if (!(await mountOn(bot, ctl, e))) { report.stopped = 'сесть не вышло (сервер не посадил)'; return report }
    report.mounted = true
    await sleep(300)
  }
  if (mode === 'mount') return report
  if (!target) { report.stopped = 'куда ехать? x и z'; return report }
  report.from = xyz(e.position)
  report.distance = Math.round(flat(e.position, target))
  const arrived = await rideHorse(session, ctl, e, target, report, { deadline, range: p.range ?? 1.5 })
  report.arrived = arrived
  if (!arrived && !report.stopped) report.stopped = ctl.aborted ? 'прервано' : `время вышло: осталось ${report.rode && report.rode.left} блоков — позови тот же вызов`
  if (report.rode && report.rode.seconds > 0) report.rode.avgSpeed = Math.round((report.distance - (report.rode.left || 0)) / report.rode.seconds * 10) / 10
  if (arrived && !p.stay) {
    report.dismounted = await dismount(bot)
    if (p.tie) await tie(session, ctl, e, report)
  }
  return report
}

// Привязать лошадь к забору: поводок на неё, потом клик по столбу забора
// (FenceBlock.useWithoutItem → LeadItem.bindPlayerMobs).
async function tie (session, ctl, e, report) {
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

async function runBoat (session, ctl, p, report, target, deadline) {
  const bot = session.bot
  const have = () => { const it = boatItemIn(bot); return it ? it.name : null }
  if (mode(p) === 'craft') {
    if (have() && !p.force) { report.have = have(); report.note = `лодка уже в рюкзаке: ${have()} (force=true — ещё одну)`; return report }
    await craftBoat(session, ctl, report)
    report.have = have()
    return report
  }
  if (mode(p) === 'pickup') {
    const boat: any = findBoat(bot, p.radius ?? 8)
    if (!boat) { report.stopped = `пустой лодки в ${p.radius ?? 8} блоках не вижу`; return report }
    report.boat = { kind: boat.name, at: xyz(boat.position) }
    await pickUpBoat(session, ctl, boat, report)
    if (!report.pickedUp && !report.stopped) report.stopped = 'лодку не подобрал'
    return report
  }
  let boat = bot.vehicle && isBoatName(bot.vehicle.name) ? bot.vehicle : null
  if (!boat && mode(p) !== 'launch') boat = findBoat(bot, p.radius ?? 8)
  if (!boat) {
    if (mode(p) === 'status') { report.boat = null; report.have = have(); return report }
    boat = await launchBoat(session, ctl, report)
    if (!boat) return report
  }
  report.boat = { kind: boat.name, at: xyz(boat.position) }
  if (mode(p) === 'status' || mode(p) === 'launch') { report.have = have(); return report }
  if (!bot.vehicle || bot.vehicle.id !== boat.id) {
    if (!(await approach(bot, ctl, boat, 2))) { report.stopped = 'не подошёл к лодке'; return report }
    if (!(await mountOn(bot, ctl, boat))) { report.stopped = 'сесть в лодку не вышло'; return report }
    report.mounted = true
    await sleep(300)
  }
  if (mode(p) === 'mount') return report
  if (!target) { report.stopped = 'куда плыть? x и z'; return report }
  report.distance = Math.round(flat(boat.position, target))
  const arrived = await rideBoat(session, ctl, boat, target, report, { deadline, stay: !!p.stay })
  report.arrived = arrived
  if (!arrived && !report.stopped) report.stopped = ctl.aborted ? 'прервано' : 'время вышло — позови тот же вызов'
  if (arrived && !p.stay) {
    // Доплыть до водной клетки недостаточно: без сухого места shift оставит
    // тело в воде. Сохраняем управление лодкой для следующего отрезка.
    if (report.beached !== true) { report.arrived = false; report.stopped = 'сухая площадка высадки не подтверждена — остаюсь в лодке'; return report }
    // AbstractBoat.getDismountLocationForPassenger: место высадки — в 1.3 блока
    // ПО ВЗГЛЯДУ наездника (getCollisionHorizontalEscapeVector от его yRot), и
    // только если там не вода. Смотреть на берег, потом shift.
    const shore = report.landingTarget || target
    const face = toMcYaw(Math.atan2(-(shore.x - boat.position.x), -(shore.z - boat.position.z)))
    for (let i = 0; i < 3; i++) { sendLook(bot, face, 20); sendVehicle(bot, boat.position, face, false); await sleep(TICK) }
    if (report.beached === false) report.note = (report.note ? report.note + ' ' : '') + 'к берегу вплотную не подошёл — сервер мог высадить в воду'
    report.dismounted = await dismount(bot)
    await sleep(400)
    const ashore = bot.entity.position.clone()
    if (DEBUG) console.log(`[boat] dismount face ${face.toFixed(0)} boat ${boat.position} → body ${ashore}`)
    // Лодку с собой — если не сказано оставить.
    if (p.pickup !== false && report.dismounted) {
      await pickUpBoat(session, ctl, boat, report)
      if (DEBUG) console.log(`[boat] after pickup body ${bot.entity.position}`)
      // За дропом тело могло зайти в воду (предмет плавает у берега) —
      // вернуться туда, куда высадила лодка.
      if (!ctl.aborted && bot.entity.position.distanceTo(ashore) > 1.5) {
        try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(ashore.x, ashore.y, ashore.z, 1)), 10000) } catch { try { bot.pathfinder.setGoal(null) } catch {} }
      }
    }
    report.landed = xyz(bot.entity.position)
    report.onLand = flat(bot.entity.position, target)
    report.onLand = Math.round(report.onLand * 10) / 10
  }
  return report
}

const mode = p => String(p.mode || 'go').toLowerCase()

module.exports = { run, dismount, mountOn, tameHorse, patchVehicle, isTamedHorse, isSaddled, horseInfo, HORSES, HORSE_MODES, BOAT_MODES, isBoatName, astar }
export {
  run, dismount, mountOn, tameHorse, patchVehicle, isTamedHorse, isSaddled, horseInfo, HORSES, HORSE_MODES,
  BOAT_MODES, isBoatName, astar
}
