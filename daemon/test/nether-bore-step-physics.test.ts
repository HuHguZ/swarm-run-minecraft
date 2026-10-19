import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { cjsContext } from './cjs-context'
import { bodySource } from './source-fixture'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()

// Real movement/collision engine, a one-block stair, and lava 23 blocks below it.
async function stepScene(dx: number, dz: number, offset: number, speed: number) {
  const start = new Vec3(.5 + dx * (offset - .5), 55, .5 + dz * (offset - .5))
  const controls: any = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const bot: any = { version: '1.21.11', registry, health: 20, food: 20, game: { dimension: 'the_nether' },
    entity: { position: start, velocity: new Vec3(dx * speed,0,dz * speed), height: 1.8, eyeHeight: 1.62,
      yaw: 0, pitch: 0, onGround: true, effects: {}, attributes: {}, isInWater: false, isInLava: false, isInWeb: false },
    inventory: { slots: [], items: () => [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    setControlState: (k, v) => { controls[k] = v }, getControlState: k => controls[k] }
  bot.look = async yaw => { bot.entity.yaw = yaw }
  bot.lookAt = async p => { bot.entity.yaw = Math.atan2(-(p.x - bot.entity.position.x), -(p.z - bot.entity.position.z)) }
  const cache = new Map()
  const world = { getBlock(p) {
    const q = p.floored(), key = q.toString()
    if (!cache.has(key)) {
      const name = q.y <= 30 || q.x === 0 && q.z === 0 && q.y === 54 || q.x === dx && q.z === dz && q.y === 53
        ? 'netherrack' : q.y === 31 ? 'lava' : 'air'
      const b = Block.fromStateId(registry.blocksByName[name].defaultState,0); b.position = q; cache.set(key,b)
    }
    return cache.get(key)
  } }
  bot.blockAt = world.getBlock
  const physics = native.Physics(registry,world)
  let ticks = 0, lava = false
  const advance = ms => {
    for (let k=0; k<Math.max(1, Math.round(ms / 50)); k++) {
      physics.simulatePlayer(new native.PlayerState(bot,controls),world).apply(bot)
      ticks++; lava ||= bot.entity.isInLava
    }
  }
  const file = path.resolve(__dirname, '../src/nether.js'), real = createRequire(file)
  const context: any = { module: { exports: {} }, process, console, require: id =>
    id === './game-clock' ? { now: () => ticks * 50, setTimeout: (fn,ms) => { advance(ms); queueMicrotask(fn); return 0 }, clearTimeout () {} } : id === './movement' ? { ...real(id), sleep: async ms => advance(ms) } : real(id) }
  vm.runInNewContext(bodySource(file),cjsContext(context))
  const result = await context.module.exports.bore({ bot, mcData:registry }, { aborted:false,onAbort:[] },
    { x:dx*2,z:dz*2 }, { deadline:2500,maxSteps:1,minY:54 })
  const ok = result.moved === 1
  const returned = { ok, pos: bot.entity.position.clone(), ground: bot.entity.onGround, ticks }
  advance(2000)
  return { returned, lava, pos: bot.entity.position, ground: bot.entity.onGround }
}

test('ne6 bore descent lands and brakes on the supported cell in 48 native-physics approach states', async () => {
  for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) for (const offset of [.1,.5,.9]) for (const speed of [0,.1,.2,.3]) {
    const r = await stepScene(dx,dz,offset,speed)
    const label = JSON.stringify({ dx,dz,offset,speed,r })
    assert.equal(r.returned.ok,true,label)
    assert.equal(r.returned.ground,true,label)
    assert.equal(r.returned.pos.y,54,label)
    assert.equal(r.ground,true,label)
    assert.equal(r.pos.floored().equals(new Vec3(dx,54,dz)),true,label)
    assert.equal(r.lava,false,label)
  }
})
