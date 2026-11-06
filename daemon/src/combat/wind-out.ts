// Реактивный сброс зарядом ветра (пользователь 24.10: «зарядами ветра выкидывать врага с арены»). Каждый бот решает сам,
// по своим глазам, каждый второй тик: видимый враг — если брошу сейчас, вылетит ли он за
// край / ниже линии смерти, даже рулящий назад к центру. Да — бросок рядом с текущим боем (wind_out, не эксклюзивно).
// Цепочка складывается без общего расписания: следующий бот видит уже изменённую скорость цели и считает свой бросок от
// неё (общий график по RPC разъезжался на 1–2 тика между процессами — auto-log 24.10 04:47…07:06).
// Физика — та же, что у роевой цепи: enemy-wind (WindCharge 1.21.11, ServerExplosion, сопротивление по видимой броне).
import * as clock from '../game-clock'
import * as hands from '../mace/hands'
import { worldTick, arenaRoom, useWindAtAngle, windOutward, type WindArena, type WindReport } from './team-wind'
import { planEnemyWind, enemyWindFrames, enemyWindShot, windTeamSafe, windAllyTailSafe, windImpactKey, pendingWindHit, observeOwnWindBurst, installWindTracking, windMotionFresh, windGroundObservationExpired, windCollisionWorld } from './enemy-wind'
import { isAlly } from './ally-safety'
import { WIND_CD_MS } from '../mace/consts'
import { seesPlayer } from '../pvp/last-seen'
import { observedCollision } from '../pvp/search'
import edges = require('../edges')
import * as pick from '../pick'
import { WIND_BID_RELEASE_MS, WIND_BID_REPLY_TICKS, windOrder, type WindBidFinish, type WindRadio } from './wind-coordination'
const tw = () => require('./team-wind') as typeof import('./team-wind')
// Скорость чужого тела — по наблюдённым позициям: сырой entity.velocity — из редких пакетов entity_velocity (см. enemy-wind enemyView).
const seenV = (e: any) => (require('../bow/track') as typeof import('../bow/track')).observedVelocity(e) || e.velocity

// Only visibility and the native trajectory decide whether a hostile throw is possible.

export function edgeRoom(arena: WindArena, p: { x: number; z: number }) {
  return arenaRoom(arena, p)
}

/** Height of the feet above the first known support below (up to 40 blocks); Infinity — nothing seen under him. */
export function heightAbove(bot: any, p: { x: number; y: number; z: number }) {
  const { Vec3 }: typeof import('vec3') = require('vec3')
  for (let dy = 0; dy <= 40; dy++) {
    const b = bot.blockAt(new Vec3(p.x, p.y - dy - .01, p.z), false)
    if (b && b.boundingBox === 'block') return p.y - (Math.floor(p.y - dy - .01) + 1)
  }
  return Infinity
}

/** A visible survival foe at least 2 blocks below and within 6 horizontally — the mace descent target. */
export function maceTarget(bot: any, me: { x: number; y: number; z: number }) {
  return (Object.values(bot.players || {}) as any[]).map(pl => pl?.entity).find(e => e?.position && e !== bot.entity && e.username &&
    !isAlly(bot, e) && bot.players[e.username]?.gamemode === 0 && e.position.y < me.y - 2 &&
    Math.hypot(e.position.x - me.x, e.position.z - me.z) <= 6 && seesPlayer(bot, e)) || null
}

/** Every visible hostile survival/adventure body reaches the native trajectory planner. */
export function windOutCandidates(bot: any, arena: WindArena) {
  const own = bot.entity?.position
  if (!own) return []
  return (Object.values(bot.players || {}) as any[]).map(pl => pl?.entity).filter(e => e?.position && e.isValid !== false && e !== bot.entity && e.username &&
    e.username !== bot.username && !isAlly(bot, e) && bot.players[e.username]?.gamemode !== 3 && bot.players[e.username]?.gamemode !== 1 &&
    seesPlayer(bot, e))
    .sort((a, b) => edgeRoom(arena, a.position) - edgeRoom(arena, b.position))
}

// Отвод видимого таранщика: native protect rollout decides whether and when he can reach us.
// Своих — глаза меня и союзников в 10 бл. (расчёт дорогой — бросает тот, кто рядом): порыв должен увести его тело от них дальше, чем достаёт копьё (CONTACT).
const CONTACT = 3.5
function deflectTargets(bot: any, includeSmash = false) {
  const own = bot.entity?.position, sky: typeof import('../elytra/track') = require('../elytra/track')
  if (!own || bot.entity.elytraFlying) return []
  const guard = [own, ...(Object.values(bot.entities || {}) as any[]).filter(e => e?.position && e !== bot.entity && e.username && isAlly(bot, e) &&
    !sky.gliding(e) && e.position.distanceTo(own) <= 10).map(e => e.position)].map(p => p.offset(0, 1.62, 0))
  const out = []
  const enemies = (Object.values(bot.players || {}) as any[]).map(pl => pl?.entity).filter(e =>
    e?.position && e.isValid !== false && e !== bot.entity && e.username && !isAlly(bot, e) &&
    bot.players[e.username]?.gamemode !== 3 && bot.players[e.username]?.gamemode !== 1)
  const launch = includeSmash && new Set((require('../threats') as typeof import('../threats')).smashes(bot,
    enemies.filter(e => e.onGround !== true && !sky.gliding(e)).map(e => e.username)).map(s => s.name))
  for (const e of enemies) {
    if (!sky.gliding(e) && (!launch || !launch.has(e.username))) continue
    if (!seesPlayer(bot, e)) { trace('deflect:los'); continue }
    out.push({ foe: e, protect: guard })
  }
  return out
}
export function deflectDecide(bot: any, own: WindReport, arena: WindArena, lag = 0, deadline?: number, collision?: ReturnType<typeof windCollisionWorld>) {
  const now = worldTick(bot)
  if (now === null) return null
  for (const { foe, protect } of deflectTargets(bot, true)) {
    if (deadline !== undefined && clock.wall.monotonic() > deadline) return null
    const allies = alliesNear(bot, foe, now)
    const plan = planEnemyWind(bot, foe, [own], { arena, startTick: now, maxShots: 1, allies, delays: [lag], reactAfterHit: true, protect, deadline, collision })
    trace(!plan ? 'deflect:no_plan' : plan.baseline.clear >= CONTACT ? 'deflect:miss_anyway' : plan.nominal.clear < CONTACT ? 'deflect:weak' : 'deflect:planned')
    // Частичный отвод — тоже цена: в худшем исходе удар откладывается на время подъёма щита (5 т., BlocksAttacks 0.25 с) и зазор
    // растёт — шаг, щит и встречное копьё успевают.
    const full = !!plan && plan.worst.clear >= CONTACT
    const partial = !!plan && !full && plan.worst.reach - plan.baseline.reach >= 5 && plan.worst.clear > plan.baseline.clear
    if (plan && plan.shots[0].fireDelay !== lag) trace('deflect:late')
    else if (plan && plan.baseline.clear < CONTACT && !full && !partial) trace('deflect:worst_close')
    if (!plan || plan.shots[0].fireDelay !== lag || plan.baseline.clear >= CONTACT || !full && !partial) continue
    return { kind: full ? 'deflect' : 'deflect~', plan, foe, allies, shot: plan.shots[0] }
  }
  return null
}

/** Every visible ally can move into the projectile or burst before its native arrival. */
function alliesNear(bot: any, foe: any, now: number): WindReport[] {
  const sky: typeof import('../elytra/track') = require('../elytra/track')
  return (Object.values(bot.entities || {}) as any[]).filter(e => e?.position && e !== bot.entity && e.username && isAlly(bot, e) &&
    bot.players?.[e.username]?.gamemode !== 3)
    .sort((a, b) => a.position.distanceTo(foe.position) - b.position.distanceTo(foe.position)).filter(e => seesPlayer(bot, e))
    .map(a => ({ id: a.username, position: { ...a.position }, velocity: { ...seenV(a) }, onGround: !!a.onGround,
      gliding: sky.gliding(a), pitch: a.pitch || 0, yaw: a.yaw || 0, eyeHeight: pick.eyeHeight(bot, a), gameTick: now }))
}

/** Decide one own shot released THIS tick; null — nothing worth a charge. Pure: no hands, no packets. */
// Счётчик отказов (ND_WIND_TRACE=1): почему по видимому у края не бросили — для стенда ветра.
export const windTrace: Record<string, number> = {}
const trace = (k: string) => { if (process.env.ND_WIND_TRACE === '1') windTrace[k] = (windTrace[k] || 0) + 1 }
export function windOutDecide(bot: any, own: WindReport, arena: WindArena, lag = 0, deadline?: number, coordinatedTarget?: string,
  collision?: ReturnType<typeof windCollisionWorld>, visiblePrefix = false) {
  const now = worldTick(bot)
  if (now === null) return null
  for (const foe of windOutCandidates(bot, arena)) {
    if (foe.username === coordinatedTarget) continue
    if (!windMotionFresh(bot, foe)) { trace('pending_wind_observation'); continue }
    if (deadline !== undefined && clock.wall.monotonic() > deadline) { trace('late:budget'); return null }
    const allies = alliesNear(bot, foe, now)
    const plan = planEnemyWind(bot, foe, [own], { arena, startTick: now, maxShots: 1, allies, delays: [lag], reactAfterHit: true,
      juggle: !foe.onGround, deadline, waitForHit: true, collision, visiblePrefix })
    const late = plan && plan.relayPrefix === undefined && plan.shots[0].fireDelay !== lag
    trace(!plan ? 'no_plan' : plan.baseline.out ? 'already_out' : late ? 'late' : 'planned')
    // Сам и так улетает — заряд не тратить (и не толкнуть его обратно на край).
    if (!plan || plan.baseline.out || late) continue
    const kind = plan.relayPrefix !== undefined ? 'chain' : offensiveWindKind(plan, !foe.onGround)
    trace(kind ? 'kind:' + kind : `weak:${foe.onGround ? 'ground' : 'air'}`)
    if (kind) return { kind, plan, foe, allies, shot: plan.shots[0] }
  }
  return null
}
/** A charge must add outward movement, or add air without an inward effect. */
export function windKind(o: { worstOut: boolean; nominalOut: boolean; progress: number; juggle: boolean; fall?: boolean }) {
  if (o.fall) return 'fall'
  if (o.worstOut) return 'out'
  if (o.nominalOut) return 'out?'
  if (o.progress < 0) return null
  return o.juggle ? 'juggle' : o.progress > 0 ? 'chain' : null
}

function offensiveWindKind(plan: NonNullable<ReturnType<typeof planEnemyWind>>, airborne: boolean) {
  // A tied first step can still lift the body over a wall in the same simulated trajectory.
  const future = plan.nominal.progress - plan.baseline.progress
  const immediate = plan.nominal.outwardEffect !== undefined && plan.baseline.outwardEffect !== undefined
    ? plan.nominal.outwardEffect - plan.baseline.outwardEffect : future
  const progress = immediate === 0 ? future : immediate
  const juggle = airborne && plan.nominal.air > plan.baseline.air && progress >= 0
  return windKind({ worstOut: plan.worst.exited, nominalOut: plan.nominal.exited, progress, juggle, fall: plan.fallThreat })
}

// Батут и волейбол (пользователь 24.10): союзник с булавой только что подпрыгнул к врагу — заряд в пол ему под ноги к тику
// прилёта, его подбрасывает (взрыв от центра к глазам, ServerExplosion), падает он булавой (бонус от fallDistance, MaceItem).
// Враг на земле — батут, удар сверху; враг в воздухе (подброшен) — волейбол, перехват на высоте. Тело союзника бьёт само.
// Цена: без попадания союзнику падение ~6–8 бл. (3–5 хп) — поэтому только при видимом враге рядом с ним и подъёме вверх.
export function trampolineDecide(bot: any, own: WindReport) {
  const { Vec3 }: typeof import('vec3') = require('vec3')
  const tw: typeof import('./team-wind') = require('./team-wind')
  const me = bot.entity?.position
  if (!me) return null
  const foes = (Object.values(bot.players || {}) as any[]).map(pl => pl?.entity).filter(e => e?.position && e.username && e !== bot.entity &&
    !isAlly(bot, e) && bot.players[e.username]?.gamemode === 0 && e.position.distanceTo(me) <= 24)
  for (const ally of Object.values(bot.entities || {}) as any[]) {
    if (!ally?.position || ally === bot.entity || !ally.username || !isAlly(bot, ally) || ally.position.distanceTo(me) > 8) continue
    if (ally.heldItem?.name !== 'mace' && ally.equipment?.[0]?.name !== 'mace') continue
    const v = new (require('vec3').Vec3)(seenV(ally).x, seenV(ally).y, seenV(ally).z)
    // Только что оторвался от пола прыжком (0.42 → вниз по 0.08): подъём, низко над опорой.
    if (ally.onGround || !(v.y > .15 && v.y < .45) || heightAbove(bot, ally.position) > 1.3) continue
    const foe = foes.map(e => ({ e, d: Math.hypot(e.position.x - ally.position.x, e.position.z - ally.position.z) }))
      .filter(f => f.d >= 2 && f.d <= 9 && (f.e.position.x - ally.position.x) * v.x + (f.e.position.z - ally.position.z) * v.z > 0).sort((a, b) => a.d - b.d)[0]
    if (!foe || !seesPlayer(bot, ally) || !seesPlayer(bot, foe.e)) continue
    // Один заряд на прыжок: бросает ближайший к нему из своих (без общего расписания все видят одно и то же; стенд 14:06 —
    // по 3–5 зарядов в одного прыгнувшего).
    const mine = me.distanceTo(ally.position)
    if ((Object.values(bot.entities || {}) as any[]).some(o => o?.position && o !== ally && o !== bot.entity && o.username && isAlly(bot, o) &&
      o.position.distanceTo(ally.position) < mine - .3 && bot.players?.[o.username]?.gamemode === 0)) continue
    const floorY = ally.position.y - heightAbove(bot, ally.position)
    const eye = me.offset(0, 1.62, 0), movement = own.launchMovement || own.velocity
    const moved = new Vec3(movement.x, own.onGround ? 0 : movement.y, movement.z)
    // Где он будет к прилёту: баллистика игрока (тяжесть 0.08, сопротивление 0.98), горизонталь — ×0.91 в воздухе.
    let t = Math.max(1, Math.ceil(eye.distanceTo(ally.position) / tw.WIND.speed)), shot: any = null, feet: any = null
    for (let iter = 0; iter < 3; iter++) {
      let p = ally.position.clone(), w = v.clone()
      for (let k = 0; k < t; k++) { p = p.plus(w); w = new Vec3(w.x * .91, (w.y - .08) * .98, w.z * .91) }
      feet = p
      shot = tw.windShot(bot, eye, new Vec3(p.x, floorY, p.z), moved, bot.username)
      if (!shot) break
      if (shot.ticks === t) break
      t = shot.ticks
    }
    if (!shot || !feet) continue
    const kick = tw.windImpulse({ ...bot, entity: { attributes: {} } }, feet, shot.burst)
    if (kick.y < .5) continue
    return { kind: foe.e.onGround ? 'trampoline' : 'volley', ally: ally.username, foe: foe.e, shot, kick: +kick.y.toFixed(2) }
  }
  return null
}

// Выпуск в тот же тик, что и расчёт: поворот едет в самом use_item (1.21.11 ServerGamePacketListenerImpl.handleUseItem →
// absSnapRotationTo), отдельный пакет взгляда и ожидание тика не нужны — прыгающая цель за 1–2 тика уходила с прицела.
export function release(bot: any, shot: { yaw: number; pitch: number }) {
  if (hands.windCooling(bot)) return false
  const off = hands.offWind(bot), slot = hands.hotbarIndex(bot, 'wind_charge')
  if (!off && slot < 0) return false
  const back = bot.quickBarSlot
  if (!off && back !== slot) bot.setQuickBarSlot(slot)
  try {
    useWindAtAngle(bot, off, shot)
    bot.usingHeldItem = false; bot._ndWindCd = clock.now() + WIND_CD_MS
  } finally { if (!off && back !== slot) bot.setQuickBarSlot(back) }
  return true
}

export function installWindOut(session: any) {
  const bot = session.bot
  if (!bot || bot._ndWindOut) return
  hands.install(bot)
  installWindTracking(bot)
  const stats = session._windOut ||= { tries: 0, fired: 0, log: [] as any[] }
  let busy = false, closed = false, tick = 0, spawnGeneration = 0, planEma = 40, releaseEma = 40, staleTick: number | null = null
  bot._ndWindOut = true
  const newLife = () => { spawnGeneration++; staleTick = null }
  bot.on('respawn', newLife); bot.on('death', newLife)
  for (const event of ['end', 'kicked']) bot.once(event, () => { closed = true; newLife() })
  const tryTrampoline = (arena: WindArena) => {
    if (!hands.offWind(bot) && hands.hotbarIndex(bot, 'wind_charge') < 0) return
    const ex: typeof import('./enemy-wind-execute') = require('./enemy-wind-execute')
    const report = ex.enemyWindReport(session)
    if (!report.ok || !report.ready) return
    const pick = trampolineDecide(bot, report.report)
    if (!pick || !tw().windInside(pick.shot.burst, arena)) return
    busy = true
    const entry: any = { at: clock.now(), target: pick.foe.username, kind: pick.kind, ally: pick.ally, kick: pick.kick, edge: +edgeRoom(arena, pick.foe.position).toFixed(1), air: !pick.foe.onGround, progress: 0, planMs: 0 }
    const foeId = pick.foe.id
    let hurt = false
    const onHurt = (e: any) => { if (e?.id === foeId) hurt = true }
    hands.afterPacket(bot, () => {
      entry.fired = release(bot, pick.shot)
      if (!entry.fired) { busy = false; return }
      stats.fired++
      bot.on('entityHurt', onHurt)
      let left = 40
      const wait = () => { if (--left > 0 && !hurt) return; bot.removeListener('physicsTick', wait); bot.removeListener('entityHurt', onHurt)
        entry.hit = hurt; busy = false; stats.log.push(entry); if (stats.log.length > 20) stats.log.shift() }
      bot.on('physicsTick', wait)
    })
  }
  // Меня подбросили (батут союзника) с булавой в руке, враг внизу в 6 бл. — спуск с ударом (mace.descend): своего взлёта у
  // тела не было, и удар с падения сам не начинался (стенд 24.10 14:06 — пять батутов, ни одного удара).
  let descending = false
  const tryDescend = () => {
    if (descending || bot.heldItem?.name !== 'mace' || bot.entity.onGround || bot.entity.elytraFlying || heightAbove(bot, bot.entity.position) < 4) return
    const me = bot.entity.position
    const foe = maceTarget(bot, me)
    if (!foe) return
    descending = true
    const entry: any = { at: clock.now(), target: foe.username, kind: 'descend', ally: bot.username, kick: 0, fired: true, progress: 0, edge: 0 }
    session.runIntent('mace_descend', ctl => (require('../mace') as typeof import('../mace')).descend(bot, ctl, foe, {}),
      { exclusive: false, timeoutMs: 5000, interruptOn: ['death', 'kicked', 'disconnected'], params: { reflex: true } })
      .then(r => { entry.hit = !!r?.detail?.hit }).catch(() => {})
      .finally(() => { descending = false; stats.log.push(entry); if (stats.log.length > 20) stats.log.shift() })
  }
  // Щит от булавы сверху — рефлекс тела вне боя (стенд 25.10: падение с 12 бл. на лутающего, летящего и бросающего ветер — ни щита,
  // ни отскока, 5 смертей из 6; драйвер замечал «падает на меня» через опрос раз из двух и поздно). Щит держит через 5 т. после подъёма (blockDelayTicks), mace_smash щитом гасится (jar 1.21.11) — подъём за ≤ 25 т.
  let shieldUp = false, shieldEpoch = 0, shieldRelease = 0, shieldSeen = 0, equipping = false, dodging: { x: number, z: number } | null = null
  const smashShield = (): boolean => {
    const foes: string[] = session._ndFoes || []
    const reflex: typeof import('../reflex-lock') = require('../reflex-lock'), epoch = session._reflexState?.epoch || 0
    const released = bot._ndUse?.stats?.ended?.['отпустил'] || 0
    if (shieldUp && (shieldEpoch !== epoch || shieldRelease !== released)) shieldUp = false // actual item release, including a same-tick skill handoff
    // И в бою: его защита (mace/defend) поднимает щит, только если он уже надет, — стенд: «☂ падает на меня» у дерущегося, удар в открытого.
    const s = foes.length && !bot.entity.elytraFlying ? (require('../threats') as typeof import('../threats')).smashes(bot, foes, null, true)[0] : null
    const { SMASH_SHIELD_HORIZON } = require('./shield') as typeof import('./shield')
    if (!s || s.ticks > SMASH_SHIELD_HORIZON) {
      if (shieldUp && clock.now() - shieldSeen > 300) { bot.deactivateItem(); bot.setControlState('back', false); shieldUp = false }
      if (dodging && clock.now() - shieldSeen > 300) { for (const k of ['forward', 'sprint', 'jump']) bot.setControlState(k, false); dodging = null }
      return shieldUp || !!dodging
    }
    shieldSeen = clock.now()
    if (!reflex.allowed(session)) return true
    const off = bot.inventory.slots[45]
    if (off?.name !== 'shield') {
      const sh = bot.inventory.items().find((i: any) => i.name === 'shield')
      // Тотем в левой руке при малом хп не снимать. Щита нет — спринт с прыжком прочь от точки удара, если до посадки 5+ т. и
      // пробег чистый (без обрыва глубже 3 и стен, flee.runLength), — стенд: двое без щита стояли и умирали.
      if (!sh || off?.name === 'totem_of_undying' && bot.health <= 16) {
        const me = bot.entity.position, dx = me.x - s.at.x, dz = me.z - s.at.z, n = Math.hypot(dx, dz)
        if (s.ticks < 5 || !bot.entity.onGround && !dodging) return !!dodging
        const fl: any = require('../flee')
        const dirs = [0, .8, -.8, 1.6, -1.6].map(a => { const b0 = n > .3 ? Math.atan2(dz, dx) : Math.random() * 6.28; return { x: Math.cos(b0 + a), z: Math.sin(b0 + a) } })
        const dir = dodging || dirs.find(d => fl.runLength(bot, d, 4, 3, session._rescue?.arena).len >= 2.5)
        if (!dir) return false
        if (!dodging) bot.pathfinder?.setGoal(null)
        dodging = dir
        bot.look(Math.atan2(-dir.x, -dir.z), 0, true).catch(() => {})
        for (const k of ['forward', 'sprint', 'jump']) bot.setControlState(k, true)
        return true
      }
      if (!equipping) { equipping = true; bot.equip(sh, 'off-hand').catch(() => {}).finally(() => { equipping = false }) }
      return true
    }
    const duelOwnsAim = session.current?.name === 'fight' && reflex.shieldHold(session) && bot._ndMaceDefense?.target === s.name
    if (!duelOwnsAim) {
      const aim = s.shieldFrom || s.from
      bot.lookAt(new Vec3(aim.x, aim.y, aim.z), true).catch(() => {})
      // Прямо над головой щит не держит — шаг назад, лицом к нему.
      const dh = Math.hypot(s.from.x - bot.entity.position.x, s.from.z - bot.entity.position.z)
      bot.setControlState('back', dh < 1.5); bot.setControlState('sprint', false)
    }
    if (!shieldUp) {
      bot.activateItem(true); shieldUp = true; shieldEpoch = epoch; shieldRelease = released
      stats.log.push({ at: clock.now(), target: s.name, kind: 'shield', ticks: s.ticks, fired: true, progress: 0, edge: 0 }); if (stats.log.length > 20) stats.log.shift()
    }
    return true
  }
  const { Vec3 }: typeof import('vec3') = require('vec3')
  bot.on('physicsTick', () => {
    if (closed) return
    const cfg = session._rescue
    if (cfg?.arena && bot.entity && bot.health > 0 && smashShield()) return
    if (cfg?.arena && bot.entity && bot.health > 0) tryDescend()
    if (busy || !cfg?.arena || (++tick & 1) || !bot.entity || !(bot.health > 0) || process.env.ND_WIND_OUT === '0') return
    if (!hands.windReady(bot) || bot.usingHeldItem) {
      if (process.env.ND_WIND_TRACE === '1' && bot.entity && deflectTargets(bot).length) trace(!hands.windReady(bot) ? ((require('../mace/hands') as typeof import('../mace/hands')).windCount(bot) ? 'deflect:gate_cooldown' : 'deflect:gate_empty') : 'deflect:gate_using:' + (bot.heldItem?.name || '?'))
      return
    }
    const arena: WindArena = { ...cfg.arena, killY: Number.isFinite(cfg.killY) ? cfg.killY : undefined }
    if (process.env.ND_WIND_TRACE === '1' && tick % 200 === 0 && Object.keys(windTrace).length) {
      const pt = (require('./enemy-wind') as typeof import('./enemy-wind')).planTraceCounts
      console.log('[wind-trace]', JSON.stringify(windTrace), JSON.stringify(pt)); for (const k of Object.keys(windTrace)) delete windTrace[k]; for (const k of Object.keys(pt)) delete pt[k]
    }
    if (!windOutCandidates(bot, arena).length && !deflectTargets(bot).length) {
      if (process.env.ND_WIND_TRACE === '1' && tick % 10 === 0) for (const e of (Object.values(bot.players || {}) as any[]).map(pl => pl?.entity)) {
        if (!e?.position || e === bot.entity || isAlly(bot, e) || bot.players[e.username]?.gamemode !== 0) continue
        trace(!seesPlayer(bot, e) ? 'cand:los' : 'cand:other')
      }
      tryTrampoline(arena); return
    }
    // Заряд в рюкзаке — сначала в хотбар (фоном), считать бросок — со следующего раза.
    if (!hands.offWind(bot) && hands.hotbarIndex(bot, 'wind_charge') < 0) { busy = true; hands.ensureHotbar(bot, ['wind_charge']).catch(() => {}).finally(() => { busy = false }); return }
    // Plan in the existing post-packet phase, after the remaining handlers of this physics tick.
    const entity = bot.entity, nativeClock = bot.ndClock, owner = session.current, epoch = session._reflexState?.epoch || 0, generation = spawnGeneration
    const queuedAt = clock.wall.monotonic(), queuedObservation = nativeClock?.observationNow?.()
    const current = () => !closed && session.bot === bot && bot.entity === entity && bot.ndClock === nativeClock &&
      !nativeClock?.frozen && !nativeClock?.disposed && generation === spawnGeneration && session.current === owner && !owner?.ctl?.aborted &&
      epoch === (session._reflexState?.epoch || 0) && bot.health > 0
    busy = true
    hands.afterPacket(bot, () => {
      let waitingForBid = false
      try {
        if (!current() || !hands.windReady(bot) || bot.usingHeldItem) return
        // An old queue cannot renew the existing twenty-tick observation/extrapolation horizon.
        const queueAge = queuedObservation === undefined ? (clock.wall.monotonic() - queuedAt) * (nativeClock?.observationRate?.() || 20) / 20 : nativeClock.observationNow() - queuedObservation
        if (queueAge > 20 * 50) return
        const cfg = session._rescue
        if (!cfg?.arena) return
        const arena: WindArena = { ...cfg.arena, killY: Number.isFinite(cfg.killY) ? cfg.killY : undefined }
        if (!windOutCandidates(bot, arena).length && !deflectTargets(bot).length) return
        const ex: typeof import('./enemy-wind-execute') = require('./enemy-wind-execute')
        const report = ex.enemyWindReport(session, { flying: true })
        if (!report.ok || !report.ready) return
        // Кадр, чей план уже опоздал, второй раз не считать: тот же снимок даст тот же поздний бросок (Kimi AUDIT 27.10 — пары по 9–11
        // повторов). Новый игровой тик — новый кадр.
        if (staleTick !== null && worldTick(bot) === staleTick) return
        const t0 = clock.wall.monotonic(), observedAtPlan = nativeClock?.observationNow?.()
        // Упреждение на свой расчёт: бросок уходит через planMs после кадра, по которому считан (стенд 24.10 14:06: 90–230 мс —
        // мимо, цель уже на земле). Цель — на столько тиков вперёд, сколько обычно идёт от кадра до выпуска (скользящее среднее):
        // Решение и выпуск теперь в одном afterPacket; ожидание остальных обработчиков тика больше не попадает в среднее. Больше 6 тиков (300 мс) прогноз не тянем.
        const lag = Math.max(0, Math.min(6, Math.round(Math.max(planEma, releaseEma) * (nativeClock?.observationRate?.() ?? 20) / 1000)))
        // Расчёт не дольше окна свежести выпуска (та же граница, что у stale_release ниже, в стеночных мс при наблюдённой скорости
        // тиков): досчитанный позже план всё равно не бросается.
        const deadline = t0 + ((lag + 1) * 50 + 25) * 20 / (nativeClock?.observationRate?.() || 20)
        const frame = worldTick(bot), collision = windCollisionWorld(bot)
        // Сначала — отвод таранщика с линии на своих (жизнь своего дороже выноса), потом вынос за край.
        const pick = deflectDecide(bot, report.report, arena, lag, deadline, collision) ??
          windOutDecide(bot, report.report, arena, lag, deadline, windOrder(session, frame)?.target, collision, !!session._windRadio)
        const planMs = Math.round(clock.wall.monotonic() - t0)
        planEma = planEma * .8 + planMs * .2
        if (!pick) { if (clock.wall.monotonic() > deadline) staleTick = frame; return }
        stats.tries++
        const entry: any = { at: clock.now(), target: pick.foe.username, kind: pick.kind, planMs, foeY: +pick.foe.position.y.toFixed(1),
          edge: +edgeRoom(arena, pick.foe.position).toFixed(1), air: !pick.foe.onGround, progress: +pick.plan.nominal.progress.toFixed(1), allies: pick.allies.length, lag, airGain: pick.plan.nominal.air - pick.plan.baseline.air }
        let logged = false
        const done = () => { busy = false; if (logged) return; logged = true; stats.log.push(entry); if (stats.log.length > 20) stats.log.shift() }
        // Замер прогноза: скорость цели сырая (пакеты entity_velocity) и по наблюдённым позициям, где ждём ноги к прилёту.
        const r2 = (v: any) => v ? [v.x, v.y, v.z].map(n => +(+n).toFixed(2)).join(',') : '?'
        const obsV = (require('../bow/track') as typeof import('../bow/track')).observedVelocity(pick.foe)
        entry.dbg = `v ${r2(pick.foe.velocity)} / набл. ${r2(obsV)}, ноги к прилёту ${r2(pick.shot.feet)} через ${pick.shot.ticks}+${pick.shot.fireDelay} т.`
        // Расчёт занял стеночное время: тик уже другой — пусть решает следующий заход по свежему кадру.
        if (worldTick(bot) !== pick.plan.gameTick) { entry.why = 'tick_passed_while_planning'; return done() }
        // Наблюдённое игровое время идёт и при синхронном расчёте.
        const bidTick = worldTick(bot)
        if (!current() || bidTick === null || bidTick < pick.plan.gameTick) { entry.why = 'stale_release'; return done() }
        const elapsed = observedAtPlan === undefined ? clock.wall.monotonic() - t0 : nativeClock.observationNow() - observedAtPlan
        releaseEma = releaseEma * .8 + elapsed * .2
        // Для журнала: сколько ушло от свежего кадра до выпуска против окна свежести.
        entry.dbg += `, до выпуска ${Math.round(elapsed)} мс/${bidTick - pick.plan.gameTick} т. (окно ${(lag + 1) * 50 + 25}, lag ${lag})`
        if (Math.max(elapsed, (bidTick - pick.plan.gameTick) * 50) > (lag + 1) * 50 + 25) { entry.why = 'stale_release'; staleTick = pick.plan.gameTick; return done() }
        const radio: WindRadio | undefined = session._windRadio
        const prefix = pick.plan.relayPrefix
        const plannedTick = prefix === undefined ? bidTick : pick.shot.fireTick ?? bidTick
        const lastBidTick = bidTick + WIND_BID_REPLY_TICKS + 1
        if (plannedTick > lastBidTick) { entry.why = 'wind_relay_expired'; return done() }
        const refuse = (why: string) => { entry.why = why; done() }
        const refuseState = () => refuse(session.current !== owner ? 'wind_release_owner_changed' : 'wind_release_state_changed')
        const send = (finish?: WindBidFinish, requestedAt = -Infinity) => {
          let flight: { tick: number; ticks: number } | undefined
          try {
            const tick = worldTick(bot)
            if (tick === null || !current()) return refuseState()
            if (prefix !== undefined && !finish) return refuse('wind_relay_busy')
            if (finish) {
              if (session._windRadio !== radio) return refuse('wind_relay_channel_changed')
              if (windOrder(session, tick)?.target === pick.foe.username) return refuse('wind_relay_team_order')
              if (smashShield()) return refuse('wind_relay_defence')
            }
            if (finish && (tick < plannedTick || tick > lastBidTick || prefix !== undefined && session._rescue?.arena !== cfg.arena)) {
              entry.why = 'wind_relay_expired'; return done()
            }
            const observedAt = finish ? nativeClock?.observationNow?.() : observedAtPlan
            const releaseStart = finish ? clock.wall.monotonic() : t0
            const releaseCollision = finish ? windCollisionWorld(bot) : collision
            // Очередь выпуска не обязана ждать lag тиков: угол нужен из фактического тела, а не из будущей точки плана.
            const releaseDeadline = Math.min(finish ? Infinity : deadline, clock.wall.monotonic() + 1000 / (nativeClock?.observationRate?.() || 20),
              prefix === undefined ? Infinity : requestedAt + WIND_BID_RELEASE_MS)
            const fresh = ex.enemyWindReport(session, { flying: true }), foe = bot.players?.[pick.foe.username]?.entity
            if (!fresh.ok || !fresh.ready || !foe || foe.id !== pick.foe.id || !seesPlayer(bot, foe) || isAlly(bot, foe)) { entry.why = 'changed_before_release'; return done() }
            const mode = bot.players[pick.foe.username]?.gamemode
            if (finish && (foe.isValid === false || mode === 1 || mode === 3)) return refuse('changed_before_release')
            if (!windMotionFresh(bot, foe)) { entry.why = 'pending_wind_observation'; return done() }
            const allies = alliesNear(bot, foe, tick), team = [fresh.report, ...allies]
            const tracks = new Map()
            const plannedReprice = !!finish || pick.kind === 'fall' || pick.plan.repriceRim && pick.shot.fireDelay > 0
            let inwardReaim = false
            let shot
            if (!plannedReprice) {
              const frames = enemyWindFrames(bot, foe, arena, [], pick.plan.resistance.lo, true, releaseCollision)
              const pending = pendingWindHit(bot, foe, frames, [], releaseCollision)
              const intercept = pending ? frames.slice(0, pending.ticks) : frames
              shot = enemyWindShot(bot, foe, fresh.report, intercept, { height: pick.shot.aimHeight ?? pick.shot.aim.y - pick.shot.feet.y, allies: team, tracks }, undefined, releaseDeadline, releaseCollision)
              if (pending && (!shot || shot.ticks >= pending.ticks)) {
                entry.why = 'pending_wind_impulse'; entry.pending = pending.id; return done()
              }
              if (shot && (pick.kind === 'chain' || pick.kind === 'juggle')) {
                const outward = windOutward(arena, pick.plan.targetAt, foe.width || .6)
                inwardReaim = shot.feet.minus(shot.burst).dot(outward) < 0
              }
            }
            const reprice = plannedReprice || inwardReaim
            let releaseSafeKey: string | undefined
            if (reprice) {
              // A ray proves contact. An inward gust can still lift past a wall, which needs fresh motion pricing.
              if (inwardReaim) trace('release:inward_reprice')
              const currentPlan = planEnemyWind(bot, foe, [fresh.report], { arena, startTick: tick, maxShots: 1, allies: team,
                delays: [0], reactAfterHit: true, juggle: !foe.onGround, waitForHit: true, deadline: releaseDeadline, collision: releaseCollision,
                visiblePrefix: prefix !== undefined, expectedPrefix: prefix, certifyRelease: prefix === undefined })
              releaseSafeKey = currentPlan?.releaseSafeKey
              shot = currentPlan && currentPlan.relayPrefix === prefix && !currentPlan.baseline.out &&
                (pick.kind !== 'fall' || currentPlan.fallThreat || currentPlan.nominal.out) &&
                (prefix !== undefined || !finish && !inwardReaim || offensiveWindKind(currentPlan, !foe.onGround)) ? currentPlan.shots[0] : null
            }
            const world = edges.worldOf(releaseCollision)
            // A fresh full plan certifies its own landing. A ray-only refresh still relies on the old aim.
            const safe = shot && (reprice || shot.feet.distanceTo(pick.shot.feet) <= tw().WIND.reach) &&
              (releaseSafeKey !== undefined && releaseSafeKey === windImpactKey(shot) ||
                windTeamSafe({ ...bot, blockAt: p => world.getBlock(p) }, team, [shot], arena, tracks, false, releaseDeadline))
            const safeTail = !safe || !allies.length || pick.kind.startsWith('deflect') ||
              windAllyTailSafe(bot, foe, shot, allies, releaseCollision, releaseDeadline)
            const releaseObservation = observedAt === undefined ? undefined : nativeClock.observationNow()
            const releaseElapsed = observedAt === undefined ? clock.wall.monotonic() - releaseStart : releaseObservation - observedAt
            const landing = shot && safe && safeTail && foe.onGround && foe._ndPositionReceipts?.[1]
            const groundExpired = landing?.grounded && landing.kind === 'sync_entity_position' &&
              windGroundObservationExpired(bot, foe, landing.t, releaseObservation)
            const releaseAt = clock.wall.monotonic()
            if (!current() || worldTick(bot) !== tick || releaseElapsed > (lag + 1) * 50 + 25 || releaseAt > releaseDeadline ||
                finish && releaseAt - requestedAt >= WIND_BID_RELEASE_MS) {
              entry.why = 'stale_release'; staleTick = pick.plan.gameTick; return done()
            }
            if (!shot || !safe) { entry.why = 'changed_before_release'; return done() }
            if (!safeTail) { entry.why = 'ally_tail_unsafe'; return done() }
            if (groundExpired) { entry.why = 'stale_ground_observation'; return done() }
            pick.shot = { ...shot, fireTick: tick, arrivalTick: tick + shot.ticks }; pick.foe = foe
            entry.allies = allies.length
            entry.dbg += `, выпуск: ноги ${r2(shot.feet)} через ${shot.ticks} т.`
            entry.fired = release(bot, pick.shot)
            if (!entry.fired) { entry.why = 'charge_not_in_hotbar'; return done() }
            flight = { tick, ticks: shot.ticks }
            stats.fired++
            // Следующий бросок — с перезарядкой заряда (windReady), а не после замера: замер ждал полёт + 11 т., и за 1–1.5 с в воздухе
            // бот успевал один заряд (пользователь 25.10: «подкидываю себя на краю — кинут один ветер, и всё»; стенд: 1 сброс из 4 с 7 бл.).
            busy = false
            // Взрыв у цели — по пакету explosion в окне полёта (порыв gust_emitter_small, радиус 1.2) — для журнала.
            const spread = .08 + pick.shot.ticks * .05
            const closeBurst = observeOwnWindBurst(bot, pk => pk?.center && tw().windGust(pk) &&
              Math.hypot(pk.center.x - pick.shot.burst.x, pk.center.y - pick.shot.burst.y, pk.center.z - pick.shot.burst.z) <= 1.5 + spread, () => { entry.burst = true })
            let left = pick.shot.ticks + 3
            // The sender clears its own flight. The controller's wall deadline is only a fallback on disconnect.
            let relay = finish, afterBurst = 2, flightLeft = shot.ticks + Math.ceil(shot.ticks * tw().WIND.dispersion * Math.sqrt(3)) + 2
            // Отвод: «заход сорван» — за окно он ко мне ближе удара копья не подошёл и меня не ранил (своих рядом журнал не судит).
            const hp0 = bot.health, deflect = /^deflect/.test(pick.kind)
            let near = Infinity
            const wait = () => {
              if (closed || generation !== spawnGeneration || bot.entity !== entity || bot.ndClock !== nativeClock) {
                bot.removeListener('physicsTick', wait); closeBurst(); return
              }
              if (relay && (--flightLeft <= 0 || entry.burst && --afterBurst <= 0)) { relay(); relay = undefined }
              const q0 = deflect && bot.players?.[pick.foe.username]?.entity?.position
              if (q0) near = Math.min(near, q0.distanceTo(bot.entity.position.offset(0, .9, 0)))
              if (left === 3) { const q = bot.players?.[pick.foe.username]?.entity?.position; entry.dbg += `, на деле ${r2(q)}` }
              if (--left > -8) return // ещё 8 тиков после окна взрыва — куда его унесло
              bot.removeListener('physicsTick', wait); closeBurst()
              const p = bot.players?.[pick.foe.username]?.entity?.position
              if (p) { entry.edgeAfter = +edgeRoom(arena, p).toFixed(1); entry.yAfter = +p.y.toFixed(1) }
              if (deflect) { entry.foiled = bot.health >= hp0 && near > CONTACT; entry.passed = Number.isFinite(near) ? +near.toFixed(1) : null }
              logged = true; stats.log.push(entry); if (stats.log.length > 20) stats.log.shift()
            }
            bot.on('physicsTick', wait)
          } finally { finish?.(flight); busy = false }
        }
        const granted = (finish: WindBidFinish, requested: number) => {
          if (!current()) {
            try { return refuseState() } finally { finish() }
          }
          const sendAfterMovement = () => hands.afterPacket(bot, () => send(finish, requested))
          const tick = worldTick(bot)
          if (prefix === undefined || tick !== null && tick >= plannedTick) return sendAfterMovement()
          const life = ['death', 'respawn', 'end', 'kicked'], hooks: Array<() => void> | undefined = owner?.ctl?.onAbort
          let waiting = true, timer: ReturnType<typeof clock.wall.setTimeout>
          const unhook = () => {
            const index = hooks?.indexOf(abort) ?? -1
            if (index >= 0) hooks!.splice(index, 1)
          }
          const cleanup = () => {
            if (!waiting) return false
            waiting = false
            clock.wall.clearTimeout(timer)
            bot.removeListener('physicsTick', advance)
            for (const event of life) bot.removeListener(event, abort)
            // The session calls abort hooks by iterating this array in place.
            if (owner?.ctl?.aborted) queueMicrotask(unhook); else unhook()
            return true
          }
          const abort = () => {
            if (!cleanup()) return
            entry.why = 'wind_relay_expired'
            try { finish() } finally { done() }
          }
          const advance = () => {
            const tick = worldTick(bot), target = bot.players?.[pick.foe.username]
            if (!current() || session._windRadio !== radio || session._rescue?.arena !== cfg.arena ||
              !target?.entity || target.entity.id !== pick.foe.id || target.gamemode === 1 || target.gamemode === 3 ||
              tick === null || tick < bidTick || tick > lastBidTick || clock.wall.monotonic() - requested >= WIND_BID_RELEASE_MS) return abort()
            if (tick >= plannedTick && cleanup()) sendAfterMovement()
          }
          for (const event of life) bot.on(event, abort)
          hooks?.push(abort)
          bot.on('physicsTick', advance)
          timer = clock.wall.setTimeout(abort, Math.max(0, requested + WIND_BID_RELEASE_MS - clock.wall.monotonic()))
          timer.unref?.()
          advance()
        }
        // Do not stack speculative relifts while the current rising target still has its own airborne route.
        const relayLift = pick.plan.lateLift || pick.plan.nominal.progress < pick.plan.baseline.progress
        const openingLift = pick.kind === 'chain' && !entry.air && pick.plan.earlyLift
        if (radio && (prefix !== undefined || openingLift || pick.kind === 'juggle' && (pick.plan.earlyLift || relayLift))) {
          if (prefix !== undefined) entry.dbg += `, первый заряд #${prefix}`
          else if (openingLift || !relayLift) entry.dbg += ', согласуем ранний подъём'
          waitingForBid = true
          const requested = clock.wall.monotonic()
          const hooks: Array<() => void> | undefined = owner?.ctl?.onAbort
          const abortBid = hooks && new AbortController()
          const cancel = () => abortBid?.abort()
          hooks?.push(cancel)
          void radio({ target: pick.foe.username, entity: pick.foe.id, tick: bidTick, ticks: pick.shot.ticks,
            ...(prefix !== undefined && { prefix }) }, abortBid?.signal).then(finish => {
            if (finish) {
              entry.dbg += `, заказ роя ${Math.round(clock.wall.monotonic() - requested)} мс`
              granted(finish, requested)
            }
            else if (abortBid?.signal.aborted) refuseState()
            else refuse('wind_relay_busy')
          }).catch(() => done()).finally(() => {
            const index = hooks?.indexOf(cancel) ?? -1
            if (index >= 0) hooks!.splice(index, 1)
          })
        } else send()
      } finally { if (!waitingForBid) busy = false }
    })
  })
}
