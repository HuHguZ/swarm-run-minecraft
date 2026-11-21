import { seesPlayer, observePlayerGear, createLastSeen } from './pvp/last-seen'
import * as clock from './game-clock'
import { wingPeak } from './combat/wing-orbit'
import { recentlyWindAffected } from './combat/enemy-wind'
const previous = new WeakMap<object, Map<number, any>>()
const gearMemory = new WeakMap<object, Map<number, any>>()
const sights = new WeakMap<object, ReturnType<typeof createLastSeen>>()

type DeathSpot = { position: { x: number; y: number; z: number }; at: number; dimension: string; self: boolean }
const deathRadios = new WeakMap<object, { scope: string; pending: Map<string, DeathSpot> }>()

// Record the rendered death at packet time. Seeing the player before a wall or hearing chat gives no death location.
export function witnessedDeaths(bot: any, scope: string, consume = true) {
  if (!bot?.entity || !scope || typeof bot.on !== 'function') return []
  let radio = deathRadios.get(bot)
  if (!consume && radio?.scope !== scope) return []
  if (!radio) {
    const pending = new Map<string, DeathSpot>()
    radio = { scope, pending }; deathRadios.set(bot, radio)
    const playing = () => ['survival', 'adventure'].includes(bot.game?.gameMode)
    const note = (p, self: boolean) => {
      if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return
      const at = clock.now(), key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      for (const [k, d] of pending) if (at - d.at >= 280000 || d.dimension !== bot.game.dimension) pending.delete(k)
      if (pending.get(key)?.self && !self) return
      pending.set(key, { position: { x: p.x, y: p.y, z: p.z }, at, dimension: bot.game.dimension, self })
    }
    const self = () => { if (playing()) note(bot.entity?.position, true) }
    const other = e => { if (playing() && bot.isAlive !== false && bot.health > 0 && e !== bot.entity && e?.type === 'player' && seesPlayer(bot, e)) note(e.position, false) }
    bot.on('death', self); bot.on('entityDead', other)
    bot.once('end', () => { bot.removeListener('death', self); bot.removeListener('entityDead', other); deathRadios.delete(bot) })
  }
  if (radio.scope !== scope) { radio.scope = scope; radio.pending.clear() }
  if (!radio.pending.size) return []
  const now = clock.now(), reports = []
  for (const d of radio.pending.values()) {
    const ageMs = now - d.at
    if (ageMs >= 0 && ageMs < 280000 && d.dimension === bot.game?.dimension) reports.push({ position: d.position, ageMs, self: d.self })
  }
  if (consume) radio.pending.clear()
  return reports
}

export function playerCues(bot: any, e: any) {
  const flags = Number(e.metadata?.[0]) || 0, distance = bot.entity.position.distanceTo(e.position)
  return { invisible: !!(flags & 0x20), nametag: !(flags & 0x22) && distance <= 64,
    crouchName: !(flags & 0x20) && !!(flags & 0x02) && distance < 32, glowing: !!(flags & 0x40) && distance <= 128 }
}

// Share what this body sees; packet-only movement cannot refresh the team's memory.
export function swarmSightings(bot: any, allies: string[] = bot?._ndSwarmAllies ?? [], publish = true) {
  if (!bot?.entity) return []
  let sight = sights.get(bot)
  if (publish && !sight && bot.physics && typeof bot.on === 'function') {
    sight = createLastSeen(bot); sights.set(bot, sight)
    // An invisible figure can disappear and return between radio polls. Losing the track also loses its name.
    const trackNames = () => {
      for (const entry of previous.get(bot)?.values() || []) {
        if (!entry.identified) continue
        const raw = entry.raw
        if (entry.observer !== bot.entity || bot.entities?.[raw.id] !== raw || raw.isValid === false) { entry.identified = false; continue }
        const cues = playerCues(bot, raw)
        if (cues.nametag || cues.glowing) continue
        entry.identified = (cues.invisible || cues.crouchName) && seesPlayer(bot, raw)
        if (!entry.identified) entry.lost = true
      }
    }
    bot.on('physicsTick', trackNames)
    bot.once('end', () => { bot.removeListener('physicsTick', trackNames); sight.close(); sights.delete(bot); previous.delete(bot) })
  }
  const excluded = new Set(Array.isArray(allies) ? allies : [])
  // Только имена команды из её же опроса: позиции для стройки всё равно нужны видимые сейчас.
  if (publish) bot._ndSwarmAllies = [...excluded]
  const before = previous.get(bot) || new Map()
  const current = new Map<number, any>()
  const sightings = []
  const now = clock.now()
  const remembered = gearMemory.get(bot) || new Map()
  for (const e of Object.values(bot.entities || {}) as any[]) {
    if (e === bot.entity || !e?.username || e.isValid === false || excluded.has(e.username)) continue
    const mode = bot.players?.[e.username]?.gamemode
    if (mode === 1 || mode === 3) continue
    const position = { x: e.position.x, y: e.position.y, z: e.position.z }
    if (!Object.values(position).every(Number.isFinite)) continue
    const cues = playerCues(bot, e), prior = before.get(e.id)
    const old = prior?.raw === e && prior.observer === bot.entity && !prior.lost ? prior : null
    // Ник игрока виден сквозь стены (клиент рисует его поверх блоков в 64 бл.), если он не крадётся и не невидим — это видит и
    // человек (пользователь 25.10: «вылезаю с другого этажа — как будто не видят мой ник заранее»). Только место и движение:
    // снаряжение за стеной не видно, visible: false — не цель для выстрела и броска.
    if (!seesPlayer(bot, e)) {
      if (publish) sight?.markOccluded(e)
      const { nametag, glowing } = cues
      if (!nametag && !(glowing && old?.identified)) continue
      const ticks = old?.identified && old.now < now ? (now - old.now) / 50 : 0
      const velocity = ticks ? Object.fromEntries(['x', 'y', 'z'].map(k => [k, (position[k] - old.position[k]) / ticks])) : { x: 0, y: 0, z: 0 }
      const known = remembered.get(e.id)?.raw === e ? remembered.get(e.id).projection?.equipment || [] : []
      const weapon = known[0]?.name || null
      sightings.push({ id: e.username, position, velocity, peakY: null, equipment: { weapon, armor: known.slice(2, 6).map(it => it?.name).filter(Boolean) }, threat: /bow|crossbow/.test(weapon || '') ? 'bow' : 'melee', visible: false, ...(nametag ? { nametag: true } : {}), ...(glowing ? { glowing: true } : {}), seenAt: now })
      current.set(e.id, { position, now, raw: e, observer: bot.entity, identified: true })
      continue
    }
    const identified = cues.nametag || cues.crouchName || !!old?.identified
    if (cues.invisible && !identified) continue
    const ticks = old && old.now < now ? (now - old.now) / 50 : 0
    const velocity = ticks ? Object.fromEntries(['x', 'y', 'z'].map(k => [k, (position[k] - old.position[k]) / ticks])) : { x: 0, y: 0, z: 0 }
    const projection = observePlayerGear(bot, e, remembered.get(e.id)?.raw === e ? remembered.get(e.id).projection : null)
    if (publish) remembered.set(e.id, { raw: e, projection })
    const gear = projection.equipment
    const equipment = { weapon: gear[0]?.name || null, ...(projection.known[0] ? { weaponEnchanted: !!gear[0]?.enchanted } : {}), armor: gear.slice(2, 6).map(it => it?.name).filter(Boolean), armorVisible: projection.visible.slice(2, 6), armorEnchanted: gear.slice(2, 6).map(it => !!it?.enchanted), ...(projection.unknownArmorSlots ? { unknownArmorSlots: projection.unknownArmorSlots } : {}), ...(gear.some(it => it?.enchanted) ? { enchanted: true } : {}) }
    const threat = /bow|crossbow/.test(equipment.weapon || '') ? 'bow' : /^(end_crystal|respawn_anchor)$/.test(equipment.weapon || '') ? 'blast' : e.elytraFlying || equipment.weapon === 'mace' && velocity.y < -.2 ? 'aerial' : 'melee'
    const observer: typeof import('./pvp/combat-observe') = require('./pvp/combat-observe')
    const hp = observer.foeHpUpper(bot, e), hitProof = observer.foeHitProof(bot, e)
    // В воздухе высоко над опорой (подлетел: заряд, булава, удар) — рою позиции для бокового броска ветром (driver wind.ts).
    const airborne = !e.onGround && (require('./combat/wind-out') as typeof import('./combat/wind-out')).heightAbove(bot, e.position) >= 2.5
    const gliding = (require('./elytra/track') as typeof import('./elytra/track')).gliding(e)
    // The radio's 500ms average can straddle launch; keep it and publish the fast fair native apex separately.
    const observed = sight && (airborne || equipment.weapon === 'wind_charge') ? (publish ? sight.observe(e) : old?.observed) : null
    const peakY = airborne && !gliding && observed ? wingPeak(bot, observed) : null
    const windAffected = airborne && !gliding && recentlyWindAffected(bot, e)
    sightings.push({ id: e.username, position, velocity, peakY, equipment, threat, visible: true, seenAt: now, gliding, ...(airborne ? { airborne: true } : {}), ...(windAffected ? { windAffected: true } : {}), ...(Number.isFinite(hp) ? { hpEstimate: hp } : {}), ...(hitProof && (hitProof.hits.length || hitProof.healing) ? { hitProof } : {}) })
    current.set(e.id, { position, now, raw: e, observer: bot.entity, identified, observed })
  }
  if (publish) { previous.set(bot, current); gearMemory.set(bot, remembered) }
  return sightings
}

// A nearby cell may be in hand range while all its reference faces are hidden.
export function placementPoses(bot: any, at: any) {
  if (!bot?.entity || !at || !['x', 'y', 'z'].every(k => Number.isSafeInteger(at[k])) || at.y < -64 || at.y > 319 || Math.abs(at.x) >= 30000000 || Math.abs(at.z) >= 30000000) return []
  const { Vec3 }: typeof import('vec3') = require('vec3'), pick: typeof import('./pick') = require('./pick')
  const { standPositions, verticalLift, bodyBox, intersects }: typeof import('./navigation/geometry') = require('./navigation/geometry')
  // One synchronous survey: do not re-run the same personal sight ray from hundreds of hypothetical eyes.
  const sight = (require('./pvp/search') as typeof import('./pvp/search')).observedCollision(bot)
  const { getBlock } = (require('./edges') as typeof import('./edges')).worldOf(sight)
  const observed = { ...sight, blockAt: getBlock }
  const opaque = { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
  const rayWorld = { entity: bot.entity, registry: bot.registry, blockAt: p => getBlock(p) ?? opaque }
  const nearby = Object.values<any>(bot.entities || {}).filter(e => e !== bot.entity && (e.username || /^(player|mob|hostile|animal|passive|ambient|water_creature)$/.test(e.type)) &&
    e.position && e.position.distanceTo(bot.entity.position) <= 14 && bot.players?.[e.username]?.gamemode !== 3 && seesPlayer(bot, e))
  const occupied = nearby.map(e => {
    const { lo, hi } = pick.hitboxOf(bot, e)
    return { minX: lo.x, minY: lo.y, minZ: lo.z, maxX: hi.x, maxY: hi.y, maxZ: hi.z }
  })
  const target = new Vec3(at.x, at.y, at.z), poses = [], explore = []
  const targetCell = { minX: at.x, minY: at.y, minZ: at.z, maxX: at.x + 1, maxY: at.y + 1, maxZ: at.z + 1 }
  const references = (require('./build') as typeof import('./build')).FACES.map(face => ({ face, pos: target.minus(face) })).filter(ref => {
    const block = observed.blockAt(ref.pos)
    return block?.boundingBox === 'block'
  })
  const eyeHeight = pick.eyeHeight(bot, bot.entity)
  const canAim = eye => references.some(ref => pick.faceAim(rayWorld, ref.pos, ref.face, { eye, avoid: nearby }))
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    for (const p of standPositions(observed, target.offset(x, 0, z), { rise: 1, drop: 3 })) {
      const travel = p.distanceTo(bot.entity.position)
      if (travel > 8 || travel < .4) continue
      const body = bodyBox(observed, p)
      if (intersects(body, targetCell) || occupied.some(box => intersects(box, body))) continue
      const eye = p.offset(0, eyeHeight, 0)
      const standing = canAim(eye)
      const jump = !standing && at.y > p.y + 1 ? verticalLift(observed, p, .95) : 0
      const aim = standing ? 'standing' : jump > .4 && canAim(eye.offset(0, jump, 0)) ? 'jump' : undefined
      const pose = { x: p.x, y: p.y, z: p.z, ...(aim && { aim }) }
      if (aim) { poses.push(pose); continue }
      const delta = target.offset(.5, .5, .5).minus(eye), length = delta.norm()
      const hit = pick.blockOnRay(rayWorld, eye, delta.scaled(1 / length), length)
      const viewpoint = !hit || hit.pos.equals(target)
      if (viewpoint && p.distanceTo(target) < 4) poses.push(pose)
      else if (travel >= 1.2) explore.push(pose)
    }
  }
  if (poses.length) return poses.sort((a, b) => placementRank(b) - placementRank(a) ||
    new Vec3(a.x, a.y, a.z).distanceTo(bot.entity.position) - new Vec3(b.x, b.y, b.z).distanceTo(bot.entity.position)).slice(0, 8)
  // Walk around the known wall to reveal its other side, then ask for faces again.
  return explore.sort((a, b) => new Vec3(a.x, a.y, a.z).distanceTo(target) - new Vec3(b.x, b.y, b.z).distanceTo(target)).slice(0, 8)
}

export function placementRank(pose: { aim?: string }) {
  return pose.aim === 'standing' ? 2 : pose.aim === 'jump' ? 1 : 0
}
