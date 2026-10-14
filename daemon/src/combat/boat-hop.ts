import { runBoatHops, type BoatHopPlan, type BoatHopResult, type HopPosition } from '../tactics/boat-hop-graph'
import { boatItem, boatBaseVisible, boatLavaAim, placeBoatOn, placeBoatOnLava, mountBoat, boatClickAim, type BoatController } from './boat-placement'
type Body = Record<string, any>
const clock = require('../game-clock')
const ride = require('../ride')
const Vec3 = require('vec3')
const count = (bot: Body): number => bot.inventory.items().filter((item: Body) => /_(boat|raft)$/.test(item.name) && !/chest/.test(item.name)).reduce((sum: number, item: Body) => sum + item.count, 0)
// anyFloor — посадка на любую твёрдую опору (спуск с обрыва: точка приземления заранее не известна с точностью 1.5 бл.).
export interface BoatHopRequest { mode?: 'lava' | 'fall'; target?: HopPosition; anyFloor?: boolean; maxHops?: number; timeoutSeconds?: number }
const shoreOffsets: Array<{ x: number; y: number; z: number; distance: number }> = []
for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) for (let y = -1; y <= 3; y++) {
  shoreOffsets.push({ x, y, z, distance: Math.hypot(x, z) + Math.abs(y) * .7 })
}
shoreOffsets.sort((a, b) => a.distance - b.distance)

function goalNear(bot: Body): HopPosition | null {
  const origin = bot.entity.position.floored()
  for (const offset of shoreOffsets) {
    const floor = origin.offset(offset.x, offset.y, offset.z)
    const block = bot.blockAt(floor)
    if (block?.boundingBox !== 'block' || /lava|magma|fire|cactus/.test(block.name)) continue
    if ([1, 2].some(y => { const above = bot.blockAt(floor.offset(0, y, 0)); return !above || above.boundingBox !== 'empty' || /lava|fire/.test(above.name) })) continue
    return floor.offset(.5, 1, .5)
  }
  return null
}

export function boatHopPlan(bot: Body, { mode = 'lava', target }: BoatHopRequest = {}): BoatHopPlan | null {
  if (!boatItem(bot)) return null
  const origin = bot.entity.position.floored()
  const goal = target || goalNear(bot)
  const candidates: Array<{ at: HopPosition & Body; score: number }> = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -4; dy <= 0; dy++) {
    const at = origin.offset(dx, dy, dz)
    const point = bot.entity.position
    // В падении — только земля под собой, ниже ног на 1.5+: край обрыва рядом (откуда шагнули) — не посадка
    // (try-descent boat 14.10: лодка встала на край, тело — в блок края, спуска нет).
    if (mode === 'fall' && at.y + 1 > point.y - 1.5) continue
    if (Math.hypot(Math.max(at.x - point.x, 0, point.x - at.x - 1), Math.max(at.y - point.y, 0, point.y - at.y - 1), Math.max(at.z - point.z, 0, point.z - at.z - 1)) > 2.7) continue
    const distance = Math.hypot(at.x + .5 - bot.entity.position.x, at.z + .5 - bot.entity.position.z)
    const score = goal ? Math.hypot(goal.x - at.x - .5, goal.z - at.z - .5) : -distance
    if (mode === 'lava' && goal && score >= Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z) - .4) continue
    candidates.push({ at, score })
  }
  candidates.sort((a, b) => a.score - b.score)
  for (const { at } of candidates) {
    const surface = mode === 'lava' && bot.blockAt(at)?.name === 'lava' ? 'lava' : 'dry'
    const aim = surface === 'lava' ? boatLavaAim(bot, at) : boatBaseVisible(bot, at) ? at.offset(.5, 1, .5) : null
    if (aim && aim.distanceTo(bot.entity.position) <= 2.7) return { at: { x: at.x, y: at.y, z: at.z }, surface }
  }
  return null
}

// Разбить лодку по прицелу (высадиться, если в ней): удары, пока сущность не исчезнет.
export async function breakBoatEntity(session: Body, ctl: BoatController, id: number, maxMs: number): Promise<boolean> {
  const bot = session.bot
  const boat = bot.entities[id]
  if (!boat) return true
  if (bot.vehicle?.id === id && !await ride.dismount(bot, Math.min(500, maxMs))) return false
  const weapon = bot.inventory.items().find((item: Body) => /_(sword|axe)$/.test(item.name))
  if (weapon && !ctl.aborted) await bot.equip(weapon, 'hand')
  const until = clock.now() + maxMs
  while (!ctl.aborted && bot.health > 0 && bot.entities[id] && clock.now() < until) {
    const aim = boatClickAim(bot, boat)
    if (!aim?.point) return false
    await bot.lookAt(aim.point, true)
    if (ctl.aborted || !boatClickAim(bot, boat)?.point.equals(aim.point)) return false
    bot.attack(boat)
    await clock.sleep(100)
  }
  return !ctl.aborted && !bot.entities[id]
}

export function boatHopAvailable(bot: Body): boolean { return bot.health > 4 && count(bot) >= 2 && !!boatHopPlan(bot) }

export async function runBoatHop(session: Body, ctl: BoatController, request: BoatHopRequest = {}): Promise<BoatHopResult> {
  const bot = session.bot
  const target = request.anyFloor ? null : (request.target || goalNear(bot))
  const position = (): HopPosition => {
    const point = bot.vehicle?.position || bot.entity.position
    return { x: point.x, y: point.y, z: point.z, source: bot.vehicle ? 'vehicle' : 'player' }
  }
  const safe = () => {
    const point = bot.vehicle?.position || bot.entity.position
    const floor = bot.blockAt(point.offset(0, -.05, 0))
    if (floor?.boundingBox !== 'block' || /lava|magma|fire/.test(floor.name)) return false
    if ([0, 1].some(y => /lava|fire/.test(bot.blockAt(point.offset(0, y, 0))?.name || ''))) return false
    return !target || Math.hypot(point.x - target.x, point.z - target.z) < 1.5 && point.y >= target.y - .2
  }
  const result = await runBoatHops({ now: clock.now, sleep: clock.sleep, health: () => bot.health, aborted: () => ctl.aborted, stock: () => count(bot), position,
    plan: () => boatHopPlan(bot, { ...request, target: target || undefined }), safe,
    phase: (phase, facts) => session.bus.emit('boat_hop_phase', { phase, ...facts,
      player: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      vehicle: bot.vehicle ? { id: bot.vehicle.id, x: bot.vehicle.position.x, y: bot.vehicle.position.y, z: bot.vehicle.position.z } : null }),
    place: async (plan, maxMs) => {
      const result = await (plan.surface === 'lava' ? placeBoatOnLava : placeBoatOn)(session, ctl, { at: plan.at, maxMs })
      return result.ok ? result.boat!.id : null
    },
    mount: async (id, maxMs) => {
      const boat = bot.entities[id]
      const result = await mountBoat(session, ctl, boat, { maxMs })
      if (!result.ok) session.bus.emit('boat_mount_failed', { id, why: result.why, aborted: ctl.aborted,
        boat: boat && { name: boat.name, type: boat.type, width: boat.width, height: boat.height, position: boat.position, isValid: boat.isValid,
          passengers: boat.passengers?.map((passenger: Body | number) => typeof passenger === 'object' ? passenger.id : passenger) } })
      return result.ok
    },
    breakBoat: (id, maxMs) => breakBoatEntity(session, ctl, id, maxMs)
  }, { maxHops: Math.min(12, Math.max(1, request.maxHops ?? 8)), budgetMs: Math.min(15, Math.max(1, request.timeoutSeconds ?? 10)) * 1000, fallClutch: request.mode === 'fall' })
  session.bus.emit('boat_hop_result', result)
  return result
}
