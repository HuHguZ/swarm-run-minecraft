type Body = Record<string, any>
export interface BoatController { aborted: boolean; onAbort: Array<() => void> }
export interface BoatPosition { x: number; y: number; z: number }
export interface BoatPlacementResult { ok: boolean; why?: string; boat?: Body }
const clock = require('../game-clock')
const pick = require('../pick')
const ride = require('../ride')
const Vec3 = require('vec3')

export function boatItem(bot: Body): Body | null {
  return bot.inventory.items().find((item: Body) => /_(boat|raft)$/.test(item.name) && !/chest/.test(item.name)) || null
}

export function mountedBoatDry(bot: Body): boolean {
  const boat = bot.vehicle
  if (!boat?.position || !ride.isBoatName(boat.name || '') || !bot.entities?.[boat.id] || boat.isValid === false) return false
  const point = boat.position
  const floor = bot.blockAt(point.offset(0, -.05, 0))
  if (floor?.boundingBox !== 'block' || /lava|magma|fire/.test(floor.name)) return false
  return [0, .3].every(y => {
    const block = bot.blockAt(point.offset(0, y, 0))
    return block?.boundingBox === 'empty' && !/lava|fire/.test(block.name)
  })
}

export function boatBaseVisible(bot: Body, at: BoatPosition): boolean {
  const base = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
  if (bot.blockAt(base)?.boundingBox !== 'block') return false
  if (!pick.faceAim(bot, base, new Vec3(0, 1, 0))) return false
  for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
    const above = bot.blockAt(base.offset(dx, 1, dz))
    if (!above || above.boundingBox !== 'empty' || /lava|fire/.test(above.name)) return false
  }
  return true
}

export function boatLavaAim(bot: Body, at: BoatPosition): Body | null {
  const base = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
  const fluid = bot.blockAt(base)
  if (fluid?.name !== 'lava') return null
  const aim = base.offset(.5, 8 / 9, .5)
  const eye = pick.eyeOf(bot)
  const delta = aim.minus(eye)
  const distance = delta.norm()
  if (distance > 4.2 || distance < .01) return null
  const direction = delta.scaled(1 / distance)
  const wall = pick.blockOnRay(bot, eye, direction, distance)
  if (wall && wall.t < distance - .02) return null
  let first: Body | null = null
  let previousCell: Body | null = null
  for (let t = 0; t <= distance + .05; t += .025) {
    const point = eye.plus(direction.scaled(Math.min(t, distance)))
    const cell = point.floored()
    if (previousCell?.equals(cell)) continue
    previousCell = cell
    const block = bot.blockAt(point)
    if (!block || /water/.test(block.name)) return null
    if (block.name !== 'lava') continue
    const properties = block.getProperties?.() || {}
    const level = Number(properties.level || 0)
    const height = bot.blockAt(block.position.offset(0, 1, 0))?.name === 'lava' ? 1 : level >= 8 ? 8 / 9 : (8 - level) / 9
    const hit = pick.rayBox(eye, direction, block.position, block.position.offset(1, height, 1), distance)
    if (hit !== null) { first = { point: eye.plus(direction.scaled(hit)), base: block.position }; break }
  }
  if (!first || !first.base.equals(base)) return null
  const point = first.point
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const bottom = bot.blockAt(base.offset(dx, 0, dz))
    if (!bottom) return null
    if (bottom.boundingBox === 'block') {
      for (const shape of bottom.shapes || [[0, 0, 0, 1, 1, 1]]) {
        const x0 = bottom.position.x + shape[0]; const y0 = bottom.position.y + shape[1]; const z0 = bottom.position.z + shape[2]
        const x1 = bottom.position.x + shape[3]; const y1 = bottom.position.y + shape[4]; const z1 = bottom.position.z + shape[5]
        if (point.x + .6875 > x0 && point.x - .6875 < x1 && point.y + .5625 > y0 && point.y < y1 && point.z + .6875 > z0 && point.z - .6875 < z1) return null
      }
    }
    const top = bot.blockAt(base.offset(dx, 1, dz))
    if (!top || top.boundingBox !== 'empty' || /lava/.test(top.name)) return null
  }
  for (const entity of Object.values(bot.entities || {}) as Body[]) {
    if (!entity?.position || entity === bot.entity || entity.isValid === false) continue
    const box = pick.hitboxOf(bot, entity)
    const hit = pick.rayBox(eye, direction, box.lo, box.hi, distance)
    if (hit !== null && hit < distance) return null
  }
  return point
}

function waitForBoat(bot: Body, ctl: BoatController, before: Set<number>, point: Body, maxMs: number): Promise<Body | null> {
  return new Promise((resolve, reject) => {
    let finished = false
    const complete = (boat: Body | null, error?: unknown) => {
      if (finished) return
      finished = true
      clock.clearTimeout(timer)
      bot.removeListener?.('entitySpawn', spawned)
      bot.removeListener?.('death', failed)
      bot.removeListener?.('end', failed)
      ctl.onAbort = ctl.onAbort.filter(callback => callback !== failed)
      if (error) reject(error)
      else resolve(boat)
    }
    const failed = () => complete(null)
    const spawned = (entity: Body) => {
      if (!before.has(entity.id) && ride.isBoatName(entity.name || '') && entity.position?.distanceTo(point) < 2) complete(entity)
    }
    const timer = clock.setTimeout(failed, maxMs)
    bot.on?.('entitySpawn', spawned)
    bot.once?.('death', failed)
    bot.once?.('end', failed)
    ctl.onAbort.push(failed)
    if (ctl.aborted || bot.health <= 0) return failed()
    try { bot.activateItem() } catch (error) { return complete(null, error) }
    for (const entity of Object.values(bot.entities) as Body[]) if (entity) spawned(entity)
  })
}

export async function placeBoatOnLava(session: Body, ctl: BoatController, { at, maxMs = 1000 }: { at: BoatPosition; maxMs?: number }): Promise<BoatPlacementResult> {
  const bot = session.bot
  const item = boatItem(bot)
  let aim = boatLavaAim(bot, at)
  if (ctl.aborted || !item || !aim) return { ok: false, why: 'visible collision-free lava placement unavailable' }
  const before = new Set<number>((Object.values(bot.entities) as Body[]).filter(entity => ride.isBoatName(entity.name || '')).map(entity => entity.id))
  await bot.equip(item, 'hand')
  session.bus?.emit('boat_placement_step', { step: 'equipped', health: bot.health, held: bot.heldItem?.name, position: bot.entity.position.clone() })
  aim = boatLavaAim(bot, at)
  if (ctl.aborted || !aim) return { ok: false, why: 'lava placement changed' }
  await bot.lookAt(aim, true)
  if (ctl.aborted) return { ok: false, why: 'lava placement interrupted' }
  const waiting = waitForBoat(bot, ctl, before, aim, maxMs)
  session.bus?.emit('boat_placement_step', { step: 'use_requested', health: bot.health, aim, yaw: bot.entity.yaw, pitch: bot.entity.pitch, position: bot.entity.position.clone() })
  const boat = await waiting
  if (boat) return { ok: true, boat }
  return { ok: false, why: ctl.aborted ? 'lava placement interrupted' : 'actual lava boat spawn not confirmed' }
}

export async function placeBoatOn(session: Body, ctl: BoatController, { at, maxMs = 2500 }: { at: BoatPosition; maxMs?: number }): Promise<BoatPlacementResult> {
  const bot = session.bot
  const item = boatItem(bot)
  const base = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
  if (ctl.aborted || !item || !boatBaseVisible(bot, base)) return { ok: false, why: ctl.aborted ? 'interrupted' : !item ? 'boat unavailable' : 'boat base is occupied or its top face is not visible' }
  const before = new Set<number>((Object.values(bot.entities) as Body[]).filter(entity => ride.isBoatName(entity.name || '')).map(entity => entity.id))
  await bot.equip(item, 'hand')
  const aim = pick.faceAim(bot, base, new Vec3(0, 1, 0))
  if (ctl.aborted || !aim) return { ok: false, why: 'boat base changed before use' }
  await bot.lookAt(aim, true)
  if (ctl.aborted) return { ok: false, why: 'interrupted before boat use' }
  const boat = await waitForBoat(bot, ctl, before, base.offset(.5, 1, .5), maxMs)
  if (boat) return { ok: true, boat }
  return { ok: false, why: ctl.aborted ? 'boat placement interrupted' : 'boat spawn not confirmed' }
}

export async function mountBoat(session: Body, ctl: BoatController, boat: Body, { maxMs = 2500 }: { maxMs?: number } = {}): Promise<BoatPlacementResult> {
  const bot = session.bot
  if (ctl.aborted || !boat?.position || !ride.isBoatName(boat.name || '') || boat.passengers?.length) return { ok: false, why: 'boat mount unavailable' }
  const aim = pick.aim(bot, boat, { range: 3 })
  if (!aim?.point) return { ok: false, why: 'boat is outside visible interaction range' }
  const mounted = await ride.mountOn(bot, ctl, boat, maxMs)
  return mounted && !ctl.aborted && bot.vehicle?.id === boat.id ? { ok: true, boat } : { ok: false, why: 'server passenger mount not confirmed' }
}
