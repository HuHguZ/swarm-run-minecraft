'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const R = require('../src/reflex-lock')
function fixture ({ distance = 1.5, visible = true } = {}) {
  const b = new EventEmitter(); b._client = new EventEmitter(); const calls = []
  b.entity = { id: 1, position: new Vec3(.5,64,.5), onGround: true }
  const foe = { id: 2, name: 'blaze', position: new Vec3(.5 + distance,64,.5), height: 1.8, metadata: [] }
  b.entities = { 1: b.entity, 2: foe }; b.health = 20; b.food = 20; b.game = { dimension: 'the_nether' }
  b.registry = { entitiesByName: { blaze: { metadataKeys: [] } } }
  b.inventory = { slots: { 45: { name: 'shield' } }, items: () => [{ name: 'iron_sword', count: 1 }] }
  b.lookAt = async () => {}; b.activateItem = () => calls.push('shield'); b.deactivateItem = () => {}
  b.equip = async () => {}; b.stopDigging = () => calls.push('stop'); b.clearControlStates = () => {}
  b.pathfinder = { setGoal () {} }; b.attack = () => { calls.push('attack'); foe.isValid = false; delete b.entities[2] }
  const s = { bot: b, current: { name: 'ne_route', ctl: { aborted: false, onAbort: [] } } }
  const context = { module: { exports: {} }, console: { log () {} }, process, setTimeout, clearTimeout,
    require: n => n === 'vec3' ? { Vec3 } : n === './movement' ? { sleep: ms => new Promise(r => setTimeout(r, Math.min(ms,1))) } : n === './worlds' ? { worldOf: () => 'the_nether' } : n === './reflex-lock' ? R : n === './perception' ? { eyePos: () => b.entity.position, raySees: () => visible } : n === './pick' ? { canHit: () => visible && distance < 3 } : n === './sealed' ? { fillerCount: () => 0 } : {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/ne-guard.js'),'utf8'),context)
  const G = context.module.exports; G.attach(s)
  return { b,s,G,calls,hit: () => b._client.emit('damage_event',{ entityId: 1, sourceCauseId: 3, sourceDirectId: 3 }) }
}
test('first close blaze hit owns hands during ne_route and attacks only the visible target', async () => {
  const f = fixture(); f.hit(); assert.ok(f.s.reflex); await f.s.reflex
  assert.ok(f.calls.includes('shield')); assert.ok(f.calls.includes('attack')); assert.equal(f.s.current.ctl.aborted,false); f.b.emit('end')
})
test('visible close blaze is a proactive threat even without mob_flags', () => {
  const f = fixture(); assert.equal(f.G.hot(f.b)?.e.name,'blaze'); f.b.emit('end')
})
test('a distant shooter and a hidden close blaze do not initiate a melee chase', () => {
  for (const opts of [{ distance: 8 }, { visible: false }]) { const f = fixture(opts); assert.equal(f.G.hot(f.b),null); f.b.emit('end') }
})
test('a distant blaze fireball does not seize the hands for a melee duel', async () => {
  for (const distance of [4,8]) {
    const f = fixture({ distance }); f.hit(); f.hit(); f.b.health = 12; f.b.emit('health')
    assert.equal(f.s.reflex,undefined); assert.equal(f.G.hot(f.b),null); f.b.emit('end')
  }
})
test('ND_GUARD_BLAZE=0 keeps the old threat set', () => {
  const old = process.env.ND_GUARD_BLAZE; process.env.ND_GUARD_BLAZE = '0'
  try { const f = fixture(); assert.equal(f.G.hot(f.b),null); f.hit(); assert.equal(f.s.reflex,undefined); f.b.emit('end') } finally { if (old === undefined) delete process.env.ND_GUARD_BLAZE; else process.env.ND_GUARD_BLAZE = old }
})
