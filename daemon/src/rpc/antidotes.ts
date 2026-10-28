import type { RpcContext } from './context'
import { eat } from '../actions/food'
import { chooseAntidote, ownAntidoteState, finishAntidote } from '../pvp/antidotes'
import { seesPlayer } from '../pvp/last-seen'
import { usingItem } from '../pvp/body'
import * as pick from '../pick'
import * as tempo from '../tempo'
import * as dm from '../pvp/damage-model'
import * as read from '../read'
import * as clock from '../game-clock'

const ANTIDOTES = ['honey_bottle', 'milk_bucket']
const matches = (e: any, id: any) => e.id === id || e.username === id
const owned = (bot: any, name: string) => [...new Set<any>([...bot.inventory.items(), bot.inventory.slots?.[45]])]
  .reduce((sum, item) => sum + (item?.name === name ? item.count : 0), 0)

// Public shield overlap is a price input, not proof that a future hit will be blocked.
function covers(bot: any, guard: any, foe: any): boolean {
  if (!guard || guard === bot.entity || !seesPlayer(bot, guard) || usingItem(bot, guard) !== 'shield') return false
  if (!dm.shieldBlocks({ raised: true, angle: dm.shieldAngle(guard.yaw, guard.position, foe.position) })) return false
  const origin = foe.position.offset(0, pick.eyeHeight(bot, foe), 0)
  const delta = pick.eyeOf(bot).minus(origin), length = delta.norm()
  const box = pick.hitboxOf(bot, guard)
  const t = length > 0 && pick.rayBox(origin, delta.scaled(1 / length), box.lo, box.hi, length)
  return typeof t === 'number' && t > 0 && t < length
}

export function antidoteMethods({ session }: RpcContext) {
  return {
    antidote_pause: () => session.immediate(() => {
      const bot = session.require(), current = session.current
      if (bot._ndAntidoteDrinking) return { ready: false, why: 'drinking' }
      if (bot._ndHandLock?.on() || bot._ndClutch?.lastDecision?.action === 'clutch' ||
          ['fly_to', 'pearl_to'].includes(current?.name) && current?.params?.rescue && current.ctl && !current.ctl.aborted) {
        return { ready: false, why: 'rescuing' }
      }
      session.cancel('antidote_transfer')
      return { ready: true }
    }),
    antidote: async (p: any = {}) => session.runIntent('antidote', async (ctl: any) => {
      const bot = session.require(), entity = bot.entity
      if (p.item !== undefined && !ANTIDOTES.includes(p.item) ||
          ['allies', 'enemies'].some(key => p[key] !== undefined && (!Array.isArray(p[key]) || p[key].length > 128 || p[key].some(id => !['string', 'number'].includes(typeof id))))) {
        return { consumed: false, item: null, why: 'invalid_antidote' }
      }
      const allies = p.allies || [], initialId = entity?.id
      const foes = () => (Object.values(bot.entities || {}) as any[]).filter(e => e && e !== bot.entity &&
        (e.type === 'player' || e.username) && e.isValid !== false && !allies.some(id => matches(e, id)) &&
        (!p.enemies?.length || p.enemies.some(id => matches(e, id))) && seesPlayer(bot, e))
      const guard = () => allies.includes(p.cover) ? (Object.values(bot.entities || {}) as any[]).find(e => e && matches(e, p.cover)) : null
      const tracker = tempo.track(bot, { threats: foes })
      const now = () => bot.ndClock?.now?.() ?? clock.now()
      let lifeEnded = false
      const sameLife = () => !lifeEnded && session.bot === bot && bot.entity === entity && bot.entity?.id === initialId && bot.health > 0
      const physical = () => ctl.aborted || !sameLife() ||
        !(bot.health > 0) || bot._ndHandLock?.on() || bot._ndClutch?.lastDecision?.action === 'clutch'
      let why = '', stopped = false
      const release = () => { if (sameLife()) { try { bot.deactivateItem() } catch {} } }
      const cancel = () => { why ||= 'cancelled'; release() }
      let choice: any, before: any, coveredAtStart = false
      const risk = (ticks: number) => {
        const visible = foes(), cover = guard()
        const resistance = bot.entity.effects?.[(bot.registry.effectsByName.Resistance || bot.registry.effectsByName.resistance)?.id]?.amplifier ?? -1
        const defense = dm.defenseOf([5, 6, 7, 8].map(slot => bot.inventory.slots?.[slot]).filter(Boolean).map(item => ({ name: item.name,
          ench: { protection: read.enchLevel(bot, item, 'protection'), projectile_protection: read.enchLevel(bot, item, 'projectile_protection') } })), { resistance })
        let exposure = 0, allCovered = visible.length > 0
        for (const foe of visible) {
          const covered = covers(bot, cover, foe)
          allCovered &&= covered
          if (covered) continue
          const left = Math.max(0, ticks * 50 - tracker.eta(foe))
          if (!(left > 0)) continue
          const held = foe.equipment?.[0]?.name, ranged = /^(bow|crossbow)$/.test(held || '')
          const raw = ranged ? Math.max(...dm.arrowOutcomes({ speed: held === 'bow' ? 3 : dm.CROSSBOW_ARROW_SPEED, crit: true }).map(o => o.raw))
            : dm.meleeRaw({ weapon: held, fall: held === 'mace' ? Math.max(0, foe.position.y - bot.entity.position.y) : 0 })
          const count = 1 + Math.floor(left / Math.max(50, tempo.swingCooldownMs(held)))
          exposure += dm.afterDefense(raw, ranged ? 'projectile' : 'melee', defense) * count
        }
        return { exposurePerTick: exposure / ticks, covered: allCovered }
      }
      const stop = (reason: string) => { if (stopped) return; stopped = true; why ||= reason; release(); ctl.abort?.() }
      const endLife = () => { lifeEnded = true; stop('life_ended') }
      const lifeEvents = ['death', 'respawn', 'end', 'kicked']
      const check = () => {
        if (physical()) { stop('interrupted'); return }
        if (!choice) return
        const left = Math.max(1, choice.drinkTicks - (now() - startedAt) / 50)
        const context = risk(left)
        if (coveredAtStart && !context.covered && context.exposurePerTick > 0) { stop('cover_lost'); return }
        if (context.exposurePerTick * left > initialExposure * choice.drinkTicks) stop('new_direct_threat')
      }
      let startedAt = 0, initialExposure = 0
      const previousEating = session.eating
      const mark: any = { item: null, startedAt: 0 }
      try {
        if (physical() || bot._ndUse?.cur || bot._ndAntidoteDrinking) return { consumed: false, item: null, why: 'body_busy' }
        const requested = p.item
        const ticks = requested === 'honey_bottle' ? 40 : 32
        const context = risk(ticks)
        before = ownAntidoteState(bot, context)
        choice = chooseAntidote(before = requested ? { ...before, inventory: { [requested]: before.inventory[requested] || 0 } } : before)
        if (!choice) return { consumed: false, item: requested || null, before: before.effects, after: before.effects, quoteState: before, why: 'not_worth_consuming' }
        const selectedRisk = risk(choice.drinkTicks)
        before = ownAntidoteState(bot, selectedRisk)
        choice = chooseAntidote(before = { ...before, inventory: { [choice.item]: before.inventory[choice.item] || 0 } })
        if (!choice) return { consumed: false, item: requested || null, before: before.effects, after: before.effects, quoteState: before, why: 'exposure_cost' }
        coveredAtStart = selectedRisk.covered; initialExposure = selectedRisk.exposurePerTick
        startedAt = now(); Object.assign(mark, { item: choice.item, startedAt })
        const countBefore = owned(bot, choice.item)
        ctl.onAbort?.push(cancel); bot.on('physicsTick', check)
        for (const event of lifeEvents) bot.on(event, endLife)
        bot._ndAntidoteDrinking = mark; session.eating = true
        const result = await eat(session, { item: choice.item })
        const consumed = sameLife() && result.ate === choice.item && result.spent > 0 && owned(bot, choice.item) < countBefore
        finishAntidote(bot, choice.item, consumed)
        return { consumed, item: choice.item, before: before.effects, after: ownAntidoteState(bot).effects,
          covered: coveredAtStart, why: consumed ? 'consumed' : why || 'consume_unconfirmed', quoteState: before, choice, receipt: result }
      } finally {
        if (bot._ndAntidoteDrinking === mark) release()
        tracker.close(); bot.removeListener('physicsTick', check)
        for (const event of lifeEvents) bot.removeListener(event, endLife)
        if (ctl.onAbort) { const index = ctl.onAbort.indexOf(cancel); if (index >= 0) ctl.onAbort.splice(index, 1) }
        if (bot._ndAntidoteDrinking === mark) delete bot._ndAntidoteDrinking
        session.eating = previousEating
      }
    }, { params: p, timeoutMs: 6500, interruptOn: ['death', 'kicked', 'disconnected'] })
  }
}
