import type { SwarmBoard } from '../../../daemon/src/swarm/board'
import type { SharedEnemy, SwarmPosition } from '../../../daemon/src/swarm/types'
import { distance } from './common'

export type TrailReport = { id: string; cell: string; seenAt: number; round: number }
export function repeatedTrail(reports: WeakMap<object, TrailReport>, bot: { name: string }, foe: SharedEnemy | undefined,
  round: number, now: number, ttl: number) {
  const last = reports.get(bot)
  if (!foe || foe.nametag || foe.glowing) { reports.delete(bot); return false }
  const p = foe.position, cell = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  reports.set(bot, { id: foe.id, cell, seenAt: foe.seenAt, round })
  return !!last && last.round === round && last.id === foe.id && last.cell === cell && last.seenAt < foe.seenAt &&
    now - last.seenAt < ttl && foe.source !== bot.name
}

export function nearbyOutpost(board: SwarmBoard, projects: Map<string, { kind: string; origin: SwarmPosition }>, p: SwarmPosition, beacon: string) {
  const tasks = board.tasks()
  if (tasks.some(t => t.data?.blueprint === beacon && (t.claim || t.status === 'done'))) return
  const done = new Set(tasks.filter(t => t.status === 'done').map(t => t.id))
  let nearest = Infinity, request: { kind: string; origin: SwarmPosition; id: string } | undefined
  for (const task of tasks) {
    const id = task.data?.blueprint
    if (task.kind !== 'build' || task.status !== 'pending' || task.claim || !id || !task.position || task.data.obstruction) continue
    const gap = distance(task.position, p)
    if (gap > 4.5 || gap >= nearest || task.dependsOn?.some(id => !done.has(id))) continue
    const plan = projects.get(board.team + ':' + id)
    if (plan?.kind === 'outpost') { nearest = gap; request = { kind: plan.kind, origin: plan.origin, id } }
  }
  return request
}
