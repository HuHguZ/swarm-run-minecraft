import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
const point = (p: any) => p ? { x: p.x, y: p.y, z: p.z } : null
const copy = (v: any) => v == null ? v : JSON.parse(JSON.stringify(v, (_, item) => typeof item === 'bigint' ? String(item) : item))
export const CALIBRATION_POSES = {
  self: [[600.5, 603.5], [602.5, 603.5], [605.5, 605.5], [610.5, 600.5]],
  share: [[600.5, 603.5], [602.5, 603.5], [600.5, 601.5], [600.5, 599.5]],
}
export const FAR_SHARE_POSES = [[600.5, 603.5], [604.79, 603.5], [600.5, 601.5], [600.5, 599.5]]

/** Small session bridge for actual house RPC bodies on one owned raw client; no daemon or fake consume implementation. */
export function rawAntidoteSession(bot: any, stop: () => boolean): any {
  const session: any = { bot, mcData: bot.registry, current: null, eating: false, require: () => bot }
  session.runIntent = async (name: string, worker: any, options: any = {}) => {
    if (session.current) throw new Error(`owned raw intent already running: ${session.current.name}`)
    const life = bot.entity, onAbort: (() => void)[] = []; let cancelled = false
    const ctl: any = { onAbort, get aborted() { return cancelled || stop() || bot.entity !== life }, abort() {
      if (cancelled) return; cancelled = true; for (const fn of [...onAbort]) { try { fn() } catch {} }
    } }
    const ended = () => ctl.abort(), events = ['death', 'respawn', 'end', 'kicked']
    for (const event of events) bot.on(event, ended)
    const timer = setTimeout(ended, options.timeoutMs ?? 6500)
    session.current = { name, ctl }
    try { return await worker(ctl) }
    finally { clearTimeout(timer); for (const event of events) bot.removeListener(event, ended); session.current = null }
  }
  return session
}

/** Calibration only. Effect setup is outside this phase; choices read own public effect receipts and inventory. */
export async function antidoteCalibrationPhase(roles: any, kind: string, stop: () => boolean, actions: any = {}): Promise<any> {
  if (!['honey', 'milk', 'share', 'share-far'].includes(kind)) throw new Error('calibration kind honey|milk|share|share-far')
  const sharing = kind === 'share' || kind === 'share-far', far = kind === 'share-far'
  const { patient, donor, cover, enemy } = roles, bots = [patient, donor, cover, enemy], lives = bots.map(bot => bot.entity)
  const t0 = Date.now(), ended = new Set<any>(), cleanup: (() => void)[] = [], jobs: Promise<any>[] = []
  const trace: any = { kind, t0, consumed: false, joined: true, events: [], frames: [], packets: [], transfer: null, cover: null, receipt: null,
    error: null, why: 'complete', hardClosed: false }
  let closed = false, pending = 0, guard: any, capResolve: () => void
  const cap = new Promise<void>(resolve => { capResolve = resolve })
  const current = (bot: any) => bot.entity === lives[bots.indexOf(bot)] && !ended.has(bot)
  const halted = () => closed || stop() || bots.some(bot => !current(bot)) || !(patient.health > 0)
  const ctl = { get aborted() { return halted() } }
  const sessions = bots.map(bot => rawAntidoteSession(bot, halted))
  const target = actions.target ?? ((bot, name) => require('./combo-ideas').target(bot, name))
  const item = kind === 'milk' ? 'milk_bucket' : 'honey_bottle'
  const count = actions.count ?? (() => [...new Set<any>([...patient.inventory.items(), patient.inventory.slots?.[45]])]
    .reduce((n, value) => n + (value?.name === item ? value.count : 0), 0))
  const run = async (action: () => Promise<any>) => {
    pending++; const job = Promise.resolve().then(action).then(value => ({ value }), error => ({ error })).finally(() => { pending-- }); jobs.push(job)
    const result: any = await Promise.race([job, cap.then(() => ({ error: Error('antidote calibration wall cap') }))])
    if (result.error) throw result.error
    return result.value
  }
  const hardClose = () => { trace.hardClosed = true; for (const bot of bots) { try { bot.quit('owned antidote calibration cap') } catch {} } }
  const timer = setTimeout(() => { closed = true; trace.why = 'wall_cap'; if (pending) hardClose(); capResolve() }, 12000)
  for (const [index, bot] of bots.entries()) {
    for (const event of ['death', 'respawn', 'end', 'kicked']) {
      const handler = () => { ended.add(bot); trace.events.push({ ms: Date.now(), actor: bot.username, event }) }
      bot.on(event, handler); cleanup.push(() => bot.removeListener(event, handler))
    }
    const frame = () => { if (bot.entity === lives[index] && !ended.has(bot)) trace.frames.push({ ms: Date.now(), actor: bot.username,
      position: point(bot.entity.position), velocity: point(bot.entity.velocity), onGround: bot.entity.onGround, yaw: bot.entity.yaw, pitch: bot.entity.pitch,
      using: !!bot.usingHeldItem, held: bot.heldItem?.name, heldUse: copy(bot._ndUse?.cur) }) }
    bot.on('physicsTick', frame); cleanup.push(() => bot.removeListener('physicsTick', frame))
    for (const name of ['entity_effect', 'remove_entity_effect', 'damage_event', 'entity_status', 'sound_effect']) {
      const listener = data => { if (trace.packets.length < 1024) trace.packets.push({ ms: Date.now(), actor: bot.username, name, data: copy(data) }) }
      bot._client?.on(name, listener); cleanup.push(() => bot._client?.removeListener(name, listener))
    }
    const serializer = bot._client?.serializer
    const serialized = (bytes: Buffer) => { try {
      const buffer = Buffer.from(bytes), packet = serializer.proto.parsePacketBuffer('packet', buffer).data
      if (trace.packets.length < 1024 && ['use_item', 'use_entity', 'block_dig', 'arm_animation', 'window_click'].includes(packet.name))
        trace.packets.push({ ms: Date.now(), actor: bot.username, direction: 'serialized', name: packet.name, data: copy(packet.params), hex: buffer.toString('hex') })
    } catch {} }
    serializer?.on?.('data', serialized); cleanup.push(() => serializer?.removeListener?.('data', serialized))
  }
  try {
    if (sharing && !halted()) {
      guard = await run(() => actions.shield ? actions.shield() : (async () => {
        const foe = target(cover, enemy.username), g = require('../../../daemon/src/combat/shield').makeShield(sessions[2], ctl, { shield: 'always' })
        cleanup.push(() => g.close()) // Own the guard before its first await, including a stalled native raise.
        try {
          g.watch(foe); if (foe) await cover.lookAt(foe.position.offset(0, 1, 0), true)
          const worn = await g.wear(), confirmed = worn && !halted() && await g.raise(true)
          if (!halted()) await cover.waitForTicks(5)
          return { confirmed, close: () => g.close(), report: () => ({ ...g.stats, nativeUse: g.nativeUse(), trace: g.traceState(), blockingNow: g.blocking() }) }
        } catch (error) { g.close(); throw error }
      })())
      const before = count()
      let deliveryAllowed = true
      if (far && !halted()) {
        const visible = actions.visible ?? ((bot, entity) => require('../../../daemon/src/pick').canHit(bot, entity, { range: 32 }))
        const state = actions.state ?? require('../../../daemon/src/pvp/antidotes').ownAntidoteState
        const member = bot => { const own = state(bot); return { id: bot.username, team: 'own', health: bot.health, inventory: own.inventory, antidote: { state: own, receivedAt: Date.now() } } }
        const quote = ticks => require('../../../daemon/src/swarm/antidotes').antidoteTransferValue(member(donor), member(patient), item, Date.now(), ticks)
        let ally = target(donor, patient.username), seen = ally && visible(donor, ally)
        const range = seen ? Math.hypot(ally.position.x - donor.entity.position.x, ally.position.z - donor.entity.position.z) : null
        const deliveryTicks = seen ? 40 + Math.ceil(Math.max(0, range - 2.5) / require('../../../daemon/src/tempo').WALK_BPT) : null
        trace.delivery = { initialRange: range, deliveryTicks, initialQuote: seen ? quote(deliveryTicks) : null, why: seen ? 'initial_quote_nonpositive' : 'patient_not_public' }
        if (seen && trace.delivery.initialQuote > 0) {
          const Vec3 = require('../../../daemon/src/pvp/vec3').Vec3, dx = donor.entity.position.x - ally.position.x, dz = donor.entity.position.z - ally.position.z
          const spot = new Vec3(ally.position.x + dx / range * 2.5, ally.position.y, ally.position.z + dz / range * 2.5)
          trace.delivery.approach = await run(() => (actions.approach ?? require('../../../daemon/src/navigation/parkour').executeJump)(donor, ctl, spot, { allowWalk: true, maxFallDamage: 0, maxTicks: 40, maxFrames: 120 }))
          ally = !halted() ? target(donor, patient.username) : null; seen = ally && visible(donor, ally)
          const releaseRange = seen ? Math.hypot(ally.position.x - donor.entity.position.x, ally.position.z - donor.entity.position.z) : null
          Object.assign(trace.delivery, { releaseRange, publicLOS: !!seen, releaseQuote: !halted() && seen ? quote(40) : null })
          deliveryAllowed = !halted() && !!seen && releaseRange <= 3 && trace.delivery.releaseQuote > 0
          trace.delivery.why = deliveryAllowed ? 'ready_to_toss' : halted() ? 'approach_interrupted' : !seen ? 'patient_not_public_after_approach' : releaseRange > 3 ? 'still_out_of_range' : 'fresh_quote_nonpositive'
        } else deliveryAllowed = false
      }
      const tossed = !halted() && deliveryAllowed ? await run(() => actions.toss ? actions.toss() : require('../../../daemon/src/pvp/team-assist').tossTo(donor, target(donor, patient.username), item, 1, undefined, ctl)) : null
      const picked = !halted() && tossed?.ok ? far && count() > before ? { ok: true, why: 'actual_inventory_gain_during_delivery' }
        : await run(() => actions.pickup ? actions.pickup() : require('../../../daemon/src/pvp/team-assist').pickup(patient, item, 4, undefined, ctl)) : null
      trace.transfer = { before, after: count(), received: !halted() ? Math.max(0, count() - before) : 0, tossed, picked }
      if (!halted()) trace.enemyStrike = await run(() => actions.attackCover ? actions.attackCover() : require('../../../daemon/src/swarm/combos/ideas').strike(enemy, target(enemy, cover.username), { ctl }))
    }
    if (!halted() && (!sharing || trace.transfer.received > 0)) {
      trace.receipt = await run(() => actions.consume ? actions.consume() : require('../../../daemon/src/rpc/antidotes').antidoteMethods({ session: sessions[0] }).antidote({
        allies: [donor.username, cover.username], enemies: [enemy.username], ...(sharing ? { cover: cover.username } : {}),
      }))
      trace.consumed = trace.receipt?.consumed === true && current(patient)
    }
    if (!halted()) {
      const landing = actions.landing ?? require('./combo-shockwave-active').fullSpearLanding
      trace.landing = await run(() => Promise.all(bots.map(bot => landing(bot, halted, Math.max(0, 12000 - (Date.now() - t0))))))
      await run(() => actions.drain ? actions.drain() : Promise.race([Promise.all(bots.map(bot => bot.waitForTicks(3))), pause(500)]))
    }
  } catch (error) { trace.error = String(error); if (!closed) trace.why = 'action_error' }
  finally {
    closed = true; clearTimeout(timer)
    if (guard) { trace.cover = { confirmed: guard.confirmed, ...guard.report() }; guard.close() }
    for (const bot of bots) { try { bot.clearControlStates(); if (current(bot)) bot.deactivateItem() } catch {} }
    if (pending) { hardClose(); await Promise.race([Promise.all(jobs), pause(500)]); trace.joined = pending === 0 }
    for (const close of cleanup.reverse()) close()
    if (stop() && trace.why === 'complete') trace.why = 'cancelled'
    if (ended.size && trace.why === 'complete') trace.why = 'first_life_ended'
    trace.endedAtMs = Date.now(); trace.elapsedMs = trace.endedAtMs - t0
  }
  return trace
}

/** Native calibration first; scripted combat cohorts are a separate candidate and are not silently substituted here. */
export async function antidoteCalibrations(reps = 1, far = false) {
  if (!Number.isInteger(reps) || reps < 1 || reps > 20) throw new Error('combo-antidotes calibration [reps=1:1..20]')
  const { REPO_ROOT } = require('../../../daemon/src/paths'), { GameClock } = require('../../../daemon/src/game-clock')
  const { connect, clients, measure, stopped, sleep } = require('./combo-ideas'), { setup, give, hold, cmd, position } = require('./combo-air')
  const { settleFixtureTeleport } = require('./combo-ab'), { ownAntidoteState } = require('../../../daemon/src/pvp/antidotes')
  const { nativeHpAgreement } = require('./combo-anvil')
  if (stopped() || clients.length) throw new Error('antidote calibration requires isolated owned raw clients')
  const owned: any[] = [], rows: any[] = [], folder = path.join(REPO_ROOT, 'farm/results/ideas-28')
  const kinds = far ? ['share-far'] : ['honey', 'milk', 'share']
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `antidotes-calibration${far ? '-share-far' : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`)
  fs.closeSync(fs.openSync(file, 'wx'))
  const probeFile = path.join(REPO_ROOT, 'farm/server-28/plugins/IdeasProbe/events.jsonl')
  const read = async (command: string) => { try { return await cmd(command) } catch (error) { return `OBSERVER_ERROR: ${String(error)}` } }
  const native = async (bot: any) => ({ actor: bot.username, id: bot.entity?.id, ms: Date.now(), pos: await read(`data get entity ${bot.username} Pos`),
    health: await read(`data get entity ${bot.username} Health`), effects: await read(`data get entity ${bot.username} active_effects`),
    food: await read(`data get entity ${bot.username} foodLevel`), fall: await read(`data get entity ${bot.username} fall_distance`) })
  const inventory = bot => ({ actor: bot.username, items: bot.inventory.items().map(item => ({ name: item.name, count: item.count, slot: item.slot })),
    offhand: bot.inventory.slots?.[45] ? { name: bot.inventory.slots[45].name, count: bot.inventory.slots[45].count } : null })
  try {
    for (const name of ['NeuroFarm28j', 'NeuroFarm28k', 'NeuroFarm28b0', 'NeuroFarm28l']) {
      const bot = await connect(name, new GameClock()); owned.push(bot)
      ownAntidoteState(bot) // BEFORE setup's effects and before every synthetic or hostile effect receipt, on every actor.
    }
    const [patient, donor, cover, enemy] = owned, roles = { patient, donor, cover, enemy }
    for (let rep = 0; rep < reps; rep++) for (const kind of kinds) {
      if (stopped()) throw new Error('AUTO-STOP')
      const sharing = kind === 'share' || kind === 'share-far', poses = far ? FAR_SHARE_POSES : sharing ? CALIBRATION_POSES.share : CALIBRATION_POSES.self
      const prep: any = far ? { fixture: 'CALIBRATION_share_far_75', syntheticEffects: true, donorRange: 4.29 } : {}, nativeStart: any[] = []
      try {
        await setup(owned, poses, 20)
        for (const bot of owned) {
          if (stopped()) throw new Error('AUTO-STOP')
          await cmd(`team leave ${bot.username}`); await cmd(`clear ${bot.username}`)
          await cmd(`effect give ${bot.username} minecraft:saturation 1 20 true`)
          await bot.waitForTicks(2) // Saturation applies on server ticks; clearing immediately can leave the saved food level unchanged.
          await cmd(`effect clear ${bot.username} minecraft:saturation`)
          bot._ndSwarmAllies = owned.filter(other => other !== bot && (bot === enemy ? false : other !== enemy)).map(other => other.username)
        }
        for (const bot of [patient, donor]) { await give(bot, 'diamond_sword 1'); await hold(bot, 'diamond_sword') }
        await give(sharing ? donor : patient, kind === 'milk' ? 'milk_bucket 1' : 'honey_bottle 2')
        if (sharing) await cmd(`item replace entity ${cover.username} weapon.offhand with minecraft:shield`)
        await settleFixtureTeleport(owned); await patient.waitForTicks(3)
        await cmd(`random reset * ${650126 + rep}`)
        for (const bot of owned) nativeStart.push(await native(bot))
        for (const [index, bot] of owned.entries()) {
          const parsed = nativeStart[index].pos.match(/\[([^\]]+)\]/)?.[1].split(',').map((v: string) => parseFloat(v)), want = [poses[index][0], 151, poses[index][1]], local = position(bot)
          const nativeHp = parseFloat(nativeStart[index].health.match(/:\s*(-?[\d.]+)f?\s*$/)?.[1] ?? '')
          if (!parsed || parsed.length !== 3 || parsed.some((n: number, axis: number) => !Number.isFinite(n) || Math.abs(n - want[axis]) > .05) ||
            Math.hypot(local.x - want[0], local.y - want[1], local.z - want[2]) > .05 || !bot.entity.onGround || bot.health !== 20 || bot.food !== 20 ||
            nativeHp !== 20 || bot.game.gameMode !== 'survival') throw new Error(`unsettled antidote calibration ${bot.username}: ${nativeStart[index].pos}; HP${bot.health}/${nativeHp};food${bot.food}`)
        }
      } catch (error) {
        prep.clientStart = owned.map(bot => ({ actor: bot.username, pos: position(bot), health: bot.health, food: bot.food, onGround: bot.entity.onGround }))
        fs.writeFileSync(file.replace(/\.jsonl$/, `-${rep}-${kind}.prep-failure.json`), JSON.stringify({ rep, kind, prep, nativeStart, error: String(error) }, null, 2) + '\n')
        throw error
      }
      const startInventory = owned.map(inventory), measures: (() => any)[] = owned.map(measure), offset = fs.existsSync(probeFile) ? fs.statSync(probeFile).size : 0
      let phase: any, receipts: any[], before: any, nativeBefore: any[]
      try {
        // Synthetic effects are restricted to this calibration cohort; the combat cohort must deliver actual enemy items.
        for (const effect of kind === 'milk' ? ['wither 30 1', 'weakness 30 0', 'slowness 30 1', 'speed 30 0'] : ['poison 30 1', 'strength 30 0']) {
          if (stopped()) throw new Error('AUTO-STOP')
          await cmd(`effect give ${patient.username} minecraft:${effect} true`)
        }
        await patient.waitForTicks(2)
        before = ownAntidoteState(patient); nativeBefore = []; for (const bot of owned) nativeBefore.push(await native(bot))
        phase = await antidoteCalibrationPhase(roles, kind, stopped)
      } finally { receipts = measures.map(close => close()) }
      const after = ownAntidoteState(patient), nativeEnd = []; for (const bot of owned) nativeEnd.push(await native(bot))
      let probe: any[] = [], probeError: string | null = null
      try { const buffer = fs.readFileSync(probeFile); probe = buffer.subarray(offset <= buffer.length ? offset : 0).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) }
      catch (error) { probeError = String(error) }
      const row = { kind: 'antidote_calibration_real_client_use', case: kind, rep, prep, nativeStart, nativeBefore, nativeEnd, before, after, startInventory,
        endInventory: owned.map(inventory), phase, receipts, probe, probeError, hpAgreement: Object.fromEntries(owned.map((bot, index) => [bot.username, nativeHpAgreement(nativeEnd[index].health, receipts[index])])),
        limitation: 'Synthetic debuffs in calibration only; public shield pose is not proof of a blocked future hit; inventory transfer and native effect clearing are distinct receipts; no combat ROI claim' }
      rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n'); console.log(JSON.stringify({ file, ...row, probe: undefined }))
      if (!phase.joined || phase.hardClosed || phase.error || stopped()) throw new Error(phase.error ?? phase.why)
    }
    return { file, rows }
  } finally {
    const summary = { file, rows: rows.length, cases: kinds.map(kind => { const selected = rows.filter(row => row.case === kind); return {
      case: kind, n: selected.length, consumed: selected.filter(row => row.phase.consumed).length,
      transfers: selected.filter(row => row.phase.transfer?.received > 0).length, coverConfirmed: selected.filter(row => row.phase.cover?.confirmed).length,
      blockedSoundReceipts: selected.reduce((n, row) => n + (row.phase.cover?.blocked || 0), 0),
      patientDamage: selected.reduce((n, row) => n + row.receipts[0].damage, 0), ownDamage: selected.reduce((n, row) => n + row.receipts.slice(0, 3).reduce((sum, hp) => sum + hp.damage, 0), 0),
      ownDeaths: selected.reduce((n, row) => n + row.receipts.slice(0, 3).reduce((sum, hp) => sum + hp.deaths, 0), 0),
    } }) }
    fs.writeFileSync(file.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(summary, null, 2) + '\n'); console.log('SUMMARY', JSON.stringify(summary))
    for (const bot of owned) { try { bot.clearControlStates(); bot.deactivateItem(); bot.quit('antidote calibration finished') } catch {} }
    await sleep(300)
  }
}

if (require.main === module) {
  const [mode = 'calibration', requested, ...extra] = process.argv.slice(2), reps = requested ?? (mode === 'share-far' ? '2' : '1')
  if (!['calibration', 'share-far'].includes(mode) || extra.length || !/^\d+$/.test(reps) || +reps < 1 || +reps > 20) throw new Error('combo-antidotes calibration|share-far [reps=1|2:1..20]')
  antidoteCalibrations(+reps, mode === 'share-far').then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
