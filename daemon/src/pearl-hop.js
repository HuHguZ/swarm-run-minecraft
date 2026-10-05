'use strict'
const gameClock = require('./game-clock')
// Жемчуг как быстрое перемещение (2026-10-01, агент дракона). Общий модуль: «добраться до точки goal
// одним-тремя бросками вместо пешего пути/моста», если это быстрее с учётом цены в хп.
//
// Физика — сверено по байткоду paper-1.21.11.jar (javap: codex-lab/pearl/javap):
//   * EnderpearlItem.use → Projectile.spawnProjectileFromRotationDelayed(…, zRot 0, сила 1.5, неточность 1.0);
//     кулдаун предмета — 20 тиков;
//   * getMovementToShoot: dir.normalize() + triangle(0, 0.0172275 × неточность) по каждой оси, × 1.5 (без
//     повторной нормировки); shootFromRotation прибавляет getKnownMovement бросающего (вертикаль — только
//     если он не на земле) — это уже учитывает throw.js;
//   * ThrowableProjectile.tick: гравитация 0.03 → трение 0.99 (в воде 0.8) → луч по отрезку движения
//     (ClipContext COLLIDER — точка, не коробка 0.25) и сущности по пути → сдвиг;
//   * ThrownEnderpearl.onHit: перенос в oldPosition() — позицию жемчуга в начале тика удара, сброс падения,
//     урон 5.0 типа ender_pearl (теги 1.21.11: is_fall и bypasses_armor — броня не режет, «Защита» и
//     «Невесомость» режут), 5 % — эндермит;
//   * onHitEntity: entity.hurt(thrown, 0) — кристалл Энда от этого ВЗРЫВАЕТСЯ (любой урон не от дракона),
//     эндермен телепортируется, дракон — жемчуг переносит в воздух у его коробки. Поэтому путь держим
//     подальше от сущностей.
//
// Что делает модуль:
//   planHop(bot, goal, opts) — выбрать бросок: кандидаты посадки у линии на goal (твёрдый верх, 2 воздуха над
//     ним, не край пустоты, не вода/лава, не opts.avoid), угол — по баллистике throw.js, проверка траектории по
//     блокам мира (жемчуг не врезается раньше), разброс ±0.7 от предельного — посадка безопасна тоже;
//   worth(…) — стоит ли бросать: время пешком против броска + цена хп в секундах, порог хп, резерв жемчуга;
//   hopTo(bot, goal, opts) — до maxHops бросков через throw.throwAt (pick — пересчёт прицела на тике броска со
//     своим движением), проверка факта (куда перенесло, сколько хп), еда между бросками, у края — шаг от пустоты.
//   Крючок opts.onEdge(bot, info) — будущее «блок под ноги у края» (сейчас не используется по умолчанию).

const Vec3 = require('vec3')
const throwMod = require('./throw')

const K = throwMod.KINDS.ender_pearl
const DRAG = 0.99
const DEG = Math.PI / 180
const PEARL_DMG = 5
const SPREAD = 0.0172275
const EYE = 1.62 - 0.1
const BAD = /lava|fire|magma|cactus|campfire|sweet_berry|powder_snow|water|portal|bubble_column|cobweb|scaffolding|pointed_dripstone/
const AIRISH_BAD = /lava|water|fire|portal|cobweb|powder_snow|bubble_column/

function solidB (b) { return !!b && b.boundingBox === 'block' }
function airB (b) { return !!b && b.boundingBox === 'empty' && !AIRISH_BAD.test(b.name) }

// world(x, y, z) -> блок или null (чанк не прогружен)
function worldOf (bot) {
  const cache = new Map()
  return (x, y, z) => {
    const k = x + ',' + y + ',' + z
    if (cache.has(k)) return cache.get(k)
    let b = null
    try { b = bot.blockAt(new Vec3(x, y, z)) } catch { b = null }
    cache.set(k, b)
    return b
  }
}

// Полёт жемчуга по тикам с лучом по блокам. Возвращает { tp, at, ticks, path } (tp — куда перенесёт),
// либо { void }, { unknown } (непрогруженный блок на пути), { water }.
function simulate (world, from, v0, { maxTicks = 240, minY = -64 } = {}) {
  let p = { x: from.x, y: from.y, z: from.z }
  let v = { x: v0.x, y: v0.y, z: v0.z }
  const path = [p]
  for (let t = 0; t < maxTicks; t++) {
    v = { x: v.x * DRAG, y: (v.y - K.g) * DRAG, z: v.z * DRAG }
    const len = Math.hypot(v.x, v.y, v.z)
    const n = Math.max(1, Math.ceil(len / 0.2))
    let lastKey = null
    for (let i = 1; i <= n; i++) {
      const f = i / n
      const q = { x: p.x + v.x * f, y: p.y + v.y * f, z: p.z + v.z * f }
      const cx = Math.floor(q.x); const cy = Math.floor(q.y); const cz = Math.floor(q.z)
      const key = cx + ',' + cy + ',' + cz
      if (key === lastKey) continue
      lastKey = key
      if (cy < minY) return { void: true, ticks: t + 1, path }
      const b = world(cx, cy, cz)
      if (!b) return { unknown: true, ticks: t + 1, at: q, path }
      if (/water|lava/.test(b.name)) return { water: true, ticks: t + 1, at: q, path }
      if (solidB(b)) return { tp: p, at: q, cell: { x: cx, y: cy, z: cz }, ticks: t + 1, path }
    }
    p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }
    path.push(p)
  }
  return { void: true, ticks: maxTicks, path }
}

// Колонка под точкой: первый твёрдый блок не глубже depth. -> y верха (ноги) или null.
function groundBelow (world, x, y, z, depth = 6) {
  const cx = Math.floor(x); const cz = Math.floor(z)
  const y0 = Math.floor(y)
  for (let k = 0; k <= depth; k++) {
    const b = world(cx, y0 - k, cz)
    if (!b) return null
    if (solidB(b)) return y0 - k + 1
  }
  return null
}

// Куда встанут ноги после переноса в tp и годится ли место. -> { ok, feet, fall, edge, why }
function settle (world, tp, { floorOk = null, avoid = null } = {}) {
  const cx = Math.floor(tp.x); const cz = Math.floor(tp.z)
  const y0 = Math.floor(tp.y)
  for (let dy = 0; dy <= 1; dy++) {
    const b = world(cx, y0 + dy, cz)
    if (!b) return { ok: false, why: 'не прогружено' }
    if (solidB(b) || AIRISH_BAD.test(b.name)) return { ok: false, why: `в блоке (${b.name})` }
  }
  let fy = null; let floor = null
  for (let k = 0; k <= 5; k++) {
    const b = world(cx, y0 - k, cz)
    if (!b) return { ok: false, why: 'не прогружено' }
    if (AIRISH_BAD.test(b.name) && !solidB(b)) return { ok: false, why: b.name }
    if (solidB(b)) { fy = y0 - k + 1; floor = b; break }
  }
  if (fy == null) return { ok: false, why: 'под ногами пусто' }
  if (BAD.test(floor.name)) return { ok: false, why: `пол ${floor.name}` }
  if (floorOk && !floorOk(floor)) return { ok: false, why: `пол ${floor.name} не годится` }
  const feet = new Vec3(cx + 0.5, fy, cz + 0.5)
  for (let dy = 0; dy <= 1; dy++) if (!airB(world(cx, fy + dy, cz))) return { ok: false, why: 'нет 2 воздуха' }
  if (avoid && avoid(feet)) return { ok: false, why: 'запретная зона' }
  // Край: соседи на 1 и 2 блока — есть ли под ними земля (не глубже 4 от ног).
  let edge = 0; let edge1 = 0
  for (const r of [1, 2]) {
    for (let a = 0; a < 8; a++) {
      const x = cx + Math.round(Math.cos(a * Math.PI / 4) * r)
      const z = cz + Math.round(Math.sin(a * Math.PI / 4) * r)
      const g = groundBelow(world, x + 0.5, fy + 1, z + 0.5, 5)
      if (g == null) { edge++; if (r === 1) edge1++ }
    }
  }
  return { ok: true, feet, floor: floor.name, fall: Math.max(0, tp.y - fy), edge, edge1 }
}

// Высота над точкой: верх твёрдого с 2 воздуха над ним (первый сверху). -> y ног или null.
function surfaceAt (world, x, z, yTop, yBot) {
  let airRun = 0
  for (let y = yTop; y >= yBot; y--) {
    const b = world(x, y, z)
    if (!b) return null
    if (solidB(b)) return airRun >= 2 ? y + 1 : null
    airRun = airB(b) ? airRun + 1 : 0
  }
  return null
}

// Наклоны (рад), при которых жемчуг на горизонтали dx пройдёт высоту dy: низкая и высокая дуги.
function pitchesFor (dx, dy) {
  const out = []
  const yAt = (p) => {
    const l = throwMod.launch(p, K)
    const f = throwMod.flight(l.vh, l.vy, dx, K)
    return f ? f.y : -Infinity
  }
  let prevP = -40 * DEG; let prevY = yAt(prevP)
  for (let d = -39; d <= 80; d += 1) {
    const p = d * DEG
    const y = yAt(p)
    if ((prevY < dy) !== (y < dy) && isFinite(prevY) && isFinite(y)) {
      let lo = prevP; let hi = p
      const up = y >= dy
      for (let i = 0; i < 25; i++) {
        const mid = (lo + hi) / 2
        if ((yAt(mid) >= dy) === up) hi = mid; else lo = mid
      }
      out.push(hi)
      if (out.length === 2) break
    } else if (!isFinite(prevY) && isFinite(y) && y >= dy) {
      out.push(p)
    }
    prevP = p; prevY = y
  }
  return out
}

// Наибольшая дальность по горизонтали при перепаде dy (кэш по целому dy).
const REACH = new Map()
function reach (dy) {
  const k = Math.round(dy)
  if (REACH.has(k)) return REACH.get(k)
  const ok = (dx) => {
    for (let d = -30; d <= 80; d += 1) {
      const l = throwMod.launch(d * DEG, K)
      const f = throwMod.flight(l.vh, l.vy, dx, K)
      if (f && f.y >= k) return true
    }
    return false
  }
  let lo = 0; let hi = 120
  for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid }
  REACH.set(k, lo)
  return lo
}

function velOf (yaw, pitch, extra = null) {
  const l = throwMod.launch(pitch, K)
  const v = { x: -Math.sin(yaw) * l.vh, y: l.vy, z: -Math.cos(yaw) * l.vh }
  if (extra) { v.x += extra.x; v.y += extra.y; v.z += extra.z }
  return v
}

// Скорость с отклонением разброса: dir + e (в долях от единичного), × 1.5 — как getMovementToShoot.
function spreadVel (yaw, pitch, ex, ey, ez) {
  const l = throwMod.launch(pitch, K)
  const d = { x: -Math.sin(yaw) * l.vh / K.speed, y: l.vy / K.speed, z: -Math.cos(yaw) * l.vh / K.speed }
  return { x: (d.x + ex) * K.speed, y: (d.y + ey) * K.speed, z: (d.z + ez) * K.speed }
}

function segDist (a, b, q) {
  const vx = b.x - a.x; const vy = b.y - a.y; const vz = b.z - a.z
  const l2 = vx * vx + vy * vy + vz * vz
  let t = l2 > 1e-9 ? ((q.x - a.x) * vx + (q.y - a.y) * vy + (q.z - a.z) * vz) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(a.x + vx * t - q.x, a.y + vy * t - q.y, a.z + vz * t - q.z)
}
function pathClear (path, obstacles) {
  for (const o of obstacles) {
    for (let i = 1; i < path.length; i++) if (segDist(path[i - 1], path[i], o.pos) < o.r) return o
  }
  return null
}

// Препятствия-сущности: кристалл (взорвётся от удара), дракон (коробка 16 × 8), эндермен.
function obstaclesOf (bot) {
  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e === bot.entity) continue
    const n = e.name || ''
    if (n === 'end_crystal') out.push({ pos: e.position.offset(0, 1, 0), r: 3, name: n })
    else if (n === 'ender_dragon') out.push({ pos: e.position.offset(0, 2, 0), r: 14, name: n })
    else if (n === 'enderman') out.push({ pos: e.position.offset(0, 1.5, 0), r: 1.6, name: n })
  }
  return out
}

// Урон переноса с учётом «Защиты» и «Невесомости» на броне (тип ender_pearl: is_fall, bypasses_armor).
function pearlDamage (bot) {
  let epf = 0
  const slots = (bot.inventory && bot.inventory.slots) || []
  for (let s = 5; s <= 8; s++) {
    const it = slots[s]
    if (!it) continue
    let ench = []
    try { ench = it.enchants || [] } catch { ench = [] }
    for (const e of ench) {
      if (e.name === 'protection') epf += e.lvl
      else if (e.name === 'feather_falling') epf += 3 * e.lvl
    }
  }
  epf = Math.min(20, epf)
  let dmg = PEARL_DMG * (1 - epf / 25)
  const res = bot.entity && bot.entity.effects && Object.values(bot.entity.effects).find(e => e && (e.id === 11 || e.name === 'resistance'))
  if (res) dmg *= Math.max(0, 1 - 0.2 * ((res.amplifier || 0) + 1))
  return Math.round(dmg * 100) / 100
}

// Оценка пешего пути: по прямой, пустота по пути — мост (медленно), подъём.
function walkEstimate (world, from, to, { speed = 4.3, detour = 1.2, bridgeSec = 1.1, climbSec = 0.5 } = {}) {
  const dx = to.x - from.x; const dz = to.z - from.z
  const d = Math.hypot(dx, dz)
  let voids = 0
  const n = Math.ceil(d)
  for (let i = 1; i < n; i++) {
    const x = from.x + dx * i / n; const z = from.z + dz * i / n
    const top = surfaceAt(world, Math.floor(x), Math.floor(z), Math.max(from.y, to.y) + 12, Math.min(from.y, to.y) - 12)
    if (top == null) voids++
  }
  const climb = Math.max(0, to.y - from.y)
  const sec = (d - voids) / speed * detour + voids * bridgeSec + climb * climbSec
  return { sec: Math.round(sec * 10) / 10, dist: Math.round(d), voids }
}

// Время броска: прицел/смена предмета, полёт, приход в себя после переноса.
function hopSeconds (ticks) { return 0.4 + ticks / 20 + 0.4 }

// Стоит ли бросать. hpSec — сколько секунд стоит 1 хп (регенерация/риск), minGain — порог выигрыша.
function worth ({ walkSec, hopSec, restSec = 0, dmg, hp, hpMin = 12, hpSec = 1.5, minGain = 3, pearls = 0, reserve = 0 }) {
  if (pearls - reserve <= 0) return { go: false, why: `жемчуга ${pearls}, резерв ${reserve}` }
  if (hp - dmg < hpMin) return { go: false, why: `хп ${Math.round(hp * 10) / 10} − ${dmg} < ${hpMin}`, lowHp: true }
  const cost = hopSec + restSec + dmg * hpSec
  const gain = Math.round((walkSec - cost) * 10) / 10
  if (gain < minGain) return { go: false, why: `выигрыш ${gain} с < ${minGain}`, gain }
  return { go: true, gain }
}

// Выбор броска к goal из from (точка вылета = ноги + EYE). opts:
//   maxR, minR — дальность посадки; lateral — поперёк линии; arriveR — уже у цели;
//   floorOk(block), avoid(feet) — фильтры места; obstacles — сущности [{pos, r}]; spread — доля разброса.
function planHop (world, feet, goal, { maxR = 70, minR = 6, lateral = [0, -2, 2, -4, 4, -7, 7, -10, 10], floorOk = null, avoid = null, obstacles = [], spread = 0.7, yTop = 30, yBot = 16, maxTries = 80, lookOk = null } = {}) {
  const from = { x: feet.x, y: feet.y + EYE, z: feet.z }
  const gx = goal.x - feet.x; const gz = goal.z - feet.z
  const gd = Math.hypot(gx, gz)
  if (gd < 1) return { plan: null, why: 'уже у цели' }
  const ux = gx / gd; const uz = gz / gd
  const cands = []
  const seen = new Set()
  for (let r = Math.min(maxR, gd + 3); r >= minR; r -= 1) {
    for (const lat of lateral) {
      const x = Math.floor(feet.x + ux * r - uz * lat)
      const z = Math.floor(feet.z + uz * r + ux * lat)
      const key = x + ',' + z
      if (seen.has(key)) continue
      seen.add(key)
      const sy = surfaceAt(world, x, z, Math.floor(feet.y) + yTop, Math.floor(feet.y) - yBot)
      if (sy == null) continue
      const rem = Math.hypot(goal.x - (x + 0.5), goal.z - (z + 0.5))
      cands.push({ x, z, y: sy, rem })
    }
  }
  cands.sort((a, b) => a.rem - b.rem)
  const why = {}
  const no = (k) => { why[k] = (why[k] || 0) + 1 }
  let tries = 0
  for (const c of cands) {
    if (tries >= maxTries) break
    const pre = settle(world, { x: c.x + 0.5, y: c.y + 0.3, z: c.z + 0.5 }, { floorOk, avoid })
    if (!pre.ok) { no(pre.why); continue }
    if (pre.edge1) { no('край пустоты'); continue }
    const tx = c.x + 0.5 - from.x; const tz = c.z + 0.5 - from.z
    const dx = Math.hypot(tx, tz)
    if (dx > reach(c.y + 0.05 - from.y) - 0.3) { no('не долетит'); continue }
    tries++
    const yaw = Math.atan2(-tx, -tz)
    const ps = pitchesFor(dx, c.y + 0.05 - from.y)
    if (!ps.length) { no('не долетит'); continue }
    for (const pitch of ps) {
      if (lookOk && !lookOk(yaw, pitch)) { no('взгляд'); continue }
      const sim = simulate(world, from, velOf(yaw, pitch))
      if (!sim.tp) { no(sim.void ? 'в пустоту' : sim.unknown ? 'не прогружено' : 'вода'); continue }
      const st = settle(world, sim.tp, { floorOk, avoid })
      if (!st.ok) { no('посадка: ' + st.why); continue }
      if (Math.hypot(st.feet.x - (c.x + 0.5), st.feet.z - (c.z + 0.5)) > 2.5 || Math.abs(st.feet.y - c.y) > 2) { no('врезается раньше'); continue }
      if (st.edge1) { no('край пустоты'); continue }
      const hit = pathClear(sim.path, obstacles)
      if (hit) { no('на пути ' + hit.name); continue }
      // Разброс: ±spread от предельного отклонения по поперечной и вертикальной оси.
      const a = SPREAD * spread
      const px = Math.cos(yaw); const pz = -Math.sin(yaw)
      let bad = null
      for (const [ex, ey, ez] of [[a * px, 0, a * pz], [-a * px, 0, -a * pz], [0, a, 0], [0, -a, 0]]) {
        const s2 = simulate(world, from, spreadVel(yaw, pitch, ex, ey, ez))
        if (!s2.tp) { bad = s2.void ? 'разброс: пустота' : 'разброс: ?'; break }
        const t2 = settle(world, s2.tp, { floorOk, avoid })
        if (!t2.ok) { bad = 'разброс: ' + t2.why; break }
        if (t2.edge1) { bad = 'разброс: край'; break }
      }
      if (bad) { no(bad); continue }
      return {
        plan: {
          yaw, pitch, ticks: sim.ticks, cell: { x: c.x, y: c.y, z: c.z }, tp: sim.tp, feet: st.feet, fall: st.fall, edge: st.edge,
          aim: new Vec3(c.x + 0.5, c.y + 0.05, c.z + 0.5), rem: Math.hypot(goal.x - st.feet.x, goal.z - st.feet.z), arc: pitch === ps[0] ? 'low' : 'high'
        },
        tries,
        why
      }
    }
  }
  return { plan: null, tries, why, cands: cands.length }
}

const r1 = (x) => Math.round(x * 10) / 10
const xyz = (p) => p ? `${r1(p.x)},${r1(p.y)},${r1(p.z)}` : '?'
const countPearls = (bot) => bot.inventory.items().filter(i => i.name === 'ender_pearl').reduce((n, i) => n + i.count, 0)
const sleep = (ms) => new Promise(resolve => gameClock.setTimeout(resolve, ms))

async function waitTeleport (bot, from, ms) {
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < ms) {
    await sleep(50)
    const p = bot.entity && bot.entity.position
    if (p && p.distanceTo(from) > 2.5) return true
  }
  return false
}

// Еда/регенерация между бросками: доесть до сытости и подождать хп (не дольше maxMs).
async function recover (bot, want, maxMs = 5000, stopIf = null) {
  const t0 = gameClock.now()
  if ((bot.food ?? 20) < 20) {
    const food = bot.inventory.items().find(i => /cooked_|bread|baked_potato|golden_carrot|steak|apple$/.test(i.name) && !/golden_apple|enchanted/.test(i.name))
    if (food) {
      try { await bot.equip(food, 'hand'); await bot.consume() } catch {}
    }
  }
  while ((bot.health ?? 20) < want && gameClock.now() - t0 < maxMs && (bot.food ?? 20) >= 18 && !(stopIf && stopIf())) await sleep(250)
  return bot.health
}

// Шаг от пустоты после посадки у края: в сторону, где земля (крючок onEdge — блок под ноги, на будущее).
async function stepFromEdge (bot, world, opts = {}) {
  const p = bot.entity.position
  let vx = 0; let vz = 0; let voids = 0
  for (let a = 0; a < 8; a++) {
    const dx = Math.cos(a * Math.PI / 4); const dz = Math.sin(a * Math.PI / 4)
    const g = groundBelow(world, p.x + dx * 1.2, p.y + 0.5, p.z + dz * 1.2, 5)
    if (g == null) { vx -= dx; vz -= dz; voids++ }
  }
  if (!voids) return { moved: false }
  if (opts.onEdge) {
    try { const r = await opts.onEdge(bot, { voids }); if (r) return { moved: false, hook: r } } catch {}
  }
  const yaw = Math.atan2(-vx, -vz)
  try { await bot.look(yaw, 0, true) } catch {}
  bot.setControlState('sneak', true)
  bot.setControlState('forward', true)
  await sleep(450)
  bot.setControlState('forward', false)
  bot.setControlState('sneak', false)
  return { moved: true, voids }
}

// Быстрая проверка «бросок отсюда к goal стоит того?» (для ходьбы: остановиться и бросить). -> { go, why, plan }
function hopWorth (bot, goal, opts = {}) {
  const reserve = opts.reserve ?? 1
  const pearls = countPearls(bot)
  if (pearls - reserve <= 0) return { go: false, why: 'жемчуг' }
  const world = worldOf(bot)
  const me = bot.entity.position
  const ph = planHop(world, me, goal, { floorOk: opts.floorOk, avoid: opts.avoid, lookOk: opts.lookOk, obstacles: opts.obstacles || obstaclesOf(bot), maxTries: opts.maxTries ?? 12 })
  if (!ph.plan) return { go: false, why: 'нет броска' }
  const walk = walkEstimate(world, me, goal)
  const rest = walkEstimate(world, ph.plan.feet, goal)
  const w = worth({ walkSec: walk.sec, hopSec: hopSeconds(ph.plan.ticks), restSec: rest.sec, dmg: pearlDamage(bot), hp: bot.health, hpMin: opts.hpMin ?? 12, hpSec: opts.hpSec ?? 1.5, minGain: opts.minGain ?? 3, pearls, reserve })
  return { ...w, plan: ph.plan }
}

// До maxHops бросков к goal. opts: reserve, hpMin, hpSec, minGain, maxHops, arriveR, floorOk, avoid, obstacles
// (fn или массив), lookOk, log, abortIf(), onEdge. -> сводка { hops, pearls, hpLost, ms, misses, stops, log }
async function hopTo (bot, goal, opts = {}) {
  const log = opts.log || ((m) => console.log('[pearl] ' + m))
  const { reserve = 1, hpMin = 12, hpSec = 1.5, minGain = 3, maxHops = 3, arriveR = 4 } = opts
  const out = { hops: 0, pearls: 0, hpLost: 0, ms: 0, misses: 0, saved: 0, steps: [] }
  const t0 = gameClock.now()
  for (let k = 0; k < maxHops; k++) {
    if (opts.abortIf && opts.abortIf()) { out.stop = 'прервано'; break }
    const world = worldOf(bot)
    const me = bot.entity.position.clone()
    const rem = Math.hypot(goal.x - me.x, goal.z - me.z)
    if (rem <= arriveR) { out.stop = 'у цели'; break }
    const pearls = countPearls(bot)
    if (pearls - reserve <= 0) { out.stop = `жемчуга ${pearls} (резерв ${reserve})`; break }
    const obstacles = typeof opts.obstacles === 'function' ? opts.obstacles() : (opts.obstacles || obstaclesOf(bot))
    const tPlan = gameClock.wall.now()
    const ph = planHop(world, me, goal, { floorOk: opts.floorOk, avoid: opts.avoid, obstacles, lookOk: opts.lookOk, maxR: opts.maxR || 70 })
    const planMs = gameClock.wall.now() - tPlan
    if (!ph.plan) { out.stop = 'нет броска'; log(`нет броска к ${xyz(goal)} (${Math.round(rem)} бл.): ${JSON.stringify(ph.why)} за ${planMs} мс`); break }
    const pl = ph.plan
    // opts.walkSec — время пешком, посчитанное зовущим по настоящему пути (hopgoto: A* pathfinder'а), только для
    // первого броска; без него — оценка по прямой (как было).
    const walk = k === 0 && Number.isFinite(opts.walkSec) ? { sec: opts.walkSec, voids: '—' } : walkEstimate(world, me, goal)
    const rest = walkEstimate(world, pl.feet, goal)
    const dmg = pearlDamage(bot)
    let w = worth({ walkSec: walk.sec, hopSec: hopSeconds(pl.ticks), restSec: rest.sec, dmg, hp: bot.health, hpMin, hpSec, minGain, pearls, reserve })
    if (!w.go && w.lowHp) {
      const hp = await recover(bot, hpMin + dmg, opts.recoverMs ?? 5000)
      w = worth({ walkSec: walk.sec, hopSec: hopSeconds(pl.ticks), restSec: rest.sec, dmg, hp, hpMin, hpSec, minGain, pearls, reserve })
    }
    log(`бросок ${k + 1}: до цели ${Math.round(rem)} бл., пешком ~${walk.sec} с (пустоты ${walk.voids}); жемчугом ${r1(hopSeconds(pl.ticks))} с + остаток ${rest.sec} с + хп ${dmg}×${hpSec}; ` +
      `выигрыш ${w.gain ?? '-'} с; посадка ${xyz(pl.feet)} (${pl.arc}, ${pl.ticks} т, край ${pl.edge}), план ${planMs} мс, проб ${ph.tries}${w.go ? '' : ' — НЕТ: ' + w.why}`)
    if (!w.go) { out.stop = w.why; break }
    // Бросок: прицел пересчитывается на тике броска (своё движение) и проверяется по блокам.
    try { for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) bot.setControlState(c, false) } catch {}
    for (let i = 0; i < 10 && !(bot.entity.onGround && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.01); i++) await sleep(50)
    const pearl = bot.inventory.items().find(i => i.name === 'ender_pearl')
    const hp0 = bot.health
    const from0 = bot.entity.position.clone()
    let picked = null
    const r = await throwMod.throwAt(bot, null, {
      item: pearl,
      // Прицел — на тике броска из точной точки вылета, та же дуга, что в плане; своё движение — в скорость.
      pick: (ctx) => {
        const tx = pl.aim.x - ctx.from.x; const tz = pl.aim.z - ctx.from.z
        const yaw = Math.atan2(-tx, -tz)
        const ps = pitchesFor(Math.hypot(tx, tz), pl.aim.y - ctx.from.y)
        const pitch = pl.arc === 'high' ? ps[1] : ps[0]
        if (pitch == null) return null
        const extra = { x: ctx.moved.x, y: ctx.airborne ? ctx.moved.y : 0, z: ctx.moved.z }
        const sim = simulate(world, ctx.from, velOf(yaw, pitch, extra))
        const st = sim.tp ? settle(world, sim.tp, { floorOk: opts.floorOk, avoid: opts.avoid }) : null
        if (!st || !st.ok || st.edge1 || Math.hypot(st.feet.x - pl.feet.x, st.feet.z - pl.feet.z) > 2.5) return null
        if (opts.lookOk && !opts.lookOk(yaw, pitch)) return null
        picked = { tp: sim.tp, feet: st.feet, ticks: sim.ticks }
        return { yaw, pitch, ticks: sim.ticks, at: pl.aim }
      }
    }).catch(e => ({ thrown: false, why: e.message }))
    if (!r || !r.thrown) { out.stop = `не бросил: ${r && r.why}`; log(out.stop); break }
    out.pearls++
    const ticks = (picked && picked.ticks) || pl.ticks
    const moved = await waitTeleport(bot, from0, ticks * 50 + 2500)
    await sleep(350)
    const p1 = bot.entity.position.clone()
    const lost = Math.max(0, r1(hp0 - bot.health))
    const want = (picked && picked.feet) || pl.feet
    const err = Math.hypot(p1.x - want.x, p1.z - want.z)
    const world2 = worldOf(bot)
    const ground = groundBelow(world2, p1.x, p1.y + 0.1, p1.z, 40)
    const step = { k: k + 1, from: xyz(from0), want: xyz(want), got: xyz(p1), err: r1(err), dy: r1(p1.y - want.y), hp: `${r1(hp0)}→${r1(bot.health)}`, lost, ticks, moved }
    out.steps.push(step)
    out.hpLost = r1(out.hpLost + lost)
    if (!moved) { out.misses++; out.stop = 'не перенесло'; log(`бросок ${k + 1}: не перенесло (жемчуг в ${xyz(want)}?)`); break }
    out.hops++
    out.saved = r1(out.saved + (w.gain || 0))
    const miss = err > 4 || ground == null
    log(`бросок ${k + 1}: перенесло в ${xyz(p1)} (план ${xyz(want)}, ошибка ${r1(err)} бл.), хп ${step.hp} (−${lost})${miss ? ' — ПРОМАХ' : ''}`)
    if (miss) { out.misses++; if (ground == null) { out.stop = 'в пустоту'; break } }
    const sf = await stepFromEdge(bot, world2, opts)
    if (sf.moved) log(`у края (пустота с ${sf.voids} сторон) — шаг от пустоты`)
  }
  out.ms = gameClock.now() - t0
  return out
}

module.exports = { recover, hopWorth, worldOf, reach, simulate, settle, surfaceAt, groundBelow, pitchesFor, planHop, worth, walkEstimate, hopSeconds, pearlDamage, obstaclesOf, hopTo, stepFromEdge, velOf, PEARL_DMG, SPREAD, EYE }
