import * as gameClock from '../game-clock'
import * as mace from '../mace'
import { thundering } from '../perception'
import * as spear from '../spear'
import { rodChance } from '../utility/rod'
import { findItem } from './potions'
import { TICK_MS } from './rules'
import { type DuelCtx, type TurnFrame } from './turn'

// Граф боя раз в 5 тиков: план калькулятора и длинные приёмы.
export async function fightGraphTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { GRAPH, bot, co, fg, foe, holdWeapon, ready, rest, sky, skyOver, st, traceT0 } = ctx
  const { d, dy, hp, now } = turn
  // Граф боя (S7d): раз в 5 тиков — план калькулятора (kill-planner: удар/крит/топор/копьё/булава/арбалет/лук/удочка/
  // трезубец/кристалл/якорь) и длинные приёмы (таран, пике) → лучший по чистому урону в секунду; ветки ниже
  // исполняют приём, только если граф его не отверг (gate). Ближнее оружие — по урону в секунду против его брони.
  if (ctx.prof.player && ready('calcPlan')) {
    rest('calcPlan', 5 * TICK_MS)
    try {
      const obs = co.observe(bot, ctx.entity, { tracker: ctx.calc, since: Math.round((now - ctx.lastSwing) / TICK_MS), shieldOffTicks: Math.round((foe.shieldOff(ctx.entity) || 0) / TICK_MS) })
      obs.storm = thundering(bot)
      obs.foeSky = obs.storm ? skyOver(ctx.entity) : false
      // Булава с падения: взлёт зарядом ветра — подъём и спуск ~28 тиков, высота по потолку (mace.smashPlan).
      try { const smp = findItem(bot, i => i.name === 'mace') ? mace.smashPlan(bot, ctx.entity) : null; if (smp) obs.smash = { h: smp.h, ticks: 28 } } catch {}
      const cp = require('./kill-planner').planAttack(obs, { depth: 3, pHit: { rod: rodChance(bot, ctx.entity) } })
      const opts = []
      // У экземпляра elytra.create нет ON (флаг ND_ELYTRA — у модуля): проверка всегда истинна; поведение не трогаю.
      if (GRAPH && sky.ON !== false) {
        const sp0 = spear.spearOf(bot)
        if (sp0 && require('../combat/aerial-lance').lancePlan(bot, ctx.entity, { d, hp, hisShield: obs.foe.blocking })) opts.push(fg.lanceOption(obs, sp0.item.name, bot._ndFightXp || (bot._ndFightXp = {})))
        // Считать только доступное пике: тот же план и пауза, что у исполнителя.
        const hisShield = [obs.foe.main, obs.foe.off].some(i => i?.name === 'shield') && !(foe.shieldOff(ctx.entity) > 1500)
        const dv = sky.planDive({ d, dy, hp, foeGrounded: ctx.foeGrounded(), hisShield })
        if (dv) opts.push(fg.diveOption(obs, 12, bot._ndFightXp || (bot._ndFightXp = {})))
      }
      ctx.gp = fg.decide(obs, cp, opts)
      st.calc = st.calc || { plans: 0, kinds: {} }
      st.calc.plans++
      if (cp && cp.action) {
        st.calc.kinds[cp.action.kind] = (st.calc.kinds[cp.action.kind] || 0) + 1
        st.calc.last = { why: cp.why, pKill: cp.pKill != null ? Math.round(cp.pKill * 100) / 100 : null, hp: cp.hp ? [Math.round(cp.hp.lo), Math.round(cp.hp.hi)] : null, graph: ctx.gp.why }
      }
      if (ctx.gp.pick) { st.calc.picks = st.calc.picks || {}; st.calc.picks[ctx.gp.pick] = (st.calc.picks[ctx.gp.pick] || 0) + 1 }
      if (GRAPH) {
        const mc0 = fg.meleeChoice(obs)
        // Щит: топор — ударом-свапом в тик удара (melee.FAST_AXE, заряд меча не теряется), не сменой в руке.
        const want = mc0 && !mc0.shield ? mc0.item : null
        if (want && want !== ctx.chosenWeapon) {
          ctx.chosenWeapon = want
          st.calc.weapons = st.calc.weapons || {}
          st.calc.weapons[want] = (st.calc.weapons[want] || 0) + 1
          // Сменить в руке, только если сейчас в руке меч/топор/пусто (копьё, булава, удочка — у своих веток).
          const hn = bot.heldItem ? bot.heldItem.name : null
          if (!hn || /_(sword|axe)$/.test(hn)) await holdWeapon()
        }
      }
      // След решения — в трассу боя (не в used: метка не должна перехватывать урон приёма в trickDmg).
      if (process.env.ND_TRACE_PVP && ctx.gp.pick && ctx.gp.pick !== st.lastPick) {
        st.lastPick = ctx.gp.pick
        try { console.log(`[trace] ${new Date().toISOString().slice(11, 19)} ${bot.username} +${((gameClock.now() - traceT0) / 1000).toFixed(1)}s граф: ${ctx.gp.why} | ${ctx.gp.scores.slice(0, 3).map(x => x.kind + ' ' + x.value).join(', ')}`) } catch {}
      }
    } catch (err) { st.calcErr = String(err && err.message || err).slice(0, 120) }
  }
}
