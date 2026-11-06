import { AsyncResource } from 'node:async_hooks'
import { Vec3 } from 'vec3'
import * as clock from '../game-clock'
import * as hands from '../mace/hands'
import { WIND_CD_MS } from '../mace/consts'
import * as reflex from '../reflex-lock'
import * as pick from '../pick'
import edges = require('../edges')
import { createLastSeen, seesPlayer } from '../pvp/last-seen'
import { WIND, WIND_REPORT_AGE_TICKS, worldTick, windInside, windMovement, useWindAtAngle, type WindReport } from './team-wind'
import { planEnemyWind, enemyWindFrames, enemyWindShot, windTeamSafe, windReportAt, pendingWindHit, observeOwnWindBurst, installWindTracking, windMotionFresh, observeEnemyWindMotion, WIND_FORECAST_TICKS, windCollisionWorld, windFinishOpportunity } from './enemy-wind'
import { cancelWindOrder, reserveWindOrder, windOrder } from './wind-coordination'

const finite = p => !!p && [p.x, p.y, p.z].every(Number.isFinite)
const vec = p => new Vec3(p.x, p.y, p.z)
const escape = /^(evade|juke|take_cover|douse_lava|lava_escape|wind_jump|pearl_to|fly_to|burrow|block_behind|peek_shot|wind_leap|dodge_blast|clear_web)$/
const sights = new WeakMap<object, ReturnType<typeof createLastSeen>>()
function windSight(bot) {
  let sight = sights.get(bot)
  if (!sight) {
    installWindTracking(bot)
    sight = createLastSeen(bot); sights.set(bot, sight)
    const close = () => { sight!.close(); sights.delete(bot); for (const event of ['death', 'end', 'kicked']) bot.removeListener(event, close) }
    for (const event of ['death', 'end', 'kicked']) bot.once(event, close)
  }
  return sight
}
// flying — рефлекс сброса на подлёте (wind-out RANGE_FLY): полёт на элитрах и fly_to бросок не запрещают.
function busy(session, flying = false) {
  const bot = session.bot, body = bot?.entity, c = session.current, d = bot?._ndMaceDefense
  if (bot?.version === '1.21.11' && typeof bot._ndLaunchMovement === 'function' && body?.onGround && !body.elytraFlying) {
    // Landing clears local flight before both the simulated height and Paper's public pose settle.
    const pose = pick.poseOf(bot, body)
    if (bot._ndOwnGlideLanding === body || pose === 1 || pose === 'fall_flying') return true
  }
  return !!reflex.owner(session) || !!bot?.usingHeldItem || !flying && !!body?.elytraFlying ||
    !!c && !c.ctl?.aborted && (escape.test(c.name) && !(flying && c.name === 'fly_to') || c.name === 'swarm_hold' && !!(c.params?.whileSmash || c.params?.whileDraw) ||
      c.name === 'fight' && d?.current === c && !d.ctl?.aborted && d.until > clock.now())
}
function own(bot): WindReport & { gameTick: number | null } {
  return { id: bot.username || bot.entity.username, position: { ...bot.entity.position }, velocity: { ...bot.entity.velocity },
    launchMovement: { ...windMovement(bot) }, onGround: !!bot.entity.onGround, gliding: !!bot.entity.elytraFlying, pitch: bot.entity.pitch || 0,
    eyeHeight: pick.eyeHeight(bot, bot.entity), attributes: bot.entity.attributes || {}, effects: bot.entity.effects || {},
    control: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(k => [k, !!bot.getControlState(k)])),
    yaw: bot.entity.yaw || 0, gameTick: worldTick(bot) }
}
export function enemyWindReport(session, p: any = {}) {
  const bot = session.bot, gameTick = bot?.entity ? worldTick(bot) : null
  if (p.coordination !== undefined) {
    if (typeof p.coordination !== 'string' || !p.coordination || p.coordination.length > 64 ||
      typeof p.target !== 'string' || !p.target || p.target.length > 64) return { ok: false, ready: false, why: 'invalid_wind_order' }
    if (p.cancel === true) {
      cancelWindOrder(session, p.coordination, p.target)
      return { ok: true, ready: false }
    }
  }
  if (!bot?.entity || gameTick === null || !(bot.health > 0)) return { ok: false, ready: false, gameTick, why: 'shared_world_tick_required' }
  const ready = () => !busy(session, !!p.flying && !!bot.entity.elytraFlying) && hands.windReady(bot)
  // The report window covers both planning attempts and the last projectile's arrival.
  if (p.coordination !== undefined) {
    if (p.probe === true) {
      const order = windOrder(session, gameTick)
      if (order?.id !== p.coordination || order.target !== p.target) return { ok: false, ready: false, gameTick, why: 'wind_order_lost' }
      return { ok: true, ready: ready(), gameTick, coordination: order.id, targetVisible: seesPlayer(bot, bot.players?.[p.target]?.entity) }
    }
    if (bot.ndClock?.frozen || bot.ndClock?.disposed ||
      !reserveWindOrder(session, p.coordination, p.target, gameTick, gameTick + 20 + WIND_FORECAST_TICKS)) {
      return { ok: false, ready: false, gameTick, why: 'wind_order_unavailable' }
    }
    return { ok: true, gameTick, coordination: p.coordination, report: own(bot) }
  }
  if (p.target) windSight(bot).observe(bot.players?.[p.target]?.entity)
  return { ok: true, ready: ready(), gameTick, report: own(bot) }
}
const reportsValid = (reports, tick) => Array.isArray(reports) && reports.length <= 32 && reports.every(r =>
  typeof r?.id === 'string' && r.id.length <= 64 && finite(r.position) && finite(r.velocity) &&
  (r.launchMovement === undefined || finite(r.launchMovement)) && Number.isSafeInteger(r.gameTick) && Math.abs(tick - r.gameTick) <= WIND_REPORT_AGE_TICKS)
function waitReportTick(session, target: number) {
  const bot = session.bot, entity = bot.entity, owner = session.current, nativeClock = bot.ndClock
  let last = worldTick(bot), bodyTick = nativeClock?.ticks
  return new Promise<string | null>(resolve => {
    let timer: any
    const finish = (why: string | null) => {
      bot.removeListener('physicsTick', check)
      for (const event of ['death', 'end', 'kicked']) bot.removeListener(event, cancelled)
      nativeClock?.removeListener?.('state', check)
      const i = owner?.ctl?.onAbort?.indexOf(cancelled); if (i >= 0) owner.ctl.onAbort.splice(i, 1)
      if (timer) clock.wall.clearTimeout(timer)
      resolve(why)
    }
    const cancelled = () => finish('clock_sync_interrupted')
    const check = () => {
      const tick = worldTick(bot), nextBodyTick = nativeClock?.ticks
      if (session.bot !== bot || bot.entity !== entity || session.current !== owner || owner?.ctl?.aborted || !(bot.health > 0) || bot.ndClock !== nativeClock || nativeClock?.disposed) return cancelled()
      if (nativeClock?.frozen) return finish('clock_sync_paused')
      if (tick === null || last === null || tick < last || tick > last + 1 || Number.isFinite(bodyTick) && nextBodyTick > bodyTick + 1) return finish('clock_sync_changed')
      last = tick; bodyTick = nextBodyTick
      if (tick >= target) finish(null)
    }
    bot.on('physicsTick', check)
    for (const event of ['death', 'end', 'kicked']) bot.once(event, cancelled)
    nativeClock?.on?.('state', check)
    owner?.ctl?.onAbort?.push(cancelled)
    // A paused/disconnected native clock must not retain a read-only query forever.
    timer = clock.wall.setTimeout(() => finish('clock_sync_timeout'), 20 * 50)
    check()
  })
}
export async function enemyWindPlan(session, p: any = {}) {
  const bot = session.bot, owner = session.current, entity = bot?.entity, nativeClock = bot?.ndClock, world = bot?.world, lead = p.leadTicks ?? 2
  const current = () => session.bot === bot && bot.entity === entity && bot.world === world && session.current === owner &&
    !owner?.ctl?.aborted && bot.health > 0 && bot.ndClock === nativeClock && !nativeClock?.disposed && !nativeClock?.frozen
  let tick = entity ? worldTick(bot) : null
  if (tick === null || !Number.isSafeInteger(lead) || lead < 1 || lead > 20 || !reportsValid(p.throwers, tick) || !reportsValid(p.allies || [], tick)) return { ok: false, why: 'invalid_or_stale_reports', gameTick: tick }
  if (nativeClock?.frozen || nativeClock?.disposed) return { ok: false, why: nativeClock.frozen ? 'clock_sync_paused' : 'clock_sync_interrupted', gameTick: tick }
  const reportTick = Math.max(tick, ...p.throwers.map(r => r.gameTick), ...(p.allies || []).map(r => r.gameTick))
  if (reportTick > tick) {
    const why = await waitReportTick(session, reportTick)
    tick = worldTick(bot)
    if (why) return { ok: false, why, gameTick: tick }
    if (!current() || tick !== reportTick) return { ok: false, why: 'clock_sync_changed', gameTick: tick }
    if (!reportsValid(p.throwers, tick) || !reportsValid(p.allies || [], tick)) return { ok: false, why: 'invalid_or_stale_reports', gameTick: tick }
  }
  const deadline = clock.wall.monotonic() + lead * 1000 / (nativeClock?.observationRate?.() || 20)
  const sight = windSight(bot)
  const raw = bot.players?.[p.target]?.entity
  let foe = sight.observe(raw)
  if (!foe || !sight.visible(foe)) return { ok: false, why: 'target_not_visible', gameTick: tick }
  if (!windMotionFresh(bot, foe)) return { ok: false, why: 'pending_wind_observation', gameTick: tick }
  const throwers = p.throwers.map(r => windReportAt(bot, r, tick, deadline)), allies = (p.allies || []).map(r => windReportAt(bot, r, tick, deadline))
  if (clock.wall.monotonic() > deadline) return { ok: false, why: 'planning_deadline', gameTick: worldTick(bot) }
  if ([...throwers, ...allies].some(r => !r)) return { ok: false, why: 'stale_reports', gameTick: tick }
  const plan = throwers.length ? planEnemyWind(bot, foe, throwers, { arena: p.arena, startTick: tick + lead, maxShots: p.maxShots ?? 2,
    allies, deadline, reactAfterHit: true, waitForHit: true }) : null
  if (!plan && throwers.length && p.finish === true && clock.wall.monotonic() <= deadline) {
    // A rejected synchronous search can leave target packets queued. Forecast the fallback only after one IO turn.
    await new Promise<void>(resolve => setImmediate(resolve))
    const latest = worldTick(bot)
    if (!current() || sights.get(bot) !== sight || latest === null || latest < tick) return { ok: false, why: 'clock_sync_changed', gameTick: latest }
    if (clock.wall.monotonic() > deadline) return { ok: false, why: 'planning_deadline', gameTick: latest }
    foe = bot.players?.[p.target]?.entity === raw ? sight.observe(raw) : null
    if (!foe || !sight.visible(foe)) return { ok: false, why: 'target_not_visible', gameTick: latest }
    if (!windMotionFresh(bot, foe)) return { ok: false, why: 'pending_wind_observation', gameTick: latest }
  }
  const finish = p.finish === true && !plan?.nominal?.out && !plan?.worst?.out && !plan?.fallThreat
    ? windFinishOpportunity(bot, foe, p.arena, undefined, deadline) : null
  if (clock.wall.monotonic() > deadline) return { ok: false, why: 'planning_deadline', gameTick: worldTick(bot) }
  return { ok: !!plan, plan, gameTick: worldTick(bot), why: plan ? undefined : 'no_useful_native_chain',
    ...(finish ? { finish: { target: finish.target, at: finish.at, ticks: finish.ticks, gameTick: finish.gameTick } } : {}) }
}

/** One atomic hand action beside the current fight; movement and defensive reflexes retain their owners. */
export async function enemyWindExecute(session, ctl, p: any = {}) {
  const bot = session.bot, plan = p.plan, tick = bot?.entity ? worldTick(bot) : null
  const fail = why => ({ ok: false, fired: false, why })
  const replan = !plan && p.replan === true && typeof p.coordination === 'string'
  const target = replan ? p.target : plan?.target
  const id = bot?.username || bot?.entity?.username
  const shot = Array.isArray(plan?.shots) ? plan.shots.find(s => s.thrower === id) : undefined
  if (tick === null || typeof target !== 'string' || !windInside(bot.entity.position, p.arena)) return fail('invalid_schedule')
  if (!replan && (!shot || plan.shots.length > WIND_FORECAST_TICKS ||
    ![plan.gameTick, shot.fireTick, shot.arrivalTick, shot.ticks].every(Number.isSafeInteger) ||
    shot.fireTick < plan.gameTick || shot.fireTick > plan.gameTick + 26 || shot.ticks < 1 || shot.ticks > WIND_FORECAST_TICKS || shot.arrivalTick !== shot.fireTick + shot.ticks ||
    ![shot.from, shot.aim, shot.feet, shot.burst, shot.velocity].every(finite))) return fail('invalid_schedule')
  const order = windOrder(session, tick)
  if (p.coordination !== undefined && (order?.id !== p.coordination || order?.target !== target)) return fail('wind_order_lost')
  const fireTick = shot?.fireTick ?? tick
  const canReplan = p.coordination !== undefined && (replan || plan.shots.length === 1)
  if (tick > fireTick && !canReplan) return fail('shared_world_tick_missed')
  if (ctl.aborted || busy(session, !!bot.entity.elytraFlying) || !hands.windReady(bot)) return fail('hands_or_defence_busy')
  const entity = bot.entity, nativeClock = bot.ndClock, owner = session.current
  const current = () => !ctl.aborted && session.bot === bot && bot.entity === entity && bot.ndClock === nativeClock &&
    !nativeClock?.frozen && !nativeClock?.disposed && session.current === owner && !owner?.ctl?.aborted && bot.health > 0 &&
    (p.coordination === undefined || windOrder(session, worldTick(bot)) === order)
  const sight = windSight(bot)
  let fired = false, launchConfirmed = false, burstSeen = false, actual = null, firedTick = null, closeBurst = () => {}
  let releaseWhy = 'changed_before_release'
  const refuse = (why: string) => { releaseWhy = why; return null }
  const count = hands.windCount(bot)
  const cooldown = packet => { if (fired && /wind_charge/.test(String(packet?.cooldownGroup || '')) && packet.cooldownTicks > 0) launchConfirmed = true }
  const matchesBurst = packet => {
    if (!fired || !actual || !finite(packet?.center) || packet.explosionParticle?.type !== 'gust_emitter_small' || Math.abs(packet.radius - WIND.reach / 2) > 1e-5) return false
    if (Math.abs(worldTick(bot)! - firedTick - actual.ticks) > Math.ceil(actual.ticks * WIND.dispersion * Math.sqrt(3)) + 1) return false
    const spread = WIND.speed * WIND.dispersion * Math.sqrt(3) * actual.ticks + .08
    return vec(packet.center).distanceTo(vec(actual.burst)) <= spread
  }
  const waitTick = (complete?: () => boolean) => new Promise<void>((resolve, reject) => {
    const close = () => {
      bot.removeListener('physicsTick', onTick)
      const i = ctl.onAbort.indexOf(done); if (i >= 0) ctl.onAbort.splice(i, 1)
    }
    const done = () => { close(); resolve() }
    const onTick = complete ? AsyncResource.bind(() => {
      try { if (ctl.aborted || complete()) done() }
      catch (error) { close(); reject(error) }
    }) : done
    bot.on('physicsTick', onTick); ctl.onAbort.push(done)
    if (ctl.aborted) done()
  })
  const recheck = () => {
    const now = worldTick(bot)
    if (!current() || now === null) return refuse('wind_owner_changed')
    if (busy(session, !!bot.entity.elytraFlying) || !hands.windReady(bot)) return refuse('hands_or_defence_busy')
    if (now !== fireTick && !canReplan) return refuse('shared_world_tick_missed')
    const foe = sight.observe(bot.players?.[target]?.entity)
    if (!foe || !sight.visible(foe)) return refuse('target_not_visible')
    if (!windMotionFresh(bot, foe)) return refuse('pending_wind_observation')
    const preceding = replan ? [] : plan.shots.filter(s => s !== shot && s.fireTick <= fireTick && s.arrivalTick > now)
      .map(s => ({ ...s, fireDelay: s.fireTick - now }))
    const team = [own(bot), ...(p.allies || []).filter(r => r.id !== id).map(r => {
      const ally = sight.observe(bot.players?.[r.id]?.entity)
      return ally && sight.visible(ally) ? { ...r, position: { ...ally.position }, velocity: { ...ally.velocity }, onGround: !!ally.onGround, gameTick: now } : windReportAt(bot, r, now)
    })]
    if (!team.every(Boolean)) return refuse('stale_allies_at_release')
    const collision = windCollisionWorld(bot)
    const frames = enemyWindFrames(bot, foe, p.arena, preceding, plan?.resistance?.lo ?? 0, true, collision)
    const pending = pendingWindHit(bot, foe, frames, preceding, collision)
    const intercept = pending ? frames.slice(0, pending.ticks) : frames
    const tracks = new Map()
    let candidate = shot && now === fireTick && !plan?.fallThreat
      ? enemyWindShot(bot, foe, team[0], intercept, { height: shot.aimHeight ?? shot.aim.y - shot.feet.y, allies: team, tracks }, undefined, undefined, collision)
      : null
    if (pending && candidate && candidate.ticks >= pending.ticks) candidate = null
    if (!candidate || vec(candidate.feet).distanceTo(vec(shot.feet)) > WIND.reach) {
      if (!canReplan) return refuse(pending ? 'pending_wind_impulse' : 'changed_interception')
      const deadline = clock.wall.monotonic() + 1000 / (nativeClock?.observationRate?.() || 20)
      const fresh = planEnemyWind(bot, foe, [team[0]!], { arena: p.arena, startTick: now, delays: [0], maxShots: 1, allies: team, reactAfterHit: true, waitForHit: true, collision, deadline })
      candidate = fresh?.shots[0] ?? null
      if (pending && (!candidate || candidate.ticks >= pending.ticks)) return refuse('pending_wind_impulse')
      if (plan?.fallThreat && !fresh?.fallThreat && !fresh?.nominal.out) return refuse('no_useful_release_replan')
      if (!candidate || clock.wall.monotonic() > deadline) return refuse('no_useful_release_replan')
    }
    const world = edges.worldOf(collision), observed = { ...bot, blockAt: p => world.getBlock(p) }
    return windTeamSafe(observed, team, [...preceding, candidate], p.arena, tracks) ? candidate : refuse('unsafe_allies_at_release')
  }
  const release = () => new Promise<void>(resolve => edges.afterPacket(bot, () => {
      try {
        const release = recheck(), off = hands.offWind(bot), slot = hands.hotbarIndex(bot, 'wind_charge')
        if (!release || !off && slot < 0) return
        const back = bot.quickBarSlot
        if (!off && back !== slot) bot.setQuickBarSlot(slot)
        actual = release; fired = true; firedTick = worldTick(bot)
        closeBurst = observeOwnWindBurst(bot, matchesBurst, () => { burstSeen = true })
        try {
          useWindAtAngle(bot, off, release)
          bot.usingHeldItem = false; bot._ndWindCd = clock.now() + WIND_CD_MS
        }
        finally { if (!off && back !== slot) bot.setQuickBarSlot(back) }
      } finally { resolve() }
  }))
  bot._client.on('set_cooldown', cooldown)
  try {
    hands.install(bot)
    if (!hands.offWind(bot) && !await hands.ensureHotbar(bot, ['wind_charge'])) return fail('charge_not_in_hotbar')
    let queued: Promise<void> | undefined
    const start = worldTick(bot)
    if (!ctl.aborted && start !== null && start < fireTick) {
      await ctl.waitReflex?.()
      if (ctl.aborted) return fail('cancelled')
      const ready = worldTick(bot)
      if (ready === null || !current()) return fail('local_trajectory_or_defence_changed')
      if (ready < fireTick) {
        // Keep the listener armed when several physics frames arrive before the next microtask.
        await waitTick(() => {
          const now = worldTick(bot)
          if (now === null || !current()) return true
          if (now >= fireTick) { queued = release(); return true }
          const foe = sight.observe(bot.players?.[target]?.entity)
          if (foe?._ndVisible) observeEnemyWindMotion(bot, foe)
          return false
        })
        if (!queued) return fail(ctl.aborted ? 'cancelled' : 'local_trajectory_or_defence_changed')
      }
    }
    if (!queued && ctl.aborted) return fail('cancelled')
    await (queued ?? release())
    if (!fired) return fail(releaseWhy)
    while (!ctl.aborted && worldTick(bot) !== null && worldTick(bot)! <= firedTick + actual.ticks + 2) {
      if (hands.windCount(bot) < count) launchConfirmed = true
      if (burstSeen && launchConfirmed) break
      await waitTick()
    }
    return { ok: launchConfirmed, fired, launchConfirmed, burstSeen, fireTick: firedTick, arrivalTick: firedTick + actual.ticks, shot: actual,
      why: ctl.aborted ? 'interrupted_after_release' : launchConfirmed ? undefined : 'launch_unconfirmed' }
  } finally { bot._client.removeListener('set_cooldown', cooldown); closeBurst() }
}
