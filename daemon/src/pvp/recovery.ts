import { recoveryDecision } from './recovery-graph'
import { consumeHand } from './hand-policy'

type CombatContext = Record<string, any>

export function createRecovery(ctx: CombatContext) {
const punishable = () => {
    try {
      if (!ctx.prof.player || !ctx.tempo.ON || !ctx.entity || !ctx.entity.isValid || !ctx.bot.entity) return null
      const c = ctx.tt.state(ctx.entity).consuming
      if (!c || c.left < 300) return null
      const me0 = ctx.bot.entity.position
      const r0 = ctx.reachFrom(me0.offset(0, ctx.EYE, 0), ctx.entity)
      const d0 = Math.hypot(ctx.entity.position.x - me0.x, ctx.entity.position.z - me0.z)
      if (Math.abs(ctx.entity.position.y - me0.y) < 2.5 && (Math.max(0, r0 - ctx.HIT_REACH) / ctx.tempo.SPRINT_BPT) * ctx.TICK_MS + 150 < c.left) return { kind: 'rush', left: c.left }
      if (!ctx.raySees(ctx.bot, me0.offset(0, ctx.EYE, 0), ctx.entity.position.offset(0, (ctx.entity.height || 1.8) * 0.55, 0))) return null
      if (d0 > 3 && d0 < 7 && ctx.findItem(ctx.bot, i => i.name === 'splash_potion' && /harming$/.test(ctx.potionOf(i) || ''))) return { kind: 'harm', left: c.left }
      const arrowsNow = ctx.rangedAllowed() && !!ctx.findItem(ctx.bot, i => /arrow$/.test(i.name))
      const xbs = arrowsNow ? ctx.ranged.crossbows(ctx.bot) : []
      if (d0 >= 2.5 && d0 <= 40 && xbs.some(x => x.info.loaded)) return { kind: 'crossbow', left: c.left }
      if (d0 >= 4 && d0 <= 30 && xbs.length && c.left > 1000) return { kind: 'crossbow', left: c.left }
      if (d0 >= 5 && d0 <= 30 && arrowsNow && ctx.findItem(ctx.bot, i => i.name === 'bow') && c.left > 900) return { kind: 'bow', left: c.left }
      return null
    } catch { return null }
  }

const eatHeld = async (name, abortIf = null, { desperate = false, buff = false, offhand = false, flightStable = false }: any = {}) => {
    const had = ctx.countOf(ctx.bot, name)
    await ctx.sleep(120)
    const inHand = offhand ? ctx.bot.inventory.slots[45] : ctx.bot.heldItem
    if (!inHand || inHand.name !== name) return false
    const unsafe = ctx.prof.player && ctx.tempo.ON && !desperate ? ctx.tt.guard(name, { fortSealed: ctx.fortSealed }) : null
    if (unsafe && unsafe()) { ctx.tt.stats.refused++; ctx.used('не стал есть: ' + (ctx.tt.lastAbort || 'опасно')); return false }
    if (ctx.FIX && ctx.maceNow()) { ctx.maceAbort('глоток'); return false }
    const movement = ['back', 'left', 'right'].find(key => ctx.stepSafe(ctx.bot, ctx.keyDir(ctx.bot, key)))
    const evaluate = (consuming: boolean) => recoveryDecision({
      hp: ctx.bot.health ?? 20, buff, desperate, consuming, drink: /potion/.test(name),
      safe: !(unsafe && unsafe()), covered: ctx.fortSealed(), grounded: !!ctx.bot.entity.onGround,
      flightStable: flightStable && !!ctx.bot.entity.elytraFlying, clutchActive: ctx.edges.falling(ctx.bot), moveSafe: !!movement,
      opponentUsing: !!(ctx.prof.player && ctx.tt.state(ctx.entity).consuming), opponentPunishable: !!ctx.punishable()
    })
    const first = evaluate(false)
    if (first.node === 'WaitForWindow' || first.node === 'PunishOpponentUsing') return false
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
      while (ctx.gameClock.now() - t0 < 2400 && ctx.countOf(ctx.bot, name) >= had && !ctx.ctl.aborted && !(abortIf && abortIf())) {
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
    const ok = ctx.countOf(ctx.bot, name) < had
    if (!ok && dropped === 'mace') ctx.maceAbort('глоток')
    else if (!ok && dropped === 'punish') { ctx.st.eatPunish.swaps++; ctx.used('бросил свой глоток — он сам пьёт, наказываю') } else if (!ok && dropped) { ctx.tt.stats.aborted++; ctx.used('бросил глоток: ' + (ctx.tt.lastAbort || 'опасно')) }
    return ok
  }

const consumeItem = async (item, abortIf = null, opt: any = {}) => {
    const previousOff = ctx.bot.inventory.slots[45]
    const enemyReach = ctx.reachFrom(ctx.entity.position.offset(0, ctx.EYE, 0), ctx.bot.entity)
    const hand = consumeHand({ main: ctx.bot.heldItem?.name || null, off: previousOff?.name || null,
      safe: ctx.tt.safe(ctx.tempo.consumeMs(item.name), { fortSealed: ctx.fortSealed() }).ok,
      grounded: !!ctx.bot.entity.onGround, clutchActive: ctx.edges.falling(ctx.bot),
      flightStable: !!opt.flightStable && !!ctx.bot.entity.elytraFlying,
      usingMain: !!ctx.bot.usingHeldItem,
      shieldNeeded: enemyReach < 7 && !ctx.fortSealed(), totemNeeded: (ctx.bot.health ?? 20) <= 10 })
    if (!hand) return false
    const offhand = hand === 'off-hand'
    let consumed = false
    try {
      if (offhand) { try { await ctx.bot.equip(item, 'off-hand') } catch { return false } }
      else if (!(await ctx.holdItem(item))) return false
      consumed = await ctx.eatHeld(item.name, abortIf, { ...opt, offhand })
    } finally {
      if (offhand && previousOff && ctx.countOf(ctx.bot, previousOff.name) > 0) {
        const restored = ctx.bot.inventory.items?.().find(item => item.name === previousOff.name) || previousOff
        try { await ctx.bot.equip(restored, 'off-hand') } catch {}
      }
    }
    return consumed
  }

const drink = async (item, what, abortIf = null, opt: any = {}) => {
    if (!(await consumeItem(item, abortIf, opt))) return false
    ctx.used(what)
    const role = ctx.potionRole(ctx.potionOf(item))
    if (role === 'heal' || role === 'regen') ctx.st.healed.push(what)
    return true
  }

const escapePearl = async () => {
    const pearl = ctx.findItem(ctx.bot, i => i.name === 'ender_pearl')
    if (!pearl || !ctx.ready('pearl') || (ctx.bot.health ?? 0) <= 6) return null
    ctx.rest('pearl', 3000)
    const from = ctx.entity.position.clone()
    ctx.aim = 'free'
    const r = (await ctx.holdItem(pearl)) ? await ctx.throwMod.throwAt(ctx.bot, null, {
      item: ctx.bot.heldItem,
      jump: 'auto', // S6b pearl-jump
      pick: ctx.throwMod.escapePick(ctx.bot, tp => Math.min(32, Math.hypot(tp.x - from.x, tp.z - from.z)), { maxDrop: 4 })
    }).catch(() => null) : null
    ctx.aim = 'target'
    if (!r?.thrown) { await ctx.holdWeapon(); return null }
    ctx.used('жемчуг: оторвался')
    await ctx.sleep(900)
    return { thrown: true, how: 'уход жемчугом', clear: !ctx.tt.threats().some(e => e?.position && e.isValid !== false && e.position.distanceTo(ctx.bot.entity.position) < 8) }
  }

const buffUp = async (minD = 6, extra: any = []) => {
    const d = ctx.entity.position.distanceTo(ctx.bot.entity.position)
    if (d < minD) return
    for (const [kind, eff] of [['strength', 'strength'], ['swiftness', 'speed'], ['regeneration', 'regeneration'], ['fire_resistance', 'fire_resistance'], ...extra]) {
      if (ctx.hasEffect(ctx.bot, eff)) continue
      const splash = ctx.findItem(ctx.bot, i => i.name === 'splash_potion' && (ctx.potionOf(i) || '').replace(/^(long|strong)_/, '') === kind)
      if (splash) {
        if (await ctx.holdItem(splash)) { await ctx.useAt(ctx.bot.entity.yaw, -Math.PI / 2); ctx.used('зелье на себя: ' + kind) }
        continue
      }
      const pot = ctx.findItem(ctx.bot, i => i.name === 'potion' && (ctx.potionOf(i) || '').replace(/^(long|strong)_/, '') === kind)
      const tempoGate = ctx.tempo.ON && ctx.prof.player
      if (pot && tempoGate) {
        const sf = ctx.tt.safe(ctx.tempo.consumeMs('potion'), { fortSealed: ctx.fortSealed() })
        if (!sf.ok) { ctx.tt.stats.refused++; break }
      }
      if (pot && ctx.FIX && ctx.prof.player && !ctx.fortSealed() && (ctx.punishable() || !!ctx.tt.state(ctx.entity).consuming)) {
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
    if (!ctx.prof.player || !ctx.seesNow() || (ctx.bot.food ?? 20) <= 6 || !ctx.ready('spearCharge')) return false
    const sp = ctx.spear.spearOf(ctx.bot)
    if (!sp || !ctx.stepSafe(ctx.bot, ctx.keyDir(ctx.bot, 'forward'))) return false
    const me0 = ctx.bot.entity.position
    const v0 = ctx.track.vel()
    const tw = (v0.x * (me0.x - ctx.entity.position.x) + v0.z * (me0.z - ctx.entity.position.z)) / Math.max(d0, 0.1)
    if (!ctx.spear.chargeWindow(sp.item.name, r0, tw)) return false
    ctx.rest('spearCharge', 3000)
    if (!ctx.bot.heldItem || ctx.bot.heldItem.name !== sp.item.name) await ctx.holdItem(sp.item)
    if (ctx.guard) await ctx.guard.raise(false)
    ctx.aim = 'free'
    const hpS = ctx.healthOf(ctx.bot, ctx.entity)
    const ch = await ctx.spear.charge(ctx.bot, ctx.ctl, ctx.entity, { maxMs: 1800, safe: k => ctx.stepSafe(ctx.bot, ctx.keyDir(ctx.bot, k)), vel: () => ctx.track.vel(), onHit: () => { ctx.st.landed++ } })
    ctx.aim = 'target'
    ctx.st.spearCharges = (ctx.st.spearCharges || 0) + 1
    if (ch.hit) ctx.st.spearChargeHits = (ctx.st.spearChargeHits || 0) + 1
    ctx.used(ch.hit ? `разгон копьём — попал (${hpS != null && ctx.healthOf(ctx.bot, ctx.entity) != null ? Math.round((hpS - ctx.healthOf(ctx.bot, ctx.entity)) * 10) / 10 : '?'} хп)` : `разгон копьём — мимо (${ch.why || 'время'})`)
    return true
  }
return { punishable, eatHeld, consumeItem, drink, escapePearl, buffUp, spearChargeFar }
}
