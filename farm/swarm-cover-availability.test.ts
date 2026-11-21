import assert from 'node:assert/strict'
import test from 'node:test'
import { installDangers } from './arena/dangers'
import { createSwarmDriver } from './swarm/swarm-driver'

function scene(t, refusal?: string) {
  const prior = process.env.SWARM_DOCTRINE
  process.env.SWARM_DOCTRINE = 'hunt'
  t.after(() => { if (prior === undefined) delete process.env.SWARM_DOCTRINE; else process.env.SWARM_DOCTRINE = prior })
  let now = 10000
  const at = (x, z = 0) => ({ x, y: 64, z }), guards: string[] = []
  const bots: any[] = ['Ward', 'First', 'Second'].map(name => ({ name, team: 'blue', c: { async call(method, params) {
    if (method === 'swarm_hold' && params.coverAlly === 'Ward' && params.whileDraw === 'Archer') {
      guards.push(name)
      if (name === 'First' && refusal) return { status: 'done', detail: { ok: false, why: refusal } }
    }
    return { status: 'done', detail: {} }
  } } }))
  const [ward, first, second] = bots
  ward.swarmTask = { kind: 'mine', data: {} }
  ward.last = { m: 'swarm_work', pending: true }
  const armor = { head: 'diamond_helmet', torso: 'diamond_chestplate', legs: 'diamond_leggings', feet: 'diamond_boots' }
  const pos: any = {
    Ward: { p: at(0), hp: 20, armor, inv: { iron_pickaxe: 1, diamond_sword: 1 } },
    First: { p: at(1), hp: 20, armor, offHand: 'shield', inv: { diamond_sword: 1 } },
    Second: { p: at(1, 1), hp: 20, armor, offHand: 'shield', inv: { diamond_sword: 1 } }
  }
  const driver = createSwarmDriver({ bots, pos, now: () => now, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 32 },
    home: () => at(0), hostile: (_, n) => n === 'Archer', log() {} })
  installDangers({ bots: [ward], pos, busy: new Set(), out: new Set(), deadNow: new Set(), enemiesOf: () => [], log() {} } as any)
  const draw = async () => {
    now += 550
    ward.c.onDanger({ pos: pos.Ward.p, observedAt: now, dangers: { aims: [{ name: 'Archer', weapon: 'bow', at: at(20) }] } })
    driver.observe(ward, [{ visible: true, id: 'Archer', position: at(20), equipment: { weapon: 'bow', armor: [] } }])
    await driver.turn(first)
    await driver.turn(second)
  }
  return { first, second, pos, guards, draw, orders: () => driver.snapshot().blue.tasks.filter(t => t.data?.coverShield).map(t => t.assignedTo) }
}

for (const state of ['available', 'emergency', 'reserved', 'both busy']) test('worker shield availability: ' + state, async t => {
  const f = scene(t)
  if (state === 'emergency' || state === 'both busy') f.pos.First.tactics = { owner: 'Emergency' }
  if (state === 'reserved') f.first.swarmReserved = true
  if (state === 'both busy') f.second.swarmReserved = true
  const expected = state === 'both busy' ? [] : [state === 'available' ? 'First' : 'Second']
  for (let i = 0; i < 3; i++) {
    await f.draw()
    assert.deepEqual(f.orders(), expected, 'a current assignment has an available guard')
  }
  assert.deepEqual(f.guards, [...expected, ...expected, ...expected])
})

for (const reason of ['cover_step_blocked', 'shield_cooldown']) test('a second guard takes over after ' + reason, async t => {
  const f = scene(t, reason)
  await f.draw()
  assert.deepEqual(f.guards, ['First', 'Second'])
  await f.draw()
  assert.deepEqual(f.orders(), ['Second'])
  assert.deepEqual(f.guards, ['First', 'Second', 'Second'])
})
