'use strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz } from './movement'
import { RANGED } from './combat'

// Can this mob get at me — one question, asked the same way by the drift, by
// the errand that comes back for ore, and by the climb.
//
// It used to be answered three ways, and all three were a radius plus a ray:
// mining's «within 3 blocks or canSeePoint», mine_seen's «within 3 or
// canSeePoint», survival's «within 2.5, or it shoots». The diamond run at y=1
// (run-surface-diamond.log 244-257) stopped six drift calls in a row on mobs in
// the cave under the floor — five zombies and a creeper, the last zombie
// straight down through one block of stone — and mine_seen then refused three
// times with «zombie в 3 блоках вплотную» for that same zombie.
//
// What that log proves is narrower than it sounds. Lines 244-250 each ended
// sealed:true behind a wall, so nobody getting hurt there says nothing about
// whether those mobs had a way up: the wall was in the way. Each fits a cave
// with no way up to the opening and one with a ramp to it equally, and on the
// ramp this file still says «дойдёт» — that stop is right. Only 252-257 is
// evidence: that wall did NOT close (sealed:false), and the zombie under the
// floor stayed in its cell through three errands and the climb, never reaching
// the bot.
//
// Two separate faults, and a radius cannot fix either:
//   * a 3D distance counts rock. Three blocks straight down is «touch»;
//   * canSeePoint (perception.raySees) forgives 1.2 blocks at the target end
//     and measures the hit by the block's min corner, which on a downward ray
//     lies a whole block past the face the ray entered by. One block of floor
//     over a zombie at y=-2 reads «seen» (corner 2.89 >= 1.94); the same zombie
//     one block lower reads «not seen» (2.89 < 2.94). That 0.05 is the entire
//     difference between the behindRock and the threat of log line 252.
//
// And one fault of the question itself: sight is the right test for something
// that shoots, and the wrong one for something that has to walk. At y=1 the
// walls went into holes the mobs could see through; whether they could climb
// to them is the question sight never asked.
//
// So the answer is split by how the mob hurts:
//   shoots  — line of sight, strict: the ray is blocked by any collision shape
//             it actually enters before the target, nothing forgiven;
//   walks   — a walkable path of at most PATH_MAX cells to a square from which
//             its attack box touches our body, with sight from there, because
//             vanilla's melee goal asks hasLineOfSight before it swings;
//   creeper — the same path, to within fuse range with sight;
//   flies   — sight is the path;
//   ignores walls (vex, warden) — radius alone, nothing else is honest.
// Unknown is never read as safe: unloaded cells on the way, or a search that
// ran out of budget, fall back to sight — a mob that sees us then counts.

// How far round a walker may have to go and still count. Twelve cells is five
// or six seconds of zombie, longer than any gap between two looks this answer
// feeds — the drift asks between swings, the climb once a level — so a mob
// further round than this is seen arriving by a later look, not missed.
const PATH_MAX = 12
// An open cave floor within twelve cells is about three hundred squares; ten
// times that means the world is not what the numbers assume.
const NODE_CAP = 3000
// How far a walker will choose to drop on its way to us. Mob.getMaxFallDistance
// in the server jar (paper-1.21.11, read from the bytecode, not measured): 3
// with no target; with one, (int)(hp - 0.33*maxHp) - (3 - difficulty)*4, floored
// at 0, plus 3 — exactly 12 for a full-health zombie on normal, which is what
// server.properties says. Hard would make it 16. The large end is the one that
// errs towards stopping, since a mob on a ledge above us is exactly who drops.
const MAX_DROP = 12
// Mob.getAttackBoundingBox(reach) in the same jar: the mob's own box inflated
// by (reach, 0, reach) — horizontally and NOT vertically — with reach
// DEFAULT_ATTACK_REACH = sqrt(2.04) - 0.6, and MeleeAttackGoal swings only when
// that box touches us AND Sensing.hasLineOfSight (eye to eye, collision shapes).
// The vertical half is why a zombie on the floor under a two-high step cannot
// hit, and combat.js's pillar doctrine rests on the same fact. Not modelled: a
// mob holding an item with the 1.21.11 attack_range component (a spear) swaps
// that reach for the item's, which is longer sideways — still never upwards,
// still only with sight — and a mob riding something takes its mount's box.
const ATTACK_INFLATE = Math.sqrt(2.04) - 0.6
const PLAYER_HALF = 0.3
const PLAYER_HEIGHT = 1.8
// SwellGoal lights the fuse under distanceToSqr 9, with sight.
const FUSE_RANGE = 3
// Float noise only. The old 1.2 of forgiveness is what let a floor block count
// as part of the target.
const EDGE = 0.02

// Spiders are taken as fitting a one-wide hole, which a 1.4-wide spider does
// not: the error is on the side of stopping.
const CLIMBERS = new Set(['spider', 'cave_spider'])
// A vex has no collision and the warden's sonic boom ignores blocks: for these
// two, rock is not an argument.
const THROUGH_WALLS = new Set(['vex', 'warden'])
const FLYERS = new Set(['phantom', 'ghast', 'blaze', 'breeze'])
// Not in combat.RANGED because nothing there fights them, but a guardian's beam
// is a ranged hit that needs sight and nothing else.
const BEAMS = new Set(['guardian', 'elder_guardian'])

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function eyeOf (entity, body) {
  return entity.position.offset(0, body.height * 0.85, 0)
}

// The box the server gives this mob. A baby is half of everything:
// LivingEntity.getDefaultDimensions scales the type's box by getAgeScale(), 0.5
// for a baby, and Zombie keeps its own BABY_DIMENSIONS, the same ×0.5 (both read
// from the server jar). mineflayer copies width and height from the registry
// (entities.js:168) and never scales them, so a baby zombie arrives as a full
// 0.6×1.95 — too tall for the one-high hole it walks through, which is a miss
// on the side of not stopping. The flag sits in entity metadata under an index
// that differs by type — 'baby' is 16 for a zombie and 17 for a piglin, while 16
// is a skeleton's stray_conversion and 17 a creeper's is_powered — so the index
// comes from the registry by name, never as a number. Not modelled: the scale
// attribute, which nothing natural sets.
function bodyOf (bot, mob) {
  const width = mob.width || 0.6
  const height = mob.height || 1.95
  let baby = false
  try {
    const type = bot.registry && bot.registry.entitiesByName[mob.name]
    const i = type && type.metadataKeys ? type.metadataKeys.indexOf('baby') : -1
    baby = i >= 0 && !!mob.metadata && mob.metadata[i] === true
  } catch {}
  return baby ? { width: width / 2, height: height / 2 } : { width, height }
}

function myEye (bot) {
  return bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
}

// Strict sight between two points. The matcher asks the real collision shapes
// where the ray enters them — the same call mineflayer's canSeeBlock makes on
// the sync world — so a slab blocks only the half it fills. A throwing raycast
// (a chunk going away under it) answers «seen»: the cautious side.
function clearLine (bot, from, to) {
  const delta = to.minus(from)
  const dist = delta.norm()
  if (dist < 0.1) return true
  try {
    const hit = bot.world.raycast(from, delta.normalize(), dist, (b, iter) => {
      if (!b || !b.shapes || !b.shapes.length) return false
      const i = iter.intersect(b.shapes, b.position)
      return !!i && i.pos.distanceTo(from) < dist - EDGE
    })
    return !hit
  } catch {
    return true
  }
}

// One block read per cell per look, however many mobs ask.
const OPEN = 0
const SOLID = 1
const DEADLY = 2 // open, but no walker paths through lava or fire
const UNLOADED = 3
// Every living thing climbs these, not just spiders — and a ladder has a
// collision shape, so reading it as rock would call a ladder shaft a wall.
const CLIMB = 4
function reader (bot, cache) {
  return (x, y, z) => {
    const key = `${x},${y},${z}`
    let v = cache.get(key)
    if (v !== undefined) return v
    let b = null
    try { b = bot.blockAt(new Vec3(x, y, z), false) } catch {}
    if (!b) v = UNLOADED
    else if (/ladder|vine|scaffolding/.test(b.name)) v = CLIMB
    else if (b.boundingBox === 'block') v = SOLID
    else if (/lava|fire/.test(b.name)) v = DEADLY
    else v = OPEN
    cache.set(key, v)
    return v
  }
}

// Does a mob of this build, feet in cell (x,y,z), touch our body with its
// attack box? Its centre can sit anywhere in the cell it fits in, so the
// centre nearest to us is the one that counts. Returns that centre or null.
function touchesFrom (me, spec, x, y, z) {
  const lo = Math.min(spec.half, 0.5)
  const cx = Math.max(x + lo, Math.min(x + 1 - lo, me.x))
  const cz = Math.max(z + lo, Math.min(z + 1 - lo, me.z))
  if (spec.creeper) return Math.hypot(cx - me.x, y - me.y, cz - me.z) < FUSE_RANGE ? new Vec3(cx, y, cz) : null
  const reach = spec.half + ATTACK_INFLATE + PLAYER_HALF
  if (Math.abs(cx - me.x) >= reach || Math.abs(cz - me.z) >= reach) return null
  if (!(y < me.y + PLAYER_HEIGHT && y + spec.height > me.y)) return null
  return new Vec3(cx, y, cz)
}

// Breadth-first from the mob's feet over cells its body fits in. Returns how
// many cells it must walk before it can hit (0 = already can), null when it
// cannot within PATH_MAX, undefined when that could not be settled.
function stepsToMe (bot, mob, spec, read) {
  const me = bot.entity.position
  const eye = myEye(bot)
  const hc = spec.cells
  let unknown = false
  const open = (x, y, z) => {
    for (let k = 0; k < hc; k++) {
      const c = read(x, y + k, z)
      if (c === UNLOADED) unknown = true
      if (c !== OPEN && c !== CLIMB) return false
    }
    return true
  }
  // ND_OW_SPIDER_WIDTH=1 (owC7-12: паук за ходом в клетку «дойдёт за 6 шаг.» 7 игр. мин стопорил спуск, бой — 0 взмахов):
  // тело шире клетки (паук 1.4) проходит только там, где открыт квадрат 2×2 вокруг клетки; уже стоящую клетку не пересчитываем.
  const wide = spec.half > 0.5 && typeof process !== 'undefined' && process.env.ND_OW_SPIDER_WIDTH === '1'
  const square = (x, y, z) => [[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([a, b]) => open(x + a, y, z) && open(x, y, z + b) && open(x + a, y, z + b))
  const walk = (x, y, z) => open(x, y, z) && (!wide || square(x, y, z))
  const floor = (x, y, z) => { const c = read(x, y - 1, z); return c === SOLID || c === CLIMB }
  const wallBeside = (x, y, z) => DIRS4.some(([dx, dz]) => read(x + dx, y, z + dz) === SOLID)
  const canClimb = (x, y, z) => read(x, y, z) === CLIMB || (spec.climber && wallBeside(x, y, z))
  const holds = (x, y, z) => floor(x, y, z) || canClimb(x, y, z)

  // Where the feet really stand: a mob on a slab floors into the slab, and a
  // mob mid-jump is not standing where its feet are this tick.
  let sx = Math.floor(mob.position.x)
  let sz = Math.floor(mob.position.z)
  let sy = Math.floor(mob.position.y)
  if (!open(sx, sy, sz) && open(sx, sy + 1, sz)) sy++
  // A mob on the rim of a hole with its centre over the hole still stands on the
  // rim. Vanilla starts the path the same way (WalkNodeEvaluator.getStart in the
  // server jar): the cell under the centre, and when that cannot hold it, the
  // cells under the box's four corners at the same height, in this order. Going
  // straight down instead searched from the bottom of a pit for a zombie on our
  // own floor two blocks away, and called it scenery.
  if (!holds(sx, sy, sz)) {
    const h = spec.half
    const px = mob.position.x
    const pz = mob.position.z
    for (const [cx, cz] of [[px - h, pz - h], [px - h, pz + h], [px + h, pz - h], [px + h, pz + h]]) {
      const x = Math.floor(cx)
      const z = Math.floor(cz)
      if (open(x, sy, z) && holds(x, sy, z)) { sx = x; sz = z; break }
    }
  }
  if (!holds(sx, sy, sz)) {
    let k = 1
    while (k <= 8 && open(sx, sy - k, sz) && !holds(sx, sy - k, sz)) k++
    if (k > 8 || !open(sx, sy - k, sz)) return undefined // swimming, falling far, wedged
    sy -= k
  }

  // Admissible pruning: a move shifts the feet at most one cell horizontally,
  // and a square can only hit us if its centre is within `slack` of us on each
  // axis — the attack box (or the fuse radius) plus how far off-centre the body
  // may stand in its cell. Anything tighter throws away paths that do arrive
  // inside PATH_MAX: a flat «two cells» lost a creeper exactly twelve steps
  // down an open drift, because it lights the fuse from three blocks, not two.
  const slack = (spec.creeper ? FUSE_RANGE : spec.half + ATTACK_INFLATE + PLAYER_HALF) + 0.5 - Math.min(spec.half, 0.5)
  const left = (x, z) => Math.max(0, Math.abs(x + 0.5 - me.x) - slack) + Math.max(0, Math.abs(z + 0.5 - me.z) - slack)
  const seen = new Set([`${sx},${sy},${sz}`])
  const queue = [[sx, sy, sz, 0]]
  const push = (x, y, z, d) => {
    const key = `${x},${y},${z}`
    if (seen.has(key) || d + left(x, z) > PATH_MAX) return
    seen.add(key)
    queue.push([x, y, z, d])
  }

  for (let head = 0; head < queue.length; head++) {
    if (queue.length > NODE_CAP) return undefined
    const [x, y, z, d] = queue[head]
    const at = touchesFrom(me, spec, x, y, z)
    if (at && clearLine(bot, at.offset(0, spec.height * 0.85, 0), eye)) return d
    if (d >= PATH_MAX) continue
    const above = read(x, y + hc, z)
    const headroom = above === OPEN || above === CLIMB
    for (const [dx, dz] of DIRS4) {
      const nx = x + dx
      const nz = z + dz
      if (walk(nx, y, nz)) {
        if (holds(nx, y, nz)) push(nx, y, nz, d + 1)
        else {
          for (let k = 1; k <= MAX_DROP; k++) {
            const c = read(nx, y - k, nz)
            if (c === UNLOADED) unknown = true
            if (c !== OPEN) break
            if (floor(nx, y - k, nz)) { push(nx, y - k, nz, d + 1); break }
          }
        }
      }
      // One block up needs the cell over our own head to jump into first.
      if (headroom && walk(nx, y + 1, nz) && floor(nx, y + 1, nz)) push(nx, y + 1, nz, d + 1)
    }
    if (headroom && (canClimb(x, y, z) || canClimb(x, y + 1, z))) push(x, y + 1, z, d + 1)
  }
  return unknown ? undefined : null
}

// The whole answer:
//   reaches  — true when it can hit me now, shoot me now, or get to a square
//              it can hit me from within PATH_MAX cells;
//   how      — 'вплотную' | 'стреляет' | 'дойдёт' | 'долетит' | 'сквозь стены'
//              | 'не просчитал' (could not settle, and it sees me), or null;
//   steps    — cells it must walk before it can hit: 0 already can, null not
//              within PATH_MAX (or not a walker);
//   sees     — strict line of sight, eye to eye;
//   where    — 'снизу' | 'сверху' | 'на моём уровне', for the report;
//   why      — only when it does not reach: the sentence the brain gets.
// `cache` is a Map shared by every mob asked about in ONE look: blocks do not
// change between two mobs, and they do between two swings, so a cache must
// never outlive the look it was made for.
function reachOf (bot, mob, { cache = new Map() }: any = {}) {
  const out: any = { mob: mob && mob.name, reaches: false, how: null, steps: null, sees: false }
  const me = bot && bot.entity && bot.entity.position
  if (!me || !mob || !mob.position) return out
  const name = mob.name
  const p = mob.position
  const dy = p.y - me.y
  out.dist = Math.round(p.distanceTo(me) * 10) / 10
  out.where = dy <= -1.5 ? 'снизу' : dy >= 1.5 ? 'сверху' : 'на моём уровне'
  const body = bodyOf(bot, mob)
  out.sees = clearLine(bot, eyeOf(mob, body), myEye(bot))

  if (THROUGH_WALLS.has(name)) {
    out.reaches = true
    out.how = 'сквозь стены'
    return out
  }

  const spec = {
    half: body.width / 2,
    height: body.height,
    cells: Math.max(1, Math.ceil(body.height - 0.01)),
    climber: CLIMBERS.has(name),
    creeper: name === 'creeper'
  }
  const shoots = RANGED.has(name) || BEAMS.has(name)

  // Contact where it stands this tick, from its real centre rather than a cell.
  const reach = spec.half + ATTACK_INFLATE + PLAYER_HALF
  const touching = spec.creeper
    ? p.distanceTo(me) < FUSE_RANGE
    : Math.abs(p.x - me.x) < reach && Math.abs(p.z - me.z) < reach &&
      p.y < me.y + PLAYER_HEIGHT && p.y + spec.height > me.y
  let steps
  if (touching && out.sees) steps = 0
  else if (FLYERS.has(name)) steps = undefined
  else steps = stepsToMe(bot, mob, spec, reader(bot, cache))
  out.steps = typeof steps === 'number' ? steps : null

  if (steps === 0) out.how = 'вплотную'
  else if (shoots && out.sees) out.how = 'стреляет'
  else if (typeof steps === 'number') out.how = 'дойдёт'
  else if (steps === undefined && out.sees) out.how = FLYERS.has(name) ? 'долетит' : 'не просчитал'
  out.reaches = out.how !== null
  if (!out.reaches) {
    out.why = out.sees
      ? `видит меня, но дороги ко мне в ${PATH_MAX} шагов и короче у него нет`
      : `между нами порода, и дороги ко мне в ${PATH_MAX} шагов и короче у него нет`
  }
  return out
}

// What a mob that cannot get at us is reported as, in one shape for every
// caller, so the brain hears «zombie снизу, между нами порода» from the drift
// and from the errand in the same words.
function sceneryOf (mob, r) {
  return { mob: mob.name, dist: r.dist, at: xyz(mob.position), where: r.where, why: r.why }
}

export { reachOf, sceneryOf, clearLine, PATH_MAX }
