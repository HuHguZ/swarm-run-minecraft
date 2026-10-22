import * as gameClock from '../game-clock'
import { looksAtBody } from '../gestures'
import * as mace from '../mace'
import { keyDir } from '../moves'
import * as pick from '../pick'
import * as read from '../read'
import * as tempo from '../tempo'
import * as throwMod from '../throw'
import { stepSafe } from './body'
import { findItem, potionOf } from './potions'
import { HIT_REACH, TICK_MS, cooldownMs } from './rules'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Булава сверху: тотем, щит, жемчуг или бег.
export async function maceDefenseTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, guard, holdWeapon, mc, pathTo, pvpSkills, ready, rest, set, st, used } = ctx
  const { hp, now, r } = turn
  const maceThreat = ctx.prof.player ? mc.threat() : null
  if (maceThreat && !ctx.maceTotem && bot.inventory.slots[45]?.name !== 'totem_of_undying' && bot.heldItem?.name !== 'totem_of_undying') {
    const tt0 = findItem(bot, i => i.name === 'totem_of_undying')
    if (tt0) { ctx.maceTotem = true; bot.equip(tt0, 'hand').then(() => used('тотем в правую руку: булава сверху')).catch(() => { ctx.maceTotem = false }) }
  }
  if (!maceThreat && ctx.maceTotem) {
    ctx.maceTotem = false
    if (bot.heldItem?.name === 'totem_of_undying') await holdWeapon()
  }
  if (maceThreat) {
    if (ctx.pathing) { pathTo(false); ctx.pathing = false }
    ctx.aim = 'target'
    const shieldOk = !!(guard && guard.stats && guard.stats.worn) && (maceThreat.eta >= 6 || maceThreat.shielded)
    let how = null
    if (maceThreat.kind === 'above' || shieldOk) {
      how = mace.defend(bot, maceThreat, { guard, entity: ctx.entity, vel: () => ctx.track.vel(), set, keyDir, stepSafe: dir => stepSafe(bot, dir), stats: mc.st })
    } else {
      const pearlOut = findItem(bot, i => i.name === 'ender_pearl')
      if (pearlOut && pvpSkills.itemReady(pearlOut) && maceThreat.eta >= 12 && hp > 7) {
        ctx.aim = 'free'
        const foeAt = ctx.entity.position.clone()
        const pr = await pvpSkills.throwPearl(null, {
          jump: 'auto',
          pick: throwMod.escapePick(bot, tp => Math.min(24, Math.hypot(tp.x - foeAt.x, tp.z - foeAt.z)), { minDist: 6, maxDrop: 4 })
        })
        ctx.aim = 'target'
        if (pr && pr.thrown) { how = 'жемчуг из-под булавы'; mc.st.dodges++ }
        const tt1 = findItem(bot, i => i.name === 'totem_of_undying')
        if (tt1 && bot.inventory.slots[45]?.name !== 'totem_of_undying') await bot.equip(tt1, 'hand').catch(() => {})
      }
      if (!how) {
        ctx.aim = 'away'
        const fwd = keyDir(bot, 'forward')
        if (stepSafe(bot, fwd)) {
          for (const x of ['back', 'left', 'right']) set(x, false)
          set('forward', true); set('sprint', (bot.food ?? 20) > 6); set('jump', false)
          how = 'бегу из-под булавы'
          if (!maceThreat.dodged) { maceThreat.dodged = true; mc.st.dodges++ }
        } else {
          ctx.aim = 'target'
          how = mace.defend(bot, maceThreat, { guard, entity: ctx.entity, vel: () => ctx.track.vel(), set, keyDir, stepSafe: dir => stepSafe(bot, dir), stats: mc.st })
        }
      }
    }
    if (how && ready('maceDef:' + how)) { rest('maceDef:' + how, 2500); used(how) }
    if (how !== 'щит к булаве сверху' && maceThreat.kind === 'air' && now >= ctx.nextReady && r <= HIT_REACH && pick.canHit(bot, ctx.entity, { range: HIT_REACH })) {
      try { bot.attack(ctx.entity) } catch {}
      st.swings++
      mc.st.counterHits++
      ctx.lastSwing = gameClock.now()
      ctx.nextReady = ctx.lastSwing + cooldownMs(bot.heldItem)
      used('ударил его в полёте')
    }
    await ctx.sleep(TICK_MS)
    return NEXT
  }
}

// Заряд ветра: оттолкнуть.
export async function windPushTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, guard, holdWeapon, mc, used, windInputs } = ctx
  const { blocking, cooldownLeft, d, me, meInWeb, seesBody, theyBow, theyEat, theyUp } = turn
  if (ctx.prof.player && !ctx.perch && !ctx.fort && !meInWeb) {
    const vv = ctx.track.vel()
    const closingNow = (vv.x * (me.x - ctx.entity.position.x) + vv.z * (me.z - ctx.entity.position.z)) / Math.max(d, 0.1)
    const pp = mace.pushPlan(bot, ctx.entity, { sees: seesBody, theyUp, busy: theyEat ? 'ест или пьёт' : theyBow ? 'тянет лук' : null, closing: closingNow, cooldownLeft, blocking })
    if (pp && (!ctx.failedWindPush || ctx.failedWindPush.inputs !== windInputs())) {
      if (guard) await guard.raise(false)
      ctx.aim = 'free'
      const wr = await mace.windPush(bot, ctx.entity, { vel: () => ctx.track.vel(), swap: true })
      ctx.aim = 'target'
      ctx.failedWindPush = wr.fired ? null : { inputs: windInputs(), why: wr.why || 'wind_not_fired' }
      if (wr.fired) {
        mc.notePush(ctx.entity, pp.why)
        used('заряд ветра: ' + pp.why)
        ctx.nextReady = Math.max(ctx.nextReady, gameClock.now() + cooldownMs(bot.heldItem))
        await holdWeapon()
        return NEXT
      }
    }
  }
}

// Сближение; подготовка удара булавой (паутина, медлительность).
export async function smashSetupTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, foeGrounded, holdWeapon, placeUnder, throwAt } = ctx
  const { busyFoe, d, hp, inWeb, me, meInWeb, r, theyEat } = turn
  const vel = ctx.track.vel()
  turn.closing = (vel.x * (me.x - ctx.entity.position.x) + vel.z * (me.z - ctx.entity.position.z)) / Math.max(d, 0.1)

  turn.smashSetup = false
  if (ctx.prof.player && !ctx.perch && !ctx.fort && !meInWeb && hp > 6 && mace.smashPlan(bot, ctx.entity)) {
    const pinned = inWeb || busyFoe || theyEat || read.effectsOf(bot, ctx.entity).has('slowness')
    if (!pinned) {
      const webS = findItem(bot, i => i.name === 'cobweb')
      const slowS = findItem(bot, i => i.name === 'splash_potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === 'slowness')
      if (webS && r < 4.2 && foeGrounded()) {
        if (await placeUnder(webS, 'булава: сначала паутина под него')) { turn.smashSetup = true; await holdWeapon(); return NEXT }
      } else if (slowS && d > 2.5 && d < 7) {
        if (await throwAt(slowS, 'булава: сначала медлительность в него')) { turn.smashSetup = true; await holdWeapon(); return NEXT }
      }
    }
  }
}

// Взлёт зарядом ветра и удар булавой с падения.
export async function smashTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, ctl, duo, gate, guard, holdWeapon, maceChain, mc, pendingLava, ready, rest, st, telemetryHp, tt, used, windInputs } = ctx
  const { aimedCb, hp, meInWeb, now, theirR, theyBow } = turn
  if (!turn.smashSetup && ctx.prof.player && !ctx.perch && !ctx.fort && !meInWeb && hp > 6 && !pendingLava.length) {
    const fsM = tt.foes.get(ctx.entity.id)
    const handM = ctx.entity.equipment && ctx.entity.equipment[0] ? ctx.entity.equipment[0].name : ''
    const readyM = fsM && fsM.swungAt ? Math.max(0, fsM.swungAt + tempo.swingCooldownMs(handM) - now) : 0
    // Его удар и лук собьют взлёт, только если они в меня: в толпе (рой на сильного, стенд 21.10) он бьёт и целится в другого,
    // а взлёт отменялся по любому его взмаху и натянутому луку — «не взлетаю» 31 раз за шесть раундов, удар с падения — дважды.
    const atMe = looksAtBody(bot, ctx.entity, 0.8)
    const hitSoon = atMe && ((theirR <= tempo.PLAYER_REACH && readyM < 2 * TICK_MS) || theyBow) || !!aimedCb || (duo.active() && duo.secondThreat())
    const sp0 = hitSoon ? null : mace.smashPlan(bot, ctx.entity)
    // Взлёт с булавой — если граф (калькулятор: булава с падения против удара/топора/копья) его не отверг.
    const sp = sp0 && gate('smash') ? sp0 : null
    if (hitSoon && ready('smashWaitNote') && mace.smashPlan(bot, ctx.entity)) { rest('smashWaitNote', 4000); used('булава: не взлетаю — его удар или выстрел собьёт взлёт') }
    // Булава и заряд есть, а взлёта нет — почему (smashCheck), раз в 4 с: отказ молчал, и взлётов за раунд было по одному.
    else if (!sp0 && ready('smashWhyNote') && findItem(bot, i => i.name === 'mace')) { const why = mace.smashCheck?.(bot, ctx.entity)?.why; if (why) { rest('smashWhyNote', 4000); used('булава: не взлетаю — ' + why) } }
    if (sp && (!ctx.failedSmash || ctx.failedSmash.inputs !== windInputs(ctx.failedSmash.native))) {
      const first = maceChain.choose(bot.entity.position.y, true)
      if (first) maceChain.onTarget(first)
      if (guard) await guard.raise(false)
      clear()
      ctx.aim = 'free'
      const res = await mace.windSmash(bot, ctl, ctx.entity, {
        chain: maceChain,
        vel: () => ctx.track.vel(),
        stats: mc.st,
        telemetryHp,
        stillOk: () => ctx.entity.isValid && Math.hypot(ctx.entity.position.x - bot.entity.position.x, ctx.entity.position.z - bot.entity.position.z) < 4.6 && !mace.shieldAtUs(bot, ctx.entity)
      })
      ctx.aim = 'target'
      ctx.failedSmash = res.hit ? null : { inputs: windInputs(!res.launched), native: !res.launched, why: res.why || (res.launched ? 'missed_landing' : 'launch_not_confirmed') }
      if (res.swung) { st.swings++; ctx.lastSwing = gameClock.now() }
      if (res.launched && !res.hit) { st.smashMiss = (st.smashMiss || 0) + 1; if (st.smashMiss >= 2) { st.smashMiss = 0 } } else if (res.hit) st.smashMiss = 0
      if (!res.aborted) used(res.hit ? 'булава: удар с падения' : res.launched ? 'булава: взлёт, не достал' : res.cancelled ? (res.note || 'булава: передумал взлетать') : 'булава: не взлетел' + (res.why ? ` (${res.why.split(', ')[0]})` : ''))
      if (!res.launched && res.why && /в паутине/.test(res.why)) used('булава: взлёт в паутине не поднял (проверка перед взлётом пропустила)')
      if (res.retry) used(`булава: второй заряд стоя — взлетел (первый: ${res.retry.split(', ')[0]})`)
      if (res.why && !res.launched) console.log('[mace] не взлетел:', res.why)
      if ((res.self || 0) > 3) console.log('[mace]', res.note)
      if (process.env.ND_DEBUG_PVP) console.log('[mace]', res.note)
      await holdWeapon()
      return NEXT
    }
  }
}
