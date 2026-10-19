import { seesPlayer, observePlayerGear } from './pvp/last-seen'
import * as clock from './game-clock'
const previous = new WeakMap<object, Map<number, any>>()
const gearMemory = new WeakMap<object, Map<number, any>>()

// Share what this body sees; packet-only movement cannot refresh the team's memory.
export function swarmSightings(bot: any, allies: string[] = []) {
  if (!bot?.entity) return []
  const excluded = new Set(Array.isArray(allies) ? allies : [])
  const before = previous.get(bot) || new Map()
  const current = new Map<number, any>()
  const sightings = []
  const now = clock.now()
  const remembered = gearMemory.get(bot) || new Map()
  for (const e of Object.values(bot.entities || {}) as any[]) {
    if (e === bot.entity || !e?.username || excluded.has(e.username) || !seesPlayer(bot, e)) continue
    const position = { x: e.position.x, y: e.position.y, z: e.position.z }
    if (!Object.values(position).every(Number.isFinite)) continue
    const old = before.get(e.id)
    const ticks = old && old.now < now ? (now - old.now) / 50 : 0
    const velocity = ticks ? Object.fromEntries(['x', 'y', 'z'].map(k => [k, (position[k] - old.position[k]) / ticks])) : { x: 0, y: 0, z: 0 }
    const projection = observePlayerGear(bot, e, remembered.get(e.id)?.raw === e ? remembered.get(e.id).projection : null)
    remembered.set(e.id, { raw: e, projection })
    const gear = projection.equipment
    const equipment = { weapon: gear[0]?.name || null, armor: gear.slice(2, 6).map(it => it?.name).filter(Boolean), ...(projection.unknownArmorSlots ? { unknownArmorSlots: projection.unknownArmorSlots } : {}), ...(gear.some(it => it?.enchanted) ? { enchanted: true } : {}) }
    const threat = /bow|crossbow/.test(equipment.weapon || '') ? 'bow' : /end_crystal|tnt/.test(equipment.weapon || '') ? 'blast' : e.elytraFlying || equipment.weapon === 'mace' && velocity.y < -.2 ? 'aerial' : 'melee'
    const hp = (require('./pvp/combat-observe') as typeof import('./pvp/combat-observe')).foeHpUpper(bot, e)
    sightings.push({ id: e.username, position, velocity, equipment, threat, visible: true, seenAt: now, ...(Number.isFinite(hp) && hp < 20 ? { hpEstimate: hp } : {}) })
    current.set(e.id, { position, now })
  }
  previous.set(bot, current)
  gearMemory.set(bot, remembered)
  return sightings
}

// A nearby cell may be in hand range while all its reference faces are hidden.
export function placementPoses(bot: any, at: any) {
  if (!bot?.entity || !at || !['x', 'y', 'z'].every(k => Number.isSafeInteger(at[k])) || at.y < -64 || at.y > 319 || Math.abs(at.x) >= 30000000 || Math.abs(at.z) >= 30000000) return []
  const { Vec3 }: typeof import('vec3') = require('vec3'), pick: typeof import('./pick') = require('./pick')
  const { standPositions, verticalLift }: typeof import('./navigation/geometry') = require('./navigation/geometry')
  const observed = (require('./pvp/search') as typeof import('./pvp/search')).observedCollision(bot)
  const target = new Vec3(at.x, at.y, at.z), poses = [], explore = []
  const references = (require('./build') as typeof import('./build')).FACES.map(face => ({ face, pos: target.minus(face) })).filter(ref => {
    const block = observed.blockAt(ref.pos)
    return block?.boundingBox === 'block'
  })
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    for (const p of standPositions(observed, target.offset(x, 0, z), { rise: 1, drop: 3 })) {
      if (p.distanceTo(bot.entity.position) > 8 || p.distanceTo(bot.entity.position) < .4) continue
      const eye = p.offset(0, 1.62, 0)
      const delta = target.offset(.5, .5, .5).minus(eye), length = delta.norm()
      const hit = pick.blockOnRay(observed, eye, delta.scaled(1 / length), length)
      const viewpoint = !hit || hit.pos.equals(target)
      const jump = verticalLift(observed, p, .95)
      const jumpFace = jump > .4 && references.some(ref => pick.faceAim(bot, ref.pos, ref.face, { eye: eye.offset(0, jump, 0) }))
      const pose = { x: p.x, y: p.y, z: p.z }
      if (references.some(ref => pick.faceAim(bot, ref.pos, ref.face, { eye })) || jumpFace || viewpoint && p.distanceTo(target) < 4) poses.push(pose)
      else if (p.distanceTo(bot.entity.position) >= 1.2) explore.push(pose)
    }
  }
  if (poses.length) return poses.sort((a, b) => new Vec3(a.x, a.y, a.z).distanceTo(bot.entity.position) - new Vec3(b.x, b.y, b.z).distanceTo(bot.entity.position)).slice(0, 8)
  // Walk around the known wall to reveal its other side, then ask for faces again.
  return explore.sort((a, b) => new Vec3(a.x, a.y, a.z).distanceTo(target) - new Vec3(b.x, b.y, b.z).distanceTo(target)).slice(0, 8)
}
