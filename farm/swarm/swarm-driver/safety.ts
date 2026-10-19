// Рой: «не вытяну» (симуляция боя по правилу планировщика), паника, можно ли вступать.
import { assessSwarmFight, mustFlee, groupOf, groupVerdict } from '../../../daemon/src/swarm'
import { distance } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmSafety (sw: SwarmDriverCtx) {
  const { now, aggressive, pos, unsafeCache, planned, boardOf, membersOf, rangedAdvantage, teamOf } = sw
  const unsafe = b => {
    const c = unsafeCache.get(b.name)
    if (c && now() - c.at >= 0 && now() - c.at < 250) return c.v
    // Свежая опасность — сразу, не дожидаясь плана, но по тому же правилу, что в planPvp (mustFlee: смертельный залп,
    // тяжёлая рана, безнадёжный размен), а липкое бегство плана — тоже паника. Раньше здесь была своя личная оценка, и
    // опрос арены рвал бой, который команда держала (арена 14.10).
    const board = boardOf(b), members = membersOf(b), member = members.find(m => m.id === b.name)
    const risk = member && assessSwarmFight(member, board.enemies(), members)
    const contact = !!member && board.enemies().some(e => distance(e.position, member.position) <= 4)
    const close = aggressive ? !!member && board.enemies().some(e => distance(e.position, member.position) <= 8) : contact
    const v = !rangedAdvantage(b) && !!member && (!!risk && mustFlee(member, risk, close, groupVerdict(groupOf(members, member), board.enemies()), aggressive) || planned.get(teamOf(b))?.get(b.name)?.kind === 'flee')
    unsafeCache.set(b.name, { at: now(), v }); return v
  }
  const panic = b => !b.campReacting && unsafe(b) && !(b.swarmPreparingUntil > now() && boardOf(b).enemies().every(e => distance(e.position, pos[b.name].p) >= 14 && e.threat === 'melee'))
  const canEngage = (b, target) => boardOf(b).enemies().some(e => e.id === target) && !unsafe(b)
  return { unsafe, panic, canEngage }
}
