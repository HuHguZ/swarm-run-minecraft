// Рой: новый раунд, снимок для наблюдателя, ход с ожиданием перебитого боя.
import type { SwarmDriverCtx } from './common'

export function swarmLifecycle (sw: SwarmDriverCtx) {
  const { bots, ladderSites, now, alive, boards, holes, walls, ladderRoutes, boxed, boxTries, tourBad, blockedRoutes, blueprints, transfers, planned, plannedAt, visited, cooldown, placed, toured, emptyChests, fullFor, knownChests, telemetry, teamOf, turn } = sw
  function reset() {
    sw.generation++
    for (const board of boards.values()) board.resetRound()
    for (const b of bots) { delete b.swarmPosition; delete b.swarmHoldUntil; delete b.swarmPreparingUntil; delete b.swarmReserved; delete b.swarmTask; delete b.swarmTaskAt; delete b.swarmFightReply; delete b.noReach }
    holes.length = 0; walls.clear(); for (const w of ladderSites) walls.set(w.key, { ...w }); ladderRoutes.length = 0; boxed.clear(); boxTries.clear()
    for (const b of bots) { b.boxedCamp = null; b.boxOutTries = 0; delete b.campReacting }
    tourBad.clear(); blockedRoutes.clear()
    blueprints.clear(); transfers.clear(); planned.clear(); plannedAt.clear(); visited.clear(); cooldown.clear(); placed.clear(); toured.clear(); emptyChests.clear(); fullFor.clear(); knownChests.clear()
    for (const b of bots) Promise.resolve(b.c?.call('swarm_keep', { clear: true })).catch(() => {})
  }
  const snapshot = () => Object.fromEntries([...boards].map(([team, board]) => [team, { enemies: board.enemies(), tasks: board.tasks(), stats: { ...telemetry }, learning: board.tacticStats() }]))
  const guardedTurn = async b => {
    if (b.swarmReserved) return
    const round = sw.generation
    // Перебитый бой ждёт освобождения тактики: раз в 0.5 с observe (он и снимает requireObservation), потом перепланирование.
    if (b.swarmFightReply?.status === 'interrupted') {
      const key = `fight:${b.name}`
      if ((cooldown.get(key) || 0) > now()) return
      cooldown.set(key, now() + 500)
      const seen = await b.c.call('observe', { radius: 24, fair: true })
      if (round !== sw.generation || !alive(b.name) || b.swarmReserved) return
      const t = seen?.state?.tactics
      if (seen?.status !== 'done' || t?.action || t?.owner === 'Tactical' || t?.owner === 'Emergency' || t?.requireObservation) return
      delete b.swarmFightReply
      plannedAt.delete(teamOf(b))
    }
    b.swarmExecuting = true
    try { await turn(b) } finally { delete b.swarmExecuting }
  }
  return { reset, snapshot, guardedTurn }
}
