import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from '../daemon/src/pvp/vec3'
import { hazardCoverMethods } from '../daemon/src/rpc/hazards-cover'
import { archerCovered } from '../daemon/src/pvp/archer-cover'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'

function scene() {
  let now = 1000
  const calls: string[] = [], ate: InstanceType<typeof Vec3>[] = [], controls: Record<string, boolean> = {}
  const placed = new Map([0, 1, 2].map(y => [`2,${y},-1`, { x: 2, y, z: -1 }]))
  const physical = new Set(placed.keys()), arena = { x: 0, y: 0, z: 0, r: 24 }
  const archer = { id: 2, username: 'Archer', type: 'player', isValid: true, position: new Vec3(.5, 0, -12.5),
    height: 1.8, width: .6, metadata: [], equipment: [{ name: 'bow' }], yaw: Math.PI }
  const body: any = Object.assign(new EventEmitter(), { health: 5, food: 10, players: { Archer: { entity: archer } }, entities: { 2: archer },
    registry: { entitiesByName: {}, blocksByName: {} }, physics: { playerHeight: 1.8, playerHalfWidth: .3 },
    inventory: { items: () => [], slots: [] }, game: { minY: -64, height: 384 },
    entity: { id: 1, position: new Vec3(.5, 0, .5), height: 1.8, eyeHeight: 1.62, yaw: 0, onGround: true, effects: {}, metadata: [] },
    lookAt: async () => {}, setControlState: (key, value) => { controls[key] = value },
    clearControlStates: () => { for (const key of Object.keys(controls)) controls[key] = false },
    canSeeBlock: () => true, blockAt(p) {
      const at = p.floored(), solid = at.y < 0 || physical.has([at.x, at.y, at.z].join(','))
      return { name: solid ? 'stone' : 'air', position: at, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
    } })
  const session = { require: () => body, runIntent: async (_, action) => action({ aborted: false, onAbort: [] }) }
  const methods = hazardCoverMethods({ session, state: {}, gameClock: { now: () => now, sleep: async () => {
    now += 50
    const x = +!!controls.right - +!!controls.left, z = +!!controls.back - +!!controls.forward, n = Math.hypot(x, z) || 1
    body.entity.position = body.entity.position.offset(.215 * x / n, 0, .215 * z / n)
  } } } as any)
  const m = { p: body.entity.position, hp: 5, inv: { bread: 1 } }, member = { id: 'Ward', position: m.p, health: 5 }
  const foes = [{ id: 'Archer', position: archer.position, seenAt: now }]
  const board = { team: 'red', enemies: () => foes, facts: () => [], tasks: () => [] }
  const task = { kind: 'recover', position: new Vec3(-6.5, 0, .5), data: { doctrine: 'weak-center' } }
  const b: any = { name: 'Ward', arrowThreat: { at: now, active: true, ward: m.p, bows: [{ name: 'Archer', at: archer.position }] },
    c: { call: async (method, params) => {
      calls.push(method)
      if (method === 'eat') ate.push(body.entity.position.clone())
      if (method === 'flee') return { status: 'done', detail: { mode: 'бегу' } }
      return { status: 'done', detail: method === 'take_cover' ? await methods.take_cover(params) : {} }
    } } }
  const sw: any = { pos: { Ward: m }, arena, generation: 1, now: () => now, alive: () => true, cooldown: new Map(),
    hostile: (_b, id) => foes.some(e => e.id === id), placed: new Map([['red', placed]]),
    refresh: () => ({ task, board, member, members: [member] }), say() {}, onslaught: () => false, detail: r => r?.detail,
    go: async (_b, to) => { calls.push('goto'); body.entity.position = to.clone() } }
  Object.assign(sw, swarmTurnTasks(sw))
  return { b, archer, body, ate, calls, physical, foes, sw, run: () => swarmTurn(sw).turn(b) }
}

test('a wounded member of weak-center eats behind the teammate’s physical wall under a personally observed bow draw', async () => {
  const f = scene()
  await f.run()
  assert.deepEqual(f.calls, ['take_cover', 'eat'])
  assert.equal(f.ate.length, 1)
  assert.ok(f.ate[0].x > 2)
  assert.equal(archerCovered(f.body, f.archer.position.offset(0, 1.62, 0), f.ate[0]), true)
})

for (const mode of ['wall removed', 'stale draw', 'friendly bow', 'incoming melee', 'second archer', 'interrupted'] as const) test('recovery cover control: ' + mode, async () => {
  const f = scene()
  if (mode === 'wall removed') f.physical.clear() // the team still remembers its build
  if (mode === 'stale draw') f.b.arrowThreat.at -= 1600
  if (mode === 'friendly bow') f.b.arrowThreat.bows[0].name = 'Ally'
  if (mode === 'incoming melee') f.foes.push({ id: 'Blade', position: new Vec3(1, 0, 1), seenAt: 1000 })
  if (mode === 'second archer') {
    const call = f.b.c.call
    f.b.c.call = async (method, params) => {
      const reply = await call(method, params)
      const position = new Vec3(12, 0, 1)
      f.foes.push({ id: 'Second', position, seenAt: f.sw.now() })
      f.b.arrowThreat = { active: true, at: f.sw.now(), bows: [{ name: 'Second', at: position }] }
      return reply
    }
  }
  if (mode === 'interrupted') f.b.c.call = async method => { f.calls.push(method); return { status: 'interrupted' } }
  await f.run()
  if (mode === 'interrupted' || mode === 'second archer') assert.deepEqual(f.calls, ['take_cover'])
  else if (mode === 'incoming melee') assert.deepEqual(f.calls, ['flee'])
  else assert.deepEqual(f.calls, mode === 'wall removed' ? ['take_cover', 'goto', 'eat'] : ['goto', 'eat'])
})
