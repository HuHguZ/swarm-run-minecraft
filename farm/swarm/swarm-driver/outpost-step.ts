import { AIR, DIRECTIONS, validCell } from '../../../daemon/src/swarm-work'
import { withinArena, type MovementArena } from '../../../daemon/src/navigation/parkour/model'
import { cellKey, distance } from './common'
import type { SwarmPosition, SwarmTask } from '../../../daemon/src/swarm/types'

type Point = SwarmPosition
const up = (p: Point, y: number) => ({ ...p, y: p.y + y })
const feet = (p: Point) => ({ x: p.x + .5, y: p.y + 1, z: p.z + .5 })
type Seen = { name: string; solid?: boolean; occupied?: boolean; exitBlocked?: boolean }
type Sight = { cells?: { at: Point; existing?: Seen }[]; underThreat?: boolean }
type Reply = { status?: string; notStarted?: boolean; detail?: Sight }
interface Access {
  bot: { c: { call(method: string, params: object): Promise<Reply> } }
  plan: { origin: Point }; tasks: SwarmTask[]; cell: SwarmTask; item: string; count: number; position: Point; arena?: MovementArena
  forbidden(at: Point): boolean; knownStep?: Point; owns(): boolean
  allies: string[]; contained: string[]
  detail(reply: Reply): Sight
  approach(to: Point, range: number): Promise<Reply | null>; placeStep(at: Point): Promise<boolean>
}

type Route = { step: Point; ledge: Point; roof?: Point; beside: Point[] }
const flat = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z)
const column = (base: Point) => [base, up(base, 1), up(base, 2)]
const sides = Object.values(DIRECTIONS)

// A roof edge and an exterior block from an allied project can form the top two steps.
function roofRoutes(tasks: SwarmTask[], id: string, o: Point): Route[] {
  const nearby = tasks.filter(t => t.kind === 'build' && t.status === 'done' && t.position && flat(t.position, o) <= Math.SQRT2 * 2)
  const caps = nearby.filter(t => t.data?.blueprint === id && t.position.y === o.y + 2)
  const posts = nearby.filter(t => t.position.y === o.y + 1 && (Math.abs(t.position.x - o.x) > 1 || Math.abs(t.position.z - o.z) > 1))
  const routes: Route[] = []
  for (const { position: roof } of caps) for (const { position: ledge } of posts) {
    if (flat(ledge, roof) > Math.SQRT2) continue
    for (const [dx, dz] of sides) {
      const step = { x: ledge.x + dx, y: o.y, z: ledge.z + dz }
      if (flat(step, roof) > Math.SQRT2 || Math.abs(step.x - o.x) <= 1 && Math.abs(step.z - o.z) <= 1) continue
      const beside = sides.map(([x, z]) => ({ x: step.x + x, y: step.y - 1, z: step.z + z }))
      routes.push({ step, ledge, roof, beside })
    }
  }
  return routes
}

// The board nominates landings. Only this builder's current view authorizes a stair or a climb.
export async function climbOutpost({ bot, plan, tasks, cell, item, count, position, arena, forbidden, knownStep, allies, contained,
  detail, owns, approach, placeStep }: Access): Promise<boolean> {
  const o = plan.origin, walls = tasks.filter(t => t.kind === 'build' && t.data?.blueprint === cell.data.blueprint && t.position.y < o.y + 2)
  if (!walls.length || walls.some(t => t.id !== cell.id && t.status !== 'done')) return false
  const confirmed = new Set(walls.filter(t => t.status === 'done').map(t => cellKey(t.position)))
  const roofWork = cell.position.y === o.y + 2
  const routes: Route[] = roofWork ? roofRoutes(tasks, cell.data.blueprint, o) : sides.map(([dx, dz]) => {
    const ledge = { x: o.x + dx, y: o.y + 1, z: o.z + dz }, step = { x: o.x + 2 * dx, y: o.y, z: o.z + 2 * dz }
    const beside = [-1, 1].map(k => ({ x: step.x + k * dz, y: step.y - 1, z: step.z + k * dx }))
    return { ledge, step, beside }
  }).filter(({ ledge }) => confirmed.has(cellKey(ledge)))
  const candidates = routes.filter(({ ledge, step, roof }) => validCell(step) && withinArena({}, feet(step), arena) &&
    withinArena({}, feet(ledge), arena, feet(step)) && (!roof || withinArena({}, feet(roof), arena, feet(ledge))) &&
    !forbidden(step) && (roofWork || !knownStep || cellKey(knownStep) === cellKey(step)))
  const sameStep = (p: Point) => !!knownStep && cellKey(knownStep) === cellKey(p)
  candidates.sort((a, b) => Number(sameStep(b.step)) - Number(sameStep(a.step)) || distance(position, a.step) - distance(position, b.step) ||
    (a.roof && b.roof ? distance(a.roof, cell.position) - distance(b.roof, cell.position) : 0))
  if (!candidates.length || !owns()) return false
  const inspect = async (points: Point[], buildAt?: Set<string>) => {
    const result = await bot.c.call('swarm_pose', { inspectOnly: true, occupants: true,
      cells: points.map(p => ({ ...p, bodyFor: item, ...(buildAt?.has(cellKey(p)) && { exitFor: item }) })) }).catch(() => null)
    const seen = new Map<string, Seen>()
    if (owns() && result && (!result.status || result.status === 'done') && !result.notStarted)
      for (const row of detail(result).cells || []) if (row.existing) seen.set(cellKey(row.at), row.existing)
    return (p: Point) => seen.get(cellKey(p))
  }
  const clear = (s?: Seen) => !!s && AIR.test(s.name) && s.occupied === false
  const landing = (see: (p: Point) => Seen | undefined, ground: Point) => see(ground)?.solid === true && clear(see(up(ground, 1))) && clear(see(up(ground, 2)))
  const safe = async () => {
    if (!owns()) return false
    const reply = await bot.c.call('swarm_pose', { placementSafety: true, allies, contained }).catch(() => null)
    return owns() && reply && !reply.notStarted && (!reply.status || reply.status === 'done') && detail(reply).underThreat === false
  }
  const walk = async (ground: Point) => (!roofWork || await safe()) && (await approach(feet(ground), .25))?.status === 'done'
  const points = new Map<string, Point>(), surveyed: Route[] = []
  for (const route of candidates) {
    const { step, ledge, roof, beside } = route
    const add = [up(step, -1), ...column(step), ...(roof ? [...column(ledge), ...column(roof)] : [ledge]), ...beside.flatMap(column)]
    // One bounded sweep shared by all overlapping approaches. The body accepts at most 64 cells per call.
    const additional = new Set(add.map(cellKey).filter(k => !points.has(k)))
    if (points.size + additional.size > 64) continue
    for (const p of add) points.set(cellKey(p), p)
    surveyed.push(route)
  }
  const seen = await inspect([...points.values()], new Set(surveyed.map(r => cellKey(r.step))))
  for (const { step, ledge, roof, beside } of surveyed) {
    const base = seen(step)
    if (!base || !seen(ledge)?.solid || !clear(seen(up(step, 1))) || !clear(seen(up(step, 2)))) continue
    if (roof && (!landing(seen, ledge) || !landing(seen, roof))) continue
    if (!base.solid) {
      if (!(count >= 2) || !clear(base) || base.exitBlocked !== false || !seen(up(step, -1))?.solid) continue
      const approaches = beside.filter(p => validCell(p) && withinArena({}, feet(p), arena) &&
        (distance(position, feet(p)) < .35 || landing(seen, p))).sort((a, b) => distance(position, feet(a)) - distance(position, feet(b)))
      if (!approaches.length) continue
      if (distance(position, feet(approaches[0])) >= .35 && !await walk(approaches[0])) return false
      if (!owns() || forbidden(step)) return false
      const fresh = await inspect([up(step, -1), ...column(step), ...(roof ? [...column(ledge), ...column(roof)] : [])], new Set([cellKey(step)]))
      if (roof && (!landing(fresh, ledge) || !landing(fresh, roof) || !await safe())) return false
      if (!fresh(up(step, -1))?.solid || !clear(fresh(step)) || fresh(step)?.exitBlocked !== false ||
          !clear(fresh(up(step, 1))) || !clear(fresh(up(step, 2))) || !owns() || forbidden(step) || !await placeStep(step)) return false
    }
    if (!await walk(step)) {
      if (roof && base.solid && sameStep(step) && owns() && await safe()) continue
      return false
    }
    const next = await inspect(column(ledge))
    if (!landing(next, ledge) || !await walk(ledge)) return false
    if (!roof) return true
    const top = await inspect(column(roof))
    return landing(top, roof) && await walk(roof)
  }
  return false
}
