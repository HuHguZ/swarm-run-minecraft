import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { rawAntidoteSession } from './combo-antidotes'

const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
const point = p => p ? { x: p.x, y: p.y, z: p.z } : null
const copy = v => v == null ? v : JSON.parse(JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x))

export function antidoteRoundPoses(size: number) {
  const lane = Array.from({ length: size }, (_, i) => 600.5 + (i - (size - 1) / 2) * 4)
  // Candidate69: house standing-potion aim reaches five meters here; six meters has no solution.
  return [...lane.map(x => [x, 606.5]), ...lane.map(x => [x, 600.5])]
}

/** Fixture only: clear old lingering toxins before reset and park respawns outside the combat floor. */
export async function prepareAntidoteParking(bots: any[], cmd: (command: string) => Promise<any>, stop: () => boolean) {
  const receipts: any[] = []
  for (const command of ['kill @e[type=minecraft:area_effect_cloud]', 'fill 648 150 648 652 150 652 minecraft:stone', 'fill 648 151 648 652 154 652 minecraft:air',
    ...bots.map(bot => `spawnpoint ${bot.username} 650 151 650`)]) {
    if (stop()) throw new Error('AUTO-STOP')
    receipts.push({ ms: Date.now(), command, reply: await cmd(command) })
  }
  return receipts
}

/** Keep the house downward heal, with one scoped guard at its actual release after equip/look awaits. */
export async function guardedRoundHeal(bot: any, ctl: any, heal: any = null) {
  const life = bot.entity, original = bot.activateItem
  let refused = false
  const activate = function (...args: any[]) {
    if (ctl.aborted || bot.entity !== life || !(bot.health > 0)) { refused = true; return }
    return original.apply(bot, args)
  }
  bot.activateItem = activate
  try {
    const result = await (heal ?? require('../../../daemon/src/pvp/team-assist').healAt)(bot, life.position)
    return refused ? { ...result, ok: false, why: 'cancelled_before_activate' } : result
  } finally { if (bot.activateItem === activate) bot.activateItem = original }
}

/** Scripted first-life melee cohort with actual house antidote decisions; not the production swarm brain. */
export async function antidoteRoundPhase(bots: any[], size: number, enabled: boolean, stop: () => boolean, actions: any = {}): Promise<any> {
  if (!Number.isInteger(size) || size < 3 || size > 5 || bots.length !== 2 * size) throw new Error('antidote rounds size3..5 and exactly two teams')
  const t0 = Date.now(), lives = bots.map(b => b.entity), ticks = bots.map(() => 0), dead = new Set<any>(), deaths = new Set<any>(), busy = new Set<any>()
  const cleanup: (() => void)[] = [], jobs: Promise<any>[] = [], assigned = new Map<string, any>(), trace: any = {
    t0, enabled, comparison: 'antidote_kit_and_house_policy_vs_no_antidote_ordinary_melee', actions: [], consumes: [], transfers: [], covers: [], frames: [], packets: [], lifeEvents: [], assignments: [], taskDiagnostics: [], planDiagnostics: [], error: null,
    censored: false, joined: true, hardClosed: false, winner: null, roundEndMs: null, endReason: '', limitation: 'scripted nearest-visible melee plus real house antidote planner/RPC; not production swarm-vs-swarm',
  }
  let closed = false, pending = 0, planTick = -5
  const memberReports = new Map<string, any>()
  const visible = actions.visible ?? ((bot, target) => require('../../../daemon/src/pick').canHit(bot, target, { range: 32 }))
  const alive = (bot: any) => !dead.has(bot) && bot.entity === lives[bots.indexOf(bot)]
  const ended = (bot: any, event: string) => {
    if (event === 'death') deaths.add(bot)
    else if (!deaths.has(bot) && !trace.hardClosed) { trace.censored = true; trace.error ||= `unexpected_lifecycle:${bot.username}:${event}` }
    dead.add(bot); trace.lifeEvents.push({ ms: Date.now(), actor: bot.username, event })
    try { bot.clearControlStates(); bot.deactivateItem() } catch {}
  }
  const winner = () => {
    const own = bots.slice(0, size).some(b => !deaths.has(b)), enemy = bots.slice(size).some(b => !deaths.has(b))
    return !own && !enemy ? 'draw' : !enemy ? 'own' : !own ? 'enemy' : null
  }
  const halted = () => {
    for (const bot of bots) if (!dead.has(bot) && bot.entity !== lives[bots.indexOf(bot)]) ended(bot, 'entity_identity')
    return closed || stop() || !!trace.error || !!winner() || Date.now() - t0 >= 12000 || Math.max(...ticks) >= 240
  }
  const sessions = bots.map(bot => rawAntidoteSession(bot, () => halted() || !alive(bot)))
  const publicTarget = (bot: any, actor: any) => {
    if (!actor || !alive(actor)) return null
    const e = Object.values<any>(bot.entities || {}).find(e => e.username === actor.username && e.id === lives[bots.indexOf(actor)].id)
    return e && e.isValid !== false && visible(bot, e) ? e : null
  }
  const nearest = (bot: any) => bots.filter(other => (bots.indexOf(other) < size) !== (bots.indexOf(bot) < size)).map(actor => ({ actor, entity: publicTarget(bot, actor) }))
    .filter(x => x.entity).sort((a, b) => Math.hypot(a.entity.position.x - bot.entity.position.x, a.entity.position.z - bot.entity.position.z) -
      Math.hypot(b.entity.position.x - bot.entity.position.x, b.entity.position.z - bot.entity.position.z))[0]
  const inventory = bot => [...new Set<any>([...bot.inventory.items(), bot.inventory.slots?.[45]])].filter(Boolean)
    .reduce((out, item) => { out[item.name] = (out[item.name] || 0) + item.count; return out }, {} as Record<string, number>)
  const member = (bot: any) => {
    const foe = nearest(bot), report = actions.report ? actions.report(bot) : require('../../../daemon/src/pvp/antidotes').antidoteReport(bot, {
      damagePerTick: foe ? require('../../../daemon/src/pvp/damage-model').afterDefense(require('../../../daemon/src/pvp/damage-model').attackDamage('iron_sword'), 'melee',
        require('../../../daemon/src/pvp/damage-model').defenseOf(foe.entity.equipment || [])) / require('../../../daemon/src/pvp/damage-model').ticksToCharge('iron_sword') *
        Math.max(0, 40 - Math.max(0, Math.hypot(foe.entity.position.x - bot.entity.position.x, foe.entity.position.z - bot.entity.position.z) - 3) / require('../../../daemon/src/tempo').WALK_BPT) / 40 : 0,
    })
    const reportMember = { id: bot.username, team: 'own', position: point(bot.entity.position), health: bot.health, inventory: inventory(bot),
      offHand: bot.inventory.slots?.[45]?.name ?? null, reserve: {}, needs: {}, antidote: { ...report, receivedAt: Date.now() } }
    memberReports.set(bot.username, reportMember)
    return reportMember
  }
  const updatePlan = () => {
    let plan: Map<string, any>
    if (actions.plan) plan = actions.plan()
    else {
      const team = bots.slice(0, size).filter(alive).map(member), enemies = new Map<string, any>(), now = Date.now()
      for (const observer of bots.slice(0, size).filter(alive)) for (const actor of bots.slice(size)) {
        const e = publicTarget(observer, actor); if (e) enemies.set(actor.username, { id: actor.username, position: point(e.position), seenAt: now })
      }
      plan = new Map(); for (const bot of busy) plan.set(bot.username, { kind: 'busy' })
      require('../../../daemon/src/swarm/antidotes').pvpAntidotes({ team, enemies: [...enemies.values()], board: { now: () => now }, plan,
        put: (m, kind, data, position) => plan.set(m.id, { kind, data, position }) })
      if (trace.planDiagnostics.length < 64) trace.planDiagnostics.push({ ms: now, team: copy(team), plan: copy([...plan]),
        rawStock: team.reduce((stock, m) => { for (const item of ['honey_bottle', 'milk_bucket']) stock[item] = (stock[item] || 0) + (m.inventory[item] || 0); return stock }, {}) })
    }
    for (const [name, task] of plan) if (task.kind !== 'busy' && !assigned.has(name) && !busy.has(bots.find(b => b.username === name))) {
      assigned.set(name, task); trace.assignments.push({ ms: Date.now(), actor: name, task: copy(task) })
    }
  }
  for (const [index, bot] of bots.entries()) {
    for (const event of ['death', 'respawn', 'end', 'kicked']) { const fn = () => ended(bot, event); bot.on(event, fn); cleanup.push(() => bot.removeListener(event, fn)) }
    const frame = () => { if (alive(bot)) { ticks[index]++; trace.frames.push({ ms: Date.now(), actor: bot.username, position: point(bot.entity.position), velocity: point(bot.entity.velocity),
      onGround: bot.entity.onGround, health: bot.health, held: bot.heldItem?.name, using: !!bot.usingHeldItem, yaw: bot.entity.yaw, pitch: bot.entity.pitch }) } }
    bot.on('physicsTick', frame); cleanup.push(() => bot.removeListener('physicsTick', frame))
    for (const name of ['damage_event', 'entity_effect', 'remove_entity_effect', 'entity_status']) {
      const fn = data => { if (trace.packets.length < 4096) trace.packets.push({ ms: Date.now(), actor: bot.username, name, data: copy(data) }) }
      bot._client.on(name, fn); cleanup.push(() => bot._client.removeListener(name, fn))
    }
    const serializer = bot._client.serializer, fn = (bytes: Buffer) => { try {
      const buffer = Buffer.from(bytes), p = serializer.proto.parsePacketBuffer('packet', buffer).data
      if (trace.packets.length < 4096 && ['use_item', 'use_entity', 'block_dig', 'arm_animation'].includes(p.name)) trace.packets.push({ ms: Date.now(), actor: bot.username, direction: 'serialized', name: p.name, data: copy(p.params), hex: buffer.toString('hex') })
    } catch {} }
    serializer?.on?.('data', fn); cleanup.push(() => serializer?.removeListener?.('data', fn))
  }
  const taskFor = async (bot: any, task: any) => {
    const ctl = { get aborted() { return halted() || !alive(bot) } }
    const note = (why: string, facts: any = {}) => { trace.taskDiagnostics.push({ ms: Date.now(), actor: bot.username, kind: task.kind, why, ...facts }) }
    if (task.kind === 'transfer') {
      const recipient = bots.find(b => b.username === task.to)
      const deliveryCtl = { get aborted() { return ctl.aborted || !recipient || !alive(recipient) || !(bot.health > 0) || !(recipient.health > 0) } }
      let entity = publicTarget(bot, recipient)
      if (!entity || ctl.aborted) return note(ctl.aborted ? 'transfer_aborted' : 'transfer_recipient_not_public', { recipient: task.to, publicLOS: !!entity })
      let range = Math.hypot(entity.position.x - bot.entity.position.x, entity.position.z - bot.entity.position.z)
      if (range > 3) {
        const dx = bot.entity.position.x - entity.position.x, dz = bot.entity.position.z - entity.position.z, Vec3 = require('../../../daemon/src/pvp/vec3').Vec3
        const spot = new Vec3(entity.position.x + dx / range * 2.5, entity.position.y, entity.position.z + dz / range * 2.5)
        const moved = await (actions.approach ?? require('../../../daemon/src/navigation/parkour').executeJump)(bot, deliveryCtl, spot, { allowWalk: true, maxFallDamage: 0, maxTicks: 40, maxFrames: 120 })
        note('transfer_approach_result', { recipient: task.to, range, spot: point(spot), moved })
        entity = publicTarget(bot, recipient)
      }
      range = entity ? Math.hypot(entity.position.x - bot.entity.position.x, entity.position.z - bot.entity.position.z) : Infinity
      const quote = !deliveryCtl.aborted && entity ? require('../../../daemon/src/swarm/antidotes').antidoteTransferValue(member(bot), member(recipient), task.item, Date.now(), 40) : null
      if (deliveryCtl.aborted || !entity || range > 3 || !(quote > 0)) return note(deliveryCtl.aborted ? 'transfer_aborted_before_toss' : !entity ? 'transfer_recipient_not_public_after_approach' : range > 3 ? 'transfer_not_in_range' : 'transfer_fresh_quote_nonpositive', { recipient: task.to, range, quote })
      note('transfer_ready_to_toss', { recipient: task.to, range, publicLOS: true, quote, deliveryTicks: 40 })
      const result = await (actions.toss ?? require('../../../daemon/src/pvp/team-assist').tossTo)(bot, entity, task.item, 1, undefined, deliveryCtl)
      trace.transfers.push({ ms: Date.now(), stage: 'toss', from: bot.username, to: task.to, item: task.item, result }); return note('transfer_result', { recipient: task.to, item: task.item, result })
    }
    if (task.kind === 'goto' && task.data?.antidoteCover) {
      const patient = bots.find(b => b.username === task.data.antidoteCover), foeActor = bots.find(b => b.username === task.data.target)
      if (!patient || !alive(patient)) return note('cover_patient_unavailable', { patient: task.data.antidoteCover, present: !!patient })
      const Vec3 = require('../../../daemon/src/pvp/vec3').Vec3, spot = new Vec3(task.position.x, task.position.y, task.position.z)
      const move = await require('../../../daemon/src/navigation/parkour').executeJump(bot, ctl, spot, { allowWalk: true, maxFallDamage: 0, maxTicks: 40, maxFrames: 120 })
      const guard = require('../../../daemon/src/combat/shield').makeShield(sessions[bots.indexOf(bot)], ctl, { shield: 'always' })
      try {
        const foe = publicTarget(bot, foeActor); guard.watch(foe)
        if (foe) await bot.lookAt(foe.position.offset(0, 1, 0), true)
        let worn: any = null, bodyAborted: any = null, raiseResult: any = null
        let raised = move.ok && (worn = await guard.wear()) && !(bodyAborted = ctl.aborted) && (raiseResult = await guard.raise(true)), sawSip = false
        let endWhy = raised ? 'cover_window_end' : !move.ok ? 'cover_move_failed' : !worn ? 'cover_wear_failed' : bodyAborted ? 'cover_aborted_before_raise' : 'cover_raise_unconfirmed'
        const start = Date.now(), retargets: any[] = []
        let anchor = spot
        while (raised && !ctl.aborted && alive(patient) && Date.now() - start < 4500) {
          if (patient._ndAntidoteDrinking) sawSip = true; else if (sawSip) { endWhy = 'cover_sip_finished'; break }
          const next = publicTarget(bot, foeActor), ally = publicTarget(bot, patient)
          if (!next || !ally) { endWhy = 'cover_public_body_lost'; note(endWhy, { foeVisible: !!next, patientVisible: !!ally }); break }
          // Pickup can move the patient. Reprice from its fresh own report, then move real cover to the newly visible lane.
          if (!patient._ndAntidoteDrinking) {
            const fresh = require('../../../daemon/src/swarm/antidotes').antidoteExchange(member(patient), Date.now(),
              bots.slice(0, size).filter(alive).reduce((stock, actor) => { const inv = inventory(actor); for (const item of ['honey_bottle', 'milk_bucket']) stock[item] = (stock[item] || 0) + (inv[item] || 0); return stock }, {}))
            if (!fresh.choice && !fresh.need) { endWhy = 'cover_quote_nonpositive'; note(endWhy, { patient: patient.username, report: copy(fresh) }); break }
          }
          const dx = next.position.x - ally.position.x, dz = next.position.z - ally.position.z, length = Math.hypot(dx, dz) || 1
          const wanted = new Vec3(ally.position.x + dx / length * 1.2, ally.position.y, ally.position.z + dz / length * 1.2)
          if (Math.hypot(wanted.x - anchor.x, wanted.z - anchor.z) > .6) {
            await guard.raise(false)
            const moved = await require('../../../daemon/src/navigation/parkour').executeJump(bot, ctl, wanted, { allowWalk: true, maxFallDamage: 0, maxTicks: 40, maxFrames: 120 })
            const currentFoe = publicTarget(bot, foeActor)
            if (currentFoe) await bot.lookAt(currentFoe.position.offset(0, 1, 0), true)
            raised = moved.ok && !ctl.aborted && !!currentFoe && await guard.raise(true); anchor = wanted
            if (!raised) endWhy = !moved.ok ? 'cover_retarget_move_failed' : ctl.aborted ? 'cover_retarget_aborted' : !currentFoe ? 'cover_retarget_foe_not_public' : 'cover_retarget_raise_unconfirmed'
            retargets.push({ ms: Date.now(), patient: point(ally.position), wanted: point(wanted), moved, raised })
          } else await bot.lookAt(next.position.offset(0, 1, 0), true)
          await pause()
        }
        trace.covers.push({ actor: bot.username, for: patient.username, raised, move, retargets, sawSip, stats: { ...guard.stats }, nativeUse: guard.nativeUse() })
        note(ctl.aborted ? 'cover_aborted' : !alive(patient) ? 'cover_patient_life_ended' : endWhy, { patient: patient.username, move, worn, bodyAborted, raiseResult, raised, sawSip })
      } finally { guard.close() }
      return
    }
    const request = task.data?.antidote
    if (task.kind !== 'recover' || !request) return note('unsupported_task_or_missing_antidote')
    if (!(inventory(bot)[request.item] > 0)) {
      const policyQuotes = new Map<any, number>(), policyDeliveryTicks = new Map<any, number>()
      const recipient = member(bot), donor = bots.slice(0, size).filter(other => other !== bot && alive(other) && !busy.has(other) && !assigned.has(other.username) && publicTarget(other, bot))
        .map(other => { const range = Math.hypot(other.entity.position.x - bot.entity.position.x, other.entity.position.z - bot.entity.position.z), deliveryTicks = 40 + Math.ceil(Math.max(0, range - 2.5) / require('../../../daemon/src/tempo').WALK_BPT)
          // Quote time follows both report timestamps; a future-dated donor report would hide its own reserve.
          const value = require('../../../daemon/src/swarm/antidotes').antidoteTransferValue(member(other), recipient, request.item, Date.now(), deliveryTicks); policyQuotes.set(other, value); policyDeliveryTicks.set(other, deliveryTicks); return { other, value } })
        .filter(x => x.value > 0).sort((a, b) => b.value - a.value)[0]?.other
      // Observer only: do not evaluate an extra quote for candidates the policy filtered out.
      const candidates = bots.slice(0, size).filter(other => other !== bot).map(other => {
        const currentLife = alive(other), publicLOS = currentLife && !!publicTarget(other, bot), pos = other.entity?.position, own = bot.entity?.position
        const range = pos && own ? Math.hypot(pos.x - own.x, pos.z - own.z) : null
        const report = memberReports.get(other.username), occupied = busy.has(other), queued = assigned.has(other.username)
        const skipped = !currentLife ? 'life' : occupied ? 'busy' : queued ? 'assigned' : !publicLOS ? 'public_los' : 'unknown'
        return { donor: other.username, currentLife, publicLOS, range, busy: occupied, assigned: queued, stock: inventory(other)[request.item] || 0,
          declaredReserve: report?.reserve?.[request.item] || 0, declaredNeed: report?.needs?.[request.item] || 0,
          pricedReserve: report ? (report.antidote.choice?.item === request.item ? 1 : 0) : null, reportAgeMs: report ? Date.now() - report.antidote.receivedAt : null,
          quote: policyQuotes.has(other) ? policyQuotes.get(other) : null, deliveryTicks: policyDeliveryTicks.get(other) ?? null, quoteKind: policyQuotes.has(other) ? 'policy' : 'skipped_' + skipped }
      })
      note(donor ? 'donor_selected' : 'no_eligible_donor', { item: request.item, recipientStock: inventory(bot)[request.item] || 0, candidates, selected: donor?.username ?? null })
      if (!donor) return
      const before = inventory(bot)[request.item] || 0
      assigned.set(donor.username, { kind: 'transfer', to: bot.username, item: request.item })
      while (!ctl.aborted && alive(donor) && (assigned.has(donor.username) || busy.has(donor))) await pause()
      if (ctl.aborted || !alive(donor)) return note('recover_donor_job_interrupted', { donor: donor.username, item: request.item })
      const result = (inventory(bot)[request.item] || 0) > before ? { ok: true, why: 'actual_inventory_gain_during_delivery' }
        : await (actions.pickup ?? require('../../../daemon/src/pvp/team-assist').pickup)(bot, request.item, 4, undefined, ctl)
      const received = Math.max(0, (inventory(bot)[request.item] || 0) - before)
      trace.transfers.push({ ms: Date.now(), stage: 'pickup', to: bot.username, item: request.item, received, result })
      if (!received || ctl.aborted) return note(ctl.aborted ? 'recover_aborted_after_pickup' : 'recover_no_actual_pickup', { item: request.item, received, result })
    }
    const result = actions.consume ? await actions.consume(bot, request) : await require('../../../daemon/src/rpc/antidotes').antidoteMethods({ session: sessions[bots.indexOf(bot)] }).antidote({
      item: request.item, allies: bots.slice(0, size).filter(other => other !== bot).map(other => other.username), enemies: bots.slice(size).map(other => other.username), cover: request.cover,
    })
    const before = result.before || [], after = result.after || [], relevant = fx => request.item === 'milk_bucket' || fx.name === 'poison'
    const removed = before.filter(fx => !after.some(next => next.name === fx.name)).map(fx => fx.name)
    const cleared = !!result.consumed && before.some(relevant) && !after.some(relevant)
    trace.consumes.push({ ms: Date.now(), actor: bot.username, request, result, removed, cleared })
    note('recover_rpc_result', { item: request.item, consumed: !!result.consumed, rpcWhy: result.why ?? null, cleared })
  }
  const opening = async (bot: any, entity: any, kind: string, ctl: any) => {
    if (actions.opening) return actions.opening(bot, entity, kind, ctl)
    if (kind === 'arrow') return require('../../../daemon/src/bow').shoot(bot, entity, { follow: true, shouldStop: () => ctl.aborted, mode: 'settle' })
    const item = bot.inventory.items().find(i => i.name === (kind === 'splash' ? 'splash_potion' : 'lingering_potion') && /(^|_)poison$/.test(require('../../../daemon/src/pvp/potions').potionOf(i) || ''))
    if (!item) return { thrown: false, why: 'missing_actual_poison_item' }
    const lastVisible = entity.position.offset(0, .3, 0), onAimRejected: any[] = []
    const result = await (actions.throwAt ?? require('../../../daemon/src/throw').throwAt)(bot, () => !ctl.aborted ? entity.position.offset(0, .3, 0) : lastVisible, { item, mode: 'exact', jump: 'auto', sprint: false,
      onAim: shot => {
        // Preserve the existing short-circuit policy; null means this later check was not evaluated.
        const aborted = !!ctl.aborted, seen = aborted ? null : !!visible(bot, entity)
        const party = !aborted && seen ? bots.slice(size).filter(other => other !== bot).map(other => publicTarget(bot, other)).filter(Boolean) : []
        const unsafe = !aborted && seen ? !!(actions.unsafeSplash ?? require('../../../daemon/src/swarm/combos/splash-safety').unsafeSplash)(bot, entity, party, shot) : null
        const allowed = !aborted && !!seen && !unsafe
        if (!allowed && onAimRejected.length < 8) onAimRejected.push({ ms: Date.now(), ctlAborted: aborted, visible: seen, unsafeSplash: unsafe,
          own: { position: point(bot.entity?.position), yaw: bot.entity?.yaw, pitch: bot.entity?.pitch },
          target: { id: entity.id, name: entity.username, position: seen ? point(entity.position) : null },
          allies: party.map(e => ({ id: e.id, name: e.username, position: point(e.position) })),
          aim: { from: point(shot.from), at: point(shot.sol?.at), yaw: shot.sol?.yaw, pitch: shot.sol?.pitch, ticks: shot.sol?.ticks, moved: point(shot.moved), airborne: shot.airborne, land: point(shot.land?.at) } })
        return allowed
      } })
    return { ...result, onAimRejected }
  }
  const actor = async (bot: any, index: number) => {
    const ctl = { get aborted() { return halted() || !alive(bot) || !(bot.health > 0) } }
    let processed = -1, lastStrike = -100
    if (index >= size && !ctl.aborted) {
      const kind = ['splash', 'lingering', 'arrow'][(index - size) % 3], selected = nearest(bot)
      const result = selected ? await opening(bot, selected.entity, kind, { get aborted() { return ctl.aborted || publicTarget(bot, selected.actor) !== selected.entity } }) : { attempted: false, why: 'no_current_visible_target' }
      trace.actions.push({ ms: Date.now(), actor: bot.username, kind: 'opening_' + kind, result })
    }
    while (!ctl.aborted) {
      if (ticks[index] === processed) { await pause(); continue }; processed = ticks[index]
      if (enabled && index < size && bot === bots.slice(0, size).find(alive) && ticks[index] >= planTick + 5) { updatePlan(); planTick = ticks[index] }
      const task = assigned.get(bot.username)
      if (enabled && index < size && task) {
        assigned.delete(bot.username); busy.add(bot); bot.clearControlStates(); bot.deactivateItem()
        try { await taskFor(bot, task) } finally { busy.delete(bot) }
        continue
      }
      const selected = nearest(bot)
      if (!selected) { bot.clearControlStates(); await pause(); continue }
      const e = selected.entity, cancel = () => ctl.aborted || publicTarget(bot, selected.actor) !== e
      await bot.lookAt(e.position.offset(0, .9, 0), true); if (cancel()) continue
      const safe = actions.safeStep ?? ((bot, key) => require('../../../daemon/src/pvp/body').stepSafe(bot, require('../../../daemon/src/moves').keyDir(bot, key)))
      const distance = Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z), forward = distance > 2.25 && safe(bot, 'forward')
      bot.setControlState('forward', !!forward); bot.setControlState('sprint', !!forward)
      const heal = actions.heal ?? (async () => {
        const pot = bot.inventory.items().find(i => i.name === 'splash_potion' && /healing$/.test(require('../../../daemon/src/pvp/potions').potionOf(i) || ''))
        if (!pot || Math.min(8, 20 - bot.health) <= (distance <= 3 ? 6 : 0)) return false
        const value = await guardedRoundHeal(bot, ctl); trace.actions.push({ ms: Date.now(), actor: bot.username, kind: 'ordinary_heal', result: value }); return value.ok
      })
      if (await heal(bot)) continue
      const cooldown = actions.cooldown ? actions.cooldown(bot) : require('../../../daemon/src/pvp/damage-model').ticksToCharge('iron_sword')
      if (ticks[index] - lastStrike >= cooldown) {
        const result = await (actions.strike ?? require('../../../daemon/src/swarm/combos/ideas').strike)(bot, e, { weapon: 'iron_sword', ctl: { get aborted() { return cancel() } } })
        trace.actions.push({ ms: Date.now(), actor: bot.username, kind: 'ordinary_strike', result }); if (result.sent) lastStrike = ticks[index]
      }
      await pause()
    }
    bot.clearControlStates(); bot.deactivateItem()
  }
  const timer = setTimeout(() => { closed = true }, 12000)
  try {
    bots.forEach((bot, index) => {
      pending++; jobs.push(Promise.resolve().then(() => actor(bot, index)).catch(error => { if (!halted()) trace.error = String(error) }).finally(() => { pending-- }))
    })
    while (!halted()) await pause()
    trace.roundEndMs = Date.now() - t0; trace.winner = trace.error || stop() ? null : winner()
    trace.endReason = stop() ? 'AUTO-STOP' : trace.error ? 'action_error' : trace.winner ? 'team_wipe' : Math.max(...ticks) >= 240 ? 'physics_cap' : 'wall_cap'
  } finally {
    closed = true; clearTimeout(timer); bots.forEach(bot => { try { bot.clearControlStates(); bot.deactivateItem() } catch {} })
    await Promise.race([Promise.allSettled(jobs), pause(3500)])
    if (pending) { trace.hardClosed = true; bots.forEach(bot => { try { bot.quit('antidote round unjoined action') } catch {} }); await Promise.race([Promise.allSettled(jobs), pause(500)]) }
    trace.joined = pending === 0
    try {
      const land = actions.landing ?? require('./combo-shockwave-active').fullSpearLanding
      trace.landing = await Promise.all(bots.map(bot => alive(bot) ? land(bot, () => stop() || !alive(bot), 2500) : { reason: 'first_life_ended' }))
      if (actions.drain) await actions.drain(); else if (!stop()) await Promise.race([Promise.all(bots.filter(alive).map(bot => bot.waitForTicks(3))), pause(500)])
    } catch (error) { trace.error ||= String(error); trace.censored = true }
    finally {
      cleanup.reverse().forEach(close => close()); trace.finalWinner = trace.error || trace.hardClosed || stop() ? null : winner()
      trace.endedAtMs = Date.now(); trace.elapsedMs = trace.endedAtMs - t0
    }
  }
  return trace
}

/** Separate 12-second scripted cohort. All toxin exposure comes from actual hostile items. */
export async function antidoteRounds(size = 3, pairs = 2) {
  if (!Number.isInteger(size) || size < 3 || size > 5 || !Number.isInteger(pairs) || pairs < 1 || pairs > 20) throw new Error('combo-antidotes-rounds [size=3:3..5] [pairs=2:1..20]')
  const { REPO_ROOT } = require('../../../daemon/src/paths'), { GameClock } = require('../../../daemon/src/game-clock')
  const { connect, clients, measure, stopped, sleep } = require('./combo-ideas'), { setup, give, hold, cmd, position } = require('./combo-air')
  const { settleFixtureTeleport } = require('./combo-ab'), { ownAntidoteState } = require('../../../daemon/src/pvp/antidotes'), { nativeHpAgreement } = require('./combo-anvil')
  if (stopped() || clients.length) throw new Error('antidote rounds require isolated owned raw clients')
  const owned: any[] = [], rows: any[] = [], folder = path.join(REPO_ROOT, 'farm/results/ideas-28')
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `antidotes-rounds-${size}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`)
  fs.closeSync(fs.openSync(file, 'wx'))
  const probeFile = path.join(REPO_ROOT, 'farm/server-28/plugins/IdeasProbe/events.jsonl')
  const read = async (command: string) => { try { return await cmd(command) } catch (error) { return `OBSERVER_ERROR: ${String(error)}` } }
  const native = async (bot: any) => ({ actor: bot.username, id: bot.entity?.id, ms: Date.now(), pos: await read(`data get entity ${bot.username} Pos`),
    health: await read(`data get entity ${bot.username} Health`), food: await read(`data get entity ${bot.username} foodLevel`),
    effects: await read(`data get entity ${bot.username} active_effects`), fall: await read(`data get entity ${bot.username} fall_distance`) })
  const inventory = (bot: any) => ({ actor: bot.username, items: bot.inventory.items().map(item => ({ name: item.name, count: item.count, slot: item.slot,
    potion: /potion$/.test(item.name) ? require('../../../daemon/src/pvp/potions').potionOf(item) : undefined })), offhand: bot.inventory.slots?.[45]?.name ?? null })
  try {
    // No bootstrap/daemon client: exactly 2*size raw actors occupy the owned server.
    for (const suffix of ['j', 'k', 'b0', 'l', 'm', 'n', 'o', 'p', 'q', 'r'].slice(0, 2 * size)) {
      const bot = await connect('NeuroFarm28' + suffix, new GameClock()); owned.push(bot)
      ownAntidoteState(bot) // Attach before setup effects AND before any hostile effect receipt, including on enemies.
    }
    const poses = antidoteRoundPoses(size)
    for (let pair = 0; pair < pairs; pair++) for (const enabled of pair % 2 ? [true, false] : [false, true]) {
      if (stopped()) throw new Error('AUTO-STOP')
      const prep: any = { cohort: 'delivery74', size, poses, seed: 680126 + pair, health: 20, armor: 'plain diamond', weapon: 'iron_sword', toxinSource: 'actual enemy items only' }, nativeStart: any[] = []
      try {
        prep.parking = await prepareAntidoteParking(owned, cmd, stopped)
        await setup(owned, poses, 20)
        for (const [index, bot] of owned.entries()) {
          if (stopped()) throw new Error('AUTO-STOP')
          await cmd(`team leave ${bot.username}`); await cmd(`clear ${bot.username}`)
          await cmd(`effect give ${bot.username} minecraft:saturation 1 20 true`); await bot.waitForTicks(2)
          await cmd(`effect clear ${bot.username} minecraft:saturation`)
          bot._ndSwarmAllies = owned.filter((other, i) => other !== bot && (i < size) === (index < size)).map(other => other.username)
          for (const [slot, item] of [['head', 'diamond_helmet'], ['chest', 'diamond_chestplate'], ['legs', 'diamond_leggings'], ['feet', 'diamond_boots']])
            await cmd(`item replace entity ${bot.username} armor.${slot} with minecraft:${item}`)
          await give(bot, 'iron_sword 1'); await give(bot, 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}] 2')
          await cmd(`item replace entity ${bot.username} weapon.offhand with minecraft:shield`)
          if (enabled && index > 0 && index < size) { await give(bot, 'honey_bottle 2'); await give(bot, 'milk_bucket 1') }
          if (index >= size) {
            const kind = ['splash', 'lingering', 'arrow'][(index - size) % 3]
            if (kind === 'arrow') { await give(bot, 'bow 1'); await give(bot, 'tipped_arrow[potion_contents={potion:"minecraft:strong_poison"}] 1') }
            else await give(bot, `${kind === 'splash' ? 'splash_potion' : 'lingering_potion'}[potion_contents={potion:"minecraft:strong_poison"}] 1`)
          }
          await hold(bot, 'iron_sword')
        }
        await settleFixtureTeleport(owned); await owned[0].waitForTicks(3); await cmd(`random reset * ${prep.seed}`)
        for (const bot of owned) nativeStart.push(await native(bot))
        for (const [index, bot] of owned.entries()) {
          const p = nativeStart[index].pos.match(/\[([^\]]+)\]/)?.[1].split(',').map((s: string) => parseFloat(s)), want = [poses[index][0], 151, poses[index][1]], local = position(bot)
          const hp = parseFloat(nativeStart[index].health.match(/:\s*(-?[\d.]+)f?\s*$/)?.[1] ?? '')
          const noEffects = nativeStart[index].effects === 'Found no elements matching active_effects' || /:\s*\[\s*\]\s*$/.test(nativeStart[index].effects)
          if (!p || p.length !== 3 || p.some((n: number, axis: number) => !Number.isFinite(n) || Math.abs(n - want[axis]) > .05) ||
            Math.hypot(local.x - want[0], local.y - want[1], local.z - want[2]) > .05 || !bot.entity.onGround || bot.health !== 20 || hp !== 20 || bot.food !== 20 || bot.game.gameMode !== 'survival' || !noEffects)
            throw new Error(`unsettled antidote rounds ${bot.username}: ${nativeStart[index].pos};HP${bot.health}/${hp};food${bot.food};effects${nativeStart[index].effects}`)
        }
      } catch (error) {
        prep.clientStart = owned.map(bot => ({ actor: bot.username, pos: position(bot), health: bot.health, food: bot.food, onGround: bot.entity.onGround }))
        fs.writeFileSync(file.replace(/\.jsonl$/, `-${pair}-${enabled ? 'on' : 'off'}.prep-failure.json`), JSON.stringify({ pair, enabled, prep, nativeStart, error: String(error) }, null, 2) + '\n'); throw error
      }
      const startInventory = owned.map(inventory), before = owned.map(bot => ownAntidoteState(bot)), measures: (() => any)[] = owned.map(measure), offset = fs.existsSync(probeFile) ? fs.statSync(probeFile).size : 0
      let phase: any, receipts: any[]
      try { phase = await antidoteRoundPhase(owned, size, enabled, stopped) }
      finally { receipts = measures.map(close => close()) }
      const after = owned.map(bot => ownAntidoteState(bot)), nativeEnd: any[] = []; for (const bot of owned) nativeEnd.push(await native(bot))
      let probe: any[] = [], probeError: string | null = null
      try { const buffer = fs.readFileSync(probeFile); probe = buffer.subarray(offset <= buffer.length ? offset : 0).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) }
      catch (error) { probeError = String(error) }
      const row = { kind: 'antidotes_scripted_melee_real_toxin', cohort: 'delivery74', comparison: 'antidote_kit_and_house_policy_vs_no_antidote_ordinary_melee', pair, enabled, size, prep, nativeStart, nativeEnd, before, after, startInventory, endInventory: owned.map(inventory),
        phase, receipts, probe, probeError, hpAgreement: Object.fromEntries(owned.map((bot, i) => [bot.username, nativeHpAgreement(nativeEnd[i].health, receipts[i])])),
        limitation: '12-second scripted chase cohort, not production swarm brain; no synthetic toxin commands; poison misses/refusals and negative priced decisions remain in N; public shield use is separate from actual blocked sound/native damage; first-life HP and post-respawn native HP differ intentionally' }
      rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n'); console.log(JSON.stringify({ ...row, file, probe: undefined }))
      if (!phase.joined || phase.hardClosed || phase.error || stopped()) throw new Error(phase.error ?? phase.endReason)
    }
    return { file, rows }
  } finally {
    const summary = { file, cohort: 'delivery74', rows: rows.length, arms: [false, true].map(enabled => { const arm = rows.filter(row => row.enabled === enabled); return {
      enabled, n: arm.length, wins: arm.filter(row => row.phase.winner === 'own').length, losses: arm.filter(row => row.phase.winner === 'enemy').length,
      draws: arm.filter(row => row.phase.winner === 'draw').length, timeouts: arm.filter(row => ['wall_cap', 'physics_cap'].includes(row.phase.endReason)).length,
      consumed: arm.reduce((sum, row) => sum + row.phase.consumes.filter(x => x.result.consumed).length, 0),
      cleared: arm.reduce((sum, row) => sum + row.phase.consumes.filter(x => x.cleared).length, 0),
      pickups: arm.reduce((sum, row) => sum + row.phase.transfers.filter(x => x.received > 0).length, 0),
      covers: arm.reduce((sum, row) => sum + row.phase.covers.filter(x => x.raised).length, 0),
      ownDamage: arm.reduce((sum, row) => sum + row.receipts.slice(0, size).reduce((n, hp) => n + hp.damage, 0), 0),
      enemyDamage: arm.reduce((sum, row) => sum + row.receipts.slice(size).reduce((n, hp) => n + hp.damage, 0), 0),
      ownDeaths: arm.reduce((sum, row) => sum + row.receipts.slice(0, size).reduce((n, hp) => n + hp.deaths, 0), 0),
      enemyDeaths: arm.reduce((sum, row) => sum + row.receipts.slice(size).reduce((n, hp) => n + hp.deaths, 0), 0),
    } }) }
    fs.writeFileSync(file.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(summary, null, 2) + '\n'); console.log('SUMMARY', JSON.stringify(summary))
    for (const bot of owned) { try { bot.clearControlStates(); bot.deactivateItem(); bot.quit('antidote rounds finished') } catch {} }
    await sleep(300)
  }
}

if (require.main === module) {
  const [size = '3', pairs = '2', ...extra] = process.argv.slice(2)
  if (extra.length || !/^\d+$/.test(size) || !/^\d+$/.test(pairs)) throw new Error('combo-antidotes-rounds [size=3:3..5] [pairs=2:1..20]')
  antidoteRounds(+size, +pairs).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
