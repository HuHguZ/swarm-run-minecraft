import { seesPlayer, observePlayerGear, createLastSeen } from './pvp/last-seen'
import * as clock from './game-clock'
import { wingPeak } from './combat/wing-orbit'
import { recentlyWindAffected } from './combat/enemy-wind'
const previous = new WeakMap<object, Map<number, any>>()
const gearMemory = new WeakMap<object, Map<number, any>>()
const sights = new WeakMap<object, ReturnType<typeof createLastSeen>>()

// Share what this body sees; packet-only movement cannot refresh the team's memory.
export function swarmSightings(bot: any, allies: string[] = []) {
  if (!bot?.entity) return []
  let sight = sights.get(bot)
  if (!sight && bot.physics && typeof bot.on === 'function') {
    sight = createLastSeen(bot); sights.set(bot, sight)
    bot.once('end', () => { sight.close(); sights.delete(bot) })
  }
  const excluded = new Set(Array.isArray(allies) ? allies : [])
  // Только имена команды из её же опроса: позиции для стройки всё равно нужны видимые сейчас.
  bot._ndSwarmAllies = [...excluded]
  const before = previous.get(bot) || new Map()
  const current = new Map<number, any>()
  const sightings = []
  const now = clock.now()
  const remembered = gearMemory.get(bot) || new Map()
  for (const e of Object.values(bot.entities || {}) as any[]) {
    if (e === bot.entity || !e?.username || excluded.has(e.username)) continue
    const mode = bot.players?.[e.username]?.gamemode
    if (mode === 1 || mode === 3) continue
    const position = { x: e.position.x, y: e.position.y, z: e.position.z }
    if (!Object.values(position).every(Number.isFinite)) continue
    // Ник игрока виден сквозь стены (клиент рисует его поверх блоков в 64 бл.), если он не крадётся и не невидим — это видит и
    // человек (пользователь 25.10: «вылезаю с другого этажа — как будто не видят мой ник заранее»). Только место и движение:
    // снаряжение за стеной не видно, visible: false — не цель для выстрела и броска.
    if (!seesPlayer(bot, e)) {
      sight?.observe(e)
      const flags = Number(e.metadata?.[0]) || 0
      if (flags & 0x02 || flags & 0x20 || bot.entity.position.distanceTo(e.position) > 64) continue
      const old = before.get(e.id), ticks = old && old.now < now ? (now - old.now) / 50 : 0
      const velocity = ticks ? Object.fromEntries(['x', 'y', 'z'].map(k => [k, (position[k] - old.position[k]) / ticks])) : { x: 0, y: 0, z: 0 }
      const known = remembered.get(e.id)?.raw === e ? remembered.get(e.id).projection?.equipment || [] : []
      const weapon = known[0]?.name || null
      sightings.push({ id: e.username, position, velocity, peakY: null, equipment: { weapon, armor: known.slice(2, 6).map(it => it?.name).filter(Boolean) }, threat: /bow|crossbow/.test(weapon || '') ? 'bow' : 'melee', visible: false, nametag: true, seenAt: now })
      current.set(e.id, { position, now })
      continue
    }
    const old = before.get(e.id)
    const ticks = old && old.now < now ? (now - old.now) / 50 : 0
    const velocity = ticks ? Object.fromEntries(['x', 'y', 'z'].map(k => [k, (position[k] - old.position[k]) / ticks])) : { x: 0, y: 0, z: 0 }
    const projection = observePlayerGear(bot, e, remembered.get(e.id)?.raw === e ? remembered.get(e.id).projection : null)
    remembered.set(e.id, { raw: e, projection })
    const gear = projection.equipment
    const equipment = { weapon: gear[0]?.name || null, armor: gear.slice(2, 6).map(it => it?.name).filter(Boolean), ...(projection.unknownArmorSlots ? { unknownArmorSlots: projection.unknownArmorSlots } : {}), ...(gear.some(it => it?.enchanted) ? { enchanted: true } : {}) }
    const threat = /bow|crossbow/.test(equipment.weapon || '') ? 'bow' : /^(end_crystal|respawn_anchor)$/.test(equipment.weapon || '') ? 'blast' : e.elytraFlying || equipment.weapon === 'mace' && velocity.y < -.2 ? 'aerial' : 'melee'
    const observer: typeof import('./pvp/combat-observe') = require('./pvp/combat-observe')
    const hp = observer.foeHpUpper(bot, e), hitProof = observer.foeHitProof(bot, e)
    // В воздухе высоко над опорой (подлетел: заряд, булава, удар) — рою позиции для бокового броска ветром (driver wind.ts).
    const airborne = !e.onGround && (require('./combat/wind-out') as typeof import('./combat/wind-out')).heightAbove(bot, e.position) >= 2.5
    const gliding = (require('./elytra/track') as typeof import('./elytra/track')).gliding(e)
    // The radio's 500ms average can straddle launch; keep it and publish the fast fair native apex separately.
    const observed = sight && (airborne || equipment.weapon === 'wind_charge') ? sight.observe(e) : null
    const peakY = airborne && !gliding && observed ? wingPeak(bot, observed) : null
    const windAffected = airborne && !gliding && recentlyWindAffected(bot, e)
    sightings.push({ id: e.username, position, velocity, peakY, equipment, threat, visible: true, seenAt: now, gliding, ...(airborne ? { airborne: true } : {}), ...(windAffected ? { windAffected: true } : {}), ...(Number.isFinite(hp) ? { hpEstimate: hp } : {}), ...(hitProof && (hitProof.hits.length || hitProof.healing) ? { hitProof } : {}) })
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
