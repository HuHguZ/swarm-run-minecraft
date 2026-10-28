import { performance } from 'node:perf_hooks'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

export type FlightFrame = { ms: number; x: number; y: number; z: number; vy: number; onGround: boolean; age?: string }
export function anvilArm(enabled: boolean, rescue?: 'water' | 'water-motion' | 'wind' | 'wind-observed' | 'wind-gravity') {
  return { firstWind: !!rescue || enabled, supportZ: rescue ? 606.5 : 604.5, waterEnabled: !!rescue && enabled }
}
export type Apex = FlightFrame & { index: number; confirmedAtMs: number }
export function detectApex(frames: FlightFrame[]): Apex | null {
  let previous: FlightFrame | null = null, peak: Apex | null = null, rising = false
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]
    if (![frame.ms, frame.x, frame.y, frame.z].every(Number.isFinite) || previous && frame.ms < previous.ms) continue
    if (previous && !frame.onGround && frame.y > previous.y) rising = true
    if (rising && !frame.onGround && (!peak || frame.y > peak.y)) peak = { ...frame, index, confirmedAtMs: frame.ms }
    // Repeated positions, including the first negative post-drag vy, are not a confirmed descent.
    if (peak && frame.y < peak.y) return { ...peak, confirmedAtMs: frame.ms }
    previous = frame
  }
  return null
}
export function observationStop(frames: FlightFrame[], elapsedMs: number, stop: boolean): string | null {
  if (stop) return 'AUTO-STOP'
  if (frames.at(-1)?.onGround === true && frames.some(frame => frame.onGround === false)) return 'landed'
  return elapsedMs >= 4000 ? 'timeout' : null
}
export function windContact(trace: { damage: any[]; explosions: any[] }, shooterId: number) {
  // Native sourceCauseId is wire entityId+1; unrelated HP loss and sent packets are not receipts.
  const directEvents = trace.damage.filter(event => event.sourceTypeId === 47 && event.sourceCauseId === shooterId + 1).length
  const impulses = trace.explosions.filter(event => event.impulse && ['x', 'y', 'z'].every(axis => Number.isFinite(event.impulse[axis])) &&
    Math.hypot(event.impulse.x, event.impulse.y, event.impulse.z) > 0).length
  return { contact: directEvents > 0 || impulses > 0, kind: directEvents ? 'direct' : impulses ? 'burst' : 'none', directEvents, impulses }
}
export async function observeFlight(frames: FlightFrame[], stop: () => boolean, maxMs = 4000): Promise<string> {
  const start = performance.now()
  for (;;) {
    const elapsed = performance.now() - start
    const why = observationStop(frames, elapsed, stop())
    if (why) return why
    if (elapsed >= maxMs) return 'timeout'
    await new Promise(resolve => setTimeout(resolve, Math.min(25, maxMs - elapsed)))
  }
}

export function apexRelease(previous: { x: number; y: number; z: number } | null, current: { x: number; y: number; z: number }, vy: number) {
  const rising = !!previous && current.y > previous.y
  let remaining: number | null = null
  if (Number.isFinite(vy) && vy > 0) {
    let velocity = vy, ticks = 0
    while (velocity > 0 && ticks < 500) { velocity = (velocity - .08) * Math.fround(.98); ticks++ }
    if (velocity <= 0) remaining = ticks
  }
  return { rising, remaining, ready: rising && remaining !== null && remaining <= 8 }
}
// Experimental 20-HP caller candidate: native29 hit at h=1.5926 dealt 18.556 plus one wind damage.
// Delay the first attempt past two observed blocks in both arms; this is not the native smash threshold.
export function diveGate(startY: number, y: number, vy: number) { return startY - y > 2 && vy < 0 }
export function activeStrafe(bot: any, stop: () => boolean) {
  let ticks = 0, done = false, endedAtMs: number | null = null
  const close = () => {
    if (done) return
    done = true; endedAtMs = Date.now(); bot.removeListener('physicsTick', step); bot.removeListener('death', close); bot.removeListener('end', close)
    bot.setControlState('left', false); bot.setControlState('right', false)
  }
  const apply = () => {
    if (stop() || ticks >= 80) return close()
    bot.setControlState('left', Math.floor(ticks / 10) % 2 === 0)
    bot.setControlState('right', Math.floor(ticks / 10) % 2 === 1)
  }
  const step = () => { ticks++; apply() }
  bot.on('physicsTick', step); bot.on('death', close); bot.on('end', close); apply()
  return { close, get ticks() { return ticks }, get done() { return done }, get endedAtMs() { return endedAtMs } }
}
export function anvilContact(probe: any[], damage: any[], attackerId: number, targetId: number,
  activeWindow?: { fromMs: number; throughMs: number } | null) {
  const accepted = probe.filter(event => event.event === 'mace_damage' && event.attackerId === attackerId && event.targetId === targetId &&
    !event.cancelled && event.finalDamage > 0)
  const damageEvents = damage.filter(event => event.entityId === targetId && event.sourceCauseId === attackerId + 1 &&
    (event.sourceTypeId === 26 || event.sourceTypeId === 34))
  return { contact: accepted.length > 0 || damageEvents.length > 0,
    airContact: accepted.length ? accepted.some(event => event.targetOnGround === false) : null,
    withinActiveWindow: activeWindow && accepted.length ? accepted.some(event => event.ms >= activeWindow.fromMs && event.ms <= activeWindow.throughMs) : null,
    airWithinActiveWindow: activeWindow && accepted.length ? accepted.some(event => event.ms >= activeWindow.fromMs && event.ms <= activeWindow.throughMs && event.targetOnGround === false) : null,
    probe: accepted, damageEvents }
}

/** Landing is client physics; the server's fall-damage HP packet can arrive afterwards. */
export async function drainTelemetry(bots: any[], stop: () => boolean, maxMs = 500) {
  const ticks = bots.map(() => 0), handlers = bots.map((_, index) => () => { ticks[index]++ })
  const started = performance.now()
  bots.forEach((bot, index) => bot.on('physicsTick', handlers[index]))
  try {
    while (!stop() && ticks.some(count => count < 3) && performance.now() - started < maxMs)
      await new Promise(resolve => setTimeout(resolve, 10))
    return { ticks, reason: stop() ? 'AUTO-STOP' : ticks.every(count => count >= 3) ? 'drained' : 'timeout', elapsedMs: performance.now() - started }
  } finally { bots.forEach((bot, index) => bot.removeListener('physicsTick', handlers[index])) }
}
export function nativeHpAgreement(raw: string, firstLife: { hp: number; deaths: number }) {
  const value = raw.match(/:\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)[fFdD]?\s*$/)?.[1]
  const nativeHp = value === undefined ? null : Number(value)
  return { nativeHp, firstLifeHp: firstLife.hp, firstLifeEnded: firstLife.deaths > 0,
    matches: nativeHp !== null && Number.isFinite(nativeHp) && !firstLife.deaths ? Math.abs(nativeHp - firstLife.hp) < .0001 : null }
}
type FixturePoint = { x: number; y: number; z: number }
type FixtureSample = { client: FixturePoint; native: string | null; onGround: boolean; support: { name: string; boundingBox: string } | null }
export function fixtureReady(sample: FixtureSample, expected: FixturePoint | null) {
  if (sample.support?.name !== 'glass' || sample.support.boundingBox !== 'block') return false
  if (expected === null) return true // Receive the collision support before sending the elevated teleport.
  const server = sample.native?.match(/\[([^\]]+)\]/)?.[1].split(',').map(value => parseFloat(value))
  const client = [sample.client.x, sample.client.y, sample.client.z], wanted = [expected.x, expected.y, expected.z]
  return sample.onGround && !!server && server.length === 3 && [...server, ...client].every(Number.isFinite) &&
    Math.hypot(...server.map((value, axis) => value - wanted[axis])) <= .05 &&
    Math.hypot(...client.map((value, axis) => value - wanted[axis])) <= .05
}
export async function fixtureBarrier(read: () => Promise<FixtureSample>, expected: FixturePoint | null, stop: () => boolean, maxMs = 2000) {
  const started = performance.now()
  let sample: FixtureSample | null = null
  for (;;) {
    if (!stop()) {
      sample = await read()
      if (fixtureReady(sample, expected)) return { ms: Date.now(), elapsedMs: performance.now() - started, sample }
    }
    if (stop() || performance.now() - started >= maxMs)
      throw Object.assign(new Error(stop() ? 'AUTO-STOP' : 'fixture receipt timeout'), { fixture: { expected, sample, elapsedMs: performance.now() - started } })
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
type WindMotionSample = { atMs: number; visible: boolean; afterBaseline: boolean; confidence: boolean; position: FixturePoint | null;
  receipt: (FixturePoint & { t: number; kind?: string }) | null; velocity: (FixturePoint & { ageTicks?: number }) | null }
export async function waitWindReady(read: () => WindMotionSample, stop: () => boolean) {
  const started = performance.now(), seen = new Set<string>(), horizontal = new Set<string>(), observations: WindMotionSample[] = []
  let current: WindMotionSample | null = null
  const result = (reason: string) => ({ ready: reason === 'ready', reason, elapsedMs: performance.now() - started,
    newReceiptCount: seen.size, distinctHorizontalPositions: horizontal.size, current, observations })
  for (;;) {
    if (stop()) return result('cancelled')
    if (performance.now() - started >= 500) return result('timeout')
    // Poll after packet handlers finish; freshness uses this observer's tracker clock, not Date.now minus receipt.t.
    current = read()
    const receipt = current.receipt, velocity = current.velocity
    if (current.visible && current.afterBaseline && receipt && [receipt.t, receipt.x, receipt.y, receipt.z].every(Number.isFinite)) {
      const key = JSON.stringify([receipt.t, receipt.kind, receipt.x, receipt.y, receipt.z])
      if (!seen.has(key)) { seen.add(key); horizontal.add(`${receipt.x},${receipt.z}`); observations.push(current) }
      if (seen.size >= 2 && horizontal.size >= 2 && current.confidence && velocity &&
        [velocity.x, velocity.z, velocity.ageTicks].every(Number.isFinite) && velocity.ageTicks! >= 0 && velocity.ageTicks! <= 1.5 &&
        Math.hypot(velocity.x, velocity.z) > 0) return result('ready')
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(0, 500 - (performance.now() - started)))))
  }
}

/** Two passive actors; self physics/HP are calibration telemetry, never future enemy choice inputs. */
export async function calibrate(reps = 3) {
  if (!Number.isInteger(reps) || reps < 1 || reps > 20) throw new Error('calibrate reps[1..20]')
  const { REPO_ROOT, DIST_ROOT } = require('../../../daemon/src/paths')
  const { GameClock } = require('../../../daemon/src/game-clock')
  const { connect, clients, measure, sleep, stopped, target } = require('./combo-ideas')
  const { setup, track, give, hold, cmd, position } = require('./combo-air')
  const { settleFixtureTeleport } = require('./combo-ab')
  const { windAt } = require(path.join(DIST_ROOT, 'daemon/src/swarm/combos/air-ideas'))
  if (stopped()) throw new Error('AUTO-STOP')
  const inherited = new Set(clients), rows: any[] = []
  const folder = path.join(REPO_ROOT, 'farm/results/ideas-28')
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `anvil-calibrate-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`)
  fs.closeSync(fs.openSync(file, 'wx'))
  const native = async (bot: any) => ({ pos: await cmd(`data get entity ${bot.username} Pos`),
    fall: await cmd(`data get entity ${bot.username} fall_distance`), health: await cmd(`data get entity ${bot.username} Health`) })
  try {
    const support = await connect('NeuroFarm28j', new GameClock()), victim = await connect('NeuroFarm28k', new GameClock())
    for (let rep = 0; rep < reps; rep++) {
      if (stopped()) throw new Error('AUTO-STOP')
      await setup([support, victim], [[600.5, 606.5], [600.5, 600.5]], 100)
      for (const bot of [support, victim]) await cmd(`clear ${bot.username}`)
      await give(support, 'wind_charge 1'); await hold(support, 'wind_charge')
      await settleFixtureTeleport([support, victim]) // No teleport after this boundary.
      const nativeStart = [await native(support), await native(victim)]
      for (const [index, expectedZ] of [[0, 606.5], [1, 600.5]]) {
        const values = nativeStart[index].pos.match(/\[([^\]]+)\]/)?.[1].split(',').map((value: string) => parseFloat(value))
        if (!values || values.length !== 3 || !values.every(Number.isFinite) || Math.hypot(values[0] - 600.5, values[1] - 151, values[2] - expectedZ) > .05)
          throw new Error(`unsettled native pose: ${nativeStart[index].pos}`)
      }
      if (support.health !== 100 || victim.health !== 100) throw new Error('fixture HP is not 100')
      const start = { support: position(support), victim: position(victim) }
      const hp = [measure(support), measure(victim)], finish = [track(support), track(victim)]
      const frames: FlightFrame[] = [], sample = () => frames.push({ ms: Date.now(), ...position(victim),
        vy: victim.entity.velocity.y, onGround: victim.entity.onGround })
      victim.on('physicsTick', sample)
      let release: any, endReason: string, receipts: any[], traces: any[]
      try {
        release = await windAt(support, target(support, victim.username), { ctl: { get aborted() { return stopped() } } })
        endReason = release.fired ? await observeFlight(frames, stopped) : stopped() ? 'AUTO-STOP' : 'release_refused'
      } finally {
        victim.removeListener('physicsTick', sample)
        receipts = hp.map(close => close()); traces = finish.map(close => close())
      }
      const nativeEnd = [await native(support), await native(victim)]
      const apex = detectApex(traces[1].frames)
      const end = position(victim), delta = { x: end.x - start.victim.x, y: end.y - start.victim.y, z: end.z - start.victim.z }
      const row = { mode: 'calibrate', rep, actors: { support: support.username, victim: victim.username }, start,
        nativeStart, nativeEnd, release, endReason, apex, displacement: delta, contact: windContact(traces[1], support.entity.id),
        receipts: { support: receipts[0], victim: receipts[1] }, traces: { support: traces[0], victim: traces[1] } }
      rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n')
      console.log(JSON.stringify({ file, ...row, traces: undefined }))
      if (endReason === 'AUTO-STOP') throw new Error('AUTO-STOP')
    }
    return { file, rows }
  } finally {
    const apices = rows.flatMap(row => row.apex ? [row.apex] : [])
    const summary = { file, n: rows.length, fired: rows.filter(row => row.release.fired).length,
      contacts: rows.filter(row => row.contact.contact).length, confirmedApices: apices.length,
      apices: apices.map(({ x, y, z, ms, confirmedAtMs }) => ({ x, y, z, ms, confirmedAtMs })),
      damage: rows.reduce((sum, row) => sum + row.receipts.victim.damage, 0),
      ownDamage: rows.reduce((sum, row) => sum + row.receipts.support.damage, 0),
      deaths: rows.reduce((sum, row) => sum + row.receipts.support.deaths + row.receipts.victim.deaths, 0) }
    fs.writeFileSync(file.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(summary, null, 2) + '\n')
    console.log('SUMMARY', JSON.stringify(summary))
    for (const bot of clients.filter((bot: any) => !inherited.has(bot))) {
      bot.clearControlStates(); bot.deactivateItem(); bot.quit('wind-only calibration complete')
    }
    await sleep(300)
  }
}

export async function apexTrials(active: boolean | 'ready' = false, pairs = 3, hp = 100, rescueMode?: 'water' | 'water-motion' | 'wind' | 'wind-observed' | 'wind-gravity') {
  const windRescue = rescueMode === 'wind' || rescueMode === 'wind-observed' || rescueMode === 'wind-gravity'
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20 || ![20, 100].includes(hp)) throw new Error('apex|active|active-ready pairs[1..20] hp20|100')
  if (rescueMode && (!['water', 'water-motion', 'wind', 'wind-observed', 'wind-gravity'].includes(rescueMode) || active === 'ready' || (rescueMode === 'water-motion' || windRescue) && active))
    throw new Error('water rescue uses apex or active target; synthetic motion control uses apex only')
  const { REPO_ROOT, DIST_ROOT } = require('../../../daemon/src/paths')
  const { GameClock } = require('../../../daemon/src/game-clock')
  const { connect, clients, measure, sleep, stopped, target } = require('./combo-ideas')
  const { setup, track, place, give, hold, cmd, position } = require('./combo-air')
  const { settleFixtureTeleport } = require('./combo-ab')
  const createRescue: typeof import('./combo-rescue').startWaterRescue = rescueMode === 'wind-gravity' ? require('./combo-wind-gravity').startGravityWindRescue : rescueMode === 'wind-observed' ? require('./combo-wind-observation').startObservedWindRescue : windRescue ? require('./combo-wind-rescue').startWindRescue : rescueMode ? require('./combo-rescue').startWaterRescue : null
  const { windAt, maceDive } = require(path.join(DIST_ROOT, 'daemon/src/swarm/combos/air-ideas'))
  const { observedVelocity, hasObservedVelocity } = require(path.join(DIST_ROOT, 'daemon/src/bow/track'))
  const pick = require(path.join(DIST_ROOT, 'daemon/src/pick'))
  if (stopped()) throw new Error('AUTO-STOP')
  const inherited = new Set(clients), rows: any[] = [], mode = rescueMode === 'wind-gravity' ? 'wind-rescue-C2b' : rescueMode === 'wind-observed' ? 'wind-rescue-C2a' : windRescue ? 'wind-rescue-C1' : rescueMode === 'water-motion' ? 'water-rescue-synthetic-motion-control' : rescueMode ? active ? 'water-rescue-active' : 'water-rescue' : active === 'ready' ? 'active-ready' : active ? 'active' : 'apex'
  const candidate = rescueMode === 'wind-gravity' ? 'H37_C2b_strict_postcue_arc_gravity_age_look1_wind_vs_sham' : rescueMode === 'wind-observed' ? 'H37_C2a_strict_postcue_arc_same_linear_wind_vs_sham' : windRescue ? 'H37_C1_stationary_second_linear_wind_vs_sham' : rescueMode === 'water-motion' ? 'H38_SYNTHETIC_motion_only_control_same_wind_sprint_water_vs_sham' : rescueMode ? active ? 'H38_active_same_wind_sprint_water_vs_sham' : 'H38_same_wind_sprint_water_vs_sham' : 'drop_gt2_support4m'
  const initialWind = windRescue ? 2 : 1
  const folder = path.join(REPO_ROOT, 'farm/results/ideas-28')
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `anvil-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`)
  fs.closeSync(fs.openSync(file, 'wx'))
  const probeFile = path.join(REPO_ROOT, 'farm/server-28/plugins/IdeasProbe/events.jsonl')
  const context = async (bot: any) => ({ ignore: await cmd(`data get entity ${bot.username} ignore_fall_damage_from_current_explosion`),
    grace: await cmd(`data get entity ${bot.username} current_impulse_context_reset_grace_time`),
    impact: await cmd(`data get entity ${bot.username} current_explosion_impact_pos`) })
  const native = async (bot: any, body = false) => ({ ms: Date.now(), pos: await cmd(`data get entity ${bot.username} Pos`),
    fall: await cmd(`data get entity ${bot.username} fall_distance`), health: await cmd(`data get entity ${bot.username} Health`),
    ...(windRescue && body ? { context: await context(bot) } : {}) })
  try {
    const mace = await connect('NeuroFarm28b0', new GameClock()), support = await connect('NeuroFarm28j', new GameClock()),
      victim = await connect('NeuroFarm28k', new GameClock()), actors = [mace, support, victim]
    for (let pair = 0; pair < pairs; pair++) for (const enabled of (pair % 2 ? [true, false] : [false, true])) {
      if (stopped()) throw new Error('AUTO-STOP')
      const arm = anvilArm(enabled, rescueMode)
      const nativeStart: any[] = [], prep: any = {}, wantedMace = { x: 600.5, y: 163, z: 597.5 }
      let prepStage = 'setup'
      const prepSample = async (withNative: boolean): Promise<FixtureSample> => {
        const raw = withNative ? await cmd(`data get entity ${mace.username} Pos`) : null
        const cell = mace.entity.position.clone(); cell.x = 600; cell.y = 162; cell.z = 597
        const block = mace.blockAt(cell)
        return { client: position(mace), native: raw, onGround: mace.entity.onGround,
          support: block ? { name: block.name, boundingBox: block.boundingBox } : null }
      }
      try {
        await setup(actors, [[600.5, 597.5], [600.5, arm.supportZ], [600.5, 600.5]], hp)
        if (rescueMode) {
          prepStage = 'rescue_cell_receipt'
          await cmd('fill 592 151 589 608 151 605 minecraft:air replace minecraft:water')
          await cmd('setblock 600 150 597 minecraft:stone')
          const cell = support.entity.position.clone(); cell.set(600, 151, 597)
          const sample = () => {
            const block = support.blockAt(cell), below = support.blockAt(cell.offset(0, -1, 0))
            return { ms: Date.now(), source: block ? { name: block.name, boundingBox: block.boundingBox } : null,
              below: below ? { name: below.name, boundingBox: below.boundingBox } : null }
          }
          const deadline = Date.now() + 2000
          while (!stopped() && Date.now() < deadline) {
            prep.rescue = sample()
            if (prep.rescue.source?.name === 'air' && prep.rescue.below?.name === 'stone') break
            await sleep(25)
          }
          if (stopped() || prep.rescue?.source?.name !== 'air' || prep.rescue?.below?.name !== 'stone')
            throw new Error('rescue source air/stone client receipt missing')
        }
        if (windRescue) {
          prepStage = 'natural_context_reset'
          await mace.waitForTicks(42); await settleFixtureTeleport(actors)
          prep.context = await context(mace)
          if (!/:\s*0b\s*$/.test(prep.context.ignore) || !/:\s*0\s*$/.test(prep.context.grace))
            throw new Error('wind rescue fixture context did not naturally reset')
        }
        prepStage = 'support_receipt'
        await cmd('setblock 600 162 597 minecraft:glass')
        prep.support = await fixtureBarrier(() => prepSample(false), null, stopped)
        console.log(JSON.stringify({ kind: 'prep_ready', pair, enabled, stage: prepStage, ...prep.support }))
        prepStage = 'pose_receipt'
        await place(mace, 600.5, 163, 597.5)
        prep.pose = await fixtureBarrier(() => prepSample(true), wantedMace, stopped)
        console.log(JSON.stringify({ kind: 'prep_ready', pair, enabled, stage: prepStage, ...prep.pose }))
        prepStage = 'kit'
        for (const bot of actors) await cmd(`clear ${bot.username}`)
        await give(mace, 'mace'); await hold(mace, 'mace')
        await give(support, `wind_charge ${initialWind}`)
        if (rescueMode && !windRescue) await give(support, 'water_bucket 1')
        await hold(support, 'wind_charge')
        mace._ndSwarmAllies = [support.username]; support._ndSwarmAllies = [mace.username]
        prepStage = 'dry_hop'
        await settleFixtureTeleport(actors) // Both sides received the intended elevated pose before this hop.
        await victim.look(0, 0, true)
        await mace.waitForTicks(36)
        await cmd(`random reset * ${280126 + pair}`)
        prepStage = 'native_start'
        for (const bot of actors) nativeStart.push(await native(bot, bot === mace))
        if (windRescue && (!/:\s*0b\s*$/.test(nativeStart[0].context.ignore) || !/:\s*0\s*$/.test(nativeStart[0].context.grace)))
          throw new Error('wind rescue elevated nativeStart context is not reset')
        for (let i = 0; i < actors.length; i++) {
          const values = nativeStart[i].pos.match(/\[([^\]]+)\]/)?.[1].split(',').map((value: string) => parseFloat(value))
          const wanted = [[600.5, 163, 597.5], [600.5, 151, arm.supportZ], [600.5, 151, 600.5]][i]
          if (!values || values.length !== 3 || !values.every(Number.isFinite) || Math.hypot(...values.map((v: number, axis: number) => v - wanted[axis])) > .05)
            throw new Error(`unsettled native pose: ${nativeStart[i].pos}`)
          if (actors[i].health !== hp) throw new Error(`fixture HP ${actors[i].username}: ${actors[i].health} != ${hp}`)
        }
      } catch (error) {
        const failure = { kind: 'prep_failure', ms: Date.now(), mode, pair, enabled, hp, stage: prepStage, prep, nativeStart,
          current: actors.map(bot => ({ actor: bot.username, ...position(bot), onGround: bot.entity.onGround, hp: bot.health })),
          error: String(error), fixture: (error as any).fixture ?? null }
        const failureFile = file.replace(/\.jsonl$/, `-${pair}-${enabled ? 'on' : 'off'}.prep-failure.json`)
        fs.writeFileSync(failureFile, JSON.stringify(failure, null, 2) + '\n')
        console.log(JSON.stringify({ file: failureFile, ...failure }))
        throw error
      }
      const ids = actors.map(bot => bot.entity.id), start = actors.map(position), startY = mace.entity.position.y
      const probeOffset = fs.existsSync(probeFile) ? fs.statSync(probeFile).size : 0
      const hpReceipts: any[] = actors.map(measure), closeTrace: any[] = actors.map(track)
      const t0 = Date.now(), wallStart = performance.now(), observed: any[] = [], deaths: any[] = []
      const initialReceipt = target(support, victim.username)?._ndPositionReceipts?.[1] ?? null
      const ctl = { get aborted() { return stopped() || deaths.length > 0 } }
      const onDeath = actors.map(bot => () => deaths.push({ actor: bot.username, atMs: Date.now() - t0 }))
      actors.forEach((bot, i) => bot.on('death', onDeath[i]))
      // Support's clear ray supplies the visible team observation; the mace's glass support blocks its downward pick ray.
      let previous = target(support, victim.username)?.position?.clone() ?? null, forecast: any = null
      const onFoe = (entity: any) => {
        if (entity.id !== ids[2] || !entity.position || !pick.canHit(support, entity, { range: 32 })) return
        const current = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
        if (previous && ['x', 'y', 'z'].every(axis => current[axis] === previous[axis])) return
        const velocity = observedVelocity(entity), confidence = hasObservedVelocity(entity)
        const decision = apexRelease(previous, current, velocity.y)
        const receipt = entity._ndPositionReceipts?.[1]
        const sample = { atMs: Date.now() - t0, ...current, onGround: entity.onGround, velocity: { ...velocity }, confidence,
          receipt: receipt ? { t: receipt.t, kind: receipt.kind, x: receipt.x, y: receipt.y, z: receipt.z } : null, ...decision }
        observed.push(sample); previous = current
        if (!forecast && entity.onGround !== true && confidence && (velocity.ageTicks ?? 0) <= 1.5 && decision.ready) forecast = sample
      }
      support.on('entityMoved', onFoe)
      const motion = active ? activeStrafe(victim, () => ctl.aborted) : null
      let wind: any = { fired: false, why: 'baseline' }, dive: any = null, dropAtMs: number | null = null,
        launchedAtMs: number | null = null, gate: any = null, dropReason = 'baseline', traces: any[], receipts: any[],
        telemetryTail: any = null, physicalEndAtMs: number | null = null, readiness: any = null
      const onOwn = () => { if (dropAtMs !== null && launchedAtMs === null && !mace.entity.onGround) launchedAtMs = Date.now() - t0 }
      mace.on('physicsTick', onOwn)
      const rescue = rescueMode ? windRescue ? createRescue(support, mace, victim, arm.waterEnabled, stopped, t0) : createRescue(support, mace, victim, arm.waterEnabled, stopped, t0, rescueMode !== 'water-motion') : null
      try {
        if (arm.firstWind) {
          if (active === 'ready') readiness = { baseline: initialReceipt ? { t: initialReceipt.t, kind: initialReceipt.kind,
            x: initialReceipt.x, y: initialReceipt.y, z: initialReceipt.z } : null, ...await waitWindReady(() => {
            const enemy = target(support, victim.username), visible = !!enemy?.position && pick.canHit(support, enemy, { range: 32 })
            const receipt = visible ? enemy._ndPositionReceipts?.[1] : null, velocity = visible ? observedVelocity(enemy) : null
            return { atMs: Date.now() - t0, visible,
              afterBaseline: !!receipt && receipt !== initialReceipt, confidence: visible && hasObservedVelocity(enemy),
              position: visible ? { x: enemy.position.x, y: enemy.position.y, z: enemy.position.z } : null,
              receipt: receipt ? { t: receipt.t, kind: receipt.kind, x: receipt.x, y: receipt.y, z: receipt.z } : null,
              velocity: velocity ? { ...velocity } : null }
          }, () => ctl.aborted) }
          // Readiness timeout spends coordination time, then attempts the same ordinary wind shot.
          wind = active === 'ready' && ctl.aborted ? { fired: false, why: 'cancelled_before_wind' } :
            await windAt(support, target(support, victim.username), { ctl })
          rescue?.afterWind(wind)
          const forecastStart = performance.now()
          while (wind.fired && !forecast && !ctl.aborted && performance.now() - forecastStart < 4000) await sleep(10)
          dropReason = forecast ? 'remote_rising_forecast' : wind.fired ? 'fallback_flight_timeout' : 'fallback_wind_refused'
        }
        if (!ctl.aborted) {
          dropAtMs = Date.now() - t0
          await cmd('setblock 600 162 597 minecraft:air')
          const gateStart = performance.now()
          while (!diveGate(startY, mace.entity.position.y, mace.entity.velocity.y) && !ctl.aborted && performance.now() - gateStart < 4000) await sleep(10)
          gate = { atMs: Date.now() - t0, startY, y: mace.entity.position.y, observedDropFromRelease: startY - mace.entity.position.y,
            ownVy: mace.entity.velocity.y, onGround: mace.entity.onGround }
          if (!ctl.aborted && diveGate(startY, gate.y, gate.ownVy)) dive = await maceDive(mace, target(mace, victim.username), { ctl, maxTicks: 90 })
          else dive = { sent: false, why: ctl.aborted ? 'cancelled' : 'own_drop_not_observed' }
        }
        // Observe late falling costs; active input is at most 80 actual physics ticks from t0.
        const settleStart = performance.now()
        while (!stopped() && !deaths.some(event => event.actor === mace.username) && performance.now() - settleStart < 4000 &&
          (!mace.entity.onGround || !deaths.some(event => event.actor === victim.username) && !victim.entity.onGround || motion && !motion.done)) await sleep(10)
        await rescue?.settle()
      } finally {
        physicalEndAtMs = Date.now() - t0
        motion?.close(); support.removeListener('entityMoved', onFoe); mace.removeListener('physicsTick', onOwn)
        await rescue?.close()
        actors.forEach(bot => bot.clearControlStates())
        try { telemetryTail = await drainTelemetry(actors, stopped) }
        finally {
          actors.forEach((bot, i) => bot.removeListener('death', onDeath[i]))
          receipts = hpReceipts.map(close => close()); traces = closeTrace.map(close => close())
        }
      }
      const elapsedMs = Date.now() - t0, nativeEnd = []
      for (const bot of actors) nativeEnd.push(await native(bot, bot === mace))
      let probe: any[] = [], probeError: string | null = null
      try {
        const bytes = fs.readFileSync(probeFile)
        probe = bytes.subarray(probeOffset <= bytes.length ? probeOffset : 0).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      } catch (error) { probeError = String(error) }
      const remainingWind = support.inventory.items().filter((item: any) => item.name === 'wind_charge').reduce((n: number, item: any) => n + item.count, 0)
      const victimDeath = deaths.find(event => event.actor === victim.username)
      const activeWindow = motion ? { fromMs: t0, throughMs: motion.endedAtMs!, physicsTicks: motion.ticks } : null
      const row = { mode, pair, enabled, hp, candidate, t0, elapsedMs, wallElapsedMs: performance.now() - wallStart, prep, start, nativeStart, nativeEnd,
        physicalEndAtMs, telemetryTail, hpAgreement: Object.fromEntries(actors.map((bot, i) => [bot.username, nativeHpAgreement(nativeEnd[i].health, receipts[i])])),
        comparison: rescueMode === 'wind-gravity' ? 'C2b_postcue_arc_gate_gravity_age_look1_wind_vs_sham' : rescueMode === 'wind-observed' ? 'C2a_postcue_arc_gate_same_linear_wind_vs_sham' : windRescue ? 'C1_second_linear_wind_vs_sham_same_first_wind_stationary_support' : rescueMode === 'water-motion' ? 'SYNTHETIC_motion_only_water_vs_sham_same_first_wind_and_walk' : rescueMode ? 'water_vs_sham_same_first_wind_and_walk' : 'isolated_wind_vs_no_wind_passive_support', forecastObserver: support.username,
        ...(rescue ? { rescue: { ...rescue.trace, bodyHpLoss: receipts[0].damage, bodyHpEnd: receipts[0].hp, bodyDeaths: receipts[0].deaths } } : {}),
        wind, readiness, windConsumed: initialWind - remainingWind, dropReason, dropAtMs, launchedAtMs, forecast, observedFoe: observed, gate, dive,
        helperDropMeaning: 'local_to_maceDive_call_not_native_fall_distance', activeTicks: motion?.ticks ?? 0, activeWindow,
        firstDeath: deaths[0] ?? null, firstKillTTKMs: victimDeath?.atMs ?? null, deaths,
        firstKillWithinActiveWindow: activeWindow ? !!victimDeath && t0 + victimDeath.atMs <= activeWindow.throughMs : null,
        contact: anvilContact(probe, traces[2].damage, ids[0], ids[2], activeWindow), probeError, probe,
        receipts: { mace: receipts[0], support: receipts[1], victim: receipts[2] }, traces: { mace: traces[0], support: traces[1], victim: traces[2] } }
      rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n')
      console.log(JSON.stringify({ file, ...row, observedFoe: undefined, traces: undefined, probe: undefined }))
      if (stopped()) throw new Error('AUTO-STOP')
    }
    return { file, rows }
  } finally {
    const summary = { file, mode, hp, candidate, arms: [false, true].map(enabled => {
      const arm = rows.filter(row => row.enabled === enabled), kills = arm.filter(row => row.firstKillTTKMs !== null)
      return { enabled, n: arm.length, contacts: arm.filter(row => row.contact.contact).length,
        airContacts: arm.filter(row => row.contact.airContact === true).length, unknownAir: arm.filter(row => row.contact.airContact === null).length,
        activeContactsWithinWindow: active ? arm.filter(row => row.contact.withinActiveWindow === true).length : null,
        activeAirContactsWithinWindow: active ? arm.filter(row => row.contact.airWithinActiveWindow === true).length : null,
        activeKillsWithinWindow: active ? arm.filter(row => row.firstKillWithinActiveWindow === true).length : null,
        kills: kills.length, firstKillTTKMs: kills.length ? kills.reduce((n, row) => n + row.firstKillTTKMs, 0) / kills.length : null,
        damage: arm.reduce((n, row) => n + row.receipts.victim.damage, 0), windConsumed: arm.reduce((n, row) => n + row.windConsumed, 0),
        ownDamage: arm.reduce((n, row) => n + row.receipts.mace.damage + row.receipts.support.damage, 0),
        ownDeaths: arm.reduce((n, row) => n + row.receipts.mace.deaths + row.receipts.support.deaths, 0),
        ...(windRescue ? { firstWindFired: arm.filter(row => row.wind.fired).length,
          smashCues: arm.filter(row => row.rescue.firstSmash).length,
          secondWindFired: arm.filter(row => row.rescue.secondWind?.fired).length,
          secondWindRefusedOrSham: arm.filter(row => !row.rescue.secondWind?.fired).length } : rescueMode ? { firstWindFired: arm.filter(row => row.wind.fired).length,
          smashCues: arm.filter(row => row.rescue.firstSmash).length, waterSent: arm.filter(row => row.rescue.secondPlace?.sent).length,
          clientWaterObserved: arm.filter(row => row.rescue.secondPlace?.waterObserved).length,
          clientWaterBeforeLanding: arm.filter(row => row.rescue.secondPlace?.waterObserved && row.rescue.landing &&
            row.rescue.secondPlace.observedAt <= row.rescue.landing.ms).length } : {}),
        elapsedMs: arm.length ? arm.reduce((n, row) => n + row.elapsedMs, 0) / arm.length : null }
    }) }
    try {
      fs.writeFileSync(file.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(summary, null, 2) + '\n')
      console.log('SUMMARY', JSON.stringify(summary))
    } finally {
      for (const bot of clients.filter((bot: any) => !inherited.has(bot))) { bot.clearControlStates(); bot.deactivateItem(); bot.quit('anvil trial complete') }
      await sleep(300)
    }
  }
}

if (require.main === module) {
  const [mode, count = '3', hp = '100', ...extra] = process.argv.slice(2)
  if (!['calibrate', 'apex', 'active', 'active-ready', 'rescue', 'rescue-active', 'rescue-motion-control'].includes(mode) || extra.length || !/^\d+$/.test(count) || !['20', '100'].includes(hp) || mode === 'calibrate' && process.argv.length > 4)
    throw new Error('combo-anvil calibrate [reps=3] | apex|active|active-ready|rescue|rescue-active|rescue-motion-control [pairs=3] [hp=100:20|100]')
  const task = mode === 'calibrate' ? calibrate(Number(count)) : apexTrials(mode === 'active-ready' ? 'ready' : mode === 'active' || mode === 'rescue-active', Number(count), Number(hp), mode === 'rescue-motion-control' ? 'water-motion' : mode === 'rescue' || mode === 'rescue-active' ? 'water' : undefined)
  task.then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
