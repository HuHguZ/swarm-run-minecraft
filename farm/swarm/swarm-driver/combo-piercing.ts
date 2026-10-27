import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const point = (p: any) => p ? { x: p.x, y: p.y, z: p.z } : null
const copy = (value: any) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v))

/** Fixed X/Z poses; all three actors have feet Y151. */
export function piercingPoses(enabled: boolean) {
  return [[600.5, 600.5], [603.3, 600.5], [enabled ? 604.5 : 603.7, enabled ? 600.5 : 602.9]]
}

/** One ordinary STAB, aimed only at T. E is selected by the native piercing ray, never by this phase. */
export async function piercingPhase(roles: any, stop: () => boolean, actions: any = {}): Promise<any> {
  const { spear: a, primary: t, secondary: e } = roles, bots = [a, t, e], lives = bots.map(bot => bot.entity)
  const t0 = Date.now(), ticks = bots.map(() => 0), ended = new Set<any>(), cleanup: (() => void)[] = []
  const frames: any[] = [], packets: any[] = [], damage: any[] = [], lifeEvents: any[] = []
  const target = actions.target ?? ((bot, name) => require('./combo-ideas').target(bot, name))
  const visible = actions.visible ?? ((bot, entity) => require('../../../daemon/src/pick').canHit(bot, entity, { range: 32 }))
  const readyIn = actions.readyIn ?? ((...args) => require('../../../daemon/src/spear').readyIn(...args))
  const jabReach = actions.jabReach ?? ((...args) => require('../../../daemon/src/spear').jabReach(...args))
  const teamSafe = actions.teamSafe ?? ((...args) => require('../../../daemon/src/spear').teamSafe(...args))
  const jab = actions.jab ?? ((...args) => require('../../../daemon/src/spear').jab(...args))
  let closed = false, pending = false, hardClosed = false, why = 'complete', error: string | null = null
  let result: any = null, ready: any = null, tail: any = null, aim: any = null
  const own = (bot: any) => ({ position: point(bot.entity?.position), velocity: point(bot.entity?.velocity),
    yaw: bot.entity?.yaw, pitch: bot.entity?.pitch, onGround: bot.entity?.onGround, held: bot.heldItem?.name ?? null,
    using: !!bot.usingHeldItem, useReceipt: bot._ndUse?.cur ? { name: bot._ndUse.cur.name, hand: bot._ndUse.cur.hand } : null, tick: ticks[bots.indexOf(bot)] })
  const scopeReason = () => {
    if (stop() || closed) return 'cancelled'
    if (Date.now() - t0 >= 3500) return 'phase_timeout'
    if (bots.some((bot, index) => ended.has(bot) || bot.entity !== lives[index])) return 'first_life_ended'
    if (a.heldItem?.name !== 'iron_spear' || a.usingHeldItem || a._ndUse?.cur) return 'held_changed_or_using'
    return null
  }
  for (const [index, bot] of bots.entries()) {
    const step = () => { if (!ended.has(bot) && bot.entity === lives[index]) { ticks[index]++; frames.push({ ms: Date.now(), actor: bot.username, ...own(bot) }) } }
    bot.on('physicsTick', step); cleanup.push(() => bot.removeListener('physicsTick', step))
    for (const event of ['death', 'respawn', 'end']) {
      const listener = () => { ended.add(bot); lifeEvents.push({ ms: Date.now(), actor: bot.username, event }) }
      bot.on(event, listener); cleanup.push(() => bot.removeListener(event, listener))
    }
    const received = (data: any) => {
      if (ended.has(bot) || bot.entity !== lives[index]) return
      damage.push({ ms: Date.now(), actor: bot.username, receiverId: lives[index].id, ...copy(data) })
    }
    bot._client.on('damage_event', received); cleanup.push(() => bot._client.removeListener('damage_event', received))
    const serializer = bot._client.serializer
    const serialized = (buffer: Buffer) => {
      try {
        const bytes = Buffer.from(buffer), parsed = serializer.proto.parsePacketBuffer('packet', bytes).data
        if (!['position', 'position_look', 'look', 'tick_end', 'use_item', 'use_entity', 'block_dig', 'arm_animation'].includes(parsed.name)) return
        packets.push({ ms: Date.now(), actor: bot.username, direction: 'serialized', name: parsed.name, data: copy(parsed.params), hex: bytes.toString('hex'), own: own(bot) })
      } catch (failure) { packets.push({ ms: Date.now(), actor: bot.username, direction: 'decode_error', error: String(failure) }) }
    }
    serializer?.on?.('data', serialized); cleanup.push(() => serializer?.removeListener?.('data', serialized))
  }
  // The existing jab has its own 400 ms timeout. This wall cap also closes a stalled owned connection before reset.
  const wallTimer = setTimeout(() => {
    closed = true; why = 'phase_timeout'
    if (pending) { hardClosed = true; for (const bot of bots) { try { bot.quit('piercing action wall cap') } catch {} } }
  }, 3500)
  try {
    const foe = target(a, t.username)
    const legal = () => !scopeReason() && foe && foe.id === lives[1].id && foe.isValid !== false && target(a, t.username) === foe && visible(a, foe)
    // Twenty own physics ticks after the equipped fixture, plus the existing equip/jab cooldown. No held-use marker.
    while (!scopeReason() && (ticks[0] < 20 || readyIn(a, 'iron_spear') > 0)) await pause()
    if (scopeReason()) why = scopeReason()!
    else if (!legal()) why = 'primary_not_visible_or_current'
    else {
      const reach = jabReach(a, foe)
      ready = { ms: Date.now(), ticks: [...ticks], readyIn: readyIn(a, 'iron_spear'), own: own(a) }
      aim = { ms: Date.now(), targetId: foe.id, target: point(foe.position), reach }
      if (!reach.ok || !teamSafe(a, reach.aim?.yaw, reach.aim?.pitch)) why = 'reach_or_team_unsafe'
      else {
        pending = true
        try { result = await jab(a, foe, { abortIf: () => !legal() || readyIn(a, 'iron_spear') > 0 || !teamSafe(a) }) }
        finally { pending = false }
        why = result?.ok ? 'complete' : scopeReason() ?? 'jab_refused'
      }
    }
  } catch (failure) { error = String(failure); why = 'action_error' }
  finally {
    try {
      // Keep first-life HP/damage observers alive for the native response, independently of whether STAB was accepted.
      const started = Date.now(), baseline = [...ticks]
      while (!scopeReason() && ticks.some((n, index) => n - baseline[index] < 3) && Date.now() - started < 500) await pause()
      tail = { ticks: ticks.map((n, index) => n - baseline[index]), elapsedMs: Date.now() - started,
        reason: scopeReason() ?? (ticks.every((n, index) => n - baseline[index] >= 3) ? 'drained' : 'timeout') }
    } finally {
      closed = true; clearTimeout(wallTimer)
      for (const bot of bots) { try { bot.clearControlStates(); bot.deactivateItem() } catch {} }
      cleanup.forEach(close => close())
    }
  }
  const stabPackets = packets.filter(row => row.actor === a.username && row.name === 'block_dig' && row.data.status === 7)
  return { t0, elapsedMs: Date.now() - t0, why, error, result, sent: stabPackets.length === 1,
    stabCount: stabPackets.length, ready, aim, ticks, tail, hardClosed, frames, packets, damage, lifeEvents,
    limitation: 'STAB sent is an attempt; native source37 and first-life HP determine per-target effects, with no assumed target order or damage split' }
}

export async function piercingTrials(pairs = 3) {
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20) throw new Error('combo-piercing [pairs=3:1..20]; HP fixed 100')
  const { REPO_ROOT } = require('../../../daemon/src/paths'), { GameClock } = require('../../../daemon/src/game-clock')
  const { connect, clients, measure, target, stopped, sleep } = require('./combo-ideas')
  const { setup, place, give, hold, track, cmd, position } = require('./combo-air')
  const { settleFixtureTeleport } = require('./combo-ab'), { nativeHpAgreement } = require('./combo-anvil')
  if (stopped()) throw new Error('AUTO-STOP')
  const inherited = new Set(clients), folder = path.join(REPO_ROOT, 'farm/results/ideas-28'), rows: any[] = []
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `piercing-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`)
  fs.closeSync(fs.openSync(file, 'wx'))
  const probeFile = path.join(REPO_ROOT, 'farm/server-28/plugins/IdeasProbe/events.jsonl')
  const native = async (bot: any) => ({ ms: Date.now(), pos: await cmd(`data get entity ${bot.username} Pos`),
    health: await cmd(`data get entity ${bot.username} Health`), fall: await cmd(`data get entity ${bot.username} fall_distance`) })
  try {
    const a = await connect('NeuroFarm28j', new GameClock()), t = await connect('NeuroFarm28k', new GameClock()), e = await connect('NeuroFarm28l', new GameClock())
    const bots = [a, t, e], names = ['spear', 'primary', 'secondary'], roles = { spear: a, primary: t, secondary: e }
    for (let pair = 0; pair < pairs; pair++) for (const enabled of pair % 2 ? [true, false] : [false, true]) {
      if (stopped()) throw new Error('AUTO-STOP')
      const poses = piercingPoses(enabled), prep: any = {}, nativeStart: any[] = []
      try {
        await setup(bots, poses, 100)
        for (const bot of bots) { await cmd(`team leave ${bot.username}`); await cmd(`clear ${bot.username}`) }
        prep.teams = await cmd('team list')
        await give(a, 'iron_spear'); await hold(a, 'iron_spear')
        for (const [index, bot] of bots.entries()) await place(bot, poses[index][0], 151, poses[index][1])
        await settleFixtureTeleport(bots) // No teleport after this boundary; both arms are stationary and unarmoured.
        await cmd(`random reset * ${540126 + pair}`)
        for (const bot of bots) nativeStart.push(await native(bot))
        for (const [index, bot] of bots.entries()) {
          const xyz = nativeStart[index].pos.match(/\[([^\]]+)\]/)?.[1].split(',').map((v: string) => parseFloat(v))
          const want = [poses[index][0], 151, poses[index][1]], client = position(bot)
          if (!xyz || xyz.length !== 3 || !xyz.every(Number.isFinite) || Math.hypot(...xyz.map((v: number, axis: number) => v - want[axis])) > .05 ||
            Math.hypot(client.x - want[0], client.y - want[1], client.z - want[2]) > .05 || !bot.entity.onGround || bot.health !== 100)
            throw new Error(`unsettled piercing fixture ${bot.username}: ${nativeStart[index].pos}`)
        }
      } catch (failure) {
        fs.writeFileSync(file.replace(/\.jsonl$/, `-${pair}-${enabled ? 'on' : 'off'}.prep-failure.json`), JSON.stringify({ pair, enabled, poses, prep, nativeStart, error: String(failure) }, null, 2) + '\n')
        throw failure
      }
      const ids = Object.fromEntries(names.map((name, index) => [name, bots[index].entity.id]))
      const start = bots.map(bot => ({ actor: bot.username, position: position(bot), held: bot.heldItem?.name ?? null,
        using: !!bot.usingHeldItem, items: bot.inventory.items().map(item => ({ name: item.name, count: item.count })) }))
      const offset = fs.existsSync(probeFile) ? fs.statSync(probeFile).size : 0
      const hp: (() => any)[] = bots.map(bot => measure(bot)), trace: (() => any)[] = bots.map(bot => track(bot))
      let phase: any, receipts: any[], traces: any[]
      try { phase = await piercingPhase(roles, stopped, { target }) }
      finally { receipts = hp.map(close => close()); traces = trace.map(close => close()) }
      // These serialized reads also drain the existing tracker's already queued fall/Pos telemetry before the next reset.
      const nativeEnd: any[] = []
      for (const bot of bots) {
        try { nativeEnd.push(await native(bot)) }
        catch (failure) { nativeEnd.push({ ms: Date.now(), pos: '', health: '', error: String(failure) }) }
      }
      let probe: any[] = [], probeError: string | null = null
      try { const bytes = fs.readFileSync(probeFile); probe = bytes.subarray(offset <= bytes.length ? offset : 0).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) }
      catch (failure) { probeError = String(failure) }
      const contacts = Object.fromEntries(['primary', 'secondary'].map(name => [name, probe.filter(row => row.event === 'mace_damage' && !row.cancelled &&
        row.attackerId === ids.spear && row.targetId === ids[name] && row.damageTypeKey === 'minecraft:spear').length]))
      const row = { kind: 'H42_ordinary_piercing_calibration', candidate: 'single_STAB_T_equal_range4m_E_aligned_vs_offray56', pair, enabled, hp: 100,
        actors: Object.fromEntries(names.map((name, index) => [name, bots[index].username])), ids, prep, start, nativeStart, phase, nativeEnd, probe, probeError, contacts,
        receipts: Object.fromEntries(names.map((name, index) => [name, receipts[index]])),
        hpAgreement: Object.fromEntries(names.map((name, index) => [name, nativeHpAgreement(nativeEnd[index].health, receipts[index])])),
        traces: Object.fromEntries(names.map((name, index) => [name, traces[index]])) }
      rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n'); console.log(JSON.stringify({ file, ...row, traces: undefined, probe: undefined }))
      if (phase.error || phase.hardClosed || phase.why === 'first_life_ended' || stopped()) throw new Error(phase.error ?? phase.why)
    }
    return { file, rows }
  } finally {
    const summary = { file, comparison: 'single_ordinary_STAB_equal_range4m_E_aligned_vs_offray56_unarmoured_HP100_not_combat_ROI', arms: [false, true].map(enabled => {
      const arm = rows.filter(row => row.enabled === enabled)
      return { enabled, n: arm.length, sent: arm.filter(row => row.phase.sent).length, refused: arm.filter(row => !row.phase.sent).length,
        errors: arm.filter(row => row.phase.error).length, primaryDamage: arm.reduce((n, row) => n + row.receipts.primary.damage, 0),
        secondaryDamage: arm.reduce((n, row) => n + row.receipts.secondary.damage, 0),
        bothDamaged: arm.filter(row => row.receipts.primary.damage > 0 && row.receipts.secondary.damage > 0).length,
        nativePrimaryContacts: arm.reduce((n, row) => n + row.contacts.primary, 0), nativeSecondaryContacts: arm.reduce((n, row) => n + row.contacts.secondary, 0) }
    }) }
    fs.writeFileSync(file.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(summary, null, 2) + '\n'); console.log('SUMMARY', JSON.stringify(summary))
    for (const bot of clients.filter(bot => !inherited.has(bot))) { try { bot.clearControlStates(); bot.deactivateItem(); bot.quit('piercing trial complete') } catch {} }
    await sleep(300)
  }
}

if (require.main === module) {
  const [pairs = '3', ...extra] = process.argv.slice(2)
  if (extra.length || !/^\d+$/.test(pairs) || +pairs < 1 || +pairs > 20) throw new Error('combo-piercing [pairs=3:1..20]; HP fixed 100')
  piercingTrials(+pairs).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
