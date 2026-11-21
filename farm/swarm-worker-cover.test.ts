import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
import { REPO_ROOT } from '../daemon/src/paths'
import { installDangers } from './arena/dangers'
import { swarmLifecycle } from './swarm/swarm-driver/lifecycle'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmTeam } from './swarm/swarm-driver/team'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmSightings } from '../daemon/src/swarm-senses'
import { dangers } from '../daemon/src/threats'
import { block, data } from '../daemon/test/tick-plugins-fixture'

const { Vec3 } = createRequire(path.join(REPO_ROOT, 'daemon/package.json'))('vec3')

function scene(t, weapon = 'bow') {
  const before = process.env.SWARM_DOCTRINE
  process.env.SWARM_DOCTRINE = 'hunt'
  t.after(() => { if (before === undefined) delete process.env.SWARM_DOCTRINE; else process.env.SWARM_DOCTRINE = before })
  let time = 10000, wall = false
  const here = new Vec3(.5, 64, .5), spot = new Vec3(1.5, 64, 1.5)
  const air = block('air', here), stone = block('stone', here)
  const worker: any = { name: 'Miner', team: 'blue', c: { async call() {} } }
  const guard: any = { name: 'Shield', team: 'blue', c: { async call() {} } }
  const bots = [worker, guard]
  const gear = { head: 'diamond_helmet', torso: 'diamond_chestplate', legs: 'diamond_leggings', feet: 'diamond_boots' }
  const pos = { Miner: { p: here, hp: 20, food: 20, watchRound: 1, armor: gear, inv: { iron_pickaxe: 1 } },
    Shield: { p: spot, hp: 20, food: 20, watchRound: 1, armor: gear, offHand: 'shield', inv: { diamond_sword: 1 } } }
  const sw = createDriverState({ bots, pos, now: () => time, alive: () => true, log() {},
    hostile: (_, id) => id === 'Foe', home: () => here, arena: { x: 0, y: 64, z: 0, r: 50 } })
  Object.assign(sw, swarmRetry(sw), swarmTeam(sw), { preempt() {} })
  Object.assign(sw, swarmLifecycle(sw))
  const arena: any = { bots, pos, busy: new Set(), out: new Set(), deadNow: new Set(), log() {}, round: 1, Y: 64 }
  installDangers(arena)
  const body: any = Object.assign(new EventEmitter(), { _client: new EventEmitter(), registry: data,
    entity: { id: 1, position: here, height: 1.8 }, entities: {}, players: {},
    blockAt: p => wall && p.x === 1 ? stone : air })
  const foe: any = Object.assign(new EventEmitter(), { id: 2, username: 'Foe', type: 'player', name: 'player',
    position: new Vec3(weapon === 'bow' ? 20.5 : 2.5, 64, .5), yaw: Math.PI / 2,
    width: .6, height: 1.8, metadata: [], equipment: [{ name: weapon }] })
  const using = data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  body.entities[foe.id] = foe
  t.after(() => body.emit('end'))
  const work = (m: string) => { worker.swarmTask = { kind: 'mine', data: {} }; worker.last = { m, pending: true, round: arena.round, at: time } }
  const sense = (draw = false) => {
    pos.Miner.watchRound = arena.round
    foe.metadata[using] = draw ? 1 : 0
    body.emit('physicsTick')
    const report = dangers(body, { foes: ['Foe'] })
    worker.c.onDanger({ pos: here, observedAt: time, dangers: report })
    sw.observe(worker, swarmSightings(body, ['Shield']), time)
    return report
  }
  return { sw, worker, guard, foe, pos, arena, work, sense, task: () => sw.refresh(guard).task,
    advance: (ms = 1) => { time += ms }, wall: v => { wall = v } }
}

test('a fresh bow draw reassigns a side shield to a healthy worker, and a completed job releases it', t => {
  const f = scene(t)
  f.work('mine')
  assert.deepEqual(f.sense().aims, [])
  assert.equal(f.task().data.coverShield, undefined)
  f.advance()
  assert.deepEqual(f.sense(true).aims.map(a => a.name), ['Foe'])
  assert.equal(f.task().data.coverShield, true)
  assert.equal(f.task().data.cover, 'Miner')
  const cached = f.sw.planned.get('blue')
  f.advance(); f.sense(true); f.task()
  assert.equal(f.sw.planned.get('blue'), cached, 'an unchanged aim does not replan the whole roster')
  f.advance()
  f.worker.last.pending = false
  assert.equal(f.task().data.coverShield, undefined)
})

test('only current block work is reported by the real team member', t => {
  const f = scene(t)
  const working = () => !!f.sw.membersOf(f.guard).find(m => m.id === 'Miner')!.workingBlocks
  for (const m of ['swarm_work', 'dig_to', 'mine', 'ladder_up']) {
    f.work(m)
    assert.equal(working(), true)
    f.worker.last.pending = false
    assert.equal(working(), false)
  }
  f.work('goto'); assert.equal(working(), false)
  f.work('mine'); f.worker.swarmTurnOwner = { cancelled: true }; assert.equal(working(), false)
})

test('a wall hides the draw even when the archer name can still be seen; a new round clears the cover order', t => {
  const f = scene(t)
  f.work('swarm_work')
  const clear = f.sense(true)
  assert.ok(clear.aims.length)
  assert.equal(f.task().data.coverShield, true)
  f.advance(); f.wall(true)
  assert.deepEqual(f.sense(true).aims, [])
  assert.ok(f.sw.boardOf(f.worker).enemies().find(e => e.id === 'Foe')?.nametag)
  f.worker.c.onDanger({ pos: f.pos.Miner.p, observedAt: 10000, dangers: clear })
  assert.equal(f.task().data.coverShield, undefined)
  f.advance(); f.wall(false); f.sense(true)
  assert.equal(f.task().data.coverShield, true)
  f.sw.reset(); f.arena.round++
  assert.equal(f.task().data.coverShield, undefined)
})

test('a pending block command from before reset cannot protect a worker assigned a different job next round', t => {
  const f = scene(t)
  f.work('mine'); f.sense(true)
  assert.equal(f.task().data.coverShield, true)
  f.sw.reset(); f.arena.round++; f.advance(1000)
  f.worker.swarmTask = { kind: 'loot', data: {} }
  f.sense(true)
  assert.equal(f.sw.membersOf(f.guard).find(m => m.id === 'Miner').workingBlocks, undefined)
  assert.equal(f.task().data.coverShield, undefined)
})

for (const helper of ['close', 'far', 'unarmed']) test(`a healthy miner under a melee threat gets a suitable defender: ${helper}`, t => {
  const f = scene(t, 'diamond_sword')
  if (helper === 'far') f.pos.Shield.p = new Vec3(13, 64, 0)
  if (helper === 'unarmed') {
    Object.assign(f.pos.Shield, { armor: {}, inv: {}, offHand: null })
    f.foe.equipment = [{ name: 'netherite_sword' }, null, ...['boots', 'leggings', 'chestplate', 'helmet'].map(n => ({ name: 'netherite_' + n }))]
  }
  f.work('dig_to'); f.sense()
  const task = f.task()
  assert.equal(task.data.cover, helper === 'close' ? 'Miner' : undefined)
  if (helper === 'close') assert.equal(task.data.target, 'Foe')
  if (helper === 'unarmed') assert.notEqual(task.kind, 'fight')
})

test('the same visible swordsman entering contact changes a cached allocation before its next periodic refresh', t => {
  const f = scene(t, 'diamond_sword')
  f.work('mine'); f.foe.position.x = 5.5
  f.sense(); assert.equal(f.task().data.cover, undefined)
  f.advance(50); f.foe.position.x = 4.5
  f.sense(); assert.equal(f.task().data.cover, 'Miner')
})
