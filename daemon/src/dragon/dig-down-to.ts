
const gameClock = require('.././game-clock')

const Vec3 = require('vec3')

const { Movements, goals } = require('mineflayer-pathfinder')

const { sleep } = require('.././movement')

const bow = require('.././bow')

const build = require('.././build')

const threats = require('.././threats')

const pvp = require('.././pvp')

const items = require('.././items')

const armor = require('.././armor')

const actions = require('.././actions')

const pick = require('.././pick')

const pearlHop = require('.././pearl-hop')

const DEBUG = !!process.env.ND_DEBUG_DRAGON

const yieldTick = () => new Promise<any>(resolve => setImmediate(resolve))

const dbg = (...a: any[]) => { if (DEBUG) console.log(`[dragon ${new Date().toISOString().slice(11, 19)}]`, ...a) }

const PHASE = { HOLDING: 0, STRAFE: 1, APPROACH: 2, LANDING: 3, TAKEOFF: 4, FLAMING: 5, SCANNING: 6, ROARING: 7, CHARGING: 8, DYING: 9, HOVER: 10 }

const PHASE_RU = ['кружит', 'заходит на игрока с фаерболом', 'заходит на посадку', 'садится', 'взлетает',
  'сидит и дышит огнём', 'сидит, высматривает', 'сидит, ревёт', 'таранит', 'умирает', 'висит']

const SITTING = new Set([PHASE.FLAMING, PHASE.SCANNING, PHASE.ROARING])

const PILLOW_DY = process.env.ND_PILLOW_DY != null ? Number(process.env.ND_PILLOW_DY) : 0

const TOWER_FAR = Number(process.env.ND_TOWER_FAR ?? 40)

const RUN_TOWER1 = () => envv('ND_RUN_TOWER1') !== '0'

const RUN_FACING = () => envv('ND_RUN_FACING') !== '0'

const RUN_ARROW = () => envv('ND_RUN_ARROW') === '1'

const RUN_HIGH = () => envv('ND_RUN_HIGH') === '1'

const RUN_MELEE = () => envv('ND_RUN_MELEE') === '1'

const RUN_BOX = () => envv('ND_RUN_BOX') !== '0'

const RUN_SEEN = () => envv('ND_RUN_SEEN') !== '0'

const RUN_GAPARROW = () => envv('ND_RUN_GAPARROW') === '1'

const RUN_KEEPCOB = () => envv('ND_RUN_KEEPCOB') !== '0'

const RUN_TICKSEEN = () => envv('ND_RUN_TICKSEEN') !== '0'

const RUN_LATEHEAD = () => envv('ND_RUN_LATEHEAD') !== '0'

function pillarTriesMax () { return runnerOn() ? envNum('ND_RUN_TRIES', 25) : 10 }

const KEEP_ON = process.env.ND_KEEP_BEDS !== '0'

const KEEP_N = Number(process.env.ND_KEEP_N ?? 7)

const FIRST_MAX = Number(process.env.ND_FIRST_MAX ?? 4.0)

const BUILD_MAX_MS = Number(process.env.ND_BUILD_MAX_MS ?? 0)

const PLACE_LEAD = Number(process.env.ND_PLACE_LEAD ?? 6)

const PILLAR_BAD = process.env.ND_PILLAR_BAD === '1'

const HEAD_ROOM = Number(process.env.ND_PILLAR_HEADROOM ?? 2.6)

const LABENV = {}

function envv (k) { return Object.prototype.hasOwnProperty.call(LABENV, k) ? LABENV[k] : process.env[k] }

function runnerOn () { return envv('ND_RUNNER') !== '0' }

function envNum (k, d) { const v = envv(k); return v != null && v !== '' ? Number(v) : d }

const HEAD_AHEAD = 6.5

const HURT_PAD = 1.5

const NECK_AHEAD = 5.5

const SIT_HEAD_DY = -1

const PART = { head: 1, neck: 2, body: 3 }

const SIT_TAKEOFF = 50

const CRYSTAL_BLAST = 12

const SAFE_FROM_CRYSTAL = 12.8

const BREATH_R = 5

const BREATH_AHEAD = 2.5

const FIREBALL_SNAP = 4

const CLOUD_SLAB = 0.5

const STARE_TOL = 0.025

const STARE_MARGIN = 3

const ENDERMAN_EYE = 2.55

const MELEE_REACH = 2.9

const EYE = 1.62

const CENTER = { x: 0.5, z: 0.5 }

function holdingOdds (alive, feet, podium) {
  const distanceBound = Math.floor(feet.distanceSquared(podium) / 512 + 2)
  const perch = 1 / (alive + 3)
  const strafeGivenNoPerch = 1 / distanceBound + (1 - 1 / distanceBound) / (alive + 2)
  return { distanceBound, perch, strafeGivenNoPerch, strafe: (1 - perch) * strafeGivenNoPerch }
}

function dragonWaitBand ({ station, crystalActive, holdOut, ph }: any) {
  if (envv('ND_WAIT_BUCKET') !== '1' || !station || crystalActive || holdOut ||
      ![PHASE.HOLDING, PHASE.STRAFE, PHASE.CHARGING].includes(ph)) return null
  // Прежний допуск кольца -0.7: даже его внутренний край должен иметь горизонтальный d² >= 512.
  // 0.1 — запас координат; максимальный радиус менее 27, чтобы не удлинять вход как ND_WAIT_FAR.
  return [Math.sqrt(512) + 0.7 + 0.1, 25.5]
}

function dragonWaitStop (ph) {
  return [PHASE.HOLDING, PHASE.STRAFE, PHASE.CHARGING].includes(ph) ? null : 'окно посадки'
}

const KIT = { arrows: 32, blocks: 64, food: 6 }

const BEDS_KIT = 12

const FILLER_RE = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|end_stone|oak_planks|spruce_planks|birch_planks)$/

function metaOf (bot, e, key) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys.indexOf(key)
    return i >= 0 && e.metadata ? e.metadata[i] : undefined
  } catch { return undefined }
}

function dragonOf (bot) {
  let best = null
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (e && e.name === 'ender_dragon' && e.position && e.isValid !== false) best = e
  }
  return best
}

function phaseOf (bot, d) { const v = d && metaOf(bot, d, 'phase'); return typeof v === 'number' ? v : null }

function hpOf (bot, d) { const v = d && metaOf(bot, d, 'health'); return typeof v === 'number' ? v : null }

function headDir (d) { return { x: Math.sin(d.yaw), z: Math.cos(d.yaw) } }

function makeTrack (bot) {
  const hist = []
  let id = null
  return {
    tick () {
      const d = dragonOf(bot)
      if (!d) { hist.length = 0; id = null; return null }
      if (d.id !== id) { hist.length = 0; id = d.id }
      const p = d.position
      hist.push({ x: p.x, y: p.y, z: p.z, t: gameClock.now() })
      if (hist.length > 80) hist.shift()
      return d
    },
    // Средняя скорость за ~0.5 с, блоки за тик.
    vel () {
      if (hist.length < 2) return { x: 0, y: 0, z: 0 }
      const b = hist[hist.length - 1]
      let a = hist[0]
      for (let i = hist.length - 1; i >= 0; i--) { if (b.t - hist[i].t >= 500) { a = hist[i]; break } }
      const dt = (b.t - a.t) / 50
      if (dt < 0.5) return { x: 0, y: 0, z: 0 }
      return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt }
    },
    yAgo (ticks) {
      if (!hist.length) return null
      const want = gameClock.now() - ticks * 50
      for (let i = hist.length - 1; i >= 0; i--) if (hist[i].t <= want) return hist[i].y
      return null
    }
  }
}

function box (cx, y, cz, half, height) {
  return { min: new Vec3(cx - half, y, cz - half), max: new Vec3(cx + half, y + height, cz + half) }
}

function inflate (b, r) {
  return { min: b.min.offset(-r, -r, -r), max: b.max.offset(r, r, r) }
}

function boxDist (p, b) {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x)
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y)
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z)
  return Math.hypot(dx, dy, dz)
}

function overlap (a, b) {
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y && a.min.z < b.max.z && a.max.z > b.min.z
}

function playerBox (feet) { return box(feet.x, feet.y, feet.z, 0.3, 1.8) }

function partsOf (bot, d, track, predict = null) {
  const sit = predict ? true : SITTING.has(phaseOf(bot, d))
  let dir = headDir(d)
  // Сидя голова отстаёт от yaw на замороженный yRotA·0.01 рад (tickPart головы) —
  // угол из прогноза посадки, пока yaw тот же (видящий, повернувшись, почти не отстаёт).
  if (sit && !predict) {
    const f = sitFix.get(d.id)
    if (f && Math.abs(Math.atan2(Math.sin(d.yaw - f.yaw), Math.cos(d.yaw - f.yaw))) < 0.03) { const a = d.yaw + f.yRotA * 0.01; dir = { x: Math.sin(a), z: Math.cos(a) } }
  }
  let c = 1; let s = 0; let off = SIT_HEAD_DY
  if (!sit) {
    off = 0
    if (track) {
      const y5 = track.yAgo(5); const y10 = track.yAgo(10)
      if (y5 != null && y10 != null) { const p = (y5 - y10) * 10 * Math.PI / 180; c = Math.cos(p); s = Math.sin(p) }
      if (y5 != null) off = y5 - d.position.y
    }
  }
  const P = predict ? predict.pos : d.position
  const hx = P.x + dir.x * HEAD_AHEAD * c; const hz = P.z + dir.z * HEAD_AHEAD * c
  const nx = P.x + dir.x * NECK_AHEAD * c; const nz = P.z + dir.z * NECK_AHEAD * c
  const head = box(hx, P.y + off + s * HEAD_AHEAD, hz, 0.5, 1)
  const neck = box(nx, P.y + off + s * NECK_AHEAD, nz, 1.5, 3)
  const body = box(P.x + dir.x * 0.5, P.y, P.z + dir.z * 0.5, 2.5, 3)
  const center = b => b.min.plus(b.max).scaled(0.5)
  return { sit, dir, pos: P, head, neck, body, headC: center(head), bodyC: center(body) }
}

function isSolid (b) { return !!b && b.boundingBox === 'block' }

function isAirish (b) { return !!b && b.boundingBox === 'empty' && !/lava|water|fire|portal/.test(b.name) }

// Описание блока по номеру состояния (750 TPS, s5 06.10): bot.blockAt строит объект Block на каждую клетку
// (prismarine-block fromStateId) — в сканах колонок (края, поверхность, кольца pickSpot, цена шага A*) это главное время
// демона в бою; на 750 тиках/с каждая мс — тик без реакции. Имя и форма — из реестра; null — чанк не загружен (как blockAt).
const defPos = new Vec3(0, 0, 0)
function blockDef (bot, x, y, z) {
  const w = bot.world; const reg = bot.registry && bot.registry.blocksByStateId
  if (!w || typeof w.getColumnAt !== 'function' || typeof w.getBlockStateId !== 'function' || !reg) return bot.blockAt(new Vec3(x, y, z))
  defPos.x = x; defPos.y = y; defPos.z = z
  if (!w.getColumnAt(defPos)) return null
  return reg[w.getBlockStateId(defPos)] || null
}

function voidBelow (bot, x, y, z, depth = 64) {
  const fx = Math.floor(x); const fz = Math.floor(z)
  for (let yy = Math.floor(y) - 1; yy >= Math.max(0, Math.floor(y) - depth); yy--) {
    const b = blockDef(bot, fx, yy, fz)
    if (!b) return true
    if (isSolid(b)) return false
  }
  return true
}

async function digUpThrough (session, ctl, maxUp = 24) {
  const bot = session.bot
  const out: any = { ok: false, dug: 0, up: 0, why: null }
  const p0 = bot.entity.position
  const ceil = (() => { for (let k = 2; k <= 7; k++) { const b = bot.blockAt(p0.floored().offset(0, k, 0)); if (b && b.name === 'end_stone') return true } return false })()
  if (!ceil) { out.why = 'над головой нет острова'; return out }
  let plat = false
  for (let k = 1; k <= 3 && !plat; k++) { const b = bot.blockAt(p0.floored().offset(0, -k, 0)); if (b && b.name === 'obsidian' && Math.abs(b.position.x - 100) <= 2 && Math.abs(b.position.z) <= 2) plat = true }
  if (!plat) { out.why = 'не на платформе'; return out }
  // к середине платформы (вокруг — обсидиан: шаг в сторону не в пустоту)
  const mid = new Vec3(100.5, p0.y, 0.5)
  if (Math.hypot(p0.x - mid.x, p0.z - mid.z) > 0.4) {
    // свой блок под ногами на краю — спуститься на платформу
    if (p0.y > 49.5) { await digDownTo(bot, ctl, 49, 3).catch(() => {}); clearControls(bot) }
    await stepTo(bot, ctl, new Vec3(100.5, bot.entity.position.y, 0.5), { ms: 3000, sprint: false, stopAt: 0.15, clouds: false })
    clearControls(bot)
  }
  if (Math.hypot(bot.entity.position.x - mid.x, bot.entity.position.z - mid.z) > 0.6) { out.why = 'к середине платформы не дошёл'; return out }
  const pick = findItem(bot, /_pickaxe$/)
  const okDig = b => b && /^(end_stone|cobblestone|cobbled_deepslate|netherrack|dirt|stone|.*_planks)$/.test(b.name)
  for (let i = 0; i < maxUp && !ctl.aborted; i++) {
    const f = bot.entity.position.floored()
    const h1 = bot.blockAt(f.offset(0, 1, 0)); const h2 = bot.blockAt(f.offset(0, 2, 0)); const h3 = bot.blockAt(f.offset(0, 3, 0))
    // вышли: над головой воздух на 3, а на ярусе ног сбоку — остров (стоим вровень с его поверхностью)
    if (isAirish(h1) && isAirish(h2) && isAirish(h3)) {
      let side = false
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const b = bot.blockAt(f.offset(dx, -1, dz)); if (b && b.name === 'end_stone') side = true }
      if (side && i > 0) { out.ok = true; break }
    }
    // 03.10 (ca1-s10, смерть): потолок на ноги + 3 — прыжок упирался в него (ноги поднимались на ~1.2 вместо 1.25), блок под
    for (const hb of [h1, h2, h3]) {
      if (!hb || isAirish(hb)) continue
      if (hb === h3 && !okDig(hb)) continue
      if (!okDig(hb)) { out.why = `над головой ${hb.name}`; return out }
      try { if (pick) await bot.equip(pick, 'hand'); await build.withTimeout(bot.dig(hb, true, 'raycast'), 3000); out.dug++ } catch (e) { bot.stopDigging(); out.why = 'копать: ' + e.message; return out }
    }
    let t = null
    for (let k = 0; k < 3 && !ctl.aborted; k++) {
      t = await build.towerUp(bot, ctl, 1).catch(e => ({ ok: false, reason: e.message }))
      clearControls(bot)
      if (t && t.placed) break
      out.towerRetry = (out.towerRetry || 0) + 1
      await sleep(250)
    }
    if (!t || !t.placed) { out.why = 'столб: ' + ((t && t.reason) || 'не встал'); return out }
    out.up++
  }
  if (!out.ok && !out.why) out.why = 'не вышел'
  return out
}

async function padOverVoid (bot, sup) {
  const out: any = { placed: 0, ok: false }
  const centre = new Vec3(sup.x + 0.5, sup.y + 1, sup.z + 0.5)
  const sideOf = d => sup.offset(d[0], 0, d[1])
  try {
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = sideOf(d)
      if (isSolid(bot.blockAt(c))) continue
      // к краю крадучись ~0.8 от середины опоры в сторону d
      bot.setControlState('sneak', true)
      const goal = centre.offset(d[0] * 0.8, 0, d[1] * 0.8)
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 1500) {
        const q = bot.entity.position
        if (Math.abs(q.x - goal.x) < 0.12 && Math.abs(q.z - goal.z) < 0.12) break
        await lookSafe(bot, Math.atan2(-(goal.x - q.x), -(goal.z - q.z)), -0.6)
        bot.setControlState('forward', true)
        await sleep(50)
        bot.setControlState('forward', false)
        if (bot.entity.position.y < sup.y + 0.9) break
      }
      bot.setControlState('forward', false)
      if (bot.entity.position.y < sup.y + 0.9) { out.fell = true; break }
      const r = await placeItemAt(bot, c, FILLER_RE).catch(() => ({ ok: false }))
      if (r && r.ok) out.placed++
      // назад в середину крадучись
      const t1 = gameClock.now()
      while (gameClock.now() - t1 < 1200) {
        const q = bot.entity.position
        if (Math.hypot(q.x - centre.x, q.z - centre.z) < 0.15) break
        await lookSafe(bot, Math.atan2(-(centre.x - q.x), -(centre.z - q.z)), -0.3)
        bot.setControlState('forward', true)
        await sleep(50)
        bot.setControlState('forward', false)
      }
    }
    // углы — к уже стоящим соседям, с середины
    for (const d of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const c = sideOf(d)
      if (isSolid(bot.blockAt(c))) continue
      const r = await placeItemAt(bot, c, FILLER_RE).catch(() => ({ ok: false }))
      if (r && r.ok) out.placed++
    }
  } finally { clearControls(bot) }
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(sideOf)
  out.missing = sides.filter(c => !isSolid(bot.blockAt(c))).length
  out.ok = out.missing === 0 && !out.fell
  return out
}

function supportCell (bot) {
  const p = bot.entity.position
  const f = new Vec3(Math.floor(p.x), Math.floor(p.y + 0.01) - 1, Math.floor(p.z))
  if (isSolid(bot.blockAt(f))) return f
  let best = null
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      const q = f.offset(dx, 0, dz)
      const cx = Math.max(q.x, Math.min(p.x, q.x + 1)); const cz = Math.max(q.z, Math.min(p.z, q.z + 1))
      if (Math.abs(cx - p.x) > 0.3 + 1e-6 || Math.abs(cz - p.z) > 0.3 + 1e-6) continue
      if (!isSolid(bot.blockAt(q))) continue
      const d = Math.hypot(q.x + 0.5 - p.x, q.z + 0.5 - p.z)
      if (!best || d < best.d) best = { q, d }
    }
  }
  return best ? best.q : null
}

function offIsland (bot, sup) {
  let air = false
  for (let y = sup.y; y >= Math.max(0, sup.y - 70); y--) {
    const b = bot.blockAt(new Vec3(sup.x, y, sup.z))
    if (!b) break
    if (b.name === 'end_stone') return false
    if (!isSolid(b)) air = true
  }
  return air
}

function floorAt (bot, x, feetY, z, depth = 3) {
  const fx = Math.floor(x); const fz = Math.floor(z); const fy = Math.floor(feetY + 0.01)
  const at = y => bot.blockAt(new Vec3(fx, y, fz))
  const b0 = at(fy)
  if (!b0) return null
  if (isSolid(b0)) return isSolid(at(fy + 1)) ? 'wall' : fy + 1
  for (let y = fy - 1; y >= fy - 1 - depth; y--) {
    const b = at(y)
    if (!b) return null
    if (isSolid(b)) return y + 1
  }
  return null
}

function runwayAhead (bot, p, ux, uz, upto, depth = 3) {
  let y = p.y
  for (let s = 0.4; s <= upto + 1e-6; s += 0.4) {
    const f = floorAt(bot, p.x + ux * s, y, p.z + uz * s, depth)
    if (f === 'wall') return null
    if (f == null) return Math.round(s * 10) / 10
    y = f
  }
  return null
}

function stepKeys (bot, p, target, { sprint = true, onGround = true, lidOver = false, portal = false, zones = null }: any = {}) {
  const dx = target.x - p.x; const dz = target.z - p.z
  const dist = Math.hypot(dx, dz) || 1e-9
  const ux = dx / dist; const uz = dz / dist
  const cliff = runwayAhead(bot, p, ux, uz, Math.min(2.8, dist + 0.6))
  if (cliff != null && cliff <= 1.0) return { stop: 'впереди обрыв', cliff }
  if (zones && zones.length) {
    const s1 = Math.min(1.0, dist)
    const fl = floorAt(bot, p.x + ux * s1, p.y, p.z + uz * s1)
    const z = stepIntoZone(zones, p, new Vec3(p.x + ux * s1, typeof fl === 'number' ? fl : p.y, p.z + uz * s1))
    if (z) return { stop: `впереди ${z.kind}`, zone: z }
  }
  const ax = p.x + ux * 0.9; const az = p.z + uz * 0.9
  // Шаг в выходной портал (или шлюз) уносит из Энда — только если туда и шли.
  if (!portal && nearPortal(new Vec3(ax, p.y, az)) && !nearPortal(p)) return { stop: 'впереди чаша портала' }
  if (!portal) {
    const pb = bot.blockAt(new Vec3(Math.floor(ax), Math.floor(p.y), Math.floor(az)))
    const pb2 = bot.blockAt(new Vec3(Math.floor(ax), Math.floor(p.y) - 1, Math.floor(az)))
    if ((pb && /end_portal|end_gateway/.test(pb.name)) || (pb2 && /^end_portal$/.test(pb2.name))) return { stop: 'впереди портал' }
  }
  const front = bot.blockAt(new Vec3(Math.floor(ax), Math.floor(p.y), Math.floor(az)))
  // Цель рядом и на нашем ярусе — блок «в 0.9 впереди» уже за ней (стенка за целью): не прыгать (02.10, fr1-s18: точная
  // доводка к клетке у обода чаши — каждый шаг прыжком, тело запрыгивало на обод — «к столбику не дошёл» 83 раза за серию).
  const nearSame = dist < 0.9 && typeof target.y === 'number' && target.y <= p.y + 0.5
  const jump = !nearSame && isSolid(front) && onGround && !lidOver && (cliff == null || cliff > 2.3)
  return { stop: null, cliff, sprint: !!sprint && dist > 2.5 && cliff == null, jump, yaw: Math.atan2(-dx, -dz) }
}

function nearPortal (pos) {
  return Math.hypot(pos.x - CENTER.x, pos.z - CENTER.z) < 3.8 && pos.y < 63
}

const zoneCache = { t: 0, z: [], bot: null }

function cloudZones (bot) {
  const now = gameClock.now()
  if (zoneCache.bot === bot && now - zoneCache.t < 100) return zoneCache.z
  const out = zonesOf(cloudsOf(bot), fireballsOf(bot))
  zoneCache.t = now; zoneCache.z = out; zoneCache.bot = bot
  return out
}

function zonesOf (clouds, fireballs: any = []) {
  const out = []
  for (const c of clouds) out.push({ x: c.pos.x, y: c.pos.y, z: c.pos.z, r: c.r + 0.8, kind: 'облако', id: c.e ? c.e.id : null })
  for (const f of fireballs) {
    const at = f.line ? f.ground : f.at
    if (at && f.ticks < 60) out.push({ x: at.x, y: at.y, z: at.z, r: FIREBALL_SNAP + 1.5, kind: 'место фаербола', fb: true, id: f.e ? f.e.id : null })
  }
  return out
}

function inZone (z, feet, grow = 0) {
  if (Math.hypot(feet.x - z.x, feet.z - z.z) > z.r + grow) return false
  if (z.fb) return Math.abs(feet.y - z.y) < 3.5
  return feet.y < z.y + CLOUD_SLAB && feet.y + 1.8 > z.y
}

function stepIntoZone (zones, here, next) {
  for (const z of zones) {
    if (!inZone(z, next)) continue
    if (!inZone(z, here)) return z
    if (Math.hypot(next.x - z.x, next.z - z.z) < Math.hypot(here.x - z.x, here.z - z.z) - 0.05) return z
  }
  return null
}

function cloudsOf (bot) {
  const out = []
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e.name !== 'area_effect_cloud' || !e.position || e.isValid === false) continue
    const r = metaOf(bot, e, 'radius')
    if (!cloudBorn.has(e.id)) cloudBorn.set(e.id, gameClock.now())
    out.push({ e, pos: e.position, r: typeof r === 'number' && r > 0 ? r : 3 })
  }
  return out
}

function cloudHits (c, feet, margin = 0.7) {
  const h = Math.hypot(feet.x - c.pos.x, feet.z - c.pos.z)
  if (h > c.r + margin) return false
  return feet.y < c.pos.y + CLOUD_SLAB && feet.y + 1.8 > c.pos.y
}

function starer (bot, yaw, pitch, tol = STARE_TOL * STARE_MARGIN) {
  const eye = bot.entity.position.offset(0, EYE, 0)
  const lx = -Math.sin(yaw) * Math.cos(pitch); const ly = Math.sin(pitch); const lz = -Math.cos(yaw) * Math.cos(pitch)
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e.name !== 'enderman' || !e.position) continue
    const tx = e.position.x - eye.x; const ty = e.position.y + ENDERMAN_EYE - eye.y; const tz = e.position.z - eye.z
    const len = Math.hypot(tx, ty, tz)
    if (len > 64 || len < 0.3) continue
    if ((lx * tx + ly * ty + lz * tz) / len > 1 - tol / len) return e
  }
  return null
}

function safePitch (bot, yaw, pitch) {
  if (!starer(bot, yaw, pitch)) return pitch
  for (const d of [0.1, 0.2, 0.35, 0.5, 0.7, 0.95, 1.2]) {
    const p = Math.max(-1.55, pitch - d)
    if (!starer(bot, yaw, p)) return p
  }
  for (const d of [0.15, 0.3, 0.5]) {
    const p = Math.min(1.55, pitch + d)
    if (!starer(bot, yaw, p)) return p
  }
  return -1.55
}

const fbAlarmAt = new WeakMap()

function fbAlarm (bot) { const a = fbAlarmAt.get(bot); return a && gameClock.now() < a.until ? a : null }

async function lookSafe (bot, yaw, pitch) {
  await bot.look(yaw, safePitch(bot, yaw, pitch), true).catch(() => {})
}

const findItem = (bot, re) => bot.inventory.items().find(i => re.test(i.name)) || null

function runnerBowl (bot, ctl) {
  const p = ctl.pillar && ctl.pillar.plan, q = bot.entity.position
  return runnerOn() && !!p && p.runner && q.y <= p.P - 3 + 0.3 && Math.hypot(q.x - 0.5, q.z - 0.5) < 4
}

function clearControls (bot) {
  for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) { try { bot.setControlState(k, false) } catch {} }
}

async function stepTo (bot, ctl, target, { ms = 2500, sprint = true, stopAt = 0.3, stop = null, portal = false, clouds = true, stuckMs = 700 }: any = {}) {
  if (runnerBowl(bot, ctl)) portal = true
  const t0 = gameClock.now()
  let why = null
  // Упёрся (стенка в 2 блока, яма-воронка: прыгает на месте — fin3-26, 1.5 с прыжков у ямы)
  // — бросить: пусть ведёт pathfinder.
  let best = Infinity; let bestT = t0
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      if (stop && stop()) { why = 'прервал'; break }
      const p = bot.entity.position
      const dx = target.x - p.x; const dz = target.z - p.z
      const dist = Math.hypot(dx, dz)
      if (dist < stopAt) break
      if (dist < best - 0.25) { best = dist; bestT = gameClock.now() } else if (stuckMs && gameClock.now() - bestT > stuckMs) { why = 'застрял'; break }
      // Облако над головой (легло на стенку станции, на столб) не трогает, пока
      const lidOver = cloudsOf(bot).some(c => Math.hypot(p.x - c.pos.x, p.z - c.pos.z) < c.r + 0.8 && c.pos.y >= p.y + 0.5 && c.pos.y < p.y + 1.8 + 1.3)
      // clouds: true — все зоны; 'fb' — только места фаерболов (уход краем облака); false — никаких.
      const k = stepKeys(bot, p, target, { sprint, onGround: bot.entity.onGround, lidOver, portal, zones: clouds === 'fb' ? zonesOf([], fireballsOf(bot)) : clouds ? cloudZones(bot) : null })
      if (k.stop) { why = k.stop; break }
      await lookSafe(bot, k.yaw, -0.35)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', k.sprint)
      bot.setControlState('jump', k.jump)
      await sleep(50)
    }
  } finally {
    clearControls(bot)
  }
  const left = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
  if (!why && left > stopAt + 0.5) why = `не дошёл: ${left.toFixed(1)} блока`
  return { ok: !why, why, dist: Math.round(left * 10) / 10 }
}

async function digDownTo (bot, ctl, gy, max = 40, abortIf = null) {
  let dug = 0; let fails = 0; let patched = 0
  clearControls(bot)
  let cloudWait = 0
  while (!ctl.aborted && Math.floor(bot.entity.position.y + 0.01) > gy && dug < max && fails < 4) {
    await yieldTick()
    const stopWhy = abortIf && abortIf()
    if (stopWhy) return { dug, patched, why: stopWhy }
    const feet = bot.entity.position.floored()
    // Облако под столбом (фаербол лёг у ног): блок вниз — ноги в его полблоке,
    const lower = new Vec3(bot.entity.position.x, feet.y - 1, bot.entity.position.z)
    if (cloudsOf(bot).some(c => cloudHits(c, lower, 0.6) || cloudHits(c, lower.offset(0, -1, 0), 0.6))) {
      if (cloudWait === 0) cloudWait = gameClock.now()
      if (gameClock.now() - cloudWait > 32000) return { dug, patched, why: 'облако под столбом' }
      clearControls(bot)
      await sleep(250)
      continue
    }
    cloudWait = 0
    const under = bot.blockAt(feet.offset(0, -1, 0))
    if (!under) return { dug, patched, why: 'под ногами не прогружено' }
    if (!isSolid(under)) {
      // клетка под серединой уже вырыта, а тело висит на краю соседней (коробка 0.6 — hb3: «окоп: не спустился» 9 раз,
      // ноги в 0.3 от середины): шаг к середине своей клетки, без «крадучись» — и падает в яму
      if (bot.entity.onGround) {
        const cx = feet.x + 0.5; const cz = feet.z + 0.5
        const p = bot.entity.position
        clearControls(bot)
        await bot.look(Math.atan2(-(cx - p.x), -(cz - p.z)), 0, true).catch(() => {})
        bot.setControlState('forward', true)
        await sleep(110)
        bot.setControlState('forward', false)
        const tn = gameClock.now()
        while (bot.entity.onGround && Math.floor(bot.entity.position.y + 0.01) === feet.y && gameClock.now() - tn < 400) await sleep(50)
        while (!bot.entity.onGround && gameClock.now() - tn < 1200) await sleep(50)
        if (Math.floor(bot.entity.position.y + 0.01) < feet.y) continue
      }
      await sleep(150); fails++; continue
    }
    if (!FILLER_RE.test(under.name) && under.name !== 'end_stone') return { dug, patched, why: `под ногами ${under.name}` }
    const below = bot.blockAt(feet.offset(0, -2, 0))
    // и на последнем шаге: пол под целью (pil5-19: окоп на 2 — провалился на 3, «не спустился» каждую посадку)
    if (feet.y - 1 >= gy && below && !isSolid(below) && !/water|lava/.test(below.name)) {
      const r = await build.placeBlockAt(bot, below.position, { timeoutMs: 2000, item: fillerItem(bot) })
      if (!r.ok) return { dug, patched, why: `дыра под столбом, подложить не вышло: ${r.reason}` }
      patched++
    }
    try {
      await items.equipBestTool(bot, under)
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      await build.withTimeout(bot.dig(under, true), 6000)
      dug++
      const t0 = gameClock.now()
      while (bot.entity.position.y > under.position.y + 0.05 && gameClock.now() - t0 < 1500) await sleep(50)
      const t1 = gameClock.now()
      while (!bot.entity.onGround && gameClock.now() - t1 < 1000) await sleep(50)
    } catch (e) { dbg('down', e.message); fails++; await sleep(200) }
  }
  return { dug, patched, why: Math.floor(bot.entity.position.y + 0.01) > gy ? 'не спустился до земли' : null }
}

const fbSpawn = new Map()

const FB_PATH = (() => { const out = [0]; let v = 0.1; let s = 0; for (let k = 1; k <= 160; k++) { v = (v + 0.1) * 0.95; s += v; out.push(s) } return out })()

function fbTicksTo (dist) { for (let k = 0; k < FB_PATH.length; k++) if (FB_PATH[k] >= dist) return k; return FB_PATH.length }

function fbLineHit (bot, p0, dir, maxDist = 160) {
  for (let s = 0.25; s < maxDist; s += 0.25) {
    const p = p0.offset(dir.x * s, dir.y * s, dir.z * s)
    if (p.y < -64) return null
    const b = bot.blockAt(p.floored())
    if (!b) return null
    if (isSolid(b)) return { at: p, dist: s }
  }
  return null
}

function lineDist (p0, dir, q) {
  const rx = q.x - p0.x; const ry = q.y - p0.y; const rz = q.z - p0.z
  const s = rx * dir.x + ry * dir.y + rz * dir.z
  return { s, d: Math.hypot(rx - dir.x * s, ry - dir.y * s, rz - dir.z * s) }
}

const fbSeen = new Map()

function fireballsOf (bot) {
  const out = []
  const me = bot.entity.position
  const now = gameClock.now()
  const alive = new Set()
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e.name !== 'dragon_fireball' || !e.position) continue
    alive.add(e.id)
    const info = fbSpawn.get(e.id)
    if (info && info.dir) {
      if (!info.hit || now - info.hitAt > 500) { info.hit = fbLineHit(bot, info.p0, info.dir); info.hitAt = now }
      const flown = (now - info.t0) / 50
      // Прямое попадание в нас: прямая проходит сквозь наше тело раньше земли.
      const body = lineDist(info.p0, info.dir, me.offset(0, 0.9, 0))
      let at = info.hit ? info.hit.at : null
      let dist = info.hit ? info.hit.dist : null
      let direct = false
      if (body.s > 0 && body.d < 1.2 && (dist == null || body.s < dist)) { at = me.clone(); dist = body.s; direct = true }
      if (at == null) continue
      const ticks = Math.max(0, fbTicksTo(dist) - flown)
      out.push({ e, at, ticks, line: { p0: info.p0, dir: info.dir, dist: info.hit ? info.hit.dist : 160 }, ground: info.hit ? info.hit.at : null, direct, exact: true })
      continue
    }
    // Точки появления не видели (фаербол родился до начала боя) — по двум
    // замерам позиции, как раньше; свежий без скорости считаем летящим в нас.
    let h = fbSeen.get(e.id)
    if (!h) { h = []; fbSeen.set(e.id, h) }
    const last = h[h.length - 1]
    if (!last || now - last.t >= 40) h.push({ x: e.position.x, y: e.position.y, z: e.position.z, t: now })
    while (h.length > 8) h.shift()
    let vel = null
    const a = h[0]; const b = h[h.length - 1]
    if (h.length >= 2 && b.t - a.t >= 80) {
      const dt = (b.t - a.t) / 50
      vel = { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt }
    }
    if (!vel || Math.hypot(vel.x, vel.y, vel.z) < 0.02) {
      const to = me.offset(0, 0.9, 0).minus(e.position)
      const n = to.norm() || 1
      vel = { x: to.x / n * 0.6, y: to.y / n * 0.6, z: to.z / n * 0.6 }
    }
    let p = e.position.clone(); let w = { x: vel.x, y: vel.y, z: vel.z }
    let at = null; let ticks = 0
    for (let t = 1; t <= 90; t++) {
      const len = Math.hypot(w.x, w.y, w.z) || 1
      p = p.offset(w.x, w.y, w.z)
      w = { x: (w.x + 0.1 * w.x / len) * 0.95, y: (w.y + 0.1 * w.y / len) * 0.95, z: (w.z + 0.1 * w.z / len) * 0.95 }
      const bl = bot.blockAt(p.floored())
      if ((bl && isSolid(bl)) || p.distanceTo(me.offset(0, 0.9, 0)) < 1.2 || p.y < 0) { at = p; ticks = t; break }
    }
    if (at) out.push({ e, at, ticks })
  }
  for (const id of fbSeen.keys()) if (!alive.has(id)) fbSeen.delete(id)
  for (const [id, info] of fbSpawn) if (!alive.has(id) && now - info.t0 > 3000) fbSpawn.delete(id)
  return out
}

const cloudBorn = new Map()

const sitFix = new Map()

async function placeItemAt (bot, pos, itemRe) {
  const at = bot.blockAt(pos)
  if (at && at.name !== 'air' && isSolid(at)) return { ok: true, already: at.name }
  const stack = bot.inventory.items().find(i => itemRe.test(i.name))
  if (!stack) return { ok: false, reason: 'нет блока' }
  const was = bot.getControlState('sneak')
  bot.setControlState('sneak', true)
  try {
    await bot.equip(stack, 'hand')
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    for (const face of [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]) {
      if (fbAlarm(bot)) return { ok: false, reason: 'фаербол' }
      const ref = bot.blockAt(pos.minus(face))
      if (!ref || !isSolid(ref) || /_bed$|portal|gateway/.test(ref.name)) continue
      const aim = pick.faceAim(bot, ref.position, face)
      if (!aim) continue
      try { await bot.lookAt(aim, true); await build.withTimeout(bot.placeBlock(ref, face), 1500) } catch (e) { dbg('placeItemAt', e.message) }
      const b = bot.blockAt(pos)
      if (b && isSolid(b)) return { ok: true }
    }
    return { ok: false, reason: 'грань не видно' }
  } finally { if (!was) bot.setControlState('sneak', false) }
}

function fillerItem (bot) {
  if (build.pickFiller(bot, { steady: true })) return undefined
  return findItem(bot, /^end_stone$/) ? 'end_stone' : undefined
}

module.exports = { gameClock, Vec3, Movements, goals, sleep, bow, build, threats, pvp, items, armor, actions, pick, pearlHop, DEBUG, yieldTick, dbg, PHASE, PHASE_RU, SITTING, PILLOW_DY, TOWER_FAR, RUN_TOWER1, RUN_FACING, RUN_ARROW, RUN_HIGH, RUN_MELEE, RUN_BOX, RUN_SEEN, RUN_GAPARROW, RUN_KEEPCOB, RUN_TICKSEEN, RUN_LATEHEAD, pillarTriesMax, KEEP_ON, KEEP_N, FIRST_MAX, BUILD_MAX_MS, PLACE_LEAD, PILLAR_BAD, HEAD_ROOM, LABENV, envv, runnerOn, envNum, HEAD_AHEAD, HURT_PAD, NECK_AHEAD, SIT_HEAD_DY, PART, SIT_TAKEOFF, CRYSTAL_BLAST, SAFE_FROM_CRYSTAL, BREATH_R, BREATH_AHEAD, FIREBALL_SNAP, CLOUD_SLAB, STARE_TOL, STARE_MARGIN, ENDERMAN_EYE, MELEE_REACH, EYE, CENTER, holdingOdds, dragonWaitBand, dragonWaitStop, KIT, BEDS_KIT, FILLER_RE, metaOf, dragonOf, phaseOf, hpOf, headDir, makeTrack, box, inflate, boxDist, overlap, playerBox, partsOf, isSolid, isAirish, blockDef, voidBelow, digUpThrough, padOverVoid, supportCell, offIsland, floorAt, runwayAhead, stepKeys, nearPortal, zoneCache, cloudZones, zonesOf, inZone, stepIntoZone, cloudsOf, cloudHits, starer, safePitch, fbAlarmAt, fbAlarm, lookSafe, findItem, runnerBowl, clearControls, stepTo, digDownTo, fbSpawn, FB_PATH, fbTicksTo, fbLineHit, lineDist, fbSeen, fireballsOf, cloudBorn, sitFix, placeItemAt, fillerItem }
