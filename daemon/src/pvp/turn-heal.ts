import * as flee from '../flee'
import { keyDir } from '../moves'
import * as tempo from '../tempo'
import * as totemMod from '../totem'
import { hasEffect, reachFrom, stepSafe } from './body'
import { findItem, findPotion, potionOf } from './potions'
import { COVER_MS, COVER_WIDE_MS, EYE, FIX, HIT_REACH, TICK_MS } from './rules'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Лечение по общей безопасности; наказание, если он открылся.
export async function recoverTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, ctl, drink, guard, holdItem, holdWeapon, pathTo, pvpSkills, st, useAt } = ctx
  const { medical, safeMedical, safety } = turn
  turn.punishAfterRecovery = false
  if (safety.action === 'recover' && safeMedical) {
    const recoveryOptions = { onPunish: () => { turn.punishAfterRecovery = true } }
    pathTo(false); ctx.pathing = false; clear()
    if (guard) await guard.raise(false)
    if (medical.name === 'splash_potion') {
      if (await holdItem(medical) && await useAt(bot.entity.yaw, -Math.PI / 2, { item: medical })) st.healed.push('взрывное лечения')
    } else if (medical.name === 'potion') await drink(medical, 'лечение до нового размена', null, recoveryOptions)
    else if (await pvpSkills.consumeItem(medical, null, recoveryOptions)) st.healed.push(medical.name)
    await holdWeapon()
    if (!turn.punishAfterRecovery || ctl.aborted || (bot.health ?? 0) <= 0) { await ctx.sleep(TICK_MS); return NEXT }
  }
}

// Надеть броню в бою.
export async function dressTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, ctl, itemInputs, session, used } = ctx
  const { theirR } = turn
  const dressInputs = [itemInputs(/_(helmet|chestplate|leggings|boots)$/), [5, 6, 7, 8].map(s => bot.inventory.slots[s]?.name).join(','), bot.entity.onGround, !!session._reflexState?.active].join('|')
  if ((!ctx.failedDress || ctx.failedDress.inputs !== dressInputs) && theirR > HIT_REACH + 1 && bot.inventory.items().some(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name))) {
    const worn = [5, 6, 7, 8].filter(s => bot.inventory.slots[s]).length
    // Элитры на груди, а я на земле (сел после полёта, нагрудник не вернулся) — тоже переодеться (S7d, ревью Codex
    // №2); в воздухе armor.planSwaps элитры не трогает.
    const wingsOnGround = bot.entity.onGround && !bot.entity.elytraFlying && bot.inventory.slots[6]?.name === 'elytra'
    if (worn < 4 || wingsOnGround) {
      try { const r = await require('../armor').equipBestArmor(session, ctl, { confirmMs: 300 }); if (r && r.equipped && r.equipped.length) used('надел броню в бою'); ctx.failedDress = r?.equipped?.length ? null : { inputs: dressInputs, why: 'armor_slot_unconfirmed' } } catch (error) { ctx.failedDress = { inputs: dressInputs, why: error.message } }
    }
  }
}

// Обновить баффы, когда безопасно.
export async function rebuffTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, buffUp, fortSealed, punishable, tt } = ctx
  const { busyFoe, pressing, theirR } = turn
  if (!turn.punishAfterRecovery && ctx.prof.player && !(FIX && (pressing || punishable())) && (tempo.ON ? tt.safe(tempo.consumeMs('potion'), { fortSealed: fortSealed() }).ok : (theirR > 5 || busyFoe || ctx.fort || ctx.perch))) {
    const KIND = { strength: 'strength', speed: 'swiftness', regeneration: 'regeneration' }
    const lack = (Object.entries(KIND) as [string, any][]).some(([e, k]) => !hasEffect(bot, e) &&
      findItem(bot, i => /potion$/.test(i.name) && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k))
    if (lack) await buffUp(ctx.fort || ctx.perch ? 0 : 4.5, ctx.fort ? [['turtle_master', 'resistance']] : [])
  }
}

// Левая рука: тотем или щит.
export async function offhandTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, guard, mc, tot, used } = ctx
  const { now, theirR } = turn
  if (now >= ctx.totemAt) {
    ctx.totemAt = now + 250
    const offIt = bot.inventory.slots[45]
    const offN = offIt ? offIt.name : null
    const mt = ctx.prof.player ? mc.threat() : null
    const wt = totemMod.wantTotem(bot, { entity: ctx.entity, maceThreat: mt && mt.mace ? mt : null, theirR })
    if (wt.yes && offN !== 'totem_of_undying' && now - tot.lastSwitch > 400 && findItem(bot, i => i.name === 'totem_of_undying')) {
      if (tot.equip('заранее: ' + wt.why)) { tot.preempt++; used('тотем в левую руку: ' + wt.why) }
    } else if (!wt.yes && offN === 'totem_of_undying' && guard && guard.stats && guard.stats.have &&
        wt.hp >= 2 * wt.burst + 8 && !bot.currentWindow) {
      const sh = findItem(bot, i => i.name === 'shield')
      if (sh) { tot.lastSwitch = now; tot.shieldBack++; try { await bot.equip(sh, 'off-hand'); used('щит обратно в левую руку') } catch {} }
    }
  }
}

// Коробка на низком хп.
export async function fortTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, cx, fortOut, fortPossible, healAt, healItem, style, tt } = ctx
  const { busyFoe, d, hp, meInWeb, theirR, theyBow } = turn
  const archer = turn.archer = theyBow || ctx.prof.ranged
  turn.calmHeal = busyFoe && d > 3.5 && hp < 16 && !!healItem()
  const mobCrowd = !ctx.prof.player && (flee.hostilesAround(bot, 8).length >= 2 || hp <= 8)
  const needSafeEat = tempo.ON && ctx.prof.player && hp <= healAt && !!healItem() && !tt.safe(tempo.consumeMs('golden_apple')).ok
  if (!ctx.lastStand && !ctx.fort && hp <= style.fortAt && !busyFoe && !meInWeb && !ctx.perch && !cx.dominant() &&
      (ctx.prof.player ? (theirR < 7 || archer || needSafeEat) && theirR > 2.2 : mobCrowd) && fortPossible()) {
    if (await fortOut()) return NEXT
  }
}

// Лечение и еда в бою.
export async function healTurn (ctx: DuelCtx, turn: TurnFrame) {
  if (ctx.bot.entity?.effects && await require('./antidotes').antidoteTurn(ctx, turn)) return NEXT
  const { bot, clear, coverFrom, ctl, drink, healAt, holdItem, holdWeapon, pathTo, placeUnder, punishable, pvpSkills, ready, rest, routeInputs, set, st, tt, useAt, used } = ctx
  const { archer, calmHeal, d, hp, meInWeb, pressing, seesBody, theirR, theyUp, webSafe } = turn
  if (!turn.punishAfterRecovery && (hp <= healAt + (archer ? 3 : 0) || calmHeal)) {
    if (calmHeal && hp > healAt + (archer ? 3 : 0) && ready('calmNote')) { rest('calmNote', 5000); used('лечусь, пока он занят') }
    const splash = findPotion(bot, 'splash_potion', 'heal')
    if (splash && await holdItem(splash) && await useAt(bot.entity.yaw, -Math.PI / 2, { item: splash })) {
      used('лечение под ноги'); st.healed.push('взрывное лечения')
      await holdWeapon()
      return NEXT
    }
    const absorbing = hasEffect(bot, 'absorption')
    const desperate = tempo.ON && ctx.prof.player && hp <= 6 && ((meInWeb && !webSafe) || st.cornered?.inputs === routeInputs())
    const turtle = desperate ? findItem(bot, i => i.name === 'potion' && /turtle_master$/.test(potionOf(i) || '')) : null
    const gapple = findItem(bot, i => i.name === 'enchanted_golden_apple') ||
      (!absorbing && findItem(bot, i => i.name === 'golden_apple'))
    const potion = findPotion(bot, 'potion', 'heal') || findPotion(bot, 'potion', 'regen')
    const food = !gapple && !potion && (bot.food ?? 20) < 18 &&
      findItem(bot, i => /cooked_|bread|baked_potato|golden_carrot/.test(i.name))
    const punFirst = FIX && !desperate && hp > 8 && !!punishable()
    if (punFirst) { st.eatPunish.skips = (st.eatPunish.skips || 0) + 1; if (ready('punFirstNote')) { rest('punFirstNote', 3000); used('не ем — он сам ест или пьёт, наказываю') } }
    const candidate = punFirst ? null : (desperate && (findItem(bot, i => i.name === 'enchanted_golden_apple') || turtle)) || gapple || potion || food
    const pick = ctx.lastStand && candidate && !tt.safe(tempo.consumeMs(candidate.name)).ok ? null : candidate
    if (pick && !(ctx.failedHealSpace?.inputs === routeInputs() && !tt.safe(tempo.consumeMs(pick.name)).ok && !desperate)) {
      const web = findItem(bot, i => i.name === 'cobweb')
      let walled = 0
      if (web && theirR < 4.5 && !archer) { await placeUnder(web, 'паутина перед едой') }
      else if ((theirR < 5 || archer || (FIX && seesBody && d < 24)) && !theyUp && (!FIX || desperate || tt.safe(tempo.consumeMs(pick.name) + (archer ? COVER_WIDE_MS : COVER_MS)).ok)) {
        walled = await coverFrom(ctx.entity.position, archer
          ? { wide: true, what: 'стенка 3×2 от лучника перед едой' }
          : { what: 'колонка перед едой' })
      }
      // Толпа: оторваться от троих поесть не выйдет — бег под ударами всех (try-crowd b5: «не ем под ударами —
      // отрываюсь» ×5 за раунд, 0–2 удара за 20 с). Золотое яблоко и зелье — есть под ударами: за 1.6 с толпа снимает ~3,
      // яблоко даёт ~8 (поглощение 4 + регенерация II 5 с; L5c без яблок жил 10.9 с против 20.3 у «до», который ел).
      // Простая еда под ударами — нет: бьюсь.
      if (ctx.crowd?.on && !desperate && !tt.safe(tempo.consumeMs(pick.name)).ok && !/golden_apple|potion/.test(pick.name)) { tt.stats.refused++; return }
      if (tempo.ON && ctx.prof.player && !desperate && !ctx.crowd?.on && !tt.safe(tempo.consumeMs(pick.name)).ok) {
        tt.stats.refused++
        if (ready('refuseNote')) { rest('refuseNote', 3000); used('не ем под ударами — отрываюсь') }
        let how = 'в паутине'
        if (FIX && pressing && hp > 8) how = 'нажим'
        else if (!meInWeb) {
          pathTo(false); ctx.pathing = false
          clear()
          ctx.aim = 'free'
          how = await tempo.kite(bot, ctl, tt.threats, {
            ms: 1800,
            until: () => tt.safe(tempo.consumeMs(pick.name)).ok,
            stop: () => ctx.entity.isValid && reachFrom(ctx.entity.position.offset(0, EYE, 0), bot.entity) <= tempo.PLAYER_REACH
          })
          ctx.aim = 'target'
          tt.stats.kites++
          if (how === 'некуда' || how === 'догнал') st.cornered = { inputs: routeInputs(), why: how }
        }
        if (how !== 'оторвался') {
          ctx.failedHealSpace = { inputs: routeInputs(), why: how }
          st.kiteFails = (st.kiteFails || 0) + 1
          if (st.kiteFails >= 2) st.kiteFails = 0
          await holdWeapon()
          return NEXT
        }
        st.kiteFails = 0
        ctx.failedHealSpace = null
      }
      if (desperate && ready('desperateNote')) { rest('desperateNote', 4000); used('прижат на ' + Math.round(hp) + ' хп — ем под ударами ' + pick.name) }
      pathTo(false); ctx.pathing = false
      clear()
      if (!(archer && walled)) {
        set('back', stepSafe(bot, keyDir(bot, 'back')))
        set(ctx.strafeKey, stepSafe(bot, keyDir(bot, ctx.strafeKey)))
      }
      const recoveryOptions = { desperate, onPunish: () => { turn.punishAfterRecovery = true } }
      const consumed = pick.name === 'potion' ? await drink(pick, 'выпил ' + (potionOf(pick) || 'зелье'), null, recoveryOptions)
        : await pvpSkills.consumeItem(pick, null, recoveryOptions)
      if (consumed && pick.name !== 'potion') { used('съел ' + pick.name); st.healed.push(pick.name) }
      clear()
      await holdWeapon()
      if (consumed || ctl.aborted || (bot.health ?? 0) <= 0) return NEXT
    }
  }
}
