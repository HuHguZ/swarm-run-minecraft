import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as W from '../src/night-work'

const open = { walls: 0, roof: false, floor: true, block: 0, sky: 0, sealed: false }
const rock = { ...open, walls: 4, roof: true, sealed: true }
const key = p => `${p.x},${p.y},${p.z}`

test('dark open work costs more than its gain; light and enclosure reduce the price', () => {
  const dark = W.price({ ...open, hp: 20, night: true }, 2)
  assert.ok(dark > 2)
  assert.ok(W.price({ ...open, block: 8, hp: 20, night: true }, 2) < 2)
  assert.equal(W.price({ ...rock, hp: 20, night: true }, 2), 0)
  assert.ok(W.price({ ...open, hp: 4, night: true }, 2) > dark)
  assert.equal(W.price({ ...rock, floor: false, hp: 20 }, 2), 3600)
})

test('a visible armed walker, ranged attacker or swelling creeper is priced using the native combat estimate', () => {
  for (const f of [{ name: 'zombie', dist: 3, hit: 6, dps: 3 },
    { name: 'zombie', hand: 'iron_spear', dist: 9, hit: 6, dps: 3 },
    { name: 'skeleton', dist: 12, ranged: true, hit: 4, dps: 2 },
    { name: 'creeper', dist: 2, hit: 22, dps: 0, swelling: true }]) {
    assert.ok(W.price({ ...open, block: 14, hp: 20, fight: { order: [f] } }, 2) > 2)
    assert.ok(W.price({ ...open, block: 14, hp: 3, fight: { order: [f] } }, 2) >= 3600)
    assert.ok(W.price({ ...rock, hp: 3, fight: { order: [f] } }, 2) >= 3600, 'an enclosure does not hide a visible attacker')
  }
})

function body() {
  const world = new Map<string, string>()
  for (const x of [0, 1]) for (const y of [40, 41]) world.set(`${x},${y},0`, 'air')
  const bot: any = { health: 20, entity: { position: new Vec3(.5, 40, .5) }, entities: {},
    time: { timeOfDay: 18000 }, game: { dimension: 'overworld' },
    inventory: { items: () => [{ name: 'cobblestone', count: 16 }] },
    blockAt: p => ({ name: world.get(key(p)) || 'stone', boundingBox: world.get(key(p)) === 'air' ? 'empty' : 'block', light: 0, skyLight: 0 }) }
  return { bot, world }
}

test('after the cut, a closed leg is cheaper than a dark rear opening; an open cave can be refused', () => {
  const { bot, world } = body(), back = new Vec3(0, 40, 0), next = new Vec3(1, 40, 0)
  const plan = W.step(bot, next, back, 2, { order: [] } as any)
  assert.equal(plan.close, true)
  for (const x of [1, 2]) for (const z of [-1, 1]) for (const y of [40, 41, 42]) world.set(`${x},${y},${z}`, 'air')
  world.set('1,42,0', 'air')
  assert.match(W.step(bot, next, back, 2, { order: [] } as any).stopped, /NIGHT_RISK/)
  bot.blockAt = p => ({ name: world.get(key(p)) || 'stone', boundingBox: world.get(key(p)) === 'air' ? 'empty' : 'block', light: 14, skyLight: 0 })
  assert.equal(W.step(bot, next, back, 2, { order: [] } as any).stopped, undefined, 'lit open travel remains a priced alternative')
})

test('closing checks cancellation, actual placement and keeps the native honest controller', async () => {
  const { bot, world } = body(), B: typeof import('../src/build') = require('../src/build'), original = B.placeBlockAt
  const ctl: any = { aborted: false }, calls: any[] = []
  B.placeBlockAt = async (b, p, opts) => { calls.push({ p, opts }); world.set(key(p), 'stone'); return { ok: true } }
  try {
    assert.equal(await W.closeBehind(bot, ctl, new Vec3(0, 40, 0)), null)
    assert.equal(calls.length, 2)
    assert.ok(calls.every(c => c.opts.ctl === ctl && c.opts.honest && c.opts.steady))
    ctl.aborted = true
    assert.match(await W.closeBehind(bot, ctl, new Vec3(2, 40, 0)), /прервано/)
    assert.equal(calls.length, 2)
    ctl.aborted = false
    B.placeBlockAt = async () => ({ ok: false, reason: 'нет опоры' })
    assert.match(await W.closeBehind(bot, ctl, new Vec3(3, 40, 0)), /нет опоры/)
  } finally { B.placeBlockAt = original }
})
