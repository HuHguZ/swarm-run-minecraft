import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))
const copy = (value: any) => value == null ? value : JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item))
const point = (p: any) => p ? { x: p.x, y: p.y, z: p.z } : null

/** Mineflayer supports respawn:false only at creation; shared connect keeps its default. Scope this filter to our T. */
export function targetRespawnFilter(bot: any, held: boolean) {
  const original = bot._client.write, requests: any[] = []
  const write = function (this: any, name: string, data: any, ...rest: any[]) {
    if (name === 'client_command' && (data?.payload === 0 || data?.actionId === 0)) {
      requests.push({ ms: Date.now(), blocked: held, data: copy(data) })
      if (held) return
    }
    return Reflect.apply(original, this, [name, data, ...rest])
  }
  bot._client.write = write
  return { requests, close() { if (bot._client.write === write) bot._client.write = original } }
}

export function classifyDeathBoost(trace: any) {
  const deathObserved = Number.isFinite(trace.deathAtMs), bursts = deathObserved ? (trace.explosions ?? []).filter(row => row.ms >= trace.deathAtMs) : []
  const receiverBursts = bursts.filter(row => row.actor === trace.receiver)
  const impulse = receiverBursts.some(row => row.impulse && [row.impulse.x, row.impulse.y, row.impulse.z].every(Number.isFinite) &&
    Math.hypot(row.impulse.x, row.impulse.y, row.impulse.z) > 0)
  const motion = receiverBursts.length > 0 && (trace.frames ?? []).some(row => row.actor === trace.receiver && row.ms >= receiverBursts[0].ms &&
    row.velocity && (Math.hypot(row.velocity.x, row.velocity.z) > 0 || row.velocity.y > 0))
  return { deathObserved, primedAtDeath: trace.primedAtDeath ?? null, blastObserved: bursts.length > 0,
    receiverImpulseObserved: impulse, receiverMotionObserved: motion,
    limitation: 'Isolated-scene temporal evidence, not a general explosion-source attribution or combat ROI claim' }
}

export async function windChargedPhase(roles: any, mode: 'auto' | 'held', stop: () => boolean, actions: any = {}): Promise<any> {
  const { attacker: a, target: t, receiver: b } = roles, bots = [a, t, b], lives = bots.map(bot => bot.entity)
  const t0 = Date.now(), ended = new Set<any>(), cleanup: (() => void)[] = [], observers: Promise<any>[] = [], jobs: Promise<any>[] = []
  const trace: any = { t0, mode, receiver: b.username, deathAtMs: null, primedAtDeath: null, frames: [], lifeEvents: [], effects: [],
    explosions: [], packets: [], checkpoints: [], toss: null, strike: null, landing: null, error: null, why: 'complete', hardClosed: false, joined: true }
  const filter = targetRespawnFilter(t, mode === 'held'), effectId = t.registry?.effectsByName?.WindCharged?.id ?? t.registry?.effectsByName?.wind_charged?.id
  let closed = false, pending = 0, primed = false, actionEnd = t0, capResolve: () => void
  const cap = new Promise<void>(resolve => { capResolve = resolve })
  const ctl = { get aborted() { return closed || stop() || [a, b].some(bot => ended.has(bot) || bot.entity !== lives[bots.indexOf(bot)] || !(bot.health > 0)) } }
  const checkpoint = (label: string) => {
    if (!actions.observe || trace.checkpoints.includes(label)) return
    trace.checkpoints.push(label)
    observers.push(Promise.resolve().then(() => actions.observe(label)).catch(error => ({ label, error: String(error) })))
  }
  const target = actions.target ?? ((bot, name) => require('./combo-ideas').target(bot, name))
  const visible = actions.visible ?? ((bot, entity) => require('../../../daemon/src/pick').canHit(bot, entity, { range: 32 }))
  const legal = () => { const foe = target(a, t.username); return !ctl.aborted && !ended.has(t) && t.entity === lives[1] &&
    foe?.id === lives[1].id && foe.isValid !== false && visible(a, foe) }
  const quitOwned = () => { for (const bot of bots) { try { bot.quit('wind-charged action wall cap') } catch {} } }
  const timer = setTimeout(() => { closed = true; trace.why = 'wall_cap'; if (pending) { trace.hardClosed = true; quitOwned() }; capResolve() }, 8000)
  const run = async (action: () => Promise<any>) => {
    pending++
    const job = Promise.resolve().then(action).then(value => ({ value }), error => ({ error })).finally(() => { pending-- })
    jobs.push(job)
    const result: any = await Promise.race([job, cap.then(() => ({ error: Error('wind-charged wall cap') }))])
    if (result.error) throw result.error
    return result.value
  }
  for (const [index, bot] of bots.entries()) {
    const step = () => { if (!ended.has(bot) && bot.entity === lives[index]) trace.frames.push({ ms: Date.now(), actor: bot.username,
      position: point(bot.entity.position), velocity: point(bot.entity.velocity), onGround: bot.entity.onGround }) }
    bot.on('physicsTick', step); cleanup.push(() => bot.removeListener('physicsTick', step))
    for (const event of ['death', 'respawn', 'end']) {
      const listener = () => { ended.add(bot); trace.lifeEvents.push({ ms: Date.now(), actor: bot.username, event, currentId: bot.entity?.id })
        if (bot === t && event === 'death' && trace.deathAtMs === null) { trace.deathAtMs = Date.now(); trace.primedAtDeath = Number.isFinite(effectId) ? primed : null; checkpoint('death') }
        if (bot === t && event === 'respawn' && trace.cleanupRespawnAtMs !== undefined) trace.cleanupRespawnObservedAtMs = Date.now() }
      bot.on(event, listener); cleanup.push(() => bot.removeListener(event, listener))
    }
    for (const name of ['entity_effect', 'remove_entity_effect', 'damage_event', 'entity_status', 'entity_destroy', 'respawn', 'explosion']) {
      const listener = (data: any) => {
        const row = { ms: Date.now(), actor: bot.username, name, data: copy(data) }
        if (trace.packets.length < 512) trace.packets.push(row)
        if (bot === t && t.entity === lives[1] && !ended.has(t) && data.entityId === lives[1].id && data.effectId === effectId && /entity_effect$/.test(name)) {
          primed = name === 'entity_effect'; trace.effects.push({ ...row, active: primed })
        }
        if (name === 'explosion') { trace.explosions.push({ ms: row.ms, actor: bot.username, center: copy(data.center), impulse: copy(data.playerKnockback), packet: copy(data) }); checkpoint('explosion') }
      }
      bot._client.on(name, listener); cleanup.push(() => bot._client.removeListener(name, listener))
    }
    const serializer = bot._client.serializer
    const serialized = (bytes: Buffer) => { try {
      const buffer = Buffer.from(bytes), parsed = serializer.proto.parsePacketBuffer('packet', buffer).data
      if (['use_item', 'use_entity', 'arm_animation', 'client_command'].includes(parsed.name) && trace.packets.length < 512)
        trace.packets.push({ ms: Date.now(), actor: bot.username, direction: 'serialized', name: parsed.name, data: copy(parsed.params), hex: buffer.toString('hex') })
    } catch (error) { trace.packets.push({ ms: Date.now(), actor: bot.username, error: String(error) }) } }
    serializer?.on?.('data', serialized); cleanup.push(() => serializer?.removeListener?.('data', serialized))
    const raw = (data: any, meta: any, bytes: Buffer) => {
      if (meta?.name !== 'explosion' && !(meta?.name === 'entity_velocity' && data.entityId === lives[index].id)) return
      const velocity = meta.name === 'entity_velocity' ? require('../../../daemon/src/drops').velocityFromRaw(bytes, 'velocity') : null
      if (trace.packets.length < 512) trace.packets.push({ ms: Date.now(), actor: bot.username, direction: 'received_raw', name: meta.name,
        entityId: data.entityId, velocity: point(velocity), hex: Buffer.from(bytes).subarray(0, 2048).toString('hex') })
    }
    bot._client.on('packet', raw); cleanup.push(() => bot._client.removeListener('packet', raw))
  }
  try {
    if (!legal()) trace.why = ctl.aborted ? 'cancelled' : 'target_not_current_or_visible'
    else {
      const toss = actions.throwPotion ?? (async () => {
        const item = a.inventory.items().find(item => item.name === 'splash_potion')
        if (!item) return { thrown: false, why: 'missing_potion' }
        const foe = target(a, t.username)
        return require('../../../daemon/src/throw').throwAt(a, () => foe.position.offset(0, .9, 0), {
          item, mode: 'exact', jump: false, sprint: false, onAim: () => legal() })
      })
      trace.toss = await run(toss); checkpoint('after_toss')
      trace.flightDelayTicks = Math.ceil(Number(trace.toss?.ticks) || 0) + 3
      await run(() => actions.waitTicks ? actions.waitTicks(a, trace.flightDelayTicks) : a.waitForTicks(trace.flightDelayTicks))
      if (!legal() || a.entity.onGround !== true) trace.why = ctl.aborted ? 'cancelled' : 'strike_target_changed_or_not_grounded'
      else {
        checkpoint('before_strike')
        trace.strike = await run(() => (actions.strike ?? require('../../../daemon/src/swarm/combos/ideas').strike)(a, target(a, t.username), { weapon: 'diamond_sword', ctl }))
      }
      actionEnd = Date.now()
      while (!closed && !stop() && Date.now() - (trace.deathAtMs ?? actionEnd) < 2000) await pause()
      trace.captureComplete = !closed && !stop() && Date.now() - (trace.deathAtMs ?? actionEnd) >= 2000
      // Releasing held death is itself observable: if natural removal has not happened, this request can be its first KILLED/blast.
      if (mode === 'held' && trace.deathAtMs !== null && !closed && !stop()) {
        filter.close(); trace.cleanupRespawnAtMs = Date.now(); checkpoint('before_cleanup_respawn')
        await run(() => Promise.resolve(actions.respawn ? actions.respawn(t) : t.respawn()))
        while (!closed && !stop() && (!trace.cleanupRespawnObservedAtMs || Date.now() - trace.cleanupRespawnObservedAtMs < 1000)) await pause()
        trace.cleanupRespawnCaptureComplete = !closed && !stop() && !!trace.cleanupRespawnObservedAtMs && Date.now() - trace.cleanupRespawnObservedAtMs >= 1000
      }
      for (const bot of bots) { bot.clearControlStates(); bot.deactivateItem() }
      const landing = actions.landing ?? require('./combo-shockwave-active').fullSpearLanding
      if (!closed && !stop()) trace.landing = await run(() => Promise.all([a, b].map(bot => ended.has(bot) || bot.entity !== lives[bots.indexOf(bot)] ?
        { reason: 'first_life_ended' } : landing(bot, () => closed || stop() || ended.has(bot), Math.max(0, 8000 - (Date.now() - t0))))))
    }
  } catch (error) { trace.error = String(error); if (!closed) trace.why = 'action_error' }
  finally {
    trace.physicalEndAtMs = Date.now(); closed = true; clearTimeout(timer)
    if (stop() && trace.why === 'complete') trace.why = 'cancelled'
    for (const bot of bots) { try { bot.clearControlStates(); bot.deactivateItem() } catch {} }
    if (pending) { trace.hardClosed = true; quitOwned(); await Promise.race([Promise.all(jobs), pause(500)]); trace.joined = pending === 0 }
    checkpoint('capture_end'); trace.nativeCheckpoints = await Promise.all(observers)
    for (const close of cleanup.reverse()) close()
    filter.close(); trace.respawnRequests = filter.requests; trace.respawnRestored = true; trace.endedAtMs = Date.now()
  }
  trace.outcome = classifyDeathBoost(trace)
  return trace
}

export async function windChargedTrials(pairs = 2, mode: 'auto' | 'held' = 'auto') {
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20 || !['auto', 'held'].includes(mode)) throw new Error('combo-wind-charged [pairs=2:1..20] [auto|held]')
  const { REPO_ROOT } = require('../../../daemon/src/paths'), { GameClock } = require('../../../daemon/src/game-clock')
  const { connect, clients, measure, target, stopped, sleep } = require('./combo-ideas')
  const { setup, give, hold, track, cmd, position } = require('./combo-air')
  const { settleFixtureTeleport, fixtureHealth } = require('./combo-ab'), { nativeHpAgreement } = require('./combo-anvil')
  if (stopped() || clients.length) throw new Error('wind-charged requires isolated own raw clients and no AUTO-STOP')
  const owned: any[] = [], rows: any[] = [], folder = path.join(REPO_ROOT, 'farm/results/ideas-28')
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `wind-charged-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`)
  fs.closeSync(fs.openSync(file, 'wx'))
  const before = await cmd('gamerule immediate_respawn'), priorRule = before.match(/\b(true|false)\b/i)?.[1]?.toLowerCase()
  if (!priorRule) throw new Error(`cannot preserve immediate_respawn: ${before}`)
  const probeFile = path.join(REPO_ROOT, 'farm/server-28/plugins/IdeasProbe/events.jsonl')
  const read = async (command: string) => { try { return await cmd(command) } catch (error) { return `OBSERVER_ERROR: ${String(error)}` } }
  const native = async (bot: any) => ({ actor: bot.username, id: bot.entity?.id, ms: Date.now(),
    pos: await read(`data get entity ${bot.username} Pos`), health: await read(`data get entity ${bot.username} Health`),
    fall: await read(`data get entity ${bot.username} fall_distance`), effects: await read(`data get entity ${bot.username} active_effects`),
    ignore: await read(`data get entity ${bot.username} ignore_fall_damage_from_current_explosion`),
    grace: await read(`data get entity ${bot.username} current_impulse_context_reset_grace_time`),
    impact: await read(`data get entity ${bot.username} current_explosion_impact_pos`) })
  try {
    await cmd('gamerule immediate_respawn false')
    for (const name of ['NeuroFarm28j', 'NeuroFarm28k', 'NeuroFarm28b0']) owned.push(await connect(name, new GameClock()))
    const [a, t, b] = owned, poses = [[600.5, 603.2], [600.5, 600.5], [603.5, 600.5]], roles = { attacker: a, target: t, receiver: b }
    for (let pair = 0; pair < pairs; pair++) for (const enabled of pair % 2 ? [true, false] : [false, true]) {
      if (stopped()) throw new Error('AUTO-STOP')
      const prep: any = {}, nativeStart: any[] = []
      try {
        await setup(owned, poses, 100)
        await cmd('fill 592 151 592 610 171 610 minecraft:air')
        for (const bot of owned) { await cmd(`team leave ${bot.username}`); await cmd(`clear ${bot.username}`) }
        a._ndSwarmAllies = [b.username]; b._ndSwarmAllies = [a.username]; t._ndSwarmAllies = []
        await give(a, 'diamond_sword 1')
        await give(a, `splash_potion[potion_contents={potion:"minecraft:${enabled ? 'wind_charged' : 'water'}"}] 1`)
        await hold(a, 'splash_potion')
        await fixtureHealth(t, 1) // Synthetic fixed 1 HP; never used by the action policy. The house helper restores max HP to 20.
        await b.waitForTicks(42); await settleFixtureTeleport(owned)
        await cmd(`random reset * ${590126 + pair}`)
        prep.rule = await cmd('gamerule immediate_respawn'); prep.teams = await cmd('team list')
        for (const bot of owned) nativeStart.push(await native(bot))
        for (const [index, bot] of owned.entries()) {
          const actual = nativeStart[index].pos.match(/\[([^\]]+)\]/)?.[1].split(',').map((v: string) => parseFloat(v))
          const want = [poses[index][0], 151, poses[index][1]], local = position(bot), hp = index === 1 ? 1 : 100
          const nativeHp = parseFloat(nativeStart[index].health.match(/:\s*(-?[\d.]+)f?\s*$/)?.[1] ?? '')
          if (!actual || actual.length !== 3 || actual.some((n: number, axis: number) => !Number.isFinite(n) || Math.abs(n - want[axis]) > .05) ||
            Math.hypot(local.x - want[0], local.y - want[1], local.z - want[2]) > .05 || !bot.entity.onGround || bot.health !== hp ||
            !Number.isFinite(nativeHp) || Math.abs(nativeHp - hp) > .01 || bot.game.gameMode !== 'survival')
            throw new Error(`unsettled wind-charged fixture ${bot.username}: ${nativeStart[index].pos}; HP client=${bot.health}, native=${nativeHp}, expected=${hp}`)
          if (index !== 1 && (!/:\s*0b\s*$/.test(nativeStart[index].ignore) || !/:\s*0\s*$/.test(nativeStart[index].grace) ||
            !/:\s*0(?:\.0)?d?\s*$/.test(nativeStart[index].fall) || !/Found no elements/i.test(nativeStart[index].impact)))
            throw new Error(`unclean prior impulse context ${bot.username}`)
        }
      } catch (error) {
        prep.clientStart = owned.map((bot, index) => ({ actor: bot.username, position: position(bot), onGround: bot.entity.onGround,
          mode: bot.game.gameMode, health: bot.health, expectedHp: index === 1 ? 1 : 100, nativeHealth: nativeStart[index]?.health ?? null }))
        const failure = { kind: 'prep_failure', pair, enabled, mode, prep, nativeStart, error: String(error) }
        fs.writeFileSync(file.replace(/\.jsonl$/, `-${pair}-${enabled ? 'on' : 'off'}.prep-failure.json`), JSON.stringify(failure, null, 2) + '\n')
        throw error
      }
      const start = owned.map(bot => ({ actor: bot.username, id: bot.entity.id, position: position(bot), mode: bot.game.gameMode,
        inventory: bot.inventory.items().map(item => ({ name: item.name, count: item.count, potion: require('../../../daemon/src/pvp/potions').potionOf(item) })) }))
      const offset = fs.existsSync(probeFile) ? fs.statSync(probeFile).size : 0
      const hp: (() => any)[] = owned.map(measure), closeTrace: (() => any)[] = owned.map(track)
      let phase: any, receipts: any[], traces: any[]
      try { phase = await windChargedPhase(roles, mode, stopped, { target, observe: async label => ({ label, ms: Date.now(), snapshots: await Promise.all(owned.map(native)) }) }) }
      finally { receipts = hp.map(close => close()); traces = closeTrace.map(close => close()) }
      // These serialized observer reads also drain queued fall/Pos tracking before another fixture reset.
      const nativeEnd = []; for (const bot of owned) nativeEnd.push(await native(bot))
      let probe: any[] = [], probeError: string | null = null
      try { const buffer = fs.readFileSync(probeFile); probe = buffer.subarray(offset <= buffer.length ? offset : 0).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) }
      catch (error) { probeError = String(error) }
      const row = { kind: 'K03_WindCharged_PLAYER_death_calibration', comparison: 'actual_splash_wind_charged_vs_water_one_ordinary_strike_not_combat_ROI',
        mode, pair, enabled, ownHp: 100, syntheticTargetHp: 1, prep, start, nativeStart, nativeEnd, phase, receipts, traces, probe, probeError,
        endInventory: owned.map(bot => ({ actor: bot.username, items: bot.inventory.items().map(item => ({ name: item.name, count: item.count, potion: require('../../../daemon/src/pvp/potions').potionOf(item) })) })),
        hpAgreement: Object.fromEntries(owned.map((bot, index) => [bot.username, nativeHpAgreement(nativeEnd[index].health, receipts[index])])) }
      rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n'); console.log(JSON.stringify({ file, ...row, traces: undefined, probe: undefined }))
      if (phase.hardClosed || !phase.joined || phase.error || !phase.captureComplete || mode === 'held' && phase.deathAtMs !== null && !phase.cleanupRespawnCaptureComplete || stopped())
        throw new Error(phase.error ?? phase.why)
    }
    return { file, rows }
  } finally {
    let restoreError: string | null = null
    try { await cmd(`gamerule immediate_respawn ${priorRule}`) } catch (error) { restoreError = String(error) }
    const summary = { file, mode, gameruleBefore: before, restoredTo: priorRule, restoreError,
      limitation: 'Separate auto/held cohorts; PLAYER explosion after actual KILLED removal, no assumed 20-tick timing, no WindCharge 1.22 or fall-immunity claim',
      arms: [false, true].map(enabled => { const arm = rows.filter(row => row.enabled === enabled); return { enabled, n: arm.length,
        thrown: arm.filter(row => row.phase.toss?.thrown).length, strikeAttempts: arm.filter(row => row.phase.strike?.sent).length,
        targetDeaths: arm.filter(row => row.phase.outcome.deathObserved).length, primedAtDeath: arm.filter(row => row.phase.outcome.primedAtDeath === true).length,
        blastsObserved: arm.filter(row => row.phase.outcome.blastObserved).length, receiverMotionObserved: arm.filter(row => row.phase.outcome.receiverMotionObserved).length,
        ownDamage: arm.reduce((n, row) => n + row.receipts[0].damage + row.receipts[2].damage, 0), ownDeaths: arm.reduce((n, row) => n + row.receipts[0].deaths + row.receipts[2].deaths, 0) } }) }
    fs.writeFileSync(file.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(summary, null, 2) + '\n'); console.log('SUMMARY', JSON.stringify(summary))
    for (const bot of clients) { try { bot.clearControlStates(); bot.deactivateItem(); bot.quit('wind-charged trial finished') } catch {} }
    await sleep(300)
  }
}

if (require.main === module) {
  const [pairs = '2', mode = 'auto', ...extra] = process.argv.slice(2)
  if (extra.length || !/^\d+$/.test(pairs) || +pairs < 1 || +pairs > 20 || !['auto', 'held'].includes(mode)) throw new Error('combo-wind-charged [pairs=2:1..20] [auto|held]')
  windChargedTrials(+pairs, mode as 'auto' | 'held').then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
