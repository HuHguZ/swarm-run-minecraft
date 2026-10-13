'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { transformSync } = require('esbuild')
const { Vec3 } = require('vec3')

function fixture ({ distant = false, hidden = false, shield = true, arrives = 0, abortAt = Infinity }: any = {}) {
  let now = 10000
  const intervals = new Map()
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const events: any[] = []
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.health = 20
  bot.entity = { id: 0, position: new Vec3(.5,64,.5), height: 1.8, metadata: [0] }
  bot.registry = { entitiesByName: { player: { metadataKeys: ['living_entity_flags'] } } }
  bot.blockAt = p => ({ name: hidden && p.z === -1 ? 'stone' : 'air', position: p,
    boundingBox: hidden && p.z === -1 ? 'block' : 'empty', shapes: hidden && p.z === -1 ? [[0, 0, 0, 1, 1, 1]] : [] })
  const sword = { name: 'iron_sword', count: 1 }
  bot.heldItem = sword
  bot.inventory = { slots: { 45: shield ? { name: 'shield', count: 1 } : null }, items: () => [sword] }
  const foe = { id: 1, name: 'skeleton', position: new Vec3(.5,64,3), height: 1.99, isValid: true }
  const shot: any = { id: 2, name: 'fireball', position: new Vec3(.5,65,-5), height: .3125, isValid: true, _ndObservationNow: () => now }
  bot.entities = { 1: foe }
  const update = () => {
    const elapsed = now - 10000
    if (elapsed >= arrives && elapsed < arrives + 400) {
      shot.position.z = (distant ? -30 : -5) + (elapsed - arrives) * .6 / 50
      shot._ndPositionReceipts = [
        { t: now - 50, x: .5, y: 65, z: shot.position.z - .6 },
        { t: now, x: .5, y: 65, z: shot.position.z }
      ]
      bot.entities[2] = shot
    } else delete bot.entities[2]
    if (elapsed >= abortAt && !ctl.aborted) { ctl.aborted = true; for (const fn of [...ctl.onAbort]) fn() }
  }
  update()
  bot.lookAt = async p => { events.push({ kind: 'aim', at: now - 10000, z: p.z }) }
  bot.activateItem = () => { bot.entity.metadata[0] = 3; events.push({ kind: 'up', at: now - 10000 }) }
  bot.deactivateItem = () => { bot.entity.metadata[0] = 0; events.push({ kind: 'down', at: now - 10000 }) }
  bot.attack = () => events.push({ kind: 'attack', at: now - 10000 })
  bot.setControlState = (key, value) => events.push({ kind: key, value, at: now - 10000 })
  const clock = {
    now: () => now, observationNow: () => now,
    setInterval: fn => { const timer = {}; intervals.set(timer,fn); return timer },
    clearInterval: timer => intervals.delete(timer)
  }
  const movement = { sleep: async ms => { now += ms; update(); for (const fn of intervals.values()) fn() } }
  const perception = { eyePos: () => bot.entity.position.offset(0,1.62,0), raySees: (_b,_eye,p) => !(hidden && p.z < 0) }
  const modules: any = {}
  const load = name => {
    if (modules[name]) return modules[name]
    const context: any = { module: { exports: {} }, process, console, require: id => {
      if (id === './game-clock') return clock
      if (id === './movement') return movement
      if (id === 'vec3') return require('vec3')
      if (id === 'mineflayer-pathfinder') return { goals: {} }
      if (id === './perception') return perception
      if (id === './pvp/last-seen') return require('../src/pvp/last-seen')
      if (id === './threats' || id === './combat') return load(id.slice(2))
      if (id === './sealed') return { fillerCount: () => 0 }
      if (id === './pick') return { canHit: () => true }
      if (id === './moves') return { stepSafe: () => true, keyDir: () => ({ x: 0,z: 1 }) }
      if (id === './items') return { itemNamed: () => null }
      if (id === './bow') return { observeCharge: () => {
        let started = 0
        return { start: () => { started = now; bot.activateItem(true); return true }, ready: ticks => now - started >= ticks * 50, close () {}, why: () => null, cancelled: new Promise(() => {}), snapshot: () => ({ useConfirmed: true }) }
      } }
      return {}
    } }
    const source = fs.readFileSync(path.join(__dirname,'../src',name + '.ts'),'utf8')
    vm.runInNewContext(transformSync(source,{ loader: 'ts', format: 'cjs', target: 'node22' }).code,context)
    modules[name] = context.module.exports
    return modules[name]
  }
  const guard = load('ne-guard')
  const threats = load('threats')
  if (bot.entities[2]) {
    const current = shot.position.clone()
    now -= 50; shot.position.z -= .6; threats.incoming(bot)
    now += 50; shot.position.update(current)
  }
  return { bot, ctl, events, intervals, threats, foe, run: () => guard.duel({ bot },ctl,foe,1000) }
}

test('actual Nether duel shields a visible imminent fireball behind its melee target, then resumes swings', async () => {
  const f = fixture()
  assert.ok(f.threats.incoming(f.bot).some(p => p.ticks <= 10))
  await f.run()
  assert.equal(f.events.some(e => e.kind === 'attack' && e.at < 400),false)
  assert.ok(f.events.some(e => e.kind === 'aim' && e.at < 400 && e.z < 0))
  assert.ok(f.events.some(e => e.kind === 'up' && e.at < 400))
  assert.ok(f.events.some(e => e.kind === 'attack' && e.at >= 400))
  assert.equal(f.intervals.size,0)
  assert.equal(f.bot._client.listenerCount('set_cooldown'),0)
})

test('a projectile arriving during the open swing gap postpones the actual attack', async () => {
  const f = fixture({ arrives: 50 })
  await f.run()
  assert.equal(f.events.some(e => e.kind === 'attack' && e.at >= 100 && e.at < 450),false)
  assert.ok(f.events.some(e => e.kind === 'up' && e.at >= 100 && e.at < 450), 'defence starts after the second visible motion frame')
  assert.ok(f.events.some(e => e.kind === 'attack' && e.at >= 450))
})

test('distant or hidden projectiles and absence of a shield preserve the ordinary melee swing', async () => {
  for (const options of [{ distant: true }, { hidden: true }, { shield: false }]) {
    const f = fixture(options)
    if (options.distant) assert.ok(f.threats.incoming(f.bot).every(p => p.ticks > 10))
    await f.run()
    assert.ok(f.events.some(e => e.kind === 'attack' && e.at === 50))
    assert.equal(f.events.some(e => e.kind === 'aim' && e.z < 0),false)
  }
})

test('abort during projectile defence releases controls and native shield listeners without a swing', async () => {
  const f = fixture({ abortAt: 120 })
  await f.run()
  assert.equal(f.events.some(e => e.kind === 'attack'),false)
  assert.equal(f.bot.entity.metadata[0],0)
  assert.equal(f.intervals.size,0)
  assert.equal(f.bot._client.listenerCount('sound_effect'),0)
  assert.equal(f.bot.listenerCount('health'),0)
  assert.equal(f.events.filter(e => e.kind === 'forward').at(-1).value,false)
})
