import * as assess from '../assess'
import * as tempo from '../tempo'
import * as throwMod from '../throw'
import { countOf, findItem, potionOf, potionRole } from './potions'
import { BOX_FRONT_MS, FIX } from './rules'
import { type DuelCtx } from './turn'

// Начало боя: план против мобов, оружие, щит, дебют по темпу.
export async function openDuel (ctx: DuelCtx) {
  const { bot, buildHot, clearArea, fortOut, fortPossible, guard, healItem, heldName, holdItem, holdWeapon, leadFn, opts, pickWeaponFor, pvpSkills, rangedAllowed, retarget, st, style, tt, used } = ctx
  if (!ctx.prof.player) {
    try {
      const p = assess.plan(bot, { radius: clearArea || 16 })
      if (p) {
        ctx.planText = p.text
        ctx.planVerdict = p.verdict
        if (clearArea && p.first && p.first.e && p.first.e !== ctx.entity) retarget(p.first.e)
      }
    } catch {}
    pickWeaponFor(ctx.entity)
  }

  await holdWeapon()
  if (guard) await guard.wear()
  if (process.env.ND_DEBUG_PVP) console.log('[pvp] start', JSON.stringify({ t: ctx.label, held: heldName(), inv: bot.inventory.items().map(i => `${i.name}×${i.count}`) }))

  const buffUp = ctx.buffUp = (...args: any[]) => pvpSkills.buffUp(...args)
  if (tempo.ON && ctx.prof.player && !ctx.lastStand) {
    // Арена зовёт бой кусками по 3 с: пауза дебюта (до 1.2 с) против толпы — стоять под ударами в начале каждого куска.
    if (!(require('./turn-crowd').ON && (opts.targets || []).length >= 3)) await ctx.sleep(style.openDelayMs)
    const drinkable = k => findItem(bot, i => i.name === 'potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k)
    const d0 = ctx.entity.position.distanceTo(bot.entity.position)
    const plan = tempo.pickOpening({
      d: d0,
      hp: bot.health ?? 20,
      aggression: style.aggression,
      foeBusy: !!tt.state(ctx.entity).consuming,
      has: {
        bow: rangedAllowed() && !!((findItem(bot, i => i.name === 'bow') && findItem(bot, i => /arrow$/.test(i.name))) ||
          (findItem(bot, i => i.name === 'crossbow') && findItem(bot, i => /arrow$|^firework_rocket$/.test(i.name)))),
        drinkBuffs: ['strength', 'swiftness', 'regeneration'].some(k => drinkable(k)),
        splashDebuff: !!findItem(bot, i => i.name === 'splash_potion' && potionRole(potionOf(i)) === 'debuff'),
        pearls: countOf(bot, 'ender_pearl'),
        fort: fortPossible() && !(FIX && buildHot(BOX_FRONT_MS)),
        heal: !!healItem()
      }
    })
    tt.opening = plan.kind
    st.style.начало = plan.kind
    used('начало: ' + ({ rush: 'рывок', bow: 'лук издалека', buff: 'баффы', splash: 'зелья в него', pearl: 'жемчуг к нему', fort: 'коробка с баффами' })[plan.kind])
    if (plan.kind === 'buff') await buffUp(0)
    else if (plan.kind === 'rush') ctx.rushActive = true
    else if (plan.kind === 'splash') ctx.splashFirst = true
    else if (plan.kind === 'pearl') {
      const pearl = findItem(bot, i => i.name === 'ender_pearl')
      ctx.aim = 'free'
      const pr = pearl && (await holdItem(pearl))
        ? await throwMod.throwAt(bot, leadFn(0.1), {
          item: bot.heldItem,
          onAim: (res) => !!(res.land && !res.land.void && throwMod.safeLanding(bot, res.land.tp) && res.land.tp.y > bot.entity.position.y - 5)
        }).catch(() => null)
        : null
      ctx.aim = 'target'
      if (pr && pr.thrown) { used('жемчуг к нему'); await ctx.sleep(800) }
      await holdWeapon()
      ctx.rushActive = true
    } else if (plan.kind === 'fort') {
      if (!(await fortOut())) await buffUp(0)
    }
  } else if (!ctx.lastStand) await buffUp()
}
