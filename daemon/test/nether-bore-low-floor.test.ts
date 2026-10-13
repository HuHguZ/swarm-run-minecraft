'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')
const { transformSync } = require('esbuild')

async function floorBore (name) {
  const file = path.join(__dirname, '../src/nether.ts')
  const realRequire = createRequire(file)
  const registry = realRequire('minecraft-data')('1.21.11')
  const Block = realRequire('prismarine-block')(registry)
  const { Physics, PlayerState } = realRequire('prismarine-physics')
  const floor = Block.fromStateId(registry.blocksByName[name].defaultState)
  const top = Math.max(...floor.shapes.map(s => s[4]))
  const controls = { forward: false, back: false, left: false, right: false, sprint: false, sneak: false, jump: false }
  const removed = new Set(), dug = [], placements = []
  let now = 0
  const bot: any = {
    version: '1.21.11', registry, inventory: { items: () => [], slots: [] }, entities: {},
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { position: new Vec3(.5, 50 + top, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    blockAt (p) {
      const cell = p.floored()
      const material = cell.y === 50 && cell.z === 0 && cell.x >= 0 && cell.x <= 4 && !removed.has(cell.toString()) ? name : 'air'
      const block = Block.fromStateId(registry.blocksByName[material].defaultState)
      block.position = cell
      return block
    },
    pathfinder: { setGoal () {} },
    async lookAt (p) { this.entity.yaw = Math.atan2(-(p.x - this.entity.position.x), -(p.z - this.entity.position.z)) },
    setControlState (key, value) { controls[key] = value }
  }
  const world = { getBlock: p => bot.blockAt(p) }
  const physics = Physics(registry, world)
  const advance = ms => {
    for (let i = 0; i < Math.ceil(ms / 50); i++) { physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot); now += 50 }
  }
  const clock = { now: () => now, sleep: async ms => advance(ms), setTimeout (fn, ms) {
    const timer = { active: true }
    queueMicrotask(() => { if (timer.active) { advance(ms); fn() } })
    return timer
  }, clearTimeout (timer) { timer.active = false } }
  const context: any = { module: { exports: {} }, console, process, setTimeout, clearTimeout,
    clearFixture: async (_session, _ctl, cells) => {
      let count = 0
      for (const p of cells) if (bot.blockAt(p).boundingBox === 'block') { dug.push(p.clone()); removed.add(p.toString()); count++ }
      return { dug: count }
    },
    require: dependency => dependency === './game-clock' ? clock
      : dependency === './movement' ? { ...realRequire(dependency), sleep: clock.sleep }
        : dependency === './perception/eyes' ? { entities: () => [] }
        : dependency === './build' ? { ...realRequire(dependency), placeBlockAt: async (_bot, p) => {
          placements.push(p.clone()); return { ok: false, reason: 'нет грани под тонким полом' }
        } } : realRequire(dependency) }
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code + '\nclearCells = clearFixture', context)
  const result = await context.module.exports.bore({ bot, mcData: registry }, { aborted: false, onAbort: [] }, { x: 3, z: 0 }, { deadline: 5000, maxSteps: 4 })
  return { result, dug, placements, bot, top, controls }
}

for (const name of ['soul_sand', 'mud', 'farmland', 'netherrack']) {
  test(`штрек идёт по физическому верху ${name}, сохраняя опору вместо копки собственного пола`, async () => {
    const f = await floorBore(name)
    assert.equal(f.result.ok, true, f.result.why)
    assert.ok(f.result.moved >= 2)
    assert.ok(f.bot.entity.position.x >= 2)
    assert.equal(f.bot.entity.position.y, 50 + f.top)
    assert.equal(f.dug.length, 0)
    assert.equal(f.placements.length, 0)
    assert.equal(f.controls.forward, false)
    assert.equal(f.controls.jump, false)
  })
}
