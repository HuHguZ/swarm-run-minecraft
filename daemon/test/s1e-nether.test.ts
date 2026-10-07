import test from 'node:test'
import assert from 'node:assert/strict'

// S1e (раунд 4, Ад): замечания проверяющего S1d и добор жемчуга эндерменами.

test('s1e: digInNear finds a neighbour cell for the depth-2 pit on a thin platform (no depth-3 floor anywhere)', async () => {
  const Vec3 = require('vec3')
  const sealed = require('../src/sealed')
  const { digInNear } = require('../src/blaze')
  const air = new Set<string>()
  const k = (v: any) => `${v.x},${v.y},${v.z}`
  // Мост над пустотой: под ногами (0,63,0) воздух; рядом помост x 1..4, z −2..2, толщиной 3 (y 61..63) — яма 3 не помещается.
  const solid = (v: any) => !air.has(k(v)) && v.y < 64 && v.y >= 61 && v.x >= 1 && v.x <= 4 && v.z >= -2 && v.z <= 2
  const block = (v: any) => solid(v) ? { name: 'nether_bricks', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  const bot: any = {
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
    blockAt: (v: any) => block(v.floored ? v.floored() : v),
    pathfinder: { goto: async (g: any) => { bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5) }, setGoal () {} }
  }
  const dig0 = sealed.digCell; const fill0 = sealed.fillCell
  sealed.digCell = async (_b: any, c: any) => { air.add(k(c)); bot.entity.position = new Vec3(c.x + 0.5, c.y, c.z + 0.5); return 'ok' }
  sealed.fillCell = async () => true
  try {
    const r = await digInNear(bot, { aborted: false, onAbort: [] })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.depth, 2)
    assert.deepEqual(r.moved, { x: 2, y: 64, z: 0 })
  } finally { sealed.digCell = dig0; sealed.fillCell = fill0 }
})

test('s1e: targets at a copy brute home go last (taken at hp ≥ 16 when nothing else is left), not never', () => {
  const { targetsByBruteHome } = require('../src/bastion/bastion')
  const brutes = [[10, 40, 10]]
  const at = (x: number) => ({ pos: { x, y: 40, z: 10 } })
  const pos = (t: any) => t.pos
  assert.deepEqual(targetsByBruteHome([at(12), at(40)], pos, brutes, 20).map((t: any) => t.pos.x), [40], 'other targets first')
  // S1f: решение — цена от брони (bruteHomeTake); железо + золотые ботинки, как в наборе std.
  const iron = require('../src/assess').gearOf(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots'].map(name => ({ name })))
  assert.deepEqual(targetsByBruteHome([at(12)], pos, brutes, 20, iron).map((t: any) => t.pos.x), [12], 'only the brute-home target left, full hp — taken (old rule: never)')
  assert.deepEqual(targetsByBruteHome([at(12)], pos, brutes, 12, iron), [], 'low hp — kept for later')
})

test('s1e: the walk to traders is priced by the brutes that can reach us or stand by the trader, not by any brute in 16', () => {
  const { bruteWalkRisk } = require('../src/bastion/bastion')
  const b = (id: number) => ({ id })
  const behindWall = bruteWalkRisk([b(1)], { threatens: () => false, nearTrader: () => false, hit: 9, hp: 20 })
  assert.equal(behindWall.go, true, 'a brute behind the wall that cannot reach us — trade (old: hunker and end the trip)')
  const seen = bruteWalkRisk([b(1)], { threatens: () => true, nearTrader: () => false, hit: 9, hp: 20 })
  assert.equal(seen.go, false, 'a brute that sees us: ~18 damage on the walk at 20 hp — hunker')
  assert.equal(bruteWalkRisk([b(1)], { threatens: () => false, nearTrader: () => true, hit: 4, hp: 20 }).go, true, 'diamond-like armor: 2 blows of 4 — walk')
})

test('s1e: the enderman hunt owns its fight with endermen (tactics below level 3 does not cut it), not with other mobs', () => {
  const { EventEmitter } = require('node:events')
  const { observeTactics } = require('../src/tactics/minecraft')
  const gameClock = require('../src/game-clock')
  const Vec3 = require('vec3')
  const session = (current: string | null, foe: string) => {
    const bot: any = new EventEmitter()
    bot.version = '1.21.11'; bot.health = 20; bot.food = 20
    bot.inventory = { slots: [], items: () => [{ name: 'iron_sword', count: 1 }] }
    bot.registry = { foodsByName: {}, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
    bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [], yaw: 0, pitch: 0 }
    bot.entities = { 5: { id: 5, name: foe, type: 'hostile', position: new Vec3(2.5, 64, .5), height: foe === 'enderman' ? 2.9 : 1.95, width: 0.6, metadata: [], isValid: true, equipment: [] } }
    bot.game = { dimension: 'the_nether', gameMode: 'survival' }
    bot.blockAt = (p: any) => ({ name: p.y < 64 ? 'netherrack' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
    return { bot, current: current ? { name: current, params: { style: 'foxhole' } } : null, reflex: null, bus: { emit: () => {} }, tempo: null,
      autopilot: { lastHurt: { at: gameClock.now(), sourceId: 5, byMob: true, type: 'mob_attack', dimension: 'the_nether' } } }
  }
  const s = observeTactics(session('pearls', 'enderman'))
  assert.equal(s.protectedEncounter, true, JSON.stringify(s.enemies || null))
  const bare: any = session('pearls', 'enderman'); bare.current.params = {}
  assert.equal(observeTactics(bare).protectedEncounter, false, 'a hunt without a style (the boat encounter keeps its own guard) is not covered')
  assert.equal(observeTactics(session('pearls', 'zombified_piglin')).protectedEncounter, false)
  assert.equal(observeTactics(session('mine', 'enderman')).protectedEncounter, false)
})

test('s1e: the warped forest is remembered from visible nylium (sight), the best sighting wins, a map record is left alone', () => {
  const Vec3 = require('vec3')
  const F = require('../src/nether-forest')
  const st: any = { places: {} }
  const session: any = { journal: { state: st, patch: (fn: any) => fn(st) } }
  const seen = [new Vec3(10, 40, 10), new Vec3(11, 40, 10), new Vec3(12, 41, 11), new Vec3(30, 40, 30), new Vec3(10, 40, 12), new Vec3(11, 40, 11), new Vec3(12, 40, 12)]
  const s = F.spot(seen)
  assert.equal(s.seen, 7)
  assert.equal(s.y, 41, 'stand on the nylium (block + 1)')
  assert.equal(F.remember(session, s, 'nether_wastes'), true)
  assert.equal(st.places[F.PLACE].by, 'sight')
  assert.equal(F.remember(session, F.spot(seen.slice(0, 6)), null), false, 'a smaller sighting does not replace the best one')
  assert.equal(F.remember(session, F.spot(seen.slice(0, 6)), 'warped_forest'), true, 'standing in the forest (F3 biome) adds to the score')
  assert.equal(F.remember(session, F.spot(seen.slice(0, 3)), null), false, 'three blocks are not a forest')
  const far = seen.map((v: any) => v.offset(200, 0, 0))
  assert.equal(F.remember(session, F.spot(far), null), true, 'another forest 200 bl. away is kept too')
  assert.equal(st.places[F.PLACE].x < 100, true, 'the best (F3) stays the main record')
  assert.equal(st.places[F.PLACE].alts.length, 1)
  assert.equal(st.places[F.PLACE].alts[0].x > 200, true)
  st.places[F.PLACE] = { x: 0, y: 70, z: 0, note: 'по карте копии мира' }
  assert.equal(F.remember(session, s, 'warped_forest'), false, 'map record (separate line) untouched')
})

test('s1e: no stems in reach — the Nether supply walks to the stems seen on the way instead of a 45 s look-around', async () => {
  const { replenishNetherTools } = require('../src/campaign/nether-supply')
  const state: any = { dimension: 'the_nether', health: 20, inventory: { iron_ingot: 4, blackstone: 12 }, pickSwings: 0, woodAt: { x: 90, y: 40, z: -10 } }
  const acts: any[] = []
  let now = 0
  let near = false
  const port = { observe: async () => state, now: () => now, interrupted: () => false, log () {},
    async act (method: string, params: any) {
      now += 30000; acts.push([method, params])
      if (method === 'goto') near = true
      if (method === 'mine' && params.block !== 'crafting_table' && near) state.inventory.warped_stem = 4
    },
    async craft (item: string, count: number) {
      if (item === 'warped_planks') { state.inventory.warped_stem = 0; state.inventory.warped_planks = count; return true }
      return false
    } }
  await replenishNetherTools(port)
  const go = acts.find(([m]) => m === 'goto')
  assert.ok(go, acts.map(([m]) => m).join(','))
  assert.deepEqual([go[1].x, go[1].z], [90, -10])
  assert.equal(acts.some(([m, p]) => m === 'explore' && /stem/.test(p.block)), false)
})

test('s1e: a lying pearl is walked to by horizontal proximity (GoalNearXZ 1), not into its own cell (roof of the foxhole)', async () => {
  const Vec3 = require('vec3')
  const { walkTo } = require('../src/pearls')
  const goalsSeen: any[] = []
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, pathfinder: { goto: async (g: any) => { goalsSeen.push(g) }, setGoal () {} } }
  const r = await walkTo(bot, { aborted: false, onAbort: [] }, new Vec3(3.4, 66.1, 0.6), 1, 2000, null, true)
  assert.equal(r.ok, true)
  assert.equal(goalsSeen[0].constructor.name, 'GoalNearXZ')
  assert.equal(goalsSeen[0].rangeSq, 1)
})

test('s1e: the spot where the eyes saw the most endermen at once is remembered, and the hunt goes there first', () => {
  const Vec3 = require('vec3')
  const F = require('../src/nether-forest')
  const st: any = { places: {} }
  const em = (id: number, x: number) => ({ id, name: 'enderman', position: new Vec3(x, 64, 0), isValid: true })
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8 }, entities: { 1: em(1, 10), 2: em(2, 20), 3: em(3, 30) }, world: { raycast: () => null } }
  const session: any = { bot, journal: { state: st, patch: (fn: any) => fn(st) } }
  assert.equal(F.noteEndermen(session), true)
  assert.equal(st.places[F.EM_PLACE].count, 3)
  bot.entities = { 1: em(1, 10), 2: em(2, 20) }
  bot.entity.position = new Vec3(40.5, 64, 0.5)
  assert.equal(F.noteEndermen(session), false, 'fewer elsewhere — the record stays')
  bot.entities = { 1: em(1, 10) }
  assert.equal(F.noteEndermen(session), false, 'one is not a herd')
})

test('s1e: a bastion seen from afar is recognised by the wall template (predictGold from bastion/predict-gold, not the ./bastion shim)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/fortress.js'), 'utf8')
  assert.ok(/require\(["']\.\/bastion\/predict-gold["']\)\.predictGold/.test(src))
  assert.equal(typeof require('../src/bastion/predict-gold').predictGold, 'function')
  assert.equal(typeof require('../src/bastion').predictGold, 'undefined', 'the shim does not export it — the old call threw every run')
})

test('s1e: the blaze post prefers a cell where the rest pit can be dug (thin fortress platform vs solid floor)', () => {
  const Vec3 = require('vec3')
  const { choosePost } = require('../src/blaze')
  // Спавнер 0,64,0; пол y 63. С запада (x < 0) под полом толща до y 59 — яма 3 помещается; с востока (x > 0) пол в 1 блок над пустотой.
  const solid = (v: any) => v.y <= 63 && v.y >= (v.x < 0 ? 59 : 63) && Math.abs(v.x) <= 8 && Math.abs(v.z) <= 8 && !(v.x === 0 && v.y === 64 && v.z === 0)
  const block = (v: any) => (v.x === 0 && v.y === 64 && v.z === 0) ? { name: 'spawner', boundingBox: 'block' } : solid(v) ? { name: 'nether_bricks', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  const bot: any = { entity: { position: new Vec3(4.5, 64, 3.5) }, registry: { blocksByName: { lava: { id: 99 } } }, blockAt: (v: any) => block(v.floored ? v.floored() : v), world: { raycast: () => null } }
  const best = choosePost(bot, new Vec3(0, 64, 0))
  assert.ok(best, 'a post')
  assert.ok(best.pos.x < 0, JSON.stringify(best))
  assert.equal(best.pit, 2)
})
