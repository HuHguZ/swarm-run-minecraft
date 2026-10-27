import { shockwavePhase, shockwaveTrials } from './combo-shockwave'
import { activeStrafe } from './combo-anvil'

const pause = () => new Promise(resolve => setTimeout(resolve, 10))
const point = (p: any) => ({ x: p.x, y: p.y, z: p.z })
type Mode = 'ca' | 'useful'

/** New ticks after release, not a grounded sample left over from the held-use phase. */
export async function fullSpearLanding(bot: any, stop: () => boolean, maxMs = 2500): Promise<any> {
  const life = bot.entity, startedAtMs = Date.now(), frames: any[] = []
  let groundTicks = 0, ticks = 0, dead = !(bot.health > 0), ended = false
  const death = () => { dead = true }, end = () => { ended = true }
  const step = () => {
    ticks++; groundTicks = bot.entity === life && bot.entity.onGround === true ? groundTicks + 1 : 0
    frames.push({ ms: Date.now(), position: point(bot.entity.position), velocity: point(bot.entity.velocity), onGround: bot.entity.onGround })
  }
  bot.on('physicsTick', step); bot.on('death', death); bot.on('end', end)
  try {
    while (!stop() && !dead && !ended && bot.entity === life && groundTicks < 2 && ticks < 60 && Date.now() - startedAtMs < maxMs) await pause()
    return { startedAtMs, endedAtMs: Date.now(), ticks, groundTicks, frames,
      reason: stop() ? 'AUTO-STOP' : dead ? 'death' : ended ? 'end' : bot.entity !== life ? 'new_life' : groundTicks >= 2 ? 'landed' : 'timeout' }
  } finally { bot.removeListener('physicsTick', step); bot.removeListener('death', death); bot.removeListener('end', end) }
}

function enemyWindow(e: any, a: any, stop: () => boolean, actions: any) {
  const strike: typeof import('../../../daemon/src/swarm/combos/ideas').strike = actions.strike ?? require('../../../daemon/src/swarm/combos/ideas').strike
  const visible = actions.visible ?? ((bot, target) => require('../../../daemon/src/pick').canHit(bot, target, { range: 32 }))
  const trace: any = { startedAtMs: Date.now(), endedAtMs: null, physicsTicks: 0, frames: [],
    start: { position: point(e.entity.position), onGround: e.entity.onGround, yaw: e.entity.yaw, pitch: e.entity.pitch },
    policy: 'unarmored_local_lateral_10tick_toggle_80tick_visible_fist_retaliation', matched: 'policy_not_world_trajectory',
    retaliation: { attempts: 0, sent: 0, refused: [] } }
  let closed = false, lastAttempt = -5
  const motion = activeStrafe(e, () => closed || stop())
  const ctl = { get aborted() { return closed || stop() || motion.done || Date.now() - trace.startedAtMs >= 5000 } }
  const frame = () => trace.frames.push({ ms: Date.now(), tick: motion.ticks, position: point(e.entity.position),
    velocity: point(e.entity.velocity), onGround: e.entity.onGround, yaw: e.entity.yaw, pitch: e.entity.pitch })
  e.on('physicsTick', frame)
  const job = (async () => {
    while (!ctl.aborted) {
      const target = actions.target(e, a.username)
      // Empty-hand attack speed is 4/s: the ordinary native cooldown is five physics ticks.
      if (motion.ticks - lastAttempt >= 5 && target && visible(e, target)) {
        lastAttempt = motion.ticks; trace.retaliation.attempts++
        const result = await strike(e, target, { ctl })
        if (result.sent) trace.retaliation.sent++
        else trace.retaliation.refused.push({ ms: Date.now(), why: result.why })
      }
      await pause()
    }
  })().catch(error => { trace.error = String(error) }).finally(() => {
    trace.endReason = stop() ? 'first_life_ended' : motion.ticks >= 80 ? 'eighty_ticks' : closed ? 'closed' : 'wall_cap'
    motion.close(); e.removeListener('physicsTick', frame)
    trace.endedAtMs = motion.endedAtMs; trace.physicsTicks = motion.ticks
  })
  return { trace, settle: () => job, async close() { closed = true; motion.close(); await job } }
}

/** Same fixture and B path; useful Off spends A's charge on an ordinary sprint instead of awaiting a wave. */
export async function activeShockwavePhase(roles: any, mode: Mode, enabled: boolean, stop: () => boolean, actions: any): Promise<any> {
  const { body: b, spear: a, primary: t, enemy: e } = roles, bots = [b, a, t, e], lives = bots.map(bot => bot.entity)
  const dead = new Set<any>(), lifeEvents: any[] = [], ordinarySprint = mode === 'useful' && !enabled
  let closed = false, dropped = false, actualUse: any = null, enemy: ReturnType<typeof enemyWindow> | null = null, result: any, landing: any, heldEndMs: number | null = null
  const deadLife = (bot: any) => dead.has(bot) || bot.entity !== lives[bots.indexOf(bot)]
  const commonStop = () => closed || stop() || deadLife(a) || deadLife(b)
  const clearSprint = () => { a.setControlState('forward', false); a.setControlState('sprint', false) }
  const ended = bots.map(bot => Object.fromEntries(['death', 'end', 'respawn'].map(event => [event, () => {
    dead.add(bot); lifeEvents.push({ ms: Date.now(), actor: bot.username, event }); if (bot === a) clearSprint()
  }])))
  bots.forEach((bot, i) => { for (const event of ['death', 'end', 'respawn']) bot.on(event, ended[i][event]) })
  const serializer = a._client.serializer
  const serialized = (buffer: Buffer) => {
    if (actualUse || commonStop()) return
    try {
      const bytes = Buffer.from(buffer), parsed = serializer.proto.parsePacketBuffer('packet', bytes).data
      if (parsed.name !== 'use_item' || parsed.params.hand !== 0 || a.heldItem?.name !== 'iron_spear') return
      actualUse = { ms: Date.now(), name: parsed.name, hex: bytes.toString('hex'), ownPosition: point(a.entity.position) }
      enemy = enemyWindow(e, a, () => commonStop() || deadLife(e), actions)
      if (ordinarySprint) { a.setControlState('forward', true); a.setControlState('sprint', true) }
    } catch (error) { if (actualUse) throw error }
  }
  serializer?.on?.('data', serialized)
  try {
    result = await shockwavePhase(roles, mode === 'useful' || enabled, commonStop, { ...actions,
      chargedSpear: async (bot, target, p) => {
        const ctl = { get aborted() { return p.ctl.aborted || deadLife(e) || commonStop() } }
        let value: any
        try { value = await actions.chargedSpear(bot, target, { ...p, ctl, stand: false }) }
        finally { heldEndMs = Date.now(); clearSprint() }
        // E can die before use+20. Keep the existing phase's spearDone gate open until B gets its scheduled drop.
        const deadline = Date.now() + 6000
        while (actualUse && !dropped && !commonStop() && Date.now() < deadline) await pause()
        return value
      },
      maceDive: (bot, target, p) => actions.maceDive(bot, target, { ...p, ctl: { get aborted() { return p.ctl.aborted || deadLife(t) || commonStop() } } }),
      removeFloor: async () => { await actions.removeFloor(); dropped = true },
    })
    await enemy?.settle()
  } finally {
    closed = true; clearSprint(); a.setControlState('jump', false); a.deactivateItem()
    try {
      await enemy?.close()
      landing = deadLife(a) ? { reason: 'first_life_ended', groundTicks: 0, frames: [] } : await fullSpearLanding(a, () => stop() || deadLife(a))
      if (deadLife(a)) landing.reason = 'first_life_ended'
    }
    finally {
      serializer?.removeListener?.('data', serialized)
      bots.forEach((bot, i) => { for (const event of ['death', 'end', 'respawn']) bot.removeListener(event, ended[i][event]) })
    }
  }
  return { ...result, mode: mode === 'ca' ? 'H40_active_causal' : 'H40_active_useful_run_charge', enabled,
    actualUse, enemyWindow: enemy?.trace ?? null, fullLanding: landing, firstLifeEvents: lifeEvents, heldEndMs,
    error: result?.error ?? enemy?.trace.error ?? null,
    ordinarySprint, waitPolicy: 'grounded_no_auto_hop', candidate: 'H40_active_grounded_wait_48', rejoin: 'unknown_not_measured',
    comparison: mode === 'ca' ? 'grounded_wait_active_E_matched_policy_sham_B_vs_real_B' : 'both_real_B_A_run_charge_vs_A_grounded_wait_wave',
    limitation: 'unarmored_scripted_enemy; specific_run_charge_reference_not_general_swarm_ROI' }
}

/** Measurement only: a packet contact remains distinct from positive native/first-life HP damage. */
export function activeOutcome(row: any) {
  const phase = row.phase, window = phase?.enemyWindow
  const source = row.traces?.enemy?.damage ? row.traces.enemy.damage.map(p => ({ ms: p.ms, name: 'damage_event', receiverId: row.ids.enemy, data: p })) : phase?.packets ?? []
  const packets = source.filter(p => p.name === 'damage_event' && p.receiverId === row.ids.enemy &&
    p.data?.entityId === row.ids.enemy && p.data?.sourceCauseId === row.ids.spear + 1 && p.data?.sourceDirectId === row.ids.spear + 1)
  const death = phase?.firstLifeEvents?.find(p => p.actor === row.actors.enemy && p.event === 'death')
  const within = ms => !!window && ms >= window.startedAtMs && ms <= window.endedAtMs
  const after = ms => !!window && ms > window.endedAtMs
  const killed = row.receipts.enemy.deaths > 0
  const falls = (row.probe ?? []).filter(p => p.event === 'fall_damage' && p.player === row.actors.spear && !p.cancelled && p.finalDamage > 0)
  return { packetContactsWithinWindow: packets.filter(p => within(p.ms)).length,
    packetContactsAfterWindow: packets.filter(p => after(p.ms)).length,
    killWithinWindow: killed && !death ? null : killed && within(death.ms), killAfterWindow: killed && !death ? null : killed && after(death.ms),
    clientFullLanding: phase?.fullLanding?.reason === 'landed' && phase.fullLanding.groundTicks >= 2,
    nativeAFallDamage: falls.reduce((n, p) => n + p.finalDamage, 0),
    nativeALateFallDamage: Number.isFinite(phase?.heldEndMs) ? falls.filter(p => p.ms >= phase.heldEndMs).reduce((n, p) => n + p.finalDamage, 0) : null }
}

export async function activeShockwaveTrials(mode: Mode, pairs = 1, hp = 100) {
  if (!['ca', 'useful'].includes(mode) || !Number.isInteger(pairs) || pairs < 1 || pairs > 20 || ![20, 100].includes(hp))
    throw new Error('combo-shockwave-active ca|useful [pairs=1:1..20] [hp=100:20|100]')
  return shockwaveTrials(pairs, mode, hp)
}

if (require.main === module) {
  const [mode, pairs = '1', hp = '100', ...extra] = process.argv.slice(2)
  if (!['ca', 'useful'].includes(mode) || extra.length || !/^\d+$/.test(pairs) || !['20', '100'].includes(hp)) throw new Error('combo-shockwave-active ca|useful [pairs=1] [hp=100:20|100]')
  activeShockwaveTrials(mode as Mode, Number(pairs), Number(hp)).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
