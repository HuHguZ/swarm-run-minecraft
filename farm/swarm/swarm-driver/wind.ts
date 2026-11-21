import { blockCount, distance } from './common'
import { arenaRoom, windOutward, WIND_FORECAST_TICKS, WIND_REPORT_AGE_TICKS, type WindArena } from '../../../daemon/src/combat/team-wind'
import { WIND_BID_RELEASE_MS, WIND_BID_REPLY_TICKS, windFlightLeaseMs, type WindBid } from '../../../daemon/src/combat/wind-coordination'
import { ambushPlan, ambushStand, AMBUSH_PEARL_TRAVEL_MS, AMBUSH_RUN, AMBUSH_WIND_LEAP_RANGE } from '../../../daemon/src/combat/pearl-ambush'
import type { SwarmDriverCtx } from './common'
import type { SwarmPosition } from '../../../daemon/src/swarm/types'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

// Фланг ветра (пользователь 24.10: «если они стоят под тем, кого подкидывают, не откинут — отойти в сторону»): взрыв
// толкает от центра порыва к глазам цели (ServerExplosion), а порыв — там, где заряд встретил её тело; брошенный снизу бьёт
// в ноги и только подкидывает, брошенный полого сбоку — уносит вбок. Враг в воздухе или у края — до трёх свободных с
// зарядами, кто стоит под ним или снаружи, идут на сторону центра на пологий угол (дальше, чем он высоко); бросок решает
// тело само (combat/wind-out: вылетит ли от моего броска сейчас).
const FLANK_N = 3, FLANK_RANGE = 18, FLANK_MS = 2500
export function flankSpots(target: { x: number; y: number; z: number }, arena: WindArena, floorY: number, shooters: { x: number; y: number; z: number }[]) {
  let ux = target.x - arena.x, uz = target.z - arena.z
  if (arena.ellipse) {
    const axis = windOutward(arena, target)
    ux = axis.x; uz = axis.z
  } else if (Math.hypot(ux, uz) < 1) {
    const c = shooters.reduce((a, p) => ({ x: a.x + p.x / shooters.length, z: a.z + p.z / shooters.length }), { x: 0, z: 0 })
    ux = target.x - c.x; uz = target.z - c.z
  }
  const n = Math.hypot(ux, uz) || 1; ux /= n; uz /= n
  const h = Math.max(0, target.y - floorY), back = Math.min(12, 5 + 1.5 * h)
  // Плохой угол: ближе по горизонтали, чем 1.5 высоты (снизу — в ноги), или не со стороны центра (толкнёт внутрь).
  const bad = (p: { x: number; y: number; z: number }) => Math.hypot(p.x - target.x, p.z - target.z) < Math.max(3, 1.5 * Math.abs(target.y - p.y)) || (p.x - target.x) * ux + (p.z - target.z) * uz > -2
  const spots = [0, -1, 1].map(k => ({ x: target.x - ux * back - uz * 3 * k, y: floorY, z: target.z - uz * back + ux * 3 * k }))
    .map(p => { const m = Math.max(Math.abs(p.x - arena.x), Math.abs(p.z - arena.z)), lim = arena.r - 2; return m > lim ? { x: arena.x + (p.x - arena.x) * lim / m, y: p.y, z: arena.z + (p.z - arena.z) * lim / m } : p })
  return { spots, bad, out: { x: ux, z: uz }, back }
}

/** An observation may start one short chain per team; it never stops an existing fight or defence. */
export function swarmWind(sw: SwarmDriverCtx) {
  const { bots, pos, now, alive, teamOf, arena, log } = sw
  // До края: в Колизее — до внешней стены по эллипсу (combat/team-wind arenaRoom).
  const edgeRoom = (q: { x: number; z: number }) => arenaRoom(arena, q)
  const pending = new Map<string, object>()
  const attempted = new Map<string, string>()
  const witnesses = new WeakMap<object, { round: number; team: string; at: number; targets: Set<string> }>()
  const finishes = new Map<string, { until: number; active: boolean }>()
  const sharedOrders = new Set<string>()
  const bids = new Map<string, { actor: object; id: number; entity: number; prefix?: number; until: number; released: boolean }>()
  // If an ally crosses the winner's ray, hand the same observed pearl to a waiting teammate.
  const standby = new Map<string, Map<object, { id: number; answer: (tryOpen: boolean) => boolean }>>()
  let bidRound = sw.generation
  const followKey = (key: string) => key + ':follow'
  const liveBid = (key: string, at: number, entity?: number) => {
    const bid = bids.get(key)
    return bid && at <= bid.until && (entity === undefined || bid.entity === entity) ? bid : undefined
  }
  const targetHasBid = (round: number, key: string, wall: number) =>
    bidRound === round && (liveBid(key, wall) || liveBid(followKey(key), wall))
  const planningMs = new Map<string, number>()
  let generation = sw.generation
  const detail = reply => reply?.detail || reply || {}
  const protectedAction = (b, flying = false) => b.maceDefense?.until > now() || b.climbing || pos[b.name]?.rescuing || !flying && pos[b.name]?.gliding ||
    (/^(lava_escape|dodge_blast|clear_web|evade|juke|take_cover|douse_lava|pearl_to|wind_jump|wind_leap|fly_to|burrow|block_behind|peek_shot)$/.test(b.last?.m || '') || b.shieldHold && b.last?.m === 'swarm_hold') && b.last?.pending !== false
  // Preflight is a query: panic() caches the strategic verdict and must not run for an unused wind opportunity.
  // Отходящий по плану (flee, recover) — не в наряд: караул и фланг слали его обратно к человеку под лук (игра пользователя 24.10).
  // Вырезает союзника из паутины (dangers webRescue) — не уводить фланом (Codex 25.10, C-HELPER-FAILURE: g летел на ярус, q так и сидел).
  const plannedTask = b => sw.planned?.get(teamOf(b))?.get(b.name)
  // Both the running owner and the fresh priced choice survive a helper's movement request.
  const protectedTask = t => /^(flee|recover)$/.test(t?.kind || '') || t?.data?.rearm || t?.kind === 'fight' && t.data?.shove
  const available = (b, own?: object, flying = false) => alive(b.name) && !!pos[b.name]?.p && (!b.swarmReserved || b.swarmReserved === own) && !b.webRescue && !pos[b.name]?.combo && !protectedAction(b, flying) && !protectedTask(b.swarmTask) && !protectedTask(plannedTask(b))
  const movementFree = b => !sw.commandOwnsMovement?.(b)
  const boostArcher = o => {
    const m = pos[o.name]
    return m?.inv?.bow > 0 && m.inv.arrow > 0 && m.enchants?.some(it => it.name === 'bow' && it.slot >= 9 && it.slot <= 44 && it.ench?.punch > 0) !== false
  }
  const leavingUpperReserve = (b, at) => {
    const p = pos[b.name]?.p
    if (!sw.arms || !p || ![b.swarmTask, plannedTask(b)].some(t => t?.kind === 'goto' && t.data?.reserve && t.data?.sentry &&
        !t.data.target && !t.data.search && t.position && distance(p, t.position) <= (t.data.range ?? 2))) return false
    const upper = [...(sw.hideouts || []), ...(sw.chestTops || [])].filter(h => h.tier > 0 && h.y <= p.y)
      .sort((a, c) => distance(p, a) - distance(p, c))[0]
    // Optional helper movement pays the same occupied-upper geometry as the strategic reserve.
    return !!upper && distance(p, upper) < Math.min(distance(p, at), distance(at, upper))
  }
  const windAvailable = (b, target?: string) => available(b, wingToken(b, target), true)
  // В рукопашной — не трогать ходом на точку (бой роя 24.10: караул и разгон прервали goto 54 боя из 89, ⚔ cancelled by goto).
  const meleeBusy = b => b.last?.m === 'fight' && b.last.pending === true
  const charged = b => (pos[b.name]?.inv?.wind_charge || 0) > 0 || pos[b.name]?.offHand?.item === 'wind_charge'
  const groundMace = (b, own?: object) => available(b, own) && !meleeBusy(b) &&
    !(b.last?.pending !== false && /^(pearl_ambush|pearl_trap|boost_lance|boost_shot|wing_orbit)$/.test(b.last?.m || '')) &&
    (pos[b.name]?.inv?.mace || 0) > 0 && charged(b)
  const assaulting = (b, target: string) => b.swarmTask?.kind === 'fight' && b.swarmTask.data?.committed && b.swarmTask.data?.assault && b.swarmTask.data?.target === target
  function windBid(b, q: WindBid & { id: number; type: string; shot?: Pick<WindBid, 'tick' | 'ticks'> }): boolean | Promise<boolean> {
    if (bidRound !== sw.generation) {
      bids.clear(); bidRound = sw.generation
      for (const line of standby.values()) for (const waiter of line.values()) waiter.answer(false)
    }
    if (typeof q.target !== 'string' || !Number.isSafeInteger(q.entity) || !Number.isSafeInteger(q.id)) return false
    const prefix = q.prefix
    if (prefix !== undefined && (!Number.isSafeInteger(prefix) || prefix <= 0 || prefix === q.entity)) return false
    const pearl = q.pearl
    if (pearl !== undefined && (!Number.isSafeInteger(pearl) || pearl <= 0 || pearl === q.entity || prefix !== undefined)) return false
    const key = `${bidRound}:${teamOf(b)}:${q.target}`
    const slot = pearl !== undefined ? `${key}:pearl:${pearl}` : prefix === undefined ? key : followKey(key)
    const at = performance.now()
    // A long round creates many projectile IDs. Keep only reservations that can still affect an incoming bid.
    if (pearl !== undefined) for (const [id, bid] of bids) if (bid.until < at && id.includes(':pearl:')) bids.delete(id)
    const previous = bids.get(slot)
    const validFlight = (s: Pick<WindBid, 'tick' | 'ticks'>) => Number.isSafeInteger(s.tick) &&
      Number.isSafeInteger(s.ticks) && s.ticks > 0 && s.ticks <= WIND_FORECAST_TICKS
    if (q.type === 'wind_bid_done') {
      const line = standby.get(slot), cancelled = line?.get(b)
      if (cancelled?.id === q.id) cancelled.answer(false)
      if (previous?.actor === b && previous.id === q.id && previous.entity === q.entity && previous.prefix === prefix) {
        if (q.shot && validFlight(q.shot)) {
          previous.released = true
          previous.until = at + windFlightLeaseMs(q.shot.ticks)
        } else bids.delete(slot)
        if (line) for (const waiter of line.values()) if (waiter.answer(!bids.has(slot))) break
      }
      return false
    }
    if (!validFlight(q) || !alive(b.name) || !sw.hostile(b, q.target) || pearl === undefined && sharedOrders.has(key)) return false
    const held = liveBid(slot, at, q.entity)
    if (held) {
      if (pearl === undefined || q.standby !== true || held.released || held.actor === b) return false
      let line = standby.get(slot)
      if (!line) { line = new Map(); standby.set(slot, line) }
      if (line.has(b)) return false
      const round = bidRound, team = teamOf(b)
      return new Promise<boolean>(resolve => {
        const answer = (tryOpen: boolean) => {
          clearTimeout(timer); line.delete(b)
          if (!line.size) standby.delete(slot)
          const granted = tryOpen && sw.generation === round && teamOf(b) === team && windBid(b, { ...q, standby: undefined }) === true
          resolve(granted)
          return granted
        }
        const timer = setTimeout(() => answer(false), WIND_BID_REPLY_TICKS * 50)
        timer.unref()
        line.set(b, { id: q.id, answer })
      })
    }
    const lead = liveBid(key, at, q.entity)
    if (pearl === undefined && (prefix === undefined ? liveBid(followKey(key), at, q.entity) : lead && (!lead.released || lead.actor === b))) return false
    // Keep room for a launch receipt delayed behind another socket's request. Refusal clears immediately.
    bids.set(slot, { actor: b, id: q.id, entity: q.entity, prefix, released: false,
      until: at + WIND_BID_RELEASE_MS + windFlightLeaseMs(WIND_FORECAST_TICKS) })
    return true
  }
  async function windObserve(b, sightings, seenAt = now()) {
    const round = sw.generation, team = teamOf(b), key = `${round}:${team}`, token = {}, reserved: any[] = []
    const current = () => round === sw.generation && alive(b.name)
    const age = now() - seenAt
    if (!current() || !Number.isFinite(age) || age < 0 || age > 1000) return false
    const visible = (sightings || []).filter(e => e.position && e.visible === true && sw.hostile(b, e.id))
    const previous = witnesses.get(b)
    // Keep direct sightings even while another observer is collecting the team's reports.
    if (!previous || previous.round !== round || previous.team !== team || previous.at <= seenAt)
      witnesses.set(b, { round, team, at: seenAt, targets: new Set(visible.map(e => e.id)) })
    if (pending.has(key)) return false
    const wall = performance.now()
    const open = visible.filter(e => !targetHasBid(round, `${key}:${e.id}`, wall))
    if (!open.length) return false
    const roster = bots.filter(o => teamOf(o) === team && alive(o.name) && pos[o.name]?.p)
    const escorted = new Set<string>()
    const unrestricted = roster.some(o => {
      if (!charged(o) || !windAvailable(o)) return false
      if (!o.swarmReserved) return true
      // windAvailable accepts a reserved thrower only under its own live wing lease.
      escorted.add(winging.get(o.name).foe)
      return false
    })
    const eligible = unrestricted ? open : open.filter(e => escorted.has(e.id))
    if (!eligible.length) return false
    const target = eligible.sort((a, c) => edgeRoom(a.position) - edgeRoom(c.position) ||
      distance(a.position, pos[b.name].p) - distance(c.position, pos[b.name].p))[0]
    if (generation !== round) { attempted.clear(); finishes.clear(); planningMs.clear(); generation = round }
    const scene = JSON.stringify([target.id, target.position, target.velocity, target.equipment,
      roster.map(o => [o.name, pos[o.name].p, pos[o.name].v, pos[o.name].velocity, pos[o.name].armor,
        pos[o.name].inv?.wind_charge || 0, pos[o.name].offHand, windAvailable(o, target.id), groundMace(o)])])
    if (attempted.get(key) === scene) return false
    pending.set(key, token)
    let coordination: string | undefined
    const finishKey = `${key}:${target.id}`
    const releaseOrder = () => {
      const id = coordination
      if (!id) return
      coordination = undefined
      sharedOrders.delete(finishKey)
      void Promise.allSettled(roster.map(async o => o.c.call('wind_report', { target: target.id, flying: true, coordination: id, cancel: true })))
    }
    let fallback: (() => Promise<false>) | undefined
    let planMs = planningMs.get(team) ?? 0
    let refreshAllies: string[] | undefined
    try {
      // A cold native forecast may miss its first launch window; one measured replan replaces that stale schedule.
      for (let attempt = 0; attempt < 2; attempt++) {
        const reports = await Promise.all(roster.map(async o => {
          const start = now(), reply = detail(await o.c.call('wind_report', { target: target.id, flying: true }).catch(() => null))
          return { bot: o, ...reply, at: now(), ms: now() - start }
        }))
        if (!current() || targetHasBid(round, finishKey, performance.now())) return false
        const bodies = reports.filter(r => r.ok && r.report && Number.isSafeInteger(r.gameTick))
        if (refreshAllies?.some(id => !bodies.some(r => r.bot.name === id))) return false
        const ready = bodies.filter(r => r.ready && windAvailable(r.bot, target.id) && charged(r.bot))
        const helpers = bodies.filter(r => r.report.onGround === true && !r.report.gliding && groundMace(r.bot))
        if (!ready.length && !helpers.length) return false
        const rtt = Math.max(0, ...bodies.map(r => r.ms))
        const handoffTicks = Math.ceil(rtt / 50)
        if (2 * handoffTicks + 1 > 20) return false
        const leadTicks = Math.min(20, Math.max(2, Math.ceil((rtt + planMs) / 50) + 1 + handoffTicks))
        // A newer witness can plan without waiting for this observer's body to catch up.
        let observer = b, observerTick = bodies.find(r => r.bot === b)?.gameTick ?? -Infinity
        for (const r of bodies) {
          const w = witnesses.get(r.bot), age = w ? now() - w.at : Infinity
          if (r.gameTick > observerTick && r.report.id === r.bot.name && r.report.gameTick === r.gameTick &&
              alive(r.bot.name) && teamOf(r.bot) === team && w?.round === round && w.team === team &&
              age >= 0 && age <= 1000 && w.targets.has(target.id)) {
            observer = r.bot
            observerTick = r.gameTick
          }
        }
        // Offer every ready thrower; the native kernel owns the bounded certification work.
        const maxShots = ready.length, start = now(), proposal = detail(await observer.c.call('enemy_wind_plan', {
          target: target.id, throwers: ready.map(r => r.report), allies: bodies.map(r => r.report), arena, leadTicks, maxShots,
          ...(helpers.length ? { finish: true } : {})
        }).catch(() => null))
        planMs = now() - start
        if (!current() || !alive(observer.name) || teamOf(observer) !== team) return false
        // A quick retry can reuse warmed physics. Keep some of the cold cost for the next observer.
        if (proposal.ok || proposal.why === 'planning_deadline' || proposal.why === 'no_useful_native_chain') {
          const previous = planningMs.get(team) ?? 0
          planningMs.set(team, Math.max(planMs, .75 * previous + .25 * planMs))
        }
        // A local bid may win while native planning runs. Its target is unavailable for this retry and its result cannot settle the next opening.
        if (targetHasBid(round, finishKey, performance.now())) return false
        fallback = undefined
        if (proposal.why === 'planning_deadline') continue
        if (proposal.why === 'invalid_or_stale_reports' && Number.isSafeInteger(proposal.gameTick) &&
            bodies.some(r => proposal.gameTick - r.gameTick > WIND_REPORT_AGE_TICKS)) {
          refreshAllies = bodies.map(r => r.bot.name)
          continue
        }
        const plan = proposal.plan
        const finish = proposal.finish
        // An inside landing is a secondary target, after shared wind has no live release.
        if (helpers.length && finish?.target === target.id && Number.isSafeInteger(finish.gameTick) &&
            finish.gameTick === proposal.gameTick && Number.isSafeInteger(finish.ticks) && finish.ticks > 0 &&
            finish.at && [finish.at.x, finish.at.y, finish.at.z].every(Number.isFinite) &&
            finish.at.y > (arena.killY ?? -Infinity) && edgeRoom(finish.at) > 0 &&
            !plan?.nominal?.out && !plan?.worst?.out && !plan?.fallThreat) {
          fallback = async () => {
            const previous = finishes.get(finishKey)
            if (previous && (previous.active || previous.until > finish.gameTick)) return false
            const eligible = o => teamOf(o) === team && groundMace(o, reserved.includes(o) ? token : undefined)
            const until = finish.gameTick + finish.ticks
            let currentTick = Math.max(finish.gameTick, ...bodies.map(r => r.gameTick))
            const canReach = (p, o) => {
              if (!p || ![p.x, p.y, p.z].every(Number.isFinite) || currentTick >= until) return false
              const stand = ambushStand(p, finish.at), run = Math.hypot(stand.x - p.x, stand.z - p.z)
              const left = (until - currentTick) * 50
              // The body verifies terrain and an actual wind-leap ray before taking this route.
              return !!ambushPlan(left, finish.at.y - p.y, run / AMBUSH_RUN * 1000) || run <= AMBUSH_WIND_LEAP_RANGE ||
                (pos[o.name].inv?.ender_pearl || 0) > 0 && pos[o.name].hp > 9 && !!ambushPlan(left - AMBUSH_PEARL_TRAVEL_MS, 0)
            }
            const candidates = helpers.filter(r => eligible(r.bot) && canReach(r.report.position, r.bot))
              .sort((a, c) => distance(a.report.position, finish.at) - distance(c.report.position, finish.at))
            const reservation = { until, active: true }
            let next = 0, retryEntity: number | undefined
            const valid = () => {
              if (!current() || teamOf(b) !== team || !sw.hostile(b, target.id) || currentTick >= until) return false
              return (retryEntity === undefined || finishes.get(finishKey) === reservation) && !sharedOrders.has(finishKey) &&
                !targetHasBid(round, finishKey, performance.now())
            }
            const dispatch = async (): Promise<boolean> => {
              while (next < candidates.length && valid()) {
                const { bot: o, report } = candidates[next++]
                if (!eligible(o) || !canReach(report.position, o)) continue
                const latest = detail(await o.c.call('wind_report', { target: target.id, flying: false }).catch(() => null))
                if (!valid()) return false
                if (!latest.ok || latest.report?.id !== o.name || latest.report.gameTick !== latest.gameTick ||
                    !Number.isSafeInteger(latest.gameTick) || latest.gameTick < finish.gameTick) continue
                currentTick = Math.max(currentTick, latest.gameTick)
                if (!latest.ready || latest.report.onGround !== true || latest.report.gliding ||
                    !eligible(o) || !canReach(latest.report.position, o) || sw.panic(o)) continue
                finishes.set(finishKey, reservation)
                o.swarmReserved = reservation
                // A committed helper may fight for seconds. It must not hold the team's planning lock.
                void (async () => {
                  let reply, owned = false
                  try {
                    reply = await o.c.call('pearl_ambush', { kind: 'wind', owner: target.id, at: finish.at,
                      eta: finish.ticks, gameTick: finish.gameTick, arena, ...(retryEntity === undefined ? {} : { entity: retryEntity }) })
                  } finally {
                    owned = o.swarmReserved === reservation
                    if (owned) delete o.swarmReserved
                  }
                  const d = detail(reply)
                  if (current()) log(`🌬🔨 ${o.name} → ${target.id}: ${d.hit ? 'удар после ветра' : d.why || reply?.error || 'без удара'}`)
                  if (owned && reply?.status === 'done' && d.ok === false && d.retry === 'no_route_before_move' &&
                      Number.isSafeInteger(d.entity) && d.entity > 0 && (retryEntity === undefined || retryEntity === d.entity) &&
                      Number.isSafeInteger(d.gameTick) && d.gameTick >= latest.gameTick) {
                    currentTick = Math.max(currentTick, d.gameTick)
                    retryEntity = d.entity
                    if (await dispatch()) return
                  }
                  reservation.active = false
                })().catch(() => { reservation.active = false })
                return true
              }
              return false
            }
            await dispatch()
            return false
          }
        }
        if (proposal.ok || proposal.why === 'no_useful_native_chain') attempted.set(key, scene)
        if (!proposal.ok || !plan?.shots?.length || plan.shots.length > maxShots)
          return proposal.why === 'no_useful_native_chain' && fallback ? await fallback() : false
        const currentTick = Math.max(...bodies.map(r => r.gameTick + Math.ceil((now() - r.at) / 50)))
        if (plan.shots.some(s => !Number.isSafeInteger(s.fireTick) || s.fireTick <= currentTick + handoffTicks)) continue
        const shooters = [...new Set<string>(plan.shots.map(s => s.thrower))].map(id => ready.find(r => r.bot.name === id)?.bot)
        if (shooters.some(o => !o || !windAvailable(o, target.id))) return fallback ? await fallback() : false
        coordination = randomUUID()
        sharedOrders.add(finishKey)
        const acks = await Promise.all(roster.map(async o => detail(await o.c.call('wind_report', {
          target: target.id, flying: true, coordination
        }).catch(() => null))))
        if (!current() || acks.some(r => !r.ok || r.coordination !== coordination || !Number.isSafeInteger(r.gameTick))) return false
        const dispatchTick = Math.max(...acks.map(r => r.gameTick))
        if (plan.shots.some(s => s.fireTick <= dispatchTick)) {
          releaseOrder()
          continue
        }
        if (shooters.some(o => !o || !windAvailable(o, target.id) || sw.panic(o))) return false
        for (const o of shooters) if (!o.swarmReserved) { o.swarmReserved = token; reserved.push(o) }
        const latestAllies = new Map(bodies.map(r => [r.bot.name, r.report]))
        acks.forEach((ack, i) => {
          if (ack.report?.id === roster[i].name && ack.report.gameTick === ack.gameTick) latestAllies.set(ack.report.id, ack.report)
        })
        const allies = [...latestAllies.values()]
        const execute = async (o, params) => detail(await o.c.call('wind_out', { ...params, arena, coordination, allies })
          .catch(e => ({ why: e.message })))
        const actors = [...shooters]
        const results = await Promise.all(shooters.map(o => execute(o, { plan })))
        if (!current()) return false
        // Only confirmed pre-launch refusals permit another shooter to use this order.
        if (results.every(r => r.fired === false) && (shooters.length > 1 || results[0].why === 'hands_or_defence_busy')) {
          const retryAvailable = o => available(o, reserved.includes(o) ? token : wingToken(o, target.id), true)
          const candidates = [...shooters.filter((_, i) => results[i].why !== 'hands_or_defence_busy'),
            ...ready.map(r => r.bot).filter(o => !shooters.includes(o))
              .sort((a, b) => distance(pos[a.name].p, target.position) - distance(pos[b.name].p, target.position))]
            .filter(retryAvailable)
          const probes = await Promise.all(candidates.map(async o => detail(await o.c.call('wind_report', {
            target: target.id, flying: true, coordination, probe: true
          }).catch(() => null))))
          if (!current()) return false
          const next = candidates.find((o, i) => probes[i].ok && probes[i].coordination === coordination &&
            probes[i].ready && probes[i].targetVisible === true && retryAvailable(o) && !sw.panic(o))
          if (next) {
            if (!next.swarmReserved) { next.swarmReserved = token; reserved.push(next) }
            actors.push(next)
            results.push(await execute(next, { target: target.id, replan: true }))
            if (!current()) return false
          }
        }
        const fired = results.filter(r => r.fired).length, confirmed = results.filter(r => r.launchConfirmed).length, bursts = results.filter(r => r.burstSeen).length
        log(`🌬 ${team} → ${target.id}: цепочка ${fired}/${actors.length}, запуск подтверждён ${confirmed}, всплесков видно ${bursts}`)
        if (process.env.ND_WIND_TRACE === '1') log(`wind dispatch ${target.id}: ${JSON.stringify(results.map((r, i) => [actors[i].name, r.why, r.fireTick, r.arrivalTick]))}`)
        if (fallback && results.every(r => r.fired === false)) { releaseOrder(); return await fallback() }
        return fired > 0
      }
      attempted.delete(key)
      return fallback ? await fallback() : false
    } finally {
      for (const o of reserved) if (o.swarmReserved === token) delete o.swarmReserved
      releaseOrder()
      if (pending.get(key) === token) pending.delete(key)
    }
  }
  // Караул жемчуга (тело: combat/pearl-watch): враг бросил жемчуг — двое ближайших свободных бойцов команды идут в точку
  // приземления, пока он летит; бой подхватит их там (wind-out у края, удар в момент появления). Один жемчуг — один вызов.
  const pearlsSeen = new Map<string, number>()
  function pearlObserve(b, pearls) {
    for (const pl of pearls || []) {
      if (!pl.at || ![pl.at.x, pl.at.y, pl.at.z, pl.eta].every(Number.isFinite) || pl.eta < 0 ||
          pl.gameTick !== undefined && !Number.isSafeInteger(pl.gameTick)) continue
      const key = `${sw.generation}:${pl.owner}:${pl.id}`
      if (pearlsSeen.has(key) || !sw.hostile(b, pl.owner)) continue
      pearlsSeen.set(key, now()); if (pearlsSeen.size > 200) pearlsSeen.delete(pearlsSeen.keys().next().value!)
      const team = teamOf(b), at = { x: pl.at.x, y: Math.round(pl.at.y), z: pl.at.z }
      if (arena && (Math.abs(at.x - arena.x) > arena.r - 1 || Math.abs(at.z - arena.z) > arena.r - 1 || at.y <= (arena.killY ?? -64))) { log(`🟣 ${pl.owner}: жемчуг за край (${Math.round(at.x)},${at.y},${Math.round(at.z)}) — не встречаем`); continue }
      // Засада (пользователь 24.10: «заранее там взлетают, чтобы сразу долбануть булавой и ваншотнуть»): до трёх с булавой и
      // зарядом в 30 бл. — к точке любым способом (бег, ветер, свой жемчуг — выбирает тело: combat/pearl-ambush) и взлёт к
      // его появлению, с разных сторон (120°); без булавы — один, кто добежит (бег 5.6 бл./с, 3 бл. на удар).
      const reach = 3 + 5.6 * pl.eta / 20
      // Ответ на жемчуг — шанс на ваншот, важнее мелких дел: снимает с караула, разгона, полёта на насест, подъёма и хода
      // (бой роя 24.10, испытание «жемчуг вверх»: на полёт 85–113 т. «к точке никто» — 9–14 своих в fly_to, с булавой в
      // 4–13 бл. «занят»). Не трогает рукопашную, щит от булавы, уворот, выход из лавы и паутины, связку.
      const hardReaction = o => o.maceDefense?.until > now() || /^(lava_escape|dodge_blast|clear_web|evade|juke|douse_lava|burrow|block_behind|pearl_ambush|pearl_trap|boost_lance)$/.test(o.last?.m || '') && o.last?.pending !== false
      // Кого враг уже достаёт (в 8 бл.), тот не встречает жемчуг: дерётся или уходит сам (игра пользователя 24.10).
      const pressed = o => sw.boardOf(o).enemies().some(e => now() - e.seenAt < 1500 && distance(e.position, pos[o.name].p) <= 8)
      const free = bots.filter(o => teamOf(o) === team && alive(o.name) && !!pos[o.name]?.p && !o.webRescue && !pos[o.name]?.combo && !hardReaction(o) && !meleeBusy(o) && !sw.panic(o) && !pressed(o))
      const smashers = free.filter(o => (pos[o.name].inv?.mace || 0) > 0 && (pos[o.name].inv?.wind_charge || 0) > 0 && distance(pos[o.name].p, at) <= 30)
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at)).slice(0, 2) // двое: третий ближний — ловушка или зелье (бой 24.10: их набор был только в 30–90 бл.)
      const walkers = free.filter(o => movementFree(o) && !smashers.includes(o) && distance(pos[o.name].p, at) <= reach)
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at)).slice(0, smashers.length ? 1 : 2)
      log(`🟣 ${pl.owner} бросил жемчуг → ${Math.round(at.x)},${at.y},${Math.round(at.z)} через ${pl.eta} т. (видел ${b.name}; стазис 3×1 поймал бы: ${pl.stasis ? 'да' : 'нет'}); засада: ${smashers.map(o => `${o.name} (${distance(pos[o.name].p, at).toFixed(0)} бл.)`).join(', ') || 'нет булав'}; встречают: ${walkers.map(o => `${o.name} (${distance(pos[o.name].p, at).toFixed(0)} бл.)`).join(', ') || '—'}`)
      // Булава проверяет ETA от исходного игрового тика, когда он есть в наблюдении.
      const seenAt = Date.now(), base = Math.random() * Math.PI * 2
      const forecast = { at: pl.at, eta: pl.eta, ...(pl.gameTick === undefined ? {} : { gameTick: pl.gameTick }) }
      smashers.forEach((o, k) => {
        const token = {}; o.swarmReserved = token
        void o.c.call('pearl_ambush', { owner: pl.owner, ...forecast, seenAt, side: base + k * 2 * Math.PI / 3, arena })
          .then(r => { const d = r?.detail || r || {}; log(`🟣🔨 ${o.name} → ${pl.owner}: ${d.ok ? (d.hit ? `удар булавой в точке появления${d.fall ? ' с ' + d.fall + ' бл.' : ''}${d.dealt != null ? ', снял ' + Math.round(d.dealt) : ''}` : 'взлетел, мимо') : 'не взлетел — ' + (d.why || r?.error || '?')} (${d.travel || '—'})`) })
          .catch(() => {}).finally(() => { if (o.swarmReserved === token) delete o.swarmReserved })
      })
      // Every available wind holder may offer a shot; the body checks the actual ray and arrival deadline.
      const poppers = free.filter(o => available(o, undefined, true) && !smashers.includes(o) && !walkers.includes(o) && ((pos[o.name].inv?.wind_charge || 0) > 0 || pos[o.name].offHand?.item === 'wind_charge'))
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at))
      for (const o of poppers) void o.c.call('pearl_pop', { owner: pl.owner, ...forecast, contact: pl.contact, block: pl.block, seenAt })
        .then(r => { const d = r?.detail || r || {}; log(`🟣🌬 ${o.name} → ${pl.owner}: подброс в точке появления — ${d.ok ? `бросил, всплеск ${d.lateMs >= 0 ? '+' : ''}${d.lateMs} мс от появления` : d.why || r?.error || '?'}`) }).catch(() => {})
      // Ловушка и подкоп (combat/pearl-trap): с засадой — паутина в клетку появления (держит его под булавой; лава — нет:
      // засадчик падает туда же); без засады — лава, паутина или подкоп блока удара (яма / жемчуг в пустоту), что успеет.
      const used = new Set([...smashers, ...walkers, ...poppers])
      const inv = o => pos[o.name].inv || {}
      const trapKit = o => (inv(o).cobweb || 0) > 0 || !smashers.length && ((inv(o).lava_bucket || 0) > 0 || Object.keys(inv(o)).some(n => /_pickaxe$/.test(n)))
      const trapper = free.filter(o => !used.has(o) && trapKit(o) && distance(pos[o.name].p, at) <= 4.2 + 5.6 * pl.eta / 20 - 1)
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at))[0]
      // Разгон стрелой к точке появления (пользователь 24.10: «стрелами тоже кидать друг друга к жемчугу»; combat/arrow-boost):
      // место и тик известны, и первые тики он стоит. Копейщик — в 7 бл. от точки со своей стороны, 1–3 лучника — за ним по
      // той же линии; когда стрелять — считают тела по своим часам (at, eta). Только с запасом на подбег (от 2 с полёта).
      const lancerOk = o => Object.entries(inv(o)).some(([n, c]) => /_spear$/.test(n) && Number(c) > 0)
      const runFor = (o, spot) => distance(pos[o.name].p, spot) <= 5.6 * (pl.eta / 20 - 1.8)
      const lancer = pl.eta >= 40 ? free.filter(o => !used.has(o) && o !== trapper && lancerOk(o)).sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at))[0] : null
      if (lancer) {
        let ux = pos[lancer.name].p.x - at.x, uz = pos[lancer.name].p.z - at.z
        const n = Math.hypot(ux, uz) || 1; ux /= n; uz /= n
        const spot = (k: number, side = 0) => ({ x: at.x + ux * k - uz * side, y: at.y, z: at.z + uz * k + ux * side })
        const S = spot(BOOST_D), spots = [spot(BOOST_D + 3, -.6), spot(BOOST_D + 3, .6), spot(BOOST_D + 4.5)]
        const archers = runFor(lancer, S) ? free.filter(o => !used.has(o) && o !== lancer && o !== trapper && boostArcher(o)).sort((x, y) => distance(pos[x.name].p, S) - distance(pos[y.name].p, S)).slice(0, 3).filter((o, k) => runFor(o, spots[k])) : []
        if (archers.length) {
          const crew = [lancer, ...archers]; crew.forEach(o => used.add(o))
          const tokens = crew.map(o => { const t = {}; o.swarmReserved = t; return t })
          const draws = BOOST_DRAW.slice(0, archers.length), maxDraw = Math.max(...draws)
          const flight = archers.map((o, k) => Math.ceil((k < 2 ? 3 : 4.5) / arrowSpeed(draws[k])))
          log(`🟣🏹 ${team} разгон к точке появления ${pl.owner}: копьё ${lancer.name}, лучники ${archers.map(o => o.name).join(', ')} (${pl.eta} т.)`)
          void (async () => {
            const lance = lancer.c.call('boost_lance', { foe: pl.owner, ...forecast, stand: S, lead: maxDraw + 4, from: archers.map(o => o.name) }).catch(err => ({ detail: { why: err.message } }))
            const shots = await Promise.all(archers.map((o, k) => o.c.call('boost_shot', { ally: lancer.name, foe: pl.owner, ...forecast, stand: spots[k], draw: draws[k], lag: Math.max(...flight) - flight[k], wait: maxDraw - draws[k] }).catch(err => ({ detail: { why: err.message } }))))
            const r = await lance, d = r?.detail || r || {}
            log(`🟣🏹 ${lancer.name} → ${pl.owner}: ${d.hit ? 'удар копьём в точке появления' : 'без удара' + (d.why ? ' — ' + d.why : '')}, скорость ${d.vmax ?? '?'} бл/т; стрелы: ${shots.map((s: any) => { const x = s?.detail || s || {}; return x.ok ? (x.hit ? 'попал' : 'мимо') : x.why || '?' }).join(', ')}`)
          })().finally(() => crew.forEach((o, k) => { if (o.swarmReserved === tokens[k]) delete o.swarmReserved }))
        }
      }
      // Зелье в точку появления (combat/pearl-ambush pearlPotion): ближайший в 16 бл. со взрывным или оседающим — вредное
      // ли оно, решает тело. Бросок с места, без хода — не эксклюзивно, как подброс.
      const potter = free.filter(o => !used.has(o) && o !== trapper && ((inv(o).lingering_potion || 0) > 0 || (inv(o).splash_potion || 0) > 0) && distance(pos[o.name].p, at) <= 16)
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at))[0]
      if (potter) void potter.c.call('pearl_potion', { owner: pl.owner, ...forecast })
        .then(r => { const d = r?.detail || r || {}; log(`🟣🧪 ${potter.name} → ${pl.owner}: ${d.ok ? `${d.kind === 'lingering_potion' ? 'облако' : 'брызги'} ${d.potion} в точку появления, ${d.lateMs >= 0 ? '+' : ''}${d.lateMs} мс` : 'не бросил — ' + (d.why || r?.status)}`) }).catch(() => {})
      {
        const near = (f: (o: any) => boolean) => { const xs = free.filter(o => !used.has(o) && f(o)); return xs.length ? Math.min(...xs.map(o => distance(pos[o.name].p, at))).toFixed(0) + ' бл.' : 'нет' }
        log(`🟣· ${pl.owner}: ловушка ${trapper?.name || 'нет (ближайший с набором ' + near(trapKit) + ')'}, зелье ${potter?.name || 'нет (' + near(o => (inv(o).lingering_potion || 0) + (inv(o).splash_potion || 0) > 0) + ')'}, разгон ${lancer ? lancer.name : 'нет'}`)
      }
      // Никто не пошёл — почему (бой роя 24.10: на полёты 78–88 т. «засада: нет булав, встречают: —», ловушек 0).
      if (!smashers.length && !trapper && !walkers.length && !potter) {
        const mine = bots.filter(o => teamOf(o) === team && alive(o.name) && pos[o.name]?.p), near = (xs: any[]) => xs.length ? Math.min(...xs.map(o => distance(pos[o.name].p, at))).toFixed(0) + ' бл.' : 'нет'
        const why = (o: any) => pos[o.name]?.combo ? 'связка' : hardReaction(o) ? `реакция ${o.maceDefense?.until > now() ? 'щит от булавы' : o.last?.m}` : meleeBusy(o) ? 'рукопашная' : sw.panic(o) ? 'паника' : 'свободен'
        const tally: Record<string, number> = {}; for (const o of mine) tally[why(o)] = (tally[why(o)] || 0) + 1
        log(`🟣∅ ${pl.owner}: к точке никто (${pl.eta} т., успеть с ${reach.toFixed(0)} бл.) — ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(', ')}; ближайший свободный ${near(free)}, с булавой и зарядом ${near(mine.filter(o => (inv(o).mace || 0) > 0 && (inv(o).wind_charge || 0) > 0))}, с паутиной ${near(mine.filter(o => (inv(o).cobweb || 0) > 0))}`)
      }
      if (trapper) {
        const token = {}; trapper.swarmReserved = token
        void trapper.c.call('pearl_trap', { owner: pl.owner, id: pl.id, ...forecast, contact: pl.contact, block: pl.block, seenAt, lava: !smashers.length, dig: !smashers.length })
          .then(r => { const d = r?.detail || r || {}; log(`🟣🕸 ${trapper.name} → ${pl.owner}: ${d.ok ? (d.kind === 'lava' ? 'лава в точку появления' : d.kind === 'web' ? 'паутина в точку появления' : `подкоп ${d.dug} бл.${d.lost ? ' — жемчуг в пустоту' : d.drop != null ? `, он упадёт на ${d.drop} бл. ниже` : ''}`) + ` (запас ${-(d.lateMs ?? 0)} мс)` : 'ловушка не вышла — ' + (d.why || r?.error || '?')}`) })
          .catch(() => {}).finally(() => { if (trapper.swarmReserved === token) delete trapper.swarmReserved })
      }
      for (const o of walkers) {
        const token = {}; o.swarmReserved = token
        void sw.go(o, at, 1.5, Math.max(2, Math.ceil(pl.eta / 20) + 2)).catch(() => {}).finally(() => { if (o.swarmReserved === token) delete o.swarmReserved })
      }
    }
  }
  const flankAt = new Map<string, number>()
  const flankMoves = new WeakMap<object, { round: number; foe: string; token: object; action: any; tier: boolean; spot: SwarmPosition }>()
  const flankWings = m => (m.inv?.elytra || m.armor?.torso === 'elytra') && (m.inv?.firework_rocket || 0) >= 5
  const walkCell = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const walkSignature = (foe, p) => `${foe}:${walkCell(p)}`
  const walkRoute = (p, blocks) => `${Math.floor(p.x)},${p.y},${Math.floor(p.z)}:${blocks}`
  const walkBudget = (blocks: number) => Math.min(15, Math.max(4, Math.ceil(blocks / 3)))
  function windFlank(b, sightings) {
    if (!arena || process.env.ND_WIND_FLANK === '0') return
    // Лук тоже: стрела толкает вдоль своего полёта (AbstractArrow.doKnockback — «Отдача» ×0.6 на уровень, плюс обычный
    // отброс от попадания), подброшенного в воздухе — на несколько блоков; со стороны центра — наружу.
    const team = teamOf(b), inv = o => pos[o.name]?.inv || {}
    const charged = o => (inv(o).wind_charge || 0) > 0 || pos[o.name]?.offHand?.item === 'wind_charge' || (inv(o).bow || 0) > 0 && ((inv(o).arrow || 0) + (inv(o).tipped_arrow || 0) + (inv(o).spectral_arrow || 0)) > 0
    let members: typeof bots
    for (const e of sightings || []) {
      // Ник сквозь уступ — тоже место: на ярусе выше его прямо не видно никому снизу (ниже — только для яруса).
      if (e.visible !== true && !e.nametag || !sw.hostile(b, e.id) || !e.position) continue
      const key = `${team}:${e.id}`
      if (now() - (flankAt.get(key) || 0) < FLANK_MS) continue
      const room = edgeRoom(e.position)
      // Стоит на ярусе выше нас (гребень Колизея) — фланг на его ярусе со стороны центра: с поля его закрывает уступ, а на 18 бл.
      // никого нет (стенд ветра 25.10: «cand:far / cand:los» — по бегущему у края ни одного броска). Подняться — дальше, до 48 бл.
      members ??= bots.filter(o => teamOf(o) === team && alive(o.name) && pos[o.name]?.p)
      const low = Math.min(...members.map(o => pos[o.name].p.y))
      const tier = !e.airborne && (e.velocity?.y || 0) <= .5 && e.position.y - low > 2.5
      if (e.visible !== true && !tier) continue
      const crew = members.filter(o => movementFree(o) && available(o) && charged(o) && !sw.panic(o) && distance(pos[o.name].p, e.position) <= (tier ? 64 : FLANK_RANGE) && !meleeBusy(o) && !assaulting(o, e.id))
      // Один боец (чемпион) — не рой: его фланг уводил из боя (стенд 24.10 14:48 — по 2–3 раза в секунду). На ярус — и один свободный:
      // снизу заряд упирается в уступ (стенд ветра 25.10: none:blocked — половина отказов).
      if (crew.length < (tier ? 1 : 2)) continue
      const floorY = tier ? e.position.y : Math.min(...crew.map(o => pos[o.name].p.y))
      // Подброшен, а не прыгнул: прыжок — 0.42 бл./т. вверх, обычный в бою; выше 2.5 бл. над полом — уже не прыжок.
      const airborne = !tier && ((e.velocity?.y || 0) > .5 || e.position.y - floorY > 2.5)
      // An inner terrace can screen a target long before the outer wall.
      if (!tier && !airborne && room > 5) continue
      const { spots, bad } = flankSpots(e.position, arena, floorY, crew.map(o => pos[o.name].p))
      // На ярусе — «плохо» стоит и тот, кто ниже его на 2+ бл.: снизу уступ закрывает.
      const wrong = tier ? (p: any) => bad(p) || p.y < e.position.y - 2 : bad
      const occupied: SwarmPosition[] = []
      let sameFoe = 0
      if (tier) for (const o of members) {
        const lease = flankMoves.get(o)
        if (lease?.tier && lease.round === sw.generation && o.swarmReserved === lease.token &&
            o.last === lease.action && lease.action.pending === true) {
          occupied.push(lease.spot)
          if (lease.foe === e.id) sameFoe++
        }
      }
      // The goto radius covers neighbouring columns on this terrace. A slab at another height has its own arrival test.
      const open = spots.filter(spot => occupied.every(p => p.y !== spot.y || distance(p, spot) > 2))
      const movers = []
      for (const o of crew.filter(o => wrong(pos[o.name].p)).sort((x, y) => distance(pos[x.name].p, spots[0]) - distance(pos[y.name].p, spots[0]))) {
        if (!open.length || sameFoe + movers.length >= FLANK_N) break
        const blocks = tier ? blockCount(pos[o.name].inv) : 0
        const alarm = tier && !flankWings(pos[o.name]) ? sw.recentHuntAlarm?.(o) : undefined
        const index = open.findIndex(spot => !leavingUpperReserve(o, spot) &&
          !alarm?.(spot) &&
          (!tier || flankWings(pos[o.name]) || !sw.blocked?.(o, `flankWalk:${o.name}`, walkRoute(spot, blocks))))
        if (index >= 0) movers.push({ o, spot: open.splice(index, 1)[0] })
      }
      if (!movers.length) continue
      flankAt.set(key, now())
      log(`🌬↔ ${team} → ${e.id}${airborne ? ' в воздухе' : tier ? ' на ярусе' : ' у края'} (${room.toFixed(0)} бл. до края): на фланг ${movers.map(({ o, spot }) => `${o.name} ${distance(pos[o.name].p, spot).toFixed(0)} бл.`).join(', ')}`)
      movers.forEach(({ o, spot }) => {
        const token = {}, round = sw.generation, before = o.last; o.swarmReserved = token
        // На ярус — время по пути и с элитрами (пользователь 25.10: «научи вставать на мой ярус со стороны центра»): 2 с пешком
        // не поднимали с поля на 30 бл. ни разу, и снизу заряд по гребню не попадает (стенд: 15 «out?» мимо).
        const m = pos[o.name], from = { ...m.p }, far = distance(from, spot), wings = flankWings(m)
        const blocks = tier && !wings ? blockCount(m.inv) : 0
        const walkSeconds = walkBudget(far)
        const retryKey = `flankWalk:${o.name}`
        // Walking to a second post consumes the first post's full retry window. Keep the earlier
        // refusals from this same group only if the alternative also ends without progress.
        const attempted = tier && !wings ? spots.map(p => walkRoute(p, blocks)).filter(sig => sw.blocked?.(o, retryKey, sig)) : []
        const move = !tier ? sw.go(o, spot, 1.5, 2)
          : wings ? o.c.call('fly_to', { at: spot, timeoutSeconds: 12, arena })
          : o.c.call('goto', { ...spot, range: 2, climb: true, exactY: true, timeoutSeconds: walkSeconds, arena, _hunt: true })
        const lease = { round, foe: e.id, token, action: o.last, tier, spot }
        if (o.last !== before && (o.last?.m === 'goto' || o.last?.m === 'fly_to') && o.last.pending === true) flankMoves.set(o, lease)
        void Promise.resolve(move)
          .then(r => {
            if (!tier) return
            // A detour or a placed block is progress. A teammate may later open the same route while we stand still.
            const report = detail(r), end = r?.state?.pos, here = pos[o.name]?.p
            const arrived = wings ? report.ok : report.arrived
            // state.pos is the occupied integer cell; the ordinary swarm sighting keeps the sub-block pose.
            if (!wings && !arrived && (r?.status === 'timeout' || r?.status === 'done' && report.stopped) &&
                round === sw.generation && o.swarmReserved === token && o.last === lease.action &&
                end && here && walkCell(from) === walkCell(end) && distance(from, here) < .35 &&
                blocks === blockCount(r.state.inventory || pos[o.name].inv)) {
              const until = now() + Math.max(5, walkSeconds) * 1000
              for (const sig of [...attempted, walkRoute(spot, blocks)]) sw.failed?.(o, retryKey, sig, until)
            }
            log(`🌬↔ ${o.name}: на ярус к ${e.id} ${wings ? 'на элитрах' : 'пешком'} — ${arrived ? 'дошёл' : report.stopped || report.why || r?.error || r?.status || '?'}`)
          })
          .catch(() => {}).finally(() => {
            if (o.swarmReserved === token) delete o.swarmReserved
            if (flankMoves.get(o) === lease) flankMoves.delete(o)
          })
      })
    }
  }
  // Караул булав (пользователь 24.10: «2–3 бота с булавой и зарядами держатся в 6–12 бл. от цели по разные стороны»): жемчуг
  // врага ловится, только если засадчик успевает — взлёт 1.15 с плюс подбег (сцена try-pearl-ambush: из 4 бл. — 9 из 10
  // ваншотов, из 13–30 — ни одного). На каждого видимого врага — три сектора по 120°; пустой сектор занимает ближайший
  // свободный с булавой и зарядом, не в рукопашной (дальше 5 бл.), в 9 бл. от врага. Раз в 2 с на врага.
  const sentryAt = new Map<string, number>()
  let sentryRound = sw.generation
  const SENTRY_R = 9, SENTRY_MIN = 6, SENTRY_MAX = 12, SENTRY_TEAM = 3, SENTRY_REFRESH_MS = 2000
  const stopSentry = (o, post) => {
    if (post.stopping || o.last !== post.action || o.last?.m !== 'goto' || !o.last.pending || !movementFree(o) || protectedAction(o) || o.webRescue) return
    post.stopping = true
    void o.c.call('stop').catch(() => {})
  }
  const sentryRearming = task => task?.kind === 'loot' && (task.data?.weak || task.data?.race)
  const leavingPost = o => {
    const current = o.swarmTask, planned = plannedTask(o)
    return o.last?.m === 'flee' && o.last.pending === true || protectedTask(current) || protectedTask(planned) || sentryRearming(current) || sentryRearming(planned)
  }
  function sentries(b, sightings, observedAt = now()) {
    if (process.env.ND_PEARL_SENTRY === '0') return
    const team = teamOf(b), round = sw.generation
    if (sentryRound !== round) { sentryAt.clear(); sentryRound = round }
    const own = b.swarmSentry
    if (own && own.round === round && b.swarmReserved === own && !own.stopping && b.last === own.action &&
        (leavingPost(b) || sw.panic(b))) stopSentry(b, own)
    if (now() - observedAt > SENTRY_REFRESH_MS) return
    const smasher = o => (pos[o.name]?.inv?.mace || 0) > 0 && charged(o)
    let teamBots: typeof bots, maces: typeof bots
    for (const e of sightings || []) {
      if (e.visible !== true || !sw.hostile(b, e.id) || !e.position) continue
      const key = `${team}:${e.id}`
      if (now() - (sentryAt.get(key) ?? -Infinity) < SENTRY_REFRESH_MS) continue
      sentryAt.set(key, now())
      teamBots ??= bots.filter(o => teamOf(o) === team && alive(o.name) && pos[o.name]?.p)
      maces ??= teamBots.filter(o => smasher(o) && !leavingPost(o))
      const sector = (p: any) => { const a = Math.atan2(p.z - e.position.z, p.x - e.position.x); return ((Math.round(a / (2 * Math.PI / 3)) % 3) + 3) % 3 }
      const inRing = p => Math.hypot(p.x - e.position.x, p.z - e.position.z) >= 4 && distance(p, e.position) <= SENTRY_MAX + 2
      const posted = teamBots.filter(o => o.swarmSentry && o.swarmSentry.round === round && o.swarmReserved === o.swarmSentry)
      const claimed = new Set<number>()
      for (const o of posted) {
        const post = o.swarmSentry
        if (post.foe !== e.id || post.stopping) continue
        if (leavingPost(o) || !inRing(post.spot)) stopSentry(o, post)
        else claimed.add(sector(post.spot))
      }
      if (!maces.length || posted.length >= SENTRY_TEAM) continue
      const holding = new Map<any, number>()
      for (const o of maces) {
        if (posted.includes(o)) continue
        const frame = pos[o.name], last = o.sentryPost
        const p = last && last.round === round && last.frame === frame ? last.arrived : frame.p
        if (inRing(p)) holding.set(o, sector(p))
      }
      const remaining = new Map<number, number>()
      for (const k of holding.values()) remaining.set(k, (remaining.get(k) || 0) + 1)
      for (const k of remaining.keys()) claimed.add(k)
      if (claimed.size === 3) continue
      const free = maces.filter(o => movementFree(o) && available(o) && !meleeBusy(o) && !assaulting(o, e.id) && distance(pos[o.name].p, e.position) > 5 && distance(pos[o.name].p, e.position) <= 40)
        .map(o => ({ o, blocks: blockCount(pos[o.name].inv) }))
      if (!free.length) continue
      const sent: string[] = []
      const options = []
      for (let k = 0; k < 3; k++) {
        if (claimed.has(k)) continue
        const a = k * 2 * Math.PI / 3
        let spot = { x: e.position.x + SENTRY_R * Math.cos(a), y: e.position.y, z: e.position.z + SENTRY_R * Math.sin(a) }
        if (arena) { const m = Math.max(Math.abs(spot.x - arena.x), Math.abs(spot.z - arena.z)), lim = arena.r - 2; if (m > lim) spot = { x: arena.x + (spot.x - arena.x) * lim / m, y: spot.y, z: arena.z + (spot.z - arena.z) * lim / m } }
        if (sector(spot) !== k || distance(spot, e.position) < SENTRY_MIN - 1 || arena?.ellipse && edgeRoom(spot) < 2) continue
        const route = walkSignature(e.id, spot)
        for (const { o, blocks } of free) {
          const sig = `${route}:${blocks}`
          if (!leavingUpperReserve(o, spot) && !sw.blocked?.(o, `sentry:${o.name}`, sig))
            options.push({ o, k, spot, sig, blocks, cost: distance(pos[o.name].p, spot) })
        }
      }
      const withdrawing = new Set()
      for (const { o, k, spot, sig, blocks, cost } of options.sort((a, c) => a.cost - c.cost)) {
        if (sent.length >= SENTRY_TEAM - posted.length) break
        const from = holding.get(o)
        if (claimed.has(k) || sent.includes(o.name) || from !== undefined && remaining.get(from)! <= 1) continue
        if (withdrawing.has(o)) continue
        if (sw.panic(o) || leavingPost(o)) { withdrawing.add(o); continue }
        claimed.add(k)
        sent.push(o.name)
        if (from !== undefined) remaining.set(from, remaining.get(from)! - 1)
        const start = { ...pos[o.name].p }, before = o.last
        const post = { round, foe: e.id, spot, action: null, stopping: false }
        o.swarmReserved = o.swarmSentry = post
        const move = sw.go(o, spot, 2, walkBudget(cost)), action = o.last
        if (action !== before && action?.m === 'goto') post.action = action
        void move.then(r => {
          if (sw.generation !== round || o.swarmReserved !== post || o.last !== action || post.stopping || r?.notStarted || !alive(o.name)) return
          const arrived = r?.detail?.arrived && (r.state?.pos || r.detail.arrived)
          if (r?.status === 'done' && arrived && distance(arrived, spot) <= 2) o.sentryPost = { round, frame: pos[o.name], arrived: { ...arrived } }
          else {
            const end = r?.state?.pos || r?.detail?.at, frame = pos[o.name]
            const refused = r?.status === 'failed' && /^(NO_PATH|ARENA_BOUNDARY|AVOID_NO_PATH)$/.test(r.code)
            const stopped = r?.status === 'timeout' || r?.status === 'done' && r.detail?.stopped
            if ((refused || stopped && end) && frame?.p && distance(start, frame.p) < 2 && (!end || distance(start, end) < 2) &&
                blocks === blockCount(r?.state?.inventory || frame.inv)) sw.failed?.(o, `sentry:${o.name}`, sig)
          }
        }).catch(() => {}).finally(() => { if (o.swarmReserved === post) delete o.swarmReserved; if (o.swarmSentry === post) delete o.swarmSentry })
      }
      if (sent.length) log(`🛡 ${team} караул булав у ${e.id}: держат ${remaining.size} из 3 секторов, иду ${sent.join(', ')}`)
    }
  }
  // Разгон стрелой (пользователь 24.10: «один бот другого стрелой ускоряет, и тот копьём ваншотит»; combat/arrow-boost):
  // копейщик встаёт в 7 бл. от врага и ждёт с копьём в «использовании», прыгая на месте; 1–3 лучника за его спиной по линии
  // на врага пускают в него слабые стрелы «Отдачи» — все в один тик (lag — разница полётов), каждая следующая больнее
  // прошлой (не отскочит в неуязвимости). Сцена try-arrow-boost: одна стрела — 1.3 бл/т, железо — ваншот; две — 2.3.
  // ND_ARROW_BOOST=0 — выкл.
  type BoostAttempt = { at: SwarmPosition; round: number; stalled?: Map<string, SwarmPosition> }
  const boostAt = new Map<string, BoostAttempt>(), boosting = new Set<string>()
  const BOOST_D = 7, BOOST_DRAW = [10, 14, 20]
  const arrowSpeed = (t: number) => { let f = t / 20; f = Math.min(1, (f * f + 2 * f) / 3); return 3 * f }
  function arrowBoost(b, sightings) {
    if (process.env.ND_ARROW_BOOST === '0' || !sightings?.length) return
    const team = teamOf(b), round = sw.generation, roundTeam = `${round}:${team}`, m = pos[b.name]
    // Только сам копейщик может подтвердить цель. Остальным разведчикам оценивать всю команду незачем.
    if (boosting.has(roundTeam) || !m?.p || !Object.entries(m.inv || {}).some(([n, count]) => n.endsWith('_spear') && Number(count) > 0)) return
    const lancer = b, L = m.p
    const free = (o, owner?: object) => movementFree(o) && available(o, owner) && !meleeBusy(o) && !(o.last?.m === 'flee' && o.last.pending)
    if (!free(lancer)) return
    for (const e of sightings) {
      if (e.visible !== true || !sw.hostile(b, e.id) || !e.position) continue
      const key = `${team}:${e.id}`
      // Только по стоящему или увязшему (паутина, яма): по бегущему за 1–2 с подготовки линия уходит — 0 из 212 в бою 24.10.
      const v = e.velocity; if (!v || Math.hypot(v.x || 0, v.z || 0) > 0.1) continue
      const gap = distance(L, e.position)
      if (gap < 4 || gap > 12 || Math.abs(L.y - e.position.y) >= 1.5) continue
      const prev = boostAt.get(key)
      const sameTarget = prev && prev.round === round && distance(prev.at, e.position) < 2
      if (sameTarget && !prev.stalled) continue
      if (sw.panic(lancer)) return
      const archers = bots.filter(o => o !== lancer && teamOf(o) === team && boostArcher(o) && free(o) && distance(pos[o.name].p, L) <= 14 && !sw.panic(o))
        .sort((x, y) => distance(pos[x.name].p, L) - distance(pos[y.name].p, L)).slice(0, 3)
      if (!archers.length) continue
      if (sameTarget) {
        const stuck = o => prev.stalled.has(o.name) && distance(prev.stalled.get(o.name), pos[o.name].p) < 2
        if (prev.stalled.has(lancer.name) ? stuck(lancer) : archers.every(stuck)) continue
      }
      const attempt: BoostAttempt = { at: { ...e.position }, round }
      boostAt.set(key, attempt); boosting.add(roundTeam)
      // Линия: от врага через копейщика; копейщик — в 7 бл., лучники — в 3 и 4.5 бл. за ним (двое рядом, на 0.6 вбок).
      let ux = L.x - e.position.x, uz = L.z - e.position.z
      const n = Math.hypot(ux, uz) || 1; ux /= n; uz /= n
      const at = (k: number, side = 0) => ({ x: e.position.x + ux * k - uz * side, y: L.y, z: e.position.z + uz * k + ux * side })
      const S = at(BOOST_D), spots = [at(BOOST_D + 3, -.6), at(BOOST_D + 3, .6), at(BOOST_D + 4.5)]
      const crew = [lancer, ...archers], token = {}
      for (const o of crew) o.swarmReserved = token
      const current = o => round === sw.generation && o.swarmReserved === token && free(o, token) && !sw.panic(o)
      const release = o => { if (o.swarmReserved === token) delete o.swarmReserved }
      const reopen = () => { if (boostAt.get(key) === attempt) boostAt.delete(key) }
      log(`🏹➶ ${team} разгон стрелой на ${e.id}: копьё ${lancer.name} (${distance(L, e.position).toFixed(0)} бл.), лучники ${archers.map(o => o.name).join(', ')}`)
      void (async () => {
        const positions = await Promise.all(crew.map(async (o, k) => {
          const at = k ? spots[k - 1] : S
          const reply = await sw.go(o, at, 1, 4).catch(() => null)
          if (reply?.status !== 'done' || reply.detail?.stopped || reply.detail?.ok === false || !(reply.detail?.arrived || reply.detail?.ok === true)) return null
          const p = reply.state?.pos || reply.detail.arrived || pos[o.name]?.p
          return p && distance(p, at) <= 2 ? p : null
        }))
        if (!current(lancer) || !archers.some(current)) {
          reopen()
          return
        }
        const ready = archers.map((o, i) => ({ o, p: positions[i + 1] })).filter(a => a.p && current(a.o))
        if (!positions[0] || !ready.length) {
          const stalled = !positions[0] ? [lancer] : archers
          attempt.stalled = new Map(stalled.map(o => [o.name, { ...pos[o.name].p }]))
          log(`🏹➶ ${lancer.name}: ${!positions[0] ? 'до места не дошёл' : 'лучники не вышли на позиции'}`); return
        }
        for (const o of archers) if (!ready.some(a => a.o === o)) release(o)
        const lance = lancer.c.call('boost_lance', { foe: e.id, from: ready.map(a => a.o.name), maxMs: 4500 }).catch(err => ({ detail: { why: err.message } }))
        // Копьё может потерять цель ещё до конца заряда. Стрелять в уже вышедшего из приёма союзника нельзя.
        const charging = await Promise.race([lance.then(() => false), new Promise(resolve => setTimeout(() => resolve(true), 900))])
        const firing = ready.filter(a => current(a.o))
        if (!charging || !current(lancer) || !firing.length) {
          for (const { o } of ready) release(o)
          const result = await lance
          if (!result?.detail?.hit) reopen()
          return
        }
        const flight = firing.map((a, k) => Math.ceil(distance(a.p, positions[0]) / arrowSpeed(BOOST_DRAW[k])))
        const longest = Math.max(...flight)
        const shots = await Promise.all(firing.map(({ o }, k) => o.c.call('boost_shot', { ally: lancer.name, foe: e.id, draw: BOOST_DRAW[k], lag: longest - flight[k], wait: BOOST_DRAW[firing.length - 1] - BOOST_DRAW[k] }).catch(err => ({ detail: { why: err.message } }))))
        const r = await lance, d = r?.detail || r || {}
        log(`🏹➶ ${lancer.name} → ${e.id}: ${d.hit ? 'удар копьём' : 'без удара' + (d.why ? ' — ' + d.why : '')}, скорость ${d.vmax ?? '?'} бл/т; стрелы: ${shots.map((s: any) => { const x = s?.detail || s || {}; return x.ok ? (x.hit ? 'попал' : 'мимо') : x.why || '?' }).join(', ')}`)
      })().finally(() => { boosting.delete(roundTeam); crew.forEach(release) })
      return
    }
  }
  // Испытание (ARMS_PEARL_UP=1; пользователь 24.10: «пусть некоторые боты тестово кидают жемчуг тупо вверх, чтобы проверить,
  // что всё работает»): бот, видящий врага в 8–24 бл. и не в рукопашной, кидает жемчуг вверх с места и убегает — враг должен
  // встретить его засадой, ловушкой или подкопом (🟣 у них в журнале). На команду — один испытатель за раз.
  const pearlTesting = new Set<string>()
  function pearlUpTest(b, sightings) {
    if (process.env.ARMS_PEARL_UP !== '1') return
    const team = teamOf(b), m = pos[b.name]
    if (pearlTesting.has(team) || !available(b) || meleeBusy(b) || sw.panic(b) || !((m?.inv?.ender_pearl || 0) > 0) || (m?.hp ?? 0) < 14) return
    const foe = (sightings || []).find(e => e.visible === true && sw.hostile(b, e.id) && e.position && distance(e.position, m.p) >= 8 && distance(e.position, m.p) <= 24)
    if (!foe) return
    pearlTesting.add(team)
    const token = {}; b.swarmReserved = token
    log(`🧪🟣 ${b.name}: испытание — жемчуг вверх с места (${foe.id} в ${distance(foe.position, m.p).toFixed(0)} бл.)`)
    void b.c.call('pearl_test_up', { runMs: 2500 }).then(r => { const d = r?.detail || r || {}; if (!d.ok) log(`🧪🟣 ${b.name}: не бросил — ${d.why || r?.status}`) })
      .catch(() => {}).finally(() => { pearlTesting.delete(team); if (b.swarmReserved === token) delete b.swarmReserved })
  }
  // Погоня на элитрах за подброшенным (пользователь 25.10: «те, кто на элитрах, подлетают за мной и кидают… преследовали»):
  // Свободные элитровые с зарядом подходят к видимой цели; бросок выбирает собственная native-физика тела.
  // Повтор той же попытки не прерывает уже идущий полёт; изменившаяся позиция допускает новый подход.
  const winging = new Map<string, any>()
  const wingToken = (b, target?: string) => {
    const lease = winging.get(b.name)
    return lease && lease.round === sw.generation && (target === undefined || lease.foe === target) &&
      b.swarmReserved === lease.token && b.last === lease.action && b.last?.m === 'wing_orbit' && b.last.pending === true ? lease.token : undefined
  }
  // Only this helper's exact pending ground approach may become its airborne escort.
  const flankToken = (b, foe: string) => {
    const lease = flankMoves.get(b)
    return lease && lease.round === sw.generation && lease.foe === foe && b.swarmReserved === lease.token && b.last === lease.action &&
      b.last?.m === 'goto' && b.last.pending === true ? lease.token : undefined
  }
  function windWing(b, sightings) {
    const team = teamOf(b)
    const kit = (o, spearWindow: boolean) => {
      const m = pos[o.name], inv = m?.inv || {}
      return (inv.elytra || m?.armor?.torso === 'elytra') && (m?.gliding || (inv.firework_rocket || 0) > 0) &&
        (charged(o) || spearWindow && m?.gliding && Object.entries(inv).some(([name, n]) => /_spear$/.test(name) && Number(n) > 0))
    }
    if (!bots.some(o => teamOf(o) === team && kit(o, true))) return
    // observe() runs before guardedTurn() first prices the team. Do not reserve its body before that choice exists.
    if (sw.planned && (sightings || []).some(e => e.position && e.visible === true && sw.hostile(b, e.id))) sw.refresh?.(b)
    for (const e of sightings || []) {
      if (!e.position || !sw.hostile(b, e.id) || e.visible !== true) continue
      const ledge = !e.airborne, radius = 8
      const spearWindow = !ledge && !e.gliding && e.windAffected === true
      const outward = windOutward(arena, e.position)
      const wingers = bots.filter(o => teamOf(o) === team && wingToken(o, e.id))
      const lanes = (arena.ellipse ? [0, -1, 1] : [0]).map(lane => {
        const a = Math.atan2(-outward.z, -outward.x) + Math.atan2(3 * lane, radius)
        return { lane, count: wingers.filter(o => winging.get(o.name).lane === lane).length,
          at: { x: e.position.x + Math.cos(a) * radius, y: e.position.y + (ledge ? 2 : 0), z: e.position.z + Math.sin(a) * radius } }
      })
      const least = Math.min(...lanes.map(lane => lane.count))
      const open = lanes.filter(lane => lane.count === least)
      const relayWithoutAttack = q => {
        const m = pos[q.name], inv = m.inv
        if (!arena.ellipse || !spearWindow || !m.gliding || m.lance || q.last?.pending !== false || !inv) return false
        const off = m.offHand?.item || '', airWeapon = /^(mace|crossbow|trident|ender_pearl)$|_spear$/
        // Арбалет может быть заряжен даже без стрел в рюкзаке.
        const arrows = m.attackArrows ?? (inv.arrow || inv.spectral_arrow || inv.tipped_arrow || /^(arrow|spectral_arrow|tipped_arrow)$/.test(off))
        return !airWeapon.test(off) && !Object.entries(inv).some(([name, n]) => Number(n) > 0 && airWeapon.test(name)) &&
          !((inv.bow > 0 || off === 'bow') && arrows)
      }
      const crew = bots.filter(q => teamOf(q) === team && movementFree(q) && available(q, flankToken(q, e.id), true) && !meleeBusy(q) &&
        (!assaulting(q, e.id) || relayWithoutAttack(q)) && !sw.panic(q) && kit(q, spearWindow) && !wingers.includes(q) &&
        // Ближний штурм держит бой; свободный летун без воздушного удара может поддержать ту же цель ветром.
        !(q.swarmTask?.kind === 'fight' && q.swarmTask.data?.committed && q.swarmTask.data?.target === e.id && distance(pos[q.name].p, e.position) <= 6) &&
        !(winging.get(q.name)?.round === sw.generation && winging.get(q.name)?.foe === e.id && distance(winging.get(q.name).at, e.position) < 6) &&
        // Не взлетел отсюда (крыша, стена) — снова только с другого места (повтор по месту, не по времени).
        !(winging.get(q.name)?.round === sw.generation && winging.get(q.name)?.failAt && distance(winging.get(q.name).failAt, pos[q.name].p) < 3))
      const approach = crew.flatMap(o => open.map(lane => ({ o, lane: lane.lane, distance: distance(pos[o.name].p, lane.at) })))
        .sort((x, y) => x.distance - y.distance)[0]
      if (!approach) continue
      const { o, lane } = approach
      const token = {}, attempt: any = { foe: e.id, at: { ...e.position }, round: sw.generation, token, lane }
      winging.set(o.name, attempt)
      log(`🪽🌬 ${o.name} → ${e.id}: ${ledge ? 'на гребне' : 'в воздухе'} +${Math.round(e.position.y - arena.y)} — ${ledge ? 'заход с центра' : 'облёт'} на элитрах, заряды на сближении (${distance(pos[o.name].p, e.position).toFixed(0)} бл.)`)
      // Ход бота полёт не рвёт: резерв до квитанции (guardedTurn пропускает зарезервированного).
      o.swarmReserved = token
      const from = { ...pos[o.name].p }
      const work = o.c.call('wing_orbit', { target: e.id, seconds: ledge ? 6 : 12, radius, arena, floorY: arena.y, ledge, lane: arena.ellipse ? lane : undefined })
      attempt.action = o.last
      void work.then(r => {
        if (sw.generation !== attempt.round || winging.get(o.name) !== attempt) return
        const d = detail(r)
        if (r?.code === 'RESCUE_BUSY') winging.delete(o.name)
        else {
          const latest = sw.boardOf(o).enemies().find(foe => foe.id === e.id)
          // Movement during the reserved flight is already covered; retry only after a later change.
          if (latest?.position) attempt.at = { ...latest.position }
          if (!d.ok && /^взлёт/.test(d.why || '')) attempt.failAt = from
        }
        log(`🪽🌬 ${o.name}: облёт ${d.ok ? `${Math.round((d.ms || 0) / 100) / 10} с, ближе 16 бл. ${d.nearTicks} т., ближе всего ${d.closest} бл., зарядов ${d.windShots ?? '?'}, ${d.why}${d.landed ? ', сел' : ''}` : d.why || r?.error || r?.status || '?'}`)
      }).catch(() => {})
        .finally(() => { if (o.swarmReserved === token) delete o.swarmReserved })
    }
  }
  return { windObserve, windBid, pearlObserve, windFlank, sentries, arrowBoost, pearlUpTest, windWing }
}
