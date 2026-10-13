'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')
const filename = path.resolve(__dirname, '../src/fauna.js')
const code = require('esbuild').transformSync(fs.readFileSync(filename.replace(/\.js$/, '.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code
const ctx = { module: { exports: {} as Record<string, any> }, require: createRequire(filename), process, console }
vm.runInNewContext(code + '\nmodule.exports.floorNear = golemTopNear; module.exports.spotNear = golemSpotNear', ctx)

function floorFixture (dx: number, dz: number) {
  const bot = { blockAt: p => ({ boundingBox: p.y <= 63 || p.x === dx && p.z === dz && p.y === 64 ? 'block' : 'empty' }) }
  return { bot, base: new Vec3(0, 64, 0) }
}

for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [3, 3]]) {
  test(`golem perch includes a third-cell support ${dx},${dz} within the native attack box`, () => {
    // Mob1.21.11: horizontal-only inflation sqrt(2.04)-0.6. Iron golem width1.4; player width0.6.
    const reach = Math.sqrt(Math.fround(2.04)) - Math.fround(.6)
    const half = Math.fround(1.4) / 2
    const center = 1.825
    assert.ok(center < half + reach + Math.fround(.6) / 2, 'native attack box overlaps the player')
    assert.ok(center + half > 2.5, 'golem feet overlap the third cell from the centered pillar')
    const f = floorFixture(dx, dz)
    assert.equal(ctx.module.exports.floorNear(f.bot, f.base), 65, 'raised reachable support contributes to the safe perch height')
  })
}

test('a fourth-cell rise remains outside the native golem melee and footing overlap', () => {
  const f = floorFixture(4, 0)
  assert.equal(ctx.module.exports.floorNear(f.bot, f.base), 64)
})

test('an overhead solid block does not become a golem standing floor', () => {
  const f = floorFixture(3, 0)
  const baseRead = f.bot.blockAt
  f.bot.blockAt = p => p.x === 3 && p.z === 0 && p.y >= 65 ? { boundingBox: 'block' } : baseRead(p)
  assert.equal(ctx.module.exports.floorNear(f.bot, f.base), 64)
})

function villageRoofFixture (stairs = false) {
  const solid = p => stairs
    ? p.y <= 63 || p.x === 1 && p.y === 64 && Math.abs(p.z) <= 2 || p.x === 2 && p.y <= 65 && Math.abs(p.z) <= 2
    : p.y <= 63 || p.x >= 2 && p.x <= 5 && Math.abs(p.z) <= 2 && p.y <= 67
  const bot = { entity: { position: new Vec3(.5, 64, .5) }, world: { raycast: () => null },
    blockAt: p => ({ name: solid(p) ? 'stone' : 'air', boundingBox: solid(p) ? 'block' : 'empty' }) }
  return { bot, base: new Vec3(0, 64, 0), golem: { name: 'iron_golem', width: 1.4, height: 2.7, position: new Vec3(-2.5, 64, .5) } }
}

test('a village roof four blocks above the street without a step route does not force a seven-block pillar', () => {
  const f = villageRoofFixture()
  assert.equal(ctx.module.exports.floorNear(f.bot, f.base), 68, 'the roof remains in the geometric scan')
  assert.equal(ctx.module.exports.floorNear(f.bot, f.base, f.golem), 64, 'a supported three-block pillar is unreachable to this walking golem')
})

test('a real two-step rise remains a threat to a three-block golem pillar', () => {
  const f = villageRoofFixture(true)
  assert.equal(ctx.module.exports.floorNear(f.bot, f.base, f.golem), 66)
})

test('the wide golem can use the edge of a raised third-cell support after one real step', () => {
  const f = villageRoofFixture()
  f.golem.position = new Vec3(4.5, 65, .5)
  f.bot.blockAt = p => {
    const solid = p.y <= 63 || p.x === 4 && p.y <= 64 || p.x === 3 && p.y <= 65
    return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty' }
  }
  assert.equal(ctx.module.exports.floorNear(f.bot, f.base, f.golem), 66, 'cell-center reach must retain the native wide-footing fringe')
})

test('a blocked village perch returns without six repeated waits for the same neutral golem', async () => {
  const { EventEmitter } = require('node:events')
  const { withClockFixture } = require('./clock-fixture')
  const local = createRequire(filename), bot = new EventEmitter()
  let time = 1000, waited = 0
  bot.entity = { position: new Vec3(.5, 64, .5) }
  bot.entities = { 2: { id: 2, name: 'iron_golem', position: new Vec3(2.5, 64, .5), height: 2.7, width: 1.4 } }
  bot.health = 20; bot.inventory = { items: () => [{ name: 'cobblestone', count: 32 }, { name: 'stone_axe', count: 1 }] }
  bot.pathfinder = { setGoal () {} }; bot.blockAt = p => ({ boundingBox: p.y <= 63 ? 'block' : 'empty' })
  class Time extends Date { static now () { return time } }
  const fixture = { module: { exports: {} as Record<string, any> }, process, console, Date: Time, require: local,
    advance: async ms => { time += ms; waited += ms } }
  vm.runInNewContext(code + '\nsleep = advance; visible = () => true; golemSpotNear = () => null', withClockFixture(fixture))
  const out = await fixture.module.exports.golemKill({ bot }, { aborted: false, onAbort: [] }, { timeoutSeconds: 85 })
  assert.equal(out.hits, 0)
  assert.equal(out.noSpot, true, 'the caller can distinguish a physically blocked perch from an unfinished fight')
  assert.ok(waited < 1000, 'retrying the unchanged neutral position must not spend six four-second waits')
})

test('a diagonally close raised golem cannot be struck until the supported pillar clears its attack box', async () => {
  const { EventEmitter } = require('node:events')
  const { withClockFixture } = require('./clock-fixture')
  let t = 1000
  const attacks = [], towers = []
  const bot = new EventEmitter()
  const golem = { id: 2, name: 'iron_golem', position: new Vec3(2.325, 65, 2.325), height: 2.7, width: 1.4 }
  bot.entity = { position: new Vec3(.5, 67, .5) }; bot.entities = { 2: golem }; bot.health = 20
  bot.inventory = { items: () => [{ name: 'cobblestone', count: 64 }, { name: 'stone_axe', count: 1 }] }
  bot.pathfinder = { setGoal () {} }; bot.equip = async i => { bot.heldItem = i }; bot.lookAt = async () => {}
  bot.blockAt = p => ({ boundingBox: p.y <= 63 || p.x === 0 && p.z === 0 && p.y < bot.entity.position.y ? 'block' : 'empty' })
  bot.attack = () => { attacks.push(bot.entity.position.y); delete bot.entities[2]; bot.emit('entityGone', golem) }
  class Time extends Date { static now () { return t } }
  const local = createRequire(filename)
  const fixture = { module: { exports: {} as Record<string, any> }, process, Date: Time, console,
    require: name => name === './pick' ? { aim: () => ({ point: golem.position }) }
      : name === './build' ? { towerUp: async () => { towers.push(bot.entity.position.y); bot.entity.position.y++; return { placed: 1 } }, pickFiller () {} }
      : local(name),
    advance: async ms => { t += ms }, descend: async () => { bot.entity.position.y = 64 } }
  // Isolate the live mob-box check: a local height scan may predate the golem stepping up.
  vm.runInNewContext(code + '\nsleep = advance; visible = () => true; golemTopNear = () => 64; descendPillar = descend', withClockFixture(fixture))
  await fixture.module.exports.golemKill({ bot }, { aborted: false, onAbort: [] }, { timeoutSeconds: 20 })
  assert.deepEqual(attacks, [68], 'attack comes after the extra real tower step, not from unsafe Y67')
  assert.deepEqual(towers, [67])
})
