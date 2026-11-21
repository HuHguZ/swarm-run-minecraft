import { Vec3 } from 'vec3'
import * as pick from '../pick'
import { wall } from '../game-clock'
import { observedVelocity } from '../bow/track'
import { gliding } from '../elytra/track'
import { seesPlayer } from '../pvp/last-seen'
import { allyOnSegment, isAlly } from './ally-safety'
import { observedWindPlayer, windCollisionWorld, windCoverClear } from './enemy-wind'
import { WIND, windLaunch, windMovement, worldTick } from './team-wind'

const air = /^(air|cave_air|void_air)$/
const solid = { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
const chargeHalf = .3125 / 2, chargeBase = -Math.fround(.15), noise = WIND.speed * WIND.dispersion
const vector = (p: {x: number; y: number; z: number}) => new Vec3(p.x, p.y, p.z)
const finite = (p: Vec3) => p && [p.x, p.y, p.z].every(Number.isFinite)
const awaitingMotion = new WeakSet<object>()

function standingStill(body) {
  if (!body.onGround || gliding(body)) return false
  const receipts = body._ndPositionReceipts
  if (!receipts?.[0] && receipts?.[1]?.kind === 'reacquired' && typeof body.once === 'function') {
    // A newly sighted player has one public position and no measured interval. At the next movement
    // trackTarget seeds itself from both receipts, exactly as if it had waited here from the beginning.
    if (!awaitingMotion.has(body)) {
      awaitingMotion.add(body)
      body.once('ndPositionObserved', () => observedVelocity(body))
    }
    return true
  }
  const v = observedVelocity(body)
  return v?.x === 0 && v?.z === 0
}

// AbstractWindCharge.makeBoundingBox and ProjectileUtil.computeMargin, Paper 1.21.11.
function chargeEntry(p: Vec3, step: Vec3, charge: Vec3, age: number, extra: number) {
  const margin = Math.max(0, Math.min(Math.fround(.3), (age - 2) / 20)) + extra
  const half = chargeHalf + margin
  if (half <= 0) return null
  return pick.rayBox(p, step, charge.offset(-half, chargeBase - margin, -half), charge.offset(half, chargeBase + .3125 + margin, half), 1)
}

function interceptAim(eye: Vec3, move: Vec3, at: Vec3, step: Vec3, flight: number, age: number) {
  for (const part of [.75, .5, .25]) {
    const shot = windLaunch(eye, at.plus(step.scaled(part)).offset(0, -(chargeBase + chargeHalf), 0), move)
    if (!shot) continue
    const charge = eye.plus(shot.velocity.scaled(flight))
    const entry = chargeEntry(at, step, charge, age, -noise * flight)
    // AABB.clip needs an entry face; starting inside even one possible box cannot certify that spread.
    if (entry !== null && entry > 0 && entry < 1 && chargeEntry(at, step, charge, age, noise * flight) !== 0) return { shot, charge }
  }
  return null
}

function overDrop(world, at: Vec3, killY: number, owner, deadline: number) {
  if (at.y < killY) return true
  // A pearl preserves its owner's motion. Price only a short, observed, unsupported fall from walking speed.
  if (!owner?._ndVisible || !owner.onGround || owner.elytraFlying || !owner._ndPositionReceipts?.[0]) return false
  const v = observedVelocity(owner)
  if (!v || Math.abs(v.y) > .1) return false
  let y = at.y, vy = Math.max(0, v.y), radius = Math.fround(.6) / 2, horizontal = Math.hypot(v.x, v.z)
  for (let i = 0; i < 8 && y >= killY; i++) {
    horizontal += .026; radius += horizontal; horizontal *= .91
    y += vy; vy = (vy - .08) * .98
  }
  if (y >= killY || radius > 4 || !Number.isFinite(radius)) return false
  for (let x = Math.floor(at.x - radius); x <= at.x + radius; x++)
    for (let z = Math.floor(at.z - radius); z <= at.z + radius; z++)
      for (let h = Math.floor(killY) - 1; h <= at.y + 1.8; h++) {
        if (wall.monotonic() > deadline || !air.test(world.blockAt(new Vec3(x, h, z))?.name)) return false
      }
  return true
}

type Spent = Pick<WeakSet<object>, 'has'>
type Foes = any[] | ((owner: any) => boolean)
type Offer = { pearl: any; owner: string; ownerId: number; ticks: number }
type Shot = Offer & { at: Vec3; yaw: number; pitch: number }
/** Reserve a reachable nominal charge ray. Only the release forecast certifies both swept paths. */
export function pearlWindOffer(bot: any, killY: number, foes: Foes, spent: Spent, deadline: number): Offer | null {
  return forecast(bot, killY, foes, spent, deadline, true)
}
export function pearlWindIntercept(bot: any, killY: number, foes: Foes, spent: Spent, deadline = Infinity): Shot | null {
  return forecast(bot, killY, foes, spent, deadline, false)
}
function forecast(bot: any, killY: number, foes: Foes, spent: Spent, deadline: number, offer: false): Shot | null
function forecast(bot: any, killY: number, foes: Foes, spent: Spent, deadline: number, offer: true): Offer | null
/** The older pearl tests the charge before the charge moves this tick. */
function forecast(bot: any, killY: number, foes: Foes, spent: Spent, deadline: number, offer: boolean): Offer | Shot | null {
  if (!bot._ndThrown?.size || !Number.isFinite(killY)) return null
  const tick = worldTick(bot)
  if (tick === null) return null
  const eye = pick.eyeOf(bot), movement = windMovement(bot)
  let world: ReturnType<typeof windCollisionWorld> | undefined
  for (const [id, birth] of bot._ndThrown) {
    if (wall.monotonic() > deadline) return null
    if (birth.name !== 'ender_pearl' || birth.own || !birth.owner || !Number.isSafeInteger(birth.gameTick)) continue
    const age = tick - birth.gameTick, pearl = bot.entities[id], owner = bot.entities[birth.owner]
    if (age < 0 || age >= 120 || !finite(birth.p) || !finite(birth.v) || !pearl || pearl.name !== birth.name || spent.has(pearl) ||
      !owner?.username || !(Array.isArray(foes) ? foes.includes(owner) : foes(owner)) ||
      isAlly(bot, owner) || !seesPlayer(bot, pearl) || !seesPlayer(bot, owner)) continue
    const positions = [vector(birth.p)]
    let velocity = vector(birth.v)
    const horizon = Math.ceil((chargeHalf + Math.fround(.3)) / noise)
    for (let n = 0; n <= age + horizon; n++) {
      velocity = velocity.offset(0, -.03, 0).scaled(.99)
      positions.push(positions[n].plus(velocity))
    }
    // The visible position can lag ten ticks; a deflected or replaced projectile no longer fits its public flight.
    let checked = Math.max(0, age - 10)
    while (checked <= age && positions[checked].distanceTo(pearl.position) >= .04) checked++
    if (checked > age) continue
    let ownerView
    const dry = { blockAt(p) {
      world ||= windCollisionWorld(bot)
      const b = world.blockAt(p); return b && air.test(b.name) ? b : solid
    } }
    for (let n = age + 1; n < positions.length - 1; n++) {
      if (wall.monotonic() > deadline) return null
      const at = positions[n], step = positions[n + 1].minus(at), flight = n - age
      if (at.y > killY + 2 || at.distanceTo(eye) > 64) continue
      const aim = interceptAim(eye, movement, at, step, flight, n + 1)
      if (!aim) continue
      const { shot, charge } = aim
      if (at.y >= killY) {
        ownerView ||= observedWindPlayer(bot, owner, true)
        world ||= windCollisionWorld(bot)
        if (!overDrop(world, at, killY, ownerView, deadline)) continue
      }
      if (offer) {
        // The ray starts at our eyes, stopping at the first unseen cell, fluid or block.
        // A grant can arrive after someone moved: the complete dry paths and all bodies are priced there.
        const sight = { blockAt(p) { const b = bot.blockAt(p, false); return b && air.test(b.name) ? b : solid } }
        const length = shot.velocity.norm()
        if (!pick.blockOnRay(sight, eye, shot.velocity.scaled(1 / length), length * flight))
          return { pearl, owner: owner.username, ownerId: owner.id, ticks: flight + 1 }
        continue
      }
      // Seeing the pearl beyond a block proves it already passed. Any lagged steps since that sighting still need dry air.
      while (checked <= n) {
        if (wall.monotonic() > deadline) return null
        const p = positions[checked], delta = positions[checked + 1].minus(p), len = delta.norm()
        if (len === 0 || pick.blockOnRay(dry, p, delta.scaled(1 / len), len)) break
        checked++
      }
      if (checked <= n) break
      if (!windCoverClear(dry, { from: eye, velocity: shot.velocity, burst: charge, ticks: flight }, new Map(), deadline)) continue
      const first = positions[age], last = positions[n + 1], margin = Math.fround(.3), spread = .3 + noise * flight
      const bodies = (Object.values(bot.entities) as any[]).flatMap(e => {
        if (e === bot.entity || e === pearl || !e.position) return []
        if (e.username) {
          if (bot.players?.[e.username]?.gamemode === 3) return []
          const body = (e === owner && ownerView) || observedWindPlayer(bot, e, true)
          if (body) return body._ndVisible ? [body] : []
        } else if (!['mob', 'hostile', 'animal'].includes(e.type)) return []
        return seesPlayer(bot, e) ? [{ id: e.id, position: e.position, height: e.height, width: e.width, onGround: e.onGround }] : []
      }).filter(e => {
        // A standing body with zero observed horizontal motion stays at its feet in the native forecast.
        // The pearl moves monotonically along X/Z. A body outside both swept corridors needs no per-tick track.
        if (!standingStill(e)) return true
        const box = pick.hitboxOf(bot, e)
        if (box.hi.x + margin >= Math.min(first.x, last.x) && box.lo.x - margin <= Math.max(first.x, last.x) &&
            box.hi.z + margin >= Math.min(first.z, last.z) && box.lo.z - margin <= Math.max(first.z, last.z)) return true
        return pick.rayBox(eye, shot.velocity, vector(box.lo).offset(-spread, -spread, -spread),
          vector(box.hi).offset(spread, spread, spread), flight) !== null
      })
      const self = pick.hitboxOf(bot, bot.entity), ownLo = vector(self.lo).offset(-.3, -.3, -.3), ownHi = vector(self.hi).offset(.3, .3, .3)
      // Both projectiles share this synchronous observation. A grant or later movement packet starts a fresh forecast.
      const tracks = new Map()
      let clear = true
      for (let j = 0; clear && j <= flight; j++) {
        if (wall.monotonic() > deadline) return null
        const start = eye.plus(shot.velocity.scaled(j)), p = positions[age + j], delta = positions[age + j + 1].minus(p)
        // The earliest possible contact must yield the intended teleport, even at the edge of native dispersion.
        if (j < flight && chargeEntry(p, delta, start, age + j + 1, noise * j) !== null) clear = false
        if (j < flight && allyOnSegment(bot, bodies, start, start.plus(shot.velocity), j, 1, .3 + noise * (j + 1), tracks)) clear = false
        if (allyOnSegment(bot, age + j > 2 ? bodies : bodies.filter(e => e.id !== owner.id), p, p.plus(delta), j, 1, Math.fround(.3), tracks)) clear = false
        if (pick.rayBox(p, delta, ownLo, ownHi, 1) !== null) clear = false
      }
      if (clear) return { pearl, owner: owner.username, ownerId: owner.id, at, ticks: flight + 1, yaw: shot.yaw, pitch: shot.pitch }
    }
  }
  return null
}
