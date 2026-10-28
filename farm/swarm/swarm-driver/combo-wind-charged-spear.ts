import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const point = (p: any) => p ? { x: p.x, y: p.y, z: p.z } : null
const copy = (value: any) => value == null ? value : JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v))

/** Whole-combo calibration: charged death-boost vs useful ordinary sprint/jab, not a single-factor boost comparison. */
export async function windChargedSpearPhase(roles: any, enabled: boolean, stop: () => boolean, actions: any = {}): Promise<any> {
  const { attacker: a, target: t, receiver: b, enemy: e } = roles, bots = [a, t, b, e], lives = bots.map(bot => bot.entity)
  const target = actions.target ?? ((bot, name) => require('./combo-ideas').target(bot, name))
  const visible = actions.visible ?? ((bot, entity) => require('../../../daemon/src/pick').canHit(bot, entity, { range: 32 }))
  const t0 = Date.now(), ended = new Set<any>(), ticks = bots.map(() => 0), cleanup: (() => void)[] = [], remoteE = target(b, e.username)
  const trace: any = { t0, enabled, comparison: 'whole_combo_WindCharged_stand_charge_vs_water_ordinary_sprint_jab_not_single_factor_or_combat_ROI',
    actionWindowMs: 4000, actionPhysicsCap: 80, actions: [], frames: [], packets: [], contacts: [], rejectedContacts: [], lifeEvents: [],
    spear: null, charge: null, heldEndMs: null, error: null, why: 'complete', joined: true, hardClosed: false }
  let closed = false, running = true, stage = 'none', commonReady = false
  const current = (bot: any) => bot.entity === lives[bots.indexOf(bot)] && !ended.has(bot)
  const fixtureStopped = () => closed || stop() || !current(a) || !current(b) || !(a.health > 0) || !(b.health > 0)
  const endedWindow = () => Date.now() - t0 >= 4000 || ticks[2] >= 80
  const publicE = () => {
    const entity = target(b, e.username)
    return current(e) && entity === remoteE && entity?.id === lives[3].id && entity.isValid !== false && visible(b, entity) ? entity : null
  }
  const bStopped = () => closed || stop() || !current(b) || !(b.health > 0) || !current(e) || endedWindow()
  const ctl = { get aborted() { return bStopped() } }
  const clearB = () => { try { b.clearControlStates(); b.deactivateItem() } catch {} }
  const closeOwned = () => { trace.hardClosed = true; for (const bot of bots) { try { bot.quit('K03 spear stalled owned action') } catch {} } }
  for (const [index, bot] of bots.entries()) {
    const frame = () => {
      if (bot.entity !== lives[index] || ended.has(bot)) return
      ticks[index]++
      trace.frames.push({ ms: Date.now(), actor: bot.username, tick: ticks[index], position: point(bot.entity.position), velocity: point(bot.entity.velocity),
        onGround: bot.entity.onGround, yaw: bot.entity.yaw, pitch: bot.entity.pitch, held: bot.heldItem?.name, using: !!bot.usingHeldItem, use: copy(bot._ndUse?.cur) })
    }
    bot.on('physicsTick', frame); cleanup.push(() => bot.removeListener('physicsTick', frame))
    for (const event of ['death', 'end', 'respawn']) {
      const handler = () => { ended.add(bot); trace.lifeEvents.push({ ms: Date.now(), actor: bot.username, event, id: bot.entity?.id }) }
      bot.on(event, handler); cleanup.push(() => bot.removeListener(event, handler))
    }
    const serializer = bot._client.serializer
    const serialized = (bytes: Buffer) => { try {
      const buffer = Buffer.from(bytes), packet = serializer.proto.parsePacketBuffer('packet', buffer).data
      if (!['use_item', 'use_entity', 'block_dig', 'arm_animation', 'client_command'].includes(packet.name) || trace.packets.length >= 768) return
      const row = { ms: Date.now(), actor: bot.username, direction: 'serialized', stage: bot === b ? stage : null,
        name: packet.name, data: copy(packet.params), hex: buffer.toString('hex'), tick: ticks[index], using: !!bot.usingHeldItem }
      trace.packets.push(row)
      if (bot === b && packet.name === 'use_item' && packet.params.hand === 0 && b.heldItem?.name === 'iron_spear' && !trace.charge) trace.charge = row
    } catch (error) { if (trace.packets.length < 768) trace.packets.push({ actor: bot.username, error: String(error) }) } }
    const incoming = (data: any, meta: any, bytes: Buffer) => {
      if (trace.packets.length >= 768 || !['damage_event', 'explosion', 'entity_velocity'].includes(meta?.name)) return
      if (meta.name === 'entity_velocity' && data.entityId !== lives[index].id) return
      const velocity = meta.name === 'entity_velocity' ? (actions.velocityFromRaw ?? require('../../../daemon/src/drops').velocityFromRaw)(bytes, 'velocity') : null
      trace.packets.push({ ms: Date.now(), actor: bot.username, direction: 'received', stage, name: meta.name, data: copy(data), velocity: point(velocity),
        hex: Buffer.isBuffer(bytes) ? bytes.subarray(0, 2048).toString('hex') : null })
    }
    serializer?.on?.('data', serialized); bot._client.on('packet', incoming)
    cleanup.push(() => { serializer?.removeListener?.('data', serialized); bot._client.removeListener('packet', incoming) })
  }
  const contact = (packet: any) => {
    const own = b.entity === lives[2], targetLife = e.entity === lives[3] && !trace.lifeEvents.some(row => row.actor === e.username && row.event !== 'death')
    const type = (actions.damageTypeName ?? require('../../../daemon/src/gamedata').damageTypeName)(packet.sourceTypeId)
    const accepted = own && targetLife && packet.entityId === lives[3].id && packet.sourceCauseId === lives[2].id + 1 && packet.sourceDirectId === lives[2].id + 1 && type === 'spear'
    const row = { ms: Date.now(), stage, targetId: packet.entityId, packet: copy(packet), using: !!b.usingHeldItem, heldUse: copy(b._ndUse?.cur), actualUseObserved: !!trace.charge }
    if (accepted) trace.contacts.push(row)
    else if (trace.rejectedContacts.length < 32) trace.rejectedContacts.push({ ...row, why: !own || !targetLife ? 'old_life' : 'foreign_or_wrong_target_or_type' })
  }
  b._client.on('damage_event', contact); cleanup.push(() => b._client.removeListener('damage_event', contact))
  const ordinary = async () => {
    stage = 'ordinary_jab'; let processed = -1
    while (!bStopped()) {
      if (processed === ticks[2]) { await pause(); continue }; processed = ticks[2]
      const foe = publicE()
      if (!foe) { clearB(); await pause(); continue }
      const cancelled = () => bStopped() || publicE() !== foe
      await b.lookAt(foe.position.offset(0, .9, 0), true)
      if (cancelled()) continue
      const d = Math.hypot(foe.position.x - b.entity.position.x, foe.position.y - b.entity.position.y, foe.position.z - b.entity.position.z)
      const safe = actions.safeStep ?? ((bot, key) => require('../../../daemon/src/pvp/body').stepSafe(bot, require('../../../daemon/src/moves').keyDir(bot, key)))
      const forward = d > 3.4 && safe(b, 'forward'), back = d < 2.6 && safe(b, 'back')
      b.setControlState('forward', !!forward); b.setControlState('back', !!back); b.setControlState('sprint', !!forward && (b.food ?? 20) > 6); b.setControlState('jump', false)
      const ready = actions.readyIn ?? ((bot, name) => require('../../../daemon/src/spear').readyIn(bot, name))
      const reach = actions.jabReach ?? ((bot, entity) => require('../../../daemon/src/spear').jabReach(bot, entity))
      if (ready(b, 'iron_spear') === 0 && reach(b, foe).ok) {
        const result = await (actions.jab ?? require('../../../daemon/src/spear').jab)(b, foe, { abortIf: cancelled })
        trace.actions.push({ ms: Date.now(), kind: 'ordinary_jab_attempt', targetId: foe.id, tick: ticks[2], result })
      }
      await pause()
    }
  }
  const bJob = Promise.resolve().then(async () => {
    if (enabled && !bStopped()) {
      const foe = publicE(); stage = 'charged'
      if (foe) {
        trace.actions.push({ ms: Date.now(), kind: 'charge_start', targetId: foe.id })
        try { trace.spear = await (actions.chargedSpear ?? require('../../../daemon/src/swarm/combos/air-ideas').chargedSpear)(b, foe, { ctl, stand: true, maxTicks: 80 }) }
        finally { trace.heldEndMs = Date.now() }
      } else trace.spear = { started: false, why: 'E_not_current_visible' }
    } else trace.spear = { kind: 'ordinary_sprint_jab_control_no_held_use', started: false }
    if (!bStopped()) await ordinary()
  }).catch(error => { trace.error = String(error) }).finally(() => { running = false; stage = 'after_actions'; clearB(); trace.bActionsEndedAtMs = Date.now() })
  const hardTimer = setTimeout(() => { closed = true; if (running) closeOwned() }, 8000)
  try {
    trace.deathBoost = await (actions.phase ?? require('./combo-wind-charged').windChargedPhase)({ attacker: a, target: t, receiver: b }, 'auto', stop, {
      target, visible, observe: actions.observe, waitTicks: actions.waitTicks,
      throwPotion: async () => {
        while (!fixtureStopped() && !endedWindow() && ticks[2] < 20) await pause()
        commonReady = !fixtureStopped() && !endedWindow() && ticks[2] >= 20
        trace.tossGate = { ms: Date.now(), bTicks: ticks[2], ready: commonReady }
        if (!commonReady) return { thrown: false, why: 'common20tick_cancelled_or_timeout' }
        if (actions.throwPotion) return actions.throwPotion()
        const foe = target(a, t.username), item = a.inventory.items().find(item => item.name === 'splash_potion')
        if (!item || !foe || !visible(a, foe)) return { thrown: false, why: 'missing_potion_or_unseen_T' }
        return require('../../../daemon/src/throw').throwAt(a, () => foe.position.offset(0, .9, 0), {
          item, mode: 'exact', jump: false, sprint: false, onAim: () => !fixtureStopped() && current(t) && target(a, t.username) === foe && visible(a, foe) })
      },
      strike: async (bot, foe, p) => {
        const result = commonReady && !fixtureStopped() && !endedWindow() ? await (actions.strike ?? require('../../../daemon/src/swarm/combos/ideas').strike)(bot, foe, p) : { sent: false, why: 'action_window_or_life_ended' }
        // Join after the actual strike: the reused K03 phase must not deactivate B or begin its landing while B still acts.
        await bJob
        return result
      },
      landing: async (bot, halt, maxMs) => { await bJob; return (actions.landing ?? require('./combo-shockwave-active').fullSpearLanding)(bot, halt, maxMs) },
    })
  } catch (error) { trace.error = String(error) }
  finally {
    closed = true; clearB()
    await Promise.race([bJob, new Promise(resolve => setTimeout(resolve, 250))])
    if (running) { closeOwned(); await Promise.race([bJob, new Promise(resolve => setTimeout(resolve, 500))]) }
    trace.joined = !running && trace.deathBoost?.joined !== false; clearTimeout(hardTimer)
    // Landing can end just before its final health packet; preserve the first-life observer scope for three more ticks.
    if (!stop() && !trace.hardClosed) await Promise.race([Promise.all([a, b].filter(current).map(bot => bot.waitForTicks(3))), new Promise(resolve => setTimeout(resolve, 500))])
    for (const close of cleanup.reverse()) close()
    trace.ticks = ticks; trace.endedAtMs = Date.now(); trace.elapsedMs = trace.endedAtMs - t0
    trace.why = stop() ? 'cancelled' : trace.error ? 'action_error' : trace.deathBoost?.why ?? 'action_error'
  }
  return trace
}

/** Four raw clients, fixed HP100/static E; importing this file never connects or changes a rule. */
export async function windChargedSpearTrials(pairs = 2) {
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20) throw new Error('combo-wind-charged-spear [pairs=2:1..20]')
  const { REPO_ROOT } = require('../../../daemon/src/paths'), { GameClock } = require('../../../daemon/src/game-clock')
  const { connect, clients, measure, target, stopped, sleep } = require('./combo-ideas')
  const { setup, give, hold, cmd, position } = require('./combo-air')
  const { fixtureHealth, settleFixtureTeleport } = require('./combo-ab'), { nativeHpAgreement } = require('./combo-anvil')
  if (stopped() || clients.length) throw new Error('K03 spear requires isolated own raw clients and no AUTO-STOP')
  const owned: any[] = [], rows: any[] = [], folder = path.join(REPO_ROOT, 'farm/results/ideas-28')
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `wind-charged-spear-static-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`)
  fs.closeSync(fs.openSync(file, 'wx'))
  const before = await cmd('gamerule immediate_respawn'), priorRule = before.match(/\b(true|false)\b/i)?.[1]?.toLowerCase()
  if (!priorRule) throw new Error(`cannot preserve immediate_respawn: ${before}`)
  const read = async (command: string) => { try { return await cmd(command) } catch (error) { return `OBSERVER_ERROR: ${String(error)}` } }
  const native = async (bot: any) => ({ actor: bot.username, id: bot.entity?.id, ms: Date.now(),
    pos: await read(`data get entity ${bot.username} Pos`), health: await read(`data get entity ${bot.username} Health`),
    fall: await read(`data get entity ${bot.username} fall_distance`), effects: await read(`data get entity ${bot.username} active_effects`),
    ignore: await read(`data get entity ${bot.username} ignore_fall_damage_from_current_explosion`),
    grace: await read(`data get entity ${bot.username} current_impulse_context_reset_grace_time`), impact: await read(`data get entity ${bot.username} current_explosion_impact_pos`) })
  const inventory = (bot: any) => ({ actor: bot.username, items: bot.inventory.items().map(item => ({ name: item.name, count: item.count,
    durabilityUsed: item.durabilityUsed ?? null, potion: require('../../../daemon/src/pvp/potions').potionOf(item) })) })
  const probeFile = path.join(REPO_ROOT, 'farm/server-28/plugins/IdeasProbe/events.jsonl')
  try {
    await cmd('gamerule immediate_respawn false')
    for (const name of ['NeuroFarm28j', 'NeuroFarm28k', 'NeuroFarm28b0', 'NeuroFarm28l']) owned.push(await connect(name, new GameClock()))
    const [a, t, b, e] = owned, roles = { attacker: a, target: t, receiver: b, enemy: e }, poses = [[600.5, 603.2], [600.5, 600.5], [603.5, 600.5], [608.5, 600.5]]
    for (let pair = 0; pair < pairs; pair++) for (const enabled of pair % 2 ? [true, false] : [false, true]) {
      if (stopped()) throw new Error('AUTO-STOP')
      const prep: any = {}, nativeStart: any[] = []
      try {
        await setup(owned, poses, 100)
        await cmd('fill 592 151 592 620 171 610 minecraft:air')
        for (const bot of owned) { await cmd(`team leave ${bot.username}`); await cmd(`clear ${bot.username}`) }
        a._ndSwarmAllies = [b.username]; b._ndSwarmAllies = [a.username]; t._ndSwarmAllies = [e.username]; e._ndSwarmAllies = [t.username]
        await give(a, 'diamond_sword 1'); await give(a, `splash_potion[potion_contents={potion:"minecraft:${enabled ? 'wind_charged' : 'water'}"}] 1`)
        await give(b, 'iron_spear 1'); await hold(a, 'splash_potion'); await hold(b, 'iron_spear')
        await fixtureHealth(t, 1) // Explicit synthetic one-hit primary, identical arms; never an action-policy input.
        await b.waitForTicks(42); await settleFixtureTeleport(owned)
        await a.lookAt(target(a, t.username).position.offset(0, .9, 0), true)
        await b.lookAt(target(b, e.username).position.offset(0, .9, 0), true)
        await cmd(`random reset * ${640126 + pair}`)
        prep.rule = await cmd('gamerule immediate_respawn'); prep.teams = await cmd('team list')
        for (const bot of owned) nativeStart.push(await native(bot))
        for (const [index, bot] of owned.entries()) {
          const pose = nativeStart[index].pos.match(/\[([^\]]+)\]/)?.[1].split(',').map((v: string) => parseFloat(v)), want = [poses[index][0], 151, poses[index][1]]
          const local = position(bot), hp = index === 1 ? 1 : 100, nativeHp = parseFloat(nativeStart[index].health.match(/:\s*(-?[\d.]+)f?\s*$/)?.[1] ?? '')
          if (!pose || pose.length !== 3 || pose.some((n: number, axis: number) => !Number.isFinite(n) || Math.abs(n - want[axis]) > .05) ||
            Math.hypot(local.x - want[0], local.y - want[1], local.z - want[2]) > .05 || !bot.entity.onGround || bot.health !== hp ||
            !Number.isFinite(nativeHp) || Math.abs(nativeHp - hp) > .01 || bot.game.gameMode !== 'survival')
            throw new Error(`unsettled K03 spear fixture ${bot.username}: ${nativeStart[index].pos}; HP client=${bot.health},native=${nativeHp},expected=${hp}`)
          if (index !== 1 && (!/:\s*0b\s*$/.test(nativeStart[index].ignore) || !/:\s*0\s*$/.test(nativeStart[index].grace) ||
            !/:\s*0(?:\.0)?d?\s*$/.test(nativeStart[index].fall) || !/Found no elements/i.test(nativeStart[index].impact)))
            throw new Error(`unclean prior impulse context ${bot.username}`)
        }
      } catch (error) {
        prep.clientStart = owned.map((bot, index) => ({ actor: bot.username, position: position(bot), onGround: bot.entity.onGround, health: bot.health,
          expectedHp: index === 1 ? 1 : 100, nativeHealth: nativeStart[index]?.health ?? null }))
        fs.writeFileSync(file.replace(/\.jsonl$/, `-${pair}-${enabled ? 'on' : 'off'}.prep-failure.json`), JSON.stringify({ pair, enabled, prep, nativeStart, error: String(error) }, null, 2) + '\n')
        throw error
      }
      const startInventory = owned.map(inventory), start = owned.map(bot => ({ actor: bot.username, id: bot.entity.id, position: position(bot), mode: bot.game.gameMode }))
      const offset = fs.existsSync(probeFile) ? fs.statSync(probeFile).size : 0, measurements: (() => any)[] = owned.map(measure)
      let phase: any, receipts: any[]
      try { phase = await windChargedSpearPhase(roles, enabled, stopped, { target, observe: async label => ({ label, ms: Date.now(), snapshots: await Promise.all(owned.map(native)) }) }) }
      finally { receipts = measurements.map(close => close()) }
      // No interval observer jobs: K03 checkpoint jobs are joined, then these serialized reads drain the observation queue before reset.
      const nativeEnd = []; for (const bot of owned) nativeEnd.push(await native(bot))
      let probe: any[] = [], probeError: string | null = null
      try { const buffer = fs.readFileSync(probeFile); probe = buffer.subarray(offset <= buffer.length ? offset : 0).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) }
      catch (error) { probeError = String(error) }
      const endInventory = owned.map(inventory), consumption = [0, 2].map(index => {
        const initial = startInventory[index].items, final = endInventory[index].items, count = items => items.filter(item => item.name === 'splash_potion').reduce((n, item) => n + item.count, 0)
        const wear = items => items.filter(item => /sword|spear/.test(item.name)).reduce((n, item) => n + (item.durabilityUsed ?? 0), 0)
        return { actor: owned[index].username, splashPotions: Math.max(0, count(initial) - count(final)), weaponDurabilityIncrease: Math.max(0, wear(final) - wear(initial)) }
      }), row = { kind: 'K03_PLAYER_death_boost_iron_spear_static_E', pair, enabled, ownHp: 100, enemyHp: 100, syntheticPrimaryHp: 1,
        comparison: phase.comparison, limitation: 'Static second enemy at8m from primary can also receive PLAYER blast; fixed low-HP primary and auto respawn; whole-combo calibration, no general combat ROI or PLAYER fall-immunity claim',
        prep, start, startInventory, endInventory, nativeStart, nativeEnd, phase, receipts, probe, probeError,
        hpAgreement: Object.fromEntries(owned.map((bot, index) => [bot.username, nativeHpAgreement(nativeEnd[index].health, receipts[index])])),
        secondEnemy: { damage: receipts[3].damage, deaths: receipts[3].deaths, ttkMs: receipts[3].ttkMs },
        own: { damage: receipts[0].damage + receipts[2].damage, deaths: receipts[0].deaths + receipts[2].deaths }, consumption }
      rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n'); console.log(JSON.stringify({ file, ...row, probe: undefined }))
      if (!phase.joined || phase.hardClosed || phase.error || phase.deathBoost?.hardClosed || !phase.deathBoost?.captureComplete || stopped()) throw new Error(phase.error ?? phase.why)
    }
    return { file, rows }
  } finally {
    let restoreError: string | null = null
    try { await cmd(`gamerule immediate_respawn ${priorRule}`) } catch (error) { restoreError = String(error) }
    const summary = { file, gameruleBefore: before, restoredTo: priorRule, restoreError, fullCostScope: 'A+B through joined actions, capture and complete first-life landing tails; all assigned attempts retained',
      arms: [false, true].map(enabled => { const arm = rows.filter(row => row.enabled === enabled); return { enabled, n: arm.length,
        tosses: arm.filter(row => row.phase.deathBoost?.toss?.thrown).length, primaryDeaths: arm.filter(row => row.phase.deathBoost?.outcome?.deathObserved).length,
        primedAtDeath: arm.filter(row => row.phase.deathBoost?.primedAtDeath === true).length, contacts37: arm.reduce((n, row) => n + row.phase.contacts.length, 0),
        secondEnemyDamage: arm.reduce((n, row) => n + row.secondEnemy.damage, 0), secondEnemyKills: arm.reduce((n, row) => n + row.secondEnemy.deaths, 0),
        secondEnemyTtkMs: arm.filter(row => row.secondEnemy.ttkMs !== null).map(row => row.secondEnemy.ttkMs),
        ownDamage: arm.reduce((n, row) => n + row.own.damage, 0), ownDeaths: arm.reduce((n, row) => n + row.own.deaths, 0),
        ownFullLandings: arm.reduce((n, row) => n + (row.phase.deathBoost?.landing ?? []).filter(value => value.reason === 'landed').length, 0),
        splashPotionsConsumed: arm.reduce((n, row) => n + row.consumption.reduce((sum, value) => sum + value.splashPotions, 0), 0),
        ownWeaponDurabilityIncrease: arm.reduce((n, row) => n + row.consumption.reduce((sum, value) => sum + value.weaponDurabilityIncrease, 0), 0) } }) }
    fs.writeFileSync(file.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(summary, null, 2) + '\n'); console.log('SUMMARY', JSON.stringify(summary))
    for (const bot of owned) { try { bot.clearControlStates(); bot.deactivateItem(); bot.quit('K03 spear finished') } catch {} }
    await sleep(300)
  }
}

if (require.main === module) {
  const [pairs = '2', ...extra] = process.argv.slice(2)
  if (extra.length || !/^\d+$/.test(pairs) || +pairs < 1 || +pairs > 20) throw new Error('combo-wind-charged-spear [pairs=2:1..20]')
  windChargedSpearTrials(+pairs).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
