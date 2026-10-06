const { voidBelow, blockDef, Vec3, isSolid, isAirish, stepIntoZone, CENTER, runwayAhead, cloudZones, nearPortal, cloudsOf, CLOUD_SLAB, cloudHits, BREATH_AHEAD, BREATH_R, starer, safePitch, gameClock, pvp, EYE, clearControls, dbg, fireballsOf, fbAlarmAt, cloudBorn, FILLER_RE, sleep, items, build, metaOf, findItem, actions, HEAD_AHEAD, stepTo, digDownTo } = require('./dig-down-to')
function nearEdge (bot, pos, r = 3) {
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue
      if (voidBelow(bot, pos.x + dx, pos.y + 1, pos.z + dz, 24)) return true
    }
  }
  return false
}

function straightOut (bot, me, away, lens = [10, 7, 5, 3.5]) {
  const d0 = Math.hypot(me.x - away.x, me.z - away.z)
  const base = Math.atan2(me.z - away.z, me.x - away.x)
  const dirs = [0, 0.6, -0.6, 1.2, -1.2].map(t => base + t)
  dirs.push(Math.atan2(CENTER.z - me.z, CENTER.x - me.x))
  let best = null
  for (const a of dirs) {
    const ux = Math.cos(a); const uz = Math.sin(a)
    for (const L of lens) {
      if (runwayAhead(bot, me, ux, uz, L + 0.6) != null) continue
      const t = me.offset(ux * L, 0, uz * L)
      if (!straightWalkable(bot, me, t, cloudZones(bot))) continue
      if (nearEdge(bot, t, 2) || nearPortal(t)) continue
      const gain = Math.hypot(t.x - away.x, t.z - away.z) - d0
      if (gain < 2) continue
      if (!best || gain > best.gain) best = { t, gain }
      break
    }
  }
  return best ? best.t : null
}

function surfaceY (bot, x, z, from = 110) {
  const fx = Math.floor(x); const fz = Math.floor(z)
  for (let y = from; y >= 1; y--) {
    const b = blockDef(bot, fx, y, fz)
    if (!b) return null
    if (isSolid(b)) return { y: y + 1, name: b.name }
    if (!isAirish(b) && b.name !== 'air') return null
  }
  return null
}

function standY (bot, x, z, nearY, up = 8, down = 14) {
  const fx = Math.floor(x); const fz = Math.floor(z)
  for (let y = Math.floor(nearY) + up; y >= Math.floor(nearY) - down; y--) {
    const under = blockDef(bot, fx, y - 1, fz)
    if (!under) continue
    if (!isSolid(under)) continue
    if (isAirish(blockDef(bot, fx, y, fz)) && isAirish(blockDef(bot, fx, y + 1, fz))) return y
  }
  return null
}

function cageBars (bot, cx, top, cz) {
  const out = []
  for (let dy = 0; dy <= 3; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2 && dy !== 3) continue
        const p = new Vec3(cx + dx, top + dy, cz + dz)
        const b = bot.blockAt(p)
        if (b && b.name === 'iron_bars') out.push(p)
      }
    }
  }
  return out
}

function crystalsOf (bot) {
  const out = []
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e.name !== 'end_crystal' || !e.position || e.isValid === false) continue
    const cx = Math.floor(e.position.x); const cz = Math.floor(e.position.z)
    const top = Math.floor(e.position.y) - 1
    out.push({
      e,
      id: e.id,
      pos: e.position.clone(),
      aim: e.position.offset(0, 1, 0),
      cx,
      cz,
      top,
      bars: cageBars(bot, cx, top, cz).length,
      pillar: Math.hypot(e.position.x - CENTER.x, e.position.z - CENTER.z) > 20
    })
  }
  return out
}

function overCloud (bot) {
  const me = bot.entity.position
  return cloudsOf(bot).some(c => Math.hypot(me.x - c.pos.x, me.z - c.pos.z) < c.r + 1 && me.y >= c.pos.y + CLOUD_SLAB - 0.01 && me.y < c.pos.y + 3)
}

function inClouds (clouds, feet, margin) { return clouds.find(c => cloudHits(c, feet, margin)) || null }

function breathOf (bot, d, parts) {
  const hc = parts.headC
  const cx = hc.x + parts.dir.x * BREATH_AHEAD
  const cz = hc.z + parts.dir.z * BREATH_AHEAD
  let y = Math.floor(parts.head.min.y + 0.5)
  for (; y > 0; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(cx), y, Math.floor(cz)))
    if (!b) break
    if (b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') break
  }
  return { pos: new Vec3(cx, y + 1, cz), r: BREATH_R, predicted: true, column: { x: Math.floor(cx), z: Math.floor(cz) } }
}

function lookGuard (bot, stats) {
  const onTick = () => {
    if (!bot.entity) return
    const y = bot.entity.yaw; const p = bot.entity.pitch
    if (!starer(bot, y, p)) return
    const np = safePitch(bot, y, p)
    stats.guarded = (stats.guarded || 0) + 1
    bot.look(y, np, true).catch(() => {})
  }
  bot.on('physicsTick', onTick)
  const unfilter = stareFilter(bot, stats)
  return () => { bot.removeListener('physicsTick', onTick); unfilter() }
}

// Взгляд на эндермена — в пакете (750 TPS, s5 06.10). Эндермен злится после 5 тиков взгляда сервера (поворот из
// последнего look/position_look); на 750 тиках это 7 мс, а поправка сторожа (bot.look под замком рефлексов — асинхронно)
// уходила позже: на 750 эндермены злились «без взгляда» по клиенту и убили 4 из 6 погибших (s5-c3, c4), на 20 — 1 бой из 42.
// Каждый исходящий поворот, который смотрит в глаза эндермену, опускается до ближайшего безопасного (safePitch).
const DEG = Math.PI / 180
function stareFilter (bot, stats: any = {}) {
  const c = bot._client
  if (!c || typeof c.write !== 'function') return () => {}
  const raw = c.write
  const wrapped = function (name, data) {
    if ((name === 'look' || name === 'position_look') && data && bot.entity && typeof data.pitch === 'number') {
      const yaw = Math.PI - data.yaw * DEG; const pitch = -data.pitch * DEG
      if (starer(bot, yaw, pitch)) {
        const np = safePitch(bot, yaw, pitch)
        stats.stareCut = (stats.stareCut || 0) + 1
        data = { ...data, pitch: -np / DEG }
      }
    }
    return raw.call(this, name, data)
  }
  c.write = wrapped
  return () => { if (c.write === wrapped) c.write = raw }
}

function fallGuard (bot, stats, ctl = null) {
  const ev = (k, o) => { if (ctl && ctl.trace) ctl.trace.ev(k, o) }
  let peak = null
  let placed = null
  let steering = false
  let drinking = false
  const hotbar = name => bot.inventory.slots.findIndex((it, i) => i >= 36 && i <= 44 && it && it.name === name)
  const onTick = () => {
    const e = bot.entity
    if (!e || !e.position) return
    const p = e.position
    // Приземлились в свою воду — забрать её назад, пустым ведром вниз.
    if (placed && (e.onGround || e.isInWater)) {
      // Приземлились — высота падения с нуля: иначе старая вершина жила, пока
      peak = null
      if (!placed.landed) { placed.landed = true; const w0 = bot.blockAt(placed.pos); ev('clutchLand', { y: r1(p.y), x: r1(p.x), z: r1(p.z), at: [placed.pos.x, placed.pos.y, placed.pos.z], block: w0 ? w0.name : null, water: !!e.isInWater, hp: r1(bot.health ?? 0) }) }
      if (gameClock.now() - placed.t > 3000) { placed = null; return }
      if (placed.picking) return
      const w = bot.blockAt(placed.pos)
      if (!w || w.name !== 'water') { if (gameClock.now() - placed.t > 600) placed = null; return }
      const b = hotbar('bucket')
      if (b < 0) return
      // Взгляд — на середину источника (не прямо вниз): отнесло на блок — и луч
      const eyeW = e.position.offset(0, EYE, 0)
      if (eyeW.distanceTo(placed.pos.offset(0.5, 0.5, 0.5)) > 4.3) { if (gameClock.now() - placed.t > 600) placed = null; return }
      placed.picking = true
      if (bot.quickBarSlot !== b - 36) bot.setQuickBarSlot(b - 36)
      const at = placed
      const aimW = () => {
        const q = e.position.offset(0, EYE, 0)
        const tx = at.pos.x + 0.5 - q.x; const ty = at.pos.y + 0.5 - q.y; const tz = at.pos.z + 0.5 - q.z
        const h = Math.hypot(tx, tz)
        if (h < 0.25) { e.pitch = -Math.PI / 2; return }
        e.yaw = Math.atan2(-tx, -tz); e.pitch = Math.atan2(ty, h)
      }
      aimW()
      afterPositionPacket(bot, () => {
        aimW()
        bot.activateItem()
        stats.clutch.pickedUp = (stats.clutch.pickedUp || 0) + 1
        gameClock.setTimeout(() => {
          if (placed !== at) return
          const w2 = bot.blockAt(at.pos)
          if (w2 && w2.name === 'water') at.picking = false
          else placed = null
        }, 400)
      })
      return
    }
    if (e.onGround || e.isInWater) { peak = null; stats.clutch.noBucketAt = 0; return }
    if (peak == null || p.y > peak) peak = p.y
    if (e.velocity.y > -0.25) return
    let gy = null
    for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 48 && y >= -64; y--) {
      const b = bot.blockAt(new Vec3(Math.floor(p.x), y, Math.floor(p.z)))
      if (!b) return
      if (/water/.test(b.name)) return
      if (isSolid(b)) { gy = y + 1; break }
    }
    if (gy == null) {
      if (peak - p.y > 4 && !placed) { placed = { t: gameClock.now(), pos: new Vec3(0, -999, 0) }; stats.clutch.void = (stats.clutch.void || 0) + 1 }
      return
    }
    const fall = peak - gy
    // Урон падения — fallDistance − 3; до 4 хп терпимо, дальше — спасаться.
    if (fall < 7 || placed) return
    const wb = hotbar('water_bucket')
    if (wb >= 0) {
      // Приземлится тело на самую высокую из колонок под хитбоксом (0.6): краем
      let land = null
      for (const [ox, oz] of [[0, 0], [-0.3, -0.3], [-0.3, 0.3], [0.3, -0.3], [0.3, 0.3]]) {
        const x = Math.floor(p.x + ox); const z = Math.floor(p.z + oz)
        if (land && land.x === x && land.z === z) continue
        for (let y = Math.floor(p.y); y >= gy - 1; y--) {
          const b = bot.blockAt(new Vec3(x, y, z))
          if (b && isSolid(b)) { if (!land || y + 1 > land.top) land = { x, z, top: y + 1 }; break }
        }
      }
      if (!land) land = { x: Math.floor(p.x), z: Math.floor(p.z), top: gy }
      const cx = land.x + 0.5; const cz = land.z + 0.5
      const off = Math.hypot(cx - p.x, cz - p.z)
      if (off > 0.08) {
        e.yaw = Math.atan2(-(cx - p.x), -(cz - p.z))
        bot.setControlState('forward', true)
        bot.setControlState('sprint', false)
        steering = true
      } else if (steering) { bot.setControlState('forward', false); steering = false }
      const gyBox = land.top
      const above = p.y - gyBox
      if (above > 2.75 || above < 0.02) return
      if (land.x !== Math.floor(p.x) || land.z !== Math.floor(p.z)) stats.clutch.uneven = (stats.clutch.uneven || 0) + 1
      steering = false
      // pathfinder в полёте (шли, и крылом подбросило) держит в руке блок
      try { bot.pathfinder.setGoal(null) } catch {}
      clearControls(bot)
      if (bot.quickBarSlot !== wb - 36) bot.setQuickBarSlot(wb - 36)
      placed = { t: gameClock.now(), pos: new Vec3(land.x, gyBox, land.z) }
      stats.clutch.water = (stats.clutch.water || 0) + 1
      stats.clutch.above = r1(above)
      ev('clutch', { y: r1(p.y), x: r1(p.x), z: r1(p.z), gy: gyBox, land: [land.x, land.z], above: r1(above), vy: r1(e.velocity.y), vx: +e.velocity.x.toFixed(2), vz: +e.velocity.z.toFixed(2), held: bot.heldItem ? bot.heldItem.name : null, fall: r1(fall) })
      // Взгляд — на верх колонки приземления (центр над ней — прямо вниз), до
      // пакета позиции этого тика (уйдёт в нём же).
      const aim = () => {
        const eye = e.position.offset(0, EYE, 0)
        const tx = land.x + 0.5 - eye.x; const ty = gyBox - eye.y; const tz = land.z + 0.5 - eye.z
        const h = Math.hypot(tx, tz)
        if (h < 0.3) { e.pitch = -Math.PI / 2; return }
        e.yaw = Math.atan2(-tx, -tz); e.pitch = Math.atan2(ty, h)
      }
      aim()
      afterPositionPacket(bot, () => {
        const slot = hotbar('water_bucket')
        if (slot >= 0 && bot.quickBarSlot !== slot - 36) bot.setQuickBarSlot(slot - 36)
        aim()
        bot.activateItem()
        ev('clutchUse', { y: r1(e.position.y), held: bot.heldItem ? bot.heldItem.name : null })
        dbg('clutch water', 'fall', fall.toFixed(1), 'above', above.toFixed(2), 'v', e.velocity.y.toFixed(2), 'at', placed && placed.pos.toString(), 'held', bot.heldItem && bot.heldItem.name)
      })
      return
    }
    // Ведра в хотбаре нет: свидетель для разбора (e2e3, 303 с: падение с 23
    // блоков без попытки ведра) — где оно было в этот миг.
    if (peak - p.y > 3 && !stats.clutch.noBucketAt) {
      stats.clutch.noBucketAt = gameClock.now()
      const where = bot.inventory.slots.map((it, k) => it && /bucket/.test(it.name) ? `${k}:${it.name}` : null).filter(Boolean)
      stats.clutch.noBucket = (stats.clutch.noBucket || 0) + 1
      ev('noBucket', { where, held: bot.heldItem ? bot.heldItem.name : null, fall: r1(fall) })
      dbg('clutch: в хотбаре нет ведра воды', JSON.stringify(where), 'в руке', bot.heldItem && bot.heldItem.name, 'падать', fall.toFixed(1))
    }
    if (!drinking && fall > 12 && !hasEffect(bot, 'slow_falling')) {
      const pot = potionItem(bot, 'slow_falling', { splash: false })
      if (!pot) return
      drinking = true
      stats.clutch.slowFalling = (stats.clutch.slowFalling || 0) + 1
      bot.equip(pot, 'hand').then(() => bot.consume()).catch(() => {}).finally(() => { drinking = false })
    }
  }
  stats.clutch = stats.clutch || {}
  bot.on('physicsTick', onTick)
  return () => bot.removeListener('physicsTick', onTick)
}

function afterPositionPacket (bot, fn) {
  const c = bot._client
  if (!c._ndAfterPos) {
    c._ndAfterPos = []
    const orig = c.write
    c.write = function (name) {
      const r = orig.apply(this, arguments)
      if (c._ndAfterPos.length && (name === 'position' || name === 'position_look' || name === 'look' || name === 'flying')) {
        const q = c._ndAfterPos.splice(0)
        for (const f of q) { try { f() } catch {} }
      }
      return r
    }
  }
  let done = false
  const once = () => { if (done) return; done = true; fn() }
  c._ndAfterPos.push(once)
  gameClock.setTimeout(() => { const i = c._ndAfterPos.indexOf(once); if (i >= 0) c._ndAfterPos.splice(i, 1); once() }, 120)
}

function aboveCloudY (me, c) {
  return Math.max(Math.floor(me.y + 0.01) + 1, Math.ceil(c.pos.y + CLOUD_SLAB - 0.01))
}

const FB_ALARM_R = Number(process.env.ND_FB_ALARM_R ?? 5)

function fireballAlarm (bot, ctl, stats) {
  if (process.env.ND_FB_ALARM === '0') return () => {}
  const seen = new Set()
  const iv = gameClock.setInterval(() => {
    try {
      const e = bot.entity
      if (!e || !e.position || ctl.aborted) return
      const me = e.position
      for (const fb of fireballsOf(bot)) {
        if (!fb.at || fb.ticks > 60) continue
        const h = Math.hypot(fb.at.x - me.x, fb.at.z - me.z)
        if (!fb.direct && !(h < FB_ALARM_R && Math.abs(fb.at.y - me.y) < 4)) continue
        fbAlarmAt.set(bot, { t: gameClock.now(), until: gameClock.now() + fb.ticks * 50 + 800, at: fb.at, id: fb.e.id })
        if (seen.has(fb.e.id)) continue
        seen.add(fb.e.id)
        if (seen.size > 200) seen.clear()
        stats.fbAlarm = (stats.fbAlarm || 0) + 1
        if (ctl.trace) ctl.trace.ev('fbAlarm', { id: fb.e.id, h: r1(h), ticks: fb.ticks, direct: !!fb.direct, doing: ctl.doing, evading: !!ctl.evading })
        // уход — дело боя; мост/край (крадучись, далеко от центра) не трогать: отпущенный «крадучись» на краю — падение
        if (ctl.evading || bot.getControlState('sneak') || Math.hypot(me.x - CENTER.x, me.z - CENTER.z) > 40) continue
        try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
        try { bot.stopDigging() } catch {}
        try { bot.deactivateItem() } catch {}
        clearControls(bot)
      }
    } catch {}
  }, 100)
  return () => gameClock.clearInterval(iv)
}

function cloudReflex (bot, ctl, stats) {
  let inSince = 0
  let busy = false
  const onTick = () => {
    const e = bot.entity
    if (busy || !e || !e.position || !e.onGround || ctl.aborted) { if (!busy) inSince = 0; return }
    // Стоим на месте у кроватей (двойная станция) с запасом хп — не лезть на блок:
    // подъём ломает щелчок поверх стенки, а облако — 3 в секунду.
    if (ctl.holdStation && bot.health >= 12) { inSince = 0; return }
    const me = e.position
    const age = ctl.evading ? 700 : 300
    const c = cloudsOf(bot).find(k => cloudHits(k, me, 0.2) && cloudAgeMs(k) > age)
    if (!c) { inSince = 0; return }
    if (!inSince) { inSince = gameClock.now(); return }
    if (gameClock.now() - inSince < 100) return
    if (!bot.inventory.items().some(i => FILLER_RE.test(i.name))) return
    if (!isAirish(bot.blockAt(me.floored().offset(0, 2, 0)))) return
    busy = true
    stats.dodges.рефлекс = (stats.dodges.рефлекс || 0) + 1
    if (ctl.trace) ctl.trace.ev('reflex', { at: [r1(me.x), r1(me.y), r1(me.z)], cloud: c.e.id, r: r1(c.r) })
    const toY = aboveCloudY(me, c)
    ;(async () => {
      try {
        try { bot.stopDigging() } catch {}
        try { bot.pathfinder.setGoal(null) } catch {}
        clearControls(bot)
        await fastTower(bot, ctl, toY, { maxMs: 1500 })
      } catch {} finally { busy = false; inSince = 0 }
    })()
  }
  bot.on('physicsTick', onTick)
  return () => bot.removeListener('physicsTick', onTick)
}

const hitBy = new Map()

const r1 = v => Math.round(v * 10) / 10

const doing = (ctl, what) => { if (ctl) ctl.doing = what }

function hunters (bot, r = 24) {
  return angryEndermen(bot, r).filter((e : any) => {
    const t = hitBy.get(e.id)
    return t && gameClock.now() - t < 8000
  })
}

function angryEndermen (bot, r = 24) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'enderman' && e.position &&
    e.position.distanceTo(me) < r && metaOf(bot, e, 'creepy') === true)
}

async function unembed (bot, ctl) {
  clearControls(bot)
  for (let i = 0; i < 4 && !ctl.aborted; i++) {
    const b = embeddedNow(bot)
    if (!b || /bedrock|obsidian|end_portal/.test(b.name)) break
    try {
      await items.equipBestTool(bot, b)
      await build.withTimeout(bot.dig(b, true), 5000)
      dbg('unembed', b.name, b.position.toString())
    } catch (e) { dbg('unembed failed', e.message) }
  }
  await sleep(300)
}

function embeddedNow (bot) {
  const p = bot.entity.position
  for (const x of [p.x - 0.29, p.x + 0.29]) {
    for (const z of [p.z - 0.29, p.z + 0.29]) {
      for (const y of [p.y + 0.05, p.y + 0.9, p.y + 1.75]) {
        const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
        if (b && b.boundingBox === 'block' && b.shapes && b.shapes.length === 1) {
          const [x0, y0, z0, x1, y1, z1] = b.shapes[0]
          if (x0 === 0 && y0 === 0 && z0 === 0 && x1 === 1 && y1 === 1 && z1 === 1) return b
        }
      }
    }
  }
  return null
}

function pickSpot (bot, center, { rMin = 10, rMax = 16, prefer = null, edge = 3, avoid = null, nearY = null, step = 2 }: any = {}) {
  const me = prefer || bot.entity.position
  const clouds = cloudsOf(bot)
  let best = null
  for (let r = rMin; r <= rMax; r += step) {
    const n = Math.max(12, Math.round(2 * Math.PI * r / 2))
    for (let k = 0; k < n; k++) {
      const a = 2 * Math.PI * k / n
      const x = center.x + Math.cos(a) * r; const z = center.z + Math.sin(a) * r
      let y = null
      if (nearY != null) y = standY(bot, x, z, nearY, 4, 6)
      else {
        const sf = surfaceY(bot, x, z)
        if (sf && /^(end_stone|cobblestone)$/.test(sf.name)) y = sf.y
      }
      if (y == null) continue
      const feet = new Vec3(Math.floor(x) + 0.5, y, Math.floor(z) + 0.5)
      if (nearPortal(feet)) continue
      if (inClouds(clouds, feet, 1.5)) continue
      if (edge && nearEdge(bot, feet, edge)) continue
      if (avoid && avoid(feet)) continue
      const score = feet.distanceTo(me)
      if (!best || score < best.score) best = { feet, score, r }
    }
  }
  return best
}

async function fastTower (bot, ctl, toY, { abortIf = null, maxMs = 40000 }: any = {}) {
  const filler = () => bot.inventory.items().find(i => FILLER_RE.test(i.name))
  let it = filler()
  if (!it) return { ok: false, why: 'нечем строить', placed: 0 }
  clearControls(bot)
  await bot.equip(it, 'hand').catch(() => {})
  await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {})
  const fx = Math.floor(bot.entity.position.x); const fz = Math.floor(bot.entity.position.z)
  let top = Math.floor(bot.entity.position.y + 0.01)
  const t0 = gameClock.now()
  let placed = 0
  let pending = 0
  let why = null
  bot.setControlState('sneak', true)
  bot.setControlState('jump', true)
  try {
    while (!ctl.aborted && top < toY && gameClock.now() - t0 < maxMs) {
      await new Promise<any>(resolve => bot.once('physicsTick', resolve))
      why = abortIf ? abortIf() : null
      if (why) break
      const cell = bot.blockAt(new Vec3(fx, top, fz))
      if (cell && isSolid(cell)) { top++; placed++; pending = 0; continue }
      const head = bot.blockAt(new Vec3(fx, top + 2, fz))
      if (head && isSolid(head)) { why = `потолок ${head.name}`; break }
      if (pending && gameClock.now() - pending < 450) continue
      if (bot.entity.position.y - top < 1.02) continue
      if (!bot.heldItem || !FILLER_RE.test(bot.heldItem.name)) {
        it = filler()
        if (!it) { why = 'кончились блоки'; break }
        await bot.equip(it, 'hand').catch(() => {})
        continue
      }
      const ref = bot.blockAt(new Vec3(fx, top - 1, fz))
      if (!ref || !isSolid(ref)) { why = 'под столбом пусто'; break }
      pending = gameClock.now()
      afterPositionPacket(bot, () => { bot._genericPlace(ref, new Vec3(0, 1, 0), { forceLook: 'ignore', swingArm: 'right' }).catch(() => {}) })
    }
  } finally {
    bot.setControlState('jump', false)
    bot.setControlState('forward', false); bot.setControlState('back', false)
    bot.setControlState('left', false); bot.setControlState('right', false)
    // Встать на поставленный блок крадучись — потом отпускать.
    const tl = gameClock.now()
    while (!ctl.aborted && !bot.entity.onGround && gameClock.now() - tl < 600) await sleep(50)
    bot.setControlState('sneak', false)
  }
  if (!why && top < toY) why = ctl.aborted ? 'прервано' : 'не успел'
  return { ok: top >= toY, placed, y: top, why, ms: gameClock.now() - t0 }
}

function hasEffect (bot, name) {
  try {
    const pascal = String(name).split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')
    const eff = bot.registry.effectsByName[name] || bot.registry.effectsByName[pascal]
    return !!(eff && bot.entity.effects && bot.entity.effects[eff.id])
  } catch { return false }
}

function potionItem (bot, kind, { splash = null }: any = {}) {
  return bot.inventory.items().find(i => (splash === true ? i.name === 'splash_potion' : splash === false ? i.name === 'potion' : /^(splash_)?potion$/.test(i.name)) &&
    (pvp.potionOf(i) || '').replace(/^(long|strong)_/, '') === kind) || null
}

async function usePotion (bot, stats, kind, effect = kind) {
  if (effect && hasEffect(bot, effect)) return false
  const it = potionItem(bot, kind, { splash: true }) || potionItem(bot, kind, { splash: false })
  if (!it) return false
  try {
    await bot.equip(it, 'hand')
    if (it.name === 'splash_potion') {
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      bot.activateItem()
      await sleep(150)
    } else {
      await build.withTimeout(bot.consume(), 4000)
    }
    stats.potions = stats.potions || []
    stats.potions.push(`${it.name === 'splash_potion' ? 'взрывное ' : ''}${kind}`)
    return true
  } catch (e) { dbg('potion', kind, e.message); return false }
}

async function healRaw (session, ctl, rep, stats, { hard = false }: any = {}) {
  const bot = session.bot
  // Совсем мало — мгновенное лечение первым (яблоко — это 1.6 с и лечит
  // медленно), потом регенерация.
  if (bot.health <= 8 && await usePotion(bot, stats, 'healing', null)) return true
  if (bot.health <= 10 && !findItem(bot, /golden_apple$/) && await usePotion(bot, stats, 'regeneration')) return true
  if (findItem(bot, /golden_apple$/) && (hard || bot.health <= 14)) {
    const r = await actions.eat(session, { item: findItem(bot, /golden_apple$/).name }).catch(e => ({ note: e.message }))
    if (r && r.ate) { stats.ate.push(r.ate); return true }
  }
  if (bot.food < 20) {
    const r = await actions.eat(session, {}).catch(e => ({ note: e.message }))
    if (r && r.ate) { stats.ate.push(r.ate); return true }
  }
  return false
}

function nearPillar (bot, feet, r = 4) {
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const b = blockDef(bot, Math.floor(feet.x) + dx, Math.floor(feet.y) + 1, Math.floor(feet.z) + dz)
      if (b && b.name === 'obsidian') return true
    }
  }
  return false
}

function wingBoxes (pos, yaw, grow = 0) {
  const hx = Math.sin(yaw); const hz = Math.cos(yaw)
  return [1, -1].map(s => {
    const cx = pos.x - hz * 4.5 * s; const cz = pos.z + hx * 4.5 * s
    return { min: new Vec3(cx - 6 - grow, pos.y - 2, cz - 6 - grow), max: new Vec3(cx + 6 + grow, pos.y + 4, cz + 6 + grow) }
  })
}

const dragonHist = []

function dragonVel (d, now) {
  const last = dragonHist[dragonHist.length - 1]
  if (!last || last.id !== d.id || now - last.t >= 40) dragonHist.push({ id: d.id, t: now, x: d.position.x, y: d.position.y, z: d.position.z })
  while (dragonHist.length > 1 && (dragonHist[0].id !== d.id || now - dragonHist[0].t > 600)) dragonHist.shift()
  const a = dragonHist[0]; const b = dragonHist[dragonHist.length - 1]
  const dt = (b.t - a.t) / 50
  if (dt < 2) return { x: 0, y: 0, z: 0 }
  return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt }
}

const sight = new Map()

const STAY_R = 17

function takeoffBoxes (pos, yaw, len = 24) {
  const out = []
  for (const turn of [0, 0.6, -0.6]) {
    const a = yaw + turn
    for (let k = 0; k <= len; k += 4) {
      const p = new Vec3(pos.x + Math.sin(a) * k, pos.y + k * 0.06, pos.z + Math.cos(a) * k)
      out.push(...wingBoxes(p, a, 0.5))
    }
  }
  return out
}

let podiumCache = null

function podiumTop (bot) {
  if (podiumCache && gameClock.now() - podiumCache.t < 30000) return podiumCache.y
  const s = surfaceY(bot, CENTER.x - 0.5, CENTER.z - 0.5, 90)
  if (!s) return podiumCache ? podiumCache.y : null
  // верх столба — бедрок: над ним бывает чужое (кровать R, блок) — тогда ниже, до 4 блоков (rs6-s3: P 66 вместо 65, план R пуст)
  let y = s.y
  if (s.name !== 'bedrock') {
    for (let k = 1; k <= 4; k++) { const b = bot.blockAt(new Vec3(Math.floor(CENTER.x - 0.5), s.y - 1 - k, Math.floor(CENTER.z - 0.5))); if (b && b.name === 'bedrock') { y = s.y - k; break } }
  }
  podiumCache = { y, t: gameClock.now() }
  return y
}

function inCharge (ch, feet) {
  const ax = ch.target.x - ch.from.x; const az = ch.target.z - ch.from.z
  const L = Math.hypot(ax, az) || 1
  const ux = ax / L; const uz = az / L
  const rx = feet.x - ch.from.x; const rz = feet.z - ch.from.z
  const along = rx * ux + rz * uz
  if (along < -5 || along > L + 15) return false
  const side = Math.abs(rx * uz - rz * ux)
  if (side > 11) return false
  const lineY = ch.from.y + (ch.target.y - ch.from.y) * Math.min(1, Math.max(0, along / L))
  return feet.y > lineY - 5.8 && feet.y < lineY + 4
}

function cloudAgeMs (c) {
  if (!c || !c.e) return 0
  const t = cloudBorn.get(c.e.id)
  return t ? gameClock.now() - t : 5000
}

function straightWalkable (bot, from, to, zones = null) {
  const dx = to.x - from.x; const dz = to.z - from.z
  const len = Math.hypot(dx, dz)
  let y = Math.floor(from.y + 0.01)
  let prev = from
  for (let s = 0.5; s <= len; s += 0.5) {
    const x = from.x + dx / len * s; const z = from.z + dz / len * s
    const ny = standY(bot, x, z, y, 1, 3)
    if (ny == null) return false
    if (ny > y + 1) return false
    if (ny > y && !headroom(bot, prev, y)) return false
    if (voidBelow(bot, x, ny + 0.5, z, 12)) return false
    const cur = new Vec3(x, ny, z)
    if (zones && zones.length && stepIntoZone(zones, prev, cur)) return false
    prev = cur
    y = ny
  }
  return true
}

function headroom (bot, at, y) {
  const b = bot.blockAt(new Vec3(Math.floor(at.x), y + 2, Math.floor(at.z)))
  return !b || !isSolid(b)
}

const HOLE_TOP = 3.8

const DIGGABLE_RE = /^(end_stone|cobblestone|cobbled_deepslate|dirt|stone|netherrack|andesite|diorite|granite|tuff|blackstone)$/

function duckPlan (bot, F) {
  const p = bot.entity.position
  const fy = Math.floor(p.y + 0.01); const x = Math.floor(p.x); const z = Math.floor(p.z)
  if (fy <= F) return { dig: 0 }
  if (fy - F > 2 || Math.hypot(x + 0.5 - CENTER.x, z + 0.5 - CENTER.z) < 4.6) return null
  for (let y = F; y < fy; y++) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b || !(isAirish(b) || DIGGABLE_RE.test(b.name))) return null
  }
  if (!isSolid(bot.blockAt(new Vec3(x, F - 1, z))) || voidBelow(bot, x + 0.5, F, z + 0.5, 6)) return null
  return { dig: fy - F }
}

async function duck (bot, ctl, F) {
  const p = bot.entity.position
  const c = new Vec3(Math.floor(p.x) + 0.5, p.y, Math.floor(p.z) + 0.5)
  if (Math.hypot(p.x - c.x, p.z - c.z) > 0.15) await stepTo(bot, ctl, c, { ms: 700, sprint: false, stopAt: 0.12, clouds: false })
  await digDownTo(bot, ctl, F, 3)
  return Math.floor(bot.entity.position.y + 0.01) <= F
}

function awayFromHead (d, parts, feet, dist) {
  const ax = parts.dir.x; const az = parts.dir.z
  const rx = feet.x - d.position.x; const rz = feet.z - d.position.z
  const along = rx * ax + rz * az
  const px = rx - along * ax; const pz = rz - along * az
  const pl = Math.hypot(px, pz)
  let ux; let uz
  if (along > HEAD_AHEAD + 0.5 && pl < 1.5) { ux = ax; uz = az } else if (pl > 0.3) { ux = px / pl; uz = pz / pl } else { ux = -ax; uz = -az }
  return feet.offset(ux * dist, 0, uz * dist)
}

module.exports = { nearEdge, straightOut, surfaceY, standY, cageBars, crystalsOf, overCloud, inClouds, breathOf, lookGuard, stareFilter, fallGuard, afterPositionPacket, aboveCloudY, FB_ALARM_R, fireballAlarm, cloudReflex, hitBy, r1, doing, hunters, angryEndermen, unembed, embeddedNow, pickSpot, fastTower, hasEffect, potionItem, usePotion, healRaw, nearPillar, wingBoxes, dragonHist, dragonVel, sight, STAY_R, takeoffBoxes, podiumCache, podiumTop, inCharge, cloudAgeMs, straightWalkable, headroom, HOLE_TOP, DIGGABLE_RE, duckPlan, duck, awayFromHead }
