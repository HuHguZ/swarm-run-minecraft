'use strict'
import * as gameClock from './game-clock'
// Копьё (новое в 1.21.11; PVP-RESEARCH б.9, в.8; просьба 2026-09-26: «все
// приёмы про-игроков, по максимуму того, что даёт версия»).
//
// Код игры — декомпилированный клиент 1.21.11 (github extremeheat/
// extracted_minecraft_data, ветка client1.21.11, пути от net/minecraft/):
//  * world/item/Item.Properties.spear: ATTACK_RANGE = AttackRange(min 2.0,
//    max 4.5, запас хитбокса 0.125); MINIMUM_ATTACK_CHARGE 1.0; скорость атаки
//    1/время взмаха (дерево 0.65 с … незерит 1.15 с); урон 0 + бонус материала
//    к базовой 1 игрока (world/item/ToolMaterial); USE_EFFECTS(can_sprint, 1.0) —
//    «использовать» не режет ход и не гасит спринт; KINETIC_WEAPON(контакт 10
//    тиков, задержка, окна сбить/отбросить/урон, множитель урона);
//  * укол — не удар по сущности: ванильный клиент при копье в руке шлёт
//    ServerboundPlayerActionPacket STAB (действие 7, BlockPos.ZERO, DOWN) вместо
//    атаки (Minecraft.startAttack → MultiPlayerGameMode.piercingAttack), и
//    мы — так же: use_entity с копьём ванильный клиент не шлёт вовсе;
//  * сервер (ServerGamePacketListenerImpl.handlePlayerAction STAB): отказ, если
//    cannotAttackWithItem(копьё, 5) — заряд (t + 5)/T < 1.0; иначе
//    PiercingWeapon.attack — луч от глаз по ВЗГЛЯДУ сервера (позиция и поворот
//    последнего пакета движения) от 2.0 до 4.5 + max(0, своё смещение · взгляд),
//    бьёт всех на луче (ProjectileUtil.getHitEntitiesAlong), блоки обрывают;
//    onAttack обнуляет заряд;
//  * разгон (KineticWeapon.damageEntities каждый тик «использования» после
//    задержки): урон 1 + floor(отн. скорость × множитель), отн. скорость — моя
//    вдоль взгляда минус его вдоль моего взгляда, блоки в секунду (getKnownSpeed
//    × 20); урон, если отн. ≥ 4.6; отброс, если моя ≥ 5.1; одну цель — раз в 10
//    тиков;
//  * до 60 тиков после входа и возрождения сервер действия игнорирует, пока клиент
//    не скажет player_loaded (read.installLoaded).

const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep } from './movement'
import { allyOnSpearRay } from './combat/ally-safety'

const TICK_MS = 50
const EYE = 1.62
const MIN_R = 2.0
const MAX_R = 4.5
const MARGIN = 0.125
// Items.java 1.21.11: spear(материал, время взмаха, множитель разгона, задержка,
// сбить: окно/скорость, отброс: окно/скорость, урон: окно/отн. скорость).
// bonus — ToolMaterial.attackDamageBonus: укол = 1 + bonus.
const SPEARS = {
  wooden_spear: { swing: 0.65, mult: 0.7, delay: 0.75, bonus: 0, dmgWin: 15 },
  stone_spear: { swing: 0.75, mult: 0.82, delay: 0.7, bonus: 1, dmgWin: 13.75 },
  copper_spear: { swing: 0.85, mult: 0.82, delay: 0.65, bonus: 1, dmgWin: 12.5 },
  iron_spear: { swing: 0.95, mult: 0.95, delay: 0.6, bonus: 2, dmgWin: 11.25 },
  golden_spear: { swing: 0.95, mult: 0.7, delay: 0.7, bonus: 0, dmgWin: 13.75 },
  diamond_spear: { swing: 1.05, mult: 1.075, delay: 0.5, bonus: 3, dmgWin: 10 },
  netherite_spear: { swing: 1.15, mult: 1.2, delay: 0.4, bonus: 4, dmgWin: 8.75 }
}
const KB_SPEED = 5.1 // бл/с — отброс при разгоне
const DMG_REL = 4.6 // бл/с — урон при разгоне

function isSpear (name) { return !!SPEARS[name] }
// Лучшее копьё: по урону укола, при равенстве — по множителю разгона.
function spearOf (bot) {
  install(bot)
  let best = null
  for (const it of bot.inventory.items()) {
    const s = SPEARS[it.name]
    if (!s) continue
    const score = s.bonus * 10 + s.mult
    if (!best || score > best.score) best = { item: it, score, spec: s }
  }
  return best
}
// Тиков до полного заряда: T = 20 / скорость атаки = 20 × время взмаха.
function chargeTicks (name) { const s = SPEARS[name]; return s ? Math.round(s.swing * 20) : 20 }

// Луч от глаз по направлению dir: где он входит в раздутую на MARGIN рамку цели
// (null — мимо). Метод плит.
function rayBox (eye, dir, e, grow = MARGIN) {
  const hw = (e.width || 0.6) / 2 + grow
  const h = (e.height || 1.8)
  const p = e.position
  const lo = [p.x - hw, p.y - grow, p.z - hw]
  const hi = [p.x + hw, p.y + h + grow, p.z + hw]
  const o = [eye.x, eye.y, eye.z]
  const d = [dir.x, dir.y, dir.z]
  let t0 = -Infinity; let t1 = Infinity
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo[i] || o[i] > hi[i]) return null; continue }
    let a = (lo[i] - o[i]) / d[i]; let b = (hi[i] - o[i]) / d[i]
    if (a > b) { const t = a; a = b; b = t }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b)
    if (t0 > t1) return null
  }
  return { tIn: t0, tOut: t1 }
}
function dirOf (yaw, pitch) { return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) } }

// Куда смотреть, чтобы луч копья прошёл через него: в середину туловища.
function aimAt (bot, e) {
  const eye = (require('./pick') as typeof import('./pick')).eyeOf(bot)
  const box = (require('./pick') as typeof import('./pick')).hitboxOf(bot, e)
  const c = e.position.offset(0, box.h * 0.55, 0)
  const dx = c.x - eye.x; const dy = c.y - eye.y; const dz = c.z - eye.z
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), dist: Math.hypot(dx, dy, dz) }
}
// Достанет ли укол отсюда: отрезок луча [2.0, 4.5 + fwd] пересекает рамку цели
// (или начало отрезка внутри неё), блоков на пути нет.
function jabReach (bot, e, fwd = 0) {
  if (!bot.entity || !e || !e.position) return { ok: false }
  const eye = (require('./pick') as typeof import('./pick')).eyeOf(bot)
  const a = aimAt(bot, e)
  const dir = dirOf(a.yaw, a.pitch)
  const body = { ...e, height: (require('./pick') as typeof import('./pick')).hitboxOf(bot, e).h }
  const hit = rayBox(eye, dir, body)
  if (!hit) return { ok: false, why: 'мимо луча' }
  const v = bot.entity.velocity || { x: 0, y: 0, z: 0 }
  const maxT = MAX_R + Math.max(0, fwd, dir.x * v.x + dir.y * v.y + dir.z * v.z)
  if (allyOnSpearRay(bot, eye, new Vec3(dir.x, dir.y, dir.z), MIN_R, maxT)) return { ok: false, why: 'союзник на луче копья' }
  // Начало отрезка (2.0) должно быть внутри самой рамки или до неё: запас 0.125
  // сервер добавляет только лучу, входящему снаружи (ProjectileUtil.
  // getManyEntityHitResult: contains(start) или clip) — замер: с 1.4 бл. мимо.
  const bare = rayBox(eye, dir, body, 0)
  if (!bare || bare.tOut < MIN_R + 0.05) return { ok: false, close: true, why: 'ближе 2 блоков — укол не достаёт' }
  if (hit.tIn > maxT) return { ok: false, far: true, why: 'дальше 4.5' }
  try {
    const wall = bot.world.raycast(eye, new Vec3(dir.x, dir.y, dir.z), Math.max(MIN_R, hit.tIn), b => b && b.boundingBox === 'block')
    if (wall) return { ok: false, why: 'блок на луче' }
  } catch {}
  return { ok: true, t: Math.max(MIN_R, hit.tIn), aim: a }
}

// Сделать fn сразу после пакета позиции этого тика (как mace.afterPacket).
function afterPacket (bot, fn) {
  let done = false
  const run = () => {
    if (done) return
    done = true
    bot.removeListener('physicsTick', run)
    try { fn() } catch {}
  }
  bot.prependListener('physicsTick', run)
  setImmediate(run)
}

// Часы заряда копья: от смены предмета (melee.js ведёт resetAt по тикам) и от
// своего укола (STAB обнуляет заряд на сервере — Player.onAttack).
function install (bot) {
  if (bot._ndSpear) return bot._ndSpear
  const S = { lastJab: 0, jabs: 0, hits: 0 }
  bot._ndSpear = S
  const guard = () => {
    if (!bot.entity || bot.health <= 0 || !isSpear(bot.heldItem?.name)) return
    const use = bot._ndUse?.cur
    // Mineflayer clears usingHeldItem on any entity_status, even a foreign
    // hurt/death. Our own held-use receipt survives until our actual use ends.
    if (use ? use.hand !== 0 || use.name !== bot.heldItem.name : !bot.usingHeldItem) return
    if (!teamSafe(bot)) bot.deactivateItem()
  }
  Object.defineProperty(guard, '_ndLatePacketAim', { value: true })
  bot.on?.('physicTick', guard)
  bot.once?.('end', () => bot.removeListener('physicTick', guard))
  return S
}
function teamSafe(bot, yaw = bot.entity?.yaw, pitch = bot.entity?.pitch) {
  if (!(bot._ndSwarmAllies?.length || bot.teamMap?.[bot.username || bot.entity?.username]?.team)) return true
  if (!bot.entity || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return false
  const pick: typeof import('./pick') = require('./pick'), eye = pick.eyeOf(bot), dir = dirOf(yaw, pitch)
  const v = bot.entity.velocity || { x: 0, y: 0, z: 0 }
  return !allyOnSpearRay(bot, eye, new Vec3(dir.x, dir.y, dir.z), MIN_R, MAX_R + Math.max(0, dir.x * v.x + dir.y * v.y + dir.z * v.z))
}
function readyIn (bot, name) {
  const S = install(bot)
  const M = bot._ndMelee
  const msPerTick = (M && M.msPerTick) || TICK_MS
  const from = Math.max(S.lastJab, (M && M.resetAt) || 0)
  return Math.max(0, from + chargeTicks(name) * msPerTick + 60 - gameClock.now())
}

// Укол: взгляд на тике физики (уйдёт в пакете позиции этого тика), после пакета —
// STAB и взмах, как у ванильного клиента.
function jab (bot, e, { abortIf = null }: any = {}) {
  return new Promise<any>(resolve => {
    const S = install(bot)
    const held = bot.heldItem
    if (!held || !isSpear(held.name)) return resolve({ ok: false, why: 'копья нет в руке' })
    let done = false
    const onT = () => {
      if (done) return
      done = true
      gameClock.clearTimeout(timer)
      bot.removeListener('physicsTick', onT)
      if (abortIf?.() || e.isValid === false) return resolve({ ok: false, why: 'укол прерван' })
      const jr = jabReach(bot, e)
      if (!jr.ok) return resolve({ ok: false, why: jr.why })
      bot.look(jr.aim.yaw, jr.aim.pitch, true).catch(() => {})
      afterPacket(bot, () => {
        if (abortIf?.() || e.isValid === false || !teamSafe(bot) || !jabReach(bot, e).ok) return resolve({ ok: false, why: 'цель ушла или союзник на луче' })
        try {
          bot._client.write('block_dig', { status: 7, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 })
          bot.swingArm('right')
        } catch {}
        S.lastJab = gameClock.now()
        S.jabs++
        resolve({ ok: true, dist: Math.round(jr.t * 10) / 10 })
      })
    }
    bot.on('physicsTick', onT)
    const timer = gameClock.setTimeout(() => { if (!done) { done = true; bot.removeListener('physicsTick', onT); resolve({ ok: false, why: 'физика стоит' }) } }, 400)
  })
}

// Разгон: «использовать» копьё и спринт на него; урон сервер считает сам каждый
// тик после задержки. Держим, пока он в луче не получил удар, или maxMs.
// 2026-09-26 (арена «копья»: разгон мимо в половине случаев): урон — только
// пока его рамка на луче 2.0–4.5 от глаз (KineticWeapon.damageEntities →
// ProjectileUtil.getHitEntitiesAlong по AttackRange копья) и отн. скорость
// ≥ 4.6 бл/с (Condition.test: minRelativeSpeed); начатый ближе нужного разгон
// проскакивал его: задержка (delay_ticks) кончалась, когда он был уже ближе
// 2 бл. Когда начинать — chargeWindow ниже; здесь — бросить сразу, как окно
// упущено: проскочили (ближе 2 без попадания) или он уходит быстрее, чем
// догоняем (отн. скорость < 4.6 четыре тика подряд).
async function charge (bot, ctl, e, { maxMs = 2200, onHit = null, safe = null, vel = null }: any = {}) {
  install(bot)
  const held = bot.heldItem
  if (!held || !isSpear(held.name)) return { ok: false, why: 'копья нет в руке' }
  const spec = SPEARS[held.name]
  let hit = false
  let why = null
  let slow = 0
  const onHurt = (victim, src) => { if (victim?.id === e.id && src && bot.entity && src.id === bot.entity.id) { hit = true; if (onHit) { try { onHit() } catch {} } } }
  bot.on('entityHurt', onHurt)
  const t0 = gameClock.now()
  const delayMs = spec.delay * 1000
  bot.activateItem()
  try {
    while (gameClock.now() - t0 < maxMs && !(ctl && ctl.aborted) && e.isValid !== false) {
      const a = aimAt(bot, e)
      if (!teamSafe(bot, a.yaw, Math.abs(a.pitch) > 0.2 ? a.pitch : 0)) { why = 'союзник на луче копья'; break }
      await bot.look(a.yaw, Math.abs(a.pitch) > 0.2 ? a.pitch : 0, true).catch(() => {})
      const f = safe ? safe('forward') : true
      bot.setControlState('forward', f)
      bot.setControlState('sprint', f && (bot.food ?? 20) > 6)
      const el = gameClock.now() - t0
      if (hit && el > delayMs) break
      if (!hit && el > delayMs + 100 && bot.entity) {
        const eye = bot.entity.position.offset(0, EYE, 0)
        const bare = rayBox(eye, dirOf(a.yaw, 0), e, 0)
        if (!bare || bare.tOut < MIN_R) { why = 'проскочил'; break }
        // Отн. скорость вдоль взгляда (бл/тик): моя минус его.
        const dir = dirOf(a.yaw, 0)
        const mv = bot.entity.velocity
        const hv = vel ? vel() : { x: 0, z: 0 }
        const rel = (mv.x * dir.x + mv.z * dir.z) - (hv.x * dir.x + hv.z * dir.z)
        if (rel < DMG_REL / 20) { if (++slow >= 4) { why = 'уходит быстрее'; break } } else slow = 0
      }
      await sleep(TICK_MS)
    }
  } finally {
    bot.deactivateItem()
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    bot.removeListener('entityHurt', onHurt)
  }
  return { ok: true, hit, ms: gameClock.now() - t0, why }
}

// Когда начинать разгон (2026-09-26): рамка его должна войти в луч 2.0–4.5
// ПОСЛЕ задержки (delay_ticks копья, Items.java: spear(…, delay…)) плюс тик
// пакета. r — от наших глаз до его рамки; мы разгоняемся в среднем до ~0.25
// бл/тик за задержку (спринт 0.28, земля 0.546/тик), он идёт на нас towardMe
// бл/тик. Где он будет к концу задержки: r − (0.25 + towardMe)·ticks — в
// 2.5–4.3, иначе не начинать. Уходит от нас — урона не будет (отн. скорость).
function chargeWindow (name, r, towardMe) {
  const s = SPEARS[name]
  if (!s) return null
  if (towardMe < -0.03) return null
  const ticks = Math.round(s.delay * 20) + 2
  const at = r - (0.25 + Math.max(0, towardMe)) * ticks
  if (at < 2.5 || at > 4.3) return null
  return { at: Math.round(at * 10) / 10, ticks }
}

export { SPEARS, isSpear, spearOf, chargeTicks, jabReach, jab, charge, chargeWindow, readyIn, install, teamSafe, rayBox, afterPacket, KB_SPEED, DMG_REL, MIN_R, MAX_R }
