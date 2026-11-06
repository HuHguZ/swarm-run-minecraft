// Паркур: прыжки — разбег, отскок слизи и пружины, лестница за углом, ступени, бюджет прямых профилей, прогноз, бой, паутина.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { native, worldOf, drive } from './parkour-fixture'

test('a loaded bent runway preserves a real intermediate landing before the next rising jump', async () => {
  const floor: Array<[number, number, number, string]> = [[0, 0, 1, 'stone'], [1, 0, 0, 'stone'], [1, 0, 1, 'stone'], [1, 0, 2, 'stone'], [2, 0, 0, 'stone'], [2, 0, 1, 'stone'], [2, 0, 2, 'stone'], [3, 0, 0, 'stone'], [3, 0, 1, 'stone'], [6, 1, 5, 'stone']]
  const { bot } = worldOf(floor)
  bot.physics.playerHalfWidth = Math.fround(.6) / 2
  bot.entity.position = new Vec3(3.54227155072947, 1, 1.536848335588923); bot.entity.velocity.y = -.0784000015258789
  const before = bot.entity.position.clone(); const target = new Vec3(6.5, 2, 5.5)
  const { planJumpAsync, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bodyClear }: typeof import('../src/navigation/geometry') = require('../src/navigation/geometry')
  const plan = await planJumpAsync(bot, { aborted: false }, target, { allowWalk: true, maxTicks: 38, planningMs: 180 })
  assert.ok(plan, 'stopping at every center must not erase an observed, physically reachable two-jump continuation')
  assert.deepEqual(bot.entity.position, before, 'forecasting may not move the bot or inject velocity')
  const jumps = plan.steps.flatMap((step: any, i: number) => step.control.jump ? [i] : [])
  assert.ok(jumps.length >= 2, 'both impulses must be earned by actual native grounded jumps')
  assert.ok(plan.states.slice(jumps[0], jumps[1]).some((s: any) => s.onGround && s.isCollidedVertically && s.pos.y === 1), 'the second jump requires an observed native floor collision')
  assert.ok(plan.states.every((s: any) => bodyClear(bot, s.pos) && !s.isInWater && !s.isInLava && s.pos.y >= .6))
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 2)
  assert.ok(landed.pos.distanceTo(target) < .22)
  assert.ok(Math.hypot(landed.vel.x, landed.vel.z) < .035)
  assert.ok(plan.states.slice(-6).every((s: any) => s.onGround && s.pos.y === 2 && s.pos.distanceTo(target) < .22))
  const observed = bot.blockAt
  bot.blockAt = (p: Vec3) => p.x < 3 ? null : observed(p)
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, { allowWalk: true, maxTicks: 38, planningMs: 180 }), null, 'an unobserved runway cannot supply the same earned momentum')
  assert.deepEqual(bot.entity.position, before)
})
test('a native grounded flag after leaving a lava-side ledge cannot supply a delayed rising jump', async () => {
  // Translated observed Author36 geometry; names with equal full collision and
  // friction use stone. State-specific slab tops and the overhead corner stay.
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = []
  const lavaRows = new Map([[0, [1, 2]], [1, [0, 1, 2]], [2, [0, 1, 2, 3]], [3, [0, 1, 2]], [4, [0, 1]], [5, [0]]])
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 6; z++) cells.push([x, 0, z, lavaRows.get(z)?.includes(x) ? 'lava' : 'stone'])
  for (let y = 1; y <= 4; y++) for (let z = 1; z <= 5; z++) cells.push([-1, y, z, 'stone'])
  for (let x = 4; x <= 5; x++) for (let y = 1; y <= 4; y++) for (let z = -1; z <= 3; z++) cells.push([x, y, z, 'stone'])
  for (let y = 1; y <= 3; y++) for (let z = 1; z <= 3; z++) if (y !== 1 || z !== 2) cells.push([3, y, z, 'stone'])
  cells.push([2, 1, 4, 'stone'], [3, 1, 4, 'stone'], [4, 1, 4, 'stone'], [2, 4, 2, 'stone'], [3, 4, 2, 'stone'],
    [3, 2, 4, 'stone_slab', { type: 'bottom', waterlogged: false }], [4, 2, 4, 'stone_slab', { type: 'bottom', waterlogged: false }])
  const { bot } = worldOf(cells)
  bot.physics.playerHalfWidth = Math.fround(.6) / 2
  bot.entity.position = new Vec3(.47467265494781, 1, .562079224545182); bot.entity.velocity.y = -.0784000015258789
  const { planJumpAsync }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bodyClear, supportAt }: typeof import('../src/navigation/geometry') = require('../src/navigation/geometry')
  const plan = await planJumpAsync(bot, { aborted: false }, new Vec3(2.5, 2, 4.5), { allowWalk: true, maxTicks: 38, beam: 24, planningMs: 180 })
  assert.ok(!plan || plan.states.every((s: any) => !s.onGround || s.vel.y >= 0 || supportAt(bot, s.pos, .04) || bodyClear(bot, s.pos.offset(0, s.vel.y, 0))),
    'Author36 frame5 was unsupported over lava; matching client endpoints still received native lava damage')
  const dry = worldOf(cells.map(([x, y, z, name, props]) => [x, y, z, name === 'lava' ? 'air' : name, props]))
  dry.bot.physics.playerHalfWidth = bot.physics.playerHalfWidth
  dry.bot.entity.position = bot.entity.position.clone(); dry.bot.entity.velocity.y = bot.entity.velocity.y
  const ordinary = await planJumpAsync(dry.bot, { aborted: false }, new Vec3(2.5, 2, 4.5), { allowWalk: true, maxTicks: 38, beam: 24, planningMs: 180 })
  assert.ok(ordinary, 'ordinary air overhangs retain the native contact and impulse behavior')
  assert.ok(ordinary.states.some((s: any) => s.onGround && !supportAt(dry.bot, s.pos, .04)), 'the control exercises the retained Y-before-XZ contact')
})
test('one native trajectory preserves a slime rebound and finishes on the next stable support', () => {
  const cells: Array<[number, number, number, string]> = [[0, 5, 0, 'stone'], [1, 5, 0, 'stone'], [2, 5, 0, 'stone'], [4, 0, 0, 'slime_block'], [5, 0, 0, 'slime_block'], [7, 3, 0, 'stone'], [8, 3, 0, 'stone']]
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(2.5, 6, .5); bot.entity.velocity.y = -.0784000015258789
  const { planJump, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const plan = planJump(bot, new Vec3(7.5, 4, .5), { bounce: new Vec3(4.5, 1, .5), maxTicks: 90 })
  assert.ok(plan, 'the shared native integrator must discover drop, bounce, steering and final rest')
  assert.ok(plan.states.some((state: any) => state.pos.y === 1 && state.vel.y > .3 && state.onGround), 'real slime collision must reverse falling velocity')
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 4)
  assert.ok(landed.pos.distanceTo(new Vec3(7.5, 4, .5)) < .22)
  assert.equal((require('../src/navigation/landing') as typeof import('../src/navigation/landing')).landingDamage(bot.blockAt(new Vec3(4, 0, 0)), 20), 0)
})
test('an observed diagonal spring approach tries its supported run-up before exhausting unrelated native profiles', () => {
  const { bot } = worldOf([[0, 0, 0, 'stone'], [-5, -5, -3, 'slime_block'], [-4, -5, -3, 'slime_block'], [-9, -2, -6, 'stone'], [-8, -2, -6, 'stone']])
  bot.entity.position = new Vec3(.3942147, 1, .6100089); bot.entity.velocity.y = -.0784000015258789
  const { planJump, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const diagnostics = { frames: 0, profiles: 0 }
  const target = new Vec3(-8.5, -1, -5.5)
  const plan = planJump(bot, target, { bounce: new Vec3(-4.5, -4, -2.5), maxTicks: 90, diagnostics })
  assert.ok(plan, 'the run-up remains an ordinary supported movement followed by a native slime collision')
  assert.ok(diagnostics.frames < 120, `the bounded planner must reach this profile early, got ${diagnostics.frames} native frames`)
  assert.ok(plan.states.some((state: any) => state.pos.y === -4 && state.vel.y > .3 && state.onGround))
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.ok(landed.pos.distanceTo(target) < .22)
})
test('a higher semantic approach earns the native spring velocity needed for the following lower checkpoint', () => {
  const { planJump, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const target = new Vec3(7.5, 6, .5)
  for (const height of [5, 9]) {
    const { bot } = worldOf([[0, height - 1, 0, 'stone'], [4, -1, 0, 'slime_block'], [5, -1, 0, 'slime_block'], [7, 5, 0, 'stone'], [8, 5, 0, 'stone']])
    bot.entity.position = new Vec3(.5, height, .5); bot.entity.velocity.y = -.0784000015258789
    const diagnostics: { frames: number; profiles: number; reboundCeiling?: number } = { frames: 0, profiles: 0 }
    const plan = planJump(bot, target, { bounce: new Vec3(4.5, 0, .5), maxTicks: 90, diagnostics })
    if (height === 5) {
      assert.equal(plan, null, 'going directly to the numerically lower checkpoint cannot earn this rebound')
      assert.ok((diagnostics.reboundCeiling ?? Infinity) < target.y, 'all native launch profiles must stay below the required landing')
    } else {
      assert.ok(plan, 'the preceding higher approach must make the same spring and destination reachable')
      assert.ok(plan.states.some((s: any) => s.pos.y === 0 && s.onGround && s.vel.y > .3), 'vertical speed comes from an actual native slime collision')
      const landed = simulatePlan(bot, plan.steps)
      assert.equal(landed.onGround, true); assert.equal(landed.pos.y, target.y)
      assert.ok(landed.pos.distanceTo(target) < .22)
    }
  }
})
test('a native local trajectory catches an offset ladder around a tall corner and exits on real upper support', async () => {
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 2, 'stone']]
  for (let y = 0; y <= 2; y++) cells.push([0, y, 0, 'stone'])
  for (let y = 0; y <= 3; y++) cells.push([0, y, 1, 'stone'])
  for (let y = 1; y <= 2; y++) cells.push([1, y, 0, 'ladder', { facing: 'east', waterlogged: false }])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.5, 1, 2.5); bot.entity.velocity.y = -.0784000015258789
  const { planJumpAsync, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const target = new Vec3(.5, 3, .5)
  const plan = await planJumpAsync(bot, { aborted: false }, target, { climb: new Vec3(1.5, 1, .5), maxTicks: 90, planningMs: 180 })
  assert.ok(plan, 'the shared predictor must retain native ladder contact after the corner approach')
  assert.ok(plan.states.some((s: any) => bot.blockAt(s.pos.floored()).name === 'ladder' && !s.onGround))
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 3)
  assert.ok(landed.pos.distanceTo(target) < .22)
})
test('a real exposed stair tread beside a high wall stays reachable inside the local native planning budget', async () => {
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone'], [-1, 0, 2, 'stone'], [-1, 1, 2, 'acacia_stairs', { facing: 'south', half: 'bottom', shape: 'straight', waterlogged: false }], [-1, 1, 3, 'acacia_planks']]
  for (let y = 1; y <= 3; y++) cells.push([0, y, 1, 'stone'])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.6074165, 1, .4952658); bot.entity.velocity.y = -.0784000015258789
  const { planJumpAsync, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const target = new Vec3(-.5, 1.5, 2.2)
  const plan = await planJumpAsync(bot, { aborted: false }, target, { allowWalk: true, planningMs: 180 })
  assert.ok(plan, 'an optional detour cushion cannot hide an actually clear partial support')
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 1.5)
  assert.ok(landed.pos.distanceTo(target) < .22)
})
test('exhausted native spring profiles bound only the impossible height family from that actual source support', async () => {
  const cells: Array<[number, number, number, string]> = [[0, 3, 0, 'stone'], [1, 3, 0, 'stone'], [2, 3, 0, 'stone'], [4, 0, 0, 'slime_block'], [5, 0, 0, 'slime_block'], [7, 4, 0, 'stone'], [8, 4, 0, 'stone']]
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(2.5, 4, .5); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(7.5, 5, .5); const spring = new Vec3(4.5, 1, .5)
  const { planJump }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { supportRoute, transitionKey, landingKey }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const diagnostics: import('../src/navigation/parkour').PlanningDiagnostics = { frames: 0, profiles: 0 }
  assert.equal(planJump(bot, target, { bounce: spring, maxTicks: 90, diagnostics }), null)
  assert.equal(diagnostics.why, 'rebound_ceiling', 'the unobstructed native rebound apex refuses the family, never a CPU cutoff')
  assert.equal(diagnostics.profiles, 0, 'an impossible height family enumerates no launch profiles')
  assert.ok(diagnostics.reboundCeiling < target.y && diagnostics.reboundCeiling > 4.5)
  const source = landingKey(bot.entity.position)
  const ceiling = (from: any, at: any) => landingKey(from) === source && landingKey(at) === landingKey(spring) ? diagnostics.reboundCeiling : Infinity
  const blocked = new Set([target, new Vec3(8.5, 5, .5)].map(to => transitionKey(bot.entity.position, to)))
  const bounded = await supportRoute(bot, bot.entity.position, target, blocked, 8, undefined, ceiling)
  bounded.forEach((option: any, index: number) => {
    const from = index ? bounded[index - 1].target : bot.entity.position
    if (option.bounce && landingKey(from) === landingKey(bot.entity.position) && landingKey(option.bounce) === landingKey(spring)) assert.ok(option.target.y <= diagnostics.reboundCeiling, 'the exhausted family is bounded from its actual source and spring; a changed approach earns a separate forecast')
  })
  const higher = worldOf(cells.map(([x, y, z, name]) => [x, name === 'stone' && x <= 2 ? 7 : y, z, name]))
  higher.bot.entity.position = new Vec3(2.5, 8, .5); higher.bot.entity.velocity.y = -.0784000015258789
  assert.ok(planJump(higher.bot, target, { bounce: spring, maxTicks: 90 }), 'a higher genuine approach retains its independently reachable spring edge')
})
test('native direct profiles solve ordinary rises before a route edge CPU budget expires', async () => {
  const { planJumpAsync }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 1, 0, 'stone']])
  const plan = await planJumpAsync(bot, { aborted: false }, new Vec3(2.5, 2, .5), { planningMs: 180 })
  assert.ok(plan)
  assert.ok(plan.states.every((state: { isInLava: boolean; isInWeb: boolean }) => !state.isInLava && !state.isInWeb))
})
test('a spring edge is refused when a rim between spring and landing stands above the native rebound apex', async () => {
  const { reboundApex }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const base: Array<[number, number, number, string]> = [[0, 4, 0, 'stone'], [1, 4, 0, 'stone'], [4, 0, 0, 'slime_block']]
  const probe = worldOf(base).bot
  const spring = new Vec3(4.5, 1, .5)
  const apex = Math.max(reboundApex(probe, spring, 5, false), reboundApex(probe, spring, 5, true))
  const floor = Math.floor(apex) - 2 // pit feet at floor + 1, below the apex
  assert.ok(floor + 1 > 2.25 && floor + 1 < apex)
  const pit: Array<[number, number, number, string]> = [[8, floor, 0, 'stone'], [9, floor, 0, 'stone']]
  const rim: Array<[number, number, number, string]> = Array.from({ length: Math.floor(apex) }, (_, y) => [7, y + 1, 0, 'stone'] as [number, number, number, string])
  const ceiling = (from: Vec3, at: Vec3) => Math.max(reboundApex(probe, at, from.y, false), reboundApex(probe, at, from.y, true))
  const target = new Vec3(8.5, floor + 1, .5)
  const open = worldOf([...base, ...pit]).bot; open.entity.position = new Vec3(1.5, 5, .5)
  const openRoute = await supportRoute(open, open.entity.position, target, new Set(), 10, undefined, ceiling)
  assert.ok(openRoute.some((o: any) => o.bounce), 'without the rim the spring edge stays a candidate')
  const walled = worldOf([...base, ...pit, ...rim]).bot; walled.entity.position = new Vec3(1.5, 5, .5)
  const walledRoute = await supportRoute(walled, walled.entity.position, target, new Set(), 10, undefined, ceiling)
  assert.ok(!walledRoute.some((o: any) => o.bounce && o.target.x === 8.5), 'a rim above the rebound apex cannot be cleared by that rebound')
})
test('a planned jump keeps its forecast ownership however far the server clock runs ahead of the next client frame', async () => {
  const clockModule: typeof import('../src/game-clock') = require('../src/game-clock')
  const clock = new clockModule.GameClock({ manual: true, epoch: 0 }); clockModule.activate(clock)
  const { executeJump, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { lavaFallFloor }: typeof import('../src/combat/emergency-escape') = require('../src/combat/emergency-escape')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [3, 0, 0, 'stone']])
  bot.entity.velocity.y = -.0784000015258789
  let control = { ...IDLE }; let checked: unknown = 'unchecked'
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot); clock.advanceTicks(1); bot.emit('physicsTick')
      if (checked === 'unchecked' && !bot.entity.onGround && bot.entity.velocity.y < -.1) {
        // Author49 (750 TPS): 11 server ticks passed before the next client frame
        // and the lava reflex dropped the jump into lava. 100 ticks > FORECAST_TTL_MS.
        clock.advanceTicks(100)
        bot._ndClutch = { stats: { water_saved: 0 }, forecast: { from: bot.entity.position.clone(), at: clock.now(), landing: { lava: true, top: -5 }, excluded: false, ground: false } }
        checked = lavaFallFloor(bot)
      }
      if (!bot.listenerCount('physicsTick')) break
    }
  }
  const result = await executeJump(bot, { aborted: false }, new Vec3(3.5, 1, .5), { allowWalk: true, maxTicks: 38 })
  assert.equal(result.ok, true, result.why)
  assert.equal(checked, null, 'the lava reflex must not take a verified jump while its owner still drives it')
})
test('a combat hop takes the best-scored visible local landing within a small native frame budget', async () => {
  const { combatHop }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 1, 0, 'stone'], [-2, 0, 0, 'stone']])
  bot.entity.velocity.y = -.0784000015258789
  drive(bot, world)
  const result = await combatHop(bot, { aborted: false }, { score: (target: Vec3) => target.y })
  assert.equal(result.ok, true, result.why)
  assert.equal(bot.entity.position.y, 2, 'higher ground wins the caller score')
  const none = await combatHop(bot, { aborted: false }, { score: () => -Infinity })
  assert.equal(none.why, 'no_short_hop')
})
test("a web catch requested before the first falling frame waits for the real descent above the web", async () => {
  const { catchWeb }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'cobweb'], [0, -1, 0, 'stone']])
  bot.entity.position = new Vec3(.5, 8, .5); bot.entity.velocity = new Vec3(0, 0, 0); bot.entity.onGround = false
  drive(bot, world)
  const result = await catchWeb(bot, { aborted: false }, new Vec3(.5, 0, .5))
  assert.equal(result.ok, true, result.why)
  assert.ok(bot.entity.position.y < 1 && bot.entity.position.y > 0)
})
test('a spring chain falls from one rebound onto a second slime and reaches a ledge no single spring reaches (CP25 shape)', async () => {
  const { planJump, reboundApex, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  // Tower top 7 → slime A (top 0) → slime B (top -1) → ledge 2: three above B, 8.5 from A.
  const cells: Array<[number, number, number, string]> = [[0, 6, 0, 'stone']]
  for (const z of [0, 1]) cells.push([6, -1, z, 'slime_block'], [7, -1, z, 'slime_block'], [11, -2, z, 'slime_block'], [12, -2, z, 'slime_block'])
  for (let y = -2; y <= 1; y++) for (const z of [0, 1]) cells.push([15, y, z, 'stone'], [16, y, z, 'stone'])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.5, 7, .5); bot.entity.velocity.y = -.0784000015258789
  const a = new Vec3(7.5, 0, .5); const b = new Vec3(11.5, -1, .5); const ledge = new Vec3(15.5, 2, .5)
  const plan = planJump(bot, ledge, { bounce: a, chain: [b], maxTicks: 150 })
  assert.ok(plan, 'the native integrator finds drop, two rebounds and the ledge landing')
  const contacts = plan.states.filter((s: any, i: number) => s.onGround && s.vel.y > .3 && !(plan.states[i - 1]?.onGround))
  assert.deepEqual(contacts.map((s: any) => s.pos.y), [0, -1], 'one real contact on each slime, in order')
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 2)
  const ceiling = (from: Vec3, at: Vec3) => Math.max(reboundApex(bot, at, from.y, false), reboundApex(bot, at, from.y, true))
  const route = await supportRoute(bot, bot.entity.position, ledge, new Set(), 20, undefined, ceiling)
  const edge = route.find((o: any) => o.target.y === 2 && o.bounce)
  assert.ok(edge?.chain?.length === 1, `the graph offers the chained edge: ${JSON.stringify(route.map((o: any) => [o.target, o.bounce, o.chain]))}`)
})
test('a hop over a higher slab step walks on and steps down to the lower target (CP28 roof: 165.5 → slab 166.5 → 166)', async () => {
  const { planJumpAsync, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const slab = { type: 'bottom', waterlogged: false }
  const { bot } = worldOf([[0, 0, 0, 'smooth_stone_slab', slab], [-1, 0, 0, 'smooth_stone_slab', slab], [1, 0, 0, 'stone'], [1, 1, 0, 'smooth_stone_slab', slab], [2, 0, 0, 'stone'], [3, 0, 0, 'stone']])
  bot.entity.position = new Vec3(1 - Math.fround(.6) / 2, .5, .5); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(2.5, 1, .5)
  const plan = await planJumpAsync(bot, { aborted: false }, target, { allowWalk: true, maxTicks: 38, planningMs: 180 })
  assert.ok(plan, 'the slab is only a step on the way: landing there must not end the profile, nor pin the body with sneak')
  assert.ok(plan.states.some((s: any) => s.onGround && s.pos.y === 1.5), 'the native trajectory really crosses the slab top')
  const landed = simulatePlan(bot, plan.steps)
  assert.ok(landed.onGround && landed.pos.distanceTo(target) < .22, JSON.stringify(landed.pos))
})
