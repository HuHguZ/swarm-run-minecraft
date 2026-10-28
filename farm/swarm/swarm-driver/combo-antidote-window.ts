import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

type Condition = 'cold' | 'prepared_full_ge20'
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 10))
const copy = (value: any) => value == null ? null : JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v))
const point = (p: any) => p ? { x: p.x, y: p.y, z: p.z } : null

/** Fixed-window calibration of the existing full-charge policy, not maximum possible bow cadence. */
export async function antidoteWindowPhase(shooter: any, patient: any, condition: Condition, stop: () => boolean, actions: any = {}): Promise<any> {
  if (!['cold', 'prepared_full_ge20'].includes(condition)) throw new Error('cold|prepared_full_ge20')
  const bots = [shooter, patient], lives = bots.map(b => b.entity), ended = new Set<any>(), cleanup: (() => void)[] = [], observers: Promise<any>[] = []
  const trace: any = { condition, startedAtMs: Date.now(), window: null, tail: null, attempts: [], packets: [], arrows: [], health: [], frames: [], lifeEvents: [], observations: [],
    why: 'complete', error: null, hardClosed: false, joined: false, policy: 'house_default_full_charge_follow_false_32_client_physics_ticks' }
  let closed = false, ticks = 0, pending = false, lastRelease: any = null
  const phase = () => !trace.window ? 'preparation' : trace.window.endedAtMs === null ? 'window' : 'tail'
  const stamp = () => ({ ms: Date.now(), physicsCounter: ticks, clockNow: shooter.ndClock?.now?.() ?? null, worldAge: String(shooter.ndClock?.age ?? '') })
  const lifeHp = (bot: any) => ended.has(bot) || bot.entity !== lives[bots.indexOf(bot)] ? 0 : bot.health
  const interrupted = () => closed || stop() || ended.size > 0 || bots.some((b, i) => b.entity !== lives[i]) || !(shooter.health > 0)
  const target = actions.target ?? ((bot: any, name: string) => require('./combo-ideas').target(bot, name))
  const visible = actions.visible ?? ((bot: any, e: any) => require('../../../daemon/src/pick').canHit(bot, e, { range: 32 }))
  const publicTarget = () => { const e = target(shooter, patient.username); return e?.id === lives[1].id && e.isValid !== false && visible(shooter, e) ? e : null }
  const cutoff = () => trace.window?.endedAtMs != null
  const legal = () => !interrupted() && !cutoff() && !!publicTarget()
  // Releasing use fires a weak arrow. The house cancel path also switches the main-hand slot instead.
  const cancel = () => { if (shooter.entity === lives[0] && shooter.heldItem?.name === 'bow') shooter.setQuickBarSlot((shooter.quickBarSlot + 1) % 9) }
  const observe = (label: string) => { if (actions.observe) observers.push(Promise.resolve().then(() => actions.observe(label)).then(value => trace.observations.push({ label, value }), error => trace.observations.push({ label, error: String(error) }))) }
  const open = () => { if (!trace.window && !interrupted()) { trace.window = { ...stamp(), startedAtMs: Date.now(), endedAtMs: null, ticks: 0, hpStart: lifeHp(patient) }; observe('window_start') } }
  const close = (why: string) => {
    if (trace.window && trace.window.endedAtMs === null) { Object.assign(trace.window, { end: stamp(), endedAtMs: Date.now(), hpEnd: lifeHp(patient), ticks: ticks - trace.window.physicsCounter,
      observedHpLoss: trace.window.hpStart - lifeHp(patient), why }); observe('window_end') }
    cancel()
  }
  const activate = shooter.activateItem
  const guardedActivate = function (this: any, ...args: any[]) { if (legal()) return activate.apply(this, args) }
  shooter.activateItem = guardedActivate
  cleanup.push(() => { if (shooter.activateItem === guardedActivate) shooter.activateItem = activate })
  for (const [index, bot] of bots.entries()) {
    for (const event of ['death', 'respawn', 'end', 'kicked']) {
      const fn = () => { ended.add(bot); trace.lifeEvents.push({ ...stamp(), actor: bot.username, event }); close('first_life_ended') }
      bot.on(event, fn); cleanup.push(() => bot.removeListener(event, fn))
    }
    const step = () => {
      if (bot === shooter) { ticks++; if (trace.window && !cutoff() && ticks - trace.window.physicsCounter >= 32) close('physics_window_end') }
      if (bot.entity === lives[index] && !ended.has(bot)) trace.frames.push({ ...stamp(), actor: bot.username, phase: phase(), position: point(bot.entity.position), velocity: point(bot.entity.velocity),
        onGround: bot.entity.onGround, held: bot.heldItem?.name, using: !!bot.usingHeldItem })
    }
    bot.prependListener('physicsTick', step); cleanup.push(() => bot.removeListener('physicsTick', step))
    const hp = () => trace.health.push({ ...stamp(), actor: bot.username, phase: phase(), hp: lifeHp(bot) })
    bot.on('health', hp); cleanup.push(() => bot.removeListener('health', hp))
    for (const name of ['damage_event', 'entity_status']) {
      const fn = (data: any) => trace.packets.push({ ...stamp(), actor: bot.username, phase: phase(), name, data: copy(data) })
      bot._client.on(name, fn); cleanup.push(() => bot._client.removeListener(name, fn))
    }
    const spawn = (e: any) => { if (/arrow$/.test(e?.name ?? '')) trace.arrows.push({ ...stamp(), observer: bot.username, phase: phase(), id: e.id, name: e.name, position: point(e.position) }) }
    bot.on('entitySpawn', spawn); cleanup.push(() => bot.removeListener('entitySpawn', spawn))
    const arrowIds = new Set<number>(), rawSpawn = (data: any) => {
      if (data.type !== bot.registry?.entitiesByName?.arrow?.id || !Number.isInteger(data.entityId)) return
      arrowIds.add(data.entityId); trace.packets.push({ ...stamp(), actor: bot.username, phase: phase(), name: 'spawn_entity', data: copy(data) })
    }, metadata = (data: any) => { if (arrowIds.has(data.entityId)) trace.packets.push({ ...stamp(), actor: bot.username, phase: phase(), name: 'entity_metadata', data: copy(data) }) }
    bot._client.on('spawn_entity', rawSpawn); bot._client.on('entity_metadata', metadata)
    cleanup.push(() => { bot._client.removeListener('spawn_entity', rawSpawn); bot._client.removeListener('entity_metadata', metadata) })
    const serializer = bot._client.serializer, wire = (bytes: Buffer) => { try {
      const buffer = Buffer.from(bytes), p = serializer.proto.parsePacketBuffer('packet', buffer).data
      if (!['use_item', 'block_dig', 'held_item_slot'].includes(p.name)) return
      const row = { ...stamp(), actor: bot.username, direction: 'serialized', phase: phase(), name: p.name, data: copy(p.params), hex: buffer.toString('hex') }
      trace.packets.push(row)
      if (bot === shooter && p.name === 'block_dig' && p.params.status === 5) lastRelease = stamp()
    } catch {} }
    serializer?.on?.('data', wire); cleanup.push(() => serializer?.removeListener?.('data', wire))
  }
  const timer = setTimeout(() => { trace.why = 'wall_cap'; close('wall_cap'); closed = true; if (pending) { trace.hardClosed = true; bots.forEach(b => { try { b.quit('owned bow-window cap') } catch {} }) } }, 8000)
  try {
    if (condition === 'cold') open()
    let first = true
    while (legal()) {
      const foe = publicTarget(), began = stamp()
      pending = true
      let result: any
      try { result = await (actions.shoot ?? require('../../../daemon/src/bow').shoot)(shooter, foe, { mode: 'settle', follow: false, traceAim: true, shouldStop: () => !legal(),
        holdWhile: condition === 'prepared_full_ge20' && first ? () => { open(); return false } : null,
        onRelease: () => trace.packets.push({ ...stamp(), phase: phase(), name: 'api_onRelease_only_not_a_contact' }) }) }
      finally { pending = false }
      trace.attempts.push({ began, ended: stamp(), result: copy(result) }); first = false
      if (!result.shot) break
    }
    while (trace.window && !cutoff() && !interrupted()) await pause()
    close(interrupted() ? 'interrupted' : 'shot_refused')
    if (!trace.window) trace.why = interrupted() ? 'interrupted_before_ready' : 'prepared_shot_refused'
    const hpStart = trace.window?.hpEnd ?? lifeHp(patient)
    // follow:false owns short-lived hit/spawn listeners; let their existing <=3 game-second timers drain before reset.
    if (actions.drain) await actions.drain()
    else while (!interrupted() && (lastRelease && (Date.now() - lastRelease.ms < 3100 || ticks - lastRelease.physicsCounter < 62) || trace.window && ticks - trace.window.end.physicsCounter < 3)) await pause()
    trace.tail = { startedAtMs: trace.window?.endedAtMs ?? Date.now(), endedAtMs: Date.now(), hpStart, hpEnd: lifeHp(patient), observedHpLoss: hpStart - lifeHp(patient) }
    trace.landing = await Promise.all(bots.map((bot, index) => ended.has(bot) || bot.entity !== lives[index] ? { reason: 'first_life_ended' } :
      (actions.landing ?? require('./combo-shockwave-active').fullSpearLanding)(bot, () => stop() || closed || ended.has(bot) || bot.entity !== lives[index], 1000)))
  } catch (error) { trace.error = String(error); trace.why = 'error'; close('error') }
  finally {
    close('cleanup'); closed = true; clearTimeout(timer)
    for (const bot of bots) bot.clearControlStates()
    await Promise.allSettled(observers)
    for (const fn of cleanup.reverse()) fn()
    trace.joined = !pending; trace.endedAtMs = Date.now(); trace.end = stamp()
  }
  return trace
}

export async function antidoteWindowTrials(pairs = 2) {
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20) throw new Error('combo-antidote-window [pairs=2:1..20]')
  const { REPO_ROOT } = require('../../../daemon/src/paths'), { GameClock } = require('../../../daemon/src/game-clock')
  const { connect, clients, stopped, measure } = require('./combo-ideas'), { setup, cmd, give, hold, position } = require('./combo-air')
  const { settleFixtureTeleport } = require('./combo-ab'), { nativeHpAgreement } = require('./combo-anvil')
  if (stopped() || clients.length) throw new Error('isolated owned raw clients required')
  const bots: any[] = [], rows: any[] = [], folder = path.join(REPO_ROOT, 'farm/results/ideas-28'), poses = [[600.5, 608.5], [600.5, 600.5]]
  const armor = [['head', 'helmet', 5, 103], ['chest', 'chestplate', 6, 102], ['legs', 'leggings', 7, 101], ['feet', 'boots', 8, 100]] as const
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `antidote-bow-window-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`)
  fs.closeSync(fs.openSync(file, 'wx'))
  const probeFile = path.join(REPO_ROOT, 'farm/server-28/plugins/IdeasProbe/events.jsonl')
  const read = async (q: string) => { try { return await cmd(q) } catch (error) { return `OBSERVER_ERROR:${String(error)}` } }
  const native = async (bot: any) => ({ actor: bot.username, id: bot.entity?.id, ms: Date.now(), pos: await read(`data get entity ${bot.username} Pos`),
    health: await read(`data get entity ${bot.username} Health`), effects: await read(`data get entity ${bot.username} active_effects`), food: await read(`data get entity ${bot.username} foodLevel`), inventory: await read(`data get entity ${bot.username} Inventory`) })
  try {
    for (const name of ['NeuroFarm28j', 'NeuroFarm28b0']) bots.push(await connect(name, new GameClock()))
    const [shooter, patient] = bots
    for (let pair = 0; pair < pairs; pair++) for (const condition of (pair % 2 ? ['prepared_full_ge20', 'cold'] : ['cold', 'prepared_full_ge20']) as Condition[]) {
      if (stopped()) throw new Error('AUTO-STOP')
      const prep: any = { poses, distance: 8, hp: 20, bow: 'plain', arrow: 'plain', seed: 790126 + pair, policy: 'default_house_full_charge_ge20_confirmed', target: 'AFK_no_shield_plain_diamond4' }
      const nativeStart: any[] = []
      try {
        prep.cloudCleanup = await cmd('kill @e[type=minecraft:area_effect_cloud]'); prep.arrowCleanup = await cmd('kill @e[type=minecraft:arrow]')
        await setup(bots, poses, 20)
        for (const bot of bots) {
          if (stopped()) throw new Error('AUTO-STOP')
          await cmd(`team leave ${bot.username}`); await cmd(`clear ${bot.username}`)
          await cmd(`spawnpoint ${bot.username} 650 151 650`)
          await cmd(`effect give ${bot.username} minecraft:saturation 1 20 true`); await bot.waitForTicks(2); await cmd(`effect clear ${bot.username} minecraft:saturation`)
          bot._ndSwarmAllies = []
        }
        await give(shooter, 'bow 1'); await give(shooter, 'arrow 16'); await hold(shooter, 'bow')
        for (const [slot, item] of armor) await cmd(`item replace entity ${patient.username} armor.${slot} with minecraft:diamond_${item}`)
        await settleFixtureTeleport(bots); await shooter.waitForTicks(3); await cmd(`random reset * ${prep.seed}`)
        for (const bot of bots) nativeStart.push(await native(bot))
        for (const [i, bot] of bots.entries()) {
          const p = nativeStart[i].pos.match(/\[([^\]]+)\]/)?.[1].split(',').map(parseFloat), local = position(bot), wanted = [poses[i][0], 151, poses[i][1]]
          const hp = parseFloat(nativeStart[i].health.match(/:\s*(-?[\d.]+)f?\s*$/)?.[1] ?? ''), empty = /:\s*\[\s*\]\s*$/.test(nativeStart[i].effects) || nativeStart[i].effects === 'Found no elements matching active_effects'
          const food = parseFloat(nativeStart[i].food.match(/:\s*(\d+)\s*$/)?.[1] ?? '')
          if (!p || p.length !== 3 || p.some((n: number, axis: number) => !Number.isFinite(n) || Math.abs(n - wanted[axis]) > .05) || Math.hypot(local.x - wanted[0], local.y - wanted[1], local.z - wanted[2]) > .05 ||
            !bot.entity.onGround || bot.game.gameMode !== 'survival' || hp !== 20 || bot.health !== 20 || food !== 20 || bot.food !== 20 || !empty) throw Error(`unsettled bow window:${bot.username}:${JSON.stringify(nativeStart[i])}`)
        }
        const nativeArmor = nativeStart[1].inventory.match(/\{[^{}]*\}/g) ?? []
        if (!armor.every(([_slot, item, clientSlot, nativeSlot]) => patient.inventory.slots[clientSlot]?.name === `diamond_${item}` && nativeArmor.some((s: string) =>
          s.includes(`minecraft:diamond_${item}`) && new RegExp(`Slot:\\s*${nativeSlot}b`).test(s))) || /minecraft:enchantments/.test(nativeStart[1].inventory)) throw Error('patient plain diamond4 armor not established')
      } catch (error) { fs.writeFileSync(file.replace(/\.jsonl$/, `-${pair}-${condition}.prep-failure.json`), JSON.stringify({ pair, condition, prep, nativeStart, error: String(error) }, null, 2) + '\n'); throw error }
      const offset = fs.existsSync(probeFile) ? fs.statSync(probeFile).size : 0, measurements = bots.map(bot => measure(bot) as () => any)
      let phase: any, receipts: any[]
      try { phase = await antidoteWindowPhase(shooter, patient, condition, stopped, { observe: async (label: string) => ({ label, samples: await Promise.all(bots.map(native)) }) }) }
      finally { receipts = measurements.map(close => close()) }
      const nativeEnd = []; for (const bot of bots) nativeEnd.push(await native(bot))
      let probe: any[] = [], probeError: string | null = null
      try { const b = fs.readFileSync(probeFile); probe = b.subarray(offset <= b.length ? offset : 0).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) } catch (error) { probeError = String(error) }
      const row = { kind: 'H52_bow_window_calibration', pair, condition, prep, nativeStart, phase, receipts, nativeEnd, probe, probeError,
        hpAgreement: Object.fromEntries(bots.map((bot, i) => [bot.username, nativeHpAgreement(nativeEnd[i].health, receipts[i])])),
        limitation: '32 client physics ticks, not a native32tick promise; prepared>=20confirmed, not exact20useage; health/damage boundaries are observed receipt times; API onHit is not attributed proof; separate projectile tail; AFK calibration not antidote combat ROI' }
      rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n'); console.log(JSON.stringify({ file, pair, condition, why: phase.why, window: phase.window, hp: receipts[1].hp }))
    }
    const summary = { n: rows.length, conditions: ['cold', 'prepared_full_ge20'].map(condition => ({ condition, n: rows.filter(r => r.condition === condition).length,
      releasesInWindow: rows.filter(r => r.condition === condition).reduce((n, r) => n + r.phase.packets.filter(p => p.direction === 'serialized' && p.actor === bots[0].username && p.name === 'block_dig' && p.data.status === 5 && p.phase === 'window').length, 0) })) }
    fs.writeFileSync(file.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(summary, null, 2) + '\n'); console.log(JSON.stringify(summary)); return { file, summary }
  } finally { for (const bot of bots) { try { bot.clearControlStates(); bot.quit('owned bow-window complete') } catch {} } }
}

if (require.main === module) {
  const args = process.argv.slice(2), pairs = args.length ? Number(args[0]) : 2
  if (args.length > 1 || !Number.isInteger(pairs) || pairs < 1 || pairs > 20) { console.error('combo-antidote-window [pairs=2:1..20]'); process.exitCode = 1 }
  else antidoteWindowTrials(pairs).catch(error => { console.error(error); process.exitCode = 1 })
}
