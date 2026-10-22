import * as read from '../read'
import * as tempo from '../tempo'
import { findItem, potionOf, potionRole } from './potions'
import { HIT_REACH, TICK_MS } from './rules'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Наказание занятого: зелье вреда, рывок, стрела, шаг.
export async function punishTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { blastRetreat, bot, cx, holdWeapon, ready, rest, st, throwAt, tt, used } = ctx
  const { cooldownLeft, d, meInWeb, r, seesBody } = turn
  turn.punRush = false
  turn.punStep = false
  turn.punBow = false
  if (tempo.ON && ctx.prof.player && !meInWeb && !ctx.perch) {
    const harm = findItem(bot, i => i.name === 'splash_potion' && /harming$/.test(potionOf(i) || ''))
    const pun = tt.punish(ctx.entity, {
      d, r, sees: seesBody, hitReach: HIT_REACH,
      has: { harm: !!harm, bow: !cx.dominant() && !!(findItem(bot, i => i.name === 'bow') && findItem(bot, i => /arrow$/.test(i.name))) }
    })
    if (pun) {
      const cEat = /^он (ест|пьёт)$/.test(pun.why) ? tt.state(ctx.entity).consuming : null
      if (cEat && cEat.since !== st.eatPunish.at) { st.eatPunish.at = cEat.since; st.eatPunish.tries++ }
      if (ready('punNote:' + pun.kind)) {
        rest('punNote:' + pun.kind, 2500)
        tt.punished(pun.kind)
        used(`наказываю (${pun.why}): ${({ harm: 'зелье вреда', rush: 'рывок', bow: 'стрела', step: 'шаг внутрь' })[pun.kind]}`)
      }
      if (pun.kind === 'harm' && harm) {
        if (await throwAt(harm, 'зелье вреда в занятого')) { await holdWeapon(); return NEXT }
      }
      // «Вред» брошен — рывок к нему только когда бутылка разбилась (S7d: репетиция «арсенал» — бросок и сразу рывок
      // «на занятого» в зону всплеска своего «вреда II»: «killed by … using magic»; ревью Codex по jar — всплеск
      // задевает и бросившего, щит зелье не отражает).
      turn.punRush = pun.kind === 'rush' || (pun.kind === 'harm' && !blastRetreat())
      turn.punBow = pun.kind === 'bow'
      turn.punStep = pun.kind === 'step' && cooldownLeft < pun.left
    }
  }
}

// Зелье в него первым.
export async function potionFirstTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, guard, holdWeapon, opts, throwAt } = ctx
  const { d, seesBody } = turn
  if (opts.potionFirst && ctx.prof.player && seesBody && d >= 4.5 && d <= 7) {
    const effNow = read.effectsOf(bot, ctx.entity)
    const bad = findItem(bot, i => i.name === 'splash_potion' && potionRole(potionOf(i)) === 'debuff' && !effNow.has((potionOf(i) || '').replace(/^(long|strong)_/, '')))
    if (bad) {
      if (guard) await guard.raise(false)
      if (await throwAt(bad, 'зелье в него: ' + (potionOf(bad) || '?'))) { await holdWeapon(); return NEXT }
    }
  }
}

// Утилиты: удочка, трезубец, наковальни, коробки.
export async function utilTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { ctl, duo, foeHpDecide, gate, holdWeapon, tt, util } = ctx
  const { blocking, d, dy, hp, meInWeb, r, seesBody, theyUp } = turn
  if (ctx.prof.player && !ctx.perch && !ctx.fort && !meInWeb) {
    ctx.aim = 'free'
    const ua = await util.step({ entity: ctx.entity, d, dy, r, hp, foeHp: foeHpDecide(ctx.entity), sees: seesBody, theyUp, blocking, busy: tt.state(ctx.entity), vel: () => ctx.track.vel(), others: duo.foes().filter(e => e !== ctx.entity), ctl, allow: (k) => gate(k) })
    ctx.aim = 'target'
    if (ua) { if (ua.rush) ctx.rushActive = true; await holdWeapon(); return NEXT }
  }
}

// Показ: приёмы на публику.
export async function showmanTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, hm, otherAttacker } = ctx
  const { aimedCb, blocking, busyFoe, cbShield, cooldownLeft, d, dy, hp, inc, meInWeb, now, pressing, r, seesBody, theirHp, theirR, theyBow } = turn
  // Толпа (turn-crowd): жест или финт на публику против троих и больше — удар в спину от остальных.
  if (hm && ctx.prof.player && !ctx.crowd?.on && bot.entity.onGround && !bot.entity.elytraFlying && (await hm.pre({
    now, d, dy, r, theirR, hp, theirHp, theyBow, blocking, seesBody, busyFoe, meInWeb, cooldownLeft,
    perch: !!ctx.perch, fort: !!ctx.fort, incoming: inc.length, vel: ctx.track.vel(), others: !!otherAttacker(),
    openRush: ctx.rushActive, punRush: turn.punRush, cbAimed: !!aimedCb || cbShield, press: pressing
  }))) { await ctx.sleep(TICK_MS); return NEXT }
}
