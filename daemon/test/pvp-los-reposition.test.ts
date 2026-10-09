import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { Vec3 } from 'vec3'

const req = createRequire(resolve(__dirname, '../src/pvp.js'))
const pick = req('./pick')
const { createLastSeen } = req('./pvp/last-seen')
const { raySees } = req('./perception')
const { goals } = req('mineflayer-pathfinder')
const source = readFileSync(process.env.ND_TEST_LOS_SOURCE || resolve(__dirname, '../src/pvp.ts'), 'utf8')
const spotStart = source.indexOf('const losSpot = () => {')
const spotEnd = source.indexOf('\n  let lastTrick', spotStart)
const seenStart = source.indexOf('const seesBody = ')
const seenEnd = source.indexOf('\n    // Честный прицел', seenStart)
assert.ok(spotStart > 0 && spotEnd > spotStart && seenStart > 0 && seenEnd > seenStart, 'exercise the actual PvP closures')

function scene (at = new Vec3(.5, 0, .5), terrain: (p: Vec3) => boolean = p => p.y < 0) {
  const bot: any = new EventEmitter()
  bot.entity = { position: at, height: 1.8, onGround: true }
  bot.blockAt = p => {
    p = p.floored()
    const solid = terrain(p)
    return { name: solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty',
      shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  // Real project shape-ray traversal backs the ordinary perception ray; this
  // fixture does not decide which candidate losSpot should select.
  bot.world = { raycast(from, direction, length) {
    const hit = pick.blockOnRay(bot, from, direction, length)
    return hit && { ...hit.block, position: hit.pos, intersect: from.plus(direction.scaled(hit.t)) }
  } }
  return bot
}

function context (bot, position, vision = { visible: () => false }) {
  return { bot, vision, entity: { position, height: 1.8 }, foeSeenPos: position.clone(),
    Vec3, pick, raySees, EYE: 1.62, eye: pick.eyeOf(bot), prof: { player: true },
    AR: null, onField: () => true, require: req, goals }
}
function spot (ctx) {
  return runInNewContext(source.slice(spotStart, spotEnd) + '\nlosSpot()', ctx)
}

test('a player seen during an awaited skill retains that observation after landing behind cover', t => {
  // Relevant D27 swap2 shapes: the 2-high platform and the recorded clutch.
  const bot = scene(new Vec3(589.6, 120, 596.3), p => p.y < 120 ||
    p.x >= 581 && p.x <= 584 && p.z >= 593 && p.z <= 596 && p.y <= 121 ||
    p.equals(new Vec3(576, 122, 591)))
  const raw = Object.assign(new EventEmitter(), { id: 2, type: 'player', username: 'Foe', height: 1.8, width: .6,
    isValid: true, metadata: [], position: new Vec3(587.4, 120, 597.6) })
  const vision = createLastSeen(bot); t.after(() => vision.close())
  const entity = vision.observe(raw)
  const ctx = context(bot, entity.position, vision)
  ctx.entity = entity
  bot.entity.position = new Vec3(588, 127.9, 596.4)
  raw.position = new Vec3(576.4, 123, 591.5)
  bot.emit('physicsTick')
  assert.equal(entity._ndVisible, true, 'the flight really provided a new sighting')
  const observed = entity.position.clone()
  bot.entity.position = new Vec3(585.4, 120, 594.5)
  bot.emit('physicsTick')
  assert.equal(entity._ndVisible, false)
  // Further hidden packet movement cannot replace that sighting.
  raw.position = new Vec3(576.2, 123, 591.3)
  bot.emit('physicsTick')
  assert.equal(entity._ndVisible, false)
  assert.deepEqual(entity.position, observed)
  ctx.eye = pick.eyeOf(bot)
  runInNewContext(source.slice(seenStart, seenEnd), ctx)
  assert.deepEqual(ctx.foeSeenPos, observed, 'the caller must use the observer receipt, including one received while awaiting a skill')
  assert.notDeepEqual(ctx.foeSeenPos, raw.position, 'never follow the hidden raw packet')
})

test('LOS repositioning cannot sell the already completed GoalBlock as another movement', () => {
  const bot = scene()
  const ctx = context(bot, new Vec3(4.5, 0, .5))
  const chosen = spot(ctx)
  assert.ok(chosen, 'another visible viewpoint is available')
  const goal = new goals.GoalBlock(chosen.x, chosen.y, chosen.z)
  assert.equal(goal.isEnd(bot.entity.position.floored()), false, 'a goal already reached cannot recover visibility')
})

test('a hidden ceiling cannot change the selected LOS viewpoint', () => {
  const selected = []
  for (const roof of [false, true]) {
    const bot = scene(new Vec3(.5, 0, .5), p => p.y < 0 ||
      p.x === 1 && p.y <= 3 && Math.abs(p.z) <= 10 ||
      roof && p.equals(new Vec3(2, 1, 0)))
    assert.equal(pick.blockSeen(bot, new Vec3(2, 1, 0)), false)
    const chosen = spot(context(bot, new Vec3(8.5, 0, .5)))
    selected.push(chosen && [chosen.x, chosen.y, chosen.z])
  }
  assert.deepEqual(selected[0], selected[1], 'packet-only geometry beyond the wall must not decide the viewpoint')
  assert.equal(selected[0], null, 'all proposed supports in this scene are still behind the wall')
})

test('a target hidden from the beginning does not create a remembered LOS position', () => {
  const bot = scene()
  const ctx = context(bot, new Vec3(4.5, 0, .5))
  ctx.foeSeenPos = null
  assert.equal(spot(ctx), null)
})
