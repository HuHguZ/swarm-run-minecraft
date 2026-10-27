const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const point = (p: any) => p ? { x: p.x, y: p.y, z: p.z } : null
const copy = (value: any) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v))

/** Stand-only first-life 2x2. No enemy HP, fake use marker, or guaranteed shockwave contact. */
export async function duelShockwavePhase(roles: any, enabled: boolean, stop: () => boolean, actions: any): Promise<any> {
  const { body: b, spear: a, primary: t, enemy: e } = roles, bots = [b, a, t, e], lives = bots.map(bot => bot.entity)
  const t0 = Date.now(), ticks = bots.map(() => 0), lastSentTicks = bots.map(() => -1000), dead = new Set<any>(), deathSet = new Set<any>(), frames: any[] = [], packets: any[] = [], firstLifeEvents: any[] = [], actionLog: any[] = [], cleanup: (() => void)[] = []
  let closed = false, error: string | null = null, endReason = '', roundEndMs = 0, dropped = false, dropAtMs: number | null = null
  let spear: any = null, dive: any = null, charge: any = null, heldEndMs: number | null = null, hardClosed = false, censored = false
  const visible = actions.visible ?? ((bot, target) => require('../../../daemon/src/pick').canHit(bot, target, { range: 32 }))
  const strike = actions.strike ?? ((...args) => require('../../../daemon/src/swarm/combos/ideas').strike(...args))
  const jab = actions.jab ?? ((...args) => require('../../../daemon/src/spear').jab(...args))
  const readyIn = actions.readyIn ?? ((...args) => require('../../../daemon/src/spear').readyIn(...args))
  const jabReach = actions.jabReach ?? ((...args) => require('../../../daemon/src/spear').jabReach(...args))
  const safeStep = actions.safeStep ?? ((bot, key) => require('../../../daemon/src/pvp/body').stepSafe(bot, require('../../../daemon/src/moves').keyDir(bot, key)))
  const landing = actions.fullSpearLanding ?? ((...args) => require('./combo-shockwave-active').fullSpearLanding(...args))
  const chargeSpear = actions.chargedSpear ?? ((...args) => require('../../../daemon/src/swarm/combos/air-ideas').chargedSpear(...args))
  const maceDive = actions.maceDive ?? ((...args) => require('../../../daemon/src/swarm/combos/air-ideas').maceDive(...args))
  const alive = (bot: any) => !!bot.entity && !dead.has(bot) && bot.entity === lives[bots.indexOf(bot)]
  const clear = (bot: any) => { try { bot.clearControlStates(); bot.deactivateItem() } catch {} }
  const lifeEnded = (bot: any, event: string) => {
    if (event === 'death') deathSet.add(bot)
    else if (!deathSet.has(bot) && !hardClosed) { censored = true; error ??= `unexpected_lifecycle:${bot.username}:${event}` }
    dead.add(bot); firstLifeEvents.push({ ms: Date.now(), actor: bot.username, event }); clear(bot)
  }
  const winner = (): 'allies' | 'enemies' | 'draw' | null => {
    const allies = !deathSet.has(a) || !deathSet.has(b), enemies = !deathSet.has(t) || !deathSet.has(e)
    return !allies && !enemies ? 'draw' : !enemies ? 'allies' : !allies ? 'enemies' : null
  }
  const reason = () => {
    for (const bot of bots) if (!dead.has(bot) && !alive(bot)) lifeEnded(bot, 'entity_identity')
    const win = winner()
    return stop() ? 'AUTO-STOP' : error ? 'action_error' : win === 'draw' ? 'mutual_wipe' : win === 'allies' ? 'enemies_wipe' : win === 'enemies' ? 'allies_wipe' : Date.now() - t0 >= 8000 ? 'wall_cap' : ticks[0] >= 160 ? 'physics_cap' : ''
  }
  const stopped = () => closed || !!reason()
  const snapshot = (bot: any) => ({ position: point(bot.entity?.position), velocity: point(bot.entity?.velocity), onGround: bot.entity?.onGround,
    yaw: bot.entity?.yaw, pitch: bot.entity?.pitch, held: bot.heldItem?.name ?? null, using: !!bot.usingHeldItem, tick: ticks[bots.indexOf(bot)] })
  const publicTarget = (bot: any, actor: any) => {
    if (!alive(actor)) return null
    const target = Object.values<any>(bot.entities ?? {}).find(entity => entity.id === lives[bots.indexOf(actor)].id && entity.username === actor.username)
    return target && target.isValid !== false && visible(bot, target) ? target : null
  }
  const nearest = (bot: any, opponents: any[]) => opponents.map(actor => ({ actor, target: publicTarget(bot, actor) })).filter(x => x.target)
    .sort((x, y) => {
      const p = bot.entity.position, d = target => Math.hypot(target.position.x - p.x, target.position.y - p.y, target.position.z - p.z)
      return d(x.target) - d(y.target)
    })[0] ?? null
  const controls = (bot: any, target: any, spearBand: boolean, strafe: boolean) => {
    const p = bot.entity.position, q = target.position, distance = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)
    const forward = distance > (spearBand ? 3.4 : 2.25), back = spearBand && distance < 2.6
    let allowedForward = false
    for (const [key, wanted] of Object.entries({ forward, back, left: strafe && Math.floor(ticks[bots.indexOf(bot)] / 10) % 2 === 0,
      right: strafe && Math.floor(ticks[bots.indexOf(bot)] / 10) % 2 === 1 })) {
      const allowed = wanted && safeStep(bot, key)
      bot.setControlState(key, allowed); if (key === 'forward') allowedForward = allowed
    }
    bot.setControlState('sprint', allowedForward && (bot.food ?? 20) > 6); bot.setControlState('jump', false)
  }
  for (const [index, bot] of bots.entries()) {
    const step = () => {
      if (!alive(bot)) return
      ticks[index]++; frames.push({ ms: Date.now(), actor: bot.username, ...snapshot(bot) })
    }
    bot.on('physicsTick', step); cleanup.push(() => bot.removeListener('physicsTick', step))
    for (const event of ['death', 'end', 'respawn']) {
      const handler = () => lifeEnded(bot, event)
      bot.on(event, handler); cleanup.push(() => bot.removeListener(event, handler))
    }
    const serializer = bot._client.serializer
    const serialized = (buffer: Buffer) => {
      try {
        const bytes = Buffer.from(buffer), parsed = serializer.proto.parsePacketBuffer('packet', bytes).data
        if (!['use_item', 'use_entity', 'block_dig', 'arm_animation'].includes(parsed.name)) return
        const row = { ms: Date.now(), actor: bot.username, direction: 'serialized', name: parsed.name, data: copy(parsed.params), hex: bytes.toString('hex'), own: snapshot(bot), firstLife: alive(bot) }
        packets.push(row)
        if (parsed.name === 'use_entity' && parsed.params.mouse === 1) lastSentTicks[index] = ticks[index]
        if (bot === a && parsed.name === 'use_item' && parsed.params.hand === 0 && bot.heldItem?.name === 'iron_spear' && !charge) charge = row
      } catch (failure) { packets.push({ ms: Date.now(), actor: bot.username, direction: 'decode_error', error: String(failure) }) }
    }
    const incoming = (data: any, meta: any, bytes: any) => {
      if (meta?.name !== 'damage_event' && !(meta?.name === 'entity_velocity' && data?.entityId === lives[index].id)) return
      const row: any = { ms: Date.now(), actor: bot.username, receiverId: lives[index].id, direction: 'in', name: meta.name, data: copy(data), firstLife: alive(bot) }
      if (meta.name === 'entity_velocity') {
        row.velocity = (actions.velocityFromRaw ?? require('../../../daemon/src/drops').velocityFromRaw)(bytes, 'velocity')
        row.hex = Buffer.isBuffer(bytes) ? bytes.toString('hex') : null
      }
      packets.push(row)
    }
    serializer?.on?.('data', serialized); bot._client.on('packet', incoming)
    cleanup.push(() => { serializer?.removeListener?.('data', serialized); bot._client.removeListener('packet', incoming) })
  }
  const ordinary = async (bot: any, opponents: any[], spearBand: boolean, strafe: boolean) => {
    let processed = -1
    while (!stopped() && alive(bot)) {
      const tick = ticks[bots.indexOf(bot)]
      if (tick === processed) { await pause(); continue }
      processed = tick
      const selected = (bot === a ? nearest(bot, [e]) : null) ?? nearest(bot, opponents)
      if (!selected) { clear(bot); await pause(); continue }
      const { actor, target } = selected, cancelled = () => stopped() || !alive(bot) || publicTarget(bot, actor) !== target
      await bot.lookAt(target.position.offset(0, .9, 0), true)
      if (cancelled()) continue
      controls(bot, target, spearBand, strafe)
      if (spearBand) {
        if (readyIn(bot, bot.heldItem?.name) === 0 && jabReach(bot, target).ok) {
          const result = await jab(bot, target, { abortIf: cancelled })
          actionLog.push({ ms: Date.now(), actor: bot.username, kind: 'jab_attempt', targetId: target.id, tick, result })
        }
      } else {
        const cooldown = bot === b ? require('../../../daemon/src/pvp/damage-model').ticksToCharge(bot.heldItem?.name) : 5
        if (tick - lastSentTicks[bots.indexOf(bot)] >= cooldown) {
          const ctl = { get aborted() { return cancelled() } }, result = await strike(bot, target, { ctl })
          actionLog.push({ ms: Date.now(), actor: bot.username, kind: 'strike_attempt', targetId: target.id, tick, result })
          if (result.sent) lastSentTicks[bots.indexOf(bot)] = Math.max(lastSentTicks[bots.indexOf(bot)], tick)
        }
      }
      await pause()
    }
    clear(bot)
  }
  const jobs: Promise<any>[] = []
  let pending = 0
  const launch = (actor: any, run: () => Promise<any>) => {
    pending++
    const job = Promise.resolve().then(run).catch(failure => {
      actionLog.push({ ms: Date.now(), actor: actor.username, kind: 'action_error', error: String(failure), cancelled: stopped() || !alive(actor) })
      if (!stopped() && alive(actor)) error = String(failure)
    }).finally(() => { pending--; clear(actor) })
    jobs.push(job)
  }
  const hardClose = () => {
    if (hardClosed) return
    hardClosed = true
    error ??= 'action_join_stalled'
    for (const bot of bots) { try { bot.quit('duel stalled action cleanup') } catch {} }
  }
  const wallTimer = setTimeout(() => { closed = true; if (!endReason) endReason = reason() || 'wall_cap'; bots.forEach(clear) }, 8000)
  let fullLandingA: any, bodyLanding: any, winnerAtRoundEnd: any = null, roundTicks: number[] = []
  try {
    // Both opponents start before A's equip/warmup/use and before the independent B drop clock.
    launch(t, () => ordinary(t, [a, b], false, true)); launch(e, () => ordinary(e, [a, b], false, true))
    launch(a, async () => {
      if (enabled) {
        const target = publicTarget(a, e)
        if (target) {
          const ctl = { get aborted() { return stopped() || !alive(a) || !alive(e) } }
          actionLog.push({ ms: Date.now(), actor: a.username, kind: 'charge_start', targetId: target.id })
          try { spear = await chargeSpear(a, target, { ctl, stand: false, maxTicks: 80 }) }
          finally { heldEndMs = Date.now() }
        } else spear = { started: false, why: 'initial_E_not_visible' }
      } else spear = { started: false, why: 'ordinary_jab_control_no_use' }
      if (!stopped() && alive(a)) await ordinary(a, [t, e], true, false)
    })
    launch(b, async () => {
      while (!stopped() && alive(b) && ticks[0] < 20) await pause()
      if (stopped() || !alive(b)) return
      dropAtMs = Date.now() - t0; await actions.removeFloor(); dropped = true
      while (!stopped() && alive(b) && (b.entity.onGround || !(b.entity.velocity.y < 0))) await pause()
      if (stopped() || !alive(b)) return
      const target = publicTarget(b, t)
      if (target) {
        const ctl = { get aborted() { return stopped() || !alive(b) || !alive(t) } }
        dive = await maceDive(b, target, { ctl, maxTicks: 80 })
      } else dive = { sent: false, why: 'primary_not_visible_or_first_life_ended' }
      while (!stopped() && alive(b) && !b.entity.onGround) await pause()
      if (!stopped() && alive(b)) await ordinary(b, [t, e], false, false)
    })
    while (!closed && !(endReason = reason())) await pause()
    if (!endReason) endReason = reason() || 'wall_cap'
    roundEndMs = Date.now() - t0; roundTicks = [...ticks]; winnerAtRoundEnd = error || hardClosed ? null : winner()
  } finally {
    closed = true; clearTimeout(wallTimer); bots.forEach(clear)
    // Native helpers may be waiting for a tick that can no longer arrive. End only these owned clients if joining stalls.
    const cleanupTimer = setTimeout(() => { if (pending) hardClose() }, 250)
    try {
      await Promise.allSettled(jobs)
      const land = async bot => {
        if (!alive(bot)) return { reason: 'first_life_ended', groundTicks: 0, frames: [] }
        const value = await landing(bot, () => stop() || !alive(bot))
        if (!alive(bot)) value.reason = 'first_life_ended'
        return value
      }
      ;[fullLandingA, bodyLanding] = await Promise.all([land(a), land(b)])
    } finally { clearTimeout(cleanupTimer); cleanup.forEach(close => close()) }
  }
  return { t0, roundEndMs, elapsedMs: Date.now() - t0, endReason, timeout: ['wall_cap', 'physics_cap'].includes(endReason),
    why: error ? 'action_error' : endReason === 'AUTO-STOP' ? 'cancelled' : 'complete', error, censored,
    winner: error || hardClosed ? null : winnerAtRoundEnd, winnerAtRoundEnd, finalWinner: error || hardClosed ? null : winner(),
    enabled, mode: 'H40_first_life_2v2', candidate: 'E_priority_52_common_t0_B_drop20_grounded_charge_vs_ordinary_jab_then_follow_through',
    comparison: 'both_real_B_two_active_enemies_E_priority_52_grounded_charge_then_jab_vs_ordinary_jab_not_general_swarm_ROI',
    charge, actualUse: charge, heldEndMs, dropAtMs, dropped, dive, spear, ticks, roundTicks, frames, actionLog, packets, firstLifeEvents,
    deaths: firstLifeEvents.filter(p => p.event === 'death'), fullLanding: fullLandingA, fullLandingA, bodyLanding,
    attacks: packets.filter(p => p.direction === 'serialized' && p.name === 'use_entity'),
    enemyWindow: { startedAtMs: t0, endedAtMs: t0 + roundEndMs, physicsTicks: roundTicks[0], endReason, policy: 'both_active_from_t0_nearest_visible_approach_local10tick_strafe_fist5tick' },
    wallCapMs: 8000, physicsCap: 160, hardClosed,
    limitation: 'first-life scripted2v2; Bphysics clock stops if B dies, wall8s remains authoritative; A/B landing tails and their cost extend beyond round action window; packet contact is not HP damage' }
}

if (require.main === module) {
  const [pairs = '1', hp = '100', ...extra] = process.argv.slice(2)
  if (extra.length || !/^\d+$/.test(pairs) || +pairs < 1 || +pairs > 20 || !['20', '100'].includes(hp)) throw new Error('combo-shockwave-duel [pairs=1:1..20] [hp=100:20|100]')
  require('./combo-shockwave').shockwaveTrials(+pairs, 'duel', +hp).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
