'use strict'
// Страж Ада (ne-guard.ts): отбить шар гаста ударом.
import { Vec3 } from 'vec3'
import * as gameClock from '../game-clock'
import { log } from './foes'


// Шар гаста — отбить ударом: Player.deflectProjectile (1.21.11) уводит снаряд с тегом redirectable_projectile по взгляду
// ударившего (ProjectileDeflection.AIM_DEFLECT: скорость = getLookAngle), отражённый шар гаст не переживает (Ghast.hurtServer).
// Шар летит сам (AbstractHurtingProjectile.tick: v = (v + норм(v)·0.1)·0.95, затем pos += v), а сервер шлёт его позицию раз
// в 10 тиков (EntityType.FIREBALL updateInterval 10): mineflayer видит шар там, где тот был до 10 тиков назад (до 13 бл.), и
// удар «по памяти» прицел (pick.ts) не пропускал. Клиент игры ведёт шар сам — и здесь: скорость из пакета появления (lpVec3,
// drops.velocityFromRaw), шаг на каждый тик тела, поправка по пакетам позиции и скорости; e.position — где шар сейчас.
// Взгляд — в тик, когда шар на следующем шаге в досягаемости прицела (3 бл., pick.RANGE) и ещё не коснётся тела, удар — тиком
// позже (взгляд уходит пакетом движения в конце тика, удар — сразу). Щит перед ударом опускается: клиент игры, держа предмет,
// клики атаки съедает (Minecraft.handleKeybinds). По умолчанию включено (ND_GHAST_SWAT=0 — выкл.): сброс шаром гаста в лаву —
// первая по частоте смерть лаборатории Ада (агент Ада 14.10: b6 — 3 из 9).
const FB_ACCEL = 0.1
const FB_INERTIA = Math.fround(0.95)
function fbStep (s) {
  const n = Math.hypot(s.vx, s.vy, s.vz) || 1
  s.vx = (s.vx + s.vx / n * FB_ACCEL) * FB_INERTIA
  s.vy = (s.vy + s.vy / n * FB_ACCEL) * FB_INERTIA
  s.vz = (s.vz + s.vz / n * FB_ACCEL) * FB_INERTIA
  s.x += s.vx; s.y += s.vy; s.z += s.vz
  return s
}
// От глаз до рамки прицела шара: 1×1 (позиция сущности — низ середины), раздута на getPickRadius 1.0 (Projectile.isPickable —
// redirectable_projectile, 1.21.11): прицел клиента берёт шар на блок раньше его рамки — удар на тик раньше, до касания тела.
function fbReach (eye, s) {
  return Math.hypot(Math.max(s.x - 1.5 - eye.x, 0, eye.x - s.x - 1.5), Math.max(s.y - 1 - eye.y, 0, eye.y - s.y - 2),
    Math.max(s.z - 1.5 - eye.z, 0, eye.z - s.z - 1.5))
}
// Летит ли шар в тело: ближайший подход его линии к середине тела — в 2 бл.
function fbIncoming (s, me) {
  const sp = Math.hypot(s.vx, s.vy, s.vz)
  if (sp < 1e-3) return false
  const rx = me.x - s.x, ry = me.y + 0.9 - s.y, rz = me.z - s.z
  const t = (rx * s.vx + ry * s.vy + rz * s.vz) / sp
  return t > 0 && Math.hypot(rx - s.vx / sp * t, ry - s.vy / sp * t, rz - s.vz / sp * t) <= 2
}
// shortcut: constant observed ghast velocity through this return flight; re-aim from later shots if it turns.
function fbReturnAim (bot, s, g, velocity, lagTicks) {
  const pick: typeof import('../pick') = require('../pick')
  const eye = pick.eyeOf(bot), origin = new Vec3(s.x, s.y, s.z)
  const height = g.height || 4, half = (g.width || 4) / 2
  let speed = 1, travelled = 0
  for (let ticks = 1; ticks <= 64; ticks++) {
    speed = (speed + FB_ACCEL) * FB_INERTIA
    travelled += speed
    const time = ticks + lagTicks
    const target = g.position.offset(velocity.x * time, height / 2 + velocity.y * time, velocity.z * time)
    const delta = target.minus(origin), distance = delta.norm()
    if (distance < 1e-6 || travelled < distance) continue
    const dir = delta.scaled(1 / distance)
    const t = pick.rayBox(eye, dir, { x: s.x - 1.5, y: s.y - 1, z: s.z - 1.5 },
      { x: s.x + 1.5, y: s.y + 2, z: s.z + 1.5 }, pick.RANGE)
    if (t == null || pick.blockOnRay(bot, eye, dir, t)) return null
    const end = pick.rayBox(origin, dir, { x: target.x - half, y: target.y - height / 2, z: target.z - half },
      { x: target.x + half, y: target.y + height / 2, z: target.z + half }, distance)
    if (end == null || pick.blockOnRay(bot, origin, dir, end)) return null
    // AIM_DEFLECT takes the player's look, but launches at the projectile position.
    return eye.plus(dir.scaled(distance))
  }
  return null
}
export function swatInstall (bot) {
  if (!bot || bot._ndSwat || typeof bot.on !== 'function') return bot && bot._ndSwat
  const st = { pend: null, n: 0, back: 0, fb: new Map(), rawVel: new Map(), ghasts: new Map(), type: null }
  bot._ndSwat = st
  try { st.type = bot.registry.entitiesByName.fireball.id } catch {}
  const show = s => { const e = bot.entities && bot.entities[s.id]; if (e && e.position && typeof e.position.set === 'function') e.position.set(s.x, s.y, s.z) }
  const cl = bot._client
  if (cl && typeof cl.on === 'function' && st.type != null) {
    const raw = (require('../drops') as typeof import('../drops')).velocityFromRaw
    // Сырые байты есть только в 'packet', и он приходит раньше события по имени (drops.ts).
    cl.on('packet', (data, meta, buf) => {
      if (!meta || !data) return
      if (meta.name === 'spawn_entity' && data.type === st.type) st.rawVel.set(data.entityId, raw(buf, 'spawn'))
      else if (meta.name === 'entity_velocity' && st.fb.has(data.entityId)) st.rawVel.set(data.entityId, raw(buf, 'velocity'))
    })
    cl.on('spawn_entity', data => {
      if (data.type !== st.type) return
      const v = st.rawVel.get(data.entityId) || { x: 0, y: 0, z: 0 }
      st.rawVel.delete(data.entityId)
      st.fb.set(data.entityId, { id: data.entityId, bx: data.x, by: data.y, bz: data.z, x: data.x, y: data.y, z: data.z, vx: v.x, vy: v.y, vz: v.z, hitAt: 0 })
    })
    cl.on('entity_velocity', data => {
      const s = st.fb.get(data.entityId)
      const v = st.rawVel.get(data.entityId)
      st.rawVel.delete(data.entityId)
      if (!s || !v) return
      const me = bot.entity && bot.entity.position
      if (s.hitAt > 0 && me && gameClock.now() - s.hitAt < 1000 && v.x * (s.x - me.x) + v.y * (s.y - me.y - 0.9) + v.z * (s.z - me.z) > 0) {
        st.back++
        log('шар гаста: отбит', { back: st.back, of: st.n })
        s.hitAt = -1
      }
      Object.assign(s, { vx: v.x, vy: v.y, vz: v.z })
    })
    cl.on('sync_entity_position', data => {
      const s = st.fb.get(data.entityId)
      if (!s) return
      Object.assign(s, { bx: data.x, by: data.y, bz: data.z, x: data.x, y: data.y, z: data.z })
      if ([data.dx, data.dy, data.dz].every(Number.isFinite)) Object.assign(s, { vx: data.dx, vy: data.dy, vz: data.dz })
      show(s)
    })
    // Сдвиг — от прошлой позиции сервера: mineflayer прибавил его к e.position, то есть к нашей.
    const rel = data => {
      const s = st.fb.get(data.entityId)
      if (!s) return
      s.bx += (data.dX || 0) / 4096; s.by += (data.dY || 0) / 4096; s.bz += (data.dZ || 0) / 4096
      Object.assign(s, { x: s.bx, y: s.by, z: s.bz })
      show(s)
    }
    cl.on('rel_entity_move', rel)
    cl.on('entity_move_look', rel)
    cl.on('entity_destroy', data => { for (const id of data.entityIds || []) { st.fb.delete(id); st.rawVel.delete(id) } })
  }
  bot.on('respawn', () => { st.fb.clear(); st.rawVel.clear(); st.ghasts.clear(); st.pend = null })
  const onTick = () => {
    try {
      if (!st.fb.size) { st.ghasts.clear(); st.pend = null; return }
      for (const s of st.fb.values()) {
        if (!bot.entities[s.id]) { st.fb.delete(s.id); continue }
        fbStep(s)
        show(s)
      }
      if (process.env.ND_GHAST_SWAT === '0' || !bot.entity) return
      const pick: typeof import('../pick') = require('../pick')
      const eye = pick.eyeOf(bot)
      const me = bot.entity.position
      const now = gameClock.now()
      const ghasts = (Object.values(bot.entities) as any[]).filter(g => g?.name === 'ghast' && g.position && g.isValid !== false &&
        g.position.distanceTo(me) <= 64 && !!pick.aim(bot, g, { range: 66 })?.point)
      const visible = new Set(ghasts.map(g => g.id))
      for (const id of st.ghasts.keys()) if (!visible.has(id)) st.ghasts.delete(id)
      for (const g of ghasts) {
        const prev = st.ghasts.get(g.id), receipt = g._ndPositionReceipts?.[1]
        if (prev && prev.receipt === receipt && prev.position.equals(g.position)) continue
        const dt = prev ? (now - prev.at) / 50 : 0
        const velocity = dt > 0 && dt <= 10 ? g.position.minus(prev.position).scaled(1 / dt) : new Vec3(0, 0, 0)
        st.ghasts.set(g.id, { position: g.position.clone(), at: now, receipt, velocity })
      }
      if (st.pend) {
        const s = st.fb.get(st.pend.id)
        const e = bot.entities[st.pend.id]
        if (!s || !e || fbReach(eye, s) > pick.RANGE) { st.pend = null; return }
        // Взгляд ещё не ушёл пакетом или щит снова поднят (тактика Shield) — ударить следующим тиком, пока шар в досягаемости.
        if (!st.pend.looked || bot.usingHeldItem) { st.pend.looked = false; return }
        const { ghast, ghastId } = st.pend
        st.pend = null
        const blocked = bot._ndBlockedHits || 0
        bot.attack(e)
        if ((bot._ndBlockedHits || 0) !== blocked) return
        s.hitAt = gameClock.now()
        st.n++
        log('шар гаста: удар', { n: st.n, d: +fbReach(eye, s).toFixed(2), ghast, ghastId, blocked: bot._ndBlockedHits || 0 })
        return
      }
      let best = null
      for (const s of st.fb.values()) {
        if (s.hitAt || !fbIncoming(s, me)) continue
        const n = fbStep({ ...s })
        const d = fbReach(eye, n)
        if (d > pick.RANGE - 0.1) continue
        // Шагом позже уже в рамке тела, раздутой на 0.3 (ProjectileUtil.getEntityHitResult) — поздно.
        if (Math.abs(n.x - me.x) < 0.6 && Math.abs(n.z - me.z) < 0.6 && n.y > me.y - 0.3 && n.y < me.y + 2.1) continue
        if (!best || d < best.d) best = { s, n, d }
      }
      if (!best) return
      // Шар уже в радиусе взрыва (LargeFireball explosionPower 1 → урон сущностям в 2 бл., ServerExplosion radius·2), а щит поднят
      // и смотрит на шар — держать щит: он берёт и удар шара, и взрыв спереди; удар по шару в 1.3–1.8 бл. стоил −7.6 хп (blz
      // bz11-s17-1). Щит не поднят — бить, как прежде: прямое попадание (6 + взрыв вплотную) дороже. ND_SWAT_SHIELD_NEAR=0 — прежнее.
      if (process.env.ND_SWAT_SHIELD_NEAR !== '0') {
        const cd = Math.hypot(best.n.x - me.x, best.n.y + 0.5 - (me.y + 0.9), best.n.z - me.z)
        const SH: typeof import('../combat/shield') = require('../combat/shield')
        if (cd < 2.5 && SH.shieldUp(bot) && SH.facingCos(bot, new Vec3(best.n.x, best.n.y, best.n.z)) > 0.3) {
          best.s.hitAt = -4
          log('шар гаста: близко — держу щит', { cd: +cd.toFixed(2) })
          return
        }
      }
      const c = new Vec3(best.n.x, best.n.y + 0.5, best.n.z)
      let aimAt = c, ghastId = null
      for (const g of ghasts) {
        const motion = st.ghasts.get(g.id)
        const age = (now - motion.at) / 50
        const velocity = age <= 10 ? motion.velocity : new Vec3(0, 0, 0)
        const aim = fbReturnAim(bot, best.n, g, velocity, 1 + age)
        if (aim) { aimAt = aim; ghastId = g.id; break }
      }
      // К гасту чистого пути нет — отбитый шар летит по взгляду и рвётся о ближнюю стену: взрыв «от игрока» злит зомби-пиглинов и
      // пиглинов рядом (c94-int3-s20: «отбит 4 из 5», шар NeuroFarm9 −6, орда зомби-пиглинов 8 + 8 + 4). Есть мирные свиночеловеки
      // в 16 — отбить вверх, в небо (сервер берёт удар по досягаемости, направление — взгляд: ProjectileDeflection.AIM_DEFLECT).
      // ND_SWAT_UP=1 (поток ne 21.10, выкл.).
      if (ghastId == null && process.env.ND_SWAT_UP === '1' && (Object.values(bot.entities || {}) as any[]).some((e: any) => e && e.position &&
          /^(zombified_piglin|piglin)$/.test(e.name || '') && e.position.distanceTo(me) <= 16)) {
        const pick: typeof import('../pick') = require('../pick')
        const eye = pick.eyeOf(bot), h = Math.hypot(c.x - eye.x, c.z - eye.z) || 1
        aimAt = eye.offset((c.x - eye.x) / h, 4, (c.z - eye.z) / h)
      }
      st.pend = { id: best.s.id, ghast: ghastId != null, ghastId, aim: aimAt, looked: false }
    } catch {}
  }
  // Взгляд — на поздней границе тика (physicTick, прямо перед пакетом движения): навык и pathfinder ставят свой взгляд в
  // physicsTick, и удар уходил по их взгляду — шар отлетал не к гасту, а под ноги (b8-7-1 14.10: 10 ударов, 0 отбитых, хп 20 → 9).
  const late = () => {
    try {
      if (!st.pend || st.pend.looked || !bot.entity) return
      if (bot.usingHeldItem) { try { bot.deactivateItem() } catch {} }
      const d = st.pend.aim.minus((require('../pick') as typeof import('../pick')).eyeOf(bot))
      bot.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)), true).catch(() => {})
      st.pend.looked = true
    } catch {}
  }
  Object.defineProperty(late, '_ndLatePacketAim', { value: true })
  bot.on('physicsTick', onTick)
  bot.on('physicTick', late)
  return st
}
