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

function bodyPart(start: string, end: string) {
  const a = source.indexOf(start); const b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `actual PvP branch: ${start}`)
  return source.slice(a, b)
}

function strafeScene() {
  const ctx: any = {
    bot: { entity: { position: new Vec3(.5, 0, .5) } }, now: 1000,
    Math: Object.assign(Object.create(Math), { random: () => .25 }),
    stepSafe: (_bot, dir) => !ctx.blocked.has(dir.x), blocked: new Set(),
    keyDir: (_bot, key) => ({ x: key === 'left' ? -1 : 1, z: 0 })
  }
  const init = bodyPart('  let strafeKey = ', '  let dodgeKey = ')
  const tick = bodyPart('    let forward = false', '    const shieldBroken = ')
  runInNewContext(`${init}\nglobalThis.poll = () => { ${tick}\nreturn strafeKey }`, ctx)
  return ctx
}

test('stationary strafe does not reverse merely because game time advances', () => {
  const f = strafeScene(); const side = f.poll()
  for (const now of [3000, 15000, 60000]) { f.now = now; assert.equal(f.poll(), side) }
})

test('strafe reverses after real lateral displacement without waiting for a timer', () => {
  const f = strafeScene(); const side = f.poll()
  f.bot.entity.position.x += side === 'left' ? -2 : 2
  assert.notEqual(f.poll(), side)
})

test('a newly unsafe strafe side yields to the safe side immediately', () => {
  const f = strafeScene(); const side = f.poll()
  f.blocked.add(side === 'left' ? -1 : 1)
  assert.notEqual(f.poll(), side)
})

test('spear bracing follows the current dive instead of expiring after three seconds', () => {
  const ctx: any = { bracing: 1000, skyThreat: { eta: 10 }, meInWeb: false,
    gameClock: { now: () => 60000 }, drops: 0, heldName: () => 'iron_spear',
    spear: req('./spear'), bot: { deactivateItem: () => { ctx.drops++ } } }
  const branch = bodyPart('    if (bracing && ', '    // Он летит на нас')
  runInNewContext(branch, ctx)
  assert.equal(ctx.drops, 0)
  ctx.skyThreat = null
  runInNewContext(branch, ctx)
  assert.equal(ctx.drops, 1, 'the dive ending releases the spear immediately')
})

function floorScene() {
  const bot: any = new EventEmitter(); bot.entity = { id: 1, position: new Vec3(.5, 0, .5) }
  const ctx: any = { bot, now: 1000, Vec3, floorEscape: null, EYE: 1.62,
    solid: (_bot, p) => p.y < 0, stepSafe: () => true, ready: () => true, rest() {}, used() {},
    gameClock: { now: () => ctx.now }, Math: Object.assign(Object.create(Math), { random: () => 0 }),
    keyDir: (_bot, k) => ({ x: k === 'forward' ? 1 : k === 'back' ? -1 : 0, z: k === 'left' ? 1 : k === 'right' ? -1 : 0 }) }
  const init = bodyPart('  let floorEscape = ', '  let groundY = ')
  const branch = bodyPart('\n    if (floorEscape', '    if (!meInWeb) {')
  runInNewContext(`${init}\nglobalThis.poll = () => { const me = bot.entity.position; let forward = false, back = false, strafe = null, sprint = false, jump = false; ${branch}\nreturn { forward, back, strafe } }`, ctx)
  const block = { position: new Vec3(0, -1, 0) }
  return { ctx, crack: (breaker = 2) => bot.emit('blockBreakProgressObserved', block, 3, { id: breaker }),
    stop: (breaker = 2) => bot.emit('blockBreakProgressEnd', block, { id: breaker }) }
}

test('floor escape lasts until leaving the threatened support, with no seven-hundred-ms expiry', () => {
  const f = floorScene(); f.crack(); f.ctx.now = 60000
  assert.equal(f.ctx.poll().forward, true)
  f.ctx.bot.entity.position.x = 1.5
  assert.equal(f.ctx.poll().forward, false, 'the next support ends this escape without waiting')
  f.ctx.bot.entity.position.x = .5; f.crack()
  f.ctx.bot.entity.position.y = -2
  assert.equal(f.ctx.poll().forward, false, 'landing below the old support also ends its escape')
})

test('a cancelled crack releases floor escape immediately', () => {
  const f = floorScene(); f.crack(); assert.equal(f.ctx.poll().forward, true)
  assert.doesNotThrow(() => f.ctx.bot.emit('blockBreakProgressEnd', null, { id: 2 }))
  assert.equal(f.ctx.poll().forward, true, 'an unloaded end packet does not invent a cancellation receipt')
  f.stop()
  assert.equal(f.ctx.poll().forward, false)
})

test('floor escape is not released while another observed breaker continues the same support', () => {
  const f = floorScene(); f.crack(2); f.crack(3); f.stop(2)
  assert.equal(f.ctx.poll().forward, true)
  f.stop(3)
  assert.equal(f.ctx.poll().forward, false)
})

function routeScene() {
  const bot = scene()
  bot.pathfinder = { goal: new goals.GoalBlock(6, 0, 0) }
  const ctx: any = { ...context(bot, new Vec3(8.5, 0, .5)),
    now: 1000, r: 8, d: 8, dy: 3, HIT_REACH: 2.9, TICK_MS: 50,
    me: bot.entity.position, seesBody: false, perch: null, fort: null, stuckTicks: 0,
    repositionUntil: 4000, reposition: { from: bot.entity.position.clone(), at: 1000, target: 2 },
    losGoal: bot.pathfinder.goal, failedReposition: null, failedUnblock: null, itemInputs: () => '', pathing: true, st: {},
    gameClock: { now: () => ctx.now }, mining: false, miningProgress: () => ctx.mining,
    stepSafe: () => true, keyDir: () => ({ x: 1, z: 0 }), hazardOnLine: () => null,
    ready: () => true, rest() {}, clear() {}, used() {}, sleep: async () => {},
    pathTo(on, goal) { ctx.commands.push({ on, goal }); bot.pathfinder.goal = on ? goal : null }, commands: [] }
  ctx.entity.id = 2
  const helpers = source.indexOf('  const routeInputs = ')
  const helperCode = helpers < 0 ? '' : source.slice(helpers, source.indexOf('\n  let lastTrick', helpers))
  const branch = bodyPart('    // Окно перестановки', '    if (prof.flying')
  const unblock = bodyPart('    if (st.blockedSince &&', "    if (back &&")
  runInNewContext(`${helperCode}\nglobalThis.poll = async () => { me = bot.entity.position; for (let pass = 0; pass < 1; pass++) { ${branch} } }; globalThis.unblock = async () => { for (let pass = 0; pass < 1; pass++) { ${unblock} } }`, ctx)
  return ctx
}

test('an advancing LOS route survives the old three-second mode duration', async () => {
  const f = routeScene()
  for (const [now, x] of [[1000, .5], [3500, 1.5], [5000, 2.5]]) {
    f.now = now; f.bot.entity.position.x = x; await f.poll()
  }
  assert.ok(f.losGoal, 'actual displacement keeps the intermediate route')
  assert.equal(f.pathing, true)
})

test('reaching the LOS stand releases its path immediately', async () => {
  const f = routeScene(); f.now = 1001; f.bot.entity.position.x = 6.5
  await f.poll()
  assert.equal(f.losGoal, null)
  assert.equal(f.pathing, false)
})

test('LOS routing does not cancel a valid stationary dig when the old duration expires', async () => {
  const f = routeScene(); f.now = 10000; f.mining = true
  await f.poll()
  assert.ok(f.losGoal)
  assert.equal(f.pathing, true)
})

test('a stalled LOS route does not retry unchanged geometry when only time advances', async () => {
  const f = routeScene(); f.dy = 0; f.now = 60000; f.stuckTicks = 8
  await f.poll(); f.commands.length = 0
  f.now = 120000; f.stuckTicks = 8
  await f.poll()
  assert.equal(f.commands.filter(c => c.on).length, 0)
  f.entity.position.x += 2
  await f.poll()
  assert.equal(f.commands.filter(c => c.on).length, 1, 'a different target cell permits a new approach immediately')
})

test('an unchanged unblock refusal cannot renew a failed intermediate route', async () => {
  const f = routeScene(); f.dy = 0; f.now = 60000
  await f.poll()
  f.st.blockedSince = 1000; f.now = 120000; f.unblockPath = async () => false
  await f.unblock()
  assert.equal(f.reposition, null)
})

test('a newly usable tool for the observed exit releases a failed approach at the same pose', async () => {
  const f = routeScene(); f.dy = 0
  const blockAt = f.bot.blockAt; let digMs = 10000
  f.bot.blockAt = p => p.floored().equals(new Vec3(1, 0, 0))
    ? { name: 'obsidian', stateId: 1, position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
    : blockAt(p)
  f.tools = { bestFor: () => ({ ms: digMs }) }
  f.reposition.failed = 'noPath'; f.stuckTicks = 8
  await f.poll(); f.commands.length = 0
  f.hp = 19; f.now += 60000
  await f.poll()
  assert.equal(f.commands.filter(c => c.on).length, 0, 'unrelated health and age do not change an obstructed exit')
  digMs = 500
  await f.poll()
  assert.equal(f.commands.filter(c => c.on).length, 1)
})

async function attackerTurn({ visible = true, r = 8, inSight = false } = {}) {
  const ctx: any = { prof: { player: true }, duo: { active: () => false }, now: 1000, switchedAt: 1000,
    otherAttacker: () => ({ e: { id: 3, username: 'Other' }, dist: 2 }),
    reachFrom: () => 2, eye: {}, entity: { id: 2 }, HIT_REACH: 2.9,
    lastHurtByTarget: 1000, foeHpDecide: () => 20, theirHp: 20, r, d: r,
    busyFoe: false, inSight, vision: { visible: () => visible }, pick: { canHit: () => visible }, bot: {},
    turns: [] as number[], used() {}, retarget: e => ctx.turns.push(e.id), holdWeapon: async () => {} }
  const at = source.indexOf('    if (prof.player && !duo.active()'); const branch = source.slice(at, source.indexOf('\n    if (', at + 8))
  await runInNewContext(`(async () => { for (let pass = 0; pass < 1; pass++) { ${branch} } })()`, ctx)
  return ctx.turns
}

test('an available close attacker can replace an unreachable target without a three-second lock', async () => {
  assert.deepEqual(await attackerTurn(), [3])
})

test('an available current contact is not abandoned for an equal nearby attacker', async () => {
  assert.deepEqual(await attackerTurn({ r: 2, inSight: true }), [])
  assert.deepEqual(await attackerTurn({ visible: false }), [])
})


function ifBody(marker: string) {
  let start = source.indexOf(marker)
  assert.ok(start >= 0, marker)
  start = source.indexOf('if (', start)
  const open = source.indexOf('{', start)
  let depth = 1, quote = '', escaped = false, at = open + 1
  for (; at < source.length && depth; at++) {
    const c = source[at]
    if (escaped) escaped = false
    else if (quote) { if (c === '\\') escaped = true; else if (c === quote) quote = '' }
    else if ('\'"`'.includes(c)) quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
  }
  return source.slice(start, at)
}

function counterScene({ bow = false, near = false } = {}) {
  const bot = scene(new Vec3(.5, 0, .5)); const target = new Vec3(near ? .5 : 5.5, 4, .5)
  let geometry = 'wall', mining = false, towers = 0
  const commands: any[] = []
  const ctx: any = { bot, entity: { id: 2, position: target }, me: bot.entity.position, foeSeenPos: target,
    now: 1000, dy: 4, theyUp: true, upLong: false, pillarNeeded: true, prof: { player: true },
    perch: null, fort: null, meInWeb: false, reposition: null, pathing: true,
    st: { build: { refused: 0 } }, ready: () => true, rest() {}, used() {}, clear() {}, aim: 'target',
    goals, TICK_MS: 50, PILLAR_MS: 400, THEIR_REACH: 3.4, theirR: 8, FIX: true,
    failedCounter: null, counterRoute: null, columnInputs: () => `${bot.entity.position.floored()}|${target.floored()}|${geometry}`,
    routeInputs: () => `${bot.entity.position.floored()}|${target.floored()}|${geometry}`,
    pickFiller: () => ({ name: 'cobblestone' }), countOf: () => 64, headroom: () => true,
    findItem: (_b, predicate) => (bow ? [{ name: 'bow' }, { name: 'arrow' }] : []).find(predicate),
    miningProgress: () => mining, pathTo: (on, goal) => commands.push({ on, goal }),
    sleep: async () => {}, noteBuild() {}, buildGuard: () => ({}), guardCtl: g => g,
    towerShield() {}, holdWeapon: async () => {}, buildDone: () => false,
    towerUp: async () => { towers++; return { ok: false, placed: 0, why: 'face blocked' } } }
  const columnStart = source.indexOf('  const columnInputs = ')
  if (columnStart >= 0) {
    ctx.edges = { fillerCount: () => 64 }; ctx.pick = pick
    runInNewContext(source.slice(columnStart, source.indexOf('  const windInputs = ', columnStart)) + '\nglobalThis.columnInputs = columnInputs', ctx)
  }
  const branch = ifBody('    if (theyUp && prof.player && !perch && !reposition')
  runInNewContext(`globalThis.poll = async () => { me = bot.entity.position; for (let pass = 0; pass < 1; pass++) { ${branch} } }`, ctx)
  return { ctx, commands, towers: () => towers, mining: v => { mining = v }, geometry: v => { geometry = v; const read = bot.blockAt; bot.blockAt = p => p.floored().equals(new Vec3(0, 2, 0)) ? { ...read(p), name: v, stateId: v } : read(p) } }
}

test('counter pillar owns its approach even when another route is already active', async () => {
  const f = counterScene(); await f.ctx.poll()
  assert.ok(f.commands.some(c => c.on && c.goal), 'a dedicated approach goal must be installed')
})

test('counter approach keeps a useful long dig beyond its previous three-second window', async () => {
  const f = counterScene(); await f.ctx.poll(); f.mining(true)
  f.ctx.now += 60000; await f.ctx.poll()
  assert.equal(f.commands.filter(c => !c.on).length, 0)
})

test('counter approach does not restart a failed unchanged route after eight seconds', async () => {
  const f = counterScene(); await f.ctx.poll()
  f.ctx.now += 3100; await f.ctx.poll()
  const before = f.commands.length
  f.ctx.now += 60000; await f.ctx.poll()
  assert.equal(f.commands.length, before)
  f.geometry('opening'); await f.ctx.poll()
  assert.ok(f.commands.length > before, 'a changed observed exit permits a new approach immediately')
})

test('counter pillar can replace an unusable bow immediately instead of waiting six seconds on top', async () => {
  const f = counterScene({ bow: true, near: true }); await f.ctx.poll()
  assert.equal(f.towers(), 1)
})

test('failed counter construction is not repeated unchanged; a new support releases it immediately', async () => {
  const f = counterScene({ near: true }); await f.ctx.poll(); assert.equal(f.towers(), 1)
  f.ctx.now += 60000; await f.ctx.poll(); assert.equal(f.towers(), 1)
  f.geometry('new support'); await f.ctx.poll(); assert.equal(f.towers(), 2)
})


test('failed shelter remains refused through time and unlocks on a changed material plan', async () => {
  let material = 'none', attempts = 0
  const ctx: any = { bot: {}, entity: { position: new Vec3(8, 0, 0) }, style: { reactMs: 100 }, BOX_MS: 2500,
    totemMod: { absorption: () => 0 }, st: { build: {} },
    fortSpot: () => new Vec3(0, 0, 0), fortify: { boxCheck: () => ({ ok: true, ms: 500 }) },
    wallInputs: () => material, buildHot: () => false, tt: { safe: () => ({ ok: true }) },
    pvpSkills: { fortOut: async () => { attempts++; return false } } }
  const start = source.indexOf('  let failedFort = '), original = source.indexOf('  const fortOut = ')
  const end = source.indexOf('\n  const punchThrough', original)
  const init = start >= 0 ? source.slice(start, end) : source.slice(original, end)
  runInNewContext(require('esbuild').transformSync(init + '\nglobalThis.tryFort = fortOut', { loader: 'ts' }).code, ctx)
  await ctx.tryFort(); ctx.now = 60000; await ctx.tryFort(); assert.equal(attempts, 1)
  material = 'enough blocks with visible faces'; await ctx.tryFort(); assert.equal(attempts, 2)
})

test('a failed smash does not repeat on the same launch; a changed available trajectory permits it', async () => {
  let attempts = 0, trajectory = 'blocked', nativeReady = false
  const ctx: any = { prof: { player: true }, perch: null, fort: null, meInWeb: false, hp: 20, pendingLava: [],
    smashSetup: false, ready: () => true, rest() {}, entity: { id: 2, position: new Vec3(3, 0, 0), equipment: [] },
    tt: { foes: new Map() }, tempo: { PLAYER_REACH: 3.4, swingCooldownMs: () => 625 }, now: 1000, TICK_MS: 50,
    theirR: 8, theyBow: false, aimedCb: null, duo: { active: () => false }, gate: () => true,
    mace: { smashPlan: () => ({}), windSmash: async () => { attempts++; return { hit: false, launched: true, why: 'missed landing' } } },
    maceChain: { choose: () => null }, failedSmash: null, windInputs: (native = true) => trajectory + (native ? nativeReady : ''), guard: null,
    bot: { entity: { position: new Vec3(0, 0, 0) } }, clear() {}, aim: 'target', st: {}, mc: { st: {} },
    track: { vel: () => new Vec3(0, 0, 0) }, telemetryHp: () => null, used() {}, holdWeapon: async () => {},
    process: { env: {} }, console: { log() {} }, ctl: { aborted: false } }
  const branch = ifBody('    if (!smashSetup && prof.player')
  runInNewContext(`globalThis.poll = async () => { for (let pass = 0; pass < 1; pass++) { ${branch} } }`, ctx)
  await ctx.poll(); ctx.now += 60000; nativeReady = true; await ctx.poll(); assert.equal(attempts, 1)
  trajectory = 'new safe landing'; await ctx.poll(); assert.equal(attempts, 2)
})

function flankScene() {
  const bot = scene(); let geometry = 'blocked', mining = false
  const commands: boolean[] = []
  const ctx: any = { bot, me: bot.entity.position, entity: { id: 2, position: new Vec3(8, 0, 0) },
    now: 1000, r: 8, d: 8, HIT_REACH: 2.9, TICK_MS: 50, theyUp: false, pathing: false,
    failedFlank: null, failedReposition: null, flankRoute: null, st: {}, goals, theyEat: false,
    routeInputs: () => geometry, miningProgress: () => mining, clear() {}, ready: () => true, rest() {}, used() {},
    pathTo: on => commands.push(on), sleep: async () => {} }
  const branch = ifBody('      } else if (r > HIT_REACH && !theyUp')
  runInNewContext(`globalThis.poll = async () => { me = bot.entity.position; for (let pass = 0; pass < 1; pass++) { ${branch} } }`, ctx)
  return { ctx, commands, mining: v => { mining = v }, geometry: v => { geometry = v } }
}

test('flank watchdog reports failure, and six seconds cannot re-arm that same blocked approach', async () => {
  const f = flankScene(); await f.ctx.poll(); f.ctx.now += 3100; await f.ctx.poll()
  const count = f.commands.length
  f.ctx.now += 60000; await f.ctx.poll(); assert.equal(f.commands.length, count)
  f.geometry('opened flank'); await f.ctx.poll(); assert.ok(f.commands.length > count)
})

test('flank retains its own advancing route and does not interrupt useful mining', async () => {
  const f = flankScene(); await f.ctx.poll(); f.mining(true)
  f.ctx.now += 60000; await f.ctx.poll()
  assert.deepEqual(f.commands, [true])
})

test('a grounded high target offers climb immediately, and a failed shaft needs a real new cause', async () => {
  let climbs = 0, geometry = 'blocked'
  const ctx: any = { AR: null, prof: { player: true }, dy: 7, st: { highSince: 1000 }, now: 1000,
    perch: null, d: 5, ready: () => true, rest() {}, climbInputs: 'blocked|blocked', failedClimb: null,
    foeGrounded: () => true, pathTo() {}, pathing: false, clear() {}, aim: 'target',
    gameClock: { now: () => ctx.now }, entity: { position: new Vec3(5, 7, 0) }, bot: { entity: { position: new Vec3(0, 0, 0) } },
    buildGuard: () => ({}), guardCtl: g => g, towerShield() {}, buildDone: () => false,
    edges: { climbBack: async () => { climbs++; return { ok: false, why: 'shaft blocked' } } },
    bowWatch: { shots: 0 }, findItem: () => null, holdWeapon: async () => {}, used() {}, process: { env: {} },
    routeInputs: () => geometry, columnInputs: () => geometry }
  const branch = ifBody('    if (!AR && prof.player && dy > 6')
  runInNewContext(require('esbuild').transformSync(`globalThis.poll = async () => { for (let pass = 0; pass < 1; pass++) { ${branch} } }`, { loader: 'ts' }).code, ctx)
  await ctx.poll(); assert.equal(climbs, 1)
  ctx.now += 60000; await ctx.poll(); assert.equal(climbs, 1)
  geometry = 'open'; ctx.climbInputs = 'open|open'; await ctx.poll(); assert.equal(climbs, 2)
})

test('a rejected combat hop chooses another means until its observed obstacle changes', async () => {
  let attempts = 0, geometry = 'blocked'
  const ctx: any = { HOP: true, prof: { player: true }, perch: null, fort: null, meInWeb: false,
    bot: { entity: { position: new Vec3(0, 0, 0), onGround: true, isInWater: false, isCollidedHorizontally: true } },
    entity: { position: new Vec3(4, 1, 0) }, HOP_DUMMY: true, r: 4, d: 4, dy: 1,
    HIT_REACH: 2.9, TICK_MS: 50, now: 1000, hopDAt: 1000, hopD: 4, stuckTicks: 4,
    ready: () => true, rest() {}, pathing: false, pathTo() {}, clear() {}, ctl: { aborted: false },
    failedHop: null, failedReposition: null, failedFlank: null, miningProgress: () => false,
    routeInputs: () => geometry, hazardOnLine: () => ({}), st: {}, used() {}, sleep: async () => {}, gameClock: { now: () => ctx.now },
    require: id => { assert.equal(id, './navigation/parkour'); return { combatHop: async () => { attempts++; return { ok: false, why: 'no supported landing' } } } } }
  const branch = ifBody('    if (HOP && prof.player')
  runInNewContext(`globalThis.poll = async () => { for (let pass = 0; pass < 1; pass++) { ${branch} } }`, ctx)
  await ctx.poll(); ctx.now += 60000; await ctx.poll(); assert.equal(attempts, 1)
  geometry = 'new support'; await ctx.poll(); assert.equal(attempts, 2)
})
