'use strict'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as fs from 'node:fs'
import * as vm from 'node:vm'
import { withClockFixture } from './clock-fixture'
import path = require('node:path')
import { bodySource } from './source-fixture'
const delay = ms => new Promise<any>(resolve => setTimeout(resolve, ms))
function fixture () {
  const calls = []
  const b: any = new EventEmitter(); b._client = new EventEmitter()
  b.entity = { id: 1, position: new Vec3(.5, 64, .5), onGround: true }
  const foe = { id: 2, name: 'piglin_brute', position: new Vec3(2, 64, .5), height: 1.95, metadata: [4] }
  b.entities = { 1: b.entity, 2: foe }; b.health = 20
  b.inventory = { slots: { 45: { name: 'shield' } }, items: () => [] }
  b.registry = { entitiesByName: { piglin_brute: { metadataKeys: ['mob_flags'] } } }
  b.lookAt = async () => { calls.push('look') }
  b.activateItem = () => calls.push('shield')
  b.deactivateItem = () => calls.push('unshield')
  b.stopDigging = () => calls.push('stopDigging')
  b.clearControlStates = () => calls.push('clear')
  b.closeWindow = () => { calls.push('close'); b.currentWindow = null }
  b.pathfinder = { setGoal: () => calls.push('goal'), goto: async () => calls.push('goto') }
  b.setControlState = (k, v) => calls.push(`${k}:${v}`)
  b.equip = async () => calls.push('equip')
  b.attack = () => calls.push('attack')
  const s: { bot: any; current: any; reflex?: any } = { bot: b, current: { name: 'bastion', ctl: { aborted: false, onAbort: [] } } }
  const fallback = new Proxy({} as Record<string, any>, { get: () => () => {} })
  const context = { module: { exports: {} as Record<string, any> }, console: { log () {} }, process, setTimeout, clearTimeout, setImmediate,
    require (n) { if (n === 'vec3') return { Vec3 }; if (n === './worlds') return { worldOf: () => 'the_nether' }; if (n === './movement') return { sleep: delay }; if (n === './perception') return { eyePos: () => b.entity.position, raySees: () => true }; if (n === './reflex-lock') return (require('../src/reflex-lock') as typeof import('../src/reflex-lock')); return fallback } }
  // ne-guard — фасад + части (src/ne-guard/**) одной областью видимости.
  vm.runInNewContext(bodySource(path.join(__dirname, '../src/ne-guard.js')), cjsContext(withClockFixture(context)))
  const G = context.module.exports
  G.attach(s)
  return { b, s, calls, foe, G, hit: () => b._client.emit('damage_event', { entityId: 1, sourceCauseId: 3, sourceDirectId: 3 }) }
}
test('первый удар забирает руки и ставит session.reflex без abort бастиона', async () => {
  const { b, s, calls, hit } = fixture()
  b.currentWindow = { id: 3 }
  hit()
  assert.ok(calls.includes('stopDigging'))
  assert.ok(calls.includes('close'))
  assert.ok(s.reflex)
  assert.equal(s.current.name, 'bastion')
  assert.equal(s.current.ctl.aborted, false)
  await s.reflex
  b.emit('end')
})

import R = require('../src/reflex-lock')
test('первое защитное действие на первом ударе укладывается в 500 мс', async () => {
  const { b, s, hit } = fixture()
  const actions = []
  b.on('nd_guard_reflex', a => actions.push(a))
  hit(); await s.reflex
  assert.equal(actions.length, 1)
  assert.equal(actions[0].how, 'shield')
  assert.ok(actions[0].reflexMs <= 500, JSON.stringify(actions))
  b.emit('end')
})
test('копка останавливается, после защиты продолжается тот же worker', async () => {
  const { b, s, calls } = fixture()
  let rejectDig; let release; let n = 0; let reached: any = 0
  const firstDig = new Promise<any>(resolve => { reached = resolve })
  b.blockAt = () => ({ name: 'netherrack' })
  b.dig = async () => {
    n++
    if (n === 1) { reached(); return new Promise<void>((resolve, reject) => { rejectDig = reject }) }
    calls.push('digged')
  }
  b.stopDigging = () => { rejectDig?.(new Error('Digging aborted')); rejectDig = null }
  // Install wraps once on the actual fixture; replace methods above THEN install
  // a fresh bot lock, since those methods model the mineflayer plugin boundary.
  b._ndReflexLock = false; R.install(s)
  let entered = 0
  const worker = R.run(s, s.current.ctl, async () => { entered++; await b.dig({ name: 'netherrack' }); calls.push('continued') })
  await firstDig
  const hold = new Promise<any>(resolve => { release = resolve })
  const defence = R.start(s, async () => { b.activateItem(true); await hold })
  await delay(10)
  assert.ok(!calls.includes('continued'))
  assert.equal(s.current.ctl.aborted, false)
  release(); await defence; await worker
  assert.equal(entered, 1)
  assert.equal(n, 2)
  assert.ok(calls.includes('continued'))
  b.emit('end')
})
test('поздний ввод worker не снимает щит и не запускает pathfinder поверх защиты', async () => {
  const { b, s, calls } = fixture()
  let release
  const hold = new Promise<any>(resolve => { release = resolve })
  const defence = R.start(s, async () => { b.activateItem(true); await hold })
  await delay(0)
  const before = calls.length
  R.run(s, s.current.ctl, () => { b.setControlState('forward', true); b.deactivateItem(); b.pathfinder.setGoal({} as Record<string, any>); b.clearControlStates() })
  assert.equal(calls.length, before)
  release(); await defence
  R.run(s, s.current.ctl, () => b.setControlState('forward', true))
  assert.equal(calls.at(-1), 'forward:true')
  b.emit('end')
})
test('повторный удар объединяется с защитой, смерть отпускает lock и хуки', async () => {
  const { b, s } = fixture()
  const a = R.start(s, async () => new Promise<void>(() => {}))
  const again = R.start(s, async () => assert.fail('вторая защита'))
  assert.equal(a, again)
  b.emit('death')
  assert.equal((await a).cancelled, true)
  assert.equal(s.reflex, null)
  assert.equal(b.listenerCount('death'), 0)
  b.emit('end')
})
test('goto после setGoal(null) возобновляется к той же цели без рестарта worker', async () => {
  const { b, s } = fixture()
  const goto = require('mineflayer-pathfinder/lib/goto')
  const goals = []; const goal: Record<string, any> = {} as Record<string, any>
  b.pathfinder.setGoal = g => { goals.push(g); b.emit('goal_updated', g) }
  b.pathfinder.goto = g => goto(b, g)
  b._ndReflexLock = false; R.install(s)
  let entered = 0; let release
  const work = R.run(s, s.current.ctl, async () => { entered++; await b.pathfinder.goto(goal) })
  await delay(0)
  const defence = R.start(s, async () => new Promise<any>(resolve => { release = resolve }))
  await delay(5); release(); await defence; await delay(5)
  assert.equal(goals.filter(g => g === goal).length, 2)
  b.emit('goal_reached'); await work
  assert.equal(entered, 1)
  b.emit('end')
})
test('прерванный крафт не повторяет уже полученный результат и не кликает закрытое окно', async () => {
  const { b, s, calls } = fixture()
  let count = 0; let started; let resume; let release
  const counts = []
  b.inventory.items = () => [{ type: 99, count }]
  b.clickWindow = async () => calls.push('click')
  const ready = new Promise<any>(resolve => { started = resolve })
  const blocked = new Promise<any>(resolve => { resume = resolve })
  b.craft = async (recipe, n) => {
    counts.push(n)
    if (counts.length === 1) { count++; started(); await blocked; await b.clickWindow(0, 0, 0) }
    else count += n
  }
  b._ndReflexLock = false; R.install(s)
  const work = R.run(s, s.current.ctl, () => b.craft({ result: { id: 99, count: 1 } }, 2))
  await ready
  const defence = R.start(s, async () => new Promise<any>(resolve => { release = resolve }))
  await delay(0); resume(); await delay(5)
  assert.ok(!calls.includes('click'))
  release(); await defence; await work
  assert.deepEqual(counts, [2, 1])
  assert.equal(count, 2)
  b.emit('end')
})
test('общий крафт в Аду не начинается при враге в 12 блоках', async () => {
  const { b, s } = fixture()
  b.game = { dimension: 'the_nether' }
  let crafted = false
  b.craft = async () => { crafted = true }
  b._ndReflexLock = false; R.install(s)
  await assert.rejects(R.run(s, s.current.ctl, () => b.craft({ result: { id: 99, count: 1 } }, 1)) as Promise<unknown>, { code: 'REFLEX_UNSAFE_CRAFT' })
  assert.equal(crafted, false)
  b.emit('end')
})
