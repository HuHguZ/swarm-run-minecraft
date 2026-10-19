'use strict'
// Шаги лестницы вниз: направления, выход из шахты, уступ, шаг вперёд, сход с края, факел.
// ---------------------------------------------------------------- stairs
import { fallCost, FREE_FALL, floorBelow, groundUnder, lavaNear, dropFields } from './drop-judge'
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { sleep, xyz }: typeof import('../movement') = require('../movement')
const { itemNamed }: typeof import('../items') = require('../items')
const { placeBlockAt, pickFiller, FACES }: typeof import('../build') = require('../build')
const STAIR_DIRS = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  север: [0, -1], юг: [0, 1], восток: [1, 0], запад: [-1, 0]
}

// Which cardinal the body is actually facing. Matches mineflayer's own lookAt
// maths (yaw 0 is north), so "no direction given" means "carry on the way I am
// already pointed" rather than an arbitrary axis.
function facingDir (bot) {
  const yaw = bot.entity.yaw
  const x = -Math.sin(yaw)
  const z = -Math.cos(yaw)
  return Math.abs(x) >= Math.abs(z) ? [Math.sign(x) || 1, 0] : [0, Math.sign(z) || 1]
}

function dirName (dir) {
  for (const [name, v] of (Object.entries(STAIR_DIRS) as [string, any][])) {
    if (/[a-z]/.test(name) && v[0] === dir[0] && v[1] === dir[1]) return name
  }
  return `${dir[0]},${dir[1]}`
}

const STAIR_DIR_LIST = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// Can a staircase step be founded this way at all: something solid to land on,
// a free drop, or — when the bag holds something steady to build with — a face
// to place the step's support against. Nine blockAt calls and no digging,
// because it is asked about three directions the body never walked — and the
// only thing worth knowing about them is whether they are a different question
// or the same one. A direction that would need a prop in its open step cell is
// the same one: that is precisely what just failed here.
function canFootStep (bot, feet, dx, dz, canBuild = true) {
  const land = feet.offset(dx, -2, dz)
  const under = bot.blockAt(land)
  if (under && under.boundingBox === 'block') return true
  if (floorBelow(bot, feet.offset(dx, -1, dz), FREE_FALL) !== null) return true
  if (!canBuild) return false
  for (const f of FACES) {
    const ref = bot.blockAt(land.offset(f.x, f.y, f.z))
    if (ref && ref.boundingBox === 'block' && !/water|lava/.test(ref.name)) return true
  }
  return false
}

// Would a shaft actually start from this square? Advice that names a move the
// tool then refuses is the same class of lie this whole refusal exists to stop,
// so the question is asked with digDown-s own rules rather than assumed: solid
// underfoot, not bedrock, no lava or water one below, and not a cave already
// open two below. On the floor of a cave all of that holds — which is what
// makes the shaft the answer there — but on a one-block ledge over the void it
// does not, and then saying «копай колодец» would send the brain into a second
// refusal. Kept next to the branch it mirrors; if digDown changes, so does this.
// Asked for a call WITHOUT maxFallHp: over a cave the shaft starts on its own
// only when the drop into it is free.
function shaftStarts (bot, feet) {
  const below = bot.blockAt(feet.offset(0, -1, 0))
  if (!below || below.boundingBox !== 'block' || below.name === 'bedrock') return false
  const under = bot.blockAt(feet.offset(0, -2, 0))
  if (under && /lava|water/.test(under.name)) return false
  if (under && under.boundingBox === 'empty') {
    const deeper = bot.blockAt(feet.offset(0, -3, 0))
    if (deeper && deeper.boundingBox === 'empty') {
      const g = groundUnder(bot, feet, 32, [below.position])
      return !!g && !g.lava && !g.water && fallCost(g.fall) === 0 && !lavaNear(bot, feet.offset(0, -g.fall, 0))
    }
  }
  return true
}

// How many blocks to fetch before a staircase can cross a cave: a step over
// open cave places two and cuts the prop back out, one a level, and the levels
// are the cave's depth. Unknown depth counts as the 32 groundUnder looks.
function blocksToCross (fall) {
  return Math.min(64, Math.max(8, (Number.isFinite(fall) ? fall : 28) + 4))
}

// A shaft refusing over a cave used to stop on the refusal itself — «лава — не
// прыгаю», «дна не видно» — a sentence with no call in it (review of
// 2026-09-15). The way on from a square over a cave is the other mode of the
// same tool: a staircase steps onto rock beside the hole, or walks out over the
// cave on props. Asked with the staircase's own rules — canFootStep for a step
// that needs no blocks, and a prop needs only the floor under our own feet,
// which a shaft stands on by definition — so the call named here is not one
// the staircase refuses for the same reason.
function shaftWayOut (bot, feet, fall) {
  const bare = STAIR_DIR_LIST.find(d => canFootStep(bot, feet, d[0], d[1], false))
  if (bare) {
    const name = dirName(bare)
    return {
      text: `лесенке на ${name} есть куда ступить и без блоков: mc_dig_down mode=stairs direction=${name}`,
      fields: { stairs: name }
    }
  }
  const name = dirName(facingDir(bot))
  if (pickFiller(bot, { steady: true })) {
    return {
      text: `лесенка перейдёт пещеру на подпорках из сумки: mc_dig_down mode=stairs direction=${name}`,
      fields: { stairs: name }
    }
  }
  const need = blocksToCross(fall)
  return {
    text: `подмостить лесенку нечем: mc_mine block=stone_like count=${need} (по блоку на уровень над пещерой), ` +
      `потом mc_dig_down mode=stairs direction=${name}`,
    fields: { stairs: name, mine: need }
  }
}

// «не к чему прислонить блок» is true and useless: it names the physics and
// leaves the brain holding nothing. Measured on the descent that stopped at
// y=-36 — four directions tried, eight legs of the trip spent, zero steps cut,
// and 64 cobblestone plus a hundred deepslate in the bag the whole time. The bag
// was never the problem: a block needs a face to go on, and open cave has none.
//
// So the refusal answers the things that can actually be acted on: how far the
// ground is and what the fall would cost, whether another direction is a
// different question or the same one, and the move that does work here.
//
// It used to end on «Остаётся спрыгнуть, если цена выше по карману» — and no
// call jumped. On 2026-09-15 that sentence closed eight legs of the trip at y=1
// with the floor five blocks down for two points of eighteen: advice with no
// callable path is a dead end. The jump is now a parameter of this very call,
// and the sentence names it with its number; `ledge` carries the same facts for
// a caller that reads fields rather than Russian.
//
// Without blocks the prop is the move that is missing, not the direction: the
// floor under our feet is always a face for one. So an empty bag names the
// fetch and the same call after it — on a pillar with the price past any
// health, that is the only thing in the sentence that can be done.
function ledgeReport (bot, feet, dir, put, other, noFooting, verdict, { canBuild = true, call }: any = {}) {
  const parts = [`под ступенькой пусто (${put.reason})`, verdict.text]
  if (other) parts.push(`с другой стороны опора есть — зови лесенку с direction=${dirName(other)}`)
  else if (noFooting) parts.push('опоры нет ни с одной из четырёх сторон — перебирать направления бесполезно')
  else parts.push('опора тут есть, но блок не встал — можно позвать лесенку ещё раз с этого же места')
  const mine = canBuild ? undefined : blocksToCross(verdict.fall)
  if (mine) {
    parts.push(`подмостить нечем: mc_mine block=stone_like count=${mine} (по блоку на уровень над пещерой), потом снова ${call}`)
  }
  const shaft = shaftStarts(bot, feet)
  parts.push(shaft
    ? 'подо мной твёрдый пол: mc_dig_down mode=shaft копает вниз без подпорок'
    : 'колодцем отсюда тоже только прыжок — под ногами пустота через блок')
  if (!verdict.retry && !other && !shaft && !mine) parts.push('остаётся увести меня mc_goto к стене пещеры и звать лесенку оттуда')
  return {
    stopped: parts.join('; '),
    ledge: {
      at: xyz(feet),
      mode: 'stairs',
      direction: dirName(dir),
      why: put.reason,
      // Faces the server was asked for under the step and did not give, and the
      // prop if one went in first: the underside is placed on a reading of the
      // jar, and this is where a run finds out the reading was wrong.
      refused: put.refused && put.refused.length ? put.refused : undefined,
      prop: put.prop,
      ...dropFields(verdict),
      other: other ? dirName(other) : null,
      directionWontHelp: !!noFooting,
      mine,
      shaft
    }
  }
}

// One block forward on manual controls. Pathfinder re-plans the whole route for
// a single step, and with canDig on it digs its own detour straight out of the
// staircase we are cutting.
async function stepForward (bot, ctl, target, ms = 2500) {
  const deadline = gameClock.now() + ms
  const cx = target.x + 0.5
  const cz = target.z + 0.5
  const near = () => Math.hypot(bot.entity.position.x - cx, bot.entity.position.z - cz)
  try {
    await bot.lookAt(new Vec3(cx, bot.entity.position.y, cz), true)
    bot.setControlState('forward', true)
    while (gameClock.now() < deadline && !ctl.aborted && near() > 0.55) await sleep(60)
  } catch {
  } finally {
    try { bot.setControlState('forward', false) } catch {}
  }
  return near() < 0.95
}

// The cell the body stands in, taken from the block that holds it up rather
// than from where its centre happens to be. A body rests on any block its
// 0.6-wide hitbox overlaps, and after a step it often stops with the centre
// just past the edge of the step block: with prismarine-physics driven the way
// mineflayer drives it (review of 2026-09-15) it landed at 167.965 with 0.068
// of speed left and came to rest past 168.0. position.floored() then named the
// next column, whose floor is open cave, and the staircase planned its prop
// against nothing — 8 of 12 crossings of a 24-deep cave stopped part-way with
// 64 cobblestone in the bag. The hand-written test body stopped at exactly
// +0.300 and never showed it.
function standingCell (bot) {
  const pos = bot.entity.position
  const feet = pos.floored()
  const holds = c => { const b = bot.blockAt(c.offset(0, -1, 0)); return !!b && b.boundingBox === 'block' }
  if (holds(feet)) return feet
  const half = (bot.entity.width || 0.6) / 2
  let best = null
  for (let x = Math.floor(pos.x - half); x < pos.x + half; x++) {
    for (let z = Math.floor(pos.z - half); z < pos.z + half; z++) {
      if (x === feet.x && z === feet.z) continue
      const cell = new Vec3(x, feet.y, z)
      if (!holds(cell)) continue
      const area = (Math.min(pos.x + half, x + 1) - Math.max(pos.x - half, x)) *
        (Math.min(pos.z + half, z + 1) - Math.max(pos.z - half, z))
      if (area > 0 && (!best || area > best.area)) best = { cell, area }
    }
  }
  return best ? best.cell : feet
}

// Off a lip and into a drop that was priced on the column under the step — and
// down in that column. A body that walks off keeps 0.91 of its speed every tick
// in the air: measured with prismarine-physics, a twelve-block drop priced on
// column 161 came down on 162.227, and with the event loop busy it slid off
// that floor's edge too and paid 17 on a price of 9, landing at 3 hp (review of
// 2026-09-15). So: walk up short of the edge, let the glide die, step off from
// nearly a standstill, and on the first tick in the air turn round and push
// against the drift until it is gone. Air control is 0.02 a tick; a standing
// start leaves the lip at about 0.15, which that cancels in a few ticks and a
// fraction of a block. Returns false if the body never left the lip.
async function walkOff (bot, ctl, step, [dx, dz], fromY, ms = 4000) {
  const e = bot.entity
  const deadline = gameClock.now() + ms
  // How far the centre is past the face between the lip and the step cell. The
  // hitbox leaves the lip at +0.3.
  const face = dx > 0 ? step.x : dx < 0 ? -(step.x + 1) : dz > 0 ? step.z : -(step.z + 1)
  const past = () => e.position.x * dx + e.position.z * dz - face
  let left = false
  const airborne = () => (left = left || (!e.onGround && e.position.y < fromY - 0.01))
  const going = () => !ctl.aborted && gameClock.now() < deadline
  try {
    await bot.lookAt(new Vec3(step.x + 0.5, e.position.y + 1.6, step.z + 0.5), true)
    // Walking speed is 0.22 a tick and the glide after letting go about a
    // quarter of a block, so let go a tenth short of the face.
    bot.setControlState('forward', true)
    while (going() && !airborne() && past() < -0.1) await sleep(20)
    bot.setControlState('forward', false)
    const calm = gameClock.now() + 700
    while (going() && gameClock.now() < calm && !airborne() && Math.hypot(e.velocity.x, e.velocity.z) > 0.01) await sleep(20)
    if (!airborne()) {
      bot.setControlState('forward', true)
      while (going() && !airborne()) await sleep(20)
      bot.setControlState('forward', false)
    }
    if (!airborne()) return false
    const vx = e.velocity.x
    const vz = e.velocity.z
    if (Math.hypot(vx, vz) > 0.003) {
      await bot.look(Math.atan2(-vx, -vz), e.pitch, true)
      bot.setControlState('back', true)
      while (going() && !e.onGround && e.velocity.x * vx + e.velocity.z * vz > 0) await sleep(20)
    }
    return true
  } catch {
    return left
  } finally {
    try { bot.setControlState('forward', false) } catch {}
    try { bot.setControlState('back', false) } catch {}
  }
}

// placeBlockAt judges success by the square becoming solid, and a torch never
// is — so verify by name. Short leash on purpose: a torch that will not stick
// must never cost the descent.
async function placeTorch (bot, pos) {
  const lit = b => !!b && /torch/.test(b.name)
  if (lit(bot.blockAt(pos))) return true
  if (!itemNamed(bot, 'torch')) return false
  try {
    await placeBlockAt(bot, pos, { item: 'torch', timeoutMs: 1200 })
  } catch {}
  return lit(bot.blockAt(pos))
}

export { STAIR_DIRS, facingDir, dirName, STAIR_DIR_LIST, canFootStep, shaftWayOut, ledgeReport, stepForward,
  standingCell, walkOff, placeTorch }
