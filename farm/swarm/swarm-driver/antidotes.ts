import { antidoteTransferValue } from '../../../daemon/src/swarm/antidotes'
import { assessSwarmFight } from '../../../daemon/src/swarm'
import { distance, type SwarmDriverCtx } from './common'

export function antidoteDeliveryValue(sw: SwarmDriverCtx, donor: string, recipient: string, item: string, members: any[], enemies: any[] = []): number {
  if (!/^(honey_bottle|milk_bucket)$/.test(item) || donor === recipient) return 0
  const giver = sw.bots.find(b => b.name === donor), receiver = sw.bots.find(b => b.name === recipient)
  const a = sw.pos[donor], b = sw.pos[recipient]
  if (!giver || !receiver || sw.teamOf(giver) !== sw.teamOf(receiver) || !sw.alive(donor) || !sw.alive(recipient) ||
      !a?.p || !b?.p || a.rescuing || b.rescuing || a.antidote?.using || b.antidote?.using ||
      sw.panic?.(giver) || sw.panic?.(receiver) ||
      Math.max(b.inv?.[item] || 0, b.antidote?.state?.inventory?.[item] || 0) > 0) return 0
  for (const actor of [giver, receiver]) {
    if ((/^(lava_escape|dodge_blast|clear_web|antidote)$/.test(actor.last?.m || '') ||
        actor.shieldHold && actor.last?.m === 'swarm_hold') && actor.last?.pending !== false) return 0
  }
  const current = (id: string, p: any) => {
    const member = members.find(m => m.id === id)
    return member && { ...member, position: p.p, health: p.hp ?? member.health, inventory: p.inv, antidote: p.antidote }
  }
  const from = current(donor, a), to = current(recipient, b)
  if (!from?.antidote || !to?.antidote || !(a.inv?.[item] > 0)) return 0
  const foes = enemies.filter(e => sw.now() - e.seenAt < 1500 && distance(e.position, b.p) < 8)
  const survival = foes.length ? assessSwarmFight(to, foes, members).survivalSeconds : Infinity
  const exposure = Number.isFinite(survival) ? to.health / Math.max(1, survival * 20) : 0
  // Pickup has a native 40-tick delay; only the short final approach is extra.
  const ticks = 40 + Math.ceil(Math.max(0, distance(a.p, b.p) - 2.5) / .215)
  return Math.max(0, antidoteTransferValue(from, to, item, sw.now(), ticks, exposure))
}
