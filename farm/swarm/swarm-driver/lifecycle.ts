// Рой: новый раунд, снимок для наблюдателя, ход с ожиданием перебитого боя.
import type { SwarmDriverCtx } from './common'

export const currentTurn = (sw: SwarmDriverCtx, b, round: number) =>
  round === sw.generation && sw.alive(b.name) && !b.swarmTurnOwner?.cancelled

export function swarmLifecycle (sw: SwarmDriverCtx) {
  const { bots, ladderSites, now, alive, boards, holes, walls, ladderRoutes, boxed, boxTries, tourBad, blockedRoutes, blueprints, transfers, planned, plannedAt, visited, cooldown, placed, toured, emptyChests, fullFor, knownChests, telemetry, teamOf, turn } = sw
  const turning = new WeakSet<object>()
  function reset() {
    sw.generation++
    // Память матча: кто сколько наших убил в прошлых раундах (лента смертей; доска раунда её стирает) — сила врага не забывается
    // за смену раунда (стенд 21.10: чемпион убил шестерых, а в новом раунде рой снова шёл на него «втрое больше» до двух смертей).
    for (const d of sw.drops()) if (d.team && d.by) { const t = sw.pastKills.get(d.team) || {}; t[d.by] = (t[d.by] || 0) + 1; sw.pastKills.set(d.team, t) }
    for (const board of boards.values()) board.resetRound()
    for (const b of bots) { delete b.swarmPosition; delete b.swarmPreparing; delete b.swarmReserved; delete b.swarmWindReservation; delete b.swarmTask; delete b.swarmTaskAt; delete b.swarmFightReply; delete b.swarmLadder; delete b.swarmBusyUntil; delete b.maceDefense; delete b.noReach }
    holes.length = 0; walls.clear(); for (const w of ladderSites) walls.set(w.key, { ...w }); ladderRoutes.length = 0; boxed.clear(); boxTries.clear()
    for (const b of bots) { b.boxedCamp = null; b.boxOutTries = 0; delete b.campReacting; delete b.arrowThreat; delete b.swarmAscent; delete b.bowShieldHold; delete b.grabbing; b.climbing = false }
    tourBad.clear(); blockedRoutes.clear()
    blueprints.clear(); transfers.clear(); planned.clear(); plannedAt.clear(); sw.plannedFoes.clear(); visited.clear(); cooldown.clear(); placed.clear(); toured.clear(); emptyChests.clear(); fullFor.clear(); knownChests.clear(); sw.retries.clear(); sw.sites.clear()
    for (const b of bots) Promise.resolve(b.c?.call('swarm_keep', { clear: true })).catch(() => {})
  }
  const snapshot = () => Object.fromEntries([...boards].map(([team, board]) => [team, { enemies: board.enemies(), tasks: board.tasks(), stats: { ...telemetry }, learning: board.tacticStats() }]))
  const guardedTurn = async b => {
    // Тело в неделимой связке («Тягун → булава»): новое задание оборвало бы её посреди заряда или полёта.
    if (b.swarmReserved || sw.pos[b.name]?.combo || turning.has(b)) return
    turning.add(b)
    const owner = { cancelled: false }
    b.swarmTurnOwner = owner
    try {
    const round = sw.generation
    // Перебитый бой ждёт освобождения тактики: раз в 0.5 с observe (он и снимает requireObservation), потом перепланирование.
    if (b.swarmFightReply?.status === 'interrupted') {
      const key = `fight:${b.name}`
      if ((cooldown.get(key) || 0) > now()) return
      cooldown.set(key, now() + 500)
      const seen = await b.c.call('observe', { radius: 24, fair: true })
      if (!currentTurn(sw, b, round) || b.swarmReserved) return
      const t = seen?.state?.tactics
      if (seen?.status !== 'done' || t?.action || t?.owner === 'Tactical' || t?.owner === 'Emergency' || t?.requireObservation) return
      delete b.swarmFightReply
      plannedAt.delete(teamOf(b))
    }
    b.swarmExecuting = true
    await turn(b)
    } finally {
      if (b.swarmTurnOwner === owner) { delete b.swarmTurnOwner; delete b.swarmExecuting }
      turning.delete(b)
    }
  }
  return { reset, snapshot, guardedTurn }
}
