import test from 'node:test'
import assert from 'node:assert/strict'
import { bruteNear } from '../src/ne-gold-first'

// ND_NE_GOLD_FIRST: руда у поста брута (где видел и где увидел впервые, ±10 по высоте) — мимо; в 12 бл. по горизонтали.
test('gold-first: ore near a remembered brute post is skipped', () => {
  const brute = { x: 36.7, y: 74, z: 22.2, assumedPatrolAnchor: { x: 36.7, y: 74, z: 22.2 } }
  assert.equal(bruteNear([brute], { x: 37, y: 70, z: 21 }, 12), true, 'b86-int2-s21: ore 1 block from the brute')
  assert.equal(bruteNear([brute], { x: 22, y: 67, z: 9 }, 12), false, 'c87-int2-s21: ore 19.6 blocks off gave boots in b86')
  assert.equal(bruteNear([brute], { x: 37, y: 50, z: 21 }, 12), false, 'far below the post')
  const moved = { x: 10, y: 74, z: 0, assumedPatrolAnchor: { x: 36.7, y: 74, z: 22.2 } }
  assert.equal(bruteNear([moved], { x: 37, y: 70, z: 21 }, 12), true, 'the first-seen post still counts')
})

// ND_NE_REFUGE_HOLE: в Аду нора выбирается, когда она быстрее коробки; без флага — прежнее «в Аду вниз не копаю».
test('refuge: nether hole under the flag', () => {
  const { chooseRefuge } = require('../src/survival/hold-out')
  const a = { nether: true, foeClose: true, hole: { depth: 3, ms: 900 }, blocks: 64, cell: null, canBreakOut: false, nearest: { name: 'piglin_brute', d: 2, etaMs: 0 } }
  const was = process.env.ND_NE_REFUGE_HOLE
  try {
    delete process.env.ND_NE_REFUGE_HOLE
    assert.equal(chooseRefuge(a).how, 'flee')
    process.env.ND_NE_REFUGE_HOLE = '1'
    assert.equal(chooseRefuge(a).how, 'hole')
    assert.equal(chooseRefuge({ ...a, shooters: 1 }).how, 'hole', 'a fast hole also under a crossbow')
    assert.equal(chooseRefuge({ ...a, shooters: 1, hole: { depth: 3, ms: 2400 } }).how, 'flee', 'a slow hole under a crossbow — no')
  } finally { if (was === undefined) delete process.env.ND_NE_REFUGE_HOLE; else process.env.ND_NE_REFUGE_HOLE = was }
})

// Посты брутов шаблона (jar: маркер jigsaw пула piglin_melee, моб — в клетке перед ним): −2642, стена конюшен wall_base r1 — брут у сундука.
test('bastion-pieces: template brute post next to the wall chest', () => {
  const bp = require('../src/bastion-pieces')
  const posts = bp.brutesOf({ piece: 'hoglin_stable/walls/wall_base', r: 1, t: { x: 48, y: 31, z: 16 } }).map(v => `${v.x},${v.y},${v.z}`)
  assert.deepEqual(posts, ['35,35,30'], 'truth of the −2642 bastion: mobs/melee_piglin at 35,35,30')
})

// ND_NE_TOOLS_SOFT: 260 взмахов — запас; ≥ 100 и кирку из принесённого не сделать — готово (без похода за стеблями).
test('nether-supply: soft tools readiness under the flag', () => {
  const { netherToolsReady } = require('../src/campaign/nether-supply')
  const st = (inv, swings) => ({ dimension: 'the_nether', health: 20, inventory: inv, pickSwings: swings })
  const worn = st({ stone_pickaxe: 2, cobblestone: 64 }, 246) // палок и досок нет — кирку не сделать
  const was = process.env.ND_NE_TOOLS_SOFT
  try {
    delete process.env.ND_NE_TOOLS_SOFT
    assert.equal(netherToolsReady(worn), false)
    process.env.ND_NE_TOOLS_SOFT = '1'
    assert.equal(netherToolsReady(worn), true, 'c94-int16-s22: 246/260, no sticks')
    assert.equal(netherToolsReady(st({ stone_pickaxe: 1, cobblestone: 64, stick: 4, crafting_table: 1 }, 246)), false, 'a pick is craftable now')
    assert.equal(netherToolsReady(st({ stone_pickaxe: 1 }, 60)), false, 'too few swings')
  } finally { if (was === undefined) delete process.env.ND_NE_TOOLS_SOFT; else process.env.ND_NE_TOOLS_SOFT = was }
})
