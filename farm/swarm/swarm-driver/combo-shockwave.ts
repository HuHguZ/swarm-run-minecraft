import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

const pause = () => new Promise(resolve => setTimeout(resolve, 10))
const point = (p: any) => ({ x: p.x, y: p.y, z: p.z })
const copy = (v: any) => JSON.parse(JSON.stringify(v, (_, value) => typeof value === 'bigint' ? String(value) : value))
// Candidate44 changes only E's X: the first observed wave step leaves about 3.9 m rather than 1.9 m to E.
const ENEMY_X = 608.5

/** One stand-only opportunity. T's first death closes B's action, never A's action toward E. */
export async function shockwavePhase(roles: any, enabled: boolean, stop: () => boolean, actions: any): Promise<any> {
  const { velocityFromRaw } = require('../../../daemon/src/drops')
  const { body: b, spear: a, primary: t, enemy: e } = roles, bots = [b, a, t, e]
  const t0 = Date.now(), deadline = t0 + 6000, originalAttack = b.attack, deaths: any[] = [], packets: any[] = [], attacks: any[] = [], spearViews: any[] = []
  const dead = new Set<any>(), ticks = bots.map(() => 0), cleanup: (() => void)[] = [], tasks: Promise<any>[] = []
  let closed = false, charge: any = null, spearDone = false, spearResult: any = null, dive: any = null, dropAtMs: number | null = null
  let why = 'complete', error: string | null = null, hardClosed = false
  const expired = () => Date.now() >= deadline
  const commonStop = () => closed || stop() || expired() || dead.has(a) || dead.has(b)
  const spearCtl = { get aborted() { return commonStop() || dead.has(e) } }
  const maceCtl = { get aborted() { return commonStop() || dead.has(t) } }
  const hardClose = () => { if (!hardClosed) { hardClosed = true; bots.forEach(bot => bot.quit('shockwave wall cap')) } }
  // End owned connections if a native tick wait stalls at the wall cap; its existing scope then cancels the wait.
  const timer = setTimeout(hardClose, 6000)
  const own = (bot: any) => ({ position: point(bot.entity.position), velocity: point(bot.entity.velocity),
    onGround: bot.entity.onGround, yaw: bot.entity.yaw, pitch: bot.entity.pitch,
    held: bot.heldItem?.name ?? null, age: String(bot.ndClock?.age ?? ''), tick: ticks[bots.indexOf(bot)] })
  for (const [index, bot] of bots.entries()) {
    const receiverId = bot.entity.id
    const step = () => { ticks[index]++; if (bot === a) spearViews.push({ ms: Date.now(), ...own(a) }) }, death = () => {
      if (!dead.has(bot)) deaths.push({ actor: bot.username, atMs: Date.now() - t0 })
      dead.add(bot)
    }
    const end = () => { dead.add(bot) }
    bot.on('physicsTick', step); bot.on('death', death); bot.on('end', end)
    const serializer = bot._client.serializer
    const serialized = (buffer: Buffer) => {
      try {
        const bytes = Buffer.from(buffer), parsed = serializer.proto.parsePacketBuffer('packet', bytes).data
        if (!['use_item', 'use_entity', 'block_dig'].includes(parsed.name)) return
        const row = { ms: Date.now(), actor: bot.username, direction: 'serialized', name: parsed.name,
          data: copy(parsed.params), hex: bytes.toString('hex'), own: own(bot) }
        packets.push(row)
        if (bot === a && !charge && parsed.name === 'use_item' && bot.heldItem?.name === 'iron_spear') charge = { ...row }
      } catch (error) { packets.push({ ms: Date.now(), actor: bot.username, direction: 'decode_error', error: String(error) }) }
    }
    const incoming = (data: any, meta: any, bytes: any) => {
      if (meta?.name !== 'damage_event' && !(meta?.name === 'entity_velocity' && data?.entityId === bot.entity?.id)) return
      packets.push({ ms: Date.now(), actor: bot.username, receiverId, direction: 'in', name: meta.name, data: copy(data),
        ...(meta.name === 'entity_velocity' ? { velocity: velocityFromRaw(bytes, 'velocity'), hex: Buffer.isBuffer(bytes) ? bytes.toString('hex') : null } : {}) })
    }
    serializer?.on?.('data', serialized); bot._client.on('packet', incoming)
    cleanup.push(() => {
      bot.removeListener('physicsTick', step); bot.removeListener('death', death); bot.removeListener('end', end)
      serializer?.removeListener?.('data', serialized); bot._client.removeListener('packet', incoming)
    })
  }
  const attack = function (this: any, ...args: any[]) {
    attacks.push({ ms: Date.now(), targetId: args[0]?.id, sham: !enabled, own: own(b) })
    if (enabled) return Reflect.apply(originalAttack, this, args)
  }
  b.attack = attack
  try {
    const target = actions.target
    const spearJob = Promise.resolve().then(() => actions.chargedSpear(a, target(a, e.username), { ctl: spearCtl, stand: true, maxTicks: 80 }))
      .then(result => { spearResult = result; return result }, failure => {
        error = String(failure); spearResult = { started: false, why: 'action_error', error }; return spearResult
      }).finally(() => { spearDone = true })
    tasks.push(spearJob)
    while (!commonStop() && !charge && !spearDone) await pause()
    if (!charge) why = commonStop() ? expired() ? 'wall_cap' : 'cancelled' : 'charge_not_started'
    else {
      // Count actual body physics after serialized use, rather than after the helper's equip/warmup call.
      while (!commonStop() && !spearDone && ticks[1] - charge.own.tick < 20) await pause()
      if (commonStop()) why = expired() ? 'wall_cap' : 'cancelled'
      else if (spearDone) why = 'charge_ended_before_drop'
      else {
        dropAtMs = Date.now() - t0
        await actions.removeFloor()
        while (!maceCtl.aborted && (b.entity.onGround || !(b.entity.velocity.y < 0))) await pause()
        if (!maceCtl.aborted) {
          const result = await actions.maceDive(b, target(b, t.username), { ctl: maceCtl, maxTicks: 80 })
          dive = { ...result, sent: enabled && result.sent === true, sham: !enabled,
            ...(enabled ? {} : { attempted: result.sent === true, why: 'sham_no_attack_packet' }) }
        }
      }
    }
    if (why === 'complete') {
      await spearJob
      while (!commonStop() && !dead.has(b) && !b.entity.onGround) await pause()
      if (expired()) why = 'wall_cap'
      else if (stop() || dead.has(a) || dead.has(b)) why = 'cancelled'
    }
  } catch (failure) { why = 'action_error'; error = String(failure) }
  finally {
    closed = true
    bots.forEach(bot => { bot.clearControlStates(); bot.deactivateItem() })
    if (expired()) hardClose()
    await Promise.allSettled(tasks)
    clearTimeout(timer)
    if (b.attack === attack) b.attack = originalAttack
    cleanup.forEach(close => close())
  }
  return { t0, elapsedMs: Date.now() - t0, why: error ? 'action_error' : why, error, charge, dropAtMs, spear: spearResult, dive, deaths, packets, attacks, ticks, spearViews,
    wallCapMs: 6000, chargeMeaning: 'serialized_use_then_20_own_physics_ticks_not_server_use_age',
    comparison: 'isolated_mace_shockwave_vs_suppressed_B_attack_not_full_role_ROI' }
}

export function shockwaveContacts(probe: any[], packets: any[], ids: any) {
  return {
    mace: probe.filter(row => row.event === 'mace_damage' && !row.cancelled && row.attackerId === ids.body &&
      row.targetId === ids.primary && row.damageTypeKey === 'minecraft:mace_smash').length,
    spear: packets.filter(row => row.name === 'damage_event' && row.receiverId === ids.enemy && row.data?.entityId === ids.enemy &&
      row.data?.sourceCauseId === ids.spear + 1 && row.data?.sourceDirectId === ids.spear + 1).length
  }
}

export async function nativeEndReceipt(actor: string, read: () => Promise<any>) {
  try { return await read() }
  catch (error) { return { ms: Date.now(), actor, pos: '', fall: '', health: '', error: String(error) } }
}

export async function shockwaveTrials(pairs = 1, activeMode?: 'ca' | 'useful' | 'duel', hp = 100) {
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20) throw new Error('combo-shockwave [pairs=1:1..20]; HP is fixed at 100')
  if ((!activeMode && hp !== 100) || activeMode && !['ca', 'useful', 'duel'].includes(activeMode) || ![20, 100].includes(hp)) throw new Error('shockwave active mode/hp')
  const { REPO_ROOT, DIST_ROOT } = require('../../../daemon/src/paths')
  const { GameClock } = require('../../../daemon/src/game-clock')
  const { connect, clients, measure, target, stopped, sleep } = require('./combo-ideas')
  const { setup, place, give, hold, track, cmd, position } = require('./combo-air')
  const { settleFixtureTeleport } = require('./combo-ab')
  const { fixtureBarrier, drainTelemetry, nativeHpAgreement } = require('./combo-anvil')
  const { chargedSpear, maceDive } = require(path.join(DIST_ROOT, 'daemon/src/swarm/combos/air-ideas'))
  if (stopped()) throw new Error('AUTO-STOP')
  const inherited = new Set(clients), rows: any[] = [], folder = path.join(REPO_ROOT, 'farm/results/ideas-28')
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `shockwave-${activeMode ? `active-${activeMode}-` : ''}${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`)
  fs.closeSync(fs.openSync(file, 'wx'))
  const probeFile = path.join(REPO_ROOT, 'farm/server-28/plugins/IdeasProbe/events.jsonl')
  const native = async (bot: any) => ({ ms: Date.now(), pos: await cmd(`data get entity ${bot.username} Pos`),
    fall: await cmd(`data get entity ${bot.username} fall_distance`), health: await cmd(`data get entity ${bot.username} Health`) })
  try {
    const b = await connect('NeuroFarm28b0', new GameClock()), a = await connect('NeuroFarm28j', new GameClock()),
      t = await connect('NeuroFarm28k', new GameClock()), e = await connect('NeuroFarm28l', new GameClock())
    const bots = [b, a, t, e], names = ['body', 'spear', 'primary', 'enemy'], roles = { body: b, spear: a, primary: t, enemy: e }
    for (let pair = 0; pair < pairs; pair++) for (const enabled of pair % 2 ? [true, false] : [false, true]) {
      if (stopped()) throw new Error('AUTO-STOP')
      const prep: any = {}, nativeStart: any[] = []
      try {
        // B starts on a separate staging cell, so its ground body cannot push T during health/kit preparation.
        await setup(bots, [[600.5, 597.5], [602.5, 600.5], [600.5, 600.5], [ENEMY_X, 600.5]], hp)
        await cmd('fill 592 151 589 608 151 605 minecraft:air replace minecraft:water')
        for (const bot of bots) { await cmd(`team leave ${bot.username}`); await cmd(`clear ${bot.username}`) }
        prep.teams = await cmd('team list')
        await cmd('setblock 600 162 600 minecraft:glass')
        const sample = async (withNative: boolean) => {
          const p = b.entity.position.clone(); p.set(600, 162, 600)
          const block = b.blockAt(p)
          return { client: position(b), native: withNative ? await cmd(`data get entity ${b.username} Pos`) : null,
            onGround: b.entity.onGround, support: block ? { name: block.name, boundingBox: block.boundingBox } : null }
        }
        prep.support = await fixtureBarrier(() => sample(false), null, stopped)
        await place(b, 600.5, 163, 600.5)
        prep.pose = await fixtureBarrier(() => sample(true), { x: 600.5, y: 163, z: 600.5 }, stopped)
        await give(b, 'mace'); await hold(b, 'mace'); await give(a, 'iron_spear'); await hold(a, 'iron_spear')
        b._ndSwarmAllies = [a.username]; a._ndSwarmAllies = [b.username]
        if (activeMode === 'duel') { t._ndSwarmAllies = [e.username]; e._ndSwarmAllies = [t.username] }
        await settleFixtureTeleport(bots)
        await b.waitForTicks(36)
        await cmd(`random reset * ${400126 + pair}`)
        if (activeMode) await e.look(-Math.PI / 2, 0, true)
        if (activeMode === 'duel') {
          await a.look(-Math.PI / 2, 0, true); await t.look(-Math.PI / 2, 0, true)
          await e.look(Math.PI / 2, 0, true); await b.look(0, -Math.PI / 2, true)
        }
        for (const bot of bots) nativeStart.push(await native(bot))
        for (let i = 0; i < bots.length; i++) {
          const expected = [[600.5, 163, 600.5], [602.5, 151, 600.5], [600.5, 151, 600.5], [ENEMY_X, 151, 600.5]][i]
          const xyz = nativeStart[i].pos.match(/\[([^\]]+)\]/)?.[1].split(',').map((v: string) => parseFloat(v))
          if (!xyz || xyz.length !== 3 || !xyz.every(Number.isFinite) || Math.hypot(...xyz.map((v: number, axis: number) => v - expected[axis])) > .05 || bots[i].health !== hp)
            throw new Error(`unsettled fixture ${bots[i].username}: ${nativeStart[i].pos}`)
        }
      } catch (error) {
        fs.writeFileSync(file.replace(/\.jsonl$/, `-${pair}-${enabled ? 'on' : 'off'}.prep-failure.json`),
          JSON.stringify({ pair, enabled, prep, nativeStart, error: String(error), fixture: (error as any).fixture ?? null }, null, 2) + '\n')
        throw error
      }
      const ids = Object.fromEntries(names.map((name, i) => [name, bots[i].entity.id]))
      const start = bots.map(bot => ({ actor: bot.username, position: position(bot), held: bot.heldItem?.name,
        ...(activeMode ? { yaw: bot.entity.yaw, pitch: bot.entity.pitch } : {}),
        items: bot.inventory.items().map((item: any) => ({ name: item.name, count: item.count })) }))
      const offset = fs.existsSync(probeFile) ? fs.statSync(probeFile).size : 0
      const finishHp: (() => any)[] = bots.map(bot => measure(bot)), finishTrace: (() => any)[] = bots.map(bot => track(bot))
      let phase: any, failure: string | null = null, tail: any, receipts: any[], traces: any[]
      try {
        const actions = { chargedSpear, maceDive, target, removeFloor: () => cmd('setblock 600 162 600 minecraft:air') }
        phase = activeMode === 'duel' ? await require('./combo-shockwave-duel').duelShockwavePhase(roles, enabled, stopped, actions)
          : activeMode ? await require('./combo-shockwave-active').activeShockwavePhase(roles, activeMode, enabled, stopped, actions) : await shockwavePhase(roles, enabled, stopped, actions)
        failure = phase.error
      }
      catch (error) { failure = String(error) }
      finally {
        bots.forEach(bot => { bot.clearControlStates(); bot.deactivateItem() })
        try { tail = await drainTelemetry(bots, stopped) }
        finally { receipts = finishHp.map(close => close()); traces = finishTrace.map(close => close()) }
      }
      const nativeEnd: any[] = []
      for (const bot of bots) nativeEnd.push(await nativeEndReceipt(bot.username, () => native(bot)))
      let probe: any[] = [], probeError: string | null = null
      try { const bytes = fs.readFileSync(probeFile); probe = bytes.subarray(offset <= bytes.length ? offset : 0).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) }
      catch (error) { probeError = String(error) }
      const row = { kind: activeMode ? `H40_active_${activeMode}` : 'H40_mace_shockwave_spear', candidate: activeMode === 'duel' ? 'E_X608.5_duel_E_priority52' : activeMode ? `E_X608.5_active_${activeMode}` : 'E_X608.5', pair, enabled, hp, actors: Object.fromEntries(names.map((name, i) => [name, bots[i].username])),
        ids, prep, start, nativeStart, nativeEnd, phase, failure, tail, probe, probeError,
        contacts: shockwaveContacts(probe, phase?.packets ?? [], ids), receipts: Object.fromEntries(names.map((name, i) => [name, receipts[i]])),
        hpAgreement: Object.fromEntries(names.map((name, i) => [name, nativeHpAgreement(nativeEnd[i].health, receipts[i])])),
        traces: Object.fromEntries(names.map((name, i) => [name, traces[i]])) }
      if (activeMode) Object.assign(row, { activeOutcome: require('./combo-shockwave-active').activeOutcome(row) })
      rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n')
      console.log(JSON.stringify({ file, ...row, traces: undefined, probe: undefined }))
      if (failure || phase.why === 'wall_cap' || stopped()) throw new Error(failure ?? phase.why)
    }
    return { file, rows }
  } finally {
    const summary = { file, ...(activeMode ? { mode: activeMode, hp } : {}), comparison: activeMode === 'duel' ? 'active_2v2_B_drop_both_A_E_priority_jab_vs_E_charge_then_E_priority_jab' : activeMode === 'ca' ? 'active_E_sham_B_vs_real_B' : activeMode === 'useful' ? 'both_real_B_A_run_charge_vs_A_wait_wave_not_best_ordinary_strategy' : 'isolated_shockwave_no_full_role_ROI', arms: [false, true].map(enabled => {
      const arm = rows.filter(row => row.enabled === enabled)
      return { enabled, n: arm.length, nativeMaceContacts: arm.reduce((n, r) => n + r.contacts.mace, 0), spearContacts: arm.reduce((n, r) => n + r.contacts.spear, 0),
        enemyDamage: arm.reduce((n, r) => n + r.receipts.enemy.damage, 0), primaryDamage: arm.reduce((n, r) => n + r.receipts.primary.damage, 0),
        enemyKills: arm.reduce((n, r) => n + r.receipts.enemy.deaths, 0), enemyTTKMs: arm.map(r => r.receipts.enemy.ttkMs),
        ownDamage: arm.reduce((n, r) => n + r.receipts.body.damage + r.receipts.spear.damage, 0),
        ownDeaths: arm.reduce((n, r) => n + r.receipts.body.deaths + r.receipts.spear.deaths, 0),
        ...(activeMode === 'duel' ? { primaryKills: arm.reduce((n, r) => n + r.receipts.primary.deaths, 0),
          wins: arm.filter(r => r.phase?.winner === 'allies').length, losses: arm.filter(r => r.phase?.winner === 'enemies').length,
          draws: arm.filter(r => r.phase?.winner === 'draw').length, errors: arm.filter(r => r.failure || r.phase?.error).length,
          postLandingWins: arm.filter(r => r.phase?.finalWinner === 'allies').length,
          postLandingLosses: arm.filter(r => r.phase?.finalWinner === 'enemies').length,
          postLandingDraws: arm.filter(r => r.phase?.finalWinner === 'draw').length,
          timeouts: arm.filter(r => ['physics_cap', 'wall_cap'].includes(r.phase?.endReason)).length,
          roundEndMs: arm.map(r => r.phase?.roundEndMs ?? null) } : {}),
        ...(activeMode ? { packetContactsWithinEWindow: arm.reduce((n, r) => n + r.activeOutcome.packetContactsWithinWindow, 0),
          packetContactsAfterEWindow: arm.reduce((n, r) => n + r.activeOutcome.packetContactsAfterWindow, 0),
          enemyKillsWithinEWindow: arm.filter(r => r.activeOutcome.killWithinWindow === true).length,
          enemyKillsAfterEWindow: arm.filter(r => r.activeOutcome.killAfterWindow === true).length,
          fullClientALandings: arm.filter(r => r.activeOutcome.clientFullLanding).length,
          nativeAFallDamage: arm.reduce((n, r) => n + r.activeOutcome.nativeAFallDamage, 0),
          nativeALateFallDamage: arm.reduce((n, r) => n + (r.activeOutcome.nativeALateFallDamage ?? 0), 0),
          unknownALateFallClassification: arm.filter(r => r.activeOutcome.nativeALateFallDamage === null).length } : {}) }
    }) }
    fs.writeFileSync(file.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(summary, null, 2) + '\n')
    console.log('SUMMARY', JSON.stringify(summary))
    for (const bot of clients.filter((bot: any) => !inherited.has(bot))) { bot.clearControlStates(); bot.deactivateItem(); bot.quit('shockwave trial complete') }
    await sleep(300)
  }
}

if (require.main === module) {
  const [pairs = '1', ...extra] = process.argv.slice(2)
  if (extra.length || !/^\d+$/.test(pairs)) throw new Error('combo-shockwave [pairs=1:1..20]; HP fixed 100')
  shockwaveTrials(Number(pairs)).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
