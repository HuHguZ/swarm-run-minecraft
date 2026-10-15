import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()
const { createCover } = require('../src/pvp/cover')
const pick = require('../src/pick')

function scene({ hp = 8, floor = 'stone', own = true, height = 6, digMs = 150, move = true } = {}) {
  const blocks = new Map<string, string>()
  const control = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const inputs: Array<[string, boolean]> = []; const digs: Vec3[] = []; const notes: string[] = []
  let now = 0
  const blockAt = (p: Vec3) => {
    const q = p.floored(); const name = blocks.get(q.toString()) ?? (q.y === 119 ? floor : q.y < 119 ? 'stone' : 'air')
    const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = q; return b
  }
  const world = { getBlock: blockAt }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, health: hp, food: 0, entities: {}, inventory: { slots: [], items: () => [] },
    game: { minY: -64, height: 384, dimension: 'overworld' }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { id: 1, name: 'player', position: new Vec3(.5, 120, .5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0,
      onGround: true, eyeHeight: 1.62, height: 1.8, effects: {}, attributes: {}, metadata: [], isInWater: false, isInLava: false, isInWeb: false },
    blockAt, physics: native.Physics(registry, world),
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    lookAt: async (p: Vec3) => { const d = p.minus(pick.eyeOf(bot)); await bot.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))) },
    setControlState: (k: string, v: boolean) => { control[k] = v; inputs.push([k, v]) },
    getControlState: (k: string) => control[k],
    clearControlStates: () => { for (const k of Object.keys(control)) control[k] = false },
    dig: async (b: any) => { digs.push(b.position.clone()); blocks.set(b.position.toString(), 'air') },
    stopDigging: () => {}, equip: async (item: any) => { bot.heldItem = item }
  })
  const ctx: any = {
    bot, Vec3, pick, ctl: { aborted: false, onAbort: [] }, TICK_MS: 50, PERCH_MAX: 8,
    entity: { id: 2, name: 'player', position: new Vec3(10.5, 120, .5), isValid: true },
    gameClock: { now: () => now, wall: { now: () => Date.now() } }, prof: { player: true }, st: { blocks: 0, build: {} },
    tools: { bestFor: () => ({ ms: digMs, item: null }) },
    clear: bot.clearControlStates, set: bot.setControlState, pathTo: () => {},
    edgeGuard: { allow: () => {} }, aim: 'target', pathing: false,
    yawTo: (a: Vec3, b: Vec3) => Math.atan2(a.x - b.x, a.z - b.z),
    blockName: (_b: any, p: Vec3) => blockAt(p).name,
    used: (s: string) => notes.push(s), holdWeapon: async () => {}, heldName: () => null, switched: () => {},
    withTimeout: async (p: Promise<unknown>) => p,
    mace: { fallSmashReady: () => false }, findItem: () => null,
    pickFiller: () => ({ name: 'cobblestone' }), countOf: () => 64,
    noteBuild: () => {}, buildGuard: () => () => false, guardCtl: (g: any) => g, buildDone: () => false,
    headroom: () => true, perchHeight: () => height, towerShield: async () => {},
    towerUp: async (_bot: unknown, _ctl: unknown, _height: number, opts: any) => {
      for (let i = 0; i < height; i++) {
        await opts.beforeStep()
        blocks.set(new Vec3(0, 120 + i, 0).toString(), 'cobblestone')
        bot.entity.position.y++
      }
      return { ok: true, placed: height }
    },
    sleep: async (ms: number) => {
      for (let i = 0; i < Math.ceil(ms / 50); i++) {
        now += 50
        if (move) { const state = new native.PlayerState(bot, control); bot.physics.simulatePlayer(state, world); state.apply(bot) }
        bot.emit('physicsTick')
      }
    }
  }
  const cover = createCover(ctx)
  const ready = async () => {
    await cover.pillarOut()
    if (!own) delete ctx.perch.own
    inputs.length = 0
  }
  return { bot, ctx, cover, ready, blocks, inputs, digs, notes, control }
}

test('the own-support tag is present only at dig entry and restores the previous tag', async () => {
  for (const fail of [false, true]) {
    const s = scene(); await s.ready()
    const prior = { what: 'previous operation' }
    s.bot._ndBlockTag = prior
    const raw = s.bot.dig
    let seen
    s.bot.dig = async block => {
      seen = s.bot._ndBlockTag
      await Promise.resolve()
      assert.equal(s.bot._ndBlockTag, prior, 'another action must not inherit the descent tag')
      if (fail) throw new Error('Digging aborted')
      return raw(block)
    }
    await s.cover.dropFromPerch()
    assert.equal(seen.intent, 'perch-descent')
    assert.ok(seen.cell.equals(new Vec3(0, 125, 0)))
    assert.equal(s.bot._ndBlockTag, prior)
  }
})

test('low HP and no arrows: dismantle our six-block perch one visible support at a time', async () => {
  const s = scene(); await s.ready()
  assert.equal(pick.faceAim(s.bot, new Vec3(0, 125, 0), new Vec3(0, 1, 0))?.y, 126)
  const result = await s.cover.dropFromPerch()
  assert.equal(s.digs.length, 1, 'break a confirmed own support instead of paying three HP for the fall')
  assert.equal(s.bot.entity.position.y, 125)
  assert.equal(s.bot.health, 8)
  assert.ok(s.ctx.perch, 'return to the combat loop between individual blocks')
  assert.equal(result.kind, 'dig')
  assert.ok(!s.inputs.some(([key, on]) => key === 'forward' && on))
})

test('a ready water clutch competes with digging the whole perch', async () => {
  const s = scene({ digMs: 400, move: false }); await s.ready()
  const bucket = { name: 'water_bucket', slot: 39, count: 1 }
  s.bot.inventory.slots[39] = bucket
  s.ctx.findItem = (_bot, predicate) => predicate(bucket) ? bucket : null
  s.ctx.tempo = require('../src/tempo')
  s.ctx.entity.position.x = 24.5
  s.ctx.tt = { eta: () => Math.max(0, s.ctx.tempo.reachFrom(s.ctx.entity.position.offset(0, 1.62, 0), s.bot.entity) - s.ctx.tempo.PLAYER_REACH) / s.ctx.tempo.SPRINT_BPT * 50 }
  let claimed = 0, released = 0
  s.bot._ndFallGuard = { fired: 0, picked: 0, waterReady: () => ({ ok: true }),
    planWater: () => { claimed++; return () => released++ } }
  const result = await s.cover.dropFromPerch()
  assert.equal(result.kind, 'water', 'known reachable water clutch should beat six digs in this scene')
  assert.equal(s.digs.length, 0)
  assert.equal(result.ok, false, 'the stationary fixture cannot claim a successful landing')
  assert.equal(claimed, 1)
  assert.equal(released, 1)
  assert.ok(Object.values(s.control).every(v => !v))
})

test('a bucket does not authorize jumping onto lava or with an unavailable water guard', async () => {
  for (const floor of ['lava', 'stone']) {
    const s = scene({ floor, own: floor !== 'lava', hp: 1 }); await s.ready()
    const bucket = { name: 'water_bucket', slot: 39, count: 1 }
    s.ctx.findItem = (_bot, predicate) => predicate(bucket) ? bucket : null
    s.bot._ndFallGuard = { waterReady: () => ({ ok: false, why: 'dimension' }), planWater: () => assert.fail('not water-ready') }
    const result = await s.cover.dropFromPerch()
    assert.notEqual(result.kind, 'water')
    assert.equal(result.kind, floor === 'stone' ? 'dig' : undefined)
    assert.ok(!s.inputs.some(([key, on]) => key === 'forward' && on))
  }
})

test('an opponent waiting below raises the water-drop price', async () => {
  const s = scene({ digMs: 400 }); await s.ready()
  const bucket = { name: 'water_bucket', slot: 39, count: 1 }
  s.ctx.findItem = (_bot, predicate) => predicate(bucket) ? bucket : null
  s.ctx.tempo = require('../src/tempo')
  s.ctx.entity.position = new Vec3(2.5, 120, .5)
  s.ctx.tt = { eta: () => 1000 }
  s.bot._ndFallGuard = { waterReady: () => ({ ok: true }), planWater: () => assert.fail('exposed landing must not win this comparison') }
  assert.notEqual((await s.cover.dropFromPerch()).kind, 'water')
})

test('bucket preparation reprices changed HP instead of keeping an old jump or banning descent', async () => {
  const s = scene({ digMs: 600 }); await s.ready()
  await s.ctx.sleep(100)
  const bucket = { name: 'water_bucket', slot: 39, count: 1 }
  s.ctx.findItem = (_bot, predicate) => predicate(bucket) ? bucket : null
  s.ctx.tempo = require('../src/tempo')
  s.ctx.entity.position.x = 24.5
  s.ctx.tt = { eta: () => 3500 }
  let settled = false
  const sleep = s.ctx.sleep
  s.ctx.sleep = async ms => { settled = true; s.bot.health = 1; await sleep(ms) }
  s.bot._ndFallGuard = { waterReady: () => settled ? { ok: true } : { ok: false, retryMs: 50 },
    planWater: () => assert.fail('water is too expensive after the injury') }
  const result = await s.cover.dropFromPerch()
  assert.equal(result.kind, 'dig')
  assert.equal(result.ok, true)
  assert.equal(s.digs.length, 1)
})

test('preparation cleanup waits for the repriced descent to release its hand', async () => {
  const s = scene({ digMs: 600 }); await s.ready()
  await s.ctx.sleep(100)
  const bucket = { name: 'water_bucket', slot: 39, count: 1 }
  s.ctx.findItem = (_bot, predicate) => predicate(bucket) ? bucket : null
  s.ctx.tempo = require('../src/tempo'); s.ctx.entity.position.x = 24.5
  s.ctx.tt = { eta: () => 3500 }
  let settled = false, restored = 0, enter, resume
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { resume = resolve })
  const sleep = s.ctx.sleep
  s.ctx.sleep = async ms => { settled = true; s.bot.health = 1; await sleep(ms) }
  s.bot._ndFallGuard = { waterReady: () => settled ? { ok: true } : { ok: false, retryMs: 50 } }
  s.bot._ndFallGuard.planWater = () => assert.fail('reprice selects the support')
  s.ctx.holdWeapon = async () => { restored++ }
  s.bot.look = async () => { enter(); await held }
  const running = s.cover.dropFromPerch()
  await Promise.race([entered, running.then(() => assert.fail('child must reach its deferred look'))]); await Promise.resolve()
  try { assert.equal(restored, 0, 'outer cleanup must not change the active child hand') }
  finally { resume(); await running }
})

test('cancellation during the look cannot enable movement off the perch', async () => {
  const s = scene({ own: false, hp: 20 }); await s.ready()
  s.bot.look = async () => { s.ctx.ctl.aborted = true }
  await s.cover.dropFromPerch()
  assert.ok(!s.inputs.some(([key, on]) => key === 'forward' && on))
  assert.equal(s.bot.entity.position.y, 126)
})

test('all surroundings lethal: keep the perch and never walk into the fallback direction', async () => {
  const s = scene({ floor: 'lava', own: false }); await s.ready()
  const perch = s.ctx.perch
  const result = await s.cover.dropFromPerch()
  assert.equal(s.ctx.perch, perch)
  assert.ok(!s.inputs.some(([key, on]) => key === 'forward' && on))
  assert.equal(s.digs.length, 0)
  assert.equal(result.ok, false)
})

test('a lethal drop with no own support is refused at one HP', async () => {
  const s = scene({ hp: 1, own: false }); await s.ready()
  const result = await s.cover.dropFromPerch()
  assert.ok(s.ctx.perch)
  assert.ok(!s.inputs.some(([key, on]) => key === 'forward' && on))
  assert.equal(result.ok, false)
})

test('blocked movement does not report a completed descent or forget the perch', async () => {
  const s = scene({ own: false, move: false, hp: 20 }); await s.ready()
  const result = await s.cover.dropFromPerch()
  assert.ok(s.ctx.perch)
  assert.ok(Object.values(s.control).every(v => !v))
  assert.equal(result.ok, false)
})

test('hidden destruction below our support does not act as a safety oracle', async () => {
  const intact = scene({ hp: 1 }); const hiddenChange = scene({ hp: 1 })
  await intact.ready(); await hiddenChange.ready()
  for (let y = 120; y < 125; y++) hiddenChange.blocks.set(new Vec3(0, y, 0).toString(), 'air')
  assert.equal(pick.blockSeen(hiddenChange.bot, new Vec3(0, 124, 0)), false)
  await intact.cover.dropFromPerch(); await hiddenChange.cover.dropFromPerch()
  assert.deepEqual(hiddenChange.digs, intact.digs, 'the same visible top and construction memory authorize the same initial action')
  assert.equal(intact.digs.length, 1)
})

test('construction remembers supports when seen, not by rereading the hidden finished column', async () => {
  const s = scene()
  s.ctx.towerShield = async () => {
    if (s.bot.entity.position.y === 123) s.blocks.set(new Vec3(0, 120, 0).toString(), 'air')
  }
  await s.ready()
  assert.equal(s.ctx.perch.own.length, 6, 'a hidden later destruction cannot erase our earlier observation')
  assert.equal((await s.cover.dropFromPerch()).kind, 'dig')
})

test('successive own supports reach the original floor without a large fall', async () => {
  const s = scene({ hp: 1 }); await s.ready()
  for (let i = 0; i < 6; i++) {
    const result = await s.cover.dropFromPerch()
    assert.equal(result.kind, 'dig')
    assert.equal(s.bot.entity.position.y, 125 - i)
  }
  assert.equal(s.ctx.perch, null)
  assert.equal(s.digs.length, 6)
  assert.equal(s.bot.health, 1)
  assert.equal(s.bot.blockAt(new Vec3(0, 119, 0)).name, 'stone', 'the original floor is never mined')
})

test('a nonlethal observed landing is still reachable at four HP', async () => {
  const s = scene({ hp: 4, own: false }); await s.ready()
  const result = await s.cover.dropFromPerch()
  assert.equal(result.kind, 'drop')
  assert.equal(result.ok, true)
  assert.equal(result.damage, 3)
  assert.equal(s.bot.entity.position.y, 120)
  assert.ok(s.bot.entity.onGround)
  assert.equal(s.ctx.perch, null)
  assert.ok(Object.values(s.control).every(v => !v))
})

test('visible threat makes a slow six-block dig dearer than the nonlethal drop', async () => {
  const s = scene({ digMs: 10000 }); await s.ready()
  s.ctx.tt = { eta: () => 1000 }
  const result = await s.cover.dropFromPerch()
  assert.equal(result.kind, 'drop')
  assert.equal(result.ok, true)
  assert.equal(s.digs.length, 0)
})

test('own Feather Falling participates in the physical fall budget', async () => {
  const s = scene({ hp: 2, own: false }); await s.ready()
  s.bot.inventory.slots[8] = { name: 'diamond_boots', componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'minecraft:feather_falling', level: 4 }] } }]]) }
  const result = await s.cover.dropFromPerch()
  assert.equal(result.ok, true)
  assert.ok(Math.abs(result.damage - 1.56) < 1e-6)
})

test('the native Resistance id participates in our physical fall budget', async () => {
  const s = scene({ hp: 2, own: false }); await s.ready()
  const effect = registry.effectsByName.Resistance
  s.bot.entity.effects[effect.id] = { id: effect.id, amplifier: 1, duration: 100 }
  const result = await s.cover.dropFromPerch()
  assert.equal(result.ok, true)
  assert.ok(Math.abs(result.damage - 1.8) < 1e-6)
})

test('an unseen landing cannot authorize a new drop', async () => {
  const s = scene({ own: false }); await s.ready()
  s.ctx.pick = { ...pick, blockSeen: () => false }
  const result = await s.cover.dropFromPerch()
  assert.equal(result.ok, false)
  assert.ok(!s.inputs.some(([key, on]) => key === 'forward' && on))
})

test('cancellation during digging stops the hand and removes the abort callback', async () => {
  const s = scene(); await s.ready()
  let stops = 0
  s.bot.stopDigging = () => { stops++ }
  s.bot.dig = async () => {
    s.ctx.ctl.aborted = true
    for (const abort of s.ctx.ctl.onAbort) abort()
  }
  const result = await s.cover.dropFromPerch()
  assert.equal(result.ok, false)
  assert.ok(s.ctx.perch)
  assert.ok(stops > 0)
  assert.equal(s.ctx.ctl.onAbort.length, 0)
  assert.ok(Object.values(s.control).every(v => !v))
})

test('the actual pickaxe is equipped before the dig priced at its speed', async () => {
  const s = scene(); await s.ready()
  const pickaxe = { name: 'diamond_pickaxe', slot: 37 }
  s.bot.heldItem = { name: 'diamond_sword', slot: 36 }
  s.ctx.tools.bestFor = () => ({ ms: 150, item: pickaxe })
  const dig = s.bot.dig
  s.bot.dig = async (block: unknown) => { assert.equal(s.bot.heldItem, pickaxe); return dig(block) }
  const result = await s.cover.dropFromPerch()
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'dig')
})

// Execute the actual caller branch rather than duplicate its HP/continue
// conditions. The complete fight needs live inventory, routing and opponents;
// this isolates only the integration from that unrelated infrastructure.
async function perchCaller(hp: number, result: { ok: boolean; acted: boolean }, options: any = {}) {
  const source = readFileSync(process.env.ND_TEST_PERCH_CALLER_SOURCE || join(__dirname, '../src/pvp.ts'), 'utf8')
  const start = source.lastIndexOf('if (perch)', source.indexOf('const noArrows'))
  const end = source.indexOf('const inc = threats.incoming', start)
  assert.ok(start >= 0 && end > start, 'the real perch caller is present')
  const branch = source.slice(start, end)
  const ctx: any = {
    hp, now: 1000, perch: { y0: 120, top: 126, h: 6, since: 0 }, calls: 0, normalCombat: 0,
    bot: { entity: { position: new Vec3(.5, 126, .5), attributes: {} }, food: 0 }, entity: {},
    findItem: () => null, ready: () => true, rest: () => {}, used: () => {}, canHeal: false,
    hasEffect: () => false, rangedAllowed: () => true, vision: { visible: () => true },
    dropFromPerch: async () => { ctx.calls++; return result }, ...options
  }
  await runInNewContext(`(async () => { for (let pass = 0; pass < 1; pass++) { ${branch}\n normalCombat++ } })()`, ctx)
  return ctx
}

test('actual PvP caller requests descent at HP8 with no arrows or healing', async () => {
  const ctx = await perchCaller(8, { ok: true, acted: true })
  assert.equal(ctx.calls, 1)
  assert.equal(ctx.normalCombat, 0, 'successful descent takes this combat turn')
})

test('actual PvP caller keeps fighting after a descent refusal without action', async () => {
  const ctx = await perchCaller(20, { ok: false, acted: false })
  assert.equal(ctx.calls, 1)
  assert.equal(ctx.normalCombat, 1, 'a declined plan does not unconditionally continue')
})

test('useful ranged perch does not expire after forty-five seconds', async () => {
  const ctx = await perchCaller(20, { ok: true, acted: true }, { now: 60000,
    findItem: (_bot, predicate) => [{ name: 'bow' }, { name: 'arrow' }].find(predicate) })
  assert.equal(ctx.calls, 0)
  assert.equal(ctx.normalCombat, 1)
})

test('healing still makes a perch useful even after running out of arrows', async () => {
  const ctx = await perchCaller(8, { ok: true, acted: true }, { canHeal: true, now: 60000 })
  assert.equal(ctx.calls, 0)
})

test('a failed perch dig is not aged away, and a newly available descent resource opens another choice', async () => {
  const s = scene(); await s.ready()
  const source = readFileSync(join(__dirname, '../src/pvp.ts'), 'utf8')
  const init = source.indexOf('  let failedPerchDrop = ')
  const start = init >= 0 ? init : source.indexOf('  const dropFromPerch = ')
  const end = source.indexOf('  let fort = ', start)
  let calls = 0, water = false
  const ctx: any = { bot: s.bot, session: {}, tools: { bestFor: () => ({ ms: 150 }) },
    routeInputs: () => 'same support and stance', hasEffect: () => false,
    itemInputs: () => water ? 'water_bucket:36:1' : '',
    pvpSkills: { dropFromPerch: async () => { calls++; return { ok: false, acted: true, kind: 'dig' } } } }
  runInNewContext(require('esbuild').transformSync(source.slice(start, end) + '\nglobalThis.tryDrop = dropFromPerch', { loader: 'ts' }).code, ctx)
  await ctx.tryDrop(); ctx.now = 60000; await ctx.tryDrop(); assert.equal(calls, 1)
  water = true; await ctx.tryDrop(); assert.equal(calls, 2, 'an available bucket must let the planner compare its other descent means')
})
