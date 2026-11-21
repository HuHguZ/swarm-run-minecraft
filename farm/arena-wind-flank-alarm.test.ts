import test from 'node:test'
import assert from 'node:assert/strict'
import { installSight, watchAlarm } from './arena/watch'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmWind } from './swarm/swarm-driver/wind'

for (const change of ['moved', 'nametag only', 'disappeared', 'aged out', 'new round'])
test(`a terrace walker yields under observed contact and can return after the threat has ${change}`, async t => {
  let at = 100000, alarm: () => void, wind: ReturnType<typeof swarmWind>, visible: any[] = []
  const calls: string[] = [], walkers = new Map<string, (r: any) => void>()
  const bots = ['UnderAttack', 'Free'].map(name => ({ name, team: 'red',
    c: { call: async (method, params) => {
      if (method === 'goto') {
        calls.push(name + ':walk')
        return new Promise(resolve => walkers.set(name, resolve))
      }
      if (method === 'stop') {
        calls.push(name + ':stop')
        walkers.get(name)?.({ status: 'interrupted', error: 'The goal was changed before it could be completed!' })
        walkers.delete(name)
      }
      return { status: 'done' }
    } } }))
  const pos = Object.fromEntries(bots.map((b, i) => [b.name, { p: { x: i * 22, y: 64, z: 0 }, hp: 20, inv: { wind_charge: i ? 0 : 1 } }]))
  const ctx: any = { bots, pos, names: bots.map(b => b.name), alive: () => true, hostile: () => true, deathAt: {},
    home: () => '0 0', log() {}, humans: {}, X: -.5, Y: 64, Z: -.5, R: 80, L: {}, between: false,
    round: 4, busy: new Set(), deadNow: new Set(), out: new Set() }
  t.mock.method(Date, 'now', () => at)
  t.mock.method(globalThis, 'setInterval', fn => { alarm = fn; return 1 as any })
  t.mock.method(require('./swarm/swarm-driver'), 'createSwarmDriver', opts => {
    wind = swarmWind({ ...createDriverState(opts), teamOf: b => b.team, panic: () => false })
    return { enemies: () => visible }
  })
  installSight(ctx)
  const reads: string[] = [], enemiesOf = ctx.enemiesOf
  ctx.enemiesOf = (b, p) => { reads.push(b.name); return enemiesOf(b, p) }
  watchAlarm(ctx)
  const upper = id => [{ id, visible: true, position: { x: 23, y: 75, z: 0 } }]
  const passer = { id: 'Approacher', seenAt: at, position: { x: 2, y: 64, z: 0 } }
  wind!.windFlank(bots[0], upper('First'))
  assert.deepEqual(calls, ['UnderAttack:walk'])
  assert.deepEqual(reads, [], 'an uninterrupted walk requires no extra enemy scan')
  visible = [passer]
  alarm!()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['UnderAttack:walk', 'UnderAttack:stop'])
  for (let frame = 0; frame < 7; frame++) {
    at += 250
    visible = [{ ...passer, seenAt: at }]
    alarm!()
  }
  pos.Free.inv.wind_charge = 1
  reads.length = 0
  wind!.windFlank(bots[0], upper('Second'))
  const flankReads = [...reads]
  alarm!()
  assert.deepEqual(calls, ['UnderAttack:walk', 'UnderAttack:stop', 'Free:walk'])
  assert.deepEqual(flankReads, ['UnderAttack'])
  at += 50
  if (change === 'moved') visible = [{ ...passer, seenAt: at, position: { x: -34, y: 64, z: 0 } }]
  if (change === 'nametag only') visible = [{ ...passer, seenAt: at, nametag: true }]
  if (change === 'disappeared') visible = []
  if (change === 'aged out') at += 1500
  if (change === 'new round') ctx.round++
  wind!.windFlank(bots[0], upper('Third'))
  assert.equal(calls.at(-1), 'UnderAttack:walk')
  for (const done of walkers.values()) done({ status: 'done' })
  await new Promise<void>(resolve => setImmediate(resolve))
  reads.length = 0
  wind!.windFlank(bots[0], upper('Fourth'))
  assert.deepEqual(reads, [], 'once the alarm is clear ordinary flanks stop scanning')
  for (const done of walkers.values()) done({ status: 'done' })
})
