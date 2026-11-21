import { Vec3 } from 'vec3'
import * as pick from '../pick'
import { seesPlayer, gearPartVisible, visiblePlayerItem } from '../pvp/last-seen'
import { observedCollision } from '../pvp/search'
import { DRAG, GRAVITY, SPEED } from '../bow/ballistics'
import * as clock from '../game-clock'

type Body = Record<string, any>
type Point = { x: number; y: number; z: number }
type Kind = 'respawn_anchor' | 'end_crystal' | 'tnt_minecart'
export interface InstantBlast { kind: Kind; at: Vec3; reach: number; fuse: null; foe?: string; projectile?: number; id?: number }
interface AnchorArea { world: unknown; dimension: string; from: Vec3 | null; cells: Map<string, Vec3> }
const anchorAreas = new WeakMap<object, AnchorArea>()

// Candidate locations stay private. The eye must still see a face before the charge level can be read.
function nearbyAnchors (bot: Body, me: Vec3): Iterable<Vec3> {
  const id = bot.registry?.blocksByName?.respawn_anchor?.id
  if (id == null || typeof bot.findBlocks !== 'function') return []
  let area = anchorAreas.get(bot)
  if (!area) {
    const index: AnchorArea = { world: bot.world, dimension: bot.game.dimension, from: null, cells: new Map() }
    area = index
    anchorAreas.set(bot, index)
    bot.on?.('chunkColumnLoad', (corner: Vec3) => {
      if (index.from && Math.abs(corner.x + 8 - index.from.x) <= 24 && Math.abs(corner.z + 8 - index.from.z) <= 24) index.from = null
    })
    bot.on?.('blockUpdate', (oldBlock: Body | null, block: Body | null) => {
      if (!index.from || (oldBlock?.type !== id && block?.type !== id)) return
      const cell = block?.position ?? oldBlock?.position
      if (!cell || cell.distanceTo(index.from) > 16) return
      if (block?.type === id) index.cells.set(cell.toString(), cell)
      else index.cells.delete(cell.toString())
    })
  }
  if (!area.from || area.world !== bot.world || area.dimension !== bot.game.dimension || me.distanceTo(area.from) > 4) {
    area.world = bot.world
    area.dimension = bot.game.dimension
    area.from = me.clone()
    area.cells.clear()
    for (const cell of bot.findBlocks({ point: me, matching: id, maxDistance: 16, count: 256 })) area.cells.set(cell.toString(), cell)
  }
  return area.cells.values()
}

const solidUnknown = { name: 'unknown', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
function knownWorld (bot: Body) {
  const observed = observedCollision(bot, undefined, true, pick.eyeOf(bot))
  return { entity: bot.entity, blockAt: (p: Vec3) => observed.blockAt(p) || solidUnknown }
}
function nearestPoint (eye: Vec3, lo: Point, hi: Point) {
  return new Vec3(Math.max(lo.x, Math.min(eye.x, hi.x)), Math.max(lo.y, Math.min(eye.y, hi.y)), Math.max(lo.z, Math.min(eye.z, hi.z)))
}

// The drawn bow must be pointed at the crystal in both axes. Trace its native full-draw arc,
// stopping at the first collision. Unobserved space cannot establish a clear firing lane.
function aimedAtExplosive (bot: Body, foe: Body, target: Body, world: ReturnType<typeof knownWorld>) {
  const flags = foe.metadata?.[bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('living_entity_flags') ?? 8]
  if (!(flags & 1) || !Number.isFinite(foe.pitch) || !Number.isFinite(foe.yaw)) return false
  const hand = flags & 2 ? 1 : 0
  if (!gearPartVisible(bot, foe, hand)) return false
  const bow = visiblePlayerItem(foe.equipment?.[hand])
  // A plain arrow cannot ignite a cart. Visible glint allows Flame; the actual enchantment is private.
  if (bow?.name !== 'bow' || (target.name === 'tnt_minecart' && !bow.enchanted)) return false
  const pos = foe.position.offset(0, pick.eyeHeight(bot, foe) - .1, 0)
  const horiz = Math.cos(foe.pitch)
  const vel = new Vec3(-Math.sin(foe.yaw) * horiz, Math.sin(foe.pitch), -Math.cos(foe.yaw) * horiz).scaled(SPEED)
  return flightHits(bot, target, world, pos, vel, 32)
}

function flightHits (bot: Body, target: Body, world: ReturnType<typeof knownWorld>, pos: Vec3, vel: Vec3, horizon: number) {
  const box = pick.hitboxOf(bot, target), segments = []
  for (let tick = 0; tick < horizon; tick++) {
    const length = vel.norm(), dir = vel.scaled(1 / length)
    const hit = pick.rayBox(pos, dir, box.lo, box.hi, length)
    segments.push({ pos, dir, length: hit ?? length })
    if (hit != null) return segments.every(s => !pick.blockOnRay(world, s.pos, s.dir, s.length))
    pos = pos.plus(vel)
    vel = vel.scaled(DRAG)
    vel.y -= GRAVITY
  }
  return false
}

function firedAtExplosive (bot: Body, target: Body, arrows: Body[], world: ReturnType<typeof knownWorld>) {
  if (!arrows.length) return undefined
  const { projectileView, projectileVelocity, thrownTracker } = require('../threats') as typeof import('../threats')
  for (const arrow of arrows) {
    if (arrow.position.distanceTo(target.position) > 36) continue
    const now = clock.now(), view = projectileView(bot, arrow, now)
    if (!view) continue
    const inGround = bot.registry?.entitiesByName?.[arrow.name]?.metadataKeys?.indexOf('in_ground')
    if (arrow.metadata?.[inGround] || target.name === 'tnt_minecart' && !(Number(arrow.metadata?.[0]) & 1)) continue
    const measured = projectileVelocity(view, now)
    // Visible network spawn is a valid first frame. An old launch vector cannot predict an arrow
    // that stopped, was deflected or reappeared at some other point out of view.
    const birth = thrownTracker(bot).get(arrow.id)
    const freshBirth = birth?.name === arrow.name && clock.observationNow() - birth.observedAt < 50 &&
      view.position.distanceTo(new Vec3(birth.p.x, birth.p.y, birth.p.z)) < .01
    const v = measured ?? (freshBirth ? birth.v : null)
    if (!v) continue
    const velocity = new Vec3(v.x, v.y, v.z)
    if (velocity.norm() < .05) continue
    // A measured delta was the previous step. Drag and gravity act before the upcoming one.
    if (measured) { velocity.scale(DRAG); velocity.y -= GRAVITY }
    if (flightHits(bot, target, world, view.position, velocity, 12)) return arrow
  }
  return undefined
}

export function instantBlasts (bot: Body, foes: string[] | null): InstantBlast[] {
  const me = bot.entity?.position
  if (!me) return []
  const entities = Object.values(bot.entities || {}) as Body[]
  const actors = entities.filter(e => e?.type === 'player' && e !== bot.entity &&
    (foes ? foes.includes(e.username) : !bot._ndSwarmAllies?.includes(e.username)) &&
    e.isValid !== false && bot.players?.[e.username]?.gamemode !== 3 && e.position)
  const arrows = entities.filter(e => /^(?:spectral_)?arrow$/.test(e?.name) && e.position && e.isValid !== false)
  if (!actors.length && !arrows.length) return []
  const seen = new Map<Body, boolean>()
  const visible = (e: Body) => {
    if (!seen.has(e)) seen.set(e, seesPlayer(bot, e))
    return seen.get(e)
  }
  let observed: ReturnType<typeof knownWorld> | undefined
  const terrain = () => observed ??= knownWorld(bot)
  const out: InstantBlast[] = []
  const near = actors.filter(e => e.position.distanceTo(me) <= 16)
  if (/^(?:minecraft:)?(?:overworld|the_end|end)$/.test(bot.game?.dimension) && near.length) {
    for (const cell of nearbyAnchors(bot, me)) {
      const center = cell.offset(.5, .5, .5)
      if (center.distanceTo(me) > 10 || !pick.blockSeen(bot, cell, { range: 12 })) continue
      const block = bot.blockAt(cell, false)
      if (block?.name !== 'respawn_anchor') continue
      const charged = Number(block.getProperties?.().charges) > 0
      const foe = near.find(e => {
        const eye = e.position.offset(0, pick.eyeHeight(bot, e), 0)
        if (nearestPoint(eye, cell, cell.offset(1, 1, 1)).distanceTo(eye) > 4.5 || !visible(e)) return false
        if (!charged && ![0, 1].some(slot => gearPartVisible(bot, e, slot) && e.equipment?.[slot]?.name === 'glowstone')) return false
        return pick.blockAim(terrain(), cell, { eye, range: 4.5, seeThrough: null })
      })
      if (foe) out.push({ kind: 'respawn_anchor', at: center, reach: 10, fuse: null, foe: foe.username })
    }
  }
  for (const explosive of entities) {
    const kind = explosive?.name
    if (kind !== 'end_crystal' && kind !== 'tnt_minecart') continue
    // Full-draw fire arrow speed ~3; MinecartTNT adds up to 1.5 * speed to the base power of 4.
    const reach = kind === 'end_crystal' ? 12 : 2 * (4 + 1.5 * SPEED)
    if (explosive.isValid === false || !explosive.position || explosive.position.distanceTo(me) > reach || !seesPlayer(bot, explosive)) continue
    const projectile = firedAtExplosive(bot, explosive, arrows, terrain())
    if (projectile) {
      out.push({ kind, at: explosive.position.clone(), reach, fuse: null, projectile: projectile.id, id: explosive.id })
      continue
    }
    const box = pick.hitboxOf(bot, explosive)
    const foe = actors.find(e => {
      if (e.position.distanceTo(explosive.position) > 64 || !visible(e)) return false
      if (kind === 'end_crystal') {
        const eye = e.position.offset(0, pick.eyeHeight(bot, e), 0)
        const delta = nearestPoint(eye, box.lo, box.hi).minus(eye), distance = delta.norm()
        if (distance <= 3 && (!distance || !pick.blockOnRay(terrain(), eye, delta.scaled(1 / distance), distance))) return true
      }
      return aimedAtExplosive(bot, e, explosive, terrain())
    })
    if (foe) out.push({ kind, at: explosive.position.clone(), reach, fuse: null, foe: foe.username, id: explosive.id })
  }
  return out
}
