import test from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as vm from 'node:vm'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { bodySource } from './source-fixture'
import { cjsContext } from './cjs-context'

function fixture(digMs = 10000) {
  const file = path.join(__dirname, '../src/movement/basics.js'), nativeRequire = createRequire(file)
  let now = 0, callback, active = true, stopped = 0
  const clock = { now: () => now, setInterval: fn => { callback = fn; return 1 }, clearInterval: () => { active = false } }
  const context = cjsContext({ module: { exports: {} as any }, console,
    require: name => name === '../game-clock' ? clock : name === '../navigation/geometry' ? {} : nativeRequire(name) })
  vm.runInNewContext(bodySource(file), context)
  const target = { position: new Vec3(1, 65, 0), type: 1, stateId: 1, name: 'smooth_sandstone', diggable: true }
  const bot: any = { entity: { position: new Vec3(.5, 64, .5), onGround: true }, targetDigBlock: target,
    blockAt: () => target, blockAtCursor: () => target, canDigBlock: () => true, digTime: () => digMs,
    pathfinder: { isMining: () => true, setGoal: () => { stopped++ } } }
  const ctl = { onAbort: [] }, guard = context.module.exports.stuckGuard(bot, ctl)
  guard.promise.catch(() => {})
  const advance = to => { for (; now + 1500 <= to && active;) { now += 1500; callback() } }
  return { bot, target, guard, ctl, advance, stopped: () => stopped }
}

test('a native ten-second dig can finish while the body stays still beyond eight seconds', () => {
  const f = fixture(10050)
  try {
    f.advance(10500)
    assert.equal(f.stopped(), 0, 'the native smooth-sandstone action still has a finite work budget')
    f.bot.targetDigBlock = null; f.bot.entity.position.x += 1
    f.advance(12000)
    assert.equal(f.stopped(), 0)
  } finally { f.guard.stop() }
})

test('a stuck native dig flag does not renew an exhausted work budget', () => {
  const f = fixture()
  f.advance(21000)
  assert.equal(f.stopped(), 1)
})

test('fresh Block objects for the same unchanged target do not renew its work budget', () => {
  const f = fixture()
  for (let t = 1500; t <= 21000; t += 1500) {
    f.bot.targetDigBlock = { ...f.target }
    f.advance(t)
  }
  assert.equal(f.stopped(), 1)
})

for (const ms of [0, Infinity, NaN]) test(`invalid or empty native dig duration ${ms} keeps the eight-second guard`, () => {
  const f = fixture(ms)
  f.advance(9000)
  assert.equal(f.stopped(), 1)
})

test('an isMining flag without a real target is not work', () => {
  const f = fixture()
  f.bot.targetDigBlock = null; f.advance(9000)
  assert.equal(f.stopped(), 1)
})
