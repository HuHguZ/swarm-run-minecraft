import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { liveBlazes, sweepRisk } from '../src/blaze'
import { cooldownMs } from '../src/pvp'
import * as BF from '../src/barter-flow'

// s1c 06.10: ифрит, которого знает игрок, — видимый лучом или слышимый (16 бл.); сквозь стену дальше 16 — нет.
function botWith (entities: any[], wall: boolean) {
  const bot: any = { entity: { position: new Vec3(0, 64, 0), height: 1.8, eyeHeight: 1.62 }, entities: {} }
  entities.forEach((e, i) => { bot.entities[i + 2] = { id: i + 2, isValid: true, height: 1.8, ...e } })
  bot.world = { raycast: (from: any) => wall ? { position: from.offset(1, 0, 0) } : null }
  return bot
}
test('liveBlazes: behind a wall only the heard ones (≤16 blocks); in sight all in radius', () => {
  const blazes = [{ name: 'blaze', position: new Vec3(10, 64, 0) }, { name: 'blaze', position: new Vec3(24, 64, 0) }]
  assert.deepEqual(liveBlazes(botWith(blazes, true), new Set(), 32).map((e: any) => e.position.x), [10])
  assert.deepEqual(liveBlazes(botWith(blazes, false), new Set(), 32).map((e: any) => e.position.x), [10, 24])
})
test('sweepRisk counts only a neutral the player can see next to the target', () => {
  const pair = [{ name: 'blaze', position: new Vec3(2, 64, 0) }, { name: 'zombified_piglin', position: new Vec3(2.5, 64, 0.5) }]
  const seen = botWith(pair, false), hidden = botWith(pair, true)
  assert.equal(sweepRisk(seen, seen.entities[2]), true)
  assert.equal(sweepRisk(hidden, hidden.entities[2]), false)
})
test('melee cadence follows the held item: pickaxe 1.2/s is slower than sword 1.6/s (attack_speed 1.21.11)', () => {
  assert.ok(cooldownMs({ name: 'iron_pickaxe' }) > cooldownMs({ name: 'iron_sword' }))
  assert.equal(cooldownMs({ name: 'iron_pickaxe' }) - cooldownMs({ name: 'iron_sword' }), 833 - 625)
})
test('bastion batch contract: with mapped gold the barter model mines a whole-block batch; no gold here — no mining', () => {
  const mine = BF.plan({ pearls: 0, required: 12, gold: 0, siteIngots: 153, fireRes: { have: 0, want: 3, valueSeconds: 120 } })
  assert.equal(mine.action, 'mine')
  assert.ok(mine.batch >= 9 && mine.batch <= 153 && mine.batch % 9 === 0, `batch ${mine.batch}`)
  assert.match(mine.line, /бартер-модель: mine/)
  assert.notEqual(BF.plan({ pearls: 0, required: 12, gold: 0, siteIngots: 0 }).action, 'mine')
  // Pearls held: fire resistance alone does not pay for mining (0.034 FR per ingot × 120 s < trade 2.4 s + mine 2.5 s).
  assert.notEqual(BF.plan({ pearls: 12, required: 12, gold: 0, siteIngots: 153, fireRes: { have: 0, want: 3, valueSeconds: 120 } }).action, 'mine')
})

test('wither skeleton: the route fights it from a 2-deep pit (its attack box is inflated only sideways), then climbs out', async () => {
  const Module: any = require('node:module')
  const realLoad = Module._load
  const dug: string[] = []
  let climbed = 0
  Module._load = function (request: string, parent: any, isMain: boolean) {
    // pitFight — в nether-route/fight.ts: ленивые require там — '../sealed', '../build', '../pick'.
    if (request === './sealed' || request === '../sealed') return { digCell: async (_b: any, c: any) => { dug.push(`${c.x},${c.y},${c.z}`); bot.entity.position = bot.entity.position.offset(0, -1, 0); return 'ok' } }
    if (request === './build' || request === '../build') return { towerUp: async () => { climbed++; return { ok: true } } }
    if (request === './pick' || request === '../pick') return { canHit: () => true }
    return realLoad.apply(this, arguments as any)
  }
  const foe: any = { id: 7, name: 'wither_skeleton', isValid: true, position: new Vec3(1.5, 64, 0.5) }
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), onGround: true }, health: 20, entities: { 7: foe },
    inventory: { items: () => [{ name: 'iron_sword' }] }, heldItem: { name: 'iron_sword' }, equip: async () => {},
    lookAt: async () => {}, attack: () => { foe.isValid = false },
    blockAt: (p: any) => ({ name: 'nether_bricks', boundingBox: 'block' }) }
  try {
    delete require.cache[require.resolve('../src/nether-route')]
    const NR: typeof import('../src/nether-route') = require('../src/nether-route')
    const st: any = {}
    assert.equal(await NR.pitFight({ bot }, { aborted: false }, st, foe), true)
    assert.deepEqual(dug, ['0,63,0', '0,62,0'])
    assert.equal(foe.isValid, false, 'struck from the pit')
    assert.equal(climbed, 1)
    // Lava next to the pit cells: no pit, the old fight goes on.
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    bot.blockAt = (p: any) => ({ name: p.x === 1 && p.y === 63 ? 'lava' : 'nether_bricks', boundingBox: p.x === 1 && p.y === 63 ? 'empty' : 'block' })
    assert.equal(await NR.pitFight({ bot }, { aborted: false }, {}, { ...foe, isValid: true }), false)
    // Air beside the pit (platform edge): open to a strike from the side — no pit (s1c-M-2).
    bot.blockAt = (p: any) => ({ name: p.x === 1 && p.y === 62 ? 'air' : 'nether_bricks', boundingBox: p.x === 1 && p.y === 62 ? 'empty' : 'block' })
    assert.equal(await NR.pitFight({ bot }, { aborted: false }, {}, { ...foe, isValid: true }), false)
  } finally { Module._load = realLoad; delete require.cache[require.resolve('../src/nether-route')] }
})
