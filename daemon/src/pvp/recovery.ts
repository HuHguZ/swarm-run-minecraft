import { recoveryDecision } from './recovery-graph'
import { consumeHand } from './hand-policy'
import { canSurvivePearl } from '../throw'
import bow = require('../bow')

type CombatContext = Record<string, any>

export function createRecovery(ctx: CombatContext) {
const failedConsumes = new Map<string, any>()
let failedPearl = null
let failedFarCharge = null
const consumeInputs = (item, opt) => [item.name, item.slot, item.count, /potion$/.test(item.name) ? ctx.potionOf(item) : null,
    ctx.tt.safe(ctx.tempo.consumeMs(item.name), { fortSealed: ctx.fortSealed() }).ok,
    !!ctx.fortSealed(), !!ctx.maceNow(), !!ctx.bot.entity.onGround, !!ctx.bot.entity.elytraFlying,
    !!opt.desperate, !!ctx.punishable(), ctx.session?._reflexState?.active || null].join('|')
const punishable = () => {
    try {
      if (!ctx.prof.player || !ctx.tempo.ON || !ctx.entity || !ctx.entity.isValid || !ctx.bot.entity) return null
      const c = ctx.tt.state(ctx.entity).consuming
      if (!c || !Number.isFinite(c.left) || c.left <= 0) return null
      const me0 = ctx.bot.entity.position
      const eye = me0.offset(0, ctx.EYE, 0)
      const target = ctx.entity.position.offset(0, (ctx.entity.height || 1.8) * 0.55, 0)
      if (ctx.seesNow?.() === false || !ctx.raySees(ctx.bot, eye, target)) return null
      const r0 = ctx.reachFrom(eye, ctx.entity)
      const d0 = Math.hypot(ctx.entity.position.x - me0.x, ctx.entity.position.z - me0.z)
      const now = ctx.gameClock.now()
      const reaction = c.since == null ? 0 : Math.max(0, (ctx.tt.reactMs || 0) - (now - c.since))
      const quote = (kind, ms) => {
        const hitMs = reaction + ms
        return hitMs < c.left ? { kind, left: c.left, hitMs } : null
      }
      const speed = (ctx.bot.food ?? 20) > 6 ? ctx.tempo.SPRINT_BPT : ctx.tempo.WALK_BPT
      const walkMs = Math.max(0, r0 - ctx.HIT_REACH) / speed * ctx.TICK_MS
      const swapMs = ctx.weapon && ctx.bot.heldItem?.name !== ctx.weapon.name ? ctx.cooldownMs(ctx.weapon) : 0
      const meleeMs = Math.max(walkMs, Math.max(0, (ctx.nextReady || 0) - now), swapMs) + ctx.TICK_MS
      if (Math.abs(ctx.entity.position.y - me0.y) < 2.5 && (r0 <= ctx.HIT_REACH || ctx.stepSafe(ctx.bot, ctx.keyDir(ctx.bot, 'forward')))) {
        const rush = quote('rush', meleeMs)
        if (rush) return rush
      }
      if (d0 > 3 && d0 < 7 && ctx.findItem(ctx.bot, i => i.name === 'splash_potion' && /harming$/.test(ctx.potionOf(i) || ''))) {
        const mine = ctx.pick.hitboxOf(ctx.bot, ctx.bot.entity)
        const box = ctx.pick.hitboxOf(ctx.bot, ctx.entity)
        const gap = Math.hypot(...['x', 'y', 'z'].map(a => Math.max(0, mine.lo[a] - box.hi[a] - .425, box.lo[a] - mine.hi[a] - .425)))
        if (gap >= 4) { // same splash self-hit clearance as equipment.throwAt
          const sol = ctx.throwMod.aim(eye.offset(0, -.1, 0), target, ctx.throwMod.kindOf('splash_potion'))
          const harm = sol && quote('harm', (2 + sol.ticks) * ctx.TICK_MS)
          if (harm) return harm
        }
      }
      // A shot must arrive during the observed use. Draw/load and flight are game time,
      // using the same ballistics/charge mechanics as the executors, not a distance-only promise.
      const flightMs = (speed) => {
        const sol = bow.aim(eye.offset(0, -.1, 0), () => target, speed)
        return sol ? sol.ticks * ctx.TICK_MS : Infinity
      }
      const rangedOK = ctx.rangedAllowed()
      const arrowsNow = rangedOK && !!ctx.findItem(ctx.bot, i => /arrow$/.test(i.name))
      const xbs = rangedOK ? ctx.ranged.crossbows(ctx.bot) : []
      if (d0 >= 2.5 && d0 <= 40) for (const x of xbs) {
        if (!x.info.loaded && (!arrowsNow || d0 < 4 || d0 > 30)) continue
        const rocket = x.info.ammo === 'firework'
        // Match the executor's own blast clearance; empty rockets cannot punish.
        if (rocket && (!(x.info.stars > 0) || target.distanceTo(me0) < ctx.ranged.BLAST_R + .4)) continue
        const loadMs = x.info.loaded ? 0 : ctx.ranged.chargeTicks(x.info.quickCharge) * ctx.TICK_MS
        const flyMs = rocket ? ctx.ranged.rocketAim(eye.offset(0, -.1, 0), () => target).ticks * ctx.TICK_MS : flightMs(ctx.ranged.ARROW_SPEED)
        const shot = quote('crossbow', loadMs + ctx.TICK_MS + flyMs)
        if (shot) return shot
      }
      if (d0 >= 5 && d0 <= 30 && arrowsNow && ctx.findItem(ctx.bot, i => i.name === 'bow')) {
        const shot = quote('bow', bow.DRAW_MS + ctx.TICK_MS + flightMs(bow.SPEED))
        if (shot) return shot
      }
      return null
    } catch { return null }
  }

const eatHeld = async (name, abortIf = null, { desperate = false, buff = false, offhand = false, flightStable = false, onPunish = null }: any = {}) => {
    const remaining = () => {
      const off = ctx.bot.inventory.slots[45]
      return ctx.countOf(ctx.bot, name) + (off?.name === name ? off.count : 0)
    }
    const had = remaining()
    await ctx.sleep(120)
    const inHand = offhand ? ctx.bot.inventory.slots[45] : ctx.bot.heldItem
    if (!inHand || inHand.name !== name) return false
    const unsafe = ctx.prof.player && ctx.tempo.ON && !desperate ? ctx.tt.guard(name, { fortSealed: ctx.fortSealed }) : null
    if (unsafe && unsafe()) { ctx.tt.stats.refused++; ctx.used('не стал есть: ' + (ctx.tt.lastAbort || 'опасно')); return false }
    if (ctx.FIX && ctx.maceNow()) { ctx.maceAbort('глоток'); return false }
    const movement = ['back', 'left', 'right'].find(key => ctx.stepSafe(ctx.bot, ctx.keyDir(ctx.bot, key)))
    let startedAt = null
    const evaluate = (consuming: boolean) => {
      const opportunity = ctx.punishable()
      const remaining = Math.max(0, ctx.tempo.consumeMs(name) - (startedAt == null ? 0 : ctx.gameClock.now() - startedAt))
      // If finishing our current use still leaves time for the same hit, cancellation
      // buys nothing and loses all consume progress. A fresh real window can still win.
      const interrupt = opportunity && (!consuming || remaining + opportunity.hitMs >= opportunity.left)
      return recoveryDecision({
      hp: ctx.bot.health ?? 20, buff, desperate, consuming, drink: /potion/.test(name),
      safe: !(unsafe && unsafe()), covered: ctx.fortSealed(), grounded: !!ctx.bot.entity.onGround,
      flightStable: flightStable && !!ctx.bot.entity.elytraFlying, clutchActive: ctx.edges.falling(ctx.bot), moveSafe: !!movement,
      opponentUsing: !!(ctx.prof.player && ctx.tt.state(ctx.entity).consuming), opponentPunishable: !!interrupt
    })
    }
    const first = evaluate(false)
    if (first.node === 'WaitForWindow' || first.node === 'PunishOpponentUsing') {
      if (first.node === 'PunishOpponentUsing' && !ctx.ctl.aborted) onPunish?.()
      return false
    }
    const controls = movement && first.path.includes('RecoverWhileMoving')
      ? { key: movement, was: !!ctx.bot.controlState?.[movement], sprint: !!ctx.bot.controlState?.sprint }
      : null
    const nodes = ctx.st.recoveryNodes || (ctx.st.recoveryNodes = {})
    for (const node of first.path) nodes[node] = (nodes[node] || 0) + 1
    if (ctx.prof.player) ctx.tt.noteConsume(name, { desperate, fortSealed: ctx.fortSealed() })
    let dropped: any = false
    ctx.session.eating = true
    try {
      if (controls) { ctx.set(controls.key, true); ctx.set('sprint', false) }
      ctx.bot.activateItem(offhand)
      const t0 = ctx.gameClock.now()
      startedAt = t0
      while (ctx.gameClock.now() - t0 < 2400 && remaining() >= had && !ctx.ctl.aborted && !(abortIf && abortIf())) {
        if (ctx.FIX && ctx.maceNow()) { dropped = 'mace'; break }
        const decision = evaluate(true)
        if (decision.node === 'CancelOnApproach' || decision.node === 'WaitForWindow') { nodes[decision.node] = (nodes[decision.node] || 0) + 1; dropped = true; break }
        if (decision.node === 'PunishOpponentUsing') { nodes.PunishOpponentUsing = (nodes.PunishOpponentUsing || 0) + 1; dropped = 'punish'; break }
        if (controls && !ctx.stepSafe(ctx.bot, ctx.keyDir(ctx.bot, controls.key))) ctx.set(controls.key, false)
        await ctx.sleep(50)
      }
    } finally {
      ctx.session.eating = false
      try { ctx.bot.deactivateItem() } catch {}
      if (controls) { ctx.set(controls.key, !ctx.ctl.aborted && controls.was); ctx.set('sprint', !ctx.ctl.aborted && controls.sprint) }
    }
    const ok = remaining() < had
    if (!ok && dropped === 'mace') ctx.maceAbort('глоток')
    else if (!ok && dropped === 'punish') { ctx.st.eatPunish.swaps++; ctx.used('бросил свой глоток — он сам пьёт, наказываю'); if (!ctx.ctl.aborted) onPunish?.() } else if (!ok && dropped) { ctx.tt.stats.aborted++; ctx.used('бросил глоток: ' + (ctx.tt.lastAbort || 'опасно')) }
    return ok
  }

const consumeItem = async (item, abortIf = null, opt: any = {}) => {
    const key = item.name + ':' + (/potion$/.test(item.name) ? ctx.potionOf(item) : '')
    const inputs = consumeInputs(item, opt)
    if (failedConsumes.get(key)?.inputs === inputs) return false
    if (ctx.itemReady && !ctx.itemReady(item) || ctx.bot._ndUse?.cur) return false
    const previousOff = ctx.bot.inventory.slots[45]
    const enemyReach = ctx.reachFrom(ctx.entity.position.offset(0, ctx.EYE, 0), ctx.bot.entity)
    const hand = consumeHand({ main: ctx.bot.heldItem?.name || null, off: previousOff?.name || null,
      safe: ctx.tt.safe(ctx.tempo.consumeMs(item.name), { fortSealed: ctx.fortSealed() }).ok,
      grounded: !!ctx.bot.entity.onGround, clutchActive: ctx.edges.falling(ctx.bot),
      flightStable: !!opt.flightStable && !!ctx.bot.entity.elytraFlying,
      usingMain: !!ctx.bot.usingHeldItem,
      shieldNeeded: enemyReach < 7 && !ctx.fortSealed(), totemNeeded: (ctx.bot.health ?? 20) <= 10 })
    if (!hand) { failedConsumes.set(key, { inputs, why: 'no_safe_consume_hand' }); return false }
    const offhand = hand === 'off-hand'
    let consumed = false
    try {
      if (offhand) { try { await ctx.bot.equip(item, 'off-hand') } catch { failedConsumes.set(key, { inputs, why: 'equip_rejected' }); return false } }
      else if (!(await ctx.holdItem(item))) { failedConsumes.set(key, { inputs, why: 'equip_unconfirmed' }); return false }
      consumed = await ctx.eatHeld(item.name, abortIf, { ...opt, offhand })
    } finally {
      if (offhand && previousOff && ctx.countOf(ctx.bot, previousOff.name) > 0) {
        const restored = ctx.bot.inventory.items?.().find(item => item.name === previousOff.name) || previousOff
        try { await ctx.bot.equip(restored, 'off-hand') } catch {}
      }
    }
    if (consumed) failedConsumes.delete(key)
    else failedConsumes.set(key, { inputs: consumeInputs(item, opt), why: ctx.maceNow() ? 'mace' : ctx.punishable() ? 'punish_window' : 'consume_not_confirmed' })
    return consumed
  }

const drink = async (item, what, abortIf = null, opt: any = {}) => {
    if (!(await consumeItem(item, abortIf, opt))) return false
    ctx.used(what)
    const role = ctx.potionRole(ctx.potionOf(item))
    if (role === 'heal' || role === 'regen') ctx.st.healed.push(what)
    return true
  }

const throwPearl = async (target, options: any = {}) => {
    const pearl = ctx.findItem(ctx.bot, i => i.name === 'ender_pearl')
    if (!pearl || ctx.itemReady && !ctx.itemReady(pearl) || !canSurvivePearl(ctx.bot)) return null
    const quote = () => [ctx.bot.entity.position, ctx.entity.id, ctx.entity.position, pearl.slot, pearl.count,
      ctx.routeInputs?.(), !!target, ctx.session?._reflexState?.active || null].join('|')
    const inputs = quote()
    if (failedPearl?.inputs === inputs) return null
    const origin = ctx.bot.entity.position.clone()
    const r = (await ctx.holdItem(pearl)) ? await ctx.throwMod.throwAt(ctx.bot, target, {
      ...options, item: ctx.bot.heldItem
    }).catch(() => null) : null
    if (!r?.thrown) { failedPearl = { inputs: quote(), why: r?.why || 'throw_unconfirmed' }; return r }
    const start = ctx.gameClock?.now()
    const arrived = () => ctx.bot.entity.position.distanceTo(origin) > 2 && (!r.land || Math.hypot(ctx.bot.entity.position.x - r.land.x,
      ctx.bot.entity.position.y - r.land.y, ctx.bot.entity.position.z - r.land.z) < 2)
    while (start != null && !ctx.ctl?.aborted && !arrived() && ctx.gameClock.now() - start < ((r.ticks || 40) + 2) * ctx.TICK_MS) await ctx.sleep(ctx.TICK_MS)
    failedPearl = arrived() ? null : { inputs: quote(), why: 'teleport_not_confirmed' }
    return { ...r, teleported: arrived() }
  }

const escapePearl = async () => {
    const from = ctx.entity.position.clone()
    ctx.aim = 'free'
    const r = await throwPearl(null, { jump: 'auto',
      pick: ctx.throwMod.escapePick(ctx.bot, tp => Math.min(32, Math.hypot(tp.x - from.x, tp.z - from.z)), { maxDrop: 4 }) })
    ctx.aim = 'target'
    if (!r?.thrown) { await ctx.holdWeapon(); return null }
    ctx.used('жемчуг: оторвался')
    return { thrown: true, how: 'уход жемчугом', clear: r.teleported && !ctx.tt.threats().some(e => e?.position && e.isValid !== false && e.position.distanceTo(ctx.bot.entity.position) < 8) }
  }

const buffUp = async (minD = 6, extra: any = []) => {
    const d = ctx.entity.position.distanceTo(ctx.bot.entity.position)
    if (d < minD) return
    for (const [kind, eff] of [['strength', 'strength'], ['swiftness', 'speed'], ['regeneration', 'regeneration'], ['fire_resistance', 'fire_resistance'], ...extra]) {
      if (ctx.hasEffect(ctx.bot, eff)) continue
      const splash = ctx.findItem(ctx.bot, i => i.name === 'splash_potion' && (ctx.potionOf(i) || '').replace(/^(long|strong)_/, '') === kind)
      if (splash) {
        if (await ctx.holdItem(splash) && await ctx.useAt(ctx.bot.entity.yaw, -Math.PI / 2, { item: splash })) ctx.used('зелье на себя: ' + kind)
        continue
      }
      const pot = ctx.findItem(ctx.bot, i => i.name === 'potion' && (ctx.potionOf(i) || '').replace(/^(long|strong)_/, '') === kind)
      const tempoGate = ctx.tempo.ON && ctx.prof.player
      if (pot && tempoGate) {
        const sf = ctx.tt.safe(ctx.tempo.consumeMs('potion'), { fortSealed: ctx.fortSealed() })
        if (!sf.ok) { ctx.tt.stats.refused++; break }
      }
      if (pot && ctx.FIX && ctx.prof.player && !ctx.fortSealed() && ctx.punishable()) {
        ctx.st.eatPunish.skips = (ctx.st.eatPunish.skips || 0) + 1
        if (ctx.ready('punFirstNote')) { ctx.rest('punFirstNote', 3000); ctx.used('не пью — он сам пьёт, наказываю') }
        break
      }
      if (pot && (tempoGate || ctx.entity.position.distanceTo(ctx.bot.entity.position) >= minD)) {
        const hp0 = ctx.bot.health ?? 20
        const close = () => ctx.reachFrom(ctx.bot.entity.position.offset(0, ctx.EYE, 0), ctx.entity) < ctx.HIT_REACH + 1.2 || (ctx.bot.health ?? 20) < hp0 - 0.5
        if (close()) break
        if (ctx.FIX && ctx.prof.player) await ctx.coverForDrink()
        const ok = await ctx.drink(pot, 'выпил ' + kind, close, { buff: true })
        if (!ok) { ctx.used('бросил пить — он рядом'); break }
        if (minD < 6 && !tempoGate) break
      }
    }
    await ctx.holdWeapon()
  }

const spearChargeFar = async (r0, d0) => {
    if (!ctx.prof.player || !ctx.seesNow() || (ctx.bot.food ?? 20) <= 6) return false
    const sp = ctx.spear.spearOf(ctx.bot)
    if (!sp || !ctx.stepSafe(ctx.bot, ctx.keyDir(ctx.bot, 'forward'))) return false
    const me0 = ctx.bot.entity.position
    const v0 = ctx.track.vel()
    const tw = (v0.x * (me0.x - ctx.entity.position.x) + v0.z * (me0.z - ctx.entity.position.z)) / Math.max(d0, 0.1)
    if (!ctx.spear.chargeWindow(sp.item.name, r0, tw)) return false
    const inputs = [ctx.routeInputs?.(), ctx.bot.entity.position.floored(), ctx.entity.id, ctx.entity.position.floored(), sp.item.name,
      ctx.session?._reflexState?.active || null].join('|')
    if (failedFarCharge?.inputs === inputs) return false
    if (!ctx.bot.heldItem || ctx.bot.heldItem.name !== sp.item.name) await ctx.holdItem(sp.item)
    if (ctx.guard) await ctx.guard.raise(false)
    ctx.aim = 'free'
    const hpS = ctx.healthOf(ctx.bot, ctx.entity)
    const ch = await ctx.spear.charge(ctx.bot, ctx.ctl, ctx.entity, { maxMs: 1800, safe: k => ctx.stepSafe(ctx.bot, ctx.keyDir(ctx.bot, k)), vel: () => ctx.track.vel(), onHit: () => { ctx.st.landed++ } })
    failedFarCharge = ch.hit ? null : { inputs: [ctx.routeInputs?.(), ctx.bot.entity.position.floored(), ctx.entity.id, ctx.entity.position.floored(), sp.item.name,
      ctx.session?._reflexState?.active || null].join('|'), why: ch.why || 'charge_missed' }
    ctx.aim = 'target'
    ctx.st.spearCharges = (ctx.st.spearCharges || 0) + 1
    if (ch.hit) ctx.st.spearChargeHits = (ctx.st.spearChargeHits || 0) + 1
    ctx.used(ch.hit ? `разгон копьём — попал (${hpS != null && ctx.healthOf(ctx.bot, ctx.entity) != null ? Math.round((hpS - ctx.healthOf(ctx.bot, ctx.entity)) * 10) / 10 : '?'} хп)` : `разгон копьём — мимо (${ch.why || 'время'})`)
    return true
  }
return { punishable, eatHeld, consumeItem, drink, throwPearl, escapePearl, buffUp, spearChargeFar }
}
