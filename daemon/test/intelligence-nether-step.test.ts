import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { bodySource } from './source-fixture'

function physicalStep({ elevated = false, inheritedBack = false, inheritedSneak = false }: { elevated?: boolean; inheritedBack?: boolean; inheritedSneak?: boolean } = {}) {
  const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry as any)
  const { Physics, PlayerState } = require('prismarine-physics')
  const controls = { forward: false, back: inheritedBack, left: false, right: false, sprint: false, sneak: inheritedSneak, jump: false }
  let now = 0
  const bot = {
    version: '1.21.11', registry, inventory: { items: () => [], slots: [] }, jumpTicks: 0, jumpQueued: false,
    fireworkRocketDuration: 0,
    entity: { position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    blockAt(p) {
      const cell = p.floored()
      const floor = elevated && cell.x >= 1 ? 62 : 63
      const block = Block.fromStateId(registry.blocksByName[cell.y <= floor ? 'stone' : 'air'].defaultState)
      block.position = cell; return block
    },
    async lookAt(target) { this.entity.yaw = Math.atan2(-(target.x - this.entity.position.x), -(target.z - this.entity.position.z)) },
    setControlState(key, value) { controls[key] = value },
    clearControlStates() { for (const key of Object.keys(controls)) controls[key] = false }
  }
  const world = { getBlock: p => bot.blockAt(p) }
  const physics = Physics(registry, world)
  const clock = { now: () => now, setTimeout(fn, milliseconds) {
    queueMicrotask(() => {
      for (let i = 0; i < Math.ceil(milliseconds / 50); i++) {
        physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot); now += 50
      }
      fn()
    })
  } }
  const filename = require.resolve('../src/sealed')
  const realRequire = createRequire(filename)
  const localRequire = name => name === './game-clock' ? clock
    : name === './reflex-lock' ? { clock: () => now } : realRequire(name)
  const module = { exports: {} as Record<string, any> }
  new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(localRequire, module, module.exports)
  const routeFilename = require.resolve('../src/nether-route')
  const routeRequire = createRequire(routeFilename)
  const routeModule = { exports: {} as Record<string, any> }
  // nether-route — фасад + части (src/nether-route/**) одной областью видимости: stepOne — имя верхнего уровня.
  new Function('require', 'module', 'exports', bodySource(routeFilename) + '\nmodule.exports.stepOne = stepOne')(
    name => name === './game-clock' ? clock : name === './sealed' ? module.exports : routeRequire(name), routeModule, routeModule.exports)
  const destination = new Vec3(1, elevated ? 63 : 64, 0)
  return { bot, controls, elapsed: () => now, run: () => module.exports.stepMove(bot, { aborted: false }, { kind: 'flat', to: destination }),
    routeRun: () => routeModule.exports.stepOne({ bot }, { aborted: false }, { mark() {} },
      { kind: elevated ? 'down' : 'flat', from: { x: 0, y: 64, z: 0 }, to: destination }, { mismatch: 0, digFails: 0, stepFails: 0 }) }
}

test('Nether physical flat and descending steps advance into actual supported cells', async () => {
  for (const elevated of [false, true]) {
    const f = physicalStep({ elevated })
    assert.equal(await f.run(), true)
    assert.equal(f.bot.entity.position.floored().equals(new Vec3(1, elevated ? 63 : 64, 0)), true)
    assert.equal(f.controls.forward, false)
    assert.equal(f.controls.jump, false)
  }
})

test('Nether route takes movement ownership before a real physics step', async () => {
  const f = physicalStep({ inheritedBack: true })
  assert.equal(await f.routeRun(), 'ok')
  assert.equal(f.controls.back, false)
  assert.equal(f.bot.entity.position.floored().x, 1)
})

test('a safe descending route releases inherited edge sneak after validating the loaded landing floor', async () => {
  const f = physicalStep({ elevated: true, inheritedSneak: true })
  assert.equal(await f.routeRun(), 'ok')
  assert.ok(f.elapsed() < 3000, `descending step stalled for ${f.elapsed()} game ms`)
  assert.equal(f.bot.entity.position.floored().equals(new Vec3(1, 63, 0)), true)
})
