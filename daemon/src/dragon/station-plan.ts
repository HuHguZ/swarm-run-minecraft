import { countOf, DIRS4, virtualBot, SNEAK_EYE, fillPlaceable, exposure, landingForecast, lookAtSafe, bedDamage } from './evade-raw'
import { pillowDys, pillarPlan, pillarKey, pillarCells, faceClick, runnerAim, headPoint } from './pillar-plan'
import { cloudsOf, Vec3, cloudHits, runnerOn, EYE, findItem, gameClock, dragonOf, hpOf, phaseOf, PHASE, PHASE_RU, sleep, pick, partsOf, makeTrack, isAirish, envNum, supportCell, CENTER, offIsland, dbg, lookSafe, voidBelow, isSolid, clearControls, FILLER_RE, bow, SITTING, actions, build, items } from './dig-down-to'
import { surfaceY, r1, inClouds, doing, standY } from './fall-guard'
import { FACE_IDX, AXES, DAMAGE_TYPES } from './ts-plan'
async function waterToHotbar (bot) {
  const i = bot.inventory.slots.findIndex((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')
  if (i >= 0) return true
  const wb = findItem(bot, /^water_bucket$/)
  if (!wb) return false
  // Не через equip: тот меняет местами с выбранным слотом, и «взять меч
  const sel = 36 + bot.quickBarSlot
  const keep = /sword|axe|bow|pickaxe|golden_apple|_bed$|potion/
  let dest = -1
  for (let k = 36; k <= 44; k++) if (k !== sel && !bot.inventory.slots[k]) { dest = k; break }
  if (dest < 0) for (let k = 36; k <= 44; k++) if (k !== sel && !keep.test(bot.inventory.slots[k].name)) { dest = k; break }
  if (dest < 0) return false
  try { await bot.moveSlotItem(wb.slot, dest) } catch (e) { dbg('water to hotbar', e.message) }
  return bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')
}

async function stepOnto (bot, ctl, x, z) {
  const target = new Vec3(x + 0.5, 0, z + 0.5)
  const t0 = gameClock.now()
  bot.setControlState('sneak', true)
  try {
    while (!ctl.aborted && gameClock.now() - t0 < 2500) {
      const p = bot.entity.position
      const dx = target.x - p.x; const dz = target.z - p.z
      if (Math.hypot(dx, dz) < 0.2) break
      await lookSafe(bot, Math.atan2(-dx, -dz), -0.6)
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally {
    bot.setControlState('forward', false)
  }
}

const CRYS_BAND = [13, 30]

function crysAlive (ctl) { return ctl.crys ? [...ctl.crys.known.values()].filter(k => !k.gone).length : null }

function dropSpot (bot, dir) {
  const p = bot.entity.position
  for (const k of [1, 2]) {
    const x = Math.floor(p.x) + dir.x * k; const z = Math.floor(p.z) + dir.z * k
    const land = surfaceY(bot, x + 0.5, z + 0.5, Math.floor(p.y) - 1)
    if (!land || voidBelow(bot, x + 0.5, land.y + 0.5, z + 0.5, 4)) continue
    if (/lava|fire|portal/.test(land.name)) continue
    if (inClouds(cloudsOf(bot), new Vec3(x + 0.5, land.y, z + 0.5), 1.5)) continue
    // Сбоку по пути падения — воздух (иначе зацепимся за свой же мост).
    let clear = true
    for (let y = land.y; y < Math.floor(p.y) + 2 && clear; y++) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (b && isSolid(b)) clear = false
    }
    if (clear) return { x: x + 0.5, z: z + 0.5, landY: land.y, k }
  }
  return null
}

async function dropOff (bot, ctl, stats, dir, why) {
  const spot = dropSpot(bot, dir)
  if (!spot) return { ok: false, why: 'спрыгнуть некуда' }
  const water = bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')
  const fall = bot.entity.position.y - spot.landY
  if (!water && fall > 6) return { ok: false, why: 'без ведра в хотбаре со столба не прыгаю' }
  stats.drops = (stats.drops || 0) + 1
  if (ctl.trace) ctl.trace.ev('drop', { why, fall: r1(fall), water })
  clearControls(bot)
  const yaw = Math.atan2(-(spot.x - bot.entity.position.x), -(spot.z - bot.entity.position.z))
  await bot.look(yaw, 0, true).catch(() => {})
  const hp0 = bot.health
  const y0 = bot.entity.position.y
  // Сперва на ноги: сброс, начатый в прыжке (последний блок столба), сразу видел
  const tg = gameClock.now()
  while (!ctl.aborted && !bot.entity.onGround && gameClock.now() - tg < 800) await sleep(50)
  bot.setControlState('sneak', false)
  bot.setControlState('forward', true)
  const t0 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t0 < 1500 && bot.entity.onGround) await sleep(50)
  await sleep(120)
  bot.setControlState('forward', false)
  const t1 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t1 < 4000 && !bot.entity.onGround && !bot.entity.isInWater) await sleep(50)
  await sleep(600)
  await waterToHotbar(bot).catch(() => {})
  if (y0 - bot.entity.position.y < 2) return { ok: false, why: 'не спрыгнул — стою на столбе' }
  return { ok: true, fall: r1(fall), lost: r1(Math.max(0, hp0 - bot.health)) }
}

function onOwnPillar (bot) {
  const sup = supportCell(bot)
  if (!sup) return null
  let y = sup.y; let n = 0
  for (; y > sup.y - 40; y--) {
    const b = bot.blockAt(new Vec3(sup.x, y, sup.z))
    if (!b || !isSolid(b) || !FILLER_RE.test(b.name) || b.name === 'end_stone') break
    n++
  }
  if (n < 4) return null
  const g = bot.blockAt(new Vec3(sup.x, y, sup.z))
  if (!g || g.name !== 'end_stone') return null
  return { gy: y + 1, n }
}

function onSpike (bot) {
  const sup = supportCell(bot)
  if (!sup) return false
  const b = bot.blockAt(sup)
  if (!b || b.name !== 'obsidian') return false
  if (Math.hypot(sup.x + 0.5 - CENTER.x, sup.z + 0.5 - CENTER.z) < 30 || offIsland(bot, sup)) return false
  const g = surfaceY(bot, sup.x + 0.5 + Math.sign(CENTER.x - sup.x) * 7, sup.z + 0.5 + Math.sign(CENTER.z - sup.z) * 7, sup.y)
  return !g || sup.y + 1 - g.y > 5
}

async function getDown (session, ctl, stats) {
  const bot = session.bot
  doing(ctl, 'spike:down')
  const me = bot.entity.position
  const toC = { x: CENTER.x - me.x, z: CENTER.z - me.z }
  const dirs = Math.abs(toC.x) >= Math.abs(toC.z)
    ? [{ x: Math.sign(toC.x), z: 0 }, { x: 0, z: Math.sign(toC.z) || 1 }, { x: 0, z: -(Math.sign(toC.z) || 1) }]
    : [{ x: 0, z: Math.sign(toC.z) }, { x: Math.sign(toC.x) || 1, z: 0 }, { x: -(Math.sign(toC.x) || 1), z: 0 }]
  await waterToHotbar(bot)
  for (const dir of dirs) {
    if (ctl.aborted) break
    // К краю: крадучись по dir, пока следующая клетка — верхушка.
    bot.setControlState('sneak', true)
    for (let k = 0; k < 8; k++) {
      const p = bot.entity.position
      const nx = Math.floor(p.x) + dir.x; const nz = Math.floor(p.z) + dir.z
      if (!isSolid(bot.blockAt(new Vec3(nx, Math.floor(p.y + 0.01) - 1, nz)))) break
      await stepOnto(bot, ctl, nx, nz)
    }
    bot.setControlState('sneak', false)
    const spot = dropSpot(bot, dir)
    if (!spot) continue
    const water = bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')
    const fall = bot.entity.position.y - spot.landY
    if (!water && fall - 3 > bot.health - 4) continue
    if (ctl.trace) ctl.trace.ev('spikeDown', { fall: r1(fall), water })
    if (water) { const r = await dropOff(bot, ctl, stats, dir, 'обелиск'); if (r.ok) return true; continue }
    // Без ведра — шагом с края (урон падения — высота − 3).
    const yaw = Math.atan2(-(spot.x - bot.entity.position.x), -(spot.z - bot.entity.position.z))
    await bot.look(yaw, 0, true).catch(() => {})
    bot.setControlState('forward', true)
    const t0 = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t0 < 900 && bot.entity.onGround) await sleep(50)
    bot.setControlState('forward', false)
    const t1 = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t1 < 4000 && !bot.entity.onGround) await sleep(50)
    return true
  }
  return false
}

function towerUnsafe (bot) {
  const d = dragonOf(bot)
  if (!d) return null
  const ph = phaseOf(bot, d)
  const dist = d.position.distanceTo(bot.entity.position)
  if (SITTING.has(ph)) return 'дракон сидит — будет таран'
  if (ph === PHASE.CHARGING) return 'таран'
  if (ph === PHASE.STRAFE && dist < 70) return 'заходит с фаерболом'
  if (ph === PHASE.LANDING) return 'садится'
  return null
}

async function tidy (session, ctl, rep, stats) {
  const bot = session.bot
  if (bot.food < 17 || (bot.health < 14 && bot.food < 20)) {
    const r = await actions.eat(session, {}).catch(e => ({ note: e.message }))
    if (r && r.ate) stats.ate.push(r.ate)
  }
}

async function rangedShot (session, ctl, stats, track, d, hazardSoon) {
  const bot = session.bot
  if (countOf(bot, /arrow$/) < 1 || !findItem(bot, /^bow$/)) return false
  const eye = bot.entity.position.offset(0, EYE, 0)
  const dist = d.position.distanceTo(eye)
  if (dist > 48 || dist < 8) return false
  const v = track.vel()
  const parts = partsOf(bot, d, track)
  const toMe = { x: eye.x - d.position.x, z: eye.z - d.position.z }
  const len = Math.hypot(toMe.x, toMe.z) || 1
  // Голова, если летит на нас (она впереди тела), иначе тело.
  const headOn = (parts.dir.x * toMe.x + parts.dir.z * toMe.z) / len > 0.85
  const base = headOn ? parts.headC : parts.bodyC
  const off = base.minus(d.position)
  const point = (ticks) => {
    const tt = Math.min(ticks, 30)
    return new Vec3(d.position.x + off.x + v.x * tt, d.position.y + off.y + v.y * tt, d.position.z + off.z + v.z * tt)
  }
  const hp0 = hpOf(bot, d)
  const r = await bow.shoot(bot, d, { point, follow: false, mode: 'compensate', shouldStop: () => ctl.aborted || hazardSoon() || SITTING.has(phaseOf(bot, dragonOf(bot))) })
  if (!r.shot) return false
  stats.arrows++
  if (headOn) stats.headShots++
  // Попадание — по здоровью из метаданных, когда стрела долетит.
  gameClock.setTimeout(() => {
    const dd = dragonOf(bot)
    const hp = dd ? hpOf(bot, dd) : null
    if (hp0 != null && hp != null && hp < hp0) { stats.arrowHits++; stats.dmg += hp0 - hp }
  }, Math.min(2500, (r.flightTicks || 20) * 50 + 400))
  return true
}

async function runnerSupport (bot, plan, dy) {
  const why = w => { runnerSupport.why = w; return false }
  runnerSupport.why = null
  const pos = new Vec3(0, plan.P, plan.F.z), b = bot.blockAt(pos)
  if (!dy) {
    if (isAirish(b)) return true
    if (!b || b.name !== 'cobblestone') return why(`снять: там ${b && b.name}`)
    const eye = bot.entity.position.offset(0, EYE, 0)
    const hit = faceClick(bot, eye, pos, new Vec3(0, 0, Math.sign(plan.B.z)))
    const tool = findItem(bot, /^(iron|diamond|netherite)_pickaxe$/)
    if (!hit || !tool) return why(!hit ? 'снять: грань не видно' : 'нет кирки')
    await bot.equip(tool, 'hand')
    if (bot.digTime(b) > 650) return why(`снять: долго ${bot.digTime(b)}`)
    runnerAim(bot, hit.point)
    const stop = gameClock.setTimeout(() => bot.stopDigging(), 800)
    try { await bot.dig(b, true) } catch (e) { return why('снять: ' + e.message) } finally { gameClock.clearTimeout(stop) }
    return isAirish(bot.blockAt(pos)) || why('снять: осталась')
  }
  if (b && b.name === 'cobblestone') return true
  if (!isAirish(b)) return why(`поставить: там ${b && b.name}`)
  const low = plan.runnerLevels[0], K = new Vec3(low.place.K.x, plan.P, low.place.K.z)
  const hit = faceClick(bot, bot.entity.position.offset(0, EYE, 0), K, low.place.face)
  const item = findItem(bot, /^cobblestone$/)
  if (!hit || !item) return why(!hit ? 'поставить: грань K0 не видно' : 'нет булыжника')
  await bot.equip(item, 'hand'); runnerAim(bot, hit.point)
  const pc = hit.point.minus(K)
  bot._client.write('block_place', { location: K, direction: FACE_IDX(low.place.face), hand: 0,
    cursorX: pc.x, cursorY: pc.y, cursorZ: pc.z, insideBlock: false, sequence: 0, worldBorderHit: false })
  const end = gameClock.now() + 400
  while (gameClock.now() < end && (bot.blockAt(pos) || {}).name !== 'cobblestone') await sleep(20)
  if ((bot.blockAt(pos) || {}).name === 'cobblestone') return true
  const dd = dragonOf(bot)
  return why(`поставить: не встал${dd ? ` (тело ${r1(dd.position.x)},${r1(dd.position.y)},${r1(dd.position.z)})` : ''}`)
}
declare namespace runnerSupport {
  let why: any
}

function standFor (bot, cell, world) {
  const vb = virtualBot(bot, world)
  const clouds = cloudsOf(bot)
  const cands = []
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const x = cell.x + dx; const z = cell.z + dz
      if (x === 0 && z === 0) continue
      const s = surfaceY(vb, x + 0.5, z + 0.5, cell.y + 4)
      if (!s) continue
      const feet = new Vec3(x + 0.5, s.y, z + 0.5)
      if (Math.abs(feet.y - cell.y) > 4) continue
      if (clouds.some(c => cloudHits(c, feet, 1.2))) continue
      if (Math.floor(feet.x) === cell.x && Math.floor(feet.z) === cell.z && feet.y <= cell.y + 1.8 && feet.y + 1.8 > cell.y) continue
      const eye = feet.offset(0, SNEAK_EYE, 0)
      if (!fillPlaceable(vb, new Vec3(cell.x, cell.y, cell.z), eye, { robust: true })) continue
      cands.push({ feet, d: feet.distanceTo(bot.entity.position) })
    }
  }
  cands.sort((a, b) => a.d - b.d)
  standFor.all = cands
  return cands[0] || null
}
declare namespace standFor {
  let all: any[]
}

function pillarHere (bot, plan) {
  const q = bot.entity.position
  const runner = runnerOn() && plan.runner
  if (runner && Math.abs(q.y - plan.feet.y) > 0.3) return null
  if (runner ? Math.hypot(q.x - plan.feet.x, q.z - plan.feet.z) > 0.35 || !bot.entity.onGround : Math.floor(q.x) !== plan.B.x || Math.floor(q.z) !== plan.B.z || !bot.entity.onGround) return null
  const P = plan.P ?? plan.yb + 1
  const torchSet = new Set(pillarCells(P).torches.map(t => `${t.x},${t.y},${t.z}`))
  const torchHit = (eye, d, len) => { if (runner) return false; for (let t = 0; t < len; t += 0.1) { const r = eye.plus(d.scaled(t)); if (torchSet.has(`${Math.floor(r.x)},${Math.floor(r.y)},${Math.floor(r.z)}`)) return true } return false }
  const eye = q.offset(0, EYE, 0)
  const fcl = faceClick(bot, eye, new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z), plan.place.face, { avoidTorch: torchHit })
  if (!fcl) return null
  const dom = Math.abs(fcl.dir.x) >= Math.abs(fcl.dir.z) ? { x: Math.sign(fcl.dir.x), z: 0 } : { x: 0, z: Math.sign(fcl.dir.z) }
  if (dom.x !== plan.a.x || dom.z !== plan.a.z) return null
  const wB = new Map([[`${plan.F.x},${plan.yb},${plan.F.z}`, 'bed'], [`${plan.H.x},${plan.yb},${plan.H.z}`, 'bed']])
  if (!faceClick(virtualBot(bot, wB), eye, new Vec3(plan.click.cell.x, plan.yb, plan.click.cell.z), new Vec3(plan.click.face.x, plan.click.face.y, plan.click.face.z), { avoidTorch: torchHit })) return null
  const feet = runner && plan.feet ? plan.feet : new Vec3(plan.B.x + 0.5, Math.floor(q.y + 0.01), plan.B.z + 0.5)
  const expo = exposure(bot, feet, plan.centre)
  if (expo > 0.04) return null
  return { feet, expo }
}

async function pillarPlanAutoAsync (bot, P, bad = null) {
  const obsHave = countOf(bot, /^(obsidian|crying_obsidian)$/)
  for (const dy of pillowDys()) {
    const all = []; const why = {}
    for (const Hc of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
      for (const a of DIRS4) {
        pillarPlan(bot, P, { dy, pillow: Hc, aOnly: a })
        all.push(...(pillarPlan.all || []))
        for (const [k, v] of (Object.entries(pillarPlan.why || {}) as [string, any][])) why[k] = (why[k] || 0) + v
        await new Promise<any>(resolve => setImmediate(resolve))
      }
    }
    all.sort((p, q) => p.cost - q.cost)
    pillarPlan.all = all; pillarPlan.why = why
    const ok = all.filter(q => q.nObs <= obsHave && !(bad && (bad.get(pillarKey(q)) || 0) >= 2))
    if (ok.length) return ok[0]
  }
  return null
}

const SM_EMPTY = []

const SM_FULL = [[0, 0, 0, 1, 1, 1]]

const smAxes = new Map()

function smAxis (size) {
  if (smAxes.has(size)) return smAxes.get(size)
  const step = 1 / (2 * size + 1), out: any = []
  for (let a = 0; a <= 1; a += step) out.push(a * size)
  out.offset = (1 - Math.floor(1 / step) * step) / 2
  smAxes.set(size, out)
  return out
}

function smShapes (b) {
  if (!b || /^(air|cave_air|void_air|fire|soul_fire|end_portal|water|lava|.*torch)$/.test(b.name)) return SM_EMPTY
  if (b.shapes) return b.shapes
  return SM_FULL
}

function smRayHit (p, c, b) {
  let lo = 0, hi = 1, len2 = 0, inside = true
  for (let a = 0; a < 3; a++) {
    const d = c[a] - p[a], probe = p[a] + d * 0.001
    len2 += d * d
    if (probe < b[a] || probe >= b[a + 3]) inside = false
    if (Math.abs(d) < 1e-7) { if (p[a] < b[a] || p[a] > b[a + 3]) return false; continue }
    const t0 = (b[a] - p[a]) / d, t1 = (b[a + 3] - p[a]) / d
    lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1))
    if (lo > hi) return false
  }
  return len2 >= 1e-7 && (inside || (lo > 0 && lo < 1 && hi >= lo))
}

function smCompile (bot, bounds, skip = null) {
  const colliders = []
  for (let x = Math.floor(bounds[0]); x <= Math.floor(bounds[3]); x++) {
    for (let y = Math.floor(bounds[1]); y <= Math.floor(bounds[4]); y++) {
      for (let z = Math.floor(bounds[2]); z <= Math.floor(bounds[5]); z++) {
        if (skip && skip(x, y, z)) continue
        for (const sh of smShapes(bot.blockAt(new Vec3(x, y, z)))) colliders.push([x + sh[0], y + sh[1], z + sh[2], x + sh[3], y + sh[4], z + sh[5]])
      }
    }
  }
  return { colliders, bounds: bounds.slice() }
}

function smSeenBox (snap, c, box, extra = SM_EMPTY) {
  const bounds = [Math.min(c[0], box[0]), Math.min(c[1], box[1]), Math.min(c[2], box[2]), Math.max(c[0], box[3]), Math.max(c[1], box[4]), Math.max(c[2], box[5])]
  const xs = smAxis(box[3] - box[0]), ys = smAxis(box[4] - box[1]), zs = smAxis(box[5] - box[2])
  const nx = xs.length, total = nx * ys.length * zs.length
  let blocked = 0
  const relevant = snap.colliders.concat(extra).filter(b => b[3] >= bounds[0] && b[4] >= bounds[1] && b[5] >= bounds[2] && b[0] <= bounds[3] && b[1] <= bounds[4] && b[2] <= bounds[5])
  const intervals = []
  for (const sy of ys) for (const sz of zs) {
    const y = box[1] + sy, z = box[2] + sz + zs.offset
    intervals.length = 0
    for (const b of relevant) {
      let lo = 0, hi = 1
      for (let a = 1; a <= 2; a++) {
        const d = (a === 1 ? y : z) - c[a]
        if (Math.abs(d) < 1e-7) { if (c[a] < b[a] || c[a] > b[a + 3]) hi = -1; continue }
        const t0 = (b[a] - c[a]) / d, t1 = (b[a + 3] - c[a]) / d
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1))
      }
      if (hi < lo || hi <= 0) continue
      const a0 = b[0] - c[0], d0 = b[3] - c[0]
      const xmin = c[0] + Math.min(a0 / hi, lo > 0 ? a0 / lo : a0 < 0 ? -Infinity : a0 === 0 ? 0 : Infinity)
      const xmax = c[0] + Math.max(d0 / hi, lo > 0 ? d0 / lo : d0 > 0 ? Infinity : d0 === 0 ? 0 : -Infinity)
      let first = -1, last = -1
      for (let i = 0; i < nx; i++) {
        const x = box[0] + xs[i] + xs.offset
        if (x < xmin - 1e-7 || x > xmax + 1e-7) continue
        if (smRayHit([x, y, z], c, b)) { if (first < 0) first = i; last = i }
      }
      if (first >= 0) intervals.push([first, last])
    }
    intervals.sort((p, q) => p[0] - q[0])
    let end = -1
    for (const [start, stop] of intervals) if (stop > end) { blocked += stop - Math.max(start, end + 1) + 1; end = stop }
  }
  return Math.fround((total - blocked) / total)
}

function smDragonSeen (snap, centre, body, extra = SM_EMPTY) {
  const b = snap.bounds
  if (body.x - 8 < b[0] || body.z - 8 < b[2] || body.x + 8 > b[3] + 1 || body.z + 8 > b[5] + 1 || body.y < b[1] || body.y + 8 > b[4] + 1) return null
  return smSeenBox(snap, [centre.x, centre.y, centre.z], [body.x - 8, body.y, body.z - 8, body.x + 8, body.y + 8, body.z + 8], extra)
}

function bodyBlocksBed (pos, F, yb, m = envNum('ND_RUN_BOX_M', 0)) {
  return !!pos && Math.abs(pos.x - (F.x + 0.5)) < 8.5 + m && Math.abs(pos.z - (F.z + 0.5)) < 8.5 + m && pos.y < yb + 0.5625 + m && pos.y + 8 > yb - m
}

async function runnerGapArrow (session, ctl, feed, P, { minHit, maxHit, deadline }: any) {
  const bot = session.bot
  const bow = findItem(bot, /^bow$/)
  if (!bow || countOf(bot, /arrow$/) < 1) return { why: 'нет лука или стрел' }
  const out: any = {}
  try { await bot.equip(bow, 'hand') } catch (e) { return { why: 'лук: ' + e.message } }
  const charge = (require('../bow') as typeof import('../bow')).observeCharge(bot)
  if (!charge.start()) { charge.close(); return { why: charge.why(), fullChargeConfirmed: false } }
  const tDraw = gameClock.now()
  try {
    while (!ctl.aborted && gameClock.now() < deadline) {
      if (charge.why()) { out.why = charge.why(); return out }
      const dd = dragonOf(bot)
      if (!dd || phaseOf(bot, dd) !== PHASE.LANDING) { out.why = 'фаза'; return out }
      const fc = landingForecast(feed, P)
      if (!fc) { await Promise.race([sleep(20), charge.cancelled]); continue }
      const eye = bot.entity.position.offset(0, EYE, 0)
      const nowTick = Math.round((gameClock.now() - fc.t) / 50)
      let best = null
      for (let k = nowTick + 1; k < Math.min(fc.path.length, nowTick + 30, (fc.n || fc.path.length) - 3); k++) {
        const tHit = fc.t + 50 * k
        if (tHit < minHit || tHit > maxHit) continue
        const hc = fc.path[k].head.offset(0, 0.5, 0)
        const d = hc.distanceTo(eye)
        if (d < 1.5 || d > 12) continue
        const travel = Math.max(1, Math.ceil(d / 2.9))
        if (k - travel < nowTick) continue
        const dir = hc.minus(eye).scaled(1 / d)
        if (pick.blockOnRay(bot, eye, dir, d - 0.55)) continue
        if (!best || d < best.d) best = { k, d, hc, travel }
      }
      const drawn = gameClock.now() - tDraw >= 1000 && charge.ready()
      if (best && drawn && best.k - best.travel <= nowTick) {
        const hpB = hpOf(bot, dd)
        // падение стрелы за полёт (гравитация 0.05/тик): цель чуть выше
        runnerAim(bot, best.hc.offset(0, 0.025 * best.travel * best.travel, 0))
        if (!charge.ready()) continue
        bot.deactivateItem()
        charge.close()
        out.shot = { d: r1(best.d), ahead: best.k - nowTick, drawMs: gameClock.now() - tDraw, hp: hpB != null ? r1(hpB) : null, fullChargeConfirmed: true, nativeCharge: charge.snapshot() }
        await sleep(250)
        const d2 = dragonOf(bot); out.hpAfter = d2 ? r1(hpOf(bot, d2) ?? -1) : 0
        return out
      }
      if (best) await lookAtSafe(bot, best.hc); else { const pc = partsOf(bot, dd, makeTrack(bot)); if (pc && pc.headC) await lookAtSafe(bot, pc.headC) }
      await Promise.race([sleep(20), charge.cancelled])
    }
    out.why = 'нет окна'
    return out
  } finally {
    // без выстрела — снять натяжение сменой предмета (deactivateItem выстрелил бы)
    if (out.shot) charge.close()
    else { charge.cancel(); const bi = findItem(bot, /_bed$/); if (bi) await bot.equip(bi, 'hand').catch(() => {}) }
    if (ctl.trace) ctl.trace.ev('gapArrow', out)
  }
}

async function runnerArrow (session, ctl, feed, P, lastBoom) {
  const bot = session.bot
  const bow = findItem(bot, /^bow$/)
  if (!bow || countOf(bot, /arrow$/) < 1) return { why: 'нет лука или стрел' }
  const out: any = {}
  try { await bot.equip(bow, 'hand') } catch (e) { return { why: 'лук: ' + e.message } }
  const charge = (require('../bow') as typeof import('../bow')).observeCharge(bot)
  if (!charge.start()) { charge.close(); return { why: charge.why(), fullChargeConfirmed: false } }
  const tDraw = gameClock.now()
  const hp0 = (() => { const dd = dragonOf(bot); return dd ? hpOf(bot, dd) : null })()
  try {
    while (!ctl.aborted && gameClock.now() - tDraw < 6000) {
      if (charge.why()) { out.why = charge.why(); return out }
      const dd = dragonOf(bot)
      if (!dd) { out.why = 'дракона нет'; return out }
      const ph = phaseOf(bot, dd)
      if (ph !== PHASE.LANDING) { out.why = `фаза ${PHASE_RU[ph] ?? ph}`; return out }
      if ((hpOf(bot, dd) ?? 1) <= 0) { out.why = 'убит'; return out }
      if (bot.health < 8) { out.why = 'мало хп'; return out }
      const fc = landingForecast(feed, P)
      const eye = bot.entity.position.offset(0, EYE, 0)
      if (!fc) { await Promise.race([sleep(25), charge.cancelled]); continue }
      const nowTick = Math.round((gameClock.now() - fc.t) / 50)
      const minTick = Math.max(nowTick + 1, Math.ceil(((lastBoom || 0) + 560 - fc.t) / 50))
      let best = null
      // стрела должна застать голову до посадки: сидячему стрелы — 0 (rs4: 3 выстрела в последний тик снижения — мимо урона)
      for (let k = minTick; k < Math.min(fc.path.length, nowTick + 40, (fc.n || fc.path.length) - 3); k++) {
        const hc = fc.path[k].head.offset(0, 0.5, 0)
        const d = hc.distanceTo(eye)
        if (d > 9 || d < 1) continue
        const dir = hc.minus(eye).scaled(1 / d)
        if (pick.blockOnRay(bot, eye, dir, d - 0.55)) continue
        if (!best || d < best.d) best = { k, d, hc }
      }
      if (!best) { const pc = partsOf(bot, dd, makeTrack(bot)); if (pc && pc.headC) await lookAtSafe(bot, pc.headC); await Promise.race([sleep(25), charge.cancelled]); continue }
      const travel = Math.max(1, Math.round(best.d / 2.9))
      const drawn = gameClock.now() - tDraw >= 1050 && charge.ready()
      if (drawn && best.k - travel <= nowTick) {
        runnerAim(bot, best.hc)
        if (!charge.ready()) continue
        bot.deactivateItem()
        charge.close()
        out.shot = { d: r1(best.d), ahead: best.k - nowTick, drawMs: gameClock.now() - tDraw, hp: hp0 != null ? r1(hp0) : null, fullChargeConfirmed: true, nativeCharge: charge.snapshot() }
        await sleep(400)
        const d2 = dragonOf(bot); out.hpAfter = d2 ? r1(hpOf(bot, d2) ?? -1) : 0
        return out
      }
      await lookAtSafe(bot, best.hc)
      await Promise.race([sleep(20), charge.cancelled])
    }
    out.why = 'прохода нет'
    return out
  } finally {
    if (out.shot) charge.close(); else charge.cancel()
    if (ctl.trace) ctl.trace.ev('runnerArrow', out)
  }
}

const ST_N = { H: 7, F: 8, W1: 9, W2: 10, B: 11 }

function stationCell (a, n, l) {
  const px = -a.z; const pz = a.x
  return { x: Math.floor(CENTER.x + a.x * n + px * l), z: Math.floor(CENTER.z + a.z * n + pz * l) }
}

function groundAt (bot, x, z, nearY) {
  return standY(bot, x + 0.5, z + 0.5, nearY, 3, 5)
}

function stationPlan (bot, a) {
  const podium = surfaceY(bot, CENTER.x, CENTER.z)
  if (!podium) return { ok: false, why: 'верх фонтана не виден' }
  // Кровать — на P−3, не P−2: садясь, дракон проходит ниже конечной высоты,
  const yb = podium.y - 3
  const cell = (n, l = 0) => stationCell(a, n, l)
  const B = cell(ST_N.B)
  const g = groundAt(bot, B.x, B.z, yb - 2)
  if (g == null) return { ok: false, why: 'под местом стоянки нет земли' }
  if (yb - g < 1 || yb - g > 3) return { ok: false, why: `земля у станции на ${g}, кровать на ${yb}` }
  const place = []
  const bad = []
  const want = (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) { bad.push('не прогружено'); return }
    if (isSolid(b)) return
    if (/portal|gateway/.test(b.name)) { bad.push(b.name); return }
    place.push(new Vec3(x, y, z))
  }
  const air = (x, y, z, bedOk = false) => {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) { bad.push('не прогружено'); return false }
    if (bedOk && /_bed$/.test(b.name)) return true
    return !isSolid(b) && !/portal|gateway|lava/.test(b.name)
  }
  // Что ставить — поменьше (e2e5: 128 блоков кончились — мост ~40, два столба
  const rows = [[ST_N.F, [0]], [ST_N.W1, [-1, 0, 1]], [ST_N.W2, [0]], [ST_N.B, [0]]]
  for (const [n, ls] of (rows as any)) {
    for (const l of ls) {
      const c = cell(n, l)
      if (voidBelow(bot, c.x + 0.5, g, c.z + 0.5, 6)) { bad.push(`пустота под ${c.x},${c.z}`); continue }
      want(c.x, g - 1, c.z)
    }
  }
  // Стенки W1 (три) и W2 (середина) — два блока от земли; F — опора до yb−1.
  for (const [n, ls] of (rows.slice(0, 3) as any)) {
    for (const l of ls) {
      const c = cell(n, l)
      const top = n === ST_N.F ? yb - 1 : g + 1
      for (let y = g; y <= top; y++) want(c.x, y, c.z)
    }
  }
  const H = cell(ST_N.H); const F = cell(ST_N.F)
  if (!air(B.x, g, B.z) || !air(B.x, g + 1, B.z)) bad.push('на месте стоянки блок')
  if (!air(H.x, yb, H.z, true)) bad.push('в клетке изголовья блок')
  if (!air(F.x, yb, F.z, true)) bad.push('в клетке изножья блок')
  if (bad.length) return { ok: false, why: bad[0] }
  return {
    ok: true,
    key: `${a.x},${a.z}`,
    a,
    yb,
    g,
    podium: podium.y,
    B: new Vec3(B.x + 0.5, g, B.z + 0.5),
    H: new Vec3(H.x, yb, H.z),
    F: new Vec3(F.x, yb, F.z),
    support: new Vec3(F.x, yb - 1, F.z),
    blast: new Vec3(H.x + 0.5, yb + 0.5, H.z + 0.5),
    place
  }
}

function chooseStation (bot, fails = new Map()) {
  const me = bot.entity.position
  const clouds = cloudsOf(bot)
  let best = null
  const why = {}
  for (const a of AXES) {
    const st = stationPlan(bot, a)
    if (!st.ok) { why[`${a.x},${a.z}`] = st.why; continue }
    if (inClouds(clouds, st.B, 1.5)) { why[st.key] = 'облако'; continue }
    const cost = st.place.length * 0.6 + st.B.distanceTo(me) * 0.3 + (fails.get(st.key) || 0) * 12
    if (!best || cost < best.cost) best = { ...st, cost }
  }
  if (!best) chooseStation.why = why
  return best
}
declare namespace chooseStation {
  let why: any
}

function bedHere (bot, st) {
  const f = bot.blockAt(st.F); const h = bot.blockAt(st.H)
  return !!(f && /_bed$/.test(f.name) && h && /_bed$/.test(h.name))
}

async function stationPlaceBed (bot, st) {
  const bed = findItem(bot, /_bed$/)
  if (!bed) return { ok: false, why: 'кроватей нет' }
  const ref = bot.blockAt(st.support)
  if (!ref || !isSolid(ref)) return { ok: false, why: 'опоры изножья нет' }
  try {
    await bot.equip(bed, 'hand')
    // Смотреть вдоль оси к изголовью: оно ляжет туда, куда смотрим
    await bot.lookAt(st.support.offset(0.5, 1, 0.5), true)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    await build.withTimeout(bot.placeBlock(ref, new Vec3(0, 1, 0)), 2000)
  } catch (e) { dbg('station bed', e.message) }
  await sleep(50)
  return bedHere(bot, st) ? { ok: true } : { ok: false, why: `кровать не встала (${(bot.blockAt(st.H) || {}).name}/${(bot.blockAt(st.F) || {}).name})` }
}

async function stationBlow (session, ctl, st, stats, d, track, why) {
  const bot = session.bot
  const f = bot.blockAt(st.F)
  if (!f || !/_bed$/.test(f.name)) return false
  const w = items.bestWeapon(bot)
  if (w && (!bot.heldItem || /_bed$/.test(bot.heldItem.name))) await bot.equip(w, 'hand').catch(() => {})
  const ph = phaseOf(bot, d)
  const head = headPoint(bot, d, track, 0)
  const dist = head.distanceTo(st.blast)
  const before = hpOf(bot, d)
  const me0 = bot.health
  doing(ctl, `bed:${why}`)
  if (ctl.trace) ctl.trace.ev('bed', { ph, why, dist: r1(dist), expect: bedDamage(dist), dragonHp: before, me: me0 })
  // Свидетель взрыва — урон по дракону с причиной «кровать» (damage_event,
  // bad_respawn_point), а не пропажа кровати: её сносит и сам дракон.
  let boom = false
  const onDmg = pk => { if (pk && (pk.entityId === d.id || pk.entityId === bot.entity.id) && DAMAGE_TYPES[pk.sourceTypeId] === 'bad_respawn_point') boom = true }
  bot._client.on('damage_event', onDmg)
  try { await bot.activateBlock(f, new Vec3(0, 1, 0), new Vec3(0.5, 0.56, 0.5)) } catch (e) { dbg('bed use', e.message) }
  const tb = gameClock.now()
  while (!boom && gameClock.now() - tb < 600) await sleep(50)
  bot._client.removeListener('damage_event', onDmg)
  await sleep(100)
  const gone = !bot.blockAt(st.F) || !/_bed$/.test(bot.blockAt(st.F).name)
  if (!gone) return false
  const dd = dragonOf(bot)
  const after = dd ? hpOf(bot, dd) : 0
  const dmg = before != null && after != null ? Math.max(0, before - after) : null
  if (!boom && !(dmg > 0)) {
    stats.bedsLost = (stats.bedsLost || 0) + 1
    if (ctl.trace) ctl.trace.ev('bedLost', { ph, dist: r1(dist) })
    return false
  }
  stats.bedsUsed = (stats.bedsUsed || 0) + 1
  if (dmg) stats.dmg += dmg
  const rec = { ph: PHASE_RU[ph] ?? ph, why, dist: r1(dist), dmg: dmg != null ? Math.round(dmg) : null, self: r1(Math.max(0, me0 - bot.health)) }
  stats.beds.push(rec)
  if (ctl.trace) ctl.trace.ev('bedDone', rec)
  dbg('station bed', JSON.stringify(rec))
  return true
}

function dynamicPlace (bot, st) {
  const D = st.a
  const B = { x: Math.floor(st.B.x), z: Math.floor(st.B.z) }
  const W = { x: st.H.x + 2 * D.x, z: st.H.z + 2 * D.z }
  const W2 = { x: st.H.x + 3 * D.x, z: st.H.z + 3 * D.z }
  const F = { x: st.F.x, z: st.F.z }
  const g = st.g
  const place = []
  const want = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); if (b && !isSolid(b)) place.push(new Vec3(x, y, z)) }
  for (const c of [B, W, W2, F]) if (!voidBelow(bot, c.x + 0.5, g, c.z + 0.5, 6)) want(c.x, g - 1, c.z)
  for (let y = g; y <= st.yb - 1; y++) want(F.x, y, F.z)
  for (const c of [W, W2]) for (let y = g; y <= g + 1; y++) want(c.x, y, c.z)
  return place
}

export {
  waterToHotbar, stepOnto, CRYS_BAND, crysAlive, dropSpot, dropOff, onOwnPillar, onSpike, getDown, towerUnsafe,
  tidy, rangedShot, runnerSupport, standFor, pillarHere,
  pillarPlanAutoAsync, SM_EMPTY, SM_FULL, smAxes, smAxis, smShapes, smRayHit, smCompile, smSeenBox, smDragonSeen,
  bodyBlocksBed, runnerGapArrow, runnerArrow, ST_N, stationCell, groundAt, stationPlan,
  chooseStation, bedHere, stationPlaceBed, stationBlow, dynamicPlace
}
