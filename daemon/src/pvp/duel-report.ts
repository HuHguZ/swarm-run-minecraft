import * as edges from '../edges'
import * as gameClock from '../game-clock'
import * as tempo from '../tempo'
import * as totemMod from '../totem'
import { leftovers } from './potions'
import { type DuelCtx } from './turn'

// Конец боя: отпустить предметы, стратегическая пауза, уборка слушателей и служб, отчёт.
export function installReport (ctx: DuelCtx) {
  const { aimTimer, blk, bm, bot, clear, combo, ctl, cx, duo, edgeGuard, foodFire, guard, hm, kills, mc, mf, onCrack, onCrackEnd, onDead, onHurt, onMlg, onMobHurt, onRoutePath, onSelfDeath, onTickArcher, onTickDmg, onTickFall, onTickSwat, opts, ovl, pathTo, pearlResponse, pendingLava, quiet, restoreMoves, scoop, session, sky, st, strategicTargetId, tt, use0, util, vision } = ctx
  const releaseFightItems = ctx.releaseFightItems = async () => {
    if (guard && !ctx.selfDied) await guard.raise(false)
    if (!ctx.selfDied) for (const cell of pendingLava.splice(0)) await scoop(cell)
  }
  ctx.strategicRequest = () => !ctl.aborted && !ctx.selfDied && (bot.health ?? 20) > 0 && ctx.prof.player &&
    ctx.entity.id === strategicTargetId && bot.entity?.onGround && !bot.entity.elytraFlying && !edges.falling(bot) &&
    !bot._ndClutch?.waterPlan && !bot._ndAerialRecovering?.() ? opts.strategicYield?.() : null

  ctx.finish = async (out, itemsReleased = false) => {
    gameClock.clearInterval(aimTimer)
    clear()
    pathTo(false)
    restoreMoves()
    try { bot.deactivateItem() } catch {}
    // Погиб — отчёт сразу: сессия ждёт его 1 с реального времени после смерти (intent-runner), щит и вычерпывание
    // лавы мёртвому не нужны (S7c: у погибшего в ROUND пустые crystal/elytra — отчёт не успевал).
    if (!itemsReleased) await releaseFightItems()
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('physicsTick', onTickSwat)
    bot.removeListener('physicsTick', onTickArcher)
    bot.removeListener('entityHurt', onMobHurt)
    bot.removeListener('death', onSelfDeath)
    bot.removeListener('physicsTick', onTickFall)
    bot.removeListener('physicsTick', onTickDmg)
    edgeGuard.stop()
    bot.removeListener('nd_mlg', onMlg)
    if (edgeGuard.stats.saves || edgeGuard.stats.air) st.tricks['рефлекс края: ' + (Object.entries(edgeGuard.stats.why) as [string, any][]).map(([k, v]) => `${k}×${v}`).join(', ')] = 1
    bot.removeListener('blockBreakProgressObserved', onCrack)
    bot.removeListener('blockBreakProgressEnd', onCrackEnd)
    bot.removeListener('path_update', onRoutePath)
    bot.removeListener('entityDead', onDead)
    tt.close()
    if (session.tempo === tt) session.tempo = null
    mc.close()
    ctx.pvpSkills.closeEquipment()
    sky.close()
    ctx.calc.stop()
    blk.close()
    pearlResponse.close()
    bm.close()
    cx.close()
    mf.close()
    duo.close()
    util.close()
    vision.close()
    const human = hm && ctx.prof.player ? hm.report() : undefined
    if (hm) hm.close()
    if (st.spearCharges || st.spearSwaps) st.tricks[`копьё: разгонов ${st.spearCharges || 0}, попал ${st.spearChargeHits || 0}; смен копьё↔меч ${st.spearSwaps || 0}`] = 1
    const tricks = Object.keys(st.tricks).length ? st.tricks : undefined
    const ts = tt.stats
    { const gapEnd = gameClock.now() - quiet.at; if (gapEnd >= 10000) { quiet.gaps10++; quiet.total10 += gapEnd } if (gapEnd > quiet.longest) quiet.longest = gapEnd }
    // Отчёт — и в память демона (S7d): арена забирает его status { lastDuel }, если ответ fight опоздал или пуст
    // (s7d-base: у 2 из 5 раундов «элитр» пустые ROUND обеих сторон — стоп арены обгонял отчёт).
    if (out.strategicYield) out.strategicYield.returnedAt = gameClock.now()
    const rep = buildReport(out, tricks, human, ts)
    try { bot._ndLastDuel = { at: gameClock.wall.now(), foe: ctx.label, detail: rep } } catch {}
    return rep
  }
  function buildReport (out, tricks, human, ts) {
    return {
      pvp: ctx.prof.player || undefined,
      lastStand: ctx.lastStand || undefined,
      micro: true,
      quality: ctx.prof.player ? {
        gaps10: quiet.gaps10,
        quiet10S: Math.round(quiet.total10 / 100) / 10,
        longestS: Math.round(quiet.longest / 100) / 10,
        bothEatS: Math.round(ovl.ms / 100) / 10,
        bothEatN: ovl.n,
        bothEatOpenS: Math.round((ovl.openMs || 0) / 100) / 10,
        pearlSpace: st.pearlSpace || 0,
        build: st.build,
        eatPunish: st.eatPunish,
        eatHits: ts.busyByKind['ест/пьёт'] || 0,
        pressure: st.pressure || 0,
        maceAborts: st.maceAborts || 0,
        phases: human && human.фазы,
        showS: human ? Math.round(human.showMs / 100) / 10 : undefined,
        persona: human && human.нрав
      } : undefined,
      tempo: ctx.prof.player ? { on: tempo.ON, open: tt.opening || undefined, ate: ts.consumes, pressured: ts.pressured, aborted: ts.aborted, desperate: ts.desperate || undefined, refused: ts.refused || undefined, foeAte: ts.foeConsumes, busyHits: ts.busyLanded, busyBy: Object.keys(ts.busyByKind).length ? ts.busyByKind : undefined, punish: Object.keys(ts.punish).length ? ts.punish : undefined, breaches: ts.breaches || undefined, escapes: ts.breachEscapes || undefined, kites: ts.kites || undefined } : undefined,
      target: ctx.label,
      search: st.search,
      kills: kills.length ? kills : undefined,
      assessment: ctx.planText || undefined,
      arrows: st.arrows || undefined,
      blocks: st.blocks || undefined,
      style: st.style,
      arrowHits: st.arrows ? (st.arrowHits || 0) : undefined,
      towerShots: st.towerShots || undefined,
      holds: st.holds || undefined,
      returns: st.returns || undefined,
      gathered: st.gathered || undefined,
      mobKills: st.mobKills || undefined,
      swings: st.swings,
      landed: st.landed,
      crits: st.crits,
      sprintHits: st.sprintHits,
      axeOnShield: st.axeOnShield || undefined,
      hops: st.hops ? { tries: st.hops, ok: st.hopOk || 0, eff: st.hopEff || 0, why: st.hopWhy } : undefined,
      calc: st.calc ? { plans: st.calc.plans, kinds: st.calc.kinds, picks: st.calc.picks, gated: st.calc.gated, weapons: st.calc.weapons, last: st.calc.last, err: st.calcErr } : undefined,
      combos: combo.report(),
      vsShield: st.shield,
      storm: st.storm,
      breakUnder: st.breakUnder,
      blockLog: blk.report(),
      util: util.stats && (util.stats.trident || util.stats.riptide || util.stats.anvils || util.stats.boxes || util.stats.lava) ? { trident: util.stats.trident, tridentHit: util.stats.tridentHit, bolts: util.stats.bolts, riptide: util.stats.riptide, anvils: util.stats.anvils, boxes: util.stats.boxes, lava: util.stats.lava } : undefined,
      xbow: st.xbow && Object.keys(st.xbow).length ? st.xbow : undefined,
      rod: util.stats && (util.stats.rod || util.stats.hookedOnMe || util.stats.pulledMe) ? { casts: util.stats.rod, hooked: util.stats.rodHooked, hookedOnMe: util.stats.hookedOnMe, counter: util.stats.rodCounter, pulledMe: util.stats.pulledMe } : undefined,
      mace: mc.report(),
      elytra: sky.report(),
      pearlResponse: pearlResponse.report(),
      recoveryNodes: st.recoveryNodes,
      foodFire: foodFire.attempts ? foodFire : undefined,
      boom: bm.report(),
      crystal: cx.report(),
      melee: mf.report(),
      totem: totemMod.delta(opts.totem0, totemMod.snapshot(bot)),
      itemUse: bot._ndUse ? (() => { const s = bot._ndUse.stats; const b = use0 || {}; const df = k => (s[k] || 0) - (b[k] || 0); return { slowTicks: df('slowTicks'), sprintBlocked: df('sprintBlocked'), sprintNoFwd: df('sprintNoFwd'), sprintStops: df('sprintStops'), sprintStarts: df('sprintStarts'), wallStops: df('wallStops'), wallTicks: df('wallTicks') } })() : undefined,
      human,
      dodges: st.dodges || undefined,
      tricks,
      trickDmg: Object.keys(st.trickDmg).length ? st.trickDmg : undefined,
      healed: st.healed.length ? st.healed : undefined,
      weapon: ctx.weapon ? ctx.weapon.name : 'кулаки',
      hp: `${st.hpStart} -> ${Math.round(bot.health ?? 0)}`,
      left: leftovers(bot),
      ...out
    }
  }
}
