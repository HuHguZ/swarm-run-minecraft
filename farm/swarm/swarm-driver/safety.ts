// Рой: «не вытяну» (симуляция боя по правилу планировщика), паника, можно ли вступать.
import { assessSwarmFight, groupOf, groupVerdict } from '../../../daemon/src/swarm'
import { TEAM_LINK, REINFORCE_LINK } from '../../../daemon/src/swarm/fight'
import { inContact, alliesNear, caughtBy, retreatWhy, nearestGap } from '../../../daemon/src/swarm/retreat'
import { pvpState, knownEnemies } from '../../../daemon/src/swarm/board'
import { behindRace } from '../../../daemon/src/swarm/race'
import { distance } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmSafety (sw: SwarmDriverCtx) {
  const { now, pos, unsafeCache, planned, boardOf, membersOf, rangedAdvantage, teamOf } = sw
  const unsafe = b => {
    const c = unsafeCache.get(b.name)
    if (c && now() - c.at >= 0 && now() - c.at < 250) return c.v
    // Свежая опасность — сразу, не дожидаясь плана, но по тому же правилу, что в planPvp (mustFlee: смертельный залп,
    // тяжёлая рана, безнадёжный размен), а липкое бегство плана — тоже паника. Раньше здесь была своя личная оценка, и
    // опрос арены рвал бой, который команда держала (арена 14.10).
    const board = boardOf(b), members = membersOf(b), member = members.find(m => m.id === b.name), foes = knownEnemies(board)
    const risk = member && assessSwarmFight(member, foes, members)
    // Контакт — как у плана (retreat.ts): начатая рукопашная держится до 8 бл., натиск — тоже 8.
    const onslaught = sw.onslaught(b)
    const close = !!member && inContact(member, foes, b.swarmTask?.kind === 'fight', onslaught)
    // Догнали и развернулся (retreat.ts turned) — дерётся: мгновенная паника не рвёт этот бой.
    const turned = !!pvpState(board).retreats.get(b.name)?.turned
    // Мгновенно — только срочное (смертельный удар, рана, пустой размен — ранить его нечем): «один» и «нас меньше» решает план
    // (раз в 0.5 с) — иначе паника опроса рвала бой, который план только что назначил, и ход назначал его снова
    // (стенд 15×15, 21.10: четверть оборванных боёв — без записи в журнал).
    // Пустой размен — срочно, только с врагом, которого план ещё не видел (новая опасность), и по тем же условиям, что в
    // плане: бег что-то даёт, если отстаёт снаряжением (race.behindRace) — без них опрос видел «пустой размен» там, где план
    // решил драться: «⚡ стоп» → план «бой» → снова стоп (стенд 15×15, 21.10: 220 «⚡» за раунд). Взрыв рядом — залп без форы.
    const seenByPlan = sw.plannedFoes.get(teamOf(b))
    const unplanned = !seenByPlan || foes.some(e => !seenByPlan.has(e.id))
    const blast = !!member && foes.some(e => e.threat === 'blast' && distance(e.position, member.position) <= 8)
    const behind = !!member && behindRace({ state: pvpState(board), enemies: foes }, member)
    const why = !rangedAdvantage(b) && !!member && !turned && !!risk ? retreatWhy(member, risk, { contact: close, caught: caughtBy(member, foes), headstart: nearestGap(member, foes), allies: alliesNear(member, members), blast, behind, shelter: false, ...(onslaught ? groupVerdict(groupOf(members, member), foes) : groupVerdict(groupOf(members, member, REINFORCE_LINK), foes, TEAM_LINK)), aggressive: onslaught }) : null
    // Срочно — только новое для плана: враг, которого план не видел, или урон после плана; остальное план уже решил (иначе
    // паника переигрывала его каждые полсекунды — стенд 15×15, 21.10).
    const hurt = !!member && member.health < (b.plannedHp ?? Infinity) - .5
    const urgent = (why === 'залп' || why === 'рана' || why === 'пустой размен') && (unplanned || hurt)
    const v = urgent || planned.get(teamOf(b))?.get(b.name)?.kind === 'flee'
    b.panicWhy = urgent ? `${why}${blast ? ', взрыв' : ''}; ${risk!.reason}; план ${planned.get(teamOf(b))?.get(b.name)?.kind ?? '—'}` : null
    unsafeCache.set(b.name, { at: now(), v }); return v
  }
  // Стоп опроса — только срочное (urgent): бегство плана исполнитель принимает сам (turn.preempt по фазе), а «уход раненого»
  // и бегство — одна фаза; стоп по «план: бегство» рвал начатый уход раненого (стенд 15×15, 21.10: 131 «⚡» за раунд).
  const panic = b => !b.campReacting && unsafe(b) && !!b.panicWhy && !(b.swarmPreparing && b.swarmTask?.kind === 'flee' && boardOf(b).enemies().every(e => distance(e.position, pos[b.name].p) >= 14 && e.threat === 'melee'))
  const canEngage = (b, target) => boardOf(b).enemies().some(e => e.id === target) && !unsafe(b)
  return { unsafe, panic, canEngage }
}
