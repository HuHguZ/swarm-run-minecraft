import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyWorld, fact } from '../src/core/world-state'
import { speedrunRegistry } from '../src/core/speedrun'

test('s1d: after the Nether (eyes in hand) the graph builds no new portal and digs no diamonds', () => {
  const registry = speedrunRegistry({ eyes: 12 })
  const world = emptyWorld()
  world.resources = { stone_tool: 1, bucket: 1, lighter: 1, water: 1, food: 6, iron: 3, eyes: 12 }
  world.facts.lava = fact(true, 'map', 0)
  for (const id of ['LavaPoolPortal', 'AcquireDiamondPick', 'ScoutLava']) assert.equal(registry.get(id)!.preconditions(world), false, id)
  world.resources.eyes = 4
  assert.equal(registry.get('LavaPoolPortal')!.preconditions(world), true, 'before the Nether the cast portal stays an option')
  assert.equal(registry.get('AcquireDiamondPick')!.preconditions(world), true)
})

test('s1d: KillDragon priced by the S5c farm series (200 s, success 0.8, risk 0.12)', () => {
  const kill = speedrunRegistry().get('KillDragon')!
  const end = emptyWorld(); end.dimension = 'the_end'; end.health = 20
  assert.equal(kill.estimateCost(end), 200 * 20)
  assert.equal(kill.successChance!(end), 0.8)
  assert.ok(Math.abs(kill.estimateRisk(end) - 0.12) < 1e-9)
})

test('s1d: the bastion approach aims at gold away from the copy brute homes (4120… treasure entrance deaths)', () => {
  const { approachGold } = require('../src/bastion/bastion')
  const room = [{ x: 17, y: 36, z: -123 }, { x: 18, y: 37, z: -124 }, { x: 20, y: 36, z: -126 }]
  const wall = [{ x: 21, y: 69, z: -148 }, { x: 16, y: 70, z: -148 }]
  const brutes = [[18, 41, -115]]
  assert.deepEqual(approachGold([...room, ...wall], brutes), wall)
  assert.deepEqual(approachGold(room, brutes), room, 'no safe gold — the old choice stays')
  assert.deepEqual(approachGold(room, []), room)
})

test('s1d: gold that opens the sealed tunnel is broken and patched when the drop stays inside (not only 1×1 windows)', () => {
  const { goldWindowOk } = require('../src/bastion/bastion')
  assert.equal(goldWindowOk({ win1: true, dropSafe: false, strong: 0, hp: 20 }, {}), true)
  assert.equal(goldWindowOk({ win1: false, dropSafe: true, strong: 0, hp: 20 }, {}), true, 'floor gold with air above')
  assert.equal(goldWindowOk({ win1: false, dropSafe: false, strong: 0, hp: 20 }, {}), false, 'drop would fall into the yard')
  assert.equal(goldWindowOk({ win1: false, dropSafe: true, strong: 1, hp: 20 }, {}), false, 'brute or hoglin in 12')
  assert.equal(goldWindowOk({ win1: true, dropSafe: true, strong: 0, hp: 15 }, {}), false)
  assert.equal(goldWindowOk({ win1: false, dropSafe: true, strong: 0, hp: 20 }, { ND_GOLD_OPEN: '0' }), false, 'switch restores the 1×1 rule')
  assert.equal(goldWindowOk({ win1: false, dropSafe: true, strong: 1, strongG: 0, hp: 20 }, {}), true, 'brute in 12 of the body but not in 8 of the gold')
  assert.equal(goldWindowOk({ win1: false, dropSafe: true, strong: 0, onTop: true, hp: 20 }, {}), false, 'a mob on the gold would fall into the hole')
})

test('s1d: a lit portal far from the remembered own portal is foreign (7777… loop through another portal)', () => {
  const Vec3 = require('vec3')
  const { notForeign } = require('../src/nether')
  const own = new Vec3(-6, 92, -9)
  assert.equal(notForeign({ cells: [new Vec3(-5, 92, -10), new Vec3(-5, 93, -10)] }, own), true)
  assert.equal(notForeign({ cells: [new Vec3(-70, 63, 6), new Vec3(-70, 64, 6)] }, own), false)
})

test('s1d: the pit dump keeps stone for stone pickaxes ahead of netherrack (128 fill)', () => {
  const PG = require('../src/bastion/predict-gold')
  const items = [['netherrack', 64], ['netherrack', 64], ['netherrack', 64], ['cobbled_deepslate', 64], ['cobblestone', 46]]
    .map(([name, count], slot) => ({ name, count, slot }))
  const bot = { registry: { foodsByName: {} }, inventory: { items: () => items.slice() } }
  const out = PG.pitJunk(bot).map(i => i.name)
  assert.ok(!out.includes('cobblestone') && !out.includes('cobbled_deepslate'), out.join(','))
  assert.equal(out.filter(n => n === 'netherrack').length, 2, 'stone 110 + one netherrack stack fill the 128 keep')
})

test('s1d: barter pits keep away from copy brute homes (12, else 8)', () => {
  const { pitsAwayFromBrutes } = require('../src/bastion/bastion')
  const pit = (x, y, z) => ({ P: { x, y, z } })
  const brutes = [[85, 58, -88]]
  assert.deepEqual(pitsAwayFromBrutes([pit(92, 59, -87), pit(60, 42, -94)], brutes).map(b => b.P.x), [60])
  assert.deepEqual(pitsAwayFromBrutes([pit(92, 59, -87), pit(95, 59, -87)], brutes).map(b => b.P.x), [95], 'all within 12 — at least 8 away')
})

test('s1d: the blaze rest pit is 3 deep so its cap (above the head) always has wall faces to be placed against', async () => {
  const Vec3 = require('vec3')
  const sealed = require('../src/sealed')
  const { digInPlace } = require('../src/blaze')
  const air = new Set<string>()
  const k = (v: any) => `${v.x},${v.y},${v.z}`
  const block = (v: any) => (v.y >= 64 || air.has(k(v))) ? { name: 'air', boundingBox: 'empty' } : { name: 'netherrack', boundingBox: 'block' }
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), onGround: true }, blockAt: (v: any) => block(v.floored ? v.floored() : v) }
  const caps: string[] = []
  const dig0 = sealed.digCell; const fill0 = sealed.fillCell
  sealed.digCell = async (_b: any, c: any) => { air.add(k(c)); bot.entity.position = new Vec3(0.5, c.y, 0.5); return 'ok' }
  sealed.fillCell = async (_b: any, c: any) => { caps.push(k(c)); return true }
  try {
    const r = await digInPlace(bot, { aborted: false })
    assert.equal(r.ok, true)
    assert.equal(r.depth, 3)
    assert.deepEqual(caps, ['0,63,0'], 'cap in f−1: its four neighbours are pit walls')
  } finally { sealed.digCell = dig0; sealed.fillCell = fill0 }
})

test('s1d: a pick swing is priced by the pick stock in the Nether route plan', () => {
  const NR = require('../src/nether-route')
  const bag = (items: any[]) => ({ inventory: { items: () => items }, registry: { itemsByName: { iron_pickaxe: { maxDurability: 250 }, stone_pickaxe: { maxDurability: 131 } } } })
  const kit = bag([{ name: 'iron_pickaxe', count: 1, durabilityUsed: 0 }, { name: 'stone_pickaxe', count: 1, durabilityUsed: 31 },
    { name: 'oak_planks', count: 16 }, { name: 'oak_log', count: 4 }, { name: 'stick', count: 8 }, { name: 'cobblestone', count: 64 }])
  assert.equal(NR.swingsLeft(kit), 250 + 100 + 21 * 131)
  assert.ok(NR.swingPrice(kit) < 0.01, 'full kit — digging stays cheap')
  const low = bag([{ name: 'stone_pickaxe', count: 1, durabilityUsed: 31 }, { name: 'stick', count: 1 }])
  assert.ok(NR.swingPrice(low) > 0.8, 'last pick — a dug cell costs more than an exposed step')
})
