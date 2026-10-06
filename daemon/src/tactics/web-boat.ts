import { WebBoatGraph, type WebBoatFacts } from './web-boat-graph'
import { boatItem, mountedBoatDry, placeBoatOn, mountBoat, type BoatController, type BoatPosition } from '../combat/boat-placement'
type Body = Record<string, any>
const build = require('../build')
const pick = require('../pick')
const clock = require('../game-clock')
const Vec3 = require('vec3')

interface BlockPoint extends BoatPosition { offset(x: number, y: number, z: number): BlockPoint; minus(face: Body): BlockPoint }
export interface WebBoatPlan { web: BlockPoint; supports: [BlockPoint, BlockPoint]; base: BlockPoint }
export function webBoatPlan(session: Body): WebBoatPlan | null {
  const bot = session.bot
  const items: Body[] = bot.inventory.items()
  if (!boatItem(bot) || !items.some(item => item.name === 'cobweb')) return null
  const fillers = items.filter(item => build.FILLER.includes(item.name) && !/^(sand|red_sand|gravel)$/.test(item.name)).reduce((total, item) => total + item.count, 0)
  if (fillers < 2) return null
  const feet = bot.entity.position.floored()
  for (let dy = 0; dy <= 3; dy++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const web = feet.offset(dx, dy, dz)
    const cell = bot.blockAt(web)
    if (!cell || !/^(air|cave_air|void_air)$/.test(cell.name)) continue
    if (!build.FACES.some((face: Body) => {
      const ref = bot.blockAt(web.minus(face))
      return ref?.boundingBox === 'block' && !!pick.faceAim(bot, ref.position, face)
    })) continue
    for (const [sx, sz] of [[dz, dx], [-dz, -dx], [dx, dz]]) {
      const base = web.offset(sx, 2, sz)
      const lower = base.offset(0, -1, 0)
      if (![lower, base].every(position => bot.blockAt(position)?.boundingBox === 'empty')) continue
      if ([-1, 0, 1].some(x => [-1, 0, 1].some(z => [1, 2].some(y => {
        const block = bot.blockAt(base.offset(x, y, z))
        return block?.boundingBox !== 'empty' || /lava|fire/.test(block?.name || '')
      })))) continue
      const anchored = build.FACES.some((face: Body) => bot.blockAt(lower.minus(face))?.boundingBox === 'block')
      if (!anchored) continue
      return { web, supports: [lower, base], base }
    }
  }
  return null
}

export function webBoatExit(bot: Body, plan: WebBoatPlan, boat: Body, beforeY: number): boolean {
  if (bot.health <= 0 || bot.vehicle?.id !== boat.id || bot.entities[boat.id]?.isValid === false) return false
  const point = boat.position
  if (!point || point.y < beforeY + 1 || point.y < plan.base.y + .8) return false
  return mountedBoatDry(bot)
}

export async function webBoatEscape(session: Body, ctl: BoatController): Promise<{ ok: boolean; phase: string; why?: string; boatId?: number; height?: number; heightSource?: 'vehicle'; player?: BoatPosition; vehicle?: BoatPosition }> {
  const bot = session.bot
  const plan = webBoatPlan(session)
  const graph = new WebBoatGraph()
  if (!plan || ctl.aborted) return { ok: false, phase: graph.phase, why: 'web, two visible supports or boat unavailable' }
  const beforeY = bot.entity.position.y
  const facts: WebBoatFacts = { aborted: false, alive: true, webPlaced: false, inWeb: false, supports: 0, boatSpawned: false, mounted: false, safeHeight: false }
  const advance = (): boolean => {
    facts.aborted = ctl.aborted
    facts.alive = bot.health > 0
    const from = graph.phase
    graph.advance(facts)
    session.bus.emit('tactical_phase', { action: 'WebBoatEscape', from, phase: graph.phase, facts: { ...facts } })
    return graph.phase !== 'Failed'
  }
  const failure = (why: string) => ({ ok: false, phase: graph.phase, why })
  const placed = await build.placeBlockAt(bot, plan.web, { item: 'cobweb', honest: true, timeoutMs: 1200 })
  facts.webPlaced = placed.ok && bot.blockAt(plan.web)?.name === 'cobweb'
  if (!advance()) return failure('cobweb placement not confirmed')
  const began = clock.now()
  try {
    while (!ctl.aborted && bot.health > 0 && clock.now() - began < 2500) {
      const point = bot.entity.position
      facts.inWeb = point.x + .29 > plan.web.x && point.x - .29 < plan.web.x + 1 && point.y + 1.75 > plan.web.y && point.y < plan.web.y + 1 && point.z + .29 > plan.web.z && point.z - .29 < plan.web.z + 1
      if (facts.inWeb) break
      facts.inWeb = false
      await bot.lookAt(plan.web.offset(.5, .5, .5), true)
      if (ctl.aborted) break
      bot.setControlState('jump', true)
      bot.setControlState('forward', true)
      await clock.sleep(50)
    }
  } finally { try { bot.clearControlStates() } catch {} }
  if (!advance()) return failure('body did not reach the placed cobweb')
  for (const support of plan.supports) {
    if (ctl.aborted) break
    const result = await build.placeBlockAt(bot, support, { honest: true, steady: true, timeoutMs: 1200 })
    if (!result.ok || bot.blockAt(support)?.boundingBox !== 'block') break
    facts.supports++
  }
  if (!advance()) return failure('two solid support blocks not confirmed')
  const spawned = await placeBoatOn(session, ctl, { at: plan.base, maxMs: 2000 })
  facts.boatSpawned = !!(spawned.ok && spawned.boat)
  if (!advance() || !spawned.boat) return failure(spawned.why || 'boat spawn not confirmed')
  const mounted = await mountBoat(session, ctl, spawned.boat, { maxMs: 2000 })
  facts.mounted = mounted.ok && bot.vehicle?.id === spawned.boat.id
  if (!advance()) return failure(mounted.why || 'passenger mount not confirmed')
  await clock.sleep(300)
  facts.mounted = bot.vehicle?.id === spawned.boat.id
  facts.safeHeight = webBoatExit(bot, plan, spawned.boat, beforeY)
  if (!advance()) return failure('mount did not establish a stable position above the lava')
  return { ok: true, phase: graph.phase, boatId: spawned.boat.id, height: spawned.boat.position.y - beforeY,
    heightSource: 'vehicle', player: bot.entity.position.clone(), vehicle: spawned.boat.position.clone() }
}
