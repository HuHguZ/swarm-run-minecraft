'use strict'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import path = require('node:path')
import * as vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { bodySource } from './source-fixture'
import { stubRequire } from './stub-require'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// A deliberately small physics oracle: SmallFireball 5 HP, shield activation 5 ticks,
// and three arrivals separated by 6 ticks (BlazeAttackGoal). No farm process.
async function exchange (enabled = true, haveShield = true, corner = false) {
  const file = process.env.BLAZE_TEST_FILE || path.join(__dirname, '../src/blaze.js')
  let now = 100000
  let useSince = null
  let lost = 0
  let digAt = null
  let continues = 0
  const calls = []
  const ctl = { aborted: false, onAbort: [] }
  const enemy = { id: 2, name: 'blaze', position: new Vec3(0, 64, 8), isValid: true }
  const shots = [500, 800, 1100].map((ms, id) => ({ id: id + 10, at: now + ms, from: enemy.position.clone(), done: false }))
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', health: 13, food: 20,
    entity: { id: 1, position: new Vec3(0, 64, 0), metadata: [0] }, entities: { 2: enemy },
    inventory: { items: () => [{ name: 'iron_sword', count: 1 }, { name: 'cooked_mutton', count: 8 }],
      slots: Array(46).fill(null), emptySlotCount: () => 20 },
    registry: { entitiesByName: { blaze: { metadataKeys: ['flags'] } }, blocksByName: { lava: { id: 10 } } },
    pathfinder: { movements: {}, setMovements () {}, setGoal () {} },
    clearControlStates () {}, lookAt: async () => {}, equip: async () => {},
    blockAt: p => ({ position: p, name: p.y < 64 ? 'nether_bricks' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }),
    world: { raycast: () => null }, attack: () => calls.push('attack'), testCorner: corner
  })
  if (haveShield) bot.inventory.slots[45] = { name: 'shield' }
  bot._client = new EventEmitter()
  const advance = async ms => {
    const end = now + ms
    for (const s of shots.filter(s => !s.done && s.at <= end)) {
      s.done = true
      if (!(corner && bot.entity.position.x >= 1) && !(haveShield && useSince !== null && s.at - useSince >= 250)) {
        const hit = Math.min(5, bot.health)
        lost += hit; bot.health -= hit
      }
    }
    now = end
  }
  const guard = { stats: { worn: haveShield, blocked: 0 }, wear: async () => haveShield,
    raise: async on => { calls.push(on ? 'raise' : 'lower'); if (on && haveShield && useSince === null) useSince = now; if (!on) useSince = null; return haveShield },
    blocking: () => haveShield && useSince !== null && now - useSince >= 250,
    close () {}, report: () => ({}) }
  const radar: any = { untilDanger: () => Infinity, charged: () => false, stop () {}, stats: {},
    incoming: () => shots.filter(s => !s.done && !(corner && bot.entity.position.x >= 1)).map(s => ({ from: s.from, eta: s.at - now, id: s.id })) }
  // Заглушки по spec (stubRequire сверяет и разрешённый путь: части blaze/hold/* просят '../../combat'); unmatched() —
  // заглушки, которые ни разу не сработали.
  const req = stubRequire(file, {
    './combat': { makeShield: () => guard, shieldUp: () => useSince !== null,
      retreat: async () => ({ ok: false }) },
    './walkable': { walkable: () => [], standable: () => true },
    './sight': { seesBlock: () => corner },
    './sealed': { stepMove: async (_b, _c, step) => { calls.push('corner'); bot.entity.position = step.to.offset(0.5, 0, 0.5); return { ok: true } } },
    './flee': { hostilesAround: () => [{ e: enemy }], smartFlee: async () => ({}) }
  }, {
    './game-clock': actual => ({ ...actual, now: () => now }),
    './movement': actual => ({ ...actual, sleep: advance }),
    './combat-safety': actual => ({ ...actual, recover: async () => { calls.push('recover'); ctl.aborted = true; return { rested: true } }, watch: () => ({ close () {}, check: ({ phase }) => ({
      action: phase === 'start' || continues++ === 0 ? 'fight' : 'recover', reason: 'heal', healable: true
    }) }) })
  })
  const context: any = { module: { exports: {} }, console: { log () {} }, Date, setTimeout, clearTimeout,
    process: { env: { ND_BLAZE_WORLD_STATE: enabled ? '1' : '0', ND_GUARD: '0', ND_NE_ROUTE: '0' } }, bot, calls, radar,
    require: req,
    testDig: async () => { digAt = now; await advance(1200); ctl.aborted = true; return { ok: false } }
  }
  vm.runInNewContext(bodySource(file) + `
    makeRadar = () => radar; fightMoves = () => ({}); liveBlazes = () => [bot.entities[2]];
    losClear = (_b, _a, b) => bot.testLineOfSight !== false && !(bot.testCorner && b.x >= 1.4);
    digInNear = testDig; witherClose = () => null;
    module.exports.testHold = holdSpawner;
    module.exports.testShieldPrice = typeof blazeShieldPrice === 'function' ? blazeShieldPrice : null;
  `, cjsContext(context))
  await context.module.exports.testHold({ bot }, ctl, { spawner: null, want: 7, deadline: now + 10000,
    dead: new Set(), setPhase: p => calls.push(p), restAt: 12, bailAt: 6, p: { box: false }, t0: now })
  // './sealed' (stepMove) is reached only on the corner path; the corner test checks it through calls.
  assert.deepEqual(req.unmatched().filter(k => k !== './sealed'), [], 'every stub reaches the decomposed spawner loop')
  if (corner) assert.ok(calls.includes('recover'), calls.join(','))
  else assert.ok(digAt !== null, 'the skill still attempts recovery')
  return { lost, digAt, calls, helper: context.module.exports.testShieldPrice, bot, enemy, radar, guard }
}

test('a heal request preserves the shield until the actual three fireballs have passed', async () => {
  const x = await exchange()
  assert.equal(x.lost, 0, x.calls.join(','))
  assert.ok(x.digAt >= 101100, 'dig only after the last projectile')
})

test('ND_BLAZE_WORLD_STATE=0 reproduces the old open recovery', async () => {
  const x = await exchange(false)
  assert.equal(x.lost, 13)
  assert.ok(x.digAt < 101100)
})

test('absence of a shield is a cost, not a loop waiting for an impossible block', async () => {
  const x = await exchange(true, false)
  assert.ok(x.digAt < 101100)
})

test('a visible supported neighbour that closes both rays and projectile paths is used before healing', async () => {
  const x = await exchange(true, true, true)
  assert.ok(x.calls.includes('corner'))
  assert.ok(x.calls.indexOf('corner') < x.calls.indexOf('recover'))
  assert.equal(x.digAt, null, 'a corner does not need a three-block pit')
  assert.equal(x.lost, 0)
})

test('shield price follows rays, horizontal hemisphere, activation ticks, fire and melee under FR', async () => {
  const { helper, bot, enemy, radar, guard } = await exchange()
  assert.equal(typeof helper, 'function')
  bot.entity.metadata[0] = 0
  guard.blocking = () => true
  radar.incoming = () => []
  radar.untilDanger = () => 0
  const face = new Vec3(0, 65.62, 8)
  assert.equal(helper(bot, [enemy], radar, guard, false, face).cost, 0)
  bot.inventory.slots[45] = null
  assert.equal(helper(bot, [enemy], radar, guard, false, face).cost, 5)
  bot.testLineOfSight = false
  assert.equal(helper(bot, [enemy], radar, guard, false, face).cost, 0, 'a blaze behind cover cannot add a shot')
  bot.inventory.slots[45] = { name: 'shield' }
  radar.incoming = () => [{ from: new Vec3(0, 65, -8), eta: 100 }]
  assert.equal(helper(bot, [], radar, guard, false, face).cost, 5, 'the back remains exposed')
  radar.incoming = () => [{ from: face, eta: 249 }]
  guard.blocking = () => false
  assert.equal(helper(bot, [], radar, guard, false, face).cost, 5)
  radar.incoming = () => [{ from: face, eta: 250 }]
  assert.equal(helper(bot, [], radar, guard, false, face).cost, 0)
  bot.entity.metadata[0] = 1
  assert.equal(helper(bot, [], radar, guard, false, face).cost, 5, 'a shield does not extinguish an existing burn')
  bot.testLineOfSight = true
  bot.inventory.slots[45] = null
  enemy.position.z = 1.9
  assert.equal(helper(bot, [enemy], radar, guard, true, face).cost, 6, 'FR removes fire but not melee')
})
