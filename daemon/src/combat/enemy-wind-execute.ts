import { Vec3 } from 'vec3'
import * as clock from '../game-clock'
import * as hands from '../mace/hands'
import { WIND_CD_MS } from '../mace/consts'
import * as reflex from '../reflex-lock'
import * as pick from '../pick'
import edges = require('../edges')
import { createLastSeen } from '../pvp/last-seen'
import { observedCollision } from '../pvp/search'
import { WIND, worldTick, windInside, type WindReport } from './team-wind'
import { planEnemyWind, enemyWindFrames, enemyWindShot, windTeamSafe, windReportAt } from './enemy-wind'

const finite = p => !!p && [p.x, p.y, p.z].every(Number.isFinite)
const vec = p => new Vec3(p.x, p.y, p.z)
const escape = /^(evade|juke|take_cover|douse_lava|lava_escape|wind_jump|pearl_to|fly_to|burrow|block_behind|peek_shot|wind_leap|dodge_blast|clear_web)$/
const sights = new WeakMap<object, ReturnType<typeof createLastSeen>>()
function windSight(bot) {
  let sight = sights.get(bot)
  if (!sight) {
    sight = createLastSeen(bot); sights.set(bot, sight)
    const close = () => { sight!.close(); sights.delete(bot); for (const event of ['death', 'end', 'kicked']) bot.removeListener(event, close) }
    for (const event of ['death', 'end', 'kicked']) bot.once(event, close)
  }
  return sight
}
// flying — рефлекс сброса на подлёте (wind-out RANGE_FLY): полёт на элитрах и fly_to бросок не запрещают.
function busy(session, flying = false) {
  const c = session.current, d = session.bot?._ndMaceDefense
  return !!reflex.owner(session) || !!session.bot?.usingHeldItem || !flying && !!session.bot?.entity?.elytraFlying ||
    !!c && !c.ctl?.aborted && (escape.test(c.name) && !(flying && c.name === 'fly_to') || c.name === 'swarm_hold' && !!(c.params?.whileSmash || c.params?.whileDraw) ||
      c.name === 'fight' && d?.current === c && !d.ctl?.aborted && d.until > clock.now())
}
function own(bot): WindReport & { gameTick: number | null } {
  return { id: bot.username || bot.entity.username, position: { ...bot.entity.position }, velocity: { ...bot.entity.velocity },
    onGround: !!bot.entity.onGround, eyeHeight: pick.eyeHeight(bot, bot.entity), attributes: bot.entity.attributes || {}, effects: bot.entity.effects || {},
    control: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(k => [k, !!bot.getControlState(k)])),
    yaw: bot.entity.yaw || 0, gameTick: worldTick(bot) }
}
export function enemyWindReport(session, p: any = {}) {
  const bot = session.bot, gameTick = bot?.entity ? worldTick(bot) : null
  if (!bot?.entity || gameTick === null || !(bot.health > 0)) return { ok: false, ready: false, gameTick, why: 'shared_world_tick_required' }
  if (p.target) windSight(bot).observe(bot.players?.[p.target]?.entity)
  return { ok: true, ready: !busy(session, !!p.flying && !!bot.entity.elytraFlying) && hands.windReady(bot), gameTick, report: own(bot) }
}
const reportsValid = (reports, tick) => Array.isArray(reports) && reports.length <= 32 && reports.every(r =>
  typeof r?.id === 'string' && r.id.length <= 64 && finite(r.position) && finite(r.velocity) && Number.isSafeInteger(r.gameTick) && Math.abs(tick - r.gameTick) <= 20)
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
  const bot = session.bot, owner = session.current, entity = bot?.entity, nativeClock = bot?.ndClock, lead = p.leadTicks ?? 2
  let tick = entity ? worldTick(bot) : null
  if (tick === null || !Number.isSafeInteger(lead) || lead < 1 || lead > 20 || !reportsValid(p.throwers, tick) || !reportsValid(p.allies || [], tick)) return { ok: false, why: 'invalid_or_stale_reports', gameTick: tick }
  const reportTick = Math.max(tick, ...p.throwers.map(r => r.gameTick), ...(p.allies || []).map(r => r.gameTick))
  if (reportTick > tick) {
    const why = await waitReportTick(session, reportTick)
    tick = worldTick(bot)
    if (why) return { ok: false, why, gameTick: tick }
    if (session.bot !== bot || bot.entity !== entity || session.current !== owner || owner?.ctl?.aborted || !(bot.health > 0) || bot.ndClock !== nativeClock || nativeClock?.disposed || nativeClock?.frozen || tick !== reportTick) return { ok: false, why: 'clock_sync_changed', gameTick: tick }
    if (!reportsValid(p.throwers, tick) || !reportsValid(p.allies || [], tick)) return { ok: false, why: 'invalid_or_stale_reports', gameTick: tick }
  }
  const sight = windSight(bot)
    const foe = sight.observe(bot.players?.[p.target]?.entity)
    if (!foe || !sight.visible(foe)) return { ok: false, why: 'target_not_visible', gameTick: tick }
    const throwers = p.throwers.map(r => windReportAt(bot, r, tick)), allies = (p.allies || []).map(r => windReportAt(bot, r, tick))
    if ([...throwers, ...allies].some(r => !r)) return { ok: false, why: 'stale_reports', gameTick: tick }
    const plan = planEnemyWind(bot, foe, throwers, { arena: p.arena, startTick: tick + lead, maxShots: p.maxShots ?? 2, allies })
    return { ok: !!plan, plan, gameTick: worldTick(bot), why: plan ? undefined : 'no_useful_native_chain' }
}

/** One atomic hand action beside the current fight; movement and defensive reflexes retain their owners. */
export async function enemyWindExecute(session, ctl, p: any = {}) {
  const bot = session.bot, plan = p.plan, tick = bot?.entity ? worldTick(bot) : null
  const fail = why => ({ ok: false, fired: false, why })
  const id = bot?.username || bot?.entity?.username, shot = plan?.shots?.find(s => s.thrower === id)
  if (tick === null || !shot || !Array.isArray(plan.shots) || plan.shots.length > 3 ||
    ![plan.gameTick, shot.fireTick, shot.arrivalTick, shot.ticks].every(Number.isSafeInteger) ||
    shot.fireTick < plan.gameTick || shot.fireTick > plan.gameTick + 26 || shot.ticks < 1 || shot.ticks > 30 || shot.arrivalTick !== shot.fireTick + shot.ticks ||
    ![shot.from, shot.aim, shot.feet, shot.burst, shot.velocity].every(finite) || !windInside(bot.entity.position, p.arena)) return fail('invalid_schedule')
  if (tick > shot.fireTick) return fail('shared_world_tick_missed')
  if (ctl.aborted || busy(session) || !hands.windReady(bot)) return fail('hands_or_defence_busy')
  const sight = windSight(bot)
  let fired = false, launchConfirmed = false, burstSeen = false, actual = null, firedTick = null
  const count = hands.windCount(bot)
  const cooldown = packet => { if (fired && /wind_charge/.test(String(packet?.cooldownGroup || '')) && packet.cooldownTicks > 0) launchConfirmed = true }
  const explosion = packet => {
    if (!fired || !actual || !finite(packet?.center) || packet.explosionParticle?.type !== 'gust_emitter_small' || Math.abs(packet.radius - WIND.reach / 2) > 1e-5) return
    if (Math.abs(worldTick(bot)! - firedTick - actual.ticks) > Math.ceil(actual.ticks * WIND.dispersion * Math.sqrt(3)) + 1) return
    const spread = WIND.speed * WIND.dispersion * Math.sqrt(3) * actual.ticks + .08
    if (vec(packet.center).distanceTo(vec(actual.burst)) <= spread) burstSeen = true
  }
  const waitTick = () => new Promise<void>(resolve => {
    const done = () => { bot.removeListener('physicsTick', done); const i = ctl.onAbort.indexOf(done); if (i >= 0) ctl.onAbort.splice(i, 1); resolve() }
    bot.once('physicsTick', done); ctl.onAbort.push(done)
    if (ctl.aborted) done()
  })
  const recheck = () => {
    const now = worldTick(bot)
    if (ctl.aborted || busy(session) || !(bot.health > 0) || now !== shot.fireTick || !hands.windReady(bot)) return null
    const foe = sight.observe(bot.players?.[plan.target]?.entity)
    if (!foe || !sight.visible(foe)) return null
    const preceding = plan.shots.filter(s => s !== shot && s.fireTick <= shot.fireTick && s.arrivalTick > now)
      .map(s => ({ ...s, fireDelay: s.fireTick - now }))
    const team = [own(bot), ...(p.allies || []).filter(r => r.id !== id).map(r => {
      const ally = sight.observe(bot.players?.[r.id]?.entity)
      return ally && sight.visible(ally) ? { ...r, position: { ...ally.position }, velocity: { ...ally.velocity }, onGround: !!ally.onGround, gameTick: now } : windReportAt(bot, r, now)
    })]
    if (!team.every(Boolean)) return null
    const frames = enemyWindFrames(bot, foe, p.arena, preceding, plan.resistance?.lo ?? 0)
    const candidate = enemyWindShot(bot, foe, own(bot), frames, { height: shot.aim.y - shot.feet.y, allies: team })
    if (!candidate || vec(candidate.feet).distanceTo(vec(shot.feet)) > WIND.reach) return null
    const world = edges.worldOf(observedCollision(bot)), observed = { ...bot, blockAt: p => world.getBlock(p) }
    return windTeamSafe(observed, team, [...preceding, candidate], p.arena) ? candidate : null
  }
  bot._client.on('set_cooldown', cooldown); bot._client.on('explosion', explosion)
  try {
    hands.install(bot)
    if (!hands.offWind(bot) && !await hands.ensureHotbar(bot, ['wind_charge'])) return fail('charge_not_in_hotbar')
    while (!ctl.aborted && worldTick(bot) !== null && worldTick(bot)! < shot.fireTick) { await ctl.waitReflex?.(); await waitTick() }
    if (ctl.aborted) return fail('cancelled')
    actual = recheck()
    if (!actual) return fail('local_trajectory_or_defence_changed')
    await bot.look(actual.yaw, actual.pitch, true)
    await new Promise<void>(resolve => edges.afterPacket(bot, () => {
      try {
        const release = recheck(), off = hands.offWind(bot), slot = hands.hotbarIndex(bot, 'wind_charge')
        if (!release || !off && slot < 0) return
        // The look packet already carries this angle; a changed direction requires a fresh plan, not a blind late throw.
        if (Math.abs(release.yaw - actual.yaw) > WIND.dispersion || Math.abs(release.pitch - actual.pitch) > WIND.dispersion) return
        const back = bot.quickBarSlot
        if (!off && back !== slot) bot.setQuickBarSlot(slot)
        actual = release; fired = true; firedTick = worldTick(bot)
        try { bot.activateItem(off); bot.usingHeldItem = false; bot._ndWindCd = clock.now() + WIND_CD_MS }
        finally { if (!off && back !== slot) bot.setQuickBarSlot(back) }
      } finally { resolve() }
    }))
    if (!fired) return fail('changed_before_release')
    while (!ctl.aborted && worldTick(bot) !== null && worldTick(bot)! <= firedTick + actual.ticks + 2) {
      if (hands.windCount(bot) < count) launchConfirmed = true
      if (burstSeen && launchConfirmed) break
      await waitTick()
    }
    return { ok: launchConfirmed, fired, launchConfirmed, burstSeen, fireTick: firedTick, arrivalTick: firedTick + actual.ticks, shot: actual,
      why: ctl.aborted ? 'interrupted_after_release' : launchConfirmed ? undefined : 'launch_unconfirmed' }
  } finally { bot._client.removeListener('set_cooldown', cooldown); bot._client.removeListener('explosion', explosion) }
}
